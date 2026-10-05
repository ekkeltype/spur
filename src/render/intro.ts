// The run's opening shot (spec §3, §18.2): a few seconds close on the locomotive's running gear as it
// gets under way from the origin, while the run's title comes up over it (the title is DOM, in
// src/ui/intro.ts). Everything here is a pure function of the seconds since the shot began, so any frame
// can be drawn at any moment and both seats see the same one.
//
// The drivers turn through the same distance the engine's sound counts its exhaust beats along (Sfx's
// CHUFF_PATTERN: a beat every quarter turn of a 5 m driver), and every beat puffs steam from the cylinder
// cocks and smoke from the stack, so what's heard and what's seen keep time. The title lands on the
// first beat.
//
// The picture is drawn in metres in the locomotive's frame (y up, the rails' top at 0, the rear driver's
// axle at x = 0, running to the right). Behind the engine, layers at parallax f slide past at f times
// the train's speed and stand between the horizon (f = 0) and the rails (f = 1).

import { CHUFFS_PER_REV, DRIVER_CIRCUMFERENCE } from '../audio/sfx';
import { INTRO_SECONDS } from '../sim/rules';
import { HiDpiCanvas } from './canvas';
import { PALETTE } from './palette';
import { type Lit, LitCache } from './rider/materials';
import { hash01, noise1 } from './rider/parallax';
import { type RGB, rgbStr, skyAt, type SkyInfo } from './rider/sky';

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** 0 at or below e0, 1 at or above e1, smooth between. */
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
const easeOut = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
const easeInOut = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));

// ---- The timeline: seconds from the start of the shot ------------------------------------------------

/** Up from black. */
const FADE_IN = 0.6;
/** Down onto the play screen, over the shot's last this-many seconds. */
const FADE_OUT = 0.8;
/** The throttle opens (the lever's clank), the cylinder cocks roar and the drivers start to turn. */
export const THROTTLE_AT = 1.0;
/** How hard the engine pulls away (m/s²), up to the speed it holds (m/s, about 20 mph). */
const ACCEL = 2;
export const INTRO_CRUISE = 9;
const RAMP = INTRO_CRUISE / ACCEL;
const RAMP_TRAVEL = (ACCEL * RAMP * RAMP) / 2;
/** Metres travelled per exhaust beat. */
export const BEAT_TRAVEL = DRIVER_CIRCUMFERENCE / CHUFFS_PER_REV;
/** The drivers' radius (m): the wheel the sound counts beats round. */
const DRIVER_R = DRIVER_CIRCUMFERENCE / TAU;

/** Speed (m/s, real seconds) at t. */
export function introSpeed(t: number): number {
  const u = t - THROTTLE_AT;
  return u <= 0 ? 0 : Math.min(INTRO_CRUISE, ACCEL * u);
}

/** Metres travelled by t. */
export function introTravel(t: number): number {
  const u = t - THROTTLE_AT;
  if (u <= 0) return 0;
  if (u <= RAMP) return (ACCEL * u * u) / 2;
  return RAMP_TRAVEL + INTRO_CRUISE * (u - RAMP);
}

/** When the engine has travelled d metres (d > 0). */
export function introTimeAt(d: number): number {
  if (d <= 0) return THROTTLE_AT;
  if (d <= RAMP_TRAVEL) return THROTTLE_AT + Math.sqrt((2 * d) / ACCEL);
  return THROTTLE_AT + RAMP + (d - RAMP_TRAVEL) / INTRO_CRUISE;
}

/** The throttle the engine's sound is given at t. */
export function introThrottle(t: number): number {
  return t >= THROTTLE_AT ? 0.9 : 0;
}

/** The exhaust beat k (k ≥ 1) comes after k quarter turns, as the engine's sound counts them. */
export function beatTime(k: number): number {
  return introTimeAt(k * BEAT_TRAVEL);
}

/** The first beat: the title lands on it and the whistle sounds with it. */
export const FIRST_BEAT_AT = beatTime(1);

/** The sound's cues (played by src/ui/intro.ts). */
export const INTRO_CUES = {
  /** The safety valve blowing off while the engine stands. */
  valve: [0.1, 0.95],
  /** The bell, swung three times. */
  bells: [0.3, 0.8, 1.3],
  /** The throttle lever. */
  lever: THROTTLE_AT - 0.03,
  /** One long blast as the title lands. */
  whistle: [FIRST_BEAT_AT + 0.05, FIRST_BEAT_AT + 1.5],
  /** The engine's sound fades from here, ahead of the picture. */
  engineOff: INTRO_SECONDS - 0.6,
} as const;

// ---- The title's look (applied to the DOM by src/ui/intro.ts) --------------------------------------

export interface IntroTitleLook {
  /** Black over the whole shot: the fade up. */
  veil: number;
  /** The letterbox bars, 0 (gone) to 1 (in). */
  bars: number;
  /** The whole shot's opacity: it fades out onto the play screen. */
  opacity: number;
  kicker: { opacity: number; dy: number };
  name: { opacity: number; scale: number; dy: number };
  /** The rule under the name, drawn out from the middle (0..1). */
  rule: number;
  route: { opacity: number; dy: number };
}

/** The title at t. `motion` off (no screen shake) keeps the fades and drops the stamp and slides. */
export function introTitleLook(t: number, motion: boolean): IntroTitleLook {
  const T = FIRST_BEAT_AT;
  const m = (v: number): number => (motion ? v : 0);
  const kicker = smooth(T - 0.4, T - 0.05, t);
  // The name is stamped on with the first beat: in large, slammed down, a jolt as it lands.
  const p = clamp01((t - T) / 0.32);
  const nameIn = smooth(T - 0.03, T + 0.08, t);
  const jolt = p > 0 && p < 1 ? Math.sin(p * Math.PI * 3) * (1 - p) * 4 : 0;
  const route = smooth(T + 0.45, T + 0.95, t);
  return {
    veil: 1 - smooth(0, FADE_IN, t),
    bars: smooth(0, 0.7, t) * (1 - smooth(INTRO_SECONDS - FADE_OUT, INTRO_SECONDS - 0.1, t)),
    opacity: 1 - smooth(INTRO_SECONDS - FADE_OUT, INTRO_SECONDS, t),
    kicker: { opacity: kicker, dy: m((1 - kicker) * 10) },
    name: { opacity: nameIn, scale: 1 + m(0.28 * (1 - easeOut(p))), dy: m(jolt) },
    rule: easeOut((t - T - 0.12) / 0.6),
    route: { opacity: route, dy: m((1 - route) * 8) },
  };
}

// ---- The camera ---------------------------------------------------------------------------------------

export interface IntroCamera {
  /** The view's centre (m) and the width it takes in (m). */
  x: number;
  y: number;
  w: number;
}

/** Tight on the crosshead and rods at first, drawing back to the whole front of the engine. Held still without motion. */
export function introCamera(t: number, motion: boolean): IntroCamera {
  const p = motion ? easeInOut(t / INTRO_SECONDS) : 0.6;
  return { x: lerp(4.1, 3.2, p), y: lerp(1.0, 3.0, p), w: lerp(4.6, 14.5, p) };
}

// ---- Steam and smoke --------------------------------------------------------------------------------

/** A puff, in the loco's frame (m). */
export interface Puff {
  x: number;
  y: number;
  r: number;
  alpha: number;
  /** Stack smoke (grey) rather than white steam. */
  smoke: boolean;
}

/** Where the cylinder cocks blow (m), and which way: the rear one back, the front one forward. */
const COCKS: readonly { x: number; y: number; dir: -1 | 1 }[] = [
  { x: 5.12, y: 0.55, dir: -1 },
  { x: 6.38, y: 0.55, dir: 1 },
];
/** The stack's top (m). */
const STACK_TOP = { x: 6.45, y: 5.45 };
const COCK_LIFE = 1.4;
const WISP_LIFE = 1.2;
const WISP_EVERY = 0.13;
const SMOKE_LIFE = 2.3;
const LAZY_EVERY = 0.22;

/** How hard the cocks blow on a beat at speed v: open at a start, shut once it's rolling. */
function cocksOpen(v: number): number {
  return 1 - smooth(1.5, 4.5, v);
}

/** Every puff alive at t. Beat 0 is the throttle opening (the cocks roar before the first exhaust beat). */
export function introPuffs(t: number, out: Puff[] = []): Puff[] {
  out.length = 0;
  const s = introTravel(t);
  // The engine standing: steam curling from the cocks, smoke lazing from the stack.
  for (let i = 0; i * WISP_EVERY <= Math.min(t, THROTTLE_AT + 0.2); i++) {
    const te = i * WISP_EVERY;
    const age = t - te;
    if (age >= WISP_LIFE) continue;
    const h = hash01(i, 11);
    const c = COCKS[h < 0.5 ? 0 : 1];
    const f = age / WISP_LIFE;
    out.push({
      x: c.x + c.dir * (0.1 + 0.35 * age) - (s - introTravel(te)) + (hash01(i, 12) - 0.5) * 0.2,
      y: c.y - 0.05 + 0.3 * age * age + 0.12 * age,
      r: 0.07 + 0.4 * age,
      alpha: 0.45 * (1 - f) ** 1.5 * smooth(0, 0.15, age),
      smoke: false,
    });
  }
  for (let i = 0; i * LAZY_EVERY <= Math.min(t, THROTTLE_AT + 0.4); i++) {
    const te = i * LAZY_EVERY;
    const age = t - te;
    if (age >= SMOKE_LIFE) continue;
    const f = age / SMOKE_LIFE;
    out.push({
      x: STACK_TOP.x + (hash01(i, 13) - 0.5) * 0.3 - 0.25 * age - (s - introTravel(te)) * 0.85,
      y: STACK_TOP.y + 0.7 * age,
      r: 0.28 + 0.5 * age,
      alpha: 0.55 * (1 - f) ** 1.4 * smooth(0, 0.3, age),
      smoke: true,
    });
  }
  // The beats: the cocks blast (while they're open), the stack coughs.
  for (let k = 0; k < 1000; k++) {
    const tk = k === 0 ? THROTTLE_AT : beatTime(k);
    if (tk > t) break;
    const age = t - tk;
    const drift = s - introTravel(tk);
    const open = cocksOpen(introSpeed(tk)) * (k === 0 ? 1.2 : 1);
    if (open > 0.02 && age < COCK_LIFE) {
      const f = age / COCK_LIFE;
      const reach = (1 - Math.exp(-age * 3.2)) / 3.2;
      for (const [ci, c] of COCKS.entries()) {
        for (let j = 0; j < 4; j++) {
          const h1 = hash01(k * 16 + ci * 4 + j, 21);
          const h2 = hash01(k * 16 + ci * 4 + j, 22);
          const speed = 3.2 + 2.2 * h1;
          out.push({
            x: c.x + c.dir * speed * reach - drift,
            y: c.y - (0.9 + 0.8 * h2) * reach + 0.45 * age * age,
            r: 0.1 + (0.55 + 0.45 * h2) * age,
            alpha: Math.min(0.85, 0.75 * open) * (1 - f) ** 1.6,
            smoke: false,
          });
        }
      }
    }
    if (k > 0 && age < SMOKE_LIFE) {
      const f = age / SMOKE_LIFE;
      // Blasted up, then laid back over the train by its speed.
      const lift = (1 - Math.exp(-age * 3)) / 3;
      for (let j = 0; j < 3; j++) {
        const h1 = hash01(k * 8 + j, 31);
        out.push({
          x: STACK_TOP.x + (h1 - 0.5) * 0.5 - 0.3 * j - drift * 0.9,
          y: STACK_TOP.y + (2.4 + 1.4 * h1) * lift + 0.35 * age + 0.1 * j,
          r: 0.3 + (0.8 + 0.5 * h1) * age,
          alpha: 0.7 * (1 - f) ** 1.3 * smooth(0, 0.05, age),
          smoke: true,
        });
      }
    }
  }
  return out;
}

// ---- Mechanism --------------------------------------------------------------------------------------

/** The drivers (axle x, m), the leading truck's wheels, and their radii. */
const DRIVERS = [0, 2.25] as const;
const TRUCK = [5.25, 6.8] as const;
const TRUCK_R = 0.45;
/** Crank radius (m), the main rod's length, and the height of the crosshead's line. */
const CRANK = 0.34;
const MAIN_ROD = 2.2;
const GUIDE_Y = 0.95;
/** The expansion link's pivot, the radius rod's length and the valve stem's height. */
const LINK = { x: 3.05, y: 1.45 };
const RADIUS_ROD = 1.3;
const STEM_Y = 1.58;

/** The moving parts at driver angle theta (clockwise, rolling right); `bob` lifts everything on the springs. */
export interface Gear {
  /** Crank pins on the rear and front drivers. */
  pins: [[number, number], [number, number]];
  /** The crosshead's wrist pin. */
  cross: [number, number];
  /** The return crank's end, the expansion link's foot, its die block, and the valve stem's end. */
  ecc: [number, number];
  linkFoot: [number, number];
  die: [number, number];
  stem: [number, number];
  /** The link's swing (rad). */
  swing: number;
}

export function gearAt(theta: number, bob = 0): Gear {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const pins: Gear['pins'] = [
    [DRIVERS[0] + CRANK * c, DRIVER_R + CRANK * sn],
    [DRIVERS[1] + CRANK * c, DRIVER_R + CRANK * sn],
  ];
  const gy = GUIDE_Y + bob;
  const [px, py] = pins[1];
  const cross: [number, number] = [px + Math.sqrt(Math.max(0, MAIN_ROD * MAIN_ROD - (gy - py) * (gy - py))), gy];
  // The return crank leads the main crank by a quarter turn, rocking the link through its eccentric rod.
  const ecc: [number, number] = [px + 0.22 * Math.cos(theta + Math.PI / 2), py + 0.22 * Math.sin(theta + Math.PI / 2)];
  const swing = 0.3 * Math.cos(theta);
  const lx = LINK.x;
  const ly = LINK.y + bob;
  const linkFoot: [number, number] = [lx + 0.3 * Math.sin(swing), ly - 0.3 * Math.cos(swing)];
  const die: [number, number] = [lx - 0.14 * Math.sin(swing), ly + 0.14 * Math.cos(swing)];
  const sy = STEM_Y + bob;
  const stem: [number, number] = [die[0] + Math.sqrt(Math.max(0, RADIUS_ROD * RADIUS_ROD - (sy - die[1]) * (sy - die[1]))), sy];
  return { pins, cross, ecc, linkFoot, die, stem, swing };
}

/** The drivers' angle after travelling s metres (clockwise: rolling to the right). */
export function driverAngle(s: number): number {
  return -s / DRIVER_R;
}

// ---- Drawing ----------------------------------------------------------------------------------------

export interface IntroLook {
  /** The run's clock at the start (s since midnight) and whether it's a night run: the sky and the light. */
  clock: number;
  night: boolean;
  /** Camera moves and the loco's jolts; off with screen shake off. */
  motion: boolean;
  /** Varies the country behind the engine from run to run. */
  seed: number;
}

// The engine's paint: Russia iron boiler, black smokebox and stack, red wheels, brass and polished steel.
const IRON = '#1E1C1C';
const BOILER = '#56636E';
const BOILER_HI = '#8494A0';
const BOILER_LO = '#2C343B';
const WHEEL_RED = '#9E2B1E';
const WEIGHT = '#7A2A1E';
const STEEL = '#C9C9CE';
const STEEL_DARK = '#8A8A90';
const BRASS = PALETTE.brass;
const BRASS_DARK = '#7A5A2A';
const CAB = '#7A3B22';
const CAB_DARK = '#4E2616';
const INK = PALETTE.ink;

export class IntroRenderer {
  private readonly hd: HiDpiCanvas;
  private readonly lits = new LitCache();
  private readonly puffs: Puff[] = [];
  private readonly sprites = new Map<string, HTMLCanvasElement>();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.hd = new HiDpiCanvas(canvas);
  }

  draw(t: number, look: IntroLook): void {
    const ctx = this.hd.begin();
    const w = this.hd.width;
    const h = this.hd.height;
    const dpr = this.hd.dpr;
    const sky = skyAt(look.clock, look.night);
    // A little kinder than the run's own light: it's the opening shot, and it has to read.
    const amb: RGB = [lerp(sky.amb[0], 1, 0.3), lerp(sky.amb[1], 1, 0.3), lerp(sky.amb[2], 1, 0.3)];
    const lit = this.lits.rgb(amb);
    const cam = introCamera(t, look.motion);
    // Fit the width, but never show less than half as much height (very wide screens show more width).
    const k = Math.min(w / cam.w, h / (cam.w * 0.5));
    const s = introTravel(t);
    const v = introSpeed(t);
    const theta = driverAngle(s);
    // The engine rocks on its springs with the beats, harder while it's working up to speed.
    const bob = look.motion ? 0.012 * Math.sin(theta * CHUFFS_PER_REV) * smooth(0, 2, v) * (1 - 0.5 * smooth(5, 9, v)) : 0;
    const railY = h / 2 + cam.y * k;
    const horizonY = h * 0.5;

    this.background(ctx, w, h, sky, lit, look, k, cam, s, railY, horizonY);

    // The engine, in metres.
    ctx.setTransform(dpr * k, 0, 0, -dpr * k, dpr * (w / 2 - cam.x * k), dpr * railY);
    trackbed(ctx, lit, s, cam, k, w, h, railY);
    drawEngine(ctx, lit, t, s, v, theta, bob, look.night || sky.light < 0.7);
    this.steam(ctx, lit, t, look);
    if (look.night || sky.light < 0.75) headlampGlow(ctx, bob, look.night ? 1 : 0.55);

    // Screen space: a vignette.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vg = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.3, w / 2, h * 0.55, Math.hypot(w, h) * 0.62);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(8,5,3,0.62)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  private background(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    sky: SkyInfo,
    lit: Lit,
    look: IntroLook,
    k: number,
    cam: IntroCamera,
    s: number,
    railY: number,
    horizonY: number,
  ): void {
    const g = ctx.createLinearGradient(0, 0, 0, horizonY);
    g.addColorStop(0, rgbStr(sky.top));
    g.addColorStop(1, rgbStr(sky.horizon));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, horizonY + 1);
    // The sun low on the horizon, or the moon and a few stars.
    if (sky.sun > -0.2 && !look.night) {
      const sx = w * 0.18;
      const sy = horizonY - Math.max(0, sky.sun) * h * 0.5;
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, w * 0.45);
      glow.addColorStop(0, 'rgba(255,226,170,0.75)');
      glow.addColorStop(0.2, 'rgba(255,196,130,0.35)');
      glow.addColorStop(1, 'rgba(255,180,120,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, horizonY + 1);
    } else if (sky.light < 0.6) {
      ctx.fillStyle = 'rgba(221,230,240,0.8)';
      for (let i = 0; i < 40; i++) {
        const x = hash01(i, look.seed + 41) * w;
        const y = hash01(i, look.seed + 42) * horizonY * 0.85;
        const r = 0.6 + hash01(i, look.seed + 43) * 0.9;
        ctx.fillRect(x, y, r, r);
      }
      const mx = w * 0.78;
      const my = horizonY * 0.28;
      const moon = ctx.createRadialGradient(mx, my, 0, mx, my, h * 0.2);
      moon.addColorStop(0, 'rgba(221,230,240,0.35)');
      moon.addColorStop(1, 'rgba(221,230,240,0)');
      ctx.fillStyle = moon;
      ctx.fillRect(mx - h * 0.2, my - h * 0.2, h * 0.4, h * 0.4);
      ctx.fillStyle = PALETTE.lunar;
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(6, h * 0.022), 0, TAU);
      ctx.fill();
    }
    const haze = rgbStr(sky.horizon);
    // A layer z metres behind the train: its scale against the train's (the camera stands `eye` metres off,
    // drawing back as it widens), where its ground meets the picture, and world x (m, fixed to the ground) on screen.
    const eye = cam.w / 1.1;
    const scale = (z: number): number => eye / (eye + z);
    const ground = (z: number): number => horizonY + (railY - horizonY) * scale(z);
    const sx = (x: number, z: number): number => w / 2 + (x - (cam.x + s)) * k * scale(z);
    const layer = (z: number, colour: string, height: (x: number) => number): void => {
      const f = scale(z);
      const half = w / (2 * k * f);
      const step = (2 * half) / 160;
      const x0 = cam.x + s - half - step;
      const x1 = cam.x + s + half + step;
      const gy = ground(z);
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.moveTo(sx(x0, z), h);
      for (let x = x0; x <= x1; x += step) ctx.lineTo(sx(x, z), gy - height(x) * k * f);
      ctx.lineTo(sx(x1, z), h);
      ctx.closePath();
      ctx.fill();
    };
    // Mesas far off, flat-topped, in the haze; nearer ridges of the desert.
    layer(3000, mixCss(lit.c(PALETTE.mesa), haze, 0.6), (x) => mesa(x, look.seed));
    layer(350, mixCss(lit.c(PALETTE.canyon), haze, 0.4), (x) => 6 + 22 * noise1(x / 60, look.seed + 5) + 8 * noise1(x / 14, look.seed + 6));
    // The flat, hazier toward the ridges, and brush on it.
    const flat = ground(350);
    const fg = ctx.createLinearGradient(0, flat, 0, railY);
    fg.addColorStop(0, mixCss(lit.c(PALETTE.sand), haze, 0.45));
    fg.addColorStop(1, lit.c('#B8955E'));
    ctx.fillStyle = fg;
    ctx.fillRect(0, flat, w, h - flat);
    layer(40, lit.c('#9A7A4E'), (x) => 0.5 * noise1(x * 0.9, look.seed + 7) * (noise1(x / 8, look.seed + 8) > 0.55 ? 1 : 0.15));
    // Telegraph poles along the line behind the train, and their wire.
    const z = 12;
    const f = scale(z);
    const gy = ground(z);
    const spacing = 32;
    const half = w / (2 * k * f);
    const x0 = cam.x + s - half;
    const x1 = cam.x + s + half;
    ctx.strokeStyle = lit.c('#4A3A2E');
    ctx.lineWidth = Math.max(1, 0.22 * k * f);
    ctx.beginPath();
    for (let i = Math.floor(x0 / spacing) - 1; i * spacing <= x1 + spacing; i++) {
      const px = sx(i * spacing + 12, z);
      ctx.moveTo(px, gy);
      ctx.lineTo(px, gy - 7 * k * f);
      ctx.moveTo(px - 0.9 * k * f, gy - 6.5 * k * f);
      ctx.lineTo(px + 0.9 * k * f, gy - 6.5 * k * f);
    }
    ctx.stroke();
    ctx.strokeStyle = lit.a('#2A2118', 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = Math.floor(x0 / spacing) - 1; i * spacing <= x1; i++) {
      const a = sx(i * spacing + 12, z);
      const b = sx((i + 1) * spacing + 12, z);
      const y = gy - 6.5 * k * f;
      ctx.moveTo(a, y);
      ctx.quadraticCurveTo((a + b) / 2, y + 0.6 * k * f, b, y);
    }
    ctx.stroke();
  }

  private steam(ctx: CanvasRenderingContext2D, lit: Lit, t: number, look: IntroLook): void {
    const steam = this.sprite(lit.c(PALETTE.steam));
    const smoke = this.sprite(lit.c(look.night ? '#6A6866' : '#948C84'));
    for (const p of introPuffs(t, this.puffs)) {
      if (p.alpha <= 0.004) continue;
      ctx.globalAlpha = Math.min(1, p.alpha);
      const r = p.r * 1.6;
      ctx.drawImage(p.smoke ? smoke : steam, p.x - r, p.y - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;
  }

  /** A soft round puff in one colour, drawn once and scaled for every puff. */
  private sprite(colour: string): HTMLCanvasElement {
    let c = this.sprites.get(colour);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const x = c.getContext('2d');
    if (x) {
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, withAlphaCss(colour, 1));
      g.addColorStop(0.45, withAlphaCss(colour, 0.65));
      g.addColorStop(1, withAlphaCss(colour, 0));
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
    }
    this.sprites.set(colour, c);
    return c;
  }
}

/** A mesa skyline (m above the flat): tables and buttes with steep sides. */
function mesa(x: number, seed: number): number {
  const table = smooth(0.42, 0.5, noise1(x / 420, seed + 1)) * (90 + 90 * noise1(x / 1300, seed + 2));
  const butte = smooth(0.8, 0.85, noise1(x / 140, seed + 3)) * 150;
  return 8 + Math.max(table, butte) + 6 * noise1(x / 40, seed + 4);
}

/** Mixes two CSS rgb() colours. */
function mixCss(a: string, b: string, t: number): string {
  const pa = rgbOf(a);
  const pb = rgbOf(b);
  return `rgb(${Math.round(lerp(pa[0], pb[0], t))},${Math.round(lerp(pa[1], pb[1], t))},${Math.round(lerp(pa[2], pb[2], t))})`;
}

function withAlphaCss(c: string, a: number): string {
  const [r, g, b] = rgbOf(c);
  return `rgba(${r},${g},${b},${a})`;
}

function rgbOf(c: string): RGB {
  if (c.startsWith('#')) {
    const n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = c.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : [0, 0, 0];
}

// ---- The engine, in metres ---------------------------------------------------------------------------

function trackbed(ctx: CanvasRenderingContext2D, lit: Lit, s: number, cam: IntroCamera, k: number, w: number, h: number, railY: number): void {
  const left = cam.x - w / (2 * k) - 1;
  const right = cam.x + w / (2 * k) + 1;
  const bottom = -(h - railY) / k - 0.1;
  // Ballast, darker toward us.
  const g = ctx.createLinearGradient(0, -0.1, 0, bottom);
  g.addColorStop(0, lit.c('#7A6A58'));
  g.addColorStop(1, lit.c('#3E332A'));
  ctx.fillStyle = g;
  ctx.fillRect(left, bottom, right - left, -0.1 - bottom);
  // Ties, end on, sliding back under us.
  const spacing = 0.58;
  ctx.fillStyle = lit.c('#4A3326');
  for (let i = Math.floor((left + s) / spacing); i * spacing - s <= right; i++) {
    const x = i * spacing - s;
    ctx.fillRect(x, -0.26, 0.24, 0.16);
  }
  ctx.fillStyle = lit.c('#2E2019');
  for (let i = Math.floor((left + s) / spacing); i * spacing - s <= right; i++) ctx.fillRect(i * spacing - s, -0.26, 0.24, 0.035);
  // The rail: web, and a bright head.
  ctx.fillStyle = lit.c('#3A3634');
  ctx.fillRect(left, -0.13, right - left, 0.1);
  ctx.fillStyle = lit.c('#6E6A66');
  ctx.fillRect(left, -0.04, right - left, 0.04);
  ctx.fillStyle = lit.c('#B6B2AC');
  ctx.fillRect(left, -0.015, right - left, 0.015);
  // Rail joints click by.
  ctx.fillStyle = lit.c('#24201E');
  for (let i = Math.floor((left + s) / 12); i * 12 - s <= right; i++) ctx.fillRect(i * 12 - s - 0.2, -0.12, 0.4, 0.07);
}

function drawEngine(ctx: CanvasRenderingContext2D, lit: Lit, t: number, s: number, v: number, theta: number, bob: number, lampLit: boolean): void {
  const b = bob;
  const blur = smooth(4, 10, v);
  // The frame, behind the wheels.
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(-1.3, 1.02 + b, 8.6, 0.3);

  // The cab, its front half in the frame's left edge.
  ctx.fillStyle = lit.c(CAB_DARK);
  ctx.fillRect(-4.2, 1.9 + b, 3.65, 0.25);
  ctx.fillStyle = lit.c(CAB);
  ctx.fillRect(-4.0, 2.15 + b, 3.4, 2.35);
  ctx.fillStyle = lit.c(CAB_DARK);
  for (let x = -3.85; x < -0.7; x += 0.28) ctx.fillRect(x, 2.15 + b, 0.03, 0.95);
  ctx.fillStyle = lamp(lit, lampLit);
  ctx.fillRect(-3.55, 3.25 + b, 1.1, 0.9);
  ctx.fillRect(-2.1, 3.25 + b, 1.1, 0.9);
  ctx.strokeStyle = lit.c(BRASS);
  ctx.lineWidth = 0.06;
  ctx.strokeRect(-3.55, 3.25 + b, 1.1, 0.9);
  ctx.strokeRect(-2.1, 3.25 + b, 1.1, 0.9);
  ctx.fillStyle = lit.c(IRON);
  ctx.beginPath();
  ctx.moveTo(-4.35, 4.45 + b);
  ctx.quadraticCurveTo(-2.3, 4.85 + b, -0.25, 4.45 + b);
  ctx.lineTo(-0.25, 4.6 + b);
  ctx.quadraticCurveTo(-2.3, 5.0 + b, -4.35, 4.6 + b);
  ctx.closePath();
  ctx.fill();

  // The boiler: shaded round, with brass bands.
  const by = 2.8 + b;
  const br = 0.82;
  const g = ctx.createLinearGradient(0, by + br, 0, by - br);
  g.addColorStop(0, lit.c(BOILER_HI));
  g.addColorStop(0.35, lit.c(BOILER));
  g.addColorStop(1, lit.c(BOILER_LO));
  ctx.fillStyle = g;
  ctx.fillRect(-0.6, by - br, 6.4, 2 * br);
  ctx.fillStyle = lit.c(BRASS);
  for (const x of [-0.45, 1.1, 3.6, 5.55]) ctx.fillRect(x, by - br, 0.1, 2 * br);
  // Domes: sand, then steam, brass; the bell between them and the stack, swinging on its yoke.
  dome(ctx, lit, 0.55, by + br - 0.06, 0.38, 0.62);
  dome(ctx, lit, 2.35, by + br - 0.06, 0.45, 0.82);
  bell(ctx, lit, 4.35, by + br, t);
  // The smokebox, the stack and the headlamp.
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(5.7, by - br - 0.04, 1.5, 2 * br + 0.08);
  ctx.fillStyle = lit.c('#34302E');
  ctx.fillRect(7.14, by - br + 0.1, 0.12, 2 * br - 0.2);
  ctx.fillStyle = lit.c('#5A5652');
  for (let i = 0; i < 6; i++) ctx.fillRect(5.78 + i * 0.24, by + br - 0.12, 0.05, 0.05);
  stack(ctx, lit, by + br);
  headlamp(ctx, lit, by + br, lampLit);
  // The running board, with its brass edge.
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(-0.6, 1.9 + b, 7.9, 0.09);
  ctx.fillStyle = lit.c(BRASS);
  ctx.fillRect(-0.6, 1.9 + b, 7.9, 0.025);

  // The leading truck.
  const tt = -s / TRUCK_R;
  for (const x of TRUCK) wheel(ctx, lit, x, TRUCK_R, TRUCK_R, tt, 10, blur, false);
  // The cylinder and steam chest, over the truck.
  cylinder(ctx, lit, b);
  // The drivers.
  for (const x of DRIVERS) wheel(ctx, lit, x, DRIVER_R, DRIVER_R, theta, 14, blur, true);
  // The motion: guides, crosshead, rods and the valve gear.
  motion(ctx, lit, gearAt(theta, b), b);
  // The pilot and the buffer beam.
  pilot(ctx, lit, b);
}

function lamp(lit: Lit, lampLit: boolean): string {
  return lampLit ? '#F2C66A' : lit.c('#3A4048');
}

function dome(ctx: CanvasRenderingContext2D, lit: Lit, cx: number, base: number, halfW: number, hgt: number): void {
  ctx.fillStyle = lit.c(BRASS);
  ctx.beginPath();
  ctx.moveTo(cx - halfW - 0.1, base);
  ctx.quadraticCurveTo(cx - halfW, base + 0.06, cx - halfW * 0.85, base + hgt * 0.6);
  ctx.quadraticCurveTo(cx, base + hgt * 1.15, cx + halfW * 0.85, base + hgt * 0.6);
  ctx.quadraticCurveTo(cx + halfW, base + 0.06, cx + halfW + 0.1, base);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = lit.c(BRASS_DARK);
  ctx.lineWidth = 0.035;
  ctx.stroke();
  ctx.fillStyle = lit.c('#EED9A6');
  ctx.fillRect(cx - halfW * 0.5, base + hgt * 0.25, 0.07, hgt * 0.4);
}

/** The bell swings once for each ring of the intro's bell cues, dying away. */
export function bellSwing(t: number): number {
  let a = 0;
  for (const [i, at] of INTRO_CUES.bells.entries()) {
    const age = t - at + 0.12;
    if (age > 0) a += (i % 2 === 0 ? 1 : -1) * 0.5 * Math.sin(Math.min(age, 1.5) * Math.PI * 2) * Math.exp(-age * 1.6) * (age < 1.5 ? 1 : 0);
  }
  return a;
}

function bell(ctx: CanvasRenderingContext2D, lit: Lit, x: number, top: number, t: number): void {
  // The yoke.
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x - 0.3, top - 0.02, 0.08, 0.62);
  ctx.fillRect(x + 0.22, top - 0.02, 0.08, 0.62);
  ctx.fillRect(x - 0.3, top + 0.56, 0.6, 0.06);
  const a = bellSwing(t);
  ctx.save();
  ctx.translate(x, top + 0.56);
  ctx.rotate(a);
  ctx.fillStyle = lit.c(BRASS);
  ctx.beginPath();
  ctx.moveTo(-0.08, 0);
  ctx.quadraticCurveTo(-0.2, -0.05, -0.22, -0.3);
  ctx.lineTo(-0.28, -0.38);
  ctx.lineTo(0.28, -0.38);
  ctx.lineTo(0.22, -0.3);
  ctx.quadraticCurveTo(0.2, -0.05, 0.08, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = lit.c('#EED9A6');
  ctx.fillRect(-0.13, -0.3, 0.04, 0.2);
  ctx.restore();
}

function stack(ctx: CanvasRenderingContext2D, lit: Lit, top: number): void {
  const x = STACK_TOP.x;
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x - 0.22, top - 0.1, 0.44, 0.95);
  // The balloon: flaring out to the spark arrester, and its cap.
  ctx.beginPath();
  ctx.moveTo(x - 0.22, top + 0.8);
  ctx.quadraticCurveTo(x - 0.62, top + 1.3, x - 0.6, top + 1.75);
  ctx.lineTo(x + 0.6, top + 1.75);
  ctx.quadraticCurveTo(x + 0.62, top + 1.3, x + 0.22, top + 0.8);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(x - 0.68, top + 1.72, 1.36, 0.12);
  ctx.fillStyle = lit.c('#3A3634');
  ctx.fillRect(x - 0.55, top + 1.6, 1.1, 0.05);
  ctx.fillStyle = lit.c(BRASS);
  ctx.fillRect(x - 0.24, top + 0.15, 0.48, 0.06);
}

function headlamp(ctx: CanvasRenderingContext2D, lit: Lit, top: number, lampLit: boolean): void {
  const x = 6.7;
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x - 0.05, top - 0.02, 0.9, 0.08);
  ctx.fillStyle = lit.c('#2E2B2A');
  ctx.fillRect(x, top + 0.06, 0.8, 0.62);
  ctx.fillStyle = lit.c(BRASS);
  ctx.fillRect(x - 0.03, top + 0.64, 0.86, 0.08);
  ctx.fillRect(x + 0.3, top + 0.72, 0.2, 0.14);
  ctx.fillStyle = lamp(lit, lampLit);
  ctx.fillRect(x + 0.74, top + 0.14, 0.12, 0.46);
  ctx.fillStyle = lit.c(PALETTE.canyon);
  ctx.fillRect(x + 0.08, top + 0.2, 0.5, 0.34);
}

function headlampGlow(ctx: CanvasRenderingContext2D, b: number, strength: number): void {
  const x = 7.6;
  const y = 3.62 + b + 0.37;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createRadialGradient(x, y, 0, x, y, 3.2);
  g.addColorStop(0, `rgba(255,214,140,${0.55 * strength})`);
  g.addColorStop(0.25, `rgba(255,190,110,${0.18 * strength})`);
  g.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.25);
  ctx.lineTo(x + 9, y + 2.2);
  ctx.lineTo(x + 9, y - 2.4);
  ctx.lineTo(x, y - 0.25);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function cylinder(ctx: CanvasRenderingContext2D, lit: Lit, b: number): void {
  const gy = GUIDE_Y + b;
  // Steam chest above, the saddle up to the smokebox.
  ctx.fillStyle = lit.c('#2E3236');
  ctx.fillRect(5.3, gy + 0.3, 1.6, 0.66);
  ctx.fillStyle = lit.c('#3E4449');
  ctx.fillRect(5.12, gy + 0.34, 1.26, 0.42);
  ctx.fillStyle = lit.c(STEEL_DARK);
  ctx.fillRect(5.06, gy + 0.34, 0.08, 0.42);
  ctx.fillRect(6.36, gy + 0.34, 0.08, 0.42);
  // The cylinder: lagged, with brass bands and polished covers.
  const g = ctx.createLinearGradient(0, gy - 0.34, 0, gy + 0.34);
  g.addColorStop(0, lit.c('#262B30'));
  g.addColorStop(0.6, lit.c('#4A545C'));
  g.addColorStop(1, lit.c('#39424A'));
  ctx.fillStyle = g;
  ctx.fillRect(5.08, gy - 0.34, 1.34, 0.68);
  ctx.fillStyle = lit.c(BRASS);
  ctx.fillRect(5.3, gy - 0.34, 0.05, 0.68);
  ctx.fillRect(6.15, gy - 0.34, 0.05, 0.68);
  ctx.fillStyle = lit.c(STEEL);
  ctx.fillRect(4.98, gy - 0.3, 0.12, 0.6);
  ctx.fillRect(6.4, gy - 0.3, 0.12, 0.6);
  // The cocks under it, where the steam blows.
  ctx.fillStyle = lit.c(BRASS_DARK);
  for (const c of COCKS) ctx.fillRect(c.x - 0.04, gy - 0.44, 0.08, 0.12);
}

function wheel(ctx: CanvasRenderingContext2D, lit: Lit, cx: number, cy: number, r: number, angle: number, spokes: number, blur: number, driver: boolean): void {
  // Tyre, then the red centre.
  ctx.fillStyle = lit.c('#1A1818');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = lit.c('#8A8480');
  ctx.lineWidth = 0.03;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 0.025, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = lit.c(WHEEL_RED);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, 0, TAU);
  ctx.fill();
  // Spokes, fading into a blurred disc at speed so they don't strobe.
  const spokeAlpha = 1 - 0.8 * blur;
  ctx.globalAlpha = spokeAlpha;
  ctx.fillStyle = lit.c('#1A1818');
  ctx.beginPath();
  for (let i = 0; i < spokes; i++) {
    const a = angle + (i / spokes) * TAU;
    const half = 0.62 / spokes;
    ctx.moveTo(cx + Math.cos(a - half) * r * 0.2, cy + Math.sin(a - half) * r * 0.2);
    ctx.lineTo(cx + Math.cos(a - half * 0.35) * r * 0.84, cy + Math.sin(a - half * 0.35) * r * 0.84);
    ctx.lineTo(cx + Math.cos(a + half * 0.35) * r * 0.84, cy + Math.sin(a + half * 0.35) * r * 0.84);
    ctx.lineTo(cx + Math.cos(a + half) * r * 0.2, cy + Math.sin(a + half) * r * 0.2);
  }
  ctx.fill();
  ctx.globalAlpha = 1;
  if (blur > 0) {
    ctx.fillStyle = lit.a('#1A1818', 0.3 * blur);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.84, 0, TAU);
    ctx.fill();
  }
  if (driver) {
    // The counterweight, opposite the crank.
    ctx.fillStyle = lit.c(WEIGHT);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.82, angle + Math.PI - 0.72, angle + Math.PI + 0.72);
    ctx.arc(cx, cy, r * 0.42, angle + Math.PI + 0.58, angle + Math.PI - 0.58, true);
    ctx.closePath();
    ctx.fill();
    // The crank boss.
    ctx.fillStyle = lit.c('#5A2018');
    ctx.beginPath();
    ctx.arc(cx + Math.cos(angle) * CRANK, cy + Math.sin(angle) * CRANK, 0.14, 0, TAU);
    ctx.fill();
  }
  // The hub.
  ctx.fillStyle = lit.c('#6E6660');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.17, 0, TAU);
  ctx.fill();
  ctx.fillStyle = lit.c('#9A928A');
  ctx.beginPath();
  ctx.arc(cx - r * 0.04, cy + r * 0.04, r * 0.07, 0, TAU);
  ctx.fill();
}

/** A polished rod from a to b: an ink outline, the steel, and a highlight along its top. */
function rod(ctx: CanvasRenderingContext2D, lit: Lit, a: readonly [number, number], b: readonly [number, number], w: number): void {
  ctx.lineCap = 'round';
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = w + 0.05;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.strokeStyle = lit.c(STEEL);
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.strokeStyle = lit.c('#F2F0EA');
  ctx.lineWidth = w * 0.22;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1] + w * 0.22);
  ctx.lineTo(b[0], b[1] + w * 0.22);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function pin(ctx: CanvasRenderingContext2D, lit: Lit, p: readonly [number, number], r: number): void {
  ctx.fillStyle = lit.c(BRASS);
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = lit.c(BRASS_DARK);
  ctx.beginPath();
  ctx.arc(p[0], p[1], r * 0.4, 0, TAU);
  ctx.fill();
}

function motion(ctx: CanvasRenderingContext2D, lit: Lit, g: Gear, b: number): void {
  const gy = GUIDE_Y + b;
  const [xc] = g.cross;
  // The link's bracket, hung from the running board, and the valve stem's guide.
  ctx.fillStyle = lit.c('#2A2828');
  ctx.fillRect(LINK.x - 0.1, LINK.y + b, 0.2, 1.9 - LINK.y);
  ctx.fillRect(4.95, STEM_Y + b - 0.08, 0.18, 0.16);
  // The guides and their yoke.
  ctx.fillStyle = lit.c('#34302E');
  ctx.fillRect(3.55, gy - 0.34, 0.14, 1.28);
  ctx.fillStyle = lit.c(STEEL_DARK);
  ctx.fillRect(3.6, gy + 0.12, 1.42, 0.06);
  ctx.fillRect(3.6, gy - 0.18, 1.42, 0.06);
  // The piston rod, into the cylinder.
  ctx.fillStyle = lit.c(STEEL);
  ctx.fillRect(xc, gy - 0.035, 5.0 - xc, 0.07);
  // The crosshead, sliding between the guides.
  ctx.fillStyle = lit.c('#B8B8BE');
  ctx.fillRect(xc - 0.2, gy - 0.12, 0.4, 0.24);
  ctx.fillStyle = lit.c(STEEL_DARK);
  ctx.fillRect(xc - 0.2, gy - 0.02, 0.4, 0.04);
  // The expansion link, rocking, and the eccentric rod driving it.
  rod(ctx, lit, g.ecc, g.linkFoot, 0.07);
  ctx.save();
  ctx.translate(LINK.x, LINK.y + b);
  ctx.rotate(g.swing);
  ctx.fillStyle = lit.c('#6E6A66');
  ctx.fillRect(-0.07, -0.34, 0.14, 0.58);
  ctx.fillStyle = lit.c('#24201E');
  ctx.fillRect(-0.025, -0.28, 0.05, 0.46);
  ctx.restore();
  // The radius rod to the combination lever, the lever down to the crosshead, and the valve stem.
  const leverFoot: [number, number] = [xc + 0.12, gy - 0.3];
  rod(ctx, lit, g.die, g.stem, 0.07);
  rod(ctx, lit, g.stem, leverFoot, 0.06);
  ctx.fillStyle = lit.c(STEEL);
  ctx.fillRect(g.stem[0], g.stem[1] - 0.025, 5.12 - g.stem[0], 0.05);
  pin(ctx, lit, g.die, 0.045);
  pin(ctx, lit, g.stem, 0.04);
  pin(ctx, lit, leverFoot, 0.035);
  // The side rod, then the main rod over it, and the pins.
  rod(ctx, lit, g.pins[0], g.pins[1], 0.12);
  rod(ctx, lit, g.pins[1], g.cross, 0.15);
  pin(ctx, lit, g.pins[0], 0.08);
  pin(ctx, lit, g.pins[1], 0.09);
  pin(ctx, lit, g.cross, 0.06);
  pin(ctx, lit, g.ecc, 0.05);
}

function pilot(ctx: CanvasRenderingContext2D, lit: Lit, b: number): void {
  // The buffer beam and coupler.
  ctx.fillStyle = lit.c(WHEEL_RED);
  ctx.fillRect(7.2, 0.95 + b, 0.28, 0.4);
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(7.48, 1.05 + b, 0.3, 0.14);
  // The cowcatcher: slats raked down to the rails.
  ctx.strokeStyle = lit.c('#6B3A26');
  ctx.lineWidth = 0.06;
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const f = i / 6;
    ctx.moveTo(7.25 + f * 0.25, 0.95 + b);
    ctx.lineTo(7.4 + f * 1.3, 0.12 + f * 0.05);
  }
  ctx.moveTo(7.25, 0.95 + b);
  ctx.lineTo(8.75, 0.14);
  ctx.stroke();
  ctx.strokeStyle = lit.c(IRON);
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(7.3, 0.55 + b / 2);
  ctx.lineTo(8.05, 0.5);
  ctx.stroke();
}
