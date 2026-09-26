// Fords in the Rider's view (spec §4.3, §18.2 layer 5): the river over the line. The water stands
// FORD_WATER_Y above the rails from x0 to x1, and anyone on the train with their feet below it is
// washed off, so the view has to say at a glance: you can't be down there.
//
// Two passes. Behind the track (before it's drawn): the river itself, from its surface down past
// the bottom of the view, opaque: its far half behind the train, and in the foreground its bed
// between the near banks, which slope out toward the viewer. In front of the train, its figures
// and the horses (after them): the water's near face, tinted and darker with depth, so whatever is
// below the surface shows through it. The surface carries ripples fixed to the water (they stream
// past as the train runs through) and the current's streaks; at the ends it spills down over the
// embankment to the banks in foaming shoulders; and a bow wave with foam piles up in front of the
// loco and of each car's front end in the water, growing with speed. The renderer throws the spray.
//
// Everything is in the train frame at render time (trackside x plus Scene.shift) and scrolls with
// the odometer where it belongs to the water or the land.

import { FORD_WATER_Y } from '../../sim/rules';
import type { TracksideItem } from '../../sim/types';
import type { CarLook } from './cars';
import { hash01 } from './parallax';
import { FLOOR_Y } from './scenery';
import { clamp01, setWorld, TAU, type Scene } from './scene';
import { hexRgb, rgbStr, type RGB } from './sky';

/** The water's surface over the line: the sim's FORD_WATER_Y above the rail tops (spec §4.3). */
export const WATER_Y = FORD_WATER_Y;
/** The shoulders: the surface spills down to the bank top beside the line, reaching it this far outside the ford… */
export const SHOULDER_OUT = 2;
/** …after starting to fall this far inside it. */
export const SHOULDER_IN = 0.1;
/** Where the banks meet the line: just below the ballast's top. */
export const BANK_TOP_Y = -0.3;
/** The near banks run out toward the viewer: this much wider per metre down the foreground. */
const BANK_SPREAD = 0.55;
/** The smokebox front, where the water meets the loco (from the loco's rear: see train.ts). */
const LOCO_FACE = 13.95;

const WATER = '#2F6F7B';
const DEEP = '#1B4450';
const SHEEN = '#6FA9B2';
const BED = '#4A7466';
const EARTH = '#8A6A48';
const EARTH_DARK = '#5E4430';
const MUD = '#3E3024';
const REED = '#7E8E52';
const REED_DARK = '#5A6A3A';
const CATTAIL = '#5A3A22';
const STONE = '#5E6A62';
const FAR_RGB = hexRgb('#7FB4BC');

/** A hump in the surface: a bow wave piled up in front of a face cutting through the water. */
export interface Wave {
  x: number;
  /** Height above the surface (m) and half-width (m). */
  h: number;
  w: number;
}

/** How hard the train ploughs through the water, 0..1, from its speed (m/s). */
export function wash(v: number): number {
  return clamp01((Math.abs(v) - 0.5) / 16);
}

/**
 * The bow waves where the train cuts through a ford [x0, x1] at speed `v`: one in front of the
 * loco's smokebox, and a smaller one in front of every car body's front end in the water (in the
 * gap before it), higher the faster the train runs. Reversing, the water piles against the rear
 * ends instead. Standing still there are none.
 */
export function bowWaves(looks: readonly CarLook[], x0: number, x1: number, v: number, out: Wave[] = []): Wave[] {
  out.length = 0;
  const k = wash(v);
  if (k <= 0) return out;
  const dir = v >= 0 ? 1 : -1;
  const last = looks.length - 1;
  for (let i = 0; i <= last; i++) {
    const c = looks[i];
    const lead = dir > 0 ? i === 0 : i === last;
    const face = dir > 0 ? (c.kind === 'loco' ? c.x0 + LOCO_FACE : c.bx1) : i === last ? c.x0 : c.bx0;
    if (face < x0 || face > x1) continue;
    out.push({ x: face + dir * (lead ? 0.6 : 0.35), h: 0.04 + (lead ? 0.5 : 0.24) * k, w: lead ? 0.85 : 0.42 });
  }
  return out;
}

/** The train-frame x of the loco's face in the water, for the renderer's spray. */
export function locoFaceX(loco: CarLook): number {
  return loco.x0 + LOCO_FACE;
}

/**
 * The water's surface at train-frame x (`u` is the same point in the world: x plus the odometer):
 * ripples that belong to the water, so they stream past as the train runs through, plus the waves.
 */
export function surfaceY(x: number, u: number, t: number, waves: readonly Wave[]): number {
  let y = WATER_Y + 0.035 * Math.sin(u * 2.3 + t * 2.1) + 0.022 * Math.sin(u * 5.3 - t * 3.4) + 0.01 * Math.sin(u * 11.7 + t * 6.1);
  for (let i = 0; i < waves.length; i++) {
    const d = (x - waves[i].x) / waves[i].w;
    if (d > -3 && d < 3) y += waves[i].h * Math.exp(-d * d);
  }
  return y;
}

/** The near bank's edge at height y (at or below BANK_TOP_Y) beside the ford end `xe`: side −1 left, +1 right. */
export function bankX(xe: number, side: -1 | 1, y: number): number {
  return xe + side * (SHOULDER_OUT + BANK_SPREAD * Math.max(0, BANK_TOP_Y - y));
}

/** Samples a cubic Bézier into flat [x, y, …] points (the first point excluded). */
function bezier(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, n: number): void {
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const m = 1 - t;
    out.push(m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x3, m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y3);
  }
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class FordPainter {
  /** The surface outline: the left shoulder, the surface, the right shoulder, as flat [x, y, …]. */
  private readonly top: number[] = [];
  /** How many points of `top` belong to each shoulder. */
  private shoulderPts = 0;
  private readonly waves: Wave[] = [];
  private readonly calm: Wave[] = [];

  // ---- Behind the track ----------------------------------------------------------------------

  /** The river behind the train and in the foreground, its bed and the near banks. */
  drawBack(s: Scene, items: readonly TracksideItem[]): void {
    setWorld(s);
    for (const it of items) {
      if (it.kind !== 'ford') continue;
      const x0 = it.x0 + s.shift;
      const x1 = it.x1 + s.shift;
      if (bankX(x1, 1, FLOOR_Y) < s.left - 2 || bankX(x0, -1, FLOOR_Y) > s.right + 2) continue;
      const seed = hashId(it.id);
      this.buildTop(s, x0, x1, this.calm);
      this.river(s, x0, x1, seed);
      this.nearBank(s, x0, -1, seed);
      this.nearBank(s, x1, 1, seed + 5);
    }
  }

  /**
   * The river as seen past the train: its far half from the surface down to the line, pale with
   * the sky it reflects, then the bed in the foreground. Streaks drift across it (the current
   * crosses the line), and stones lie on the bed.
   */
  private river(s: Scene, x0: number, x1: number, seed: number): void {
    const { ctx } = s;
    const lit = s.lit;
    const bottom = FLOOR_Y;
    ctx.beginPath();
    ctx.moveTo(bankX(x0, -1, bottom), bottom);
    this.tracePoints(ctx, this.top, 0, this.top.length, true);
    ctx.lineTo(bankX(x1, 1, bottom), bottom);
    ctx.closePath();
    const amb = s.sky.amb;
    const sky = mix(FAR_RGB, s.sky.horizon, 0.35);
    const g = ctx.createLinearGradient(0, WATER_Y + 0.1, 0, bottom);
    g.addColorStop(0, rgbStr([sky[0] * amb[0], sky[1] * amb[1], sky[2] * amb[2]]));
    g.addColorStop(0.2, lit.c('#4F8E97'));
    g.addColorStop(0.3, lit.c(SHEEN));
    g.addColorStop(0.6, lit.c(BED));
    g.addColorStop(1, lit.c('#3E6458'));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.save();
    ctx.clip();
    // The current: pale streaks drifting across the line.
    ctx.strokeStyle = s.night ? 'rgba(160,182,220,0.3)' : lit.a('#EAF6F6', 0.42);
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    const a = Math.max(x0 - SHOULDER_OUT, s.left - 1);
    const b = Math.min(x1 + SHOULDER_OUT, s.right + 1);
    if (b > a) {
      for (let k = 0; k < 16; k++) {
        const ph = (s.t * 0.08 + hash01(seed + k, 5)) % 1;
        const y = WATER_Y - 0.25 - ph * (WATER_Y - 0.1);
        const x = a + (b - a) * hash01(seed + k, 6);
        const len = 0.8 + 1.8 * hash01(seed + k, 7);
        ctx.moveTo(x - len / 2, y);
        ctx.quadraticCurveTo(x, y + 0.05, x + len / 2, y);
      }
    }
    ctx.stroke();
    // Stones on the bed, fixed to the ground.
    const pitch = 1.7;
    const sa = Math.max(bankX(x0, -1, bottom), s.left - 1);
    const sb = Math.min(bankX(x1, 1, bottom), s.right + 1);
    ctx.fillStyle = lit.a(STONE, 0.6);
    ctx.beginPath();
    for (let n = Math.floor((sa + s.odo) / pitch); n * pitch - s.odo < sb; n++) {
      if (hash01(n, 131) > 0.45) continue;
      const x = n * pitch + hash01(n, 132) * pitch - s.odo;
      const y = -1.3 - 3.2 * hash01(n, 133);
      if (x < bankX(x0, -1, y) + 0.3 || x > bankX(x1, 1, y) - 0.3) continue;
      const r = 0.12 + 0.22 * hash01(n, 134);
      ctx.moveTo(x + r * 1.5, y);
      ctx.ellipse(x, y, r * 1.5, r * 0.7, 0, 0, TAU);
    }
    ctx.fill();
    ctx.restore();
  }

  /** A near bank: the earth sloping down into the river beside the ford end `xe`, its wet edge dark. */
  private nearBank(s: Scene, xe: number, side: -1 | 1, seed: number): void {
    const { ctx } = s;
    const lit = s.lit;
    const bottom = FLOOR_Y;
    const inTop = bankX(xe, side, BANK_TOP_Y);
    const inBot = bankX(xe, side, bottom);
    if (Math.max(inTop, inBot) + 4 < s.left || Math.min(inTop, inBot) - 4 > s.right) return;
    ctx.beginPath();
    ctx.moveTo(inTop, BANK_TOP_Y);
    ctx.lineTo(inTop + side * 1.1, BANK_TOP_Y);
    ctx.lineTo(inBot + side * 2.2, bottom);
    ctx.lineTo(inBot, bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(inTop + side * 1.1, 0, inTop, 0);
    g.addColorStop(0, lit.c(EARTH));
    g.addColorStop(1, lit.c(EARTH_DARK));
    ctx.fillStyle = g;
    ctx.fill();
    // The wet edge at the waterline, and pebbles on the slope.
    ctx.strokeStyle = lit.a(MUD, 0.9);
    ctx.lineWidth = 0.14;
    ctx.beginPath();
    ctx.moveTo(inTop, BANK_TOP_Y);
    ctx.lineTo(inBot, bottom);
    ctx.stroke();
    ctx.fillStyle = lit.a('#A89478', 0.85);
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const u = (k + 0.5) / 7;
      const y = BANK_TOP_Y + (bottom - BANK_TOP_Y) * u * 0.85;
      const x = bankX(xe, side, y) + side * (0.25 + 1.1 * hash01(seed + k, 141));
      const r = 0.06 + 0.08 * hash01(seed + k, 142);
      ctx.moveTo(x + r * 1.4, y);
      ctx.ellipse(x, y, r * 1.4, r, 0, 0, TAU);
    }
    ctx.fill();
  }

  // ---- In front of the train -------------------------------------------------------------------

  /**
   * The water's near face, in front of everything below its surface: the train's lower part, the
   * figures on it and the horses. `looks` and `v` place the bow waves.
   */
  drawFront(s: Scene, items: readonly TracksideItem[], looks: readonly CarLook[], v: number): void {
    setWorld(s);
    for (const it of items) {
      if (it.kind !== 'ford') continue;
      const x0 = it.x0 + s.shift;
      const x1 = it.x1 + s.shift;
      if (bankX(x1, 1, FLOOR_Y) < s.left - 2 || bankX(x0, -1, FLOOR_Y) > s.right + 2) continue;
      const seed = hashId(it.id);
      bowWaves(looks, x0, x1, v, this.waves);
      this.buildTop(s, x0, x1, this.waves);
      this.face(s, x0, x1, seed);
      this.foam(s);
      this.reeds(s, x0, -1, seed);
      this.reeds(s, x1, 1, seed + 17);
    }
  }

  /** The surface outline, spilling shoulders included, into this.top. */
  private buildTop(s: Scene, x0: number, x1: number, waves: readonly Wave[]): void {
    const pts = this.top;
    pts.length = 0;
    const surf = (x: number): number => surfaceY(x, x + s.odo, s.t, waves);
    const l = x0 + SHOULDER_IN;
    const r = x1 - SHOULDER_IN;
    const yl = surf(l);
    const yr = surf(r);
    const n = 14;
    pts.push(x0 - SHOULDER_OUT, BANK_TOP_Y);
    bezier(pts, x0 - SHOULDER_OUT, BANK_TOP_Y, x0 - SHOULDER_OUT + 0.9, BANK_TOP_Y, l - 1, yl, l, yl, n);
    this.shoulderPts = n + 1;
    const a = Math.max(l, s.left - 1);
    const b = Math.min(r, s.right + 1);
    const step = 0.2;
    for (let x = Math.ceil(a / step) * step; x < b; x += step) if (x > l) pts.push(x, surf(x));
    pts.push(r, yr);
    bezier(pts, r, yr, r + 1, yr, x1 + SHOULDER_OUT - 0.9, BANK_TOP_Y, x1 + SHOULDER_OUT, BANK_TOP_Y, n);
  }

  /** Points [from, to) of a flat list as a polyline: a new subpath, or joined onto the current one. */
  private tracePoints(ctx: CanvasRenderingContext2D, pts: readonly number[], from = 0, to = pts.length, join = false): void {
    if (join) ctx.lineTo(pts[from], pts[from + 1]);
    else ctx.moveTo(pts[from], pts[from + 1]);
    for (let i = from + 2; i < to; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  }

  /** The water's near face: tinted, deeper with depth, streaked by the current, and its surface line. */
  private face(s: Scene, x0: number, x1: number, seed: number): void {
    const { ctx } = s;
    const lit = s.lit;
    const pts = this.top;
    const bottom = FLOOR_Y;
    ctx.beginPath();
    ctx.moveTo(bankX(x0, -1, bottom), bottom);
    this.tracePoints(ctx, pts, 0, pts.length, true);
    ctx.lineTo(bankX(x1, 1, bottom), bottom);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, WATER_Y + 0.5, 0, bottom);
    g.addColorStop(0, lit.a(SHEEN, 0.62));
    g.addColorStop(0.08, lit.a(WATER, 0.52));
    g.addColorStop(0.25, lit.a(WATER, 0.58));
    g.addColorStop(0.5, lit.a(DEEP, 0.66));
    g.addColorStop(1, lit.a(DEEP, 0.8));
    ctx.fillStyle = g;
    ctx.fill();
    // The current: pale streaks under the surface belonging to the water, and in the foreground
    // foam lines drifting down toward the viewer.
    ctx.save();
    ctx.clip();
    const streak = s.night ? 'rgba(160,182,220,' : 'rgba(226,244,246,';
    ctx.lineWidth = 0.045;
    const cell = 2.6;
    const a = Math.max(x0, s.left - 2);
    const b = Math.min(x1, s.right + 2);
    for (let n = Math.floor((a + s.odo) / cell); n * cell - s.odo < b; n++) {
      const h = hash01(n, 151);
      const x = n * cell + h * cell - s.odo;
      const y = WATER_Y - 0.3 - 1.9 * hash01(n, 152);
      const len = 0.7 + 1.5 * hash01(n, 153);
      const al = 0.08 + 0.1 * (0.5 + 0.5 * Math.sin(s.t * (1.1 + h) + n));
      ctx.strokeStyle = `${streak}${al.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len / 2, y + 0.05 * Math.sin(s.t * 2 + n), x + len, y);
      ctx.stroke();
    }
    for (let k = 0; k < 12; k++) {
      const ph = (s.t * 0.07 + hash01(seed + k, 154)) % 1;
      const y = BANK_TOP_Y - 0.6 - ph * (BANK_TOP_Y - 0.6 - bottom);
      const l = bankX(x0, -1, y);
      const r = bankX(x1, 1, y);
      const x = l + (r - l) * hash01(seed + k, 155);
      const len = (0.6 + 1.2 * hash01(seed + k, 156)) * (1 + 0.4 * ph);
      ctx.strokeStyle = `${streak}${(0.3 * Math.sin(Math.PI * ph)).toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(x - len / 2, y);
      ctx.lineTo(x + len / 2, y - 0.03);
      ctx.stroke();
    }
    ctx.restore();
    // The surface: a dark line just under a bright one, so it reads against any sky.
    const n = this.shoulderPts * 2;
    const from = n - 2;
    const to = pts.length - n + 2;
    ctx.lineJoin = 'round';
    ctx.save();
    ctx.translate(0, -0.06);
    ctx.beginPath();
    this.tracePoints(ctx, pts, from, to);
    ctx.strokeStyle = lit.a(DEEP, 0.55);
    ctx.lineWidth = 0.07;
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    this.tracePoints(ctx, pts, from, to);
    ctx.strokeStyle = s.night ? 'rgba(175,195,232,0.85)' : lit.a('#F4FBFA', 0.95);
    ctx.lineWidth = 0.06;
    ctx.stroke();
    // The shoulders: white water spilling down to the banks.
    this.spill(s, 0, n, 1);
    this.spill(s, pts.length - n, pts.length, -1);
  }

  /** Foam broken along a shoulder (points [from, to) of this.top), running down it; `inward` +1 at the left end. */
  private spill(s: Scene, from: number, to: number, inward: 1 | -1): void {
    const { ctx } = s;
    const pts = this.top;
    const col = s.night ? '185,200,232' : '248,252,250';
    ctx.lineCap = 'round';
    ctx.lineWidth = 0.09;
    ctx.setLineDash([0.28, 0.2]);
    ctx.lineDashOffset = -s.t * 1.6 * inward;
    ctx.strokeStyle = `rgba(${col},0.85)`;
    ctx.beginPath();
    this.tracePoints(ctx, pts, from, to);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    // Churned water where it runs out onto the bank.
    const bx = inward > 0 ? pts[from] : pts[to - 2];
    ctx.fillStyle = `rgba(${col},0.55)`;
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const x = bx + inward * (0.3 + 0.35 * k) + 0.05 * Math.sin(s.t * 5 + k);
      const y = BANK_TOP_Y + 0.05 + 0.06 * Math.sin(s.t * 7 + k * 2);
      ctx.moveTo(x + 0.22, y);
      ctx.ellipse(x, y, 0.22, 0.08, 0, 0, TAU);
    }
    ctx.fill();
    ctx.lineCap = 'butt';
  }

  /** Foam on the bow waves and trailing back from them along the surface. */
  private foam(s: Scene): void {
    const { ctx } = s;
    const waves = this.waves;
    if (waves.length === 0) return;
    const col = s.night ? '190,205,235' : '250,252,250';
    for (let i = 0; i < waves.length; i++) {
      const w = waves[i];
      const k = clamp01((w.h - 0.04) / 0.4);
      if (k <= 0.02) continue;
      ctx.fillStyle = `rgba(${col},${(0.55 + 0.35 * k).toFixed(3)})`;
      ctx.beginPath();
      const n = 4 + Math.round(4 * k);
      for (let j = 0; j < n; j++) {
        const f = (j + 0.5) / n;
        const x = w.x + (f - 0.6) * 2.4 * w.w + 0.06 * Math.sin(s.t * 13 + j * 2.1);
        const y = surfaceY(x, x + s.odo, s.t, waves) + 0.01;
        const r = (0.09 + 0.1 * k) * (0.7 + 0.5 * Math.sin(j * 1.7 + s.t * 7) ** 2);
        ctx.moveTo(x + r * 1.6, y);
        ctx.ellipse(x, y, r * 1.6, r * 0.8, 0, 0, TAU);
      }
      ctx.fill();
      // Churned water streaming back from the wave along the surface.
      ctx.strokeStyle = `rgba(${col},${(0.4 * k).toFixed(3)})`;
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      for (let j = 0; j < 3; j++) {
        const x = w.x - w.w - 0.4 - j * 0.9 - ((s.t * 3 + j * 0.37) % 0.9);
        const y = surfaceY(x, x + s.odo, s.t, waves) - 0.05 - 0.07 * j;
        ctx.moveTo(x, y);
        ctx.lineTo(x - 0.5 - 0.3 * k, y + 0.01);
      }
      ctx.stroke();
    }
  }

  /** Reeds on the near bank beside the ford end `xe` (side −1 left, +1 right), in front of the water. */
  private reeds(s: Scene, xe: number, side: -1 | 1, seed: number): void {
    const { ctx } = s;
    const lit = s.lit;
    const near = bankX(xe, side, -2);
    if (near < s.left - 4 || near > s.right + 4) return;
    ctx.lineCap = 'round';
    for (let c = 0; c < 3; c++) {
      const y = BANK_TOP_Y - 0.7 - 1.3 * c - 0.6 * hash01(seed + c, 161);
      const x = bankX(xe, side, y) + side * (0.4 + 0.7 * hash01(seed + c, 162));
      const blades = 5 + Math.floor(4 * hash01(seed + c, 163));
      for (let j = 0; j < blades; j++) {
        const h = 0.55 + 0.6 * hash01(seed * 7 + c * 13 + j, 164);
        const lean = (hash01(seed + c * 5 + j, 165) - 0.5) * 0.6 + 0.08 * Math.sin(s.t * 1.7 + j + c) + 0.1 * s.wind * (s.v >= 0 ? -1 : 1);
        const bx = x + (j - blades / 2) * 0.07;
        ctx.strokeStyle = lit.c(j % 2 === 0 ? REED : REED_DARK);
        ctx.lineWidth = 0.05;
        ctx.beginPath();
        ctx.moveTo(bx, y);
        ctx.quadraticCurveTo(bx + lean * h * 0.3, y + h * 0.6, bx + lean * h, y + h);
        ctx.stroke();
        if (j % 3 === 1) {
          // A cattail.
          ctx.fillStyle = lit.c(CATTAIL);
          ctx.beginPath();
          ctx.ellipse(bx + lean * h * 0.85, y + h * 0.9, 0.05, 0.14, -lean * 0.8, 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.lineCap = 'butt';
  }
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % 100000;
}
