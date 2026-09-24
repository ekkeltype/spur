// Timetable math for scheduled trains (spec §10.1): where a train's front is along its route at a
// clock time (constant speed with dwells), the track it occupies, and its main-line position.
// Pure functions of the AiTrainDef and the clock, shared by the sim, the views and the Engineer's chart.

import { edgeOf, mainPos, type NetIndex } from './network';
import type { AiTrainDef, Span, TrackHead } from './types';

const EPS = 1e-9;

/** Total length of the route (m). */
export function routeLength(ix: NetIndex, def: AiTrainDef): number {
  let n = 0;
  for (const leg of def.route) n += edgeOf(ix, leg.edge).length;
  return n;
}

/**
 * The front's distance along the route at `clock` (s since midnight). Negative before departure
 * (the train hasn't entered the map). The front waits `dwell` seconds on reaching each stop.
 */
export function routeDistanceAt(def: AiTrainDef, clock: number): number {
  let t = clock - def.depart;
  if (t < 0) return t * def.speed;
  let at = 0;
  for (const stop of def.stops) {
    const travel = (stop.at - at) / def.speed;
    if (t < travel) return at + t * def.speed;
    t -= travel;
    if (t <= stop.dwell) return stop.at;
    t -= stop.dwell;
    at = stop.at;
  }
  return at + t * def.speed;
}

/** When the front first reaches route distance `s` (arrival, before any dwell there). */
export function timeAtRouteDistance(def: AiTrainDef, s: number): number {
  let clock = def.depart;
  let at = 0;
  for (const stop of def.stops) {
    if (s <= stop.at + EPS) return clock + (s - at) / def.speed;
    clock += (stop.at - at) / def.speed + stop.dwell;
    at = stop.at;
  }
  return clock + (s - at) / def.speed;
}

/** The track point at route distance `s` (clamped to the route), heading along the route. */
export function routePoint(ix: NetIndex, def: AiTrainDef, s: number): TrackHead {
  let left = Math.max(0, s);
  for (let i = 0; i < def.route.length; i++) {
    const leg = def.route[i];
    const len = edgeOf(ix, leg.edge).length;
    if (left <= len + EPS || i === def.route.length - 1) {
      const d = Math.min(left, len);
      return { edge: leg.edge, off: leg.dir === 1 ? d : len - d, dir: leg.dir };
    }
    left -= len;
  }
  throw new Error(`Train ${def.id} has an empty route`);
}

/**
 * The track a train occupies with its front at route distance `front`: from front − length to
 * front, clipped to the route, rear → front. Empty before it enters and after its rear has left.
 */
export function routeSpans(ix: NetIndex, def: AiTrainDef, front: number): Span[] {
  const total = routeLength(ix, def);
  const hi = Math.min(front, total);
  const lo = Math.max(0, front - def.length);
  if (hi - lo <= EPS) return [];
  const spans: Span[] = [];
  let legStart = 0;
  for (const leg of def.route) {
    const len = edgeOf(ix, leg.edge).length;
    const a = Math.max(lo, legStart);
    const b = Math.min(hi, legStart + len);
    if (b - a > EPS) {
      const offA = leg.dir === 1 ? a - legStart : len - (a - legStart);
      const offB = leg.dir === 1 ? b - legStart : len - (b - legStart);
      spans.push({ edge: leg.edge, from: offA, to: offB });
    }
    legStart += len;
  }
  return spans;
}

/** Main-line distance of the point at route distance `s`, or null off the main line. */
export function routeMainPos(ix: NetIndex, def: AiTrainDef, s: number): number | null {
  return mainPos(ix, routePoint(ix, def, s));
}
