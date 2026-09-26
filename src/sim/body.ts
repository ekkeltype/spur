// Figure physics shared by the Rider and boarded bandits (spec §6.3, §7.3): walking with the
// wind, crouching, jumping, falling, ladders, hatches, and collisions with the train's walls.
// A figure is a box RIDER_WIDTH wide standing on its feet at (x, y). Surfaces hold it from above
// only; solids block it from every side.

import { interiorAt, ROOF_THICKNESS, STEP_UP, supportAt, type TrainGeometry } from './geometry';
import {
  DT,
  HARD_LANDING,
  LADDER_JUMP,
  LADDER_REACH,
  LADDER_SPEED,
  LADDER_TOP_REACH,
  RIDER_ACCEL,
  RIDER_CROUCH_HEIGHT,
  RIDER_GRAVITY,
  RIDER_HEIGHT,
  RIDER_JUMP_V,
  RIDER_WIDTH,
  WIND_AIR_ACCEL,
  WIND_MAX,
  WIND_REF_SPEED,
  WIND_WALK_BACK,
  WIND_WALK_FWD,
} from './rules';
import type { Dir, SurfaceKind } from './types';

// ---- Tunables (candidates for rules.ts) ---------------------------------------------------------

export const HALF_W = RIDER_WIDTH / 2;
const EPS = 1e-6;

/** The fields of RiderState and BanditState this module moves. */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  surface: SurfaceKind | null;
  ladder: number | null;
  crouch: boolean;
}

/** What the figure is trying to do this tick. */
export interface BodyInput {
  moveX: -1 | 0 | 1;
  /** W held: grab and climb a ladder, or climb out through a hatch from beneath. */
  up: boolean;
  /** S held: climb down a ladder. */
  down: boolean;
  /** S pressed: mount a ladder from its top, or drop through a hatch. */
  downPressed: boolean;
  jumpPressed: boolean;
  crouch: boolean;
  /**
   * The ladder meant, where two are within reach (a car's end ladder hangs 0.33 m from the
   * tender's). Without one, the nearest is taken.
   */
  ladder?: number;
}

export const IDLE: BodyInput = { moveX: 0, up: false, down: false, downPressed: false, jumpPressed: false, crouch: false };

export interface Wind {
  /** Which way it pushes in the train frame: toward the rear (−1) when the train runs forward. */
  dir: Dir | 0;
  /** Strength: (|v| / WIND_REF_SPEED)², capped at WIND_MAX (spec §6.3). */
  w: number;
}

export interface BodyStep {
  jumped: boolean;
  landed: boolean;
  hard: boolean;
  /** Dropped through a hatch. */
  dropped: boolean;
}

export function windOf(trainV: number): Wind {
  const w = Math.min(WIND_MAX, (trainV / WIND_REF_SPEED) ** 2);
  return { dir: trainV > 0 ? -1 : trainV < 0 ? 1 : 0, w };
}

export function bodyHeight(b: Body): number {
  return b.crouch ? RIDER_CROUCH_HEIGHT : RIDER_HEIGHT;
}

/** Surfaces the wind blows across (spec §6.3: not inside, not in the cab). */
const WINDY: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['roof', 'cupola', 'tenderTop', 'cabRoof', 'platform']);

/** Is this a surface out in the wind: a roof, the cupola, the tender top, the cab roof or a platform? */
export function windySurface(s: SurfaceKind | null): boolean {
  return s !== null && WINDY.has(s);
}

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}

function overlapsX(s: { x0: number; x1: number }, x: number): boolean {
  return x + HALF_W > s.x0 + EPS && x - HALF_W < s.x1 - EPS;
}

/** Advances a figure one tick. `walk` and `crouchWalk` are its top speeds on a still train. */
export function stepBody(geo: TrainGeometry, b: Body, inp: BodyInput, walk: number, crouchWalk: number, wind: Wind): BodyStep {
  const out: BodyStep = { jumped: false, landed: false, hard: false, dropped: false };
  if (b.ladder !== null) {
    climb(geo, b, inp, walk, out);
    return out;
  }
  depenetrate(geo, b);

  // W next to a ladder grabs it rather than jumping (spec §6.2); S at a ladder's top climbs down it,
  // and S on a hatch drops inside.
  if (inp.up) {
    const li = ladderToGrab(geo, b, inp.ladder);
    if (li >= 0) {
      attach(geo, b, li, b.y);
      return out;
    }
  }
  if (b.onGround && inp.downPressed) {
    const li = ladderTopAt(geo, b, inp.ladder);
    if (li >= 0) {
      attach(geo, b, li, geo.ladders[li].y1 - 0.01);
      return out;
    }
    const h = geo.hatches.find((q) => Math.abs(b.x - q.x) <= q.x1 - q.x && Math.abs(b.y - q.roofY) < EPS);
    if (h) {
      // Through the opening: just under the roof, falling to the floor.
      Object.assign(b, { x: h.x, y: h.roofY - ROOF_THICKNESS - RIDER_HEIGHT - 0.01, vx: 0, vy: 0, onGround: false, surface: null, crouch: false });
      out.dropped = true;
      return out;
    }
  }

  b.crouch = b.onGround && inp.crouch;
  const inside = interiorAt(geo, b.x, b.y) !== null;
  if (b.onGround) {
    let top = b.crouch ? crouchWalk : walk;
    if (inp.moveX !== 0 && wind.dir !== 0 && !inside && windySurface(b.surface)) {
      top *= inp.moveX === wind.dir ? 1 + WIND_WALK_BACK * wind.w : 1 - WIND_WALK_FWD * wind.w;
    }
    b.vx = approach(b.vx, inp.moveX * top, RIDER_ACCEL * DT);
    if (inp.jumpPressed) {
      b.vy = RIDER_JUMP_V;
      b.onGround = false;
      b.surface = null;
      b.crouch = false;
      out.jumped = true;
    }
  }
  // In the air the wind pushes (spec §6.3); there's no steering. The update is exact for constant
  // acceleration, so jump heights and reaches match the spec's figures.
  const ax = !b.onGround && !inside ? wind.dir * WIND_AIR_ACCEL * wind.w : 0;
  const ay = b.onGround ? 0 : -RIDER_GRAVITY;
  const dx = b.vx * DT + 0.5 * ax * DT * DT;
  const dy = b.vy * DT + 0.5 * ay * DT * DT;
  b.vx += ax * DT;
  b.vy += ay * DT;
  moveX(geo, b, dx);
  moveY(geo, b, dy, out);
  if (b.onGround) settle(geo, b);
  return out;
}

function attach(geo: TrainGeometry, b: Body, li: number, y: number): void {
  Object.assign(b, { ladder: li, x: geo.ladders[li].x, y, vx: 0, vy: 0, onGround: false, surface: null, crouch: false });
}

function climb(geo: TrainGeometry, b: Body, inp: BodyInput, walk: number, out: BodyStep): void {
  const l = geo.ladders[b.ladder as number];
  b.x = l.x;
  b.vx = 0;
  b.vy = 0;
  if (inp.jumpPressed && !inp.up) {
    b.ladder = null;
    b.vy = RIDER_JUMP_V * LADDER_JUMP;
    b.vx = inp.moveX * walk;
    out.jumped = true;
    return;
  }
  if (inp.moveX !== 0 && !inp.up && !inp.down) {
    b.ladder = null; // let go
    return;
  }
  b.y += ((inp.up ? 1 : 0) - (inp.down ? 1 : 0)) * LADDER_SPEED * DT;
  if (b.y >= l.y1 - EPS) {
    Object.assign(b, { ladder: null, x: l.topX, y: l.y1, onGround: true, surface: geo.surfaces[l.top].kind });
  } else if (b.y <= l.y0 + EPS) {
    Object.assign(b, { ladder: null, y: l.y0, onGround: true, surface: geo.surfaces[l.bottom].kind });
  }
}

function canGrab(b: Body, l: TrainGeometry['ladders'][number]): boolean {
  return Math.abs(b.x - l.x) <= LADDER_REACH && b.y >= l.y0 - 0.25 && b.y <= l.y1 - 0.1;
}

function canMountTop(b: Body, l: TrainGeometry['ladders'][number]): boolean {
  return l.kind !== 'hatch' && Math.abs(b.x - l.topX) <= LADDER_TOP_REACH && Math.abs(b.y - l.y1) < EPS;
}

/** The ladder W grabs: the one meant if it's within reach, else the nearest. */
function ladderToGrab(geo: TrainGeometry, b: Body, meant: number | undefined): number {
  if (meant !== undefined && geo.ladders[meant]) return canGrab(b, geo.ladders[meant]) ? meant : -1;
  let best = -1;
  for (let i = 0; i < geo.ladders.length; i++) {
    if (!canGrab(b, geo.ladders[i])) continue;
    if (best < 0 || Math.abs(b.x - geo.ladders[i].x) < Math.abs(b.x - geo.ladders[best].x)) best = i;
  }
  return best;
}

function ladderTopAt(geo: TrainGeometry, b: Body, meant: number | undefined): number {
  if (meant !== undefined && geo.ladders[meant]) return canMountTop(b, geo.ladders[meant]) ? meant : -1;
  for (let i = 0; i < geo.ladders.length; i++) if (canMountTop(b, geo.ladders[i])) return i;
  return -1;
}

/** Pushes a figure sideways out of any solid it overlaps (after letting go of a ladder, say). */
function depenetrate(geo: TrainGeometry, b: Body): void {
  const h = bodyHeight(b);
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const s of geo.solids) {
      if (b.y + EPS >= s.y1 || b.y + h - EPS <= s.y0 || !overlapsX(s, b.x)) continue;
      const left = s.x0 - HALF_W - b.x;
      const right = s.x1 + HALF_W - b.x;
      b.x += Math.abs(left) <= Math.abs(right) ? left : right;
      moved = true;
    }
    if (!moved) return;
  }
}

function moveX(geo: TrainGeometry, b: Body, dx: number): void {
  if (dx === 0) return;
  const h = bodyHeight(b);
  let nx = b.x + dx;
  for (const s of geo.solids) {
    if (b.y + EPS >= s.y1 || b.y + h - EPS <= s.y0) continue;
    if (dx > 0) {
      const face = s.x0 - HALF_W;
      if (b.x <= face + EPS && nx > face) {
        nx = face;
        b.vx = 0;
      }
    } else {
      const face = s.x1 + HALF_W;
      if (b.x >= face - EPS && nx < face) {
        nx = face;
        b.vx = 0;
      }
    }
  }
  b.x = nx;
}

function moveY(geo: TrainGeometry, b: Body, dy: number, out: BodyStep): void {
  if (dy === 0) return;
  let ny = b.y + dy;
  if (dy < 0) {
    // Land on the highest surface the feet pass through.
    let land = -Infinity;
    for (const s of geo.surfaces) {
      if (overlapsX(s, b.x) && s.y <= b.y + EPS && s.y >= ny - EPS && s.y > land) land = s.y;
    }
    if (land > -Infinity) {
      out.landed = true;
      out.hard = b.vy < -HARD_LANDING;
      ny = land;
      b.vy = 0;
      b.onGround = true;
    }
  } else {
    // Heads bump the undersides of solids (ceilings, the cab roof).
    const h = bodyHeight(b);
    for (const s of geo.solids) {
      if (!overlapsX(s, b.x)) continue;
      const under = s.y0 - h;
      if (b.y <= under + EPS && ny > under) {
        ny = under;
        b.vy = 0;
      }
    }
  }
  b.y = ny;
  if (b.onGround) {
    const s = supportAt(geo, b.x, b.y);
    b.surface = s >= 0 ? geo.surfaces[s].kind : null;
  }
}

/** On the ground: step up onto a slightly higher surface, or start falling if nothing's underfoot. */
function settle(geo: TrainGeometry, b: Body): void {
  let best = -Infinity;
  for (const s of geo.surfaces) {
    if (overlapsX(s, b.x) && s.y >= b.y - EPS && s.y <= b.y + STEP_UP + EPS && s.y > best) best = s.y;
  }
  if (best === -Infinity) {
    b.onGround = false;
    b.surface = null;
    return;
  }
  b.y = Math.max(b.y, best);
  const s = supportAt(geo, b.x, b.y);
  b.surface = s >= 0 ? geo.surfaces[s].kind : null;
}
