// Parallax layers (spec §18.2): the far buttes at 0.05, the mid hills at 0.35, the ground at 1.0.
//
// A layer has its own coordinate u (metres at the view's scale). The camera's world position is
// the odometer plus the camera's train-frame x, and a layer at parallax p is drawn shifted by p
// times that, so a parallax-1 layer moves exactly with the track. Layer content is a pure
// function of u (seeded by integer cells), so it is continuous along the odometer, and far
// layers can be cached as tiles of fixed width.

export function wrap(v: number, period: number): number {
  const r = v % period;
  return r < 0 ? r + period : r === 0 ? 0 : r;
}

/** Screen x (CSS px) of layer coordinate u on a layer at parallax p. */
export function layerScreenX(u: number, p: number, camWorld: number, k: number, w: number): number {
  return w / 2 + (u - p * camWorld) * k;
}

/** The layer coordinates at the left and right edges of the view. */
export function layerRange(p: number, camWorld: number, k: number, w: number): [number, number] {
  const c = p * camWorld;
  const half = w / (2 * k);
  return [c - half, c + half];
}

/** First and last tile index (tiles of width tileW, tile i covers [i·tileW, (i+1)·tileW)) over [u0, u1]. */
export function tileSpan(u0: number, u1: number, tileW: number): [number, number] {
  return [Math.floor(u0 / tileW), Math.floor(u1 / tileW)];
}

/** A repeatable hash of an integer cell and a seed to [0, 1). */
export function hash01(i: number, seed: number): number {
  let h = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(seed | 0, 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in [0, 1], continuous in u (cells of width 1). */
export function noise1(u: number, seed: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const s = f * f * (3 - 2 * f);
  return hash01(i, seed) * (1 - s) + hash01(i + 1, seed) * s;
}
