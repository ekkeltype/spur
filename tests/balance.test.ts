// Balance guards (spec §1, §13): with the autopilot as a steady Engineer, a sharp Rider wins every
// run and variant, and the bandits are a real threat: a Rider who does nothing loses every run
// whose cargo they're after. Tuning that breaks either shows up here.

import { describe, expect, it } from 'vitest';
import { RUNS } from '../src/content/runs';
import { autopilotStep, newAutopilot } from '../src/sim/autopilot';
import { composeConsist, newGame, step } from '../src/sim/game';
import { TICK_HZ } from '../src/sim/rules';
import { tryLowerSpout } from '../src/sim/train';
import { NO_INPUT, type EngineerCmd, type GameState, type RiderInput, type RunDef } from '../src/sim/types';
import { GuardBot } from './bots';

function play(run: RunDef, variantIndex: number, rider: (s: GameState) => RiderInput): GameState {
  const s = newGame(run, { seed: variantIndex, consist: composeConsist(run, []), upgrades: [], assists: { rider: false, engineer: false } });
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
      run.variants.forEach((variant, vi) => {
        const bot = new GuardBot();
        const s = play(run, vi, (st) => bot.input(st));
        expect(s.phase, `${variant}: ${s.loss?.reason ?? ''} ${s.loss?.detail ?? ''}`).toBe('won');
      });
    });
  }

  const guarded = RUNS.filter((r) => r.contract.critical);
  for (const run of guarded) {
    it(`${run.index + 1}. ${run.name}: an idle Rider loses the ${run.contract.cargo}`, () => {
      const s = play(run, 0, () => NO_INPUT);
      expect(s.phase).toBe('lost');
      expect(['lootStolen', 'powder']).toContain(s.loss?.reason);
    });
  }
});
