// Motion helpers for the Rider's view: interpolation between sim ticks, and gait cycles driven by
// distance (so feet don't skate: a figure's legs cycle with how far it actually moved).

/**
 * One number sampled once per sim tick, drawn between the last two ticks. The view renders at
 * tick − 1 + alpha (spec §18.2: alpha is the fraction of a tick since the last step), so motion is
 * smooth at any frame rate at the cost of one tick of latency. When several ticks passed between
 * frames, the previous tick's value is estimated along the line from the last one seen.
 */
export class TickInterp {
  prev = 0;
  cur = 0;
  tick = Number.NaN;

  /** @param snap a jump larger than this (per tick) is a teleport: no interpolation across it. */
  constructor(readonly snap = Infinity) {}

  update(tick: number, value: number): void {
    if (tick === this.tick) {
      // The same tick again (the app may draw several frames per tick); the value may still have
      // been rewritten (a staged scene), in which case the newest wins.
      if (value !== this.cur) this.cur = value;
      return;
    }
    const n = tick - this.tick;
    if (!(n > 0) || Math.abs(value - this.cur) > this.snap * n) {
      this.prev = value;
    } else {
      this.prev = n === 1 ? this.cur : value - (value - this.cur) / n;
    }
    this.cur = value;
    this.tick = tick;
  }

  at(alpha: number): number {
    return this.prev + (this.cur - this.prev) * alpha;
  }

  reset(tick: number, value: number): void {
    this.prev = value;
    this.cur = value;
    this.tick = tick;
  }
}

/** Advances a gait phase (in cycles, [0, 1)) by a signed distance over the stride length. */
export function advancePhase(phase: number, dist: number, stride: number): number {
  const p = (phase + dist / stride) % 1;
  const r = p < 0 ? p + 1 : p;
  return Math.abs(r - 1) < 1e-12 ? 0 : r;
}

/**
 * Forward swing of one leg (radians from vertical, + = forward) at a gait phase. The other leg is
 * half a cycle away. Phase 0: legs passing each other; 0.25: this leg fully forward.
 */
export function legSwing(phase: number, amp: number): number {
  return amp * Math.sin(2 * Math.PI * phase);
}

/**
 * Knee bend (radians, ≥ 0) of a leg at a gait phase: the leg folds while it swings forward
 * (phase 0.75 → 1.25, i.e. from fully back to fully forward), and is straight while planted.
 */
export function kneeBend(phase: number, amp: number): number {
  const s = Math.cos(2 * Math.PI * phase);
  // cos > 0 on the forward swing half (phase −0.25..0.25); fold most as the leg passes under.
  return s > 0 ? amp * s * s : 0;
}

/**
 * The four legs of a horse at gallop phase (hind left, hind right, fore left, fore right), as
 * swing angles from vertical (radians, + = forward). A rotary gallop: the hinds land close
 * together, then the fores, then a moment of suspension with all four gathered.
 */
export function gallopLegs(phase: number): [number, number, number, number] {
  const leg = (offset: number, fwd: number, back: number): number => {
    const q = (((phase + offset) % 1) + 1) % 1;
    // A sharp stance sweep (forward → back) for 40 % of the cycle, a quicker recovery for the rest.
    if (q < 0.4) return fwd + (back - fwd) * (q / 0.4);
    const r = (q - 0.4) / 0.6;
    const e = r * r * (3 - 2 * r);
    return back + (fwd - back) * e;
  };
  return [leg(0, 0.55, -0.6), leg(0.08, 0.55, -0.6), leg(0.42, 0.75, -0.45), leg(0.52, 0.75, -0.45)];
}
