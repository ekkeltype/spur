import { describe, expect, it, vi } from 'vitest';
import { RUNS } from '../src/content/runs';
import { AP_CATTLE_WHISTLE, AP_WHISTLE_SECONDS, autopilotStep, newAutopilot, type AutopilotState } from '../src/sim/autopilot';
import { composeConsist, newGame, step } from '../src/sim/game';
import { framePath, frameX, frontHead, netIndex, spansFromFront, xOnSpans } from '../src/sim/network';
import { TICK_HZ, WHISTLE_EARSHOT, WHISTLE_SCARE_MAX, WHISTLE_SCARE_MIN, WHISTLE_SCARE_SECONDS, secondsToTicks } from '../src/sim/rules';
import { applyEngineerCmd, hatchX, herdsAhead, initialTrain, stepTrain, tryLowerSpout } from '../src/sim/train';
import { NO_INPUT, type Aspect, type CarType, type EngineerCmd, type GameState, type RunDef, type RunPlan, type SimEvent, type UpgradeId } from '../src/sim/types';
import { EMPTY_PLAN, baseRun, yRun } from './fixtures';

// The signals module decides aspects; here a test sets them directly (anything unset shows clear).
// The drives through the campaign's own runs read the real ones.
const aspects = vi.hoisted(() => ({}) as Record<string, Aspect>);
const realAspects = vi.hoisted(() => ({ on: false }));
vi.mock('../src/sim/signals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sim/signals')>();
  return {
    ...actual,
    aspectOf: (state: GameState, run: RunDef, id: string): Aspect => aspects[id] ?? (realAspects.on ? actual.aspectOf(state, run, id) : 'clear'),
  };
});

const plan = (p: Partial<RunPlan>): Record<string, RunPlan> => ({ main: { ...EMPTY_PLAN, ...p } });

function start(run: RunDef, consist: CarType[] = ['express'], upgrades: UpgradeId[] = []): { s: GameState; ap: AutopilotState } {
  const assists = { rider: false, engineer: false };
  const s = newGame(run, { seed: 0, consist, upgrades, assists });
  s.train = initialTrain(run, consist, upgrades, assists);
  return { s, ap: newAutopilot(run, s.variant) };
}

let seq = 0;

/** The autopilot as the Engineer, the way the game loop runs it: spout, commands, then the train. */
function drive(
  s: GameState,
  ap: AutopilotState,
  run: RunDef,
  seconds: number,
  onTick?: (s: GameState, events: SimEvent[], cmds: EngineerCmd[]) => void,
): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < seconds * TICK_HZ && s.phase === 'running'; i++) {
    const out = autopilotStep(ap, s, run);
    const events: SimEvent[] = [];
    if (out.lowerSpout) tryLowerSpout(s, run, events, { force: true });
    const cmds: EngineerCmd[] = out.cmds.map((c) => ({ ...c, seq: ++seq }) as EngineerCmd);
    for (const c of cmds) applyEngineerCmd(s, run, c, events);
    stepTrain(s, run, events);
    s.tick++;
    onTick?.(s, events, cmds);
    all.push(...events);
  }
  return all;
}

const ofType = <T extends SimEvent['type']>(events: SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Distance (m) of the loco's front past a point on its line (negative: short of it). */
function frontPast(s: GameState, run: RunDef, edge: string, off: number): number {
  const x = frameX(framePath(netIndex(run), s.switches, s.train.spans, 100, 2000), { edge, off });
  if (x === null) throw new Error(`${edge} ${off} isn't on the train's line`);
  return s.train.length - x;
}

/** A whistle blast as it began: its first tick, and how far ahead each herd within earshot was (m). */
interface Blast {
  tick: number;
  herds: Record<string, number>;
}

/** Records each blast as it begins, from a tick's events (after the tick). */
function recordBlast(run: RunDef, s: GameState, events: SimEvent[], blasts: Blast[]): void {
  if (!events.some((e) => e.type === 'whistle' && e.on)) return;
  const herds: Record<string, number> = {};
  for (const h of herdsAhead(netIndex(run), s, WHISTLE_EARSHOT + 100)) herds[h.herd.id] = h.d;
  blasts.push({ tick: s.tick - 1, herds });
}

/** No blast began with a herd ahead that would hear it from beyond the scare window: that only calms them. */
function expectNoneCalming(blasts: readonly Blast[]): void {
  for (const b of blasts) {
    for (const [id, d] of Object.entries(b.herds)) expect(d <= WHISTLE_SCARE_MAX || d > WHISTLE_EARSHOT, `blew with ${id} ${d.toFixed(0)} m ahead`).toBe(true);
  }
}

describe('the autopilot', () => {
  it('drives to the destination and stops on the mark', () => {
    const run = yRun();
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 400);
    expect(s.phase, ap.note).toBe('won');
    expect(Math.abs(frontPast(s, run, 'e4', 700))).toBeLessThan(3);
    expect(ofType(events, 'overspeed')).toEqual([]);
    expect(s.stats.maxSpeed).toBeGreaterThan(14); // it got up to its cruising speed (15 m/s)
    expect(s.stats.maxSpeed).toBeLessThan(15.5);
    expect(s.tick / TICK_HZ).toBeLessThan(200); // about 2 km
  });

  it('takes the spur by setting its switch ahead of time, and stops at a station there', () => {
    const run = yRun({
      stations: [
        { id: 'orig', name: 'Origin', edge: 'e1', at: 200, platform: 60, checkpoint: false },
        { id: 'mine', name: 'Mine', edge: 'e3', at: 450, platform: 60, checkpoint: false },
        { id: 'dest', name: 'Destination', edge: 'e4', at: 700, platform: 60, checkpoint: false },
      ],
      contract: { ...yRun().contract, destination: 'mine' },
      plan: plan({ switches: [{ junction: 'J1', state: 'reverse' }], stops: ['mine'] }),
    });
    const { s, ap } = start(run);
    let thrownAt: number | null = null;
    const events = drive(s, ap, run, 400, (st, ev) => {
      if (thrownAt === null && ev.some((e) => e.type === 'switchThrown')) thrownAt = frontHead(st.train.spans).off;
    });
    expect(s.phase, ap.note).toBe('won');
    expect(ofType(events, 'switchThrown')).toEqual([{ type: 'switchThrown', junction: 'J1', state: 'reverse', by: 'engineer' }]);
    // Thrown about 800 m out from the junction (e1 is 1000 m long).
    expect(thrownAt).toBeGreaterThan(150);
    expect(thrownAt).toBeLessThan(260);
    expect(Math.abs(frontPast(s, run, 'e3', 450))).toBeLessThan(3);
  });

  it('makes the plan stops in order, waiting out each dwell', () => {
    const run = yRun({
      stations: [
        { id: 'orig', name: 'Origin', edge: 'e1', at: 200, platform: 60, checkpoint: false },
        { id: 'halt', name: 'Halt', edge: 'e2', at: 250, platform: 60, checkpoint: true },
        { id: 'dest', name: 'Destination', edge: 'e4', at: 700, platform: 60, checkpoint: false },
      ],
      plan: plan({ stops: ['halt', 'dest'] }),
    });
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 400);
    expect(s.phase, ap.note).toBe('won');
    expect(events.filter((e) => e.type === 'stationDone' || e.type === 'checkpoint')).toEqual([
      { type: 'stationDone', stationId: 'halt' },
      { type: 'checkpoint', stationId: 'halt' },
      { type: 'stationDone', stationId: 'dest' },
    ]);
  });

  it('stops with the tender hatch under a water tower, has the spout lowered, and fills up', () => {
    const run = yRun({
      initialWater: 40,
      waterTowers: [{ id: 'w1', edge: 'e2', at: 250, name: 'Halfway tank' }],
      plan: plan({ stops: ['w1', 'dest'] }),
    });
    const { s, ap } = start(run);
    let lowered: number | null = null;
    const events = drive(s, ap, run, 500, (st, ev) => {
      if (lowered === null && ev.some((e) => e.type === 'spout' && e.down)) {
        const hatch = xOnSpans(st.train.spans, { edge: 'e2', off: 250 });
        lowered = hatch === null ? Infinity : hatch - hatchX(st.train);
      }
    });
    expect(s.phase, ap.note).toBe('won');
    expect(lowered).not.toBeNull();
    expect(Math.abs(lowered ?? Infinity)).toBeLessThan(1);
    expect(ofType(events, 'waterFull')).toHaveLength(1);
    expect(s.stats.waterStops).toBe(1);
  });

  it('decides at the tower, not at the start, whether a full tender can skip it', () => {
    // A full tender at the start: by the time the train reaches a tower 2 km on, it has used water.
    const run = yRun({
      initialWater: 100,
      waterTowers: [{ id: 'w1', edge: 'e4', at: 500, name: 'Far tank' }],
      plan: plan({ stops: ['w1', 'dest'] }),
    });
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 500);
    expect(s.phase, ap.note).toBe('won');
    expect(ofType(events, 'spout').filter((e) => e.down)).toHaveLength(1);
    expect(s.stats.waterStops).toBe(1);
  });

  it('backs up to the water tower when it starts past the spout', () => {
    // The hatch starts 8 m past the spout.
    const run = yRun({
      initialWater: 60,
      waterTowers: [{ id: 'w1', edge: 'e1', at: 200 - 23 - 8, name: 'Depot tank' }],
      plan: plan({ stops: ['w1', 'dest'] }),
    });
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 500);
    expect(s.phase, ap.note).toBe('won');
    expect(ofType(events, 'waterFull')).toHaveLength(1);
    expect(ofType(events, 'cmdResult').every((r) => r.ok)).toBe(true);
  });

  it('holds at a point until the clock passes the hold', () => {
    const until = 12 * 3600 + 300;
    const run = yRun({ plan: plan({ holds: [{ at: { edge: 'e2', off: 100 }, until }] }) });
    const { s, ap } = start(run);
    let arrived: number | null = null;
    let left: number | null = null;
    drive(s, ap, run, 600, (st) => {
      const past = xOnSpans(st.train.spans, { edge: 'e2', off: 100 });
      if (arrived === null && past !== null && st.train.v === 0) arrived = st.clock0 + st.tick / TICK_HZ;
      if (arrived !== null && left === null && st.train.v > 0) left = st.clock0 + st.tick / TICK_HZ;
    });
    expect(s.phase, ap.note).toBe('won');
    expect(arrived).not.toBeNull();
    expect(arrived ?? Infinity).toBeLessThan(until - 100);
    expect(left).toBeGreaterThanOrEqual(until);
    expect(left).toBeLessThan(until + 2);
  });

  it('keeps under a curve limit, braking for it ahead of time', () => {
    const run = yRun({
      curves: [{ id: 'c1', edge: 'e4', from: 100, to: 300, limit: 8 }],
      plan: plan({ cruise: 22 }),
    });
    const { s, ap } = start(run);
    let fastestInCurve = 0;
    const events = drive(s, ap, run, 400, (st) => {
      const f = frontHead(st.train.spans);
      if (f.edge === 'e4' && f.off >= 100 && f.off <= 300) fastestInCurve = Math.max(fastestInCurve, st.train.v);
    });
    expect(s.phase, ap.note).toBe('won');
    expect(ofType(events, 'overspeed')).toEqual([]);
    expect(fastestInCurve).toBeGreaterThan(7);
    expect(fastestInCurve).toBeLessThanOrEqual(8);
    expect(s.stats.maxSpeed).toBeGreaterThan(20);
  });

  it('stops short of a signal at stop, and goes on when it clears', () => {
    const run = yRun({ signals: [{ id: 's1', edge: 'e2', at: 300, facing: 1, kind: 'block' }] });
    const { s, ap } = start(run);
    aspects.s1 = 'stop';
    drive(s, ap, run, 300);
    expect(s.phase).toBe('running');
    expect(s.train.v).toBe(0);
    const short = -frontPast(s, run, 'e2', 300);
    expect(short).toBeGreaterThan(2);
    expect(short).toBeLessThan(25);
    aspects.s1 = 'clear';
    drive(s, ap, run, 200);
    delete aspects.s1;
    expect(s.phase, ap.note).toBe('won');
  });

  it('passes an approach signal at no more than 20 mph and keeps to it until the next signal', () => {
    const run = yRun({
      signals: [
        { id: 's1', edge: 'e2', at: 300, facing: 1, kind: 'block' },
        { id: 's2', edge: 'e4', at: 300, facing: 1, kind: 'block' },
        { id: 'back', edge: 'e2', at: 200, facing: -1, kind: 'block' }, // faces the other way: ignored
      ],
      plan: plan({ cruise: 20 }),
    });
    const { s, ap } = start(run);
    aspects.s1 = 'approach';
    aspects.back = 'stop';
    let fastest = 0;
    drive(s, ap, run, 400, (st) => {
      const f = frontHead(st.train.spans);
      const between = (f.edge === 'e2' && f.off >= 300) || (f.edge === 'e4' && f.off < 300);
      if (between) fastest = Math.max(fastest, st.train.v);
    });
    delete aspects.s1;
    delete aspects.back;
    expect(s.phase, ap.note).toBe('won');
    expect(fastest).toBeGreaterThan(7);
    expect(fastest).toBeLessThanOrEqual(9);
    expect(s.stats.maxSpeed).toBeGreaterThan(18);
  });

  it('whistles once at cattle the Rider would call, well inside the scare window, and gets them off the line', () => {
    const run = yRun({ obstacles: [{ id: 'herd', kind: 'cattle', edge: 'e2', at: 300 }], plan: plan({ cruise: 20 }) });
    const { s, ap } = start(run);
    const blasts: Blast[] = [];
    const events = drive(s, ap, run, 400, (st, ev) => recordBlast(run, st, ev, blasts));
    expect(s.phase, ap.note).toBe('won');
    expect(blasts).toHaveLength(1);
    expect(blasts[0].herds.herd).toBeGreaterThanOrEqual(AP_CATTLE_WHISTLE[0]);
    expect(blasts[0].herds.herd).toBeLessThanOrEqual(AP_CATTLE_WHISTLE[1]);
    expect(ofType(events, 'cattleCalm')).toEqual([]);
    expect(ofType(events, 'cattleScatter')).toEqual([{ type: 'cattleScatter', id: 'herd' }]);
    expect(ofType(events, 'obstacleCleared')).toEqual([{ type: 'obstacleCleared', id: 'herd', kind: 'cattle' }]);
    expect(ofType(events, 'obstacleHit')).toEqual([]);
    expect(ap.herds).toEqual(['herd']);
  });

  it('blows one blast of AP_WHISTLE_SECONDS as the loco’s front passes each plan whistle point', () => {
    const points = [
      { edge: 'e2', off: 300 },
      { edge: 'e4', off: 200 },
    ];
    const run = yRun({ plan: plan({ whistles: points }) });
    const { s, ap } = start(run);
    const blasts: { past: number; ticks: number }[] = [];
    drive(s, ap, run, 400, (st, ev) => {
      if (ev.some((e) => e.type === 'whistle' && e.on)) {
        const p = points[blasts.length];
        blasts.push({ past: frontPast(st, run, p.edge, p.off), ticks: 0 });
      }
      if (st.train.whistle) blasts[blasts.length - 1].ticks++;
    });
    expect(s.phase, ap.note).toBe('won');
    expect(blasts).toHaveLength(2);
    for (const b of blasts) {
      expect(b.past).toBeGreaterThanOrEqual(0);
      expect(b.past).toBeLessThan(1);
      expect(b.ticks).toBe(secondsToTicks(AP_WHISTLE_SECONDS));
    }
  });

  it('never begins a blast a herd ahead would hear from beyond the scare window, plan point or not', () => {
    // Plan points 800 m short of the herd (out of earshot: blown) and 400 m short (it would only calm them: skipped).
    const run = yRun({
      obstacles: [{ id: 'herd', kind: 'cattle', edge: 'e2', at: 300 }],
      plan: plan({ cruise: 20, whistles: [{ edge: 'e1', off: 500 }, { edge: 'e1', off: 900 }] }),
    });
    const { s, ap } = start(run);
    const blasts: Blast[] = [];
    const events = drive(s, ap, run, 400, (st, ev) => recordBlast(run, st, ev, blasts));
    expect(s.phase, ap.note).toBe('won');
    expectNoneCalming(blasts);
    expect(blasts).toHaveLength(2);
    expect(blasts[0].herds.herd).toBeGreaterThan(WHISTLE_EARSHOT);
    expect(blasts[1].herds.herd).toBeLessThanOrEqual(AP_CATTLE_WHISTLE[1]);
    expect(ap.whistles).toEqual([2, 2]);
    expect(ofType(events, 'cattleCalm')).toEqual([]);
    expect(ofType(events, 'cattleScatter')).toEqual([{ type: 'cattleScatter', id: 'herd' }]);
  });

  it('holds its blast for a herd while another stands within earshot beyond the window, and eases through it instead', () => {
    // 300 m apart: when the first is in reach, the second would only get used to the whistle.
    const run = yRun({
      obstacles: [
        { id: 'near', kind: 'cattle', edge: 'e2', at: 300 },
        { id: 'far', kind: 'cattle', edge: 'e4', at: 100 },
      ],
      plan: plan({ cruise: 20 }),
    });
    const { s, ap } = start(run);
    const blasts: Blast[] = [];
    const events = drive(s, ap, run, 400, (st, ev) => recordBlast(run, st, ev, blasts));
    expect(s.phase, ap.note).toBe('won');
    expectNoneCalming(blasts);
    expect(ofType(events, 'cattleCalm')).toEqual([]);
    expect(ofType(events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'near', kind: 'cattle', severe: false }]);
    expect(ofType(events, 'cattleScatter')).toEqual([{ type: 'cattleScatter', id: 'far' }]);
  });

  it('leaves the blowing to a plan point just ahead that suits the herd: one blast, at the point', () => {
    const run = yRun({
      obstacles: [{ id: 'herd', kind: 'cattle', edge: 'e2', at: 300 }],
      plan: plan({ cruise: 20, whistles: [{ edge: 'e2', off: 130 }] }), // 170 m short of the herd
    });
    const { s, ap } = start(run);
    const blasts: Blast[] = [];
    const events = drive(s, ap, run, 400, (st, ev) => recordBlast(run, st, ev, blasts));
    expect(s.phase, ap.note).toBe('won');
    expect(blasts).toHaveLength(1);
    expect(blasts[0].herds.herd).toBeGreaterThan(169);
    expect(blasts[0].herds.herd).toBeLessThanOrEqual(170);
    expect(ofType(events, 'cattleScatter')).toEqual([{ type: 'cattleScatter', id: 'herd' }]);
    expect(ofType(events, 'obstacleHit')).toEqual([]);
  });

  it('holds at least a plan minimum speed from its point on', () => {
    const run = yRun({ plan: plan({ cruise: 10, minSpeeds: [{ from: { edge: 'e2', off: 0 }, speed: 14 }] }) });
    const { s, ap } = start(run);
    let before = 0;
    let slowest = Infinity;
    drive(s, ap, run, 400, (st) => {
      const f = frontHead(st.train.spans);
      if (f.edge === 'e1') before = Math.max(before, st.train.v);
      if (f.edge === 'e4' && f.off < 200) slowest = Math.min(slowest, st.train.v);
    });
    expect(s.phase, ap.note).toBe('won');
    expect(before).toBeLessThan(10.5);
    expect(slowest).toBeGreaterThanOrEqual(14);
  });

  it('eases through a barricade the Rider would call out', () => {
    const run = yRun({ obstacles: [{ id: 'bar', kind: 'barricade', edge: 'e2', at: 300 }], plan: plan({ cruise: 20 }) });
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 400);
    expect(s.phase, ap.note).toBe('won');
    expect(ofType(events, 'obstacleHit')).toEqual([{ type: 'obstacleHit', id: 'bar', kind: 'barricade', severe: false }]);
  });

  it('runs at a burning trestle fast enough, just after a curve at the same speed', () => {
    const run = yRun({
      curves: [{ id: 'c1', edge: 'e2', from: 0, to: 300, limit: 13.4 }],
      trestles: [{ id: 'devil', edge: 'e2', from: 320, to: 450, name: "Devil's Trestle", burning: { minSpeed: 13.4 } }],
      plan: plan({ cruise: 12 }), // no plan min speed: the trestle's own minimum is on the desk
    });
    const { s, ap } = start(run);
    const events = drive(s, ap, run, 400);
    expect(s.phase, `${s.loss?.detail ?? ''} ${ap.note}`).toBe('won');
    expect(ofType(events, 'trestleEnter')).toEqual([{ type: 'trestleEnter', id: 'devil', burning: true }]);
  });

  it('leaves the fire alone with a governor, and tends it without one', () => {
    const run = yRun();
    const governed = start(run, ['express'], ['governor']);
    const fire: string[] = [];
    drive(governed.s, governed.ap, run, 400, (_st, _ev, cmds) => fire.push(...cmds.filter((c) => c.kind === 'fire').map((c) => c.kind)));
    expect(governed.s.phase).toBe('won');
    expect(fire).toEqual([]);

    const plain = start(run, ['express', 'passenger', 'boxcar', 'armored']);
    let lowest = Infinity;
    drive(plain.s, plain.ap, run, 600, (st) => {
      if (st.tick > 30 * TICK_HZ) lowest = Math.min(lowest, st.train.pressure);
    });
    expect(plain.s.phase, plain.ap.note).toBe('won');
    expect(lowest).toBeGreaterThan(150);
  });

  it('keeps its hands off the levers while held up', () => {
    const run = yRun();
    const { s, ap } = start(run);
    drive(s, ap, run, 20);
    s.train.heldUp = true;
    const out = autopilotStep(ap, s, run);
    expect(out.cmds.filter((c) => c.kind !== 'whistle')).toEqual([]);
  });

  it('is plain JSON and deterministic', () => {
    const run = yRun({ waterTowers: [{ id: 'w1', edge: 'e2', at: 250 }], initialWater: 50, plan: plan({ stops: ['w1', 'dest'] }) });
    const a = start(run);
    const b = start(run);
    drive(a.s, a.ap, run, 120);
    const copy = JSON.parse(JSON.stringify(a.ap)) as AutopilotState;
    expect(copy).toEqual(a.ap);
    drive(b.s, b.ap, run, 120);
    expect(JSON.stringify(b.s)).toBe(JSON.stringify(a.s));
    expect(JSON.stringify(b.ap)).toBe(JSON.stringify(a.ap));
  });

  it('picks up its plan mid-run, as after a restored checkpoint', () => {
    // A ─a─ J1 ─b─ J2 ─c─ B, with a spur off each junction; the destination is up J2's spur.
    const run = baseRun({
      nodes: [
        { id: 'A', kind: 'end', x: 0, y: 0 },
        { id: 'J1', kind: 'junction', x: 10, y: 0 },
        { id: 'J2', kind: 'junction', x: 25, y: 0 },
        { id: 'B', kind: 'end', x: 35, y: 0 },
        { id: 'S1', kind: 'end', x: 13, y: 3 },
        { id: 'S2', kind: 'end', x: 28, y: 3 },
      ],
      edges: [
        { id: 'a', a: 'A', b: 'J1', length: 1000, kind: 'main', speedLimit: 25, terrain: 'desert' },
        { id: 'b', a: 'J1', b: 'J2', length: 1500, kind: 'main', speedLimit: 25, terrain: 'desert' },
        { id: 'c', a: 'J2', b: 'B', length: 1000, kind: 'main', speedLimit: 25, terrain: 'desert' },
        { id: 's1', a: 'J1', b: 'S1', length: 300, kind: 'spur', speedLimit: 10, terrain: 'desert' },
        { id: 's2', a: 'J2', b: 'S2', length: 400, kind: 'spur', speedLimit: 10, terrain: 'desert' },
      ],
      junctions: [
        { node: 'J1', trunk: 'a', normal: 'b', reverse: 's1', initial: 'reverse', name: 'J1' },
        { node: 'J2', trunk: 'b', normal: 'c', reverse: 's2', initial: 'normal', name: 'J2' },
      ],
      mainLine: ['a', 'b', 'c'],
      stations: [
        { id: 'orig', name: 'Origin', edge: 'a', at: 200, platform: 60, checkpoint: false },
        { id: 'mid', name: 'Mesa', edge: 'b', at: 1100, platform: 60, checkpoint: true },
        { id: 'dest', name: 'Quarry', edge: 's2', at: 300, platform: 60, checkpoint: false },
      ],
      waterTowers: [{ id: 'w1', edge: 'b', at: 200 }],
      start: { edge: 'a', off: 200, dir: 1 },
      contract: { ...yRun().contract, destination: 'dest' },
      plan: plan({ switches: [{ junction: 'J1', state: 'normal' }, { junction: 'J2', state: 'reverse' }], stops: ['w1', 'mid', 'dest'] }),
    });
    const { s } = start(run);
    // As restored: departing Mesa, its stop made, J1 long since set for the main line.
    s.switches.J1 = 'normal';
    s.train.spans = spansFromFront(netIndex(run), s.switches, { edge: 'b', off: 1100, dir: 1 }, s.train.length);
    s.train.stationStop = { stationId: 'mid', ticks: 480, done: true };
    s.train.lastStation = 'mid';
    s.tick = 600 * TICK_HZ;
    const ap = newAutopilot(run, s.variant);
    drive(s, ap, run, 300);
    expect(s.phase, ap.note).toBe('won');
  });

  it('does nothing once the run is over', () => {
    const run = yRun();
    const { s, ap } = start(run);
    s.phase = 'lost';
    expect(autopilotStep(ap, s, run)).toEqual({ cmds: [], lowerSpout: false });
  });

  it('never runs into the buffers when the plan leads nowhere', () => {
    const run = yRun({ plan: plan({ switches: [{ junction: 'J1', state: 'reverse' }], stops: [] }), contract: { ...yRun().contract, destination: 'dest' } });
    const { s, ap } = start(run);
    drive(s, ap, run, 300);
    expect(s.phase).toBe('running');
    expect(s.train.v).toBe(0);
    const stopShort = 600 - frontHead(s.train.spans).off;
    expect(stopShort).toBeGreaterThan(1);
    expect(stopShort).toBeLessThan(30);
  });
});

describe('the autopilot at the campaign’s cattle', () => {
  // Runs 3 and 6 put a herd on the line. The autopilot must get each off it with one blast begun
  // inside the scare window, never calming it first, wherever the plan's whistle point stands.
  const herdRuns = RUNS.filter((r) => r.obstacles.some((o) => o.kind === 'cattle'));

  it('finds herds in runs 3 and 6', () => {
    expect(herdRuns.map((r) => r.index + 1)).toEqual(expect.arrayContaining([3, 6]));
  });

  for (const run of herdRuns) {
    run.variants.forEach((variant, vi) => {
      it(`${run.index + 1}. ${run.name} (${variant}): one timed blast scatters the herd`, () => {
        realAspects.on = true;
        try {
          // Bandits off, as in the campaign test; the game loop proper, up to the last herd.
          const peaceful: RunDef = { ...run, waves: [] };
          const s = newGame(peaceful, { seed: vi, consist: composeConsist(peaceful, []), upgrades: [], assists: { rider: false, engineer: false } });
          expect(s.variant).toBe(variant);
          const ap = newAutopilot(peaceful, s.variant);
          const herds = s.obstacles.filter((o) => o.kind === 'cattle');
          const blasts: Blast[] = [];
          const scattered: Record<string, number> = {};
          const events: SimEvent[] = [];
          const onLine = (): boolean => herds.some((h) => h.state === 'present' || h.state === 'scattering');
          for (let k = 0; k < 15 * 60 * TICK_HZ && s.phase === 'running' && onLine(); k++) {
            const out = autopilotStep(ap, s, peaceful);
            if (out.lowerSpout) tryLowerSpout(s, peaceful, [], { force: true });
            const ev = step(s, peaceful, NO_INPUT, out.cmds.map((c) => ({ ...c, seq: ++seq }) as EngineerCmd));
            recordBlast(peaceful, s, ev, blasts);
            for (const e of ev) if (e.type === 'cattleScatter') scattered[e.id] = s.tick - 1;
            events.push(...ev);
          }
          expect(s.phase, s.loss ? `${s.loss.reason}: ${s.loss.detail}` : ap.note).not.toBe('lost');
          expectNoneCalming(blasts);
          expect(ofType(events, 'cattleCalm')).toEqual([]);
          expect(ofType(events, 'obstacleHit').filter((e) => e.kind === 'cattle')).toEqual([]);
          for (const h of herds) {
            expect(scattered[h.id], `${h.id} scattered`).toBeDefined();
            // The blasts it heard while on the line: one, begun inside the window, which scattered it
            // on reaching WHISTLE_SCARE_SECONDS.
            const heard = blasts.filter((b) => b.herds[h.id] !== undefined && b.tick <= scattered[h.id]);
            expect(heard, h.id).toHaveLength(1);
            expect(heard[0].herds[h.id]).toBeGreaterThanOrEqual(WHISTLE_SCARE_MIN);
            expect(heard[0].herds[h.id]).toBeLessThanOrEqual(WHISTLE_SCARE_MAX);
            expect(scattered[h.id] - heard[0].tick).toBe(secondsToTicks(WHISTLE_SCARE_SECONDS) - 1);
          }
        } finally {
          realAspects.on = false;
        }
      });
    });
  }
});
