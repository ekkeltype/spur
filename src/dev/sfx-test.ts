// Dev-only test bench for src/audio/sfx.ts, served by Vite at /sfx.html (never part of the game build).
// The controls play every one-shot live and drive every continuous layer every frame, the way the game
// does. "Render all offline" plays each sound into an OfflineAudioContext (through Sfx's injectable
// factory) and checks the result: audible, never clipping, no NaN, panning and muffling, the exhaust's
// rhythm following the speed, layers stopping when told. window.renderAll() returns the same report.

import { Sfx, chuffRate, type Listener } from '../audio/sfx';

// ---- Offline rendering and analysis ------------------------------------------------------------------

const SR = 48_000;
const QUANTUM = 128;
/** Quietest short-term loudness (50 ms RMS) that still counts as audible: −40 dBFS. */
const AUDIBLE_RMS = 0.01;
/** Peaks below this count as silence: −80 dBFS. */
const SILENT_PEAK = 1e-4;
/** The master safety clip bends above this level; a single sound should never reach it. */
const CLIP_KNEE = 0.8;
/** Each one-shot is rendered this many times, since random offsets and pitches move its peak around. */
const RENDERS = 5;
/** The game calls continuous layers once per animation frame. */
const FRAME = 1 / 60;

export interface SoundStats {
  name: string;
  renderedSec: number;
  /** From the first to the last 10 ms step within 50 dB of the loudest moment. */
  activeSec: number;
  peak: number;
  peakDb: number;
  /** Highest peak over repeated renders (one-shots only). */
  worstPeakDb?: number;
  /** RMS over the active span. */
  rmsDb: number;
  /** Loudest 50 ms window. */
  loudestRmsDb: number;
  /** Loudest 400 ms window, K-weighted as in ITU-R BS.1770 (momentary LUFS): perceived loudness. */
  loudnessLufs: number;
  /** Left RMS over right RMS; positive means louder on the left. */
  balanceDb: number;
  /** RMS of the first difference relative to RMS, as a frequency: a crude spectral centroid. */
  brightnessHz: number;
  dcOffset: number;
  nan: boolean;
  clipped: number;
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface RenderReport {
  sampleRate: number;
  visibility: string;
  stats: SoundStats[];
  checks: Check[];
  cpu: { audioSec: number; wallMs: number; realtimeFactor: number };
  allPass: boolean;
}

/** Runs `fn` when the render reaches `time` (rounded to a render quantum); time 0 runs it before rendering. */
type At = (time: number, fn: () => void) => void;
type Script = (sfx: Sfx, at: At) => void;

async function render(seconds: number, script: Script): Promise<{ buffer: AudioBuffer; wallMs: number }> {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(seconds * SR), sampleRate: SR });
  const sfx = new Sfx(() => ctx);
  sfx.unlock();
  const timed = new Map<number, (() => void)[]>();
  const at: At = (time, fn) => {
    const frame = Math.round((time * SR) / QUANTUM) * QUANTUM;
    if (frame <= 0) fn();
    else if (frame < ctx.length) {
      const list = timed.get(frame);
      if (list) list.push(fn);
      else timed.set(frame, [fn]);
    }
  };
  script(sfx, at);
  for (const [frame, fns] of timed) {
    void ctx.suspend(frame / SR).then(() => {
      for (const fn of fns) fn();
      return ctx.resume();
    });
  }
  const t0 = performance.now();
  const buffer = await ctx.startRendering();
  return { buffer, wallMs: performance.now() - t0 };
}

/** Calls `fn(t)` every animation frame from `from` to `to` (s), like the game loop. */
function everyFrame(at: At, from: number, to: number, fn: (t: number) => void): void {
  for (let t = from; t < to - 1e-9; t += FRAME) {
    const time = t;
    at(time, () => fn(time));
  }
}

const db = (x: number): number => (x > 0 ? Math.max(-200, 20 * Math.log10(x)) : -200);
const round = (x: number, digits = 2): number => Number(x.toFixed(digits));

/** Short-term RMS (power-averaged over both channels) in windows of `winSec`, every `hopSec`. */
function loudness(buffer: AudioBuffer, winSec: number, hopSec: number, from = 0, to = buffer.duration): number[] {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const w = Math.round(winSec * SR);
  const h = Math.round(hopSec * SR);
  const i1 = Math.min(L.length, Math.floor(to * SR));
  const out: number[] = [];
  for (let s = Math.max(0, Math.floor(from * SR)); s + w <= i1; s += h) {
    let acc = 0;
    for (let i = s; i < s + w; i++) {
      const p = (L[i] * L[i] + R[i] * R[i]) / 2;
      if (Number.isFinite(p)) acc += p;
    }
    out.push(Math.sqrt(acc / w));
  }
  return out;
}

function peakOf(buffer: AudioBuffer, from = 0, to = buffer.duration): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const x = buffer.getChannelData(c);
    const i1 = Math.min(x.length, Math.floor(to * SR));
    for (let i = Math.max(0, Math.floor(from * SR)); i < i1; i++) peak = Math.max(peak, Math.abs(x[i]));
  }
  return peak;
}

/** The mid signal's first-difference ratio over a span, as a frequency: higher is brighter. */
function brightness(buffer: AudioBuffer, from = 0, to = buffer.duration): number {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const i0 = Math.max(1, Math.floor(from * SR));
  const i1 = Math.min(L.length, Math.floor(to * SR));
  let d = 0;
  let m = 0;
  for (let i = i0; i < i1; i++) {
    const a = (L[i] + R[i]) / 2;
    const b = (L[i - 1] + R[i - 1]) / 2;
    d += (a - b) ** 2;
    m += a * a;
  }
  const ratio = m > 0 ? Math.sqrt(d / m) : 0;
  return Math.round((Math.asin(Math.min(1, ratio / 2)) * SR) / Math.PI);
}

/** How much the 10 ms envelope swings over a span (standard deviation over mean): beats score high, a steady roar low. */
function modulation(buffer: AudioBuffer, from: number, to: number): number {
  const env = loudness(buffer, 0.01, 0.005, from, to);
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const variance = env.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, env.length);
  return mean > 0 ? Math.sqrt(variance) / mean : 0;
}

/** Power at one frequency over a span (Goertzel), Hann-windowed. */
function powerAt(buffer: AudioBuffer, hz: number, from: number, to: number): number {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const i0 = Math.floor(from * SR);
  const n = Math.min(L.length, Math.floor(to * SR)) - i0;
  const k = 2 * Math.cos((2 * Math.PI * hz) / SR);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = ((L[i0 + i] + R[i0 + i]) / 2) * w + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (s1 * s1 + s2 * s2 - k * s1 * s2) / (n * n);
}

/** A biquad section applied in place: [b0, b1, b2, a1, a2]. */
function biquadInPlace(x: Float32Array, [b0, b1, b2, a1, a2]: readonly number[]): void {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = Number.isFinite(x[i]) ? x[i] : 0;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
    x[i] = y0;
  }
}

/** ITU-R BS.1770 K-weighting at 48 kHz: a high shelf (head effects) and a high-pass (RLB). */
const K_SHELF = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585] as const;
const K_HIGHPASS = [1, -2, 1, -1.99004745483398, 0.99007225036621] as const;

/** Loudest momentary loudness (400 ms windows, 10 ms hop), in LUFS. */
function momentaryLufs(buffer: AudioBuffer): number {
  const chans = [0, 1].map((c) => {
    const z = buffer.getChannelData(c).slice();
    biquadInPlace(z, K_SHELF);
    biquadInPlace(z, K_HIGHPASS);
    return z;
  });
  const w = Math.round(0.4 * SR);
  const h = Math.round(0.01 * SR);
  const n = chans[0].length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + chans[0][i] * chans[0][i] + chans[1][i] * chans[1][i];
  let best = 0;
  if (n <= w) best = cum[n] / w;
  for (let s = 0; s + w <= n; s += h) best = Math.max(best, (cum[s + w] - cum[s]) / w);
  return best > 0 ? -0.691 + 10 * Math.log10(best) : -200;
}

function analyse(name: string, buffer: AudioBuffer): SoundStats {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  let peak = 0;
  let sumL = 0;
  let sumR = 0;
  let sum = 0;
  let clipped = 0;
  let nan = false;
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    const r = R[i];
    if (!Number.isFinite(l) || !Number.isFinite(r)) {
      nan = true;
      continue;
    }
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
    sumL += l * l;
    sumR += r * r;
    sum += (l + r) / 2;
  }
  const steps = loudness(buffer, 0.01, 0.01);
  const loudest = Math.max(0, ...loudness(buffer, 0.05, 0.01));
  const floor = Math.max(...steps, 0) * 10 ** (-50 / 20);
  let first = -1;
  let last = -1;
  steps.forEach((v, k) => {
    if (v > 0 && v >= floor) {
      if (first < 0) first = k;
      last = k;
    }
  });
  let active = 0;
  for (let k = Math.max(0, first); k <= last; k++) active += steps[k] * steps[k];
  const activeRms = first < 0 ? 0 : Math.sqrt(active / (last - first + 1));
  return {
    name,
    renderedSec: round(buffer.duration, 3),
    activeSec: first < 0 ? 0 : round((last - first + 1) * 0.01, 2),
    peak: round(peak, 4),
    peakDb: round(db(peak), 1),
    rmsDb: round(db(activeRms), 1),
    loudestRmsDb: round(db(loudest), 1),
    loudnessLufs: round(momentaryLufs(buffer), 1),
    balanceDb: round(sumR > 0 && sumL > 0 ? 10 * Math.log10(sumL / sumR) : sumL > 0 ? 200 : sumR > 0 ? -200 : 0, 1),
    brightnessHz: brightness(buffer),
    dcOffset: round(sum / L.length, 5),
    nan,
    clipped,
  };
}

/** The lag (s) in [minLag, maxLag] at which the 10 ms envelope best matches itself over [from, to]. */
function period(buffer: AudioBuffer, from: number, to: number, minLag: number, maxLag: number): number {
  const hop = 0.005;
  const env = loudness(buffer, 0.01, hop, from, to);
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const x = env.map((v) => v - mean);
  let best = -Infinity;
  let bestLag = 0;
  for (let lag = Math.round(minLag / hop); lag <= Math.round(maxLag / hop); lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    s /= Math.max(1, x.length - lag);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  return round(bestLag * hop, 3);
}

/** Rising crossings of `threshold` in the 5 ms envelope, at least `refractory` seconds apart. */
function onsets(buffer: AudioBuffer, threshold: number, refractory: number): number[] {
  const hop = 0.005;
  const env = loudness(buffer, 0.005, hop);
  const times: number[] = [];
  let last = -Infinity;
  for (let k = 1; k < env.length; k++) {
    const t = k * hop;
    if (env[k] >= threshold && env[k - 1] < threshold && t - last >= refractory) {
      times.push(round(t, 3));
      last = t;
    }
  }
  return times;
}

/** RBJ band-pass coefficients (0 dB at the peak) at the bench's rate, as biquadInPlace takes them. */
function bandpassCoeffs(hz: number, q: number): number[] {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, (-2 * Math.cos(w)) / a0, (1 - alpha) / a0];
}

/**
 * Onsets within one band (centre `hz`, width `q`): rising crossings of `rel` times the band's loudest
 * 5 ms level, at least `refractory` seconds apart. Picks out knocks another band's roar would hide.
 */
function bandOnsets(buffer: AudioBuffer, hz: number, q: number, rel: number, refractory: number): number[] {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const x = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) x[i] = (L[i] + R[i]) / 2;
  biquadInPlace(x, bandpassCoeffs(hz, q));
  const w = Math.round(0.005 * SR);
  const env: number[] = [];
  for (let s = 0; s + w <= x.length; s += w) {
    let a = 0;
    for (let i = s; i < s + w; i++) a += x[i] * x[i];
    env.push(Math.sqrt(a / w));
  }
  const threshold = rel * Math.max(0, ...env);
  const times: number[] = [];
  let last = -Infinity;
  for (let k = 1; k < env.length; k++) {
    const t = k * 0.005;
    if (env[k] >= threshold && env[k - 1] < threshold && t - last >= refractory) {
      times.push(round(t, 3));
      last = t;
    }
  }
  return times;
}

/**
 * The fundamental (Hz) of a voiced sound over [from, to]: the lag between 1/hi and 1/lo seconds at which
 * the mid signal best matches itself (normalised autocorrelation), or 0 if nothing there is periodic.
 */
function pitch(buffer: AudioBuffer, from: number, to: number, lo: number, hi: number): number {
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const i0 = Math.max(0, Math.floor(from * SR));
  const n = Math.min(L.length, Math.floor(to * SR)) - i0;
  if (n < 64) return 0;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (L[i0 + i] + R[i0 + i]) / 2;
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(SR / hi); lag <= Math.min(n - 1, Math.ceil(SR / lo)); lag++) {
    let s = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = 0; i + lag < n; i++) {
      s += x[i] * x[i + lag];
      e0 += x[i] * x[i];
      e1 += x[i + lag] * x[i + lag];
    }
    const r = s / Math.sqrt(e0 * e1 + 1e-20);
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return best > 0.3 && bestLag > 0 ? round(SR / bestLag, 1) : 0;
}

// ---- What gets rendered ------------------------------------------------------------------------------

interface Case {
  name: string;
  seconds: number;
  script: Script;
  /** Quietest acceptable loudest-moment RMS (default −40 dBFS); an idling engine is meant to be faint. */
  floor?: number;
  /** A one-shot: rendered several times for its worst peak. */
  oneShot?: boolean;
}

const shotCase = (name: string, seconds: number, fire: (s: Sfx) => void): Case => ({ name, seconds, script: (s) => fire(s), oneShot: true });

const ONE_SHOTS: Case[] = [
  shotCase('revolver', 1.2, (s) => s.shot('revolver')),
  shotCase('shotgun', 1.6, (s) => s.shot('shotgun')),
  shotCase('rifle', 2.4, (s) => s.shot('rifle')),
  shotCase('bandit (pan -1)', 1.4, (s) => s.shot('bandit', { pan: -1, gain: 1 })),
  shotCase('bandit (pan +1)', 1.4, (s) => s.shot('bandit', { pan: 1, gain: 1 })),
  shotCase('bandit (centre)', 1.4, (s) => s.shot('bandit', { gain: 1 })),
  shotCase('bandit (far, gain 0.3)', 1.4, (s) => s.shot('bandit', { pan: 0.3, gain: 0.3 })),
  shotCase('muffled (Engineer)', 1.4, (s) => s.shot('bandit', { muffled: true, gain: 1 })),
  shotCase('ricochet', 1, (s) => s.ricochet(-0.4)),
  shotCase('whiz', 0.5, (s) => s.whiz(0.8)),
  shotCase('hurt', 1.6, (s) => s.hurt()),
  shotCase('hit marker', 0.4, (s) => s.hitMarker()),
  shotCase('reload revolver', 2, (s) => s.reload('revolver')),
  shotCase('reload shotgun', 2.6, (s) => s.reload('shotgun')),
  shotCase('reload rifle', 3, (s) => s.reload('rifle')),
  shotCase('dry fire', 0.3, (s) => s.dryFire()),
  shotCase('jump', 0.5, (s) => s.jump()),
  shotCase('land', 0.5, (s) => s.land(false)),
  shotCase('land (hard)', 0.6, (s) => s.land(true)),
  shotCase('thud', 1.2, (s) => s.thud()),
  shotCase('explosion', 2.6, (s) => s.explosion(false)),
  shotCase('explosion (big)', 4.6, (s) => s.explosion(true)),
  shotCase('crash', 3.2, (s) => s.crash()),
  shotCase('tunnel (enter)', 1.2, (s) => s.tunnel(true)),
  shotCase('tunnel (exit)', 1.2, (s) => s.tunnel(false)),
  shotCase('telegraph', 2, (s) => s.telegraph()),
  shotCase('switch throw', 1, (s) => s.switchThrow()),
  shotCase('lever', 0.4, (s) => s.lever()),
  shotCase('bell', 3.6, (s) => s.bell()),
  shotCase('chime', 2, (s) => s.chime()),
  shotCase('cash', 1.4, (s) => s.cash()),
  shotCase('alarm', 1.4, (s) => s.alarm()),
  shotCase('win', 2.8, (s) => s.win()),
  shotCase('lose', 2.9, (s) => s.lose()),
  shotCase('ui click', 0.2, (s) => s.uiClick()),
  // Round 2.
  shotCase('splash (the loco)', 2, (s) => s.splash(true)),
  shotCase('splash (a body)', 1.2, (s) => s.splash(false)),
  shotCase('splash (cab)', 2, (s) => s.splash(true, { muffled: true, gain: 0.8 })),
  shotCase('lurch (rider)', 1.4, (s) => s.lurch('rider')),
  shotCase('lurch (cab)', 1.4, (s) => s.lurch('cab')),
  shotCase('whinny', 1.5, (s) => s.whinny(0, 1)),
  shotCase('cattle calm', 2, (s) => s.cattle(false, 0, 1)),
  shotCase('cattle scatter', 3.2, (s) => s.cattle(true, 0, 1)),
  shotCase('grunt', 0.8, (s) => s.grunt()),
  shotCase('flare', 1, (s) => s.flare()),
];

const ENGINE_SECONDS = 3.5;
const engineCase = (name: string, speed: number, throttle: number, listener: Listener = 'rider', tunnel = false, floor?: number): Case => ({
  name,
  seconds: ENGINE_SECONDS,
  script: (s, at) => everyFrame(at, 0, ENGINE_SECONDS, () => s.engine({ speed, throttle, tunnel, listener })),
  floor,
});

const LAYERS: Case[] = [
  engineCase('engine idle (rider)', 0, 0, 'rider', false, 10 ** (-60 / 20)),
  engineCase('engine idle (cab)', 0, 0, 'cab', false, 10 ** (-55 / 20)),
  {
    name: 'engine starting (cocks open)',
    seconds: 4,
    script: (s, at) => everyFrame(at, 0, 4, (t) => s.engine({ speed: 0.8 * t, throttle: 0.8, tunnel: false, listener: 'rider' })),
  },
  engineCase('engine 5 m/s, throttle 0.7', 5, 0.7),
  engineCase('engine 10 m/s, full', 10, 1),
  engineCase('engine 10 m/s, coasting', 10, 0),
  engineCase('engine 25 m/s, full', 25, 1),
  engineCase('engine 20 m/s (rider)', 20, 0.6, 'rider'),
  engineCase('engine 20 m/s (cab)', 20, 0.6, 'cab'),
  engineCase('engine 20 m/s (tunnel)', 20, 0.6, 'rider', true),
  engineCase('engine 15 m/s, coasting (rails, rods)', 15, 0),
  {
    name: 'engine drive: stand, pull away, run up, coast, brake',
    seconds: 16,
    script: (s, at) =>
      everyFrame(at, 0, 16, (t) => {
        const speed = t < 1 ? 0 : t < 10 ? 2.6 * (t - 1) : t < 12.5 ? 23.4 - 0.3 * (t - 10) : Math.max(0, 22.65 - 6 * (t - 12.5));
        s.engine({ speed, throttle: t < 1 ? 0 : t < 10 ? 1 : 0, tunnel: false, listener: 'rider' });
        s.brakes(t >= 12.5 && speed > 0.3 ? 0.8 : 0);
      }),
  },
  {
    name: 'wind 0.3',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.wind(0.3)),
  },
  {
    name: 'wind 1',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.wind(1)),
  },
  {
    name: 'brakes 0.5',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.brakes(0.5)),
  },
  {
    name: 'brakes 1 (emergency)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.brakes(1)),
  },
  {
    name: 'safety valve',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.safetyValve(true)),
  },
  {
    name: 'water column',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.water(true)),
  },
  {
    name: 'gallop (1 horse)',
    seconds: 4,
    script: (s, at) => everyFrame(at, 0, 4, () => s.gallop([{ pan: 0, gain: 1 }])),
  },
  {
    name: 'gallop (1 horse, pan -1)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.gallop([{ pan: -1, gain: 1 }])),
  },
  {
    name: 'gallop (3 horses)',
    seconds: 3,
    script: (s, at) =>
      everyFrame(at, 0, 3, () =>
        s.gallop([
          { pan: -0.8, gain: 1 },
          { pan: 0.2, gain: 0.7 },
          { pan: 0.9, gain: 0.4 },
        ]),
      ),
  },
  {
    name: 'whistle (cab)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, (t) => s.whistle(t < 1.5, 'cab')),
  },
  {
    name: 'whistle (rider)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, (t) => s.whistle(t < 1.5, 'rider')),
  },
  {
    name: 'ford water (churning)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.fordWater(1)),
  },
  {
    name: 'ford water (standing in it)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.fordWater(0.4)),
  },
  {
    name: 'ford water (pan -1)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.fordWater(1, { pan: -1 })),
  },
  {
    name: 'ford water (cab)',
    seconds: 3,
    script: (s, at) => everyFrame(at, 0, 3, () => s.fordWater(1, { listener: 'cab' })),
  },
];

/** Every method with sensible and nonsensical arguments. None may throw. */
function exerciseAll(s: Sfx): void {
  s.setVolumes(Number.NaN, 2);
  s.setVolumes(0.8, 0.9);
  for (const c of ONE_SHOTS) c.script(s, (_time, fn) => fn());
  s.shot('cannon' as 'rifle', { pan: Number.NaN, gain: Number.POSITIVE_INFINITY });
  s.reloadFor('rifle', Number.NaN);
  s.engine({ speed: Number.NaN, throttle: 9, tunnel: true, listener: 'moon' as Listener });
  s.engine(null);
  s.wind(Number.NaN);
  s.brakes(-1);
  s.safetyValve(true);
  s.water(true);
  s.fordWater(Number.NaN, { pan: Number.POSITIVE_INFINITY, listener: 'moon' as Listener });
  s.fordWater(0.7);
  s.splash(undefined as unknown as boolean, { gain: Number.NaN });
  s.lurch('moon' as Listener);
  s.whinny(Number.NaN, -1);
  s.cattle('yes' as unknown as boolean, 9, 9);
  s.gallop([{ pan: Number.NaN, gain: 2 }]);
  s.gallop(null as unknown as []);
  s.whistle(true, 'cab');
  s.whistle(false, 'moon' as Listener);
  s.stopAll();
}

async function renderAll(): Promise<RenderReport> {
  const stats: SoundStats[] = [];
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };
  const byName = new Map<string, SoundStats>();
  const buffers = new Map<string, AudioBuffer>();

  for (const c of [...ONE_SHOTS, ...LAYERS]) {
    const { buffer } = await render(c.seconds, c.script);
    const s = analyse(c.name, buffer);
    let worst = s.peak;
    let nan = s.nan;
    if (c.oneShot) {
      for (let i = 1; i < RENDERS; i++) {
        const again = analyse(c.name, (await render(c.seconds, c.script)).buffer);
        worst = Math.max(worst, again.peak);
        nan ||= again.nan;
      }
      s.worstPeakDb = round(db(worst), 1);
    }
    stats.push(s);
    byName.set(c.name, s);
    buffers.set(c.name, buffer);
    const loud = 10 ** (s.loudestRmsDb / 20);
    check(
      `${c.name}: audible, no clipping, no NaN`,
      loud >= (c.floor ?? AUDIBLE_RMS) && worst < 1 && s.clipped === 0 && !nan,
      `peak ${s.peakDb} dBFS${c.oneShot ? ` (worst of ${RENDERS}: ${s.worstPeakDb})` : ''}, loudest ${s.loudestRmsDb} dBFS, ${s.loudnessLufs} LUFS, active ${s.activeSec} s`,
    );
    check(`${c.name}: stays below the safety clip`, worst < CLIP_KNEE, `worst peak ${round(db(worst), 1)} dBFS`);
  }
  const stat = (name: string): SoundStats => {
    const s = byName.get(name);
    if (!s) throw new Error(`no stats for ${name}`);
    return s;
  };
  const buf = (name: string): AudioBuffer => {
    const b = buffers.get(name);
    if (!b) throw new Error(`no buffer for ${name}`);
    return b;
  };

  // Gunfire: whose shot, from where, how far, through what.
  const left = stat('bandit (pan -1)');
  const right = stat('bandit (pan +1)');
  const centre = stat('bandit (centre)');
  const far = stat('bandit (far, gain 0.3)');
  const muffled = stat('muffled (Engineer)');
  check('bandit pan -1 sits left', left.balanceDb >= 10, `L/R ${left.balanceDb} dB`);
  check('bandit pan +1 sits right', right.balanceDb <= -10, `L/R ${right.balanceDb} dB`);
  check('bandit centre is centred', Math.abs(centre.balanceDb) < 1, `L/R ${centre.balanceDb} dB`);
  check('far bandit is quieter and darker', far.loudnessLufs < centre.loudnessLufs - 6 && far.brightnessHz < centre.brightnessHz, `${far.loudnessLufs} vs ${centre.loudnessLufs} LUFS, ${far.brightnessHz} vs ${centre.brightnessHz} Hz`);
  check('muffled gunfire is much darker and softer', muffled.brightnessHz < 0.5 * centre.brightnessHz && muffled.loudnessLufs < centre.loudnessLufs - 3, `${muffled.brightnessHz} vs ${centre.brightnessHz} Hz, ${muffled.loudnessLufs} vs ${centre.loudnessLufs} LUFS`);
  const revolver = stat('revolver');
  const shotgun = stat('shotgun');
  const rifle = stat('rifle');
  check('shotgun booms louder and darker than the revolver', shotgun.loudnessLufs > revolver.loudnessLufs && shotgun.brightnessHz < revolver.brightnessHz, `${shotgun.loudnessLufs} vs ${revolver.loudnessLufs} LUFS, ${shotgun.brightnessHz} vs ${revolver.brightnessHz} Hz`);
  check('rifle rings on longest (canyon tail)', rifle.activeSec > revolver.activeSec + 0.4 && rifle.activeSec > shotgun.activeSec, `${rifle.activeSec} vs ${revolver.activeSec} / ${shotgun.activeSec} s`);
  check('rifle crack is the brightest', rifle.brightnessHz > revolver.brightnessHz && rifle.brightnessHz > shotgun.brightnessHz, `${rifle.brightnessHz} vs ${revolver.brightnessHz} / ${shotgun.brightnessHz} Hz`);
  check('your shots stand apart from bandit shots', Math.abs(revolver.brightnessHz - centre.brightnessHz) > 150 || Math.abs(revolver.loudnessLufs - centre.loudnessLufs) > 2, `revolver ${revolver.brightnessHz} Hz ${revolver.loudnessLufs} LUFS, bandit ${centre.brightnessHz} Hz ${centre.loudnessLufs} LUFS`);
  const ric = buf('ricochet');
  const ricEarly = brightness(ric, 0.02, 0.12);
  const ricLate = brightness(ric, 0.3, 0.5);
  check('ricochet sweeps down ("pyeeow")', ricLate < 0.75 * ricEarly, `${ricEarly} Hz early, ${ricLate} Hz late`);
  check('whiz is quick', stat('whiz').activeSec < 0.35, `${stat('whiz').activeSec} s`);
  const big = stat('explosion (big)');
  const small = stat('explosion');
  check('big explosion is bigger: louder and longer', big.loudnessLufs > small.loudnessLufs && big.activeSec > small.activeSec + 0.8, `${big.loudnessLufs} vs ${small.loudnessLufs} LUFS, ${big.activeSec} vs ${small.activeSec} s`);
  for (const [w, sec] of [
    ['revolver', 1.6],
    ['shotgun', 2.2],
    ['rifle', 2.6],
  ] as const) {
    const r = stat(`reload ${w}`);
    check(`reload ${w} is done as the gun is ready`, r.activeSec > 0.7 * sec && r.activeSec < sec + 0.25, `${r.activeSec} s for a ${sec} s reload`);
  }
  const ticks = onsets(buf('telegraph'), 0.3 * 10 ** (stat('telegraph').loudestRmsDb / 20), 0.03);
  check('telegraph ticks out a pattern', ticks.length >= 6, `${ticks.length} clicks`);
  check('bell rings on', stat('bell').activeSec >= 2, `${stat('bell').activeSec} s`);
  for (const name of ['win', 'lose']) check(`${name} stinger is short`, stat(name).activeSec >= 1.2 && stat(name).activeSec <= 2.9, `${stat(name).activeSec} s`);

  // The locomotive.
  const settled = (name: string): AudioBuffer => buf(name);
  const e5 = settled('engine 5 m/s, throttle 0.7');
  const p5 = period(e5, 0.8, ENGINE_SECONDS, 0.15, 0.4);
  const expect5 = 1 / chuffRate(5);
  check('engine at 5 m/s chuffs 4 times a second', Math.abs(p5 - expect5) / expect5 < 0.08, `period ${p5} s (expected ${round(expect5, 3)})`);
  const e10 = settled('engine 10 m/s, full');
  const p10 = period(e10, 0.8, ENGINE_SECONDS, 0.08, 0.2);
  const expect10 = 1 / chuffRate(10);
  check('engine at 10 m/s chuffs 8 times a second', Math.abs(p10 - expect10) / expect10 < 0.08, `period ${p10} s (expected ${round(expect10, 3)})`);
  const full = stat('engine 10 m/s, full');
  const coast = stat('engine 10 m/s, coasting');
  check('throttle: working is louder and brighter than coasting', full.loudnessLufs > coast.loudnessLufs + 5 && brightness(e10, 1, 3.5) > brightness(buf('engine 10 m/s, coasting'), 1, 3.5), `${full.loudnessLufs} vs ${coast.loudnessLufs} LUFS`);
  const m5 = modulation(e5, 1, ENGINE_SECONDS);
  const m25 = modulation(buf('engine 25 m/s, full'), 1, ENGINE_SECONDS);
  check('at speed the beats fuse into a roar', m25 < 0.75 * m5, `envelope swing ${round(m25, 2)} at 25 m/s vs ${round(m5, 2)} at 5 m/s`);
  const open = stat('engine 20 m/s (rider)');
  const bore = stat('engine 20 m/s (tunnel)');
  const cab = stat('engine 20 m/s (cab)');
  check('tunnel: louder and darker', bore.loudnessLufs > open.loudnessLufs + 2 && bore.brightnessHz < 0.8 * open.brightnessHz, `${bore.loudnessLufs} vs ${open.loudnessLufs} LUFS, ${bore.brightnessHz} vs ${open.brightnessHz} Hz`);
  check('cab: darker, the rails underfoot', cab.brightnessHz < open.brightnessHz, `${cab.brightnessHz} vs ${open.brightnessHz} Hz`);
  const idle = stat('engine idle (rider)');
  check('idling engine is faint but there', idle.loudestRmsDb < -30 && idle.loudestRmsDb > -60, `loudest ${idle.loudestRmsDb} dBFS`);
  const start = buf('engine starting (cocks open)');
  check('a start hisses from the cylinder cocks', brightness(start, 0.5, 2) > brightness(buf('engine idle (rider)'), 0.5, 2), `${brightness(start, 0.5, 2)} Hz vs idle ${brightness(buf('engine idle (rider)'), 0.5, 2)} Hz`);
  check('the fastest engine is the loudest moving', stat('engine 25 m/s, full').loudnessLufs > full.loudnessLufs, `${stat('engine 25 m/s, full').loudnessLufs} vs ${full.loudnessLufs} LUFS`);

  // Other layers.
  const w1 = stat('wind 1');
  const w3 = stat('wind 0.3');
  check('wind 1 is louder and brighter than 0.3', w1.loudnessLufs > w3.loudnessLufs + 8 && w1.brightnessHz > w3.brightnessHz, `${w1.loudnessLufs} vs ${w3.loudnessLufs} LUFS, ${w1.brightnessHz} vs ${w3.brightnessHz} Hz`);
  const b1 = stat('brakes 1 (emergency)');
  const b5 = stat('brakes 0.5');
  check('emergency brakes screech: louder and brighter', b1.loudnessLufs > b5.loudnessLufs + 3 && b1.brightnessHz > b5.brightnessHz, `${b1.loudnessLufs} vs ${b5.loudnessLufs} LUFS, ${b1.brightnessHz} vs ${b5.brightnessHz} Hz`);
  const g1 = buf('gallop (1 horse)');
  const stride = period(g1, 0.5, 4, 0.3, 0.7);
  check('a horse lopes: its beat repeats every stride', stride > 0.38 && stride < 0.52, `period ${stride} s`);
  check('horse at pan -1 sits left', stat('gallop (1 horse, pan -1)').balanceDb >= 8, `L/R ${stat('gallop (1 horse, pan -1)').balanceDb} dB`);
  // Hoofbeats are sparse and each horse keeps its own pace, so compare average power over a long settled
  // span: three equally near horses should come out near 3× the power of one (+4.8 dB).
  const herdOf = async (n: number): Promise<number> => {
    const { buffer } = await render(8, (s, at) => everyFrame(at, 0, 8, () => s.gallop(Array.from({ length: n }, (_, k) => ({ pan: k - 1, gain: 1 })))));
    return loudness(buffer, 7, 7, 0.8, 7.8)[0] ?? 0;
  };
  const herd = await herdOf(3);
  const lone = await herdOf(1);
  check('three horses are louder than one', herd > lone * 1.3, `${round(db(herd), 1)} vs ${round(db(lone), 1)} dBFS RMS`);
  const wc = stat('whistle (cab)');
  const wr = stat('whistle (rider)');
  check('whistle is louder in the cab', wc.loudnessLufs > wr.loudnessLufs + 3, `${wc.loudnessLufs} vs ${wr.loudnessLufs} LUFS`);
  const wb = buf('whistle (cab)');
  const chord = [277.18, 329.63, 415.3, 493.88, 554.37].reduce((a, f) => a + powerAt(wb, f, 0.4, 1.4), 0);
  const between = [303, 372, 452, 523, 610].reduce((a, f) => a + powerAt(wb, f, 0.4, 1.4), 0);
  check('whistle sounds its chord', chord > 20 * between, `chord/between power ${round(chord / Math.max(1e-30, between), 1)}`);
  const wTail = peakOf(wb, 2.4, 3);
  check('whistle stops when let go', wTail < SILENT_PEAK, `peak after release ${wTail.toExponential(1)}`);

  // Round 2: the ford, the lurch, horses and cattle, the Rider thrown.
  const fChurn = stat('ford water (churning)');
  const fStand = stat('ford water (standing in it)');
  const fCab = stat('ford water (cab)');
  const fLeft = stat('ford water (pan -1)');
  check('ford: ploughing through churns louder and brighter than standing in it', fChurn.loudnessLufs > fStand.loudnessLufs + 2 && fChurn.brightnessHz > fStand.brightnessHz, `${fChurn.loudnessLufs} vs ${fStand.loudnessLufs} LUFS, ${fChurn.brightnessHz} vs ${fStand.brightnessHz} Hz`);
  check('ford: under the cab’s footplate it is muffled', fCab.brightnessHz < 0.5 * fChurn.brightnessHz, `${fCab.brightnessHz} vs ${fChurn.brightnessHz} Hz`);
  check('ford at pan -1 sits left', fLeft.balanceDb >= 8, `L/R ${fLeft.balanceDb} dB`);
  const sBig = stat('splash (the loco)');
  const sBody = stat('splash (a body)');
  check('the loco ploughing in is a bigger splash than a body falling in', sBig.loudnessLufs > sBody.loudnessLufs && sBig.activeSec > sBody.activeSec, `${sBig.loudnessLufs} vs ${sBody.loudnessLufs} LUFS, ${sBig.activeSec} vs ${sBody.activeSec} s`);
  check('a splash heard from the cab is muffled', stat('splash (cab)').brightnessHz < 0.5 * sBig.brightnessHz, `${stat('splash (cab)').brightnessHz} vs ${sBig.brightnessHz} Hz`);
  // The clanks ring below the brakes' squeal and above the shove's thump: count them in their own band.
  const clanks = bandOnsets(buf('lurch (rider)'), 700, 0.8, 0.3, 0.04);
  check('lurch: clank after clank as the slack runs in', clanks.length >= 4, `${clanks.length} clanks at ${clanks.join(', ')} s`);
  const wh = buf('whinny');
  const whEarly = pitch(wh, 0.1, 0.18, 300, 1600);
  const whLate = pitch(wh, 0.55, 0.7, 300, 1600);
  check('a whinny leaps up, then shudders down', whEarly > 1.2 * whLate && whLate > 0, `${whEarly} Hz early, ${whLate} Hz late`);
  const moo = buf('cattle calm');
  const mooMid = pitch(moo, 0.35, 0.65, 60, 300);
  const mooEnd = pitch(moo, 1.18, 1.3, 60, 300);
  check('the calm herd’s low is a question: it rises at the end', mooEnd > 1.12 * mooMid && mooMid > 0, `${mooMid} Hz, then ${mooEnd} Hz`);
  const bolt = stat('cattle scatter');
  const hoofbeats = onsets(buf('cattle scatter'), 0.2 * 10 ** (bolt.loudestRmsDb / 20), 0.04).filter((t) => t > 1);
  check('a scattering herd bellows, then drums off', bolt.activeSec > stat('cattle calm').activeSec && hoofbeats.length >= 5, `${bolt.activeSec} s, ${hoofbeats.length} hoofbeats after the bellow`);
  check('the Rider’s grunt is short', stat('grunt').activeSec < 0.7, `${stat('grunt').activeSec} s`);
  check('a flare of flame is over within a second', stat('flare').activeSec < 1, `${stat('flare').activeSec} s`);

  // Layers stop when told: faded within a second or so, torn down (silent) once idle for two.
  const offs: [string, Script][] = [
    ['engine null', (s, at) => everyFrame(at, 0, 5, (t) => s.engine(t < 1.5 ? { speed: 12, throttle: 0.8, tunnel: false, listener: 'rider' } : null))],
    ['wind 0', (s, at) => everyFrame(at, 0, 5, (t) => s.wind(t < 1.5 ? 0.8 : 0))],
    ['brakes 0', (s, at) => everyFrame(at, 0, 5, (t) => s.brakes(t < 1.5 ? 1 : 0))],
    ['safety valve off', (s, at) => everyFrame(at, 0, 5, (t) => s.safetyValve(t < 1.5))],
    ['water off', (s, at) => everyFrame(at, 0, 5, (t) => s.water(t < 1.5))],
    ['ford water off', (s, at) => everyFrame(at, 0, 5, (t) => s.fordWater(t < 1.5 ? 0.8 : 0))],
    ['horses gone', (s, at) => everyFrame(at, 0, 5, (t) => s.gallop(t < 1.5 ? [{ pan: 0, gain: 1 }] : []))],
  ];
  for (const [name, script] of offs) {
    const { buffer } = await render(5, script);
    const before = Math.max(...loudness(buffer, 0.05, 0.01, 0.8, 1.5));
    const faded = Math.max(...loudness(buffer, 0.05, 0.01, 2.7, 3.5));
    const after = peakOf(buffer, 3.8, 5);
    check(
      `${name}: fades, then silent`,
      before > AUDIBLE_RMS * 0.3 && faded < before * 0.01 && after < SILENT_PEAK,
      `before ${round(db(before), 1)} dBFS, a second on ${round(db(faded), 1)} dBFS, peak after ${after.toExponential(1)}`,
    );
  }
  const stop = await render(3.5, (s, at) => {
    everyFrame(at, 0, 1.5, () => {
      s.engine({ speed: 18, throttle: 0.9, tunnel: false, listener: 'rider' });
      s.wind(0.8);
      s.brakes(0.6);
      s.safetyValve(true);
      s.water(true);
      s.fordWater(0.8, { pan: 0.3 });
      s.gallop([
        { pan: -0.5, gain: 1 },
        { pan: 0.5, gain: 0.6 },
      ]);
      s.whistle(true, 'cab');
    });
    at(1.5, () => s.stopAll());
  });
  const stopBefore = Math.max(...loudness(stop.buffer, 0.05, 0.01, 0.8, 1.5));
  const stopAfter = peakOf(stop.buffer, 1.9, 3.5);
  check('stopAll silences every layer', stopBefore > AUDIBLE_RMS && stopAfter < SILENT_PEAK, `before ${round(db(stopBefore), 1)} dBFS, peak after ${stopAfter.toExponential(1)}`);

  // Volumes: master 0 silences everything; effects 0 leaves the train (the world bus) and nothing else.
  const mute = await render(2, (s, at) => {
    s.setVolumes(0, 1);
    everyFrame(at, 0, 2, () => s.engine({ speed: 15, throttle: 1, tunnel: false, listener: 'rider' }));
    at(0.5, () => s.shot('rifle'));
  });
  const mutePeak = peakOf(mute.buffer, 0.3);
  check('master volume 0 is silent', mutePeak < SILENT_PEAK, `peak ${mutePeak.toExponential(1)}`);
  const noFxShot = await render(2, (s, at) => {
    s.setVolumes(1, 0);
    at(0.5, () => s.shot('rifle'));
  });
  const noFxShotPeak = peakOf(noFxShot.buffer);
  const noFxTrain = await render(2, (s, at) => {
    s.setVolumes(1, 0);
    everyFrame(at, 0, 2, () => s.engine({ speed: 15, throttle: 1, tunnel: false, listener: 'rider' }));
  });
  const noFxTrainLoud = Math.max(...loudness(noFxTrain.buffer, 0.05, 0.01, 0.8, 2));
  check('effects volume 0 silences the action but not the train', noFxShotPeak < SILENT_PEAK && noFxTrainLoud > AUDIBLE_RMS, `shot peak ${noFxShotPeak.toExponential(1)}, engine ${round(db(noFxTrainLoud), 1)} dBFS`);
  const half = analyse(
    'rifle at master 0.5',
    (
      await render(2.8, (s, at) => {
        s.setVolumes(0.5, 1);
        at(0.3, () => s.shot('rifle'));
      })
    ).buffer,
  );
  check('master volume 0.5 is quieter', half.loudestRmsDb < rifle.loudestRmsDb - 6, `${half.loudestRmsDb} vs ${rifle.loudestRmsDb} dBFS`);

  // Everything at once: the compressor and safety clip must hold.
  const stress = await render(4, (s, at) => {
    everyFrame(at, 0, 4, () => {
      s.engine({ speed: 22, throttle: 1, tunnel: true, listener: 'rider' });
      s.wind(1);
      s.brakes(1);
      s.safetyValve(true);
      s.water(true);
      s.fordWater(1);
      s.gallop([
        { pan: -1, gain: 1 },
        { pan: -0.3, gain: 1 },
        { pan: 0.4, gain: 1 },
        { pan: 1, gain: 1 },
      ]);
      s.whistle(true, 'cab');
    });
    at(0.3, () => {
      for (const c of ONE_SHOTS) c.script(s, (_t, fn) => fn());
    });
  });
  const stressStats = analyse('everything at once', stress.buffer);
  stats.push(stressStats);
  check('everything at once: no clipping, no NaN', stressStats.peak < 1 && stressStats.clipped === 0 && !stressStats.nan, `peak ${stressStats.peakDb} dBFS`);

  // A busy fight for CPU: the engine working up to speed, wind, four horses, gunfire, ricochets, whistle toots.
  const BUSY = 10;
  const busy = await render(BUSY, (s, at) => {
    everyFrame(at, 0, BUSY, (t) => {
      s.engine({ speed: 6 + 2 * t, throttle: 1, tunnel: false, listener: 'rider' });
      s.wind(Math.min(1, t / 8));
      s.gallop([0, 1, 2, 3].map((k) => ({ pan: Math.sin(t + k), gain: 0.5 + 0.5 * Math.cos(t * 0.7 + k) })));
      s.whistle(t % 3 < 0.4, 'rider');
      s.brakes(t > 8.5 ? 0.9 : 0);
    });
    for (let t = 0.2; t < BUSY; t += 0.35) {
      const time = t;
      at(time, () => {
        s.shot(Math.random() < 0.5 ? 'revolver' : 'bandit', { pan: Math.sin(time * 3), gain: 0.4 + 0.6 * Math.random() });
        if (Math.random() < 0.3) s.ricochet(Math.cos(time));
        if (Math.random() < 0.3) s.whiz(Math.sin(time));
      });
    }
  });
  const busyStats = analyse('busy fight (10 s)', busy.buffer);
  stats.push(busyStats);
  const cpu = { audioSec: BUSY, wallMs: Math.round(busy.wallMs), realtimeFactor: round(BUSY / (busy.wallMs / 1000), 1) };
  check('busy fight: no clipping, no NaN', busyStats.peak < 1 && !busyStats.nan, `peak ${busyStats.peakDb} dBFS`);
  check('busy fight renders far faster than realtime', cpu.realtimeFactor > 5, `${cpu.realtimeFactor}× realtime (${cpu.wallMs} ms for ${BUSY} s)`);

  // Before unlock, with a throwing factory, or with a bogus context, nothing may throw.
  const problems: string[] = [];
  const attempt = (label: string, s: Sfx, unlockFirst: boolean): void => {
    try {
      if (unlockFirst) s.unlock();
      exerciseAll(s);
    } catch (err) {
      problems.push(`${label}: ${String(err)}`);
    }
  };
  const idleSfx = new Sfx();
  attempt('before unlock', idleSfx, false);
  attempt(
    'throwing factory',
    new Sfx(() => {
      throw new Error('no audio');
    }),
    true,
  );
  attempt('bogus context', new Sfx(() => ({}) as BaseAudioContext), true);
  check('safe no-op before unlock and without audio', problems.length === 0 && !idleSfx.ready, problems.join('; ') || 'no throws, ready = false');

  return {
    sampleRate: SR,
    visibility: document.visibilityState,
    stats,
    checks,
    cpu,
    allPass: checks.every((c) => c.pass),
  };
}

// ---- Spectrograms ------------------------------------------------------------------------------------

/** In-place radix-2 FFT of (re, im); length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Colour stops from −100 dBFS (black) to 0 dBFS (white), through violet, red, orange and yellow. */
const HEAT: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [60, 20, 110],
  [190, 40, 70],
  [245, 130, 30],
  [250, 230, 90],
  [255, 255, 255],
];

function heat(v: number): readonly [number, number, number] {
  const x = Math.max(0, Math.min(1, v)) * (HEAT.length - 1);
  const i = Math.min(HEAT.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [HEAT[i], HEAT[i + 1]];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Draws a log-frequency spectrogram (40 Hz – 16 kHz, −100..0 dBFS) of a rendered sound. */
function spectrogram(name: string, buffer: AudioBuffer): HTMLElement {
  const N = 2048;
  const hop = 240;
  const L = buffer.getChannelData(0);
  const R = buffer.getChannelData(1);
  const cols = Math.max(1, Math.floor((L.length - N) / hop));
  const height = 160;
  const canvas = el('canvas', { width: cols, height });
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  const img = g.createImageData(cols, height);
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const fLo = Math.log(40);
  const fHi = Math.log(16000);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let c = 0; c < cols; c++) {
    for (let i = 0; i < N; i++) {
      re[i] = ((L[c * hop + i] + R[c * hop + i]) / 2) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let y = 0; y < height; y++) {
      const f = Math.exp(fHi - ((fHi - fLo) * y) / (height - 1));
      const bin = Math.min(N / 2 - 1, Math.round((f * N) / SR));
      const mag = (2 * Math.hypot(re[bin], im[bin])) / (N / 2);
      const [r, gr, b] = heat((db(mag) + 100) / 100);
      const o = (y * cols + c) * 4;
      img.data[o] = r;
      img.data[o + 1] = gr;
      img.data[o + 2] = b;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Grid: 100 Hz, 1 kHz and 10 kHz lines; a tick every half second.
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (const f of [100, 1000, 10000]) g.fillRect(0, Math.round(((fHi - Math.log(f)) / (fHi - fLo)) * (height - 1)), cols, 1);
  for (let s = 0.5; s * (SR / hop) < cols; s += 0.5) g.fillRect(Math.round((s * SR) / hop), height - 6, 1, 6);
  return el('figure', { className: 'spectrum' }, canvas, el('figcaption', { textContent: `${name} · ${buffer.duration.toFixed(1)} s` }));
}

/** Draws spectrograms of every case whose name contains `filter` (or any of `a|b|c`; all of them when empty). */
async function spectrograms(filter = ''): Promise<number> {
  const target = byId('spectra');
  target.replaceChildren();
  const wanted = filter.split('|');
  const cases = [...ONE_SHOTS, ...LAYERS].filter((c) => wanted.some((w) => c.name.includes(w)));
  for (const c of cases) {
    const { buffer } = await render(c.seconds, c.script);
    target.append(spectrogram(c.name, buffer));
  }
  return cases.length;
}

// ---- Live bench ----------------------------------------------------------------------------------------

declare global {
  interface Window {
    renderAll: () => Promise<RenderReport>;
    spectrograms: (filter?: string) => Promise<number>;
    sfx: Sfx;
  }
}

const sfx = new Sfx();
window.sfx = sfx;
window.renderAll = renderAll;
window.spectrograms = spectrograms;

const knobs = {
  master: 1,
  effects: 1,
  speed: 12,
  throttle: 0.6,
  wind: 0,
  brakes: 0,
  horses: 0,
  horseGain: 0.8,
  pan: 0,
  gain: 1,
  ford: 0.8,
};
const flags = { engine: false, tunnel: false, cab: false, valve: false, water: false, whistle: false, muffled: false, drive: false, rideBy: false, ford: false };

// Capture phase, so the context is created inside the gesture before any button handler runs.
const unlock = (): void => sfx.unlock();
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing`);
  return node as T;
}

function button(label: string, action: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label });
  b.addEventListener('click', () => {
    sfx.unlock();
    action();
  });
  return b;
}

/** A button that stays pressed: flips a flag the frame loop reads. */
function toggle(label: string, flag: keyof typeof flags): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label });
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => {
    sfx.unlock();
    flags[flag] = !flags[flag];
    b.setAttribute('aria-pressed', String(flags[flag]));
  });
  return b;
}

/** A button held down: the whistle cord. */
function hold(label: string, flag: keyof typeof flags): HTMLButtonElement {
  const b = el('button', { type: 'button', textContent: label });
  const set = (on: boolean): void => {
    flags[flag] = on;
    b.setAttribute('aria-pressed', String(on));
  };
  b.addEventListener('pointerdown', () => set(true));
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) b.addEventListener(ev, () => set(false));
  return b;
}

function knob(label: string, key: keyof typeof knobs, min: number, max: number, step: number): HTMLLabelElement {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(knobs[key]) });
  const out = el('output', { textContent: String(knobs[key]) });
  input.addEventListener('input', () => {
    knobs[key] = Number(input.value);
    out.textContent = input.value;
    if (key === 'master' || key === 'effects') sfx.setVolumes(knobs.master, knobs.effects);
  });
  return el('label', { className: 'knob' }, label, input, out);
}

function group(title: string, ...children: Node[]): HTMLElement {
  return el('section', { className: 'group' }, el('h2', { textContent: title }), ...children);
}

const buttons = (...children: Node[]): HTMLElement => el('div', { className: 'buttons' }, ...children);
const shotOpts = (): { pan: number; gain: number; muffled: boolean } => ({ pan: knobs.pan, gain: knobs.gain, muffled: flags.muffled });

byId('controls').append(
  group(
    'The locomotive (continuous)',
    buttons(toggle('Engine on', 'engine'), toggle('Tunnel', 'tunnel'), toggle('Listener: cab', 'cab'), toggle('Drive demo', 'drive'), hold('Whistle (hold)', 'whistle')),
    knob('Speed m/s', 'speed', 0, 30, 0.5),
    knob('Throttle', 'throttle', 0, 1, 0.05),
    knob('Brakes', 'brakes', 0, 1, 0.01),
    buttons(toggle('Safety valve', 'valve'), toggle('Water column', 'water'), button('Bell', () => sfx.bell()), button('Lever', () => sfx.lever()), button('Switch', () => sfx.switchThrow()), button('Telegraph', () => sfx.telegraph())),
  ),
  group(
    'Gunfire',
    buttons(
      button('Revolver', () => sfx.shot('revolver', shotOpts())),
      button('Shotgun', () => sfx.shot('shotgun', shotOpts())),
      button('Rifle', () => sfx.shot('rifle', shotOpts())),
      button('Bandit', () => sfx.shot('bandit', shotOpts())),
      toggle('Muffled (cab)', 'muffled'),
      button('Ricochet', () => sfx.ricochet(knobs.pan)),
      button('Whiz', () => sfx.whiz(knobs.pan)),
    ),
    knob('Pan', 'pan', -1, 1, 0.05),
    knob('Gain (distance)', 'gain', 0, 1, 0.05),
    buttons(button('Reload revolver', () => sfx.reload('revolver')), button('Reload shotgun', () => sfx.reload('shotgun')), button('Reload rifle', () => sfx.reload('rifle')), button('Dry fire', () => sfx.dryFire())),
  ),
  group(
    'The Rider',
    buttons(
      button('Hurt', () => sfx.hurt()),
      button('Hit marker', () => sfx.hitMarker()),
      button('Jump', () => sfx.jump()),
      button('Land', () => sfx.land(false)),
      button('Land hard', () => sfx.land(true)),
      button('Thud', () => sfx.thud()),
    ),
    knob('Wind', 'wind', 0, 1, 0.01),
    knob('Horses', 'horses', 0, 6, 1),
    knob('Horse distance', 'horseGain', 0, 1, 0.05),
    buttons(toggle('Horses ride by', 'rideBy')),
  ),
  group(
    'The line',
    buttons(
      button('Tunnel in', () => sfx.tunnel(true)),
      button('Tunnel out', () => sfx.tunnel(false)),
      button('Explosion', () => sfx.explosion(false)),
      button('Big explosion', () => sfx.explosion(true)),
      button('Crash', () => sfx.crash()),
    ),
  ),
  group(
    'Fords, the lurch, cattle (round 2)',
    buttons(
      toggle('Ford water', 'ford'),
      button('Splash: the loco', () => sfx.splash(true, shotOpts())),
      button('Splash: a body', () => sfx.splash(false, shotOpts())),
      button('Lurch', () => sfx.lurch(flags.cab ? 'cab' : 'rider')),
      button('Whinny', () => sfx.whinny(knobs.pan, knobs.gain)),
      button('Cattle: a questioning low', () => sfx.cattle(false, knobs.pan, knobs.gain)),
      button('Cattle: bellow and bolt', () => sfx.cattle(true, knobs.pan, knobs.gain)),
      button('Grunt (thrown)', () => sfx.grunt()),
      button('Flare (burned)', () => sfx.flare()),
    ),
    knob('Ford level', 'ford', 0, 1, 0.05),
  ),
  group(
    'Screens',
    buttons(
      button('Chime', () => sfx.chime()),
      button('Cash', () => sfx.cash()),
      button('Alarm', () => sfx.alarm()),
      button('Win', () => sfx.win()),
      button('Lose', () => sfx.lose()),
      button('UI click', () => sfx.uiClick()),
    ),
  ),
  group(
    'Mix',
    buttons(
      button('Stop all', () => {
        sfx.stopAll();
        for (const key of Object.keys(flags) as (keyof typeof flags)[]) flags[key] = false;
        knobs.wind = 0;
        knobs.brakes = 0;
        knobs.horses = 0;
        document.querySelectorAll('button[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      }),
    ),
    knob('Master', 'master', 0, 1, 0.05),
    knob('Effects', 'effects', 0, 1, 0.05),
  ),
);

// The frame loop: every continuous layer, every frame, the way the game drives them.
const started = performance.now();
function tick(): void {
  const t = (performance.now() - started) / 1000;
  const listener: Listener = flags.cab ? 'cab' : 'rider';
  let speed = knobs.speed;
  let throttle = knobs.throttle;
  let brakes = knobs.brakes;
  if (flags.drive) {
    // A 40 s loop: pull away from a stand, run up to speed, coast, brake to a stand, wait.
    const s = t % 40;
    speed = s < 20 ? 1.3 * s : s < 26 ? 26 - 0.3 * (s - 20) : s < 32 ? Math.max(0, 24.2 - 4 * (s - 26)) : 0;
    throttle = s < 20 ? 1 : 0;
    brakes = s >= 26 && s < 32 ? 0.7 : 0;
  }
  sfx.engine(flags.engine || flags.drive ? { speed, throttle, tunnel: flags.tunnel, listener } : null);
  sfx.wind(knobs.wind);
  sfx.brakes(brakes);
  sfx.safetyValve(flags.valve);
  sfx.water(flags.water);
  sfx.fordWater(flags.ford ? knobs.ford : 0, { pan: knobs.pan, listener });
  sfx.whistle(flags.whistle, listener);
  const n = flags.rideBy ? 3 : knobs.horses;
  sfx.gallop(
    Array.from({ length: n }, (_, k) => {
      if (!flags.rideBy) return { pan: n === 1 ? 0 : -0.8 + (1.6 * k) / (n - 1), gain: knobs.horseGain };
      // Riding up from behind on the left, alongside, then falling back on the right.
      const phase = ((t / 12 + k / 3) % 1) * 2 * Math.PI;
      return { pan: -Math.cos(phase), gain: 0.25 + 0.75 * Math.sin(phase / 2) ** 2 };
    }),
  );
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const status = byId('status');
const showStatus = (): void => {
  status.replaceChildren('Audio: ', el('b', { textContent: sfx.ready ? 'running' : 'locked (click anything)' }));
};
showStatus();
setInterval(showStatus, 300);

const renderButton = byId<HTMLButtonElement>('render');
renderButton.addEventListener('click', () => {
  renderButton.disabled = true;
  byId('summary').textContent = 'Rendering…';
  renderAll()
    .then(showReport)
    .catch((err: unknown) => {
      byId('summary').textContent = `Render failed: ${String(err)}`;
    })
    .finally(() => {
      renderButton.disabled = false;
    });
});

const spectraButton = byId<HTMLButtonElement>('draw-spectra');
spectraButton.addEventListener('click', () => {
  spectraButton.disabled = true;
  spectrograms(byId<HTMLInputElement>('spectra-filter').value)
    .catch((err: unknown) => {
      byId('spectra').textContent = `Failed: ${String(err)}`;
    })
    .finally(() => {
      spectraButton.disabled = false;
    });
});

function showReport(report: RenderReport): void {
  const passed = report.checks.filter((c) => c.pass).length;
  byId('summary').textContent = `${passed}/${report.checks.length} checks pass · busy fight ${report.cpu.realtimeFactor}× realtime`;
  byId('checks').replaceChildren(...report.checks.map((c) => el('li', { className: c.pass ? 'pass' : 'fail' }, `${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`)));
  const head = ['sound', 'rendered s', 'active s', 'peak dBFS', 'worst peak', 'RMS dBFS', 'loudest dBFS', 'LUFS (max)', 'L/R dB', 'brightness Hz', 'NaN'];
  byId('stats').replaceChildren(
    el('thead', {}, el('tr', {}, ...head.map((h) => el('th', { textContent: h })))),
    el(
      'tbody',
      {},
      ...report.stats.map((s) =>
        el(
          'tr',
          {},
          ...[s.name, s.renderedSec, s.activeSec, s.peakDb, s.worstPeakDb ?? '', s.rmsDb, s.loudestRmsDb, s.loudnessLufs, s.balanceDb, s.brightnessHz, s.nan ? 'yes' : 'no'].map((v) =>
            el('td', { textContent: String(v) }),
          ),
        ),
      ),
    ),
  );
}
