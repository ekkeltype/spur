// Synthesized sound (spec §18.3). STUB: the API is the contract between the apps and the audio
// engine; the audio milestone replaces the body, keeping the API. Every method is safe to call
// before unlock() and never throws.

import type { Weapon } from '../sim/types';

/** Who is listening: the Rider outside on the train, or the Engineer in the cab. */
export type Listener = 'rider' | 'cab';

export class Sfx {
  constructor(_ctxFactory?: () => BaseAudioContext) {}

  /** Starts audio on the first user gesture. */
  unlock(): void {}
  setVolumes(_master: number, _effects: number): void {}
  /** Silences every sound and continuous layer (leaving a screen). */
  stopAll(): void {}

  // ---- Continuous layers: call every frame with the current values ----------------------------
  /** The locomotive: chuff rate follows speed, loudness follows throttle; null stops it. */
  engine(_p: { speed: number; throttle: number; tunnel: boolean; listener: Listener } | null): void {}
  /** Wind over the roof, 0..1. */
  wind(_level: number): void {}
  /** Brake squeal, 0..1 (0 = none). */
  brakes(_level: number): void {}
  safetyValve(_on: boolean): void {}
  water(_on: boolean): void {}
  /** Galloping horses: one entry per horse, pan −1..1, gain 0..1. */
  gallop(_horses: { pan: number; gain: number }[]): void {}
  whistle(_on: boolean, _listener: Listener): void {}

  // ---- One-shots ------------------------------------------------------------------------------
  shot(_weapon: Weapon | 'bandit', _opts?: { pan?: number; gain?: number; muffled?: boolean }): void {}
  ricochet(_pan?: number): void {}
  /** A near miss past the Rider's head. */
  whiz(_pan?: number): void {}
  /** The Rider is hit. */
  hurt(): void {}
  /** The Rider's shot hit someone. */
  hitMarker(): void {}
  reload(_weapon: Weapon): void {}
  dryFire(): void {}
  jump(): void {}
  land(_hard: boolean): void {}
  /** Knocked down or off. */
  thud(): void {}
  explosion(_big: boolean): void {}
  /** A wreck: collision, derailment, obstacle. */
  crash(): void {}
  tunnel(_enter: boolean): void {}
  telegraph(): void {}
  switchThrow(): void {}
  lever(): void {}
  bell(): void {}
  /** A station stop or checkpoint completed. */
  chime(): void {}
  /** Payout on the results screen. */
  cash(): void {}
  /** Held up, or the loot is stolen. */
  alarm(): void {}
  win(): void {}
  lose(): void {}
  uiClick(): void {}
}
