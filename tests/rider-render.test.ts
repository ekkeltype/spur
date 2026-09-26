// Pure helpers behind the Rider's view (spec §18.2): the camera and its inverse, parallax layers,
// gait cycles, tick interpolation, signal looks (§9.1), the sky's time of day and car layout. Round
// 2: the lookout's framing, fords (the water's surface, bow waves, banks), the HUD's distances and
// flag, spray and the lurch's jolt; and whole frames drawn through a stand-in canvas, to check that
// the river's water lies over the train, its figures and the horses, and that the lookout reaches
// past the loco's front. Round 3: the scout alert (what's worth a look, how far, what's been seen,
// which edge), in the pure watch and in whole frames.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approach,
  LOOKOUT_MARGIN,
  LOOKOUT_REACH,
  LOOKOUT_ZOOM_MAX,
  lookoutCentre,
  lookoutZoom,
  makeCamera,
  placeCamera,
  RAIL_FRACTION,
  screenX,
  screenY,
  VIEW_HEIGHT_M,
  worldX,
  worldY,
} from '../src/render/rider/camera';
import { trainLook } from '../src/render/rider/cars';
import { Effects, P_WATER } from '../src/render/rider/effects';
import { BANK_TOP_Y, bankX, bowWaves, locoFaceX, SHOULDER_OUT, surfaceY, wash, WATER_Y } from '../src/render/rider/ford';
import { distanceText, flagText, glassHalfWidth, waitText } from '../src/render/rider/hud';
import { advancePhase, gallopLegs, kneeBend, legSwing, TickInterp } from '../src/render/rider/motion';
import { hash01, layerRange, layerScreenX, tileSpan, wrap } from '../src/render/rider/parallax';
import { onLookout, RiderRenderer, type RiderFrame } from '../src/render/rider/renderer';
import type { Scene } from '../src/render/rider/scene';
import { badgeSide, runDir, scoutThings, ScoutWatch, SEEN_SECONDS, type ScoutLook, type ScoutThing } from '../src/render/rider/scout';
import { lampLetter, signalHeads } from '../src/render/rider/signal-look';
import { skyAt } from '../src/render/rider/sky';
import { RUNS } from '../src/content/runs';
import { newGame, scopeMaxFor } from '../src/sim/game';
import { trainGeometry } from '../src/sim/geometry';
import { frontHead, netIndex, walk } from '../src/sim/network';
import {
  CAB_LENGTH,
  CAR_SPECS,
  COUPLER_GAP,
  CUPOLA_Y,
  FLAG_MAX,
  FORD_WATER_Y,
  PLATFORM_DEPTH,
  SCOPE_MAX,
  SCOPE_MAX_HEADLAMP,
  SCOPE_MAX_NIGHT,
  SCOPE_MIN,
  TENDER_DECK,
  YARD,
} from '../src/sim/rules';
import type { CarState, GameState, HorsemanState, RunDef, SimEvent, TracksideItem, UpgradeId } from '../src/sim/types';

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

// ---- Round 2 --------------------------------------------------------------------------------------

describe('the lookout (camera)', () => {
  it('zooms by showing more of the world, and still inverts exactly', () => {
    const cam = makeCamera(1280, 720, 40, 2, -1, 1.4);
    close(worldY(cam, 0) - worldY(cam, 720), VIEW_HEIGHT_M * 1.4, 1e-9);
    close(screenY(cam, 0), 720 * RAIL_FRACTION - 1);
    for (const [x, y] of [
      [40, 0],
      [21.5, 7.25],
    ]) {
      close(worldX(cam, screenX(cam, x)), x, 1e-9);
      close(worldY(cam, screenY(cam, y)), y, 1e-9);
    }
    placeCamera(cam, 1280, 720, 40, 0, 0, Number.NaN);
    expect(cam.zoom).toBe(1);
  });

  it('reaches LOOKOUT_REACH past the loco from the cab roof, the Rider kept inside the left edge', () => {
    const L = 90;
    const aspect = 16 / 9;
    const rx = L - 13.75; // the middle of the cab roof
    const z = lookoutZoom(rx, L, aspect);
    expect(z).toBeGreaterThan(1);
    expect(z).toBeLessThan(LOOKOUT_ZOOM_MAX);
    const half = (VIEW_HEIGHT_M * z * aspect) / 2;
    const c = lookoutCentre(rx, L, aspect, z);
    close(c + half, L + LOOKOUT_REACH, 1e-9);
    expect(c - half).toBeLessThanOrEqual(rx - LOOKOUT_MARGIN + 1e-9);
  });

  it('from farther back, zooms out no further than LOOKOUT_ZOOM_MAX and keeps the Rider in view', () => {
    const L = 90;
    const rx = L - 19.5; // the tender top
    const z = lookoutZoom(rx, L, 16 / 9);
    expect(z).toBe(LOOKOUT_ZOOM_MAX);
    const half = (VIEW_HEIGHT_M * z * (16 / 9)) / 2;
    close(lookoutCentre(rx, L, 16 / 9, z) - half, rx - LOOKOUT_MARGIN, 1e-9);
    // A wide screen needs no zoom at all.
    expect(lookoutZoom(L - 13.75, L, 21 / 9)).toBe(1);
  });

  it('is the cab roof or the tender top, standing and looking ahead, not scoped', () => {
    const r = { mode: 'active' as const, scoped: false, onGround: true, surface: 'cabRoof' as const, facing: 1 as const, aim: 0.1 };
    expect(onLookout(r)).toBe(true);
    expect(onLookout({ ...r, surface: 'tenderTop' })).toBe(true);
    expect(onLookout({ ...r, surface: 'roof' })).toBe(false);
    expect(onLookout({ ...r, facing: -1, aim: Math.PI - 0.1 })).toBe(false);
    expect(onLookout({ ...r, scoped: true })).toBe(false);
    expect(onLookout({ ...r, onGround: false })).toBe(false);
    expect(onLookout({ ...r, mode: 'off' })).toBe(false);
  });
});

describe('fords (spec §4.3)', () => {
  const cars = (): CarState[] => {
    const kinds: CarState['kind'][] = ['loco', 'tender', 'express', 'boxcar'];
    let x1 = kinds.reduce((n, k) => n + CAR_SPECS[k].length, 0);
    return kinds.map((kind) => {
      const c = { kind, x0: x1 - CAR_SPECS[kind].length, x1, hp: CAR_SPECS[kind].hp };
      x1 = c.x0;
      return c;
    });
  };

  it('stands the water at the sim’s FORD_WATER_Y, ripples no more than a few centimetres', () => {
    expect(WATER_Y).toBe(FORD_WATER_Y);
    for (let x = 0; x < 30; x += 0.7) expect(Math.abs(surfaceY(x, x + 123.4, 5.5, []) - FORD_WATER_Y)).toBeLessThan(0.08);
  });

  it('piles a bow wave in front of the loco’s smokebox and smaller ones before the cars in the water, growing with speed', () => {
    const looks = trainLook(cars()).cars;
    const L = looks[0].x1;
    expect(bowWaves(looks, -10, L + 20, 0)).toHaveLength(0); // standing still: none
    const slow = bowWaves(looks, -10, L + 20, 4);
    const fast = bowWaves(looks, -10, L + 20, 20);
    expect(fast).toHaveLength(looks.length);
    const bow = fast[0];
    expect(bow.x).toBeGreaterThan(locoFaceX(looks[0]));
    expect(bow.x).toBeLessThan(L);
    for (const w of fast.slice(1)) expect(w.h).toBeLessThan(bow.h);
    expect(bow.h).toBeGreaterThan(slow[0].h);
    // Only faces in the water: the loco's, the tender's and the express car's here, not the boxcar's behind.
    const partly = bowWaves(looks, looks[2].x0 + 0.1, L + 20, 20);
    expect(partly).toHaveLength(3);
    // Reversing, the water piles against the rear end instead.
    const back = bowWaves(looks, -10, L + 20, -10);
    expect(back[back.length - 1].x).toBeLessThan(looks[looks.length - 1].x0);
    expect(wash(0)).toBe(0);
    expect(wash(40)).toBe(1);
  });

  it('spills the surface down to the banks just outside the ford, which widen toward the viewer', () => {
    expect(bankX(100, 1, BANK_TOP_Y)).toBe(100 + SHOULDER_OUT);
    expect(bankX(20, -1, BANK_TOP_Y)).toBe(20 - SHOULDER_OUT);
    expect(bankX(100, 1, -4)).toBeGreaterThan(bankX(100, 1, -1));
    expect(bankX(20, -1, -4)).toBeLessThan(bankX(20, -1, -1));
  });
});

describe('HUD text (round 2)', () => {
  it('gives distances as the railroad does: yards under a mile, rounded, then miles', () => {
    expect(distanceText(20)).toBe('22 yd'); // the spyglass's near end
    expect(distanceText(99 * YARD)).toBe('99 yd');
    expect(distanceText(263 * YARD)).toBe('265 yd');
    expect(distanceText(650)).toBe('710 yd');
    expect(distanceText(1234 * YARD)).toBe('1230 yd');
    expect(distanceText(1609.34)).toBe('1.0 mi');
    expect(distanceText(Number.NaN)).toBe('0 yd');
  });

  it('speaks of one flag, planted or moved', () => {
    expect(FLAG_MAX).toBe(1);
    expect(flagText(0)).toMatch(/click to flag/i);
    expect(flagText(1)).toMatch(/move it/);
  });

  it('says why a due respawn is held', () => {
    expect(waitText('water')).toMatch(/water/);
    expect(waitText('tunnel')).toMatch(/tunnel/);
    expect(waitText('other')).toMatch(/aboard/);
  });
});

describe('effects (round 2)', () => {
  const scene = { odo: 0, v: 0 } as unknown as Scene;

  it('drops spray back into the river instead of through it', () => {
    const fx = new Effects();
    fx.splash(scene, 10, FORD_WATER_Y, 1);
    expect(fx.count).toBeGreaterThan(20);
    fx.clear();
    // A drop thrown up from the surface, with ten seconds to live, is gone once it falls back in…
    fx.spawn(scene, P_WATER, 0, FORD_WATER_Y, 0, 2, 0.05, 0, 10, 0, FORD_WATER_Y - 0.1);
    for (let i = 0; i < 20; i++) fx.update(1 / 60);
    expect(fx.count).toBe(1); // still in the air
    for (let i = 0; i < 40; i++) fx.update(1 / 60);
    expect(fx.count).toBe(0);
    // …while one with no water under it falls on.
    fx.spawn(scene, P_WATER, 0, FORD_WATER_Y, 0, 2, 0.05, 0, 10);
    for (let i = 0; i < 60; i++) fx.update(1 / 60);
    expect(fx.count).toBe(1);
  });

  it('jolts the view toward the rear and settles', () => {
    const fx = new Effects();
    const out = { x: 0, y: 0 };
    fx.jolt(0, 10, 0.6);
    fx.shakeAt(0.03, out);
    expect(out.x).toBeLessThan(-1);
    fx.shakeAt(0.7, out);
    expect(Math.abs(out.x)).toBe(0);
    expect(Math.abs(out.y)).toBe(0);
  });
});

// ---- Round 3 --------------------------------------------------------------------------------------

describe('the scout alert (round 3)', () => {
  const L = 100;
  /** A look from a Rider standing mid-train: the view ends 5 m short of the loco's front. */
  const look = (over: Partial<ScoutLook> = {}): ScoutLook => ({ dir: 1, length: L, near: 13, far: SCOPE_MAX, view: { x0: L - 40, x1: L - 5 }, glass: null, dt: 1 / 60, ...over });
  const herd = (id: string, x: number): TracksideItem => ({ kind: 'obstacle', id, x, obstacle: 'cattle', state: 'present', calm: false });
  const things = (items: TracksideItem[], dir: 1 | -1 = 1): ScoutThing[] => scoutThings(items, [], dir);
  const rider = (mode: 'active' | 'off' | 'down', scoped: boolean): { mode: 'active' | 'off' | 'down'; scoped: boolean } => ({ mode, scoped });
  const waiting = (id: number, x: number, mode: HorsemanState['mode']): Pick<HorsemanState, 'id' | 'x' | 'mode'> => ({ id, x, mode });

  it('counts what the Rider must spot and call: obstacles, waiting horsemen, a train on our track, a stop signal facing us', () => {
    const items: TracksideItem[] = [
      herd('cows', L + 300),
      { kind: 'obstacle', id: 'leaving', x: L + 310, obstacle: 'cattle', state: 'scattering', calm: false },
      { kind: 'obstacle', id: 'slide', x: L + 320, obstacle: 'rocks', state: 'present', calm: false },
      { kind: 'obstacle', id: 'bar', x: L + 330, obstacle: 'barricade', state: 'present', calm: false },
      { kind: 'obstacle', id: 'smashed', x: L + 340, obstacle: 'barricade', state: 'hit', calm: false },
      { kind: 'signal', id: 'red', x: L + 350, facing: 'toward', heads: 1, aspect: 'stop' },
      { kind: 'signal', id: 'yellow', x: L + 360, facing: 'toward', heads: 1, aspect: 'approach' },
      { kind: 'signal', id: 'green', x: L + 370, facing: 'toward', heads: 2, aspect: 'divergeClear' },
      { kind: 'signal', id: 'back', x: L + 380, facing: 'away', heads: 1, aspect: 'stop' },
      { kind: 'train', id: 'no7', x0: L + 400, x1: L + 520, lane: 'same', ai: 'freight', v: 10, cars: 8 },
      { kind: 'train', id: 'runaway', x0: L + 540, x1: L + 584, lane: 'same', ai: 'runaway', v: 12, cars: 4 },
      { kind: 'train', id: 'ex9', x0: L + 200, x1: L + 290, lane: 'adjacent', ai: 'express', v: 14, cars: 4 },
      // The Engineer's calls, and the rest of the scenery: none of these raise it.
      { kind: 'tunnel', id: 'tn', x0: L + 100, x1: L + 180, name: 'Tunnel' },
      { kind: 'ford', id: 'fd', x0: L + 190, x1: L + 230, name: 'Ford' },
      { kind: 'trestle', id: 'tr', x0: L + 240, x1: L + 280, name: 'Trestle', burning: true },
      { kind: 'lowBridge', id: 'lb', x: L + 60 },
      { kind: 'station', id: 'st', x: L + 420, platform: 60, name: 'Station' },
      { kind: 'water', id: 'wt', x: L + 430, spoutDown: false },
      { kind: 'milepost', x: L + 440, mile: 3 },
      { kind: 'curve', id: 'cv', x0: L + 450, x1: L + 500, limit: 12 },
      { kind: 'junction', id: 'jn', x: L + 460, state: 'normal', name: 'Junction' },
    ];
    const horsemen = [waiting(5, L + 450, 'waiting'), waiting(6, L + 20, 'pace'), waiting(7, -30, 'approach')];
    const keys = scoutThings(items, horsemen, 1).map((t) => t.key);
    expect(keys.sort()).toEqual(['g:red', 'h:5', 'o:bar', 'o:cows', 'o:leaving', 'o:slide', 't:no7', 't:runaway']);
    // Backing, the signals that face the train are the ones facing the rear.
    const back = scoutThings(items, horsemen, -1).map((t) => t.key);
    expect(back).toContain('g:back');
    expect(back).not.toContain('g:red');
    // Placed where they're drawn: shifted to render time, with the width of what's drawn.
    const [cows] = scoutThings([herd('cows', 250)], [], 1, 0.4);
    expect(cows.x0).toBeLessThan(250.4);
    expect(cows.x1).toBeGreaterThan(250.4);
    close((cows.x0 + cows.x1) / 2, 250.4, 1e-9);
  });

  it('reaches as far as the spyglass: 650 m by day, 300 m at night, 450 m with the headlamp', () => {
    const run = RUNS[0];
    const night: RunDef = { ...run, night: true };
    const make = (r: RunDef, upgrades: UpgradeId[]): GameState => newGame(r, { seed: 3, consist: ['express'], upgrades, assists: { rider: false, engineer: false } });
    const day = scopeMaxFor(make(run, []), run);
    const dark = scopeMaxFor(make(night, []), night);
    const lamp = scopeMaxFor(make(night, ['headlamp']), night);
    expect([day, dark, lamp]).toEqual([SCOPE_MAX, SCOPE_MAX_NIGHT, SCOPE_MAX_HEADLAMP]);
    const sideAt = (x: number, far: number): number => new ScoutWatch().update(things([herd('cows', x)]), look({ far }));
    expect(sideAt(L + 400, day)).toBe(1);
    expect(sideAt(L + 400, dark)).toBe(0);
    expect(sideAt(L + 400, lamp)).toBe(1);
    expect(sideAt(L + 280, dark)).toBe(1);
    // Out to the reach and no farther (a herd's near end within it counts).
    expect(sideAt(L + day - 10, day)).toBe(1);
    expect(sideAt(L + day + 10, day)).toBe(0);
    // Nearer than the glass can show at its shortest reach, it's left to the view.
    const near = SCOPE_MIN - glassHalfWidth(1280, 720);
    expect(near).toBeGreaterThan(10);
    expect(near).toBeLessThan(16);
    // (A herd is drawn 4 m either side of its point.)
    const at = (x: number): number => new ScoutWatch().update(things([herd('cows', x)]), look({ near }));
    expect(at(L + near - 4 - 1)).toBe(0);
    expect(at(L + near - 4 + 1)).toBe(1);
  });

  it('goes once the thing has been in the spyglass’s glass a moment, not for a sweep past it', () => {
    const w = new ScoutWatch();
    const cows = things([herd('cows', L + 400)]);
    expect(w.update(cows, look())).toBe(1);
    const glass = { x0: L + 393, x1: L + 407 };
    // Swept past in a few frames: still worth a look.
    for (let i = 0; i < 3; i++) w.update(cows, look({ view: null, glass }));
    expect(w.side).toBe(1);
    expect(w.hasSeen('o:cows')).toBe(false);
    // Held there a moment: seen, and the badge stays down with the glass lowered again.
    let frames = 3;
    while (!w.hasSeen('o:cows') && frames < 60) {
      w.update(cows, look({ view: null, glass }));
      frames++;
    }
    expect(frames).toBe(Math.round(SEEN_SECONDS * 60));
    expect(w.side).toBe(0);
    expect(w.update(cows, look())).toBe(0);
    // Glass elsewhere, or a game paused (no time passes), sees nothing.
    const other = new ScoutWatch();
    for (let i = 0; i < 60; i++) other.update(cows, look({ view: null, glass: { x0: L + 200, x1: L + 214 } }));
    for (let i = 0; i < 60; i++) other.update(cows, look({ view: null, glass, dt: 0 }));
    expect(other.side).toBe(1);
  });

  it('goes once the thing comes into plain view, and stays gone', () => {
    const w = new ScoutWatch();
    const cows = things([herd('cows', L + 60)]);
    expect(w.update(cows, look({ view: { x0: L - 20, x1: L + 27 } }))).toBe(1);
    expect(w.update(cows, look({ view: { x0: L - 10, x1: L + 58 } }))).toBe(0);
    expect(w.update(cows, look({ view: { x0: L - 40, x1: L - 5 } }))).toBe(0);
    // A signal seen at clear is news when it drops to stop out of sight.
    const signal = (aspect: 'clear' | 'stop'): ScoutThing[] => things([{ kind: 'signal', id: 'j', x: L + 30, facing: 'toward', heads: 2, aspect }]);
    const s = new ScoutWatch();
    expect(s.update(signal('clear'), look({ view: { x0: L - 10, x1: L + 40 } }))).toBe(0);
    expect(s.update(signal('stop'), look())).toBe(1);
  });

  it('turns to the rear when the train backs: the badge at the left edge, for what lies behind it', () => {
    expect(runDir(12, 1)).toBe(1);
    expect(runDir(0, -1)).toBe(1);
    expect(runDir(-2, 1)).toBe(-1);
    // A margin as the train slows to a stand, so it doesn't flit between edges.
    expect(runDir(-0.2, -1)).toBe(-1);
    expect(runDir(-0.2, 1)).toBe(1);
    const items: TracksideItem[] = [herd('ahead', L + 300), { kind: 'train', id: 'runaway', x0: -344, x1: -300, lane: 'same', ai: 'runaway', v: 8, cars: 4 }];
    const view = { x0: -12, x1: 22 };
    expect(new ScoutWatch().update(things(items, 1), look({ view }))).toBe(1);
    const back = new ScoutWatch();
    expect(back.update(things(items, -1), look({ dir: -1, view }))).toBe(-1);
    expect(back.update(things(items, -1), look({ dir: -1, view: { x0: -310, x1: -260 } }))).toBe(0);
  });

  it('shows only to a Rider on the train and not at the spyglass', () => {
    expect(badgeSide(1, rider('active', false))).toBe(1);
    expect(badgeSide(-1, rider('active', false))).toBe(-1);
    expect(badgeSide(1, rider('active', true))).toBe(0);
    expect(badgeSide(1, rider('off', false))).toBe(0);
    expect(badgeSide(-1, rider('down', false))).toBe(0);
    expect(badgeSide(0, rider('active', false))).toBe(0);
  });

  it('pops for something new, and keeps what was seen for the game', () => {
    const w = new ScoutWatch();
    w.forGame('run:1', 10);
    w.update(things([herd('a', L + 300)]), look());
    expect(w.fresh).toBe(true);
    w.update(things([herd('a', L + 290)]), look());
    expect(w.fresh).toBe(false);
    w.update(things([herd('a', L + 280), herd('b', L + 500)]), look());
    expect(w.fresh).toBe(true);
    w.update(things([herd('a', L + 20)]), look({ view: { x0: L - 10, x1: L + 30 } }));
    expect(w.hasSeen('o:a')).toBe(true);
    w.forGame('run:1', 400);
    expect(w.hasSeen('o:a')).toBe(true);
    // A new game, or this one restored to an earlier tick (a checkpoint), starts afresh.
    w.forGame('run:1', 200);
    expect(w.hasSeen('o:a')).toBe(false);
    w.update(things([herd('a', L + 20)]), look({ view: { x0: L - 10, x1: L + 30 } }));
    w.forGame('run:2', 300);
    expect(w.hasSeen('o:a')).toBe(false);
  });
});

// ---- Whole frames, through a stand-in canvas ------------------------------------------------------

/** A 2D context that accepts every call and returns harmless values. */
function fakeContext(): CanvasRenderingContext2D {
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop: () => undefined });
      if (prop === 'measureText') return (s: string) => ({ width: String(s).length * 7 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(w: number, h: number): HTMLCanvasElement {
  const ctx = fakeContext();
  return { width: w, height: h, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) } as unknown as HTMLCanvasElement;
}

describe('the Rider’s view, drawn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stub = (): void => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    vi.stubGlobal('document', { createElement: () => fakeCanvas(64, 64), visibilityState: 'visible' });
    vi.stubGlobal(
      'Path2D',
      function Path2D() {
        return new Proxy({}, { get: () => () => undefined });
      },
    );
  };

  /** RUNS[0] with a ford over the front 40 m of the train as it stands at the start. */
  const fordedRun = (): RunDef => {
    const r = structuredClone(RUNS[0]);
    const { edge, off, dir } = r.start;
    const len = r.edges.find((e) => e.id === edge)?.length ?? 0;
    const a = Math.min(len, Math.max(0, off - dir * 40));
    const b = Math.min(len, Math.max(0, off + dir * 15));
    r.fords.push({ id: 'f1', edge, from: Math.min(a, b), to: Math.max(a, b), name: 'Test Ford' });
    return r;
  };

  const game = (run: RunDef): GameState => newGame(run, { seed: 5, consist: ['express', 'passenger', 'boxcar'], upgrades: [], assists: { rider: false, engineer: false } });

  let now = 1000;
  const frame = (st: GameState, run: RunDef, events: SimEvent[] = []): RiderFrame => {
    now += 1000 / 60;
    return { state: st, run, alpha: 0.5, now, events, settings: { screenShake: true, lampLetters: false }, prompt: null, frozen: false };
  };

  it('lays the river’s water over the train, its figures and the horses, and its far half behind them', () => {
    stub();
    const run = fordedRun();
    const st = game(run);
    const view = new RiderRenderer(fakeCanvas(1280, 720));
    view.draw(frame(st, run));
    view.devTrace = [];
    view.draw(frame(st, run));
    const tr = view.devTrace;
    const at = (name: string): number => tr.indexOf(name);
    expect(at('fordBack')).toBeGreaterThanOrEqual(0);
    expect(at('fordFront')).toBeGreaterThanOrEqual(0);
    expect(at('fordBack')).toBeLessThan(at('track'));
    expect(at('fordBack')).toBeLessThan(at('train'));
    expect(at('fordFront')).toBeGreaterThan(tr.lastIndexOf('train'));
    expect(at('fordFront')).toBeGreaterThan(at('figures'));
    expect(at('fordFront')).toBeGreaterThan(at('horsemen'));
    // Spray, washed-off figures and shots are drawn over the water; tunnel rock and the HUD after.
    expect(tr[at('fordFront') + 1]).toBe('fx');
    expect(at('fordFront')).toBeLessThan(at('front'));
    expect(at('fordFront')).toBeLessThan(at('hud'));
    // No ford, no water.
    const dry = new RiderRenderer(fakeCanvas(1280, 720));
    dry.devTrace = [];
    dry.draw(frame(game(RUNS[0]), RUNS[0]));
    expect(dry.devTrace).not.toContain('fordFront');
    expect(dry.devTrace).not.toContain('fordBack');
  });

  it('draws the round-2 events without trouble: a ford entered, the lurch, a shying horse, a throw, a wash-off', () => {
    stub();
    const run = fordedRun();
    const st = game(run);
    st.train.v = 12;
    st.horsemen = [
      { id: 7, x: 20, worldV: 12, hp: 1, tier: 1, boss: false, goal: 'safe', mode: 'pace', modeTicks: 0, stamina: 8, targetX: 20, aimTicks: 0, cooldownTicks: 0, behindTicks: 0, pickup: false, shyTicks: 100 },
    ];
    const view = new RiderRenderer(fakeCanvas(1280, 720));
    view.draw(frame(st, run));
    const before = view.particles;
    view.draw(
      frame(st, run, [
        { type: 'fordEnter', id: 'f1' },
        { type: 'lurch' },
        { type: 'horseShy', id: 7 },
        { type: 'thrown', who: 'rider' },
        { type: 'banditKnockedOff', id: 3, cause: 'water' },
        { type: 'cattleCalm', id: 'none' },
        { type: 'cattleScatter', id: 'none' },
      ]),
    );
    expect(view.particles).toBeGreaterThan(before);
    st.rider.mode = 'off';
    st.rider.respawnTicks = 0;
    expect(() => {
      view.draw(frame(st, run, [{ type: 'riderHurt', cause: 'water', hearts: 2 }, { type: 'riderOff', cause: 'water' }]));
      for (let i = 0; i < 30; i++) view.draw(frame(st, run));
    }).not.toThrow();
  });

  it('on the lookout, reaches LOOKOUT_REACH past the loco’s front; elsewhere the framing is unchanged', () => {
    stub();
    const run = RUNS[0];
    const st = game(run);
    const L = st.train.length;
    const geo = trainGeometry(st.train.cars);
    const cabRoof = geo.surfaces.find((s) => s.kind === 'cabRoof');
    if (!cabRoof) throw new Error('no cab roof');
    const x = (cabRoof.x0 + cabRoof.x1) / 2;
    Object.assign(st.rider, { x, y: cabRoof.y, surface: 'cabRoof', onGround: true, facing: 1, aim: 0.05, mode: 'active', scoped: false, inside: null, ladder: null });
    const view = new RiderRenderer(fakeCanvas(1280, 720));
    for (let i = 0; i < 120; i++) view.draw(frame(st, run));
    const cam = view.camera;
    expect(cam.zoom).toBeGreaterThan(1.05);
    expect(worldX(cam, cam.w)).toBeGreaterThan(L + LOOKOUT_REACH - 1);
    expect(worldX(cam, 0)).toBeLessThan(x - LOOKOUT_MARGIN + 1);
    // Turned to face a bandit behind: back to the usual framing.
    Object.assign(st.rider, { facing: -1, aim: Math.PI - 0.1 });
    for (let i = 0; i < 120; i++) view.draw(frame(st, run));
    expect(view.camera.zoom).toBeCloseTo(1, 2);
    // On a car roof facing ahead: no lookout.
    const car = geo.surfaces.find((s) => s.kind === 'roof');
    if (!car) throw new Error('no roof');
    Object.assign(st.rider, { x: (car.x0 + car.x1) / 2, y: car.y, surface: 'roof', facing: 1, aim: 0.05 });
    const other = new RiderRenderer(fakeCanvas(1280, 720));
    for (let i = 0; i < 60; i++) other.draw(frame(st, run));
    expect(other.camera.zoom).toBe(1);
  });

  it('raises the scout alert for a herd 400 m ahead, as far as the spyglass reaches, and drops it after a look', () => {
    stub();
    const withHerd = (r: RunDef, upgrades: UpgradeId[] = []): GameState => {
      const st = newGame(r, { seed: 5, consist: ['express', 'passenger', 'boxcar'], upgrades, assists: { rider: false, engineer: false } });
      const p = walk(netIndex(r), st.switches, frontHead(st.train.spans), 400).end;
      st.obstacles = [{ id: 'herd', kind: 'cattle', edge: p.edge, at: p.off, state: 'present', ticks: 0, calmTicks: 0 }];
      return st;
    };
    const run = RUNS[0];
    const st = withHerd(run);
    const view = new RiderRenderer(fakeCanvas(1280, 720));
    view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(1);
    // At the spyglass it's hidden; held on the herd a moment, the herd is seen, and the "!" stays down.
    Object.assign(st.rider, { scoped: true, scopeDist: 400 });
    for (let i = 0; i < 45; i++) view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(0);
    st.rider.scoped = false;
    for (let i = 0; i < 60; i++) view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(0);
    // Off the train, hidden.
    const off = withHerd(run);
    const offView = new RiderRenderer(fakeCanvas(1280, 720));
    offView.draw(frame(off, run));
    expect(offView.scoutBadge).toBe(1);
    off.rider.mode = 'off';
    offView.draw(frame(off, run));
    expect(offView.scoutBadge).toBe(0);
    // At night the spyglass sees 300 m, or 450 m with the headlamp: the herd out of reach, then in it.
    const night: RunDef = { ...run, night: true };
    const dark = new RiderRenderer(fakeCanvas(1280, 720));
    dark.draw(frame(withHerd(night), night));
    expect(dark.scoutBadge).toBe(0);
    const lamp = new RiderRenderer(fakeCanvas(1280, 720));
    lamp.draw(frame(withHerd(night, ['headlamp']), night));
    expect(lamp.scoutBadge).toBe(1);
  });

  it('raises it for riders waiting in ambush, and the glass finds them in their lane', () => {
    stub();
    const run = RUNS[0];
    const st = game(run);
    const L = st.train.length;
    const rider = (id: number, d: number): HorsemanState => ({ id, x: L + d, worldV: 0, hp: 1, tier: 1, boss: false, goal: 'hunt', mode: 'waiting', modeTicks: 0, stamina: 8, targetX: L + d, aimTicks: 0, cooldownTicks: 0, behindTicks: 0, pickup: false, shyTicks: 0 });
    st.horsemen = [rider(1, 450), rider(2, 452)];
    const view = new RiderRenderer(fakeCanvas(1280, 720));
    view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(1);
    Object.assign(st.rider, { scoped: true, scopeDist: 451 });
    for (let i = 0; i < 45; i++) view.draw(frame(st, run));
    st.rider.scoped = false;
    for (let i = 0; i < 60; i++) view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(0);
    // Once they ride, they're no longer waiting to be spotted: a new ambush pops it up again.
    st.horsemen = [{ ...rider(1, 300), mode: 'approach' }, rider(3, 500)];
    view.draw(frame(st, run));
    expect(view.scoutBadge).toBe(1);
  });
});
