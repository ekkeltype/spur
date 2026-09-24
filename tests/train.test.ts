import { describe, expect, it } from 'vitest';
import { newGame } from '../src/sim/game';
import { frontHead, netIndex, spansFromFront, spansLength } from '../src/sim/network';
import { BIG_TENDER_CAP, CAR_SPECS, DWELL_SECONDS, P_START, TICK_HZ, WATER_CAP } from '../src/sim/rules';
import { applyEngineerCmd, initialTrain, layoutConsist, limitHere, spoutPrompt, stepTrain, tryLowerSpout } from '../src/sim/train';
import type { Assists, CarType, EngineerCmd, EngineerCmdBody, GameState, ObstacleKind, RunDef, SimEvent, TickMotion, UpgradeId } from '../src/sim/types';
import { baseRun, yRun } from './fixtures';

const NO_ASSISTS: Assists = { rider: false, engineer: false };
const LIGHT: CarType[] = ['express']; // 115 t
const HEAVY: CarType[] = ['express', 'passenger', 'boxcar', 'armored']; // 209 t

/** A fresh game on `run` whose train comes from initialTrain. */
function game(run: RunDef, consist: CarType[] = LIGHT, upgrades: UpgradeId[] = [], assists: Assists = NO_ASSISTS): GameState {
  const s = newGame(run, { seed: 1, consist, upgrades, assists });
  s.train = initialTrain(run, consist, upgrades, assists);
  return s;
}

/** 40 km of straight, level main line (limit 45 m/s): room to reach top speed. */
function straight(extra: Partial<RunDef> = {}): RunDef {
  return baseRun({
    nodes: [
      { id: 'A', kind: 'end', x: 0, y: 0 },
      { id: 'B', kind: 'end', x: 40, y: 0 },
    ],
    edges: [{ id: 'x', a: 'A', b: 'B', length: 40000, kind: 'main', speedLimit: 45, terrain: 'desert', mainAt: [0, 40000] }],
    mainLine: ['x'],
    stations: [
      { id: 'orig', name: 'Origin', edge: 'x', at: 1000, platform: 60, checkpoint: false },
      { id: 'dest', name: 'Destination', edge: 'x', at: 39000, platform: 60, checkpoint: false },
    ],
    start: { edge: 'x', off: 1000, dir: 1 },
    ...extra,
  });
}

let seq = 0;

/** One tick of the train: the commands, then stepTrain, then the tick counter (game.ts's job). */
function tick(s: GameState, run: RunDef, cmds: EngineerCmdBody[] = []): { events: SimEvent[]; motion: TickMotion } {
  const events: SimEvent[] = [];
  for (const c of cmds) applyEngineerCmd(s, run, { ...c, seq: ++seq } as EngineerCmd, events);
  const motion = stepTrain(s, run, events);
  s.tick++;
  return { events, motion };
}

/** Runs `seconds` of ticks, calling `each` before every tick; returns all events. */
function runFor(s: GameState, run: RunDef, seconds: number, each?: (s: GameState) => void): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * TICK_HZ); i++) {
    each?.(s);
    all.push(...tick(s, run).events);
  }
  return all;
}

/** Keeps the boiler out of a dynamics test: full water, full working pressure. */
const steady = (s: GameState): void => {
  s.train.water = s.train.waterCap;
  s.train.pressure = 180;
};

const ofType = <T extends SimEvent['type']>(events: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

describe('layoutConsist', () => {
  it('lays the cars out front to back: the loco at the front (x = L), the last car ending at x = 0', () => {
    const { cars, length, mass } = layoutConsist(['express', 'passenger']);
    expect(cars.map((c) => c.kind)).toEqual(['loco', 'tender', 'express', 'passenger']);
    expect(length).toBe(16 + 9 + 15 + 17);
    expect(mass).toBe(70 + 20 + 25 + 28);
    expect(cars[0]).toEqual({ kind: 'loco', x0: length - 16, x1: length, hp: 1 });
    expect(cars[1]).toEqual({ kind: 'tender', x0: length - 25, x1: length - 16, hp: 1 });
    expect(cars[3].x0).toBe(0);
    for (let i = 1; i < cars.length; i++) expect(cars[i].x1).toBe(cars[i - 1].x0);
  });

  it('gives the powder car its hit points', () => {
    const { cars } = layoutConsist(['powder']);
    expect(cars[2].hp).toBe(CAR_SPECS.powder.hp);
  });
});

describe('initialTrain', () => {
  it('stands stopped at the origin, its stop already complete, levers at rest', () => {
    const run = yRun({ initialWater: 70 });
    const t = initialTrain(run, ['express'], [], NO_ASSISTS);
    expect(frontHead(t.spans)).toEqual({ edge: 'e1', off: 200, dir: 1 });
    expect(spansLength(t.spans)).toBeCloseTo(t.length, 9);
    expect(t.v).toBe(0);
    expect(t.throttle).toBe(0);
    expect(t.brake).toBe(0);
    expect(t.reverser).toBe(1);
    expect(t.fire).toBe(2);
    expect(t.pressure).toBe(P_START);
    expect(t.water).toBe(70);
    expect(t.waterCap).toBe(WATER_CAP);
    expect(t.spout).toBe('up');
    expect(t.stationStop).toEqual({ stationId: 'orig', ticks: DWELL_SECONDS * TICK_HZ, done: true });
    expect(t.lastStation).toBe('orig');
    expect(t.pendingCheckpoint).toBeNull();
    expect(JSON.parse(JSON.stringify(t))).toEqual(t);
  });

  it('the big tender holds more, and the start level never exceeds the capacity', () => {
    const run = yRun({ initialWater: 130 });
    expect(initialTrain(run, [], [], NO_ASSISTS).water).toBe(WATER_CAP);
    const big = initialTrain(run, [], ['bigTender'], NO_ASSISTS);
    expect(big.waterCap).toBe(BIG_TENDER_CAP);
    expect(big.water).toBe(130);
  });

  it('fits into a GameState built by newGame', () => {
    const s = game(yRun());
    expect(s.train.cars.map((c) => c.kind)).toEqual(['loco', 'tender', 'express']);
  });
});

describe('motion (spec §5.3)', () => {
  it('a light train pulls away faster than a heavy one, at F/m less rolling resistance', () => {
    const run = straight();
    const light = game(run, LIGHT);
    const heavy = game(run, HEAVY);
    for (const s of [light, heavy]) s.train.throttle = 1;
    runFor(light, run, 1, steady);
    runFor(heavy, run, 1, steady);
    expect(light.train.v).toBeCloseTo(60 / 115 - 0.02, 2);
    expect(heavy.train.v).toBeCloseTo(60 / 209 - 0.02, 2);
    runFor(light, run, 19, steady);
    runFor(heavy, run, 19, steady);
    expect(light.train.v).toBeGreaterThan(1.5 * heavy.train.v);
  });

  it('a light train tops out near 27 m/s (60 mph) and a heavy one near 20 m/s (45 mph)', () => {
    const run = straight();
    const light = game(run, LIGHT);
    const heavy = game(run, HEAVY);
    for (const s of [light, heavy]) s.train.throttle = 1;
    runFor(light, run, 300, steady);
    runFor(heavy, run, 300, steady);
    expect(light.train.v).toBeGreaterThan(25.8);
    expect(light.train.v).toBeLessThan(27.8);
    expect(heavy.train.v).toBeGreaterThan(18.5);
    expect(heavy.train.v).toBeLessThan(20.5);
    expect(light.stats.maxSpeed).toBeCloseTo(light.train.v, 6);
  });

  it('has less power below FULL_POWER_PSI', () => {
    const run = straight();
    const s = game(run);
    s.train.throttle = 1;
    runFor(s, run, 1, (st) => {
      st.train.water = st.train.waterCap;
      st.train.pressure = 80;
      st.train.fire = 0;
    });
    expect(s.train.v).toBeCloseTo((60 / 115) * 0.5 - 0.02, 2);
  });

  it('climbs slower and descends faster, by the grade under the loco and the way the train faces', () => {
    const graded = (dir: 1 | -1): RunDef =>
      straight({
        grades: [{ edge: 'x', from: 0, to: 40000, grade: 0.01 }],
        start: { edge: 'x', off: 20000, dir },
        stations: [{ id: 'orig', name: 'Origin', edge: 'x', at: 20000, platform: 60, checkpoint: false }],
        contract: { ...straight().contract, destination: 'orig' },
      });
    const flat = straight();
    const up = graded(1); // facing a→b: uphill
    const down = graded(-1); // facing b→a: downhill
    const v = (run: RunDef): number => {
      const s = game(run);
      s.train.throttle = 1;
      runFor(s, run, 10, steady);
      return s.train.v;
    };
    const drag = 0.0007 * 25 * 0.33; // a rough allowance for air drag over the ten seconds
    expect(v(flat)).toBeCloseTo((60 / 115 - 0.02 - drag) * 10, 0);
    expect(v(up)).toBeCloseTo((60 / 115 - 0.02 - 0.0981 - drag) * 10, 0);
    expect(v(down)).toBeCloseTo((60 / 115 - 0.02 + 0.0981 - drag) * 10, 0);
  });

  it('stands on a gentle grade with the brakes off, but rolls back down a steep one unless braked', () => {
    const on = (grade: number): RunDef => straight({ grades: [{ edge: 'x', from: 0, to: 40000, grade }] });
    const gentle = game(on(0.001));
    runFor(gentle, on(0.001), 5, steady);
    expect(gentle.train.v).toBe(0);
    expect(gentle.train.odometer).toBe(0);

    const steep = on(0.01);
    const braked = game(steep);
    braked.train.brake = 0.5;
    runFor(braked, steep, 5, steady);
    expect(braked.train.v).toBe(0);

    const loose = game(steep);
    runFor(loose, steep, 5, steady);
    expect(loose.train.v).toBeLessThan(0); // facing uphill: it rolls backward
    expect(loose.train.odometer).toBeLessThan(0);
  });

  it('stops from 20 m/s in well under 200 m on full brake, and shorter still with air brakes', () => {
    const run = straight();
    const stoppingDistance = (upgrades: UpgradeId[]): number => {
      const s = game(run, LIGHT, upgrades);
      s.train.v = 20;
      s.train.brake = 1;
      runFor(s, run, 30, steady);
      expect(s.train.v).toBe(0);
      return s.train.odometer;
    };
    const plain = stoppingDistance([]);
    expect(plain).toBeGreaterThan(145);
    expect(plain).toBeLessThan(175);
    expect(stoppingDistance(['airBrakes'])).toBeLessThan(plain / 1.25);
  });

  it("can't reverse through zero by braking", () => {
    const run = straight();
    const s = game(run);
    s.train.v = 5;
    s.train.brake = 1;
    let lowest = Infinity;
    runFor(s, run, 10, (st) => {
      steady(st);
      lowest = Math.min(lowest, st.train.v);
    });
    expect(lowest).toBeGreaterThanOrEqual(0);
    expect(s.train.v).toBe(0);
    const at = s.train.odometer;
    runFor(s, run, 3, steady);
    expect(s.train.odometer).toBe(at);
  });

  it('drives backward in reverse, and not at all in neutral', () => {
    const run = straight();
    const back = game(run);
    back.train.reverser = -1;
    back.train.throttle = 1;
    runFor(back, run, 2, steady);
    expect(back.train.v).toBeLessThan(0);
    expect(back.train.odometer).toBeLessThan(0);

    const neutral = game(run);
    neutral.train.reverser = 0;
    neutral.train.throttle = 1;
    runFor(neutral, run, 2, steady);
    expect(neutral.train.v).toBe(0);
  });

  it("reports the loco front's path while moving forward, and nothing while backing", () => {
    const run = yRun();
    const s = game(run);
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e1', off: 999.9, dir: 1 }, s.train.length);
    s.train.v = 12;
    steady(s);
    const { motion } = tick(s, run);
    expect(motion.moved).toBeCloseTo(s.train.v / TICK_HZ, 9);
    expect(motion.frontPath[0]).toEqual({ edge: 'e1', from: 999.9, to: 1000 });
    expect(motion.frontPath[1].edge).toBe('e2');
    expect(spansLength(motion.frontPath)).toBeCloseTo(motion.moved, 9);
    expect(s.train.odometer).toBeCloseTo(motion.moved, 9);

    s.train.v = -3;
    s.train.reverser = -1;
    const back = tick(s, run).motion;
    expect(back.moved).toBeLessThan(0);
    expect(back.frontPath).toEqual([]);
  });
});

describe('boiler and water (spec §5.5)', () => {
  const run = straight();

  it('the firebox raises steam, heat loss drains it', () => {
    const s = game(run);
    s.train.pressure = 100;
    s.train.fire = 2;
    runFor(s, run, 1);
    expect(s.train.pressure).toBeCloseTo(100 + 2 * 7 - 0.5, 6);
    s.train.fire = 0;
    runFor(s, run, 1);
    expect(s.train.pressure).toBeCloseTo(113.5 - 0.5, 6);
  });

  it('the cylinders use steam by throttle and speed, but not in neutral', () => {
    const standing = game(run);
    standing.train.pressure = 100;
    standing.train.fire = 0;
    standing.train.throttle = 1;
    standing.train.brake = 1; // held on the brake: no speed, just the base draw
    runFor(standing, run, 1);
    expect(standing.train.v).toBe(0);
    expect(standing.train.pressure).toBeCloseTo(100 - 3 - 0.5, 6);

    const neutral = game(run);
    neutral.train.pressure = 100;
    neutral.train.fire = 0;
    neutral.train.throttle = 1;
    neutral.train.reverser = 0;
    runFor(neutral, run, 1);
    expect(neutral.train.pressure).toBeCloseTo(99.5, 6);

    const rolling = game(run);
    rolling.train.pressure = 100;
    rolling.train.fire = 0;
    rolling.train.throttle = 0.5;
    rolling.train.v = 10;
    tick(rolling, run);
    const v = rolling.train.v; // the speed this tick's draw was worked out from
    expect(rolling.train.pressure).toBeCloseTo(100 - (0.5 * (3 + 0.5 * v) + 0.5) / TICK_HZ, 3);
  });

  it('boiling uses water in proportion to the steam raised', () => {
    const s = game(run);
    s.train.pressure = 100;
    s.train.fire = 3;
    s.train.water = 50;
    runFor(s, run, 1);
    expect(s.train.water).toBeCloseTo(50 - 0.02 * 21, 6);
  });

  it('the safety valve lifts at P_MAX with a surplus, wasting it, and closes when the surplus stops', () => {
    const s = game(run);
    s.train.pressure = 199;
    s.train.fire = 3;
    const events = runFor(s, run, 1);
    expect(s.train.pressure).toBe(200);
    expect(s.train.safetyValve).toBe(true);
    expect(ofType(events, 'safetyValve')).toEqual([{ type: 'safetyValve', on: true }]);
    expect(s.train.water).toBeCloseTo(100 - 0.02 * 21, 6); // the vented steam still cost water
    s.train.fire = 0;
    const later = runFor(s, run, 1);
    expect(s.train.safetyValve).toBe(false);
    expect(ofType(later, 'safetyValve')).toEqual([{ type: 'safetyValve', on: false }]);
    expect(s.train.pressure).toBeLessThan(200);
  });

  it('warns once when the water falls below LOW_WATER, and again after a refill', () => {
    const s = game(run);
    s.train.fire = 3;
    s.train.water = 20.2; // 0.42 a second at full fire
    let events = runFor(s, run, 3);
    expect(ofType(events, 'lowWater')).toHaveLength(1);
    s.train.water = 20.2;
    events = runFor(s, run, 3);
    expect(ofType(events, 'lowWater')).toHaveLength(1);
  });

  it('raises no steam without water, and explodes after DRY_EXPLODE_SECONDS dry with the fire lit', () => {
    const s = game(run);
    s.train.water = 0;
    s.train.fire = 2;
    s.train.pressure = 150;
    runFor(s, run, 5.9);
    expect(s.train.pressure).toBeCloseTo(150 - 0.5 * 5.9, 6);
    expect(s.phase).toBe('running');
    const events = runFor(s, run, 0.2);
    expect(s.phase).toBe('lost');
    expect(s.loss?.reason).toBe('boiler');
    expect(ofType(events, 'explosion')).toEqual([expect.objectContaining({ what: 'boiler' })]);
    expect(ofType(events, 'lost')).toEqual([{ type: 'lost', reason: 'boiler', detail: s.loss?.detail }]);
    expect(s.loss?.detail.length).toBeGreaterThan(10);
  });

  it('never explodes dry with the fire out', () => {
    const s = game(run);
    s.train.water = 0;
    s.train.fire = 0;
    runFor(s, run, 20);
    expect(s.phase).toBe('running');
    expect(s.train.dryTicks).toBe(0);
  });

  it('the governor, or the Engineer assist, tends the fire to hold about 175 psi', () => {
    for (const [upgrades, assists] of [
      [['governor'], NO_ASSISTS],
      [[], { rider: false, engineer: true }],
    ] as [UpgradeId[], Assists][]) {
      const s = game(run, LIGHT, upgrades, assists);
      s.train.pressure = 120;
      s.train.fire = 0;
      runFor(s, run, 20);
      expect(s.train.pressure).toBeGreaterThan(165);
      // Standing, then running flat out: it stays near the target and never lifts the safety valve.
      let lo = Infinity;
      let hi = -Infinity;
      const events = runFor(s, run, 60, (st) => {
        lo = Math.min(lo, st.train.pressure);
        hi = Math.max(hi, st.train.pressure);
      });
      s.train.throttle = 1;
      const running = runFor(s, run, 120, (st) => {
        lo = Math.min(lo, st.train.pressure);
        hi = Math.max(hi, st.train.pressure);
      });
      expect(s.train.v).toBeGreaterThan(20);
      expect(lo).toBeGreaterThan(160);
      expect(hi).toBeLessThan(190);
      expect(ofType([...events, ...running], 'safetyValve')).toEqual([]);
    }
  });

  it("the governor drops the fire when the water's gone rather than wreck the boiler", () => {
    const s = game(run, LIGHT, ['governor']);
    s.train.water = 0;
    s.train.pressure = 100;
    runFor(s, run, 10);
    expect(s.train.fire).toBe(0);
    expect(s.phase).toBe('running');
  });
});

describe('Engineer commands (spec §5.2)', () => {
  const apply = (s: GameState, run: RunDef, c: EngineerCmdBody): SimEvent[] => {
    const events: SimEvent[] = [];
    applyEngineerCmd(s, run, { ...c, seq: 77 } as EngineerCmd, events);
    return events;
  };
  const result = (events: SimEvent[]): Extract<SimEvent, { type: 'cmdResult' }> => {
    const r = ofType(events, 'cmdResult');
    expect(r).toHaveLength(1);
    return r[0];
  };

  it('sets the levers, clamped to their ranges, answering each command once', () => {
    const run = yRun();
    const s = game(run);
    expect(result(apply(s, run, { kind: 'throttle', value: 1.7 }))).toEqual({ type: 'cmdResult', seq: 77, ok: true });
    expect(s.train.throttle).toBe(1);
    apply(s, run, { kind: 'throttle', value: 0.375 });
    expect(s.train.throttle).toBe(0.375);
    apply(s, run, { kind: 'brake', value: -0.2 });
    expect(s.train.brake).toBe(0);
    apply(s, run, { kind: 'brake', value: 0.9 });
    expect(s.train.brake).toBe(0.9);
    apply(s, run, { kind: 'fire', value: 2.6 });
    expect(s.train.fire).toBe(3);
    apply(s, run, { kind: 'fire', value: 9 });
    expect(s.train.fire).toBe(3);
    apply(s, run, { kind: 'fire', value: -1 });
    expect(s.train.fire).toBe(0);
  });

  it('refuses values that are not numbers', () => {
    const run = yRun();
    const s = game(run);
    const r = result(apply(s, run, { kind: 'throttle', value: Number.NaN }));
    expect(r.ok).toBe(false);
    expect(s.train.throttle).toBe(0);
  });

  it('refuses everything but the whistle while held up', () => {
    const run = yRun();
    const s = game(run);
    s.train.heldUp = true;
    for (const c of [
      { kind: 'throttle', value: 1 },
      { kind: 'brake', value: 0 },
      { kind: 'reverser', value: -1 },
      { kind: 'fire', value: 3 },
      { kind: 'switch', junction: 'J1', state: 'reverse' },
    ] as EngineerCmdBody[]) {
      expect(result(apply(s, run, c))).toEqual({ type: 'cmdResult', seq: 77, ok: false, reason: "Hands up! There's a gun on you." });
    }
    expect(s.train.throttle).toBe(0);
    expect(s.switches.J1).toBe('normal');
    const events = apply(s, run, { kind: 'whistle', on: true });
    expect(result(events).ok).toBe(true);
    expect(ofType(events, 'whistle')).toEqual([{ type: 'whistle', on: true }]);
  });

  it('moves the reverser only below REVERSER_MAX_SPEED', () => {
    const run = yRun();
    const s = game(run);
    s.train.v = 0.6;
    expect(result(apply(s, run, { kind: 'reverser', value: -1 }))).toEqual({
      type: 'cmdResult',
      seq: 77,
      ok: false,
      reason: 'Stop the train before moving the reverser.',
    });
    expect(s.train.reverser).toBe(1);
    expect(result(apply(s, run, { kind: 'reverser', value: 1 })).ok).toBe(true); // already there
    s.train.v = 0.4;
    expect(result(apply(s, run, { kind: 'reverser', value: 0 })).ok).toBe(true);
    expect(s.train.reverser).toBe(0);
  });

  it('throws switches, with an event, unless a train stands on them', () => {
    const run = yRun();
    const s = game(run);
    let events = apply(s, run, { kind: 'switch', junction: 'J1', state: 'reverse' });
    expect(result(events).ok).toBe(true);
    expect(s.switches.J1).toBe('reverse');
    expect(ofType(events, 'switchThrown')).toEqual([{ type: 'switchThrown', junction: 'J1', state: 'reverse', by: 'engineer' }]);
    events = apply(s, run, { kind: 'switch', junction: 'J1', state: 'reverse' });
    expect(result(events).ok).toBe(true);
    expect(ofType(events, 'switchThrown')).toEqual([]); // no change, no event

    expect(result(apply(s, run, { kind: 'switch', junction: 'nowhere', state: 'reverse' })).ok).toBe(false);

    // Our own train over the junction's edges within 20 m of the node.
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e1', off: 990, dir: 1 }, s.train.length);
    expect(result(apply(s, run, { kind: 'switch', junction: 'J1', state: 'normal' }))).toEqual({
      type: 'cmdResult',
      seq: 77,
      ok: false,
      reason: 'A train is standing on that switch.',
    });
    // Clear of it, but another train stands on the spur by the node.
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e1', off: 900, dir: 1 }, s.train.length);
    s.ai.push({ id: 'other', active: true, done: false, spans: [{ edge: 'e3', from: 60, to: 10 }], v: 0, started: false, wrecked: false });
    expect(result(apply(s, run, { kind: 'switch', junction: 'J1', state: 'normal' })).ok).toBe(false);
    s.ai[0].active = false;
    expect(result(apply(s, run, { kind: 'switch', junction: 'J1', state: 'normal' })).ok).toBe(true);
    expect(s.switches.J1).toBe('normal');
  });

  it('whistles: events on and off, and counts how long it has been held', () => {
    const run = straight();
    const s = game(run);
    const on = tick(s, run, [{ kind: 'whistle', on: true }]).events;
    expect(ofType(on, 'whistle')).toEqual([{ type: 'whistle', on: true }]);
    runFor(s, run, 0.5);
    expect(s.train.whistleTicks).toBe(1 + 30);
    const again = tick(s, run, [{ kind: 'whistle', on: true }]).events;
    expect(ofType(again, 'whistle')).toEqual([]);
    const off = tick(s, run, [{ kind: 'whistle', on: false }]).events;
    expect(ofType(off, 'whistle')).toEqual([{ type: 'whistle', on: false }]);
    expect(s.train.whistle).toBe(false);
    expect(s.train.whistleTicks).toBe(0);
  });

  it('leaves the fire to the governor', () => {
    const run = yRun();
    const s = game(run, LIGHT, ['governor']);
    const r = result(apply(s, run, { kind: 'fire', value: 3 }));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/governor/i);
  });
});

describe('the hold-up override (spec §5.2)', () => {
  it('eases the throttle to 0 and the brake to 0.5 over about a second', () => {
    const run = straight();
    const s = game(run);
    s.train.throttle = 1;
    s.train.heldUp = true;
    runFor(s, run, 0.5, steady);
    expect(s.train.throttle).toBeCloseTo(0.5, 6);
    expect(s.train.brake).toBeCloseTo(0.5, 6);
    runFor(s, run, 0.6, steady);
    expect(s.train.throttle).toBe(0);
    expect(s.train.brake).toBe(0.5);
    s.train.brake = 1;
    runFor(s, run, 1, steady);
    expect(s.train.brake).toBe(0.5);
  });

  it('lets the fire die down, so a long hold-up costs pressure, not the boiler', () => {
    const run = straight();
    const s = game(run);
    s.train.fire = 3;
    s.train.water = 3;
    s.train.heldUp = true;
    const events = runFor(s, run, 60, steady);
    expect(s.train.fire).toBe(0);
    expect(s.phase).toBe('running');
    expect(events.some((e) => e.type === 'lost')).toBe(false);
    expect(s.train.water).toBeGreaterThan(0);
    expect(s.train.pressure).toBeLessThan(180); // it cooled while the fire was out
  });
});

describe('switches and buffers under the train (spec §4.1)', () => {
  it('springs a switch set against a trailing move, with an event', () => {
    const run = yRun();
    const s = game(run);
    // On the spur, facing the junction, with the switch set for the main line.
    s.train.spans = spansFromFront(netIndex(run), { J1: 'reverse' }, { edge: 'e3', off: 2, dir: -1 }, s.train.length);
    s.train.v = 5;
    const events: SimEvent[] = [];
    for (let i = 0; i < 30; i++) events.push(...tick(s, run).events);
    expect(s.switches.J1).toBe('reverse');
    expect(ofType(events, 'switchThrown')).toEqual([{ type: 'switchThrown', junction: 'J1', state: 'reverse', by: 'trailing' }]);
    expect(frontHead(s.train.spans).edge).toBe('e1');
  });

  it('stops gently against the buffers below BUFFER_SAFE', () => {
    const run = yRun();
    const s = game(run);
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e4', off: 799.5, dir: 1 }, s.train.length);
    s.train.v = 1.4;
    runFor(s, run, 2, steady);
    expect(s.phase).toBe('running');
    expect(s.train.v).toBe(0);
    expect(frontHead(s.train.spans)).toEqual({ edge: 'e4', off: 800, dir: 1 });
  });

  it('is lost hitting the buffers faster than BUFFER_SAFE', () => {
    const run = yRun();
    const s = game(run);
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e4', off: 799.5, dir: 1 }, s.train.length);
    s.train.v = 4;
    const events = runFor(s, run, 1, steady);
    expect(s.phase).toBe('lost');
    expect(s.loss?.reason).toBe('buffers');
    expect(s.loss?.detail).toMatch(/9 mph/);
    expect(ofType(events, 'lost')).toHaveLength(1);
  });

  it('the rear hits the buffers too when backing', () => {
    const run = yRun();
    const s = game(run);
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'e1', off: s.train.length + 0.5, dir: 1 }, s.train.length);
    s.train.reverser = -1;
    s.train.v = -3;
    runFor(s, run, 1, steady);
    expect(s.loss?.reason).toBe('buffers');
  });
});

describe('speed limits and derailing (spec §5.4)', () => {
  // A 10 m/s curve from 2000 to 3000 on the 45 m/s straight.
  const run = straight({ curves: [{ id: 'c1', edge: 'x', from: 2000, to: 3000, limit: 10 }] });
  const inCurve = (): GameState => {
    const s = game(run);
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'x', off: 2100, dir: 1 }, s.train.length);
    return s;
  };
  const at = (v: number) => (s: GameState): void => {
    steady(s);
    s.train.v = v;
  };

  it('reads the limit at the loco: the track speed, lowered by a curve', () => {
    const s = game(run);
    expect(limitHere(s, run)).toBe(45);
    expect(limitHere(inCurve(), run)).toBe(10);
  });

  it('squeals above 1.15× the limit, once, and warns again above 1.4×', () => {
    const s = inCurve();
    let events = runFor(s, run, 1, at(12));
    expect(ofType(events, 'overspeed')).toEqual([{ type: 'overspeed', level: 1 }]);
    expect(s.train.overspeed).toBe(1);
    events = runFor(s, run, 0.5, at(15));
    expect(ofType(events, 'overspeed')).toEqual([{ type: 'overspeed', level: 2 }]);
    expect(s.train.overspeed).toBe(2);
    events = runFor(s, run, 0.5, at(9));
    expect(ofType(events, 'overspeed')).toEqual([]);
    expect(s.train.overspeed).toBe(0);
    expect(s.train.overspeedTicks).toBe(0);
    expect(s.phase).toBe('running');
  });

  it('derails after DERAIL_SECONDS above 1.4× the limit', () => {
    const s = inCurve();
    runFor(s, run, 1.4, at(15));
    expect(s.phase).toBe('running');
    const events = runFor(s, run, 0.2, at(15));
    expect(s.phase).toBe('lost');
    expect(s.loss?.reason).toBe('derailed');
    expect(s.loss?.detail).toMatch(/curve at 34 mph/);
    expect(ofType(events, 'lost')).toHaveLength(1);
  });

  it('derails at once above 1.7× the limit', () => {
    const s = inCurve();
    runFor(s, run, 1 / TICK_HZ, at(17.5));
    expect(s.loss?.reason).toBe('derailed');
  });

  it('names the stretch of track when it has a name and no curve', () => {
    const named = straight({ edges: [{ ...straight().edges[0], name: 'Sage Creek', speedLimit: 10 }] });
    const s = game(named);
    runFor(s, named, 1 / TICK_HZ, at(20));
    expect(s.loss?.detail).toMatch(/Sage Creek/);
  });
});

/** Puts the loco's front at `off` on the straight's edge, facing a→b. */
function placeAt(s: GameState, run: RunDef, off: number): void {
  s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'x', off, dir: 1 }, s.train.length);
}

describe('tunnels and trestles (spec §4.3)', () => {
  it('announces entering and leaving a tunnel, as the loco front passes its portals', () => {
    const run = straight({ tunnels: [{ id: 't1', edge: 'x', from: 2000, to: 2100, name: 'Juniper Tunnel' }] });
    const s = game(run);
    placeAt(s, run, 1990);
    const events = runFor(s, run, 20, (st) => {
      steady(st);
      st.train.v = 10;
    });
    expect(events.filter((e) => e.type === 'tunnelEnter' || e.type === 'tunnelExit')).toEqual([
      { type: 'tunnelEnter', id: 't1' },
      { type: 'tunnelExit', id: 't1' },
    ]);
  });

  it('announces leaving when the train backs out of a tunnel', () => {
    const run = straight({ tunnels: [{ id: 't1', edge: 'x', from: 2000, to: 2100, name: 'Juniper Tunnel' }] });
    const s = game(run);
    placeAt(s, run, 2010);
    s.train.reverser = -1;
    const events = runFor(s, run, 5, (st) => {
      steady(st);
      st.train.v = -5;
    });
    expect(ofType(events, 'tunnelExit')).toEqual([{ type: 'tunnelExit', id: 't1' }]);
  });

  it('announces a trestle, and crosses a burning one at speed', () => {
    const run = straight({
      trestles: [
        { id: 'r1', edge: 'x', from: 2000, to: 2100, name: 'Sage Creek Trestle' },
        { id: 'r2', edge: 'x', from: 2300, to: 2400, name: "Devil's Trestle", burning: { minSpeed: 13.4 } },
      ],
    });
    const s = game(run);
    placeAt(s, run, 1990);
    const events = runFor(s, run, 30, (st) => {
      steady(st);
      st.train.v = 15;
    });
    expect(ofType(events, 'trestleEnter')).toEqual([
      { type: 'trestleEnter', id: 'r1', burning: false },
      { type: 'trestleEnter', id: 'r2', burning: true },
    ]);
    expect(s.phase).toBe('running');
  });

  it('a burning trestle collapses under a train entering it below its minimum speed', () => {
    const run = straight({ trestles: [{ id: 'r2', edge: 'x', from: 2000, to: 2100, name: "Devil's Trestle", burning: { minSpeed: 13.4 } }] });
    const s = game(run);
    placeAt(s, run, 1995);
    runFor(s, run, 2, (st) => {
      steady(st);
      st.train.v = 11;
    });
    expect(s.loss?.reason).toBe('trestle');
    expect(s.loss?.detail).toMatch(/Devil's Trestle/);
    expect(s.loss?.detail).toMatch(/25 mph/);
  });

  it("doesn't judge a burning trestle the loco's front backs onto", () => {
    const run = straight({ trestles: [{ id: 'r2', edge: 'x', from: 2000, to: 2100, name: "Devil's Trestle", burning: { minSpeed: 13.4 } }] });
    const s = game(run);
    placeAt(s, run, 2105);
    s.train.reverser = -1;
    const events = runFor(s, run, 5, (st) => {
      steady(st);
      st.train.v = -2;
    });
    expect(s.phase).toBe('running');
    expect(ofType(events, 'trestleEnter')).toEqual([]);
  });
});

describe('obstacles (spec §8)', () => {
  const withObstacle = (kind: ObstacleKind): RunDef => straight({ obstacles: [{ id: 'o1', kind, edge: 'x', at: 2000 }] });
  /** Runs toward an obstacle at 2000 from 1990 at a fixed speed. */
  const approach = (kind: ObstacleKind, v: number, seconds = 3): { s: GameState; events: SimEvent[]; run: RunDef } => {
    const run = withObstacle(kind);
    const s = game(run);
    placeAt(s, run, 1990);
    s.train.v = v;
    const events = runFor(s, run, seconds, (st) => {
      steady(st);
      if (st.train.v !== 0) st.train.v = v;
    });
    return { s, events, run };
  };

  it('rocks: a slow train stops against them and can only back away', () => {
    const { s, events, run } = approach('rocks', 1.2, 12);
    expect(s.phase).toBe('running');
    expect(frontHead(s.train.spans).off).toBeCloseTo(2000, 6);
    expect(s.train.v).toBe(0);
    expect(ofType(events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'o1', kind: 'rocks', severe: false }]);
    expect(s.obstacles[0].state).toBe('present');
    // Full throttle can't push through.
    s.train.throttle = 1;
    const pushed = runFor(s, run, 3, steady);
    expect(frontHead(s.train.spans).off).toBeCloseTo(2000, 6);
    expect(ofType(pushed, 'obstacleHit')).toEqual([]);
    // Backing away works.
    s.train.throttle = 0;
    s.train.reverser = -1;
    s.train.throttle = 0.5;
    runFor(s, run, 3, steady);
    expect(frontHead(s.train.spans).off).toBeLessThan(1999);
  });

  it('rocks: a faster train is wrecked', () => {
    const { s, events } = approach('rocks', 3, 5);
    expect(s.loss?.reason).toBe('obstacle');
    expect(s.loss?.detail).toMatch(/rock/i);
    expect(ofType(events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'o1', kind: 'rocks', severe: true }]);
  });

  it('cattle: pushed aside at up to 10 m/s, a wreck above', () => {
    const slow = approach('cattle', 9.5);
    expect(slow.s.phase).toBe('running');
    expect(slow.s.obstacles[0].state).toBe('hit');
    expect(ofType(slow.events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'o1', kind: 'cattle', severe: false }]);
    const fast = approach('cattle', 10.5);
    expect(fast.s.loss?.reason).toBe('obstacle');
    expect(ofType(fast.events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'o1', kind: 'cattle', severe: true }]);
  });

  it('a barricade: smashed through at up to 7 m/s, a wreck above', () => {
    const slow = approach('barricade', 6.8);
    expect(slow.s.phase).toBe('running');
    expect(slow.s.obstacles[0].state).toBe('hit');
    expect(approach('barricade', 7.5).s.loss?.reason).toBe('obstacle');
  });

  it('ignores obstacles that are gone, and ones the train backs over', () => {
    const gone = withObstacle('cattle');
    const s = game(gone);
    s.obstacles[0].state = 'gone';
    placeAt(s, gone, 1990);
    runFor(s, gone, 3, (st) => {
      steady(st);
      st.train.v = 20;
    });
    expect(s.phase).toBe('running');

    const behind = withObstacle('barricade');
    const b = game(behind);
    placeAt(b, behind, 2010 + b.train.length);
    b.train.reverser = -1;
    runFor(b, behind, 3, (st) => {
      steady(st);
      st.train.v = -20;
    });
    expect(b.phase).toBe('running');
  });

  describe('the whistle scatters cattle', () => {
    /** Stands `ahead` metres short of cattle and holds the whistle for `seconds`, then waits. */
    const whistleAt = (ahead: number, seconds: number): { s: GameState; events: SimEvent[] } => {
      const run = withObstacle('cattle');
      const s = game(run);
      placeAt(s, run, 2000 - ahead);
      const events = tick(s, run, [{ kind: 'whistle', on: true }]).events;
      events.push(...runFor(s, run, seconds - 1 / TICK_HZ));
      events.push(...tick(s, run, [{ kind: 'whistle', on: false }]).events);
      events.push(...runFor(s, run, 5));
      return { s, events };
    };

    it('held for WHISTLE_SCARE_SECONDS within 40–350 m, over OBSTACLE_SCATTER_SECONDS', () => {
      const run = withObstacle('cattle');
      const s = game(run);
      placeAt(s, run, 1800);
      tick(s, run, [{ kind: 'whistle', on: true }]);
      runFor(s, run, 0.5);
      expect(s.obstacles[0].state).toBe('scattering');
      const events = runFor(s, run, 3.9);
      expect(s.obstacles[0].state).toBe('scattering');
      events.push(...runFor(s, run, 0.2));
      expect(s.obstacles[0].state).toBe('gone');
      expect(ofType(events, 'obstacleCleared')).toEqual([{ type: 'obstacleCleared', id: 'o1', kind: 'cattle' }]);
    });

    it('not by a short toot, nor too close, nor too far away', () => {
      expect(whistleAt(200, 0.4).s.obstacles[0].state).toBe('present');
      expect(whistleAt(30, 1).s.obstacles[0].state).toBe('present');
      expect(whistleAt(400, 1).s.obstacles[0].state).toBe('present');
      expect(whistleAt(345, 1).s.obstacles[0].state).toBe('gone');
    });

    it('a herd still scattering is still on the line', () => {
      const run = withObstacle('cattle');
      const s = game(run);
      placeAt(s, run, 1950);
      tick(s, run, [{ kind: 'whistle', on: true }]);
      runFor(s, run, 3, (st) => {
        steady(st);
        st.train.v = 20;
      });
      expect(s.loss?.reason).toBe('obstacle');
    });
  });
});

describe('stations (spec §5.6)', () => {
  const run = straight({
    stations: [
      { id: 'orig', name: 'Origin', edge: 'x', at: 1000, platform: 60, checkpoint: false },
      { id: 'mid', name: 'Mesa', edge: 'x', at: 2000, platform: 60, checkpoint: true, waterColumn: true },
      { id: 'dest', name: 'Coyote Bend', edge: 'x', at: 5000, platform: 60, checkpoint: false },
    ],
    sideJobs: [{ id: 'j1', title: '4 passengers Mesa → Coyote Bend', pay: 80, from: 'mid', to: 'dest', needs: 'passenger' }],
  });
  const DWELL = DWELL_SECONDS * TICK_HZ;
  /** A train standing with its front `off` metres along, levers at rest. */
  const standing = (off: number, consist: CarType[] = LIGHT): GameState => {
    const s = game(run, consist);
    placeAt(s, run, off);
    return s;
  };
  const roll = (v: number) => (s: GameState): void => {
    steady(s);
    s.train.v = v;
  };

  it('arrives on coming to a stop within 15 m of the stop mark, and completes after the dwell', () => {
    const s = standing(2012);
    const first = tick(s, run).events;
    expect(ofType(first, 'stationArrived')).toEqual([{ type: 'stationArrived', stationId: 'mid' }]);
    expect(s.train.stationStop).toEqual({ stationId: 'mid', ticks: 0, done: false });
    const events = runFor(s, run, DWELL_SECONDS - 2 / TICK_HZ);
    expect(ofType(events, 'stationDone')).toEqual([]);
    const done = runFor(s, run, 2 / TICK_HZ);
    expect(ofType(done, 'stationDone')).toEqual([{ type: 'stationDone', stationId: 'mid' }]);
    expect(s.train.stationStop).toEqual({ stationId: 'mid', ticks: DWELL, done: true });
    expect(s.train.lastStation).toBe('mid');
  });

  it("doesn't count a stop outside the window, or rolling through it", () => {
    const outside = standing(2016);
    expect(ofType(runFor(outside, run, 1), 'stationArrived')).toEqual([]);
    const rolling = standing(1980);
    expect(ofType(runFor(rolling, run, 6, roll(8)), 'stationArrived')).toEqual([]);
    expect(rolling.train.stationStop).toBeNull();
  });

  it('moving before the stop completes resets the dwell', () => {
    const s = standing(1995);
    runFor(s, run, 4);
    runFor(s, run, 0.5, roll(1));
    expect(s.train.stationStop).toBeNull();
    s.train.v = 0;
    const again = runFor(s, run, DWELL_SECONDS - 0.5);
    expect(ofType(again, 'stationArrived')).toEqual([{ type: 'stationArrived', stationId: 'mid' }]);
    expect(ofType(again, 'stationDone')).toEqual([]);
    expect(ofType(runFor(s, run, 1), 'stationDone')).toHaveLength(1);
  });

  it("doesn't arrive again at the station it just completed while still standing there", () => {
    const s = standing(1995);
    const events = runFor(s, run, DWELL_SECONDS + 5);
    events.push(...runFor(s, run, 3, roll(0.2))); // creeping along the platform
    s.train.v = 0;
    events.push(...runFor(s, run, DWELL_SECONDS + 5));
    expect(ofType(events, 'stationArrived')).toHaveLength(1);
    expect(ofType(events, 'stationDone')).toHaveLength(1);
  });

  it('the origin stop is already made: no dwell there', () => {
    const s = game(run);
    const events = runFor(s, run, DWELL_SECONDS + 1);
    expect(events.filter((e) => e.type === 'stationArrived' || e.type === 'stationDone')).toEqual([]);
  });

  it('a water column fills the tender when the stop completes', () => {
    const s = standing(2000);
    s.train.water = 30;
    s.train.fire = 0;
    const events = runFor(s, run, DWELL_SECONDS + 0.5);
    expect(s.train.water).toBe(s.train.waterCap);
    expect(ofType(events, 'waterFull')).toHaveLength(1);
    expect(s.stats.waterStops).toBe(1);
  });

  it('saves a checkpoint as the train moves off from a completed checkpoint stop', () => {
    const s = standing(2000);
    let events = runFor(s, run, DWELL_SECONDS + 2);
    expect(s.train.pendingCheckpoint).toBe('mid');
    expect(ofType(events, 'checkpoint')).toEqual([]);
    events = runFor(s, run, 2, roll(1));
    expect(ofType(events, 'checkpoint')).toEqual([{ type: 'checkpoint', stationId: 'mid' }]);
    expect(s.train.pendingCheckpoint).toBeNull();
    events = runFor(s, run, 30, roll(1)); // out of the window
    expect(ofType(events, 'checkpoint')).toEqual([]);
    expect(s.train.stationStop).toBeNull();
  });

  it('wins on completing the stop at the destination', () => {
    const s = standing(5003);
    runFor(s, run, DWELL_SECONDS - 1);
    expect(s.phase).toBe('running');
    const events = runFor(s, run, 1.5);
    expect(s.phase).toBe('won');
    // Arrived on tick 0, done DWELL ticks later.
    expect(s.arrivedClock).toBe(s.clock0 + DWELL / TICK_HZ);
    expect(events.map((e) => e.type).filter((t) => t === 'stationDone' || t === 'won')).toEqual(['stationDone', 'won']);
    const after = tick(s, run).events;
    expect(after).toEqual([]); // the run is over
  });

  it('carries side-job passengers from their station to their destination, given the car', () => {
    const s = standing(2000, ['express', 'passenger']);
    let events = runFor(s, run, DWELL_SECONDS + 0.5);
    expect(ofType(events, 'sideJob')).toEqual([{ type: 'sideJob', id: 'j1', state: 'aboard' }]);
    expect(s.sideJobs).toEqual([{ id: 'j1', state: 'aboard' }]);
    placeAt(s, run, 5000);
    events = runFor(s, run, DWELL_SECONDS + 0.5);
    expect(ofType(events, 'sideJob')).toEqual([{ type: 'sideJob', id: 'j1', state: 'done' }]);
    expect(s.sideJobs).toEqual([{ id: 'j1', state: 'done' }]);

    const noCar = standing(2000, ['express']);
    runFor(noCar, run, DWELL_SECONDS + 0.5);
    expect(noCar.sideJobs).toEqual([{ id: 'j1', state: 'pending' }]);
  });

  it('boards side-job passengers waiting at the origin before the train leaves', () => {
    const fromOrigin = straight({ sideJobs: [{ id: 'j0', title: 'Drummers', pay: 40, from: 'orig', to: 'dest', needs: 'passenger' }] });
    const s = game(fromOrigin, ['passenger']);
    const events = tick(s, fromOrigin).events;
    expect(ofType(events, 'sideJob')).toEqual([{ type: 'sideJob', id: 'j0', state: 'aboard' }]);
  });
});

describe('water towers and the spout (spec §5.5)', () => {
  // The light train is 40 m long: loco 24–40, tender 15–24, so its hatch is at x = 17, 23 m behind the front.
  const run = straight({ waterTowers: [{ id: 'w1', edge: 'x', at: 2000, name: 'Dry Gulch tank' }] });
  const HATCH_BEHIND_FRONT = 23;
  /** The train standing with its hatch `off` metres from the spout (+ = the hatch is past it), the Rider at the hatch. */
  const atTower = (off: number): GameState => {
    const s = game(run);
    placeAt(s, run, 2000 + HATCH_BEHIND_FRONT + off);
    s.train.water = 40;
    s.train.fire = 0;
    s.rider.x = 17;
    s.rider.y = 2.8;
    s.rider.surface = 'tenderTop';
    s.rider.car = 1;
    return s;
  };

  it('the Rider lowers the spout with the train stopped and the hatch within 3 m of it', () => {
    const s = atTower(2.5);
    const events: SimEvent[] = [];
    expect(spoutPrompt(s, run)).toBe('lower');
    expect(tryLowerSpout(s, run, events)).toBe(true);
    expect(s.train.spout).toBe('down');
    expect(s.train.spoutTower).toBe('w1');
    expect(events).toEqual([{ type: 'spout', down: true }]);
    expect(s.stats.waterStops).toBe(1);
    expect(tryLowerSpout(s, run, [])).toBe(false); // already down
    expect(spoutPrompt(s, run)).toBeNull();
  });

  it("won't reach a hatch more than 3 m off, a moving train, or a full tender", () => {
    const off = atTower(-3.5);
    expect(tryLowerSpout(off, run, [], { force: true })).toBe(false);
    expect(spoutPrompt(off, run)).toBe('align');

    const moving = atTower(0);
    moving.train.v = 0.2;
    expect(tryLowerSpout(moving, run, [], { force: true })).toBe(false);
    expect(spoutPrompt(moving, run)).toBe('align');

    const full = atTower(0);
    full.train.water = full.train.waterCap;
    expect(tryLowerSpout(full, run, [], { force: true })).toBe(false);
    expect(spoutPrompt(full, run)).toBeNull();
  });

  it('needs the Rider on the tender top by the hatch, unless forced', () => {
    const away = atTower(0);
    away.rider.x = 19; // 2 m from the hatch
    expect(tryLowerSpout(away, run, [])).toBe(false);
    expect(spoutPrompt(away, run)).toBeNull();
    const roof = atTower(0);
    roof.rider.surface = 'roof';
    expect(tryLowerSpout(roof, run, [])).toBe(false);
    expect(spoutPrompt(roof, run)).toBeNull();
    expect(tryLowerSpout(roof, run, [], { force: true })).toBe(true);
  });

  it('prompts nothing far from a tower', () => {
    expect(spoutPrompt(atTower(-200), run)).toBeNull();
  });

  it('fills at WATER_FILL_RATE until full, then swings the spout back up', () => {
    const s = atTower(0);
    tryLowerSpout(s, run, [], { force: true });
    runFor(s, run, 1);
    expect(s.train.water).toBeCloseTo(52, 6);
    const events = runFor(s, run, 5);
    expect(s.train.water).toBe(100);
    expect(ofType(events, 'waterFull')).toHaveLength(1);
    expect(ofType(events, 'spout')).toEqual([{ type: 'spout', down: false }]);
    expect(s.train.spout).toBe('up');
    expect(s.train.spoutTower).toBeNull();
  });

  it('moving the train raises the spout', () => {
    const s = atTower(0);
    tryLowerSpout(s, run, [], { force: true });
    runFor(s, run, 1);
    s.train.throttle = 0.3;
    const events = runFor(s, run, 0.5);
    expect(s.train.spout).toBe('up');
    expect(ofType(events, 'spout')).toEqual([{ type: 'spout', down: false }]);
    const level = s.train.water;
    runFor(s, run, 1);
    expect(s.train.water).toBeLessThanOrEqual(level);
  });
});
