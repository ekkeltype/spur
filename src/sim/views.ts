// What each seat gets (spec §2, §16.3). toEngineerRun, toEngineerView and filterForEngineer are the
// only producers of what the Engineer's browser receives; tests/views.test.ts checks nothing hidden
// leaks through them. trackside() places the track around the train in the train frame for the
// Rider's renderer (and nothing else).

import { edgeOf, framePath, frameRange, frameX, frontHead, limitAt, mainPos, netIndex, pointAt, spanDir, spanLength, spansOverlap, type NetIndex } from './network';
import { DWELL_SECONDS, TENDER_HATCH_FROM_REAR, TICK_HZ } from './rules';
import { aspectOf } from './signals';
import type { EngineerEvent, EngineerRun, EngineerView, GameState, RunDef, SimEvent, Span, TracksideItem } from './types';

// ---------------------------------------------------------------------------------------------
// The Engineer
// ---------------------------------------------------------------------------------------------

/** The run as the Engineer may know it: no obstacles, waves, runaway, variants or plan. */
export function toEngineerRun(run: RunDef): EngineerRun {
  const { obstacles: _o, waves: _w, plan: _p, variants: _v, ...rest } = run;
  return { ...rest, aiTrains: run.aiTrains.filter((t) => t.charted && t.kind !== 'runaway') };
}

/** The tender's water hatch on the track (spec §5.5). */
export function hatchPoint(state: GameState): { edge: string; off: number } {
  const t = state.train;
  const tender = t.cars[1];
  const p = pointAt(t.spans, tender.x0 + TENDER_HATCH_FROM_REAR);
  return { edge: p.edge, off: p.off };
}

/** The track distance within which charted trains show on the Engineer's map. */
function inSight(ix: NetIndex, state: GameState, spans: readonly Span[], range: number): boolean {
  if (spans.length === 0) return false;
  const fp = framePath(ix, state.switches, state.train.spans, range, range);
  if (spansOverlap(fp.spans, spans)) return true;
  const ours = mainPos(ix, frontHead(state.train.spans));
  const theirs = mainPos(ix, frontHead(spans));
  return ours !== null && theirs !== null && Math.abs(ours - theirs) <= range;
}

export function toEngineerView(state: GameState, run: RunDef, sightRange = 1500): EngineerView {
  const ix = netIndex(run);
  const t = state.train;
  const front = frontHead(t.spans);
  const restriction = state.signals.restriction?.limit ?? Infinity;
  const stop = t.stationStop;
  const r = state.rider;
  const roof = r.surface === 'roof' || r.surface === 'cabRoof' || r.surface === 'tenderTop' || r.surface === 'cupola';
  const charted = new Set(run.aiTrains.filter((d) => d.charted && d.kind !== 'runaway').map((d) => d.id));
  return {
    tick: state.tick,
    clock: state.clock0 + state.tick / TICK_HZ,
    phase: state.phase,
    loss: state.loss ? { ...state.loss } : null,
    train: {
      spans: t.spans.map((s) => ({ ...s })),
      length: t.length,
      v: t.v,
      throttle: t.throttle,
      brake: t.brake,
      reverser: t.reverser,
      fire: t.fire,
      pressure: t.pressure,
      water: t.water,
      waterCap: t.waterCap,
      whistle: t.whistle,
      heldUp: t.heldUp,
      overspeed: t.overspeed,
      safetyValve: t.safetyValve,
      spout: t.spout,
      stationStop: stop ? { stationId: stop.stationId, progress: stop.done ? 1 : Math.min(1, stop.ticks / (DWELL_SECONDS * TICK_HZ)) } : null,
      lastStation: t.lastStation,
      mainPos: mainPos(ix, front),
      hatch: hatchPoint(state),
      limit: Math.min(limitAt(ix, front), restriction),
    },
    switches: { ...state.switches },
    trains: state.ai
      .filter((a) => a.active && charted.has(a.id) && inSight(ix, state, a.spans, sightRange))
      .map((a) => ({ id: a.id, spans: a.spans.map((s) => ({ ...s })), mainPos: mainPos(ix, frontHead(a.spans)) })),
    flags: state.flags.map((f) => ({ ...f, point: { ...f.point } })),
    rider: { car: r.car, roof, mode: r.mode },
    fines: state.stats.fines,
    cargo: state.loot.status === 'stolen' ? 'stolen' : 'ok',
    sideJobs: state.sideJobs.map((j) => ({ ...j })),
  };
}

const ENGINEER_EVENTS = new Set<SimEvent['type']>([
  'switchThrown',
  'whistle',
  'overspeed',
  'safetyValve',
  'lowWater',
  'stationArrived',
  'stationDone',
  'checkpoint',
  'spout',
  'waterFull',
  'tunnelEnter',
  'tunnelExit',
  'fordEnter',
  'fordExit',
  'signalPassed',
  'fine',
  'telegram',
  'sideJob',
  'flagPlaced',
  'heldUp',
  'holdupEnded',
  'riderOff',
  'riderDown',
  'riderBack',
  'lootStolen',
  'lootRecovered',
  'collision',
  'won',
  'lost',
]);

/**
 * The Engineer's copy of an event, or null if they don't get it. Shots become muffled `gunfire`
 * (loudness only; the host rate-limits these). `signalPassed` loses its aspect.
 */
export function filterForEngineer(e: SimEvent): EngineerEvent | null {
  if (e.type === 'shot') return { type: 'gunfire', intensity: e.by === 'rider' ? 0.6 : 0.4 };
  if (!ENGINEER_EVENTS.has(e.type)) return null;
  // The Engineer learns that a signal was passed, never what it showed.
  if (e.type === 'signalPassed') return { type: 'signalPassed', id: e.id };
  return { ...e } as EngineerEvent;
}

// ---------------------------------------------------------------------------------------------
// The Rider: the track around the train, in the train frame (spec §6.1, §18.2)
// ---------------------------------------------------------------------------------------------

/**
 * Everything trackside within `behind` metres of the rear and `ahead` metres of the front (following
 * the switches), placed in the train frame, for the Rider's renderer and HUD.
 */
export function trackside(state: GameState, run: RunDef, behind: number, ahead: number): TracksideItem[] {
  const ix = netIndex(run);
  const t = state.train;
  const fp = framePath(ix, state.switches, t.spans, behind, ahead);
  const L = t.length;
  const items: TracksideItem[] = [];

  // Terrain and the nodes between the path's spans.
  let acc = fp.x0;
  fp.spans.forEach((s, i) => {
    const e = edgeOf(ix, s.edge);
    const len = spanLength(s);
    items.push({ kind: 'terrain', x0: acc, x1: acc + len, terrain: e.terrain, edge: e.id, edgeKind: e.kind });
    if (i < fp.spans.length - 1) {
      const nodeId = spanDir(s) === 1 ? e.b : e.a;
      const j = ix.junction.get(nodeId);
      if (j) items.push({ kind: 'junction', id: j.node, x: acc + len, state: state.switches[j.node] ?? j.initial, name: j.name });
    }
    acc += len;
  });

  const seen = new Set<string>();
  const once = (key: string): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  for (const s of fp.spans) {
    const f = ix.features.get(s.edge);
    if (!f) continue;
    const dir = spanDir(s);
    for (const tn of f.tunnels) {
      const r = frameRange(fp, tn.edge, tn.from, tn.to);
      if (r && once(`t:${tn.id}`)) items.push({ kind: 'tunnel', id: tn.id, x0: r[0], x1: r[1], name: tn.name });
    }
    for (const b of f.lowBridges) {
      const x = frameX(fp, { edge: b.edge, off: b.at });
      if (x !== null && once(`b:${b.id}`)) items.push({ kind: 'lowBridge', id: b.id, x });
    }
    for (const tr of f.trestles) {
      const r = frameRange(fp, tr.edge, tr.from, tr.to);
      if (r && once(`r:${tr.id}`)) items.push({ kind: 'trestle', id: tr.id, x0: r[0], x1: r[1], name: tr.name, burning: !!tr.burning });
    }
    for (const fd of f.fords) {
      const r = frameRange(fp, fd.edge, fd.from, fd.to);
      if (r && once(`f:${fd.id}`)) items.push({ kind: 'ford', id: fd.id, x0: r[0], x1: r[1], name: fd.name });
    }
    for (const st of f.stations) {
      const x = frameX(fp, { edge: st.edge, off: st.at });
      if (x !== null && once(`s:${st.id}`)) items.push({ kind: 'station', id: st.id, x, platform: st.platform, name: st.name });
    }
    for (const w of f.waterTowers) {
      const x = frameX(fp, { edge: w.edge, off: w.at });
      if (x !== null && once(`w:${w.id}`)) items.push({ kind: 'water', id: w.id, x, spoutDown: t.spout === 'down' && t.spoutTower === w.id });
    }
    for (const sg of f.signals) {
      const x = frameX(fp, { edge: sg.edge, off: sg.at });
      if (x !== null && once(`g:${sg.id}`)) {
        items.push({ kind: 'signal', id: sg.id, x, facing: sg.facing === dir ? 'toward' : 'away', heads: sg.kind === 'junction' ? 2 : 1, aspect: aspectOf(state, run, sg.id) });
      }
    }
    for (const m of f.mileposts) {
      const x = frameX(fp, { edge: m.edge, off: m.at });
      if (x !== null && once(`m:${m.edge}:${m.at}`)) items.push({ kind: 'milepost', x, mile: m.mile });
    }
    for (const c of f.curves) {
      const r = frameRange(fp, c.edge, c.from, c.to);
      if (r && once(`c:${c.id}`)) items.push({ kind: 'curve', id: c.id, x0: r[0], x1: r[1], limit: c.limit });
    }
  }

  for (const o of state.obstacles) {
    if (o.state === 'gone') continue;
    const x = frameX(fp, { edge: o.edge, off: o.at });
    if (x !== null) items.push({ kind: 'obstacle', id: o.id, x, obstacle: o.kind, state: o.state, calm: o.kind === 'cattle' && o.state === 'present' && o.calmTicks > 0 });
  }

  // Other trains: on our own track they're placed along the path; on a parallel track (a loop or
  // siding beside us) by main-line distance.
  const front = frontHead(t.spans);
  const ourMain = mainPos(ix, front);
  const e0 = edgeOf(ix, front.edge);
  const slope = e0.mainAt ? Math.sign(e0.mainAt[1] - e0.mainAt[0]) * front.dir : 0;
  const lo = fp.x0;
  const hi = L + ahead;
  for (const a of state.ai) {
    if (!a.active || a.spans.length === 0) continue;
    const def = run.aiTrains.find((d) => d.id === a.id);
    if (!def) continue;
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const s of a.spans) {
      const r = frameRange(fp, s.edge, Math.min(s.from, s.to), Math.max(s.from, s.to));
      if (r) {
        x0 = Math.min(x0, r[0]);
        x1 = Math.max(x1, r[1]);
      }
    }
    if (x0 <= x1) {
      items.push({ kind: 'train', id: a.id, x0, x1, lane: 'same', ai: def.kind, v: a.v, cars: def.cars });
      continue;
    }
    if (ourMain === null || slope === 0) continue;
    for (const s of a.spans) {
      const m0 = mainPos(ix, { edge: s.edge, off: s.from });
      const m1 = mainPos(ix, { edge: s.edge, off: s.to });
      if (m0 === null || m1 === null) continue;
      const xa = L + (m0 - ourMain) * slope;
      const xb = L + (m1 - ourMain) * slope;
      x0 = Math.min(x0, xa, xb);
      x1 = Math.max(x1, xa, xb);
    }
    if (x0 <= x1 && x1 >= lo && x0 <= hi) items.push({ kind: 'train', id: a.id, x0, x1, lane: 'adjacent', ai: def.kind, v: a.v, cars: def.cars });
  }
  return items;
}
