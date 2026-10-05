// Balance guards (spec §1, §13): with the autopilot as a steady Engineer, a sharp Rider wins every
// run and variant, on several seeds so it's no one seed's luck, and the bandits are a real threat:
// a Rider who does nothing loses every run whose cargo they're after, whichever the variant. Tuning
// that breaks either shows up here.

import { describe, expect, it } from 'vitest';
import { RUNS } from '../src/content/runs';
import { autopilotStep, newAutopilot } from '../src/sim/autopilot';
import { composeConsist, newGame, step } from '../src/sim/game';
import { trainGeometry } from '../src/sim/geometry';
import { FORD_WATER_Y, TICK_HZ, TUNNEL_FEET_Y } from '../src/sim/rules';
import { tryLowerSpout } from '../src/sim/train';
import { NO_INPUT, type BanditState, type CarType, type EngineerCmd, type GameState, type RiderInput, type RunDef, type SimEvent, type SurfaceKind } from '../src/sim/types';
import { GuardBot } from './bots';
import { yRun } from './fixtures';

/** Seeds a sharp Rider must win on, per variant. */
const SEEDS = 3;

/** Plays a run on a seed; newGame picks the variant from it (seed % variants.length). */
function play(run: RunDef, seed: number, rider: (s: GameState) => RiderInput): GameState {
  const s = newGame(run, { seed, consist: composeConsist(run, []), upgrades: [], assists: { rider: false, engineer: false } });
  const ap = newAutopilot(run, s.variant);
  let seq = 0;
  for (let k = 0; k < 40 * 60 * TICK_HZ && s.phase === 'running'; k++) {
    const out = autopilotStep(ap, s, run);
    const cmds: EngineerCmd[] = out.cmds.map((c) => ({ ...c, seq: ++seq }));
    if (out.lowerSpout) tryLowerSpout(s, run, [], { force: true });
    step(s, run, rider(s), cmds, []);
  }
  return s;
}

describe('balance', () => {
  for (const run of RUNS) {
    it(`${run.index + 1}. ${run.name}: a sharp Rider and a steady Engineer win every variant`, () => {
      for (let seed = 0; seed < SEEDS * run.variants.length; seed++) {
        const bot = new GuardBot(run);
        const s = play(run, seed, (st) => bot.input(st));
        expect(s.variant).toBe(run.variants[seed % run.variants.length]);
        expect(s.phase, `${s.variant}, seed ${seed}: ${s.loss?.reason ?? ''} ${s.loss?.detail ?? ''}`).toBe('won');
      }
    });
  }

  const guarded = RUNS.filter((r) => r.contract.critical);
  for (const run of guarded) {
    it(`${run.index + 1}. ${run.name}: an idle Rider loses the ${run.contract.cargo}`, () => {
      run.variants.forEach((variant, vi) => {
        const s = play(run, vi, () => NO_INPUT);
        expect(s.phase, variant).toBe('lost');
        expect(['lootStolen', 'powder'], variant).toContain(s.loss?.reason);
      });
    });
  }
});

// The bot on its own, on the test line (the train starts with its front at e1:200 heading east),
// with the Engineer holding 15 m/s. Express + boxcar: L = 53, the express roof [13.8, 27.2] at 4.2
// (home), the express floor at 1.2. Bare: L = 25, tender top [0, 8] at 2.8, cab [9, 13.5].
describe('the balance bot heeds the calls', () => {
  interface Seen {
    /** The Rider's lowest and highest feet while the hazard was over them. */
    low: number;
    high: number;
    events: SimEvent[];
  }

  function drive(run: RunDef, consist: CarType[], seconds: number, from: { edge: string; off0: number; off1: number }, setup?: (s: GameState) => void): { s: GameState; seen: Seen } {
    const s = newGame(run, { seed: 1, consist, upgrades: [], assists: { rider: false, engineer: false } });
    setup?.(s);
    const bot = new GuardBot(run);
    const seen: Seen = { low: Infinity, high: -Infinity, events: [] };
    for (let k = 0; k < seconds * TICK_HZ && s.phase === 'running'; k++) {
      s.train.v = 15;
      seen.events.push(...step(s, run, bot.input(s), []));
      // Is the hazard over the Rider now? The front is `L` ahead of the rear, which is at x = 0.
      const front = s.train.spans[s.train.spans.length - 1];
      const at = front.to - s.train.length + s.rider.x;
      if (front.edge === from.edge && at >= from.off0 && at <= from.off1 && s.rider.mode === 'active') {
        seen.low = Math.min(seen.low, s.rider.y);
        seen.high = Math.max(seen.high, s.rider.y);
      }
    }
    return { s, seen };
  }

  const where = (s: GameState): [SurfaceKind | null, boolean] => [s.rider.surface, s.rider.mode === 'active'];

  it('gets down off the roof for a tunnel, stays down while it passes, and climbs back up after', () => {
    const run = yRun({ tunnels: [{ id: 't1', edge: 'e1', from: 400, to: 520, name: 'Test Tunnel' }] });
    const { s, seen } = drive(run, ['express', 'boxcar'], 40, { edge: 'e1', off0: 400, off1: 520 });
    expect(s.stats.timesOff).toBe(0);
    expect(seen.high).toBeLessThanOrEqual(TUNNEL_FEET_Y);
    expect(seen.low).toBeLessThan(TUNNEL_FEET_Y);
    expect(where(s)).toEqual(['roof', true]);
  });

  it('climbs up out of the cab for a ford and stays up while it passes', () => {
    const run = yRun({ fords: [{ id: 'f1', edge: 'e1', from: 400, to: 480, name: 'Test Ford' }] });
    const { s, seen } = drive(run, [], 30, { edge: 'e1', off0: 400, off1: 480 }, (st) => {
      Object.assign(st.rider, { x: 11, y: 1.4, surface: 'cabFloor', onGround: true, inside: 0 });
    });
    expect(s.stats.timesOff).toBe(0);
    expect(seen.low).toBeGreaterThanOrEqual(FORD_WATER_Y);
    expect(s.rider.y).toBeGreaterThanOrEqual(FORD_WATER_Y);
  });

  it('crouches under a low bridge on the roof', () => {
    const run = yRun({ lowBridges: [{ id: 'b1', edge: 'e1', at: 330 }] });
    const { s, seen } = drive(run, ['express', 'boxcar'], 15, { edge: 'e1', off0: 329, off1: 331 });
    expect(seen.events.some((e) => e.type === 'riderHurt')).toBe(false);
    expect(s.rider.hearts).toBe(s.rider.maxHearts);
    expect(where(s)).toEqual(['roof', true]);
  });
});

describe('the balance bot finds its way', () => {
  it('climbs the tender’s ladder, not the one beside it, to clear a gun out of the cab', () => {
    // Loco, tender and an express car, standing, and the Rider inside the car. Out on its front
    // platform the way to the cab is up the tender's ladder, a step from the car's own, and W takes
    // the nearer.
    const run = yRun();
    const s = newGame(run, { seed: 1, consist: ['express'], upgrades: [], assists: { rider: false, engineer: false } });
    const geo = trainGeometry(s.train.cars);
    const car = s.train.cars.findIndex((c) => c.kind === 'express');
    Object.assign(s.rider, { x: s.train.cars[car].x1 - 3, y: 1.2, surface: 'floor', onGround: true, inside: car });
    const outlaw: BanditState = {
      id: 90,
      x: (geo.cab.x0 + geo.cab.x1) / 2,
      y: geo.cab.floorY,
      vx: 0,
      vy: 0,
      onGround: true,
      surface: 'cabFloor',
      ladder: null,
      crouch: false,
      facing: -1,
      hp: 1,
      tier: 1,
      boss: false,
      goal: 'cab',
      mode: 'moving',
      modeTicks: 0,
      hasLoot: false,
      aimTicks: 0,
      cooldownTicks: 60 * TICK_HZ,
      stunTicks: 0,
      burnTicks: 0,
      navTarget: null,
    };
    s.bandits = [outlaw];
    const bot = new GuardBot(run);
    let heldFor = 0;
    for (let k = 0; k < 30 * TICK_HZ && s.phase === 'running'; k++) {
      step(s, run, bot.input(s), []);
      if (s.train.heldUp) heldFor++;
      else if (heldFor > 0) break;
    }
    expect(heldFor).toBeGreaterThan(0);
    expect(s.train.heldUp).toBe(false);
    expect(heldFor / TICK_HZ).toBeLessThan(15);
  });
});
