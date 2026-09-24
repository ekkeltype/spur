// Bandits (spec §7): waves, horsemen riding alongside (the trackside layer), bandits aboard (the
// train layer) with their goals, the loot, the hold-up and the powder car.
//
// Called by game.ts after the Rider each tick (spec §15 steps 9, 11 and 12): spawnWave when the loco
// passes a wave's trigger, then stepBandits. All randomness comes from state.rng.

import { bodyHeight, IDLE, stepBody, windOf, type Body, type BodyInput, type Wind } from './body';
import {
  banditAlive,
  bridgeHits,
  chestY,
  horsemanAlive,
  hurtRider,
  removeBandit,
  tunnelHits,
  type FightCtx,
} from './fight';
import { costFrom, edgeUsable, lineOfSight, navField, raySolid, regionAt, supportAt, trainGeometry, type TrainGeometry } from './geometry';
import { chance, rand } from './rng';
import {
  ACCURACY_MIN,
  BANDIT_ACCURACY_BASE,
  BANDIT_ACCURACY_FALLOFF,
  BANDIT_CROUCH_ACCURACY,
  BANDIT_INTERVAL,
  BANDIT_RANGE,
  BANDIT_TELEGRAPH,
  BANDIT_WALK,
  BOARD_SECONDS,
  BOARD_TOLERANCE,
  BOSS_HP,
  CRACK_SECONDS,
  CROUCH_ACCURACY,
  DT,
  FALL_OFF_Y,
  FALL_SECONDS,
  FAST_MOVE_WINDOW,
  HORSE_ACCEL,
  HORSE_AMBUSH_AHEAD,
  HORSE_AMBUSH_WAKE,
  HORSE_BRAKE,
  HORSE_CLOSE,
  HORSE_GIVE_UP_BEHIND,
  HORSE_GIVE_UP_SECONDS,
  HORSE_MAX,
  HORSE_SPAWN_BEHIND,
  HORSE_SPRINT,
  HORSE_STAMINA_REGEN,
  HORSE_STAMINA_SECONDS,
  HORSEMAN_ACCURACY_BASE,
  HORSEMAN_ACCURACY_FALLOFF,
  HORSEMAN_GUN_Y,
  HORSEMAN_HP,
  HORSEMAN_INTERVAL,
  HORSEMAN_RANGE,
  HORSEMAN_TELEGRAPH,
  HUNT_CLOSE,
  MAX_BANDITS_ABOARD,
  MAX_HORSEMEN,
  MISS_CARRY,
  MOVING_ACCURACY,
  PACE_RANGE,
  POWDER_HIT_CHANCE,
  POWDER_HIT_Y,
  POWDER_SPREAD,
  RETREAT_REL,
  RETREAT_SECONDS,
  RIDER_ACCEL,
  RIDER_CROUCH_WALK,
  RIDER_SHOULDER,
  RIDER_SHOULDER_CROUCH,
  RIDER_WALK,
  secondsToTicks,
  SPAWN_SPACING,
  STUN_SECONDS,
  TICK_HZ,
} from './rules';
import type { BanditGoal, BanditState, Dir, GameState, HorsemanState, SimEvent, Tier, WaveDef } from './types';

export type { FightCtx } from './fight';

// ---- Tunables (candidates for rules.ts) ---------------------------------------------------------

/** Walking to a point: close enough. */
export const ARRIVE = 0.15;
/** A bandit is at a place when within this of it (same walk region). */
export const AT_PLACE = 0.35;

const BANDIT_CROUCH_WALK = BANDIT_WALK * (RIDER_CROUCH_WALK / RIDER_WALK);
const STUNNED: BodyInput = { ...IDLE, crouch: true };

// ---- Hit chances (spec §7.2, §7.3) --------------------------------------------------------------

/** A horseman's hit chance at the Rider: worse with distance, at a crouching or fast-moving Rider. */
export function horsemanHitChance(distance: number, crouched: boolean, movingFast: boolean): number {
  const p = (HORSEMAN_ACCURACY_BASE - HORSEMAN_ACCURACY_FALLOFF * distance) * (crouched ? CROUCH_ACCURACY : 1) * (movingFast ? MOVING_ACCURACY : 1);
  return Math.max(ACCURACY_MIN, p);
}

/** A boarded bandit's hit chance at the Rider. */
export function banditHitChance(distance: number, crouched: boolean): number {
  return Math.max(ACCURACY_MIN, (BANDIT_ACCURACY_BASE - BANDIT_ACCURACY_FALLOFF * distance) * (crouched ? BANDIT_CROUCH_ACCURACY : 1));
}

// ---- Waves (spec §7.1) --------------------------------------------------------------------------

/** A wave's trigger was passed: its horsemen ride in (from behind, or waiting in ambush ahead). */
export function spawnWave(ctx: FightCtx, wave: WaveDef, events: SimEvent[]): void {
  const { state } = ctx;
  let ws = state.waves.find((w) => w.id === wave.id);
  if (!ws) {
    ws = { id: wave.id, triggered: true, queued: 0 };
    state.waves.push(ws);
  }
  ws.triggered = true;
  let slot = 0;
  for (let k = 0; k < wave.count; k++) {
    if (liveHorsemen(state) < MAX_HORSEMEN) spawnMember(state, wave, k, wave.from, slot++);
    else ws.queued++;
  }
  events.push({ type: 'waveSpawned', id: wave.id, count: wave.count, from: wave.from });
}

function liveHorsemen(state: GameState): number {
  return state.horsemen.filter(horsemanAlive).length;
}

function banditsAboard(state: GameState): number {
  return state.bandits.filter(banditAlive).length;
}

/**
 * The k-th member's goal. 'mixed' deals the goals the train offers in turn: the safe only with an
 * express car, the powder car only with one. The boss is the last member (and goes for the safe).
 */
function member(state: GameState, wave: WaveDef, k: number): { goal: BanditGoal; boss: boolean } {
  const boss = !!wave.boss && k === wave.count - 1;
  const hasExpress = state.train.cars.some((c) => c.kind === 'express');
  const hasPowder = state.train.cars.some((c) => c.kind === 'powder');
  let goal: BanditGoal;
  if (wave.goal === 'mixed') {
    const goals: BanditGoal[] = [...(hasExpress ? ['safe' as const] : []), 'cab', 'hunt', ...(hasPowder ? ['powder' as const] : [])];
    goal = boss ? (hasExpress ? 'safe' : 'hunt') : goals[k % goals.length];
  } else {
    goal = wave.goal;
  }
  if ((goal === 'safe' && !hasExpress) || (goal === 'powder' && !hasPowder)) goal = 'hunt';
  return { goal, boss };
}

function spawnMember(state: GameState, wave: WaveDef, k: number, from: 'rear' | 'ahead', slot: number): void {
  const { goal, boss } = member(state, wave, k);
  addHorseman(state, goal, boss, wave.tier, from, slot, false);
}

function addHorseman(state: GameState, goal: BanditGoal, boss: boolean, tier: Tier, from: 'rear' | 'ahead', slot: number, pickup: boolean): HorsemanState {
  const v = state.train.v;
  const ahead = from === 'ahead';
  const x = ahead ? state.train.length + HORSE_AMBUSH_AHEAD + slot * SPAWN_SPACING : -HORSE_SPAWN_BEHIND - slot * SPAWN_SPACING;
  const h: HorsemanState = {
    id: state.nextId++,
    x,
    // From behind they're already galloping; an ambush waits, standing.
    worldV: ahead ? 0 : v >= 0 ? Math.min(v, HORSE_MAX) : Math.max(v, -HORSE_MAX),
    hp: boss ? BOSS_HP : HORSEMAN_HP[tier],
    tier,
    boss,
    goal,
    mode: ahead ? 'waiting' : 'approach',
    modeTicks: 0,
    stamina: HORSE_STAMINA_SECONDS,
    targetX: x,
    aimTicks: 0,
    cooldownTicks: interval(state, HORSEMAN_INTERVAL[tier]),
    behindTicks: 0,
    pickup,
  };
  state.horsemen.push(h);
  return h;
}

/** Queued members ride in from behind as room frees under MAX_HORSEMEN. */
function drainQueues(ctx: FightCtx): void {
  const { state, run } = ctx;
  let slot = 0;
  for (const ws of state.waves) {
    if (ws.queued <= 0) continue;
    const def = run.waves.find((w) => w.id === ws.id);
    if (!def) {
      ws.queued = 0;
      continue;
    }
    while (ws.queued > 0 && liveHorsemen(state) < MAX_HORSEMEN) {
      spawnMember(state, def, def.count - ws.queued, 'rear', slot++);
      ws.queued--;
    }
  }
}

function interval(state: GameState, [lo, hi]: readonly [number, number]): number {
  return secondsToTicks(lo + rand(state.rng) * (hi - lo));
}

// ---- The tick -----------------------------------------------------------------------------------

/** One tick of every horseman and bandit, then the loot, the pickup horse and the hold-up. */
export function stepBandits(ctx: FightCtx, events: SimEvent[]): void {
  const { state } = ctx;
  if (state.phase !== 'running') return;
  const geo = trainGeometry(state.train.cars);
  drainQueues(ctx);
  for (const h of [...state.horsemen]) stepHorseman(ctx, geo, h, events);
  for (const b of [...state.bandits]) {
    if (state.phase !== 'running') break;
    stepBandit(ctx, geo, b, events);
  }
  pickupHorse(ctx);
  // Cracking progress is kept when the cracker stops (spec §7.4).
  if (state.loot.status === 'cracking' && !state.bandits.some((b) => banditAlive(b) && b.mode === 'cracking')) state.loot.status = 'safe';
  holdup(ctx, geo, events);
  state.horsemen = state.horsemen.filter((h) => h.mode !== 'gone');
  state.bandits = state.bandits.filter((b) => b.mode !== 'gone');
}

// ---- Horsemen (spec §7.2) -----------------------------------------------------------------------

function setHorseMode(h: HorsemanState, mode: HorsemanState['mode']): void {
  if (h.mode === mode) return;
  h.mode = mode;
  h.modeTicks = 0;
}

function retreat(h: HorsemanState): void {
  h.pickup = false;
  h.aimTicks = 0;
  setHorseMode(h, 'retreat');
}

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}

/** Rides toward a world speed: HORSE_MAX, or HORSE_SPRINT while stamina lasts (spec §7.2). */
function ride(h: HorsemanState, desired: number): void {
  const cap = h.stamina > 0 ? HORSE_SPRINT : HORSE_MAX;
  h.worldV = approach(h.worldV, Math.max(-cap, Math.min(cap, desired)), HORSE_ACCEL * DT);
  if (Math.abs(h.worldV) > HORSE_MAX + 1e-9) h.stamina = Math.max(0, h.stamina - DT);
  else h.stamina = Math.min(HORSE_STAMINA_SECONDS, h.stamina + HORSE_STAMINA_REGEN * DT);
}

function stepHorseman(ctx: FightCtx, geo: TrainGeometry, h: HorsemanState, events: SimEvent[]): void {
  const { state } = ctx;
  const v = state.train.v;
  h.modeTicks++;
  switch (h.mode) {
    case 'gone':
      return;
    case 'falling':
      h.worldV = approach(h.worldV, 0, HORSE_ACCEL * DT);
      h.x += (h.worldV - v) * DT;
      if (h.modeTicks >= secondsToTicks(FALL_SECONDS)) h.mode = 'gone';
      return;
    case 'waiting':
      // Standing by the track: the train comes to them.
      h.x -= v * DT;
      if (h.x - state.train.length <= HORSE_AMBUSH_WAKE) setHorseMode(h, 'approach');
      return;
    case 'retreat':
      ride(h, v - (v >= 0 ? RETREAT_REL : -RETREAT_REL));
      h.x += (h.worldV - v) * DT;
      if (h.modeTicks >= secondsToTicks(RETREAT_SECONDS) || h.x < -HORSE_GIVE_UP_BEHIND - 30) h.mode = 'gone';
      return;
    default:
      break;
  }

  // Approach, pace, board: ride to the mark and hold it, braking in time.
  h.targetX = markFor(ctx, geo, h);
  const e = h.targetX - h.x;
  const closing = Math.min(HORSE_CLOSE, Math.sqrt(2 * HORSE_BRAKE * HORSE_ACCEL * Math.abs(e)), 2 * Math.abs(e));
  ride(h, v + Math.sign(e) * closing);
  h.x += (h.worldV - v) * DT;

  // Giving up: the train outruns a horse's gallop for 12 s, or he's 70 m behind (spec §7.2).
  const markAhead = (h.targetX - h.x) * (v >= 0 ? 1 : -1) > BOARD_TOLERANCE;
  h.behindTicks = Math.abs(v) > HORSE_MAX && markAhead ? h.behindTicks + 1 : 0;
  if (h.behindTicks >= secondsToTicks(HORSE_GIVE_UP_SECONDS) || h.x < -HORSE_GIVE_UP_BEHIND) {
    retreat(h);
    return;
  }

  // Boarding: alongside the point for BOARD_SECONDS with the train slow enough (spec §7.2).
  const aligned = Math.abs(h.targetX - h.x) <= BOARD_TOLERANCE;
  const canBoard = !h.pickup && h.goal !== 'powder' && Math.abs(v) <= HORSE_MAX + 0.5 && banditsAboard(state) < MAX_BANDITS_ABOARD;
  if (h.mode === 'boarding') {
    if (!aligned || !canBoard) setHorseMode(h, 'pace');
    else if (h.modeTicks >= secondsToTicks(BOARD_SECONDS)) {
      board(ctx, geo, h, events);
      return;
    }
  } else if (h.mode === 'pace') {
    if (aligned && canBoard) setHorseMode(h, 'boarding');
    else if (Math.abs(e) > 2 * PACE_RANGE) setHorseMode(h, 'approach');
  } else if (Math.abs(e) <= PACE_RANGE) {
    setHorseMode(h, 'pace');
  }
  horsemanShoots(ctx, h, events);
}

/** Where a horseman rides alongside (spec §7.2), in the train frame. */
function markFor(ctx: FightCtx, geo: TrainGeometry, h: HorsemanState): number {
  const { state } = ctx;
  if (h.pickup) {
    const looter = state.bandits.find((b) => b.hasLoot && banditAlive(b));
    return looter && looter.navTarget !== null ? geo.nav.nodes[looter.navTarget].x : h.targetX;
  }
  const platforms = geo.boarding.filter((b) => b.into === 'platform');
  const nearest = (x: number, list = platforms): number => list.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a), list[0]).x;
  switch (h.goal) {
    case 'cab':
      return (geo.boarding.find((b) => b.into === 'cab') ?? geo.boarding[0]).x;
    case 'powder': {
      const car = state.train.cars.find((c) => c.kind === 'powder');
      return car ? (car.x0 + car.x1) / 2 + ((h.id % 3) - 1) * POWDER_SPREAD : h.x;
    }
    case 'safe': {
      const express = state.train.cars.findIndex((c) => c.kind === 'express');
      const ends = platforms.filter((b) => b.car === express);
      if (ends.length > 0) return nearest(h.x, ends);
      break;
    }
    default:
      break;
  }
  if (platforms.length === 0) return (geo.boarding[0] ?? { x: h.x }).x;
  const r = state.rider;
  return nearest(r.mode === 'active' ? r.x : h.x);
}

/** The horseman swings aboard at his boarding point: a bandit on the platform, or in the cab. */
function board(ctx: FightCtx, geo: TrainGeometry, h: HorsemanState, events: SimEvent[]): void {
  const { state } = ctx;
  const bp = geo.boarding.reduce((a, b) => (Math.abs(b.x - h.targetX) < Math.abs(a.x - h.targetX) ? b : a));
  const s = supportAt(geo, bp.x, bp.y);
  state.bandits.push({
    id: h.id,
    x: bp.x,
    y: bp.y,
    vx: 0,
    vy: 0,
    onGround: true,
    surface: s >= 0 ? geo.surfaces[s].kind : null,
    ladder: null,
    crouch: false,
    facing: 1,
    hp: h.hp,
    tier: h.tier,
    boss: h.boss,
    goal: h.goal,
    mode: 'moving',
    modeTicks: 0,
    hasLoot: false,
    aimTicks: 0,
    cooldownTicks: interval(state, BANDIT_INTERVAL),
    stunTicks: 0,
    navTarget: null,
  });
  h.mode = 'gone';
  events.push({ type: 'banditBoarded', id: h.id, x: bp.x, y: bp.y, into: bp.into });
}

/** Can a horseman shoot at something now? The powder car, or an exposed Rider within range. */
function horsemanTarget(ctx: FightCtx, h: HorsemanState): boolean {
  const { state } = ctx;
  if (h.goal === 'powder') {
    const car = state.train.cars.find((c) => c.kind === 'powder');
    return !!car && car.hp > 0 && Math.abs(h.x - Math.min(car.x1, Math.max(car.x0, h.x))) <= HORSEMAN_RANGE;
  }
  const r = state.rider;
  return exposed(ctx) && Math.hypot(r.x - h.x, chestY(r) - HORSEMAN_GUN_Y) <= HORSEMAN_RANGE;
}

/**
 * Out in the open for a horseman's shot (spec §6.4, §7.2): not inside a car or the cab. The armored
 * car's slits let the Rider shoot out, but nothing gets in.
 */
function exposed(ctx: FightCtx): boolean {
  const r = ctx.state.rider;
  return r.mode === 'active' && r.inside === null;
}

/** Every 2.5–4 s (tier 3: 1.8–3 s), after a telegraph: the 'aim' event, a glint and a raised gun. */
function horsemanShoots(ctx: FightCtx, h: HorsemanState, events: SimEvent[]): void {
  const { state } = ctx;
  if (state.godMode || h.pickup || h.mode === 'boarding') {
    h.aimTicks = 0;
    return;
  }
  if (h.aimTicks > 0) {
    if (--h.aimTicks === 0) horsemanFires(ctx, h, events);
    return;
  }
  if (h.cooldownTicks > 0) {
    h.cooldownTicks--;
    return;
  }
  if (!horsemanTarget(ctx, h)) return;
  h.aimTicks = secondsToTicks(HORSEMAN_TELEGRAPH[h.tier]);
  events.push({ type: 'aim', by: 'horseman', id: h.id });
}

function horsemanFires(ctx: FightCtx, h: HorsemanState, events: SimEvent[]): void {
  const { state } = ctx;
  h.cooldownTicks = interval(state, HORSEMAN_INTERVAL[h.tier]);
  if (h.goal === 'powder') {
    powderShot(ctx, h, events);
    return;
  }
  const r = state.rider;
  const cy = chestY(r);
  const d = Math.hypot(r.x - h.x, cy - HORSEMAN_GUN_Y);
  const moving = state.tick - r.lastFastTick <= secondsToTicks(FAST_MOVE_WINDOW);
  const p = exposed(ctx) && d <= HORSEMAN_RANGE ? horsemanHitChance(d, r.crouch, moving) : 0;
  const hit = p > 0 && chance(state.rng, p);
  if (hit) hurtRider(ctx, 'bullet', events);
  const end = hit ? { x: r.x, y: cy } : pastTarget(h.x, HORSEMAN_GUN_Y, r.x, cy + 0.7, d + MISS_CARRY);
  events.push({ type: 'shot', by: 'horseman', id: h.id, weapon: 'revolver', layer: 'trackside', x0: h.x, y0: HORSEMAN_GUN_Y, x1: end.x, y1: end.y, hit: hit ? 'rider' : 'none' });
}

function pastTarget(x0: number, y0: number, tx: number, ty: number, dist: number): { x: number; y: number } {
  const len = Math.hypot(tx - x0, ty - y0) || 1;
  return { x: x0 + ((tx - x0) / len) * dist, y: y0 + ((ty - y0) / len) * dist };
}

/** A shot at the powder car: POWDER_HIT_CHANCE to hit; at 0 hit points it blows (spec §7.4). */
function powderShot(ctx: FightCtx, h: HorsemanState, events: SimEvent[]): void {
  const { state } = ctx;
  const car = state.train.cars.find((c) => c.kind === 'powder');
  if (!car) return;
  const hit = chance(state.rng, POWDER_HIT_CHANCE);
  const x1 = Math.min(car.x1 - 0.5, Math.max(car.x0 + 0.5, h.x));
  events.push({ type: 'shot', by: 'horseman', id: h.id, weapon: 'revolver', layer: 'trackside', x0: h.x, y0: HORSEMAN_GUN_Y, x1, y1: POWDER_HIT_Y, hit: hit ? 'car' : 'none' });
  if (!hit) return;
  car.hp = Math.max(0, car.hp - 1);
  state.stats.carDamage++;
  events.push({ type: 'powderHit', hp: car.hp });
  if (car.hp === 0 && state.phase === 'running') {
    const detail = 'The powder car blew up.';
    state.phase = 'lost';
    state.loss = { reason: 'powder', detail };
    events.push({ type: 'explosion', x: (car.x0 + car.x1) / 2, y: POWDER_HIT_Y, what: 'powder' });
    events.push({ type: 'lost', reason: 'powder', detail });
  }
}

/**
 * A looter needs a horse held alongside his platform: a horseman already riding along (not the
 * boss, who has his own business), or one sent up from behind.
 */
function pickupHorse(ctx: FightCtx): void {
  const { state } = ctx;
  const looter = state.bandits.find((b) => b.hasLoot && banditAlive(b));
  const current = state.horsemen.find((h) => h.pickup && horsemanAlive(h) && h.mode !== 'retreat');
  if (!looter) {
    if (current) retreat(current);
    return;
  }
  if (current) return;
  const free = state.horsemen.find((h) => !h.boss && h.goal !== 'powder' && (h.mode === 'approach' || h.mode === 'pace' || h.mode === 'boarding'));
  if (free) {
    free.pickup = true;
    free.aimTicks = 0;
    setHorseMode(free, 'approach');
    return;
  }
  // Nobody sends a horse the train would outrun.
  if (Math.abs(state.train.v) <= HORSE_MAX) addHorseman(state, 'safe', false, 1, 'rear', 0, true);
}

// ---- Bandits aboard (spec §7.3, §7.4) -----------------------------------------------------------

function setMode(b: BanditState, mode: BanditState['mode']): void {
  if (b.mode === mode) return;
  b.mode = mode;
  b.modeTicks = 0;
}

function stepBandit(ctx: FightCtx, geo: TrainGeometry, b: BanditState, events: SimEvent[]): void {
  const { state } = ctx;
  b.modeTicks++;
  if (b.mode === 'gone') return;
  if (b.mode === 'falling') {
    if (b.modeTicks >= secondsToTicks(FALL_SECONDS)) b.mode = 'gone';
    return;
  }
  if (b.stunTicks > 0) b.stunTicks--;
  const wind = windOf(state.train.v);
  const prevX = b.x;
  // Knocked flat: no control. Taking aim: standing still. Otherwise, the goal decides.
  const inp = b.stunTicks > 0 ? STUNNED : b.aimTicks > 0 ? IDLE : decide(ctx, geo, b, wind, events);
  if (!banditAlive(b) || state.phase !== 'running') return;
  stepBody(geo, b, inp, BANDIT_WALK, BANDIT_CROUCH_WALK, wind);
  if (inp.moveX !== 0) b.facing = inp.moveX;

  if (b.y < FALL_OFF_Y) {
    state.stats.banditsDowned++;
    events.push({ type: 'banditDown', id: b.id, x: b.x, y: b.y, boss: b.boss });
    removeBandit(ctx, b, events);
    return;
  }
  // Tunnels and low bridges hit them exactly as they hit the Rider (spec §7.3).
  if (tunnelHits(ctx.hazards, b.x, b.y)) {
    knockOff(ctx, b, 'tunnel', events);
    return;
  }
  if (bridgeHits(geo, ctx.hazards, state.train.v, prevX, b.x, b.y, bodyHeight(b))) {
    b.hp = Math.max(0, b.hp - 1);
    if (b.hp === 0) {
      knockOff(ctx, b, 'bridge', events);
      return;
    }
    Object.assign(b, { stunTicks: secondsToTicks(STUN_SECONDS), crouch: true, ladder: null, aimTicks: 0 });
  }
  banditShoots(ctx, geo, b, events);
}

function knockOff(ctx: FightCtx, b: BanditState, cause: 'tunnel' | 'bridge', events: SimEvent[]): void {
  ctx.state.stats.banditsDowned++;
  events.push({ type: 'banditKnockedOff', id: b.id, cause });
  removeBandit(ctx, b, events);
}

/** What a bandit does this tick, by its goal (spec §7.4). */
function decide(ctx: FightCtx, geo: TrainGeometry, b: BanditState, wind: Wind, events: SimEvent[]): BodyInput {
  const { state } = ctx;
  const loot = state.loot;
  if (b.hasLoot) return flee(ctx, geo, b, wind, events);
  if (b.goal === 'cab') {
    b.navTarget = geo.nav.cab;
    if (inCab(geo, b)) {
      setMode(b, 'holdup');
      return IDLE;
    }
    setMode(b, 'moving');
    return steerTo(geo, b, placeOf(geo, geo.nav.cab), wind);
  }
  if (b.goal === 'safe' && geo.safe) {
    if (loot.status === 'dropped') {
      // Grab the dropped loot before the Rider does.
      const region = regionAt(geo, loot.x, loot.y);
      if (region >= 0) {
        b.navTarget = null;
        if (at(geo, b, region, loot.x)) {
          takeLoot(state, b, events);
          return IDLE;
        }
        setMode(b, 'moving');
        return steerTo(geo, b, { region, x: loot.x }, wind);
      }
    }
    const busy = state.bandits.some((o) => o !== b && banditAlive(o) && o.mode === 'cracking');
    if ((loot.status === 'safe' || loot.status === 'cracking') && !busy && geo.nav.safe !== null) {
      b.navTarget = geo.nav.safe;
      const safe = placeOf(geo, geo.nav.safe);
      if (at(geo, b, safe.region, safe.x)) return crack(ctx, b, events);
      setMode(b, 'moving');
      return steerTo(geo, b, safe, wind);
    }
  }
  return hunt(ctx, geo, b, wind);
}

/** Crack the safe: CRACK_SECONDS of work, kept if interrupted; then the loot (spec §7.4). */
function crack(ctx: FightCtx, b: BanditState, events: SimEvent[]): BodyInput {
  const loot = ctx.state.loot;
  setMode(b, 'cracking');
  loot.status = 'cracking';
  loot.crack = Math.min(1, loot.crack + DT / CRACK_SECONDS[b.tier]);
  if (b.modeTicks % TICK_HZ === 0) events.push({ type: 'safeCracking', progress: loot.crack });
  if (loot.crack >= 1 - 1e-9) {
    loot.crack = 1;
    loot.everCracked = true;
    takeLoot(ctx.state, b, events);
  }
  return IDLE;
}

function takeLoot(state: GameState, b: BanditState, events: SimEvent[]): void {
  Object.assign(state.loot, { status: 'carried', carrier: b.id });
  b.hasLoot = true;
  b.navTarget = null;
  setMode(b, 'fleeing');
  events.push({ type: 'lootTaken' });
}

/** With the loot: to the nearest car-end platform, and down onto a horse held there (spec §7.4). */
function flee(ctx: FightCtx, geo: TrainGeometry, b: BanditState, wind: Wind, events: SimEvent[]): BodyInput {
  const { state } = ctx;
  setMode(b, 'fleeing');
  if (b.navTarget === null || !geo.nav.boarding.includes(b.navTarget)) b.navTarget = escapeNode(geo, b);
  if (b.navTarget === null) return hunt(ctx, geo, b, wind);
  const node = placeOf(geo, b.navTarget);
  if (!at(geo, b, node.region, node.x)) return steerTo(geo, b, node, wind);
  const horse = state.horsemen.find((h) => h.pickup && horsemanAlive(h) && h.mode !== 'retreat' && Math.abs(h.x - b.x) <= BOARD_TOLERANCE);
  if (horse && Math.abs(state.train.v) <= HORSE_MAX + 0.5) escape(ctx, b, horse, events);
  return IDLE;
}

/** The nearest car-end platform (the rear one on a tie: that's where the horses come from). */
function escapeNode(geo: TrainGeometry, b: BanditState): number | null {
  let best: number | null = null;
  geo.boarding.forEach((bp, k) => {
    if (bp.into !== 'platform') return;
    const node = geo.nav.boarding[k];
    if (best === null || Math.abs(bp.x - b.x) < Math.abs(geo.nav.nodes[best].x - b.x) - 1e-9) best = node;
  });
  return best;
}

function escape(ctx: FightCtx, b: BanditState, horse: HorsemanState, events: SimEvent[]): void {
  const { state, run } = ctx;
  removeBandit(ctx, b, events, true);
  Object.assign(state.loot, { status: 'stolen', carrier: null });
  events.push({ type: 'lootStolen' });
  retreat(horse);
  if (run.contract.critical && state.phase === 'running') {
    const detail = `A bandit got away with the ${run.contract.cargo}.`;
    state.phase = 'lost';
    state.loss = { reason: 'lootStolen', detail };
    events.push({ type: 'lost', reason: 'lootStolen', detail });
  }
}

/** Go after the Rider: close in, then stand and fight once there's a clear shot (spec §7.4). */
function hunt(ctx: FightCtx, geo: TrainGeometry, b: BanditState, wind: Wind): BodyInput {
  const r = ctx.state.rider;
  b.navTarget = null;
  if (r.mode !== 'active') {
    setMode(b, 'moving');
    return IDLE;
  }
  const close = Math.hypot(r.x - b.x, r.y - b.y) <= HUNT_CLOSE;
  if (close && b.onGround && lineOfSight(geo, b.x, shoulderY(b), r.x, chestY(r))) {
    setMode(b, 'fighting');
    return IDLE;
  }
  setMode(b, 'moving');
  const region = regionAt(geo, r.x, r.y);
  return region >= 0 ? steerTo(geo, b, { region, x: r.x }, wind) : IDLE;
}

function inCab(geo: TrainGeometry, b: BanditState): boolean {
  const c = geo.cab;
  return b.x >= c.x0 && b.x <= c.x1 && b.y >= c.floorY - 0.05 && b.y < c.ceilY;
}

export function placeOf(geo: TrainGeometry, node: number): { region: number; x: number } {
  const n = geo.nav.nodes[node];
  return { region: n.region, x: n.x };
}

export function regionOf(geo: TrainGeometry, b: Body): number {
  if (!b.onGround) return -1;
  const s = supportAt(geo, b.x, b.y);
  return s >= 0 ? geo.surfaces[s].region : -1;
}

function at(geo: TrainGeometry, b: Body, region: number, x: number): boolean {
  return b.ladder === null && regionOf(geo, b) === region && Math.abs(b.x - x) <= AT_PLACE;
}

// ---- Navigation (spec §7.3) ---------------------------------------------------------------------

/**
 * Steers a figure toward a place: walking within its walk region, and between regions by the
 * cheapest move of the nav graph (climbing, dropping through a hatch, jumping a gap the wind
 * allows, or stepping off a roof's end). Bandits use it; so do the test bots playing the Rider.
 */
export function steerTo(geo: TrainGeometry, b: Body, goal: { region: number; x: number }, wind: Wind, walk = BANDIT_WALK): BodyInput {
  if (b.ladder !== null) {
    const l = geo.ladders[b.ladder];
    const field = navField(geo, goal.region, goal.x, walk, wind.dir, wind.w);
    const up = costFrom(geo, field, geo.surfaces[l.top].region, l.topX, goal.region, goal.x, walk);
    const down = costFrom(geo, field, geo.surfaces[l.bottom].region, l.x, goal.region, goal.x, walk);
    return up <= down ? { ...IDLE, up: true } : { ...IDLE, down: true };
  }
  if (!b.onGround) return IDLE;
  const here = regionOf(geo, b);
  if (here < 0) return IDLE;
  if (here === goal.region) return walkTo(b, goal.x);
  const field = navField(geo, goal.region, goal.x, walk, wind.dir, wind.w);
  const { nodes, edges, out, byRegion } = geo.nav;
  let from = -1;
  let move = -1;
  let best = Infinity;
  for (const n of byRegion[here]) {
    for (const k of out[n]) {
      const e = edges[k];
      if (nodes[e.to].region === here || !edgeUsable(e, walk, wind.dir, wind.w)) continue;
      const c = Math.abs(b.x - nodes[n].x) / walk + e.cost + field[e.to];
      if (c < best) {
        best = c;
        from = n;
        move = k;
      }
    }
  }
  if (move < 0 || best === Infinity) return IDLE;
  const node = nodes[from];
  const e = edges[move];
  const dx = node.x - b.x;
  switch (e.kind) {
    case 'jump':
    case 'drop': {
      // Run at the take-off at full speed; once there, go.
      const dir = e.dir as Dir;
      if (dx * dir > 0.02) return { ...IDLE, moveX: dir };
      return { ...IDLE, moveX: dir, jumpPressed: e.kind === 'jump' };
    }
    case 'ladderUp':
    case 'hatchUp':
      return Math.abs(dx) <= 0.25 ? { ...IDLE, up: true, ladder: e.ladder ?? undefined } : walkTo(b, node.x);
    case 'ladderDown':
      return Math.abs(dx) <= 0.25 ? { ...IDLE, down: true, downPressed: true, ladder: e.ladder ?? undefined } : walkTo(b, node.x);
    case 'hatchDown':
      return Math.abs(dx) <= 0.25 ? { ...IDLE, downPressed: true } : walkTo(b, node.x);
  }
  return IDLE;
}

/** Walk to x, easing off in time to stop there. */
function walkTo(b: Body, x: number): BodyInput {
  const dx = x - b.x;
  if (Math.abs(dx) <= ARRIVE) return IDLE;
  const stopping = (b.vx * b.vx) / (2 * RIDER_ACCEL);
  if (Math.sign(dx) === Math.sign(b.vx) && Math.abs(dx) <= stopping) return IDLE;
  return { ...IDLE, moveX: dx > 0 ? 1 : -1 };
}

// ---- Bandits' shooting (spec §7.3) --------------------------------------------------------------

function shoulderY(b: BanditState): number {
  return b.y + (b.crouch ? RIDER_SHOULDER_CROUCH : RIDER_SHOULDER);
}

/** With a clear line to the Rider within 25 m: a 0.5 s telegraph, then a shot, every 2–3.5 s. */
function banditShoots(ctx: FightCtx, geo: TrainGeometry, b: BanditState, events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  if (state.godMode) {
    b.aimTicks = 0;
    return;
  }
  if (b.aimTicks > 0) {
    if (--b.aimTicks === 0) banditFires(ctx, geo, b, events);
    return;
  }
  if (b.cooldownTicks > 0) {
    b.cooldownTicks--;
    return;
  }
  if (r.mode !== 'active' || !b.onGround || b.ladder !== null || b.stunTicks > 0) return;
  const sy = shoulderY(b);
  const cy = chestY(r);
  if (Math.hypot(r.x - b.x, cy - sy) > BANDIT_RANGE || !lineOfSight(geo, b.x, sy, r.x, cy)) return;
  b.aimTicks = secondsToTicks(BANDIT_TELEGRAPH);
  b.facing = r.x >= b.x ? 1 : -1;
  events.push({ type: 'aim', by: 'bandit', id: b.id });
}

function banditFires(ctx: FightCtx, geo: TrainGeometry, b: BanditState, events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  b.cooldownTicks = interval(state, BANDIT_INTERVAL);
  const sy = shoulderY(b);
  const cy = chestY(r);
  const d = Math.hypot(r.x - b.x, cy - sy);
  const clear = r.mode === 'active' && d <= BANDIT_RANGE && lineOfSight(geo, b.x, sy, r.x, cy);
  const hit = clear && chance(state.rng, banditHitChance(d, r.crouch));
  if (hit) hurtRider(ctx, 'bullet', events);
  let end = { x: r.x, y: cy };
  if (!hit) {
    // A miss flies on over the Rider's shoulder until it meets the train or runs out.
    const len = Math.hypot(r.x - b.x, cy + 0.7 - sy) || 1;
    const dx = (r.x - b.x) / len;
    const dy = (cy + 0.7 - sy) / len;
    const t = raySolid(geo, b.x, sy, dx, dy, d + MISS_CARRY);
    end = { x: b.x + dx * t, y: sy + dy * t };
  }
  events.push({ type: 'shot', by: 'bandit', id: b.id, weapon: 'revolver', layer: 'train', x0: b.x, y0: sy, x1: end.x, y1: end.y, hit: hit ? 'rider' : 'none' });
}

// ---- The hold-up (spec §5.2, §7.4) --------------------------------------------------------------

/** Any bandit in the cab holds the Engineer up; the hold-up ends when none is left there. */
function holdup(ctx: FightCtx, geo: TrainGeometry, events: SimEvent[]): void {
  const { state } = ctx;
  const t = state.train;
  const held = state.bandits.some((b) => banditAlive(b) && inCab(geo, b));
  if (held && !t.heldUp) {
    t.heldUp = true;
    state.stats.holdups++;
    events.push({ type: 'heldUp' });
  } else if (!held && t.heldUp) {
    t.heldUp = false;
    events.push({ type: 'holdupEnded' });
  }
}
