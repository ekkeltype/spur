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
import { SPOUT_WINDOW, STATION_WINDOW } from '../../sim/rules';
import type { Dir, FlagState, Span, SwitchState, TrackHead, TrackPoint } from '../../sim/types';

const EPS = 1e-6;

export type AheadKind = 'tunnel' | 'lowBridge' | 'trestle' | 'curve' | 'signal' | 'junction' | 'station' | 'water' | 'end' | 'flag';

export interface AheadItem {
  kind: AheadKind;
  /** Feature id (the node id for junctions and ends, the flag's id for flags). */
  id: string;
  name: string;
  /** Metres from the train's leading end; 0 when it's already on a tunnel, trestle or curve. */
  dist: number;
  /** Tunnels, trestles and curves the leading end is already on: metres until it's off. */
  until?: number;
  /** Tunnels, trestles and curves: their length. */
  length?: number;
  /** Curves: the speed limit (m/s). */
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
}

/** Order for items at the same distance: what the train meets first physically. */
const KIND_ORDER: Record<AheadKind, number> = {
  flag: 0,
  signal: 1,
  junction: 2,
  curve: 3,
  lowBridge: 4,
  tunnel: 5,
  trestle: 6,
  water: 7,
  station: 8,
  end: 9,
};

/**
 * The next items along the route from `head` (the loco's front, or the rear when backing up),
 * following the switches as they are now (spec §4.1, §11). This steps edge by edge with nextEdge,
 * the same stepping network.walk does, so each junction crossing knows the edge it arrives on
 * (facing or trailing).
 */
export function buildAhead(ix: NetIndex, switches: Record<string, SwitchState>, head: TrackHead, opts: AheadOptions = {}): AheadItem[] {
  const max = opts.max ?? 6;
  const range = opts.range ?? 8000;
  const hatchBack = opts.hatchBack ?? 0;
  const flags = opts.flags ?? [];
  const items: AheadItem[] = [];
  const seen = new Set<string>();
  const add = (key: string, item: AheadItem): void => {
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  let edgeId = head.edge;
  let off = head.off;
  let dir: Dir = head.dir;
  let acc = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const e = edgeOf(ix, edgeId);
    const room = dir === 1 ? e.length - off : off;
    const take = Math.max(0, Math.min(room, range - acc));
    scanEdge(ix, edgeId, off, dir, take, acc, flags, hatchBack, opts.destination, add);
    acc += take;
    if (acc >= range - EPS || take < room - EPS) break;
    const nodeId = dir === 1 ? e.b : e.a;
    const nx = nextEdge(ix, switches, edgeId, nodeId);
    if (!nx) {
      const node = ix.node.get(nodeId);
      add(`n:${nodeId}`, { kind: 'end', id: nodeId, name: node?.label ?? 'End of track', dist: acc });
      break;
    }
    if (nx.junction) {
      const j = ix.junction.get(nx.junction);
      if (j) {
        add(`j:${j.node}:${acc.toFixed(1)}`, {
          kind: 'junction',
          id: j.node,
          name: j.name,
          dist: acc,
          junction: { state: switchOf(ix, switches, j.node), facing: edgeId === j.trunk, leg: nx.head.edge, against: nx.trailing !== null },
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

/** Collects the features on one stretch of an edge: from `off`, `take` metres in direction `dir`, starting `acc` metres from the leading end. */
function scanEdge(
  ix: NetIndex,
  edgeId: string,
  off: number,
  dir: Dir,
  take: number,
  acc: number,
  flags: readonly FlagState[],
  hatchBack: number,
  destination: string | undefined,
  add: (key: string, item: AheadItem) => void,
): void {
  const f = ix.features.get(edgeId);
  /** Distance along this stretch to an offset on the edge (negative = behind its start). */
  const along = (o: number): number => (o - off) * dir;
  /** Points count only strictly ahead: the one under the leading end is "here", not "ahead". */
  const pointAhead = (o: number): number | null => {
    const d = along(o);
    return d > EPS && d <= take + EPS ? acc + d : null;
  };
  /** A range [from, to]: its entry distance and, if the leading end is already on it, how long until it's off. */
  const rangeAhead = (from: number, to: number): { dist: number; until?: number } | null => {
    const a = along(from);
    const b = along(to);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi <= EPS || lo > take + EPS) return null;
    if (lo <= EPS) return acc === 0 ? { dist: 0, until: hi } : { dist: acc };
    return { dist: acc + lo };
  };

  if (f) {
    for (const t of f.tunnels) {
      const r = rangeAhead(t.from, t.to);
      if (r) add(`t:${t.id}`, { kind: 'tunnel', id: t.id, name: t.name, ...r, length: Math.abs(t.to - t.from) });
    }
    for (const t of f.trestles) {
      const r = rangeAhead(t.from, t.to);
      if (r) add(`r:${t.id}`, { kind: 'trestle', id: t.id, name: t.name, ...r, length: Math.abs(t.to - t.from), ...(t.burning ? { minSpeed: t.burning.minSpeed } : {}) });
    }
    for (const c of f.curves) {
      const r = rangeAhead(c.from, c.to);
      if (r) add(`c:${c.id}`, { kind: 'curve', id: c.id, name: 'Curve', ...r, length: Math.abs(c.to - c.from), limit: c.limit });
    }
    for (const b of f.lowBridges) {
      const d = pointAhead(b.at);
      if (d !== null) add(`b:${b.id}`, { kind: 'lowBridge', id: b.id, name: b.name ?? 'Low bridge', dist: d });
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
