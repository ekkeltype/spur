// A test Rider: wanders the train, jumps, crouches, climbs, shoots at whoever is nearest, reloads,
// scopes now and then and places flags. Random but not senseless, so soak tests exercise real play.

import { regionOf, steerTo } from '../src/sim/bandits';
import { windOf } from '../src/sim/body';
import { trainGeometry } from '../src/sim/geometry';
import { chance, pick, rand, type RngState } from '../src/sim/rng';
import { RIDER_SHOULDER, RIDER_WALK, WEAPONS } from '../src/sim/rules';
import { NO_INPUT, type BanditState, type GameState, type RiderInput } from '../src/sim/types';

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

/**
 * A competent Rider for balance checks: guards the express car, keeps its gun working (fires when
 * ready, reloads when empty) at the nearest enemy, and goes after bandits aboard (the cab first),
 * finding its way along the train with the bandits' own navigation. It knows nothing of tunnels or
 * bridges (the Engineer would call those), so it pays for them like a distracted player.
 */
export class GuardBot {
  /** Optional human-like imprecision: aim wobble (radians) and the chance per ready tick to pull the trigger. */
  constructor(
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
    // Where to be: beside the bandit being chased, else on the express car's roof (or the first car's).
    const home = geo.surfaces.find((sf) => sf.kind === 'roof' && state.train.cars[sf.car].kind === 'express') ?? geo.surfaces.find((sf) => sf.kind === 'roof');
    let goal: { region: number; x: number } | null = null;
    if (chase) {
      const region = regionOf(geo, chase);
      if (region >= 0) goal = { region, x: chase.x };
    } else if (home) {
      goal = { region: home.region, x: (home.x0 + home.x1) / 2 };
    }
    if (goal) {
      const step = steerTo(geo, r, goal, windOf(state.train.v), RIDER_WALK);
      const near = chase && Math.abs(chase.x - r.x) < 2 && Math.abs(chase.y - r.y) < 1;
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
