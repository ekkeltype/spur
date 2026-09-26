// The train frame's geometry (spec §5.1, §6.1, §6.3): where people on the train can stand, climb,
// walk through and shoot, derived from the consist's layout. Pure, and cached per layout, since
// the Rider and every boarded bandit query it every tick.
//
// Car ends (spec §5.1). A car's x-range (from layoutConsist) includes its end platforms, and the
// cars' ranges touch. The outer 0.3 m at each end of a car is its half of the 0.6 m bridge plate
// (COUPLER_GAP), the next 0.5 m is the end platform (PLATFORM_DEPTH), and the body sits between. So
// two adjacent bodies, and their roofs, are 2 × 0.8 = 1.6 m apart, while floor level runs
// unbroken from the rear platform to the tender. The train's very rear has no plate: step off the
// last platform and you're off the train.

import {
  BANDIT_WALK,
  CAB_LENGTH,
  CAR_SPECS,
  COUPLER_GAP,
  CUPOLA_Y,
  LADDER_SPEED,
  PLATFORM_DEPTH,
  RIDER_GRAVITY,
  RIDER_JUMP_V,
  RIDER_WIDTH,
  TENDER_DECK,
  TENDER_HATCH_FROM_REAR,
  WIND_AIR_ACCEL,
  WIND_WALK_BACK,
  WIND_WALK_FWD,
} from './rules';
import type { CarKind, CarState, Dir, SurfaceKind } from './types';

// ---- Tunables (candidates for rules.ts) ---------------------------------------------------------

/** Each car's end carries half of the bridge plate between it and its neighbour. */
export const COUPLER_HALF = COUPLER_GAP / 2;
/** From a car's end to its body: the half plate, then the end platform. */
export const CAR_END = COUPLER_HALF + PLATFORM_DEPTH;
export const ROOF_THICKNESS = 0.15;
export const END_WALL_THICKNESS = 0.1;
/** The doorway through each car end, from the floor up; the end wall above it blocks. */
export const DOOR_HEIGHT = 2.0;
export const HATCH_HALF_WIDTH = 0.4;
/** Walking climbs a step this high (adjacent cars' floors differ by 0.1 m). */
export const STEP_UP = 0.35;
/** End ladders hang this far out from the body's end wall, over the platform. */
export const LADDER_OUT = 0.15;
/** Ladders against a solid face (the tender's coal bunker) hang this far out, so a climber clears it. */
export const LADDER_CLEAR = RIDER_WIDTH / 2 + 0.02;
/** The cab's ladder hangs this far behind the cab's rear, over the tender deck. */
export const CAB_LADDER_OUT = 0.2;
/** Climbing off a ladder's top puts you this far onto the roof. */
export const LADDER_TOP_IN = 0.35;
/** The coal bunker blocks from below the lowest floor up to the tender top. */
export const BUNKER_Y0 = 1.0;
/** The boiler, domes, stack and smoke: an unwalkable block nobody gets past or over. */
export const BOILER_Y0 = 1.0;
export const BOILER_Y1 = 7.0;
/** Horsemen going for the cab board it this far forward of its rear (the gangway). */
export const CAB_BOARD_IN = 1.0;
/** Where the Rider respawns when there is no car behind the tender: this far along the tender top. */
export const TENDER_RESPAWN_IN = 1.0;
/** A jump's take-off: the centre this far past a roof's end (the feet still on it). */
export const TAKEOFF_OVER = 0.12;
/** Safety margin a planned jump must clear by (bandits only jump when it will work). */
export const JUMP_MARGIN = 0.15;
/** Rough costs (seconds) of navigation moves. */
export const NAV_JUMP_COST = 1.0;
export const NAV_HATCH_DROP_COST = 0.8;
export const NAV_CLIMB_EXTRA = 0.25;
export const NAV_DROP_EXTRA = 0.3;

/** Cars with a roof hatch (spec §5.1). */
const HATCHED: ReadonlySet<CarKind> = new Set<CarKind>(['express', 'boxcar', 'caboose']);

const HALF_W = RIDER_WIDTH / 2;
const EPS = 1e-6;

// ---- Types ------------------------------------------------------------------------------------

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export type SolidKind = 'roof' | 'endWall' | 'cupola' | 'bunker' | 'boiler' | 'cabRoof';

/** A rectangle that blocks movement and train-layer shots. */
export interface Solid extends Rect {
  car: number;
  kind: SolidKind;
}

/** A walkable top, solid from above only. */
export interface Surface {
  kind: SurfaceKind;
  car: number;
  x0: number;
  x1: number;
  y: number;
  /** Surfaces you can walk between without climbing or jumping share a region. */
  region: number;
}

export type LadderKind = 'end' | 'tenderRear' | 'bunker' | 'cab' | 'hatch';

export interface Ladder {
  kind: LadderKind;
  car: number;
  /** Where a climber hangs. */
  x: number;
  /** Feet height at the bottom and at the top. */
  y0: number;
  y1: number;
  /** Where a climber steps off at the top. */
  topX: number;
  /** Surface indices at the bottom and at the top. */
  bottom: number;
  top: number;
}

export interface Doorway {
  car: number;
  end: 'rear' | 'front';
  x: number;
  y0: number;
  y1: number;
}

export interface Hatch {
  car: number;
  x: number;
  x0: number;
  x1: number;
  roofY: number;
  floorY: number;
  /** The ladder under it (climbing out from inside). */
  ladder: number;
}

export interface Interior {
  car: number;
  kind: CarKind;
  x0: number;
  x1: number;
  floorY: number;
  ceilY: number;
}

export interface BoardingPoint {
  car: number;
  x: number;
  y: number;
  into: 'platform' | 'cab';
  end: 'rear' | 'front' | null;
}

export type NavEdgeKind = 'ladderUp' | 'ladderDown' | 'hatchDown' | 'hatchUp' | 'jump' | 'drop';

export interface NavNode {
  x: number;
  y: number;
  region: number;
  tag: string;
}

export interface NavEdge {
  from: number;
  to: number;
  kind: NavEdgeKind;
  /** Seconds, roughly. */
  cost: number;
  /** Which way to move for jumps and drops (0 for climbs). */
  dir: Dir | 0;
  ladder: number | null;
  /** Jumps: how far the centre must travel, and the landing height relative to the take-off. */
  need: number;
  dh: number;
}

export interface NavGraph {
  nodes: NavNode[];
  edges: NavEdge[];
  /** Edge indices leaving / entering each node. */
  out: number[][];
  inn: number[][];
  /** Node indices in each region. */
  byRegion: number[][];
  /** The nodes bandits head for: the safe, the cab, and each boarding point (parallel to `boarding`). */
  safe: number | null;
  cab: number;
  boarding: number[];
}

export interface TrainGeometry {
  key: string;
  length: number;
  surfaces: Surface[];
  solids: Solid[];
  ladders: Ladder[];
  doorways: Doorway[];
  hatches: Hatch[];
  interiors: Interior[];
  /** The express car's safe: the middle of its floor. */
  safe: { car: number; x: number; y: number } | null;
  /** The cab zone (the loco's rear CAB_LENGTH): a bandit here holds the Engineer up. */
  cab: { car: number; x0: number; x1: number; floorY: number; ceilY: number };
  tenderHatchX: number;
  /** Car-end platforms (front to back), then the cab's side. */
  boarding: BoardingPoint[];
  /** The rear-most platform (the tender top without cars behind it). */
  respawn: { x: number; y: number };
  /** The highest roof top (low-bridge beams over gaps sit above it). */
  maxRoofY: number;
  nav: NavGraph;
}

// ---- Construction -----------------------------------------------------------------------------

const cache = new Map<string, TrainGeometry>();
const CACHE_MAX = 32;

function layoutKey(cars: readonly CarState[]): string {
  return cars.map((c) => `${c.kind}:${c.x0.toFixed(4)}:${c.x1.toFixed(4)}`).join('|');
}

/** The geometry of a laid-out consist (cars front to back: loco, tender, then the rest). */
export function trainGeometry(cars: readonly CarState[]): TrainGeometry {
  const key = layoutKey(cars);
  const hit = cache.get(key);
  if (hit) return hit;
  const geo = build(cars, key);
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, geo);
  return geo;
}

type LadderDraft = Omit<Ladder, 'bottom' | 'top'>;

function build(cars: readonly CarState[], key: string): TrainGeometry {
  const surfaces: Surface[] = [];
  const solids: Solid[] = [];
  const drafts: LadderDraft[] = [];
  const doorways: Doorway[] = [];
  const hatchDrafts: Omit<Hatch, 'ladder'>[] = [];
  const hatchLadder: number[] = [];
  const interiors: Interior[] = [];
  const boarding: BoardingPoint[] = [];
  let safe: TrainGeometry['safe'] = null;
  const surface = (kind: SurfaceKind, car: number, x0: number, x1: number, y: number): void => {
    surfaces.push({ kind, car, x0, x1, y, region: -1 });
  };

  // The loco: the cab at its rear, then the boiler, which nobody walks on (spec §5.1).
  const loco = cars[0];
  const ls = CAR_SPECS.loco;
  const cabX1 = loco.x0 + CAB_LENGTH;
  surface('cabFloor', 0, loco.x0, cabX1, ls.floorY);
  surface('cabRoof', 0, loco.x0, cabX1, ls.roofY);
  solids.push({ car: 0, kind: 'cabRoof', x0: loco.x0, x1: cabX1, y0: ls.roofY - ROOF_THICKNESS, y1: ls.roofY });
  solids.push({ car: 0, kind: 'boiler', x0: cabX1, x1: loco.x1, y0: BOILER_Y0, y1: BOILER_Y1 });
  interiors.push({ car: 0, kind: 'loco', x0: loco.x0, x1: cabX1, floorY: ls.floorY, ceilY: ls.roofY - ROOF_THICKNESS });
  drafts.push({ kind: 'cab', car: 0, x: loco.x0 - CAB_LADDER_OUT, y0: ls.floorY, y1: ls.roofY, topX: loco.x0 + LADDER_TOP_IN });

  // The tender: the coal top, and the front deck at cab-floor height that joins the cab.
  const tender = cars[1];
  const ts = CAR_SPECS.tender;
  const deckX0 = tender.x1 - TENDER_DECK;
  surface('tenderTop', 1, tender.x0, deckX0, ts.roofY);
  surface('tenderDeck', 1, deckX0, tender.x1, ts.floorY);
  solids.push({ car: 1, kind: 'bunker', x0: tender.x0, x1: deckX0, y0: BUNKER_Y0, y1: ts.roofY });
  drafts.push({ kind: 'bunker', car: 1, x: deckX0 + LADDER_CLEAR, y0: ts.floorY, y1: ts.roofY, topX: deckX0 - LADDER_TOP_IN });

  // The cars behind the tender.
  for (let i = 2; i < cars.length; i++) {
    const c = cars[i];
    const spec = CAR_SPECS[c.kind];
    const f = spec.floorY;
    const r = spec.roofY;
    const b0 = c.x0 + CAR_END;
    const b1 = c.x1 - CAR_END;
    // Floor level: half plates, platforms, and the floor between the doorways.
    if (i < cars.length - 1) surface('platform', i, c.x0, c.x0 + COUPLER_HALF, f);
    surface('platform', i, c.x0 + COUPLER_HALF, b0, f);
    surface('floor', i, b0, b1, f);
    surface('platform', i, b1, c.x1 - COUPLER_HALF, f);
    surface('platform', i, c.x1 - COUPLER_HALF, c.x1, f);
    // The roof; the caboose's cupola rises over the middle third (spec §5.1).
    solids.push({ car: i, kind: 'roof', x0: b0, x1: b1, y0: r - ROOF_THICKNESS, y1: r });
    if (c.kind === 'caboose') {
      const third = (b1 - b0) / 3;
      surface('roof', i, b0, b0 + third, r);
      surface('cupola', i, b0 + third, b1 - third, CUPOLA_Y);
      surface('roof', i, b1 - third, b1, r);
      solids.push({ car: i, kind: 'cupola', x0: b0 + third, x1: b1 - third, y0: r, y1: CUPOLA_Y });
    } else {
      surface('roof', i, b0, b1, r);
    }
    // End walls above the doorways.
    solids.push({ car: i, kind: 'endWall', x0: b0, x1: b0 + END_WALL_THICKNESS, y0: f + DOOR_HEIGHT, y1: r - ROOF_THICKNESS });
    solids.push({ car: i, kind: 'endWall', x0: b1 - END_WALL_THICKNESS, x1: b1, y0: f + DOOR_HEIGHT, y1: r - ROOF_THICKNESS });
    doorways.push({ car: i, end: 'rear', x: b0, y0: f, y1: f + DOOR_HEIGHT });
    doorways.push({ car: i, end: 'front', x: b1, y0: f, y1: f + DOOR_HEIGHT });
    interiors.push({ car: i, kind: c.kind, x0: b0, x1: b1, floorY: f, ceilY: r - ROOF_THICKNESS });
    drafts.push({ kind: 'end', car: i, x: b0 - LADDER_OUT, y0: f, y1: r, topX: b0 + LADDER_TOP_IN });
    drafts.push({ kind: 'end', car: i, x: b1 + LADDER_OUT, y0: f, y1: r, topX: b1 - LADDER_TOP_IN });
    if (HATCHED.has(c.kind)) {
      // Mid-roof, except on the caboose, whose middle is the cupola: the middle of its rear third.
      const hx = c.kind === 'caboose' ? b0 + (b1 - b0) / 6 : (b0 + b1) / 2;
      hatchLadder.push(drafts.length);
      drafts.push({ kind: 'hatch', car: i, x: hx, y0: f, y1: r, topX: hx });
      hatchDrafts.push({ car: i, x: hx, x0: hx - HATCH_HALF_WIDTH, x1: hx + HATCH_HALF_WIDTH, roofY: r, floorY: f });
    }
    if (c.kind === 'express' && !safe) safe = { car: i, x: (b0 + b1) / 2, y: f };
    boarding.push({ car: i, x: c.x0 + COUPLER_HALF + PLATFORM_DEPTH / 2, y: f, into: 'platform', end: 'rear' });
    boarding.push({ car: i, x: c.x1 - COUPLER_HALF - PLATFORM_DEPTH / 2, y: f, into: 'platform', end: 'front' });
    // The tender's rear ladder rises from the first car's front plate.
    if (i === 2) drafts.push({ kind: 'tenderRear', car: 1, x: tender.x0 - LADDER_CLEAR, y0: f, y1: ts.roofY, topX: tender.x0 + LADDER_TOP_IN });
  }
  boarding.push({ car: 0, x: loco.x0 + CAB_BOARD_IN, y: ls.floorY, into: 'cab', end: null });

  assignRegions(surfaces);
  const ladders: Ladder[] = drafts.map((d) => ({
    ...d,
    bottom: supportIndex(surfaces, d.x, d.y0),
    top: supportIndex(surfaces, d.topX, d.y1),
  }));
  const hatches: Hatch[] = hatchDrafts.map((h, k) => ({ ...h, ladder: hatchLadder[k] }));
  const last = cars[cars.length - 1];
  const respawn =
    cars.length > 2
      ? { x: last.x0 + COUPLER_HALF + PLATFORM_DEPTH / 2, y: CAR_SPECS[last.kind].floorY }
      : { x: tender.x0 + TENDER_RESPAWN_IN, y: ts.roofY };
  let maxRoofY = ls.roofY;
  for (const s of surfaces) if (s.kind === 'roof' || s.kind === 'cupola') maxRoofY = Math.max(maxRoofY, s.y);

  const geo: TrainGeometry = {
    key,
    length: loco.x1,
    surfaces,
    solids,
    ladders,
    doorways,
    hatches,
    interiors,
    safe,
    cab: { car: 0, x0: loco.x0, x1: cabX1, floorY: ls.floorY, ceilY: ls.roofY - ROOF_THICKNESS },
    tenderHatchX: tender.x0 + TENDER_HATCH_FROM_REAR,
    boarding,
    respawn,
    maxRoofY,
    nav: { nodes: [], edges: [], out: [], inn: [], byRegion: [], safe: null, cab: -1, boarding: [] },
  };
  geo.nav = buildNav(geo, cars);
  return geo;
}

/** Union-find over surfaces that touch end to end within a step's height. */
function assignRegions(surfaces: Surface[]): void {
  const parent = surfaces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const a = surfaces[i];
      const b = surfaces[j];
      if (Math.max(a.x0, b.x0) <= Math.min(a.x1, b.x1) + EPS && Math.abs(a.y - b.y) <= STEP_UP + EPS) parent[find(i)] = find(j);
    }
  }
  const ids = new Map<number, number>();
  for (let i = 0; i < surfaces.length; i++) {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    surfaces[i].region = ids.get(root) as number;
  }
}

// ---- The navigation graph (spec §7.3) ---------------------------------------------------------
//
// Nodes are the ends of moves that aren't plain walking: ladder feet and tops, hatch tops and
// bottoms, jump take-offs, plus the places bandits head for. Walking within a region is implicit
// (any node to any node of the same region, at walking pace), so the graph stays small.

function buildNav(geo: TrainGeometry, cars: readonly CarState[]): NavGraph {
  const nodes: NavNode[] = [];
  const edges: NavEdge[] = [];
  const node = (x: number, y: number, tag: string): number => {
    nodes.push({ x, y, region: regionAt(geo, x, y), tag });
    return nodes.length - 1;
  };
  const edge = (from: number, to: number, kind: NavEdgeKind, cost: number, dir: Dir | 0 = 0, ladder: number | null = null, need = 0): void => {
    edges.push({ from, to, kind, cost, dir, ladder, need, dh: nodes[to].y - nodes[from].y });
  };
  const dropCost = (dy: number): number => Math.sqrt((2 * Math.max(0, dy)) / RIDER_GRAVITY) + NAV_DROP_EXTRA;
  /** The node in `region` nearest to x (for where a drop or jump lands). */
  const nearestIn = (region: number, x: number): number => {
    let best = -1;
    for (let n = 0; n < nodes.length; n++) if (nodes[n].region === region && (best < 0 || Math.abs(nodes[n].x - x) < Math.abs(nodes[best].x - x))) best = n;
    return best;
  };

  // Ladders and hatches.
  geo.ladders.forEach((l, li) => {
    const bottom = node(l.x, l.y0, `ladder${li}:bottom`);
    const top = node(l.topX, l.y1, `ladder${li}:top`);
    const climb = (l.y1 - l.y0) / LADDER_SPEED + NAV_CLIMB_EXTRA;
    if (l.kind === 'hatch') {
      edge(bottom, top, 'hatchUp', climb, 0, li);
      edge(top, bottom, 'hatchDown', NAV_HATCH_DROP_COST, 0, li);
    } else {
      edge(bottom, top, 'ladderUp', climb, 0, li);
      edge(top, bottom, 'ladderDown', climb, 0, li);
    }
  });

  // Places bandits head for.
  const safe = geo.safe ? node(geo.safe.x, geo.safe.y, 'safe') : null;
  const cab = node((geo.cab.x0 + geo.cab.x1) / 2, geo.cab.floorY, 'cab');
  const boarding = geo.boarding.map((b, k) => node(b.x, b.y, `board${k}`));

  // Take-offs at the ends of each car's roof, dropping to the platform below. Not off the last
  // car's rear: nothing stands behind its platform to stop you, so walking off that end carries
  // you over the platform and off the train. The way down there is the ladder.
  const rearTakeoff: number[] = [];
  const frontTakeoff: number[] = [];
  for (let i = 2; i < cars.length; i++) {
    const tops = geo.surfaces.filter((s) => s.car === i && s.kind === 'roof');
    const rearRoof = tops.reduce((a, b) => (b.x0 < a.x0 ? b : a));
    const frontRoof = tops.reduce((a, b) => (b.x1 > a.x1 ? b : a));
    const floorY = CAR_SPECS[cars[i].kind].floorY;
    if (i < cars.length - 1) {
      const rr = node(rearRoof.x0 - TAKEOFF_OVER, rearRoof.y, `car${i}:rearEdge`);
      rearTakeoff[i] = rr;
      edge(rr, nearestIn(regionAt(geo, rearRoof.x0 - HALF_W - 0.1, floorY), rearRoof.x0), 'drop', dropCost(rearRoof.y - floorY), -1);
    }
    const fr = node(frontRoof.x1 + TAKEOFF_OVER, frontRoof.y, `car${i}:frontEdge`);
    frontTakeoff[i] = fr;
    edge(fr, nearestIn(regionAt(geo, frontRoof.x1 + HALF_W + 0.1, floorY), frontRoof.x1), 'drop', dropCost(frontRoof.y - floorY), 1);
    // Off either end of the cupola, down onto the roof beside it.
    for (const cu of geo.surfaces.filter((s) => s.car === i && s.kind === 'cupola')) {
      const back = node(cu.x0 - TAKEOFF_OVER, cu.y, `car${i}:cupolaRear`);
      const fwd = node(cu.x1 + TAKEOFF_OVER, cu.y, `car${i}:cupolaFront`);
      edge(back, nearestIn(regionAt(geo, cu.x0 - HALF_W - 0.1, rearRoof.y), cu.x0), 'drop', dropCost(cu.y - rearRoof.y), -1);
      edge(fwd, nearestIn(regionAt(geo, cu.x1 + HALF_W + 0.1, frontRoof.y), cu.x1), 'drop', dropCost(cu.y - frontRoof.y), 1);
    }
  }
  // Gap jumps between neighbouring roofs, both ways; feasibility depends on the wind (navField).
  // The take-offs sit TAKEOFF_OVER past each roof's end; the landing counts once the figure's
  // leading half is over the far roof.
  for (let i = 2; i < cars.length - 1; i++) {
    const a = rearTakeoff[i];
    const b = frontTakeoff[i + 1];
    const need = Math.abs(nodes[b].x - nodes[a].x) + TAKEOFF_OVER - HALF_W + JUMP_MARGIN;
    edge(a, b, 'jump', NAV_JUMP_COST, -1, null, need);
    edge(b, a, 'jump', NAV_JUMP_COST, 1, null, need);
  }
  // From the first car's roof forward, down onto the tender top.
  const tender = cars[1];
  const tenderTop = geo.surfaces.find((s) => s.kind === 'tenderTop') as Surface;
  if (cars.length > 2) {
    const from = frontTakeoff[2];
    const to = nearestIn(tenderTop.region, tender.x0);
    edge(from, to, 'jump', NAV_JUMP_COST, 1, null, tender.x0 - nodes[from].x - HALF_W + JUMP_MARGIN);
    // Off the tender top's rear, down to the plate behind it.
    const off = node(tender.x0 - TAKEOFF_OVER, tenderTop.y, 'tender:rearEdge');
    const below = regionAt(geo, tender.x0 - HALF_W - 0.1, CAR_SPECS[cars[2].kind].floorY);
    edge(off, nearestIn(below, tender.x0), 'drop', dropCost(tenderTop.y - CAR_SPECS[cars[2].kind].floorY), -1);
  }
  // Off the cab roof's rear, down onto the deck.
  const cabRoof = geo.surfaces.find((s) => s.kind === 'cabRoof') as Surface;
  const offCab = node(cabRoof.x0 - TAKEOFF_OVER, cabRoof.y, 'cabRoof:rearEdge');
  edge(offCab, nearestIn(regionAt(geo, cabRoof.x0 - HALF_W - 0.1, geo.cab.floorY), cabRoof.x0), 'drop', dropCost(cabRoof.y - geo.cab.floorY), -1);

  const out: number[][] = nodes.map(() => []);
  const inn: number[][] = nodes.map(() => []);
  edges.forEach((e, k) => {
    out[e.from].push(k);
    inn[e.to].push(k);
  });
  const regions = geo.surfaces.reduce((n, s) => Math.max(n, s.region + 1), 0);
  const byRegion: number[][] = Array.from({ length: regions }, () => []);
  nodes.forEach((n, k) => {
    if (n.region >= 0) byRegion[n.region].push(k);
  });
  return { nodes, edges, out, inn, byRegion, safe, cab, boarding };
}

// ---- Queries ----------------------------------------------------------------------------------

/** Does a figure centred at x (half-width HALF_W) overlap the surface's extent? */
function overlaps(s: { x0: number; x1: number }, x: number): boolean {
  return x + HALF_W > s.x0 + EPS && x - HALF_W < s.x1 - EPS;
}

function supportIndex(surfaces: readonly Surface[], x: number, y: number): number {
  let best = -1;
  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    if (Math.abs(s.y - y) > EPS || !overlaps(s, x)) continue;
    // Prefer the surface under the centre (the doorway threshold belongs to the side you're on).
    if (best < 0 || (x >= s.x0 && x < s.x1)) best = i;
  }
  return best;
}

/** The surface a figure with its feet at (x, y) stands on, or −1. */
export function supportAt(geo: TrainGeometry, x: number, y: number): number {
  return supportIndex(geo.surfaces, x, y);
}

/** The highest surface at or below the feet that a figure at x overlaps, or −1. */
export function groundBelow(geo: TrainGeometry, x: number, y: number): number {
  let best = -1;
  for (let i = 0; i < geo.surfaces.length; i++) {
    const s = geo.surfaces[i];
    if (s.y > y + EPS || !overlaps(s, x)) continue;
    if (best < 0 || s.y > geo.surfaces[best].y + EPS) best = i;
  }
  return best;
}

/** The walk region of what's at or under a point, or −1. */
export function regionAt(geo: TrainGeometry, x: number, y: number): number {
  const s = supportAt(geo, x, y);
  if (s >= 0) return geo.surfaces[s].region;
  const g = groundBelow(geo, x, y);
  return g >= 0 ? geo.surfaces[g].region : -1;
}

/** The interior (a car's inside, or the cab) holding a figure with its feet at (x, y). */
export function interiorAt(geo: TrainGeometry, x: number, y: number): Interior | null {
  for (const n of geo.interiors) if (x >= n.x0 && x <= n.x1 && y >= n.floorY - 0.05 && y < n.ceilY) return n;
  return null;
}

/** The index of the car at train-frame x (the nearest car beyond either end). */
export function carAt(cars: readonly CarState[], x: number): number {
  for (let i = 0; i < cars.length; i++) if (x >= cars[i].x0 && x <= cars[i].x1) return i;
  return x > cars[0].x1 ? 0 : cars.length - 1;
}

/**
 * The distance along a ray (unit direction) to the first solid it enters, or `maxT` if none does
 * sooner. A ray that only grazes a rectangle's edge passes.
 */
export function raySolid(geo: TrainGeometry, ox: number, oy: number, dx: number, dy: number, maxT: number): number {
  let best = maxT;
  for (const s of geo.solids) {
    const t = rayRect(s, ox, oy, dx, dy, best);
    if (t !== null) best = t;
  }
  return best;
}

/** Where a ray first enters a rectangle, within [0, maxT], or null. */
export function rayRect(r: Rect, ox: number, oy: number, dx: number, dy: number, maxT: number): number | null {
  let t0 = 0;
  let t1 = maxT;
  if (Math.abs(dx) < 1e-12) {
    if (ox <= r.x0 || ox >= r.x1) return null;
  } else {
    const a = (r.x0 - ox) / dx;
    const b = (r.x1 - ox) / dx;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  if (Math.abs(dy) < 1e-12) {
    if (oy <= r.y0 || oy >= r.y1) return null;
  } else {
    const a = (r.y0 - oy) / dy;
    const b = (r.y1 - oy) / dy;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 - t0 > 1e-9 ? t0 : null;
}

/** Can a shot pass between two points in the train layer (spec §6.4)? */
export function lineOfSight(geo: TrainGeometry, x0: number, y0: number, x1: number, y1: number): boolean {
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len < 1e-9) return true;
  return raySolid(geo, x0, y0, (x1 - x0) / len, (y1 - y0) / len, len) >= len - 1e-9;
}

// ---- Path costs -------------------------------------------------------------------------------

/**
 * How far a running jump carries (centre travel, metres) by the time the feet come back down to
 * `dh` above the take-off, for a figure walking at `walk` in direction `dir` with the wind
 * (spec §6.3: walking speed changes with the wind, and it pushes on you in the air).
 */
export function jumpReach(walk: number, dir: Dir, windDir: Dir | 0, w: number, dh: number): number {
  const withWind = windDir !== 0 && dir === windDir;
  const vx = walk * (windDir === 0 ? 1 : withWind ? 1 + WIND_WALK_BACK * w : 1 - WIND_WALK_FWD * w);
  const a = windDir === 0 ? 0 : (withWind ? 1 : -1) * WIND_AIR_ACCEL * w;
  const disc = RIDER_JUMP_V * RIDER_JUMP_V - 2 * RIDER_GRAVITY * dh;
  if (disc < 0) return 0;
  const t = (RIDER_JUMP_V + Math.sqrt(disc)) / RIDER_GRAVITY;
  return vx * t + 0.5 * a * t * t;
}

function usable(e: NavEdge, walk: number, windDir: Dir | 0, w: number): boolean {
  if (e.kind !== 'jump') return true;
  return jumpReach(walk, e.dir as Dir, windDir, w, e.dh) >= e.need;
}

/**
 * Travel-time estimates to a goal (a walk region and an x in it) from every nav node, Infinity where
 * unreachable. Jumps the wind won't allow are left out.
 */
export function navField(geo: TrainGeometry, goalRegion: number, goalX: number, walk: number, windDir: Dir | 0, w: number): number[] {
  const { nodes, edges, inn, byRegion } = geo.nav;
  const dist = nodes.map((n) => (n.region === goalRegion ? Math.abs(n.x - goalX) / walk : Infinity));
  const done = nodes.map(() => false);
  for (;;) {
    let u = -1;
    for (let n = 0; n < nodes.length; n++) if (!done[n] && dist[n] < Infinity && (u < 0 || dist[n] < dist[u])) u = n;
    if (u < 0) break;
    done[u] = true;
    const du = dist[u];
    const region = nodes[u].region;
    if (region >= 0) {
      for (const v of byRegion[region]) {
        const d = du + Math.abs(nodes[v].x - nodes[u].x) / walk;
        if (d < dist[v]) dist[v] = d;
      }
    }
    for (const k of inn[u]) {
      const e = edges[k];
      if (!usable(e, walk, windDir, w)) continue;
      const d = du + e.cost;
      if (d < dist[e.from]) dist[e.from] = d;
    }
  }
  return dist;
}

/** Best estimate from (region, x) given a field toward (goalRegion, goalX). */
export function costFrom(geo: TrainGeometry, field: readonly number[], region: number, x: number, goalRegion: number, goalX: number, walk: number): number {
  let best = region === goalRegion ? Math.abs(x - goalX) / walk : Infinity;
  if (region < 0) return best;
  for (const n of geo.nav.byRegion[region]) {
    const d = Math.abs(x - geo.nav.nodes[n].x) / walk + field[n];
    if (d < best) best = d;
  }
  return best;
}

/** Estimated travel time (s) between two points on the train, Infinity if there's no way. */
export function navCost(geo: TrainGeometry, from: { x: number; y: number }, to: { x: number; y: number }, walk = BANDIT_WALK, windDir: Dir | 0 = 0, w = 0): number {
  const rFrom = regionAt(geo, from.x, from.y);
  const rTo = regionAt(geo, to.x, to.y);
  if (rFrom < 0 || rTo < 0) return Infinity;
  const field = navField(geo, rTo, to.x, walk, windDir, w);
  return costFrom(geo, field, rFrom, from.x, rTo, to.x, walk);
}

/** Can a jump edge be made in this wind? Exposed for the bandits' planner. */
export function edgeUsable(e: NavEdge, walk: number, windDir: Dir | 0, w: number): boolean {
  return usable(e, walk, windDir, w);
}
