// Time of day for the Rider's view (spec §18.1, §18.2): the sky's gradient, the sun's height, and
// the ambient light every lit colour is multiplied by. A night run (run.night) is night all run
// long; otherwise the clock (state.clock0 + tick / 60) walks through dawn, day, dusk and night.

import { SKIES } from '../palette';

export type SkyPhase = 'dawn' | 'day' | 'dusk' | 'night';

export type RGB = [number, number, number];

export interface SkyInfo {
  /** The phases being blended and how far from a to b (0 = pure a). */
  a: SkyPhase;
  b: SkyPhase;
  t: number;
  /** Overall brightness, 1 at noon. */
  light: number;
  /** Sun elevation, −1..1 (≤ 0: below the horizon). */
  sun: number;
  /** Day progress of the sun across the sky, 0 at sunrise, 1 at sunset (clamped). */
  sunT: number;
  /** Sky gradient, top and horizon (0–255). */
  top: RGB;
  horizon: RGB;
  /** Ambient light multipliers for lit materials (1 = as painted). */
  amb: RGB;
}

/** Keyframes in hours: pure phases, blended linearly between. */
const KEYS: readonly [number, SkyPhase][] = [
  [0, 'night'],
  [4.75, 'night'],
  [6.25, 'dawn'],
  [7.75, 'day'],
  [17, 'day'],
  [18.5, 'dusk'],
  [19.75, 'night'],
  [24, 'night'],
];

const LIGHT: Record<SkyPhase, number> = { dawn: 0.88, day: 1, dusk: 0.8, night: 0.4 };

/** Ambient tint per phase: warm at the ends of the day, cold blue at night. */
const AMB: Record<SkyPhase, RGB> = {
  dawn: [1.0, 0.87, 0.76],
  day: [1, 1, 1],
  dusk: [1.0, 0.78, 0.66],
  night: [0.24, 0.3, 0.5],
};

export function hexRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const SKY_RGB: Record<SkyPhase, [RGB, RGB]> = {
  dawn: [hexRgb(SKIES.dawn[0]), hexRgb(SKIES.dawn[1])],
  day: [hexRgb(SKIES.day[0]), hexRgb(SKIES.day[1])],
  dusk: [hexRgb(SKIES.dusk[0]), hexRgb(SKIES.dusk[1])],
  night: [hexRgb(SKIES.night[0]), hexRgb(SKIES.night[1])],
};

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function skyAt(clock: number, night: boolean): SkyInfo {
  if (night) {
    return { a: 'night', b: 'night', t: 0, light: LIGHT.night, sun: -1, sunT: 0, top: SKY_RGB.night[0], horizon: SKY_RGB.night[1], amb: AMB.night };
  }
  const h = ((((clock / 3600) % 24) + 24) % 24);
  let i = 0;
  while (i < KEYS.length - 2 && h >= KEYS[i + 1][0]) i++;
  const [h0, a0] = KEYS[i];
  const [h1, b0] = KEYS[i + 1];
  const same = a0 === b0;
  const t = same ? 0 : Math.min(1, Math.max(0, (h - h0) / (h1 - h0)));
  const a = a0;
  const b = same ? a0 : b0;
  const sunT = (h - 6) / 12;
  const sun = sunT >= -0.5 && sunT <= 1.5 ? Math.sin(Math.PI * sunT) : -1;
  return {
    a,
    b,
    t,
    light: LIGHT[a] + (LIGHT[b] - LIGHT[a]) * t,
    sun,
    sunT: Math.min(1, Math.max(0, sunT)),
    top: mixRgb(SKY_RGB[a][0], SKY_RGB[b][0], t),
    horizon: mixRgb(SKY_RGB[a][1], SKY_RGB[b][1], t),
    amb: mixRgb(AMB[a], AMB[b], t),
  };
}

export function rgbStr(c: RGB, alpha = 1): string {
  const r = Math.round(c[0]);
  const g = Math.round(c[1]);
  const b = Math.round(c[2]);
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}
