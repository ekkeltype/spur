// Synthesized sound (spec §18.3). No asset files and no libraries: every sound is wired from WebAudio
// nodes when it plays. The only precomputed data are a few buffers made once per context (white, brown and
// "grit" noise, and a Karplus–Strong pluck for the stingers' guitar) that every voice shares. The engine,
// its safety net and the noise helpers are Clew's (C:\claude\clew\src\audio\sfx.ts), adapted.
//
// The module never reads the simulation: the apps map sim events and train state to these calls. Audio is
// free to use Math.random, since nothing here feeds back into the deterministic sim.
//
// Signal chain:
//
//   one-shots, whistle, brakes, valve, water, ford, horses ─► effects bus (effects volume) ─┐
//   the locomotive, the wind ─────────────────────────► world bus ─────────────────────┴─► environment ─┐
//   UI sounds and stingers ───────────────────────────► dry effects bus (effects volume) ───────────────┤
//                                                                                                        │
//   environment ─┬─► dry ──────────────────────────────────────────┐                                     │
//                └─► tunnel send (0 in the open) ─► wall echoes ───┴─► compressor ◄──────────────────────┘
//                                                                     └─► safety clip ─► master (master volume) ─► out
//
// The world bus carries the train's own noise. It's information as much as ambience (the Rider has no
// speedometer and feels the speed through it), so only the master slider scales it, and the effects slider
// balances the action against it. The compressor glues overlapping sounds and tames peaks. The safety clip
// after it is transparent below −2 dBFS and never lets a sample reach full scale; no single sound is loud
// enough to touch it.
//
// Continuous layers (engine, wind, brakes, valve, water, the ford's river, horses, whistle) are driven every
// frame with the current values. Every parameter glides toward its target (setTargetAtTime), so a jump in
// speed or a lever slammed over can't click. Things with a rhythm (exhaust beats, rod knocks, rail clicks,
// hoofbeats, bubbles) are queued a little ahead of the audio clock, by the calls themselves and by a timer.
//
// Round 2 (spec §18.3): the river rushing round the train in a ford (panned to where the train is wet, or
// muffled under the footplate in the cab), splashes, the lurch's clank of slack running in with the brakes
// biting, a horse whinnying as it shies, cattle lowing and bellowing, and the Rider's grunt when thrown.

import { EMERGENCY_BRAKE, WEAPONS } from '../sim/rules';
import type { Weapon } from '../sim/types';

/** Who is listening: the Rider outside on the train, or the Engineer in the cab. */
export type Listener = 'rider' | 'cab';

/** Uniform random numbers in [0, 1). Tests inject a seeded one. */
export type Rand = () => number;

/** One partial of a struck object: frequency ratio, amplitude, decay to −60 dB (s), optional attack (s). */
type Mode = readonly [ratio: number, amp: number, decay: number, attack?: number];

// ---- Tuning -----------------------------------------------------------------------------------------

/** Seconds between a call and its first sample, so no envelope starts in the past. */
const START_DELAY = 0.01;
/**
 * Some browsers create a context suspended even inside a gesture and start it a moment later. One-shots
 * fired in that moment are queued (they play as soon as it runs) rather than dropped.
 */
const START_GRACE_MS = 250;
/** Time constant (s) of volume changes. */
const VOLUME_TC = 0.04;
/** Glide time constant (s) of continuous-layer parameters: quick enough to follow a lever, too slow to click. */
const GLIDE_TC = 0.08;
/** Rhythmic layers are queued this far (s) ahead of the audio clock… */
const LOOKAHEAD = 0.25;
/** …or this far while the page is hidden, where timers wake only about once a second… */
const LOOKAHEAD_HIDDEN = 1.6;
/** …by the per-frame calls and by a timer that wakes this often (realtime contexts only; offline ones are pumped by calls). */
const PUMP_MS = 50;
/** A layer held silent this long (s) is torn down, so silence costs no CPU. */
const IDLE_RELEASE = 2;
/** The engine's fade when it's switched off (null). */
const ENGINE_FADE = 0.6;
/** Panning width: ±1 becomes ±0.9, leaving a trace of every sound in the far ear. */
const PAN_WIDTH = 0.9;
/** Shots (with their tails) sounding at once. A volley beyond this adds nothing but load. */
const MAX_SHOT_VOICES = 10;
/** Shots of one kind closer together than this (s) are one sound: many in one frame, or a shotgun's pellets. */
const SHOT_GAP = 0.045;
/** Horses that get their own hoofbeats. */
const MAX_HORSES = 8;
/** The tunnel's echo send, and how fast (time constant, s) it follows the portal. */
const TUNNEL_SEND = 0.55;
const TUNNEL_TC = 0.12;
/** The Engineer hears gunfire through the cab's walls, which pass little above this. */
const MUFFLED_HZ = 900;
/** A released whistle is kept this long (s) so a quick toot re-attacks it rather than building a new one. */
const WHISTLE_HOLD = 1;
/** The whistle speaks this far flat and slurs up to pitch as the valve opens. */
const WHISTLE_BEND = 0.93;
/** Base pitch (Hz) of the shared Karplus–Strong pluck; other notes replay it faster or slower. */
const PLUCK_HZ = 196;
/** The ford's river heard in the open, and under the footplate in the cab (the cab passes little above this). */
const FORD_OPEN_HZ = 16000;
const FORD_CAB_HZ = 650;
/** A splash heard from the cab, through its floor and walls. */
const SPLASH_MUFFLED_HZ = 700;

/** Output level of each sound, balanced against the others by offline measurement (see /sfx.html). */
const LEVEL = {
  engine: 0.2,
  wind: 0.05,
  brakes: 0.065,
  valve: 0.033,
  water: 0.048,
  gallop: 1.2,
  whistle: 0.4,
  muffled: 0.85,
  ricochet: 0.28,
  whiz: 0.25,
  hurt: 0.35,
  hitMarker: 0.38,
  reload: 0.15,
  dryFire: 0.2,
  jump: 0.2,
  land: 0.3,
  thud: 0.28,
  explosion: 0.5,
  explosionBig: 0.52,
  crash: 0.32,
  tunnel: 0.3,
  telegraph: 0.28,
  switchThrow: 0.23,
  lever: 0.2,
  bell: 0.085,
  chime: 0.075,
  cash: 0.135,
  alarm: 0.11,
  win: 0.4,
  lose: 0.42,
  click: 0.22,
  ford: 0.07,
  /** The ford under the cab's footplate: its low-pass takes most of the rush, so it's driven harder. */
  fordCab: 0.16,
  splash: 0.36,
  splashBig: 0.24,
  lurch: 0.19,
  whinny: 0.14,
  cattle: 0.14,
  grunt: 0.26,
  flare: 0.3,
} as const;

/** Inner balance of the locomotive's parts (before LEVEL.engine), measured like LEVEL. */
const ENGINE = {
  /** The exhaust beats: their swept band, their thump and their steam edge. */
  mid: 1,
  body: 1,
  sizzle: 0.3,
  roar: 0.3,
  /** How the Rider hears the exhaust against the Engineer (who's nearer the stack). */
  exhaustRider: 0.8,
  exhaustCab: 1,
  cocks: 0.25,
  rods: 0.3,
  rails: 1,
  rumble: 0.8,
  rolling: 0.25,
  fire: 0.4,
  injector: 0.2,
} as const;

/** Inner balance of the wind's parts. */
const WIND = { buffet: 1, rush: 0.5, hiss: 0.15, howl: 0.15 } as const;

/** Inner balance of the brakes' parts. */
const BRAKE = { grind: 0.4, squeal: 0.5, screech: 0.4, sparks: 0.4 } as const;

/** Relative strength of the four beats of a revolution: no two cylinders are set up exactly alike. */
const CHUFF_ACCENTS = [1, 0.74, 0.9, 0.68] as const;
/** Each cylinder's exhaust has its own colour: a multiplier on the beat's band. */
const CHUFF_COLOURS = [1, 0.9, 1.08, 0.95] as const;
/** The nearer truck's axles, then the farther one's. */
const RAIL_ACCENTS = [1, 0.86, 0.72, 0.62] as const;
/** A lope's three beats: hind foot, diagonal pair, leading fore (the strongest). */
const HOOF_ACCENTS = [0.72, 0.84, 1] as const;

/** A locomotive bell: heavy cast bronze, hum and prime beating slowly, a strong minor-third tierce. */
const LOCO_BELL_MODES: readonly Mode[] = [
  [0.5, 0.3, 3.4],
  [1, 1, 3.0],
  [1.0028, 0.5, 2.8],
  [1.19, 0.55, 2.3],
  [1.5, 0.3, 1.9],
  [2, 0.55, 1.6],
  [2.51, 0.3, 1.1],
  [3.03, 0.2, 0.8],
  [4.2, 0.13, 0.5],
  [5.4, 0.08, 0.35],
];

/** An iron bar or link (free-bar mode ratios), short and bright. */
const CLANK_MODES: readonly Mode[] = [
  [1, 1, 0.3],
  [2.756, 0.7, 0.2],
  [5.404, 0.45, 0.12],
  [8.933, 0.25, 0.07],
];

/** Side rods knocking in their bearings: a dull, short version of the bar. */
const ROD_MODES: readonly Mode[] = [
  [1, 1, 0.09],
  [2.756, 0.45, 0.05],
  [5.404, 0.2, 0.03],
];

/** A heavy iron frame struck: dense, clangorous modes. */
const GRILLE_MODES: readonly Mode[] = [
  [1, 0.6, 1.2],
  [1.73, 0.8, 1.0],
  [2.41, 0.7, 0.85],
  [3.37, 0.5, 0.7],
  [4.12, 0.42, 0.55],
  [5.66, 0.3, 0.45],
  [7.31, 0.2, 0.35],
  [9.2, 0.14, 0.25],
];

/** Small hard metal parts (gun actions, the sounder's armature, lead on iron): brief and bright. */
const TICK_MODES: readonly Mode[] = [
  [1, 1, 0.035],
  [2.31, 0.5, 0.022],
  [3.73, 0.3, 0.014],
];

/** A coin landing on coins. */
const COIN_MODES: readonly Mode[] = [
  [1, 1, 0.3],
  [1.47, 0.6, 0.22],
  [2.21, 0.45, 0.15],
  [2.98, 0.25, 0.1],
];

/** A small alarm gong: bright and clangy, dying fast so three strikes stay distinct. */
const ALARM_MODES: readonly Mode[] = [
  [1, 1, 0.8],
  [1.18, 0.45, 0.6],
  [2, 0.4, 0.45],
  [2.66, 0.3, 0.3],
  [3.94, 0.18, 0.2],
];

/** A soft chime: nearly harmonic, with a glassy upper partial. */
const CHIME_MODES: readonly Mode[] = [
  [1, 1, 1.4, 0.004],
  [2, 0.35, 0.9, 0.004],
  [3.01, 0.15, 0.6, 0.004],
  [5.43, 0.06, 0.35, 0.004],
];

/** The steam whistle: five chimes on C♯ minor 7th (an E major 6th), the chord of the long North American whistles. */
const WHISTLE_CHORD: readonly (readonly [hz: number, amp: number])[] = [
  [277.18, 1],
  [329.63, 0.85],
  [415.3, 0.8],
  [493.88, 0.65],
  [554.37, 0.5],
];

/** Brake squeal: narrow bands of the wheel's ring [Hz, Q, level], and pure partials above them [Hz, level]. */
const SQUEAL_BANDS: readonly (readonly [number, number, number])[] = [
  [2380, 40, 0.8],
  [3170, 45, 0.6],
  [4410, 50, 0.35],
];
const SQUEAL_PARTIALS: readonly (readonly [number, number])[] = [
  [2380, 0.05],
  [3170, 0.035],
  [4760, 0.02],
];
/** The emergency screech: higher and harsher. */
const SCREECH_PARTIALS: readonly (readonly [number, number])[] = [
  [3950, 0.5],
  [5230, 0.4],
  [6940, 0.25],
];

/** Guitar voicings for the stingers (Hz, low string first). */
const E_MAJOR = [82.41, 123.47, 164.81, 207.65, 246.94, 329.63] as const;
const A_MAJOR = [110, 164.81, 220, 277.18, 329.63] as const;
const E_MAJOR_HIGH = [164.81, 246.94, 329.63, 415.3, 493.88, 659.26] as const;
const A_MINOR_WALK = [220, 164.81, 130.81, 110] as const;

/** The sounder speaks a little Morse: a few railroad wire words. */
const MORSE: Readonly<Record<string, string>> = {
  D: '-..',
  G: '--.',
  K: '-.-',
  N: '-.',
  O: '---',
  R: '.-.',
  S: '...',
  T: '-',
  W: '.--',
};
const WIRE_WORDS = ['OK', 'GN', 'SR', 'TO', 'WK', 'DN'] as const;

// ---- Pure helpers (exported for tests) ---------------------------------------------------------------

/** Clamps `x` to [lo, hi]. Anything that isn't a finite number (NaN, ±Infinity, undefined) gives `fallback`. */
export function clamp(x: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return fallback;
  return x < lo ? lo : x > hi ? hi : x;
}

/** A settings slider position (0..1) as a linear gain. Squared, so the slider feels even to the ear. */
export function volumeToGain(v: number): number {
  const c = clamp(v, 0, 1, 0);
  return c * c;
}

/** 0 below `e0`, 1 above `e1`, and an S-curve between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const u = clamp((x - e0) / (e1 - e0), 0, 1, 0);
  return u * u * (3 - 2 * u);
}

/** Uniform white noise in [−1, 1). */
export function whiteNoise(length: number, rand: Rand = Math.random): Float32Array<ArrayBuffer> {
  const n = Math.max(0, Math.floor(length) || 0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
  return out;
}

/**
 * Brown noise: leaky-integrated white noise (−6 dB/octave above ~150 Hz). Its drift is removed so the
 * last sample runs straight into the first (the buffer loops without a click), then DC is removed and
 * the peak normalised to 1.
 */
export function brownNoise(length: number, rand: Rand = Math.random): Float32Array<ArrayBuffer> {
  const n = Math.max(0, Math.floor(length) || 0);
  const out = new Float32Array(n);
  if (n === 0) return out;
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = (b + 0.02 * (rand() * 2 - 1)) / 1.02;
    out[i] = b;
  }
  // `b` stepped once more is where sample n would be; tilt the buffer so sample n lands on sample 0.
  const next = (b + 0.02 * (rand() * 2 - 1)) / 1.02;
  const drift = next - out[0];
  for (let i = 0; i < n; i++) out[i] -= (drift * i) / n;
  removeDcAndNormalise(out);
  return out;
}

/** Sparse random clicks, mostly faint and a few sharp: grit, cinders, sparks, crackling coal. */
export function gritNoise(
  length: number,
  clicksPerSecond: number,
  sampleRate: number,
  rand: Rand = Math.random,
): Float32Array<ArrayBuffer> {
  const n = Math.max(0, Math.floor(length) || 0);
  const out = new Float32Array(n);
  const p = clamp(clicksPerSecond / sampleRate, 0, 1, 0);
  for (let i = 0; i < n; i++) {
    if (rand() >= p) continue;
    const a = (rand() < 0.5 ? -1 : 1) * (0.15 + 0.85 * rand() ** 3);
    out[i] += a;
    if (i + 1 < n) out[i + 1] -= a * 0.5; // a doublet rather than a step: no DC, a crisper tick
  }
  removeDcAndNormalise(out);
  return out;
}

/**
 * A plucked string by Karplus–Strong: a burst of noise one period long circulates in a delay line,
 * through a two-tap filter that loses a little energy each trip (more of it at high frequencies).
 * `blend` 0.5 is the classic mellow averaging filter; lower is brighter. `decay` (< 1) is the loss per trip.
 * The tail is faded out and the result normalised to a peak of 1.
 */
export function karplusStrong(
  sampleRate: number,
  freqHz: number,
  seconds: number,
  opts: { decay?: number; blend?: number; rand?: Rand } = {},
): Float32Array<ArrayBuffer> {
  const sr = clamp(sampleRate, 1000, 384_000, 48_000);
  const n = Math.floor(clamp(seconds, 0, 10, 0) * sr);
  const out = new Float32Array(n);
  if (n === 0) return out;
  const f = clamp(freqHz, 20, sr / 4, 440);
  const period = Math.max(2, Math.round(sr / f - 0.5)); // the two-tap filter adds half a sample of delay
  const decay = clamp(opts.decay, 0, 0.99999, 0.996);
  const blend = clamp(opts.blend, 0, 1, 0.5);
  const line = whiteNoise(period, opts.rand);
  let mean = 0;
  for (let i = 0; i < period; i++) mean += line[i];
  mean /= period;
  for (let i = 0; i < period; i++) line[i] -= mean; // no DC in the burst, so the string doesn't thump
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const nextIdx = idx + 1 === period ? 0 : idx + 1;
    const y = line[idx];
    out[i] = y;
    line[idx] = decay * ((1 - blend) * y + blend * line[nextIdx]);
    idx = nextIdx;
  }
  removeDc(out);
  const fade = Math.min(n, Math.round(sr * 0.01));
  for (let i = 0; i < fade; i++) out[n - 1 - i] *= i / fade;
  normalise(out);
  return out;
}

/**
 * Transfer curve of the master safety clip. The WaveShaper is fed the signal halved, so the curve spans
 * signal levels ±2: transparent (exactly linear) below `knee`, then bending smoothly toward `ceiling`,
 * which no output sample can exceed.
 */
export function softClipCurve(points = 4097, knee = 0.8, ceiling = 0.98): Float32Array<ArrayBuffer> {
  const n = Math.max(3, Math.floor(points));
  const c = new Float32Array(n);
  const room = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/** Symmetric tanh saturation over ±1, normalised so ±1 maps to ±1. */
export function tanhCurve(drive: number, points = 1025): Float32Array<ArrayBuffer> {
  const d = clamp(drive, 0.01, 50, 1);
  const n = Math.max(3, Math.floor(points));
  const c = new Float32Array(n);
  const k = 1 / Math.tanh(d);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(d * ((i / (n - 1)) * 2 - 1)) * k;
  return c;
}

function removeDc(x: Float32Array): void {
  if (x.length === 0) return;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  for (let i = 0; i < x.length; i++) x[i] -= mean;
}

/** Scales to a peak of 1 (silence stays silent). */
function normalise(x: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 0) for (let i = 0; i < x.length; i++) x[i] /= peak;
}

function removeDcAndNormalise(x: Float32Array): void {
  removeDc(x);
  normalise(x);
}

// Curves are copied into each WaveShaperNode, so one array serves every voice.
const CURVE_SAFETY = softClipCurve();
const CURVE_GROWL = tanhCurve(3);
const CURVE_WARM = tanhCurve(1.5);

// ---- The locomotive's rhythms ---------------------------------------------------------------------

/** Circumference (m) of the driving wheels, about 1.6 m across. */
export const DRIVER_CIRCUMFERENCE = 5;
/** Exhaust beats per turn of the drivers: two double-acting cylinders. */
export const CHUFFS_PER_REV = 4;
/** Rail length (m): 39 ft rails, so a joint, and a click from every axle that crosses it, every 12 m. */
export const RAIL_LENGTH = 12;

/** Events repeating along the track (or through time): one at each offset in every period. */
export interface TrackPattern {
  period: number;
  /** Ascending, each in [0, period). */
  offsets: readonly number[];
}

/** An event of a pattern: when, and which offset it came from. */
export interface PatternEvent {
  t: number;
  i: number;
}

/** The exhaust: four evenly spaced beats per turn of the drivers. */
export const CHUFF_PATTERN: TrackPattern = {
  period: DRIVER_CIRCUMFERENCE,
  offsets: [0, 1, 2, 3].map((k) => (k * DRIVER_CIRCUMFERENCE) / CHUFFS_PER_REV),
};

/** Rod knocks: twice a turn, just after a beat, as the bearings take up their slack past dead centre. */
export const ROD_PATTERN: TrackPattern = { period: DRIVER_CIRCUMFERENCE, offsets: [0.3, 2.8] };

/**
 * Rail clicks under the listener, per rail length: the two axles of one car's truck (1.7 m apart), then,
 * across the coupling, the two of the next car's truck. The classic "clickety-clack".
 */
export const RAIL_PATTERN: TrackPattern = { period: RAIL_LENGTH, offsets: [0, 1.7, 5.6, 7.3] };

/** A horse's stride (s) at a lope beside a running train. */
export const GALLOP_STRIDE = 0.45;

/** Exhaust beats per second at `speed` m/s, either way. */
export function chuffRate(speed: number): number {
  return (CHUFFS_PER_REV * Math.abs(clamp(speed, -1000, 1000, 0))) / DRIVER_CIRCUMFERENCE;
}

/** Rail clicks per second at `speed` m/s: four axles cross each joint. */
export function railClickRate(speed: number): number {
  return (RAIL_PATTERN.offsets.length * Math.abs(clamp(speed, -1000, 1000, 0))) / RAIL_LENGTH;
}

/**
 * The events of a repeating pattern passed while moving at `rate` units per second from position `pos`
 * at time `t0` until `t1`, in order: one at every `period·k + offsets[i]`. The span covered is half-open,
 * (pos, pos + rate·(t1 − t0)], so consecutive windows neither repeat nor drop an event. At most `max`.
 */
export function patternEvents(p: TrackPattern, pos: number, rate: number, t0: number, t1: number, max = 512): PatternEvent[] {
  const out: PatternEvent[] = [];
  const ok = [pos, rate, t0, t1, p.period].every((v) => Number.isFinite(v));
  if (!ok || !(rate > 0) || !(t1 > t0) || !(p.period > 0)) return out;
  const end = pos + rate * (t1 - t0);
  for (let k = Math.floor(pos / p.period); out.length < max; k++) {
    const base = k * p.period;
    if (base > end) break;
    for (let i = 0; i < p.offsets.length && out.length < max; i++) {
      const d = base + p.offsets[i];
      if (d > pos && d <= end) out.push({ t: t0 + (d - pos) / rate, i });
    }
  }
  return out;
}

/** A lope in time: three hoofbeats per stride of `stride` s, then the moment of suspension. */
export function gallopPattern(stride: number): TrackPattern {
  const s = clamp(stride, 0.2, 1.5, GALLOP_STRIDE);
  return { period: s, offsets: [0, 0.22 * s, 0.43 * s] };
}

// ---- Mixes: what each layer sounds like for its inputs ------------------------------------------------

/** What engine() is told each frame. */
export interface EngineInput {
  /** m/s; the sign (direction) doesn't matter. */
  speed: number;
  /** 0..1. */
  throttle: number;
  tunnel: boolean;
  listener: Listener;
}

/** The locomotive's parts for one frame's input: levels (linear, before the inner balance) and filter settings. */
export interface EngineMix {
  /** Exhaust beats per second. */
  rate: number;
  /** Level of each exhaust beat, and its decay to −60 dB (s). */
  chuff: number;
  chuffDecay: number;
  /** Centre (Hz) of each beat's band: brighter when working hard. */
  chuffHz: number;
  /** The low thump inside each beat. */
  body: number;
  /** The steam's high edge. */
  sizzle: number;
  /** The continuous roar the beats fuse into at speed, and its band (Hz). */
  roar: number;
  roarHz: number;
  /** How loud the exhaust reaches this listener, and a low-pass on it (Hz). */
  exhaust: number;
  exhaustHz: number;
  /** Cylinder-cock steam at a start. */
  cocks: number;
  /** Side rods knocking (loudest coasting). */
  rods: number;
  /** Rail clicks, and a low-pass on them (Hz). */
  rails: number;
  railHz: number;
  /** The whole train's low rumble, and its cutoff (Hz). */
  rumble: number;
  rumbleHz: number;
  /** Steel wheels rolling on steel rails. */
  rolling: number;
  /** The fire's roar. */
  firebox: number;
  /** The injector's hiss (the cab only). */
  injector: number;
  /** Depth of a slow random dip in the exhaust as the wind tears at it (the Rider only). */
  flutter: number;
  /** A low-pass over everything (Hz): darker in a tunnel. */
  toneHz: number;
  /** Overall gain: louder in a tunnel. */
  gain: number;
}

/** The locomotive's mix for one frame's input. Nonsense reads as a quiet engine at a stand. */
export function engineMix(p: EngineInput): EngineMix {
  const v = Math.abs(clamp(p?.speed, -1000, 1000, 0));
  const th = clamp(p?.throttle, 0, 1, 0);
  const cab = p?.listener === 'cab';
  const tunnel = p?.tunnel === true;
  const rate = chuffRate(v);
  const moving = smoothstep(0.05, 1.5, v);
  const pace = Math.min(1, v / 25);
  // Beats a second or two apart stay separate; past about fifteen a second the ear fuses them into a roar.
  const fused = smoothstep(7, 20, rate);
  return {
    rate,
    chuff: moving * (0.14 + 0.86 * th) * (0.75 + 0.25 * Math.min(1, v / 12)) * (1 - 0.5 * fused),
    chuffDecay: clamp(0.85 / Math.max(rate, 0.1), 0.07, 0.32, 0.32),
    chuffHz: (430 + 850 * th) * (1 + 0.3 * pace),
    body: 0.5 + 0.5 * th,
    sizzle: th * (0.4 + 0.6 * pace),
    roar: fused * (0.15 + 0.85 * th),
    roarHz: (380 + 700 * th) * (1 + 0.2 * pace),
    exhaust: cab ? ENGINE.exhaustCab : ENGINE.exhaustRider,
    exhaustHz: cab ? 3000 : 12000,
    cocks: th * (1 - smoothstep(1.5, 4.5, v)),
    rods: moving * (1 - 0.8 * th) * (1 - 0.6 * smoothstep(12, 26, v)),
    rails: smoothstep(0.3, 5, v) * (0.5 + 0.5 * pace) * (cab ? 0.45 : 1),
    railHz: cab ? 1800 : 12000,
    rumble: moving * (0.15 + 0.85 * pace ** 1.3),
    rumbleHz: 60 + 120 * pace,
    rolling: pace ** 2 * (cab ? 0.45 : 1),
    firebox: cab ? 0.5 + 0.5 * th : 0.25,
    injector: cab ? 1 : 0,
    flutter: cab ? 0 : 0.45 * Math.min(1, v / 20),
    toneHz: tunnel ? 2500 : 18000,
    gain: tunnel ? 2 : 1,
  };
}

/** Brake shoes: a grind as soon as they touch, a squeal as they bite, a screech past the emergency notch. */
export function brakeMix(level: number): { grind: number; squeal: number; screech: number } {
  const l = clamp(level, 0, 1, 0);
  return {
    grind: l > 0 ? 0.25 + 0.75 * l : 0,
    squeal: smoothstep(0.08, 0.55, l) * (0.55 + 0.45 * l),
    screech: smoothstep(EMERGENCY_BRAKE + 0.005, EMERGENCY_BRAKE + 0.06, l),
  };
}

/** Wind over the roof: low buffeting, a rush that rises in pitch, a hiss of torn air, and a howl only when strong. */
export function windMix(level: number): { buffet: number; rush: number; hiss: number; howl: number; rushHz: number; hissHz: number } {
  const l = clamp(level, 0, 1, 0);
  return { buffet: l ** 0.7, rush: l ** 0.7, hiss: l ** 1.5, howl: smoothstep(0.45, 1, l), rushHz: 350 + 650 * l, hissHz: 1800 + 2400 * l };
}

/**
 * The river in a ford, 0..1 (0 silences it): the whole layer's gain, and its parts' balance. A slow river
 * round a standing train is mostly its rush and low wash; ploughed through at speed it throws spray and
 * patters with drops.
 */
export function fordMix(level: number): { gain: number; rush: number; wash: number; spray: number; drops: number; bubbles: number } {
  const l = clamp(level, 0, 1, 0);
  return { gain: l > 0 ? l ** 0.6 : 0, rush: 0.6 + 0.4 * l, wash: 0.8, spray: smoothstep(0.3, 1, l), drops: 0.3 + 0.7 * l, bubbles: 8 + 30 * l };
}

/**
 * Where a shot is heard: stereo pan (−1 left .. 1 right, narrowed slightly), amplitude, and the cutoff of a
 * low-pass that dulls distant ones. Muffled shots (the Engineer, through the cab's walls) are centred and
 * dark. Missing or non-finite inputs mean centred and full.
 */
export function shotPlacement(pan: unknown, gain: unknown, muffled = false): { pan: number; gain: number; cutoffHz: number } {
  const g = clamp(gain, 0, 1, 1);
  if (muffled) return { pan: 0, gain: g, cutoffHz: MUFFLED_HZ };
  return { pan: clamp(pan, -1, 1, 0) * PAN_WIDTH, gain: g, cutoffHz: 1500 + 16500 * g * g };
}

/** Sanitises engine()'s argument; anything that isn't an object switches the engine off. */
function engineInput(p: unknown): EngineInput | null {
  if (p === null || typeof p !== 'object') return null;
  const q = p as Partial<Record<keyof EngineInput, unknown>>;
  return {
    speed: clamp(q.speed, -1000, 1000, 0),
    throttle: clamp(q.throttle, 0, 1, 0),
    tunnel: q.tunnel === true,
    listener: listenerOf(q.listener),
  };
}

/** A listener, defaulting to the Rider (the host's seat). */
function listenerOf(l: unknown): Listener {
  return l === 'cab' ? 'cab' : 'rider';
}

// ---- Node plumbing ----------------------------------------------------------------------------------

const rnd = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);

function amp(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function biquad(ctx: BaseAudioContext, type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

/** Low-pass; `resDb` is WebAudio's resonance in dB (−3 is Butterworth: no peak). */
const lowpass = (ctx: BaseAudioContext, freq: number, resDb = -3): BiquadFilterNode => biquad(ctx, 'lowpass', freq, resDb);
const highpass = (ctx: BaseAudioContext, freq: number, resDb = -3): BiquadFilterNode => biquad(ctx, 'highpass', freq, resDb);
/** Band-pass with a linear Q (bandwidth ≈ freq / q). */
const bandpass = (ctx: BaseAudioContext, freq: number, q: number): BiquadFilterNode => biquad(ctx, 'bandpass', freq, q);

/** Gain that brings white noise, band-limited to about `bwHz`, back to roughly full-band loudness. */
function bandNorm(ctx: BaseAudioContext, bwHz: number): number {
  return Math.min(16, Math.sqrt(ctx.sampleRate / 2 / Math.max(1, bwHz)));
}

function panner(ctx: BaseAudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  return p;
}

/** A sound source and the audio time it ends, so a loop can stop its queued voices early. */
interface Voice {
  node: AudioScheduledSourceNode;
  end: number;
}

function tone(ctx: BaseAudioContext, type: OscillatorType, freq: number, t: number, end?: number, sink?: Voice[]): OscillatorNode {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.start(t);
  if (end !== undefined) o.stop(end);
  sink?.push({ node: o, end: end ?? Infinity });
  return o;
}

/** A looping noise source starting at a random point of `buf`, so no two sounds share a waveform. */
function noise(ctx: BaseAudioContext, buf: AudioBuffer, t: number, end?: number, sink?: Voice[]): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.start(t, Math.random() * buf.duration * 0.999);
  if (end !== undefined) s.stop(end);
  sink?.push({ node: s, end: end ?? Infinity });
  return s;
}

/** Noise through `filter` into a fresh VCA (gain 0) connected to `dest`. Returns the VCA to envelope. */
function noiseLayer(
  ctx: BaseAudioContext,
  buf: AudioBuffer,
  filter: BiquadFilterNode,
  t: number,
  end: number,
  dest: AudioNode,
  sink?: Voice[],
): GainNode {
  const vca = amp(ctx, 0);
  noise(ctx, buf, t, end, sink).connect(filter).connect(vca).connect(dest);
  return vca;
}

/** Percussive envelope: linear attack to `peak`, exponential decay to −60 dB over `decay` s. Returns the end time. */
function perc(p: AudioParam, t: number, peak: number, attack: number, decay: number): number {
  const pk = Math.max(peak, 1e-5);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, t + attack);
  p.exponentialRampToValueAtTime(pk * 1e-3, t + attack + decay);
  p.linearRampToValueAtTime(0, t + attack + decay + 0.01);
  return t + attack + decay + 0.01;
}

/** Exponential glide of a positive parameter (a frequency or rate) through [time offset, value] points. */
function glide(p: AudioParam, t: number, points: readonly (readonly [number, number])[]): void {
  points.forEach(([dt, v], i) => {
    const value = Math.max(v, 1e-4);
    if (i === 0) p.setValueAtTime(value, t + dt);
    else p.exponentialRampToValueAtTime(value, t + dt);
  });
}

/** An envelope that rises to `peak` over `rise` s, holds until `hold`, then decays exponentially to silence at `end` (all offsets from t). */
function swell(p: AudioParam, t: number, peak: number, rise: number, hold: number, end: number): number {
  const pk = Math.max(peak, 1e-5);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, t + rise);
  p.setValueAtTime(pk, t + Math.max(rise, hold));
  p.exponentialRampToValueAtTime(pk * 1e-3, t + end);
  p.linearRampToValueAtTime(0, t + end + 0.02);
  return t + end + 0.02;
}

/** Struck-object synthesis: one decaying sine per mode, summed into `out`. Returns the end time. */
function modal(ctx: BaseAudioContext, out: AudioNode, t: number, f: number, modes: readonly Mode[], decayScale = 1, sink?: Voice[]): number {
  let end = t;
  for (const [ratio, a, decay, attack = 0.0015] of modes) {
    const hz = f * ratio;
    if (hz >= ctx.sampleRate * 0.45) continue;
    const vca = amp(ctx, 0);
    const e = perc(vca.gain, t, a, attack, decay * decayScale);
    tone(ctx, 'sine', hz, t, e, sink).connect(vca).connect(out);
    end = Math.max(end, e);
  }
  return end;
}

/** A small, hard click of metal: a tick of noise and a few bright modes. */
function tick(ctx: BaseAudioContext, white: AudioBuffer, out: AudioNode, t: number, hz: number, level: number): void {
  const g = amp(ctx, level);
  g.connect(out);
  perc(noiseLayer(ctx, white, highpass(ctx, 3000), t, t + 0.02, g).gain, t, 0.7, 0.0002, 0.005);
  modal(ctx, g, t, hz * rnd(0.97, 1.03), TICK_MODES);
}

/**
 * An AudioParam driven every frame. Each new target starts a glide from wherever the param is, so a jump
 * in the input can't click. Targets within 1% of the last one are skipped, keeping the automation short.
 */
class Knob {
  private target: number;

  constructor(
    private readonly param: AudioParam,
    private readonly tc = GLIDE_TC,
  ) {
    this.target = param.value;
  }

  set(value: number, now: number, tc = this.tc): void {
    if (!Number.isFinite(value) || Math.abs(value - this.target) <= Math.max(1e-5, 0.01 * Math.abs(this.target))) return;
    this.target = value;
    this.param.setTargetAtTime(value, now, tc);
  }
}

// ---- The engine -------------------------------------------------------------------------------------

interface Graph {
  ctx: BaseAudioContext;
  offline: boolean;
  master: GainNode;
  /** One-shots and event layers, echoing in tunnels. */
  fx: GainNode;
  /** UI sounds and stingers: effects volume, never echoing. */
  fxDry: GainNode;
  /** The train's own noise: master volume only. */
  world: GainNode;
  tunnelSend: Knob;
  white: AudioBuffer;
  brown: AudioBuffer;
  grit: AudioBuffer;
  pluck: AudioBuffer;
}

/** A sound that runs until stopped: its sources, and a gain nobody else automates, for a clean fade. */
interface Loop {
  out: GainNode;
  sources: Voice[];
}

type LayerName = 'wind' | 'brakes' | 'valve' | 'water' | 'ford';
const LAYER_NAMES: readonly LayerName[] = ['wind', 'brakes', 'valve', 'water', 'ford'];

/** A level-driven continuous layer (wind, brakes, valve, water, the ford's river). */
interface Layer {
  loop: Loop;
  /** Glides the layer's parameters to a level; 0 silences it. */
  set: (level: number, now: number) => void;
  /** Queues rhythmic events up to `horizon` (audio time). */
  pump?: (horizon: number) => void;
  /** Audio time the level fell to 0, or null while it sounds. */
  idleSince: number | null;
}

interface EngineVoice {
  loop: Loop;
  input: EngineInput;
  mix: EngineMix;
  /** Odometer (m) at `schedT`: the audio time up to which beats, knocks and clicks are queued. */
  odo: number;
  schedT: number;
  /** Where each beat lands: its own falling band-pass feeds `mid`; its raw burst feeds the shared thump and edge. */
  mid: GainNode;
  bodyIn: GainNode;
  sizzleIn: GainNode;
  cockBus: GainNode;
  rodBus: GainNode;
  railBus: GainNode;
  /** Rail thunks skip the rail's ring filters. */
  railDirect: GainNode;
  /** The fire's draw, pulled by each beat. Only the beats automate it. */
  firePulse: GainNode;
  k: Record<EngineKnob, Knob>;
  injectorOn: boolean;
  injectorNext: number;
}

type EngineKnob =
  | 'level'
  | 'tone'
  | 'exhaust'
  | 'exhaustHz'
  | 'body'
  | 'sizzle'
  | 'roar'
  | 'roarHz'
  | 'roarRate'
  | 'cockHold'
  | 'rods'
  | 'rails'
  | 'railHz'
  | 'rumble'
  | 'rumbleHz'
  | 'rolling'
  | 'fire'
  | 'injector'
  | 'flutterBase'
  | 'flutterDepth';

interface HorseSlot {
  /** Release fade only. */
  out: GainNode;
  input: GainNode;
  level: Knob;
  pan: Knob;
  dull: Knob;
  pattern: TrackPattern;
  /** Audio time of a stride's first beat, and the time up to which beats are queued. */
  phase: number;
  schedT: number;
  gain: number;
  sources: Voice[];
}

interface WhistleVoice {
  loop: Loop;
  /** Attack and release: only the whistle's own on/off automates it. */
  env: GainNode;
  /** After the envelope: the valve's spit of steam lands here. */
  post: AudioNode;
  level: Knob;
  lp: Knob;
  notes: { osc: OscillatorNode; hz: number }[];
  on: boolean;
  releasedAt: number;
}

type GunKind = Weapon | 'bandit';

/** A gunshot's recipe. */
interface Gun {
  /** The crack: high-passed noise, very short. */
  crack: number;
  crackHz: number;
  crackDecay: number;
  /** The blast's body: band-passed noise. */
  body: number;
  bodyHz: number;
  bodyQ: number;
  bodyDecay: number;
  /** The boom: a falling sine, and a thump of low noise with it. */
  boom: number;
  boomFrom: number;
  boomTo: number;
  boomDecay: number;
  thump: number;
  /** The land answering: a rolling tail, and echoes off canyon walls [delay s, level, decay s]. */
  tail: number;
  tailHz: number;
  tailDecay: number;
  echoes: readonly (readonly [number, number, number])[];
  level: number;
}

const GUNS: Readonly<Record<GunKind, Gun>> = {
  // A .45 revolver: a hard crack with a solid body, and a short answer from the land.
  revolver: {
    crack: 0.8,
    crackHz: 1800,
    crackDecay: 0.014,
    body: 0.8,
    bodyHz: 850,
    bodyQ: 0.9,
    bodyDecay: 0.1,
    boom: 0.9,
    boomFrom: 150,
    boomTo: 50,
    boomDecay: 0.18,
    thump: 0.5,
    tail: 0.28,
    tailHz: 2400,
    tailDecay: 0.8,
    echoes: [[0.29, 0.14, 0.3]],
    level: 0.5,
  },
  // A coach gun: a big, round boom and a long roll.
  shotgun: {
    crack: 0.45,
    crackHz: 1200,
    crackDecay: 0.02,
    body: 1,
    bodyHz: 520,
    bodyQ: 0.7,
    bodyDecay: 0.15,
    boom: 1.1,
    boomFrom: 110,
    boomTo: 38,
    boomDecay: 0.3,
    thump: 0.8,
    tail: 0.35,
    tailHz: 1800,
    tailDecay: 1.1,
    echoes: [[0.33, 0.18, 0.4]],
    level: 0.5,
  },
  // A rifle: a sharp, high crack, less boom, and the canyon answering twice.
  rifle: {
    crack: 1.1,
    crackHz: 2800,
    crackDecay: 0.007,
    body: 0.9,
    bodyHz: 1200,
    bodyQ: 1,
    bodyDecay: 0.08,
    boom: 0.8,
    boomFrom: 130,
    boomTo: 55,
    boomDecay: 0.13,
    thump: 0.45,
    tail: 0.4,
    tailHz: 2000,
    tailDecay: 1.8,
    echoes: [
      [0.42, 0.25, 0.5],
      [0.95, 0.13, 0.7],
    ],
    level: 0.5,
  },
  // A bandit's gun: pitched higher and thinner than the Rider's own, so you can tell whose shot it was.
  bandit: {
    crack: 0.42,
    crackHz: 1500,
    crackDecay: 0.012,
    body: 0.85,
    bodyHz: 1050,
    bodyQ: 1.2,
    bodyDecay: 0.075,
    boom: 0.55,
    boomFrom: 170,
    boomTo: 70,
    boomDecay: 0.12,
    thump: 0.3,
    tail: 0.3,
    tailHz: 2200,
    tailDecay: 0.9,
    echoes: [[0.31, 0.14, 0.3]],
    level: 0.4,
  },
};

/** Tunnel wall echoes: taps [delay s, level], and damped loops [delay s, feedback, level] that ring on down the bore. */
const TUNNEL_TAPS: readonly (readonly [number, number])[] = [
  [0.023, 0.45],
  [0.041, 0.35],
  [0.067, 0.28],
];
const TUNNEL_LOOPS: readonly (readonly [number, number, number])[] = [
  [0.089, 0.5, 0.4],
  [0.137, 0.42, 0.3],
];

function monoBuffer(ctx: BaseAudioContext, data: Float32Array<ArrayBuffer>): AudioBuffer {
  const b = ctx.createBuffer(1, Math.max(1, data.length), ctx.sampleRate);
  if (data.length > 0) b.copyToChannel(data, 0);
  return b;
}

function buildGraph(ctx: BaseAudioContext, masterGain: number, effectsGain: number): Graph {
  const offline = typeof (ctx as Partial<OfflineAudioContext>).startRendering === 'function';
  const master = amp(ctx, masterGain);
  master.connect(ctx.destination);
  const clip = ctx.createWaveShaper();
  clip.curve = CURVE_SAFETY;
  clip.connect(master);
  const halve = amp(ctx, 0.5); // the safety curve spans signal levels ±2
  halve.connect(clip);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -12;
  comp.knee.value = 12;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  // Chrome's compressor starts fully clamped and releases upward, which would duck the first sounds
  // after unlock by up to 8 dB. Release almost instantly for the first moments, then settle.
  comp.release.setValueAtTime(0.005, ctx.currentTime);
  comp.release.setValueAtTime(0.25, ctx.currentTime + 0.08);
  comp.connect(halve);
  // The environment: everything passes dry, and in a tunnel also through slapback echoes off the walls,
  // darkened, with two damped loops ringing on down the bore.
  const env = amp(ctx, 1);
  env.connect(comp);
  const send = amp(ctx, 0);
  env.connect(send);
  const pre = lowpass(ctx, 2800);
  send.connect(pre);
  const wet = amp(ctx, 1);
  wet.connect(comp);
  for (const [delay, a] of TUNNEL_TAPS) {
    const d = ctx.createDelay(0.2);
    d.delayTime.value = delay;
    pre.connect(d).connect(amp(ctx, a)).connect(wet);
  }
  for (const [delay, feedback, a] of TUNNEL_LOOPS) {
    const d = ctx.createDelay(0.5);
    d.delayTime.value = delay;
    const damp = lowpass(ctx, 1800);
    pre.connect(d).connect(damp);
    damp.connect(amp(ctx, feedback)).connect(d);
    damp.connect(amp(ctx, a)).connect(wet);
  }
  const fx = amp(ctx, effectsGain);
  fx.connect(env);
  const world = amp(ctx, 1);
  world.connect(env);
  const fxDry = amp(ctx, effectsGain);
  fxDry.connect(comp);
  const sr = ctx.sampleRate;
  return {
    ctx,
    offline,
    master,
    fx,
    fxDry,
    world,
    tunnelSend: new Knob(send.gain, TUNNEL_TC),
    white: monoBuffer(ctx, whiteNoise(Math.round(sr * 3))),
    brown: monoBuffer(ctx, brownNoise(Math.round(sr * 5))),
    grit: monoBuffer(ctx, gritNoise(Math.round(sr * 2), 2500, sr)),
    pluck: monoBuffer(ctx, karplusStrong(sr, PLUCK_HZ, 2.5, { decay: 0.996, blend: 0.45 })),
  };
}

/** Fades a loop out over `fade` seconds and stops its sources, including any queued but not yet started. */
function release(ctx: BaseAudioContext, loop: Loop, fade: number): void {
  const now = ctx.currentTime;
  const p = loop.out.gain;
  p.setValueAtTime(p.value, now);
  p.linearRampToValueAtTime(0, now + fade);
  for (const s of loop.sources) {
    try {
      s.node.stop(Math.min(s.end, now + fade + 0.02));
    } catch {
      // Already stopped.
    }
  }
  loop.sources = [];
}

const everlasting = (nodes: AudioScheduledSourceNode[]): Voice[] => nodes.map((node) => ({ node, end: Infinity }));

/**
 * Every sound in the game, synthesized. Create one, call `unlock()` from the first key press or click,
 * then fire sounds freely: before unlock, or if WebAudio is missing, every method quietly does nothing.
 * Continuous layers remember what they were last asked for and start when the audio does.
 */
export class Sfx {
  private readonly factory: () => BaseAudioContext;
  private g: Graph | null = null;
  /** The context exists but lacks something we need: stay silent rather than make another. */
  private broken = false;
  /** performance.now() until which a context this gesture created may queue sounds while it starts. */
  private graceUntil = 0;
  private masterVol = 1;
  private effectsVol = 1;
  private readonly lastShot = new Map<string, number>();
  /** End times of the gunshots still sounding, to cap how many overlap. */
  private shotEnds: number[] = [];
  private bellSwing = false;
  /** Whinnies started at the same moment, so a string of shying horses doesn't neigh in unison. */
  private whinnies = 0;
  private lastWhinnyT = -Infinity;
  // What the game last asked for.
  private engineWant: EngineInput | null = null;
  private readonly want: Record<LayerName, number> = { wind: 0, brakes: 0, valve: 0, water: 0, ford: 0 };
  /** Where the ford's river is heard: its pan, and the listener (the cab hears it muffled). */
  private readonly fordPlace: { pan: number; listener: Listener } = { pan: 0, listener: 'rider' };
  private horsesWant: { pan: number; gain: number }[] = [];
  private whistleWant = false;
  private whistleListener: Listener = 'rider';
  // What's sounding.
  private eng: EngineVoice | null = null;
  private readonly layers = new Map<LayerName, Layer>();
  private horses: HorseSlot[] = [];
  private whistleVoice: WhistleVoice | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(ctxFactory: () => BaseAudioContext = () => new AudioContext()) {
    this.factory = ctxFactory;
  }

  /** Creates/resumes the AudioContext. Call from a user gesture (keydown/click). Safe to call repeatedly. */
  unlock(): void {
    try {
      if (this.g && this.g.ctx.state === 'closed') this.forget();
      if (!this.g && !this.broken) this.create();
      const g = this.g;
      if (!g) return;
      if (!g.offline && g.ctx.state !== 'running') {
        const live = g.ctx as AudioContext;
        if (typeof live.resume === 'function') {
          live.resume().then(
            () => this.syncLoops(),
            () => undefined,
          );
        }
      }
      this.syncLoops();
    } catch (err) {
      this.warn('unlock', err);
    }
  }

  /** True once a context exists and is running (or is offline). */
  get ready(): boolean {
    const g = this.g;
    if (!g) return false;
    const state = g.ctx.state;
    return g.offline ? state !== 'closed' : state === 'running';
  }

  /** Master and effects volume, 0..1 each (slider positions; squared into gains), smoothly ramped. */
  setVolumes(master: number, effects: number): void {
    try {
      this.masterVol = clamp(master, 0, 1, this.masterVol);
      this.effectsVol = clamp(effects, 0, 1, this.effectsVol);
      const g = this.g;
      if (!g) return;
      const now = g.ctx.currentTime;
      g.master.gain.setTargetAtTime(volumeToGain(this.masterVol), now, VOLUME_TC);
      g.fx.gain.setTargetAtTime(volumeToGain(this.effectsVol), now, VOLUME_TC);
      g.fxDry.gain.setTargetAtTime(volumeToGain(this.effectsVol), now, VOLUME_TC);
    } catch (err) {
      this.warn('volumes', err);
    }
  }

  /** Silences every continuous layer (leaving a screen). One-shots already playing finish. */
  stopAll(): void {
    try {
      this.engineWant = null;
      for (const name of LAYER_NAMES) this.want[name] = 0;
      this.horsesWant = [];
      this.whistleWant = false;
      const g = this.g;
      if (!g) return;
      const fade = 0.05;
      if (this.eng) release(g.ctx, this.eng.loop, fade);
      this.eng = null;
      for (const layer of this.layers.values()) release(g.ctx, layer.loop, fade);
      this.layers.clear();
      for (const h of this.horses) release(g.ctx, { out: h.out, sources: h.sources }, fade);
      this.horses = [];
      if (this.whistleVoice) release(g.ctx, this.whistleVoice.loop, fade);
      this.whistleVoice = null;
      g.tunnelSend.set(0, g.ctx.currentTime, 0.02);
      this.syncTimer();
    } catch (err) {
      this.warn('stopAll', err);
    }
  }

  // ---- Continuous layers: call every frame with the current values --------------------------------

  /**
   * The locomotive: exhaust beats at four per turn of the drivers (so their rate follows the speed, fusing
   * into a roar when fast), louder and brighter with the throttle (coasting leaves soft beats and clanking
   * rods), rail clicks, rumble and the fire. `tunnel`: louder, darker, echoing. `listener` 'cab' puts you by
   * the firebox and injector with the rails underfoot; 'rider' out on the cars in the wind. null fades it out.
   */
  engine(p: { speed: number; throttle: number; tunnel: boolean; listener: Listener } | null): void {
    try {
      this.engineWant = engineInput(p);
      this.syncEngine();
    } catch (err) {
      this.warn('engine', err);
    }
  }

  /** Wind over the roof, 0..1 (0 silences it). */
  wind(level: number): void {
    this.setLayer('wind', clamp(level, 0, 1, 0));
  }

  /** Brake shoes, 0..1 (0 = off): a grind and squeal growing with the application, a screech past the emergency notch. */
  brakes(level: number): void {
    this.setLayer('brakes', clamp(level, 0, 1, 0));
  }

  /** The safety valve lifting: a roaring hiss of surplus steam. */
  safetyValve(on: boolean): void {
    this.setLayer('valve', on === true ? 1 : 0);
  }

  /** The water column pouring into the tender. */
  water(on: boolean): void {
    this.setLayer('water', on === true ? 1 : 0);
  }

  /**
   * The river rushing round the train in a ford, 0..1 (0 silences it): louder and churning with spray as
   * the train ploughs through. The Rider hears it at `pan` (where the train is wet, nearest them); in the
   * cab ('cab') it's under the footplate: centred and muffled.
   */
  fordWater(level: number, opts?: { pan?: number; listener?: Listener }): void {
    this.fordPlace.listener = listenerOf(opts?.listener);
    this.fordPlace.pan = this.fordPlace.listener === 'cab' ? 0 : clamp(opts?.pan, -1, 1, 0);
    this.setLayer('ford', clamp(level, 0, 1, 0));
  }

  /**
   * Galloping horses: one entry per horse, pan −1..1, gain 0..1 (by distance; far ones are also duller).
   * Each lopes in threes at its own pace. Horses are matched by position in the list, so keep its order
   * stable (e.g. by id); extra slots fade out when the list shrinks.
   */
  gallop(horses: { pan: number; gain: number }[]): void {
    try {
      const list = Array.isArray(horses) ? horses.slice(0, MAX_HORSES) : [];
      this.horsesWant = list.map((h) => ({ pan: clamp(h?.pan, -1, 1, 0), gain: clamp(h?.gain, 0, 1, 0) }));
      this.syncHorses();
    } catch (err) {
      this.warn('gallop', err);
    }
  }

  /**
   * The steam whistle: a five-chime chord with breath in it, slurring up to pitch as the valve opens, held
   * until `on` is false. Quick toots re-attack the same voice. 'cab' is close and bright; 'rider' farther off.
   */
  whistle(on: boolean, listener: Listener): void {
    try {
      this.whistleWant = on === true;
      this.whistleListener = listenerOf(listener);
      this.syncWhistle();
    } catch (err) {
      this.warn('whistle', err);
    }
  }

  // ---- One-shots: gunfire -------------------------------------------------------------------------

  /**
   * A gunshot. The Rider's own: centred and full. A bandit's: pass `pan` and `gain` (by distance; far shots
   * are duller and more echo than bang). The Engineer hears any gunfire `muffled`: through the cab's walls.
   */
  shot(weapon: Weapon | 'bandit', opts?: { pan?: number; gain?: number; muffled?: boolean }): void {
    const kind: GunKind = weapon === 'shotgun' || weapon === 'rifle' || weapon === 'bandit' ? weapon : 'revolver';
    this.oneShot(`shot:${kind}`, SHOT_GAP, (g, t) => {
      const muffled = opts?.muffled === true;
      const place = shotPlacement(opts?.pan, opts?.gain, muffled);
      if (place.gain < 0.003 || !this.admitShot(g)) return;
      this.shotEnds.push(this.gunshot(g, t, GUNS[kind], place, muffled));
    });
  }

  /** A bullet glancing off iron: a tick, then a whine that sweeps down as it tumbles away ("pyeeow"). */
  ricochet(pan?: number): void {
    this.oneShot('ricochet', 0.07, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.ricochet);
      out.connect(panner(ctx, shotPlacement(pan, 1).pan)).connect(g.fx);
      const f0 = rnd(2300, 3400);
      const dur = rnd(0.45, 0.7);
      const end = t + dur + 0.05;
      modal(ctx, out, t, rnd(3800, 5200), TICK_MODES);
      perc(noiseLayer(ctx, g.white, highpass(ctx, 3000), t, t + 0.03, out).gain, t, 0.5, 0.0003, 0.012);
      const sweep: [number, number][] = [
        [0, f0],
        [0.035, f0 * 1.12],
        [dur, f0 * 0.32],
      ];
      // The whine, wobbling as the bullet spins.
      const whine = amp(ctx, 0);
      swell(whine.gain, t, 0.5, 0.02, 0.06, dur);
      const o = tone(ctx, 'triangle', f0, t, end);
      glide(o.frequency, t, sweep);
      tone(ctx, 'sine', rnd(24, 38), t, end).connect(amp(ctx, rnd(30, 60))).connect(o.detune);
      o.connect(whine).connect(out);
      // Air rushing round it, following the same sweep.
      const band = bandpass(ctx, f0, 6);
      glide(band.frequency, t, sweep);
      perc(noiseLayer(ctx, g.white, band, t, end, out).gain, t, 0.25 * bandNorm(ctx, f0 / 6), 0.01, dur);
    });
  }

  /** A near miss past the Rider's head: a quick tearing zip, falling as it passes. */
  whiz(pan?: number): void {
    this.oneShot('whiz', 0.05, (g, t) => {
      const { ctx } = g;
      const p = shotPlacement(pan, 1).pan;
      const dur = rnd(0.14, 0.2);
      // It passes: from where it came toward the other side.
      const passing = panner(ctx, p);
      passing.pan.setValueAtTime(p, t);
      passing.pan.linearRampToValueAtTime(-0.35 * p, t + dur);
      const out = amp(ctx, LEVEL.whiz);
      out.connect(passing).connect(g.fx);
      const band = bandpass(ctx, 4000, 2.5);
      glide(band.frequency, t, [
        [0, rnd(5200, 6500)],
        [dur, rnd(1600, 2200)],
      ]);
      const k = bandNorm(ctx, 1800);
      swell(noiseLayer(ctx, g.white, band, t, t + dur + 0.05, out).gain, t, 0.9 * k, dur * 0.4, dur * 0.4, dur);
      const whistle = amp(ctx, 0);
      swell(whistle.gain, t, 0.08, dur * 0.4, dur * 0.4, dur);
      const o = tone(ctx, 'sine', 3600, t, t + dur + 0.05);
      glide(o.frequency, t, [
        [0, 3600],
        [dur, 2300],
      ]);
      o.connect(whistle).connect(out);
    });
  }

  /** The Rider is hit: a blow through the chest, a slap, the world dulling, a faint ring in the ears. */
  hurt(): void {
    this.oneShot('hurt', 0.15, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.hurt);
      out.connect(g.fx);
      const body = amp(ctx, 0);
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const o = tone(ctx, 'sine', 110, t, perc(body.gain, t, 0.9, 0.003, 0.4));
      glide(o.frequency, t, [
        [0, 125],
        [0.25, 40],
      ]);
      o.connect(amp(ctx, 0.9)).connect(sat).connect(body).connect(out);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 1600, 0.9), t, t + 0.2, out).gain, t, 0.5 * bandNorm(ctx, 2800), 0.0008, 0.05);
      const closing = lowpass(ctx, 1400);
      glide(closing.frequency, t, [
        [0, 1400],
        [0.3, 200],
      ]);
      perc(noiseLayer(ctx, g.white, closing, t, t + 0.5, out).gain, t, 0.4 * bandNorm(ctx, 1500), 0.002, 0.3);
      const ring = amp(ctx, 0);
      swell(ring.gain, t + 0.05, 0.04, 0.1, 0.1, 1.1);
      tone(ctx, 'sine', 3100, t, t + 1.3).connect(ring);
      tone(ctx, 'sine', 3163, t, t + 1.3).connect(ring);
      ring.connect(out);
    });
  }

  /** The Rider's shot connected: a satisfying thwack, landing a beat after the crack as the bullet arrives. */
  hitMarker(): void {
    this.oneShot('hitMarker', 0.05, (g, t0) => {
      const { ctx } = g;
      const t = t0 + 0.06;
      const out = amp(ctx, LEVEL.hitMarker);
      out.connect(g.fx);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 2000, 1.3), t, t + 0.06, out).gain, t, 0.7 * bandNorm(ctx, 2400), 0.0004, 0.028);
      const tock = amp(ctx, 0);
      const o = tone(ctx, 'triangle', 820, t, perc(tock.gain, t, 0.55, 0.001, 0.06));
      glide(o.frequency, t, [
        [0, 950],
        [0.05, 480],
      ]);
      o.connect(tock).connect(out);
      const punch = amp(ctx, 0);
      const p = tone(ctx, 'sine', 150, t, perc(punch.gain, t, 0.5, 0.002, 0.09));
      glide(p.frequency, t, [
        [0, 170],
        [0.08, 70],
      ]);
      p.connect(punch).connect(out);
    });
  }

  /** Reloading, timed to the weapon's reload (spec §6.4): revolver gate and cylinder, coach gun breaking open, rifle gate and lever. */
  reload(weapon: Weapon): void {
    this.reloadFor(weapon, Number.NaN);
  }

  /**
   * reload() timed to a known duration (s), e.g. the Speed loader's quicker reloads, so the last click
   * lands as the gun is ready. Anything but a sensible number uses the weapon's normal reload time.
   */
  reloadFor(weapon: Weapon, seconds: number): void {
    const w: Weapon = weapon === 'shotgun' || weapon === 'rifle' ? weapon : 'revolver';
    const d = clamp(seconds, 0.3, 6, WEAPONS[w].reload);
    this.oneShot('reload', 0.25, (g, t) => {
      const out = amp(g.ctx, LEVEL.reload * (w === 'shotgun' ? 1.6 : 1));
      out.connect(g.fx);
      if (w === 'revolver') this.revolverReload(g, out, t, d);
      else if (w === 'shotgun') this.shotgunReload(g, out, t, d);
      else this.rifleReload(g, out, t, d);
    });
  }

  /** The hammer falls on an empty chamber: a small, hard click. */
  dryFire(): void {
    this.oneShot('dryFire', 0.08, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.dryFire);
      out.connect(g.fx);
      tick(ctx, g.white, out, t, rnd(2900, 3300), 1);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 1300, 2), t, t + 0.03, out).gain, t, 0.4 * bandNorm(ctx, 1040), 0.0005, 0.012);
    });
  }

  /** The push-off: a boot scuffing the roof, then cloth in the wind. */
  jump(): void {
    this.oneShot('jump', 0.1, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.jump);
      out.connect(g.fx);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 1100, 1.2), t, t + 0.1, out).gain, t, 0.5 * bandNorm(ctx, 1470), 0.002, 0.05);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 180), t, t + 0.1, out).gain, t, 0.4 * bandNorm(ctx, 200), 0.003, 0.05);
      const band = bandpass(ctx, 900, 1);
      glide(band.frequency, t, [
        [0, 600],
        [0.2, 1800],
      ]);
      swell(noiseLayer(ctx, g.white, band, t, t + 0.3, out).gain, t, 0.25 * bandNorm(ctx, 1200), 0.08, 0.08, 0.22);
    });
  }

  /** Boots on a wooden roof: the planks' thump and knock, and grit skittering. `hard` after a long drop. */
  land(hard: boolean): void {
    this.oneShot('land', 0.08, (g, t) => {
      const { ctx } = g;
      const heavy = hard === true;
      const out = amp(ctx, LEVEL.land);
      out.connect(g.fx);
      const thump = amp(ctx, 0);
      const o = tone(ctx, 'sine', 95, t, perc(thump.gain, t, heavy ? 0.9 : 0.6, 0.002, heavy ? 0.2 : 0.12));
      glide(o.frequency, t, [
        [0, heavy ? 88 : 98],
        [0.12, heavy ? 40 : 52],
      ]);
      o.connect(thump).connect(out);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 380, 1.6), t, t + 0.15, out).gain, t, (heavy ? 0.7 : 0.5) * bandNorm(ctx, 380), 0.001, heavy ? 0.09 : 0.06);
      perc(noiseLayer(ctx, g.grit, bandpass(ctx, 2600, 0.9), t, t + 0.2, out).gain, t + 0.002, heavy ? 0.45 : 0.3, 0.002, 0.12);
      if (heavy) perc(noiseLayer(ctx, g.white, bandpass(ctx, 300, 1.4), t + 0.07, t + 0.2, out).gain, t + 0.07, 0.3 * bandNorm(ctx, 340), 0.002, 0.06);
    });
  }

  /** Knocked down or off: a body hitting hard, then gravel scraping as it tumbles. */
  thud(): void {
    this.oneShot('thud', 0.2, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.thud);
      out.connect(g.fx);
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const body = amp(ctx, 0);
      const o = tone(ctx, 'sine', 80, t, perc(body.gain, t, 0.9, 0.003, 0.4));
      glide(o.frequency, t, [
        [0, 85],
        [0.3, 32],
      ]);
      o.connect(amp(ctx, 0.8)).connect(sat).connect(body).connect(out);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 300), t, t + 0.3, out).gain, t, 0.7 * bandNorm(ctx, 330), 0.002, 0.25);
      swell(noiseLayer(ctx, g.grit, bandpass(ctx, 1900, 0.8), t, t + 0.8, out).gain, t + 0.03, 0.5, 0.05, 0.1, 0.65);
      swell(noiseLayer(ctx, g.white, bandpass(ctx, 700, 0.8), t, t + 0.6, out).gain, t + 0.03, 0.3 * bandNorm(ctx, 875), 0.05, 0.08, 0.45);
    });
  }

  /** An explosion: the blast front, a falling sub boom, a rumble rolling on, and debris coming down. `big` for the boiler or the powder car. */
  explosion(big: boolean): void {
    this.oneShot('explosion', 0.25, (g, t) => {
      const { ctx } = g;
      const huge = big === true;
      const out = amp(ctx, huge ? LEVEL.explosionBig : LEVEL.explosion);
      out.connect(g.fx);
      const len = huge ? 3.8 : 2;
      const end = t + len + 0.1;
      perc(noiseLayer(ctx, g.white, highpass(ctx, 1200), t, t + 0.1, out).gain, t, 0.35, 0.0004, 0.04);
      const front = lowpass(ctx, 4000);
      glide(front.frequency, t, [
        [0, 6000],
        [huge ? 0.8 : 0.5, 350],
      ]);
      perc(noiseLayer(ctx, g.white, front, t, t + 1.2, out).gain, t, 0.22 * bandNorm(ctx, 3000), 0.003, huge ? 0.9 : 0.5);
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const boom = amp(ctx, 0);
      const o = tone(ctx, 'sine', 72, t, perc(boom.gain, t, 0.55, 0.004, huge ? 1.8 : 0.9));
      glide(o.frequency, t, [
        [0, huge ? 68 : 80],
        [huge ? 1.2 : 0.6, huge ? 24 : 32],
      ]);
      o.connect(amp(ctx, 0.8)).connect(sat).connect(boom).connect(out);
      // The rumble: brown noise shaken by two unrelated fast LFOs.
      const shake = amp(ctx, 0.7);
      tone(ctx, 'sine', rnd(7, 9), t, end).connect(amp(ctx, 0.2)).connect(shake.gain);
      tone(ctx, 'sine', rnd(11, 14), t, end).connect(amp(ctx, 0.12)).connect(shake.gain);
      const brown = noise(ctx, g.brown, t, end);
      brown.connect(lowpass(ctx, 160)).connect(amp(ctx, 1.2)).connect(shake);
      brown.connect(bandpass(ctx, 380, 1.2)).connect(amp(ctx, 0.8)).connect(shake);
      const rumble = amp(ctx, 0);
      swell(rumble.gain, t, 0.7, 0.15, huge ? 0.6 : 0.25, len);
      shake.connect(rumble).connect(out);
      // Debris: grit pattering down, and a few clunks of iron and wood.
      swell(noiseLayer(ctx, g.grit, bandpass(ctx, 2800, 0.8), t, end, out).gain, t + 0.12, 0.5, 0.23, 0.3, len * 0.8 - 0.12);
      const clunks = amp(ctx, 0.3);
      clunks.connect(out);
      for (let i = 0; i < (huge ? 6 : 3); i++) modal(ctx, clunks, t + rnd(0.2, len * 0.45), rnd(160, 620), CLANK_MODES, rnd(0.5, 1));
    });
  }

  /** A wreck (collision, derailment, obstacle): iron clanging and scraping, timber splintering, a long settle. */
  crash(): void {
    this.oneShot('crash', 0.5, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.crash);
      out.connect(g.fx);
      const len = 2.6;
      const end = t + len + 0.1;
      // The impact: the whole train shoved at once.
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const body = amp(ctx, 0);
      const o = tone(ctx, 'sine', 62, t, perc(body.gain, t, 0.7, 0.003, 0.7));
      glide(o.frequency, t, [
        [0, 66],
        [0.5, 30],
      ]);
      o.connect(amp(ctx, 0.8)).connect(sat).connect(body).connect(out);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 2500), t, t + 0.5, out).gain, t, 0.35 * bandNorm(ctx, 2700), 0.002, 0.3);
      // Iron: frames and plates clanging one after another.
      const iron = amp(ctx, 0.3);
      iron.connect(out);
      let at = t;
      for (let i = 0; i < 5; i++) {
        modal(ctx, iron, at, rnd(130, 480), GRILLE_MODES, rnd(0.45, 0.9));
        at += rnd(0.06, 0.28);
      }
      // Iron scraping on iron: narrow bands sliding down, stuttering.
      const jitter = amp(ctx, 0.6);
      tone(ctx, 'sine', rnd(12, 15), t, end).connect(amp(ctx, 0.3)).connect(jitter.gain);
      tone(ctx, 'sine', rnd(19, 23), t, end).connect(amp(ctx, 0.2)).connect(jitter.gain);
      for (const [f0, f1] of [
        [1500, 650],
        [2400, 1100],
      ] as const) {
        const b = bandpass(ctx, f0, 16);
        glide(b.frequency, t, [
          [0, f0],
          [1.6, f1],
        ]);
        noise(ctx, g.white, t, end)
          .connect(b)
          .connect(amp(ctx, 0.5 * bandNorm(ctx, f0 / 16)))
          .connect(jitter);
      }
      const scrape = amp(ctx, 0);
      swell(scrape.gain, t, 0.7, 0.06, 0.5, 1.8);
      jitter.connect(scrape).connect(out);
      // Timber: splintering cracks, and a crunch or two.
      for (let i = 0; i < 14; i++) {
        const when = t + 0.02 + rnd(0, 1) ** 1.6 * 1.2;
        const fc = rnd(1400, 3600);
        perc(noiseLayer(ctx, g.white, bandpass(ctx, fc, 1.6), when, when + 0.05, out).gain, when, rnd(0.2, 0.6) * bandNorm(ctx, fc / 1.6), 0.0005, rnd(0.008, 0.025));
      }
      for (const when of [t + 0.04, t + rnd(0.25, 0.5)]) {
        perc(noiseLayer(ctx, g.white, bandpass(ctx, 420, 1.1), when, when + 0.2, out).gain, when, 0.4 * bandNorm(ctx, 380), 0.002, 0.12);
      }
      // Settling: a low rumble.
      swell(noiseLayer(ctx, g.brown, lowpass(ctx, 150), t, end, out).gain, t, 0.7, 0.1, 0.4, len);
    });
  }

  /** A tunnel portal going by: a shove of air on the ears, and a rush that darkens going in and opens up coming out. */
  tunnel(enter: boolean): void {
    this.oneShot('tunnel', 0.4, (g, t) => {
      const { ctx } = g;
      const into = enter === true;
      const out = amp(ctx, LEVEL.tunnel);
      out.connect(g.fx);
      const press = amp(ctx, 0);
      const o = tone(ctx, 'sine', 50, t, perc(press.gain, t, into ? 0.6 : 0.4, 0.03, 0.45));
      glide(
        o.frequency,
        t,
        into
          ? [
              [0, 62],
              [0.4, 36],
            ]
          : [
              [0, 40],
              [0.4, 58],
            ],
      );
      o.connect(press).connect(out);
      const band = lowpass(ctx, 2000, 1.5);
      glide(
        band.frequency,
        t,
        into
          ? [
              [0, 6000],
              [0.55, 450],
            ]
          : [
              [0, 500],
              [0.55, 6500],
            ],
      );
      swell(noiseLayer(ctx, g.white, band, t, t + 1, out).gain, t, 0.3 * bandNorm(ctx, 2500), into ? 0.06 : 0.2, into ? 0.1 : 0.25, 0.85);
    });
  }

  /**
   * A splash in a ford. `big`: the loco ploughing in, a mass of water struck and thrown up as a sheet of
   * spray that patters back down; otherwise a body falling in, a plunge and a gulp. Pass `pan` and `gain`
   * by where it is; `muffled` for the cab (heard through the floor, centred).
   */
  splash(big: boolean, opts?: { pan?: number; gain?: number; muffled?: boolean }): void {
    const huge = big === true;
    this.oneShot(huge ? 'splash:big' : 'splash', huge ? 0.4 : 0.2, (g, t) => {
      const { ctx } = g;
      const muffled = opts?.muffled === true;
      const place = shotPlacement(opts?.pan, opts?.gain, muffled);
      if (place.gain < 0.003) return;
      const out = amp(ctx, (huge ? LEVEL.splashBig : LEVEL.splash) * place.gain);
      if (muffled) out.connect(lowpass(ctx, SPLASH_MUFFLED_HZ)).connect(g.fx);
      else out.connect(lowpass(ctx, 2500 + 15500 * place.gain)).connect(panner(ctx, place.pan)).connect(g.fx);
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const body = amp(ctx, 0);
      const o = tone(ctx, 'sine', huge ? 62 : 170, t, perc(body.gain, t, huge ? 0.85 : 0.6, 0.004, huge ? 0.32 : 0.14));
      glide(o.frequency, t, [
        [0, huge ? 62 : 170],
        [huge ? 0.3 : 0.12, huge ? 30 : 68],
      ]);
      o.connect(amp(ctx, 0.8)).connect(sat).connect(body).connect(out);
      if (!huge) {
        // The gulp: the cavity closing behind the body.
        const gulp = amp(ctx, 0);
        const b = tone(ctx, 'sine', 320, t + 0.035, perc(gulp.gain, t + 0.035, 0.35, 0.002, 0.09));
        glide(b.frequency, t + 0.035, [
          [0, 320],
          [0.06, 1050],
        ]);
        b.connect(gulp).connect(out);
      }
      // The crash of water, falling in pitch as the wave collapses.
      const band = bandpass(ctx, huge ? 2200 : 1500, huge ? 0.9 : 0.8);
      glide(band.frequency, t, [
        [0, huge ? 2400 : 1600],
        [huge ? 0.6 : 0.3, huge ? 650 : 800],
      ]);
      swell(noiseLayer(ctx, g.white, band, t, t + (huge ? 1.1 : 0.5), out).gain, t, (huge ? 0.8 : 0.6) * bandNorm(ctx, 2000), 0.012, huge ? 0.08 : 0.03, huge ? 0.95 : 0.4);
      if (huge) perc(noiseLayer(ctx, g.white, highpass(ctx, 3500), t, t + 1.3, out).gain, t + 0.02, 0.35 * bandNorm(ctx, 8000), 0.02, 1.1);
      // Drops pattering back, and bubbles.
      swell(noiseLayer(ctx, g.grit, bandpass(ctx, 2800, 0.9), t + 0.1, t + (huge ? 1.6 : 0.8), out).gain, t + 0.1, huge ? 0.55 : 0.4, 0.15, huge ? 0.45 : 0.2, huge ? 1.4 : 0.65);
      const bubbles = amp(ctx, 0.3);
      bubbles.connect(out);
      for (let i = 0; i < (huge ? 14 : 7); i++) {
        const at = t + 0.05 + rnd(0, huge ? 0.9 : 0.5);
        const f = rnd(350, 1300);
        const dur = rnd(0.02, 0.06);
        const vca = amp(ctx, 0);
        const b = tone(ctx, 'sine', f, at, perc(vca.gain, at, rnd(0.2, 0.55), 0.002, dur));
        glide(b.frequency, at, [
          [0, f],
          [dur, f * rnd(1.3, 1.8)],
        ]);
        b.connect(vca).connect(bubbles);
      }
    });
  }

  /**
   * The lurch (spec §5.2): the brake slammed into emergency, the slack in every coupling running in with a
   * clank after clank down the train, the whole train's weight shoved forward, the shoes biting. For the
   * Rider the clanks run from the loco (right) toward the rear; in the cab they come from behind.
   */
  /** The flames of a burning trestle flaring up around the Rider: a whoomph of burning air (spec §4.3). */
  flare(): void {
    this.oneShot('flare', 0.25, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.flare);
      out.connect(g.fx);
      // The rush of flame: a band of noise sweeping up as it catches, then settling.
      const band = bandpass(ctx, 600, 0.7);
      glide(band.frequency, t, [
        [0, 320],
        [0.2, 1500],
        [0.6, 520],
      ]);
      swell(noiseLayer(ctx, g.white, band, t, t + 0.75, out).gain, t, 0.9 * bandNorm(ctx, 850), 0.06, 0.14, 0.62);
      // The draught underneath it.
      const body = amp(ctx, 0);
      tone(ctx, 'sine', 68, t, perc(body.gain, t, 0.6, 0.02, 0.4)).connect(body).connect(out);
    });
  }

  lurch(listener: Listener): void {
    const cab = listenerOf(listener) === 'cab';
    this.oneShot('lurch', 1, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.lurch);
      out.connect(g.fx);
      // The shove: the whole train's weight going forward at once.
      const sat = ctx.createWaveShaper();
      sat.curve = CURVE_GROWL;
      const shove = amp(ctx, 0);
      const o = tone(ctx, 'sine', 52, t, perc(shove.gain, t, 0.55, 0.006, 0.45));
      glide(o.frequency, t, [
        [0, 52],
        [0.4, 28],
      ]);
      o.connect(amp(ctx, 0.8)).connect(sat).connect(shove).connect(out);
      // The slack running in: coupling after coupling taking up, fading down the train.
      let at = t + 0.03;
      const n = 6;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const clank = amp(ctx, (cab ? 0.9 * (1 - 0.8 * u) : 0.85 * (1 - 0.55 * u)) * rnd(0.85, 1.1));
        if (cab) clank.connect(lowpass(ctx, 2200 - 1200 * u)).connect(out);
        else clank.connect(panner(ctx, (0.55 - 1.1 * u) * PAN_WIDTH)).connect(out);
        modal(ctx, clank, at, rnd(110, 190), GRILLE_MODES, rnd(0.45, 0.7));
        perc(noiseLayer(ctx, g.white, lowpass(ctx, 420), at, at + 0.12, clank).gain, at, 0.5 * bandNorm(ctx, 460), 0.002, 0.06);
        at += rnd(0.07, 0.11);
      }
      // The shoes biting: a grinding squeal of the wheels' rings, and sparks.
      const bite = amp(ctx, 0);
      swell(bite.gain, t, 0.22, 0.03, 0.2, 0.9);
      bite.connect(out);
      for (const [f, q] of [
        [2380, 30],
        [3170, 36],
      ] as const) {
        noise(ctx, g.white, t, t + 0.95)
          .connect(bandpass(ctx, f * rnd(0.98, 1.02), q))
          .connect(amp(ctx, bandNorm(ctx, f / q)))
          .connect(bite);
      }
      swell(noiseLayer(ctx, g.brown, bandpass(ctx, 500, 1), t, t + 0.9, out).gain, t, 0.3, 0.02, 0.15, 0.8);
      perc(noiseLayer(ctx, g.grit, highpass(ctx, 3500), t, t + 0.7, out).gain, t + 0.02, 0.45, 0.01, 0.55);
    });
  }

  /**
   * A horse shying at the brake's squeal (spec §5.2): a whinny, rising steeply then shuddering down, and a
   * snort. Pass `pan` and `gain` by where the horse is. Several at once start a moment apart.
   */
  whinny(pan?: number, gain?: number): void {
    this.oneShot(`whinny:${this.whinnies++ % 3}`, 0.3, (g, t0) => {
      const { ctx } = g;
      const place = shotPlacement(pan, gain);
      if (place.gain < 0.003) return;
      // Horses shying together don't neigh in unison.
      const t = t0 - this.lastWhinnyT < 0.05 ? t0 + rnd(0.08, 0.22) : t0;
      this.lastWhinnyT = t0;
      const out = amp(ctx, LEVEL.whinny * place.gain);
      out.connect(lowpass(ctx, place.cutoffHz)).connect(panner(ctx, place.pan)).connect(g.fx);
      const r = rnd(0.88, 1.12);
      const len = rnd(0.8, 1);
      const env = amp(ctx, 0);
      const end = swell(env.gain, t, 1, 0.05, len * 0.6, len);
      // The voice: bright and nasal, its pitch leaping up and then shuddering down.
      const voice = tone(ctx, 'sawtooth', 700 * r, t, end + 0.02);
      glide(voice.frequency, t, [
        [0, 700 * r],
        [0.1, 1150 * r],
        [len, 520 * r],
      ]);
      const shudder = tone(ctx, 'sine', rnd(11, 14), t, end + 0.02);
      shudder.connect(amp(ctx, 70)).connect(voice.detune);
      const trem = amp(ctx, 0.7);
      shudder.connect(amp(ctx, 0.3)).connect(trem.gain);
      const mouth = amp(ctx, 1);
      voice.connect(trem).connect(mouth);
      mouth.connect(bandpass(ctx, 950, 4)).connect(amp(ctx, 1.4)).connect(env);
      mouth.connect(bandpass(ctx, 2300, 5)).connect(amp(ctx, 0.9)).connect(env);
      env.connect(lowpass(ctx, 3800)).connect(out);
      // Breath through it, and a snort after.
      const breath = amp(ctx, 0);
      swell(breath.gain, t, 0.25 * bandNorm(ctx, 1500), 0.05, len * 0.5, len);
      noise(ctx, g.white, t, end + 0.02).connect(bandpass(ctx, 1800, 1.2)).connect(breath).connect(out);
      const snort = t + len + 0.08;
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 900), snort, snort + 0.25, out).gain, snort, 0.9 * bandNorm(ctx, 1000), 0.01, 0.16);
    });
  }

  /**
   * Cattle on the line (spec §8), far ahead: `scatter` false, one lows, a long questioning "moo?" rising at
   * the end (the herd heard the whistle too soon and has got used to it); true, a bellow and the herd's
   * hooves as it bolts off the line. Pass `pan` and `gain` by where the herd is.
   */
  cattle(scatter: boolean, pan?: number, gain?: number): void {
    const bolt = scatter === true;
    this.oneShot(bolt ? 'cattle:scatter' : 'cattle:calm', 0.6, (g, t) => {
      const { ctx } = g;
      const place = shotPlacement(pan, gain);
      if (place.gain < 0.003) return;
      const out = amp(ctx, LEVEL.cattle * place.gain * (bolt ? 1.25 : 1));
      out.connect(lowpass(ctx, Math.min(place.cutoffHz, 6000))).connect(panner(ctx, place.pan)).connect(g.fx);
      const f0 = bolt ? rnd(150, 180) : rnd(105, 125);
      const len = bolt ? rnd(0.85, 1) : rnd(1.3, 1.5);
      const env = amp(ctx, 0);
      const end = swell(env.gain, t, 1, bolt ? 0.08 : 0.25, len * 0.75, len);
      const voice = tone(ctx, 'sawtooth', f0, t, end + 0.02);
      glide(
        voice.frequency,
        t,
        bolt
          ? [
              [0, f0],
              [0.18, f0 * 1.25],
              [len, f0 * 0.8],
            ]
          : [
              [0, f0],
              [len * 0.62, f0 * 1.02],
              [len * 0.93, f0 * 1.35],
            ],
      );
      tone(ctx, 'sine', rnd(4.5, 5.5), t, end + 0.02)
        .connect(amp(ctx, 8))
        .connect(voice.detune);
      // The mouth: closed ("mm") opening to "oo"; a bellow is rough and wide open.
      const mouth = lowpass(ctx, 350, 2);
      glide(mouth.frequency, t, [
        [0, bolt ? 700 : 330],
        [bolt ? 0.1 : 0.4, bolt ? 1500 : 900],
        [len, bolt ? 900 : 1000],
      ]);
      if (bolt) {
        const rough = ctx.createWaveShaper();
        rough.curve = CURVE_GROWL;
        voice.connect(amp(ctx, 0.9)).connect(rough).connect(mouth);
      } else voice.connect(mouth);
      mouth.connect(bandpass(ctx, bolt ? 620 : 700, 3)).connect(amp(ctx, 1.6)).connect(env);
      mouth.connect(amp(ctx, 0.5)).connect(env);
      env.connect(out);
      const breath = amp(ctx, 0);
      swell(breath.gain, t, 0.3 * bandNorm(ctx, 600), 0.1, len * 0.6, len);
      noise(ctx, g.brown, t, end + 0.02).connect(bandpass(ctx, 600, 1.4)).connect(breath).connect(out);
      if (!bolt) return;
      // The herd bolting: hooves drumming off into the distance, a low rumble under them.
      const hooves = amp(ctx, 1.9);
      hooves.connect(out);
      for (let i = 0; i < 22; i++) {
        const u = (i + rnd(0, 0.8)) / 22;
        const at = t + 0.2 + u * 2.3;
        const thud = amp(ctx, 0);
        perc(thud.gain, at, (1 - 0.6 * u) * rnd(0.6, 1), 0.003, rnd(0.05, 0.08));
        noise(ctx, g.brown, at, at + 0.12)
          .connect(lowpass(ctx, 320))
          .connect(amp(ctx, 1.4))
          .connect(thud)
          .connect(hooves);
      }
      swell(noiseLayer(ctx, g.brown, lowpass(ctx, 150), t + 0.2, t + 2.8, out).gain, t + 0.2, 0.25, 0.3, 0.5, 2.5);
    });
  }

  /** The Rider thrown by a lurch: a grunt knocked out of them, boots skidding on the roof, a stamp as they catch themselves. */
  grunt(): void {
    this.oneShot('grunt', 0.5, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.grunt);
      out.connect(g.fx);
      const env = amp(ctx, 0);
      const end = perc(env.gain, t, 1, 0.012, 0.16);
      const voice = tone(ctx, 'sawtooth', 165, t, end);
      glide(voice.frequency, t, [
        [0, 165],
        [0.14, 105],
      ]);
      voice.connect(bandpass(ctx, 650, 2)).connect(amp(ctx, 1.4)).connect(env);
      voice.connect(bandpass(ctx, 1300, 3)).connect(amp(ctx, 0.6)).connect(env);
      env.connect(out);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 1500, 1), t, t + 0.15, out).gain, t, 0.45 * bandNorm(ctx, 1500), 0.005, 0.1);
      // Boots skidding, then the stamp.
      swell(noiseLayer(ctx, g.white, bandpass(ctx, 1200, 1.5), t + 0.05, t + 0.5, out).gain, t + 0.05, 0.3 * bandNorm(ctx, 800), 0.04, 0.15, 0.4);
      perc(noiseLayer(ctx, g.grit, bandpass(ctx, 2400, 0.9), t + 0.05, t + 0.45, out).gain, t + 0.05, 0.35, 0.01, 0.3);
      const stamp = t + 0.34;
      const thump = amp(ctx, 0);
      const s = tone(ctx, 'sine', 95, stamp, perc(thump.gain, stamp, 0.7, 0.002, 0.1));
      glide(s.frequency, stamp, [
        [0, 95],
        [0.08, 55],
      ]);
      s.connect(thump).connect(out);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 380, 1.6), stamp, stamp + 0.12, out).gain, stamp, 0.5 * bandNorm(ctx, 380), 0.001, 0.06);
    });
  }

  /** The telegraph sounder ticking out a short word: a sharp click as the armature falls, a softer clack as it lifts. */
  telegraph(): void {
    this.oneShot('telegraph', 0.3, (g, t0) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.telegraph);
      out.connect(g.fx);
      const word = WIRE_WORDS[Math.floor(Math.random() * WIRE_WORDS.length)];
      const unit = rnd(0.055, 0.07);
      let t = t0;
      for (const letter of word) {
        for (const sym of MORSE[letter] ?? '') {
          const len = sym === '-' ? 3 * unit : unit;
          this.sounder(g, out, t, true);
          this.sounder(g, out, t + len, false);
          t += len + unit;
        }
        t += 2 * unit;
      }
    });
  }

  /** A switch stand thrown: the lever lifts off its latch, the points slide across, the stand drops home with a heavy clunk. */
  switchThrow(): void {
    this.oneShot('switchThrow', 0.12, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.switchThrow);
      out.connect(g.fx);
      const latch = amp(ctx, 0.35);
      latch.connect(out);
      modal(ctx, latch, t, rnd(820, 960), CLANK_MODES, 0.5);
      swell(noiseLayer(ctx, g.white, bandpass(ctx, 900, 2.2), t + 0.05, t + 0.35, out).gain, t + 0.05, 0.3 * bandNorm(ctx, 650), 0.07, 0.15, 0.25);
      swell(noiseLayer(ctx, g.grit, bandpass(ctx, 2600, 1), t + 0.05, t + 0.35, out).gain, t + 0.05, 0.3, 0.07, 0.15, 0.25);
      const home = t + 0.3;
      const clunk = amp(ctx, 0.7);
      clunk.connect(out);
      modal(ctx, clunk, home, rnd(140, 165), CLANK_MODES, 1.3);
      const thump = amp(ctx, 0);
      const o = tone(ctx, 'sine', 75, home, perc(thump.gain, home, 0.8, 0.002, 0.18));
      glide(o.frequency, home, [
        [0, 75],
        [0.15, 42],
      ]);
      o.connect(thump).connect(out);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 400), home, home + 0.2, out).gain, home, 0.6 * bandNorm(ctx, 440), 0.001, 0.1);
    });
  }

  /** A cab lever moved a notch: the latch clicks out of the quadrant and drops into the next tooth. */
  lever(): void {
    this.oneShot('lever', 0.03, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.lever);
      out.connect(g.fx);
      tick(ctx, g.white, out, t, 2600, 0.5);
      const clack = amp(ctx, 0.5);
      clack.connect(out);
      modal(ctx, clack, t + 0.03, rnd(950, 1100), CLANK_MODES, 0.35);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 1800, 1.5), t + 0.03, t + 0.06, out).gain, t + 0.03, 0.3 * bandNorm(ctx, 1900), 0.0004, 0.01);
    });
  }

  /** The locomotive's bell: heavy bronze swung on its yoke, the clapper striking alternate sides. */
  bell(): void {
    this.oneShot('bell', 0.25, (g, t) => {
      const { ctx } = g;
      this.bellSwing = !this.bellSwing;
      const out = amp(ctx, LEVEL.bell * (this.bellSwing ? 1 : 0.82));
      out.connect(g.fx);
      modal(ctx, out, t, 332 * rnd(0.995, 1.005), LOCO_BELL_MODES);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 2800, 1.2), t, t + 0.04, out).gain, t, 0.25 * bandNorm(ctx, 3700), 0.0005, 0.012);
    });
  }

  /** A station stop or checkpoint done: a bright, rising three-note chime. */
  chime(): void {
    this.oneShot('chime', 0.4, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.chime);
      out.connect(g.fxDry);
      [659.25, 830.61, 987.77].forEach((f, i) => modal(ctx, out, t + i * 0.11, f, CHIME_MODES, i === 2 ? 1.3 : 1));
    });
  }

  /** Payout: a handful of coins chinking into a pile, then the register's bell. */
  cash(): void {
    this.oneShot('cash', 0.08, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.cash);
      out.connect(g.fxDry);
      let at = t;
      for (let i = 0; i < 6; i++) {
        const coin = amp(ctx, rnd(0.35, 0.6));
        coin.connect(out);
        modal(ctx, coin, at, rnd(2600, 4600), COIN_MODES, rnd(0.6, 1));
        at += rnd(0.025, 0.06);
      }
      const ding = at + 0.04;
      const bell = amp(ctx, 0.6);
      bell.connect(out);
      modal(ctx, bell, ding, 2093, CHIME_MODES, 0.8);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 300), ding, ding + 0.15, out).gain, ding, 0.5 * bandNorm(ctx, 330), 0.002, 0.07);
    });
  }

  /** Trouble (held up, loot stolen): three quick strikes of a small alarm gong over a low, uneasy semitone. Over in a second. */
  alarm(): void {
    this.oneShot('alarm', 1.2, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.alarm);
      out.connect(g.fx);
      for (let i = 0; i < 3; i++) modal(ctx, out, t + i * 0.13, 1244.5 * (i === 2 ? 0.94 : 1), ALARM_MODES, 0.7);
      const dread = amp(ctx, 0);
      swell(dread.gain, t, 0.25, 0.05, 0.3, 1);
      const warm = lowpass(ctx, 700);
      for (const f of [146.83, 155.56]) tone(ctx, 'sawtooth', f, t, t + 1.05).connect(warm);
      warm.connect(dread).connect(out);
    });
  }

  /** Arrived: a bright strum, an answer a fourth up, and home again with a ring of the triangle. */
  win(): void {
    this.oneShot('win', 1, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.win);
      out.connect(g.fxDry);
      const guitar = this.guitar(g, out, t, 2.3);
      this.strum(g, guitar, t, E_MAJOR, 0.3, t + 2.35);
      this.strum(g, guitar, t + 0.3, A_MAJOR, 0.28, t + 2.35);
      this.strum(g, guitar, t + 0.6, E_MAJOR_HIGH, 0.34, t + 2.35);
      const ding = amp(ctx, 0.25);
      ding.connect(out);
      modal(ctx, ding, t + 0.6, 1318.5, CHIME_MODES, 1.2);
    });
  }

  /** Lost: a lone guitar walking down A minor, sagging flat, over a dull drum and the prairie wind. */
  lose(): void {
    this.oneShot('lose', 1, (g, t) => {
      const { ctx } = g;
      const out = amp(ctx, LEVEL.lose);
      out.connect(g.fxDry);
      const guitar = this.guitar(g, out, t, 2.4);
      A_MINOR_WALK.forEach((f, i) => {
        const at = t + i * 0.3;
        const s = ctx.createBufferSource();
        s.buffer = g.pluck;
        const r = f / PLUCK_HZ;
        glide(s.playbackRate, at, [
          [0, r],
          [0.1, r],
          [1.2, r * 0.97],
        ]);
        s.connect(amp(ctx, 0.45 - 0.03 * i)).connect(guitar);
        s.start(at);
        s.stop(t + 2.45);
      });
      const drum = amp(ctx, 0);
      const d = tone(ctx, 'sine', 70, t, perc(drum.gain, t, 0.8, 0.004, 0.6));
      glide(d.frequency, t, [
        [0, 70],
        [0.4, 40],
      ]);
      d.connect(drum).connect(out);
      const moan = bandpass(ctx, 400, 0.8);
      tone(ctx, 'sine', 0.35, t, t + 2.5).connect(amp(ctx, 120)).connect(moan.frequency);
      swell(noiseLayer(ctx, g.brown, moan, t, t + 2.5, out).gain, t, 0.35, 0.8, 1.2, 2.4);
    });
  }

  /** A soft UI click. */
  uiClick(): void {
    this.oneShot('uiClick', 0.03, (g, t) => {
      const { ctx } = g;
      const vca = amp(ctx, 0);
      const o = tone(ctx, 'sine', 1500, t, perc(vca.gain, t, LEVEL.click, 0.001, 0.035));
      glide(o.frequency, t, [
        [0, 1500],
        [0.03, 850],
      ]);
      o.connect(vca).connect(g.fxDry);
      perc(noiseLayer(ctx, g.white, bandpass(ctx, 3800, 1.2), t, t + 0.03, g.fxDry).gain, t, LEVEL.click * 0.25 * bandNorm(ctx, 5000), 0.0005, 0.008);
    });
  }

  // ---- Internals: context and scheduling ----------------------------------------------------------

  private create(): void {
    let ctx: BaseAudioContext;
    try {
      ctx = this.factory();
    } catch (err) {
      this.warn('no audio context', err); // e.g. no WebAudio; a later unlock may try again
      return;
    }
    try {
      this.g = buildGraph(ctx, volumeToGain(this.masterVol), volumeToGain(this.effectsVol));
    } catch (err) {
      this.broken = true;
      this.warn('audio graph', err);
      try {
        (ctx as Partial<AudioContext>).close?.().catch(() => undefined);
      } catch {
        // Nothing more to do.
      }
      return;
    }
    if (this.g.offline) return;
    ctx.addEventListener('statechange', () => this.syncLoops());
    if (ctx.state !== 'running') this.graceUntil = performance.now() + START_GRACE_MS;
  }

  /** The context was closed under us: drop everything so the next unlock starts afresh. */
  private forget(): void {
    this.clearTimer();
    this.g = null;
    this.eng = null;
    this.layers.clear();
    this.horses = [];
    this.whistleVoice = null;
    this.shotEnds = [];
    this.lastShot.clear();
  }

  /** Running, or a context the current gesture just created that is still starting up. */
  private get audible(): boolean {
    if (this.ready) return true;
    const g = this.g;
    return g !== null && !g.offline && g.ctx.state === 'suspended' && performance.now() < this.graceUntil;
  }

  /** Runs a one-shot: `build` wires its nodes starting at `t`. Rate-limited per sound. */
  private oneShot(key: string, minGap: number, build: (g: Graph, t: number) => void): void {
    try {
      const g = this.g;
      if (!g || !this.audible) return;
      const t = g.ctx.currentTime + START_DELAY;
      const last = this.lastShot.get(key);
      if (last !== undefined && t - last < minGap && t >= last) return;
      this.lastShot.set(key, t);
      build(g, t);
    } catch (err) {
      this.warn(key, err);
    }
  }

  /** How far ahead rhythmic layers are queued: further in a hidden tab, whose timers barely run. */
  private lookahead(): number {
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    return hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD;
  }

  /** Brings every continuous layer in line with what was last asked for (after unlock, or when the context starts). */
  private syncLoops(): void {
    try {
      this.syncEngine();
      for (const name of LAYER_NAMES) this.setLayer(name, this.want[name]);
      this.syncHorses();
      this.syncWhistle();
    } catch (err) {
      this.warn('loops', err);
    }
  }

  /** Keeps the pump timer running while anything rhythmic or fading needs it (realtime contexts only). */
  private syncTimer(): void {
    const g = this.g;
    const busy = g !== null && !g.offline && (this.eng !== null || this.layers.size > 0 || this.horses.length > 0 || this.whistleVoice !== null);
    if (busy && this.timer === null) this.timer = setInterval(() => this.onTimer(), PUMP_MS);
    else if (!busy) this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private onTimer(): void {
    try {
      if (!this.g) this.clearTimer();
      else if (this.ready) this.pumpAll();
    } catch (err) {
      this.warn('pump', err);
    }
  }

  /** Queues everything rhythmic, and tears down layers that have been silent a while. */
  private pumpAll(): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    const horizon = now + this.lookahead();
    if (this.eng) this.pumpEngine(g, this.eng, horizon);
    this.pumpHorses(g, horizon);
    for (const [name, layer] of this.layers) {
      if (layer.idleSince !== null && now - layer.idleSince >= IDLE_RELEASE) {
        release(g.ctx, layer.loop, 0.05);
        this.layers.delete(name);
      } else layer.pump?.(horizon);
    }
    const w = this.whistleVoice;
    if (w && !w.on && now - w.releasedAt >= WHISTLE_HOLD) {
      release(g.ctx, w.loop, 0.03);
      this.whistleVoice = null;
    }
    this.syncTimer();
  }

  private admitShot(g: Graph): boolean {
    const now = g.ctx.currentTime;
    this.shotEnds = this.shotEnds.filter((e) => e > now);
    return this.shotEnds.length < MAX_SHOT_VOICES;
  }

  // ---- Internals: the locomotive ------------------------------------------------------------------

  private syncEngine(): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    const want = this.engineWant;
    if (!want) {
      g.tunnelSend.set(0, now);
      if (this.eng) release(g.ctx, this.eng.loop, ENGINE_FADE);
      this.eng = null;
      this.syncTimer();
      return;
    }
    if (!this.ready) return; // picked up again when the context starts running
    g.tunnelSend.set(want.tunnel ? TUNNEL_SEND : 0, now);
    if (!this.eng) this.eng = this.startEngine(g, want);
    const e = this.eng;
    e.input = want;
    e.mix = engineMix(want);
    this.applyEngine(g, e, now);
    this.pumpEngine(g, e, now + this.lookahead());
    this.syncTimer();
  }

  private startEngine(g: Graph, input: EngineInput): EngineVoice {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const m = engineMix(input);
    const out = amp(ctx, 1);
    out.connect(g.world);
    const fadeIn = amp(ctx, 0);
    fadeIn.connect(out);
    fadeIn.gain.setValueAtTime(0, t);
    fadeIn.gain.linearRampToValueAtTime(1, t + 0.4);
    const level = amp(ctx, m.gain * LEVEL.engine);
    level.connect(fadeIn);
    const toneLp = lowpass(ctx, m.toneHz);
    toneLp.connect(level);
    const sum = amp(ctx, 1);
    sum.connect(toneLp);
    const white = noise(ctx, g.white, t);
    const brown = noise(ctx, g.brown, t);
    const grit = noise(ctx, g.grit, t);

    // The exhaust. Each beat (queued by pumpEngine) is a burst of noise through its own falling band-pass
    // into `mid`, and raw into a shared low-pass (the thump in the chest) and high-pass (the steam's edge).
    const exhaust = amp(ctx, m.exhaust);
    const flutter = amp(ctx, 1 - m.flutter * 0.5);
    const exhaustLp = lowpass(ctx, m.exhaustHz);
    exhaust.connect(flutter).connect(exhaustLp).connect(sum);
    const mid = amp(ctx, ENGINE.mid * bandNorm(ctx, 900));
    mid.connect(exhaust);
    const bodyIn = amp(ctx, 1);
    const body = amp(ctx, ENGINE.body * m.body * bandNorm(ctx, 190));
    bodyIn.connect(lowpass(ctx, 170)).connect(body).connect(exhaust);
    const sizzleIn = amp(ctx, 1);
    const sizzle = amp(ctx, ENGINE.sizzle * m.sizzle);
    sizzleIn.connect(highpass(ctx, 2600)).connect(sizzle).connect(exhaust);
    // The roar the beats fuse into at speed: noise throbbing at the beat rate.
    const roarBand = bandpass(ctx, m.roarHz, 0.7);
    white.connect(roarBand);
    const throb = amp(ctx, 0.65);
    roarBand.connect(amp(ctx, bandNorm(ctx, 1000))).connect(throb);
    brown.connect(lowpass(ctx, 260)).connect(amp(ctx, 0.8)).connect(throb);
    const roarLfo = tone(ctx, 'sine', Math.max(0.01, m.rate), t);
    roarLfo.connect(amp(ctx, 0.35)).connect(throb.gain);
    const roar = amp(ctx, ENGINE.roar * m.roar);
    throb.connect(roar).connect(exhaust);
    // The wind tearing at the exhaust (the Rider's ears only): two slow, unrelated swells.
    const flutterDepth = amp(ctx, m.flutter * 0.25);
    flutterDepth.connect(flutter.gain);
    const flutterA = tone(ctx, 'sine', rnd(0.37, 0.47), t);
    const flutterB = tone(ctx, 'sine', rnd(0.97, 1.31), t);
    flutterA.connect(flutterDepth);
    flutterB.connect(flutterDepth);

    // Cylinder cocks: steam blowing from the drains at a start, steadily and with every beat.
    const cockIn = amp(ctx, 1);
    cockIn
      .connect(highpass(ctx, 1800))
      .connect(bandpass(ctx, 4300, 0.7))
      .connect(amp(ctx, ENGINE.cocks * bandNorm(ctx, 6000)))
      .connect(sum);
    const cockHold = amp(ctx, m.cocks * 0.35);
    white.connect(cockHold).connect(cockIn);
    const cockBus = amp(ctx, 1);
    cockBus.connect(cockIn);

    // Side rods: knocks queued by pumpEngine.
    const rodBus = amp(ctx, ENGINE.rods * m.rods);
    rodBus.connect(sum);

    // Rails: clicks queued by pumpEngine, coloured by the rail's ring; the wheels' thunks go direct.
    const railBus = amp(ctx, 1);
    const railSum = amp(ctx, 1);
    railBus.connect(highpass(ctx, 2200)).connect(amp(ctx, 0.5)).connect(railSum);
    railBus
      .connect(bandpass(ctx, 1850, 5))
      .connect(amp(ctx, 0.6 * bandNorm(ctx, 370)))
      .connect(railSum);
    railBus
      .connect(bandpass(ctx, 3100, 7))
      .connect(amp(ctx, 0.4 * bandNorm(ctx, 440)))
      .connect(railSum);
    const railDirect = amp(ctx, 1);
    railDirect.connect(railSum);
    const railLp = lowpass(ctx, m.railHz);
    const rails = amp(ctx, ENGINE.rails * m.rails);
    railSum.connect(railLp).connect(rails).connect(sum);

    // Rolling: the whole train's low rumble, swaying on the track, and steel wheels on steel rails.
    const rumbleLp = lowpass(ctx, m.rumbleHz);
    brown.connect(rumbleLp);
    const sway = amp(ctx, 0.85);
    const swayLfo = tone(ctx, 'sine', rnd(0.6, 0.9), t);
    swayLfo.connect(amp(ctx, 0.15)).connect(sway.gain);
    const rumble = amp(ctx, ENGINE.rumble * m.rumble);
    rumbleLp.connect(sway).connect(rumble).connect(sum);
    const rollBand = bandpass(ctx, 1300, 0.6);
    white.connect(rollBand);
    const rolling = amp(ctx, ENGINE.rolling * m.rolling);
    rollBand.connect(rolling).connect(sum);

    // The firebox: a roar that pulls with every beat (the blast draws the fire), and crackling coal.
    const firePulse = amp(ctx, 1);
    brown.connect(bandpass(ctx, 260, 0.8)).connect(amp(ctx, 1.4)).connect(firePulse);
    white.connect(bandpass(ctx, 1000, 0.8)).connect(amp(ctx, 0.25)).connect(firePulse);
    grit.connect(bandpass(ctx, 2800, 0.9)).connect(amp(ctx, 0.3)).connect(firePulse);
    const fire = amp(ctx, ENGINE.fire * m.firebox);
    firePulse.connect(fire).connect(sum);

    // The injector (the Engineer's ears only): a hiss and a thin singing while it feeds the boiler.
    const injector = amp(ctx, 0);
    white
      .connect(bandpass(ctx, 3600, 1.2))
      .connect(amp(ctx, 0.5 * bandNorm(ctx, 3000)))
      .connect(injector);
    white
      .connect(bandpass(ctx, 1250, 14))
      .connect(amp(ctx, 0.35 * bandNorm(ctx, 90)))
      .connect(injector);
    injector.connect(sum);

    const k: Record<EngineKnob, Knob> = {
      level: new Knob(level.gain),
      tone: new Knob(toneLp.frequency),
      exhaust: new Knob(exhaust.gain),
      exhaustHz: new Knob(exhaustLp.frequency),
      body: new Knob(body.gain),
      sizzle: new Knob(sizzle.gain),
      roar: new Knob(roar.gain),
      roarHz: new Knob(roarBand.frequency),
      roarRate: new Knob(roarLfo.frequency),
      cockHold: new Knob(cockHold.gain),
      rods: new Knob(rodBus.gain),
      rails: new Knob(rails.gain),
      railHz: new Knob(railLp.frequency),
      rumble: new Knob(rumble.gain),
      rumbleHz: new Knob(rumbleLp.frequency),
      rolling: new Knob(rolling.gain),
      fire: new Knob(fire.gain),
      injector: new Knob(injector.gain, 0.35),
      flutterBase: new Knob(flutter.gain),
      flutterDepth: new Knob(flutterDepth.gain),
    };
    return {
      loop: { out, sources: everlasting([white, brown, grit, roarLfo, flutterA, flutterB, swayLfo]) },
      input,
      mix: m,
      odo: 0,
      schedT: t,
      mid,
      bodyIn,
      sizzleIn,
      cockBus,
      rodBus,
      railBus,
      railDirect,
      firePulse,
      k,
      injectorOn: false,
      injectorNext: t + rnd(3, 8),
    };
  }

  /** Glides the engine's parameters to its current mix. */
  private applyEngine(g: Graph, e: EngineVoice, now: number): void {
    const m = e.mix;
    const k = e.k;
    k.level.set(m.gain * LEVEL.engine, now, 0.2);
    k.tone.set(m.toneHz, now, 0.15);
    k.exhaust.set(m.exhaust, now);
    k.exhaustHz.set(m.exhaustHz, now);
    k.body.set(ENGINE.body * m.body * bandNorm(g.ctx, 190), now);
    k.sizzle.set(ENGINE.sizzle * m.sizzle, now);
    k.roar.set(ENGINE.roar * m.roar, now);
    k.roarHz.set(m.roarHz, now);
    k.roarRate.set(Math.max(0.01, m.rate), now);
    k.cockHold.set(m.cocks * 0.35, now);
    k.rods.set(ENGINE.rods * m.rods, now);
    k.rails.set(ENGINE.rails * m.rails, now);
    k.railHz.set(m.railHz, now);
    k.rumble.set(ENGINE.rumble * m.rumble, now);
    k.rumbleHz.set(m.rumbleHz, now);
    k.rolling.set(ENGINE.rolling * m.rolling, now);
    k.fire.set(ENGINE.fire * m.firebox, now);
    k.injector.set(e.injectorOn ? ENGINE.injector * m.injector : 0, now);
    k.flutterBase.set(1 - m.flutter * 0.5, now);
    k.flutterDepth.set(m.flutter * 0.25, now);
  }

  /** Queues the beats, knocks and clicks passed by `horizon` at the current speed. */
  private pumpEngine(g: Graph, e: EngineVoice, horizon: number): void {
    const now = g.ctx.currentTime;
    if (e.schedT < now) e.schedT = now + START_DELAY; // the clock ran on without us: resync rather than burst
    e.loop.sources = e.loop.sources.filter((s) => s.end > now);
    if (horizon > e.schedT) {
      const v = Math.abs(e.input.speed);
      if (v > 0) {
        for (const ev of patternEvents(CHUFF_PATTERN, e.odo, v, e.schedT, horizon)) this.chuff(g, e, ev.t, ev.i);
        for (const ev of patternEvents(ROD_PATTERN, e.odo, v, e.schedT, horizon)) this.rodKnock(g, e, ev.t, ev.i);
        for (const ev of patternEvents(RAIL_PATTERN, e.odo, v, e.schedT, horizon)) this.railClick(g, e, ev.t, ev.i);
        e.odo += v * (horizon - e.schedT);
      }
      e.schedT = horizon;
    }
    // The injector: the Engineer feeds the boiler for a few seconds now and then.
    if (now >= e.injectorNext) {
      e.injectorOn = !e.injectorOn;
      e.injectorNext = now + (e.injectorOn ? rnd(5, 11) : rnd(12, 28));
      e.k.injector.set(e.injectorOn ? ENGINE.injector * e.mix.injector : 0, now);
    }
  }

  /** One exhaust beat. */
  private chuff(g: Graph, e: EngineVoice, t: number, i: number): void {
    const { ctx } = g;
    const m = e.mix;
    const beat = i % CHUFFS_PER_REV;
    const accent = CHUFF_ACCENTS[beat] * rnd(0.88, 1.12);
    const decay = m.chuffDecay * rnd(0.85, 1.15);
    const sink = e.loop.sources;
    if (m.chuff > 0.003) {
      // A start's beats swell in more slowly: the cylinders are still filling.
      const attack = Math.min(0.3 * decay, rnd(0.004, 0.011) + 0.018 * m.cocks);
      const end = t + attack + decay + 0.02;
      const vca = amp(ctx, 0);
      perc(vca.gain, t, m.chuff * accent, attack, decay);
      noise(ctx, g.white, t, end, sink).connect(vca);
      // The band falls as the blast empties: a "chuff" rather than a "tss".
      const hz = m.chuffHz * CHUFF_COLOURS[beat] * rnd(0.94, 1.06);
      const band = bandpass(ctx, hz, 1.1);
      glide(band.frequency, t, [
        [0, hz * 1.35],
        [attack + decay * 0.6, hz * 0.7],
      ]);
      vca.connect(band).connect(e.mid);
      vca.connect(e.bodyIn);
      vca.connect(e.sizzleIn);
    }
    if (m.cocks > 0.01) {
      const vca = amp(ctx, 0);
      perc(vca.gain, t, m.cocks * accent, 0.012, 0.38);
      noise(ctx, g.white, t, t + 0.45, sink).connect(vca).connect(e.cockBus);
    }
    if (m.firebox > 0.02) {
      const p = e.firePulse.gain;
      p.setTargetAtTime(1 + 0.8 * accent * Math.min(1, 0.3 + m.chuff), t, 0.005);
      p.setTargetAtTime(1, t + 0.02, Math.max(0.015, decay * 0.3));
    }
  }

  /** A side rod knocking in its bearings; the two sides ring a little differently. */
  private rodKnock(g: Graph, e: EngineVoice, t: number, i: number): void {
    if (e.mix.rods < 0.02) return;
    const { ctx } = g;
    const out = amp(ctx, rnd(0.7, 1.1));
    out.connect(e.rodBus);
    modal(ctx, out, t, (i % 2 === 0 ? 590 : 655) * rnd(0.98, 1.02), ROD_MODES, 1, e.loop.sources);
    perc(noiseLayer(ctx, g.white, bandpass(ctx, 2400, 1.5), t, t + 0.02, out, e.loop.sources).gain, t, 0.3 * bandNorm(ctx, 1600), 0.0004, 0.008);
  }

  /** An axle crossing a rail joint: a tick of steel and the wheel's thunk. */
  private railClick(g: Graph, e: EngineVoice, t: number, i: number): void {
    const m = e.mix;
    if (m.rails < 0.01) return;
    const { ctx } = g;
    const sink = e.loop.sources;
    const a = RAIL_ACCENTS[i % RAIL_ACCENTS.length] * rnd(0.8, 1.15);
    const vca = amp(ctx, 0);
    perc(vca.gain, t, a, 0.0003, rnd(0.012, 0.022));
    noise(ctx, g.white, t, t + 0.04, sink).connect(vca).connect(e.railBus);
    const thunk = amp(ctx, 0);
    const o = tone(ctx, 'sine', 130, t, perc(thunk.gain, t, 0.9 * a, 0.001, 0.06), sink);
    glide(o.frequency, t, [
      [0, 130],
      [0.05, 70],
    ]);
    o.connect(thunk).connect(e.railDirect);
  }

  // ---- Internals: level-driven layers -------------------------------------------------------------

  private setLayer(name: LayerName, level: number): void {
    try {
      this.want[name] = level;
      const g = this.g;
      if (!g) return;
      const now = g.ctx.currentTime;
      let layer = this.layers.get(name);
      if (level > 0) {
        if (!this.ready) return;
        if (!layer) {
          layer = this.buildLayer(g, name);
          this.layers.set(name, layer);
        }
        layer.idleSince = null;
        layer.set(level, now);
        layer.pump?.(now + this.lookahead());
      } else if (layer) {
        layer.set(0, now);
        layer.idleSince ??= now;
        if (now - layer.idleSince >= IDLE_RELEASE) {
          release(g.ctx, layer.loop, 0.05);
          this.layers.delete(name);
        }
      }
      this.syncTimer();
    } catch (err) {
      this.warn(name, err);
    }
  }

  private buildLayer(g: Graph, name: LayerName): Layer {
    switch (name) {
      case 'wind':
        return this.buildWind(g);
      case 'brakes':
        return this.buildBrakes(g);
      case 'valve':
        return this.buildValve(g);
      case 'water':
        return this.buildWater(g);
      case 'ford':
        return this.buildFord(g);
    }
  }

  /** Wind over the roof: buffeting, a rush of air, the hiss of it tearing past the ears, a howl where it finds an edge, all gusting. */
  private buildWind(g: Graph): Layer {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.world);
    const gust = amp(ctx, 0.8);
    gust.connect(out);
    const gustA = tone(ctx, 'sine', rnd(0.1, 0.15), t);
    gustA.connect(amp(ctx, 0.14)).connect(gust.gain);
    const gustB = tone(ctx, 'sine', rnd(0.27, 0.36), t);
    gustB.connect(amp(ctx, 0.08)).connect(gust.gain);
    const brown = noise(ctx, g.brown, t);
    const white = noise(ctx, g.white, t);
    const buffet = amp(ctx, 0);
    brown.connect(lowpass(ctx, 160)).connect(buffet).connect(gust);
    const rushBand = bandpass(ctx, 500, 0.6);
    const rush = amp(ctx, 0);
    white.connect(rushBand).connect(rush).connect(gust);
    const hissBand = bandpass(ctx, 1500, 0.7);
    const hiss = amp(ctx, 0);
    white.connect(hissBand).connect(hiss).connect(gust);
    const howlBand = bandpass(ctx, 850, 12);
    const drift = tone(ctx, 'sine', rnd(0.045, 0.07), t);
    drift.connect(amp(ctx, 160)).connect(howlBand.frequency);
    const howl = amp(ctx, 0);
    white.connect(howlBand).connect(howl).connect(gust);
    const k = {
      buffet: new Knob(buffet.gain, 0.2),
      rush: new Knob(rush.gain, 0.2),
      rushHz: new Knob(rushBand.frequency, 0.3),
      hiss: new Knob(hiss.gain, 0.2),
      hissHz: new Knob(hissBand.frequency, 0.3),
      howl: new Knob(howl.gain, 0.4),
    };
    const nRush = bandNorm(ctx, 1000);
    const nHiss = bandNorm(ctx, 2500);
    const nHowl = bandNorm(ctx, 70);
    return {
      loop: { out, sources: everlasting([gustA, gustB, brown, white, drift]) },
      idleSince: null,
      set: (level, now) => {
        const m = windMix(level);
        k.buffet.set(LEVEL.wind * WIND.buffet * m.buffet, now);
        k.rush.set(LEVEL.wind * WIND.rush * m.rush * nRush, now);
        k.rushHz.set(m.rushHz, now);
        k.hiss.set(LEVEL.wind * WIND.hiss * m.hiss * nHiss, now);
        k.hissHz.set(m.hissHz, now);
        k.howl.set(LEVEL.wind * WIND.howl * m.howl * nHowl, now);
      },
    };
  }

  /** Brake shoes on the tyres: a grind, a squeal of the wheels' rings waxing and waning, and past the emergency notch a clipped screech with sparks. */
  private buildBrakes(g: Graph): Layer {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const sum = amp(ctx, LEVEL.brakes);
    sum.connect(out);
    const sources: AudioScheduledSourceNode[] = [];
    const white = noise(ctx, g.white, t);
    const grit = noise(ctx, g.grit, t);
    sources.push(white, grit);
    const grindBand = bandpass(ctx, 900, 0.8);
    const grind = amp(ctx, 0);
    white.connect(grindBand).connect(amp(ctx, bandNorm(ctx, 1100))).connect(grind).connect(sum);
    const squeal = amp(ctx, 0);
    squeal.connect(sum);
    for (const [f, q, a] of SQUEAL_BANDS) {
      const sway = amp(ctx, 0.6);
      const lfo = tone(ctx, 'sine', rnd(0.2, 0.9), t);
      lfo.connect(amp(ctx, 0.4)).connect(sway.gain);
      white
        .connect(bandpass(ctx, f, q))
        .connect(sway)
        .connect(amp(ctx, a * bandNorm(ctx, f / q)))
        .connect(squeal);
      sources.push(lfo);
    }
    for (const [f, a] of SQUEAL_PARTIALS) {
      const o = tone(ctx, 'sine', f * rnd(0.99, 1.01), t);
      const jitter = tone(ctx, 'sine', rnd(4, 7), t);
      jitter.connect(amp(ctx, 9)).connect(o.detune);
      const sway = amp(ctx, 0.5);
      const lfo = tone(ctx, 'sine', rnd(0.3, 1.1), t);
      lfo.connect(amp(ctx, 0.5)).connect(sway.gain);
      o.connect(sway).connect(amp(ctx, a)).connect(squeal);
      sources.push(o, jitter, lfo);
    }
    const screech = amp(ctx, 0);
    const harsh = ctx.createWaveShaper();
    harsh.curve = CURVE_GROWL;
    const screechIn = amp(ctx, 0.5);
    screechIn.connect(harsh).connect(screech).connect(sum);
    for (const [f, a] of SCREECH_PARTIALS) {
      const o = tone(ctx, 'sine', f * rnd(0.99, 1.01), t);
      const jitter = tone(ctx, 'sine', rnd(6, 11), t);
      jitter.connect(amp(ctx, 25)).connect(o.detune);
      o.connect(amp(ctx, a)).connect(screechIn);
      sources.push(o, jitter);
    }
    white
      .connect(bandpass(ctx, 5200, 18))
      .connect(amp(ctx, 0.5 * bandNorm(ctx, 290)))
      .connect(screechIn);
    const sparks = amp(ctx, 0);
    grit.connect(highpass(ctx, 3500)).connect(sparks).connect(sum);
    const k = { grind: new Knob(grind.gain), squeal: new Knob(squeal.gain, 0.12), screech: new Knob(screech.gain, 0.06), sparks: new Knob(sparks.gain, 0.06) };
    return {
      loop: { out, sources: everlasting(sources) },
      idleSince: null,
      set: (level, now) => {
        const m = brakeMix(level);
        k.grind.set(BRAKE.grind * m.grind, now);
        k.squeal.set(BRAKE.squeal * m.squeal, now);
        k.screech.set(BRAKE.screech * m.screech, now);
        k.sparks.set(BRAKE.sparks * m.screech, now);
      },
    };
  }

  /** The safety valve: a roaring hiss of surplus steam and a tone where it rushes past the seat, chattering; it lifts with a pop. */
  private buildValve(g: Graph): Layer {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const pop = amp(ctx, 1);
    pop.connect(out);
    const level = amp(ctx, 0);
    level.connect(pop);
    const chatter = amp(ctx, 0.88);
    chatter.connect(level);
    const lfo = tone(ctx, 'sine', rnd(16, 22), t);
    lfo.connect(amp(ctx, 0.12)).connect(chatter.gain);
    const white = noise(ctx, g.white, t);
    const brown = noise(ctx, g.brown, t);
    white
      .connect(highpass(ctx, 1400))
      .connect(bandpass(ctx, 4000, 0.6))
      .connect(amp(ctx, bandNorm(ctx, 6600)))
      .connect(chatter);
    white
      .connect(bandpass(ctx, 2650, 9))
      .connect(amp(ctx, 0.35 * bandNorm(ctx, 300)))
      .connect(chatter);
    brown
      .connect(bandpass(ctx, 420, 0.8))
      .connect(amp(ctx, 0.8))
      .connect(chatter);
    const k = new Knob(level.gain);
    let lifted = false;
    return {
      loop: { out, sources: everlasting([lfo, white, brown]) },
      idleSince: null,
      set: (on, now) => {
        const rising = on > 0 && !lifted;
        lifted = on > 0;
        k.set(on > 0 ? LEVEL.valve : 0, now, on > 0 ? 0.02 : 0.18);
        if (rising) {
          pop.gain.setTargetAtTime(1.6, now, 0.006);
          pop.gain.setTargetAtTime(1, now + 0.05, 0.12);
        }
      },
    };
  }

  /** The water column: a gushing torrent into the tank, churning, drumming on the water below, bubbling and splashing. */
  private buildWater(g: Graph): Layer {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const level = amp(ctx, 0);
    level.connect(out);
    const sources: Voice[] = [];
    const white = noise(ctx, g.white, t, undefined, sources);
    const brown = noise(ctx, g.brown, t, undefined, sources);
    const grit = noise(ctx, g.grit, t, undefined, sources);
    const churn = amp(ctx, 0.7);
    for (const [hz, depth] of [
      [5.3, 0.12],
      [7.9, 0.1],
      [11.3, 0.08],
    ] as const) {
      tone(ctx, 'sine', hz * rnd(0.9, 1.1), t, undefined, sources).connect(amp(ctx, depth)).connect(churn.gain);
    }
    white
      .connect(bandpass(ctx, 700, 0.6))
      .connect(amp(ctx, bandNorm(ctx, 1170)))
      .connect(churn)
      .connect(level);
    brown
      .connect(lowpass(ctx, 240))
      .connect(amp(ctx, 1.2))
      .connect(level);
    grit
      .connect(bandpass(ctx, 2400, 0.9))
      .connect(amp(ctx, 0.5))
      .connect(level);
    const bubbles = amp(ctx, 0.5);
    bubbles.connect(level);
    const k = new Knob(level.gain);
    let on = 0;
    let schedT = t;
    const loop: Loop = { out, sources };
    return {
      loop,
      idleSince: null,
      set: (lv, now) => {
        on = lv;
        k.set(lv > 0 ? LEVEL.water : 0, now, lv > 0 ? 0.15 : 0.18);
      },
      pump: (horizon) => {
        const now = ctx.currentTime;
        if (schedT < now) schedT = now + START_DELAY;
        loop.sources = loop.sources.filter((s) => s.end > now);
        // Bubbles: a sine blip each, rising in pitch as it shrinks, at random (Poisson) times.
        while (on > 0 && schedT < horizon) {
          schedT += -Math.log(1 - Math.random()) / 28;
          const f = rnd(450, 1700);
          const dur = rnd(0.02, 0.06);
          const vca = amp(ctx, 0);
          const o = tone(ctx, 'sine', f, schedT, perc(vca.gain, schedT, rnd(0.2, 0.6), 0.002, dur), loop.sources);
          glide(o.frequency, schedT, [
            [0, f],
            [dur, f * rnd(1.3, 1.8)],
          ]);
          o.connect(vca).connect(bubbles);
        }
        if (on <= 0) schedT = Math.max(schedT, horizon);
      },
    };
  }

  /**
   * The river in a ford: a broad rush of surf heaving in slow surges, a low wash piling against the
   * wheels, the hiss of spray and drops pattering back, and gurgles. Panned to where the train is wet;
   * muffled for the cab, where it's under the footplate.
   */
  private buildFord(g: Graph): Layer {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const cab = this.fordPlace.listener === 'cab';
    const pan = panner(ctx, this.fordPlace.pan * PAN_WIDTH);
    pan.connect(out);
    const muffle = lowpass(ctx, cab ? FORD_CAB_HZ : FORD_OPEN_HZ);
    muffle.connect(pan);
    const level = amp(ctx, 0);
    level.connect(muffle);
    const sources: Voice[] = [];
    const white = noise(ctx, g.white, t, undefined, sources);
    const brown = noise(ctx, g.brown, t, undefined, sources);
    const grit = noise(ctx, g.grit, t, undefined, sources);
    // Surges: the river heaving against the cars.
    const surge = amp(ctx, 0.75);
    surge.connect(level);
    tone(ctx, 'sine', rnd(0.18, 0.26), t, undefined, sources).connect(amp(ctx, 0.2)).connect(surge.gain);
    tone(ctx, 'sine', rnd(0.6, 0.85), t, undefined, sources).connect(amp(ctx, 0.1)).connect(surge.gain);
    const rush = amp(ctx, 0);
    white.connect(bandpass(ctx, 1100, 0.55)).connect(amp(ctx, bandNorm(ctx, 2000))).connect(rush).connect(surge);
    const wash = amp(ctx, 0);
    brown.connect(lowpass(ctx, 320)).connect(amp(ctx, 1.1)).connect(wash).connect(surge);
    const spray = amp(ctx, 0);
    white.connect(highpass(ctx, 3800)).connect(amp(ctx, bandNorm(ctx, 8000))).connect(spray).connect(level);
    const drops = amp(ctx, 0);
    grit.connect(bandpass(ctx, 2600, 0.9)).connect(drops).connect(level);
    const bubbles = amp(ctx, 0.45);
    bubbles.connect(level);
    const k = {
      level: new Knob(level.gain, 0.15),
      rush: new Knob(rush.gain, 0.2),
      wash: new Knob(wash.gain, 0.2),
      spray: new Knob(spray.gain, 0.2),
      drops: new Knob(drops.gain, 0.2),
      pan: new Knob(pan.pan, 0.1),
      muffle: new Knob(muffle.frequency, 0.12),
    };
    let rate = 0;
    let schedT = t;
    const loop: Loop = { out, sources };
    return {
      loop,
      idleSince: null,
      set: (lv, now) => {
        const m = fordMix(lv);
        const inCab = this.fordPlace.listener === 'cab';
        k.level.set((inCab ? LEVEL.fordCab : LEVEL.ford) * m.gain, now, lv > 0 ? 0.15 : 0.2);
        k.rush.set(m.rush, now);
        k.wash.set(m.wash, now);
        k.spray.set(0.6 * m.spray, now);
        k.drops.set(0.5 * m.drops, now);
        k.pan.set(this.fordPlace.pan * PAN_WIDTH, now);
        k.muffle.set(inCab ? FORD_CAB_HZ : FORD_OPEN_HZ, now);
        rate = lv > 0 ? m.bubbles : 0;
      },
      pump: (horizon) => {
        const now = ctx.currentTime;
        if (schedT < now) schedT = now + START_DELAY;
        loop.sources = loop.sources.filter((s) => s.end > now);
        // Gurgles: sine blips rising as the bubbles shrink, at random (Poisson) times.
        while (rate > 0 && schedT < horizon) {
          schedT += -Math.log(1 - Math.random()) / rate;
          const f = rnd(300, 1300);
          const dur = rnd(0.02, 0.07);
          const vca = amp(ctx, 0);
          const o = tone(ctx, 'sine', f, schedT, perc(vca.gain, schedT, rnd(0.15, 0.5), 0.002, dur), loop.sources);
          glide(o.frequency, schedT, [
            [0, f],
            [dur, f * rnd(1.3, 1.9)],
          ]);
          o.connect(vca).connect(bubbles);
        }
        if (rate <= 0) schedT = Math.max(schedT, horizon);
      },
    };
  }

  // ---- Internals: horses ------------------------------------------------------------------------------

  private syncHorses(): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    const want = this.horsesWant;
    while (this.horses.length > want.length) {
      const h = this.horses.pop();
      if (h) release(g.ctx, { out: h.out, sources: h.sources }, 0.3);
    }
    if (this.ready) {
      want.forEach((w, i) => {
        const h = this.horses[i] ?? (this.horses[i] = this.makeHorse(g, w));
        h.gain = w.gain;
        h.level.set(LEVEL.gallop * w.gain, now);
        h.pan.set(w.pan * PAN_WIDTH, now);
        h.dull.set(hoofCutoff(w.gain), now);
      });
      this.pumpHorses(g, now + this.lookahead());
    }
    this.syncTimer();
  }

  /** A horse arriving: it fades in where it is, rather than sliding over from the middle. */
  private makeHorse(g: Graph, at: { pan: number; gain: number }): HorseSlot {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const pan = panner(ctx, at.pan * PAN_WIDTH);
    pan.connect(out);
    const level = amp(ctx, 0);
    level.connect(pan);
    const dull = lowpass(ctx, hoofCutoff(at.gain));
    dull.connect(level);
    const input = amp(ctx, 1);
    // Hooves on a dirt track: a dull thud, and the dirt kicked up.
    input.connect(lowpass(ctx, 320)).connect(amp(ctx, 1)).connect(dull);
    input.connect(bandpass(ctx, 1700, 1.1)).connect(amp(ctx, 0.6)).connect(dull);
    const stride = GALLOP_STRIDE * rnd(0.93, 1.07);
    return {
      out,
      input,
      level: new Knob(level.gain, 0.12),
      pan: new Knob(pan.pan, 0.1),
      dull: new Knob(dull.frequency, 0.12),
      pattern: gallopPattern(stride),
      phase: t + rnd(0, stride),
      schedT: t,
      gain: 0,
      sources: [],
    };
  }

  private pumpHorses(g: Graph, horizon: number): void {
    const now = g.ctx.currentTime;
    for (const h of this.horses) {
      if (h.schedT < now) h.schedT = now + START_DELAY;
      h.sources = h.sources.filter((s) => s.end > now);
      if (horizon <= h.schedT) continue;
      if (h.gain > 0.01) for (const ev of patternEvents(h.pattern, h.schedT - h.phase, 1, h.schedT, horizon)) this.hoof(g, h, ev.t, ev.i);
      h.schedT = horizon;
    }
  }

  private hoof(g: Graph, h: HorseSlot, t: number, i: number): void {
    const { ctx } = g;
    const a = HOOF_ACCENTS[i % HOOF_ACCENTS.length] * rnd(0.8, 1.12);
    const end = t + 0.12;
    const thud = amp(ctx, 0);
    perc(thud.gain, t, a, 0.006, rnd(0.07, 0.1));
    noise(ctx, g.brown, t, end, h.sources).connect(thud).connect(h.input);
    const dirt = amp(ctx, 0);
    perc(dirt.gain, t, a * 0.5, 0.002, rnd(0.025, 0.045));
    noise(ctx, g.white, t, end, h.sources).connect(dirt).connect(h.input);
  }

  // ---- Internals: the whistle -------------------------------------------------------------------------

  private syncWhistle(): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    const listener = this.whistleListener;
    const w = this.whistleVoice;
    if (this.whistleWant && this.ready) {
      if (!w) this.whistleVoice = this.startWhistle(g, listener);
      else {
        if (!w.on) this.attackWhistle(g, w, now + START_DELAY);
        w.level.set(whistleLevel(listener), now);
        w.lp.set(whistleHz(listener), now);
      }
    } else if (w) {
      if (w.on) this.releaseWhistle(w, now);
      else if (now - w.releasedAt >= WHISTLE_HOLD) {
        release(g.ctx, w.loop, 0.03);
        this.whistleVoice = null;
      }
    }
    this.syncTimer();
  }

  private startWhistle(g: Graph, listener: Listener): WhistleVoice {
    const { ctx } = g;
    const t = ctx.currentTime + START_DELAY;
    const sources: Voice[] = [];
    const out = amp(ctx, 1);
    out.connect(g.fx);
    const level = amp(ctx, whistleLevel(listener));
    level.connect(out);
    const lp = lowpass(ctx, whistleHz(listener));
    lp.connect(level);
    const env = amp(ctx, 0);
    env.connect(lp);
    const sum = amp(ctx, 1);
    sum.connect(env);
    // Steam never blows quite steady: a quick waver and a slow wander in pitch, shared by every chime.
    const vibrato = amp(ctx, 6);
    tone(ctx, 'sine', rnd(4.8, 5.8), t, undefined, sources).connect(vibrato);
    const wander = amp(ctx, 5);
    tone(ctx, 'sine', rnd(0.5, 0.9), t, undefined, sources).connect(wander);
    const white = noise(ctx, g.white, t, undefined, sources);
    const notes = WHISTLE_CHORD.map(([hz0, a]) => {
      const hz = hz0 * 2 ** (rnd(-4, 4) / 1200);
      const osc = tone(ctx, 'triangle', hz * WHISTLE_BEND, t, undefined, sources);
      vibrato.connect(osc.detune);
      wander.connect(osc.detune);
      osc.connect(amp(ctx, a * 0.2)).connect(sum);
      // Breath: the air in each chime's pipe.
      white
        .connect(bandpass(ctx, hz, 28))
        .connect(amp(ctx, a * 0.05 * bandNorm(ctx, hz / 28)))
        .connect(sum);
      return { osc, hz };
    });
    white.connect(highpass(ctx, 1800)).connect(amp(ctx, 0.02)).connect(sum);
    const v: WhistleVoice = {
      loop: { out, sources },
      env,
      post: lp,
      level: new Knob(level.gain),
      lp: new Knob(lp.frequency),
      notes,
      on: false,
      releasedAt: 0,
    };
    this.attackWhistle(g, v, t);
    return v;
  }

  /** The valve opens: the chord swells in, slurring up from flat, with a spit of steam. */
  private attackWhistle(g: Graph, v: WhistleVoice, t: number): void {
    const { ctx } = g;
    v.on = true;
    v.env.gain.setTargetAtTime(1, t, 0.035);
    for (const { osc, hz } of v.notes) {
      osc.frequency.setTargetAtTime(hz * WHISTLE_BEND, t, 0.004);
      osc.frequency.setTargetAtTime(hz, t + 0.02, 0.09);
    }
    v.loop.sources = v.loop.sources.filter((s) => s.end > ctx.currentTime);
    perc(noiseLayer(ctx, g.white, highpass(ctx, 1500), t, t + 0.25, v.post, v.loop.sources).gain, t, 0.12, 0.004, 0.18);
  }

  /** The valve closes: the chord dies away, sagging as the pressure drops. */
  private releaseWhistle(v: WhistleVoice, now: number): void {
    v.on = false;
    v.releasedAt = now;
    v.env.gain.setTargetAtTime(0, now, 0.07);
    for (const { osc, hz } of v.notes) osc.frequency.setTargetAtTime(hz * 0.965, now, 0.12);
  }

  // ---- Internals: pieces of one-shots -----------------------------------------------------------------

  /** A gunshot's nodes; returns the audio time its tail ends. */
  private gunshot(g: Graph, t: number, gun: Gun, place: { pan: number; gain: number; cutoffHz: number }, muffled: boolean): number {
    const { ctx } = g;
    const r = rnd(0.94, 1.06);
    const dry = amp(ctx, 1);
    const wet = amp(ctx, 1);
    // The muzzle: crack, blast and boom, gently saturated so the peak is squeezed rather than clipped.
    const muzzle = amp(ctx, 0.6);
    const sat = ctx.createWaveShaper();
    sat.curve = CURVE_WARM;
    muzzle.connect(sat).connect(amp(ctx, 1.4)).connect(dry);
    perc(noiseLayer(ctx, g.white, highpass(ctx, gun.crackHz * r), t, t + 0.05, muzzle).gain, t, gun.crack, 0.0002, gun.crackDecay);
    perc(
      noiseLayer(ctx, g.white, bandpass(ctx, gun.bodyHz * r, gun.bodyQ), t, t + gun.bodyDecay + 0.05, muzzle).gain,
      t,
      gun.body * bandNorm(ctx, (1.6 * gun.bodyHz) / gun.bodyQ),
      0.0006,
      gun.bodyDecay,
    );
    const boom = amp(ctx, 0);
    const o = tone(ctx, 'sine', gun.boomFrom * r, t, perc(boom.gain, t, gun.boom, 0.001, gun.boomDecay));
    glide(o.frequency, t, [
      [0, gun.boomFrom * r],
      [gun.boomDecay * 0.6, gun.boomTo * r],
    ]);
    o.connect(boom).connect(muzzle);
    perc(noiseLayer(ctx, g.brown, lowpass(ctx, 260), t, t + gun.boomDecay + 0.05, muzzle).gain, t, gun.thump, 0.002, gun.boomDecay * 0.8);
    // The land answering: a rolling tail, and echoes off canyon walls.
    const tailEnd = t + gun.tailDecay + 0.05;
    const roll = amp(ctx, 0.75);
    tone(ctx, 'sine', rnd(5, 9), t, tailEnd).connect(amp(ctx, 0.25)).connect(roll.gain);
    roll.connect(wet);
    const nTail = bandNorm(ctx, gun.tailHz);
    swell(noiseLayer(ctx, g.white, lowpass(ctx, gun.tailHz), t, tailEnd, roll).gain, t, gun.tail * nTail, 0.015, 0.015, gun.tailDecay);
    let end = tailEnd;
    for (const [delay, a, decay] of gun.echoes) {
      const at = t + delay * rnd(0.9, 1.1);
      end = Math.max(end, perc(noiseLayer(ctx, g.white, bandpass(ctx, 800, 0.7), at, at + decay + 0.05, wet).gain, at, a * bandNorm(ctx, 1800), 0.004, decay));
    }
    if (muffled) {
      // Through the cab's walls: the crack is gone, the boom comes through, and the land answers faintly.
      const level = amp(ctx, LEVEL.muffled * gun.level * place.gain);
      const walls = lowpass(ctx, place.cutoffHz);
      dry.connect(walls);
      wet.connect(amp(ctx, 0.6)).connect(walls);
      walls.connect(lowpass(ctx, place.cutoffHz)).connect(level).connect(g.fx);
    } else {
      // Far shots are duller, and more echo than bang.
      const distant = lowpass(ctx, place.cutoffHz);
      dry.connect(amp(ctx, place.gain)).connect(distant);
      wet.connect(amp(ctx, Math.sqrt(place.gain))).connect(distant);
      distant.connect(amp(ctx, gun.level)).connect(panner(ctx, place.pan)).connect(g.fx);
    }
    return end + 0.05;
  }

  /** Colt-style: the loading gate opens, the empties are punched out, the cylinder clicks round for six rounds, the gate shuts. */
  private revolverReload(g: Graph, out: AudioNode, t: number, d: number): void {
    const { ctx } = g;
    tick(ctx, g.white, out, t, 2600, 0.8);
    const slide = t + 0.1 * d;
    perc(noiseLayer(ctx, g.white, bandpass(ctx, 2200, 2), slide, slide + 0.1, out).gain, slide, 0.35 * bandNorm(ctx, 1100), 0.004, 0.05);
    for (const at of [t + 0.16 * d, t + 0.2 * d]) {
      const brass = amp(ctx, 0.25);
      brass.connect(out);
      modal(ctx, brass, at, rnd(5200, 6400), COIN_MODES, 0.5);
    }
    for (let k = 0; k < 6; k++) tick(ctx, g.white, out, t + (0.3 + 0.1 * k) * d, 3100, 0.55);
    tick(ctx, g.white, out, t + 0.92 * d, 2200, 0.9);
  }

  /** Coach gun: the top lever and the barrels breaking open, the empties popping out, two shells thumbed in, and the snap shut. */
  private shotgunReload(g: Graph, out: AudioNode, t: number, d: number): void {
    const { ctx } = g;
    tick(ctx, g.white, out, t, 1800, 0.6);
    const hinge = amp(ctx, 0.4);
    hinge.connect(out);
    modal(ctx, hinge, t + 0.03, 420, CLANK_MODES, 0.4);
    const pop = t + 0.12 * d;
    const pok = amp(ctx, 0);
    const o = tone(ctx, 'sine', 700, pop, perc(pok.gain, pop, 0.4, 0.001, 0.03));
    glide(o.frequency, pop, [
      [0, 700],
      [0.03, 300],
    ]);
    o.connect(pok).connect(out);
    for (const at of [t + 0.2 * d, t + 0.26 * d]) {
      const shell = amp(ctx, 0.3);
      shell.connect(out);
      modal(ctx, shell, at, rnd(650, 800), CLANK_MODES, 0.25);
    }
    for (const at of [t + 0.45 * d, t + 0.65 * d]) {
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 500), at, at + 0.1, out).gain, at, 0.4 * bandNorm(ctx, 550), 0.002, 0.04);
      const thunk = amp(ctx, 0.5);
      thunk.connect(out);
      modal(ctx, thunk, at, 380, ROD_MODES, 0.8);
    }
    const shut = t + 0.9 * d;
    const clack = amp(ctx, 0.5);
    clack.connect(out);
    modal(ctx, clack, shut, 520, CLANK_MODES, 0.5);
    perc(noiseLayer(ctx, g.white, bandpass(ctx, 2000, 1.2), shut, shut + 0.05, out).gain, shut, 0.5 * bandNorm(ctx, 2700), 0.0003, 0.015);
  }

  /** Winchester: rounds pressed one by one through the spring gate, then the lever worked down and back up. */
  private rifleReload(g: Graph, out: AudioNode, t: number, d: number): void {
    const { ctx } = g;
    for (let k = 0; k < 5; k++) {
      const at = t + (0.06 + 0.15 * k) * d;
      tick(ctx, g.white, out, at, 2900, 0.55);
      perc(noiseLayer(ctx, g.white, lowpass(ctx, 700), at + 0.02, at + 0.08, out).gain, at + 0.02, 0.25 * bandNorm(ctx, 770), 0.002, 0.03);
    }
    const down = t + 0.8 * d;
    tick(ctx, g.white, out, down, 1300, 0.7);
    perc(noiseLayer(ctx, g.white, bandpass(ctx, 1800, 2), down, down + 0.1, out).gain, down, 0.3 * bandNorm(ctx, 900), 0.004, 0.05);
    const up = t + 0.9 * d;
    const clack = amp(ctx, 0.6);
    clack.connect(out);
    modal(ctx, clack, up, 1000, CLANK_MODES, 0.35);
    tick(ctx, g.white, out, up, 2400, 0.8);
  }

  /** The sounder's armature: falling onto the anvil (a sharp click) or lifting back to its stop (a softer clack). */
  private sounder(g: Graph, out: AudioNode, t: number, down: boolean): void {
    const { ctx } = g;
    tick(ctx, g.white, out, t, down ? 1900 : 1400, down ? 0.8 : 0.45);
    perc(noiseLayer(ctx, g.white, bandpass(ctx, down ? 900 : 700, 3), t, t + 0.05, out).gain, t, (down ? 0.4 : 0.25) * bandNorm(ctx, 280), 0.001, 0.02);
  }

  /** A guitar's body: warm low-pass and an envelope that closes the ring-out at `len` s. */
  private guitar(g: Graph, out: AudioNode, t: number, len: number): AudioNode {
    const { ctx } = g;
    const env = amp(ctx, 1);
    env.gain.setValueAtTime(1, t + len - 0.45);
    env.gain.linearRampToValueAtTime(0, t + len);
    const warm = lowpass(ctx, 3800);
    warm.connect(env).connect(out);
    return warm;
  }

  /** A strum: each string plucked a moment after the last (down, low to high). */
  private strum(g: Graph, out: AudioNode, t: number, notes: readonly number[], level: number, stop: number): void {
    const { ctx } = g;
    notes.forEach((f, i) => {
      const s = ctx.createBufferSource();
      s.buffer = g.pluck;
      s.playbackRate.value = f / PLUCK_HZ;
      s.connect(amp(ctx, level * (1 - 0.04 * i))).connect(out);
      s.start(t + i * 0.014 * rnd(0.8, 1.2));
      s.stop(stop);
    });
  }

  private warn(what: string, err: unknown): void {
    if (import.meta.env.DEV) console.warn(`[sfx] ${what}:`, err);
  }
}

/** Far hooves are duller: the cutoff (Hz) of a low-pass for a horse at `gain` (by distance). */
function hoofCutoff(gain: number): number {
  return 600 + 7400 * gain * gain;
}

function whistleLevel(listener: Listener): number {
  return LEVEL.whistle * (listener === 'cab' ? 1 : 0.55);
}

function whistleHz(listener: Listener): number {
  return listener === 'cab' ? 7500 : 3600;
}
