// Effects in the Rider's view (spec §18.2 layer 9): smoke from the stack, steam from the cylinders,
// the whistle and the safety valve, dust from hooves, sparks, splinters, embers, tracers, muzzle
// flashes that light the scene, aim glints (the telegraph players dodge by, spec §7.2), hit puffs
// (kept small and tasteful), explosions, figures tumbling off the train, and screen shake.
// Round 2: spray and droplets where the train cuts through a ford, figures washed off and carried
// away by the river, and the lurch's jolt along the train.
//
// Particles live in the world, not the train frame: x is a track position (train-frame x plus the
// odometer) and velocities are relative to still air. Smoke leaves the stack at the train's speed
// and drags to rest, so it streams back over the cars as the train runs on; dust kicked up by a
// horse stays behind it. A fixed pool, no allocation per particle.

import { FORD_WATER_Y } from '../../sim/rules';
import type { Weapon } from '../../sim/types';
import { defaultPose, FigurePainter, drawHorse, type FigureKind, type HorseLook, type Pose } from './figures';
import { LANE_Y } from './scenery';
import { clamp01, inTunnel, setWorld, smoothstep, TAU, type Scene } from './scene';
import { glowSprite, puffSprite } from './sprites';

export const P_SMOKE = 0;
export const P_STEAM = 1;
export const P_DUST = 2;
export const P_SPARK = 3;
export const P_SPLINTER = 4;
export const P_EMBER = 5;
export const P_BLOOD = 6;
export const P_DEBRIS = 7;
export const P_POWDER = 8;
export const P_WATER = 9;
export const P_CHIP = 10;
/** Spray: a soft white mist thrown up where the train cuts through water, settling as it drifts. */
export const P_SPRAY = 11;

/** Drawing layers for particles. */
export const L_BEHIND = 0; // smoke and steam: behind the figures, so they stay readable
export const L_LANE = 1; // dust under the horses
export const L_FRONT = 2; // sparks, splinters, hit puffs, debris, spray

const CAP = 1400;

/** Per-kind drag (1/s), gravity (m/s², + = down) and layer. */
const DRAG = [1.4, 2.2, 1.6, 0.25, 0.3, 0.9, 3.5, 0.2, 1.8, 0.3, 0.3, 2.4];
const GRAV = [-0.9, -1.6, -0.3, 9.8, 9.8, -1.5, 1.5, 9.8, -0.5, 9.8, 9.8, 2.2];
const LAYER = [L_BEHIND, L_BEHIND, L_LANE, L_FRONT, L_FRONT, L_FRONT, L_FRONT, L_FRONT, L_FRONT, L_FRONT, L_FRONT, L_FRONT];

/** A washed-off figure floats with the water at its chest: its feet this far below the surface. */
const SWEPT_DEPTH = 1.35;

interface Tracer {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  hostile: boolean;
  weapon: Weapon;
}

interface Flash {
  x: number;
  y: number;
  a: number;
  t0: number;
  big: number;
}

interface Explosion {
  s: number;
  y: number;
  t0: number;
  big: number;
}

interface Tumble {
  kind: FigureKind;
  tier: 1 | 2 | 3;
  s: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vrot: number;
  t0: number;
  ground: number;
  facing: 1 | -1;
}

interface Riderless {
  s: number;
  v: number;
  t0: number;
  look: HorseLook;
  phase: number;
  facing: 1 | -1;
}

interface Shake {
  t0: number;
  amp: number;
  dur: number;
}

/** A figure washed off in a ford (spec §4.3), carried away by the river. */
interface Swept {
  kind: FigureKind;
  tier: 1 | 2 | 3;
  /** World position along the track, and speed: the water drags it to rest as the train runs on. */
  s: number;
  vx: number;
  /** Feet height, settling to float with the water at the chest. */
  y: number;
  t0: number;
  facing: 1 | -1;
  seed: number;
}

export class Effects {
  // Particle pool (structure of arrays).
  private n = 0;
  private readonly kind = new Uint8Array(CAP);
  private readonly x = new Float64Array(CAP);
  private readonly y = new Float32Array(CAP);
  private readonly vx = new Float32Array(CAP);
  private readonly vy = new Float32Array(CAP);
  private readonly age = new Float32Array(CAP);
  private readonly life = new Float32Array(CAP);
  private readonly size = new Float32Array(CAP);
  private readonly grow = new Float32Array(CAP);
  private readonly rot = new Float32Array(CAP);
  private readonly shade = new Float32Array(CAP);
  /** Falling below this height ends a particle (spray falling back into the river). */
  private readonly floor = new Float32Array(CAP);

  private readonly tracers: Tracer[] = [];
  private readonly flashes: Flash[] = [];
  private readonly explosions: Explosion[] = [];
  private readonly tumbles: Tumble[] = [];
  private readonly horses: Riderless[] = [];
  private readonly swepts: Swept[] = [];
  private readonly shakes: Shake[] = [];
  private readonly jolts: Shake[] = [];
  /** Aim telegraphs: key ('b12' / 'h7') → start time. */
  readonly aims = new Map<string, number>();
  /** Last shot time per shooter key ('rider', 'b12', 'h7'), for recoil. */
  readonly shots = new Map<string, number>();
  hurtT0 = -Infinity;
  downT0 = -Infinity;
  private readonly fig = new FigurePainter();
  private readonly pose: Pose = defaultPose('bandit');
  private seed = 1;

  private rand(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  // ---- Spawning --------------------------------------------------------------------------------

  /**
   * Adds a particle at train-frame (tx, ty) with velocity relative to the train; `inherit` of the
   * train's speed. It ends early if it falls below `floor` (spray dropping back into the water).
   */
  spawn(s: Scene, kind: number, tx: number, ty: number, vx: number, vy: number, size: number, grow: number, life: number, inherit = 1, floor = -100): void {
    if (this.n >= CAP) return;
    const i = this.n++;
    this.kind[i] = kind;
    this.x[i] = tx + s.odo;
    this.y[i] = ty;
    this.vx[i] = vx + inherit * s.v;
    this.vy[i] = vy;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.rot[i] = this.rand() * TAU;
    this.shade[i] = this.rand();
    this.floor[i] = floor;
  }

  /** A little cloud of particles around (tx, ty). */
  burst(s: Scene, kind: number, tx: number, ty: number, count: number, speed: number, size: number, life: number, inherit = 1, up = 0, floor = -100): void {
    for (let i = 0; i < count; i++) {
      const a = this.rand() * TAU;
      const v = speed * (0.4 + 0.6 * this.rand());
      this.spawn(s, kind, tx, ty, Math.cos(a) * v, Math.sin(a) * v + up, size * (0.6 + 0.8 * this.rand()), size * 0.8, life * (0.6 + 0.6 * this.rand()), inherit, floor);
    }
  }

  /**
   * A splash at train-frame (tx, ty) on the water: droplets and mist thrown up (`big`: the loco
   * ploughing in; otherwise a body falling in), all falling back into the river.
   */
  splash(s: Scene, tx: number, ty: number, big: number, inherit = 0.3): void {
    const floor = FORD_WATER_Y - 0.15;
    for (let i = 0; i < Math.round(26 * big); i++) {
      const a = Math.PI * (0.12 + 0.76 * this.rand());
      const v = (3 + 5 * this.rand()) * Math.sqrt(big);
      this.spawn(s, P_WATER, tx + (this.rand() - 0.5) * big, ty, Math.cos(a) * v, Math.sin(a) * v, 0.05 + 0.05 * this.rand(), 0, 0.9 + 0.5 * this.rand(), inherit, floor);
    }
    for (let i = 0; i < Math.round(9 * big); i++) {
      this.spawn(s, P_SPRAY, tx + (this.rand() - 0.5) * 1.2 * big, ty + 0.2, (this.rand() - 0.5) * 3, 1.5 + 2.5 * this.rand(), 0.35 * big, 0.9 * big, 0.8 + 0.5 * this.rand(), inherit);
    }
  }

  tracer(x0: number, y0: number, x1: number, y1: number, t0: number, hostile: boolean, weapon: Weapon): void {
    if (this.tracers.length > 40) this.tracers.shift();
    this.tracers.push({ x0, y0, x1, y1, t0, hostile, weapon });
  }

  flash(x: number, y: number, a: number, t0: number, big: number): void {
    if (this.flashes.length > 24) this.flashes.shift();
    this.flashes.push({ x, y, a, t0, big });
  }

  explosion(s: Scene, x: number, y: number, big: number): void {
    this.explosions.push({ s: x + s.odo, y, t0: s.t, big });
    this.burst(s, P_DEBRIS, x, y + 0.5, Math.round(26 * big), 11 * big, 0.14, 2.2, 0.7, 5);
    this.burst(s, P_SPARK, x, y + 0.5, Math.round(40 * big), 16 * big, 0.06, 0.8, 0.7, 3);
    this.burst(s, P_EMBER, x, y + 0.5, Math.round(24 * big), 6 * big, 0.08, 2.2, 0.5, 3);
    for (let i = 0; i < 16 * big; i++) this.spawn(s, P_SMOKE, x + (this.rand() - 0.5) * 3 * big, y + this.rand() * 2, (this.rand() - 0.5) * 4, 2 + this.rand() * 4, 1.2 * big, 2.2 * big, 3.5 + this.rand() * 2, 0.6);
    this.shake(s.t, 16 * big, 0.7);
  }

  tumble(s: Scene, kind: FigureKind, tier: 1 | 2 | 3, x: number, y: number, vxRel: number, vy: number, facing: 1 | -1): void {
    if (this.tumbles.length > 10) this.tumbles.shift();
    this.tumbles.push({ kind, tier, s: x + s.odo, y, vx: s.v + vxRel, vy, rot: 0, vrot: -3 - this.rand() * 4, t0: s.t, ground: LANE_Y + 0.25 + this.rand() * 0.4, facing });
  }

  riderless(s: Scene, x: number, worldV: number, look: HorseLook, facing: 1 | -1): void {
    this.horses.push({ s: x + s.odo, v: worldV, t0: s.t, look, phase: this.rand(), facing });
  }

  /** A figure washed off the train at train-frame (x, y) by a ford: into the water and carried away. */
  swept(s: Scene, kind: FigureKind, tier: 1 | 2 | 3, x: number, y: number, facing: 1 | -1): void {
    if (this.swepts.length > 6) this.swepts.shift();
    this.swepts.push({ kind, tier, s: x + s.odo, vx: s.v, y, t0: s.t, facing, seed: this.rand() * 10 });
    this.splash(s, x, FORD_WATER_Y, 0.8);
  }

  shake(t: number, amp: number, dur: number): void {
    if (this.shakes.length > 8) this.shakes.shift();
    this.shakes.push({ t0: t, amp, dur });
  }

  /**
   * A jolt along the train (the lurch): the view kicks once toward the rear by `amp` CSS px (signed:
   * negative kicks it the other way) and settles. Like shake(), only when screen shake is on.
   */
  jolt(t: number, amp: number, dur: number): void {
    if (this.jolts.length > 4) this.jolts.shift();
    this.jolts.push({ t0: t, amp, dur });
  }

  /** Current shake offset (CSS px) at time t; 0 when none. */
  shakeAt(t: number, out: { x: number; y: number }): void {
    let amp = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const sh = this.shakes[i];
      const age = t - sh.t0;
      if (age >= sh.dur || age < -1) {
        this.shakes.splice(i, 1);
        continue;
      }
      const f = 1 - Math.max(0, age) / sh.dur;
      amp = Math.max(amp, sh.amp * f * f);
    }
    out.x = amp * (0.6 * Math.sin(t * 73.1) + 0.4 * Math.sin(t * 121.7 + 1.7));
    out.y = amp * (0.6 * Math.sin(t * 89.3 + 0.5) + 0.4 * Math.sin(t * 137.9 + 2.1));
    for (let i = this.jolts.length - 1; i >= 0; i--) {
      const j = this.jolts[i];
      const age = t - j.t0;
      if (age >= j.dur || age < -1) {
        this.jolts.splice(i, 1);
        continue;
      }
      // Everything on the train keeps going as it bites: the world kicks back, rebounds, settles.
      const f = 1 - Math.max(0, age) / j.dur;
      out.x -= j.amp * f * f * Math.sin(Math.max(0, age) * 22);
      out.y += Math.abs(j.amp) * 0.25 * f * f * Math.sin(Math.max(0, age) * 37 + 0.8);
    }
  }

  // ---- Simulation ---------------------------------------------------------------------------------

  update(dt: number): void {
    if (dt <= 0) return;
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      const k = this.kind[i];
      const d = Math.exp(-DRAG[k] * dt);
      let vx = this.vx[i] * d;
      let vy = this.vy[i] * d - GRAV[k] * dt;
      let y = this.y[i] + vy * dt;
      if (y < this.floor[i] && vy < 0) continue;
      // Heavy bits bounce on the ground and settle.
      if ((k === P_DEBRIS || k === P_SPLINTER || k === P_CHIP) && y < LANE_Y + 0.1 && vy < 0) {
        y = LANE_Y + 0.1;
        vy = -vy * 0.3;
        vx *= 0.5;
      }
      if (j !== i) {
        this.kind[j] = k;
        this.life[j] = this.life[i];
        this.size[j] = this.size[i];
        this.grow[j] = this.grow[i];
        this.rot[j] = this.rot[i];
        this.shade[j] = this.shade[i];
        this.floor[j] = this.floor[i];
      }
      this.x[j] = this.x[i] + vx * dt;
      this.y[j] = y;
      this.vx[j] = vx;
      this.vy[j] = vy;
      this.age[j] = age;
      j++;
    }
    this.n = j;
    for (const tb of this.tumbles) {
      tb.vy -= 22 * dt;
      tb.y += tb.vy * dt;
      tb.s += tb.vx * dt;
      tb.rot += tb.vrot * dt;
      if (tb.y < tb.ground) {
        tb.y = tb.ground;
        tb.vy = Math.abs(tb.vy) > 2 ? -tb.vy * 0.25 : 0;
        tb.vx *= Math.exp(-6 * dt);
        tb.vrot *= 0.6;
      }
    }
    for (const h of this.horses) h.v *= Math.exp(-0.25 * dt);
    for (const sw of this.swepts) {
      sw.vx *= Math.exp(-2.5 * dt);
      sw.s += sw.vx * dt;
      sw.y += (FORD_WATER_Y - SWEPT_DEPTH - sw.y) * (1 - Math.exp(-dt / 0.18));
    }
  }

  // ---- Drawing ----------------------------------------------------------------------------------

  drawParticles(s: Scene, layer: number): void {
    const { ctx } = s;
    setWorld(s);
    const smokeRgb = s.night ? '70,72,80' : '96,92,88';
    const steamRgb = s.night ? '150,160,178' : '244,241,234';
    const dustRgb = s.night ? '96,88,82' : '214,190,150';
    const powderRgb = s.night ? '150,150,160' : '232,230,224';
    const sprayRgb = s.night ? '140,156,186' : '236,244,246';
    const dark = '26,24,22';
    let any = false;
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (LAYER[k] !== layer) continue;
      const x = this.x[i] - s.odo;
      if (x < s.left - 6 || x > s.right + 6) continue;
      const y = this.y[i];
      const u = this.age[i] / this.life[i];
      const r = this.size[i] + this.grow[i] * u;
      if (k === P_SMOKE || k === P_STEAM || k === P_DUST || k === P_POWDER || k === P_SPRAY) {
        const tun = inTunnel(s, x);
        const rgb =
          k === P_SMOKE ? (tun ? dark : smokeRgb) : k === P_STEAM ? (tun ? '60,58,56' : steamRgb) : k === P_DUST ? dustRgb : k === P_SPRAY ? sprayRgb : powderRgb;
        const spr = puffSprite(rgb, i);
        if (!spr) continue;
        const base = k === P_SMOKE ? 0.55 : k === P_STEAM ? 0.7 : k === P_DUST ? 0.5 : k === P_SPRAY ? 0.5 : 0.6;
        const fadeIn = clamp01(u * 8);
        ctx.globalAlpha = base * fadeIn * (1 - u) * (1 - u * 0.3) * (0.75 + 0.25 * this.shade[i]);
        ctx.drawImage(spr, x - r, y - r, 2 * r, 2 * r);
        any = true;
      }
    }
    if (any) ctx.globalAlpha = 1;
    if (layer !== L_FRONT) return;
    // Bits and sparks.
    const drop = s.night ? 'rgba(150,170,205,0.75)' : 'rgba(214,236,246,0.9)';
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (LAYER[k] !== L_FRONT || k === P_POWDER || k === P_SPRAY) continue;
      const x = this.x[i] - s.odo;
      if (x < s.left - 4 || x > s.right + 4) continue;
      const y = this.y[i];
      const u = this.age[i] / this.life[i];
      const sz = this.size[i];
      switch (k) {
        case P_SPARK: {
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = u < 0.5 ? 'rgba(255,236,160,0.95)' : 'rgba(255,160,60,0.8)';
          ctx.lineWidth = sz * 0.6;
          const vx = this.vx[i] - s.v;
          const vy = this.vy[i];
          const sp = Math.hypot(vx, vy) + 1e-6;
          const len = Math.min(0.5, sp * 0.02 + 0.05);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - (vx / sp) * len, y - (vy / sp) * len);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case P_EMBER: {
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = `rgba(255,${Math.round(120 + 100 * (1 - u))},40,${(0.9 * (1 - u)).toFixed(2)})`;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
          ctx.globalCompositeOperation = 'source-over';
          break;
        }
        case P_BLOOD: {
          ctx.globalAlpha = 0.8 * (1 - u);
          ctx.fillStyle = '#9E2B1E';
          ctx.beginPath();
          ctx.arc(x, y, sz * (1 + u), 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          break;
        }
        case P_WATER: {
          ctx.fillStyle = drop;
          ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz * 1.6);
          break;
        }
        default: {
          // Splinters, chips, debris: small tumbling slivers.
          const a = this.rot[i] + this.age[i] * 9;
          const c = Math.cos(a) * sz;
          const sn = Math.sin(a) * sz;
          ctx.strokeStyle = k === P_SPLINTER ? s.lit.c('#8A6440') : k === P_CHIP ? s.lit.c('#8A7A6A') : s.lit.c('#3A2E26');
          ctx.lineWidth = sz * 0.5;
          ctx.globalAlpha = 1 - clamp01((u - 0.7) / 0.3);
          ctx.beginPath();
          ctx.moveTo(x - c, y - sn);
          ctx.lineTo(x + c, y + sn);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  /** Tracers and muzzle flashes (additive), and the light a flash throws on its surroundings. */
  drawShots(s: Scene): void {
    const { ctx } = s;
    setWorld(s);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      const age = s.t - tr.t0;
      const life = 0.13;
      if (age > life || age < -1) {
        this.tracers.splice(i, 1);
        continue;
      }
      const u = clamp01(age / life);
      // The streak races from muzzle to target, its tail following.
      const head = clamp01(age / 0.035);
      const tail = clamp01((age - 0.02) / (life - 0.02));
      const hx = tr.x0 + (tr.x1 - tr.x0) * head;
      const hy = tr.y0 + (tr.y1 - tr.y0) * head;
      const tx = tr.x0 + (tr.x1 - tr.x0) * tail * 0.85;
      const ty = tr.y0 + (tr.y1 - tr.y0) * tail * 0.85;
      const rgb = tr.hostile ? '255,120,80' : '255,236,176';
      ctx.strokeStyle = `rgba(${rgb},${(0.35 * (1 - u)).toFixed(3)})`;
      ctx.lineWidth = 0.14;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,248,225,${(0.95 * (1 - u)).toFixed(3)})`;
      ctx.lineWidth = tr.weapon === 'shotgun' ? 0.03 : 0.045;
      ctx.stroke();
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const age = s.t - f.t0;
      if (age > 0.12 || age < -1) {
        this.flashes.splice(i, 1);
        continue;
      }
      const u = age / 0.12;
      const g = glowSprite('255,200,120');
      if (g) {
        // The flash lights up everything nearby, more so in the dark.
        const R = (2.6 + (s.night ? 2.4 : 0)) * f.big;
        ctx.globalAlpha = (s.night ? 0.8 : 0.45) * (1 - u);
        ctx.drawImage(g, f.x - R, f.y - R, 2 * R, 2 * R);
      }
      ctx.globalAlpha = 1 - u;
      ctx.fillStyle = 'rgba(255,240,190,1)';
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.a);
      const L = (0.45 + 0.25 * f.big) * (1 - u * 0.5);
      ctx.beginPath();
      ctx.moveTo(0, 0.09);
      ctx.lineTo(L, 0);
      ctx.lineTo(0, -0.09);
      ctx.lineTo(-0.08, 0);
      ctx.closePath();
      ctx.moveTo(0.05, 0);
      ctx.lineTo(0.2, 0.22);
      ctx.lineTo(0.12, 0);
      ctx.lineTo(0.2, -0.22);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'butt';
  }

  /**
   * Aim telegraphs: a hard glint at the gun of each figure about to shoot (spec §7.2: the tell
   * players dodge by). `muzzleOf(key)` gives the figure's drawn muzzle, or null if unseen.
   */
  drawGlints(s: Scene, muzzleOf: (key: string) => { x: number; y: number } | null, telegraph: (key: string) => number): void {
    const { ctx } = s;
    setWorld(s);
    for (const [key, t0] of this.aims) {
      const dur = telegraph(key);
      const age = s.t - t0;
      if (age > dur + 0.15 || age < -1) {
        this.aims.delete(key);
        continue;
      }
      const m = muzzleOf(key);
      if (!m) continue;
      const u = clamp01(age / dur);
      // Grows through the telegraph, flares at the end.
      const pulse = 0.55 + 0.45 * Math.sin(u * Math.PI * 3.5);
      const r = (0.28 + 0.4 * u) * (0.8 + 0.2 * pulse);
      const g = glowSprite('255,244,210');
      ctx.globalCompositeOperation = 'lighter';
      if (g) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(g, m.x - r * 3, m.y - r * 3, r * 6, r * 6);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FFFFFF';
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(u * 1.6);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const rr = i % 2 === 0 ? r * 1.6 : r * 0.22;
        const px = Math.cos(a) * rr;
        const py = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.globalCompositeOperation = 'source-over';
      // A tightening red ring: danger, now.
      ctx.strokeStyle = `rgba(224,68,46,${(0.85 * (1 - u * 0.3)).toFixed(3)})`;
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 1.1 - 0.75 * u, 0, TAU);
      ctx.stroke();
    }
  }

  drawExplosions(s: Scene): void {
    const { ctx } = s;
    setWorld(s);
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      const age = s.t - e.t0;
      if (age > 1.6 || age < -1) {
        this.explosions.splice(i, 1);
        continue;
      }
      const x = e.s - s.odo;
      const u = age / 1.6;
      const R = (1.5 + 5 * Math.pow(u, 0.4)) * e.big;
      ctx.globalCompositeOperation = 'lighter';
      const g = glowSprite('255,170,80');
      if (g) {
        ctx.globalAlpha = Math.max(0, 1 - u * 1.4);
        const G = R * 3.2;
        ctx.drawImage(g, x - G, e.y - G, 2 * G, 2 * G);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      // Fireball: layers of lumpy puffs, white-hot core, orange, then a dark rim that rises and cools.
      if (u < 0.6) {
        const k = u / 0.6;
        const rise = k * R * 0.35;
        const layers: [string, number, number][] = [
          ['120,40,16', 1.0, 0.85],
          ['226,96,30', 0.78, 0.9],
          ['255,176,64', 0.55, 0.95],
          ['255,244,200', 0.3, 1],
        ];
        for (let li = 0; li < layers.length; li++) {
          const [rgb, sz, a0] = layers[li];
          const fade = li === layers.length - 1 ? Math.max(0, 1 - k * 2.2) : 1 - k;
          if (fade <= 0.01) continue;
          ctx.fillStyle = `rgba(${rgb},${(a0 * fade).toFixed(3)})`;
          ctx.beginPath();
          const rr = R * sz * (0.7 + 0.3 * (1 - k));
          for (let j = 0; j < 7; j++) {
            const a = (j / 7) * TAU + e.t0 * 3 + li;
            const cx = x + Math.cos(a) * rr * 0.55;
            const cy = e.y + rise + Math.sin(a) * rr * 0.45 + rr * 0.25;
            const pr = rr * (0.42 + 0.12 * Math.sin(j * 2.3 + li));
            ctx.moveTo(cx + pr, cy);
            ctx.arc(cx, cy, pr, 0, TAU);
          }
          ctx.fill();
        }
      }
      // Shock ring.
      if (u < 0.35) {
        ctx.strokeStyle = `rgba(255,250,235,${(0.6 * (1 - u / 0.35)).toFixed(3)})`;
        ctx.lineWidth = 0.18;
        ctx.beginPath();
        ctx.ellipse(x, e.y, R * 2.2, R * 1.1, 0, 0, TAU);
        ctx.stroke();
      }
    }
  }

  drawTumbles(s: Scene): void {
    const { ctx } = s;
    setWorld(s);
    const p = this.pose;
    for (let i = this.tumbles.length - 1; i >= 0; i--) {
      const tb = this.tumbles[i];
      const age = s.t - tb.t0;
      if (age > 3.2 || age < -1) {
        this.tumbles.splice(i, 1);
        continue;
      }
      const x = tb.s - s.odo;
      if (x < s.left - 4 || x > s.right + 4) continue;
      p.kind = tb.kind;
      p.tier = tb.tier;
      p.facing = tb.facing;
      p.scale = tb.kind === 'boss' ? 1.18 : 1;
      p.crouch = 0.35;
      p.air = 1;
      p.aim = null;
      p.hands = 'none';
      p.stagger = 0;
      p.tilt = 0;
      p.t = s.t;
      ctx.globalAlpha = 1 - clamp01((age - 2.4) / 0.8);
      ctx.save();
      ctx.translate(x, tb.y + 0.5);
      ctx.rotate(tb.rot);
      this.fig.draw(ctx, s.litFig, p, 0, -0.5, null);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Figures washed off in a ford: thrashing with the water at their chests, left behind as the train
   * runs on, then carried off downstream along the river's course, smaller and fainter. Only what
   * is above the water is drawn; rings spread on the surface round them.
   */
  drawSwept(s: Scene): void {
    const { ctx } = s;
    setWorld(s);
    const p = this.pose;
    const ring = s.night ? '170,190,225' : '242,248,250';
    for (let i = this.swepts.length - 1; i >= 0; i--) {
      const sw = this.swepts[i];
      const age = s.t - sw.t0;
      if (age > 3.4 || age < -1) {
        this.swepts.splice(i, 1);
        continue;
      }
      const x = sw.s - s.odo;
      if (x < s.left - 4 || x > s.right + 4) continue;
      const away = smoothstep(0.6, 3.2, age);
      const sc = (sw.kind === 'boss' ? 1.18 : 1) * (1 - 0.5 * away);
      // Downstream is away from the line, up the screen into the river's course.
      const water = FORD_WATER_Y + 1.1 * away;
      const bob = 0.07 * Math.sin(s.t * 4.3 + sw.seed) * (1 - 0.5 * away);
      const feet = water - (FORD_WATER_Y - sw.y) * sc + bob;
      const alpha = 1 - clamp01((age - 2.6) / 0.8);
      p.kind = sw.kind;
      p.tier = sw.tier;
      p.facing = sw.facing;
      p.scale = sc;
      p.phase = 0;
      p.gait = 0;
      p.crouch = 0.15;
      p.aim = null;
      p.recoil = 0;
      p.climb = false;
      p.air = 1;
      p.stunned = false;
      p.stagger = 0;
      p.tilt = 0.25 * Math.sin(s.t * 2.1 + sw.seed);
      p.hurt = 0;
      p.wind = 0;
      p.loot = false;
      p.hands = 'flail';
      p.seated = false;
      p.stand = 0;
      p.t = s.t;
      p.seed = sw.seed;
      ctx.globalAlpha = alpha;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 3, water, 6, 8);
      ctx.clip();
      this.fig.draw(ctx, s.litFig, p, x, feet, null);
      ctx.restore();
      ctx.lineWidth = 0.05 * sc;
      for (let k = 0; k < 2; k++) {
        const ph = (s.t * 1.3 + k * 0.5 + sw.seed) % 1;
        ctx.strokeStyle = `rgba(${ring},${(0.75 * (1 - ph) * alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(x, water, (0.35 + 0.8 * ph) * sc, (0.05 + 0.07 * ph) * sc, 0, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Water flung up by the thrashing arms.
      if (s.dt > 0 && age < 2.4 && this.rand() < s.dt * 7) {
        this.spawn(s, P_WATER, x + (this.rand() - 0.5) * 0.7 * sc, water + 0.35 * sc, (this.rand() - 0.5) * 2, 1.5 + 2 * this.rand(), 0.05, 0, 0.6, 0, water - 0.1);
      }
    }
  }

  drawRiderless(s: Scene): void {
    const { ctx } = s;
    setWorld(s);
    for (let i = this.horses.length - 1; i >= 0; i--) {
      const h = this.horses[i];
      const age = s.t - h.t0;
      if (age > 3 || age < -1) {
        this.horses.splice(i, 1);
        continue;
      }
      h.s += h.v * s.dt;
      h.phase = (h.phase + (Math.abs(h.v) * s.dt) / 5.6) % 1;
      const x = h.s - s.odo;
      if (x < s.left - 4 || x > s.right + 4) continue;
      ctx.globalAlpha = 1 - clamp01((age - 2) / 1);
      // Veering away from the track, into the distance.
      const away = clamp01(age / 3);
      ctx.save();
      ctx.translate(x, LANE_Y + away * 2.2);
      ctx.scale(1 - away * 0.25, 1 - away * 0.25);
      drawHorse(ctx, s.litFig, h.look, { facing: h.facing, phase: h.phase, gallop: 1, graze: 0, t: s.t, seed: i }, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /** A red flash at the edges of the view when the Rider is hurt. */
  drawHurt(s: Scene): void {
    const age = s.now - this.hurtT0;
    if (!(age >= 0 && age < 0.45)) return;
    const { ctx, cam } = s;
    const u = 1 - age / 0.45;
    const grad = ctx.createRadialGradient(cam.w / 2, cam.h / 2, Math.min(cam.w, cam.h) * 0.3, cam.w / 2, cam.h / 2, Math.hypot(cam.w, cam.h) / 2);
    grad.addColorStop(0, 'rgba(160,20,10,0)');
    grad.addColorStop(1, `rgba(170,24,12,${(0.55 * u).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cam.w, cam.h);
  }

  clear(): void {
    this.n = 0;
    this.tracers.length = 0;
    this.flashes.length = 0;
    this.explosions.length = 0;
    this.tumbles.length = 0;
    this.horses.length = 0;
    this.swepts.length = 0;
    this.shakes.length = 0;
    this.jolts.length = 0;
    this.aims.clear();
    this.shots.clear();
  }

  get count(): number {
    return this.n;
  }
}

