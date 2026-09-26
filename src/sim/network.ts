// The rail network (spec §4): an index over the RunDef, path walking that follows switches, the
// train's span list (rear → front) moved along the track, and queries that place track positions
// in the train frame. Pure: switches come in as a plain record, nothing is mutated.

import type {
  CurveDef,
  Dir,
  EngineerRun,
  FordDef,
  GradeDef,
  JunctionDef,
  LowBridgeDef,
  MilepostDef,
  NetEdge,
  NetNode,
  ObstacleDef,
  RunDef,
  SignalDef,
  Span,
  StationDef,
  SwitchState,
  TrackHead,
  TrackPoint,
  TrestleDef,
  TunnelDef,
  WaterTowerDef,
} from './types';

const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------------------------

export interface EdgeFeatures {
  tunnels: TunnelDef[];
  lowBridges: LowBridgeDef[];
  trestles: TrestleDef[];
  fords: FordDef[];
  stations: StationDef[];
  waterTowers: WaterTowerDef[];
  curves: CurveDef[];
  grades: GradeDef[];
  mileposts: MilepostDef[];
  signals: SignalDef[];
  obstacles: ObstacleDef[];
}

/** A full run, or the Engineer's copy of one (no obstacles, waves, plan or variants). */
export type AnyRun = RunDef | EngineerRun;

export interface NetIndex {
  run: AnyRun;
  node: Map<string, NetNode>;
  edge: Map<string, NetEdge>;
  /** By junction node id. */
  junction: Map<string, JunctionDef>;
  /** Node id → the edges meeting there and which of their ends touches it. */
  incident: Map<string, { edge: string; end: 'a' | 'b' }[]>;
  /** Features grouped by edge. */
  features: Map<string, EdgeFeatures>;
}

const cache = new WeakMap<AnyRun, NetIndex>();

function emptyFeatures(): EdgeFeatures {
  return { tunnels: [], lowBridges: [], trestles: [], fords: [], stations: [], waterTowers: [], curves: [], grades: [], mileposts: [], signals: [], obstacles: [] };
}

/** The index for a run, built once per run object. */
export function netIndex(run: AnyRun): NetIndex {
  const hit = cache.get(run);
  if (hit) return hit;
  const node = new Map(run.nodes.map((n) => [n.id, n]));
  const edge = new Map(run.edges.map((e) => [e.id, e]));
  const junction = new Map(run.junctions.map((j) => [j.node, j]));
  const incident = new Map<string, { edge: string; end: 'a' | 'b' }[]>();
  for (const n of run.nodes) incident.set(n.id, []);
  for (const e of run.edges) {
    incident.get(e.a)?.push({ edge: e.id, end: 'a' });
    incident.get(e.b)?.push({ edge: e.id, end: 'b' });
  }
  const features = new Map<string, EdgeFeatures>();
  for (const e of run.edges) features.set(e.id, emptyFeatures());
  const add = <K extends keyof EdgeFeatures>(key: K, list: EdgeFeatures[K]): void => {
    for (const f of list) (features.get(f.edge)?.[key] as unknown[] | undefined)?.push(f);
  };
  add('tunnels', run.tunnels);
  add('lowBridges', run.lowBridges);
  add('trestles', run.trestles);
  add('fords', run.fords);
  add('stations', run.stations);
  add('waterTowers', run.waterTowers);
  add('curves', run.curves);
  add('grades', run.grades);
  add('mileposts', run.mileposts);
  add('signals', run.signals);
  add('obstacles', 'obstacles' in run ? run.obstacles : []);
  const ix: NetIndex = { run, node, edge, junction, incident, features };
  cache.set(run, ix);
  return ix;
}

export function edgeOf(ix: NetIndex, id: string): NetEdge {
  const e = ix.edge.get(id);
  if (!e) throw new Error(`Unknown edge "${id}"`);
  return e;
}

/** The switch setting of a junction (its initial setting if the record lacks it). */
export function switchOf(ix: NetIndex, switches: Record<string, SwitchState>, junction: string): SwitchState {
  return switches[junction] ?? ix.junction.get(junction)?.initial ?? 'normal';
}

// ---------------------------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------------------------

export interface NextEdge {
  /** Where the next edge begins, heading away from the node. */
  head: TrackHead;
  /** The junction crossed, if the node is one. */
  junction: string | null;
  /** A trailing move through a switch set against it: the setting it needs (the sim throws it). */
  trailing: SwitchState | null;
}

/** The edge entered when leaving `fromEdge` through `nodeId`, following the switches. Null at an end node. */
export function nextEdge(ix: NetIndex, switches: Record<string, SwitchState>, fromEdge: string, nodeId: string): NextEdge | null {
  const node = ix.node.get(nodeId);
  if (!node || node.kind === 'end') return null;
  let nextId: string | null = null;
  let trailing: SwitchState | null = null;
  let junction: string | null = null;
  if (node.kind === 'junction') {
    const j = ix.junction.get(nodeId);
    if (!j) return null;
    junction = nodeId;
    const state = switchOf(ix, switches, nodeId);
    if (fromEdge === j.trunk) nextId = state === 'normal' ? j.normal : j.reverse;
    else if (fromEdge === j.normal) {
      nextId = j.trunk;
      if (state !== 'normal') trailing = 'normal';
    } else if (fromEdge === j.reverse) {
      nextId = j.trunk;
      if (state !== 'reverse') trailing = 'reverse';
    }
  } else {
    const other = ix.incident.get(nodeId)?.find((i) => i.edge !== fromEdge);
    nextId = other?.edge ?? null;
  }
  if (!nextId) return null;
  const ne = edgeOf(ix, nextId);
  const head: TrackHead = ne.a === nodeId ? { edge: nextId, off: 0, dir: 1 } : { edge: nextId, off: ne.length, dir: -1 };
  return { head, junction, trailing };
}

export interface Walk {
  /** Where the walk ended, still heading the same way. */
  end: TrackHead;
  walked: number;
  /** The track covered, in walking order. */
  spans: Span[];
  /** Stopped early at an end node. */
  blocked: boolean;
  /** Nodes crossed and the distance walked when crossing them. */
  nodes: { node: string; at: number }[];
  /** Trailing moves through switches set against them. */
  trails: { junction: string; state: SwitchState }[];
}

/** Walks `dist` ≥ 0 metres from `head`, following the switches. Stops at end nodes. */
export function walk(ix: NetIndex, switches: Record<string, SwitchState>, head: TrackHead, dist: number): Walk {
  const spans: Span[] = [];
  const nodes: { node: string; at: number }[] = [];
  const trails: { junction: string; state: SwitchState }[] = [];
  let edgeId = head.edge;
  let off = head.off;
  let dir: Dir = head.dir;
  let left = Math.max(0, dist);
  let walked = 0;
  let blocked = false;
  for (let guard = 0; guard < 100_000; guard++) {
    const e = edgeOf(ix, edgeId);
    const room = dir === 1 ? e.length - off : off;
    if (left <= room + EPS) {
      const stepLen = Math.min(left, room);
      const to = off + dir * stepLen;
      if (stepLen > EPS) spans.push({ edge: edgeId, from: off, to });
      walked += stepLen;
      off = to;
      break;
    }
    const to = dir === 1 ? e.length : 0;
    if (room > EPS) spans.push({ edge: edgeId, from: off, to });
    walked += room;
    left -= room;
    off = to;
    const nodeId = dir === 1 ? e.b : e.a;
    const nx = nextEdge(ix, switches, edgeId, nodeId);
    if (!nx) {
      blocked = true;
      break;
    }
    nodes.push({ node: nodeId, at: walked });
    if (nx.trailing && nx.junction) trails.push({ junction: nx.junction, state: nx.trailing });
    edgeId = nx.head.edge;
    off = nx.head.off;
    dir = nx.head.dir;
  }
  return { end: { edge: edgeId, off, dir }, walked, spans, blocked, nodes, trails };
}

// ---------------------------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------------------------

export function spanLength(s: Span): number {
  return Math.abs(s.to - s.from);
}

export function spanDir(s: Span): Dir {
  return s.to >= s.from ? 1 : -1;
}

export function spansLength(spans: readonly Span[]): number {
  let n = 0;
  for (const s of spans) n += spanLength(s);
  return n;
}

/** The front of a span list, heading forward. */
export function frontHead(spans: readonly Span[]): TrackHead {
  const s = spans[spans.length - 1];
  return { edge: s.edge, off: s.to, dir: spanDir(s) };
}

/** The rear of a span list, heading backward (the way the rear leads when reversing). */
export function rearHead(spans: readonly Span[]): TrackHead {
  const s = spans[0];
  return { edge: s.edge, off: s.from, dir: spanDir(s) === 1 ? -1 : 1 };
}

function reverseSpan(s: Span): Span {
  return { edge: s.edge, from: s.to, to: s.from };
}

/** Joins two span lists, merging the seam when it continues the same edge the same way. */
function joinSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out = a.map((s) => ({ ...s }));
  for (const s of b) {
    const last = out[out.length - 1];
    if (last && last.edge === s.edge && Math.abs(last.to - s.from) < EPS && spanDir(last) === spanDir(s)) last.to = s.to;
    else out.push({ ...s });
  }
  return out;
}

/** Removes `amount` metres from the start of a span list. */
function trimStart(spans: Span[], amount: number): Span[] {
  const out = spans.map((s) => ({ ...s }));
  let left = amount;
  while (out.length > 0 && left > EPS) {
    const s = out[0];
    const len = spanLength(s);
    if (len <= left + EPS) {
      out.shift();
      left -= len;
    } else {
      s.from += spanDir(s) * left;
      left = 0;
    }
  }
  return out;
}

/** Removes `amount` metres from the end of a span list. */
function trimEnd(spans: Span[], amount: number): Span[] {
  return trimStart(spans.map(reverseSpan).reverse(), amount).map(reverseSpan).reverse();
}

/** A train of `length` metres whose front is at `front`, laid back along the track behind it. */
export function spansFromFront(ix: NetIndex, switches: Record<string, SwitchState>, front: TrackHead, length: number): Span[] {
  const back: TrackHead = { edge: front.edge, off: front.off, dir: front.dir === 1 ? -1 : 1 };
  const w = walk(ix, switches, back, length);
  return w.spans.map(reverseSpan).reverse();
}

export interface Move {
  spans: Span[];
  /** Signed distance actually moved (less than asked when stopped by an end node). */
  moved: number;
  blocked: boolean;
  /** Trailing moves the sim must apply to the switches. */
  trails: { junction: string; state: SwitchState }[];
  /** Nodes the leading end crossed. */
  nodes: { node: string; at: number }[];
}

/** Moves a train (spans rear → front) by `d` metres: forward when d > 0, backward (rear leading) when d < 0. */
export function moveSpans(ix: NetIndex, switches: Record<string, SwitchState>, spans: readonly Span[], d: number): Move {
  if (Math.abs(d) < EPS) return { spans: spans.map((s) => ({ ...s })), moved: 0, blocked: false, trails: [], nodes: [] };
  if (d > 0) {
    const w = walk(ix, switches, frontHead(spans), d);
    const out = trimStart(joinSpans(spans, w.spans), w.walked);
    return { spans: out, moved: w.walked, blocked: w.blocked, trails: w.trails, nodes: w.nodes };
  }
  const w = walk(ix, switches, rearHead(spans), -d);
  const lead = w.spans.map(reverseSpan).reverse();
  const out = trimEnd(joinSpans(lead, spans), w.walked);
  return { spans: out, moved: -w.walked, blocked: w.blocked, trails: w.trails, nodes: w.nodes };
}

/** The point `s` metres from the rear (clamped to the spans), with the train's heading there. */
export function pointAt(spans: readonly Span[], s: number): TrackHead {
  let left = Math.max(0, s);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const len = spanLength(sp);
    if (left <= len + EPS || i === spans.length - 1) {
      const d = Math.min(left, len);
      return { edge: sp.edge, off: sp.from + spanDir(sp) * d, dir: spanDir(sp) };
    }
    left -= len;
  }
  const last = spans[spans.length - 1];
  return { edge: last.edge, off: last.to, dir: spanDir(last) };
}

/** Distance from the rear along the spans to `p`, or null if the spans don't cover it. */
export function xOnSpans(spans: readonly Span[], p: TrackPoint): number | null {
  let acc = 0;
  for (const s of spans) {
    const lo = Math.min(s.from, s.to);
    const hi = Math.max(s.from, s.to);
    if (s.edge === p.edge && p.off >= lo - EPS && p.off <= hi + EPS) return acc + Math.abs(p.off - s.from);
    acc += spanLength(s);
  }
  return null;
}

/**
 * Did a path (what something covered this tick, in order) pass `p`? The path's very start doesn't
 * count, since it was the previous tick's end; its end does.
 */
export function pathCrosses(path: readonly Span[], p: TrackPoint): boolean {
  for (let i = 0; i < path.length; i++) {
    const s = path[i];
    if (s.edge !== p.edge) continue;
    const d = (p.off - s.from) * spanDir(s);
    const len = spanLength(s);
    if (d > (i === 0 ? EPS : -EPS) && d <= len + EPS) return true;
  }
  return false;
}

/** Do two occupancies share any stretch of track (more than `margin` metres)? */
export function spansOverlap(a: readonly Span[], b: readonly Span[], margin = 0): boolean {
  for (const s of a) {
    const lo = Math.min(s.from, s.to);
    const hi = Math.max(s.from, s.to);
    for (const t of b) {
      if (t.edge !== s.edge) continue;
      const tlo = Math.min(t.from, t.to);
      const thi = Math.max(t.from, t.to);
      if (Math.min(hi, thi) - Math.max(lo, tlo) > margin + EPS) return true;
    }
  }
  return false;
}

/** Does an occupancy foul a junction: cover any of its edges within `distance` of the node? */
export function fouls(ix: NetIndex, spans: readonly Span[], junctionNode: string, distance: number): boolean {
  const inc = ix.incident.get(junctionNode) ?? [];
  for (const { edge, end } of inc) {
    const e = edgeOf(ix, edge);
    const zlo = end === 'a' ? 0 : e.length - distance;
    const zhi = end === 'a' ? distance : e.length;
    for (const s of spans) {
      if (s.edge !== edge) continue;
      const lo = Math.min(s.from, s.to);
      const hi = Math.max(s.from, s.to);
      if (Math.min(hi, zhi) - Math.max(lo, zlo) > EPS) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Point queries
// ---------------------------------------------------------------------------------------------

/** Main-line distance of a point (spec §4.4), or null if its edge isn't mapped. */
export function mainPos(ix: NetIndex, p: TrackPoint): number | null {
  const e = ix.edge.get(p.edge);
  if (!e?.mainAt) return null;
  const t = e.length > 0 ? p.off / e.length : 0;
  return e.mainAt[0] + (e.mainAt[1] - e.mainAt[0]) * t;
}

/** Rise per metre in the edge's a→b direction at a point (0 on the flat). */
export function gradeAt(ix: NetIndex, p: TrackPoint): number {
  const f = ix.features.get(p.edge);
  if (!f) return 0;
  for (const g of f.grades) if (p.off >= g.from - EPS && p.off <= g.to + EPS) return g.grade;
  return 0;
}

/** Track speed at a point: the edge's limit, lowered by any curve covering it (m/s). */
export function limitAt(ix: NetIndex, p: TrackPoint): number {
  const e = ix.edge.get(p.edge);
  let limit = e ? e.speedLimit : Infinity;
  const f = ix.features.get(p.edge);
  if (f) for (const c of f.curves) if (p.off >= c.from - EPS && p.off <= c.to + EPS) limit = Math.min(limit, c.limit);
  return limit;
}

// ---------------------------------------------------------------------------------------------
// The train frame (spec §6.1)
// ---------------------------------------------------------------------------------------------

/**
 * One continuous stretch of track through the train: up to `behind` metres behind the rear, the
 * train's own spans, and up to `ahead` metres past the front (both following the switches). The
 * first span starts at train-frame x = x0 (≤ 0); the loco's front is at x = train length.
 */
export interface FramePath {
  spans: Span[];
  x0: number;
}

export function framePath(ix: NetIndex, switches: Record<string, SwitchState>, trainSpans: readonly Span[], behind: number, ahead: number): FramePath {
  const back = walk(ix, switches, rearHead(trainSpans), behind);
  const fwd = walk(ix, switches, frontHead(trainSpans), ahead);
  const lead = back.spans.map(reverseSpan).reverse();
  return { spans: joinSpans(joinSpans(lead, trainSpans), fwd.spans), x0: -back.walked };
}

/** Train-frame x of a point on the frame path, or null if the path doesn't pass it. */
export function frameX(fp: FramePath, p: TrackPoint): number | null {
  const d = xOnSpans(fp.spans, p);
  return d === null ? null : fp.x0 + d;
}

/** The track point at train-frame x on the frame path, or null beyond its ends. */
export function framePoint(fp: FramePath, x: number): TrackPoint | null {
  const d = x - fp.x0;
  if (d < -EPS || d > spansLength(fp.spans) + EPS) return null;
  const p = pointAt(fp.spans, d);
  return { edge: p.edge, off: p.off };
}

/**
 * The train-frame extent [x0, x1] of an edge range (from ≤ to) where the frame path covers it,
 * clipped to the path; null if it doesn't.
 */
export function frameRange(fp: FramePath, edge: string, from: number, to: number): [number, number] | null {
  let acc = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of fp.spans) {
    const len = spanLength(s);
    if (s.edge === edge) {
      const slo = Math.min(s.from, s.to);
      const shi = Math.max(s.from, s.to);
      const a = Math.max(slo, from);
      const b = Math.min(shi, to);
      if (b - a > -EPS) {
        const da = acc + Math.abs(a - s.from);
        const db = acc + Math.abs(b - s.from);
        lo = Math.min(lo, da, db);
        hi = Math.max(hi, da, db);
      }
    }
    acc += len;
  }
  return lo === Infinity ? null : [fp.x0 + lo, fp.x0 + hi];
}

// ---------------------------------------------------------------------------------------------
// Validation (content tests and a dev-time guard)
// ---------------------------------------------------------------------------------------------

/** Structural problems with a run's network and feature placement; [] when it's sound. */
export function validateRun(run: RunDef): string[] {
  const problems: string[] = [];
  const nodes = new Map(run.nodes.map((n) => [n.id, n]));
  const edges = new Map(run.edges.map((e) => [e.id, e]));
  if (nodes.size !== run.nodes.length) problems.push('duplicate node ids');
  if (edges.size !== run.edges.length) problems.push('duplicate edge ids');
  const incident = new Map<string, string[]>();
  for (const e of run.edges) {
    if (!nodes.has(e.a) || !nodes.has(e.b)) problems.push(`edge ${e.id} joins an unknown node`);
    if (e.a === e.b) problems.push(`edge ${e.id} is a loop on one node`);
    if (!(e.length > 0)) problems.push(`edge ${e.id} has no length`);
    if (!(e.speedLimit > 0)) problems.push(`edge ${e.id} has no speed limit`);
    for (const n of [e.a, e.b]) incident.set(n, [...(incident.get(n) ?? []), e.id]);
  }
  for (const n of run.nodes) {
    const count = incident.get(n.id)?.length ?? 0;
    const want = n.kind === 'end' ? 1 : n.kind === 'link' ? 2 : 3;
    if (count !== want) problems.push(`node ${n.id} (${n.kind}) has ${count} edges, expected ${want}`);
  }
  const junctionNodes = new Set<string>();
  for (const j of run.junctions) {
    junctionNodes.add(j.node);
    const node = nodes.get(j.node);
    if (!node || node.kind !== 'junction') problems.push(`junction ${j.node} is not a junction node`);
    const inc = new Set(incident.get(j.node) ?? []);
    const legs = [j.trunk, j.normal, j.reverse];
    if (new Set(legs).size !== 3 || legs.some((l) => !inc.has(l))) problems.push(`junction ${j.node}: trunk/normal/reverse must be its three edges`);
  }
  for (const n of run.nodes) if (n.kind === 'junction' && !junctionNodes.has(n.id)) problems.push(`junction node ${n.id} has no JunctionDef`);

  const inEdge = (what: string, edge: string, ...offs: number[]): void => {
    const e = edges.get(edge);
    if (!e) {
      problems.push(`${what} is on unknown edge ${edge}`);
      return;
    }
    for (const o of offs) if (!(o >= -EPS && o <= e.length + EPS)) problems.push(`${what} at ${o} is outside edge ${edge} (0..${e.length})`);
  };
  for (const t of run.tunnels) inEdge(`tunnel ${t.id}`, t.edge, t.from, t.to);
  for (const t of run.trestles) inEdge(`trestle ${t.id}`, t.edge, t.from, t.to);
  for (const b of run.lowBridges) inEdge(`low bridge ${b.id}`, b.edge, b.at);
  for (const s of run.stations) inEdge(`station ${s.id}`, s.edge, s.at);
  for (const w of run.waterTowers) inEdge(`water tower ${w.id}`, w.edge, w.at);
  for (const c of run.curves) inEdge(`curve ${c.id}`, c.edge, c.from, c.to);
  for (const g of run.grades) inEdge(`grade on ${g.edge}`, g.edge, g.from, g.to);
  for (const m of run.mileposts) inEdge(`milepost ${m.mile}`, m.edge, m.at);
  for (const s of run.signals) {
    inEdge(`signal ${s.id}`, s.edge, s.at);
    if (s.kind === 'junction' && (!s.junction || !junctionNodes.has(s.junction))) problems.push(`signal ${s.id} guards unknown junction ${s.junction}`);
  }
  for (const o of run.obstacles) inEdge(`obstacle ${o.id}`, o.edge, o.at);
  for (const w of run.waves) inEdge(`wave ${w.id} trigger`, w.trigger.edge, w.trigger.off);
  inEdge('start', run.start.edge, run.start.off);

  // The main line: consecutive edges share a node.
  for (let i = 0; i < run.mainLine.length; i++) {
    const e = edges.get(run.mainLine[i]);
    if (!e) {
      problems.push(`mainLine: unknown edge ${run.mainLine[i]}`);
      continue;
    }
    if (i > 0) {
      const p = edges.get(run.mainLine[i - 1]);
      if (p && ![p.a, p.b].some((n) => n === e.a || n === e.b)) problems.push(`mainLine: ${p.id} and ${e.id} don't meet`);
    }
  }
  // Scheduled trains' routes: consecutive legs meet at the node the first leaves through.
  for (const t of run.aiTrains) {
    for (let i = 1; i < t.route.length; i++) {
      const p = edges.get(t.route[i - 1].edge);
      const e = edges.get(t.route[i].edge);
      if (!p || !e) {
        problems.push(`train ${t.id}: unknown edge in route`);
        continue;
      }
      const exitNode = t.route[i - 1].dir === 1 ? p.b : p.a;
      const entryNode = t.route[i].dir === 1 ? e.a : e.b;
      if (exitNode !== entryNode) problems.push(`train ${t.id}: route legs ${p.id} → ${e.id} don't connect`);
    }
  }
  const ids = new Set<string>();
  for (const s of run.stations) {
    if (ids.has(s.id)) problems.push(`duplicate station id ${s.id}`);
    ids.add(s.id);
  }
  if (!run.stations.some((s) => s.id === run.contract.destination)) problems.push(`contract destination ${run.contract.destination} is not a station`);
  if (!run.stations.some((s) => s.id === run.origin)) problems.push(`origin ${run.origin} is not a station`);
  if (run.variants.length === 0) problems.push('no variants');
  for (const v of run.variants) if (!run.plan[v]) problems.push(`no plan for variant ${v}`);
  return problems;
}
