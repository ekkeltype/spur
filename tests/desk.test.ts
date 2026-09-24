// The Engineer's desk (spec §11): the pure helpers behind its panels. The DOM and canvas code is
// exercised by hand and in screenshots through the harness (desk.html).

import { describe, expect, it } from 'vitest';
import { buildAhead, stopTarget } from '../src/render/desk/ahead';
import { describeEvent, type LogContext } from '../src/render/desk/events';
import { clockParts, formatClock, formatDistance, formatEta, formatMmSs, formatMoney, formatRemaining, junctionNumbers, toMph } from '../src/render/desk/format';
import {
  brakeFromFraction,
  brakeStep,
  brakeToFraction,
  brakeZone,
  CmdThrottle,
  notchThrottle,
  stepThrottle,
  THROTTLE_NOTCHES,
  throttleFromFraction,
  throttleNotch,
} from '../src/render/desk/levers';
import {
  chartM,
  chartT,
  chartX,
  chartY,
  crossings,
  findConflict,
  holdAdvice,
  lineAt,
  lineTimeAt,
  mainLength,
  mainRate,
  projectAhead,
  scheduleLine,
  sidingBands,
  TraceRecorder,
  type ChartFrame,
} from '../src/render/desk/marey';
import { netIndex, rearHead } from '../src/sim/network';
import type { AiTrainDef, RunDef, Span, SwitchState } from '../src/sim/types';
import { toEngineerRun } from '../src/sim/views';
import { loopRun, yRun } from './fixtures';

const sw = (run: RunDef, set: Record<string, SwitchState> = {}): Record<string, SwitchState> => {
  const out: Record<string, SwitchState> = {};
  for (const j of run.junctions) out[j.node] = j.initial;
  return { ...out, ...set };
};

// ---------------------------------------------------------------------------------------------
// Formatting (spec §0 note 6: mph, miles and a 12-hour clock)
// ---------------------------------------------------------------------------------------------

describe('clock and durations', () => {
  it('shows the game clock as h:mm AM/PM, floored to the minute', () => {
    expect(formatClock(9 * 3600)).toBe('9:00 AM');
    expect(formatClock(12 * 3600 + 5 * 60)).toBe('12:05 PM');
    expect(formatClock(0)).toBe('12:00 AM');
    expect(formatClock(13 * 3600 + 59 * 60 + 59.9)).toBe('1:59 PM');
    expect(formatClock(23 * 3600 + 59 * 60)).toBe('11:59 PM');
    expect(formatClock(25 * 3600)).toBe('1:00 AM'); // past midnight wraps
    expect(clockParts(14 * 3600 + 7 * 60)).toMatchObject({ hm: '2:07', ampm: 'PM' });
  });

  it('shows durations as m:ss (h:mm:ss past an hour)', () => {
    expect(formatMmSs(125)).toBe('2:05');
    expect(formatMmSs(0)).toBe('0:00');
    expect(formatMmSs(59.9)).toBe('0:59');
    expect(formatMmSs(3725)).toBe('1:02:05');
  });

  it('shows the time left before a deadline, or how late the train is', () => {
    expect(formatRemaining(612)).toEqual({ text: '10:12 left', overdue: false });
    expect(formatRemaining(0)).toEqual({ text: '0:00 left', overdue: false });
    expect(formatRemaining(-185)).toEqual({ text: '3:05 late', overdue: true });
  });

  it('formats money', () => {
    expect(formatMoney(1250)).toBe('$1,250');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-50)).toBe('−$50');
  });
});

describe('distances, speeds and ETAs', () => {
  it('shows metres below a kilometre and miles above', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(12.4)).toBe('12 m');
    expect(formatDistance(-12)).toBe('−12 m');
    expect(formatDistance(1609.34 * 1.46)).toBe('1.5 mi');
    expect(formatDistance(1609.34 * 12.3)).toBe('12 mi');
  });

  it('converts m/s to mph', () => {
    expect(toMph(10)).toBeCloseTo(22.3694, 3);
  });

  it('gives the time to reach something at the current speed', () => {
    expect(formatEta(100, 20)).toBe('5 s');
    expect(formatEta(1500, 20)).toBe('1:15');
    expect(formatEta(20000, 20)).toBe('17 min');
    expect(formatEta(0, 10)).toBe('now');
    expect(formatEta(5, 20)).toBe('now');
    expect(formatEta(100, 0)).toBe('—'); // standing
    expect(formatEta(100, -5)).toBe('—'); // moving away
  });
});

describe('switch numbers', () => {
  it('numbers the junctions 1..n from left to right on the map', () => {
    const run = loopRun();
    run.nodes = run.nodes.map((n) => (n.id === 'P' ? { ...n, x: 30 } : n)); // P now right of Q (x 14)
    const nums = junctionNumbers(run);
    expect(nums.get('Q')).toBe(1);
    expect(nums.get('P')).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Levers (spec §5.2, §11)
// ---------------------------------------------------------------------------------------------

describe('throttle notches', () => {
  it('maps the throttle to 8 notches above closed', () => {
    expect(THROTTLE_NOTCHES).toBe(8);
    expect(throttleNotch(0)).toBe(0);
    expect(throttleNotch(1)).toBe(8);
    expect(throttleNotch(0.5)).toBe(4);
    expect(throttleNotch(0.06)).toBe(0);
    expect(throttleNotch(0.07)).toBe(1);
    expect(notchThrottle(3)).toBe(0.375);
    expect(notchThrottle(9)).toBe(1);
    expect(notchThrottle(-1)).toBe(0);
  });

  it('steps a notch at a time from wherever the lever is', () => {
    expect(stepThrottle(0.375, 1)).toBe(0.5);
    expect(stepThrottle(1, 1)).toBe(1);
    expect(stepThrottle(0, -1)).toBe(0);
    expect(stepThrottle(0.3, 1)).toBe(0.375); // 0.3 sits at notch 2
  });

  it('snaps a drag along the quadrant to the nearest notch', () => {
    expect(throttleFromFraction(0)).toBe(0);
    expect(throttleFromFraction(1)).toBe(1);
    expect(throttleFromFraction(0.55)).toBe(0.5);
    expect(throttleFromFraction(0.57)).toBe(0.625);
    expect(throttleFromFraction(-0.2)).toBe(0);
    expect(throttleFromFraction(1.3)).toBe(1);
  });
});

describe('brake positions', () => {
  it('names the zones: release, service up to EMERGENCY_BRAKE, emergency above it', () => {
    expect(brakeZone(0)).toBe('release');
    expect(brakeZone(0.01)).toBe('service');
    expect(brakeZone(0.85)).toBe('service');
    expect(brakeZone(0.86)).toBe('emergency');
    expect(brakeZone(1)).toBe('emergency');
  });

  it('steps through release, five service steps and emergency', () => {
    expect(brakeStep(0, 1)).toBe(0.17);
    expect(brakeStep(0.34, 1)).toBe(0.51);
    expect(brakeStep(0.4, 1)).toBe(0.51);
    expect(brakeStep(0.4, -1)).toBe(0.34);
    expect(brakeStep(0.85, 1)).toBe(1);
    expect(brakeStep(1, 1)).toBe(1);
    expect(brakeStep(1, -1)).toBe(0.85);
    expect(brakeStep(0, -1)).toBe(0);
  });

  it('maps a drag along the quadrant with detents at release, full service and emergency', () => {
    expect(brakeFromFraction(0.02)).toBe(0);
    expect(brakeFromFraction(0.5)).toBeGreaterThan(0.3);
    expect(brakeFromFraction(0.5)).toBeLessThan(0.7);
    expect(brakeFromFraction(0.81)).toBe(0.85);
    expect(brakeFromFraction(0.95)).toBe(1);
    expect(brakeFromFraction(1.5)).toBe(1);
    for (const v of [0, 0.17, 0.4, 0.6, 0.85, 1]) expect(brakeFromFraction(brakeToFraction(v))).toBeCloseTo(v, 2);
  });
});

describe('the lever command throttle (spec §16.1: at most one per 50 ms, the last value wins)', () => {
  it('sends the first value at once and defers the rest, keeping only the latest', () => {
    const t = new CmdThrottle(50);
    expect(t.offer(0.5, 1000)).toBe(0.5);
    expect(t.offer(0.6, 1010)).toBeNull();
    expect(t.offer(0.7, 1020)).toBeNull();
    expect(t.dueAt()).toBe(1050);
    expect(t.poll(1040)).toBeNull();
    expect(t.poll(1050)).toBe(0.7);
    expect(t.poll(1100)).toBeNull();
  });

  it('always sends the final value of a gesture', () => {
    const t = new CmdThrottle(50);
    expect(t.offer(0.1, 2000)).toBe(0.1);
    expect(t.offer(0.3, 2010)).toBeNull(); // the drag ends here
    expect(t.poll(2049)).toBeNull();
    expect(t.poll(2050)).toBe(0.3);
  });

  it("doesn't repeat an unchanged value, except in a new gesture", () => {
    const t = new CmdThrottle(50);
    t.offer(0.7, 1000);
    expect(t.offer(0.7, 1200)).toBeNull();
    t.reset();
    expect(t.offer(0.7, 1210)).toBe(0.7);
  });

  it('drops a deferred value when the lever returns to what was sent', () => {
    const t = new CmdThrottle(50);
    t.offer(0.7, 1000);
    expect(t.offer(0.2, 1020)).toBeNull();
    expect(t.offer(0.7, 1030)).toBeNull();
    expect(t.dueAt()).toBeNull();
    expect(t.poll(1100)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The Ahead list (spec §11): the next items along the current route, following the switches
// ---------------------------------------------------------------------------------------------

// The loop network with one of everything:
//   m1 (0..1000): station orig 300, tunnel 500–700, low bridge 800, signals 950 (+1) and 960 (−1)
//   m2 (P→Q, 400): curve 100–300 at 10 m/s          s1 (P→Q siding, 400)
//   m3 (Q→E, 1000): water tower 200, trestle 400–500 (burning), station dest 900
function featureRun(): RunDef {
  return loopRun({
    tunnels: [{ id: 't1', edge: 'm1', from: 500, to: 700, name: 'Juniper Tunnel' }],
    lowBridges: [{ id: 'b1', edge: 'm1', at: 800 }],
    signals: [
      { id: 'g1', edge: 'm1', at: 950, facing: 1, kind: 'junction', junction: 'P' },
      { id: 'g2', edge: 'm1', at: 960, facing: -1, kind: 'block' },
    ],
    curves: [{ id: 'c1', edge: 'm2', from: 100, to: 300, limit: 10 }],
    waterTowers: [{ id: 'w1', edge: 'm3', at: 200 }],
    trestles: [{ id: 'r1', edge: 'm3', from: 400, to: 500, name: 'Sage Creek Trestle', burning: { minSpeed: 13 } }],
  });
}

describe('buildAhead', () => {
  const run = featureRun();
  const ix = netIndex(run);

  it('lists what comes next from the loco, in order, with distances', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 300, dir: 1 }, { max: 20, destination: 'dest' });
    expect(items.map((i) => [i.kind, i.id, Math.round(i.dist)])).toEqual([
      ['tunnel', 't1', 200],
      ['lowBridge', 'b1', 500],
      ['signal', 'g1', 650], // g2 faces the other way: it doesn't govern this train
      ['junction', 'P', 700],
      ['curve', 'c1', 800],
      ['junction', 'Q', 1100],
      ['water', 'w1', 1300],
      ['trestle', 'r1', 1500],
      ['station', 'dest', 2000],
      ['end', 'E', 2100],
    ]);
    expect(items[0]).toMatchObject({ name: 'Juniper Tunnel', length: 200 });
    expect(items[4]).toMatchObject({ limit: 10, length: 200 });
    expect(items[7]).toMatchObject({ minSpeed: 13 });
    expect(items[8]).toMatchObject({ name: 'Destination', destination: true });
  });

  it('shows how each junction is set: facing moves take the set leg, trailing ones pass to the trunk', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 300, dir: 1 }, { max: 20 });
    expect(items.find((i) => i.id === 'P')?.junction).toEqual({ state: 'normal', facing: true, leg: 'm2', against: false });
    expect(items.find((i) => i.id === 'Q')?.junction).toEqual({ state: 'normal', facing: false, leg: 'm3', against: false });
  });

  it('follows the switches: with the loop switch reversed the route takes the siding', () => {
    const items = buildAhead(ix, sw(run, { P: 'reverse' }), { edge: 'm1', off: 300, dir: 1 }, { max: 20 });
    expect(items.some((i) => i.id === 'c1')).toBe(false); // the curve is on the main track
    expect(items.find((i) => i.id === 'P')?.junction).toEqual({ state: 'reverse', facing: true, leg: 's1', against: false });
    // Leaving the siding through Q set for the main: a trailing move against the switch (it springs over).
    expect(items.find((i) => i.id === 'Q')?.junction).toEqual({ state: 'normal', facing: false, leg: 'm3', against: true });
  });

  it('keeps the nearest items only', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 300, dir: 1 });
    expect(items).toHaveLength(6);
    expect(items[5].id).toBe('Q');
  });

  it("marks what the leading end is already inside, with the distance until it's out", () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 620, dir: 1 }, { max: 3 });
    expect(items[0]).toMatchObject({ kind: 'tunnel', dist: 0 });
    expect(items[0].until).toBeCloseTo(80, 6);
  });

  it('measures water towers to the tender hatch', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm3', off: 0, dir: 1 }, { hatchBack: 23 });
    expect(items.find((i) => i.kind === 'water')).toMatchObject({ dist: 223, hatch: true });
  });

  it('includes the Rider’s flags on the route', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 300, dir: 1 }, { flags: [{ id: 7, point: { edge: 'm1', off: 450 }, tick: 0 }] });
    expect(items[0]).toMatchObject({ kind: 'flag', id: '7', dist: 150 });
  });

  it('walks backward from the rear when reversing, to the end of the track', () => {
    const spans: Span[] = [{ edge: 'm1', from: 400, to: 600 }];
    const items = buildAhead(ix, sw(run), rearHead(spans), { max: 10 });
    expect(items.map((i) => [i.kind, i.id, Math.round(i.dist)])).toEqual([
      ['station', 'orig', 100],
      ['end', 'W', 400],
    ]);
  });

  it('stops looking at the range', () => {
    const items = buildAhead(ix, sw(run), { edge: 'm1', off: 300, dir: 1 }, { range: 400 });
    expect(items.map((i) => i.id)).toEqual(['t1']);
  });

  it('skips facing junctions onto a spur and reports the end of track there', () => {
    const y = yRun();
    const iy = netIndex(y);
    const items = buildAhead(iy, sw(y, { J1: 'reverse' }), { edge: 'e1', off: 900, dir: 1 });
    expect(items.map((i) => [i.kind, i.id, Math.round(i.dist)])).toEqual([
      ['junction', 'J1', 100],
      ['end', 'S', 700],
    ]);
  });
});

describe('stopTarget (the precision-stop readout)', () => {
  const run = loopRun({ waterTowers: [{ id: 'w1', edge: 'm1', at: 330 }] });
  const ix = netIndex(run);

  it('measures from the loco front to a station stop mark ahead', () => {
    // A 140 m train with its front at m1 290: the stop mark (300) is 10 m ahead.
    const spans: Span[] = [{ edge: 'm1', from: 150, to: 290 }];
    const t = stopTarget(ix, sw(run), spans, { edge: 'm1', off: 267 });
    expect(t).toMatchObject({ kind: 'station', id: 'orig', window: 15 });
    expect(t?.dist).toBeCloseTo(10, 6);
  });

  it('goes negative past the mark', () => {
    const spans: Span[] = [{ edge: 'm1', from: 180, to: 320 }];
    const t = stopTarget(ix, sw(run), spans, { edge: 'm1', off: 297 }, { kinds: ['station'] });
    expect(t?.dist).toBeCloseTo(-20, 6);
  });

  it('measures from the tender hatch to a water spout', () => {
    const spans: Span[] = [{ edge: 'm1', from: 150, to: 290 }];
    // The hatch is 23 m behind the front (m1 267); the spout (330) is 40 m past the front: 63 m.
    const t = stopTarget(ix, sw(run), spans, { edge: 'm1', off: 267 }, { kinds: ['water'] });
    expect(t).toMatchObject({ kind: 'water', id: 'w1', window: 3 });
    expect(t?.dist).toBeCloseTo(63, 6);
    // The front has passed the spout but the hatch hasn't reached it yet.
    const on: Span[] = [{ edge: 'm1', from: 200, to: 340 }];
    expect(stopTarget(ix, sw(run), on, { edge: 'm1', off: 317 }, { kinds: ['water'] })?.dist).toBeCloseTo(13, 6);
  });

  it('picks the nearest target, and nothing when none is in reach', () => {
    const spans: Span[] = [{ edge: 'm1', from: 150, to: 290 }];
    expect(stopTarget(ix, sw(run), spans, { edge: 'm1', off: 267 })?.kind).toBe('station');
    const far: Span[] = [{ edge: 'm3', from: 0, to: 100 }];
    expect(stopTarget(ix, sw(run), far, { edge: 'm3', off: 77 }, { ahead: 300 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The timetable (Marey) chart (spec §11)
// ---------------------------------------------------------------------------------------------

// No. 7 runs west on the loop network's main line (m3 → m2 → m1), with a 30 s stop at route 500 m.
const freight: AiTrainDef = {
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
  depart: 1000,
  speed: 10,
  stops: [{ at: 500, dwell: 30 }],
  charted: true,
};

describe('chart coordinates', () => {
  const f: ChartFrame = { x0: 100, x1: 700, y0: 20, y1: 320, t0: 1000, t1: 1600, m0: 0, m1: 3000 };

  it('maps clock to x and main-line distance to y (0 at the top), and back', () => {
    expect(chartX(f, 1000)).toBe(100);
    expect(chartX(f, 1300)).toBe(400);
    expect(chartY(f, 0)).toBe(20);
    expect(chartY(f, 1500)).toBe(170);
    expect(chartT(f, 400)).toBe(1300);
    expect(chartM(f, 170)).toBe(1500);
  });

  it('measures the main line', () => {
    expect(mainLength(loopRun())).toBe(2400);
  });
});

describe('scheduleLine', () => {
  const run = loopRun({ aiTrains: [freight] });
  const ix = netIndex(run);

  it('plots a scheduled train by its breakpoints: legs, stops and the end of its route', () => {
    expect(scheduleLine(ix, freight, 900, 2000)).toEqual([
      { t: 1000, m: 2400 },
      { t: 1050, m: 1900 },
      { t: 1080, m: 1900 },
      { t: 1130, m: 1400 },
      { t: 1170, m: 1000 },
      { t: 1270, m: 0 },
    ]);
  });

  it('clips to the chart’s time range', () => {
    const line = scheduleLine(ix, freight, 1040, 1200);
    expect(line[0]).toEqual({ t: 1040, m: 2000 });
    expect(line[line.length - 1]).toEqual({ t: 1200, m: 700 });
  });
});

describe('reading a line', () => {
  const pts = [
    { t: 0, m: 100 },
    { t: 10, m: 200 },
    { t: 20, m: 200 },
    { t: 30, m: null },
    { t: 40, m: 500 },
  ];

  it('interpolates main-line distance at a clock, and knows where a line is broken', () => {
    expect(lineAt(pts, 5)).toBe(150);
    expect(lineAt(pts, 15)).toBe(200);
    expect(lineAt(pts, 25)).toBeNull(); // off the main line
    expect(lineAt(pts, 50)).toBeNull(); // off the chart
  });

  it('finds when a line first reaches a distance, optionally after a time', () => {
    expect(lineTimeAt(pts, 150)).toBe(5);
    expect(lineTimeAt(pts, 200)).toBe(10);
    expect(lineTimeAt(pts, 200, 12)).toBe(12); // still there while it dwells
    expect(lineTimeAt(pts, 300)).toBeNull();
  });
});

describe('conflicts', () => {
  const run = loopRun({ aiTrains: [freight] });
  const ix = netIndex(run);
  const er = toEngineerRun(run);
  const bands = sidingBands(er);
  const lines = [{ id: 'f7', pts: scheduleLine(ix, freight, 900, 2000) }];

  it('finds the passing sidings as bands on the main line', () => {
    expect(bands).toEqual([{ edge: 's1', lo: 1000, hi: 1400, name: 'Origin siding' }]);
  });

  it('projects the train along the main line at its current speed', () => {
    expect(mainRate(ix, { edge: 'm1', off: 10, dir: 1 }, 10)).toBe(10);
    expect(mainRate(ix, { edge: 'm1', off: 10, dir: -1 }, 10)).toBe(-10);
    const p = projectAhead(1000, 0, 10, 2000, 2400);
    expect(p).toEqual({ t0: 1000, m0: 0, rate: 10, t1: 1240, m1: 2400 }); // stops at the end of the main line
  });

  it('finds the first crossing of the projection with a scheduled train', () => {
    // Running east at 10 m/s from mile 1500 at 1000: No. 7 is met at 1045, 1950 m (outside the loop).
    const c = findConflict(projectAhead(1000, 1500, 10, 2000, 2400), lines, bands);
    expect(c?.train).toBe('f7');
    expect(c?.t).toBeCloseTo(1045, 6);
    expect(c?.m).toBeCloseTo(1950, 6);
  });

  it('ignores a meet inside a siding band', () => {
    // From 0 m at 1000: the lines cross at 1135, 1350 m, inside the loop.
    const p = projectAhead(1000, 0, 10, 2000, 2400);
    expect(findConflict(p, lines, bands)).toBeNull();
    const all = crossings(p, lines, bands);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ train: 'f7', safe: true });
    expect(all[0].t).toBeCloseTo(1135, 6);
  });

  it('counts a band as safe only when the route takes the siding, when told the route', () => {
    const p = projectAhead(1000, 0, 10, 2000, 2400);
    expect(findConflict(p, lines, bands, (b) => b.edge === 's1')).toBeNull();
    const c = findConflict(p, lines, bands, () => false);
    expect(c?.t).toBeCloseTo(1135, 6);
  });

  it('warns a train standing on the main line, but not one standing in the siding', () => {
    expect(findConflict(projectAhead(1000, 1200, 0, 2000, 2400), lines, bands)).toBeNull();
    const c = findConflict(projectAhead(1000, 500, 0, 2000, 2400), lines, bands);
    expect(c?.t).toBeCloseTo(1220, 6);
    expect(c?.m).toBeCloseTo(500, 6);
  });

  it('advises where to hold for the assist: the siding before the meet, until the train has passed', () => {
    const p = projectAhead(1000, 600, 10, 2000, 2400);
    const c = findConflict(p, lines, bands, () => false);
    expect(c).not.toBeNull();
    const a = holdAdvice(c!, p, bands, lines, [freight], null);
    // No. 7's front leaves the loop (1000 m) at 1170; its 150 m take 15 s more to clear.
    expect(a).toMatchObject({ where: 'ahead', band: bands[0], train: 'f7' });
    expect(a?.until).toBeCloseTo(1185, 6);
    // Already standing in the siding: hold here.
    const here = holdAdvice(c!, projectAhead(1000, 1200, 0, 2000, 2400), bands, lines, [freight], 's1');
    expect(here?.where).toBe('here');
    // Past the loop, running into No. 7: back into it.
    const past = projectAhead(1000, 1500, 10, 2000, 2400);
    const c2 = findConflict(past, lines, bands)!;
    expect(holdAdvice(c2, past, bands, lines, [freight], null)?.where).toBe('behind');
    // No siding anywhere: no advice.
    expect(holdAdvice(c2, past, [], lines, [freight], null)).toBeNull();
  });
});

describe('TraceRecorder (the player’s line on the chart)', () => {
  it('keeps a point per second or per few metres, breaks off the main line, and restarts when the clock goes back', () => {
    const r = new TraceRecorder(1, 3);
    r.add(100, 0);
    r.add(100.2, 1); // too soon and too close
    r.add(100.4, 5); // moved enough
    r.add(101.5, 5.5); // a second later
    expect(r.pts.map((p) => p.t)).toEqual([100, 100.4, 101.5]);
    r.add(102, null);
    r.add(103, null); // one break is enough
    r.add(104, 20);
    expect(r.pts.map((p) => p.m)).toEqual([0, 5, 5.5, null, 20]);
    r.add(50, 0); // a restart from a checkpoint
    expect(r.pts).toEqual([{ t: 50, m: 0 }]);
  });

  it('thins its oldest half rather than grow without end', () => {
    const r = new TraceRecorder(1, 3, 100);
    for (let t = 0; t < 400; t++) r.add(t, t * 10);
    expect(r.pts.length).toBeLessThanOrEqual(100);
    expect(r.pts[0]).toEqual({ t: 0, m: 0 }); // the start of the run is kept
    expect(r.pts[r.pts.length - 1]).toEqual({ t: 399, m: 3990 });
  });
});

// ---------------------------------------------------------------------------------------------
// The log (spec §16.3 events)
// ---------------------------------------------------------------------------------------------

describe('describeEvent', () => {
  const ctx: LogContext = {
    stationName: (id) => ({ orig: 'Juniper', dest: 'Coyote Bend' })[id] ?? id,
    switchLabel: (id) => `Switch ${id === 'P' ? 1 : 2} (${id === 'P' ? 'West loop' : 'East loop'})`,
    tunnelName: () => 'Juniper Tunnel',
    signalName: () => 'Signal',
    cargo: 'Mail',
    flagDist: 420,
  };

  it('describes switches, including the ones a trailing train springs over', () => {
    expect(describeEvent({ type: 'switchThrown', junction: 'P', state: 'reverse', by: 'engineer' }, ctx)).toMatchObject({
      text: 'Switch 1 (West loop) set to reverse',
      tone: 'info',
    });
    expect(describeEvent({ type: 'switchThrown', junction: 'Q', state: 'normal', by: 'trailing' }, ctx)?.text).toBe(
      'Switch 2 (East loop) sprung to normal by the train',
    );
  });

  it('describes stations, fines, telegrams and the hold-up', () => {
    expect(describeEvent({ type: 'stationArrived', stationId: 'orig' }, ctx)?.text).toBe('Standing at Juniper');
    expect(describeEvent({ type: 'fine', reason: 'redSignal', amount: 50 }, ctx)).toMatchObject({ text: 'Fined $50: passed a signal at stop', tone: 'danger' });
    expect(describeEvent({ type: 'telegram', id: 't', text: 'MEET NO 7 AT MESA' }, ctx)).toMatchObject({ text: 'MEET NO 7 AT MESA', tone: 'telegram' });
    expect(describeEvent({ type: 'heldUp' }, ctx)?.tone).toBe('danger');
    expect(describeEvent({ type: 'lost', reason: 'derailed', detail: '' }, ctx)?.text).toBe('Derailed');
  });

  it('says how far ahead the Rider flagged something', () => {
    expect(describeEvent({ type: 'flagPlaced', flag: { id: 1, point: { edge: 'm1', off: 0 }, tick: 0 } }, ctx)?.text).toBe(
      'The Rider flagged the line 420 m ahead',
    );
  });

  it('leaves out what the desk shows elsewhere', () => {
    expect(describeEvent({ type: 'whistle', on: false }, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Styles: the desk lives inside the app's page, so its stylesheet and the app's must not overlap.
// (The app's global .hint rule once turned the map's heading hint into a floating cream box.)
// ---------------------------------------------------------------------------------------------

/** The bits of node:fs these checks use (the repo has no Node typings; Vitest leaves CSS imports empty). */
interface Fs {
  readFileSync(path: URL, encoding: 'utf8'): string;
  readdirSync(path: URL, options: { recursive: true }): string[];
}

describe('the desk stylesheet', async () => {
  const fs = (await import(/* @vite-ignore */ ['node', 'fs'].join(':'))) as Fs;
  const src = new URL('../src/', import.meta.url);
  const sheets: Record<string, string> = {};
  for (const f of fs.readdirSync(src, { recursive: true })) {
    const path = f.replace(/\\/g, '/');
    if (path.endsWith('.css')) sheets[path] = fs.readFileSync(new URL(path, src), 'utf8');
  }
  const DESK = 'render/desk/desk.css';

  /** Each style rule's selectors (at-rule preludes and keyframe steps left out). */
  const selectors = (css: string): string[] =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim())
      .filter((head) => !head.startsWith('@') && !/^(?:from|to|[\d.]+%)(?:\s*,\s*(?:from|to|[\d.]+%))*$/.test(head))
      .flatMap((head) => head.split(',').map((s) => s.trim()));
  const classes = (css: string): Set<string> => new Set(selectors(css).flatMap((s) => [...s.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1])));

  it('is found', () => {
    expect(sheets[DESK]).toContain('.desk');
  });

  it('scopes every rule under the desk’s root, so nothing leaks into the app', () => {
    const unscoped = selectors(sheets[DESK]).filter((s) => !/^\.desk(?![\w-])/.test(s));
    expect(unscoped).toEqual([]);
  });

  it('shares no class name with the app’s stylesheets, so the app’s rules can’t reach into the desk', () => {
    const desk = classes(sheets[DESK]);
    const shared: string[] = [];
    for (const [path, css] of Object.entries(sheets)) {
      if (path === DESK) continue;
      for (const c of classes(css)) if (desk.has(c) && c !== 'desk') shared.push(`${c} (${path})`);
    }
    expect(shared).toEqual([]);
  });
});
