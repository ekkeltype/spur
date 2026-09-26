// Tests for src/audio/sfx.ts that need no real WebAudio: the pure helpers (the engine's rhythms, the
// mixes that turn train state into levels, noise, curves, the volume curve), and the Sfx engine driven
// against a recording fake AudioContext that checks every scheduling call the way the real API would
// (finite values and times, no exponential ramp to or from 0, every voice ending). Rendering real audio is
// covered by the browser bench at /sfx.html (window.renderAll()).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHUFF_PATTERN,
  CHUFFS_PER_REV,
  DRIVER_CIRCUMFERENCE,
  GALLOP_STRIDE,
  RAIL_LENGTH,
  RAIL_PATTERN,
  ROD_PATTERN,
  Sfx,
  brakeMix,
  brownNoise,
  chuffRate,
  clamp,
  engineMix,
  fordMix,
  gallopPattern,
  gritNoise,
  karplusStrong,
  patternEvents,
  railClickRate,
  shotPlacement,
  smoothstep,
  softClipCurve,
  tanhCurve,
  volumeToGain,
  whiteNoise,
  windMix,
  type EngineInput,
  type Listener,
  type TrackPattern,
} from '../src/audio/sfx';
import type { Weapon } from '../src/sim/types';

// ---- Signal helpers ------------------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so the buffers under test are reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function peak(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

function mean(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return s / Math.max(1, x.length);
}

/** RMS of the first difference relative to RMS: about 2·sin(π·f/fs) for a tone at f, ~1.4 for white noise. */
function roughness(x: Float32Array, from = 0, to = x.length): number {
  let d = 0;
  for (let i = from + 1; i < to; i++) d += (x[i] - x[i - 1]) ** 2;
  return Math.sqrt(d / Math.max(1, to - from - 1)) / Math.max(1e-12, rms(x, from, to));
}

const allFinite = (x: Float32Array): boolean => x.every((v) => Number.isFinite(v));

const input = (speed: number, throttle: number, listener: Listener = 'rider', tunnel = false): EngineInput => ({ speed, throttle, tunnel, listener });

// ---- The locomotive's rhythms ---------------------------------------------------------------------------

describe('the exhaust and the rails', () => {
  it('beats four times per turn of a 5 m driver, whichever way the train runs', () => {
    expect(DRIVER_CIRCUMFERENCE).toBe(5);
    expect(CHUFFS_PER_REV).toBe(4);
    expect(chuffRate(0)).toBe(0);
    expect(chuffRate(5)).toBeCloseTo(4); // one turn a second
    expect(chuffRate(10)).toBeCloseTo(8);
    expect(chuffRate(-10)).toBeCloseTo(8);
    expect(chuffRate(27)).toBeCloseTo(21.6); // a light train flat out: a roar
    expect(chuffRate(Number.NaN)).toBe(0);
    expect(chuffRate(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clicks four times per 12 m rail: two axles of one truck, then two of the next', () => {
    expect(RAIL_LENGTH).toBe(12);
    expect(RAIL_PATTERN.period).toBe(12);
    expect(RAIL_PATTERN.offsets).toHaveLength(4);
    expect(railClickRate(12)).toBeCloseTo(4);
    expect(railClickRate(-24)).toBeCloseTo(8);
    expect(railClickRate(Number.NaN)).toBe(0);
    // Pairs: the gap inside each pair (axle spacing) is much shorter than the gap between the pairs.
    const [a, b, c, d] = RAIL_PATTERN.offsets;
    expect(b - a).toBeCloseTo(d - c);
    expect(c - b).toBeGreaterThan(1.8 * (b - a));
    expect(RAIL_LENGTH - d + a).toBeGreaterThan(c - b); // then the longest wait: the next joint
  });

  it('every pattern is sorted and lies inside one period', () => {
    const patterns: TrackPattern[] = [CHUFF_PATTERN, ROD_PATTERN, RAIL_PATTERN, gallopPattern(GALLOP_STRIDE)];
    for (const p of patterns) {
      expect(p.period).toBeGreaterThan(0);
      for (let i = 0; i < p.offsets.length; i++) {
        expect(p.offsets[i]).toBeGreaterThanOrEqual(0);
        expect(p.offsets[i]).toBeLessThan(p.period);
        if (i > 0) expect(p.offsets[i]).toBeGreaterThan(p.offsets[i - 1]);
      }
    }
    expect(CHUFF_PATTERN.period).toBe(DRIVER_CIRCUMFERENCE);
    expect(CHUFF_PATTERN.offsets).toHaveLength(CHUFFS_PER_REV);
  });

  it('schedules the beats passed at a speed: evenly spaced, cycling through the four cylinders', () => {
    const beats = patternEvents(CHUFF_PATTERN, 0, 10, 100, 101);
    expect(beats).toHaveLength(8);
    beats.forEach((b, k) => {
      expect(b.t).toBeCloseTo(100 + (k + 1) * 0.125, 9);
      expect(b.i).toBe((k + 1) % 4);
    });
  });

  it('places the clicks of a rail by distance, so their rhythm scales with speed', () => {
    for (const v of [6, 12, 24]) {
      const clicks = patternEvents(RAIL_PATTERN, 11.999, v, 0, 12 / v);
      expect(clicks.map((c) => c.i)).toEqual([0, 1, 2, 3]);
      clicks.forEach((c, k) => expect(c.t).toBeCloseTo((0.001 + RAIL_PATTERN.offsets[k]) / v, 9));
    }
  });

  it('never repeats or drops an event across consecutive windows', () => {
    const rand = seeded(7);
    const whole = patternEvents(RAIL_PATTERN, 3.3, 17, 0, 6);
    const pieces: number[] = [];
    let t = 0;
    let pos = 3.3;
    while (t < 6) {
      const t1 = Math.min(6, t + 0.01 + rand() * 0.2);
      for (const e of patternEvents(RAIL_PATTERN, pos, 17, t, t1)) pieces.push(e.t);
      pos += 17 * (t1 - t);
      t = t1;
    }
    expect(pieces).toHaveLength(whole.length);
    pieces.forEach((p, k) => expect(p).toBeCloseTo(whole[k].t, 6));
  });

  it('schedules nothing when stopped, backwards in time, or given nonsense, and caps runaway windows', () => {
    expect(patternEvents(CHUFF_PATTERN, 0, 0, 0, 10)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, 0, -3, 0, 10)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, 0, 10, 5, 5)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, 0, 10, 5, 4)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, Number.NaN, 10, 0, 1)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, 0, Number.POSITIVE_INFINITY, 0, 1)).toEqual([]);
    expect(patternEvents({ period: 0, offsets: [0] }, 0, 10, 0, 1)).toEqual([]);
    expect(patternEvents(CHUFF_PATTERN, 0, 1e6, 0, 100, 50)).toHaveLength(50);
  });

  it('lopes in threes: three hoofbeats, then the moment of suspension', () => {
    const p = gallopPattern(GALLOP_STRIDE);
    expect(p.period).toBeCloseTo(GALLOP_STRIDE);
    expect(p.offsets).toHaveLength(3);
    const [a, b, c] = p.offsets;
    expect(p.period - c).toBeGreaterThan(c - b); // the pause is the longest gap
    expect(p.period - c).toBeGreaterThan(b - a);
    // Hoofbeats over two seconds of time: three per stride.
    const beats = patternEvents(p, 0, 1, 0, 10 * GALLOP_STRIDE);
    expect(beats).toHaveLength(30);
    expect(gallopPattern(Number.NaN).period).toBeCloseTo(GALLOP_STRIDE);
    expect(gallopPattern(99).period).toBeLessThanOrEqual(1.5);
  });
});

// ---- Mixes ---------------------------------------------------------------------------------------------

describe('engine mix', () => {
  const finiteAndNonNegative = (m: ReturnType<typeof engineMix>): void => {
    for (const [key, value] of Object.entries(m)) {
      expect(Number.isFinite(value), key).toBe(true);
      expect(value, key).toBeGreaterThanOrEqual(0);
    }
  };

  it('works the exhaust harder and brighter with the throttle; coasting leaves the rods clanking', () => {
    const coast = engineMix(input(10, 0));
    const work = engineMix(input(10, 1));
    expect(work.chuff).toBeGreaterThan(3 * coast.chuff);
    expect(coast.chuff).toBeGreaterThan(0); // soft, but there
    expect(work.chuffHz).toBeGreaterThan(1.5 * coast.chuffHz);
    expect(work.sizzle).toBeGreaterThan(coast.sizzle);
    expect(coast.rods).toBeGreaterThan(2 * work.rods);
  });

  it('fuses the beats into a roar at speed, and the rails and rumble grow with it', () => {
    const slow = engineMix(input(4, 1));
    const fast = engineMix(input(26, 1));
    expect(slow.roar).toBeLessThan(0.05);
    expect(fast.roar).toBeGreaterThan(0.5);
    expect(fast.chuff).toBeLessThan(slow.chuff * 1.1); // the beats themselves step back
    expect(fast.chuffDecay).toBeLessThan(slow.chuffDecay);
    expect(fast.rails).toBeGreaterThan(slow.rails);
    expect(fast.rumble).toBeGreaterThan(slow.rumble);
    expect(fast.rolling).toBeGreaterThan(slow.rolling);
    expect(fast.rate).toBeCloseTo(chuffRate(26));
  });

  it('is quiet but alive at a stand, and hisses from the cylinder cocks when opened up there', () => {
    const idle = engineMix(input(0, 0));
    expect(idle.rails).toBe(0);
    expect(idle.rods).toBe(0);
    expect(idle.roar).toBe(0);
    expect(idle.cocks).toBe(0);
    expect(idle.firebox).toBeGreaterThan(0);
    const starting = engineMix(input(0.5, 0.8));
    expect(starting.cocks).toBeGreaterThan(0.5);
    expect(engineMix(input(12, 0.8)).cocks).toBe(0);
  });

  it('puts the Engineer by the firebox with the rails underfoot, and the Rider out in the wind', () => {
    const cab = engineMix(input(20, 0.6, 'cab'));
    const rider = engineMix(input(20, 0.6, 'rider'));
    expect(cab.rails).toBeLessThan(0.6 * rider.rails);
    expect(cab.railHz).toBeLessThan(rider.railHz);
    expect(cab.firebox).toBeGreaterThan(3 * rider.firebox);
    expect(cab.injector).toBeGreaterThan(0);
    expect(rider.injector).toBe(0);
    expect(rider.flutter).toBeGreaterThan(0);
    expect(cab.flutter).toBe(0);
    expect(engineMix(input(0, 0, 'rider')).flutter).toBe(0); // no wind at a stand
  });

  it('is louder and darker in a tunnel', () => {
    const open = engineMix(input(15, 0.5));
    const bore = engineMix(input(15, 0.5, 'rider', true));
    expect(bore.gain).toBeGreaterThan(open.gain * 1.3);
    expect(bore.toneHz).toBeLessThan(open.toneHz / 3);
  });

  it('turns nonsense into a quiet engine, never NaN', () => {
    const odd = engineMix({ speed: Number.NaN, throttle: Number.POSITIVE_INFINITY, tunnel: 'yes' as unknown as boolean, listener: 'moon' as Listener });
    finiteAndNonNegative(odd);
    expect(odd.rails).toBe(0);
    for (const v of [0, 0.3, 3, 9, 16, 27, 40, -27]) for (const th of [0, 0.4, 1]) for (const l of ['rider', 'cab'] as const) for (const tun of [false, true]) finiteAndNonNegative(engineMix(input(v, th, l, tun)));
  });
});

describe('other mixes', () => {
  it('brakes grind, then squeal, then screech only past the emergency notch', () => {
    const off = brakeMix(0);
    expect(off).toEqual({ grind: 0, squeal: 0, screech: 0 });
    const light = brakeMix(0.2);
    const service = brakeMix(0.85);
    const emergency = brakeMix(1);
    expect(light.grind).toBeGreaterThan(0);
    expect(service.squeal).toBeGreaterThan(light.squeal);
    expect(service.screech).toBe(0);
    expect(emergency.screech).toBe(1);
    expect(brakeMix(Number.NaN)).toEqual(off);
    expect(brakeMix(7)).toEqual(emergency);
  });

  it('wind rises in level and brightness, and only howls when strong', () => {
    const calm = windMix(0);
    expect(calm.buffet + calm.rush + calm.hiss + calm.howl).toBe(0);
    const light = windMix(0.3);
    const gale = windMix(1);
    expect(gale.buffet).toBeGreaterThan(light.buffet);
    expect(gale.rush).toBeGreaterThan(light.rush);
    expect(gale.hiss).toBeGreaterThan(light.hiss);
    expect(gale.rushHz).toBeGreaterThan(light.rushHz);
    expect(light.howl).toBe(0);
    expect(gale.howl).toBeGreaterThan(0.5);
    expect(windMix(Number.NaN)).toEqual(calm);
  });

  it('the ford: silent at 0, louder with the level, and only throwing spray when churned hard', () => {
    expect(fordMix(0).gain).toBe(0);
    expect(fordMix(Number.NaN)).toEqual(fordMix(0));
    const lapping = fordMix(0.25);
    const churning = fordMix(1);
    expect(lapping.gain).toBeGreaterThan(0);
    expect(churning.gain).toBeGreaterThan(lapping.gain);
    expect(churning.rush).toBeGreaterThan(lapping.rush);
    expect(churning.drops).toBeGreaterThan(lapping.drops);
    expect(churning.bubbles).toBeGreaterThan(lapping.bubbles);
    expect(lapping.spray).toBe(0);
    expect(churning.spray).toBe(1);
    expect(fordMix(3)).toEqual(churning);
  });

  it('shots pan, attenuate and dull with distance; muffled ones are centred and dark', () => {
    const near = shotPlacement(-1, 1);
    const far = shotPlacement(1, 0.2);
    expect(near.pan).toBeCloseTo(-0.9);
    expect(far.pan).toBeCloseTo(0.9);
    expect(far.gain).toBe(0.2);
    expect(far.cutoffHz).toBeLessThan(near.cutoffHz);
    const muffled = shotPlacement(-1, 0.7, true);
    expect(muffled.pan).toBe(0);
    expect(muffled.gain).toBe(0.7);
    expect(muffled.cutoffHz).toBeLessThan(far.cutoffHz);
    expect(shotPlacement(undefined, undefined)).toEqual(shotPlacement(0, 1));
    expect(shotPlacement(Number.NaN, Number.NEGATIVE_INFINITY).gain).toBe(1);
    expect(shotPlacement(5, -3).gain).toBe(0);
  });

  it('volume sliders map to squared gains, clamped', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(0.5)).toBe(0.25);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(2)).toBe(1);
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });

  it('clamp treats anything but a finite number as missing', () => {
    expect(clamp(0.5, 0, 1, 9)).toBe(0.5);
    expect(clamp(-2, 0, 1, 9)).toBe(0);
    expect(clamp(Number.NaN, 0, 1, 9)).toBe(9);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 1, 9)).toBe(9);
    expect(clamp('0.5', 0, 1, 9)).toBe(9);
    expect(clamp(undefined, 0, 1, 9)).toBe(9);
  });

  it('smoothstep eases from 0 to 1 between its edges', () => {
    expect(smoothstep(2, 4, 1)).toBe(0);
    expect(smoothstep(2, 4, 3)).toBe(0.5);
    expect(smoothstep(2, 4, 5)).toBe(1);
    expect(smoothstep(2, 4, Number.NaN)).toBe(0);
    expect(smoothstep(0, 1, 0.25)).toBeLessThan(0.25); // eases in
  });
});

// ---- DSP helpers (Clew's) ------------------------------------------------------------------------------

describe('noise buffers', () => {
  it('white noise fills [-1, 1) evenly with no DC', () => {
    const x = whiteNoise(48_000, seeded(1));
    expect(x.length).toBe(48_000);
    expect(peak(x)).toBeLessThanOrEqual(1);
    expect(Math.abs(mean(x))).toBeLessThan(0.02);
    expect(rms(x)).toBeCloseTo(1 / Math.sqrt(3), 1);
  });

  it('brown noise is dark, DC-free, peak-normalised and loops without a jump', () => {
    const x = brownNoise(96_000, seeded(2));
    expect(allFinite(x)).toBe(true);
    expect(peak(x)).toBeCloseTo(1, 5);
    expect(Math.abs(mean(x))).toBeLessThan(1e-4);
    expect(roughness(x)).toBeLessThan(0.3);
    expect(roughness(whiteNoise(96_000, seeded(2)))).toBeGreaterThan(1.2);
    let step = 0;
    for (let i = 1; i < x.length; i++) step += (x[i] - x[i - 1]) ** 2;
    step = Math.sqrt(step / (x.length - 1));
    expect(Math.abs(x[0] - x[x.length - 1])).toBeLessThan(5 * step);
  });

  it('grit noise is sparse clicks', () => {
    const x = gritNoise(48_000, 2500, 48_000, seeded(3));
    let busy = 0;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 1e-3) busy++;
    expect(busy / x.length).toBeGreaterThan(0.02);
    expect(busy / x.length).toBeLessThan(0.2);
    expect(peak(x)).toBeCloseTo(1, 5);
    expect(Math.abs(mean(x))).toBeLessThan(1e-4);
  });

  it('degenerate lengths give empty buffers rather than throwing', () => {
    expect(whiteNoise(0).length).toBe(0);
    expect(whiteNoise(Number.NaN).length).toBe(0);
    expect(brownNoise(-5).length).toBe(0);
    expect(brownNoise(1).length).toBe(1);
    expect(gritNoise(Number.NaN, 100, 48_000).length).toBe(0);
    expect(allFinite(gritNoise(100, Number.NaN, 48_000))).toBe(true);
  });
});

describe('karplusStrong', () => {
  const SR = 48_000;

  it('rings at the requested pitch', () => {
    for (const f of [110, 196, 440]) {
      const x = karplusStrong(SR, f, 0.6, { decay: 0.996, blend: 0.45, rand: seeded(4) });
      const from = Math.round(0.05 * SR);
      const len = Math.round(0.1 * SR);
      let best = -Infinity;
      let bestLag = 0;
      for (let lag = Math.round(SR / (f * 1.4)); lag <= Math.round((SR / f) * 1.4); lag++) {
        let s = 0;
        for (let i = from; i < from + len; i++) s += x[i] * x[i + lag];
        if (s > best) {
          best = s;
          bestLag = lag;
        }
      }
      expect(SR / (bestLag + 0.5)).toBeGreaterThan(f * 0.97);
      expect(SR / (bestLag + 0.5)).toBeLessThan(f * 1.03);
    }
  });

  it('stays bounded, ends in silence and survives nonsense', () => {
    const x = karplusStrong(SR, 196, 1.2, { decay: 0.996, blend: 0.45, rand: seeded(5) });
    expect(allFinite(x)).toBe(true);
    expect(peak(x)).toBeCloseTo(1, 5);
    expect(Math.abs(x[x.length - 1])).toBe(0);
    for (const [sr, f, s] of [
      [SR, 0, 0.1],
      [Number.NaN, 440, 0.1],
      [SR, 1e9, 0.1],
      [SR, 440, Number.NaN],
    ] as const) {
      const y = karplusStrong(sr, f, s, { decay: Number.NaN, blend: 7 });
      expect(allFinite(y)).toBe(true);
      expect(peak(y)).toBeLessThanOrEqual(1);
    }
  });
});

describe('curves', () => {
  it('the safety clip is exactly linear below the knee and never reaches full scale', () => {
    const c = softClipCurve();
    const n = c.length;
    for (let i = 0; i < n; i++) {
      const x = ((i / (n - 1)) * 2 - 1) * 2;
      if (Math.abs(x) <= 0.8) expect(c[i]).toBeCloseTo(x, 6);
      expect(Math.abs(c[i])).toBeLessThanOrEqual(0.98);
      if (i > 0) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
      expect(c[i]).toBeCloseTo(-c[n - 1 - i], 6);
    }
  });

  it('tanh curves are odd, monotonic and span ±1', () => {
    for (const drive of [0.5, 1.5, 3, Number.NaN]) {
      const c = tanhCurve(drive);
      expect(c[0]).toBeCloseTo(-1, 6);
      expect(c[c.length - 1]).toBeCloseTo(1, 6);
      expect(c[(c.length - 1) / 2]).toBeCloseTo(0, 6);
      for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    }
  });
});

// ---- A recording fake AudioContext ---------------------------------------------------------------------

class FakeParam {
  private v: number;
  private last: number;
  readonly calls: { method: string; args: number[] }[] = [];

  constructor(
    initial: number,
    private readonly ctx: FakeContext,
    readonly name: string,
  ) {
    this.v = initial;
    this.last = initial;
    ctx.params.push(this);
  }

  get value(): number {
    return this.v;
  }

  set value(v: number) {
    this.check('value', [v]);
    this.calls.push({ method: 'value', args: [v] });
    this.v = v;
    this.last = v;
  }

  setValueAtTime(v: number, t: number): this {
    return this.record('setValueAtTime', [v, t], v);
  }

  linearRampToValueAtTime(v: number, t: number): this {
    return this.record('linearRampToValueAtTime', [v, t], v);
  }

  exponentialRampToValueAtTime(v: number, t: number): this {
    // The real API throws on 0, and holds (no ramp at all) from 0 or across a sign change.
    if (v === 0 || this.last === 0 || Math.sign(v) !== Math.sign(this.last)) this.ctx.problems.push(`${this.name}: exponential ramp ${this.last} → ${v}`);
    return this.record('exponentialRampToValueAtTime', [v, t], v);
  }

  setTargetAtTime(v: number, t: number, timeConstant: number): this {
    if (!(timeConstant > 0)) this.ctx.problems.push(`${this.name}: time constant ${timeConstant}`);
    return this.record('setTargetAtTime', [v, t, timeConstant], v);
  }

  private record(method: string, args: number[], value: number): this {
    this.check(method, args);
    if (args[1] < 0) this.ctx.problems.push(`${this.name}.${method} at negative time ${args[1]}`);
    if (args[1] < this.ctx.currentTime - 1e-9) this.ctx.problems.push(`${this.name}.${method} in the past (${args[1]} < ${this.ctx.currentTime})`);
    this.calls.push({ method, args });
    this.last = value;
    return this;
  }

  private check(method: string, args: number[]): void {
    if (!args.every((a) => typeof a === 'number' && Number.isFinite(a))) this.ctx.problems.push(`${this.name}.${method}(${args.join(', ')})`);
  }
}

class FakeNode {
  readonly outputs: (FakeNode | FakeParam)[] = [];

  constructor(protected readonly ctx: FakeContext) {
    ctx.nodes.push(this);
  }

  connect(dest: FakeNode | FakeParam): FakeNode | undefined {
    if (!(dest instanceof FakeNode) && !(dest instanceof FakeParam)) this.ctx.problems.push('connect() to something that is not a node or param');
    this.outputs.push(dest);
    return dest instanceof FakeNode ? dest : undefined; // like the real API: connecting to a param returns nothing
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

class FakeGain extends FakeNode {
  readonly gain: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx);
    this.gain = ctx.param(1, 'gain');
  }
}

class FakeSource extends FakeNode {
  startAt: number | undefined;
  stopAt: number | undefined;
  loop = false;
  buffer: FakeBuffer | null = null;

  constructor(
    ctx: FakeContext,
    readonly kind: 'osc' | 'buffer',
  ) {
    super(ctx);
    ctx.sources.push(this);
  }

  start(when = 0, offset = 0): void {
    if (!Number.isFinite(when) || when < 0 || !Number.isFinite(offset) || offset < 0) this.ctx.problems.push(`start(${when}, ${offset})`);
    if (when < this.ctx.currentTime - 1e-9) this.ctx.problems.push(`start in the past (${when} < ${this.ctx.currentTime})`);
    if (this.startAt !== undefined) this.ctx.problems.push('started twice');
    if (this.buffer && offset >= this.buffer.duration) this.ctx.problems.push(`offset ${offset} past the buffer`);
    this.startAt = when;
  }

  stop(when = 0): void {
    if (!Number.isFinite(when) || when < 0) this.ctx.problems.push(`stop(${when})`);
    if (this.startAt === undefined) this.ctx.problems.push('stopped before started');
    this.stopAt = when;
  }
}

class FakeOscillator extends FakeSource {
  type: OscillatorType = 'sine';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'osc');
    this.frequency = ctx.param(440, 'frequency');
    this.detune = ctx.param(0, 'detune');
  }
}

class FakeBufferSource extends FakeSource {
  readonly playbackRate: FakeParam;
  readonly detune: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx, 'buffer');
    this.playbackRate = ctx.param(1, 'playbackRate');
    this.detune = ctx.param(0, 'detune');
  }
}

class FakePanner extends FakeNode {
  readonly pan: FakeParam;

  constructor(ctx: FakeContext) {
    super(ctx);
    this.pan = ctx.param(0, 'pan');
    ctx.panners.push(this);
  }
}

class FakeBuffer {
  readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(c: number): Float32Array {
    return this.channels[c];
  }

  copyToChannel(source: Float32Array, c: number): void {
    this.channels[c].set(source.subarray(0, this.length));
  }
}

class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state: AudioContextState = 'running';
  /** When false, resume() leaves the context suspended (as if the browser refused). */
  resumes = true;
  readonly problems: string[] = [];
  readonly nodes: FakeNode[] = [];
  readonly params: FakeParam[] = [];
  readonly sources: FakeSource[] = [];
  readonly panners: FakePanner[] = [];
  readonly buffers: FakeBuffer[] = [];
  readonly destination: FakeNode = new FakeNode(this);
  private readonly listeners: (() => void)[] = [];

  param(value: number, name: string): FakeParam {
    return new FakeParam(value, this, name);
  }

  createGain(): FakeGain {
    return new FakeGain(this);
  }

  createOscillator(): FakeOscillator {
    return new FakeOscillator(this);
  }

  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    if (!(length >= 1) || !(channels >= 1)) this.problems.push(`createBuffer(${channels}, ${length})`);
    const b = new FakeBuffer(channels, length, sampleRate);
    this.buffers.push(b);
    return b;
  }

  createBiquadFilter(): FakeNode {
    return Object.assign(new FakeNode(this), {
      type: 'lowpass',
      frequency: this.param(350, 'frequency'),
      Q: this.param(1, 'Q'),
      gain: this.param(0, 'filterGain'),
      detune: this.param(0, 'detune'),
    });
  }

  createWaveShaper(): FakeNode {
    return Object.assign(new FakeNode(this), { curve: null as Float32Array | null, oversample: 'none' });
  }

  createDynamicsCompressor(): FakeNode {
    return Object.assign(new FakeNode(this), {
      threshold: this.param(-24, 'threshold'),
      knee: this.param(30, 'knee'),
      ratio: this.param(12, 'ratio'),
      attack: this.param(0.003, 'attack'),
      release: this.param(0.25, 'release'),
    });
  }

  createStereoPanner(): FakePanner {
    return new FakePanner(this);
  }

  createDelay(maxDelayTime = 1): FakeNode {
    if (!(maxDelayTime > 0 && maxDelayTime < 180)) this.problems.push(`createDelay(${maxDelayTime})`);
    return Object.assign(new FakeNode(this), { delayTime: this.param(0, 'delayTime') });
  }

  addEventListener(type: string, fn: () => void): void {
    if (type === 'statechange') this.listeners.push(fn);
  }

  setState(state: AudioContextState): void {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  resume(): Promise<void> {
    if (this.resumes) this.setState('running');
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.setState('closed');
    return Promise.resolve();
  }
}

class FakeOfflineContext extends FakeContext {
  startRendering(): Promise<void> {
    return Promise.resolve();
  }
}

function rig(opts: { offline?: boolean; state?: AudioContextState } = {}): { ctx: FakeContext; sfx: Sfx } {
  const ctx = opts.offline ? new FakeOfflineContext() : new FakeContext();
  if (opts.state) ctx.state = opts.state;
  ctx.currentTime = 12.3;
  return { ctx, sfx: new Sfx(() => ctx as unknown as BaseAudioContext) };
}

/** Every node and param reachable downstream of `from`. */
function downstream(from: FakeNode): Set<FakeNode | FakeParam> {
  const seen = new Set<FakeNode | FakeParam>();
  const stack: (FakeNode | FakeParam)[] = [from];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (n instanceof FakeNode) stack.push(...n.outputs);
  }
  return seen;
}

/** Start times of exhaust beats: a noise burst whose VCA fans out to the beat's band, the thump and the edge. */
const beatStarts = (ctx: FakeContext, from = 0): number[] =>
  ctx.sources
    .slice(from)
    .filter((s) => s.kind === 'buffer' && s.outputs.some((o) => o instanceof FakeGain && o.outputs.length === 3))
    .map((s) => s.startAt ?? Number.NaN)
    .sort((a, b) => a - b);

const frame = 1 / 60;

// ---- The engine ----------------------------------------------------------------------------------------

/** The public API the apps call (the stub's, kept exactly). Assigning an Sfx to it stops compiling if a member drifts. */
interface SpecifiedSfx {
  unlock(): void;
  setVolumes(master: number, effects: number): void;
  stopAll(): void;
  engine(p: { speed: number; throttle: number; tunnel: boolean; listener: Listener } | null): void;
  wind(level: number): void;
  brakes(level: number): void;
  safetyValve(on: boolean): void;
  water(on: boolean): void;
  fordWater(level: number, opts?: { pan?: number; listener?: Listener }): void;
  gallop(horses: { pan: number; gain: number }[]): void;
  whistle(on: boolean, listener: Listener): void;
  shot(weapon: Weapon | 'bandit', opts?: { pan?: number; gain?: number; muffled?: boolean }): void;
  splash(big: boolean, opts?: { pan?: number; gain?: number; muffled?: boolean }): void;
  lurch(listener: Listener): void;
  whinny(pan?: number, gain?: number): void;
  cattle(scatter: boolean, pan?: number, gain?: number): void;
  grunt(): void;
  ricochet(pan?: number): void;
  whiz(pan?: number): void;
  hurt(): void;
  hitMarker(): void;
  reload(weapon: Weapon): void;
  dryFire(): void;
  jump(): void;
  land(hard: boolean): void;
  thud(): void;
  explosion(big: boolean): void;
  crash(): void;
  tunnel(enter: boolean): void;
  telegraph(): void;
  switchThrow(): void;
  lever(): void;
  bell(): void;
  chime(): void;
  cash(): void;
  alarm(): void;
  win(): void;
  lose(): void;
  uiClick(): void;
}

/** Every one-shot, by name. */
const ONE_SHOTS: [string, (s: Sfx) => void][] = [
  ['revolver', (s) => s.shot('revolver')],
  ['shotgun', (s) => s.shot('shotgun')],
  ['rifle', (s) => s.shot('rifle')],
  ['bandit', (s) => s.shot('bandit', { pan: -0.6, gain: 0.5 })],
  ['muffled', (s) => s.shot('bandit', { muffled: true, gain: 0.8 })],
  ['ricochet', (s) => s.ricochet(0.4)],
  ['whiz', (s) => s.whiz(-0.7)],
  ['hurt', (s) => s.hurt()],
  ['hit marker', (s) => s.hitMarker()],
  ['reload revolver', (s) => s.reload('revolver')],
  ['reload shotgun', (s) => s.reload('shotgun')],
  ['reload rifle', (s) => s.reload('rifle')],
  ['quick reload', (s) => s.reloadFor('revolver', 1.04)],
  ['dry fire', (s) => s.dryFire()],
  ['jump', (s) => s.jump()],
  ['land', (s) => s.land(false)],
  ['hard land', (s) => s.land(true)],
  ['thud', (s) => s.thud()],
  ['explosion', (s) => s.explosion(false)],
  ['big explosion', (s) => s.explosion(true)],
  ['crash', (s) => s.crash()],
  ['tunnel in', (s) => s.tunnel(true)],
  ['tunnel out', (s) => s.tunnel(false)],
  ['telegraph', (s) => s.telegraph()],
  ['switch', (s) => s.switchThrow()],
  ['lever', (s) => s.lever()],
  ['bell', (s) => s.bell()],
  ['chime', (s) => s.chime()],
  ['cash', (s) => s.cash()],
  ['alarm', (s) => s.alarm()],
  ['win', (s) => s.win()],
  ['lose', (s) => s.lose()],
  ['ui click', (s) => s.uiClick()],
  ['splash (the loco)', (s) => s.splash(true, { pan: 0.6, gain: 0.9 })],
  ['splash (a body)', (s) => s.splash(false)],
  ['splash (the cab)', (s) => s.splash(true, { muffled: true, gain: 0.8 })],
  ['lurch (rider)', (s) => s.lurch('rider')],
  ['lurch (cab)', (s) => s.lurch('cab')],
  ['whinny', (s) => s.whinny(-0.5, 0.8)],
  ['cattle calm', (s) => s.cattle(false, 1, 0.6)],
  ['cattle scatter', (s) => s.cattle(true, 0.8, 0.9)],
  ['grunt', (s) => s.grunt()],
];

/** Every method, with sensible and nonsensical arguments, and the continuous ones called repeatedly. */
function exercise(s: Sfx, advance: (seconds: number) => void = () => undefined): void {
  s.setVolumes(Number.NaN, 2);
  s.setVolumes(0.8, 0.9);
  for (const [, fire] of ONE_SHOTS) fire(s);
  s.shot('cannon' as Weapon);
  s.shot('rifle', { pan: Number.NaN, gain: Number.POSITIVE_INFINITY, muffled: 'yes' as unknown as boolean });
  s.shot(undefined as unknown as Weapon, null as unknown as { pan?: number });
  s.ricochet(Number.NaN);
  s.whiz(1e9);
  s.reload('bow' as Weapon);
  s.reloadFor('rifle', Number.NEGATIVE_INFINITY);
  s.land('hard' as unknown as boolean);
  s.explosion(undefined as unknown as boolean);
  s.tunnel(null as unknown as boolean);
  s.splash(undefined as unknown as boolean, { pan: Number.NaN, gain: 7, muffled: 'no' as unknown as boolean });
  s.lurch('moon' as Listener);
  s.whinny(Number.POSITIVE_INFINITY, Number.NaN);
  s.cattle('yes' as unknown as boolean, -9, -1);
  for (let f = 0; f < 90; f++) {
    advance(frame);
    const t = f * frame;
    s.engine({ speed: 30 * Math.sin(t), throttle: t % 1, tunnel: f > 45, listener: f % 20 < 10 ? 'rider' : 'cab' });
    s.wind(Math.abs(Math.cos(t * 3)));
    s.brakes(f > 60 ? 1 : 0.4);
    s.safetyValve(f % 30 < 15);
    s.water(f > 20);
    s.fordWater(f > 30 && f < 75 ? Math.abs(Math.sin(t * 2)) : 0, { pan: Math.cos(t), listener: f % 40 < 20 ? 'rider' : 'cab' });
    s.gallop(
      [
        { pan: -1, gain: 1 },
        { pan: 0.4, gain: t },
        { pan: Number.NaN, gain: Number.NaN },
      ].slice(0, 1 + (f % 3)),
    );
    s.whistle(f % 12 < 6, f % 24 < 12 ? 'cab' : 'rider');
  }
  s.engine({ speed: Number.NaN, throttle: -4, tunnel: 'no' as unknown as boolean, listener: 'moon' as Listener });
  s.engine(undefined as unknown as null);
  s.engine(null);
  s.wind(Number.POSITIVE_INFINITY);
  s.brakes(Number.NaN);
  s.fordWater(Number.NaN, { pan: Number.NaN, listener: 'moon' as Listener });
  s.fordWater(2, null as unknown as { pan?: number });
  s.gallop(null as unknown as { pan: number; gain: number }[]);
  s.gallop([null, 'horse'] as unknown as { pan: number; gain: number }[]);
  s.whistle(true, 'moon' as Listener);
  s.stopAll();
}

describe('Sfx', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has the API the apps call, and an injectable context factory', () => {
    const api: SpecifiedSfx = new Sfx();
    const injected: SpecifiedSfx = new Sfx(() => new FakeContext() as unknown as BaseAudioContext);
    expect(api).toBeInstanceOf(Sfx);
    expect(injected).toBeInstanceOf(Sfx);
    expect(new Sfx().ready).toBe(false);
  });

  it('is a silent no-op before unlock, however it is called', () => {
    const { ctx, sfx } = rig();
    expect(() => exercise(sfx, (s) => (ctx.currentTime += s))).not.toThrow();
    expect(sfx.ready).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('survives having no WebAudio at all (node has no AudioContext)', () => {
    const sfx = new Sfx();
    expect(() => sfx.unlock()).not.toThrow();
    expect(sfx.ready).toBe(false);
    expect(() => exercise(sfx)).not.toThrow();
  });

  it('survives a factory that throws, or returns junk, and does not retry a broken context', () => {
    const throwing = new Sfx(() => {
      throw new Error('no audio');
    });
    expect(() => throwing.unlock()).not.toThrow();
    expect(() => exercise(throwing)).not.toThrow();
    let made = 0;
    const junk = new Sfx(() => {
      made++;
      return {} as BaseAudioContext;
    });
    expect(() => junk.unlock()).not.toThrow();
    expect(() => junk.unlock()).not.toThrow();
    expect(() => exercise(junk)).not.toThrow();
    expect(junk.ready).toBe(false);
    expect(made).toBe(1);
  });

  it('builds every one-shot from valid automation, and every voice ends by itself', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    expect(sfx.ready).toBe(true);
    for (const b of ctx.buffers) for (const ch of b.channels) expect(allFinite(ch)).toBe(true);
    for (const [name, fire] of ONE_SHOTS) {
      ctx.currentTime += 5; // past every sound's rate limit and voice cap
      const before = ctx.sources.length;
      fire(sfx);
      const made = ctx.sources.slice(before);
      expect(made.length, name).toBeGreaterThan(0);
      for (const s of made) {
        expect(s.startAt, name).toBeGreaterThanOrEqual(ctx.currentTime);
        if (s.stopAt === undefined) expect(s.kind === 'buffer' && !s.loop, `${name}: a voice that never ends`).toBe(true);
        else expect(s.stopAt, name).toBeGreaterThan(s.startAt ?? Infinity);
        expect(s.stopAt ?? 0, `${name}: rings on too long`).toBeLessThan(ctx.currentTime + 6);
      }
    }
    expect(ctx.problems).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('runs every method, continuous layers frame by frame, with nonsense too, from valid automation', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    expect(() => exercise(sfx, (s) => (ctx.currentTime += s))).not.toThrow();
    expect(ctx.problems).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drives every continuous layer for a long stretch and stopAll silences them all', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    for (let f = 0; f < 600; f++) {
      ctx.currentTime += frame;
      const s = f * frame;
      sfx.engine({ speed: 27 * Math.sin(s / 3) ** 2, throttle: (f % 200) / 200, tunnel: s > 4 && s < 6, listener: s < 5 ? 'rider' : 'cab' });
      sfx.wind(Math.abs(Math.sin(s)));
      sfx.brakes(s > 7 ? 1 : 0);
      sfx.safetyValve(s > 2 && s < 3);
      sfx.water(s > 3 && s < 4.5);
      sfx.fordWater(s > 5 && s < 8 ? 0.4 + 0.6 * Math.abs(Math.sin(s)) : 0, { pan: Math.sin(s * 2), listener: s < 6.5 ? 'rider' : 'cab' });
      sfx.gallop([
        { pan: -0.5, gain: 0.8 },
        { pan: 0.5, gain: 0.3 },
      ]);
      sfx.whistle(Math.floor(s * 2) % 3 === 0, 'cab');
    }
    expect(beatStarts(ctx).length).toBeGreaterThan(50);
    expect(ctx.problems).toEqual([]);
    sfx.stopAll();
    const now = ctx.currentTime;
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(now + 0.1);
    // Stopped layers stay stopped when the context comes back.
    const count = ctx.sources.length;
    ctx.setState('suspended');
    ctx.setState('running');
    expect(ctx.sources.length).toBe(count);
    expect(ctx.problems).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('queues four exhaust beats per turn of the drivers: the rate follows the speed', () => {
    const beatsIn = (speed: number, seconds: number): number[] => {
      const { ctx, sfx } = rig();
      sfx.unlock();
      const t0 = ctx.currentTime;
      for (let f = 0; f < seconds / frame; f++) {
        ctx.currentTime += frame;
        sfx.engine({ speed, throttle: 1, tunnel: false, listener: 'rider' });
      }
      return beatStarts(ctx).filter((t) => t > t0 + 0.5 && t <= t0 + seconds);
    };
    const at10 = beatsIn(10, 3.5);
    expect(at10.length).toBeGreaterThanOrEqual(23); // 8 a second over 3 s
    expect(at10.length).toBeLessThanOrEqual(25);
    for (let i = 1; i < at10.length; i++) expect(at10[i] - at10[i - 1]).toBeCloseTo(0.125, 6);
    const at20 = beatsIn(20, 3.5);
    expect(at20.length).toBeGreaterThanOrEqual(47);
    expect(at20.length).toBeLessThanOrEqual(49);
    expect(beatsIn(0, 2)).toHaveLength(0);
  });

  it('keeps the engine beating on its own timer between calls, and resyncs after a stall instead of bursting', () => {
    vi.useFakeTimers();
    const { ctx, sfx } = rig();
    sfx.unlock();
    sfx.engine({ speed: 10, throttle: 1, tunnel: false, listener: 'rider' });
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.05;
      vi.advanceTimersByTime(50);
    }
    const steady = beatStarts(ctx);
    expect(steady.length).toBeGreaterThanOrEqual(15); // 2 s at 8 a second, from the timer alone
    const before = ctx.sources.length;
    ctx.currentTime += 5; // the tab slept: no timer ticks while the audio clock ran on
    vi.advanceTimersByTime(50);
    const after = beatStarts(ctx, before);
    expect(after.length).toBeLessThanOrEqual(3); // a lookahead's worth, not five seconds of stale beats
    for (const t of after) expect(t).toBeGreaterThanOrEqual(ctx.currentTime);
    sfx.stopAll();
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.problems).toEqual([]);
  });

  it('never jumps a running layer: every frame update of an existing node is a glide', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    type Drive = { speed: number; throttle: number; tunnel: boolean; listener: Listener; wind: number; brakes: number; whistle: boolean; pans: [number, number] };
    const drive = (p: Drive): void => {
      ctx.currentTime += frame;
      sfx.engine(p);
      sfx.wind(p.wind);
      sfx.brakes(p.brakes);
      sfx.safetyValve(true);
      sfx.water(true);
      sfx.fordWater(p.wind, { pan: p.pans[0], listener: p.listener });
      sfx.whistle(p.whistle, p.listener);
      sfx.gallop([
        { pan: p.pans[0], gain: 1 },
        { pan: p.pans[1], gain: 0.4 },
      ]);
    };
    const calm: Drive = { speed: 3, throttle: 0.1, tunnel: false, listener: 'rider', wind: 0.1, brakes: 0.2, whistle: true, pans: [-1, 1] };
    for (let f = 0; f < 60; f++) drive(calm);
    drive({ ...calm, whistle: false });
    const existing = [...ctx.params];
    const marks = existing.map((p) => p.calls.length);
    // Everything at once: flat out, into a tunnel, the other seat, a gale, the emergency brake, the whistle, horses swapping sides.
    drive({ speed: 27, throttle: 1, tunnel: true, listener: 'cab', wind: 1, brakes: 1, whistle: true, pans: [1, -1] });
    let glides = 0;
    existing.forEach((p, i) => {
      for (const c of p.calls.slice(marks[i])) {
        expect(c.method, p.name).toBe('setTargetAtTime');
        expect(c.args[2], p.name).toBeGreaterThanOrEqual(0.004);
        glides++;
      }
    });
    expect(glides).toBeGreaterThan(20);
    expect(ctx.problems).toEqual([]);
  });

  it('keeps the train on the world bus: the effects slider scales the action, not the engine', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    sfx.shot('revolver');
    const fx = ctx.panners.at(-1)?.outputs[0] as FakeGain;
    expect(fx).toBeInstanceOf(FakeGain);
    const first = ctx.sources.length;
    sfx.engine({ speed: 10, throttle: 1, tunnel: false, listener: 'rider' });
    const reach = downstream(ctx.sources[first]);
    expect(reach.has(ctx.destination)).toBe(true);
    expect(reach.has(fx)).toBe(false);
    expect(downstream(fx).has(ctx.destination)).toBe(true);
    sfx.setVolumes(1, 0);
    expect(fx.gain.calls.at(-1)?.method).toBe('setTargetAtTime');
    expect(fx.gain.calls.at(-1)?.args[0]).toBe(0);
  });

  it('applies volumes as squared gains, remembered from before unlock and then glided', () => {
    const { ctx, sfx } = rig();
    sfx.setVolumes(0.5, 0.8);
    sfx.unlock();
    const master = ctx.nodes.find((n) => n instanceof FakeGain && n.outputs.includes(ctx.destination)) as FakeGain | undefined;
    expect(master?.gain.value).toBe(0.25);
    expect(ctx.nodes.filter((n) => n instanceof FakeGain && Math.abs(n.gain.value - 0.64) < 1e-12)).toHaveLength(2); // effects, with and without echoes
    sfx.setVolumes(1, 0);
    const glide = master?.gain.calls.at(-1);
    expect(glide?.method).toBe('setTargetAtTime');
    expect(glide?.args[0]).toBe(1);
  });

  it('collapses many shots in one frame into one, but lets different guns and later shots through', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    sfx.shot('revolver');
    const one = ctx.sources.length;
    for (let i = 0; i < 6; i++) sfx.shot('revolver'); // a burst of pellet events in one frame
    expect(ctx.sources.length).toBe(one);
    sfx.shot('bandit', { pan: 0.5, gain: 0.6 });
    expect(ctx.sources.length).toBeGreaterThan(one);
    const two = ctx.sources.length;
    ctx.currentTime += 0.1;
    sfx.shot('revolver');
    expect(ctx.sources.length).toBeGreaterThan(two);
    expect(ctx.problems).toEqual([]);
  });

  it('caps how many gunshots ring at once', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    for (let i = 0; i < 14; i++) {
      ctx.currentTime += 0.05;
      sfx.shot('bandit', { pan: (i % 3) - 1, gain: 1 });
    }
    expect(ctx.panners).toHaveLength(10);
    ctx.currentTime += 3;
    sfx.shot('bandit', { gain: 1 });
    expect(ctx.panners).toHaveLength(11);
  });

  it('skips a shot too far away to hear', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    sfx.shot('bandit', { gain: 0 });
    expect(ctx.sources).toHaveLength(0);
  });

  it('fades the engine out on null and stops its voices, queued ones included', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    for (let f = 0; f < 60; f++) {
      ctx.currentTime += frame;
      sfx.engine({ speed: 15, throttle: 0.6, tunnel: false, listener: 'rider' });
    }
    sfx.engine(null);
    const now = ctx.currentTime;
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(now + 0.65);
    const count = ctx.sources.length;
    ctx.currentTime += 1;
    sfx.engine(null);
    expect(ctx.sources.length).toBe(count);
    expect(ctx.problems).toEqual([]);
  });

  it('re-attacks a released whistle for a quick toot, and lets the voice go after a while', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    sfx.whistle(true, 'cab');
    const oscillators = (): number => ctx.sources.filter((s) => s.kind === 'osc').length;
    const voice = oscillators();
    expect(voice).toBeGreaterThanOrEqual(5); // a chord of at least five chimes
    for (const [on, dt] of [
      [false, 0.3],
      [true, 0.15],
      [false, 0.2],
      [true, 0.15],
    ] as const) {
      ctx.currentTime += dt;
      sfx.whistle(on, 'rider');
    }
    expect(oscillators()).toBe(voice); // the same voice, re-attacked
    ctx.currentTime += 0.2;
    sfx.whistle(false, 'cab');
    for (let f = 0; f < 90; f++) {
      ctx.currentTime += frame;
      sfx.whistle(false, 'cab');
    }
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(ctx.currentTime + 0.1);
    sfx.whistle(true, 'cab');
    expect(oscillators()).toBeGreaterThan(voice); // a fresh voice after the old one was let go
    expect(ctx.problems).toEqual([]);
  });

  it('gives each horse its own lope in threes, and fades out the ones that leave', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    const brown = ctx.buffers[1];
    const hooves = (): number[] =>
      ctx.sources
        .filter((s) => s.buffer === brown)
        .map((s) => s.startAt ?? Number.NaN)
        .sort((a, b) => a - b);
    const run = (horses: { pan: number; gain: number }[], seconds: number): void => {
      for (let f = 0; f < seconds / frame; f++) {
        ctx.currentTime += frame;
        sfx.gallop(horses);
      }
    };
    run([{ pan: -1, gain: 1 }], 3);
    const one = hooves();
    // Three beats per ~0.45 s stride (±7% per horse), from a random first stride, plus a lookahead's worth queued.
    expect(one.length).toBeGreaterThanOrEqual(16);
    expect(one.length).toBeLessThanOrEqual(25);
    const gaps = one.slice(1).map((t, i) => t - one[i]);
    const long = gaps.filter((g) => g > 0.2).length;
    expect(long).toBeGreaterThanOrEqual(Math.floor(gaps.length / 3) - 1); // every third gap is the pause
    expect(long).toBeLessThanOrEqual(Math.ceil(gaps.length / 3) + 1);
    expect(ctx.panners[0].pan.calls.at(-1)?.args[0]).toBeCloseTo(-0.9);
    const n1 = hooves().length;
    run(
      [
        { pan: -1, gain: 1 },
        { pan: 1, gain: 0.6 },
        { pan: 0, gain: 0.3 },
      ],
      2,
    );
    expect(ctx.panners).toHaveLength(3);
    expect(hooves().length - n1).toBeGreaterThan(30); // three horses
    run([{ pan: -1, gain: 1 }], 1);
    run([], 0.5);
    const now = ctx.currentTime;
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(now);
    expect(ctx.problems).toEqual([]);
  });

  it('tears down a level layer held at 0, and brings it back when needed', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    const run = (fn: () => void, seconds: number): void => {
      for (let f = 0; f < seconds / frame; f++) {
        ctx.currentTime += frame;
        fn();
      }
    };
    run(() => {
      sfx.brakes(0.9);
      sfx.wind(0.7);
      sfx.water(true);
      sfx.safetyValve(true);
      sfx.fordWater(0.8, { pan: -0.3 });
    }, 1);
    expect(ctx.sources.length).toBeGreaterThan(0);
    run(() => {
      sfx.brakes(0);
      sfx.wind(0);
      sfx.water(false);
      sfx.safetyValve(false);
      sfx.fordWater(0);
    }, 2.5);
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(ctx.currentTime + 0.1);
    const after = ctx.sources.length;
    sfx.brakes(0.5);
    expect(ctx.sources.length).toBeGreaterThan(after);
    const again = ctx.sources.length;
    sfx.fordWater(0.5);
    expect(ctx.sources.length).toBeGreaterThan(again);
    expect(ctx.problems).toEqual([]);
  });

  it('pans the ford to where the train is wet, and muffles it under the footplate for the cab', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    const panners = ctx.panners.length;
    for (let f = 0; f < 30; f++) {
      ctx.currentTime += frame;
      sfx.fordWater(1, { pan: -1, listener: 'rider' });
    }
    const pan = ctx.panners[panners];
    expect(pan).toBeDefined();
    const target = (p: FakeParam): number => p.calls.at(-1)?.args[0] ?? p.value;
    expect(target(pan.pan)).toBeCloseTo(-0.9);
    // The layer's low-pass sits right before its panner: wide open for the Rider…
    const muffle = ctx.nodes.find((n) => n.outputs.includes(pan)) as unknown as { frequency: FakeParam };
    expect(target(muffle.frequency)).toBeGreaterThan(10000);
    // …and down to a rumble under the cab's floor, centred.
    for (let f = 0; f < 30; f++) {
      ctx.currentTime += frame;
      sfx.fordWater(0.8, { pan: -1, listener: 'cab' });
    }
    expect(target(muffle.frequency)).toBeLessThan(1000);
    expect(target(pan.pan)).toBeCloseTo(0);
    expect(ctx.problems).toEqual([]);
  });

  it('plays several shying horses a moment apart rather than in unison', () => {
    const { ctx, sfx } = rig();
    sfx.unlock();
    const before = ctx.sources.length;
    sfx.whinny(-0.5, 1);
    sfx.whinny(0.2, 1);
    sfx.whinny(0.8, 0.6);
    const starts = ctx.sources
      .slice(before)
      .filter((s) => s.kind === 'osc' && (s as FakeOscillator).type === 'sawtooth')
      .map((s) => s.startAt ?? Number.NaN);
    expect(starts).toHaveLength(3);
    expect(new Set(starts.map((t) => t.toFixed(4))).size).toBe(3);
    expect(ctx.problems).toEqual([]);
  });

  it('waits for a suspended context, then starts the layers it was asked for', async () => {
    const { ctx, sfx } = rig({ state: 'suspended' });
    ctx.resumes = false;
    sfx.engine({ speed: 10, throttle: 0.5, tunnel: false, listener: 'rider' });
    sfx.wind(0.5);
    sfx.safetyValve(true);
    sfx.gallop([{ pan: 0, gain: 1 }]);
    sfx.whistle(true, 'cab');
    sfx.unlock();
    expect(sfx.ready).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    ctx.setState('running'); // the browser starts it
    await Promise.resolve();
    expect(sfx.ready).toBe(true);
    expect(beatStarts(ctx).length).toBeGreaterThan(0);
    expect(ctx.panners.length).toBeGreaterThan(0); // the horse
    expect(ctx.sources.filter((s) => s.kind === 'osc').length).toBeGreaterThanOrEqual(5); // the whistle
    sfx.stopAll();
    for (const s of ctx.sources) expect(s.stopAt ?? Infinity).toBeLessThanOrEqual(ctx.currentTime + 0.1);
  });

  it('queues one-shots from the gesture that created a still-starting context, but not later', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { ctx, sfx } = rig({ state: 'suspended' });
    ctx.resumes = false;
    sfx.unlock();
    sfx.uiClick();
    expect(ctx.sources.length).toBeGreaterThan(0);
    const count = ctx.sources.length;
    now.mockReturnValue(2000);
    ctx.currentTime += 1;
    sfx.uiClick();
    sfx.unlock(); // a later gesture on a context that won't start opens no new window
    sfx.hurt();
    expect(ctx.sources.length).toBe(count);
  });

  it('replaces a context that was closed under it', () => {
    let made = 0;
    let last: FakeContext | null = null;
    const sfx = new Sfx(() => {
      made++;
      last = new FakeContext();
      return last as unknown as BaseAudioContext;
    });
    sfx.unlock();
    sfx.engine({ speed: 5, throttle: 1, tunnel: false, listener: 'cab' });
    (last as FakeContext | null)?.setState('closed');
    expect(sfx.ready).toBe(false);
    sfx.unlock();
    expect(made).toBe(2);
    expect(sfx.ready).toBe(true);
    sfx.engine({ speed: 5, throttle: 1, tunnel: false, listener: 'cab' });
    expect((last as FakeContext | null)?.sources.length).toBeGreaterThan(0);
  });

  it('treats an offline context as ready before rendering starts, and pumps it by calls alone', () => {
    vi.useFakeTimers();
    const { ctx, sfx } = rig({ offline: true, state: 'suspended' });
    sfx.unlock();
    expect(sfx.ready).toBe(true);
    sfx.bell();
    expect(ctx.sources.length).toBeGreaterThan(0);
    sfx.engine({ speed: 10, throttle: 1, tunnel: false, listener: 'rider' });
    sfx.gallop([{ pan: 0, gain: 1 }]);
    expect(vi.getTimerCount()).toBe(0);
    sfx.stopAll();
  });
});
