// The game loop's wiring (spec §15): waves spawn as the loco passes their trigger, the Rider's E
// lowers the spout, debug commands, results and payouts, and checkpoints that resume identically.

import { describe, expect, it } from 'vitest';
import { cargoPayFor, composeConsist, hazardsNear, newGame, runResult, step, variantFor } from '../src/sim/game';
import { pointAt } from '../src/sim/network';
import { seedRng } from '../src/sim/rng';
import { CARGO_PAY, TENDER_HATCH_FROM_REAR, TICK_HZ } from '../src/sim/rules';
import { NO_INPUT, type EngineerCmd, type GameState, type RiderInput, type RunDef, type SimEvent } from '../src/sim/types';
import { BotRider } from './bots';
import { loopRun } from './fixtures';

const ASSISTS = { rider: false, engineer: false };

function waveRun(): RunDef {
  return loopRun({
    waves: [{ id: 'w1', trigger: { edge: 'm1', off: 450 }, count: 3, from: 'rear', goal: 'hunt', tier: 1 }],
    waterTowers: [{ id: 'tank', edge: 'm1', at: 700 }],
    initialWater: 40,
  });
}

function run(state: GameState, r: RunDef, ticks: number, input: RiderInput = NO_INPUT, cmdsFirst: EngineerCmd[] = []): SimEvent[] {
  const all: SimEvent[] = [];
  for (let k = 0; k < ticks && state.phase === 'running'; k++) all.push(...step(state, r, input, k === 0 ? cmdsFirst : []));
  return all;
}

/** Steps until an event of the given type appears (or the tick budget runs out); returns the events. */
function until(state: GameState, r: RunDef, type: SimEvent['type'], ticks: number, cmdsFirst: EngineerCmd[] = []): SimEvent[] {
  const all: SimEvent[] = [];
  for (let k = 0; k < ticks && state.phase === 'running'; k++) {
    const ev = step(state, r, NO_INPUT, k === 0 ? cmdsFirst : []);
    all.push(...ev);
    if (ev.some((e) => e.type === type)) break;
  }
  return all;
}

describe('game loop', () => {
  it('spawns a wave when the loco passes its trigger, and not before', () => {
    const r = waveRun();
    const s = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: ASSISTS });
    run(s, r, 30);
    expect(s.horsemen).toEqual([]);
    const ev = until(s, r, 'waveSpawned', 60 * TICK_HZ, [{ seq: 1, kind: 'throttle', value: 0.6 }]);
    expect(ev.some((e) => e.type === 'waveSpawned' && e.id === 'w1')).toBe(true);
    expect(s.waves[0].triggered).toBe(true);
    expect(s.horsemen.length + s.waves[0].queued).toBe(3);
  });

  it('the bandits act through step(): spawned horsemen ride', () => {
    const r = waveRun();
    const s = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: ASSISTS });
    until(s, r, 'waveSpawned', 60 * TICK_HZ, [{ seq: 1, kind: 'throttle', value: 0.6 }]);
    const before = s.horsemen.map((h) => h.x);
    run(s, r, TICK_HZ);
    const after = s.horsemen.map((h) => h.x);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before.slice(0, after.length));
  });

  it("lowers the spout when the Rider presses E on the tender by the hatch, at a tower", () => {
    const r = waveRun();
    const s = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: ASSISTS });
    // Park the train with the tender's hatch under the spout at m1 700.
    const tender = s.train.cars[1];
    const hatchX = tender.x0 + TENDER_HATCH_FROM_REAR;
    const shift = 700 - pointAt(s.train.spans, hatchX).off;
    s.train.spans = s.train.spans.map((sp) => ({ ...sp, from: sp.from + shift, to: sp.to + shift }));
    s.train.stationStop = null;
    // The Rider on the coal top beside the hatch.
    Object.assign(s.rider, { x: hatchX, y: 2.8, vx: 0, vy: 0, onGround: true, surface: 'tenderTop', inside: null, ladder: null, car: 1 });
    const ev = run(s, r, 1, { ...NO_INPUT, interactPressed: true });
    expect(ev).toContainEqual({ type: 'spout', down: true });
    expect(run(s, r, 10 * TICK_HZ).some((e) => e.type === 'waterFull')).toBe(true);
    expect(s.train.water).toBeGreaterThan(s.train.waterCap - 3);
  });

  it('the debug command kills every bandit through the fight module', () => {
    const r = waveRun();
    const s = newGame(r, { seed: 3, consist: ['express'], upgrades: [], assists: ASSISTS });
    until(s, r, 'waveSpawned', 60 * TICK_HZ, [{ seq: 1, kind: 'throttle', value: 0.6 }]);
    const alive = (): number => s.horsemen.filter((h) => h.mode !== 'gone' && h.mode !== 'falling').length;
    expect(alive()).toBeGreaterThan(0);
    const ev = step(s, r, NO_INPUT, [], [{ kind: 'killBandits' }]);
    expect(ev.some((e) => e.type === 'horsemanDown')).toBe(true);
    expect(alive()).toBe(0);
  });

  it('pays the contract, minus lateness and fines, plus side jobs; medals only on a win', () => {
    const r = waveRun();
    const s = newGame(r, { seed: 1, consist: composeConsist(r, []), upgrades: [], assists: ASSISTS });
    s.phase = 'won';
    s.arrivedClock = r.contract.deadline + 90; // 1.5 minutes late: two minutes' penalty
    s.stats.fines = 10;
    const res = runResult(s, r);
    expect(res.outcome).toBe('won');
    expect(res.pay).toBe(r.contract.pay);
    expect(res.latePenalty).toBe(2 * r.contract.latePenaltyPerMin);
    expect(res.total).toBe(r.contract.pay - 2 * r.contract.latePenaltyPerMin - 10);
    expect(res.medals).toEqual(['untouched']);
    s.phase = 'lost';
    const lost = runResult(s, r);
    expect(lost.total).toBe(0);
    expect(lost.medals).toEqual([]);
  });

  it('a slammed brake lurches on the tick its command arrives, so the Rider and the bandits see it that step', () => {
    const r = waveRun();
    const s = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: ASSISTS });
    s.train.stationStop = null;
    s.train.v = 12;
    s.tick = 500;
    const ev = step(s, r, NO_INPUT, [{ seq: 1, kind: 'brake', value: 1 }]);
    expect(ev).toContainEqual({ type: 'lurch' });
    expect(s.train.lurchTick).toBe(500);
    expect(s.tick).toBe(501);
  });

  it('pays for the optional cargo cars, but not the contract’s own, the armored car or the caboose', () => {
    const r: RunDef = { ...waveRun(), requiredCars: ['express'] };
    expect(cargoPayFor(r, ['loco', 'tender', 'express'])).toBe(0);
    expect(cargoPayFor(r, ['loco', 'tender', 'express', 'passenger', 'boxcar'])).toBe((CARGO_PAY.passenger ?? 0) + (CARGO_PAY.boxcar ?? 0));
    expect(cargoPayFor(r, ['loco', 'tender', 'express', 'armored', 'caboose'])).toBe(0);
    expect(cargoPayFor(waveRun(), ['loco', 'tender', 'express'])).toBe(CARGO_PAY.express);
    expect(CARGO_PAY).toEqual({ express: 40, passenger: 30, boxcar: 30 });
  });

  it('adds the cargo pay to a win’s total, and nothing on a loss', () => {
    const r: RunDef = { ...waveRun(), requiredCars: ['express'] };
    const s = newGame(r, { seed: 1, consist: composeConsist(r, ['passenger', 'caboose']), upgrades: [], assists: ASSISTS });
    s.phase = 'won';
    s.arrivedClock = r.contract.deadline - 60;
    const res = runResult(s, r);
    expect(res.cargoPay).toBe(CARGO_PAY.passenger);
    expect(res.total).toBe(r.contract.pay + res.cargoPay);
    s.phase = 'lost';
    expect(runResult(s, r)).toMatchObject({ cargoPay: 0, total: 0 });
  });

  it('lists the fords near the train among its hazards, in the train frame', () => {
    const r = loopRun({
      fords: [{ id: 'f1', edge: 'm1', from: 320, to: 380, name: 'Sage Creek ford' }],
      tunnels: [{ id: 't1', edge: 'm1', from: 400, to: 450, name: 'Mesa Tunnel' }],
    });
    const s = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: ASSISTS });
    const L = s.train.length; // the loco's front at m1 300
    const near = hazardsNear(s, r, 200);
    expect(near).toHaveLength(2);
    expect(near).toContainEqual({ kind: 'ford', id: 'f1', x0: L + 20, x1: L + 80 });
    expect(near).toContainEqual({ kind: 'tunnel', id: 't1', x0: L + 100, x1: L + 150 });
    expect(hazardsNear(s, r, 10)).toEqual([]);
  });

  it('picks the variant from the seed', () => {
    const r = { ...waveRun(), variants: ['A', 'B', 'C'] };
    expect([0, 1, 2, 3].map((seed) => variantFor(r, seed))).toEqual(['A', 'B', 'C', 'A']);
  });

  it('a checkpoint (the state through JSON) resumes exactly as the original goes on', () => {
    const r = waveRun();
    const a = newGame(r, { seed: 9, consist: ['express', 'boxcar'], upgrades: ['shotgun'], assists: ASSISTS });
    const botA = new BotRider(seedRng(5));
    let seq = 0;
    const drive = (s: GameState, bot: BotRider, ticks: number): void => {
      for (let k = 0; k < ticks && s.phase === 'running'; k++) {
        const cmds: EngineerCmd[] = k % 120 === 0 ? [{ seq: ++seq, kind: 'throttle', value: 0.5 }] : [];
        step(s, r, bot.input(s), cmds);
      }
    };
    drive(a, botA, 40 * TICK_HZ);
    const b: GameState = JSON.parse(JSON.stringify(a));
    const botB = new BotRider([...(botA as unknown as { rng: number[] }).rng]);
    const seqAt = seq;
    drive(a, botA, 40 * TICK_HZ);
    seq = seqAt;
    drive(b, botB, 40 * TICK_HZ);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
