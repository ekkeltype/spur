// The Rider's side view (spec §18.2). The API (RiderFrame, RiderRenderer's constructor, draw,
// toTrainFrame, destroy) is the contract with the Rider's app (ui/host-app.ts).
//
// One frame:
//  1. Clocks: an animation clock that follows the sim (frozen while paused), and interpolation:
//     the view is drawn at tick − 1 + alpha, from the positions of the last two ticks (the train's
//     odometer, the Rider, every bandit, horseman and other train).
//  2. Events since the last frame become effects: tracers from each shooter's drawn muzzle, muzzle
//     flashes, hit puffs, aim glints, explosions, tumbles, dust, steam, shake.
//  3. The camera: 19 m of height, rail tops at 76 %, following the Rider with an eased lead in the
//     facing direction, or panned ahead to the spyglass point (the loco's front + scopeDist).
//  4. trackside() for everything around the train, then the layers back to front: sky, far mesas,
//     ground and mid hills, the track, structures, other trains, the train (the Rider's car cut
//     away), smoke, boarded bandits and the Rider, horsemen and dust, effects, tunnel rock and
//     bridges, lights, wind, and the HUD.

import { framePath, frameX, frontHead, mainPos, netIndex } from '../../sim/network';
import { BANDIT_TELEGRAPH, CAR_SPECS, HORSEMAN_TELEGRAPH, TICK_HZ } from '../../sim/rules';
import type { GameState, RunDef, SimEvent, SurfaceKind, TracksideItem } from '../../sim/types';
import { trackside } from '../../sim/views';
import { HiDpiCanvas } from '../canvas';
import { PALETTE } from '../palette';
import { approach, halfWidthM, makeCamera, placeCamera, screenX, screenY, worldX, worldY, type Camera } from './camera';
import { trainLook } from './cars';
import { Effects, L_BEHIND, L_FRONT, L_LANE, P_BLOOD, P_CHIP, P_DUST, P_EMBER, P_POWDER, P_SPARK, P_SPLINTER, P_STEAM, P_SMOKE } from './effects';
import { BOSS_HORSE, defaultPose, dollar, drawHorse, FigurePainter, HORSES, type Muzzle, type Pose } from './figures';
import { Hud } from './hud';
import { LitCache } from './materials';
import { advancePhase, TickInterp } from './motion';
import { hash01 } from './parallax';
import { FLOOR_Y, LANE_Y, Scenery } from './scenery';
import { clamp01, inTunnel, setScreen, setWorld, smoothstep, TAU, TUNNEL_CEILING, type Scene } from './scene';
import { skyAt } from './sky';
import { clearSprites, glowSprite } from './sprites';
import { beam, TracksidePainter, type AiDraw } from './trackside';
import { TrainPainter } from './train';

export interface RiderFrame {
  state: GameState;
  run: RunDef;
  /** Fraction of a tick since the last sim step, for interpolation (0..1). */
  alpha: number;
  /** ms, performance.now(). */
  now: number;
  /** Events the sim produced since the last frame (effects: tracers, flashes, dust…). */
  events: SimEvent[];
  settings: { screenShake: boolean; lampLetters: boolean };
  /** A prompt to show near the Rider ("E: lower the spout"), or null. */
  prompt: string | null;
  /** The game is paused or counting down: freeze animation clocks that follow the sim. */
  frozen: boolean;
  /** Optional: this tick's trackside() scan, if the caller already made one (else the renderer does). */
  items?: TracksideItem[];
  /** Optional (dev): label bandits and horsemen with their goal and mode. */
  debug?: boolean;
  /** Optional (dev): centre the camera on this train-frame x instead of following the Rider. */
  cameraX?: number;
}

/** Metres of track scanned behind the rear. */
const BEHIND = 80;
/** Camera lead in the facing direction (m), at most this fraction of the half-width. */
const LEAD_M = 4;
const LEAD_FRAC = 0.24;

interface FigAnim {
  ix: TickInterp;
  iy: TickInterp;
  phase: number;
  climb: number;
  lastX: number;
  lastY: number;
  speed: number;
  crouch: number;
  facing: 1 | -1;
  hp: number;
  hurtT: number;
  surface: SurfaceKind | null;
  muzzle: Muzzle;
  muzzleT: number;
  x: number;
  y: number;
  seen: number;
  raise: number;
}

interface HorseAnim {
  ix: TickInterp;
  phase: number;
  facing: 1 | -1;
  muzzle: Muzzle;
  muzzleT: number;
  x: number;
  seen: number;
  dustAcc: number;
  raise: number;
}

interface AiAnim {
  x0: TickInterp;
  x1: TickInterp;
  roll: number;
  seen: number;
}

function newFig(): FigAnim {
  return {
    ix: new TickInterp(3),
    iy: new TickInterp(3),
    phase: 0,
    climb: 0,
    lastX: Number.NaN,
    lastY: 0,
    speed: 0,
    crouch: 0,
    facing: 1,
    hp: -1,
    hurtT: -Infinity,
    surface: null,
    muzzle: { x: 0, y: 0 },
    muzzleT: -Infinity,
    x: 0,
    y: 0,
    seen: 0,
    raise: 0,
  };
}

export class RiderRenderer {
  private readonly hc: HiDpiCanvas;
  private readonly cam: Camera = makeCamera(1, 1, 0);
  private readonly scenery = new Scenery();
  private readonly side = new TracksidePainter();
  private readonly train = new TrainPainter();
  private readonly fx = new Effects();
  private readonly hud = new Hud();
  private readonly fig = new FigurePainter();
  private readonly lits = new LitCache();
  private destroyed = false;

  private t = 0;
  private lastNow = Number.NaN;
  private readonly odo = new TickInterp(60);
  private readonly rider: FigAnim = newFig();
  private readonly bandits = new Map<number, FigAnim>();
  private readonly horsemen = new Map<number, HorseAnim>();
  private readonly ais = new Map<string, AiAnim>();
  private readonly aiDraw: AiDraw[] = [];
  private riderHurtT = -Infinity;
  private scanFailed = false;

  private follow = Number.NaN;
  private lead = 0;
  private scope = 0;
  private chuffAcc = 0;
  private readonly shake = { x: 0, y: 0 };
  private readonly pose: Pose = defaultPose('rider');
  private readonly tunnels: number[] = [];
  private readonly gaps: number[] = [];
  private readonly s: Scene;
  /** Draw time of the last frame (ms), for the dev harness. */
  lastDrawMs = 0;
  /** Dev profiling: layer names to skip ('sky', 'far', 'ground', 'mid', 'near', 'track', 'back', 'train', 'fx', 'figures', 'horsemen', 'front', 'lights', 'hud'). */
  devSkip: ReadonlySet<string> = new Set();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.hc = new HiDpiCanvas(canvas);
    const lit = this.lits.get(1, 1, 1);
    this.s = {
      ctx: this.hc.ctx,
      cam: this.cam,
      dpr: 1,
      t: 0,
      dt: 0,
      now: 0,
      odo: 0,
      shift: 0,
      v: 0,
      wind: 0,
      sky: skyAt(12 * 3600, false),
      night: false,
      lit,
      litTunnel: lit,
      litInside: lit,
      litFig: lit,
      litFigTunnel: lit,
      tunnels: this.tunnels,
      left: 0,
      right: 0,
      lampLetters: false,
    };
  }

  draw(f: RiderFrame): void {
    if (this.destroyed) return;
    const t0 = performance.now();
    const ctx = this.hc.begin();
    const st = f.state;
    const s = this.s;
    const W = this.hc.width;
    const H = this.hc.height;
    if (s.dpr !== this.hc.dpr || this.cam.h !== H) this.scenery.invalidate();

    // 1. Clocks and interpolation.
    const nowS = f.now / 1000;
    const realDt = Number.isFinite(this.lastNow) ? Math.min(0.1, Math.max(0, nowS - this.lastNow)) : 1 / 60;
    this.lastNow = nowS;
    const dt = f.frozen ? 0 : realDt;
    this.t += dt;
    const alpha = clamp01(Number.isFinite(f.alpha) ? f.alpha : 0);
    this.odo.update(st.tick, st.train.odometer);
    const odo = this.odo.at(alpha);
    const v = st.train.v;
    const clock = st.clock0 + Math.max(0, st.tick - 1 + alpha) / TICK_HZ;
    const sky = skyAt(clock, f.run.night);
    s.ctx = ctx;
    s.dpr = this.hc.dpr;
    s.t = this.t;
    s.dt = dt;
    s.now = nowS;
    s.odo = odo;
    s.shift = st.train.odometer - odo;
    s.v = v;
    s.wind = Math.min(1.4, (v / 25) ** 2);
    s.sky = sky;
    s.night = f.run.night || sky.light < 0.5;
    s.lampLetters = f.settings.lampLetters;
    const amb = sky.amb;
    s.lit = this.lits.rgb(amb);
    s.litTunnel = this.lits.get(0.2, 0.18, 0.17);
    s.litInside = s.night ? this.lits.get(0.7, 0.58, 0.45) : this.lits.get(0.94, 0.88, 0.78);
    s.litFig = s.night ? this.lits.get(Math.max(amb[0], 0.55), Math.max(amb[1], 0.6), Math.max(amb[2], 0.75)) : s.lit;
    s.litFigTunnel = this.lits.get(0.46, 0.42, 0.4);

    const r = st.rider;
    this.rider.ix.update(st.tick, r.x);
    this.rider.iy.update(st.tick, r.y);
    const rx = this.rider.ix.at(alpha);
    const ry = this.rider.iy.at(alpha);
    this.rider.x = rx;
    this.rider.y = ry;
    for (const b of st.bandits) {
      let a = this.bandits.get(b.id);
      if (!a) {
        a = newFig();
        this.bandits.set(b.id, a);
      }
      a.ix.update(st.tick, b.x);
      a.iy.update(st.tick, b.y);
      a.x = a.ix.at(alpha);
      a.y = a.iy.at(alpha);
      a.seen = this.t;
      if (b.surface) a.surface = b.surface;
      if (a.hp >= 0 && b.hp < a.hp) a.hurtT = this.t;
      a.hp = b.hp;
    }
    for (const h of st.horsemen) {
      let a = this.horsemen.get(h.id);
      if (!a) {
        a = { ix: new TickInterp(4), phase: hash01(h.id, 3), facing: 1, muzzle: { x: 0, y: 0 }, muzzleT: -Infinity, x: 0, seen: 0, dustAcc: 0, raise: 0 };
        this.horsemen.set(h.id, a);
      }
      a.ix.update(st.tick, h.x);
      a.x = a.ix.at(alpha);
      a.seen = this.t;
    }
    this.forget();

    // 2. Events → effects (the camera and shake from last frame are fine for these).
    this.onEvents(f, st);

    // 3. Camera.
    const scoped = r.scoped && r.mode === 'active';
    this.scope = approach(this.scope, scoped ? 1 : 0, realDt, 0.09);
    if (Math.abs(this.scope - (scoped ? 1 : 0)) < 0.002) this.scope = scoped ? 1 : 0;
    placeCamera(this.cam, W, H, this.cam.x, 0, 0);
    const half = halfWidthM(this.cam);
    this.lead = approach(this.lead, r.facing * Math.min(LEAD_M, half * LEAD_FRAC), dt, 0.45);
    const followTarget = rx + this.lead;
    this.follow = Number.isFinite(this.follow) ? approach(this.follow, followTarget, realDt, 0.07) : followTarget;
    const scopeX = st.train.length + r.scopeDist;
    const blend = smoothstep(0, 1, this.scope);
    const camX = f.cameraX ?? this.follow + (scopeX - this.follow) * blend;
    if (f.settings.screenShake) this.fx.shakeAt(this.t, this.shake);
    else this.shake.x = this.shake.y = 0;
    placeCamera(this.cam, W, H, camX, this.shake.x, this.shake.y);
    s.left = worldX(this.cam, 0) - 1;
    s.right = worldX(this.cam, W) + 1;

    // 4. Trackside.
    const L = st.train.length;
    const ahead = Math.max(60, s.right - L + 40, scoped ? r.scopeDist + half + 40 : 0);
    const behind = Math.max(BEHIND, -s.left + 40);
    const items = f.items ?? this.scan(st, f.run, behind, ahead);
    this.tunnels.length = 0;
    this.gaps.length = 0;
    for (const it of items) {
      if (it.kind === 'tunnel') this.tunnels.push(it.x0 + s.shift, it.x1 + s.shift);
      else if (it.kind === 'trestle') this.gaps.push(it.x0 + s.shift, it.x1 + s.shift);
    }
    this.gatherTrains(st, f.run, items, behind, ahead, alpha, dt);

    this.emitContinuous(s, st, items);
    this.fx.update(dt);
    this.train.lootStatus = st.loot.status;

    // Layers, back to front.
    const on = (layer: string): boolean => !this.devSkip.has(layer);
    if (on('sky')) this.scenery.drawSky(s);
    else {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#9CC7E8';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (on('far')) this.scenery.drawFar(s);
    if (on('ground')) this.scenery.drawGround(s, items);
    if (on('mid')) this.scenery.drawMid(s, items);
    if (on('near')) this.scenery.drawNearGround(s, this.gaps);
    if (on('back')) {
      this.side.drawGorges(s, items);
      this.side.drawBack(s, items, f.run);
      this.side.drawTrains(s, this.aiDraw, 'adjacent');
    }
    if (on('track')) this.scenery.drawTrack(s, this.gaps);
    if (on('back')) {
      this.side.drawObstacles(s, items, (id) => st.obstacles.find((o) => o.id === id)?.ticks ?? 0);
      this.side.drawTrains(s, this.aiDraw, 'same');
    }
    setWorld(s);
    const cabCut = r.mode === 'active' && r.surface === 'cabFloor';
    if (on('train')) this.train.draw(s, st, { cutaway: r.mode === 'active' ? r.inside : null, cabCut, heldUp: st.train.heldUp });
    if (on('fx')) this.fx.drawParticles(s, L_BEHIND);
    if (on('back')) this.side.drawNear(s, items, st.train.spout === 'down' && Math.abs(v) < 0.1 && st.train.water < st.train.waterCap - 0.5);
    setWorld(s);
    if (on('figures')) {
      this.drawLoot(s, st);
      this.drawBandits(s, st, cabCut);
      this.drawRider(s, st);
    }
    setWorld(s);
    if (on('train')) this.train.drawFront(s, st);
    if (on('fx')) this.fx.drawParticles(s, L_LANE);
    if (on('horsemen')) {
      this.drawHorsemen(s, st, dt);
      this.fx.drawRiderless(s);
    }
    if (on('fx')) {
      this.fx.drawTumbles(s);
      this.fx.drawParticles(s, L_FRONT);
      this.fx.drawExplosions(s);
      this.fx.drawShots(s);
      this.fx.drawGlints(
        s,
        (key) => this.muzzleOf(key),
        (key) => (key[0] === 'b' ? BANDIT_TELEGRAPH : HORSEMAN_TELEGRAPH[st.horsemen.find((h) => `h${h.id}` === key)?.tier ?? 1]),
      );
    }
    if (on('front')) this.side.drawFront(s, items, (x0, x1) => x1 > 0 && x0 < L);
    if (on('lights')) this.drawLights(s, st, items);
    if (this.scope > 0.3) this.drawFlags(s, st, f.run, behind, ahead);
    if (f.debug) this.drawDebug(s, st);
    setScreen(s);
    if (on('fx')) {
      this.drawWind(s);
      this.fx.drawHurt(s);
    }
    const head = r.mode === 'active' && this.scope < 0.5 ? { x: screenX(this.cam, rx), y: screenY(this.cam, ry + (r.crouch ? 1.4 : 2.2)) } : null;
    if (on('hud')) this.hud.draw(s, { state: st, prompt: f.prompt, riderHead: head, scope: this.scope, viewX0: s.left, viewX1: s.right });
    this.lastDrawMs = performance.now() - t0;
  }

  /** trackside(), never letting a bad scan take the whole view down (it logs once and shows bare track). */
  private scan(st: GameState, run: RunDef, behind: number, ahead: number): TracksideItem[] {
    try {
      return trackside(st, run, behind, ahead);
    } catch (err) {
      if (!this.scanFailed) console.error('Rider view: trackside() failed', err);
      this.scanFailed = true;
      return [];
    }
  }

  /** A pointer position (CSS px relative to the canvas) in train-frame metres, for aiming. */
  toTrainFrame(px: number, py: number): { x: number; y: number } {
    return { x: worldX(this.cam, px), y: worldY(this.cam, py) };
  }

  /** The camera of the last frame drawn (dev tools, audio panning). */
  get camera(): Readonly<Camera> {
    return this.cam;
  }

  /** Live particle count (dev). */
  get particles(): number {
    return this.fx.count;
  }

  destroy(): void {
    this.destroyed = true;
    this.fx.clear();
    this.bandits.clear();
    this.horsemen.clear();
    this.ais.clear();
    this.scenery.invalidate();
    clearSprites();
    const ctx = this.hc.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ---------------------------------------------------------------------------------------------

  private forget(): void {
    for (const [id, a] of this.bandits) if (this.t - a.seen > 3) this.bandits.delete(id);
    for (const [id, a] of this.horsemen) if (this.t - a.seen > 3) this.horsemen.delete(id);
    for (const [id, a] of this.ais) if (this.t - a.seen > 3) this.ais.delete(id);
  }

  private muzzleOf(key: string): Muzzle | null {
    if (key === 'rider') return this.t - this.rider.muzzleT < 0.2 ? this.rider.muzzle : null;
    const id = Number(key.slice(1));
    if (key[0] === 'b') {
      const a = this.bandits.get(id);
      return a && this.t - a.muzzleT < 0.2 ? a.muzzle : null;
    }
    const h = this.horsemen.get(id);
    return h && this.t - h.muzzleT < 0.2 ? h.muzzle : null;
  }

  private onEvents(f: RiderFrame, st: GameState): void {
    const s = this.s;
    const fx = this.fx;
    const t = this.t;
    let flashKeys = '';
    for (const e of f.events) {
      switch (e.type) {
        case 'shot': {
          const hostile = e.by !== 'rider';
          let key = 'rider';
          let mx = e.x0;
          let my = e.y0;
          if (e.by === 'rider') {
            const m = this.muzzleOf('rider');
            if (m && Math.hypot(m.x - e.x0, m.y - e.y0) < 2.5) {
              mx = m.x;
              my = m.y;
            }
          } else {
            // Find the shooter nearest the shot's origin, and start the tracer at their drawn gun.
            let best = 3;
            if (e.by === 'bandit') {
              for (const b of st.bandits) {
                const d = Math.hypot(b.x - e.x0, b.y + 1.2 - e.y0);
                if (d < best) {
                  best = d;
                  key = `b${b.id}`;
                }
              }
            } else {
              for (const h of st.horsemen) {
                const d = Math.abs(h.x - e.x0);
                if (d < best) {
                  best = d;
                  key = `h${h.id}`;
                }
              }
            }
            const m = key !== 'rider' ? this.muzzleOf(key) : null;
            if (m && Math.hypot(m.x - e.x0, m.y - e.y0) < 3.5) {
              mx = m.x;
              my = m.y;
            }
          }
          fx.shots.set(key, t);
          fx.tracer(mx, my, e.x1, e.y1, t, hostile, e.weapon);
          // One flash and one puff of powder smoke per shooter per frame (a shotgun's pellets share it).
          if (!flashKeys.includes(`|${key}|`)) {
            flashKeys += `|${key}|`;
            const a = Math.atan2(e.y1 - my, e.x1 - mx);
            fx.flash(mx, my, a, t, e.weapon === 'shotgun' ? 1.5 : e.weapon === 'rifle' ? 1.2 : 1);
            fx.spawn(s, P_POWDER, mx + Math.cos(a) * 0.2, my + Math.sin(a) * 0.2, Math.cos(a) * 2.5, Math.sin(a) * 2.5 + 0.5, 0.18, 0.7, 1.3, e.by === 'horseman' ? 0.2 : 1);
          }
          this.hitFx(s, st, e.hit, e.x1, e.y1, e.layer === 'trackside' && e.by === 'rider');
          break;
        }
        case 'aim':
          fx.aims.set(`${e.by === 'bandit' ? 'b' : 'h'}${e.id}`, t);
          break;
        case 'explosion':
          fx.explosion(s, e.x, e.y, e.what === 'powder' || e.what === 'boiler' ? 1.7 : 1.2);
          break;
        case 'riderOff':
          fx.tumble(s, 'rider', 1, this.rider.x, this.rider.y + 0.9, e.cause === 'tunnel' ? -9 : -4, 2.5, st.rider.facing);
          break;
        case 'riderHurt':
          fx.hurtT0 = s.now;
          this.riderHurtT = t;
          if (f.settings.screenShake) fx.shake(t, 8, 0.32);
          break;
        case 'riderDown':
          fx.downT0 = s.now;
          break;
        case 'riderBack':
          fx.burst(s, P_DUST, st.rider.x, st.rider.y + 0.3, 8, 2, 0.3, 0.7, 1);
          break;
        case 'banditKnockedOff':
        case 'banditDown': {
          const a = this.bandits.get(e.id);
          const b = st.bandits.find((x) => x.id === e.id);
          const x = e.type === 'banditDown' ? e.x : a ? a.x : (b?.x ?? 0);
          const y = e.type === 'banditDown' ? e.y : a ? a.y : (b?.y ?? 0);
          const boss = b?.boss ?? (e.type === 'banditDown' ? e.boss : false);
          fx.tumble(s, boss ? 'boss' : 'bandit', b?.tier ?? 1, x, y + 0.9, e.type === 'banditKnockedOff' ? -8 : -3, 2.5, b?.facing ?? 1);
          if (e.type === 'banditDown') fx.burst(s, P_BLOOD, x, y + 1.2, 5, 1.2, 0.07, 0.4, 1);
          this.bandits.delete(e.id);
          break;
        }
        case 'horsemanDown': {
          const h = st.horsemen.find((x) => x.id === e.id);
          const a = this.horsemen.get(e.id);
          const x = a ? a.x : e.x;
          const wv = h ? h.worldV : s.v;
          fx.tumble(s, e.boss ? 'boss' : 'bandit', h?.tier ?? 1, x, LANE_Y + 2.1, wv - 3 - s.v, 1.5, a?.facing ?? 1);
          fx.burst(s, P_BLOOD, x, LANE_Y + 2.2, 4, 1.2, 0.07, 0.4, 0);
          fx.riderless(s, x, wv, e.boss ? BOSS_HORSE : HORSES[e.id % HORSES.length], a?.facing ?? 1);
          this.horsemen.delete(e.id);
          break;
        }
        case 'land':
          fx.burst(s, P_DUST, st.rider.x, st.rider.y + 0.05, e.hard ? 10 : 5, e.hard ? 2.2 : 1.2, 0.18, 0.5, 1);
          if (e.hard && f.settings.screenShake) fx.shake(t, 3, 0.15);
          break;
        case 'jump':
          fx.burst(s, P_DUST, st.rider.x, st.rider.y + 0.05, 3, 1, 0.14, 0.35, 1);
          break;
        case 'whistle':
          if (e.on) {
            const loco = st.train.cars[0];
            fx.burst(s, P_STEAM, loco.x0 + 8.9, 4.4, 8, 2.5, 0.25, 0.8, 1, 3);
          }
          break;
        case 'obstacleCleared': {
          const o = this.itemX(f, e.id);
          if (o !== null) fx.burst(s, P_DUST, o, 0.4, 16, 3, 0.4, 1.3, 0, 1);
          break;
        }
        case 'obstacleHit': {
          const x = st.train.length;
          const kind = e.kind === 'rocks' ? P_CHIP : e.kind === 'barricade' ? P_SPLINTER : P_DUST;
          fx.burst(s, kind, x + 0.5, 1.0, e.severe ? 30 : 16, e.severe ? 9 : 5, kind === P_DUST ? 0.4 : 0.12, 1.4, 1, 3);
          fx.burst(s, P_DUST, x + 0.5, 0.5, 10, 3, 0.5, 1.2, 1, 1);
          if (f.settings.screenShake) fx.shake(t, e.severe ? 18 : 9, e.severe ? 0.8 : 0.35);
          break;
        }
        case 'lootDropped':
          fx.burst(s, P_SPARK, e.x, e.y + 0.3, 10, 2.5, 0.05, 0.5, 1, 1);
          break;
        case 'lootTaken':
        case 'lootRecovered': {
          const ex = st.train.cars.find((c) => c.kind === 'express');
          const x = e.type === 'lootRecovered' ? st.rider.x : ex ? (ex.x0 + ex.x1) / 2 : st.rider.x;
          fx.burst(s, P_SPARK, x, (e.type === 'lootRecovered' ? st.rider.y : 1.5) + 0.5, 14, 3, 0.05, 0.6, 1, 1);
          break;
        }
        case 'powderHit': {
          const pc = st.train.cars.find((c) => c.kind === 'powder');
          if (pc) {
            const x = pc.x0 + 1 + ((st.tick * 7.3) % (pc.x1 - pc.x0 - 2));
            fx.burst(s, P_SPLINTER, x, 2.2, 8, 4, 0.12, 1.0, 1, 1);
            fx.burst(s, P_SPARK, x, 2.2, 6, 5, 0.05, 0.4, 1);
          }
          break;
        }
        case 'banditBoarded':
          fx.burst(s, P_DUST, e.x, e.y + 0.1, 6, 1.5, 0.25, 0.5, 1);
          break;
        case 'safeCracking': {
          const ex = st.train.cars.find((c) => c.kind === 'express');
          if (ex && hash01(st.tick, 9) < 0.35) fx.burst(s, P_SPARK, (ex.x0 + ex.x1) / 2 + 0.12, CAR_SPECS.express.floorY + 0.7, 3, 1.5, 0.04, 0.3, 1);
          break;
        }
        case 'dryFire':
          this.hud.dryFire(s.now);
          break;
        case 'trestleEnter':
          if (e.burning) fx.burst(s, P_EMBER, st.train.length, 0.5, 20, 4, 0.08, 1.6, 0.5, 2);
          break;
        case 'collision':
          if (f.settings.screenShake) fx.shake(t, 20, 0.9);
          break;
        default:
          break;
      }
    }
  }

  private itemX(f: RiderFrame, id: string): number | null {
    const o = f.state.obstacles.find((x) => x.id === id);
    if (!o) return null;
    try {
      const fp = framePath(netIndex(f.run), f.state.switches, f.state.train.spans, 0, 800);
      const x = frameX(fp, { edge: o.edge, off: o.at });
      return x === null ? null : x + this.s.shift;
    } catch {
      return null;
    }
  }

  /** What a shot's end looks like: splinters or sparks on a car, a small red puff on a person, dust on the ground. */
  private hitFx(s: Scene, st: GameState, hit: 'rider' | 'bandit' | 'horseman' | 'car' | 'none', x: number, y: number, trackside: boolean): void {
    const fx = this.fx;
    if (hit === 'rider' || hit === 'bandit' || hit === 'horseman') {
      fx.burst(s, P_BLOOD, x, y, 4, 1.3, 0.06, 0.35, hit === 'horseman' ? 0 : 1);
    } else if (hit === 'car') {
      const car = st.train.cars.find((c) => x >= c.x0 && x <= c.x1);
      const metal = !car || car.kind === 'armored' || car.kind === 'loco' || car.kind === 'tender';
      fx.burst(s, metal ? P_SPARK : P_SPLINTER, x, y, metal ? 7 : 6, metal ? 5 : 3, metal ? 0.05 : 0.1, metal ? 0.35 : 0.8, 1);
      fx.spawn(s, P_DUST, x, y, 0, 0.5, 0.12, 0.4, 0.5, 1);
    } else if (y < 0.4 || trackside) {
      fx.burst(s, P_DUST, x, Math.max(LANE_Y + 0.1, Math.min(0.2, y)), 5, 1.4, 0.2, 0.6, 0);
    }
  }

  /** Smoke, steam, sparks and dust that follow the state rather than events. */
  private emitContinuous(s: Scene, st: GameState, items: readonly TracksideItem[]): void {
    const dt = s.dt;
    if (dt <= 0) return;
    const fx = this.fx;
    const t = st.train;
    const loco = t.cars[0];
    const lx = loco.x0;
    const speed = Math.abs(t.v);
    // Stack: a chuff every quarter turn of the drivers; a lazy trickle when standing.
    const stackX = lx + 12.95;
    const inTun = inTunnel(s, stackX);
    this.chuffAcc += speed * dt;
    const chuffLen = (TAU * 0.8) / 4;
    const work = 0.25 + 0.75 * t.throttle;
    let chuffs = 0;
    while (this.chuffAcc > chuffLen && chuffs < 6) {
      this.chuffAcc -= chuffLen;
      chuffs++;
      fx.spawn(s, P_SMOKE, stackX + (Math.random() - 0.5) * 0.3, 4.95, 0, 3.2 + 3.5 * work, 0.35 + 0.35 * work, 1.3 + 1.2 * work, (1.8 + 1.4 * work) * (inTun ? 0.6 : 1), 0.92);
    }
    if (speed < 1 && Math.random() < dt * (2 + 6 * t.throttle)) fx.spawn(s, P_SMOKE, stackX, 4.95, (Math.random() - 0.5) * 0.4, 1.4 + 2 * t.throttle, 0.3, 1.3, 3, 1);
    // Cylinder cocks: open while starting off under throttle.
    if (t.throttle > 0.1 && speed < 4 && Math.random() < dt * 22) {
      for (const dir of [1, -1]) fx.spawn(s, P_STEAM, lx + 12.0 + dir * 0.7, 0.7, dir * (2 + Math.random() * 2), -0.3 + Math.random() * 0.6, 0.2, 0.9, 0.7, 1);
    }
    // Whistle and safety valve.
    if (t.whistle && Math.random() < dt * 40) fx.spawn(s, P_STEAM, lx + 8.9, 4.35, (Math.random() - 0.5) * 0.4, 4 + Math.random() * 2, 0.12, 0.9, 0.9, 1);
    if (t.safetyValve && Math.random() < dt * 30) fx.spawn(s, P_STEAM, lx + 9.25, 4.15, (Math.random() - 0.5) * 0.5, 5, 0.12, 1.0, 1.1, 1);
    // Brakes in emergency and overspeed flanges throw sparks.
    const sparky = (t.brake > 0.85 && speed > 1) || t.overspeed > 0;
    if (sparky && Math.random() < dt * (t.overspeed > 1 ? 70 : 40)) {
      const car = t.cars[Math.floor(Math.random() * t.cars.length)];
      const wx = car.kind === 'loco' ? car.x0 + (Math.random() < 0.5 ? 5.5 : 7.75) : car.x0 + 1.5 + Math.random() * (car.x1 - car.x0 - 3);
      fx.spawn(s, P_SPARK, wx, 0.05, -1 - Math.random() * 3, 0.5 + Math.random() * 2.5, 0.05, 0, 0.35, 1);
    }
    // The caboose stove and a hurt powder car smoke.
    const tl = trainLook(t.cars);
    for (let i = 0; i < t.cars.length; i++) {
      const car = t.cars[i];
      if (car.kind === 'caboose' && Math.random() < dt * 3) fx.spawn(s, P_SMOKE, tl.cars[i].bx1 - 1.67, tl.cars[i].roofY + 0.6, 0, 1.2, 0.12, 0.5, 1.6, 1);
      if (car.kind === 'powder' && car.hp <= 3 && Math.random() < dt * (4 - car.hp) * 6) {
        fx.spawn(s, P_SMOKE, car.x0 + 1 + Math.random() * (car.x1 - car.x0 - 2), 3.8, 0, 1.5, 0.2, 0.9, 1.6, 1);
        if (car.hp <= 1) fx.spawn(s, P_EMBER, car.x0 + 1 + Math.random() * (car.x1 - car.x0 - 2), 3.5, 0, 2, 0.07, 0, 0.8, 1);
      }
    }
    // Burning trestles: embers and smoke.
    for (const it of items) {
      if (it.kind !== 'trestle' || !it.burning) continue;
      const x0 = it.x0 + s.shift;
      const x1 = it.x1 + s.shift;
      if (x1 < s.left - 10 || x0 > s.right + 10) continue;
      if (Math.random() < dt * 30) fx.spawn(s, P_EMBER, x0 + Math.random() * (x1 - x0), -1 - Math.random() * 2, (Math.random() - 0.5) * 1.5, 1.5 + Math.random() * 2, 0.07, 0, 1.6, 0);
      if (Math.random() < dt * 10) fx.spawn(s, P_SMOKE, x0 + Math.random() * (x1 - x0), 0.5, 0, 2, 0.6, 2.2, 3, 0);
    }
    // Other trains' stacks.
    for (const a of this.aiDraw) {
      if (a.ai === 'runaway' || a.x1 < s.left - 20 || a.x0 > s.right + 20) continue;
      if (Math.random() < dt * (2 + Math.abs(a.v) * 0.5)) {
        const sx = a.front === 1 ? a.x1 - 3.05 : a.x0 + 3.05;
        fx.spawn(s, P_SMOKE, sx, 4.9 + (a.lane === 'adjacent' ? 0.9 : 0), 0, 3, 0.4, 1.5, 2, 0);
      }
    }
  }

  /**
   * Other trains at render time. trackside() clips a train to the scanned stretch of track, so a
   * long one would be squeezed; instead each is anchored at whichever end the scan sees (its front
   * or rear) and laid out at its full timetable length, with its loco at its front.
   */
  private gatherTrains(st: GameState, run: RunDef, items: readonly TracksideItem[], behind: number, ahead: number, alpha: number, dt: number): void {
    this.aiDraw.length = 0;
    let fp: ReturnType<typeof framePath> | null = null;
    for (const it of items) {
      if (it.kind !== 'train') continue;
      let a = this.ais.get(it.id);
      if (!a) {
        a = { x0: new TickInterp(40), x1: new TickInterp(40), roll: 0, seen: 0 };
        this.ais.set(it.id, a);
      }
      const place = this.placeAi(st, run, it, behind, ahead, fp);
      fp = place.fp;
      const { x0, x1, front } = place;
      a.x0.update(st.tick, x0);
      a.x1.update(st.tick, x1);
      a.roll += Math.abs(it.v) * dt;
      a.seen = this.t;
      this.aiDraw.push({ id: it.id, x0: a.x0.at(alpha), x1: a.x1.at(alpha), lane: it.lane, ai: it.ai, v: it.v, cars: it.cars, front, roll: a.roll });
    }
  }

  /** Where another train is at this tick, and which end is its front (see gatherTrains). */
  private placeAi(
    st: GameState,
    run: RunDef,
    it: TracksideItem & { kind: 'train' },
    behind: number,
    ahead: number,
    fpIn: ReturnType<typeof framePath> | null,
  ): { x0: number; x1: number; front: 1 | -1; fp: ReturnType<typeof framePath> | null } {
    const out = { x0: it.x0, x1: it.x1, front: 1 as 1 | -1, fp: fpIn };
    const ai = st.ai.find((x) => x.id === it.id);
    if (!ai || ai.spans.length === 0) return out;
    const len = run.aiTrains.find((d) => d.id === it.id)?.length ?? it.x1 - it.x0;
    try {
      const ix = netIndex(run);
      const head = frontHead(ai.spans);
      const tail = { edge: ai.spans[0].edge, off: ai.spans[0].from };
      if (it.lane === 'same') {
        out.fp ??= framePath(ix, st.switches, st.train.spans, behind, ahead);
        const fx = frameX(out.fp, head);
        const rx = frameX(out.fp, tail);
        if (fx !== null && rx !== null) {
          out.front = fx >= rx ? 1 : -1;
          out.x0 = Math.min(fx, rx);
          out.x1 = Math.max(fx, rx);
        } else if (fx !== null) {
          out.front = Math.abs(fx - it.x1) <= Math.abs(fx - it.x0) ? 1 : -1;
          out.x0 = out.front === 1 ? fx - len : fx;
          out.x1 = out.front === 1 ? fx : fx + len;
        } else if (rx !== null) {
          out.front = Math.abs(rx - it.x0) <= Math.abs(rx - it.x1) ? 1 : -1;
          out.x0 = out.front === 1 ? rx : rx - len;
          out.x1 = out.front === 1 ? rx + len : rx;
        }
      } else {
        // A parallel track: which way it runs, by main-line distance against ours.
        const ours = frontHead(st.train.spans);
        const e0 = ix.edge.get(ours.edge);
        const slope = e0?.mainAt ? Math.sign(e0.mainAt[1] - e0.mainAt[0]) * ours.dir : 1;
        const fm = mainPos(ix, head);
        const rm = mainPos(ix, tail);
        if (fm !== null && rm !== null) out.front = (fm - rm) * slope >= 0 ? 1 : -1;
      }
    } catch {
      // A train on track the scan can't place: draw it where trackside() put it.
    }
    return out;
  }

  // ---- Figures ----------------------------------------------------------------------------------

  private exposed(surface: SurfaceKind | null): boolean {
    return surface !== 'floor' && surface !== 'cabFloor';
  }

  /** Gait bookkeeping from how far a figure moved this frame. */
  private gait(a: FigAnim, x: number, y: number, facing: 1 | -1, crouch: boolean, dt: number): void {
    if (Number.isNaN(a.lastX) || Math.abs(x - a.lastX) > 2) a.lastX = x;
    const dx = x - a.lastX;
    const dy = y - a.lastY;
    a.lastX = x;
    a.lastY = y;
    if (dt > 0) {
      const sp = Math.abs(dx) / dt;
      a.speed += (Math.min(6, sp) - a.speed) * (1 - Math.exp(-dt / 0.08));
      a.crouch += ((crouch ? 1 : 0) - a.crouch) * (1 - Math.exp(-dt / 0.06));
    }
    a.phase = advancePhase(a.phase, dx * facing, crouch ? 1.3 : 2.1);
    a.climb = advancePhase(a.climb, Math.abs(dy), 0.75);
  }

  private drawRider(s: Scene, st: GameState): void {
    const r = st.rider;
    const a = this.rider;
    if (r.mode !== 'active') {
      a.muzzleT = -Infinity;
      return;
    }
    const ctx = s.ctx;
    const x = a.x;
    const y = a.y;
    const ca = Math.cos(r.aim);
    const facing: 1 | -1 = Math.abs(ca) > 0.15 ? (ca >= 0 ? 1 : -1) : r.facing;
    this.gait(a, x, y, facing, r.crouch, s.dt);
    const p = this.pose;
    p.kind = 'rider';
    p.tier = 1;
    p.scale = 1;
    p.facing = facing;
    p.phase = a.phase;
    p.gait = r.onGround ? clamp01(a.speed / 3.5) : 0;
    p.crouch = a.crouch;
    p.climb = r.ladder !== null;
    p.climbPhase = a.climb;
    p.air = !r.onGround && r.ladder === null ? 1 : 0;
    p.stunned = r.stunTicks > 0;
    p.aim = p.climb || p.stunned ? null : r.aim;
    p.recoil = clamp01(1 - (this.t - (this.fx.shots.get('rider') ?? -Infinity)) / 0.14);
    p.weapon = r.weapon;
    p.hurt = this.t - this.riderHurtT < 0.12 ? 1 : 0;
    p.wind = this.exposed(r.surface) && r.inside === null ? s.wind : 0;
    p.windDir = s.v >= 0 ? -1 : 1;
    p.loot = false;
    p.hands = 'none';
    p.seated = false;
    p.stand = 0;
    p.t = s.t;
    p.seed = 0.3;
    const dark = inTunnel(s, x) && r.inside === null;
    // Invulnerable after a hit: blink.
    const blink = r.invulnTicks > 0 && Math.floor(s.now * 12) % 2 === 1;
    ctx.globalAlpha = blink ? 0.4 : 1;
    this.fig.draw(ctx, dark ? s.litFigTunnel : s.litFig, p, x, y, a.muzzle);
    ctx.globalAlpha = 1;
    a.muzzleT = this.t;
  }

  private drawBandits(s: Scene, st: GameState, cabCut: boolean): void {
    const ctx = s.ctx;
    const r = st.rider;
    const riderChestX = this.rider.x;
    const riderChestY = this.rider.y + (r.crouch ? 0.7 : 1.2);
    for (const b of st.bandits) {
      if (b.mode === 'gone' || b.mode === 'falling') continue;
      const a = this.bandits.get(b.id);
      if (!a) continue;
      const x = a.x;
      const y = a.y;
      const p = this.pose;
      p.kind = b.boss ? 'boss' : 'bandit';
      p.tier = b.tier;
      p.scale = b.boss ? 1.18 : 1;
      const aiming = b.aimTicks > 0 || this.t - (this.fx.aims.get(`b${b.id}`) ?? -Infinity) < BANDIT_TELEGRAPH;
      const fighting = aiming || b.mode === 'fighting';
      let aimAngle: number | null = null;
      let facing: 1 | -1 = b.facing;
      if (b.mode === 'holdup') {
        // Gun on the Engineer, at the front of the cab.
        facing = 1;
        aimAngle = -0.12;
      } else if (fighting && r.mode === 'active') {
        const sy = y + (b.crouch ? 0.8 : 1.35) * p.scale;
        aimAngle = Math.atan2(riderChestY - sy, riderChestX - x);
        facing = riderChestX >= x ? 1 : -1;
      }
      this.gait(a, x, y, facing, b.crouch, s.dt);
      a.facing = facing;
      a.raise += ((aimAngle !== null ? 1 : 0) - a.raise) * (s.dt > 0 ? 1 - Math.exp(-s.dt / 0.06) : 0);
      p.facing = facing;
      p.phase = a.phase;
      p.gait = b.onGround ? clamp01(a.speed / 3.2) : 0;
      p.crouch = b.mode === 'cracking' ? 0.55 : a.crouch;
      p.climb = b.ladder !== null;
      p.climbPhase = a.climb;
      p.air = !b.onGround && b.ladder === null ? 1 : 0;
      p.stunned = b.stunTicks > 0;
      p.aim = p.climb || p.stunned ? null : aimAngle;
      p.recoil = clamp01(1 - (this.t - (this.fx.shots.get(`b${b.id}`) ?? -Infinity)) / 0.14);
      p.weapon = b.tier === 3 && !b.boss ? 'rifle' : 'revolver';
      p.hurt = this.t - a.hurtT < 0.12 ? 1 : 0;
      p.wind = this.exposed(b.surface ?? a.surface) ? s.wind : 0;
      p.windDir = s.v >= 0 ? -1 : 1;
      p.loot = b.hasLoot;
      p.hands = b.mode === 'cracking' ? 'crack' : 'none';
      p.seated = false;
      p.stand = 0;
      p.t = s.t;
      p.seed = b.id * 1.37;
      // Inside a car the Rider isn't in: seen only through its openings.
      const surf = b.surface ?? a.surface;
      let clipCar: number | null = null;
      if (surf === 'floor' || surf === 'cabFloor') {
        const ci = st.train.cars.findIndex((c) => x >= c.x0 && x <= c.x1);
        const cut = surf === 'cabFloor' ? cabCut : ci === r.inside && r.mode === 'active';
        if (ci >= 0 && !cut) clipCar = ci;
      }
      const dark = inTunnel(s, x) && surf !== 'floor';
      if (clipCar !== null) {
        ctx.save();
        ctx.beginPath();
        this.train.addOpenings(ctx, trainLook(st.train.cars).cars[clipCar], false);
        ctx.clip();
      }
      this.fig.draw(ctx, dark ? s.litFigTunnel : s.litFig, p, x, y, a.muzzle);
      if (clipCar !== null) ctx.restore();
      a.muzzleT = this.t;
    }
  }

  private drawHorsemen(s: Scene, st: GameState, dt: number): void {
    const ctx = s.ctx;
    setWorld(s);
    const r = st.rider;
    const powder = st.train.cars.find((c) => c.kind === 'powder');
    for (const h of st.horsemen) {
      if (h.mode === 'gone' || h.mode === 'falling') continue;
      const a = this.horsemen.get(h.id);
      if (!a) continue;
      const x = a.x;
      if (x < s.left - 5 || x > s.right + 5) {
        a.muzzleT = -Infinity;
        continue;
      }
      const wv = h.worldV;
      if (Math.abs(wv) > 0.5) a.facing = wv >= 0 ? 1 : -1;
      a.phase = (a.phase + (Math.abs(wv) * dt) / 5.6) % 1;
      const gallop = clamp01(Math.abs(wv) / 7);
      const look = h.boss ? BOSS_HORSE : HORSES[h.id % HORSES.length];
      const grazing = h.mode === 'waiting' ? 0.5 + 0.5 * Math.sin(s.t * 0.4 + h.id) : 0;
      // A soft shadow on the ground under the horse.
      ctx.fillStyle = 'rgba(30,20,12,0.22)';
      ctx.beginPath();
      ctx.ellipse(x, LANE_Y - 0.02, 1.35, 0.13, 0, 0, TAU);
      ctx.fill();
      const saddle = drawHorse(ctx, s.litFig, look, { facing: a.facing, phase: a.phase, gallop, graze: gallop > 0.2 ? 0 : grazing, t: s.t, seed: h.id }, x, LANE_Y);
      // The rider: seated, standing in the stirrups to board, gun up to shoot.
      const aiming = h.aimTicks > 0 || this.t - (this.fx.aims.get(`h${h.id}`) ?? -Infinity) < HORSEMAN_TELEGRAPH[h.tier];
      let aim: number | null = null;
      let facing = a.facing;
      const shoulderY = LANE_Y + saddle + 0.5;
      if (aiming) {
        const tx = h.goal === 'powder' && powder ? (powder.x0 + powder.x1) / 2 : this.rider.x;
        const ty = h.goal === 'powder' && powder ? 2.4 : this.rider.y + (r.crouch ? 0.7 : 1.2);
        aim = Math.atan2(ty - shoulderY, tx - x);
        facing = tx >= x ? 1 : -1;
      }
      a.raise += ((aim !== null ? 1 : 0) - a.raise) * (dt > 0 ? 1 - Math.exp(-dt / 0.06) : 0);
      const p = this.pose;
      p.kind = h.boss ? 'boss' : 'bandit';
      p.tier = h.tier;
      // Sized so saddle to hat spans the sim's target box (1.5–2.7 m).
      p.scale = h.boss ? 1.3 : 1.18;
      p.facing = facing;
      p.gait = 0;
      p.crouch = 0;
      p.climb = false;
      p.air = 0;
      p.stunned = false;
      p.aim = aim;
      p.recoil = clamp01(1 - (this.t - (this.fx.shots.get(`h${h.id}`) ?? -Infinity)) / 0.14);
      p.weapon = h.tier === 3 ? 'rifle' : 'revolver';
      p.hurt = 0;
      p.wind = gallop * 0.8;
      p.windDir = (-a.facing) as 1 | -1;
      p.loot = false;
      p.hands = h.mode === 'boarding' ? 'reach' : aim === null ? 'reins' : 'none';
      p.seated = true;
      p.stand = h.mode === 'boarding' ? 1 : 0;
      p.t = s.t;
      p.seed = h.id * 2.1;
      const bob = gallop * 0.07 * Math.sin(TAU * a.phase * 2 + 0.6);
      this.fig.draw(ctx, s.litFig, p, x - 0.05 * a.facing, LANE_Y + saddle - 0.02 + bob * 0.4, a.muzzle);
      a.muzzleT = this.t;
      if (h.pickup) {
        // A spare horse waiting for a looter.
        drawHorse(ctx, s.litFig, HORSES[(h.id + 2) % HORSES.length], { facing: a.facing, phase: (a.phase + 0.37) % 1, gallop, graze: 0, t: s.t, seed: h.id + 5 }, x - a.facing * 3.2, LANE_Y + 0.35);
      }
      // Dust from the hooves.
      if (dt > 0 && gallop > 0.3) {
        a.dustAcc += Math.abs(wv) * dt * 0.9;
        while (a.dustAcc > 1) {
          a.dustAcc -= 1;
          this.fx.spawn(s, P_DUST, x - a.facing * (0.5 + Math.random()), LANE_Y + 0.15, -a.facing * (0.5 + Math.random()) - s.v + wv * 0.3, 0.3 + Math.random() * 0.8, 0.25, 0.8, 0.9, 1);
        }
      }
    }
  }

  private drawLoot(s: Scene, st: GameState): void {
    if (st.loot.status !== 'dropped') return;
    const ctx = s.ctx;
    const x = st.loot.x;
    const y = st.loot.y;
    const lit = inTunnel(s, x) ? s.litFigTunnel : s.litFig;
    ctx.fillStyle = lit.c('#B89868');
    ctx.beginPath();
    ctx.moveTo(x - 0.3, y);
    ctx.quadraticCurveTo(x - 0.38, y + 0.4, x - 0.08, y + 0.5);
    ctx.lineTo(x - 0.12, y + 0.62);
    ctx.lineTo(x + 0.12, y + 0.62);
    ctx.lineTo(x + 0.08, y + 0.5);
    ctx.quadraticCurveTo(x + 0.38, y + 0.4, x + 0.3, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c('#2A2118');
    ctx.lineWidth = 0.04;
    ctx.stroke();
    dollar(ctx, x, y + 0.25, 0.26, lit.c('#3E5A2A'));
    // A glint every second so it catches the eye.
    const ph = (s.t % 1.1) / 1.1;
    if (ph < 0.25) {
      const g = glowSprite('255,236,170');
      if (g) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.sin((ph / 0.25) * Math.PI);
        ctx.drawImage(g, x + 0.1 - 0.6, y + 0.5 - 0.6, 1.2, 1.2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  // ---- Lights ------------------------------------------------------------------------------------

  private drawLights(s: Scene, st: GameState, items: readonly TracksideItem[]): void {
    const ctx = s.ctx;
    setWorld(s);
    const t = st.train;
    const loco = t.cars[0];
    const lampX = loco.x0 + 14.3;
    const lampY = 3.82;
    const locoDark = inTunnel(s, lampX);
    const dusk = s.night ? 1 : s.sky.light < 0.8 ? 0.5 : 0;
    ctx.globalCompositeOperation = 'lighter';
    if (s.night || locoDark) {
      beam(ctx, lampX, lampY, 1, 60, locoDark ? 0.9 : 0.7);
      const g = glowSprite('255,244,210');
      if (g) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(g, lampX - 1.4, lampY - 1.4, 2.8, 2.8);
      }
    } else if (dusk > 0) {
      const g = glowSprite('255,244,210');
      if (g) {
        ctx.globalAlpha = 0.5 * dusk;
        ctx.drawImage(g, lampX - 1, lampY - 1, 2, 2);
      }
    }
    ctx.globalAlpha = 1;
    // Lamp-lit windows, the firebox glow, the caboose's markers.
    const tl = trainLook(t.cars);
    for (let i = 0; i < t.cars.length; i++) {
      const car = t.cars[i];
      if (car.x1 < s.left - 4 || car.x0 > s.right + 4) continue;
      const dark = s.night || inTunnel(s, (car.x0 + car.x1) / 2);
      if (!dark) continue;
      const look = tl.cars[i];
      if (car.kind === 'passenger') {
        for (let x = look.bx0 + 1.0; x + 0.7 < look.bx1 - 0.6; x += 1.28) glowAt(ctx, '255,190,110', x + 0.36, look.floorY + 1.6, 1.3, 0.45);
      } else if (car.kind === 'caboose') {
        glowAt(ctx, '255,80,60', car.x0 + 0.06, look.roofY - 0.75, 1.1, 0.8);
        glowAt(ctx, '255,190,110', look.bx0 + 1.6, look.floorY + 1.6, 1.4, 0.5);
      } else if (car.kind === 'express') {
        glowAt(ctx, '255,200,120', (look.bx0 + look.bx1) / 2, look.floorY + 1.3, 2.2, 0.35);
      } else if (car.kind === 'loco') {
        const fl = 0.75 + 0.25 * Math.sin(s.t * 13) * Math.sin(s.t * 7.3 + 1);
        glowAt(ctx, '255,140,50', car.x0 + 3.9, 2.2, 2.6, 0.55 * fl);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    this.side.drawLights(s, items, this.aiDraw);
    // Tunnel darkness over the figures' surroundings: a soft falloff at the portals.
    for (let i = 0; i < this.tunnels.length; i += 2) {
      const x0 = this.tunnels[i];
      const x1 = this.tunnels[i + 1];
      if (x1 < s.left || x0 > s.right) continue;
      const grad = ctx.createLinearGradient(x0, 0, x0 + 6, 0);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.25)');
      ctx.fillStyle = grad;
      ctx.fillRect(x0, FLOOR_Y, Math.min(6, x1 - x0), TUNNEL_CEILING - FLOOR_Y);
      if (x1 - x0 > 12) {
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(x0 + 6, FLOOR_Y, x1 - x0 - 12, TUNNEL_CEILING - FLOOR_Y);
        const g2 = ctx.createLinearGradient(x1 - 6, 0, x1, 0);
        g2.addColorStop(0, 'rgba(0,0,0,0.25)');
        g2.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(x1 - 6, FLOOR_Y, 6, TUNNEL_CEILING - FLOOR_Y);
      }
    }
  }

  /** Flags placed with the spyglass, as red pennants on the line (spec §6.5). */
  private drawFlags(s: Scene, st: GameState, run: RunDef, behind: number, ahead: number): void {
    if (st.flags.length === 0) return;
    const ctx = s.ctx;
    let fp: ReturnType<typeof framePath>;
    try {
      fp = framePath(netIndex(run), st.switches, st.train.spans, behind, ahead);
    } catch {
      return;
    }
    setWorld(s);
    for (const fl of st.flags) {
      const fx = frameX(fp, fl.point);
      if (fx === null) continue;
      const x = fx + s.shift;
      if (x < s.left - 2 || x > s.right + 2) continue;
      const age = (st.tick - fl.tick) / TICK_HZ;
      ctx.globalAlpha = clamp01(1.2 - age / 90);
      ctx.fillStyle = '#1E1C1C';
      ctx.fillRect(x - 0.05, -0.3, 0.1, 3.6);
      const wave = 0.12 * Math.sin(s.t * 6 + fl.id);
      ctx.fillStyle = PALETTE.signalRed;
      ctx.beginPath();
      ctx.moveTo(x + 0.05, 3.3);
      ctx.quadraticCurveTo(x + 0.6, 3.1 + wave, x + 1.3, 2.95 - wave);
      ctx.quadraticCurveTo(x + 0.6, 2.8 + wave, x + 0.05, 2.5);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawDebug(s: Scene, st: GameState): void {
    const ctx = s.ctx;
    setScreen(s);
    ctx.font = '700 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const label = (x: number, y: number, text: string): void => {
      const px = screenX(this.cam, x);
      const py = screenY(this.cam, y);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(text, px, py);
      ctx.fillStyle = '#FFD27A';
      ctx.fillText(text, px, py);
    };
    for (const b of st.bandits) {
      const a = this.bandits.get(b.id);
      if (a) label(a.x, a.y + 2.3, `${b.goal}·${b.mode}·${b.hp}hp`);
    }
    for (const h of st.horsemen) {
      const a = this.horsemen.get(h.id);
      if (a) label(a.x, LANE_Y + 3.1, `${h.goal}·${h.mode}·${h.hp}hp`);
    }
  }

  private drawWind(s: Scene): void {
    const a = clamp01((Math.abs(s.v) - 7) / 16);
    if (a <= 0) return;
    const { ctx, cam } = s;
    const dir = s.v >= 0 ? -1 : 1;
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = s.night ? 'rgba(190,200,230,1)' : 'rgba(255,255,255,1)';
    for (let i = 0; i < 26; i++) {
      const y = hash01(i, 1) * cam.h * 0.8;
      const speed = Math.abs(s.v) * cam.k * (1.3 + hash01(i, 2));
      const len = (30 + 90 * hash01(i, 3)) * (0.4 + a);
      const span = cam.w + len;
      const p = (s.t * speed + hash01(i, 4) * span) % span;
      const x = dir < 0 ? cam.w - p : p - len;
      ctx.globalAlpha = (0.08 + 0.14 * hash01(i, 5)) * a;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
}

function glowAt(ctx: CanvasRenderingContext2D, rgb: string, x: number, y: number, r: number, a: number): void {
  const g = glowSprite(rgb);
  if (!g) return;
  ctx.globalAlpha = a;
  ctx.drawImage(g, x - r, y - r, 2 * r, 2 * r);
  ctx.globalAlpha = 1;
}
