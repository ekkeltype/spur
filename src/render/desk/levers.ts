// The cab's levers as numbers (spec §5.2, §11): throttle notches, brake positions and zones, where a
// drag along a quadrant lands, and the throttle on lever commands (spec §16.1). Pure.

import { EMERGENCY_BRAKE } from '../../sim/rules';

// ---- Throttle -------------------------------------------------------------------------------------

/** Notches above closed (0): the sim's throttle is 0–1, the quadrant has 8 notches (spec §5.2). */
export const THROTTLE_NOTCHES = 8;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function throttleNotch(value: number): number {
  return Math.round(clamp01(value) * THROTTLE_NOTCHES);
}

export function notchThrottle(n: number): number {
  return Math.max(0, Math.min(THROTTLE_NOTCHES, Math.round(n))) / THROTTLE_NOTCHES;
}

/** One notch up (+1) or down (−1) from wherever the lever sits. */
export function stepThrottle(value: number, dir: 1 | -1): number {
  return notchThrottle(throttleNotch(value) + dir);
}

/** A drag along the quadrant, 0 = closed (bottom) … 1 = wide open (top), snapped to a notch. */
export function throttleFromFraction(f: number): number {
  return notchThrottle(clamp01(f) * THROTTLE_NOTCHES);
}

export function throttleToFraction(value: number): number {
  return throttleNotch(value) / THROTTLE_NOTCHES;
}

// ---- Brake ------------------------------------------------------------------------------------------

export type BrakeZone = 'release' | 'service' | 'emergency';

/** Release, then service up to EMERGENCY_BRAKE, then emergency above it (spec §5.2). */
export function brakeZone(value: number): BrakeZone {
  if (value <= 1e-6) return 'release';
  return value > EMERGENCY_BRAKE + 1e-6 ? 'emergency' : 'service';
}

const SERVICE_STEPS = 5;
/** Keyboard stops: release, five even service steps up to full service, then emergency. */
export const BRAKE_STEPS: readonly number[] = [
  0,
  ...Array.from({ length: SERVICE_STEPS }, (_, i) => Math.round(((i + 1) / SERVICE_STEPS) * EMERGENCY_BRAKE * 100) / 100),
  1,
];

/** The next keyboard stop above (+1) or below (−1) the lever, wherever a drag left it. */
export function brakeStep(value: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir > 0) return BRAKE_STEPS.find((s) => s > value + eps) ?? 1;
  for (let i = BRAKE_STEPS.length - 1; i >= 0; i--) if (BRAKE_STEPS[i] < value - eps) return BRAKE_STEPS[i];
  return 0;
}

/**
 * The brake quadrant, left to right: a release detent, the service range, a full-service detent
 * and the emergency notch. Fractions of the quadrant's length.
 */
export const BRAKE_QUADRANT = { releaseEnd: 0.08, serviceEnd: 0.76, emergencyStart: 0.84 } as const;

/** Where a drag along the brake quadrant (0 = left … 1 = right) sets the brake. */
export function brakeFromFraction(f: number): number {
  const q = BRAKE_QUADRANT;
  const x = clamp01(f);
  if (x <= q.releaseEnd) return 0;
  if (x >= q.emergencyStart) return 1;
  if (x >= q.serviceEnd) return EMERGENCY_BRAKE;
  const v = ((x - q.releaseEnd) / (q.serviceEnd - q.releaseEnd)) * EMERGENCY_BRAKE;
  return Math.max(0.01, Math.round(v * 100) / 100);
}

/** Where the handle sits on the quadrant for a brake value (inverse of brakeFromFraction). */
export function brakeToFraction(value: number): number {
  const q = BRAKE_QUADRANT;
  const zone = brakeZone(value);
  if (zone === 'release') return q.releaseEnd / 2;
  if (zone === 'emergency') return (q.emergencyStart + 1) / 2;
  return q.releaseEnd + (Math.min(value, EMERGENCY_BRAKE) / EMERGENCY_BRAKE) * (q.serviceEnd - q.releaseEnd);
}

// ---- The command throttle ----------------------------------------------------------------------------

/**
 * Continuous levers send at most one command per `intervalMs`, the last value wins and the final
 * value of a drag is always sent (spec §16.1). Pure: the caller passes the time and sends what
 * offer() and poll() return; dueAt() says when to poll next.
 */
export class CmdThrottle {
  private lastAt = -Infinity;
  private last: number | null = null;
  private pending: number | null = null;

  constructor(readonly intervalMs = 50) {}

  /** A new lever value at `now` (ms): the value to send now, or null (deferred, or unchanged). */
  offer(value: number, now: number): number | null {
    if (this.last !== null && value === this.last) {
      // Back where the last command left it: whatever was waiting is superseded.
      this.pending = null;
      return null;
    }
    if (now - this.lastAt >= this.intervalMs) return this.send(value, now);
    this.pending = value;
    return null;
  }

  /** The deferred value once it's due, or null. */
  poll(now: number): number | null {
    if (this.pending === null || now - this.lastAt < this.intervalMs) return null;
    const v = this.pending;
    this.pending = null;
    return this.send(v, now);
  }

  /** When the deferred value falls due (ms), or null if nothing is waiting. */
  dueAt(): number | null {
    return this.pending === null ? null : this.lastAt + this.intervalMs;
  }

  /** A new gesture: the lever may send the same value again (the host may have refused it). */
  reset(): void {
    this.last = null;
  }

  private send(value: number, now: number): number {
    this.lastAt = now;
    this.last = value;
    return value;
  }
}
