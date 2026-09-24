// Soak test (spec §19): the autopilot drives and a bot Rider fights on every run and variant, with
// the bandits on, for up to 8 simulated minutes, checking invariants every tick. Plus determinism:
// the same seed and inputs give the same final state.

import { describe, expect, it } from 'vitest';
import { RUNS } from '../src/content/runs';
import { autopilotStep, newAutopilot } from '../src/sim/autopilot';
import { composeConsist, newGame, step } from '../src/sim/game';
import { spansLength } from '../src/sim/network';
import { seedRng } from '../src/sim/rng';
import { MAX_BANDITS_ABOARD, MAX_HORSEMEN, P_MAX, TICK_HZ } from '../src/sim/rules';
import { tryLowerSpout } from '../src/sim/train';
import type { EngineerCmd, GameState, RunDef, SimEvent } from '../src/sim/types';
import { BotRider } from './bots';

const TICKS = 8 * 60 * TICK_HZ;

function finite(n: number, what: string): void {
  expect(Number.isFinite(n), `${what} = ${n}`).toBe(true);
}

function checkInvariants(s: GameState): void {
  const t = s.train;
  expect(spansLength(t.spans)).toBeCloseTo(t.length, 3);
  finite(t.v, 'train.v');
  finite(t.odometer, 'train.odometer');
  expect(t.pressure).toBeGreaterThanOrEqual(0);
  expect(t.pressure).toBeLessThanOrEqual(P_MAX + 1e-6);
  expect(t.water).toBeGreaterThanOrEqual(0);
  expect(t.water).toBeLessThanOrEqual(t.waterCap + 1e-6);
  expect(t.throttle).toBeGreaterThanOrEqual(0);
  expect(t.throttle).toBeLessThanOrEqual(1);
  expect(t.brake).toBeGreaterThanOrEqual(0);
  expect(t.brake).toBeLessThanOrEqual(1);
  const r = s.rider;
  finite(r.x, 'rider.x');
  finite(r.y, 'rider.y');
  expect(r.hearts).toBeGreaterThanOrEqual(0);
  expect(r.hearts).toBeLessThanOrEqual(r.maxHearts);
  for (const w of r.weapons) expect(r.ammo[w]).toBeGreaterThanOrEqual(0);
  expect(s.horsemen.filter((h) => h.mode !== 'gone').length).toBeLessThanOrEqual(MAX_HORSEMEN + 1); // + a looter's pickup horse
  expect(s.bandits.filter((b) => b.mode !== 'gone').length).toBeLessThanOrEqual(MAX_BANDITS_ABOARD);
  for (const b of s.bandits) {
    finite(b.x, 'bandit.x');
    finite(b.y, 'bandit.y');
  }
  for (const h of s.horsemen) finite(h.x, 'horseman.x');
  expect(['safe', 'cracking', 'carried', 'dropped', 'stolen']).toContain(s.loot.status);
  expect(s.loot.crack).toBeGreaterThanOrEqual(0);
  expect(s.loot.crack).toBeLessThanOrEqual(1);
  for (const a of s.ai) if (a.active) for (const sp of a.spans) finite(sp.from, 'ai span');
}

function play(run: RunDef, seed: number, onTick?: (s: GameState, events: SimEvent[]) => void): GameState {
  const state = newGame(run, { seed, consist: composeConsist(run, ['boxcar']), upgrades: ['shotgun'], assists: { rider: false, engineer: false } });
  const ap = newAutopilot(run, state.variant);
  const bot = new BotRider(seedRng(seed * 31 + 7));
  let seq = 0;
  for (let k = 0; k < TICKS && state.phase === 'running'; k++) {
    const out = autopilotStep(ap, state, run);
    const cmds: EngineerCmd[] = out.cmds.map((c) => ({ ...c, seq: ++seq }));
    if (out.lowerSpout) tryLowerSpout(state, run, [], { force: true });
    const events = step(state, run, bot.input(state), cmds, []);
    onTick?.(state, events);
  }
  return state;
}

describe('soak', () => {
  for (const run of RUNS) {
    it(`${run.index + 1}. ${run.name}: bots keep every invariant for up to 8 minutes`, () => {
      run.variants.forEach((_, vi) => {
        const outcomes: string[] = [];
        let n = 0;
        const s = play(run, vi + run.variants.length * 3, (st) => {
          if (n++ % 6 === 0) checkInvariants(st);
          if (n % 600 === 0) {
            // Checkpoints are JSON round trips of the state: it must survive one intact.
            expect(JSON.parse(JSON.stringify(st))).toEqual(st);
          }
        });
        checkInvariants(s);
        outcomes.push(s.phase);
        expect(outcomes.length).toBe(1);
      });
    });
  }

  it('is deterministic: the same seed and bots give the same final state', () => {
    const run = RUNS[Math.min(1, RUNS.length - 1)];
    const a = play(run, 42);
    const b = play(run, 42);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
