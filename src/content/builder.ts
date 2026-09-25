// A small DSL for authoring runs (spec §13, §15). A run's line is laid out by main-line distance:
// the main line runs from its west end (0) east, and passing sidings, cutoffs and spurs hang off it
// between main-line distances. The builder works out the nodes, edges and junctions (trunk and legs
// follow from how each branch is declared), every edge's mainAt, schematic map positions and a
// milepost every quarter mile. Features are placed by main-line distance, or by distance along a
// named branch, so a run file reads like a railroad's working timetable rather than a graph dump.
//
// The planning helpers at the bottom walk a run's plan and estimate its times: they design the
// timetables (when does No. 7 clear the siding?) and back the content tests. Pure, like the sim.

import { gradeAt, limitAt, netIndex, pointAt, spanDir, spanLength, walk, xOnSpans } from '../sim/network';
import {
  APPROACH_LIMIT,
  CAR_SPECS,
  DEFAULT_MAX_CARS,
  DIVERGE_LIMIT,
  DRAG,
  DWELL_SECONDS,
  GRAVITY,
  MILE,
  ROLL,
  RUNAWAY_ACCEL,
  RUNAWAY_MAX,
  STEAM_PER_FIRE,
  TENDER_HATCH_FROM_REAR,
  TRACTIVE_MAX,
  WATER_CAP,
  WATER_PER_PSI,
} from '../sim/rules';
import { timeAtRouteDistance } from '../sim/schedule';
import type {
  AiTrainDef,
  BanditGoal,
  CarType,
  CurveDef,
  Dir,
  GradeDef,
  JunctionDef,
  LowBridgeDef,
  MilepostDef,
  NetEdge,
  NetNode,
  ObstacleDef,
  ObstacleKind,
  RouteLeg,
  RunDef,
  SignalDef,
  Span,
  StationDef,
  SwitchState,
  TelegramDef,
  Terrain,
  Tier,
  TrackPoint,
  TrestleDef,
  TunnelDef,
  WaterTowerDef,
  WaveDef,
} from '../sim/types';

const EPS = 1e-6;

// Content defaults. These describe the track, not the simulation, so they live here, not in rules.ts.
/** Schematic map units per metre of main line (the desk fits the whole map to its panel). */
const MAP_SCALE = 1 / 100;
/** How far off the main line (map units) sidings, cutoffs and spurs are drawn. */
const LOOP_OFFSET = 2;
const CUTOFF_OFFSET = 6;
const SPUR_OFFSET = 2.5;
/**
 * Track speeds off the main line, m/s. Sidings run at the rulebook's diverging speed (30 mph), so a
 * train that obeys a diverging-clear signal is always inside the siding's limit; spurs at 15 mph.
 */
const SIDING_SPEED = DIVERGE_LIMIT;
const SPUR_SPEED = 7;
/** Edges shorter than this are almost certainly an authoring slip (a terrain break beside a switch). */
const MIN_EDGE = 40;

/** Clock time (seconds since midnight) from hours, minutes and seconds. */
export function clock(h: number, m: number, s = 0): number {
  return h * 3600 + m * 60 + s;
}

// ---------------------------------------------------------------------------------------------
// Laying out the line
// ---------------------------------------------------------------------------------------------

/** Which side of the main line a branch is drawn on the map. */
export type Side = 1 | -1;

/** A place: a main-line distance, or [branch id, metres along it from its west end or its switch]. */
export type Where = number | readonly [string, number];

/** A stretch that lies on one edge: [from, to] on the main line, or [branch id, from, to]. */
export type Stretch = readonly [number, number] | readonly [string, number, number];

/** A passing siding beside the main line between two switches (spec §10.1). */
export interface LoopSpec {
  id: string;
  /** "Lone Pine siding" */
  name: string;
  /** Main-line distances of its west and east switches; the siding is as long as the main beside it. */
  from: number;
  to: number;
  side?: Side;
  speed?: number;
  terrain?: Terrain;
}

/** A second route between two main-line switches, shorter or longer than the main beside it. */
export interface CutoffSpec {
  id: string;
  name: string;
  from: number;
  to: number;
  /** Its stretches, west to east: length and terrain (link nodes go between them). */
  parts: readonly (readonly [number, Terrain])[];
  speed: number;
  /** The names of its west and east junctions, e.g. ["Dry Gulch Jct.", "Gulch East Jct."]. */
  junctions: readonly [string, string];
  side?: Side;
}

/** A track leaving the main line at one switch: a dead-end spur, or a branch running off the map. */
export interface SpurSpec {
  id: string;
  /** "Quarry spur" */
  name: string;
  at: number;
  length: number;
  /** The way it leaves the main line: +1 = eastbound trains take it on a facing move. */
  toward: Dir;
  side?: Side;
  speed?: number;
  terrain?: Terrain;
  /** 'spur' ends at buffers; 'branch' ends at the map's edge, where scheduled trains come and go. */
  kind?: 'spur' | 'branch';
  /** The switch's name (default "<name> switch"). */
  switchName?: string;
  /** Where a branch leads, for its end's label, e.g. "To Red Rock". */
  label?: string;
}

export interface LineSpec {
  /** Main-line length (m), from the west end (0) to the east end. */
  length: number;
  /** Main-line track speed (m/s). */
  speed: number;
  /** Terrain from each main-line distance onward, first at 0 (each change becomes a node). */
  terrain: readonly (readonly [number, Terrain])[];
  /** Labels for the west and east ends, e.g. ["To Juniper", "To Pale Rock"]. */
  ends?: readonly [string, string];
  loops?: readonly LoopSpec[];
  cutoffs?: readonly CutoffSpec[];
  spurs?: readonly SpurSpec[];
}

/** One edge of a track, by distance along that track. */
interface Piece {
  edge: string;
  d0: number;
  d1: number;
}

function terrainAt(zones: LineSpec['terrain'], d: number): Terrain {
  let t: Terrain = zones[0][1];
  for (const [from, terrain] of zones) if (d >= from - EPS) t = terrain;
  return t;
}

/**
 * A laid-out line: the network parts of a RunDef, plus resolvers that turn main-line distances
 * (and distances along branches) into track points, and makers for features placed that way.
 *
 * Ids: main edges m1, m2… west to east; the ends W and E; link nodes k1, k2…; a loop or cutoff
 * `x` has switches `x-w` and `x-e`; a spur `x` has its switch `x-j` and its end `x-end`. Every
 * edge runs west → east (a spur runs away from its switch), so eastbound is direction +1.
 */
export class Line {
  readonly nodes: NetNode[] = [];
  readonly edges: NetEdge[] = [];
  readonly junctions: JunctionDef[] = [];
  readonly mainLine: string[] = [];
  /** Track id ('main' or a branch id) → its edges by distance along it. */
  private readonly tracks = new Map<string, Piece[]>();

  constructor(readonly spec: LineSpec) {
    const { length } = spec;
    const loops = spec.loops ?? [];
    const cutoffs = spec.cutoffs ?? [];
    const spurs = spec.spurs ?? [];

    // Where the main line needs nodes: its ends, every switch and every change of terrain.
    const switchAt = new Map<number, string>();
    const addSwitch = (d: number, id: string): void => {
      if (!(d > 0 && d < length)) throw new Error(`${id}: switch at ${d} is off the main line`);
      if (switchAt.has(d)) throw new Error(`${id}: another switch is already at ${d}`);
      switchAt.set(d, id);
    };
    for (const l of loops) {
      addSwitch(l.from, `${l.id}-w`);
      addSwitch(l.to, `${l.id}-e`);
    }
    for (const c of cutoffs) {
      addSwitch(c.from, `${c.id}-w`);
      addSwitch(c.to, `${c.id}-e`);
    }
    for (const s of spurs) addSwitch(s.at, `${s.id}-j`);
    const breaks = new Set<number>([0, length, ...switchAt.keys()]);
    for (const [d] of spec.terrain) if (d > 0 && d < length) breaks.add(d);
    const points = [...breaks].sort((a, b) => a - b);

    const nodeAt = new Map<number, string>();
    let links = 0;
    for (const d of points) {
      const end = d === 0 || d === length;
      const sw = switchAt.get(d);
      const id = d === 0 ? 'W' : d === length ? 'E' : (sw ?? `k${++links}`);
      const label = d === 0 ? spec.ends?.[0] : d === length ? spec.ends?.[1] : undefined;
      this.nodes.push({ id, kind: end ? 'end' : sw ? 'junction' : 'link', x: d * MAP_SCALE, y: 0, ...(label ? { label } : {}) });
      nodeAt.set(d, id);
    }
    const main: Piece[] = [];
    for (let i = 1; i < points.length; i++) {
      const d0 = points[i - 1];
      const d1 = points[i];
      if (d1 - d0 < MIN_EDGE) throw new Error(`main line: only ${d1 - d0} m between nodes at ${d0} and ${d1}`);
      const id = `m${i}`;
      this.edges.push({ id, a: need(nodeAt.get(d0)), b: need(nodeAt.get(d1)), length: d1 - d0, kind: 'main', speedLimit: spec.speed, terrain: terrainAt(spec.terrain, d0), mainAt: [d0, d1] });
      main.push({ edge: id, d0, d1 });
      this.mainLine.push(id);
    }
    this.tracks.set('main', main);
    const endingAt = (d: number): string => need(main.find((p) => p.d1 === d)).edge;
    const startingAt = (d: number): string => need(main.find((p) => p.d0 === d)).edge;

    for (const l of loops) {
      const [west, east] = [`${l.id}-w`, `${l.id}-e`];
      const [x0, x1] = [l.from * MAP_SCALE, l.to * MAP_SCALE];
      const y = (l.side ?? 1) * LOOP_OFFSET;
      const r = Math.min(0.8, (x1 - x0) / 4);
      this.edges.push({
        id: l.id,
        a: west,
        b: east,
        length: l.to - l.from,
        kind: 'siding',
        speedLimit: l.speed ?? SIDING_SPEED,
        terrain: l.terrain ?? terrainAt(spec.terrain, (l.from + l.to) / 2),
        mainAt: [l.from, l.to],
        via: [
          [x0 + r, y],
          [x1 - r, y],
        ],
        name: l.name,
      });
      this.tracks.set(l.id, [{ edge: l.id, d0: 0, d1: l.to - l.from }]);
      this.junctions.push({ node: west, trunk: endingAt(l.from), normal: startingAt(l.from), reverse: l.id, initial: 'normal', name: `${l.name}, west switch` });
      this.junctions.push({ node: east, trunk: startingAt(l.to), normal: endingAt(l.to), reverse: l.id, initial: 'normal', name: `${l.name}, east switch` });
    }

    for (const c of cutoffs) {
      const [west, east] = [`${c.id}-w`, `${c.id}-e`];
      const total = c.parts.reduce((n, [len]) => n + len, 0);
      const [x0, x1] = [c.from * MAP_SCALE, c.to * MAP_SCALE];
      const y = (c.side ?? 1) * CUTOFF_OFFSET;
      const r = Math.min(2, (x1 - x0) / 4);
      // Drawn as a trapezoid off the main line: out at an angle, along, and back.
      const corners: [number, number][] = [
        [x0 + r, y],
        [x1 - r, y],
      ];
      const yAt = (x: number): number => (x < x0 + r ? (y * (x - x0)) / r : x > x1 - r ? (y * (x1 - x)) / r : y);
      const pieces: Piece[] = [];
      let prev = west;
      let acc = 0;
      c.parts.forEach(([len, terrain], i) => {
        const last = i === c.parts.length - 1;
        const id = c.parts.length === 1 ? c.id : `${c.id}-${i + 1}`;
        const next = last ? east : `${c.id}-k${i + 1}`;
        const [f0, f1] = [acc / total, (acc + len) / total];
        const [xa, xb] = [x0 + (x1 - x0) * f0, x0 + (x1 - x0) * f1];
        if (!last) this.nodes.push({ id: next, kind: 'link', x: xb, y: yAt(xb) });
        const via = corners.filter(([cx]) => cx > xa + EPS && cx < xb - EPS);
        const mainAt: [number, number] = [c.from + (c.to - c.from) * f0, c.from + (c.to - c.from) * f1];
        this.edges.push({ id, a: prev, b: next, length: len, kind: 'branch', speedLimit: c.speed, terrain, mainAt, ...(via.length > 0 ? { via } : {}), name: c.name });
        pieces.push({ edge: id, d0: acc, d1: acc + len });
        prev = next;
        acc += len;
      });
      this.tracks.set(c.id, pieces);
      const [first, lastPiece] = [pieces[0].edge, pieces[pieces.length - 1].edge];
      this.junctions.push({ node: west, trunk: endingAt(c.from), normal: startingAt(c.from), reverse: first, initial: 'normal', name: c.junctions[0] });
      this.junctions.push({ node: east, trunk: startingAt(c.to), normal: endingAt(c.to), reverse: lastPiece, initial: 'normal', name: c.junctions[1] });
    }

    for (const s of spurs) {
      const [sw, end] = [`${s.id}-j`, `${s.id}-end`];
      const xj = s.at * MAP_SCALE;
      const y = (s.side ?? 1) * SPUR_OFFSET;
      const dx = s.toward * Math.max(1.5, s.length * MAP_SCALE * 0.8);
      this.nodes.push({ id: end, kind: 'end', x: xj + dx, y, label: s.label ?? s.name });
      // A spur lies beside the main line and maps onto it; a branch leads off the map, and a train
      // on it is no longer anywhere on our timetable.
      const reach = Math.max(0, Math.min(length, s.at + s.toward * s.length));
      this.edges.push({
        id: s.id,
        a: sw,
        b: end,
        length: s.length,
        kind: s.kind ?? 'spur',
        speedLimit: s.speed ?? SPUR_SPEED,
        terrain: s.terrain ?? terrainAt(spec.terrain, s.at),
        ...(s.kind === 'branch' ? {} : { mainAt: [s.at, reach] as [number, number] }),
        via: [[xj + s.toward, y]],
        name: s.name,
      });
      this.tracks.set(s.id, [{ edge: s.id, d0: 0, d1: s.length }]);
      const [west, east] = [endingAt(s.at), startingAt(s.at)];
      const facingFromWest = s.toward === 1;
      this.junctions.push({ node: sw, trunk: facingFromWest ? west : east, normal: facingFromWest ? east : west, reverse: s.id, initial: 'normal', name: s.switchName ?? `${s.name} switch` });
    }
  }

  // ---- Resolving places ----------------------------------------------------------------------

  private track(id: string): Piece[] {
    const t = this.tracks.get(id);
    if (!t) throw new Error(`Unknown track "${id}"`);
    return t;
  }

  /** The track point at a place. A distance exactly on a node resolves to the edge beyond it. */
  at(w: Where): TrackPoint {
    const [id, d] = typeof w === 'number' ? ['main', w] : w;
    const pieces = this.track(id);
    for (const p of pieces) if (d >= p.d0 - EPS && d < p.d1 - EPS) return { edge: p.edge, off: Math.max(0, d - p.d0) };
    const last = pieces[pieces.length - 1];
    if (Math.abs(d - last.d1) <= EPS) return { edge: last.edge, off: last.d1 - last.d0 };
    throw new Error(`${id} ${d} is off the track`);
  }

  /** A stretch as one edge's range; throws if it crosses a node (split it or move it). */
  span(s: Stretch): { edge: string; from: number; to: number } {
    const [id, from, to] = s.length === 2 ? ['main', s[0], s[1]] : s;
    if (!(to > from)) throw new Error(`${id} ${from}–${to} is empty`);
    for (const p of this.track(id)) if (from >= p.d0 - EPS && to <= p.d1 + EPS) return { edge: p.edge, from: from - p.d0, to: to - p.d0 };
    throw new Error(`${id} ${from}–${to} crosses a node`);
  }

  /** The switch node at a loop's or cutoff's west or east end, or a spur's switch. */
  junction(id: string, end: 'w' | 'e' | 'j'): string {
    const node = `${id}-${end}`;
    if (!this.junctions.some((j) => j.node === node)) throw new Error(`No junction ${node}`);
    return node;
  }

  /** A quarter-mile post along the main line, counted from its west end. */
  mileposts(): MilepostDef[] {
    const out: MilepostDef[] = [];
    const quarter = MILE / 4;
    for (let k = 1; k * quarter < this.spec.length; k++) {
      const p = this.at(k * quarter);
      out.push({ edge: p.edge, at: p.off, mile: k / 4 });
    }
    return out;
  }

  // ---- Features --------------------------------------------------------------------------------

  tunnel(id: string, name: string, s: Stretch): TunnelDef {
    return { id, name, ...this.span(s) };
  }

  lowBridge(id: string, w: Where, name?: string): LowBridgeDef {
    const p = this.at(w);
    return { id, edge: p.edge, at: p.off, ...(name ? { name } : {}) };
  }

  /** A trestle; `minSpeed` sets it burning (the loco must enter it at least that fast). */
  trestle(id: string, name: string, s: Stretch, minSpeed?: number): TrestleDef {
    return { id, name, ...this.span(s), ...(minSpeed !== undefined ? { burning: { minSpeed } } : {}) };
  }

  station(id: string, name: string, w: Where, opts: { platform?: number; checkpoint?: boolean; water?: boolean } = {}): StationDef {
    const p = this.at(w);
    return { id, name, edge: p.edge, at: p.off, platform: opts.platform ?? 90, checkpoint: opts.checkpoint ?? false, ...(opts.water ? { waterColumn: true } : {}) };
  }

  /** A water tower; `w` is its spout. */
  tower(id: string, w: Where, name?: string): WaterTowerDef {
    const p = this.at(w);
    return { id, edge: p.edge, at: p.off, ...(name ? { name } : {}) };
  }

  curve(id: string, s: Stretch, limit: number): CurveDef {
    return { id, ...this.span(s), limit };
  }

  /** Rise per metre heading east (negative: falling toward the east). */
  grade(s: Stretch, grade: number): GradeDef {
    return { ...this.span(s), grade };
  }

  /** A signal governing eastbound trains; a junction signal names the junction just beyond it. */
  signal(id: string, w: Where, junction?: string, name?: string): SignalDef {
    const p = this.at(w);
    return { id, edge: p.edge, at: p.off, facing: 1, kind: junction ? 'junction' : 'block', ...(junction ? { junction } : {}), ...(name ? { name } : {}) };
  }

  obstacle(id: string, kind: ObstacleKind, w: Where, variants?: string[]): ObstacleDef {
    const p = this.at(w);
    return { id, kind, edge: p.edge, at: p.off, ...(variants ? { variants } : {}) };
  }

  wave(id: string, w: Where, count: number, from: 'rear' | 'ahead', goal: BanditGoal | 'mixed', tier: Tier, opts: { boss?: boolean; variants?: string[] } = {}): WaveDef {
    return { id, trigger: this.at(w), count, from, goal, tier, ...(opts.boss ? { boss: true } : {}), ...(opts.variants ? { variants: opts.variants } : {}) };
  }

  /** A telegram sent as the loco passes a place, or at a clock time. */
  telegram(id: string, when: Where | { clock: number }, text: string): TelegramDef {
    if (typeof when === 'object' && 'clock' in when) return { id, clock: when.clock, text };
    return { id, at: this.at(when), text };
  }

  // ---- Routes and timetables for scheduled trains (spec §10.1) --------------------------------

  /**
   * A scheduled train's route: the main line end to end, starting from the west or east end,
   * through any cutoffs named in `via` instead of the main beside them; `leave` ends it by turning
   * off onto a branch (the way it's declared: its switch must face the train).
   */
  route(from: 'west' | 'east', opts: { via?: readonly string[]; leave?: string } = {}): RouteLeg[] {
    const main = this.track('main');
    const cuts = (opts.via ?? []).map((id) => {
      const c = (this.spec.cutoffs ?? []).find((x) => x.id === id);
      if (!c) throw new Error(`Unknown cutoff "${id}"`);
      return c;
    });
    let legs: RouteLeg[] = [];
    for (const p of main) {
      const c = cuts.find((x) => p.d0 >= x.from - EPS && p.d1 <= x.to + EPS);
      if (!c) legs.push({ edge: p.edge, dir: 1 });
      else if (p.d0 === c.from) for (const q of this.track(c.id)) legs.push({ edge: q.edge, dir: 1 });
    }
    if (from === 'east') legs = legs.reverse().map((l) => ({ edge: l.edge, dir: l.dir === 1 ? -1 : 1 }));
    if (opts.leave) {
      const s = (this.spec.spurs ?? []).find((x) => x.id === opts.leave);
      if (!s) throw new Error(`Unknown branch "${opts.leave}"`);
      if (s.toward !== (from === 'west' ? 1 : -1)) throw new Error(`${s.id} doesn't face trains from the ${from}`);
      const mainAt = (edge: string): [number, number] => need(this.edges.find((e) => e.id === edge)?.mainAt);
      const turnAt = legs.findIndex((l) => (from === 'west' ? mainAt(l.edge)[0] >= s.at - EPS : mainAt(l.edge)[1] <= s.at + EPS));
      if (turnAt < 0) throw new Error(`${s.id}: the route never reaches its switch`);
      legs = [...legs.slice(0, turnAt), { edge: s.id, dir: 1 }];
    }
    return legs;
  }

  /** Metres along a route to a place (its first pass), or null if the route doesn't cover it. */
  routeDistance(route: readonly RouteLeg[], p: TrackPoint): number | null {
    let acc = 0;
    for (const leg of route) {
      const len = this.edgeLength(leg.edge);
      if (leg.edge === p.edge) return acc + (leg.dir === 1 ? p.off : len - p.off);
      acc += len;
    }
    return null;
  }

  private edgeLength(id: string): number {
    return need(this.edges.find((e) => e.id === id)).length;
  }

  private routeDistanceOf(def: AiTrainDef, w: Where): number {
    const d = this.routeDistance(def.route, this.at(w));
    if (d === null) throw new Error(`${def.id}'s route doesn't pass ${JSON.stringify(w)}`);
    return d;
  }

  /** Clock when a scheduled train's front reaches a place. */
  arrives(def: AiTrainDef, w: Where): number {
    return timeAtRouteDistance(def, this.routeDistanceOf(def, w));
  }

  /** Clock when a scheduled train's rear has passed a place. */
  clears(def: AiTrainDef, w: Where): number {
    return timeAtRouteDistance(def, this.routeDistanceOf(def, w) + def.length);
  }

  /** Clock when a scheduled train's rear has passed both switches of a loop or cutoff. */
  clearsSection(def: AiTrainDef, id: string): number {
    const [from, to] = this.sectionEnds(id);
    return Math.max(this.clears(def, from), this.clears(def, to));
  }

  /** Clock when a scheduled train's front first reaches either switch of a loop or cutoff. */
  reachesSection(def: AiTrainDef, id: string): number {
    const [from, to] = this.sectionEnds(id);
    return Math.min(this.arrives(def, from), this.arrives(def, to));
  }

  private sectionEnds(id: string): [number, number] {
    const s = [...(this.spec.loops ?? []), ...(this.spec.cutoffs ?? [])].find((x) => x.id === id);
    if (!s) throw new Error(`No loop or cutoff "${id}"`);
    return [s.from, s.to];
  }
}

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('builder: missing piece');
  return v;
}

// ---------------------------------------------------------------------------------------------
// Assembling a run
// ---------------------------------------------------------------------------------------------

type OptionalLists = 'tunnels' | 'lowBridges' | 'trestles' | 'waterTowers' | 'curves' | 'grades' | 'signals' | 'obstacles' | 'waves' | 'aiTrains' | 'telegrams' | 'sideJobs';

/** Everything a run file writes: the RunDef minus what the Line and the origin provide. */
export type RunSpec = Omit<RunDef, 'nodes' | 'edges' | 'junctions' | 'mainLine' | 'mileposts' | 'start' | 'maxCars' | OptionalLists> &
  Partial<Pick<RunDef, OptionalLists | 'maxCars'>>;

/** A RunDef from a laid-out line: the train starts stopped, facing east, its front on the origin's stop mark. */
export function makeRun(line: Line, spec: RunSpec): RunDef {
  const origin = spec.stations.find((s) => s.id === spec.origin);
  if (!origin) throw new Error(`${spec.id}: origin ${spec.origin} is not a station`);
  return {
    tunnels: [],
    lowBridges: [],
    trestles: [],
    waterTowers: [],
    curves: [],
    grades: [],
    signals: [],
    obstacles: [],
    waves: [],
    aiTrains: [],
    telegrams: [],
    sideJobs: [],
    maxCars: DEFAULT_MAX_CARS,
    ...spec,
    nodes: line.nodes,
    edges: line.edges,
    junctions: line.junctions,
    mainLine: line.mainLine,
    mileposts: line.mileposts(),
    start: { edge: origin.edge, off: origin.at, dir: 1 },
  };
}

// ---------------------------------------------------------------------------------------------
// Planning: walk a run's plan and estimate its times (timetable design, par, deadlines, tests)
// ---------------------------------------------------------------------------------------------

/** The tender's water hatch sits this far behind the loco's front (spec §5.5). */
export const HATCH_BEHIND_FRONT = CAR_SPECS.loco.length + CAR_SPECS.tender.length - TENDER_HATCH_FROM_REAR;

const CAR_TYPES: readonly CarType[] = ['express', 'passenger', 'boxcar', 'armored', 'caboose', 'powder'];

/** The longest train a run allows: loco, tender and maxCars of the longest car. */
export function longestTrain(run: RunDef): number {
  const longest = Math.max(...CAR_TYPES.map((c) => CAR_SPECS[c].length));
  return CAR_SPECS.loco.length + CAR_SPECS.tender.length + run.maxCars * longest;
}

/** The part of a span list between distances a and b from its start. */
export function sliceSpans(spans: readonly Span[], a: number, b: number): Span[] {
  const out: Span[] = [];
  let acc = 0;
  for (const s of spans) {
    const len = spanLength(s);
    const dir = spanDir(s);
    const lo = Math.max(a, acc);
    const hi = Math.min(b, acc + len);
    if (hi - lo > EPS) out.push({ edge: s.edge, from: s.from + dir * (lo - acc), to: s.from + dir * (hi - acc) });
    acc += len;
  }
  return out;
}

export interface PlannedPath {
  /** The track from the loco's start to the destination's stop mark, in driving order. */
  spans: Span[];
  length: number;
  /** Every switch as the plan leaves it (each junction is set at most once in a plan). */
  switches: Record<string, SwitchState>;
  /** Distance along the path to a point, or null if the path doesn't pass it. */
  x(p: TrackPoint): number | null;
}

/** The route a variant's plan drives, from the start to the destination; null if it never gets there. */
export function plannedPath(run: RunDef, variant: string): PlannedPath | null {
  const plan = run.plan[variant];
  const dest = run.stations.find((s) => s.id === run.contract.destination);
  if (!plan || !dest) return null;
  const switches: Record<string, SwitchState> = {};
  for (const j of run.junctions) switches[j.node] = j.initial;
  for (const s of plan.switches) switches[s.junction] = s.state;
  const w = walk(netIndex(run), switches, run.start, 1e6);
  const length = xOnSpans(w.spans, { edge: dest.edge, off: dest.at });
  if (length === null) return null;
  const spans = sliceSpans(w.spans, 0, length);
  return { spans, length, switches, x: (p) => xOnSpans(spans, p) };
}

export interface PlanHalt {
  id: string;
  kind: 'station' | 'tower' | 'hold' | 'signal';
  /** Path distance where the loco's front stops. */
  x: number;
  arrive: number;
  leave: number;
}

export interface Estimate {
  path: PlannedPath;
  /** Clock when the destination stop completes: the run is won. */
  arrive: number;
  halts: PlanHalt[];
  /** Clock when the loco's front first reaches path distance x. */
  timeAt(x: number): number;
  /** Path distance of the loco's front at a clock time. */
  frontAt(clock: number): number;
  /** The least water in the tender just before any refill, and at the end. */
  minWater: number;
}

export interface EstimateOptions {
  /** Cars behind the tender (default: the required cars plus those the side jobs need). */
  consist?: readonly CarType[];
  /** Water used per second on the move (default: the firebox at 2 throughout, hard running). */
  waterRate?: number;
  /** Water used per second standing (default: the firebox at 1). */
  idleWaterRate?: number;
}

/** Path step for the estimate (m). */
const STEP = 2;
/** A cautious driver's braking, and share of full tractive effort, for the estimate. */
const EST_BRAKE = 0.6;
const EST_POWER = 0.9;
/** Seconds standing at a water tower: stop, spout down, fill, spout up. */
const TOWER_SECONDS = 15;
/** The runaway's rear must be this long clear of our route before we go on. */
const RUNAWAY_MARGIN = 5;

/** Seconds for the runaway to roll `d` metres from rest (spec §10.2, on the flat). */
export function runawayRollTime(d: number): number {
  const dAccel = RUNAWAY_MAX ** 2 / (2 * RUNAWAY_ACCEL);
  return d <= dAccel ? Math.sqrt((2 * d) / RUNAWAY_ACCEL) : RUNAWAY_MAX / RUNAWAY_ACCEL + (d - dAccel) / RUNAWAY_MAX;
}

interface Halt {
  id: string;
  kind: PlanHalt['kind'];
  x: number;
  dwell: number;
  until: number;
  refill: boolean;
}

/**
 * A rough drive of a variant's plan: cruise capped by track speeds and curves, braking to each
 * stop and hold, accelerating on the consist's power less a margin, with the grades. It assumes
 * approach aspects from the signal before each hold, and waits at the last signal before a
 * runaway's diverting switch until the runaway (spec §10.2) has rolled clear of our route.
 * Deliberately a little pessimistic: deadlines and meets are designed against it.
 */
export function estimate(run: RunDef, variant: string, opts: EstimateOptions = {}): Estimate {
  const path = plannedPath(run, variant);
  if (!path) throw new Error(`${run.id}/${variant}: the plan never reaches the destination`);
  const ix = netIndex(run);
  const plan = run.plan[variant];
  const consist = opts.consist ?? [...new Set([...run.requiredCars, ...run.sideJobs.map((j) => j.needs)])];
  const mass = CAR_SPECS.loco.mass + CAR_SPECS.tender.mass + consist.reduce((m, c) => m + CAR_SPECS[c].mass, 0);
  const waterRate = opts.waterRate ?? WATER_PER_PSI * STEAM_PER_FIRE * 2;
  const idleRate = opts.idleWaterRate ?? WATER_PER_PSI * STEAM_PER_FIRE;
  const at = (p: TrackPoint, what: string): number => {
    const x = path.x(p);
    if (x === null) throw new Error(`${run.id}/${variant}: ${what} is not on the planned route`);
    return x;
  };

  // Where the loco's front stops, and for how long.
  const halts: Halt[] = [];
  for (const id of plan.stops) {
    const st = run.stations.find((s) => s.id === id);
    const tw = run.waterTowers.find((w) => w.id === id);
    if (st) {
      const dest = id === run.contract.destination;
      halts.push({ id, kind: 'station', x: at({ edge: st.edge, off: st.at }, id), dwell: DWELL_SECONDS + (dest ? 0 : 2), until: 0, refill: !!st.waterColumn });
    } else if (tw) halts.push({ id, kind: 'tower', x: at({ edge: tw.edge, off: tw.at }, id) + HATCH_BEHIND_FRONT, dwell: TOWER_SECONDS, until: 0, refill: true });
    else throw new Error(`${run.id}/${variant}: unknown stop ${id}`);
  }
  if (!plan.stops.includes(run.contract.destination)) halts.push({ id: run.contract.destination, kind: 'station', x: path.length, dwell: DWELL_SECONDS, until: 0, refill: false });
  plan.holds.forEach((h, i) => halts.push({ id: `hold ${i + 1}`, kind: 'hold', x: at(h.at, `hold ${i + 1}`), dwell: 0, until: h.until, refill: false }));

  // Signals on the path that face our way.
  const signals = run.signals
    .map((s) => ({ s, x: path.x({ edge: s.edge, off: s.at }) }))
    .filter((v): v is { s: SignalDef; x: number } => v.x !== null && pointAt(path.spans, v.x).dir === v.s.facing)
    .sort((a, b) => a.x - b.x);
  const lastSignalBefore = (x: number): number | null => {
    let best: number | null = null;
    for (const v of signals) if (v.x < x - EPS) best = v.x;
    return best;
  };

  // The runaway: find where its roll leaves our route (the diverting switch), and wait at the last
  // signal before that switch until it has rolled clear.
  let gate: { trigger: number; distance: number; length: number; halt: Halt } | null = null;
  const runaway = run.aiTrains.find((t) => t.kind === 'runaway');
  if (runaway?.runaway) {
    const trigger = path.x(runaway.runaway.trigger);
    const roll = walk(ix, path.switches, { ...runaway.runaway.start, dir: runaway.runaway.dir }, 1e5);
    const ours = new Set(path.spans.map((s) => s.edge));
    const leaveAt = roll.spans.findIndex((s) => !ours.has(s.edge));
    if (trigger !== null && leaveAt > 0) {
      const shared = roll.spans[leaveAt - 1];
      const xSwitch = path.x({ edge: shared.edge, off: shared.to });
      const distance = roll.spans.slice(0, leaveAt).reduce((n, s) => n + spanLength(s), 0);
      if (xSwitch !== null) {
        const halt: Halt = { id: `${runaway.id} gate`, kind: 'signal', x: lastSignalBefore(xSwitch) ?? Math.max(0, xSwitch - 60), dwell: 0, until: 0, refill: false };
        halts.push(halt);
        gate = { trigger, distance, length: runaway.length, halt };
      }
    }
  }

  // Speed caps along the path.
  const n = Math.ceil(path.length / STEP);
  const xs = (i: number): number => Math.min(i * STEP, path.length);
  const cap = new Float64Array(n + 1);
  const grade = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const p = pointAt(path.spans, xs(i));
    cap[i] = Math.min(plan.cruise, limitAt(ix, p));
    grade[i] = gradeAt(ix, p) * p.dir;
  }
  for (const h of halts) {
    if (h.kind !== 'hold') continue;
    const from = lastSignalBefore(h.x) ?? h.x - 600;
    for (let i = Math.max(0, Math.floor(from / STEP)); i <= Math.min(n, Math.ceil(h.x / STEP)); i++) cap[i] = Math.min(cap[i], APPROACH_LIMIT);
  }
  const haltAt = new Map<number, Halt[]>();
  for (const h of halts) {
    const i = Math.min(n, Math.max(0, Math.round(h.x / STEP)));
    haltAt.set(i, [...(haltAt.get(i) ?? []), h]);
    cap[i] = 0;
  }
  cap[n] = 0;

  // Braking envelope backward, then acceleration forward.
  const v = new Float64Array(n + 1);
  const vmax = Float64Array.from(cap);
  for (let i = n - 1; i >= 0; i--) vmax[i] = Math.min(vmax[i], Math.sqrt(vmax[i + 1] ** 2 + 2 * EST_BRAKE * STEP));
  for (let i = 0; i < n; i++) {
    const a = (EST_POWER * TRACTIVE_MAX) / mass - ROLL - DRAG * v[i] ** 2 - GRAVITY * grade[i];
    v[i + 1] = Math.min(vmax[i + 1], Math.sqrt(Math.max(4, v[i] ** 2 + 2 * a * STEP)));
  }

  // Walk the clock along the profile.
  const times = new Float64Array(n + 1);
  const out: PlanHalt[] = [];
  let t = run.startClock;
  let water = run.initialWater;
  let minWater = water;
  for (let i = 0; i <= n; i++) {
    if (i > 0) {
      const dt = STEP / Math.max(0.3, (v[i - 1] + v[i]) / 2);
      t += dt;
      water -= waterRate * dt;
    }
    times[i] = t;
    if (gate && gate.halt.until === 0 && xs(i) >= gate.trigger - EPS) gate.halt.until = t + runawayRollTime(gate.distance + gate.length) + RUNAWAY_MARGIN;
    for (const h of haltAt.get(i) ?? []) {
      const arrive = t;
      t = Math.max(t + h.dwell, h.until);
      water -= idleRate * (t - arrive);
      if (h.refill) {
        minWater = Math.min(minWater, water);
        water = WATER_CAP;
      }
      out.push({ id: h.id, kind: h.kind, x: h.x, arrive, leave: t });
    }
  }
  minWater = Math.min(minWater, water);
  const last = out.filter((h) => h.id === run.contract.destination).pop();
  return {
    path,
    arrive: last ? last.leave : t,
    halts: out,
    timeAt: (x) => times[Math.min(n, Math.max(0, Math.round(x / STEP)))],
    frontAt: (c) => {
      if (c <= times[0]) return 0;
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= c) lo = mid;
        else hi = mid - 1;
      }
      return xs(lo);
    },
    minWater,
  };
}
