// People and horses in the Rider's view (spec §18.2 layers 7–8). Readability first (spec §1
// pillar 4): the Rider is a light figure in a long duster and a brass hat; bandits are dark, in
// short jackets, with red bandanas (red = danger); the boss is bigger, in a long black coat and a
// tall black hat. Limbs are outlined round strokes so poses read at a glance even when small.
//
// Figures are drawn in local metres: origin at the feet, +x the way they face, y up (the world
// transform is already y-up). Each pose comes from the renderer, which keeps the per-figure
// animation state (gait phase from distance moved, recoil, hurt flashes, aim telegraphs).

import type { Weapon } from '../../sim/types';
import { advancePhase, gallopLegs, kneeBend, legSwing } from './motion';
import type { Lit } from './materials';
import { TAU } from './scene';

export type FigureKind = 'rider' | 'bandit' | 'boss' | 'engineer';

export interface Pose {
  kind: FigureKind;
  tier: 1 | 2 | 3;
  /** Which way the body faces in the world. */
  facing: 1 | -1;
  /** Gait phase (cycles) and how much the legs swing (0 standing, 1 running). */
  phase: number;
  gait: number;
  /** 0 standing, 1 fully crouched. */
  crouch: number;
  /** World aim angle (0 = toward the loco, π/2 = up) when the gun is raised; null lowers it. */
  aim: number | null;
  /** 1 just fired, easing to 0. */
  recoil: number;
  weapon: Weapon;
  /** On a ladder: seen from behind, limbs alternating with climbPhase. */
  climb: boolean;
  climbPhase: number;
  /** In the air: > 0; the legs tuck. */
  air: number;
  stunned: boolean;
  /** 0..1 hurt flash. */
  hurt: number;
  /** Wind on the coat, 0..1.4, and which way it blows in the world (−1 = toward the rear). */
  wind: number;
  windDir: 1 | -1;
  loot: boolean;
  hands: 'none' | 'up' | 'levers' | 'crack' | 'reach' | 'reins';
  /** On horseback: hips on the saddle. */
  seated: boolean;
  /** Standing in the stirrups (boarding). */
  stand: number;
  scale: number;
  /** Seconds, for small loops (stun stars, coat flutter). */
  t: number;
  /** Per-figure random phase so a group doesn't move in lockstep. */
  seed: number;
}

export function defaultPose(kind: FigureKind): Pose {
  return {
    kind,
    tier: 1,
    facing: 1,
    phase: 0,
    gait: 0,
    crouch: 0,
    aim: null,
    recoil: 0,
    weapon: 'revolver',
    climb: false,
    climbPhase: 0,
    air: 0,
    stunned: false,
    hurt: 0,
    wind: 0,
    windDir: -1,
    loot: false,
    hands: 'none',
    seated: false,
    stand: 0,
    scale: 1,
    t: 0,
    seed: 0,
  };
}

interface Look {
  coat: string;
  coatShade: string;
  /** Coat length: hem height above the feet when standing. */
  hem: number;
  shirt: string;
  pants: string;
  pantsShade: string;
  boots: string;
  hat: string;
  hatBand: string;
  skin: string;
  scarf: string;
  mask: boolean;
  gun: string;
  grip: string;
}

const INK = '#2A2118';

const LOOKS: Record<FigureKind, Look> = {
  rider: {
    coat: '#EDE3C9',
    coatShade: '#C8B28A',
    hem: 0.36,
    shirt: '#6F8FA6',
    pants: '#5E4A36',
    pantsShade: '#46372A',
    boots: '#3A2A1E',
    hat: '#C8A15A',
    hatBand: '#5E3F1E',
    skin: '#DDA67F',
    scarf: '#2F7482',
    mask: false,
    gun: '#3C3C42',
    grip: '#E8DCC0',
  },
  bandit: {
    coat: '#3B3431',
    coatShade: '#29231F',
    hem: 0.82,
    shirt: '#5C4838',
    pants: '#34302D',
    pantsShade: '#221F1D',
    boots: '#1B1816',
    hat: '#241F1C',
    hatBand: '#4E3E30',
    skin: '#C38C68',
    scarf: '#E0442E',
    mask: true,
    gun: '#2B2B2E',
    grip: '#6B4A2A',
  },
  boss: {
    coat: '#1C1A1A',
    coatShade: '#0F0E0E',
    hem: 0.3,
    shirt: '#E6DFCF',
    pants: '#262322',
    pantsShade: '#171514',
    boots: '#0E0C0B',
    hat: '#111010',
    hatBand: '#C3CAD3',
    skin: '#C08A66',
    scarf: '#E0442E',
    mask: true,
    gun: '#C3CAD3',
    grip: '#EDE6D6',
  },
  engineer: {
    coat: '#5E7488',
    coatShade: '#4A5E70',
    hem: 0.9,
    shirt: '#5E7488',
    pants: '#5E7488',
    pantsShade: '#4A5E70',
    boots: '#2A2118',
    hat: '#5E7488',
    hatBand: '#E8E4D8',
    skin: '#D39A74',
    scarf: '#7A4A2A',
    mask: false,
    gun: '#2B2B2E',
    grip: '#6B4A2A',
  },
};

const OUT = 0.048;
const THIGH = 0.44;
const SHIN = 0.44;
const UPPER = 0.29;
const FORE = 0.27;

/** Where the last drawn figure's muzzle was, in world metres. */
export interface Muzzle {
  x: number;
  y: number;
}

export class FigurePainter {
  private ctx!: CanvasRenderingContext2D;
  private lit!: Lit;
  private flash = 0;
  private flashCol = '#FFFFFF';
  // Scratch joints (local metres).
  private kx = 0;
  private ky = 0;
  private ax = 0;
  private ay = 0;

  /** Draws a figure standing at world (x, y). Sets `muzzle` to its gun's muzzle in the world. */
  draw(ctx: CanvasRenderingContext2D, lit: Lit, p: Pose, x: number, y: number, muzzle: Muzzle | null): void {
    this.ctx = ctx;
    this.lit = lit;
    this.flash = p.hurt;
    this.flashCol = p.kind === 'rider' ? '#FF7A66' : '#FFF4EC';
    const L = LOOKS[p.kind];
    const s = p.scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(p.facing * s, s);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (p.climb) this.climber(p, L);
    else this.body(p, L, x, y, muzzle);
    ctx.restore();
    if (p.stunned) this.stunStars(ctx, x, y + (1.9 - 0.8 * p.crouch) * s, p.t, s);
  }

  private col(hex: string): string {
    return this.flash > 0.5 ? this.flashCol : this.lit.c(hex);
  }

  /** An outlined limb through up to three points. */
  private limb(w: number, colour: string, x0: number, y0: number, x1: number, y1: number, x2?: number, y2?: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    if (x2 !== undefined && y2 !== undefined) ctx.lineTo(x2, y2);
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = w + 2 * OUT;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  /** Leg from the hip: sets (kx, ky) knee and (ax, ay) ankle for thigh angle a (from straight down, + forward) and knee bend b. */
  private legJoints(hx: number, hy: number, a: number, b: number): void {
    this.kx = hx + THIGH * Math.sin(a);
    this.ky = hy - THIGH * Math.cos(a);
    this.ax = this.kx + SHIN * Math.sin(a - b);
    this.ay = this.ky - SHIN * Math.cos(a - b);
  }

  private leg(hx: number, hy: number, a: number, b: number, pants: string, boots: string, footTilt: number): void {
    this.legJoints(hx, hy, a, b);
    const kx = this.kx;
    const ky = this.ky;
    const ax = this.ax;
    const ay = this.ay;
    this.limb(0.15, pants, hx, hy, kx, ky, ax, ay);
    // Boot: heel to toe, pointing forward, tilted with the swing.
    const ctx = this.ctx;
    const c = Math.cos(footTilt);
    const sn = Math.sin(footTilt);
    ctx.beginPath();
    ctx.moveTo(ax - 0.07 * c, ay + 0.1 - 0.07 * sn);
    ctx.lineTo(ax - 0.08 * c + 0.07 * sn, ay - 0.07 - 0.08 * sn);
    ctx.lineTo(ax + 0.2 * c + 0.06 * sn, ay - 0.07 + 0.2 * sn);
    ctx.lineTo(ax + 0.19 * c - 0.02 * sn, ay + 0.0 + 0.19 * sn);
    ctx.lineTo(ax + 0.05 * c, ay + 0.06 + 0.05 * sn);
    ctx.closePath();
    ctx.fillStyle = boots;
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
  }

  private body(p: Pose, L: Look, wx: number, wy: number, muzzle: Muzzle | null): void {
    const crouch = p.crouch;
    const run = p.gait;
    // Hip height: crouch lowers it, a stride bobs it, the saddle holds it.
    let hipY = 0.95 - 0.44 * crouch - 0.035 * run * Math.abs(Math.sin(2 * Math.PI * 2 * p.phase));
    if (p.air > 0) hipY += 0.06;
    let hipX = 0;
    if (p.seated) {
      hipY = 0.02 + 0.32 * p.stand;
      hipX = -0.02;
    }
    const lean = p.seated ? 0.12 + 0.2 * p.stand : 0.12 * run + 0.5 * crouch + (p.stunned ? 0.35 : 0);
    const sl = Math.sin(lean);
    const cl = Math.cos(lean);
    const shX = hipX + 0.47 * sl;
    const shY = hipY + 0.47 * cl;
    const neckX = hipX + 0.53 * sl;
    const neckY = hipY + 0.53 * cl;
    const headX = neckX + 0.04 + 0.1 * Math.sin(lean * 0.5);
    const headY = neckY + 0.14 * Math.cos(lean * 0.5) + (p.stunned ? 0.015 * Math.sin(p.t * 7) : 0);

    // Legs: gait, crouch, air and saddle poses blended.
    let aF: number;
    let bF: number;
    let aB: number;
    let bB: number;
    if (p.seated) {
      aF = 1.15 - 0.55 * p.stand;
      bF = 1.55 - 0.9 * p.stand;
      aB = aF;
      bB = bF;
    } else if (p.air > 0) {
      aF = 0.75;
      bF = 1.25;
      aB = -0.15;
      bB = 0.95;
    } else {
      const swing = 0.5 * run;
      aF = legSwing(p.phase, swing);
      aB = legSwing(p.phase + 0.5, swing);
      bF = kneeBend(p.phase, 1.2 * run) + 0.08 * run;
      bB = kneeBend(p.phase + 0.5, 1.2 * run) + 0.08 * run;
      if (crouch > 0) {
        const th = 1.03 * crouch;
        aF = aF * (1 - crouch) + (th + 0.12) * crouch;
        bF = bF * (1 - crouch) + 2 * th * crouch;
        aB = aB * (1 - crouch) + (th - 0.28) * crouch;
        bB = bB * (1 - crouch) + (2 * th - 0.1) * crouch;
      }
    }

    const coat = this.col(L.coat);
    const coatShade = this.col(L.coatShade);
    const pants = this.col(L.pants);
    const pantsShade = this.col(L.pantsShade);
    const boots = this.col(L.boots);

    // Far arm (behind the body).
    const armSwing = p.seated ? 0 : -legSwing(p.phase, 0.55 * run);
    const long = p.weapon !== 'revolver';
    let farHandX = shX + 0.02 + UPPER * Math.sin(armSwing) + FORE * Math.sin(armSwing + 0.5);
    let farHandY = shY - UPPER * Math.cos(armSwing) - FORE * Math.cos(armSwing + 0.5);
    let aimL = 0;
    let recoilA = 0;
    if (p.aim !== null) {
      aimL = p.facing === 1 ? p.aim : Math.PI - p.aim;
      if (aimL > Math.PI) aimL -= TAU;
      recoilA = 0.28 * p.recoil;
    }
    const gunA = aimL + recoilA;
    if (p.hands === 'up') {
      farHandX = shX - 0.12;
      farHandY = shY + 0.5;
    } else if (p.hands === 'reins') {
      farHandX = shX + 0.34;
      farHandY = shY - 0.3;
    } else if (p.hands === 'crack') {
      farHandX = shX + 0.42;
      farHandY = shY - 0.12;
    } else if (p.aim !== null && long) {
      // The far hand holds the fore-end of a long gun.
      farHandX = shX + 0.55 * Math.cos(gunA);
      farHandY = shY - 0.03 + 0.55 * Math.sin(gunA);
    }
    this.arm(shX - 0.03, shY, farHandX, farHandY, coatShade, this.col(L.skin), false);

    // Far leg, then the coat's back panel, then the near leg.
    this.leg(hipX - 0.02, hipY, aB, bB, pantsShade, boots, aB - bB * 0.6);
    if (L.hem < 0.6 || p.kind === 'boss') this.coatTail(p, L, hipX, hipY, shX, shY, coatShade);
    this.leg(hipX + 0.02, hipY, aF, bF, pants, boots, aF - bF * 0.6);

    // Torso.
    this.torso(p, L, hipX, hipY, shX, shY, lean, coat);
    if (p.loot) this.sack(shX - 0.28, shY - 0.05);

    // Head and hat.
    this.head(p, L, headX, headY, lean);

    // Near arm with the gun.
    const skin = this.col(L.skin);
    if (p.hands === 'up') {
      this.arm(shX + 0.03, shY, shX + 0.14, shY + 0.52, coat, skin, false);
      return;
    }
    if (p.hands === 'levers') {
      const lx = shX + 0.42 + 0.04 * Math.sin(p.t * 1.3 + p.seed);
      this.arm(shX + 0.03, shY, lx, shY - 0.18, coat, skin, false);
      return;
    }
    if (p.hands === 'reach') {
      this.arm(shX + 0.03, shY, shX + 0.28, shY + 0.5, coat, skin, false);
      return;
    }
    let hx: number;
    let hy: number;
    let gun: number;
    if (p.aim !== null) {
      const reach = UPPER + FORE - 0.06 * p.recoil;
      hx = shX + (long ? 0.26 : reach) * Math.cos(gunA);
      hy = shY - (long ? 0.03 : 0) + (long ? 0.26 : reach) * Math.sin(gunA);
      gun = gunA;
      if (long) {
        // Bent arm: the elbow drops below the line to the trigger hand.
        const ex = shX + 0.1 * Math.cos(gunA) - 0.02;
        const ey = shY - 0.2;
        this.limbArm(shX + 0.03, shY, ex, ey, hx, hy, coat, skin);
      } else {
        this.arm(shX + 0.03, shY, hx, hy, coat, skin, true);
      }
    } else if (p.hands === 'crack') {
      hx = shX + 0.4;
      hy = shY - 0.2 + 0.02 * Math.sin(p.t * 9 + p.seed);
      gun = -1.3;
      this.arm(shX + 0.03, shY, hx, hy, coat, skin, false);
    } else {
      // Lowered: the gun held low and forward, swinging a little with the stride.
      const sw = legSwing(p.phase, 0.3 * run);
      hx = shX + 0.2 + 0.08 * sw;
      hy = shY - 0.46;
      gun = long ? -0.55 : -0.95;
      if (p.hands === 'reins') {
        hx = shX + 0.36;
        hy = shY - 0.28;
        gun = -0.5;
      }
      this.arm(shX + 0.03, shY, hx, hy, coat, skin, false);
    }
    const len = this.weapon(p.weapon, hx, hy, gun, L.grip, L.gun, long && p.aim !== null);
    if (muzzle) {
      const mx = hx + len * Math.cos(gun);
      const my = hy + len * Math.sin(gun) + 0.02;
      muzzle.x = wx + p.facing * p.scale * mx;
      muzzle.y = wy + p.scale * my;
    }
  }

  private arm(sx: number, sy: number, hx: number, hy: number, sleeve: string, skin: string, straight: boolean): void {
    // Elbow: straight along the line, or bent down and back for a relaxed arm.
    const dx = hx - sx;
    const dy = hy - sy;
    const d = Math.hypot(dx, dy);
    let ex = sx + dx * (UPPER / (UPPER + FORE));
    let ey = sy + dy * (UPPER / (UPPER + FORE));
    if (!straight && d < UPPER + FORE - 0.01) {
      // Two-bone solve, elbow bending downward/backward.
      const a = Math.acos(Math.max(-1, Math.min(1, (UPPER * UPPER + d * d - FORE * FORE) / (2 * UPPER * d))));
      const base = Math.atan2(dy, dx);
      const ang = base - a * (dx >= 0 ? 1 : -1);
      ex = sx + UPPER * Math.cos(ang);
      ey = sy + UPPER * Math.sin(ang);
    }
    this.limbArm(sx, sy, ex, ey, hx, hy, sleeve, skin);
  }

  private limbArm(sx: number, sy: number, ex: number, ey: number, hx: number, hy: number, sleeve: string, skin: string): void {
    this.limb(0.12, sleeve, sx, sy, ex, ey, hx, hy);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(hx, hy, 0.055, 0, TAU);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT * 0.8;
    ctx.stroke();
  }

  /** The long back of a duster, blown by the wind. */
  /**
   * The long back of a duster, behind the legs: it flares, trails when running, and streams and
   * flutters in the wind over the roofs (the wind blows toward the rear of the train, spec §6.3),
   * which also tells the Rider how fast the train is going.
   */
  private coatTail(p: Pose, L: Look, hipX: number, hipY: number, shX: number, shY: number, shade: string): void {
    const ctx = this.ctx;
    // Wind in local terms: +1 streams the coat forward (wind from behind), −1 back.
    const wLocal = p.windDir * p.facing;
    const flutter = Math.sin(p.t * 11 + p.seed) * 0.5 + Math.sin(p.t * 17.3 + p.seed * 2) * 0.3;
    const stream = p.wind * (0.62 + 0.14 * flutter);
    const run = p.gait * 0.16;
    const hemY = Math.max(0.12, L.hem - 0.3 * p.crouch) + (p.seated ? 0.35 : 0);
    const backX = hipX - 0.26 - run + wLocal * stream - (p.seated ? 0.12 : 0);
    const lift = Math.abs(stream) * 0.42 + run * 0.5;
    const backY = hemY + lift + 0.05 * flutter * p.wind;
    const midX = hipX - 0.2 + wLocal * stream * 0.45;
    ctx.beginPath();
    ctx.moveTo(shX - 0.13, shY - 0.04);
    ctx.quadraticCurveTo(hipX - 0.24, hipY + 0.05, midX, (hipY + backY) / 2);
    ctx.quadraticCurveTo(backX - 0.04, backY + 0.08, backX, backY);
    // The hem: a ragged, split edge back toward the legs.
    ctx.lineTo(backX + 0.12, backY - 0.05 - 0.03 * flutter);
    ctx.lineTo(backX + 0.2, hemY + lift * 0.5);
    ctx.lineTo(hipX + 0.05, hemY + 0.02);
    ctx.lineTo(hipX + 0.02, hipY - 0.1);
    ctx.closePath();
    ctx.fillStyle = shade;
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
  }

  private torso(p: Pose, L: Look, hipX: number, hipY: number, shX: number, shY: number, lean: number, coat: string): void {
    const ctx = this.ctx;
    const sl = Math.sin(lean);
    const cl = Math.cos(lean);
    // Body axis unit (up) and its normal (forward).
    const ux = sl;
    const uy = cl;
    const nx = cl;
    const ny = -sl;
    const hemY = Math.max(0.12, L.hem - 0.3 * p.crouch) + (p.seated ? 0.3 : 0);
    const long = L.hem < 0.6;
    const wLocal = p.windDir * p.facing;
    const flap = long ? p.wind * 0.08 * Math.sin(p.t * 12 + p.seed + 1) : 0;
    ctx.beginPath();
    // Back of the neck → back of the shoulders → down the back.
    ctx.moveTo(shX + ux * 0.05 - nx * 0.1, shY + uy * 0.05 - ny * 0.1);
    ctx.lineTo(shX - nx * 0.17, shY - ny * 0.17);
    if (long) {
      // An A-line duster: narrow at the shoulders, flared at the hem, swinging with the stride.
      const swing = 0.06 * legSwing(p.phase, p.gait) + wLocal * p.wind * 0.1;
      ctx.lineTo(hipX - nx * 0.19, hipY - ny * 0.19);
      ctx.lineTo(hipX - 0.2 + wLocal * p.wind * 0.16, hemY + flap + Math.abs(wLocal) * p.wind * 0.08);
      ctx.lineTo(hipX + 0.24 + swing, hemY - 0.03);
      ctx.lineTo(hipX + nx * 0.17, hipY - 0.05);
    } else {
      ctx.lineTo(hipX - nx * 0.16 - ux * 0.08, hipY - ny * 0.16 - uy * 0.08);
      ctx.lineTo(hipX + nx * 0.15 - ux * 0.08, hipY + ny * 0.15 - uy * 0.08);
    }
    ctx.lineTo(shX + nx * 0.14, shY + ny * 0.14 - 0.02);
    ctx.lineTo(shX + ux * 0.05 + nx * 0.08, shY + uy * 0.05 + ny * 0.08);
    ctx.closePath();
    ctx.fillStyle = coat;
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
    // Shirt at the open front, lapel line.
    ctx.beginPath();
    ctx.moveTo(shX + nx * 0.13 + ux * 0.02, shY + ny * 0.13 + uy * 0.02);
    ctx.lineTo(shX + nx * 0.06 - ux * 0.26, shY + ny * 0.06 - uy * 0.26);
    ctx.lineTo(shX + nx * 0.14 - ux * 0.3, shY + ny * 0.14 - uy * 0.3);
    ctx.closePath();
    ctx.fillStyle = this.col(L.shirt);
    ctx.fill();
    // Belt.
    ctx.strokeStyle = this.col(p.kind === 'rider' ? '#4A3322' : '#1A1614');
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(hipX - nx * 0.15 + ux * 0.08, hipY - ny * 0.15 + uy * 0.08);
    ctx.lineTo(hipX + nx * 0.15 + ux * 0.08, hipY + ny * 0.15 + uy * 0.08);
    ctx.stroke();
    if (p.kind === 'bandit' && p.tier === 3) {
      // Bandolier: brass rounds across the chest.
      ctx.strokeStyle = this.col('#5A3A22');
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      ctx.moveTo(shX - nx * 0.14, shY - ny * 0.14);
      ctx.lineTo(hipX + nx * 0.13 + ux * 0.1, hipY + ny * 0.13 + uy * 0.1);
      ctx.stroke();
      ctx.fillStyle = this.col('#C8A15A');
      for (let i = 1; i < 5; i++) {
        const t = i / 5;
        const bx = shX - nx * 0.14 + (hipX + nx * 0.13 + ux * 0.1 - shX + nx * 0.14) * t;
        const by = shY - ny * 0.14 + (hipY + ny * 0.13 + uy * 0.1 - shY + ny * 0.14) * t;
        ctx.fillRect(bx - 0.018, by - 0.018, 0.036, 0.036);
      }
    } else if (p.kind === 'bandit' && p.tier === 2) {
      // Vest over the shirt.
      ctx.fillStyle = this.col('#5A3A2A');
      ctx.beginPath();
      ctx.moveTo(shX + nx * 0.02, shY + ny * 0.02);
      ctx.lineTo(shX - nx * 0.15, shY - ny * 0.15);
      ctx.lineTo(hipX - nx * 0.14 + ux * 0.1, hipY - ny * 0.14 + uy * 0.1);
      ctx.lineTo(hipX + nx * 0.02 + ux * 0.1, hipY + ny * 0.02 + uy * 0.1);
      ctx.closePath();
      ctx.fill();
    } else if (p.kind === 'engineer') {
      // Hickory stripes.
      ctx.strokeStyle = this.col('#DCE2E8');
      ctx.lineWidth = 0.018;
      ctx.beginPath();
      for (let i = -2; i <= 2; i++) {
        ctx.moveTo(shX + nx * i * 0.055, shY + ny * i * 0.055);
        ctx.lineTo(hipX + nx * i * 0.055, hipY + ny * i * 0.055);
      }
      ctx.stroke();
    }
  }

  private head(p: Pose, L: Look, hx: number, hy: number, lean: number): void {
    const ctx = this.ctx;
    const r = 0.115;
    // Neck scarf.
    ctx.fillStyle = this.col(L.scarf);
    ctx.beginPath();
    ctx.ellipse(hx - 0.02, hy - 0.12, 0.1, 0.05, 0, 0, TAU);
    ctx.fill();
    // Face.
    ctx.beginPath();
    ctx.arc(hx, hy, r, 0, TAU);
    ctx.fillStyle = this.col(L.skin);
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
    if (L.mask) {
      // Red bandana over nose and mouth, knotted behind.
      ctx.beginPath();
      ctx.moveTo(hx - r * 0.95, hy + 0.0);
      ctx.lineTo(hx + r * 1.08, hy + 0.01);
      ctx.lineTo(hx + r * 0.75, hy - r * 0.95);
      ctx.lineTo(hx + r * 0.1, hy - r * 1.55);
      ctx.lineTo(hx - r * 0.6, hy - r * 0.8);
      ctx.closePath();
      ctx.fillStyle = this.col(L.scarf);
      ctx.fill();
      ctx.strokeStyle = this.col(INK);
      ctx.lineWidth = OUT * 0.8;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hx - r * 0.9, hy + 0.01);
      ctx.lineTo(hx - r * 1.55, hy + 0.05 + 0.03 * Math.sin(p.t * 10 + p.seed));
      ctx.lineTo(hx - r * 1.45, hy - 0.06);
      ctx.closePath();
      ctx.fill();
    } else {
      // Scarf knot at the throat.
      ctx.fillStyle = this.col(L.scarf);
      ctx.beginPath();
      ctx.moveTo(hx + 0.02, hy - 0.1);
      ctx.lineTo(hx + 0.11, hy - 0.2);
      ctx.lineTo(hx - 0.01, hy - 0.17);
      ctx.closePath();
      ctx.fill();
    }
    // Eye.
    ctx.fillStyle = this.col(INK);
    ctx.beginPath();
    ctx.arc(hx + r * 0.55, hy + r * 0.2, 0.02, 0, TAU);
    ctx.fill();
    this.hat(p, L, hx, hy + r * 0.55, lean);
  }

  private hat(p: Pose, L: Look, x: number, y: number, lean: number): void {
    const ctx = this.ctx;
    const tilt = lean * 0.4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-tilt);
    ctx.beginPath();
    if (p.kind === 'engineer') {
      // Striped cap with a short bill.
      ctx.moveTo(-0.13, 0);
      ctx.quadraticCurveTo(-0.12, 0.15, 0.02, 0.15);
      ctx.quadraticCurveTo(0.13, 0.14, 0.13, 0);
      ctx.lineTo(0.24, -0.01);
      ctx.lineTo(0.22, -0.035);
      ctx.lineTo(-0.13, -0.03);
    } else if (p.kind === 'boss') {
      // Tall black crown, wide flat brim.
      ctx.moveTo(-0.3, -0.03);
      ctx.lineTo(0.32, -0.03);
      ctx.lineTo(0.32, 0.015);
      ctx.lineTo(0.12, 0.02);
      ctx.lineTo(0.11, 0.3);
      ctx.quadraticCurveTo(0, 0.33, -0.12, 0.29);
      ctx.lineTo(-0.13, 0.02);
      ctx.lineTo(-0.3, 0.015);
    } else if (p.kind === 'rider') {
      // Cattleman crown, pinched, with a curled brim.
      ctx.moveTo(-0.27, 0.04);
      ctx.quadraticCurveTo(-0.2, -0.02, 0, -0.02);
      ctx.quadraticCurveTo(0.2, -0.02, 0.29, 0.05);
      ctx.quadraticCurveTo(0.2, 0.02, 0.12, 0.03);
      ctx.lineTo(0.11, 0.17);
      ctx.quadraticCurveTo(0.06, 0.2, 0.0, 0.16);
      ctx.quadraticCurveTo(-0.06, 0.2, -0.11, 0.17);
      ctx.lineTo(-0.12, 0.03);
      ctx.quadraticCurveTo(-0.2, 0.02, -0.27, 0.04);
    } else {
      // Bandit: low flat crown, stiff brim.
      ctx.moveTo(-0.25, -0.02);
      ctx.lineTo(0.27, -0.02);
      ctx.lineTo(0.27, 0.02);
      ctx.lineTo(0.12, 0.03);
      ctx.lineTo(0.1, 0.15);
      ctx.lineTo(-0.11, 0.15);
      ctx.lineTo(-0.12, 0.03);
      ctx.lineTo(-0.25, 0.02);
    }
    ctx.closePath();
    ctx.fillStyle = this.col(L.hat);
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
    // Band.
    ctx.fillStyle = this.col(L.hatBand);
    if (p.kind === 'engineer') {
      ctx.fillRect(-0.12, 0.05, 0.24, 0.025);
      ctx.fillRect(-0.12, 0.1, 0.24, 0.02);
    } else if (p.kind === 'boss') ctx.fillRect(-0.12, 0.03, 0.235, 0.05);
    else ctx.fillRect(-0.11, 0.03, 0.22, 0.04);
    ctx.restore();
  }

  /** A gun from the hand at angle a; returns the distance from the hand to the muzzle. */
  private weapon(w: Weapon, hx: number, hy: number, a: number, grip: string, metal: string, shouldered: boolean): number {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(a);
    const ink = this.col(INK);
    if (w === 'revolver') {
      ctx.fillStyle = this.col(metal);
      ctx.fillRect(-0.02, -0.005, 0.25, 0.045);
      ctx.fillRect(0.0, -0.02, 0.09, 0.07);
      ctx.fillStyle = this.col(grip);
      ctx.beginPath();
      ctx.moveTo(-0.03, 0.03);
      ctx.lineTo(0.02, 0.03);
      ctx.lineTo(-0.02, -0.1);
      ctx.lineTo(-0.07, -0.09);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = 0.02;
      ctx.strokeRect(-0.02, -0.005, 0.25, 0.045);
      ctx.restore();
      return 0.24;
    }
    const len = w === 'rifle' ? 0.98 : 0.84;
    const back = shouldered ? 0.3 : 0.32;
    // Stock behind the hand, barrel(s) ahead.
    ctx.fillStyle = this.col('#6B4A2A');
    ctx.beginPath();
    ctx.moveTo(-back, -0.07);
    ctx.lineTo(-back, 0.04);
    ctx.lineTo(0.02, 0.035);
    ctx.lineTo(0.02, -0.015);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = this.col(metal);
    const bw = w === 'shotgun' ? 0.06 : 0.04;
    ctx.fillRect(0, 0.005, len - back + 0.05, bw);
    if (w === 'rifle') {
      // Lever loop under the grip.
      ctx.strokeStyle = this.col(metal);
      ctx.lineWidth = 0.02;
      ctx.beginPath();
      ctx.ellipse(-0.02, -0.03, 0.05, 0.03, 0, 0, TAU);
      ctx.stroke();
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.018;
    ctx.strokeRect(0, 0.005, len - back + 0.05, bw);
    ctx.restore();
    return len - back + 0.05;
  }

  /** A burlap money sack over the shoulder. */
  private sack(x: number, y: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.ellipse(x, y, 0.2, 0.24, 0.3, 0, TAU);
    ctx.fillStyle = this.col('#B89868');
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
    dollar(ctx, x, y, 0.2, this.col('#3E5A2A'));
  }

  /** Seen from behind on a ladder: limbs alternate as they climb. */
  private climber(p: Pose, L: Look): void {
    const ph = p.climbPhase * TAU;
    const up = Math.sin(ph);
    const coat = this.col(L.coat);
    const pants = this.col(L.pants);
    const boots = this.col(L.boots);
    const skin = this.col(L.skin);
    // Legs on rungs.
    const hipY = 0.95;
    for (const side of [-1, 1]) {
      const lift = Math.max(0, side * up) * 0.3;
      const fx = side * 0.12;
      this.limb(0.15, pants, side * 0.08, hipY, fx + side * 0.05, 0.5 + lift, fx, 0.08 + lift);
      this.ctx.fillStyle = boots;
      this.ctx.fillRect(fx - 0.07, 0.02 + lift, 0.14, 0.1);
    }
    // Coat (back).
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(-0.2, 1.47);
    ctx.lineTo(0.2, 1.47);
    ctx.lineTo(0.24, L.hem < 0.6 ? 0.5 : 0.85);
    ctx.lineTo(-0.24, L.hem < 0.6 ? 0.5 : 0.85);
    ctx.closePath();
    ctx.fillStyle = coat;
    ctx.fill();
    ctx.strokeStyle = this.col(INK);
    ctx.lineWidth = OUT;
    ctx.stroke();
    if (L.hem < 0.6) {
      ctx.beginPath();
      ctx.moveTo(0, 0.95);
      ctx.lineTo(0, 0.5);
      ctx.stroke();
    }
    // Arms reaching up to rungs.
    for (const side of [-1, 1]) {
      const reach = 0.3 + Math.max(0, -side * up) * 0.25;
      this.limbArm(side * 0.17, 1.42, side * 0.26, 1.5 + reach * 0.5, side * 0.2, 1.62 + reach, coat, skin);
    }
    // Head from behind, hat.
    ctx.beginPath();
    ctx.arc(0, 1.62, 0.115, 0, TAU);
    ctx.fillStyle = this.col(L.mask ? L.scarf : L.skin);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 1.7, 0.27, 0.05, 0, 0, TAU);
    ctx.fillStyle = this.col(L.hat);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.12, 1.71);
    ctx.lineTo(-0.11, 1.86);
    ctx.lineTo(0.11, 1.86);
    ctx.lineTo(0.12, 1.71);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private stunStars(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, s: number): void {
    ctx.fillStyle = '#F2D06A';
    for (let i = 0; i < 3; i++) {
      const a = t * 4 + (i * TAU) / 3;
      const sx = x + Math.cos(a) * 0.3 * s;
      const sy = y + Math.sin(a) * 0.08 * s;
      star(ctx, sx, sy, 0.07 * s);
    }
  }
}

/** A dollar mark drawn with strokes (height h, centred), legible at any scale. */
export function dollar(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, colour: string): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = h * 0.16;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const r = h * 0.2;
  ctx.moveTo(x + r * 1.1, y + r * 1.2);
  ctx.bezierCurveTo(x + r * 0.6, y + r * 2.1, x - r * 1.5, y + r * 1.8, x - r * 1.0, y + r * 0.5);
  ctx.bezierCurveTo(x - r * 0.6, y - r * 0.2, x + r * 1.1, y + r * 0.1, x + r * 1.0, y - r * 0.9);
  ctx.bezierCurveTo(x + r * 0.8, y - r * 2.0, x - r * 0.9, y - r * 1.9, x - r * 1.2, y - r * 1.1);
  ctx.moveTo(x, y + h * 0.5);
  ctx.lineTo(x, y - h * 0.5);
  ctx.stroke();
}

export function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const rr = i % 2 === 0 ? r : r * 0.4;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------------------------
// Horses

export interface HorseLook {
  coat: string;
  points: string;
  blaze: boolean;
}

export const HORSES: readonly HorseLook[] = [
  { coat: '#7A4A2E', points: '#231A14', blaze: false },
  { coat: '#9A5A34', points: '#6A3A20', blaze: true },
  { coat: '#3A2E28', points: '#1A1412', blaze: false },
  { coat: '#A8A096', points: '#4A4440', blaze: false },
  { coat: '#B98A56', points: '#3A2A1C', blaze: true },
];
export const BOSS_HORSE: HorseLook = { coat: '#1E1A18', points: '#0C0A09', blaze: false };

export interface HorsePose {
  facing: 1 | -1;
  /** Gallop phase (cycles). */
  phase: number;
  /** 0 standing, 1 full gallop. */
  gallop: number;
  /** Head down grazing while standing (0..1). */
  graze: number;
  t: number;
  seed: number;
}

/**
 * Draws a horse with its hooves at world (x, y). Returns the saddle height above y so a rider can
 * be seated on it.
 */
export function drawHorse(ctx: CanvasRenderingContext2D, lit: Lit, look: HorseLook, p: HorsePose, x: number, y: number): number {
  const g = p.gallop;
  const legs = gallopLegs(p.phase);
  const bob = g * 0.07 * Math.sin(TAU * p.phase * 2 + 0.6);
  const pitch = g * 0.05 * Math.sin(TAU * p.phase + 0.3);
  const coat = lit.c(look.coat);
  const pts = lit.c(look.points);
  const ink = lit.c(INK);
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.scale(p.facing, 1);
  ctx.rotate(pitch);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const leg = (hx: number, hy: number, a: number, fore: boolean, colour: string): void => {
    // Standing legs are straight; galloping legs fold on the recovery (swinging forward).
    const sw = g > 0 ? a * g : 0;
    const fold = g * (fore ? 0.9 : -0.8) * Math.max(0, Math.sin(TAU * (p.phase + (fore ? 0.47 : 0.04))));
    const kx = hx + 0.5 * Math.sin(sw);
    const ky = hy - 0.5 * Math.cos(sw);
    const fx = kx + 0.55 * Math.sin(sw - fold);
    const fy = ky - 0.55 * Math.cos(sw - fold);
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(kx, ky);
    ctx.lineTo(fx, fy);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.21;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.14;
    ctx.stroke();
    ctx.fillStyle = ink;
    ctx.fillRect(fx - 0.07, fy - 0.02, 0.15, 0.09);
  };
  const farCol = lit.c(look.points);
  leg(-0.72, 1.12, legs[0], false, farCol);
  leg(0.62, 1.12, legs[2], true, farCol);
  // Tail streaming back.
  const stream = 0.3 + 0.7 * g;
  const sw = 0.08 * Math.sin(p.t * 3 + p.seed);
  ctx.beginPath();
  ctx.moveTo(-0.9, 1.5);
  ctx.quadraticCurveTo(-1.35 - 0.2 * stream, 1.45 - 0.3 * (1 - stream) + sw, -1.4 - 0.45 * stream, 0.75 + 0.55 * stream + sw);
  ctx.quadraticCurveTo(-1.1, 1.05 + 0.3 * stream, -0.86, 1.36);
  ctx.closePath();
  ctx.fillStyle = pts;
  ctx.fill();
  // Body barrel.
  ctx.beginPath();
  ctx.moveTo(-0.92, 1.45);
  ctx.bezierCurveTo(-0.85, 1.62, -0.4, 1.56, 0.0, 1.52);
  ctx.bezierCurveTo(0.35, 1.5, 0.5, 1.62, 0.62, 1.6);
  ctx.bezierCurveTo(0.85, 1.4, 0.95, 1.22, 0.86, 1.02);
  ctx.bezierCurveTo(0.6, 0.9, 0.0, 0.92, -0.55, 0.98);
  ctx.bezierCurveTo(-0.9, 1.0, -1.0, 1.25, -0.92, 1.45);
  ctx.closePath();
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.045;
  ctx.stroke();
  // Neck and head (lowered when grazing).
  const gz = p.graze;
  const pollX = 1.08 - 0.05 * gz;
  const pollY = 2.02 - 0.85 * gz + g * 0.03 * Math.sin(TAU * p.phase * 2);
  const muzX = pollX + 0.42 - 0.2 * gz;
  const muzY = pollY - 0.42 - 0.3 * gz;
  ctx.beginPath();
  ctx.moveTo(0.5, 1.58);
  ctx.quadraticCurveTo(0.8, 1.95 - 0.5 * gz, pollX - 0.06, pollY + 0.02);
  ctx.lineTo(pollX + 0.1, pollY - 0.02);
  ctx.lineTo(muzX + 0.06, muzY + 0.08);
  ctx.quadraticCurveTo(muzX + 0.05, muzY - 0.07, muzX - 0.1, muzY - 0.06);
  ctx.lineTo(pollX - 0.02, pollY - 0.3);
  ctx.quadraticCurveTo(0.95, 1.35 - 0.35 * gz, 0.86, 1.1);
  ctx.closePath();
  ctx.fillStyle = coat;
  ctx.fill();
  ctx.stroke();
  // Mane.
  ctx.strokeStyle = pts;
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  ctx.moveTo(0.52, 1.64);
  ctx.quadraticCurveTo(0.76 - 0.1 * g, 1.98 - 0.5 * gz, pollX - 0.04, pollY + 0.06);
  ctx.stroke();
  // Ear, eye, blaze.
  ctx.fillStyle = coat;
  ctx.beginPath();
  ctx.moveTo(pollX - 0.02, pollY + 0.02);
  ctx.lineTo(pollX + 0.02, pollY + 0.17);
  ctx.lineTo(pollX + 0.08, pollY);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.03;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(pollX + 0.1, pollY - 0.1, 0.028, 0, TAU);
  ctx.fill();
  if (look.blaze) {
    ctx.strokeStyle = lit.c('#EFE6D2');
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(pollX + 0.14, pollY - 0.08);
    ctx.lineTo(muzX + 0.02, muzY + 0.05);
    ctx.stroke();
  }
  // Saddle blanket and saddle.
  ctx.fillStyle = lit.c('#7A2E22');
  ctx.fillRect(-0.34, 1.3, 0.6, 0.26);
  ctx.fillStyle = lit.c('#4A3322');
  ctx.beginPath();
  ctx.moveTo(-0.32, 1.6);
  ctx.quadraticCurveTo(-0.1, 1.5, 0.18, 1.58);
  ctx.lineTo(0.24, 1.72);
  ctx.lineTo(0.16, 1.7);
  ctx.lineTo(0.12, 1.6);
  ctx.quadraticCurveTo(-0.1, 1.56, -0.3, 1.66);
  ctx.closePath();
  ctx.fill();
  // Near legs.
  leg(-0.64, 1.1, legs[1], false, coat);
  leg(0.7, 1.1, legs[3], true, coat);
  ctx.restore();
  return 1.58 + bob;
}

/** Advances a horse's gallop phase by its world distance (stride ≈ 6 m at full gallop). */
export function gallopAdvance(phase: number, worldDist: number): number {
  return advancePhase(phase, Math.abs(worldDist), 5.6);
}
