// A test Rider: wanders the train, jumps, crouches, climbs, shoots at whoever is nearest, reloads,
// scopes now and then and places flags. Random but not senseless, so soak tests exercise real play.

import { regionOf, steerTo } from '../src/sim/bandits';
import { HALF_W, windOf } from '../src/sim/body';
import { hazardsNear } from '../src/sim/game';
import { trainGeometry, type TrainGeometry } from '../src/sim/geometry';
import { chance, pick, rand, type RngState } from '../src/sim/rng';
import { FORD_WATER_Y, RIDER_SHOULDER, RIDER_WALK, TUNNEL_FEET_Y, WEAPONS } from '../src/sim/rules';
import { NO_INPUT, type BanditState, type FrameHazard, type GameState, type RiderInput, type RunDef, type SurfaceKind } from '../src/sim/types';

export class BotRider {
  private moveX: -1 | 0 | 1 = 0;
  private holdDown = 0;
  private holdUp = 0;
  private scopeTicks = 0;

  constructor(private readonly rng: RngState) {}

  input(state: GameState): RiderInput {
    const rng = this.rng;
    const r = state.rider;
    const input: RiderInput = { ...NO_INPUT };
    if (r.mode !== 'active') return input;

    if (this.scopeTicks > 0) {
      this.scopeTicks--;
      input.scope = true;
      input.scopeT = rand(rng);
      input.flagPressed = chance(rng, 0.01);
      return input;
    }
    if (chance(rng, 0.002)) this.scopeTicks = 60 + Math.floor(rand(rng) * 120);

    if (chance(rng, 0.03)) this.moveX = pick(rng, [-1, 0, 1, 1] as const);
    input.moveX = this.moveX;
    if (chance(rng, 0.01)) this.holdDown = 20 + Math.floor(rand(rng) * 60);
    if (chance(rng, 0.01)) this.holdUp = 20 + Math.floor(rand(rng) * 60);
    if (this.holdDown > 0) {
      this.holdDown--;
      input.down = true;
      input.downPressed = this.holdDown % 30 === 0;
    }
    if (this.holdUp > 0) {
      this.holdUp--;
      input.up = true;
    }
    if (chance(rng, 0.02)) {
      input.jump = true;
      input.jumpPressed = true;
    }
    if (chance(rng, 0.004)) input.reloadPressed = true;
    if (chance(rng, 0.002)) input.weaponPressed = 'next';
    if (chance(rng, 0.004)) input.interactPressed = true;

    // Aim at the nearest enemy and shoot sometimes.
    const sy = r.y + RIDER_SHOULDER;
    let best: { dx: number; dy: number; d: number } | null = null;
    for (const b of state.bandits) {
      const dx = b.x - r.x;
      const dy = b.y + 1.2 - sy;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { dx, dy, d };
    }
    for (const h of state.horsemen) {
      const dx = h.x - r.x;
      const dy = 2.1 - sy;
      const d = Math.hypot(dx, dy);
      if (!best || d < best.d) best = { dx, dy, d };
    }
    if (best) {
      input.aim = Math.atan2(best.dy, best.dx) + (rand(rng) - 0.5) * 0.1;
      if (best.d < 40 && chance(rng, 0.08)) {
        input.firing = true;
        input.firePressed = true;
      }
    } else {
      input.aim = (rand(rng) - 0.5) * Math.PI;
    }
    return input;
  }
}

/** A sharp Rider acts on a tunnel or a ford the Engineer calls this many seconds before it arrives… */
const CALL_SECONDS = 6;
/** …and crouches this long before a low bridge's beam passes over. */
const DUCK_SECONDS = 1;
/** Slack (m) either side of a hazard, so the whole figure is clear of it. */
const HAZARD_SLACK = 1.5;

/** Where a low bridge's beam passes too low to stand (spec §4.3). */
const TOPS: ReadonlySet<SurfaceKind> = new Set<SurfaceKind>(['roof', 'cupola', 'tenderTop', 'cabRoof']);

/** Out of a hazard's way: floor level under a tunnel ('down'), a roof or the tender top in a ford ('up'). */
type Refuge = 'down' | 'up';

function safeAt(y: number, refuge: Refuge): boolean {
  return refuge === 'down' ? y <= TUNNEL_FEET_Y : y >= FORD_WATER_Y;
}

/** Seconds until a hazard (with slack) reaches train-frame x at the train's speed: 0 while over it, Infinity once it's past. */
function secondsUntil(h: FrameHazard, x: number, v: number): number {
  const lo = h.x0 - HAZARD_SLACK;
  const hi = h.x1 + HAZARD_SLACK;
  if (x >= lo && x <= hi) return 0;
  if (v > 0 && lo > x) return (lo - x) / v;
  if (v < 0 && hi < x) return (x - hi) / -v;
  return Infinity;
}

/**
 * What the Engineer would be calling for the Rider's spot: the soonest tunnel ('down') or ford
 * ('up') due within CALL_SECONDS, and whether a low bridge is about to pass over.
 */
function calls(state: GameState, run: RunDef): { refuge: Refuge | null; duck: boolean } {
  const { rider: r, train } = state;
  let refuge: Refuge | null = null;
  let soonest = Infinity;
  let duck = false;
  for (const h of hazardsNear(state, run, Math.max(40, Math.abs(train.v) * CALL_SECONDS + 20))) {
    const t = secondsUntil(h, r.x, train.v);
    if (h.kind === 'lowBridge') duck ||= t <= DUCK_SECONDS;
    else if ((h.kind === 'tunnel' || h.kind === 'ford') && t <= CALL_SECONDS && t < soonest) {
      soonest = t;
      refuge = h.kind === 'tunnel' ? 'down' : 'up';
    }
  }
  return { refuge, duck };
}

/** The nearest spot out of the way: the closest walk region at a safe height, and the place in it nearest x. */
function shelter(geo: TrainGeometry, x: number, refuge: Refuge): { region: number; x: number } | null {
  const extent = new Map<number, [number, number]>();
  for (const s of geo.surfaces) {
    if (!safeAt(s.y, refuge)) continue;
    const e = extent.get(s.region);
    extent.set(s.region, e ? [Math.min(e[0], s.x0), Math.max(e[1], s.x1)] : [s.x0, s.x1]);
  }
  let best: { region: number; x: number } | null = null;
  let bestD = Infinity;
  for (const [region, [x0, x1]] of extent) {
    // Wholly on it: clear of the bunker, the boiler and a roof's ends.
    const tx = Math.min(Math.max(x, x0 + HALF_W), x1 - HALF_W);
    if (Math.abs(tx - x) < bestD) {
      bestD = Math.abs(tx - x);
      best = { region, x: tx };
    }
  }
  return best;
}

/**
 * A competent Rider for balance checks: guards the express car, keeps its gun working (fires when
 * ready, reloads when empty) at the nearest enemy, and goes after bandits aboard (the cab first),
 * finding its way along the train with the bandits' own navigation. It heeds the Engineer's calls
 * as a sharp Rider would, and they come first: down to floor level for a tunnel, up on a roof or
 * the tender top for a ford, crouched for a low bridge. It keeps chasing a bandit only where it
 * can do so without leaving a safe spot.
 */
export class GuardBot {
  /** Optional human-like imprecision: aim wobble (radians) and the chance per ready tick to pull the trigger. */
  constructor(
    private readonly run: RunDef,
    private readonly rng: RngState | null = null,
    private readonly wobble = 0,
    private readonly trigger = 1,
  ) {}

  input(state: GameState): RiderInput {
    const r = state.rider;
    const input: RiderInput = { ...NO_INPUT };
    if (r.mode !== 'active') return input;
    const geo = trainGeometry(state.train.cars);
    const sy = r.y + (r.crouch ? 0.8 : RIDER_SHOULDER);
    // Who to go after: a bandit in the cab, then the nearest bandit aboard, then horsemen in range.
    let chase: BanditState | null = null;
    let best = Infinity;
    for (const b of state.bandits) {
      if (b.mode === 'gone' || b.mode === 'falling') continue;
      const d = Math.hypot(b.x - r.x, b.y - r.y) - (b.mode === 'holdup' ? 1000 : 0);
      if (d < best) {
        best = d;
        chase = b;
      }
    }
    let aimAt: { x: number; y: number; d: number } | null = chase ? { x: chase.x, y: chase.y + 1.2, d: Math.hypot(chase.x - r.x, chase.y + 1.2 - sy) } : null;
    if (!aimAt) {
      for (const h of state.horsemen) {
        if (h.mode === 'gone' || h.mode === 'falling' || h.mode === 'retreat') continue;
        const d = Math.hypot(h.x - r.x, 2.1 - sy);
        if (d < 45 && (!aimAt || d < aimAt.d)) aimAt = { x: h.x, y: 2.1, d };
      }
    }
    // Where to be: out of the way of what the Engineer is calling (still chasing a bandit on the
    // same safe footing), else beside the bandit being chased, else on the express car's roof (or
    // the first car's).
    const call = calls(state, this.run);
    const home = geo.surfaces.find((sf) => sf.kind === 'roof' && state.train.cars[sf.car].kind === 'express') ?? geo.surfaces.find((sf) => sf.kind === 'roof');
    const chaseRegion = chase ? regionOf(geo, chase) : -1;
    const chaseSafely = call.refuge !== null && chaseRegion >= 0 && r.onGround && safeAt(r.y, call.refuge) && chaseRegion === regionOf(geo, r);
    let goal: { region: number; x: number } | null = null;
    if (call.refuge !== null && !chaseSafely) {
      goal = shelter(geo, r.x, call.refuge);
    } else if (chase) {
      if (chaseRegion >= 0) goal = { region: chaseRegion, x: chase.x };
    } else if (home) {
      goal = { region: home.region, x: (home.x0 + home.x1) / 2 };
    }
    if (call.duck && r.onGround && r.surface !== null && TOPS.has(r.surface)) {
      // A low bridge: crouch where you stand. S is held, never pressed, which would open a hatch.
      input.down = true;
    } else if (goal) {
      const step = steerTo(geo, r, goal, windOf(state.train.v), RIDER_WALK);
      const near = chase && goal.region === chaseRegion && Math.abs(chase.x - r.x) < 2 && Math.abs(chase.y - r.y) < 1;
      if (!near) {
        input.moveX = step.moveX;
        input.up = step.up;
        input.down = step.down || step.crouch;
        input.downPressed = step.downPressed;
        input.jump = step.jumpPressed;
        input.jumpPressed = step.jumpPressed;
      }
    }
    if (aimAt) {
      const noise = this.rng ? (rand(this.rng) * 2 - 1) * this.wobble : 0;
      input.aim = Math.atan2(aimAt.y - sy, aimAt.x - r.x) + noise;
      const pull = !this.rng || rand(this.rng) < this.trigger;
      if (r.ammo[r.weapon] <= 0) input.reloadPressed = true;
      else if (pull && r.cooldownTicks <= 0 && r.reloadTicks <= 0 && aimAt.d < WEAPONS[r.weapon].range) {
        input.firing = true;
        input.firePressed = true;
      }
    } else if (r.ammo[r.weapon] < WEAPONS[r.weapon].rounds) {
      input.reloadPressed = true;
    }
    return input;
  }
}
