// What each seat hears (spec §18.3). The Rider is outside on the train: shots, wind, the engine
// ahead, horses alongside. The Engineer is in the cab: the engine, the whistle, levers, and gunfire
// only as a muffled report from outside, never anything positional about bandits (spec §2). Sfx does
// the synthesis (see the header of src/audio/sfx.ts for its contract); this maps game events and
// state onto it. In local test mode only the Rider's set plays, since there's one set of speakers.

import type { Sfx } from '../audio/sfx';
import { QUICK_RELOAD_FACTOR, WEAPONS, WIND_MAX, WIND_REF_SPEED } from '../sim/rules';
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
        case 'banditKnockedOff':
          sfx.thud();
          break;
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
    if (!live) {
      this.stop();
      return;
    }
    const sfx = this.sfx;
    const t = state.train;
    const r = state.rider;
    const speed = Math.abs(t.v);
    let tunnel = false;
    if (r.mode === 'active') {
      for (const item of trackside(state, run, 2, 2)) {
        if (item.kind === 'tunnel' && r.x >= item.x0 && r.x <= item.x1) tunnel = true;
      }
    }
    sfx.engine({ speed, throttle: t.throttle, tunnel, listener: 'rider' });
    sfx.wind(windLevel(r, speed));
    sfx.brakes(brakeLevel(t.brake, t.v));
    sfx.safetyValve(t.safetyValve);
    sfx.water(t.spout === 'down' && t.water < t.waterCap - 0.01);
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
    sfx.whistle(false, 'rider');
    sfx.gallop([]);
  }
}

/** Throttle and brake drags send a stream of commands; one lever sound per this many ms is plenty. */
const LEVER_SOUND_MS = 180;

/** The cab: no hoofbeats and nothing positional about bandits, only muffled gunfire (spec §2). */
export class CabSounds {
  private inTunnel = false;
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
    this.sfx.engine({ speed: Math.abs(t.v), throttle: t.throttle, tunnel: this.inTunnel, listener: 'cab' });
    this.sfx.whistle(t.whistle, 'cab');
    this.sfx.brakes(brakeLevel(t.brake, t.v));
    this.sfx.safetyValve(t.safetyValve);
    this.sfx.water(t.spout === 'down' && t.water < t.waterCap - 0.01);
    this.layersOn = true;
  }

  /** A new game: out of any tunnel. */
  reset(): void {
    this.inTunnel = false;
  }

  stop(): void {
    if (!this.layersOn) return;
    this.layersOn = false;
    this.sfx.engine(null);
    this.sfx.whistle(false, 'cab');
    this.sfx.brakes(0);
    this.sfx.safetyValve(false);
    this.sfx.water(false);
  }
}
