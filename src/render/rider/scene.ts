// The per-frame context every drawing pass of the Rider's view shares, and the two transforms they
// draw in: the world (train-frame metres, y up) and the screen (CSS px, y down).

import type { Camera } from './camera';
import type { Lit } from './materials';
import type { SkyInfo } from './sky';

export interface Scene {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  dpr: number;
  /** Animation clock that follows the sim (s): frozen while paused or counting down. */
  t: number;
  /** This frame's step of that clock (s, 0 while frozen). */
  dt: number;
  /** Wall clock (s), for HUD blinks that run even while paused. */
  now: number;
  /** The odometer at render time (interpolated, m). */
  odo: number;
  /** Add to this tick's trackside x to place it at render time (the train moved on since). */
  shift: number;
  /** Train speed along the train, m/s (+ = toward the loco). */
  v: number;
  /** Wind strength over the roofs (spec §6.3): (|v| / 25)², at most 1.4. */
  wind: number;
  sky: SkyInfo;
  night: boolean;
  /** Lit palettes: outside, inside a tunnel, lamp-lit interiors, and figures (kept readable). */
  lit: Lit;
  litTunnel: Lit;
  litInside: Lit;
  litFig: Lit;
  litFigTunnel: Lit;
  /** Tunnel ranges at render time, [x0, x1] pairs. */
  tunnels: number[];
  /** The view's train-frame x range, with a small margin. */
  left: number;
  right: number;
  lampLetters: boolean;
}

/** Tunnel ceiling (m above the rails): standing on any roof, you hit the portal (spec §4.3). */
export const TUNNEL_CEILING = 5.0;

export function setWorld(s: Scene): void {
  const { cam, dpr } = s;
  const k = cam.k * dpr;
  s.ctx.setTransform(k, 0, 0, -k, dpr * (cam.w / 2 - cam.x * cam.k + cam.shakeX), dpr * (cam.railY + cam.shakeY));
}

export function setScreen(s: Scene): void {
  s.ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
}

/** Is train-frame x inside a tunnel (at render time)? */
export function inTunnel(s: Scene, x: number): boolean {
  const t = s.tunnels;
  for (let i = 0; i < t.length; i += 2) if (x >= t[i] && x <= t[i + 1]) return true;
  return false;
}

/** How much of [x0, x1] lies inside tunnels (0..1). */
export function tunnelCover(s: Scene, x0: number, x1: number): number {
  const t = s.tunnels;
  let cover = 0;
  for (let i = 0; i < t.length; i += 2) cover += Math.max(0, Math.min(x1, t[i + 1]) - Math.max(x0, t[i]));
  return x1 > x0 ? Math.min(1, cover / (x1 - x0)) : 0;
}

const fonts = new Map<string, string>();

/** A cached CSS font string. */
export function font(family: 'rye' | 'sans', px: number, weight = 700): string {
  const size = Math.max(6, Math.round(px));
  const key = `${family}${weight}${size}`;
  let f = fonts.get(key);
  if (f === undefined) {
    f = family === 'rye' ? `${size}px Rye, Georgia, serif` : `${weight} ${size}px "Alegreya Sans", system-ui, sans-serif`;
    fonts.set(key, f);
  }
  return f;
}

/**
 * Text anchored in the world (train-frame metres), drawn upright in screen space at a height of
 * `sizeM` metres. Restores the world transform afterwards.
 */
export function worldText(
  s: Scene,
  text: string,
  x: number,
  y: number,
  sizeM: number,
  fill: string,
  opts: { family?: 'rye' | 'sans'; align?: CanvasTextAlign; stroke?: string; strokeW?: number; baseline?: CanvasTextBaseline } = {},
): void {
  const { ctx, cam } = s;
  const px = cam.w / 2 + (x - cam.x) * cam.k + cam.shakeX;
  const py = cam.railY - y * cam.k + cam.shakeY;
  const size = sizeM * cam.k;
  if (size < 5) return;
  setScreen(s);
  ctx.font = font(opts.family ?? 'sans', size);
  ctx.textAlign = opts.align ?? 'center';
  ctx.textBaseline = opts.baseline ?? 'middle';
  if (opts.stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = opts.strokeW ?? Math.max(2, size * 0.18);
    ctx.strokeStyle = opts.stroke;
    ctx.strokeText(text, px, py);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, px, py);
  setWorld(s);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

export const TAU = Math.PI * 2;

/** Rounded rectangle path (world or screen units), without beginPath. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}
