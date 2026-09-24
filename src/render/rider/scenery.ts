// Scenery behind the train (spec §18.2 layers 1–4): the sky by time of day with the sun or the moon
// and stars, far buttes and mesas (parallax 0.05, cached as tiles), mid hills with cacti, trees,
// towns and telegraph poles (0.35), the ground, and the track itself (1.0), scrolling with the
// odometer. Terrain comes from the trackside scan: each stretch of track has a terrain, and the
// scenery crossfades where it changes.

import type { Terrain, TracksideItem } from '../../sim/types';
import { PALETTE } from '../palette';
import { screenY, worldX } from './camera';
import { hash01, layerRange, layerScreenX, noise1, tileSpan } from './parallax';
import { clamp01, setScreen, setWorld, TAU, type Scene } from './scene';
import { hexRgb, rgbStr, type RGB } from './sky';
import { glowSprite } from './sprites';

// ---- Vertical layout (world metres above the rail tops) -------------------------------------

/** Where the far plain meets the sky. */
export const HORIZON_Y = 2.7;
/** Base line of the mid layer's hills and props. */
export const MID_BASE_Y = 1.85;
/** The track bed: bottom of the ballast shoulder. */
export const BALLAST_Y = -0.95;
/**
 * Where horses' hooves are. The sim puts a horseman's rider (saddle to hat) at train-frame y
 * 1.5–2.7 (src/sim/fight.ts), so the horses run at track level, in front of the train, and the
 * drawn rider sits exactly where shots hit.
 */
export const LANE_Y = -0.08;
/** Base of near-side signs and stands, just in front of the ballast. */
export const NEAR_Y = -1.25;
/** Below the bottom of any view (19 m tall with the rails at 76 %: −4.56 m), for fills that must reach it. */
export const FLOOR_Y = -6;

const FAR_P = 0.05;
const FARTHER_P = 0.022;
const MID_P = 0.35;
const TILE_W = 24;
const FAR_TOP = 13;
const TIE_PITCH = 0.62;

const TERRAINS: readonly Terrain[] = ['desert', 'canyon', 'hills', 'river', 'town', 'mesa'];

/** Ground and hill colours per terrain (before haze and light). */
const GROUND: Record<Terrain, string> = {
  desert: '#D9B77E',
  canyon: '#C98A5E',
  hills: '#B9B07A',
  river: '#BDB27E',
  town: '#C9A777',
  mesa: '#CFA06B',
};
/** Mid-hill colours: more saturated and darker than the far mesas, so the layers separate. */
const HILLS: Record<Terrain, string> = {
  desert: '#A8784A',
  canyon: '#9A4A30',
  hills: '#7E8A52',
  river: '#86905A',
  town: '#A07A52',
  mesa: '#A05A3A',
};

/** The terrain at train-frame x and a neighbour it blends into near a boundary. */
export interface TerrainMix {
  a: Terrain;
  b: Terrain;
  t: number;
}

const BLEND_M = 7;

export function terrainMix(items: readonly TracksideItem[], x: number, out: TerrainMix): TerrainMix {
  let first: (TracksideItem & { kind: 'terrain' }) | null = null;
  let last: (TracksideItem & { kind: 'terrain' }) | null = null;
  out.a = 'desert';
  out.b = 'desert';
  out.t = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== 'terrain') continue;
    if (!first) first = it;
    last = it;
    if (x >= it.x0 && x < it.x1) {
      out.a = it.terrain;
      out.b = it.terrain;
      // Blend toward the neighbour across the boundary.
      const dEnd = it.x1 - x;
      const dStart = x - it.x0;
      if (dEnd < BLEND_M) {
        const nx = nextTerrain(items, i, 1);
        if (nx && nx !== it.terrain) {
          out.b = nx;
          out.t = 0.5 * (1 - dEnd / BLEND_M);
        }
      } else if (dStart < BLEND_M) {
        const pv = nextTerrain(items, i, -1);
        if (pv && pv !== it.terrain) {
          out.b = pv;
          out.t = 0.5 * (1 - dStart / BLEND_M);
        }
      }
      return out;
    }
  }
  if (first && x < first.x0) out.a = out.b = first.terrain;
  else if (last) out.a = out.b = last.terrain;
  return out;
}

function nextTerrain(items: readonly TracksideItem[], i: number, dir: 1 | -1): Terrain | null {
  for (let j = i + dir; j >= 0 && j < items.length; j += dir) {
    const it = items[j];
    if (it.kind === 'terrain') return it.terrain;
  }
  return null;
}

function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function mulRgb(a: RGB, m: RGB): RGB {
  return [a[0] * m[0], a[1] * m[1], a[2] * m[2]];
}

const GROUND_RGB = Object.fromEntries(TERRAINS.map((t) => [t, hexRgb(GROUND[t])])) as Record<Terrain, RGB>;
const HILLS_RGB = Object.fromEntries(TERRAINS.map((t) => [t, hexRgb(HILLS[t])])) as Record<Terrain, RGB>;

interface Tile {
  canvas: HTMLCanvasElement;
  i: number;
  used: number;
}

/** Star positions (fractions of the view) and sizes, fixed. */
const STARS: readonly [number, number, number, number][] = Array.from({ length: 150 }, (_, i) => [
  hash01(i, 11),
  Math.pow(hash01(i, 12), 1.4) * 0.64,
  0.6 + 1.6 * Math.pow(hash01(i, 13), 3),
  hash01(i, 14) * TAU,
]);

export class Scenery {
  private readonly tiles: Tile[] = [];
  private tileKey = '';
  private frame = 0;
  private readonly mix: TerrainMix = { a: 'desert', b: 'desert', t: 0 };
  /** Ground colour at the view's centre, eased (for the parts drawn in one colour). */
  private groundNow: RGB = [217, 183, 126];
  private hillsNow: RGB = [199, 158, 104];

  // ---- Sky --------------------------------------------------------------------------------

  drawSky(s: Scene): void {
    const { ctx, cam } = s;
    setScreen(s);
    const hy = screenY(cam, HORIZON_Y);
    const grad = ctx.createLinearGradient(0, 0, 0, Math.max(1, hy));
    grad.addColorStop(0, rgbStr(s.sky.top));
    grad.addColorStop(1, rgbStr(s.sky.horizon));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cam.w, Math.ceil(hy) + 2);
    const nightness = nightWeight(s);
    if (nightness > 0.02) this.drawStars(s, nightness, hy);
    if (s.sky.sun > -0.08 && !s.night) this.drawSun(s, hy);
    if (nightness > 0.05) this.drawMoon(s, nightness);
    this.drawClouds(s, hy);
  }

  private drawStars(s: Scene, a: number, hy: number): void {
    const { ctx, cam } = s;
    ctx.fillStyle = '#EAF0FF';
    for (let i = 0; i < STARS.length; i++) {
      const [fx, fy, size, ph] = STARS[i];
      const y = fy * cam.h;
      if (y > hy - 4) continue;
      const tw = 0.6 + 0.4 * Math.sin(s.now * (0.8 + (i % 5) * 0.37) + ph);
      ctx.globalAlpha = a * tw * (size > 1.5 ? 1 : 0.75);
      ctx.fillRect(fx * cam.w, y, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private drawSun(s: Scene, hy: number): void {
    const { ctx, cam } = s;
    const e = s.sky.sun;
    // Its arc tops out below the HUD's train strip.
    const x = cam.w * (0.14 + 0.72 * s.sky.sunT);
    const y = hy - Math.max(-0.1, e) * (hy - cam.h * 0.24);
    const r = cam.k * (0.75 + 0.35 * (1 - clamp01(e * 2)));
    const low = 1 - clamp01(e * 2.2);
    const core = low > 0.5 ? '255,176,96' : '255,238,200';
    const g = glowSprite(core);
    if (g) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 + 0.25 * low;
      const R = r * (7 + 5 * low);
      ctx.drawImage(g, x - R, y - R, 2 * R, 2 * R);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = low > 0.5 ? '#FFC47E' : '#FFF6DE';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  private drawMoon(s: Scene, a: number): void {
    const { ctx, cam } = s;
    const x = cam.w * 0.78;
    const y = cam.h * 0.17;
    const r = cam.k * 0.55;
    const g = glowSprite('190,205,235');
    if (g) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.35 * a;
      ctx.drawImage(g, x - r * 6, y - r * 6, r * 12, r * 12);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = PALETTE.lunar;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,165,190,0.45)';
    ctx.beginPath();
    ctx.arc(x - r * 0.3, y - r * 0.2, r * 0.22, 0, TAU);
    ctx.arc(x + r * 0.25, y + r * 0.3, r * 0.15, 0, TAU);
    ctx.arc(x + r * 0.35, y - r * 0.35, r * 0.1, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** A few long high clouds, drifting slowly (parallax 0.015 plus their own drift). */
  private drawClouds(s: Scene, hy: number): void {
    const { ctx, cam } = s;
    const camWorld = s.odo + cam.x;
    const day = 1 - nightWeight(s);
    const warm = s.sky.a === 'dawn' || s.sky.a === 'dusk' || s.sky.b === 'dusk' || s.sky.b === 'dawn';
    const col = s.night ? 'rgba(70,82,112,' : warm ? 'rgba(255,214,190,' : 'rgba(255,252,246,';
    const [u0, u1] = layerRange(0.015, camWorld + s.t * 60, cam.k, cam.w);
    const cell = 30;
    for (let i = Math.floor(u0 / cell) - 1; i <= Math.floor(u1 / cell) + 1; i++) {
      if (hash01(i, 71) > 0.55) continue;
      const u = i * cell + hash01(i, 72) * cell;
      const x = layerScreenX(u, 0.015, camWorld + s.t * 60, cam.k, cam.w);
      const y = cam.h * (0.08 + 0.3 * hash01(i, 73));
      if (y > hy - 30) continue;
      const len = cam.k * (6 + 10 * hash01(i, 74));
      const th = cam.k * (0.25 + 0.35 * hash01(i, 75));
      const alpha = (0.28 + 0.3 * hash01(i, 76)) * (s.night ? 0.8 : 0.4 + 0.6 * day);
      ctx.fillStyle = `${col}${alpha.toFixed(3)})`;
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        const ox = (hash01(i * 7 + j, 77) - 0.5) * len * 0.6;
        const oy = (hash01(i * 7 + j, 78) - 0.5) * th * 1.4;
        const rx = len * (0.28 + 0.2 * hash01(i * 7 + j, 79));
        ctx.ellipse(x + ox, y + oy, rx, th * (0.5 + 0.4 * hash01(i * 7 + j, 80)), 0, 0, TAU);
      }
      ctx.fill();
    }
  }

  // ---- Far buttes and mesas (parallax 0.05, cached tiles) ------------------------------------

  drawFar(s: Scene): void {
    const { ctx, cam } = s;
    setScreen(s);
    this.frame++;
    const camWorld = s.odo + cam.x;
    const skyRgb = s.sky.horizon;
    const hazeK = s.night ? 0.25 : 0.62;
    // The farthest range: a pale smooth band, drawn live.
    {
      const [u0, u1] = layerRange(FARTHER_P, camWorld, cam.k, cam.w);
      const base = mixRgb(hexRgb('#9E8A9A'), skyRgb, s.night ? 0.55 : 0.72);
      const c = mulRgb(base, s.night ? [0.55, 0.6, 0.8] : [1, 1, 1]);
      ctx.fillStyle = rgbStr(c);
      ctx.beginPath();
      const hy = screenY(cam, HORIZON_Y - 0.2);
      ctx.moveTo(0, hy);
      const step = 0.9;
      for (let u = Math.floor(u0 / step) * step; u <= u1 + step; u += step) {
        const h = 2.2 + 2.6 * noise1(u / 9, 5) + 1.2 * noise1(u / 3.1, 6);
        const flat = Math.min(h, 3.4 + 0.8 * noise1(u / 23, 7));
        ctx.lineTo(layerScreenX(u, FARTHER_P, camWorld, cam.k, cam.w), screenY(cam, HORIZON_Y + flat));
      }
      ctx.lineTo(cam.w, hy);
      ctx.closePath();
      ctx.fill();
    }
    const rs = Math.min(s.dpr, 1.5);
    const key = `${cam.k.toFixed(3)}|${rs}|${Math.round(skyRgb[0] / 6)},${Math.round(skyRgb[1] / 6)},${Math.round(skyRgb[2] / 6)}|${s.night ? 1 : 0}|${hazeK}`;
    if (key !== this.tileKey) {
      this.tiles.length = 0;
      this.tileKey = key;
    }
    const [u0, u1] = layerRange(FAR_P, camWorld, cam.k, cam.w);
    const [i0, i1] = tileSpan(u0, u1, TILE_W);
    const topY = screenY(cam, HORIZON_Y + FAR_TOP);
    const hPx = (FAR_TOP + 1) * cam.k;
    for (let i = i0; i <= i1; i++) {
      const tile = this.tile(s, i, rs, skyRgb, hazeK);
      if (!tile) continue;
      const x = layerScreenX(i * TILE_W, FAR_P, camWorld, cam.k, cam.w);
      const wPx = TILE_W * cam.k;
      ctx.drawImage(tile.canvas, x, topY, wPx + 0.5, hPx);
      if (!s.night && s.sky.light > 0.85) this.heatHaze(s, tile.canvas, x, topY, wPx, hPx);
    }
    // Golden hour: a low sun floods the far country with warm light.
    const e = s.sky.sun;
    if (!s.night && e > -0.05 && e < 0.35) {
      const g = glowSprite('255,170,90');
      if (g) {
        const hy = screenY(cam, HORIZON_Y);
        const sx = cam.w * (0.14 + 0.72 * s.sky.sunT);
        const R = cam.w * 0.55;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.32 * (1 - Math.max(0, e) / 0.35);
        ctx.drawImage(g, sx - R, hy - R * 0.7, 2 * R, 1.4 * R);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  /**
   * A heat shimmer by day: the bottom of the far layer (the distant plain) redrawn in thin
   * horizontal slices, each nudged sideways by a slow wave.
   */
  private heatHaze(s: Scene, src: HTMLCanvasElement, x: number, topY: number, wPx: number, hPx: number): void {
    const { ctx } = s;
    const band = 1.0 * s.cam.k;
    const slice = Math.max(3, Math.round(s.cam.k * 0.08));
    const sy0 = hPx - 1 * s.cam.k - band;
    const scaleY = src.height / hPx;
    ctx.globalAlpha = 0.85;
    for (let y = 0; y < band; y += slice) {
      const off = 1.4 * Math.sin((sy0 + y) * 0.21 + s.t * 2.7) * clamp01(y / band + 0.3);
      ctx.drawImage(src, 0, (sy0 + y) * scaleY, src.width, slice * scaleY, x + off, topY + sy0 + y, wPx + 0.5, slice);
    }
    ctx.globalAlpha = 1;
  }

  private tile(s: Scene, i: number, rs: number, skyRgb: RGB, hazeK: number): Tile | null {
    for (const t of this.tiles) {
      if (t.i === i) {
        t.used = this.frame;
        return t;
      }
    }
    const k = s.cam.k * rs;
    const w = Math.ceil(TILE_W * k) + 1;
    const h = Math.ceil((FAR_TOP + 1) * k);
    let canvas: HTMLCanvasElement;
    if (this.tiles.length >= 5) {
      // Reuse the least recently used tile's canvas.
      let lru = 0;
      for (let j = 1; j < this.tiles.length; j++) if (this.tiles[j].used < this.tiles[lru].used) lru = j;
      canvas = this.tiles[lru].canvas;
      this.tiles.splice(lru, 1);
    } else {
      canvas = document.createElement('canvas');
    }
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, w, h);
    paintFarTile(g, i, k, w, h, skyRgb, hazeK, s.night);
    const tile: Tile = { canvas, i, used: this.frame };
    this.tiles.push(tile);
    return tile;
  }

  // ---- Ground plane, mid hills and props -------------------------------------------------------

  /** The plain from the horizon down (drawn before the mid layer so hills stand on it). */
  drawGround(s: Scene, items: readonly TracksideItem[]): void {
    const { ctx, cam } = s;
    setScreen(s);
    const mid = terrainMix(items, cam.x, this.mix);
    const target = mixRgb(GROUND_RGB[mid.a], GROUND_RGB[mid.b], mid.t);
    const targetH = mixRgb(HILLS_RGB[mid.a], HILLS_RGB[mid.b], mid.t);
    const e = s.dt > 0 ? 1 - Math.exp(-s.dt / 0.6) : 0;
    for (let c = 0; c < 3; c++) {
      this.groundNow[c] += (target[c] - this.groundNow[c]) * (this.frame < 3 ? 1 : e);
      this.hillsNow[c] += (targetH[c] - this.hillsNow[c]) * (this.frame < 3 ? 1 : e);
    }
    const amb = s.sky.amb;
    const hy = screenY(cam, HORIZON_Y);
    const far = mulRgb(mixRgb(this.groundNow, s.sky.horizon, s.night ? 0.35 : 0.45), amb);
    const near = mulRgb(this.groundNow, amb);
    const grad = ctx.createLinearGradient(0, hy, 0, cam.h);
    grad.addColorStop(0, rgbStr(far));
    grad.addColorStop(0.35, rgbStr(mixRgb(far, near, 0.7)));
    grad.addColorStop(1, rgbStr(mulRgb(near, [0.93, 0.9, 0.86])));
    ctx.fillStyle = grad;
    ctx.fillRect(0, Math.floor(hy), cam.w, cam.h - Math.floor(hy));
  }

  drawMid(s: Scene, items: readonly TracksideItem[]): void {
    const { ctx, cam } = s;
    setScreen(s);
    const camWorld = s.odo + cam.x;
    const [u0, u1] = layerRange(MID_P, camWorld, cam.k, cam.w);
    const amb = s.sky.amb;
    const haze = s.night ? 0.2 : 0.2;
    const hillRgb = mulRgb(mixRgb(this.hillsNow, s.sky.horizon, haze), amb);
    const hillDark = mulRgb(hillRgb, [0.86, 0.84, 0.82]);
    // Rolling hills: a smooth profile, taller in canyon and mesa country.
    const mix = terrainMix(items, cam.x, this.mix);
    const tall = (mix.a === 'canyon' || mix.a === 'mesa' ? 1 - mix.t : 0) + (mix.b === 'canyon' || mix.b === 'mesa' ? mix.t : 0);
    const flat = (mix.a === 'river' || mix.a === 'town' ? 1 - mix.t : 0) + (mix.b === 'river' || mix.b === 'town' ? mix.t : 0);
    const amp = 5.2 + 2.2 * tall - 2.6 * flat;
    const baseY = screenY(cam, MID_BASE_Y - 0.25);
    const grad = ctx.createLinearGradient(0, screenY(cam, MID_BASE_Y + amp + 1.5), 0, baseY);
    grad.addColorStop(0, rgbStr(hillRgb));
    grad.addColorStop(1, rgbStr(mixRgb(hillDark, mulRgb(this.groundNow, amb), 0.55)));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-2, baseY);
    const step = 0.7;
    for (let u = Math.floor(u0 / step) * step - step; u <= u1 + step; u += step) {
      let h = 0.3 + amp * (0.62 * noise1(u / 9, 21) + 0.25 * noise1(u / 3.1, 22)) * (0.55 + 0.45 * noise1(u / 23, 25)) + 0.15 * noise1(u / 0.9, 23);
      if (tall > 0.3) {
        // Canyon and mesa country: flat-topped benches with steep steps.
        const bench = Math.round(noise1(u / 5, 24) * 3) / 3;
        h = h * (1 - tall * 0.6) + tall * 0.6 * (0.6 + amp * bench);
      }
      ctx.lineTo(layerScreenX(u, MID_P, camWorld, cam.k, cam.w), screenY(cam, MID_BASE_Y + h));
    }
    ctx.lineTo(cam.w + 2, baseY);
    ctx.closePath();
    ctx.fill();
    // A lit rim along the crests, and scrub dotted over the slopes.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = rgbStr(mulRgb(hillDark, [0.78, 0.8, 0.78]), 0.55);
    const cell = 1.1;
    for (let n = Math.floor(u0 / cell) - 1; n <= Math.floor(u1 / cell) + 1; n++) {
      if (hash01(n, 26) > 0.55) continue;
      const sx = layerScreenX(n * cell + hash01(n, 27) * cell, MID_P, camWorld, cam.k, cam.w);
      const sy = screenY(cam, MID_BASE_Y + 0.4 + hash01(n, 28) * amp * 0.7);
      const r = cam.k * (0.1 + 0.12 * hash01(n, 29));
      ctx.beginPath();
      ctx.ellipse(sx, sy, r * 1.6, r, 0, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = rgbStr(mulRgb(mixRgb(this.hillsNow, [255, 240, 210], 0.35), amb), 0.5);
    ctx.lineWidth = Math.max(1, cam.k * 0.05);
    ctx.stroke();
    // Canyon strata on the hills.
    if (tall > 0.2) {
      ctx.save();
      ctx.clip();
      ctx.globalAlpha = 0.18 * tall;
      ctx.fillStyle = s.night ? '#10141E' : '#6E2E1E';
      for (let b = 0; b < 4; b++) {
        const y = screenY(cam, MID_BASE_Y + 0.8 + b * 0.75);
        ctx.fillRect(0, y, cam.w, cam.k * 0.14);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    this.drawMidProps(s, items, u0, u1, camWorld);
    this.drawTelegraph(s, u0, u1, camWorld);
  }

  private drawMidProps(s: Scene, items: readonly TracksideItem[], u0: number, u1: number, camWorld: number): void {
    const { cam } = s;
    const cell = 6.5;
    const mix = this.mix;
    for (let i = Math.floor(u0 / cell) - 2; i <= Math.floor(u1 / cell) + 2; i++) {
      const r = hash01(i, 31);
      const u = i * cell + hash01(i, 32) * cell * 0.8;
      const sx = layerScreenX(u, MID_P, camWorld, cam.k, cam.w);
      if (sx < -cam.k * 6 || sx > cam.w + cam.k * 6) continue;
      terrainMix(items, worldX(cam, sx), mix);
      const depth = hash01(i, 33);
      if (mix.t < 0.98) this.prop(s, mix.a, r, i, sx, depth, 1 - mix.t);
      if (mix.t > 0.02) this.prop(s, mix.b, r, i, sx, depth, mix.t);
    }
  }

  private prop(s: Scene, t: Terrain, r: number, i: number, sx: number, depth: number, alpha: number): void {
    const { ctx, cam } = s;
    const y0 = screenY(cam, MID_BASE_Y + 0.15 - depth * 0.35);
    const sc = cam.k * (0.8 + 0.25 * (1 - depth));
    const amb = s.sky.amb;
    const hz = s.night ? 0.25 : 0.22;
    const col = (hex: string, k = 1): string => rgbStr(mulRgb(mixRgb(hexRgb(hex), s.sky.horizon, hz), [amb[0] * k, amb[1] * k, amb[2] * k]));
    ctx.globalAlpha = alpha;
    switch (t) {
      case 'desert':
        if (r < 0.45) saguaro(ctx, sx, y0, sc * (0.9 + 0.5 * hash01(i, 34)), col('#5E7A4A'), col('#465E36'), hash01(i, 35));
        else if (r < 0.7) pricklyPear(ctx, sx, y0, sc, col('#6C8A50'));
        else if (r < 0.82) rocks(ctx, sx, y0, sc * 0.8, col('#A0785A'), i);
        break;
      case 'canyon':
        if (r < 0.4) hoodoo(ctx, sx, y0, sc * (1 + hash01(i, 36)), col('#B0603E'), col('#8A4630'), i);
        else if (r < 0.75) rocks(ctx, sx, y0, sc, col('#9A5A3C'), i);
        break;
      case 'hills':
      case 'mesa':
        if (r < 0.55) juniper(ctx, sx, y0, sc * (0.8 + 0.5 * hash01(i, 37)), col('#4E6A3E'), col('#3A5230'));
        else if (r < 0.75) rocks(ctx, sx, y0, sc * 0.9, col(t === 'mesa' ? '#A86A48' : '#948A6A'), i);
        break;
      case 'river':
        if (r < 0.5) cottonwood(ctx, sx, y0, sc * (1 + 0.4 * hash01(i, 38)), col('#6E8A48'), col('#546E38'), col('#5A4632'));
        else if (r < 0.8) reeds(ctx, sx, y0, sc, col('#7E8E52'));
        break;
      case 'town':
        if (r < 0.6) building(ctx, sx, y0, sc, col(hash01(i, 39) < 0.5 ? '#B89A74' : '#A07A5A'), col('#6E5440'), hash01(i, 40), s.night);
        else if (r < 0.72) windmill(ctx, sx, y0, sc, col('#6E5A48'), s.t);
        break;
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The telegraph line, far back with the mid hills: poles small with distance, wires below the
   * cars' roofline so they never cross the figures up there.
   */
  private drawTelegraph(s: Scene, u0: number, u1: number, camWorld: number): void {
    const { ctx, cam } = s;
    const pitch = 24;
    const amb = s.sky.amb;
    const wood = rgbStr(mulRgb(mixRgb(hexRgb('#4A3828'), s.sky.horizon, 0.3), amb));
    const wire = s.night ? 'rgba(20,24,34,0.6)' : 'rgba(46,38,32,0.4)';
    const base = screenY(cam, MID_BASE_Y - 0.25);
    const top = screenY(cam, MID_BASE_Y + 2.2);
    const arm = screenY(cam, MID_BASE_Y + 2.02);
    const w = Math.max(1.5, cam.k * 0.075);
    const i0 = Math.floor(u0 / pitch) - 1;
    const i1 = Math.floor(u1 / pitch) + 1;
    ctx.strokeStyle = wire;
    ctx.lineWidth = Math.max(1, cam.k * 0.025);
    ctx.beginPath();
    for (let i = i0; i < i1; i++) {
      const xa = layerScreenX(i * pitch, MID_P, camWorld, cam.k, cam.w);
      const xb = layerScreenX((i + 1) * pitch, MID_P, camWorld, cam.k, cam.w);
      for (const dx of [-0.34, 0.34]) {
        const ya = arm - cam.k * 0.06;
        const sag = cam.k * 0.3;
        ctx.moveTo(xa + dx * cam.k, ya);
        ctx.quadraticCurveTo((xa + xb) / 2 + dx * cam.k, ya + sag * 2, xb + dx * cam.k, ya);
      }
    }
    ctx.stroke();
    ctx.fillStyle = wood;
    for (let i = i0; i <= i1; i++) {
      const x = layerScreenX(i * pitch, MID_P, camWorld, cam.k, cam.w);
      ctx.fillRect(x - w / 2, top, w, base - top);
      ctx.fillRect(x - cam.k * 0.46, arm, cam.k * 0.92, Math.max(1.5, cam.k * 0.06));
      ctx.fillRect(x - cam.k * 0.38, arm - cam.k * 0.1, cam.k * 0.06, cam.k * 0.1);
      ctx.fillRect(x + cam.k * 0.32, arm - cam.k * 0.1, cam.k * 0.06, cam.k * 0.1);
    }
  }

  /** The near ground: scattered stones and tufts between the mid layer and the track, and in the lane. */
  drawNearGround(s: Scene, gaps: readonly number[]): void {
    const { ctx } = s;
    setWorld(s);
    const amb = s.sky.amb;
    const g = mulRgb(this.groundNow, amb);
    const dark = rgbStr(mulRgb(g, [0.72, 0.66, 0.6]));
    const light = rgbStr(mulRgb(g, [1.08, 1.06, 1.02]));
    const tuft = rgbStr(mulRgb(mixRgb(this.groundNow, hexRgb('#6E7A44'), 0.6), amb));
    const x0 = s.left - 2;
    const x1 = s.right + 2;
    // Bands at different depths: behind the track (moving slower is implied by sparser detail) and the lane.
    const bands: [number, number, number, number][] = [
      // [yTop, yBottom, pitch, seed]
      [MID_BASE_Y - 0.3, 0.3, 1.9, 51],
      [-1.1, -2.3, 1.3, 52],
      [-2.5, -4.4, 1.1, 53],
    ];
    for (const [yt, yb, pitch, seed] of bands) {
      const s0 = Math.floor((x0 + s.odo) / pitch);
      const s1 = Math.floor((x1 + s.odo) / pitch);
      for (let n = s0; n <= s1; n++) {
        const h = hash01(n, seed);
        if (h > 0.6) continue;
        const x = n * pitch + hash01(n, seed + 100) * pitch - s.odo;
        if (inGap(gaps, x, 1.5)) continue;
        const y = yb + (yt - yb) * hash01(n, seed + 200);
        const sz = 0.08 + 0.2 * hash01(n, seed + 300) * (1 - (y - yb) / Math.max(0.1, yt - yb) * 0.5);
        if (h < 0.22) {
          ctx.fillStyle = tuft;
          ctx.beginPath();
          ctx.moveTo(x - sz * 1.4, y);
          ctx.lineTo(x - sz * 0.5, y + sz * 2.2);
          ctx.lineTo(x, y + sz * 0.6);
          ctx.lineTo(x + sz * 0.4, y + sz * 2.6);
          ctx.lineTo(x + sz * 0.8, y + sz * 0.5);
          ctx.lineTo(x + sz * 1.6, y + sz * 1.8);
          ctx.lineTo(x + sz * 1.5, y);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.fillStyle = h < 0.45 ? dark : light;
          ctx.beginPath();
          ctx.ellipse(x, y + sz * 0.35, sz * 1.4, sz * 0.55, 0, 0, TAU);
          ctx.fill();
        }
      }
    }
  }

  // ---- The track (1.0) ---------------------------------------------------------------------

  /**
   * Ballast, tie ends and the near rail across the view, except over trestle gaps (drawn by the
   * trestle). At speed the ties blur into the ballast, so they don't strobe.
   */
  drawTrack(s: Scene, gaps: readonly number[]): void {
    const { ctx } = s;
    setWorld(s);
    const lit = s.lit;
    const x0 = s.left - 1;
    const x1 = s.right + 1;
    // Ballast shoulder.
    ctx.fillStyle = lit.c('#8C7B66');
    ctx.beginPath();
    this.bandPath(ctx, x0, x1, -0.28, BALLAST_Y, gaps, 0.6);
    ctx.fill();
    // Gravel speckle, streaked at speed.
    const blur = clamp01((Math.abs(s.v) - 4) / 14);
    const pitch = 0.23;
    const n0 = Math.floor((x0 + s.odo) / pitch);
    const n1 = Math.floor((x1 + s.odo) / pitch);
    ctx.fillStyle = lit.a('#5E5046', 0.55);
    ctx.beginPath();
    for (let n = n0; n <= n1; n++) {
      const h = hash01(n, 61);
      const x = n * pitch + h * pitch - s.odo;
      if (inGap(gaps, x, 0.4)) continue;
      const y = -0.36 - hash01(n, 62) * 0.5;
      const len = 0.06 + 0.05 * hash01(n, 63) + blur * 0.5;
      ctx.rect(x, y, len, 0.045);
    }
    ctx.fill();
    ctx.fillStyle = lit.a('#B8A68C', 0.5);
    ctx.beginPath();
    for (let n = n0; n <= n1; n += 2) {
      const x = n * pitch + hash01(n, 64) * pitch - s.odo;
      if (inGap(gaps, x, 0.4)) continue;
      const y = -0.4 - hash01(n, 65) * 0.42;
      ctx.rect(x, y, 0.05 + blur * 0.4, 0.035);
    }
    ctx.fill();
    // Tie ends.
    const t0 = Math.floor((x0 + s.odo) / TIE_PITCH);
    const t1 = Math.floor((x1 + s.odo) / TIE_PITCH);
    ctx.fillStyle = lit.a('#4A3626', 1 - 0.65 * blur);
    ctx.beginPath();
    for (let n = t0; n <= t1; n++) {
      const x = n * TIE_PITCH - s.odo;
      if (inGap(gaps, x, 0.2)) continue;
      ctx.rect(x - 0.13, -0.3, 0.26, 0.17);
    }
    ctx.fill();
    if (blur > 0) {
      ctx.fillStyle = lit.a('#4A3626', 0.35 * blur);
      ctx.beginPath();
      this.bandPath(ctx, x0, x1, -0.14, -0.3, gaps, 0);
      ctx.fill();
    }
    this.drawRail(s, x0, x1);
  }

  drawRail(s: Scene, x0: number, x1: number): void {
    const { ctx } = s;
    const lit = s.lit;
    ctx.fillStyle = lit.c('#3A3634');
    ctx.fillRect(x0, -0.15, x1 - x0, 0.11);
    ctx.fillStyle = lit.c('#6E6660');
    ctx.fillRect(x0, -0.06, x1 - x0, 0.06);
    ctx.fillStyle = lit.c('#C9C2B8');
    ctx.fillRect(x0, -0.02, x1 - x0, 0.022);
  }

  /** A horizontal band [yb, yt] from x0 to x1, with trestle gaps left out (inset by `pad`). */
  private bandPath(ctx: CanvasRenderingContext2D, x0: number, x1: number, yt: number, yb: number, gaps: readonly number[], pad: number): void {
    let x = x0;
    for (let i = 0; i < gaps.length; i += 2) {
      const g0 = gaps[i] - pad;
      const g1 = gaps[i + 1] + pad;
      if (g1 < x || g0 > x1) continue;
      if (g0 > x) ctx.rect(x, yb, g0 - x, yt - yb);
      x = Math.max(x, g1);
    }
    if (x < x1) ctx.rect(x, yb, x1 - x, yt - yb);
  }

  invalidate(): void {
    this.tiles.length = 0;
    this.tileKey = '';
  }
}

export function inGap(gaps: readonly number[], x: number, pad: number): boolean {
  for (let i = 0; i < gaps.length; i += 2) if (x > gaps[i] - pad && x < gaps[i + 1] + pad) return true;
  return false;
}

export function nightWeight(s: Scene): number {
  if (s.night) return 1;
  const { a, b, t } = s.sky;
  return (a === 'night' ? 1 - t : 0) + (b === 'night' ? t : 0);
}

// ---- The far tile painter --------------------------------------------------------------------

interface Feature {
  c: number;
  half: number;
  h: number;
  side: number;
}

/** Features of far cell j (16 m wide): a mesa, a butte or nothing. */
function farFeature(j: number, out: Feature): boolean {
  const r = hash01(j, 91);
  if (r < 0.18) return false;
  out.c = j * 16 + 3 + hash01(j, 92) * 10;
  const butte = r < 0.45;
  out.half = butte ? 1.2 + hash01(j, 93) * 2.2 : 3.5 + hash01(j, 94) * 6;
  out.h = butte ? 4 + hash01(j, 95) * 4.5 : 2.6 + hash01(j, 96) * 4.2;
  out.side = 0.7 + hash01(j, 97) * 1.2;
  return true;
}

const FEAT: Feature = { c: 0, half: 0, h: 0, side: 0 };

/** Height of the far skyline at layer coordinate u (m above the horizon). */
function farHeight(u: number): number {
  let h = 0.25 + 0.55 * noise1(u / 5, 81) + 0.2 * noise1(u / 1.3, 82);
  const j0 = Math.floor(u / 16);
  for (let j = j0 - 1; j <= j0 + 1; j++) {
    if (!farFeature(j, FEAT)) continue;
    const d = Math.abs(u - FEAT.c) - FEAT.half;
    let fh: number;
    if (d <= 0) {
      // Flat top with a little erosion.
      fh = FEAT.h - 0.12 * noise1(u * 1.7, j);
    } else if (d < FEAT.side) {
      // Cliff, then a concave talus slope.
      const q = d / FEAT.side;
      fh = FEAT.h * (q < 0.35 ? 1 - q * 0.5 : 0.82 * Math.pow(1 - (q - 0.35) / 0.65, 2.2));
    } else continue;
    h = Math.max(h, fh);
  }
  return h;
}

function paintFarTile(g: CanvasRenderingContext2D, i: number, k: number, w: number, h: number, sky: RGB, hazeK: number, night: boolean): void {
  const base = mixRgb(hexRgb(PALETTE.mesa), sky, hazeK);
  const lightFace = mixRgb(hexRgb('#C87A56'), sky, hazeK);
  const shadow = mixRgb(hexRgb('#6E3A2A'), sky, hazeK + (1 - hazeK) * 0.25);
  const tint: RGB = night ? [0.42, 0.48, 0.72] : [1, 1, 1];
  const u0 = i * TILE_W;
  // y in the tile: 0 at FAR_TOP above the horizon, h at 1 m below it.
  const yOf = (hm: number): number => (FAR_TOP - hm) * k;
  g.beginPath();
  g.moveTo(0, h);
  for (let px = 0; px <= w + 2; px += 2) {
    const u = u0 + px / k;
    g.lineTo(px, yOf(farHeight(u)));
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = rgbStr(mulRgb(base, tint));
  g.fill();
  g.save();
  g.clip();
  // Sunlit and shaded faces: compare the slope.
  g.fillStyle = rgbStr(mulRgb(lightFace, tint), 0.55);
  g.beginPath();
  for (let px = 0; px <= w; px += 3) {
    const u = u0 + px / k;
    const d = farHeight(u + 0.25) - farHeight(u - 0.25);
    if (d > 0.35) g.rect(px, yOf(farHeight(u)), 3, (farHeight(u) + 1) * k);
  }
  g.fill();
  g.fillStyle = rgbStr(mulRgb(shadow, tint), 0.5);
  g.beginPath();
  for (let px = 0; px <= w; px += 3) {
    const u = u0 + px / k;
    const d = farHeight(u + 0.25) - farHeight(u - 0.25);
    if (d < -0.35) g.rect(px, yOf(farHeight(u)), 3, (farHeight(u) + 1) * k);
  }
  g.fill();
  // Strata: pale and dark bands across the rock.
  for (let b = 0; b < 9; b++) {
    const y = yOf(1.2 + b * 0.9 + 0.25 * hash01(b, 99));
    g.fillStyle = b % 2 === 0 ? rgbStr(mulRgb(lightFace, tint), 0.22) : rgbStr(mulRgb(shadow, tint), 0.2);
    g.fillRect(0, y, w, k * (0.18 + 0.12 * hash01(b, 98)));
  }
  // Haze near the base.
  const grad = g.createLinearGradient(0, yOf(2.2), 0, yOf(-0.5));
  grad.addColorStop(0, rgbStr(sky, 0));
  grad.addColorStop(1, rgbStr(sky, night ? 0.35 : 0.55));
  g.fillStyle = grad;
  g.fillRect(0, yOf(2.2), w, h - yOf(2.2));
  g.restore();
  if (night) {
    // Moonlit rims along the tops.
    g.strokeStyle = 'rgba(150,170,210,0.25)';
    g.lineWidth = Math.max(1, k * 0.04);
    g.beginPath();
    for (let px = 0; px <= w + 2; px += 2) {
      const y = yOf(farHeight(u0 + px / k));
      if (px === 0) g.moveTo(px, y);
      else g.lineTo(px, y);
    }
    g.stroke();
  }
}

// ---- Mid-layer props (screen space, sc = px per metre) -----------------------------------------

function saguaro(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, dark: string, r: number): void {
  const h = 2.4 * sc;
  const w = 0.3 * sc;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h, w, h, w / 2);
  // Arms.
  const armY = y - h * (0.45 + 0.15 * r);
  ctx.roundRect(x - w * 2.1, armY - h * 0.28, w * 0.8, h * 0.3, w * 0.4);
  ctx.rect(x - w * 2.1 + w * 0.4, armY - w * 0.4, w * 1.8, w * 0.8);
  if (r > 0.35) {
    const a2 = y - h * (0.55 + 0.2 * r);
    ctx.roundRect(x + w * 1.3, a2 - h * 0.22, w * 0.8, h * 0.24, w * 0.4);
    ctx.rect(x, a2 - w * 0.4, w * 1.7, w * 0.8);
  }
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.fillRect(x + w * 0.1, y - h * 0.97, w * 0.25, h * 0.95);
}

function pricklyPear(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x, y - 0.25 * sc, 0.22 * sc, 0.3 * sc, -0.2, 0, TAU);
  ctx.ellipse(x + 0.3 * sc, y - 0.35 * sc, 0.2 * sc, 0.28 * sc, 0.3, 0, TAU);
  ctx.ellipse(x - 0.28 * sc, y - 0.2 * sc, 0.18 * sc, 0.22 * sc, -0.5, 0, TAU);
  ctx.ellipse(x + 0.12 * sc, y - 0.72 * sc, 0.17 * sc, 0.24 * sc, 0.1, 0, TAU);
  ctx.fill();
}

function rocks(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, seed: number): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let j = 0; j < 3; j++) {
    const rx = (0.25 + 0.35 * hash01(seed * 3 + j, 41)) * sc;
    const ry = rx * (0.6 + 0.3 * hash01(seed * 3 + j, 42));
    const ox = (j - 1) * rx * 1.1;
    ctx.ellipse(x + ox, y - ry * 0.6, rx, ry, 0, Math.PI, TAU);
  }
  ctx.fill();
}

function hoodoo(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, dark: string, seed: number): void {
  const n = 3 + Math.floor(hash01(seed, 43) * 2);
  let top = y;
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let j = 0; j < n; j++) {
    const hh = (0.45 + 0.25 * hash01(seed + j, 44)) * sc;
    const ww = (0.35 + 0.25 * hash01(seed + j, 45)) * sc * (j === n - 1 ? 1.3 : 1);
    ctx.ellipse(x, top - hh / 2, ww, hh / 2 + 1, 0, 0, TAU);
    top -= hh * 0.85;
  }
  ctx.fill();
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(x, top + 0.15 * sc, 0.45 * sc, 0.14 * sc, 0, 0, TAU);
  ctx.fill();
}

function juniper(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, dark: string): void {
  ctx.fillStyle = dark;
  ctx.fillRect(x - 0.05 * sc, y - 0.5 * sc, 0.1 * sc, 0.5 * sc);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x, y - 0.95 * sc, 0.6 * sc, 0.55 * sc, 0, 0, TAU);
  ctx.ellipse(x - 0.35 * sc, y - 0.7 * sc, 0.4 * sc, 0.35 * sc, 0, 0, TAU);
  ctx.ellipse(x + 0.38 * sc, y - 0.75 * sc, 0.38 * sc, 0.34 * sc, 0, 0, TAU);
  ctx.fill();
}

function cottonwood(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, dark: string, trunk: string): void {
  ctx.fillStyle = trunk;
  ctx.fillRect(x - 0.1 * sc, y - 1.4 * sc, 0.2 * sc, 1.4 * sc);
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(x + 0.2 * sc, y - 1.9 * sc, 1.1 * sc, 0.8 * sc, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x - 0.2 * sc, y - 2.1 * sc, 0.9 * sc, 0.75 * sc, 0, 0, TAU);
  ctx.ellipse(x + 0.5 * sc, y - 2.3 * sc, 0.6 * sc, 0.5 * sc, 0, 0, TAU);
  ctx.fill();
}

function reeds(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, stroke: string): void {
  ctx.strokeStyle = stroke;
  ctx.lineWidth = Math.max(1, 0.05 * sc);
  ctx.beginPath();
  for (let j = -3; j <= 3; j++) {
    ctx.moveTo(x + j * 0.12 * sc, y);
    ctx.quadraticCurveTo(x + j * 0.14 * sc, y - 0.4 * sc, x + j * 0.2 * sc + 0.1 * sc, y - (0.7 + 0.1 * Math.abs(j % 2)) * sc);
  }
  ctx.stroke();
}

function building(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, dark: string, r: number, night: boolean): void {
  const w = (1.6 + 1.2 * r) * sc;
  const h = (1.4 + 0.8 * r) * sc;
  ctx.fillStyle = fill;
  ctx.fillRect(x - w / 2, y - h, w, h);
  // False front.
  ctx.fillRect(x - w / 2, y - h - 0.35 * sc, w * 0.62, 0.36 * sc);
  ctx.fillStyle = dark;
  ctx.fillRect(x - w / 2, y - h, w, 0.08 * sc);
  const win = night ? '#F2C46A' : dark;
  ctx.fillStyle = win;
  ctx.fillRect(x - w * 0.3, y - h * 0.62, 0.22 * sc, 0.3 * sc);
  ctx.fillRect(x + w * 0.12, y - h * 0.62, 0.22 * sc, 0.3 * sc);
  ctx.fillStyle = dark;
  ctx.fillRect(x - 0.12 * sc, y - 0.55 * sc, 0.24 * sc, 0.55 * sc);
}

function windmill(ctx: CanvasRenderingContext2D, x: number, y: number, sc: number, fill: string, t: number): void {
  ctx.strokeStyle = fill;
  ctx.lineWidth = Math.max(1, 0.06 * sc);
  ctx.beginPath();
  ctx.moveTo(x - 0.4 * sc, y);
  ctx.lineTo(x, y - 2.6 * sc);
  ctx.lineTo(x + 0.4 * sc, y);
  ctx.moveTo(x - 0.25 * sc, y - 1.2 * sc);
  ctx.lineTo(x + 0.25 * sc, y - 1.2 * sc);
  ctx.stroke();
  const cx = x;
  const cy = y - 2.6 * sc;
  ctx.fillStyle = fill;
  ctx.beginPath();
  for (let b = 0; b < 12; b++) {
    const a = (b / 12) * TAU + t * 1.3;
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, 0.55 * sc, a, a + 0.18);
  }
  ctx.fill();
}

