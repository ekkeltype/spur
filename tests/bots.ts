// A test Rider: wanders the train, jumps, crouches, climbs, shoots at whoever is nearest, reloads,
// scopes now and then and places flags. Random but not senseless, so soak tests exercise real play.

import { chance, pick, rand, type RngState } from '../src/sim/rng';
import { RIDER_SHOULDER } from '../src/sim/rules';
import { NO_INPUT, type GameState, type RiderInput } from '../src/sim/types';

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
