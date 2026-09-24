// Seeded PRNG (sfc32). The state is a plain number[4] so it can live inside GameState,
// survive JSON round-trips and take part in the determinism hash.

export type RngState = number[];

/** Expands a 32-bit seed into sfc32 state with splitmix32, then warms the generator up. */
export function seedRng(seed: number): RngState {
  let s = seed >>> 0;
  const split = (): number => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
  const st = [split(), split(), split(), split()];
  for (let i = 0; i < 15; i++) nextU32(st);
  return st;
}

/** Advances the state in place and returns an unsigned 32-bit integer. */
export function nextU32(st: RngState): number {
  let a = st[0] | 0;
  let b = st[1] | 0;
  let c = st[2] | 0;
  let d = st[3] | 0;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  st[0] = a >>> 0;
  st[1] = b >>> 0;
  st[2] = c >>> 0;
  st[3] = d >>> 0;
  return t >>> 0;
}

/** Uniform float in [0, 1). */
export function rand(st: RngState): number {
  return nextU32(st) / 4294967296;
}

/** Uniform integer in [0, n). */
export function randInt(st: RngState, n: number): number {
  return Math.floor(rand(st) * n);
}

/** Uniform integer in [lo, hi], inclusive. */
export function randRange(st: RngState, lo: number, hi: number): number {
  return lo + randInt(st, hi - lo + 1);
}

export function chance(st: RngState, p: number): boolean {
  return rand(st) < p;
}

export function pick<T>(st: RngState, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('pick from empty array');
  return arr[randInt(st, arr.length)];
}

/** Fisher–Yates shuffle, in place. Returns the same array. */
export function shuffle<T>(st: RngState, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(st, i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
