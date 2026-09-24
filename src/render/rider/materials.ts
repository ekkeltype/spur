// Lit colours (spec §18.2: night lighting, tunnel darkness). Every painted colour is multiplied by
// the ambient light of where it is drawn: the sky's (day, dawn, dusk, night), a tunnel's, or a
// lamp-lit interior. Strings are built once per (colour, ambient) and cached, so drawing never
// formats colour strings per frame. Local lights (lamps, flashes) are added on top as glows.

import type { RGB } from './sky';

export class Lit {
  private readonly solid = new Map<string, string>();
  private readonly alpha = new Map<string, Map<number, string>>();

  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
  ) {}

  /** The lit version of a #RRGGBB colour. */
  c(hex: string): string {
    let s = this.solid.get(hex);
    if (s === undefined) {
      s = this.format(hex, 1);
      this.solid.set(hex, s);
    }
    return s;
  }

  /** The lit colour with alpha (quantised to 1/64). */
  a(hex: string, alpha: number): string {
    const q = Math.max(0, Math.min(64, Math.round(alpha * 64)));
    let m = this.alpha.get(hex);
    if (m === undefined) {
      m = new Map();
      this.alpha.set(hex, m);
    }
    let s = m.get(q);
    if (s === undefined) {
      s = this.format(hex, q / 64);
      m.set(q, s);
    }
    return s;
  }

  private format(hex: string, alpha: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = clampByte(((n >> 16) & 255) * this.r);
    const g = clampByte(((n >> 8) & 255) * this.g);
    const b = clampByte((n & 255) * this.b);
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
  }
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** Lit palettes by quantised ambient (1/40 steps), kept for reuse; a handful are live at once. */
export class LitCache {
  private readonly map = new Map<number, Lit>();

  get(r: number, g: number, b: number): Lit {
    const q = (v: number): number => Math.max(0, Math.min(63, Math.round(v * 40)));
    const key = (q(r) * 64 + q(g)) * 64 + q(b);
    let lit = this.map.get(key);
    if (lit === undefined) {
      if (this.map.size > 24) this.map.delete(this.map.keys().next().value as number);
      lit = new Lit(q(r) / 40, q(g) / 40, q(b) / 40);
      this.map.set(key, lit);
    }
    return lit;
  }

  rgb(c: RGB, k = 1): Lit {
    return this.get(c[0] * k, c[1] * k, c[2] * k);
  }
}
