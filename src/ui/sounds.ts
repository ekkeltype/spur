// What each seat hears (spec §18.3). The Rider is outside on the train: shots, wind, the engine
// ahead, horses alongside. The Engineer is in the cab: the engine, the whistle, levers, and gunfire
// only as a muffled report from outside, never anything positional about bandits (spec §2). Sfx does
// the synthesis (see the header of src/audio/sfx.ts for its contract); this maps game events and
// state onto it. In local test mode only the Rider's set plays, since there's one set of speakers.
//
// Round 2: in a ford the Rider hears the river rushing round the train, loudest where the train is
// wet nearest them and panned there, and splashes as the loco ploughs in or someone is washed off;
// the lurch's clank and the brakes biting; a horse whinnying as it shies; cattle far ahead lowing
// (they heard the whistle too soon) or bellowing as they bolt; a grunt when the Rider is thrown. In
// the cab the ford is under the footplate, muffled, from the loco wading in until the cab is out,
// and the Engineer hears the lurch they caused.

import type { Sfx } from '../audio/sfx';
import { framePath, frameX, netIndex } from '../sim/network';
import { CAB_LENGTH, CAR_SPECS, EMERGENCY_BRAKE, LURCH_COOLDOWN_SECONDS, LURCH_MIN_SPEED, QUICK_RELOAD_FACTOR, TICK_HZ, TIME_SCALE, WEAPONS, WIND_MAX, WIND_REF_SPEED } from '../sim/rules';
import type { EngineerCmdBody, EngineerEvent, EngineerView, GameState, LossReason, RiderState, RunDef, SimEvent, SurfaceKind, Weapon } from '../sim/types';
import { trackside } from '../sim/views';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Losses that are a wreck; the others have their own sound (an explosion, a theft, the trestle going). */
const WRECKS: ReadonlySet<LossReason> = new Set(['collision', 'derailed', 'obstacle', 'buffers']);

/** Horsemen still in the fight (not shot off, not gone). */
const LIVE_HORSEMEN = new Set(['waiting', 'approach', 'pace', 'boarding', 'retreat']);

/** Where the Rider stands out in the wind at full strength; platforms and ladders get about half. */
const TOP_SURFACES: ReadonlySet<SurfaceKind> = new Set(['roof', 'tenderTop', 'cabRoof', 'cupola']);
const HALF_WIND_SURFACES: ReadonlySet<SurfaceKind> = new Set(['platform', 'tenderDeck']);

/** Horses are heard within this many metres, fading with distance (Sfx's gallop contract). */
const GALLOP_RANGE = 60;
/** A bullet passing this close to the Rider's head is a near miss (a whiz). */
const WHIZ_DISTANCE = 1.2;
/** The Rider's head, above the feet. */
const HEAD_Y = 1.55;
/** A ford is heard this far ahead of the loco before it wades in (m). */
export const FORD_HEARD_AHEAD = 30;
/** The river churns hardest at this speed and above (m/s). */
const FORD_CHURN_SPEED = 14;
/** The cab's middle is this far behind the loco's front (m): it's still in the water that long after the front is out. */
export const CAB_BEHIND_FRONT = CAR_SPECS.loco.length - CAB_LENGTH / 2;
/** A herd is heard fading over this distance (m); cattle low loud, and far. */
const HERD_RANGE = 900;

/** The train-frame x at the left and right edges of the Rider's view, for panning by screen position. */
export interface ViewSpan {
  left: number;
  right: number;
}

/** Stereo position −1..1 of train-frame x: its place across the view, or its offset from the Rider without one. */
export function panOf(x: number, view: ViewSpan | null, riderX: number): number {
  if (view && view.right - view.left > 1) return clamp(((x - view.left) / (view.right - view.left)) * 2 - 1, -1, 1);
  return clamp((x - riderX) / 30, -1, 1);
}

/** Loudness with distance: full within 10 m, fading to `floor` by 90 m. */
export function gainFrom(fromX: number, x: number, floor = 0): number {
  return clamp(1 - (Math.abs(x - fromX) - 10) / 80, floor, 1);
}

/** Wind on the Rider 0..1 (spec §6.3's w, normalised): full on top, about half on platforms and ladders, none inside. */
export function windLevel(r: Pick<RiderState, 'mode' | 'inside' | 'surface' | 'ladder'>, speed: number): number {
  if (r.mode !== 'active' || r.inside !== null || r.surface === 'floor' || r.surface === 'cabFloor') return 0;
  const w = Math.min(WIND_MAX, (speed / WIND_REF_SPEED) ** 2) / WIND_MAX;
  if (r.surface !== null && HALF_WIND_SURFACES.has(r.surface)) return w * 0.5;
  if (r.surface === null && r.ladder !== null) return w * 0.5;
  return r.surface === null || TOP_SURFACES.has(r.surface) ? w : 0;
}

/** Brake squeal: the lever, faded in as the wheels turn (it screeches past the emergency notch). */
export function brakeLevel(brake: number, speed: number): number {
  return clamp(brake, 0, 1) * Math.min(1, Math.abs(speed) / 1.5);
}

/**
 * The ford's river for the Rider at `riderX` on a train `length` long running at `speed` (train-frame
 * fords [x0, x1]): how loud (0..1) and where along the train it's heard from. In a ford, the water
 * nearest the Rider, churning harder the faster the train ploughs through; just ahead of the loco,
 * the river faintly, coming up. Level 0 when there's none.
 */
export function fordLevel(riderX: number, length: number, fords: readonly { x0: number; x1: number }[], speed: number): { level: number; x: number } {
  let best = 0;
  let bx = riderX;
  const churn = 0.45 + 0.55 * Math.min(1, Math.abs(speed) / FORD_CHURN_SPEED);
  for (const f of fords) {
    const a = Math.max(0, f.x0);
    const b = Math.min(length, f.x1);
    let level = 0;
    let x = riderX;
    if (b > a) {
      x = clamp(riderX, a, b);
      level = churn * gainFrom(riderX, x, 0.15);
    } else if (f.x0 >= length && f.x0 - length < FORD_HEARD_AHEAD) {
      x = f.x0;
      level = 0.3 * (1 - (f.x0 - length) / FORD_HEARD_AHEAD) * gainFrom(riderX, x, 0.15);
    }
    if (level > best) {
      best = level;
      bx = x;
    }
  }
  return { level: best, x: bx };
}

/** A herd `distance` metres from the Rider: how loud its lowing is (cattle carry far over the plain). */
export function herdGain(distance: number): number {
  return clamp(1 - Math.abs(distance) / HERD_RANGE, 0.3, 1);
}

/** Distance from point (px, py) to the segment (x0, y0)–(x1, y1). */
function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - x0) * dx + (py - y0) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

function reloadSeconds(weapon: Weapon, upgrades: readonly string[]): number {
  return WEAPONS[weapon].reload * (upgrades.includes('quickReload') ? QUICK_RELOAD_FACTOR : 1);
}

export class RiderSounds {
  private layersOn = false;
  /** The run last heard (frame() is told it; a herd's place needs it). */
  private run: RunDef | null = null;
  private readonly fords: { x0: number; x1: number }[] = [];

  constructor(private sfx: Sfx) {}

  /** One tick's events. `view` is the Rider's view across the train frame, for panning. */
  events(events: readonly SimEvent[], state: GameState, view: ViewSpan | null): void {
    const sfx = this.sfx;
    const r = state.rider;
    let crashed = false;
    for (const e of events) {
      switch (e.type) {
        case 'shot': {
          if (e.by === 'rider') {
            sfx.shot(e.weapon);
            if (e.hit === 'bandit' || e.hit === 'horseman') sfx.hitMarker();
          } else {
            sfx.shot('bandit', { pan: panOf(e.x0, view, r.x), gain: gainFrom(r.x, e.x0, 0.3) });
            if (e.hit === 'none' && r.mode === 'active' && segmentDistance(r.x, r.y + HEAD_Y, e.x0, e.y0, e.x1, e.y1) < WHIZ_DISTANCE) {
              sfx.whiz(panOf(e.x0, view, r.x));
            }
          }
          if (e.hit === 'car') sfx.ricochet(panOf(e.x1, view, r.x));
          break;
        }
        case 'riderHurt':
          sfx.hurt();
          if (e.cause === 'bridge' || e.cause === 'fall') sfx.thud();
          // Washed off: into the river (riderOff says so too; the splash plays once).
          else if (e.cause === 'water') sfx.splash(false);
          else if (e.cause === 'fire') sfx.flare();
          break;
        case 'reload':
          sfx.reloadFor(e.weapon, reloadSeconds(e.weapon, state.upgrades));
          break;
        case 'dryFire':
          sfx.dryFire();
          break;
        case 'jump':
          sfx.jump();
          break;
        case 'land':
          sfx.land(e.hard);
          break;
        case 'riderOff':
          if (e.cause === 'water') sfx.splash(false);
          else sfx.thud();
          break;
        case 'banditKnockedOff': {
          if (e.cause !== 'water') {
            sfx.thud();
            break;
          }
          const b = state.bandits.find((x) => x.id === e.id);
          const x = b ? b.x : r.x;
          sfx.splash(false, { pan: panOf(x, view, r.x), gain: gainFrom(r.x, x, 0.3) });
          break;
        }
        case 'fordEnter': {
          // The loco ploughing in, up at the front.
          const x = state.train.length;
          sfx.splash(true, { pan: panOf(x, view, r.x), gain: gainFrom(r.x, x, 0.35) });
          break;
        }
        case 'lurch':
          sfx.lurch('rider');
          break;
        case 'horseShy': {
          const h = state.horsemen.find((x) => x.id === e.id);
          if (h) sfx.whinny(panOf(h.x, view, r.x), Math.max(0.25, 1 - Math.abs(h.x - r.x) / GALLOP_RANGE));
          break;
        }
        case 'thrown':
          if (e.who === 'rider') sfx.grunt();
          break;
        case 'cattleCalm':
        case 'cattleScatter': {
          // Far ahead, off the right of the view, unless the herd can be placed nearer.
          const x = this.herdX(state, e.id);
          sfx.cattle(e.type === 'cattleScatter', x === null ? 1 : panOf(x, view, r.x), herdGain(x === null ? HERD_RANGE / 2 : x - r.x));
          break;
        }
        case 'obstacleHit':
          if (!e.severe) sfx.thud();
          break;
        case 'explosion':
          sfx.explosion(e.what === 'boiler' || e.what === 'powder');
          break;
        case 'collision':
          if (!crashed) sfx.crash();
          crashed = true;
          break;
        case 'lost':
          if (WRECKS.has(e.reason) && !crashed) sfx.crash();
          crashed = true;
          sfx.lose();
          break;
        case 'won':
          sfx.win();
          break;
        case 'stationArrived':
          sfx.bell();
          break;
        case 'stationDone':
        case 'checkpoint':
          sfx.chime();
          break;
        case 'heldUp':
        case 'lootStolen':
          sfx.alarm();
          break;
        case 'tunnelEnter':
          sfx.tunnel(true);
          break;
        case 'tunnelExit':
          sfx.tunnel(false);
          break;
        case 'switchThrown':
          sfx.switchThrow();
          break;
        default:
          break;
      }
    }
  }

  /** The continuous layers, every frame. `live` is false while paused: everything falls quiet. */
  frame(state: GameState, run: RunDef, live: boolean, view: ViewSpan | null): void {
    this.run = run;
    if (!live) {
      this.stop();
      return;
    }
    const sfx = this.sfx;
    const t = state.train;
    const r = state.rider;
    const speed = Math.abs(t.v);
    let tunnel = false;
    this.fords.length = 0;
    for (const item of trackside(state, run, 2, FORD_HEARD_AHEAD)) {
      if (item.kind === 'tunnel' && r.mode === 'active' && r.x >= item.x0 && r.x <= item.x1) tunnel = true;
      else if (item.kind === 'ford') this.fords.push({ x0: item.x0, x1: item.x1 });
    }
    // The beats and clicks keep the wall clock's pace: the world runs TIME_SCALE times it.
    sfx.engine({ speed: speed * TIME_SCALE, throttle: t.throttle, tunnel, listener: 'rider' });
    sfx.wind(windLevel(r, speed));
    sfx.brakes(brakeLevel(t.brake, t.v));
    sfx.safetyValve(t.safetyValve);
    sfx.water(t.spout === 'down' && t.water < t.waterCap - 0.01);
    const ford = fordLevel(r.x, t.length, this.fords, speed);
    sfx.fordWater(ford.level, { pan: ford.level > 0 ? panOf(ford.x, view, r.x) : 0, listener: 'rider' });
    sfx.whistle(t.whistle, 'rider');
    // One slot per horse, kept in id order so each keeps its own hoofbeats (Sfx matches by position).
    sfx.gallop(
      state.horsemen
        .filter((hm) => LIVE_HORSEMEN.has(hm.mode))
        .sort((a, b) => a.id - b.id)
        .slice(0, 8)
        .map((hm) => ({ pan: panOf(hm.x, view, r.x), gain: Math.max(0, 1 - Math.abs(hm.x - r.x) / GALLOP_RANGE) })),
    );
    this.layersOn = true;
  }

  stop(): void {
    if (!this.layersOn) return;
    this.layersOn = false;
    const sfx = this.sfx;
    sfx.engine(null);
    sfx.wind(0);
    sfx.brakes(0);
    sfx.safetyValve(false);
    sfx.water(false);
    sfx.fordWater(0);
    sfx.whistle(false, 'rider');
    sfx.gallop([]);
  }

  /** A herd's train-frame x (ahead of the loco), or null if it can't be placed. */
  private herdX(state: GameState, id: string): number | null {
    const o = state.obstacles.find((x) => x.id === id);
    if (!o || !this.run) return null;
    try {
      const fp = framePath(netIndex(this.run), state.switches, state.train.spans, 0, HERD_RANGE);
      return frameX(fp, { edge: o.edge, off: o.at });
    } catch {
      return null;
    }
  }
}

/** Throttle and brake drags send a stream of commands; one lever sound per this many ms is plenty. */
const LEVER_SOUND_MS = 180;

/**
 * The cab: no hoofbeats and nothing positional about bandits, only muffled gunfire (spec §2). The ford
 * runs under the footplate from `fordEnter` until the cab is out, CAB_BEHIND_FRONT after `fordExit`.
 * The Engineer's events don't carry the lurch, so the cab hears it when the brake it sees crosses into
 * emergency at speed, by the sim's own rule (spec §5.2).
 */
export class CabSounds {
  private inTunnel = false;
  private inFord = false;
  /** Metres the loco still has to run, after leaving a ford, before the cab is out of the water. */
  private fordLeft = 0;
  private lastTick: number | null = null;
  /** The brake in the last view (Infinity before the first, so joining at full brake is no lurch). */
  private lastBrake = Number.POSITIVE_INFINITY;
  private lastLurch = Number.NEGATIVE_INFINITY;
  private lastLever = Number.NEGATIVE_INFINITY;
  private layersOn = false;

  constructor(private sfx: Sfx) {}

  event(e: EngineerEvent): void {
    const sfx = this.sfx;
    switch (e.type) {
      case 'gunfire':
        sfx.shot('bandit', { muffled: true, gain: clamp(e.intensity, 0, 1) });
        break;
      case 'telegram':
        sfx.telegraph();
        break;
      case 'stationArrived':
      case 'lowWater':
        sfx.bell();
        break;
      case 'stationDone':
      case 'checkpoint':
        sfx.chime();
        break;
      case 'heldUp':
      case 'lootStolen':
        sfx.alarm();
        break;
      case 'collision':
        sfx.crash();
        break;
      case 'lost':
        if (WRECKS.has(e.reason) && e.reason !== 'collision') sfx.crash();
        sfx.lose();
        break;
      case 'won':
        sfx.win();
        break;
      case 'switchThrown':
        sfx.switchThrow();
        break;
      case 'tunnelEnter':
        this.inTunnel = true;
        sfx.tunnel(true);
        break;
      case 'tunnelExit':
        this.inTunnel = false;
        sfx.tunnel(false);
        break;
      case 'fordEnter':
        this.inFord = true;
        this.fordLeft = 0;
        sfx.splash(true, { muffled: true, gain: 0.8 });
        break;
      case 'fordExit':
        this.inFord = false;
        this.fordLeft = CAB_BEHIND_FRONT;
        break;
      default:
        break;
    }
  }

  /** A lever the Engineer moved (the switch sound waits for the host to confirm the throw). */
  cmd(body: EngineerCmdBody, now: number): void {
    if (body.kind === 'switch' || body.kind === 'whistle') return;
    if ((body.kind === 'throttle' || body.kind === 'brake') && now - this.lastLever < LEVER_SOUND_MS) return;
    this.lastLever = now;
    this.sfx.lever();
  }

  frame(view: EngineerView | null, live: boolean): void {
    if (!live || !view) {
      this.stop();
      return;
    }
    const t = view.train;
    const speed = Math.abs(t.v);
    const dt = this.lastTick === null ? 0 : Math.max(0, view.tick - this.lastTick) / TICK_HZ;
    this.lastTick = view.tick;
    if (this.fordLeft > 0) this.fordLeft = Math.max(0, this.fordLeft - speed * dt);
    this.sfx.engine({ speed: speed * TIME_SCALE, throttle: t.throttle, tunnel: this.inTunnel, listener: 'cab' });
    this.sfx.whistle(t.whistle, 'cab');
    this.sfx.brakes(brakeLevel(t.brake, t.v));
    this.sfx.safetyValve(t.safetyValve);
    this.sfx.water(t.spout === 'down' && t.water < t.waterCap - 0.01);
    const wet = this.inFord || this.fordLeft > 0;
    this.sfx.fordWater(wet ? 0.5 + 0.5 * Math.min(1, speed / FORD_CHURN_SPEED) : 0, { listener: 'cab' });
    // The lurch the Engineer just caused: the lever into emergency at speed, at most once a cooldown.
    if (!t.heldUp && this.lastBrake < EMERGENCY_BRAKE && t.brake >= EMERGENCY_BRAKE && speed >= LURCH_MIN_SPEED && view.tick - this.lastLurch >= LURCH_COOLDOWN_SECONDS * TICK_HZ) {
      this.sfx.lurch('cab');
      this.lastLurch = view.tick;
    }
    this.lastBrake = t.brake;
    this.layersOn = true;
  }

  /** A new game: out of any tunnel or ford, no lurch remembered. */
  reset(): void {
    this.inTunnel = false;
    this.inFord = false;
    this.fordLeft = 0;
    this.lastTick = null;
    this.lastBrake = Number.POSITIVE_INFINITY;
    this.lastLurch = Number.NEGATIVE_INFINITY;
  }

  stop(): void {
    if (!this.layersOn) return;
    this.layersOn = false;
    this.sfx.engine(null);
    this.sfx.whistle(false, 'cab');
    this.sfx.brakes(0);
    this.sfx.safetyValve(false);
    this.sfx.water(false);
    this.sfx.fordWater(0, { listener: 'cab' });
  }
}
