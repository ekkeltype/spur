// What the Rider and the bandits share each tick (spec §6, §7): the context game.ts builds for them,
// and the track hazards that hit anyone on the train "exactly as they hit the Rider" (spec §7.3).

import { bodyHeight, HALF_W, windySurface, type Body } from './body';
import { groundBelow, interiorAt, trainGeometry, type Rect, type TrainGeometry } from './geometry';
import {
  BOARD_KNOCKBACK,
  DT,
  FORD_WATER_Y,
  HORSEMAN_HALF_W,
  HORSEMAN_Y0,
  HORSEMAN_Y1,
  INVULN_SECONDS,
  LOW_BRIDGE_CLEARANCE,
  LURCH_HOP_VX,
  LURCH_HOP_VY,
  LURCH_STAGGER_SECONDS,
  RESPAWN_DOWN_SECONDS,
  RESPAWN_OFF_CABOOSE_SECONDS,
  RESPAWN_OFF_SECONDS,
  secondsToTicks,
  TUNNEL_FEET_Y,
} from './rules';
import type { BanditState, FrameHazard, GameState, HorsemanState, HurtCause, RunDef, SimEvent, SurfaceKind, TrackPoint } from './types';

// ---- Tunables (candidates for rules.ts) ---------------------------------------------------------

export interface FightCtx {
  state: GameState;
  run: RunDef;
  /** Tunnels, low bridges, trestles and fords near the train, in the train frame (lowBridge: x0 = x1). */
  hazards: FrameHazard[];
  /** Train-frame x → track point (for spyglass flags), or null beyond the known track. */
  trackPointAt(x: number): TrackPoint | null;
  /** The spyglass's reach now (night and the headlamp already applied). */
  scopeMax: number;
}

/** Is train-frame x inside a tunnel? */
export function inTunnel(hazards: readonly FrameHazard[], x: number): boolean {
  return hazards.some((h) => h.kind === 'tunnel' && x >= h.x0 && x <= h.x1);
}

/**
 * Does a tunnel's roof sweep a figure off the train (spec §4.3)? Anyone with their feet above
 * TUNNEL_FEET_Y: on a roof, the cab roof, the tender top, or a ladder's upper rungs.
 */
export function tunnelHits(hazards: readonly FrameHazard[], x: number, y: number): boolean {
  return y > TUNNEL_FEET_Y && inTunnel(hazards, x);
}

/** Is train-frame x in a ford, where the river runs over the line? */
export function inFord(hazards: readonly FrameHazard[], x: number): boolean {
  return hazards.some((h) => h.kind === 'ford' && x >= h.x0 && x <= h.x1);
}

/**
 * Does a ford wash a figure off the train (spec §4.3)? Anyone with their feet below FORD_WATER_Y:
 * on a platform, the tender deck, in the cab or a car, or on a ladder's low rungs. Only the roofs,
 * the cab roof and the tender top are dry.
 */
export function fordHits(hazards: readonly FrameHazard[], x: number, y: number): boolean {
  return y < FORD_WATER_Y && inFord(hazards, x);
}

/** Is train-frame x over a burning trestle? */
export function inFire(hazards: readonly FrameHazard[], x: number): boolean {
  return hazards.some((h) => h.kind === 'trestle' && h.burning === true && x >= h.x0 && x <= h.x1);
}

/**
 * Do a burning trestle's flames reach a figure (spec §4.3)? Everywhere outside the car bodies: the
 * roofs, the tender, the platforms, the ladders, the air. Inside a car or the cab is sheltered.
 */
export function fireHits(geo: TrainGeometry, hazards: readonly FrameHazard[], x: number, y: number): boolean {
  return inFire(hazards, x) && interiorAt(geo, x, y) === null;
}

/** Is train-frame x over a trestle (a fall from here is a long one)? */
export function overTrestle(hazards: readonly FrameHazard[], x: number): boolean {
  return hazards.some((h) => h.kind === 'trestle' && x >= h.x0 && x <= h.x1);
}

/**
 * Did a low bridge's beam sweep across a figure this tick, too low for it (spec §4.3)? The beam
 * sits LOW_BRIDGE_CLEARANCE above the roof or tender top under the figure: standing there hits
 * it, crouching passes. Over a gap or a platform it's above the highest roof.
 * `prevX` is where the figure was before this tick's move; the beam was v·DT further ahead.
 */
export function bridgeHits(geo: TrainGeometry, hazards: readonly FrameHazard[], trainV: number, prevX: number, x: number, y: number, height: number): boolean {
  for (const h of hazards) {
    if (h.kind !== 'lowBridge') continue;
    const rel = h.x0 - x;
    const prevRel = h.x0 + trainV * DT - prevX;
    const was = Math.abs(prevRel) <= HALF_W;
    const now = Math.abs(rel) <= HALF_W;
    const across = !was && !now && Math.sign(rel) !== Math.sign(prevRel);
    if (was || !(now || across)) continue;
    if (y + height > beamY(geo, x)) return true;
  }
  return false;
}

// ---- Hurting the Rider (spec §6.3) --------------------------------------------------------------

/**
 * A hit on the Rider (a bullet, a low bridge): a heart, then 0.8 s of invulnerability. At 0 hearts
 * the Rider is down. Returns whether it took a heart.
 */
export function hurtRider(ctx: FightCtx, cause: HurtCause, events: SimEvent[]): boolean {
  const { state } = ctx;
  const r = state.rider;
  if (r.mode !== 'active' || state.godMode || r.invulnTicks > 0) return false;
  r.hearts = Math.max(0, r.hearts - 1);
  state.stats.heartsLost++;
  r.invulnTicks = secondsToTicks(INVULN_SECONDS);
  events.push({ type: 'riderHurt', cause, hearts: r.hearts });
  if (r.hearts <= 0) riderDown(ctx, events);
  return true;
}

/**
 * Off the train (a fall, swept off by a tunnel or washed off in a ford): a heart, then back at the
 * rear after RESPAWN_OFF (sooner with a caboose). A fall from a trestle, or losing the last heart,
 * puts the Rider down instead.
 */
export function riderOff(ctx: FightCtx, cause: 'tunnel' | 'water' | 'fall', events: SimEvent[]): void {
  const { state } = ctx;
  const r = state.rider;
  const longFall = overTrestle(ctx.hazards, r.x);
  if (!state.godMode) {
    r.hearts = Math.max(0, r.hearts - 1);
    state.stats.heartsLost++;
    events.push({ type: 'riderHurt', cause, hearts: r.hearts });
  }
  if (longFall || r.hearts <= 0) {
    riderDown(ctx, events);
    return;
  }
  leaveTrain(state);
  const caboose = state.train.cars.some((c) => c.kind === 'caboose');
  r.mode = 'off';
  r.respawnTicks = secondsToTicks(caboose ? RESPAWN_OFF_CABOOSE_SECONDS : RESPAWN_OFF_SECONDS);
  state.stats.timesOff++;
  events.push({ type: 'riderOff', cause });
}

/** Down: back at the rear after RESPAWN_DOWN with full hearts; the run goes on meanwhile. */
export function riderDown(ctx: FightCtx, events: SimEvent[]): void {
  const { state } = ctx;
  leaveTrain(state);
  state.rider.mode = 'down';
  state.rider.respawnTicks = secondsToTicks(RESPAWN_DOWN_SECONDS);
  state.stats.timesDown++;
  events.push({ type: 'riderDown' });
}

// ---- The lurch (spec §5.2) ----------------------------------------------------------------------

/**
 * The brakes slammed on: the train slows hard and anyone standing outside keeps going. A figure
 * upright on a windy surface (a roof, the cupola, the tender top, the cab roof, a platform) is
 * thrown toward the loco (toward the rear when reversing): a hop forward and up, then staggered
 * like a knockdown, but unhurt. One already in the air is only shoved forward. Crouching, ladders,
 * the cab and the insides of cars brace you. Returns whether the figure was thrown.
 */
export function throwFigure(geo: TrainGeometry, f: Body & { stunTicks: number }, trainV: number): boolean {
  if (f.ladder !== null || interiorAt(geo, f.x, f.y) !== null) return false;
  const shove = Math.sign(trainV) * LURCH_HOP_VX;
  if (!f.onGround) {
    f.vx += shove;
    return true;
  }
  if (f.crouch || !windySurface(f.surface)) return false;
  Object.assign(f, { vx: f.vx + shove, vy: LURCH_HOP_VY, onGround: false, surface: null, crouch: false });
  f.stunTicks = Math.max(f.stunTicks, secondsToTicks(LURCH_STAGGER_SECONDS));
  return true;
}

// ---- Targets (spec §6.4, §7) ------------------------------------------------------------------

export function banditBox(b: BanditState): Rect {
  return { x0: b.x - HALF_W, x1: b.x + HALF_W, y0: b.y, y1: b.y + bodyHeight(b) };
}

/** Where shots at a figure (the Rider or a bandit) are aimed, and where their hits land. */
export function chestY(b: Body): number {
  return b.y + bodyHeight(b) / 2;
}

export function horsemanBox(h: HorsemanState): Rect {
  return { x0: h.x - HORSEMAN_HALF_W, x1: h.x + HORSEMAN_HALF_W, y0: HORSEMAN_Y0, y1: HORSEMAN_Y1 };
}

export function banditAlive(b: BanditState): boolean {
  return b.mode !== 'falling' && b.mode !== 'gone';
}

export function horsemanAlive(h: HorsemanState): boolean {
  return h.mode !== 'falling' && h.mode !== 'gone';
}

/** A bandit takes damage; at 0 it's down (and drops any loot). Returns whether it went down. */
export function damageBandit(ctx: FightCtx, b: BanditState, damage: number, events: SimEvent[]): boolean {
  b.hp = Math.max(0, b.hp - damage);
  if (b.hp > 0) return false;
  ctx.state.stats.banditsDowned++;
  events.push({ type: 'banditDown', id: b.id, x: b.x, y: b.y, boss: b.boss });
  removeBandit(ctx, b, events);
  return true;
}

/** Takes a bandit off the train (downed, swept off, or escaped): drops its loot where it stood. */
export function removeBandit(ctx: FightCtx, b: BanditState, events: SimEvent[], escaped = false): void {
  if (b.hasLoot && !escaped) dropLoot(ctx, b, events);
  b.hasLoot = false;
  b.mode = escaped ? 'gone' : 'falling';
  b.modeTicks = 0;
  b.aimTicks = 0;
  b.ladder = null;
}

/** A horseman takes damage: a hit while boarding knocks him back; at 0 he's down. */
export function damageHorseman(ctx: FightCtx, h: HorsemanState, damage: number, events: SimEvent[]): boolean {
  h.hp = Math.max(0, h.hp - damage);
  if (h.hp <= 0) {
    ctx.state.stats.horsemenDowned++;
    events.push({ type: 'horsemanDown', id: h.id, x: h.x, boss: h.boss });
    h.mode = 'falling';
    h.modeTicks = 0;
    h.aimTicks = 0;
    h.shyTicks = 0;
    return true;
  }
  if (h.mode === 'boarding') {
    h.mode = 'pace';
    h.modeTicks = 0;
    h.worldV -= Math.sign(ctx.state.train.v || 1) * BOARD_KNOCKBACK;
  }
  return false;
}

/** The loot falls where its carrier stood, onto whatever is below (spec §7.4). */
export function dropLoot(ctx: FightCtx, b: BanditState, events: SimEvent[]): void {
  const { state } = ctx;
  const geo = trainGeometry(state.train.cars);
  const x = Math.min(Math.max(b.x, geo.respawn.x), geo.cab.x1 - HALF_W);
  const g = groundBelow(geo, x, b.y + 1e-6);
  const y = g >= 0 ? geo.surfaces[g].y : geo.respawn.y;
  Object.assign(state.loot, { status: 'dropped', x, y, carrier: null });
  events.push({ type: 'lootDropped', x, y });
}

function leaveTrain(state: GameState): void {
  Object.assign(state.rider, { vx: 0, vy: 0, onGround: false, surface: null, ladder: null, crouch: false, scoped: false, stunTicks: 0, inside: null });
}

/** Surfaces a low bridge's beam clears by LOW_BRIDGE_CLEARANCE (spec §4.3). */
const UNDER_BEAM: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['roof', 'cupola', 'cabRoof', 'tenderTop']);

function beamY(geo: TrainGeometry, x: number): number {
  let top = -Infinity;
  for (const s of geo.surfaces) {
    if (!UNDER_BEAM.has(s.kind)) continue;
    if (x + HALF_W > s.x0 && x - HALF_W < s.x1) top = Math.max(top, s.y);
  }
  return (top === -Infinity ? geo.maxRoofY : top) + LOW_BRIDGE_CLEARANCE;
}
