import { describe, expect, it } from 'vitest';
import { netIndex } from '../src/sim/network';
import { routeDistanceAt, routeLength, routeMainPos, routePoint, routeSpans, timeAtRouteDistance } from '../src/sim/schedule';
import type { AiTrainDef } from '../src/sim/types';
import { loopRun } from './fixtures';

// No. 7 runs east→west on the loop network: in at E, out at W, along the main line.
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

describe('schedule', () => {
  const run = loopRun({ aiTrains: [freight] });
  const ix = netIndex(run);

  it('measures the route', () => {
    expect(routeLength(ix, freight)).toBe(2400);
  });

  it('gives the front distance along the route at a clock time, with dwells', () => {
    expect(routeDistanceAt(freight, 900)).toBeLessThan(0); // not entered yet
    expect(routeDistanceAt(freight, 1000)).toBe(0);
    expect(routeDistanceAt(freight, 1020)).toBe(200);
    expect(routeDistanceAt(freight, 1050)).toBe(500); // arrives at the stop
    expect(routeDistanceAt(freight, 1070)).toBe(500); // dwelling
    expect(routeDistanceAt(freight, 1080)).toBe(500);
    expect(routeDistanceAt(freight, 1090)).toBe(600);
  });

  it('inverts: the clock time the front reaches a route distance', () => {
    expect(timeAtRouteDistance(freight, 200)).toBe(1020);
    expect(timeAtRouteDistance(freight, 500)).toBe(1050); // arrival, not departure
    expect(timeAtRouteDistance(freight, 600)).toBe(1090);
  });

  it('finds the track point at a route distance', () => {
    expect(routePoint(ix, freight, 0)).toEqual({ edge: 'm3', off: 1000, dir: -1 });
    expect(routePoint(ix, freight, 1200)).toEqual({ edge: 'm2', off: 200, dir: -1 });
    expect(routePoint(ix, freight, 2400)).toEqual({ edge: 'm1', off: 0, dir: -1 });
  });

  it('gives the occupied spans (rear → front) for a front distance, clipped to the route', () => {
    expect(routeSpans(ix, freight, 100)).toEqual([{ edge: 'm3', from: 1000, to: 900 }]);
    expect(routeSpans(ix, freight, 1050)).toEqual([
      { edge: 'm3', from: 100, to: 0 },
      { edge: 'm2', from: 400, to: 350 },
    ]);
    expect(routeSpans(ix, freight, -5)).toEqual([]); // not on the map yet
    expect(routeSpans(ix, freight, 2500)).toEqual([{ edge: 'm1', from: 50, to: 0 }]); // the rear still on the map
    expect(routeSpans(ix, freight, 2600)).toEqual([]); // gone
  });

  it('projects the front onto the main line', () => {
    expect(routeMainPos(ix, freight, 1200)).toBe(1200);
    expect(routeMainPos(ix, freight, 100)).toBe(2300);
  });
});
