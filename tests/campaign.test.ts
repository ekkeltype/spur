// Every run and variant can be completed (spec §13): the autopilot drives each one with the bandits
// removed and must stop at the destination before the deadline, without a loss. This is the
// campaign's feasibility check — timetables, meets, water, limits and signals all have to add up.

import { describe, expect, it } from 'vitest';
import { RUNS } from '../src/content/runs';
import { autopilotStep, newAutopilot } from '../src/sim/autopilot';
import { composeConsist, newGame, step } from '../src/sim/game';
import { TICK_HZ } from '../src/sim/rules';
import { tryLowerSpout } from '../src/sim/train';
import { NO_INPUT, type EngineerCmd, type GameState, type RunDef } from '../src/sim/types';

const LIMIT_TICKS = 40 * 60 * TICK_HZ; // no run is anywhere near 40 minutes

interface Drive {
  state: GameState;
  seconds: number;
  arrivedLateBy: number;
}

/** Plays a run with the autopilot as the Engineer and nobody bothering the train. */
export function drive(run: RunDef, variantIndex: number): Drive {
  // newGame picks the variant from the seed (seed % variants.length).
  const seed = variantIndex;
  const peaceful: RunDef = { ...run, waves: [] };
  const state = newGame(peaceful, { seed, consist: composeConsist(peaceful, []), upgrades: [], assists: { rider: false, engineer: false } });
  expect(state.variant).toBe(run.variants[variantIndex]);
  const ap = newAutopilot(peaceful, state.variant);
  let seq = 0;
  for (let k = 0; k < LIMIT_TICKS && state.phase === 'running'; k++) {
    const out = autopilotStep(ap, state, peaceful);
    const cmds: EngineerCmd[] = out.cmds.map((c) => ({ ...c, seq: ++seq }));
    if (out.lowerSpout) tryLowerSpout(state, peaceful, [], { force: true });
    step(state, peaceful, NO_INPUT, cmds, []);
  }
  const arrived = state.arrivedClock ?? Infinity;
  return { state, seconds: state.tick / TICK_HZ, arrivedLateBy: arrived - run.contract.deadline };
}

describe('the campaign can be completed', () => {
  for (const run of RUNS) {
    run.variants.forEach((variant, vi) => {
      it(`${run.index + 1}. ${run.name} (${variant})`, () => {
        const d = drive(run, vi);
        const why = d.state.loss ? `${d.state.loss.reason}: ${d.state.loss.detail}` : `phase ${d.state.phase} after ${d.seconds.toFixed(0)} s`;
        expect(d.state.phase, why).toBe('won');
        expect(d.arrivedLateBy, `arrived ${d.arrivedLateBy.toFixed(0)} s after the deadline`).toBeLessThanOrEqual(0);
        // Some margin: a competent pair should have slack over the autopilot's clean drive.
        const slack = -d.arrivedLateBy / (run.contract.deadline - run.startClock);
        expect(slack, `only ${(slack * 100).toFixed(0)}% of the time allowance to spare`).toBeGreaterThanOrEqual(0.08);
      });
    });
  }
});
