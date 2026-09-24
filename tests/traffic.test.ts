import { describe, expect, it } from 'vitest';
import { newGame } from '../src/sim/game';
import { frontHead, moveSpans, netIndex, spansFromFront, spansLength, walk } from '../src/sim/network';
import { GRAVITY, RUNAWAY_ACCEL, RUNAWAY_MAX, TICK_HZ } from '../src/sim/rules';
import { routeDistanceAt, routeSpans } from '../src/sim/schedule';
import { EXPLOSION_HEIGHT, initialTraffic, stepTelegrams, stepTraffic } from '../src/sim/traffic';
import type { AiTrainDef, GameState, GradeDef, RunDef, SimEvent, TickMotion, TrackHead } from '../src/sim/types';
import { loopRun, yRun } from './fixtures';

const NOON = 12 * 3600; // the fixtures' startClock
const STILL: TickMotion = { frontPath: [], moved: 0 };

// No. 7 runs east → west over the loop network on the main line: in at E, out at W (2400 m).
function freight(extra: Partial<AiTrainDef> = {}): AiTrainDef {
  return {
    id: 'f7',
    name: 'No. 7 Freight',
    kind: 'freight',
    cars: 8,
    length: 150,
    route: [
      { edge: 'm3', dir: -1 },
      { edge: 'm2', dir: -1 },
      { edge: 'm1', dir: -1 },
    ],
    depart: NOON + 60,
    speed: 10,
    stops: [],
    charted: true,
    ...extra,
  };
}

function game(run: RunDef): GameState {
  return newGame(run, { seed: 1, consist: [], upgrades: [], assists: { rider: false, engineer: false } });
}

const clockOf = (s: GameState): number => s.clock0 + s.tick / TICK_HZ;

/** Puts the player's train (25 m: loco and tender) with its loco's front at `front`. */
function place(s: GameState, run: RunDef, front: TrackHead): void {
  s.train.spans = spansFromFront(netIndex(run), s.switches, front, s.train.length);
}

/** One tick of traffic and telegrams, as game.ts runs them (the tick counter advances after the modules). */
function tick(s: GameState, run: RunDef, motion: TickMotion = STILL): SimEvent[] {
  const events: SimEvent[] = [];
  stepTraffic(s, run, motion, events);
  stepTelegrams(s, run, motion, events);
  s.tick++;
  return events;
}

/** Ticks with the player standing still until the clock reaches `clock`. */
function runTo(s: GameState, run: RunDef, clock: number): SimEvent[] {
  const events: SimEvent[] = [];
  while (clockOf(s) < clock - 1e-9) events.push(...tick(s, run));
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

// Ore cars loose at the mill (yRun e1 300), rolling east toward J1 once the player's loco passes e4 500.
function runaway(extra: Partial<NonNullable<AiTrainDef['runaway']>> = {}): AiTrainDef {
  return {
    id: 'rw',
    name: 'the runaway ore train',
    kind: 'runaway',
    cars: 4,
    length: 40,
    route: [],
    depart: 0,
    speed: 0,
    stops: [],
    charted: false,
    runaway: { start: { edge: 'e1', off: 300 }, dir: 1, trigger: { edge: 'e4', off: 500 }, telegram: 'Ore cars loose at the mill, rolling east!', ...extra },
  };
}

const LOOSE: SimEvent = { type: 'runawayLoose', id: 'rw' };
const WARNING: SimEvent = { type: 'telegram', id: 'rw-loose', text: 'Ore cars loose at the mill, rolling east!' };

/** Ticks with the player standing still while `going()` holds (at most `seconds`). */
function runWhile(s: GameState, run: RunDef, seconds: number, going: () => boolean): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * TICK_HZ && going(); i++) events.push(...tick(s, run));
  return events;
}

describe('scheduled trains', () => {
  it('start off the map', () => {
    const run = loopRun({ aiTrains: [freight()] });
    expect(initialTraffic(run)).toEqual([{ id: 'f7', active: false, done: false, spans: [], v: 0, started: false, wrecked: false }]);
  });

  it('enter on time, dwell at their stops and leave, as a pure function of the clock', () => {
    const def = freight({ stops: [{ at: 500, dwell: 30 }] });
    const run = loopRun({ aiTrains: [def] });
    const ix = netIndex(run);
    const s = game(run);
    place(s, run, { edge: 's1', off: 300, dir: 1 }); // in the siding, clear of the main line
    const f7 = s.ai[0];

    expect(runTo(s, run, def.depart)).toEqual([]);
    expect(f7.active).toBe(false);

    // Its front enters at E just after departure time.
    expect(runTo(s, run, def.depart + 0.5)).toEqual([{ type: 'aiEntered', id: 'f7' }]);
    expect(f7.active).toBe(true);
    expect(f7.v).toBe(10);

    // Running: the occupied track follows the timetable (as of the last tick's clock).
    runTo(s, run, def.depart + 20);
    const last = s.clock0 + (s.tick - 1) / TICK_HZ;
    expect(f7.spans).toEqual(routeSpans(ix, def, routeDistanceAt(def, last)));

    // Dwelling at the stop (front at route distance 500 from depart + 50 s to depart + 80 s).
    runTo(s, run, def.depart + 65);
    expect(f7.v).toBe(0);
    expect(f7.spans).toEqual(routeSpans(ix, def, 500));
    runTo(s, run, def.depart + 81);
    expect(f7.v).toBe(10);

    // The rear leaves at W after 2400 + 150 m of running plus the dwell: depart + 285 s.
    expect(runTo(s, run, def.depart + 284.9)).toEqual([]);
    expect(f7.active).toBe(true);
    expect(runTo(s, run, def.depart + 286)).toEqual([{ type: 'aiLeft', id: 'f7' }]);
    expect(f7).toMatchObject({ active: false, done: true, spans: [], v: 0 });
    expect(runTo(s, run, def.depart + 400)).toEqual([]);
    expect(s.phase).toBe('running');
  });

  it('a train that has already left when the run starts never appears', () => {
    const run = loopRun({ aiTrains: [freight({ depart: NOON - 3600 })] });
    const s = game(run);
    expect(runTo(s, run, NOON + 5)).toEqual([]);
    expect(s.ai[0]).toMatchObject({ active: false, done: true });
  });

  it('a train already on its way when the run starts appears on the first tick', () => {
    const run = loopRun({ aiTrains: [freight({ depart: NOON - 30 })] });
    const s = game(run);
    expect(tick(s, run)).toEqual([{ type: 'aiEntered', id: 'f7' }]);
    expect(s.ai[0].spans).toEqual([{ edge: 'm3', from: 850, to: 700 }]);
  });
});

describe('collisions', () => {
  const lostEvents = (ev: SimEvent[]): SimEvent[] => ev.filter((e) => e.type === 'collision' || e.type === 'explosion' || e.type === 'lost');

  it('meeting another train head-on on the single line loses the run', () => {
    const def = freight();
    const run = loopRun({ aiTrains: [def] });
    const s = game(run);
    place(s, run, { edge: 'm3', off: 600, dir: 1 }); // eastbound, the freight's front reaches 600 at depart + 40 s
    runTo(s, run, def.depart + 39.9);
    expect(s.phase).toBe('running');
    const ev = runTo(s, run, def.depart + 40.2);
    const detail = 'Met No. 7 Freight head-on near Destination.';
    expect(s.phase).toBe('lost');
    expect(s.loss).toEqual({ reason: 'collision', detail });
    const [collision, explosion, lost] = lostEvents(ev);
    expect(collision).toEqual({ type: 'collision', with: 'f7' });
    expect(explosion).toMatchObject({ type: 'explosion', what: 'collision' });
    if (explosion.type === 'explosion') expect(explosion.x).toBeCloseTo(s.train.length, 0); // at the loco's front
    expect(lost).toEqual({ type: 'lost', reason: 'collision', detail });
    // Once lost, the overlap isn't reported again.
    expect(lostEvents(runTo(s, run, def.depart + 45))).toEqual([]);
  });

  it('fouling the main line at the loop switch is a collision', () => {
    const run = loopRun({ aiTrains: [freight()] });
    const s = game(run);
    place(s, run, { edge: 's1', off: 10, dir: 1 }); // the loco is in the siding, the tender still on m1
    expect(s.train.spans).toEqual([
      { edge: 'm1', from: 985, to: 1000 },
      { edge: 's1', from: 0, to: 10 },
    ]);
    runTo(s, run, NOON + 60 + 300);
    expect(s.loss).toEqual({ reason: 'collision', detail: 'No. 7 Freight struck the train near West loop switch.' });
  });

  it('a train entirely inside the siding lets the other one pass', () => {
    const run = loopRun({ aiTrains: [freight()] });
    const s = game(run);
    place(s, run, { edge: 's1', off: 300, dir: 1 });
    const ev = runTo(s, run, NOON + 60 + 300);
    expect(ev).toEqual([
      { type: 'aiEntered', id: 'f7' },
      { type: 'aiLeft', id: 'f7' },
    ]);
    expect(s.phase).toBe('running');
    expect(s.loss).toBeNull();
  });

  it('running into the back of a train standing at its stop', () => {
    const def = freight({ stops: [{ at: 500, dwell: 300 }] });
    const run = loopRun({ aiTrains: [def] });
    const s = game(run);
    place(s, run, { edge: 's1', off: 300, dir: 1 });
    runTo(s, run, def.depart + 60); // it stands at its stop, its rear at m3 650
    place(s, run, { edge: 'm3', off: 720, dir: -1 }); // westbound, behind it
    tick(s, run);
    expect(s.phase).toBe('running');
    for (let i = 0; i < 100 && s.phase === 'running'; i++) tick(s, run, drive(s, run, 1));
    expect(s.loss?.detail).toBe('Ran into the back of No. 7 Freight near Destination.');
  });

  it('being run into from behind', () => {
    const express: AiTrainDef = {
      ...freight(),
      id: 'x3',
      name: 'No. 3 Express',
      kind: 'express',
      route: [
        { edge: 'm1', dir: 1 },
        { edge: 'm2', dir: 1 },
        { edge: 'm3', dir: 1 },
      ],
      speed: 20,
    };
    const run = loopRun({ aiTrains: [express] });
    const s = game(run);
    place(s, run, { edge: 'm1', off: 600, dir: 1 }); // standing eastbound; the express overtakes from W
    const ev = runTo(s, run, NOON + 60 + 60);
    expect(s.loss?.detail).toBe('No. 3 Express ran into the back of the train near Origin.');
    const boom = ev.find((e) => e.type === 'explosion');
    if (boom?.type === 'explosion') expect(boom.x).toBeCloseTo(0, 0); // at the rear
  });

  it("doesn't overwrite a loss from earlier in the tick", () => {
    const run = loopRun({ aiTrains: [freight()] });
    const s = game(run);
    place(s, run, { edge: 'm3', off: 600, dir: 1 });
    s.phase = 'lost';
    s.loss = { reason: 'derailed', detail: 'Took the curve too fast.' };
    const ev = runTo(s, run, NOON + 60 + 60);
    expect(lostEvents(ev)).toEqual([]);
    expect(s.loss).toEqual({ reason: 'derailed', detail: 'Took the curve too fast.' });
  });
});

describe('the runaway', () => {
  it('breaks loose when the loco passes its trigger moving forward', () => {
    const run = yRun({ aiTrains: [runaway()] });
    const s = game(run);
    place(s, run, { edge: 'e4', off: 520, dir: -1 }); // westbound
    const rw = s.ai[0];
    expect(tick(s, run, drive(s, run, 10))).toEqual([]); // front 520 → 510: not yet
    expect(tick(s, run, drive(s, run, 15))).toEqual([LOOSE, WARNING]); // → 495
    expect(rw).toMatchObject({ started: true, active: true, done: false, wrecked: false });
    expect(spansLength(rw.spans)).toBeCloseTo(40, 6);
    const front = frontHead(rw.spans);
    expect(front.edge).toBe('e1');
    expect(front.off).toBeCloseTo(300, 2);
    expect(front.dir).toBe(1);
  });

  it("isn't set off by backing over its trigger, and only breaks loose once", () => {
    const run = yRun({ aiTrains: [runaway()] });
    const s = game(run);
    place(s, run, { edge: 'e4', off: 490, dir: -1 });
    expect(tick(s, run, reverse(s, run, 20))).toEqual([]); // front 490 → 510, backing
    expect(s.ai[0].started).toBe(false);
    expect(tick(s, run, drive(s, run, 20))).toEqual([LOOSE, WARNING]);
    tick(s, run, reverse(s, run, 20));
    expect(tick(s, run, drive(s, run, 20))).toEqual([]);
  });

  it('follows the switches into a spur and is wrecked at the buffers', () => {
    const run = yRun({ aiTrains: [runaway()] });
    const s = game(run);
    place(s, run, { edge: 'e4', off: 520, dir: -1 });
    s.switches.J1 = 'reverse'; // the Engineer diverts it into the spur
    const rw = s.ai[0];
    const ev = tick(s, run, drive(s, run, 30));
    const edges = new Set<string>();
    let top = 0;
    ev.push(
      ...runWhile(s, run, 300, () => {
        if (rw.active) edges.add(frontHead(rw.spans).edge);
        top = Math.max(top, rw.v);
        return !rw.done;
      }),
    );
    expect([...edges]).toEqual(['e1', 'e3']);
    expect(top).toBe(RUNAWAY_MAX);
    expect(rw).toMatchObject({ active: false, done: true, wrecked: true, spans: [], v: 0 });
    // The spur is off the train's line and off the main-line chart: the bang can't be placed.
    expect(ev).toEqual([
      LOOSE,
      WARNING,
      { type: 'runawayWrecked', id: 'rw' },
      { type: 'explosion', what: 'runaway', x: 0, y: 0 },
    ]);
    expect(s.phase).toBe('running');
    expect(runWhile(s, run, 5, () => true)).toEqual([]);
  });

  it('left on the main line, it meets the player head-on', () => {
    const run = yRun({ aiTrains: [runaway()] });
    const s = game(run);
    place(s, run, { edge: 'e4', off: 520, dir: -1 });
    tick(s, run, drive(s, run, 30));
    runWhile(s, run, 300, () => s.phase === 'running');
    expect(s.loss).toEqual({ reason: 'collision', detail: 'Met the runaway ore train head-on near Destination.' });
  });

  it('throws switches it trails through against it', () => {
    // Rolling west from e2 through J1, which is set for the spur.
    const run = yRun({ aiTrains: [runaway({ start: { edge: 'e2', off: 300 }, dir: -1, trigger: { edge: 'e3', off: 290 } })] });
    const s = game(run);
    place(s, run, { edge: 'e3', off: 280, dir: 1 }); // the player waits in the spur
    s.switches.J1 = 'reverse';
    const ev = tick(s, run, drive(s, run, 20));
    ev.push(...runWhile(s, run, 300, () => !s.ai[0].done));
    expect(ev.filter((e) => e.type === 'switchThrown')).toEqual([{ type: 'switchThrown', junction: 'J1', state: 'normal', by: 'trailing' }]);
    expect(s.switches.J1).toBe('normal');
    expect(s.ai[0].wrecked).toBe(true); // at the buffers at A
    expect(s.phase).toBe('running');
  });

  it('rolls faster downhill and slower uphill, and never backward', () => {
    const speedAfter = (grade: number, seconds: number): number => {
      const grades: GradeDef[] = grade === 0 ? [] : [{ edge: 'e1', from: 0, to: 1000, grade }];
      const run = yRun({ grades, aiTrains: [runaway({ start: { edge: 'e1', off: 100 } })] });
      const s = game(run);
      place(s, run, { edge: 'e4', off: 520, dir: -1 });
      tick(s, run, drive(s, run, 30));
      for (let i = 1; i < seconds * TICK_HZ; i++) tick(s, run);
      return s.ai[0].v;
    };
    // Heading a→b on e1: a positive grade is uphill.
    expect(speedAfter(0, 10)).toBeCloseTo(RUNAWAY_ACCEL * 10, 6);
    expect(speedAfter(0.01, 10)).toBeCloseTo((RUNAWAY_ACCEL - GRAVITY * 0.01) * 10, 6);
    expect(speedAfter(-0.01, 10)).toBeCloseTo((RUNAWAY_ACCEL + GRAVITY * 0.01) * 10, 6);
    expect(speedAfter(0.08, 10)).toBe(0); // too steep for it: it stands
  });

  it('places the wreck in the train frame: along the line ahead, or by main-line distance beside it', () => {
    // Rolling east from e2 to the buffers at B, 2080 m ahead of the eastbound player's loco.
    const ahead = yRun({ aiTrains: [runaway({ start: { edge: 'e2', off: 100 }, trigger: { edge: 'e1', off: 210 } })] });
    const s = game(ahead);
    const ev = tick(s, ahead, drive(s, ahead, 20)); // front e1 200 → 220
    ev.push(...runWhile(s, ahead, 300, () => !s.ai[0].done));
    expect(ev).toContainEqual({ type: 'explosion', what: 'runaway', x: 25 + 2080, y: EXPLOSION_HEIGHT });

    // The spur charted beside the main line (main-line 1000..1600): the wreck at S is 390 m ahead of
    // the westbound loco by main-line distance.
    const base = yRun();
    const beside = yRun({ edges: base.edges.map((e) => (e.id === 'e3' ? { ...e, mainAt: [1000, 1600] as [number, number] } : e)), aiTrains: [runaway()] });
    const t = game(beside);
    place(t, beside, { edge: 'e4', off: 520, dir: -1 });
    t.switches.J1 = 'reverse';
    const ev2 = tick(t, beside, drive(t, beside, 30)); // front at e4 490: main-line 1990
    ev2.push(...runWhile(t, beside, 300, () => !t.ai[0].done));
    const boom = ev2.find((e) => e.type === 'explosion');
    expect(boom).toMatchObject({ what: 'runaway', y: EXPLOSION_HEIGHT });
    if (boom?.type === 'explosion') expect(boom.x).toBeCloseTo(25 + 390, 6);
  });
});

describe('telegrams', () => {
  const telegrams = (ev: SimEvent[]): SimEvent[] => ev.filter((e) => e.type === 'telegram');

  it('go out once, at their clock time', () => {
    const text = 'No. 7 is running twenty minutes late.';
    const run = yRun({ telegrams: [{ id: 'late', clock: NOON + 10, text }] });
    const s = game(run);
    expect(runTo(s, run, NOON + 10)).toEqual([]);
    expect(tick(s, run)).toEqual([{ type: 'telegram', id: 'late', text }]);
    expect(s.telegramsSent).toEqual(['late']);
    expect(runTo(s, run, NOON + 60)).toEqual([]);
  });

  it('go out once, when the loco passes their point moving forward', () => {
    const text = 'Cattle reported on the line past the mill.';
    const run = yRun({ telegrams: [{ id: 'cattle', at: { edge: 'e1', off: 300 }, text }] });
    const s = game(run); // the loco's front at e1 200, eastbound
    expect(tick(s, run, drive(s, run, 90))).toEqual([]); // → 290
    expect(tick(s, run, drive(s, run, 20))).toEqual([{ type: 'telegram', id: 'cattle', text }]); // → 310
    tick(s, run, reverse(s, run, 30)); // → 280
    expect(tick(s, run, drive(s, run, 30))).toEqual([]); // past it again: already sent
  });

  it('go out at whichever of their clock and point comes first', () => {
    const run = yRun({
      telegrams: [
        { id: 'a', clock: NOON + 5, at: { edge: 'e1', off: 900 }, text: 'By the clock.' },
        { id: 'b', clock: NOON + 3600, at: { edge: 'e1', off: 250 }, text: 'By the point.' },
      ],
    });
    const s = game(run);
    expect(telegrams(tick(s, run, drive(s, run, 60)))).toEqual([{ type: 'telegram', id: 'b', text: 'By the point.' }]);
    expect(telegrams(runTo(s, run, NOON + 6))).toEqual([{ type: 'telegram', id: 'a', text: 'By the clock.' }]);
    expect(telegrams(tick(s, run, drive(s, run, 700)))).toEqual([]);
    expect(s.telegramsSent).toEqual(['b', 'a']);
  });

  it("warn the Engineer when the runaway breaks loose, once", () => {
    const run = yRun({ aiTrains: [runaway()] });
    const s = game(run);
    place(s, run, { edge: 'e4', off: 520, dir: -1 });
    expect(tick(s, run, drive(s, run, 30))).toEqual([LOOSE, WARNING]);
    expect(s.telegramsSent).toEqual(['rw-loose']);
    expect(telegrams(runWhile(s, run, 5, () => true))).toEqual([]);
  });

  it('stop when the run is over', () => {
    const run = yRun({ telegrams: [{ id: 'late', clock: NOON, text: 'Late.' }] });
    const s = game(run);
    s.phase = 'won';
    expect(tick(s, run)).toEqual([]);
    expect(s.telegramsSent).toEqual([]);
  });
});

describe('determinism', () => {
  it('the same drive gives the same traffic, events and state, and the state stays plain JSON', () => {
    const play = (): { events: SimEvent[]; state: GameState } => {
      const run = loopRun({
        aiTrains: [freight({ stops: [{ at: 700, dwell: 20 }] }), { ...runaway({ start: { edge: 'm1', off: 60 }, trigger: { edge: 'm1', off: 400 } }), length: 30 }],
        telegrams: [
          { id: 'late', clock: NOON + 30, text: 'No. 7 is late.' },
          { id: 'loop', at: { edge: 's1', off: 50 }, text: 'Wait in the loop.' },
        ],
      });
      const s = game(run);
      s.switches.P = 'reverse'; // into the siding
      const events: SimEvent[] = [];
      for (let i = 0; i < 240 * TICK_HZ && s.phase === 'running'; i++) {
        const d = i < 100 * TICK_HZ ? (6 + 3 * Math.sin(i / 97)) / TICK_HZ : 0;
        events.push(...tick(s, run, d > 0 ? drive(s, run, d) : STILL));
      }
      return { events, state: s };
    };
    const a = play();
    const b = play();
    expect(a.events.length).toBeGreaterThan(4);
    expect(a.events).toEqual(b.events);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });
});
