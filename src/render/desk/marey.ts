// The timetable chart's math (spec §11): Marey's train graph with the clock across and main-line
// distance down. Scheduled trains are exact polylines from their timetables (spec §10.1), the
// player's train is a recorded trace plus a straight projection at the current speed, and a
// conflict is the first crossing of that projection with a scheduled train outside a passing
// siding. Pure: no DOM.

import { edgeOf, mainPos, netIndex, type AnyRun, type NetIndex } from '../../sim/network';
import { routeDistanceAt, routeLength, routeMainPos, timeAtRouteDistance } from '../../sim/schedule';
import type { AiTrainDef, TrackHead } from '../../sim/types';

const EPS = 1e-9;

// ---- Coordinates ---------------------------------------------------------------------------------

/** The plot area in px and what it spans: clock t0..t1 across, main-line distance m0 (top) .. m1 (bottom). */
export interface ChartFrame {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  t0: number;
  t1: number;
  m0: number;
  m1: number;
}

export const chartX = (f: ChartFrame, t: number): number => f.x0 + ((t - f.t0) / (f.t1 - f.t0)) * (f.x1 - f.x0);
export const chartY = (f: ChartFrame, m: number): number => f.y0 + ((m - f.m0) / (f.m1 - f.m0)) * (f.y1 - f.y0);
export const chartT = (f: ChartFrame, x: number): number => f.t0 + ((x - f.x0) / (f.x1 - f.x0)) * (f.t1 - f.t0);
export const chartM = (f: ChartFrame, y: number): number => f.m0 + ((y - f.y0) / (f.y1 - f.y0)) * (f.m1 - f.m0);

/** The main line's length (spec §4.4): the chart's vertical extent. */
export function mainLength(run: AnyRun): number {
  const edges = new Map(run.edges.map((e) => [e.id, e]));
  let max = 0;
  let sum = 0;
  for (const id of run.mainLine) {
    const e = edges.get(id);
    if (!e) continue;
    sum += e.length;
    if (e.mainAt) max = Math.max(max, e.mainAt[0], e.mainAt[1]);
  }
  return max > 0 ? max : sum;
}

// ---- Lines ---------------------------------------------------------------------------------------

/** A point on a chart line; m = null breaks the line (off the main line). */
export interface LinePt {
  t: number;
  m: number | null;
}

export interface ChartLine {
  id: string;
  pts: LinePt[];
}

/**
 * A scheduled train's front on the chart between clocks t0 and t1. Its route distance is linear in
 * time between departures, stops and leg ends, and main-line distance is linear along each edge, so
 * the polyline through those breakpoints is exact.
 */
export function scheduleLine(ix: NetIndex, def: AiTrainDef, t0: number, t1: number): LinePt[] {
  if (def.route.length === 0) return [];
  const total = routeLength(ix, def);
  const tEnd = timeAtRouteDistance(def, total);
  const lo = Math.max(t0, def.depart);
  const hi = Math.min(t1, tEnd);
  if (hi - lo <= EPS) return [];
  const times = [lo, hi];
  let d = 0;
  for (const leg of def.route) {
    d += edgeOf(ix, leg.edge).length;
    times.push(timeAtRouteDistance(def, d));
  }
  for (const s of def.stops) {
    const arrive = timeAtRouteDistance(def, s.at);
    times.push(arrive, arrive + s.dwell);
  }
  const ts = [...new Set(times.filter((t) => t >= lo - EPS && t <= hi + EPS))].sort((a, b) => a - b);
  return ts.map((t) => ({ t, m: routeMainPos(ix, def, Math.max(0, Math.min(total, routeDistanceAt(def, t)))) }));
}

/** Main-line distance on a line at clock t (linear between points), or null if it isn't on the chart then. */
export function lineAt(pts: readonly LinePt[], t: number): number | null {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (t < a.t - EPS || t > b.t + EPS) continue;
    if (a.m === null || b.m === null) return null;
    const span = b.t - a.t;
    return span <= EPS ? b.m : a.m + ((b.m - a.m) * (t - a.t)) / span;
  }
  return pts.length === 1 && Math.abs(pts[0].t - t) <= EPS ? pts[0].m : null;
}

/** When a line first reaches main-line distance m at or after `after`, or null. */
export function lineTimeAt(pts: readonly LinePt[], m: number, after = -Infinity): number | null {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.m === null || b.m === null || b.t < after) continue;
    const lo = Math.min(a.m, b.m);
    const hi = Math.max(a.m, b.m);
    if (m < lo - EPS || m > hi + EPS) continue;
    // Standing still there (a dwell), it's there from whenever we start looking.
    const flat = Math.abs(b.m - a.m) <= EPS;
    const t = flat ? Math.max(a.t, after) : a.t + ((m - a.m) / (b.m - a.m)) * (b.t - a.t);
    if (t > b.t + EPS) continue;
    if (t >= after - EPS) return Math.max(t, after);
  }
  return null;
}

// ---- Passing sidings -------------------------------------------------------------------------------

/** A siding or spur's stretch of the main line (spec §4.4): trains can pass each other there. */
export interface Band {
  edge: string;
  lo: number;
  hi: number;
  name: string;
}

/** Within this distance a siding is named after a station. */
const NAME_REACH = 1600;

export function sidingBands(run: AnyRun): Band[] {
  const ix = netIndex(run);
  const stations = run.stations
    .map((s) => ({ name: s.name, m: mainPos(ix, { edge: s.edge, off: s.at }) }))
    .filter((s): s is { name: string; m: number } => s.m !== null);
  const bands: Band[] = [];
  for (const e of run.edges) {
    if ((e.kind !== 'siding' && e.kind !== 'spur') || !e.mainAt) continue;
    const lo = Math.min(e.mainAt[0], e.mainAt[1]);
    const hi = Math.max(e.mainAt[0], e.mainAt[1]);
    let name = e.name;
    if (!name) {
      const mid = (lo + hi) / 2;
      const near = stations.reduce<{ name: string; m: number } | null>((b, s) => (!b || Math.abs(s.m - mid) < Math.abs(b.m - mid) ? s : b), null);
      name = near && Math.abs(near.m - mid) <= NAME_REACH ? `${near.name} ${e.kind}` : e.kind === 'spur' ? 'Spur' : 'Siding';
    }
    bands.push({ edge: e.id, lo, hi, name });
  }
  return bands.sort((a, b) => a.lo - b.lo);
}

// ---- The player's projection and conflicts ---------------------------------------------------------

/** How fast the loco's front moves along the main line (m/s of main-line distance), or null off it. */
export function mainRate(ix: NetIndex, head: TrackHead, v: number): number | null {
  const e = ix.edge.get(head.edge);
  if (!e?.mainAt || e.length <= 0) return null;
  return (v * head.dir * (e.mainAt[1] - e.mainAt[0])) / e.length;
}

/** A straight line from (t0, m0) at `rate`, until tEnd or the end of the main line. */
export interface Projection {
  t0: number;
  m0: number;
  rate: number;
  t1: number;
  m1: number;
}

export function projectAhead(t0: number, m0: number, rate: number, tEnd: number, mMax: number): Projection {
  let t1 = Math.max(t0, tEnd);
  if (rate > EPS) t1 = Math.min(t1, t0 + (mMax - m0) / rate);
  else if (rate < -EPS) t1 = Math.min(t1, t0 + (0 - m0) / rate);
  t1 = Math.max(t0, t1);
  return { t0, m0, rate, t1, m1: m0 + rate * (t1 - t0) };
}

export interface Crossing {
  t: number;
  m: number;
  train: string;
  /** Inside a passing siding the route takes: a meet, not a collision. */
  safe: boolean;
  band: Band | null;
}

/**
 * Every crossing of the projection with the scheduled trains' lines, earliest first. One inside a
 * siding band is safe if `bandSafe` says so (by default any band, as the spec draws it; the desk
 * passes "the route ahead takes that siding").
 */
export function crossings(p: Projection, lines: readonly ChartLine[], bands: readonly Band[], bandSafe: (b: Band) => boolean = () => true): Crossing[] {
  const out: Crossing[] = [];
  const pm = (t: number): number => p.m0 + p.rate * (t - p.t0);
  for (const line of lines) {
    const pts = line.pts;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (a.m === null || b.m === null) continue;
      const ta = Math.max(a.t, p.t0);
      const tb = Math.min(b.t, p.t1);
      if (tb < ta - EPS) continue;
      const span = b.t - a.t;
      const lm = (t: number): number => (span <= EPS ? b.m! : a.m! + ((b.m! - a.m!) * (t - a.t)) / span);
      const fa = lm(ta) - pm(ta);
      const fb = lm(tb) - pm(tb);
      let t: number | null = null;
      if (Math.abs(fa) <= 1e-6) t = ta;
      else if (fa * fb < 0 || Math.abs(fb) <= 1e-6) t = ta + (fa / (fa - fb)) * (tb - ta);
      if (t === null) continue;
      // A touch at the very end of a segment is found again at the start of the next one.
      if (out.length > 0 && out[out.length - 1].train === line.id && Math.abs(out[out.length - 1].t - t) < 1e-6) continue;
      const m = pm(t);
      const band = bands.find((bd) => m >= bd.lo - EPS && m <= bd.hi + EPS) ?? null;
      out.push({ t, m, train: line.id, safe: band !== null && bandSafe(band), band });
    }
  }
  return out.sort((x, y) => x.t - y.t);
}

/** The first crossing that isn't a safe meet (spec §11: marked in red), or null. */
export function findConflict(p: Projection, lines: readonly ChartLine[], bands: readonly Band[], bandSafe?: (b: Band) => boolean): Crossing | null {
  return crossings(p, lines, bands, bandSafe).find((c) => !c.safe) ?? null;
}

// ---- The Engineer assist's advice (spec §12) --------------------------------------------------------

export interface HoldAdvice {
  /** here: the train stands in the siding; ahead: take the one before the meet; behind: back into it; near: the nearest, standing. */
  where: 'here' | 'ahead' | 'behind' | 'near';
  band: Band;
  /** Clock when the other train has cleared the siding's stretch. */
  until: number;
  train: string;
}

/**
 * Where to let the conflicting train pass, and until when: the siding the train stands in, else the
 * nearest one before the meet in the direction of travel, else the nearest behind. `occupied` is the
 * siding edge the loco's front is on, if any. Null when no siding helps.
 */
export function holdAdvice(
  c: Crossing,
  p: Projection,
  bands: readonly Band[],
  lines: readonly ChartLine[],
  defs: readonly AiTrainDef[],
  occupied: string | null,
): HoldAdvice | null {
  const line = lines.find((l) => l.id === c.train);
  const def = defs.find((d) => d.id === c.train);
  if (!line || !def || bands.length === 0) return null;
  const clearOf = (b: Band): number | null => {
    // The train's front leaves the band's stretch, then its whole length has to follow.
    const tIn = Math.min(lineTimeAt(line.pts, b.lo, p.t0) ?? Infinity, lineTimeAt(line.pts, b.hi, p.t0) ?? Infinity);
    if (!Number.isFinite(tIn)) return null;
    const a = lineTimeAt(line.pts, b.lo, tIn + 1e-6);
    const z = lineTimeAt(line.pts, b.hi, tIn + 1e-6);
    const out = Math.max(a ?? -Infinity, z ?? -Infinity);
    const leave = Number.isFinite(out) ? out : tIn;
    return leave + def.length / Math.max(0.1, def.speed);
  };
  const pick = (where: HoldAdvice['where'], b: Band | undefined): HoldAdvice | null => {
    if (!b) return null;
    const until = clearOf(b);
    return until === null ? null : { where, band: b, until, train: c.train };
  };
  const m0 = p.m0;
  const inside = bands.find((b) => b.edge === occupied && m0 >= b.lo - EPS && m0 <= b.hi + EPS);
  if (inside) return pick('here', inside);
  const dir = Math.sign(p.rate);
  const byDistance = (x: Band, y: Band): number => bandGap(x, m0) - bandGap(y, m0);
  if (dir === 0) return pick('near', [...bands].sort(byDistance)[0]);
  const ahead = bands.filter((b) => (dir > 0 ? b.lo >= m0 && b.lo <= c.m : b.hi <= m0 && b.hi >= c.m)).sort(byDistance);
  if (ahead.length > 0) return pick('ahead', ahead[0]);
  const behind = bands.filter((b) => (dir > 0 ? b.hi <= m0 : b.lo >= m0)).sort(byDistance);
  return pick('behind', behind[0]);
}

function bandGap(b: Band, m: number): number {
  return m < b.lo ? b.lo - m : m > b.hi ? m - b.hi : 0;
}

// ---- The player's trace ------------------------------------------------------------------------------

/** The player's line so far: a point per `minDt` seconds or `minDm` metres, broken off the main line. */
export class TraceRecorder {
  readonly pts: LinePt[] = [];

  constructor(
    readonly minDt = 1,
    readonly minDm = 3,
    readonly maxPts = 6000,
  ) {}

  add(t: number, m: number | null): void {
    const last = this.pts[this.pts.length - 1];
    if (last && t < last.t - 1e-6) this.pts.length = 0; // the clock went back: a restart
    const prev = this.pts[this.pts.length - 1];
    if (prev) {
      if (m === null && prev.m === null) return;
      if (m !== null && prev.m !== null && t - prev.t < this.minDt && Math.abs(m - prev.m) < this.minDm) return;
    }
    this.pts.push({ t, m });
    if (this.pts.length > this.maxPts) {
      // Thin the oldest half rather than drop it: the whole run stays on the chart.
      const half = Math.floor(this.pts.length / 2);
      const thinned = this.pts.slice(0, half).filter((p, i) => i % 2 === 0 || p.m === null);
      this.pts.splice(0, half, ...thinned);
    }
  }

  clear(): void {
    this.pts.length = 0;
  }
}
