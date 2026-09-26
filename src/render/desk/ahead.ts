// What lies ahead (spec §11): the "Ahead" list the Engineer reads out ("Tunnel in 5 seconds!") and
// the precision-stop readout for stations and water towers. Pure functions of the network, the
// switches and where the train is.

import {
  edgeOf,
  frontHead,
  nextEdge,
  spansLength,
  switchOf,
  walk,
  xOnSpans,
  type NetIndex,
} from '../../sim/network';
import { BRAKE_MAX, EMERGENCY_BRAKE, SPOUT_WINDOW, STATION_WINDOW } from '../../sim/rules';
import type { Dir, FlagState, Span, SwitchState, TrackHead, TrackPoint } from '../../sim/types';

const EPS = 1e-6;

export type AheadKind = 'tunnel' | 'ford' | 'lowBridge' | 'trestle' | 'curve' | 'signal' | 'junction' | 'station' | 'water' | 'end' | 'flag';

/**
 * The hazards to the people on the train (spec §4.3): they sweep the whole train, so they stay in
 * the list until its trailing end is past them, not just the loco.
 */
export const TRAIN_HAZARDS: ReadonlySet<AheadKind> = new Set(['tunnel', 'ford', 'lowBridge']);

export interface AheadItem {
  kind: AheadKind;
  /** Feature id (the node id for junctions and ends, the flag's id for flags). */
  id: string;
  name: string;
  /** Metres from the train's leading end; 0 when the train is already on it (see `until`). */
  dist: number;
  /**
   * Set when the train is already on it: metres until it's off. Tunnels, fords and low bridges
   * count until the trailing end is past them (with `trainLength`), trestles and curves until the
   * leading end is.
   */
  until?: number;
  /** Tunnels, fords, trestles and curves: their length. */
  length?: number;
  /** Curves, and junctions whose switch leads onto slower track (a siding, a cutoff): the speed limit there (m/s). */
  limit?: number;
  /** Burning trestles: cross at no less than this (m/s). */
  minSpeed?: number;
  /** Junctions: how the switch is set, whether the move is facing (from the trunk), the edge the train takes, and whether a trailing move runs against the switch (it springs over). */
  junction?: { state: SwitchState; facing: boolean; leg: string; against: boolean };
  /** Stations. */
  destination?: boolean;
  checkpoint?: boolean;
  waterColumn?: boolean;
  /** Signals: a junction signal's junction (node id). */
  guards?: string;
  /** Water towers: `dist` is measured to the tender hatch, not the leading end. */
  hatch?: boolean;
}

export interface AheadOptions {
  /** At most this many items, nearest first (default 6, spec §11). */
  max?: number;
  /** How far along the track to look, metres (default 8000). */
  range?: number;
  /** Metres from the leading end back to the tender's water hatch: water towers are measured to it (spec §5.5). */
  hatchBack?: number;
  /** The Rider's flags (spec §6.5): they mark something the Rider saw on the line. */
  flags?: readonly FlagState[];
  /** The contract's destination station id. */
  destination?: string;
  /**
   * The train's length behind the leading end (m). Tunnels, fords and low bridges then stay listed,
   * at distance 0, until the trailing end is past them: the Rider on the last car is still in the
   * water after the loco is out of it.
   */
  trainLength?: number;
}

/** Order for items at the same distance: what the train meets first physically. */
const KIND_ORDER: Record<AheadKind, number> = {
  flag: 0,
  signal: 1,
  junction: 2,
  curve: 3,
  lowBridge: 4,
  tunnel: 5,
  ford: 6,
  trestle: 7,
  water: 8,
  station: 9,
  end: 10,
};

const reverse = (h: TrackHead): TrackHead => ({ edge: h.edge, off: h.off, dir: h.dir === 1 ? -1 : 1 });

/**
 * The next items along the route from `head` (the loco's front, or the rear when backing up),
 * following the switches as they are now (spec §4.1, §11). This steps edge by edge with nextEdge,
 * the same stepping network.walk does, so each junction crossing knows the edge it arrives on
 * (facing or trailing). With `trainLength` the scan starts at the trailing end, so what the train
 * is still passing through is found too.
 */
export function buildAhead(ix: NetIndex, switches: Record<string, SwitchState>, head: TrackHead, opts: AheadOptions = {}): AheadItem[] {
  const max = opts.max ?? 6;
  const range = opts.range ?? 8000;
  const items: AheadItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, item: AheadItem): void => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  // Distances are from the leading end, so the trailing end is at `tail` ≤ 0. Walking back along the
  // train follows the switches, which match the train's path: a switch under a train can't be
  // thrown, and a trailing move springs it.
  let start = head;
  let tail = 0;
  if ((opts.trainLength ?? 0) > EPS) {
    const back = walk(ix, switches, reverse(head), opts.trainLength ?? 0);
    start = reverse(back.end);
    tail = -back.walked;
  }
  const ctx: ScanCtx = { ix, flags: opts.flags ?? [], hatchBack: opts.hatchBack ?? 0, destination: opts.destination, tail, add };

  let edgeId = start.edge;
  let off = start.off;
  let dir: Dir = start.dir;
  let acc = tail;
  for (let guard = 0; guard < 1000; guard++) {
    const e = edgeOf(ix, edgeId);
    const room = dir === 1 ? e.length - off : off;
    const take = Math.max(0, Math.min(room, range - acc));
    scanEdge(ctx, edgeId, off, dir, take, acc);
    acc += take;
    if (acc >= range - EPS || take < room - EPS) break;
    const nodeId = dir === 1 ? e.b : e.a;
    const nx = nextEdge(ix, switches, edgeId, nodeId);
    if (!nx) {
      const node = ix.node.get(nodeId);
      add(`n:${nodeId}`, { kind: 'end', id: nodeId, name: node?.label ?? 'End of track', dist: Math.max(0, acc) });
      break;
    }
    // A junction under the train, behind its leading end, is already decided.
    if (nx.junction && acc >= -EPS) {
      const j = ix.junction.get(nx.junction);
      if (j) {
        // Slower track beyond the switch: its limit applies the moment the loco crosses (spec §5.4).
        const legLimit = edgeOf(ix, nx.head.edge).speedLimit;
        add(`j:${j.node}:${acc.toFixed(1)}`, {
          kind: 'junction',
          id: j.node,
          name: j.name,
          dist: acc,
          junction: { state: switchOf(ix, switches, j.node), facing: edgeId === j.trunk, leg: nx.head.edge, against: nx.trailing !== null },
          ...(legLimit < e.speedLimit - EPS ? { limit: legLimit } : {}),
        });
      }
    }
    edgeId = nx.head.edge;
    off = nx.head.off;
    dir = nx.head.dir;
  }
  items.sort((a, b) => a.dist - b.dist || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  return items.slice(0, max);
}

interface ScanCtx {
  ix: NetIndex;
  flags: readonly FlagState[];
  hatchBack: number;
  destination: string | undefined;
  /** The trailing end's distance from the leading end (≤ 0). */
  tail: number;
  add: (key: string, item: AheadItem) => void;
}

/**
 * Collects the features on one stretch of an edge: from `off`, `take` metres in direction `dir`,
 * starting `acc` metres from the leading end (negative while the stretch is under the train).
 */
function scanEdge(ctx: ScanCtx, edgeId: string, off: number, dir: Dir, take: number, acc: number): void {
  const { ix, flags, hatchBack, destination, tail, add } = ctx;
  const f = ix.features.get(edgeId);
  /** Distance along this stretch to an offset on the edge (negative = behind its start). */
  const along = (o: number): number => (o - off) * dir;
  /** Points count only strictly ahead: the one under the leading end is "here", not "ahead". */
  const pointAhead = (o: number): number | null => {
    const d = along(o);
    return d > EPS && d <= take + EPS && acc + d > EPS ? acc + d : null;
  };
  /** A beam over the line: listed until the trailing end is under it (with `until`, once the leading end is past). */
  const beamAhead = (o: number): { dist: number; until?: number } | null => {
    const d = along(o);
    if (d <= EPS || d > take + EPS) return null;
    return acc + d > EPS ? { dist: acc + d } : { dist: 0, until: acc + d - tail };
  };
  /**
   * A range [from, to]: its entry distance and, if the train is already on it, how long until it's
   * off: the whole train for the hazards to the people on it, the leading end for the rest.
   */
  const rangeAhead = (from: number, to: number, wholeTrain: boolean): { dist: number; until?: number } | null => {
    const a = along(from);
    const b = along(to);
    const lo = acc + Math.min(a, b);
    const hi = acc + Math.max(a, b);
    if (hi <= acc + EPS || lo > acc + take + EPS) return null; // not on this stretch
    if (lo > EPS) return { dist: lo };
    if (!wholeTrain) return hi > EPS ? { dist: 0, until: hi } : null;
    return { dist: 0, until: hi - tail };
  };

  if (f) {
    for (const t of f.tunnels) {
      const r = rangeAhead(t.from, t.to, true);
      if (r) add(`t:${t.id}`, { kind: 'tunnel', id: t.id, name: t.name, ...r, length: Math.abs(t.to - t.from) });
    }
    for (const fd of f.fords) {
      const r = rangeAhead(fd.from, fd.to, true);
      if (r) add(`d:${fd.id}`, { kind: 'ford', id: fd.id, name: fd.name, ...r, length: Math.abs(fd.to - fd.from) });
    }
    for (const t of f.trestles) {
      const r = rangeAhead(t.from, t.to, false);
      if (r) add(`r:${t.id}`, { kind: 'trestle', id: t.id, name: t.name, ...r, length: Math.abs(t.to - t.from), ...(t.burning ? { minSpeed: t.burning.minSpeed } : {}) });
    }
    for (const c of f.curves) {
      const r = rangeAhead(c.from, c.to, false);
      if (r) add(`c:${c.id}`, { kind: 'curve', id: c.id, name: 'Curve', ...r, length: Math.abs(c.to - c.from), limit: c.limit });
    }
    for (const b of f.lowBridges) {
      const r = beamAhead(b.at);
      if (r) add(`b:${b.id}`, { kind: 'lowBridge', id: b.id, name: b.name ?? 'Low bridge', ...r });
    }
    for (const s of f.signals) {
      if (s.facing !== dir) continue; // it governs the other direction: the Rider sees its back
      const d = pointAhead(s.at);
      if (d === null) continue;
      const guards = s.kind === 'junction' ? s.junction : undefined;
      const name = s.name ?? (guards ? `Signal for ${ix.junction.get(guards)?.name ?? 'the junction'}` : 'Block signal');
      add(`g:${s.id}`, { kind: 'signal', id: s.id, name, dist: d, ...(guards ? { guards } : {}) });
    }
    for (const s of f.stations) {
      const d = pointAhead(s.at);
      if (d === null) continue;
      add(`s:${s.id}`, {
        kind: 'station',
        id: s.id,
        name: s.name,
        dist: d,
        ...(s.id === destination ? { destination: true } : {}),
        ...(s.checkpoint ? { checkpoint: true } : {}),
        ...(s.waterColumn ? { waterColumn: true } : {}),
      });
    }
    for (const w of f.waterTowers) {
      const d = pointAhead(w.at);
      if (d !== null) add(`w:${w.id}`, { kind: 'water', id: w.id, name: w.name ?? 'Water tower', dist: d + hatchBack, hatch: true });
    }
  }
  for (const fl of flags) {
    if (fl.point.edge !== edgeId) continue;
    const d = pointAhead(fl.point.off);
    if (d !== null) add(`f:${fl.id}`, { kind: 'flag', id: String(fl.id), name: "The Rider's flag", dist: d });
  }
}

// ---------------------------------------------------------------------------------------------
// Slower limits coming up (spec §5.4, §11)
// ---------------------------------------------------------------------------------------------

/** The braking the advice counts on (m/s²): the lever at the top of its service range, no emergency. */
const ADVICE_DECEL = BRAKE_MAX * EMERGENCY_BRAKE;
/** Say "brake now" with this much of the braking distance still in hand. */
const ADVICE_MARGIN = 1.15;

/**
 * What a slower limit `dist` metres ahead asks of a train at `speed` (m/s): nothing, slow down, or
 * brake now (service braking only just stops the overspeed in the distance left).
 */
export function slowAdvice(dist: number, speed: number, limit: number): 'ok' | 'slow' | 'brake' {
  if (speed <= limit * 1.02) return 'ok';
  const need = (speed * speed - limit * limit) / (2 * ADVICE_DECEL);
  return dist <= need * ADVICE_MARGIN ? 'brake' : 'slow';
}

// ---------------------------------------------------------------------------------------------
// The precision-stop readout (spec §5.5, §5.6, §11)
// ---------------------------------------------------------------------------------------------

export interface StopTarget {
  kind: 'station' | 'water';
  id: string;
  name: string;
  /**
   * Signed metres to the mark along the train's heading, + while it's still ahead: from the loco's
   * front to a station's stop mark, from the tender hatch to a water spout.
   */
  dist: number;
  /** ± metres that count as on the mark. */
  window: number;
}

export interface StopOptions {
  /** Look this far past the loco's front (default 500 m). */
  ahead?: number;
  /** Keep a mark overrun by up to this much (default 40 m). */
  behind?: number;
  kinds?: readonly ('station' | 'water')[];
  /** The station whose stop was just completed: forgotten once it's behind the loco's front, so pulling out isn't read as an overshoot. */
  done?: string | null;
}

/** The station or water tower nearest the train's stopping point, or null when none is in reach. */
export function stopTarget(ix: NetIndex, switches: Record<string, SwitchState>, spans: readonly Span[], hatch: TrackPoint, opts: StopOptions = {}): StopTarget | null {
  if (spans.length === 0) return null;
  const ahead = opts.ahead ?? 500;
  const behind = opts.behind ?? 40;
  const kinds = opts.kinds ?? ['station', 'water'];
  const L = spansLength(spans);
  const hatchX = xOnSpans(spans, hatch) ?? L;
  const fwd = walk(ix, switches, frontHead(spans), ahead).spans;
  /** Train-frame x of a point (0 = rear, L = front), on the train or ahead of it; null elsewhere. */
  const xOf = (p: TrackPoint): number | null => {
    const on = xOnSpans(spans, p);
    if (on !== null) return on;
    const d = xOnSpans(fwd, p);
    return d === null ? null : L + d;
  };
  let best: StopTarget | null = null;
  const consider = (t: StopTarget): void => {
    if (t.dist < -behind || t.dist > ahead + L) return;
    if (!best || Math.abs(t.dist) < Math.abs(best.dist)) best = t;
  };
  if (kinds.includes('station')) {
    for (const s of ix.run.stations) {
      const x = xOf({ edge: s.edge, off: s.at });
      if (x === null || (s.id === opts.done && x - L < -STATION_WINDOW)) continue;
      consider({ kind: 'station', id: s.id, name: s.name, dist: x - L, window: STATION_WINDOW });
    }
  }
  if (kinds.includes('water')) {
    for (const w of ix.run.waterTowers) {
      const x = xOf({ edge: w.edge, off: w.at });
      if (x !== null) consider({ kind: 'water', id: w.id, name: w.name ?? 'Water tower', dist: x - hatchX, window: SPOUT_WINDOW });
    }
  }
  return best;
}
