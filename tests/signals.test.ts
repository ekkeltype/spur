import { describe, expect, it } from 'vitest';
import { newGame } from '../src/sim/game';
import { frontHead, moveSpans, netIndex, spansFromFront, spansLength, walk } from '../src/sim/network';
import {
  APPROACH_LIMIT,
  BLOCK_MAX,
  DIVERGE_LIMIT,
  RED_SIGNAL_FINE,
  SIGNAL_DEBOUNCE_SECONDS,
  SPEED_FINE,
  SPEED_FINE_TOLERANCE,
  TICK_HZ,
} from '../src/sim/rules';
import { aspectOf, blockOf, initialSignals, restrictionLimit, stepSignals } from '../src/sim/signals';
import type { AiTrainState, Aspect, GameState, ObstacleKind, ObstacleState, RunDef, SignalDef, SimEvent, TickMotion, TrackHead } from '../src/sim/types';
import { filterForEngineer } from '../src/sim/views';
import { baseRun, yRun } from './fixtures';

// Signals on the Y network (all but w1 govern eastbound trains):
//
//   A ──e1── b1(400) ── w1(600, westbound) ── j1(950) J1 ──e2── b2(300) ── L1 ──e4── B
//                                                     └──e3 (spur)── b3(300) ── S (buffers)
const SIGNALS: SignalDef[] = [
  { id: 'b1', edge: 'e1', at: 400, facing: 1, kind: 'block' },
  { id: 'w1', edge: 'e1', at: 600, facing: -1, kind: 'block' },
  { id: 'j1', edge: 'e1', at: 950, facing: 1, kind: 'junction', junction: 'J1' },
  { id: 'b2', edge: 'e2', at: 300, facing: 1, kind: 'block' },
  { id: 'b3', edge: 'e3', at: 300, facing: 1, kind: 'block' },
];

const signalRun = (extra: Partial<RunDef> = {}): RunDef => yRun({ signals: SIGNALS, ...extra });

function game(run: RunDef): GameState {
  return newGame(run, { seed: 1, consist: [], upgrades: [], assists: { rider: false, engineer: false } });
}

function aspects(s: GameState, run: RunDef): Record<string, Aspect> {
  const out: Record<string, Aspect> = {};
  for (const sig of run.signals) out[sig.id] = aspectOf(s, run, sig.id);
  return out;
}

function addObstacle(s: GameState, edge: string, at: number, kind: ObstacleKind = 'rocks', state: ObstacleState['state'] = 'present'): ObstacleState {
  const o: ObstacleState = { id: `o${s.obstacles.length + 1}`, kind, edge, at, state, ticks: 0, calmTicks: 0 };
  s.obstacles.push(o);
  return o;
}

function addTrain(s: GameState, spans: AiTrainState['spans'], active = true): AiTrainState {
  const a: AiTrainState = { id: `t${s.ai.length + 1}`, active, done: false, spans, v: 10, started: true, wrecked: false };
  s.ai.push(a);
  return a;
}

/** Puts the player's train (25 m) with its loco's front at `front`. */
function place(s: GameState, run: RunDef, front: TrackHead): void {
  s.train.spans = spansFromFront(netIndex(run), s.switches, front, s.train.length);
}

const ALL_CLEAR: Record<string, Aspect> = { b1: 'clear', w1: 'clear', j1: 'clear', b2: 'clear', b3: 'clear' };

const STILL: TickMotion = { frontPath: [], moved: 0 };

/** One tick of the signals module, as game.ts runs it (the tick counter advances after the modules). */
function tick(s: GameState, run: RunDef, motion: TickMotion = STILL): SimEvent[] {
  const events: SimEvent[] = [];
  stepSignals(s, run, motion, events);
  s.tick++;
  return events;
}

/** Moves the player's train `d` m forward (following the switches), returning the tick's motion. */
function drive(s: GameState, run: RunDef, d: number): TickMotion {
  const ix = netIndex(run);
  const frontPath = walk(ix, s.switches, frontHead(s.train.spans), d).spans;
  const m = moveSpans(ix, s.switches, s.train.spans, d);
  s.train.spans = m.spans;
  return { frontPath, moved: m.moved };
}

/** Backs the player's train up `d` m: the front covers no new track. */
function reverse(s: GameState, run: RunDef, d: number): TickMotion {
  const m = moveSpans(netIndex(run), s.switches, s.train.spans, -d);
  s.train.spans = m.spans;
  return { frontPath: [], moved: m.moved };
}

/** Drives at speed `v` for `seconds`, collecting the events. */
function cruise(s: GameState, run: RunDef, v: number, seconds: number): SimEvent[] {
  s.train.v = v;
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * TICK_HZ; i++) events.push(...tick(s, run, drive(s, run, v / TICK_HZ)));
  return events;
}

const passed = (id: string, aspect: Aspect): SimEvent => ({ type: 'signalPassed', id, aspect });
const RED_FINE: SimEvent = { type: 'fine', reason: 'redSignal', amount: RED_SIGNAL_FINE };
const SPEEDING: SimEvent = { type: 'fine', reason: 'speeding', amount: SPEED_FINE };

describe('blocks', () => {
  it('run from a signal to the next one facing the same way, along the route the switches set', () => {
    const run = signalRun();
    const s = game(run);
    expect(blockOf(s, run, 'b1')).toEqual({ spans: [{ edge: 'e1', from: 400, to: 950 }], next: 'j1' });
    expect(blockOf(s, run, 'j1')).toEqual({
      spans: [
        { edge: 'e1', from: 950, to: 1000 },
        { edge: 'e2', from: 0, to: 300 },
      ],
      next: 'b2',
    });
    s.switches.J1 = 'reverse';
    expect(blockOf(s, run, 'j1')).toEqual({
      spans: [
        { edge: 'e1', from: 950, to: 1000 },
        { edge: 'e3', from: 0, to: 300 },
      ],
      next: 'b3',
    });
  });

  it('end at the buffers, and ignore signals facing the other way', () => {
    const run = signalRun();
    const s = game(run);
    expect(blockOf(s, run, 'b3')).toEqual({ spans: [{ edge: 'e3', from: 300, to: 600 }], next: null });
    expect(blockOf(s, run, 'w1')).toEqual({ spans: [{ edge: 'e1', from: 600, to: 0 }], next: null }); // past b1, which faces east
  });

  it('are at most BLOCK_MAX long', () => {
    const run = baseRun({
      nodes: [
        { id: 'X', kind: 'end', x: 0, y: 0 },
        { id: 'Y', kind: 'end', x: 40, y: 0 },
      ],
      edges: [{ id: 'x1', a: 'X', b: 'Y', length: 4000, kind: 'main', speedLimit: 25, terrain: 'desert' }],
      mainLine: ['x1'],
      start: { edge: 'x1', off: 50, dir: 1 },
      signals: [{ id: 's', edge: 'x1', at: 100, facing: 1, kind: 'block' }],
    });
    const s = game(run);
    expect(spansLength(blockOf(s, run, 's').spans)).toBe(BLOCK_MAX);
    const far = addObstacle(s, 'x1', 100 + BLOCK_MAX + 50);
    expect(aspectOf(s, run, 's')).toBe('clear');
    far.at = 100 + BLOCK_MAX - 50;
    expect(aspectOf(s, run, 's')).toBe('stop');
  });
});

describe('aspects', () => {
  it('are all clear on an empty line', () => {
    const run = signalRun();
    expect(aspects(game(run), run)).toEqual(ALL_CLEAR);
  });

  it('a block signal shows stop for an obstacle in its block, and the signal before it approach', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e1', 700);
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'stop' }); // w1 governs westbound: 700 is behind it
    s.obstacles = [];
    addObstacle(s, 'e2', 100);
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'approach', j1: 'stop' });
  });

  it('look only one signal ahead', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e4', 100); // in b2's block
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b2: 'stop', j1: 'approach', b1: 'clear' });
  });

  it('a westbound signal protects its own block', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e1', 150); // west of b1, which faces the other way
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, w1: 'stop' });
  });

  it('a junction signal reads the route the switch sets: diverging aspects on the reverse leg', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e2', 100); // blocks the normal route only
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'approach', j1: 'stop' });
    s.switches.J1 = 'reverse'; // throwing the switch changes what j1 shows (spec §9.2)
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, j1: 'divergeClear' });
    addObstacle(s, 'e3', 450); // in b3's block, beyond the next signal on the spur
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, j1: 'divergeApproach', b3: 'stop' });
    addObstacle(s, 'e3', 100); // in j1's own block on the spur
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'approach', j1: 'stop', b3: 'stop' });
    s.switches.J1 = 'normal';
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'approach', j1: 'stop', b3: 'stop' });
    s.obstacles = s.obstacles.filter((o) => o.edge !== 'e2');
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b3: 'stop' });
  });

  it('other trains and the runaway obstruct a block; inactive ones do not', () => {
    const run = signalRun();
    const s = game(run);
    const freight = addTrain(s, [{ edge: 'e1', from: 800, to: 500 }]);
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'stop', w1: 'stop' });
    freight.active = false;
    expect(aspects(s, run)).toEqual(ALL_CLEAR);
    addTrain(s, [{ edge: 'e3', from: 60, to: 100 }]); // a runaway rolling into the spur
    s.switches.J1 = 'reverse';
    expect(aspects(s, run)).toEqual({ ...ALL_CLEAR, b1: 'approach', j1: 'stop' });
  });

  it("never count the player's own train", () => {
    const run = signalRun();
    const s = game(run);
    place(s, run, { edge: 'e1', off: 700, dir: 1 }); // standing in b1's block
    expect(aspects(s, run)).toEqual(ALL_CLEAR);
    place(s, run, { edge: 'e2', off: 20, dir: 1 }); // across the junction, in j1's block
    expect(aspects(s, run)).toEqual(ALL_CLEAR);
  });

  it('scattering cattle still obstruct; obstacles that are gone, or that a train went through, do not', () => {
    const run = signalRun();
    const s = game(run);
    const cattle = addObstacle(s, 'e1', 700, 'cattle', 'scattering');
    expect(aspectOf(s, run, 'b1')).toBe('stop');
    cattle.state = 'hit'; // pushed aside or smashed through by a train: the line is open again
    expect(aspectOf(s, run, 'b1')).toBe('clear');
    cattle.state = 'gone';
    expect(aspectOf(s, run, 'b1')).toBe('clear');
  });
});

describe('passing signals', () => {
  it('starts with no restriction and nothing passed', () => {
    expect(initialSignals()).toEqual({ restriction: null, passed: {} });
  });

  it('reports each signal the loco passes in its facing direction, with the aspect it showed', () => {
    const run = signalRun();
    const s = game(run); // the loco's front at e1 200, eastbound
    expect(tick(s, run, drive(s, run, 190))).toEqual([]); // → 390
    const ev = tick(s, run, drive(s, run, 20)); // → 410
    expect(ev).toEqual([passed('b1', 'clear')]);
    expect(s.signals.passed).toEqual({ b1: s.tick - 1 });
    // w1 governs westbound trains: going by it eastbound isn't passing it.
    expect(tick(s, run, drive(s, run, 250))).toEqual([]); // → 660
  });

  it("tells the Engineer a signal was passed, never what it showed", () => {
    expect(filterForEngineer(passed('b1', 'stop'))).toEqual({ type: 'signalPassed', id: 'b1' });
  });

  it('passes several signals in one tick in track order', () => {
    const run = signalRun();
    const s = game(run);
    tick(s, run, drive(s, run, 190)); // → 390
    expect(tick(s, run, drive(s, run, 570))).toEqual([passed('b1', 'clear'), passed('j1', 'clear')]); // → 960
  });

  it('backing over a signal is not passing it; passing it again soon after counts once', () => {
    const run = signalRun();
    const s = game(run);
    tick(s, run, drive(s, run, 190)); // → 390
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('b1', 'clear')]); // → 410
    expect(tick(s, run, reverse(s, run, 20))).toEqual([]); // → 390
    expect(tick(s, run, drive(s, run, 20))).toEqual([]); // → 410 again: debounced
    for (let i = 0; i < SIGNAL_DEBOUNCE_SECONDS * TICK_HZ; i++) tick(s, run);
    tick(s, run, reverse(s, run, 20));
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('b1', 'clear')]);
  });

  it('does nothing once the run is over', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e1', 700);
    tick(s, run, drive(s, run, 190));
    s.phase = 'lost';
    expect(tick(s, run, drive(s, run, 20))).toEqual([]);
    expect(s.stats.fines).toBe(0);
  });
});

describe('fines and restrictions', () => {
  it('running a red signal is fined', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e1', 700);
    tick(s, run, drive(s, run, 190));
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('b1', 'stop'), RED_FINE]);
    expect(s.stats).toMatchObject({ fines: RED_SIGNAL_FINE, redSignals: 1, speedFines: 0 });
    expect(s.signals.restriction).toBeNull();
  });

  it('approach limits the speed until the next signal, and speeding is fined once', () => {
    const run = signalRun();
    const s = game(run);
    addObstacle(s, 'e2', 100); // j1 shows stop, so b1 shows approach
    tick(s, run, drive(s, run, 190));
    s.train.v = 8;
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('b1', 'approach')]);
    expect(s.signals.restriction).toEqual({ signalId: 'b1', limit: APPROACH_LIMIT, fined: false });
    expect(restrictionLimit(s)).toBe(APPROACH_LIMIT);
    expect(cruise(s, run, APPROACH_LIMIT * SPEED_FINE_TOLERANCE, 1)).toEqual([]); // within the tolerance
    expect(cruise(s, run, 10.5, 2)).toEqual([SPEEDING]); // once per restriction
    expect(s.stats).toMatchObject({ fines: SPEED_FINE, speedFines: 1, redSignals: 0 });
    expect(s.signals.restriction?.fined).toBe(true);
  });

  it('the next signal lifts the restriction', () => {
    const run = signalRun();
    const s = game(run);
    const rocks = addObstacle(s, 'e2', 100);
    tick(s, run, drive(s, run, 190));
    s.train.v = 8;
    tick(s, run, drive(s, run, 20)); // b1 at approach
    rocks.state = 'gone'; // j1 clears
    expect(cruise(s, run, 8, 70)).toEqual([passed('j1', 'clear')]);
    expect(s.signals.restriction).toBeNull();
    expect(restrictionLimit(s)).toBe(Infinity);
    expect(cruise(s, run, 20, 1)).toEqual([]);
    expect(s.stats.fines).toBe(0);
  });

  it('each approach signal restricts afresh', () => {
    const run = signalRun();
    const s = game(run);
    const rocks = addObstacle(s, 'e2', 100);
    tick(s, run, drive(s, run, 190));
    s.train.v = 12;
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('b1', 'approach'), SPEEDING]); // already too fast
    rocks.state = 'gone';
    addObstacle(s, 'e4', 100); // b2 shows stop, so j1 shows approach
    expect(cruise(s, run, 12, 50)).toEqual([passed('j1', 'approach'), SPEEDING]);
    expect(s.signals.restriction).toEqual({ signalId: 'j1', limit: APPROACH_LIMIT, fined: true });
    expect(s.stats).toMatchObject({ fines: 2 * SPEED_FINE, speedFines: 2 });
  });

  it('divergeClear limits the speed through the junction; divergeApproach like approach', () => {
    const run = signalRun();
    const s = game(run);
    s.switches.J1 = 'reverse';
    tick(s, run, drive(s, run, 740)); // → 940
    s.train.v = 12;
    expect(tick(s, run, drive(s, run, 20))).toEqual([passed('j1', 'divergeClear')]);
    expect(s.signals.restriction).toEqual({ signalId: 'j1', limit: DIVERGE_LIMIT, fined: false });
    expect(cruise(s, run, 15, 1)).toEqual([SPEEDING]);

    const t = game(run);
    t.switches.J1 = 'reverse';
    addObstacle(t, 'e3', 450); // b3 shows stop
    tick(t, run, drive(t, run, 740));
    t.train.v = 8;
    expect(tick(t, run, drive(t, run, 20))).toEqual([passed('j1', 'divergeApproach')]);
    expect(restrictionLimit(t)).toBe(APPROACH_LIMIT);
  });
});

describe('determinism', () => {
  it('the same drive past the same signals gives the same events and state, all plain JSON', () => {
    const play = (): { events: SimEvent[]; state: GameState } => {
      const run = signalRun();
      const s = game(run);
      const rocks = addObstacle(s, 'e2', 100);
      addObstacle(s, 'e3', 450, 'cattle', 'scattering');
      const events: SimEvent[] = [];
      for (let i = 0; i < 150 * TICK_HZ; i++) {
        if (i === 60 * TICK_HZ) rocks.state = 'gone';
        s.train.v = 6 + 5 * Math.sin(i / 300);
        events.push(...tick(s, run, drive(s, run, s.train.v / TICK_HZ)));
      }
      return { events, state: s };
    };
    const a = play();
    const b = play();
    expect(a.events.map((e) => e.type)).toEqual(['signalPassed', 'fine', 'signalPassed']);
    expect(a.events).toEqual(b.events);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.parse(JSON.stringify(a.state.signals))).toEqual(a.state.signals);
  });
});
