// Other trains (spec §10): scheduled trains running to their timetable, the runaway rolling through
// the Engineer's switches, and collisions with the player's train. Scheduled trains are a pure
// function of the clock (schedule.ts), so a restored checkpoint puts them back exactly; only the
// runaway is simulated tick by tick.

import {
  edgeOf,
  framePath,
  frameX,
  frontHead,
  gradeAt,
  mainPos,
  moveSpans,
  netIndex,
  pathCrosses,
  spansFromFront,
  spansLength,
  spansOverlap,
  xOnSpans,
  type NetIndex,
} from './network';
import { DT, GRAVITY, RUNAWAY_ACCEL, RUNAWAY_MAX, TICK_HZ } from './rules';
import { routeDistanceAt, routeLength, routeSpans } from './schedule';
import type { AiTrainDef, AiTrainState, GameState, RunDef, SimEvent, Span, TickMotion, TrackPoint } from './types';

/** Height (m above the rails) at which collision and wreck explosions are drawn in the train frame. */
export const EXPLOSION_HEIGHT = 2;
/** How far along the track, either way, an event is placed on the train's own line (see frameXOf). */
export const EVENT_RANGE = 3000;

const EPS = 1e-6;

/** Every other train, off the map until its timetable (or its trigger) brings it on. */
export function initialTraffic(run: RunDef): AiTrainState[] {
  return run.aiTrains.map((t) => ({ id: t.id, active: false, done: false, spans: [], v: 0, started: false, wrecked: false }));
}

/** Clock (s since midnight) at the state's tick. */
function clockOf(state: GameState): number {
  return state.clock0 + state.tick / TICK_HZ;
}

// ---------------------------------------------------------------------------------------------
// Scheduled trains (spec §10.1)
// ---------------------------------------------------------------------------------------------

/** A scheduled train at a clock time: the track it occupies (empty while off the map) and its speed (0 while it dwells). */
export function scheduledAt(ix: NetIndex, def: AiTrainDef, clock: number): { spans: Span[]; v: number } {
  const front = routeDistanceAt(def, clock);
  const moving = front - routeDistanceAt(def, clock - DT) > EPS;
  return { spans: routeSpans(ix, def, front), v: moving ? def.speed : 0 };
}

function stepScheduled(ix: NetIndex, def: AiTrainDef, ai: AiTrainState, clock: number, events: SimEvent[]): void {
  const now = scheduledAt(ix, def, clock);
  ai.spans = now.spans;
  ai.v = now.spans.length > 0 ? now.v : 0;
  if (now.spans.length > 0) {
    if (!ai.active) {
      ai.active = true;
      events.push({ type: 'aiEntered', id: def.id });
    }
    return;
  }
  if (ai.active) {
    // Its rear has left the route: gone for good.
    ai.active = false;
    ai.done = true;
    events.push({ type: 'aiLeft', id: def.id });
  } else if (routeDistanceAt(def, clock) - def.length >= routeLength(ix, def) - EPS) {
    // It ran its whole route before the run began: it never appears.
    ai.done = true;
  }
}

// ---------------------------------------------------------------------------------------------
// The runaway (spec §10.2)
// ---------------------------------------------------------------------------------------------

/** Moves the runaway one tick; true if it ran into an end node (the caller wrecks it after the collision check). */
function stepRunaway(ix: NetIndex, state: GameState, def: AiTrainDef, ai: AiTrainState, motion: TickMotion, events: SimEvent[]): boolean {
  const rw = def.runaway;
  if (!rw) return false;
  if (!ai.started) {
    // Set off by the player's loco passing its trigger moving forward (the front path is empty when backing).
    if (!pathCrosses(motion.frontPath, rw.trigger)) return false;
    ai.started = true;
    ai.active = true;
    ai.v = 0;
    ai.spans = spansFromFront(ix, state.switches, { edge: rw.start.edge, off: rw.start.off, dir: rw.dir }, def.length);
    events.push({ type: 'runawayLoose', id: def.id });
  }
  if (ai.spans.length === 0) return false;
  // Its own push plus gravity along the grade under its front: faster downhill, slower uphill. A
  // grade too steep for it holds it where it stands; it never rolls back.
  const front = frontHead(ai.spans);
  const a = RUNAWAY_ACCEL - GRAVITY * gradeAt(ix, front) * front.dir;
  ai.v = Math.min(RUNAWAY_MAX, Math.max(0, ai.v + a * DT));
  // It follows the switches as they are now, so the Engineer can divert it (spec §10.2), and springs
  // any it trails through against it, just as the player's train does (spec §4.1).
  const m = moveSpans(ix, state.switches, ai.spans, ai.v * DT);
  ai.spans = m.spans;
  for (const t of m.trails) {
    state.switches[t.junction] = t.state;
    events.push({ type: 'switchThrown', junction: t.junction, state: t.state, by: 'trailing' });
  }
  return m.blocked;
}

/**
 * Train-frame x of a track point (spec §6.1): along the train's own line (following the switches)
 * within EVENT_RANGE; else by main-line distance when both are charted, the way the Rider's
 * trackside view places a train on a parallel track; else null.
 */
export function frameXOf(state: GameState, run: RunDef, p: TrackPoint): number | null {
  const ix = netIndex(run);
  const t = state.train;
  const x = frameX(framePath(ix, state.switches, t.spans, EVENT_RANGE, EVENT_RANGE), p);
  if (x !== null) return x;
  const front = frontHead(t.spans);
  const e = edgeOf(ix, front.edge);
  const ours = mainPos(ix, front);
  const theirs = mainPos(ix, p);
  if (!e.mainAt || ours === null || theirs === null) return null;
  const slope = Math.sign(e.mainAt[1] - e.mainAt[0]) * front.dir;
  return slope === 0 ? null : t.length + (theirs - ours) * slope;
}

/** Hit the buffers: a big bang, then it's gone for good (spec §10.2). */
function wreck(state: GameState, run: RunDef, ai: AiTrainState, events: SimEvent[]): void {
  const x = frameXOf(state, run, frontHead(ai.spans));
  events.push({ type: 'runawayWrecked', id: ai.id });
  events.push({ type: 'explosion', what: 'runaway', x: x ?? 0, y: x === null ? 0 : EXPLOSION_HEIGHT });
  ai.active = false;
  ai.done = true;
  ai.wrecked = true;
  ai.spans = [];
  ai.v = 0;
}

// ---------------------------------------------------------------------------------------------
// Collisions (spec §10.1: any overlap with another train's occupied track is a loss)
// ---------------------------------------------------------------------------------------------

/** Where two occupancies touch: a point in the overlap, and the overlap's extent from each one's rear. */
interface Contact {
  point: TrackPoint;
  ours: [number, number];
  theirs: [number, number];
}

function contactOf(ours: readonly Span[], theirs: readonly Span[]): Contact | null {
  let point: TrackPoint | null = null;
  const a: [number, number] = [Infinity, -Infinity];
  const b: [number, number] = [Infinity, -Infinity];
  const widen = (range: [number, number], spans: readonly Span[], p: TrackPoint): void => {
    const x = xOnSpans(spans, p);
    if (x === null) return;
    range[0] = Math.min(range[0], x);
    range[1] = Math.max(range[1], x);
  };
  for (const s of ours) {
    for (const t of theirs) {
      if (t.edge !== s.edge) continue;
      const lo = Math.max(Math.min(s.from, s.to), Math.min(t.from, t.to));
      const hi = Math.min(Math.max(s.from, s.to), Math.max(t.from, t.to));
      if (hi - lo <= EPS) continue;
      point ??= { edge: s.edge, off: (lo + hi) / 2 };
      for (const off of [lo, hi]) {
        widen(a, ours, { edge: s.edge, off });
        widen(b, theirs, { edge: s.edge, off });
      }
    }
  }
  return point ? { point, ours: a, theirs: b } : null;
}

export type TrainEnd = 'front' | 'rear' | 'side';

/** Which part of a train an overlap [lo, hi] (m from its rear) touches: its front wins when both ends are in it. */
function endOf(range: [number, number], length: number): TrainEnd {
  if (range[1] >= length - 0.01) return 'front';
  if (range[0] <= 0.01) return 'rear';
  return 'side';
}

/** The nearest named place to a point: the edge's own name, else the nearest station or junction. */
function placeNear(ix: NetIndex, run: RunDef, p: TrackPoint): string | null {
  const e = edgeOf(ix, p.edge);
  if (e.name) return e.name;
  const places: { name: string; at: TrackPoint }[] = run.stations.map((s) => ({ name: s.name, at: { edge: s.edge, off: s.at } }));
  for (const j of run.junctions) {
    for (const inc of ix.incident.get(j.node) ?? []) places.push({ name: j.name, at: { edge: inc.edge, off: inc.end === 'a' ? 0 : edgeOf(ix, inc.edge).length } });
  }
  const here = mainPos(ix, p);
  let best: string | null = null;
  let bestD = Infinity;
  for (const pl of places) {
    let d: number | null = null;
    if (pl.at.edge === p.edge) d = Math.abs(pl.at.off - p.off);
    else {
      const there = mainPos(ix, pl.at);
      if (here !== null && there !== null) d = Math.abs(there - here);
    }
    if (d !== null && d < bestD) {
      best = pl.name;
      bestD = d;
    }
  }
  return best;
}

const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Ends a sentence with a full stop, unless it already ends in one (a place like "Red Rock Jct."). */
const sentence = (s: string): string => (s.endsWith('.') ? s : `${s}.`);

/** One sentence for the results screen, e.g. "Met No. 7 Freight head-on near Mesa Loop." */
export function collisionDetail(name: string, ours: TrainEnd, theirs: TrainEnd, place: string | null): string {
  const near = place ? ` near ${place}` : '';
  if (ours === 'front' && theirs === 'front') return sentence(`Met ${name} head-on${near}`);
  if (ours === 'front') return sentence(theirs === 'rear' ? `Ran into the back of ${name}${near}` : `Ran into ${name}${near}`);
  if (theirs === 'front') return sentence(ours === 'rear' ? `${capitalized(name)} ran into the back of the train${near}` : `${capitalized(name)} struck the train${near}`);
  return sentence(`Collided with ${name}${near}`);
}

function checkCollisions(ix: NetIndex, state: GameState, run: RunDef, events: SimEvent[]): void {
  const ours = state.train.spans;
  for (const ai of state.ai) {
    if (state.phase !== 'running') return;
    if (!ai.active || !spansOverlap(ai.spans, ours)) continue;
    const def = run.aiTrains.find((d) => d.id === ai.id);
    const c = contactOf(ours, ai.spans);
    const name = def?.name ?? ai.id;
    const detail = c
      ? collisionDetail(name, endOf(c.ours, spansLength(ours)), endOf(c.theirs, spansLength(ai.spans)), placeNear(ix, run, c.point))
      : `Collided with ${name}.`;
    const x = c ? (xOnSpans(ours, c.point) ?? 0) : 0;
    state.phase = 'lost';
    state.loss = { reason: 'collision', detail };
    events.push({ type: 'collision', with: ai.id });
    events.push({ type: 'explosion', what: 'collision', x, y: EXPLOSION_HEIGHT });
    events.push({ type: 'lost', reason: 'collision', detail });
  }
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/** One tick of the other trains (spec §15 step 8). Runs after the player's train has moved. */
export function stepTraffic(state: GameState, run: RunDef, motion: TickMotion, events: SimEvent[]): void {
  const ix = netIndex(run);
  const clock = clockOf(state);
  const wrecks: AiTrainState[] = [];
  for (const def of run.aiTrains) {
    const ai = state.ai.find((a) => a.id === def.id);
    if (!ai || ai.done) continue;
    if (def.kind === 'runaway') {
      if (stepRunaway(ix, state, def, ai, motion, events)) wrecks.push(ai);
    } else stepScheduled(ix, def, ai, clock, events);
  }
  // A runaway reaching the buffers still counts for collisions this tick: it hit whatever stood there.
  checkCollisions(ix, state, run, events);
  for (const ai of wrecks) wreck(state, run, ai, events);
}

// ---------------------------------------------------------------------------------------------
// Telegrams (spec §11: the Engineer's log)
// ---------------------------------------------------------------------------------------------

/** The id of the telegram that warns of a runaway once it breaks loose. */
export const runawayTelegramId = (def: AiTrainDef): string => `${def.id}-loose`;

/**
 * Sends each telegram once: at its clock time or when the loco's front passes its point moving
 * forward, whichever comes first, and a runaway's warning when it breaks loose (spec §10.2). Runs
 * after stepTraffic, so the warning goes out on the tick the runaway starts.
 */
export function stepTelegrams(state: GameState, run: RunDef, motion: TickMotion, events: SimEvent[]): void {
  if (state.phase !== 'running') return;
  const clock = clockOf(state);
  const send = (id: string, text: string): void => {
    if (state.telegramsSent.includes(id)) return;
    state.telegramsSent.push(id);
    events.push({ type: 'telegram', id, text });
  };
  for (const t of run.telegrams) {
    if ((t.clock !== undefined && clock >= t.clock) || (t.at !== undefined && pathCrosses(motion.frontPath, t.at))) send(t.id, t.text);
  }
  for (const def of run.aiTrains) {
    if (def.runaway && state.ai.find((a) => a.id === def.id)?.started) send(runawayTelegramId(def), def.runaway.telegram);
  }
}
