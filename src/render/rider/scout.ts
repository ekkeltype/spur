// Scout alerts (round 3). Players found the spyglass kept them scanning ahead most of the time, so
// now a "!" comes up at the edge of the Rider's view when something down the line is worth a look,
// and the spyglass is for when there's a reason (spec §6.5).
//
// Worth a look: what the Rider has to spot and call, not the hazards the Engineer calls from the map
// (spec §2): an obstacle on the line (cattle, present or scattering; rocks; a barricade), horsemen
// waiting in ambush (spec §7.1), another train or the runaway on our own track, and a signal facing
// us at stop. Where: past the end the train runs toward (the loco's front, or the rear when backing),
// from the nearest point the spyglass's glass can show out to its reach now (scopeMaxFor), measured
// as the spyglass measures it. Anything nearer is in plain view, or about to be.
//
// Seen: once it has been in plain view, or in the glass for SEEN_SECONDS (so a sweep of the glass
// past it doesn't count). What's been seen is kept per game by stable keys. It's presentation state
// for the Rider's screen, so it lives here and never in the sim.

import type { HorsemanState, RiderState, TracksideItem } from '../../sim/types';

/** A thing counts as seen once it has been this long in the spyglass's glass (s). */
export const SEEN_SECONDS = 0.1;
/** Backing faster than this (m/s) turns the alert toward the rear… */
const BACKING = 0.3;
/** …and it turns ahead again once the train isn't backing faster than this (standing counts as ahead). */
const BACKING_DONE = 0.1;
/** Half the width (m) of what's drawn for each kind of thing: a herd or a barricade, a signal, a horse. */
const OBSTACLE_HALF = 4;
const SIGNAL_HALF = 1;
const HORSE_HALF = 1.5;

/** Something worth a look, as the alert sees it. */
export interface ScoutThing {
  /** Stable for the game: `o:` an obstacle, `h:` a horseman, `t:` a train, `g:` a signal, then its id. */
  key: string;
  /** Train-frame extent (m), x0 ≤ x1. */
  x0: number;
  x1: number;
}

/** A stretch of the train frame (m). */
export interface XRange {
  x0: number;
  x1: number;
}

/** One look at the line: where the train runs, what the spyglass reaches, what's on screen. */
export interface ScoutLook {
  /** Which way the train runs (runDir): 1 toward the loco's front, −1 backing. */
  dir: 1 | -1;
  /** The train's length: the loco's front is at x = length (spec §6.1). */
  length: number;
  /** How far past the end the train runs toward the spyglass's glass shows: from `near` out to `far`, its reach. */
  near: number;
  far: number;
  /** The normal view while it's on screen; null while the spyglass is up or moving. */
  view: XRange | null;
  /** What the spyglass's glass shows once it's up and settled; null otherwise. */
  glass: XRange | null;
  /** Seconds since the last look (0 while the game is paused). */
  dt: number;
}

/**
 * Which way the train runs for the alert: toward the rear once it's backing faster than BACKING, and
 * ahead again once it isn't backing faster than BACKING_DONE (a margin, so the badge doesn't flit
 * between edges as the train comes to a stand).
 */
export function runDir(v: number, prev: 1 | -1): 1 | -1 {
  if (v < -BACKING) return -1;
  if (v > -BACKING_DONE) return 1;
  return prev;
}

/**
 * The things worth a look in a trackside() scan and among the horsemen (spec §6.5), placed at render
 * time (`shift`, see Scene). Signals count only facing the way the train runs, and only at stop.
 * Fills and returns `out`.
 */
export function scoutThings(
  items: readonly TracksideItem[],
  horsemen: readonly Pick<HorsemanState, 'id' | 'x' | 'mode'>[],
  dir: 1 | -1,
  shift = 0,
  out: ScoutThing[] = [],
): ScoutThing[] {
  out.length = 0;
  const facing = dir === 1 ? 'toward' : 'away';
  for (const it of items) {
    if (it.kind === 'obstacle') {
      if (it.state === 'present' || it.state === 'scattering') out.push({ key: `o:${it.id}`, x0: it.x + shift - OBSTACLE_HALF, x1: it.x + shift + OBSTACLE_HALF });
    } else if (it.kind === 'train') {
      if (it.lane === 'same') out.push({ key: `t:${it.id}`, x0: it.x0 + shift, x1: it.x1 + shift });
    } else if (it.kind === 'signal') {
      if (it.aspect === 'stop' && it.facing === facing) out.push({ key: `g:${it.id}`, x0: it.x + shift - SIGNAL_HALF, x1: it.x + shift + SIGNAL_HALF });
    }
  }
  // Waiting horsemen stand still beside the line, so they move in the train frame like the scan's items.
  for (const h of horsemen) if (h.mode === 'waiting') out.push({ key: `h:${h.id}`, x0: h.x + shift - HORSE_HALF, x1: h.x + shift + HORSE_HALF });
  return out;
}

/** The badge's edge (1 right, −1 left) when the Rider can see it: on the train and not at the spyglass. */
export function badgeSide(side: -1 | 0 | 1, r: Pick<RiderState, 'mode' | 'scoped'>): -1 | 0 | 1 {
  return r.mode === 'active' && !r.scoped ? side : 0;
}

const overlaps = (t: XRange, r: XRange): boolean => t.x1 >= r.x0 && t.x0 <= r.x1;

/** What the Rider has seen this game, and whether anything worth a look is still out there. */
export class ScoutWatch {
  /** Where the badge goes: 1 the right edge (ahead of the loco), −1 the left (behind the rear, backing), 0 nowhere. */
  side: -1 | 0 | 1 = 0;
  /** Something came up at the last look that wasn't up at the one before (the badge pops). */
  fresh = false;
  private readonly seen = new Set<string>();
  /** Seconds each thing has spent in the glass so far. */
  private readonly glassed = new Map<string, number>();
  private up = new Set<string>();
  private next = new Set<string>();
  private game = '';
  private tick = -1;

  /** Starts afresh for a new game, or a game restored to an earlier tick: what's seen is kept per game. */
  forGame(id: string, tick: number): void {
    if (id !== this.game || tick < this.tick) {
      this.game = id;
      this.seen.clear();
      this.glassed.clear();
      this.up.clear();
      this.side = 0;
      this.fresh = false;
    }
    this.tick = tick;
  }

  hasSeen(key: string): boolean {
    return this.seen.has(key);
  }

  /** One look: marks what's been seen, and returns (and keeps in `side`) where the badge goes. */
  update(things: readonly ScoutThing[], look: ScoutLook): -1 | 0 | 1 {
    const { dir, length } = look;
    const next = this.next;
    next.clear();
    let fresh = false;
    for (const t of things) {
      if (!this.seen.has(t.key)) {
        if (look.view && overlaps(t, look.view)) this.seen.add(t.key);
        else if (look.glass && overlaps(t, look.glass)) {
          const g = (this.glassed.get(t.key) ?? 0) + Math.max(0, look.dt);
          this.glassed.set(t.key, g);
          if (g >= SEEN_SECONDS - 1e-9) this.seen.add(t.key);
        }
      }
      if (this.seen.has(t.key)) continue;
      // Its near and far ends, as distances past the end the train runs toward.
      const a = dir === 1 ? t.x0 - length : -t.x1;
      const b = dir === 1 ? t.x1 - length : -t.x0;
      if (b < look.near || a > look.far) continue;
      next.add(t.key);
      if (!this.up.has(t.key)) fresh = true;
    }
    this.next = this.up;
    this.up = next;
    this.fresh = fresh;
    this.side = next.size > 0 ? dir : 0;
    return this.side;
  }
}
