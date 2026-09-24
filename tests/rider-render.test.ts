// Pure helpers behind the Rider's view (spec §18.2): the camera and its inverse, parallax layers,
// gait cycles, tick interpolation, signal looks (§9.1), the sky's time of day and car layout.

import { describe, expect, it } from 'vitest';
import { approach, makeCamera, placeCamera, RAIL_FRACTION, screenX, screenY, VIEW_HEIGHT_M, worldX, worldY } from '../src/render/rider/camera';
import { trainLook } from '../src/render/rider/cars';
import { advancePhase, gallopLegs, kneeBend, legSwing, TickInterp } from '../src/render/rider/motion';
import { hash01, layerRange, layerScreenX, tileSpan, wrap } from '../src/render/rider/parallax';
import { lampLetter, signalHeads } from '../src/render/rider/signal-look';
import { skyAt } from '../src/render/rider/sky';
import { trainGeometry } from '../src/sim/geometry';
import { CAB_LENGTH, CAR_SPECS, COUPLER_GAP, CUPOLA_Y, PLATFORM_DEPTH, TENDER_DECK } from '../src/sim/rules';
import type { CarState } from '../src/sim/types';

const close = (a: number, b: number, eps = 1e-9): void => {
  expect(Math.abs(a - b)).toBeLessThan(eps);
};

describe('camera', () => {
  it('shows 19 m of height with the rail tops at 76 % of the height', () => {
    const cam = makeCamera(1280, 720, 30);
    close(cam.k, 720 / VIEW_HEIGHT_M);
    close(screenY(cam, 0), 720 * RAIL_FRACTION);
    // Top and bottom edges of the view in metres.
    close(worldY(cam, 0) - worldY(cam, 720), VIEW_HEIGHT_M);
    close(worldY(cam, 0), VIEW_HEIGHT_M * RAIL_FRACTION);
  });

  it('centres the view on the camera x', () => {
    const cam = makeCamera(1920, 1080, 42.5);
    close(screenX(cam, 42.5), 960);
    close(worldX(cam, 960), 42.5);
  });

  it('inverts exactly, shake included', () => {
    const cam = makeCamera(1600, 900, 0);
    for (const [cx, sx, sy] of [
      [12.3, 0, 0],
      [-40, 4.5, -3.25],
      [700.25, -9, 7],
    ]) {
      placeCamera(cam, 1600, 900, cx, sx, sy);
      for (const [x, y] of [
        [cx, 0],
        [cx - 13.7, 4.2],
        [cx + 9.1, -2.5],
      ]) {
        close(worldX(cam, screenX(cam, x)), x, 1e-9);
        close(worldY(cam, screenY(cam, y)), y, 1e-9);
      }
      for (const [px, py] of [
        [0, 0],
        [1600, 900],
        [333.3, 512.7],
      ]) {
        close(screenX(cam, worldX(cam, px)), px, 1e-9);
        close(screenY(cam, worldY(cam, py)), py, 1e-9);
      }
    }
  });

  it('moves the drawn world with the shake', () => {
    const cam = makeCamera(800, 600, 5, 3, -2);
    close(screenX(cam, 5), 403);
    close(screenY(cam, 0), 600 * RAIL_FRACTION - 2);
  });

  it('eases toward a target exponentially', () => {
    expect(approach(0, 10, 0, 0.2)).toBe(0);
    close(approach(0, 10, 100, 0.2), 10, 1e-6);
    expect(approach(0, 10, 1, 0)).toBe(10);
    const a = approach(0, 10, 0.1, 0.2);
    const b = approach(a, 10, 0.1, 0.2);
    close(b, approach(0, 10, 0.2, 0.2), 1e-9);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(10);
  });
});

describe('parallax', () => {
  it('wraps negatives into [0, period)', () => {
    expect(wrap(-1, 10)).toBe(9);
    expect(wrap(10, 10)).toBe(0);
    expect(wrap(25, 10)).toBe(5);
    close(wrap(-0.25, 1), 0.75);
  });

  it('places a parallax-1 layer exactly like the train-frame camera', () => {
    // A ground point at world position u is at train-frame x = u − odometer.
    const odo = 1234.5;
    const cam = makeCamera(1280, 720, 37.2);
    for (const u of [odo + 10, odo + 37.2, odo - 5]) {
      close(layerScreenX(u, 1, odo + cam.x, cam.k, cam.w), screenX(cam, u - odo), 1e-6);
    }
  });

  it('moves a layer p times as far as the camera', () => {
    const k = 40;
    const a = layerScreenX(100, 0.05, 1000, k, 1000);
    const b = layerScreenX(100, 0.05, 1020, k, 1000);
    close(a - b, 0.05 * 20 * k, 1e-9);
  });

  it('knows the visible layer range and the tiles that cover it', () => {
    const [u0, u1] = layerRange(0.35, 500, 50, 1500);
    close(layerScreenX(u0, 0.35, 500, 50, 1500), 0, 1e-9);
    close(layerScreenX(u1, 0.35, 500, 50, 1500), 1500, 1e-9);
    const [i0, i1] = tileSpan(u0, u1, 16);
    expect(i0 * 16).toBeLessThanOrEqual(u0);
    expect((i1 + 1) * 16).toBeGreaterThanOrEqual(u1);
    const [n0, n1] = tileSpan(-33, -1, 16);
    expect([n0, n1]).toEqual([-3, -1]);
  });

  it('hashes integers to repeatable values in [0, 1)', () => {
    for (let i = -50; i < 50; i++) {
      const h = hash01(i, 7);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(hash01(i, 7)).toBe(h);
    }
    expect(hash01(3, 1)).not.toBe(hash01(3, 2));
  });
});

describe('gait', () => {
  it('advances a phase by distance over stride and wraps', () => {
    close(advancePhase(0.9, 0.5, 2.5), 0.1);
    expect(advancePhase(0.3, 0, 2)).toBe(0.3);
    close(advancePhase(0.1, -0.5, 2.5), 0.9);
    close(advancePhase(0, 7.5, 2.5), 0);
  });

  it('swings the legs in antiphase within the amplitude', () => {
    for (let p = 0; p < 1; p += 0.05) {
      close(legSwing(p, 0.6), -legSwing(p + 0.5, 0.6), 1e-9);
      expect(Math.abs(legSwing(p, 0.6))).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    close(legSwing(0, 0.6), 0);
    close(legSwing(0.25, 0.6), 0.6);
    expect(legSwing(0.4, 0)).toBe(0);
  });

  it('bends the knee only while the leg swings forward', () => {
    for (let p = 0; p < 1; p += 0.05) expect(kneeBend(p, 0.9)).toBeGreaterThanOrEqual(0);
    expect(kneeBend(0.1, 0.9)).toBeGreaterThan(0);
    close(kneeBend(0.6, 0.9), 0);
  });

  it('gallops with four periodic legs', () => {
    const a = gallopLegs(0.3);
    const b = gallopLegs(1.3);
    expect(a).toHaveLength(4);
    a.forEach((v, i) => close(v, b[i], 1e-9));
    // Not all four in step: a gallop is a sequence.
    expect(new Set(a.map((v) => v.toFixed(3))).size).toBeGreaterThan(1);
  });
});

describe('tick interpolation', () => {
  it('starts at the first value', () => {
    const t = new TickInterp();
    t.update(10, 5);
    expect(t.at(0)).toBe(5);
    expect(t.at(0.7)).toBe(5);
  });

  it('interpolates across one tick', () => {
    const t = new TickInterp();
    t.update(10, 5);
    t.update(11, 7);
    expect(t.at(0)).toBe(5);
    expect(t.at(1)).toBe(7);
    close(t.at(0.25), 5.5);
    // Drawing again on the same tick changes nothing.
    t.update(11, 7);
    close(t.at(0.25), 5.5);
  });

  it('estimates the previous tick when several passed between frames', () => {
    const t = new TickInterp();
    t.update(0, 0);
    t.update(3, 30);
    expect(t.at(0)).toBe(20);
    expect(t.at(1)).toBe(30);
  });

  it('snaps on a teleport and on a reset', () => {
    const t = new TickInterp(3);
    t.update(0, 0);
    t.update(1, 50);
    expect(t.at(0)).toBe(50);
    t.update(2, 51);
    t.update(1, 10);
    expect(t.at(0)).toBe(10);
    expect(t.at(1)).toBe(10);
  });
});

describe('signal looks (spec §9.1)', () => {
  it('one head: arm and lamp per aspect', () => {
    expect(signalHeads('stop', 1)).toEqual([{ arm: 0, lamp: 'red' }]);
    expect(signalHeads('approach', 1)).toEqual([{ arm: 45, lamp: 'yellow' }]);
    expect(signalHeads('clear', 1)).toEqual([{ arm: 90, lamp: 'green' }]);
  });

  it('two heads: upper over lower', () => {
    expect(signalHeads('stop', 2)).toEqual([
      { arm: 0, lamp: 'red' },
      { arm: 0, lamp: 'red' },
    ]);
    expect(signalHeads('approach', 2)).toEqual([
      { arm: 45, lamp: 'yellow' },
      { arm: 0, lamp: 'red' },
    ]);
    expect(signalHeads('clear', 2)).toEqual([
      { arm: 90, lamp: 'green' },
      { arm: 0, lamp: 'red' },
    ]);
    expect(signalHeads('divergeApproach', 2)).toEqual([
      { arm: 0, lamp: 'red' },
      { arm: 45, lamp: 'yellow' },
    ]);
    expect(signalHeads('divergeClear', 2)).toEqual([
      { arm: 0, lamp: 'red' },
      { arm: 90, lamp: 'green' },
    ]);
  });

  it('a one-head signal never shows a diverging aspect: it falls back to the plain one', () => {
    expect(signalHeads('divergeApproach', 1)).toEqual(signalHeads('approach', 1));
    expect(signalHeads('divergeClear', 1)).toEqual(signalHeads('clear', 1));
  });

  it('letters lamps for colour-blind players', () => {
    expect(lampLetter('red')).toBe('R');
    expect(lampLetter('yellow')).toBe('Y');
    expect(lampLetter('green')).toBe('G');
  });
});

describe('sky', () => {
  const h = (hours: number): number => hours * 3600;

  it('is pure day at noon and pure night on a night run', () => {
    const noon = skyAt(h(12), false);
    expect(noon.a).toBe('day');
    expect(noon.t).toBe(0);
    expect(noon.light).toBe(1);
    const night = skyAt(h(12), true);
    expect(night.a).toBe('night');
    expect(night.t).toBe(0);
    expect(night.light).toBeLessThan(0.5);
  });

  it('has a dawn and a dusk', () => {
    expect(skyAt(h(6.25), false).a).toBe('dawn');
    expect(skyAt(h(6.25), false).t).toBe(0);
    expect(skyAt(h(18.5), false).a).toBe('dusk');
    const between = skyAt(h(7), false);
    expect(between.a).toBe('dawn');
    expect(between.b).toBe('day');
    expect(between.t).toBeGreaterThan(0);
    expect(between.t).toBeLessThan(1);
  });

  it('wraps past midnight', () => {
    expect(skyAt(h(25), false).a).toBe(skyAt(h(1), false).a);
    expect(skyAt(h(-1), false).a).toBe('night');
  });

  it('puts the sun up by day and down at night', () => {
    expect(skyAt(h(12), false).sun).toBeGreaterThan(0.9);
    expect(skyAt(h(2), false).sun).toBeLessThanOrEqual(0);
    expect(skyAt(h(12), true).sun).toBeLessThanOrEqual(0);
  });
});

describe('car layout for drawing, from the sim geometry (spec §5.1)', () => {
  const consist = (kinds: CarState['kind'][]): CarState[] => {
    // Front to back, touching, like the sim's layout.
    const all: CarState['kind'][] = ['loco', 'tender', ...kinds];
    const L = all.reduce((n, k) => n + CAR_SPECS[k].length, 0);
    let x1 = L;
    return all.map((kind) => {
      const c = { kind, x0: x1 - CAR_SPECS[kind].length, x1, hp: CAR_SPECS[kind].hp };
      x1 = c.x0;
      return c;
    });
  };

  it('bodies sit inside half bridge plates and platforms: roofs 1.6 m apart', () => {
    const cars = consist(['express', 'passenger', 'boxcar']);
    const t = trainLook(cars);
    const ex = t.cars[2];
    const pa = t.cars[3];
    close(ex.bx0, ex.x0 + COUPLER_GAP / 2 + PLATFORM_DEPTH);
    close(ex.bx1, ex.x1 - COUPLER_GAP / 2 - PLATFORM_DEPTH);
    close(ex.bx0 - pa.bx1, 1.6);
    expect(ex.floorY).toBe(1.2);
    expect(ex.roofY).toBe(4.2);
    expect(t.cars[4].floorY).toBe(1.3);
    // Each car has a platform against each end of its body, and plates outside them.
    expect(ex.decks).toHaveLength(2);
    close(ex.decks[0][1], ex.bx0);
    close(ex.decks[1][0], ex.bx1);
  });

  it('draws exactly the ladders and hatches the sim has', () => {
    const cars = consist(['express', 'boxcar', 'caboose']);
    const t = trainLook(cars);
    const geo = trainGeometry(cars);
    const drawn = t.cars.flatMap((c) => c.ladders);
    expect(drawn.length).toBe(geo.ladders.length);
    for (const l of geo.ladders) expect(drawn.some((d) => d.x === l.x && d.y0 === l.y0 && d.y1 === l.y1 && d.kind === l.kind)).toBe(true);
    expect(t.cars.flatMap((c) => c.hatches.map((h) => h.x))).toEqual(geo.hatches.map((h) => h.x));
    // End ladders hang over the platforms, outside the body.
    for (const c of t.cars.slice(2)) for (const l of c.ladders.filter((d) => d.kind === 'end')) expect(l.x < c.bx0 || l.x > c.bx1).toBe(true);
    // The caboose's hatch is in its rear third; the cupola over the middle third.
    const cb = t.cars[4];
    expect(cb.hatches[0].x).toBeLessThan(cb.bx0 + (cb.bx1 - cb.bx0) / 3);
    expect(cb.cupola).not.toBeNull();
    expect(cb.cupolaY).toBe(CUPOLA_Y);
  });

  it('knows the cab, the tender deck and bunker ladder, and the safe', () => {
    const cars = consist(['express']);
    const t = trainLook(cars);
    const loco = t.cars[0];
    const tender = t.cars[1];
    expect(loco.cab).toEqual([loco.x0, loco.x0 + CAB_LENGTH]);
    expect(loco.ladders.map((l) => l.kind)).toEqual(['cab']);
    expect(tender.deck).toEqual([tender.x1 - TENDER_DECK, tender.x1]);
    expect(tender.roofY).toBe(2.8);
    expect(tender.ladders.some((l) => l.kind === 'bunker')).toBe(true);
    expect(t.safe).not.toBeNull();
    close(t.safe?.x ?? 0, (t.cars[2].bx0 + t.cars[2].bx1) / 2);
    expect(t.tenderHatchX).toBe(tender.x0 + 2);
  });

  it('is cached per layout', () => {
    const cars = consist(['express', 'caboose']);
    expect(trainLook(cars)).toBe(trainLook(cars.map((c) => ({ ...c }))));
  });
});
