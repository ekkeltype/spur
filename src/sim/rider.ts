// The Rider (spec §6): movement, wind, hazards, shooting, the spyglass, respawns.

import { bodyHeight, IDLE, stepBody, windOf, type BodyInput } from './body';
import {
  banditAlive,
  banditBox,
  bridgeHits,
  chestY,
  damageBandit,
  damageHorseman,
  fireHits,
  fordHits,
  horsemanAlive,
  horsemanBox,
  hurtRider,
  inTunnel,
  riderOff,
  throwFigure,
  tunnelHits,
  type FightCtx,
} from './fight';
import { carAt, groundBelow, interiorAt, lineOfSight, raySolid, rayRect, supportAt, trainGeometry, type TrainGeometry } from './geometry';
import { xOnSpans } from './network';
import { rand } from './rng';
import {
  AIM_ASSIST_DEGREES,
  CABOOSE_HEAL_SECONDS,
  DT,
  FALL_OFF_Y,
  FAST_MOVE,
  FLAG_MAX,
  FLAG_TTL_SECONDS,
  HEARTS,
  HORSEMAN_CHEST_Y,
  INVULN_SECONDS,
  LOOT_REACH,
  LOOT_REACH_Y,
  NEAR_MISS,
  QUICK_RELOAD_FACTOR,
  RIDER_CROUCH_WALK,
  RIDER_SHOULDER,
  RIDER_SHOULDER_CROUCH,
  RIDER_WALK,
  SCOPE_MIN,
  SCOPE_SMOOTH_SECONDS,
  secondsToTicks,
  STUN_SECONDS,
  WEAPON_SWITCH_SECONDS,
  WEAPONS,
} from './rules';
import type { Assists, CarState, GameState, LootState, RiderInput, RiderState, ShotLayer, SimEvent, UpgradeId, Weapon } from './types';

export type { FightCtx } from './fight';

// ---- Tunables (candidates for rules.ts) ---------------------------------------------------------

const DEG = Math.PI / 180;
const SCOPE_SMOOTH = 1 - Math.exp(-DT / SCOPE_SMOOTH_SECONDS);

/** Knocked down (a low bridge): lying flat, no control. */
const STUNNED: BodyInput = { ...IDLE, crouch: true };

/** The Rider at the start: on the roof of the first car behind the tender (spec §6.3). */
export function initialRider(cars: readonly CarState[], upgrades: readonly UpgradeId[], assists: Assists): RiderState {
  const geo = trainGeometry(cars);
  const car = cars.length > 2 ? 2 : 1;
  const x = (cars[car].x0 + cars[car].x1) / 2;
  const top = geo.surfaces[groundBelow(geo, x, 100)];
  const weapons: Weapon[] = (['revolver', 'shotgun', 'rifle'] as const).filter((w) => w === 'revolver' || upgrades.includes(w));
  const maxHearts = HEARTS + (upgrades.includes('extraHeart') ? 1 : 0) + (assists.rider ? 2 : 0);
  return {
    x,
    y: top.y,
    vx: 0,
    vy: 0,
    onGround: true,
    surface: top.kind,
    car,
    inside: null,
    crouch: false,
    ladder: null,
    facing: 1,
    aim: 0,
    hearts: maxHearts,
    maxHearts,
    weapon: 'revolver',
    weapons,
    ammo: { revolver: WEAPONS.revolver.rounds, shotgun: WEAPONS.shotgun.rounds, rifle: WEAPONS.rifle.rounds },
    reloadTicks: 0,
    cooldownTicks: 0,
    invulnTicks: 0,
    stunTicks: 0,
    mode: 'active',
    respawnTicks: 0,
    scoped: false,
    scopeDist: SCOPE_MIN,
    lastFastTick: -1000,
    healTicks: 0,
  };
}

export function initialLoot(): LootState {
  return { status: 'safe', crack: 0, x: 0, y: 0, carrier: null, everCracked: false };
}

/** One tick of the Rider (spec §15 step 10): input, physics, hazards, shooting. */
export function stepRider(ctx: FightCtx, input: RiderInput, events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  const geo = trainGeometry(state.train.cars);
  expireFlags(state);
  if (r.mode !== 'active') {
    // Back at the rear once the time is up, but not into the river (spec §6.3).
    if (r.respawnTicks > 0) r.respawnTicks--;
    if (r.respawnTicks <= 0 && !respawnBlocked(ctx, geo)) respawn(ctx, geo, events);
    return;
  }
  if (r.invulnTicks > 0) r.invulnTicks--;
  if (r.stunTicks > 0) r.stunTicks--;
  // The brakes slammed on (spec §5.2): thrown forward, unless braced; the spyglass drops. Thrown
  // off your feet costs a heart; in mid-air it's only a shove.
  if (state.train.lurchTick === state.tick) {
    const standing = r.onGround;
    if (throwFigure(geo, r, state.train.v)) {
      r.scoped = false;
      events.push({ type: 'thrown', who: 'rider' });
      if (standing) hurtRider(ctx, 'lurch', events);
      if (r.mode !== 'active') return;
    }
  }

  // The spyglass (spec §6.5): the Rider stands still while looking.
  r.scoped = input.scope && canScope(ctx, geo);
  if (r.scoped) {
    const target = SCOPE_MIN + Math.min(1, Math.max(0, input.scopeT)) * (ctx.scopeMax - SCOPE_MIN);
    r.scopeDist += (target - r.scopeDist) * SCOPE_SMOOTH;
    r.vx = 0;
    if (input.flagPressed) placeFlag(ctx, events);
  }

  const prevX = r.x;
  const inp: BodyInput = r.scoped
    ? { ...IDLE, crouch: input.down }
    : { moveX: input.moveX, up: input.up, down: input.down, downPressed: input.downPressed, jumpPressed: input.jumpPressed, crouch: input.down };
  const res = stepBody(geo, r, r.stunTicks > 0 ? STUNNED : inp, RIDER_WALK, RIDER_CROUCH_WALK, windOf(state.train.v));
  if (res.jumped) events.push({ type: 'jump' });
  if (res.landed) events.push({ type: 'land', hard: res.hard });

  // Off the train, swept off it by a tunnel or washed off in a ford; knocked flat by a low bridge
  // (spec §4.3, §6.3).
  if (r.y < FALL_OFF_Y) {
    riderOff(ctx, 'fall', events);
    return;
  }
  if (tunnelHits(ctx.hazards, r.x, r.y)) {
    riderOff(ctx, 'tunnel', events);
    return;
  }
  if (fordHits(ctx.hazards, r.x, r.y)) {
    riderOff(ctx, 'water', events);
    return;
  }
  // A burning trestle's flames burn anyone outside the cars (spec §4.3): a heart as they reach you,
  // and another each time the invulnerability after the last one runs out.
  if (fireHits(geo, ctx.hazards, r.x, r.y) && !state.godMode) {
    hurtRider(ctx, 'fire', events);
    if (r.mode !== 'active') return;
  }
  if (bridgeHits(geo, ctx.hazards, state.train.v, prevX, r.x, r.y, bodyHeight(r)) && !state.godMode) {
    hurtRider(ctx, 'bridge', events);
    if (r.mode !== 'active') return;
    r.stunTicks = secondsToTicks(STUN_SECONDS);
    r.crouch = true;
    r.ladder = null;
  }
  track(ctx, geo);
  // Moving fast spoils a horseman's aim (spec §7.2).
  if (Math.hypot(r.vx, r.vy) > FAST_MOVE) r.lastFastTick = state.tick;
  recoverLoot(ctx, events);
  heal(ctx);
  weapons(ctx, geo, input, events);
}

/** Walking over dropped loot returns it to the safe at once (spec §6.6); the safe is shut again. */
function recoverLoot(ctx: FightCtx, events: SimEvent[]): void {
  const { rider: r, loot } = ctx.state;
  if (loot.status !== 'dropped' || Math.abs(r.x - loot.x) > LOOT_REACH || Math.abs(r.y - loot.y) > LOOT_REACH_Y) return;
  Object.assign(loot, { status: 'safe', crack: 0, carrier: null });
  events.push({ type: 'lootRecovered' });
}

/** Inside the caboose, a heart every CABOOSE_HEAL_SECONDS (spec §5.1); leaving resets the count. */
function heal(ctx: FightCtx): void {
  const { state } = ctx;
  const r = state.rider;
  const inCaboose = r.inside !== null && state.train.cars[r.inside].kind === 'caboose';
  if (!inCaboose || r.hearts >= r.maxHearts) {
    if (r.healTicks) r.healTicks = 0;
    return;
  }
  r.healTicks = (r.healTicks ?? 0) + 1;
  if (r.healTicks >= secondsToTicks(CABOOSE_HEAL_SECONDS)) {
    r.hearts++;
    r.healTicks = 0;
  }
}

// ---- The spyglass (spec §6.5) -------------------------------------------------------------------

const SCOPE_PLACES: ReadonlySet<string> = new Set(['roof', 'tenderTop', 'cabRoof', 'cupola']);

function canScope(ctx: FightCtx, geo: TrainGeometry): boolean {
  const r = ctx.state.rider;
  return (
    r.onGround &&
    r.ladder === null &&
    r.stunTicks === 0 &&
    r.surface !== null &&
    SCOPE_PLACES.has(r.surface) &&
    interiorAt(geo, r.x, r.y) === null &&
    !inTunnel(ctx.hazards, r.x)
  );
}

/**
 * A flag on the Engineer's map at the middle of the view: the look-ahead point past the loco. There
 * are at most FLAG_MAX (one): a new flag replaces the oldest.
 */
function placeFlag(ctx: FightCtx, events: SimEvent[]): void {
  const { state } = ctx;
  const p = ctx.trackPointAt(state.train.length + state.rider.scopeDist);
  if (!p) return;
  const flag = { id: state.nextId++, point: { edge: p.edge, off: p.off }, tick: state.tick };
  state.flags.push(flag);
  while (state.flags.length > FLAG_MAX) state.flags.shift();
  events.push({ type: 'flagPlaced', flag: { ...flag, point: { ...flag.point } } });
}

/** Flags last FLAG_TTL_SECONDS, or until the train reaches them. */
function expireFlags(state: GameState): void {
  const ttl = secondsToTicks(FLAG_TTL_SECONDS);
  if (state.flags.some((f) => state.tick - f.tick >= ttl || xOnSpans(state.train.spans, f.point) !== null)) {
    state.flags = state.flags.filter((f) => state.tick - f.tick < ttl && xOnSpans(state.train.spans, f.point) === null);
  }
}

// ---- Weapons (spec §6.4) ------------------------------------------------------------------------

function weapons(ctx: FightCtx, geo: TrainGeometry, input: RiderInput, events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  if (r.cooldownTicks > 0) r.cooldownTicks--;
  if (r.reloadTicks > 0 && --r.reloadTicks === 0) r.ammo[r.weapon] = WEAPONS[r.weapon].rounds;
  if (input.weaponPressed) switchWeapon(r, input.weaponPressed);
  r.aim = input.aim;
  r.facing = Math.cos(input.aim) >= 0 ? 1 : -1;
  if (input.reloadPressed) startReload(state, events);
  if (r.stunTicks > 0 || r.scoped || !(input.firePressed || input.firing)) return;
  if (r.ammo[r.weapon] <= 0) {
    // An empty click: reload by itself (spec §6.4).
    if (input.firePressed && r.reloadTicks === 0) {
      events.push({ type: 'dryFire' });
      startReload(state, events);
    }
    return;
  }
  if (r.cooldownTicks > 0 || r.reloadTicks > 0) return;
  fire(ctx, geo, input.aim, events);
}

function switchWeapon(r: RiderState, want: Weapon | 'next'): void {
  const next = want === 'next' ? r.weapons[(r.weapons.indexOf(r.weapon) + 1) % r.weapons.length] : want;
  if (next === r.weapon || !r.weapons.includes(next)) return;
  r.weapon = next;
  r.reloadTicks = 0;
  r.cooldownTicks = Math.max(r.cooldownTicks, secondsToTicks(WEAPON_SWITCH_SECONDS));
}

function startReload(state: GameState, events: SimEvent[]): void {
  const r = state.rider;
  const spec = WEAPONS[r.weapon];
  if (r.reloadTicks > 0 || r.ammo[r.weapon] >= spec.rounds) return;
  const factor = state.upgrades.includes('quickReload') ? QUICK_RELOAD_FACTOR : 1;
  r.reloadTicks = Math.max(1, secondsToTicks(spec.reload * factor));
  events.push({ type: 'reload', weapon: r.weapon });
}

interface Trace {
  t: number;
  hit: 'bandit' | 'horseman' | 'car' | 'none';
  layer: ShotLayer;
  index: number;
}

/** Hitscan from the shoulder, a tracer per pellet (spec §6.4). */
function fire(ctx: FightCtx, geo: TrainGeometry, aim: number, events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  const spec = WEAPONS[r.weapon];
  r.ammo[r.weapon]--;
  r.cooldownTicks = secondsToTicks(spec.interval);
  state.stats.shotsFired++;
  const ox = r.x;
  const oy = r.y + (r.crouch ? RIDER_SHOULDER_CROUCH : RIDER_SHOULDER);
  // Inside a car only the armored car's gun slits reach the trackside lane.
  const trackside = r.inside === null || state.train.cars[r.inside].kind === 'armored';
  const base = state.assists.rider ? assisted(ctx, geo, ox, oy, aim, spec.range, trackside) : aim;
  let hitSomething = false;
  for (let p = 0; p < spec.pellets; p++) {
    const a = base + (rand(state.rng) * 2 - 1) * spec.spread * DEG;
    const tr = trace(ctx, geo, ox, oy, a, spec.range, trackside);
    if (tr.hit === 'bandit') damageBandit(ctx, state.bandits[tr.index], spec.damage, events);
    else if (tr.hit === 'horseman') damageHorseman(ctx, state.horsemen[tr.index], spec.damage, events);
    if (tr.hit === 'bandit' || tr.hit === 'horseman') hitSomething = true;
    events.push({ type: 'shot', by: 'rider', weapon: r.weapon, layer: tr.layer, x0: ox, y0: oy, x1: ox + Math.cos(a) * tr.t, y1: oy + Math.sin(a) * tr.t, hit: tr.hit });
  }
  if (hitSomething) state.stats.hits++;
}

function trace(ctx: FightCtx, geo: TrainGeometry, ox: number, oy: number, a: number, range: number, trackside: boolean): Trace {
  const { state } = ctx;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  // The train layer stops at the first wall or roof; the trackside lane ignores the train.
  const wall = raySolid(geo, ox, oy, dx, dy, range);
  let best: Trace = { t: Infinity, hit: 'none', layer: 'train', index: -1 };
  state.bandits.forEach((b, i) => {
    if (!banditAlive(b)) return;
    const t = rayRect(banditBox(b), ox, oy, dx, dy, wall);
    if (t !== null && t < best.t) best = { t, hit: 'bandit', layer: 'train', index: i };
  });
  if (trackside) {
    state.horsemen.forEach((h, i) => {
      if (!horsemanAlive(h)) return;
      const t = rayRect(horsemanBox(h), ox, oy, dx, dy, range);
      if (t !== null && t < best.t) best = { t, hit: 'horseman', layer: 'trackside', index: i };
    });
  }
  if (best.hit !== 'none') return best;
  const nearHorseman =
    trackside &&
    state.horsemen.some((h) => {
      if (!horsemanAlive(h)) return false;
      const t = Math.min(range, Math.max(0, (h.x - ox) * dx + (HORSEMAN_CHEST_Y - oy) * dy));
      return Math.hypot(ox + dx * t - h.x, oy + dy * t - HORSEMAN_CHEST_Y) <= NEAR_MISS;
    });
  if (nearHorseman) return { t: dy < 0 ? Math.min(range, oy / -dy) : range, hit: 'none', layer: 'trackside', index: -1 };
  return wall < range ? { t: wall, hit: 'car', layer: 'train', index: -1 } : { t: range, hit: 'none', layer: 'train', index: -1 };
}

/** The Rider assist's aim assist: a shot within AIM_ASSIST_DEGREES of a target snaps to it (spec §6.4). */
function assisted(ctx: FightCtx, geo: TrainGeometry, ox: number, oy: number, aim: number, range: number, trackside: boolean): number {
  let best = aim;
  let bestDiff = AIM_ASSIST_DEGREES * DEG;
  const consider = (tx: number, ty: number): void => {
    if (Math.hypot(tx - ox, ty - oy) > range) return;
    const a = Math.atan2(ty - oy, tx - ox);
    const diff = Math.abs(Math.atan2(Math.sin(a - aim), Math.cos(a - aim)));
    if (diff <= bestDiff) {
      bestDiff = diff;
      best = a;
    }
  };
  for (const b of ctx.state.bandits) if (banditAlive(b) && lineOfSight(geo, ox, oy, b.x, chestY(b))) consider(b.x, chestY(b));
  if (trackside) for (const h of ctx.state.horsemen) if (horsemanAlive(h)) consider(h.x, HORSEMAN_CHEST_Y);
  return best;
}

/** Keeps the whereabouts current: nearest car, and the interior (if any). */
function track(ctx: FightCtx, geo: TrainGeometry): void {
  const r = ctx.state.rider;
  r.car = carAt(ctx.state.train.cars, r.x);
  r.inside = interiorAt(geo, r.x, r.y)?.car ?? null;
}

/**
 * A respawn waits while the rear platform is in a ford or a burning trestle's flames (spec §6.3),
 * or, on a train with nothing behind the tender, while a tunnel is over the tender top it would put
 * the Rider on.
 */
function respawnBlocked(ctx: FightCtx, geo: TrainGeometry): boolean {
  const { x, y } = geo.respawn;
  return fordHits(ctx.hazards, x, y) || fireHits(geo, ctx.hazards, x, y) || tunnelHits(ctx.hazards, x, y);
}

function respawn(ctx: FightCtx, geo: TrainGeometry, events: SimEvent[]): void {
  const r = ctx.state.rider;
  const wasDown = r.mode === 'down';
  const s = supportAt(geo, geo.respawn.x, geo.respawn.y);
  Object.assign(r, {
    x: geo.respawn.x,
    y: geo.respawn.y,
    vx: 0,
    vy: 0,
    onGround: true,
    surface: s >= 0 ? geo.surfaces[s].kind : null,
    ladder: null,
    crouch: false,
    mode: 'active',
    respawnTicks: 0,
    invulnTicks: secondsToTicks(INVULN_SECONDS),
  });
  if (wasDown) r.hearts = r.maxHearts;
  track(ctx, geo);
  events.push({ type: 'riderBack' });
}
