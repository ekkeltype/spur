import { describe, expect, it } from 'vitest';
import { newGame } from '../src/sim/game';
import { lineOfSight, navCost, trainGeometry, type Surface, type TrainGeometry } from '../src/sim/geometry';
import type { CarState, CarType } from '../src/sim/types';
import { yRun } from './fixtures';

function carsOf(consist: CarType[]): CarState[] {
  return newGame(yRun(), { seed: 1, consist, upgrades: [], assists: { rider: false, engineer: false } }).train.cars;
}

const ALL_KINDS: CarType[] = ['express', 'passenger', 'boxcar', 'armored', 'caboose', 'powder'];

function surfaces(geo: TrainGeometry, kind: Surface['kind'], car?: number): Surface[] {
  return geo.surfaces.filter((s) => s.kind === kind && (car === undefined || s.car === car));
}

/** [x0, x1, y] of each surface, for compact comparisons. */
function spans(list: Surface[]): [number, number, number][] {
  return list.map((s) => [s.x0, s.x1, s.y] as [number, number, number]).sort((a, b) => a[0] - b[0]);
}

function close(list: [number, number, number][]): [number, number, number][] {
  return list.map(([a, b, c]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000, Math.round(c * 1000) / 1000]);
}

// Express + boxcar: L = 53. Loco [37, 53], tender [28, 37], express [13, 28], boxcar [0, 13].
// Each car's outer 0.3 m is half a bridge plate, then a 0.5 m platform, then the body.

describe('train geometry: the parts of each car (spec §5.1)', () => {
  it('lays out the cab, the tender and a car with platforms, bridge plates, a body and a roof', () => {
    const geo = trainGeometry(carsOf(['express', 'boxcar']));
    expect(geo.length).toBe(53);
    expect(close(spans(surfaces(geo, 'cabFloor')))).toEqual([[37, 41.5, 1.4]]);
    expect(close(spans(surfaces(geo, 'cabRoof')))).toEqual([[37, 41.5, 4]]);
    expect(close(spans(surfaces(geo, 'tenderTop')))).toEqual([[28, 36, 2.8]]);
    expect(close(spans(surfaces(geo, 'tenderDeck')))).toEqual([[36, 37, 1.4]]);
    expect(close(spans(surfaces(geo, 'roof', 2)))).toEqual([[13.8, 27.2, 4.2]]);
    expect(close(spans(surfaces(geo, 'floor', 2)))).toEqual([[13.8, 27.2, 1.2]]);
    // Rear half-plate, rear platform, front platform, front half-plate.
    expect(close(spans(surfaces(geo, 'platform', 2)))).toEqual([
      [13, 13.3, 1.2],
      [13.3, 13.8, 1.2],
      [27.2, 27.7, 1.2],
      [27.7, 28, 1.2],
    ]);
    // The last car has no bridge plate behind it: the train's rear is open.
    expect(close(spans(surfaces(geo, 'platform', 3)))).toEqual([
      [0.3, 0.8, 1.3],
      [12.2, 12.7, 1.3],
      [12.7, 13, 1.3],
    ]);
    // The boiler is not walkable.
    expect(geo.surfaces.some((s) => s.x1 > 41.5 + 1e-9)).toBe(false);
  });

  it('leaves a 1.6 m gap between adjacent roofs for every car kind', () => {
    const cars = carsOf(ALL_KINDS);
    const geo = trainGeometry(cars);
    for (let i = 2; i < cars.length - 1; i++) {
      const tops = (car: number) => geo.surfaces.filter((s) => s.car === car && (s.kind === 'roof' || s.kind === 'cupola'));
      const frontCarStart = Math.min(...tops(i).map((s) => s.x0));
      const rearCarEnd = Math.max(...tops(i + 1).map((s) => s.x1));
      expect(frontCarStart - rearCarEnd).toBeCloseTo(1.6, 9);
    }
  });

  it('keeps floor level walkable from the rear platform to the tender, and the tender deck joined to the cab', () => {
    for (const consist of [ALL_KINDS, ['express'] as CarType[], ['caboose', 'powder'] as CarType[]]) {
      const cars = carsOf(consist);
      const geo = trainGeometry(cars);
      const floor = geo.surfaces.filter((s) => s.kind === 'platform' || s.kind === 'floor').sort((a, b) => a.x0 - b.x0);
      expect(floor[0].x0).toBeCloseTo(0.3, 9);
      expect(floor[floor.length - 1].x1).toBeCloseTo(cars[1].x0, 9);
      for (let i = 1; i < floor.length; i++) {
        expect(floor[i].x0).toBeLessThanOrEqual(floor[i - 1].x1 + 1e-9);
        expect(Math.abs(floor[i].y - floor[i - 1].y)).toBeLessThanOrEqual(0.1 + 1e-9);
      }
      expect(new Set(floor.map((s) => s.region)).size).toBe(1);
      const deck = surfaces(geo, 'tenderDeck')[0];
      const cabFloor = surfaces(geo, 'cabFloor')[0];
      expect(deck.region).toBe(cabFloor.region);
      expect(surfaces(geo, 'tenderTop')[0].region).not.toBe(deck.region);
      expect(floor[0].region).not.toBe(deck.region);
    }
  });

  it('puts the caboose cupola over the middle third of its roof', () => {
    const geo = trainGeometry(carsOf(['caboose']));
    // Caboose [0, 10]: body [0.8, 9.2], 8.4 m long.
    expect(close(spans(surfaces(geo, 'cupola', 2)))).toEqual([[3.6, 6.4, 4.7]]);
    expect(close(spans(surfaces(geo, 'roof', 2)))).toEqual([
      [0.8, 3.6, 4],
      [6.4, 9.2, 4],
    ]);
  });

  it('has end ladders, doorways and an interior on every car, and hatches on the express, boxcar and caboose', () => {
    const cars = carsOf(ALL_KINDS);
    const geo = trainGeometry(cars);
    for (let i = 2; i < cars.length; i++) {
      const c = cars[i];
      const body = [c.x0 + 0.8, c.x1 - 0.8];
      const floorY = geo.surfaces.find((s) => s.car === i && s.kind === 'floor')!.y;
      const roofs = geo.surfaces.filter((s) => s.car === i && s.kind === 'roof');
      const ends = geo.ladders.filter((l) => l.car === i && l.kind === 'end');
      expect(ends.length).toBe(2);
      for (const l of ends) {
        expect(l.y0).toBe(floorY);
        expect(roofs.some((r) => r.y === l.y1)).toBe(true);
      }
      const doors = geo.doorways.filter((d) => d.car === i).map((d) => d.x).sort((a, b) => a - b);
      expect(doors[0]).toBeCloseTo(body[0], 9);
      expect(doors[1]).toBeCloseTo(body[1], 9);
      const inner = geo.interiors.filter((n) => n.car === i);
      expect(inner.length).toBe(1);
      expect(inner[0].x0).toBeCloseTo(body[0], 9);
      expect(inner[0].x1).toBeCloseTo(body[1], 9);
      expect(inner[0].floorY).toBe(floorY);
      const hatched = c.kind === 'express' || c.kind === 'boxcar' || c.kind === 'caboose';
      expect(geo.hatches.filter((h) => h.car === i).length).toBe(hatched ? 1 : 0);
    }
    // The express hatch is over the middle of its body; the caboose's clears the cupola.
    const exp = geo.hatches.find((h) => cars[h.car].kind === 'express')!;
    expect(exp.x).toBeCloseTo((cars[exp.car].x0 + cars[exp.car].x1) / 2, 9);
    const cab = geo.hatches.find((h) => cars[h.car].kind === 'caboose')!;
    const cupola = geo.surfaces.find((s) => s.kind === 'cupola')!;
    expect(cab.x1).toBeLessThan(cupola.x0);
  });

  it('climbs onto the tender from the first car, down from the tender top to the deck, and up to the cab roof', () => {
    const geo = trainGeometry(carsOf(['express', 'boxcar']));
    const byKind = (k: string) => geo.ladders.filter((l) => l.kind === k);
    expect(byKind('tenderRear').map((l) => [l.y0, l.y1])).toEqual([[1.2, 2.8]]);
    expect(byKind('bunker').map((l) => [l.y0, l.y1])).toEqual([[1.4, 2.8]]);
    expect(byKind('cab').map((l) => [l.y0, l.y1])).toEqual([[1.4, 4]]);
    // Every ladder starts and ends on something walkable.
    for (const l of geo.ladders) {
      const bottom = geo.surfaces[l.bottom];
      const top = geo.surfaces[l.top];
      expect(bottom.y).toBe(l.y0);
      expect(top.y).toBe(l.y1);
      expect(l.x + 0.3).toBeGreaterThan(bottom.x0);
      expect(l.x - 0.3).toBeLessThan(bottom.x1);
      expect(l.topX).toBeGreaterThanOrEqual(top.x0);
      expect(l.topX).toBeLessThanOrEqual(top.x1);
    }
    // Without cars behind the tender, there is no rear ladder to climb.
    const bare = trainGeometry(carsOf([]));
    expect(bare.ladders.some((l) => l.kind === 'tenderRear')).toBe(false);
  });

  it('places the safe, the cab zone, the tender hatch, the boarding points and the respawn point', () => {
    const geo = trainGeometry(carsOf(['express', 'boxcar']));
    expect(geo.safe).toEqual({ car: 2, x: 20.5, y: 1.2 });
    expect(geo.cab.car).toBe(0);
    expect(geo.cab.x0).toBe(37);
    expect(geo.cab.x1).toBeCloseTo(41.5, 9);
    expect(geo.tenderHatchX).toBe(30);
    expect(geo.respawn.x).toBeCloseTo(0.55, 9);
    expect(geo.respawn.y).toBe(1.3);
    const platforms = geo.boarding.filter((b) => b.into === 'platform');
    expect(platforms.map((b) => [b.car, b.end, Math.round(b.x * 100) / 100, b.y])).toEqual([
      [2, 'rear', 13.55, 1.2],
      [2, 'front', 27.45, 1.2],
      [3, 'rear', 0.55, 1.3],
      [3, 'front', 12.45, 1.3],
    ]);
    const cabPoints = geo.boarding.filter((b) => b.into === 'cab');
    expect(cabPoints.length).toBe(1);
    expect(cabPoints[0].x).toBeGreaterThan(37);
    expect(cabPoints[0].x).toBeLessThan(41.5);
    expect(cabPoints[0].y).toBe(1.4);
    expect(trainGeometry(carsOf(['boxcar'])).safe).toBeNull();
    // Nothing behind the tender: respawn on the tender top.
    const bare = trainGeometry(carsOf([]));
    expect(bare.respawn.y).toBe(2.8);
    expect(bare.boarding.map((b) => b.into)).toEqual(['cab']);
  });

  it('is cached by the layout', () => {
    const cars = carsOf(['express', 'boxcar']);
    const a = trainGeometry(cars);
    expect(trainGeometry(cars.map((c) => ({ ...c })))).toBe(a);
    expect(trainGeometry(carsOf(['boxcar', 'express']))).not.toBe(a);
  });
});

describe('train geometry: line of sight (spec §6.4)', () => {
  const geo = trainGeometry(carsOf(['express', 'boxcar']));

  it('is blocked by a roof and by the tender, but not through a doorway or across a roof gap', () => {
    // From the express roof (feet 4.2, shoulder 5.55) down into the express.
    expect(lineOfSight(geo, 20, 5.55, 22, 2.1)).toBe(false);
    // From the express's rear platform through its doorway into the car.
    expect(lineOfSight(geo, 13.55, 2.55, 18, 2.1)).toBe(true);
    // Roof to roof across the gap.
    expect(lineOfSight(geo, 11, 5.35, 15, 5.55)).toBe(true);
    // From the tender deck to the bridge plate behind the tender: the coal bunker is in the way.
    expect(lineOfSight(geo, 36.5, 2.75, 27.85, 2.55)).toBe(false);
    // Over the tender top.
    expect(lineOfSight(geo, 27, 5.55, 38, 5.35)).toBe(true);
  });
});

describe('train geometry: the navigation graph (spec §7.3)', () => {
  it('connects every boarding point to the safe and to the cab, for every car kind', () => {
    for (const consist of [ALL_KINDS, ['express', 'boxcar'] as CarType[], ['caboose', 'express'] as CarType[], ['powder'] as CarType[]]) {
      const geo = trainGeometry(carsOf(consist));
      const cabPoint = { x: (geo.cab.x0 + geo.cab.x1) / 2, y: geo.cab.floorY };
      for (const b of geo.boarding) {
        if (geo.safe) expect(navCost(geo, b, geo.safe)).toBeLessThan(120);
        expect(navCost(geo, b, cabPoint)).toBeLessThan(120);
      }
      // And from every roof to the cab and back to the rear platform.
      for (const s of geo.surfaces.filter((q) => q.kind === 'roof' || q.kind === 'cupola' || q.kind === 'cabRoof' || q.kind === 'tenderTop')) {
        const from = { x: (s.x0 + s.x1) / 2, y: s.y };
        expect(navCost(geo, from, cabPoint)).toBeLessThan(120);
        expect(navCost(geo, from, geo.respawn)).toBeLessThan(120);
      }
    }
  });

  it('walks within a region, and jumps roof gaps only when the wind allows', () => {
    const geo = trainGeometry(carsOf(['express', 'boxcar']));
    // Same roof: just the walk.
    expect(navCost(geo, { x: 15, y: 4.2 }, { x: 22.6, y: 4.2 }, 3.8)).toBeCloseTo(2, 9);
    // Boxcar roof to express roof (forward, toward the loco): a jump in still air…
    const calm = navCost(geo, { x: 10, y: 4 }, { x: 16, y: 4.2 }, 3.8, 0, 0);
    // …but into a strong headwind, the long way round by the ladders.
    const windy = navCost(geo, { x: 10, y: 4 }, { x: 16, y: 4.2 }, 3.8, -1, 1.4);
    expect(calm).toBeLessThan(5);
    expect(windy).toBeGreaterThan(calm + 1);
    expect(windy).toBeLessThan(30);
    // With the wind at your back the jump backward still works.
    expect(navCost(geo, { x: 16, y: 4.2 }, { x: 10, y: 4 }, 3.8, -1, 1.4)).toBeLessThan(5);
  });

  it('only plans a gap jump that clears the gap: take-off 0.12 m past the edge, 1.6 m across, landing half a body in', () => {
    const geo = trainGeometry(carsOf(['express', 'boxcar']));
    // A bandit (3.8 m/s) at w = 1 (25 m/s) jumping forward and 0.2 m up reaches about 1.16 m: short
    // of the 1.6 − 0.12 − 0.3 = 1.18 m it needs.
    const calm = navCost(geo, { x: 10, y: 4 }, { x: 16, y: 4.2 }, 3.8, 0, 0);
    expect(navCost(geo, { x: 10, y: 4 }, { x: 16, y: 4.2 }, 3.8, -1, 1)).toBeGreaterThan(calm + 1);
    // At w = 0.5 it reaches about 1.95 m: jump.
    expect(navCost(geo, { x: 10, y: 4 }, { x: 16, y: 4.2 }, 3.8, -1, 0.5)).toBeCloseTo(calm, 9);
  });
});
