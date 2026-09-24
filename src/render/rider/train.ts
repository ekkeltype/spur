// The player's train in the Rider's view (spec §5.1, §18.2 layer 6): a 4-4-0 locomotive with a
// balloon stack, brass domes and a box headlamp, its cab with the Engineer at the levers (hands
// up while held up), the tender with its coal and water hatch, and the cars behind: express (the
// safe visible through its half-open door), passenger (lit windows at night), boxcar, armored
// (rivets, parapet, slits), caboose (cupola), powder (DANGER, and damage as its hp drops). Every
// car has its trucks, platforms, ladders, hatches and couplers where the sim's geometry puts them.
// The car the Rider is inside is cut away to show its interior.
//
// Everything is drawn in world metres (train frame, y up), from each car's x0. Wheels and rods
// turn with the odometer. Cars inside a tunnel are drawn with the tunnel's darkness.

import type { CarState, GameState } from '../../sim/types';
import { CAR_SPECS } from '../../sim/rules';
import { trainLook, type CarLook } from './cars';
import { FigurePainter, defaultPose, type Pose } from './figures';
import type { Lit } from './materials';
import { clamp01, TAU, tunnelCover, worldText, type Scene } from './scene';

/** Body colours per car kind, also used by the HUD's train strip. */
export const CAR_COLOURS: Record<CarState['kind'], string> = {
  loco: '#2B2B2E',
  tender: '#3A2E2A',
  express: '#2E4B3C',
  passenger: '#6E2A1F',
  boxcar: '#8E4A33',
  armored: '#4C5548',
  caboose: '#B5563A',
  powder: '#D9CDB0',
};

const INK = '#2A2118';
const IRON = '#2B2B2E';
const BRASS = '#C8A15A';
const CREAM = '#E8D8B0';
const WOOD = '#6B4A2A';

const CAR_WHEEL_R = 0.42;
const DRIVER_R = 0.8;

export interface TrainExtras {
  /** Car index cut away (the Rider is inside), or null. */
  cutaway: number | null;
  /** The Rider is in the cab: cut its side away. */
  cabCut: boolean;
  /** Engineer's pose inputs. */
  heldUp: boolean;
}

export class TrainPainter {
  private readonly fig = new FigurePainter();
  private readonly engineer: Pose = defaultPose('engineer');

  /** Draws every car of the player's train. */
  draw(s: Scene, state: GameState, ex: TrainExtras): void {
    const cars = state.train.cars;
    const t = state.train;
    // Couplers and bridge plates first, so car ends overlap them.
    for (let i = 0; i < cars.length - 1; i++) this.joint(s, cars[i + 1], cars[i]);
    const tl = trainLook(cars);
    for (let i = cars.length - 1; i >= 0; i--) {
      const car = cars[i];
      if (car.x1 < s.left - 2 || car.x0 > s.right + 2) continue;
      const look = tl.cars[i];
      const cut = ex.cutaway === i;
      this.split(s, car.x0 - 0.5, car.x1 + 0.5, (lit, inside) => this.car(s, lit, inside, look, car, cut, ex, t.throttle));
    }
  }

  /**
   * Parts of cars that stand in front of the figures: the armored car's near parapet (cover for a
   * crouching figure, spec §5.1).
   */
  drawFront(s: Scene, state: GameState): void {
    const tl = trainLook(state.train.cars);
    state.train.cars.forEach((car, i) => {
      if (car.kind !== 'armored' || car.x1 < s.left || car.x0 > s.right) return;
      this.split(s, car.x0, car.x1, (lit) => parapet(s.ctx, lit, tl.cars[i], true));
    });
  }

  /** Adds the openings a figure inside a car can be seen through to the current path. */
  addOpenings(ctx: CanvasRenderingContext2D, look: CarLook, cabCut: boolean): void {
    const car = look;
    const mid = (look.bx0 + look.bx1) / 2;
    const f = look.floorY;
    switch (car.kind) {
      case 'loco':
        if (cabCut) ctx.rect(car.x0 - 0.2, 1.2, 4.9, 2.9);
        else {
          ctx.rect(car.x0 + 0.7, 2.35, 2.4, 1.3);
          ctx.rect(car.x0 + 0.05, 1.45, 0.5, 2.3);
          ctx.rect(car.x0 + 3.45, 2.45, 0.75, 1.1);
        }
        break;
      case 'express':
        ctx.rect(mid - 1.0, f, 2.0, 2.25);
        break;
      case 'passenger':
        for (let x = look.bx0 + 1.0; x + 0.7 < look.bx1 - 0.6; x += 1.28) ctx.rect(x, f + 1.1, 0.72, 1.0);
        break;
      case 'boxcar':
        ctx.rect(mid + 0.75, f, 0.45, 2.4);
        break;
      case 'caboose':
        ctx.rect(look.bx0 + 1.2, f + 1.15, 0.8, 0.9);
        ctx.rect(look.bx1 - 2.0, f + 1.15, 0.8, 0.9);
        if (look.cupola) ctx.rect(look.cupola[0] + 0.3, look.roofY + 0.12, look.cupola[1] - look.cupola[0] - 0.6, 0.42);
        break;
      default:
        break;
    }
  }

  /** Runs `fn` for [x0, x1] outside and inside tunnels, each clipped to its part. */
  split(s: Scene, x0: number, x1: number, fn: (lit: Lit, inTunnel: boolean) => void): void {
    const cover = tunnelCover(s, x0, x1);
    if (cover <= 0) {
      fn(s.lit, false);
      return;
    }
    if (cover >= 1) {
      fn(s.litTunnel, true);
      return;
    }
    const { ctx } = s;
    const tun = s.tunnels;
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < tun.length; i += 2) ctx.rect(tun[i], -2, tun[i + 1] - tun[i], 10);
    ctx.clip();
    fn(s.litTunnel, true);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0 - 1, -2, x1 - x0 + 2, 10);
    for (let i = 0; i < tun.length; i += 2) ctx.rect(tun[i + 1], -2, tun[i] - tun[i + 1], 10);
    ctx.clip('evenodd');
    fn(s.lit, false);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------

  private car(s: Scene, lit: Lit, inTunnel: boolean, look: CarLook, car: CarState, cut: boolean, ex: TrainExtras, throttle: number): void {
    const ctx = s.ctx;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    switch (car.kind) {
      case 'loco':
        this.loco(s, lit, look, ex, throttle, inTunnel);
        break;
      case 'tender':
        this.tender(s, lit, look);
        break;
      default:
        this.boxBody(s, lit, look, car, cut, inTunnel);
        break;
    }
  }

  private joint(s: Scene, rear: CarState, front: CarState): void {
    const ctx = s.ctx;
    const x = (rear.x1 + front.x0) / 2;
    const lit = tunnelCover(s, x - 0.6, x + 0.6) > 0.5 ? s.litTunnel : s.lit;
    // Drawbar and coupler knuckles.
    ctx.fillStyle = lit.c(IRON);
    ctx.fillRect(x - 0.55, 0.82, 1.1, 0.16);
    ctx.fillStyle = lit.c('#1C1A1A');
    ctx.fillRect(x - 0.14, 0.76, 0.28, 0.28);
    // The bridge plate at floor level: both halves between two cars, the car's half at the tender.
    if (rear.kind !== 'loco' && rear.kind !== 'tender') {
      const f = CAR_SPECS[rear.kind].floorY;
      const x1 = front.kind === 'tender' ? x : x + 0.3;
      ctx.fillStyle = lit.c('#4A4440');
      ctx.fillRect(x - 0.3, f - 0.07, x1 - (x - 0.3), 0.07);
      ctx.strokeStyle = lit.c('#1E1C1C');
      ctx.lineWidth = 0.025;
      ctx.strokeRect(x - 0.3, f - 0.07, x1 - (x - 0.3), 0.07);
    }
  }

  // ---- Locomotive ----------------------------------------------------------------------------

  private loco(s: Scene, lit: Lit, look: CarLook, ex: TrainExtras, throttle: number, inTunnel: boolean): void {
    const ctx = s.ctx;
    const x = look.x0;
    const theta = -s.odo / DRIVER_R;
    const blur = clamp01((Math.abs(s.v) - 5) / 12);
    // Frame.
    ctx.fillStyle = lit.c('#1E1C1C');
    ctx.fillRect(x + 4.3, 0.85, 9.8, 0.4);
    // Firebox (between the drivers, under the boiler's back).
    ctx.fillStyle = lit.c('#3A3E44');
    ctx.fillRect(x + 4.4, 1.25, 2.3, 0.9);
    // Boiler (Russia iron), with brass bands.
    const by = 2.55;
    const br = 0.85;
    ctx.fillStyle = lit.c('#56636E');
    ctx.fillRect(x + 4.5, by - br, 8.0, 2 * br);
    ctx.fillStyle = lit.c('#6E7C88');
    ctx.fillRect(x + 4.5, by + br * 0.35, 8.0, br * 0.4);
    ctx.fillStyle = lit.c('#46525C');
    ctx.fillRect(x + 4.5, by - br, 8.0, br * 0.5);
    ctx.fillStyle = lit.c(BRASS);
    for (const bx of [5.2, 7.0, 8.9, 10.8, 12.4]) ctx.fillRect(x + bx, by - br, 0.1, 2 * br);
    // Smokebox.
    ctx.fillStyle = lit.c('#2A2A2E');
    ctx.fillRect(x + 12.45, by - br - 0.05, 1.5, 2 * br + 0.1);
    ctx.fillStyle = lit.c('#3A3A40');
    ctx.fillRect(x + 12.45, by + 0.3, 1.5, 0.3);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x + 4.5, by - br, 9.45, 2 * br);
    // Handrail.
    ctx.strokeStyle = lit.c(BRASS);
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.moveTo(x + 4.6, by + 0.55);
    ctx.lineTo(x + 13.7, by + 0.55);
    ctx.stroke();
    // Smokestack (balloon).
    const sx = x + 12.95;
    ctx.fillStyle = lit.c('#26262A');
    ctx.beginPath();
    ctx.moveTo(sx - 0.24, by + br - 0.05);
    ctx.lineTo(sx - 0.27, 4.15);
    ctx.lineTo(sx - 0.66, 4.62);
    ctx.lineTo(sx - 0.6, 4.84);
    ctx.lineTo(sx + 0.6, 4.84);
    ctx.lineTo(sx + 0.66, 4.62);
    ctx.lineTo(sx + 0.27, 4.15);
    ctx.lineTo(sx + 0.24, by + br - 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(sx - 0.62, 4.78, 1.24, 0.07);
    ctx.fillRect(sx - 0.3, 4.1, 0.6, 0.06);
    // Domes: steam dome with whistle and safety valve, sand dome, bell.
    this.dome(ctx, lit, x + 8.9, by + br - 0.05, 0.42, 0.72);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x + 8.84, 4.05, 0.12, 0.26);
    ctx.fillRect(x + 8.8, 4.26, 0.2, 0.06);
    ctx.fillRect(x + 9.2, 3.95, 0.09, 0.18);
    this.dome(ctx, lit, x + 10.95, by + br - 0.05, 0.36, 0.52);
    // Bell on its yoke.
    ctx.fillStyle = lit.c(BRASS);
    ctx.beginPath();
    ctx.moveTo(x + 9.8, by + br + 0.05);
    ctx.lineTo(x + 9.78, by + br + 0.12);
    ctx.quadraticCurveTo(x + 9.9, by + br + 0.52, x + 10.02, by + br + 0.12);
    ctx.lineTo(x + 10.0, by + br + 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.03;
    ctx.stroke();
    // Headlamp: a box lamp on a bracket.
    ctx.fillStyle = lit.c('#1E1E22');
    ctx.fillRect(x + 13.55, by + br - 0.02, 0.1, 0.14);
    ctx.fillStyle = lit.c(IRON);
    ctx.fillRect(x + 13.3, 3.48, 0.95, 0.66);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x + 13.25, 4.12, 1.05, 0.08);
    ctx.fillRect(x + 13.62, 4.2, 0.3, 0.12);
    ctx.fillStyle = lit.c('#7A2E22');
    ctx.fillRect(x + 13.45, 3.6, 0.6, 0.4);
    ctx.fillStyle = s.night || inTunnel ? '#FFF1C8' : lit.c('#E8E0C8');
    ctx.beginPath();
    ctx.ellipse(x + 14.27, 3.81, 0.07, 0.26, 0, 0, TAU);
    ctx.fill();
    // Running board.
    ctx.fillStyle = lit.c('#1E1C1C');
    ctx.fillRect(x + 4.5, 1.6, 9.45, 0.1);
    // Cylinder and steam chest.
    ctx.fillStyle = lit.c('#3E4248');
    ctx.fillRect(x + 11.3, 0.62, 1.42, 0.68);
    ctx.fillStyle = lit.c('#4A5058');
    ctx.fillRect(x + 11.4, 1.3, 1.22, 0.3);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x + 11.3, 0.62, 0.08, 0.68);
    ctx.fillRect(x + 12.64, 0.62, 0.08, 0.68);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.04;
    ctx.strokeRect(x + 11.3, 0.62, 1.42, 0.68);
    // Pilot (cowcatcher) and buffer beam.
    ctx.fillStyle = lit.c('#9E2B1E');
    ctx.fillRect(x + 13.9, 0.95, 0.5, 0.38);
    ctx.strokeStyle = lit.c('#7A2A1E');
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    for (let i = 0; i <= 5; i++) {
      const t = i / 5;
      ctx.moveTo(x + 14.0 + t * 0.3, 0.95);
      ctx.lineTo(x + 14.2 + t * 1.6, 0.1 + t * 0.15);
    }
    ctx.moveTo(x + 14.0, 0.95);
    ctx.lineTo(x + 15.85, 0.12);
    ctx.stroke();
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x + 15.7, 0.1, 0.25, 0.1);
    // Leading truck.
    this.wheel(ctx, lit, x + 11.0, CAR_WHEEL_R, CAR_WHEEL_R, -s.odo / CAR_WHEEL_R, 8, '#9E2B1E', blur);
    this.wheel(ctx, lit, x + 12.85, CAR_WHEEL_R, CAR_WHEEL_R, -s.odo / CAR_WHEEL_R, 8, '#9E2B1E', blur);
    // Drivers, rods and crosshead.
    this.wheel(ctx, lit, x + 5.5, DRIVER_R, DRIVER_R, theta, 14, '#9E2B1E', blur, true);
    this.wheel(ctx, lit, x + 7.75, DRIVER_R, DRIVER_R, theta, 14, '#9E2B1E', blur, true);
    this.rods(ctx, lit, x, theta);
    // The cab, and its ladder up from the tender deck.
    this.cab(s, lit, x, ex, throttle, inTunnel);
    for (const l of look.ladders) ladder(ctx, lit, l.x, l.y0, l.y1);
  }

  private dome(ctx: CanvasRenderingContext2D, lit: Lit, cx: number, base: number, halfW: number, h: number): void {
    ctx.fillStyle = lit.c(BRASS);
    ctx.beginPath();
    ctx.moveTo(cx - halfW - 0.08, base);
    ctx.quadraticCurveTo(cx - halfW, base + 0.05, cx - halfW * 0.85, base + h * 0.6);
    ctx.quadraticCurveTo(cx, base + h * 1.15, cx + halfW * 0.85, base + h * 0.6);
    ctx.quadraticCurveTo(cx + halfW, base + 0.05, cx + halfW + 0.08, base);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c('#7A5A2A');
    ctx.lineWidth = 0.04;
    ctx.stroke();
    ctx.fillStyle = lit.c('#E6C98A');
    ctx.fillRect(cx - halfW * 0.5, base + h * 0.3, 0.08, h * 0.35);
  }

  private rods(ctx: CanvasRenderingContext2D, lit: Lit, x: number, theta: number): void {
    const rc = 0.34;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const p1x = x + 5.5 + rc * c;
    const p1y = DRIVER_R + rc * sn;
    const p2x = x + 7.75 + rc * c;
    const p2y = DRIVER_R + rc * sn;
    const gy = 1.0;
    const Lm = 2.6;
    const xc = p2x + Math.sqrt(Math.max(0, Lm * Lm - (gy - p2y) * (gy - p2y)));
    // Guides.
    ctx.fillStyle = lit.c('#8A8A90');
    ctx.fillRect(x + 9.5, 0.88, 1.85, 0.05);
    ctx.fillRect(x + 9.5, 1.08, 1.85, 0.05);
    // Piston rod.
    ctx.fillRect(xc, 0.97, x + 11.35 - xc, 0.06);
    // Crosshead.
    ctx.fillStyle = lit.c('#B8B8BE');
    ctx.fillRect(xc - 0.18, 0.9, 0.36, 0.2);
    // Rods: polished steel, outlined.
    const rod = (ax: number, ay: number, bx: number, by: number, w: number): void => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = lit.c(INK);
      ctx.lineWidth = w + 0.05;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.strokeStyle = lit.c('#C9C9CE');
      ctx.lineWidth = w;
      ctx.stroke();
    };
    rod(p1x, p1y, p2x, p2y, 0.1);
    rod(p2x, p2y, xc, gy, 0.12);
    ctx.fillStyle = lit.c(BRASS);
    for (const [px, py] of [
      [p1x, p1y],
      [p2x, p2y],
    ]) {
      ctx.beginPath();
      ctx.arc(px, py, 0.07, 0, TAU);
      ctx.fill();
    }
    ctx.lineCap = 'butt';
  }

  private cab(s: Scene, lit: Lit, x: number, ex: TrainExtras, throttle: number, inTunnel: boolean): void {
    const ctx = s.ctx;
    // Interior: dark, with the firebox glowing at the front.
    ctx.fillStyle = lit.c('#2A1E18');
    ctx.fillRect(x + 0.05, 1.4, 4.4, 2.5);
    const flick = 0.75 + 0.25 * Math.sin(s.t * 13) * Math.sin(s.t * 7.3 + 1);
    ctx.fillStyle = `rgba(255,${Math.round(120 + 40 * flick)},40,${(0.35 + 0.25 * flick * (s.night || inTunnel ? 1.4 : 1)).toFixed(3)})`;
    ctx.fillRect(x + 3.6, 1.45, 0.8, 0.9);
    // Levers.
    ctx.strokeStyle = lit.c(BRASS);
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(x + 4.1, 2.1);
    ctx.lineTo(x + 4.1 - 0.35 * throttle, 2.75);
    ctx.stroke();
    // The Engineer.
    // The Engineer at the levers; held up, he turns to face the gun with his hands high.
    const e = this.engineer;
    e.facing = ex.heldUp ? -1 : 1;
    e.hands = ex.heldUp ? 'up' : 'levers';
    e.t = s.t;
    e.seed = 1.7;
    this.fig.draw(ctx, lit, e, x + (ex.heldUp ? 2.8 : 2.35), 1.4, null);
    if (ex.cabCut) {
      // Cut away: just the roof, the front wall and the floor.
      ctx.fillStyle = lit.c('#5A2418');
      ctx.fillRect(x + 4.3, 1.3, 0.2, 2.6);
      this.cabRoof(ctx, lit, x);
      ctx.fillStyle = lit.c('#3A2A20');
      ctx.fillRect(x, 1.28, 4.5, 0.14);
      return;
    }
    // Side wall with window openings (even-odd).
    ctx.beginPath();
    ctx.rect(x, 1.3, 4.5, 2.62);
    ctx.rect(x + 0.7, 2.35, 2.4, 1.3);
    ctx.rect(x + 0.05, 1.45, 0.5, 2.3);
    ctx.rect(x + 3.45, 2.45, 0.75, 1.1);
    ctx.fillStyle = lit.c('#7A2E22');
    ctx.fill('evenodd');
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.stroke();
    // Cream window frames and a panel line.
    ctx.strokeStyle = lit.c(CREAM);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x + 0.7, 2.35, 2.4, 1.3);
    ctx.strokeRect(x + 3.45, 2.45, 0.75, 1.1);
    ctx.strokeRect(x + 0.75, 1.5, 3.4, 0.62);
    worldText(s, '4', x + 2.45, 1.82, 0.5, lit.c(BRASS), { family: 'rye' });
    this.cabRoof(ctx, lit, x);
  }

  private cabRoof(ctx: CanvasRenderingContext2D, lit: Lit, x: number): void {
    ctx.fillStyle = lit.c('#3A2A24');
    ctx.beginPath();
    ctx.moveTo(x - 0.18, 3.86);
    ctx.lineTo(x + 4.68, 3.86);
    ctx.lineTo(x + 4.6, 4.0);
    ctx.lineTo(x - 0.1, 4.0);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.04;
    ctx.stroke();
  }

  // ---- Tender --------------------------------------------------------------------------------

  private tender(s: Scene, lit: Lit, look: CarLook): void {
    const ctx = s.ctx;
    const x = look.x0;
    const blur = clamp01((Math.abs(s.v) - 5) / 12);
    // Frame and trucks.
    ctx.fillStyle = lit.c('#1E1C1C');
    ctx.fillRect(x + 0.1, 0.9, 8.8, 0.25);
    this.truck(ctx, lit, x + 1.7, s.odo, blur);
    this.truck(ctx, lit, x + 6.4, s.odo, blur);
    // Front deck joining the cab.
    ctx.fillStyle = lit.c('#3A3634');
    ctx.fillRect(x + 7.9, 1.28, 1.15, 0.12);
    // Tank body.
    ctx.fillStyle = lit.c(CAR_COLOURS.tender);
    ctx.fillRect(x + 0.1, 1.1, 7.85, 1.52);
    ctx.fillStyle = lit.c('#2A201C');
    ctx.fillRect(x + 0.1, 2.62, 7.85, 0.18);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x + 0.1, 1.1, 7.85, 1.7);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x + 0.1, 2.5, 7.85, 0.05);
    ctx.fillRect(x + 0.1, 1.2, 7.85, 0.04);
    // Coal heaped over the front two thirds, top at the walkable 2.8 m.
    ctx.fillStyle = lit.c('#1C1A1A');
    ctx.beginPath();
    ctx.moveTo(x + 3.2, 2.78);
    for (let i = 0; i <= 18; i++) {
      const cx = x + 3.3 + i * 0.25;
      const bump = 0.05 * Math.sin(i * 2.7) + 0.03 * Math.sin(i * 5.1);
      ctx.lineTo(cx, 2.83 + bump);
    }
    ctx.lineTo(x + 7.9, 2.78);
    ctx.lineTo(x + 7.9, 2.6);
    ctx.lineTo(x + 3.2, 2.6);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = lit.c('#3A3838');
    for (let i = 0; i < 9; i++) ctx.fillRect(x + 3.5 + i * 0.47, 2.82 + 0.03 * Math.sin(i * 3.3), 0.1, 0.05);
    // Water hatch 2 m from the rear (spec §5.5).
    const hx = x + 2.0;
    ctx.fillStyle = lit.c('#4A403A');
    ctx.fillRect(hx - 0.36, 2.8, 0.72, 0.12);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(hx - 0.3, 2.92, 0.6, 0.05);
    ctx.fillRect(hx + 0.26, 2.84, 0.1, 0.12);
    worldText(s, 'SWITCH & SPUR', x + 4.0, 1.85, 0.36, lit.c(BRASS), { family: 'rye' });
    // Ladders: up the bunker from the front deck, and up the rear from the car behind.
    for (const l of look.ladders) ladder(ctx, lit, l.x, l.y0, l.y1);
  }

  // ---- Cars behind the tender --------------------------------------------------------------------

  private boxBody(s: Scene, lit: Lit, look: CarLook, car: CarState, cut: boolean, inTunnel: boolean): void {
    const ctx = s.ctx;
    const { bx0, bx1, floorY: f, roofY: r } = look;
    const blur = clamp01((Math.abs(s.v) - 5) / 12);
    const mid = (bx0 + bx1) / 2;
    // Underframe: sills, truss rods, trucks.
    ctx.fillStyle = lit.c('#1E1C1C');
    ctx.fillRect(bx0, f - 0.22, bx1 - bx0, 0.22);
    ctx.strokeStyle = lit.c('#1E1C1C');
    ctx.lineWidth = 0.04;
    ctx.beginPath();
    ctx.moveTo(bx0 + 2.8, f - 0.2);
    ctx.lineTo(mid - 1.4, f - 0.62);
    ctx.lineTo(mid + 1.4, f - 0.62);
    ctx.lineTo(bx1 - 2.8, f - 0.2);
    ctx.stroke();
    ctx.fillRect(mid - 1.45, f - 0.62, 0.08, 0.4);
    ctx.fillRect(mid + 1.37, f - 0.62, 0.08, 0.4);
    this.truck(ctx, lit, bx0 + 1.9, s.odo, blur);
    this.truck(ctx, lit, bx1 - 1.9, s.odo, blur);
    // Platforms against both ends of the body.
    for (const [a, b] of look.decks) platform(ctx, lit, a, b, f, a < bx0);
    const body = CAR_COLOURS[car.kind];
    if (cut) {
      this.interior(s, s.litInside, look, car);
      // Cut edges: floor, end posts, roof.
      ctx.fillStyle = lit.c(shadeHex(body, 0.7));
      ctx.fillRect(bx0, f - 0.05, bx1 - bx0, 0.1);
      ctx.fillRect(bx0, f, 0.14, r - f);
      ctx.fillRect(bx1 - 0.14, f, 0.14, r - f);
      this.roof(ctx, lit, look, car);
      ctx.strokeStyle = lit.a('#F2E6C8', 0.5);
      ctx.lineWidth = 0.04;
      ctx.setLineDash([0.2, 0.14]);
      ctx.strokeRect(bx0 + 0.02, f, bx1 - bx0 - 0.04, r - f - 0.2);
      ctx.setLineDash([]);
      for (const l of look.ladders) ladder(ctx, lit, l.x, l.y0, l.y1);
      return;
    }
    // Interior glimpsed through openings.
    ctx.save();
    ctx.beginPath();
    this.addOpenings(ctx, look, false);
    ctx.clip();
    this.interior(s, s.litInside, look, car);
    ctx.restore();
    // Walls with openings.
    ctx.beginPath();
    ctx.rect(bx0, f, bx1 - bx0, r - f - 0.2);
    this.addOpenings(ctx, look, false);
    ctx.fillStyle = lit.c(body);
    ctx.fill('evenodd');
    this.siding(ctx, lit, look, car);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(bx0, f, bx1 - bx0, r - f - 0.2);
    this.details(s, lit, look, car, inTunnel);
    this.roof(ctx, lit, look, car);
    for (const l of look.ladders) if (l.kind !== 'hatch') ladder(ctx, lit, l.x, l.y0, l.y1);
  }

  private roof(ctx: CanvasRenderingContext2D, lit: Lit, look: CarLook, car: CarState): void {
    const { bx0, bx1, roofY: r } = look;
    ctx.fillStyle = lit.c(car.kind === 'armored' ? '#3A4038' : '#3E3430');
    ctx.beginPath();
    ctx.moveTo(bx0 - 0.08, r - 0.22);
    ctx.lineTo(bx1 + 0.08, r - 0.22);
    ctx.lineTo(bx1 + 0.02, r);
    ctx.lineTo(bx0 - 0.02, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.045;
    ctx.stroke();
    if (car.kind === 'boxcar' || car.kind === 'powder') {
      // Roof walk and a brake wheel at the B end.
      ctx.fillStyle = lit.c('#5A4432');
      ctx.fillRect(bx0 + 0.1, r - 0.06, bx1 - bx0 - 0.2, 0.06);
      ctx.strokeStyle = lit.c('#1E1C1C');
      ctx.lineWidth = 0.05;
      ctx.beginPath();
      ctx.moveTo(bx0 + 0.25, r);
      ctx.lineTo(bx0 + 0.25, r + 0.45);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(bx0 + 0.25, r + 0.45, 0.24, 0.05, 0, 0, TAU);
      ctx.stroke();
    }
    if (look.cupola) {
      const [c0, c1] = look.cupola;
      ctx.fillStyle = lit.c(CAR_COLOURS.caboose);
      ctx.fillRect(c0 + 0.1, r, c1 - c0 - 0.2, look.cupolaY - r - 0.12);
      ctx.fillStyle = lit.c('#3E3430');
      ctx.fillRect(c0 - 0.05, look.cupolaY - 0.12, c1 - c0 + 0.1, 0.12);
      ctx.strokeStyle = lit.c(INK);
      ctx.lineWidth = 0.045;
      ctx.strokeRect(c0 + 0.1, r, c1 - c0 - 0.2, look.cupolaY - r);
    }
    for (const h of look.hatches) {
      ctx.fillStyle = lit.c('#4A3E36');
      ctx.fillRect(h.x0, r, h.x1 - h.x0, 0.1);
      ctx.strokeStyle = lit.c(INK);
      ctx.lineWidth = 0.035;
      ctx.strokeRect(h.x0, r, h.x1 - h.x0, 0.1);
      ctx.fillStyle = lit.c(BRASS);
      ctx.fillRect(h.x - 0.08, r + 0.1, 0.16, 0.04);
    }
    if (car.kind === 'armored') parapet(ctx, lit, look, false);
    if (car.kind === 'caboose') {
      // Stove pipe.
      ctx.fillStyle = lit.c('#1E1C1C');
      ctx.fillRect(look.bx1 - 1.74, r, 0.14, 0.5);
      ctx.fillRect(look.bx1 - 1.8, r + 0.48, 0.26, 0.07);
    }
  }

  /** Board lines, trim, windows, lettering. */
  private siding(ctx: CanvasRenderingContext2D, lit: Lit, look: CarLook, car: CarState): void {
    const { bx0, bx1, floorY: f, roofY: r } = look;
    const top = r - 0.2;
    if (car.kind === 'armored') {
      // Plates and rivets.
      ctx.strokeStyle = lit.c('#343A32');
      ctx.lineWidth = 0.035;
      ctx.beginPath();
      for (let x = bx0 + 2; x < bx1 - 0.5; x += 2) {
        ctx.moveTo(x, f);
        ctx.lineTo(x, top);
      }
      ctx.moveTo(bx0, (f + top) / 2);
      ctx.lineTo(bx1, (f + top) / 2);
      ctx.stroke();
      ctx.fillStyle = lit.c('#262B24');
      ctx.beginPath();
      for (let x = bx0 + 0.2; x < bx1 - 0.1; x += 0.33) {
        for (const y of [f + 0.12, (f + top) / 2 - 0.1, (f + top) / 2 + 0.1, top - 0.12]) {
          ctx.moveTo(x + 0.035, y);
          ctx.arc(x, y, 0.035, 0, TAU);
        }
      }
      ctx.fill();
      return;
    }
    // Vertical boards.
    ctx.strokeStyle = lit.a(INK, 0.22);
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    for (let x = bx0 + 0.16; x < bx1; x += 0.16) {
      ctx.moveTo(x, f + 0.05);
      ctx.lineTo(x, top - 0.05);
    }
    ctx.stroke();
    if (car.kind === 'express' || car.kind === 'passenger' || car.kind === 'caboose') {
      ctx.fillStyle = lit.c(car.kind === 'caboose' ? '#8A3A28' : shadeHex(CAR_COLOURS[car.kind], 0.72));
      ctx.fillRect(bx0, top - 0.42, bx1 - bx0, 0.3);
      ctx.fillStyle = lit.c(BRASS);
      ctx.fillRect(bx0, top - 0.44, bx1 - bx0, 0.03);
      ctx.fillRect(bx0, top - 0.12, bx1 - bx0, 0.03);
    }
  }

  private details(s: Scene, lit: Lit, look: CarLook, car: CarState, inTunnel: boolean): void {
    const ctx = s.ctx;
    const { bx0, bx1, floorY: f, roofY: r } = look;
    const mid = (bx0 + bx1) / 2;
    const top = r - 0.2;
    const lamps = s.night || inTunnel;
    switch (car.kind) {
      case 'express': {
        // The sliding door, slid open to the left; the doorway frame.
        ctx.fillStyle = lit.c(shadeHex(CAR_COLOURS.express, 0.8));
        ctx.fillRect(mid - 3.0, f + 0.05, 2.0, 2.3);
        ctx.strokeStyle = lit.c(INK);
        ctx.lineWidth = 0.04;
        ctx.strokeRect(mid - 3.0, f + 0.05, 2.0, 2.3);
        ctx.beginPath();
        ctx.moveTo(mid - 3.0, f + 0.05);
        ctx.lineTo(mid - 1.0, f + 2.35);
        ctx.moveTo(mid - 1.0, f + 0.05);
        ctx.lineTo(mid - 3.0, f + 2.35);
        ctx.stroke();
        ctx.fillStyle = lit.c('#1E1C1C');
        ctx.fillRect(mid - 3.2, f + 2.38, 4.4, 0.06);
        ctx.strokeStyle = lit.c(BRASS);
        ctx.lineWidth = 0.05;
        ctx.strokeRect(mid - 1.0, f, 2.0, 2.25);
        // Barred windows.
        for (const wx of [bx0 + 1.6, bx1 - 2.4]) {
          ctx.fillStyle = lit.c('#1A1614');
          ctx.fillRect(wx, f + 1.3, 0.8, 0.7);
          ctx.strokeStyle = lit.c('#8A8A90');
          ctx.lineWidth = 0.03;
          ctx.beginPath();
          for (let i = 1; i < 4; i++) {
            ctx.moveTo(wx + i * 0.2, f + 1.3);
            ctx.lineTo(wx + i * 0.2, f + 2.0);
          }
          ctx.stroke();
        }
        worldText(s, 'OVERLAND EXPRESS', mid + 0.1, top - 0.27, 0.24, lit.c(BRASS), { family: 'rye' });
        break;
      }
      case 'passenger': {
        for (let x = bx0 + 1.0; x + 0.7 < bx1 - 0.6; x += 1.28) {
          ctx.strokeStyle = lit.c(CREAM);
          ctx.lineWidth = 0.06;
          ctx.strokeRect(x, f + 1.1, 0.72, 1.0);
          if (lamps) {
            ctx.fillStyle = 'rgba(255,196,110,0.5)';
            ctx.fillRect(x, f + 1.1, 0.72, 1.0);
          }
        }
        worldText(s, 'SWITCH & SPUR', mid, top - 0.27, 0.24, lit.c(BRASS), { family: 'rye' });
        break;
      }
      case 'boxcar': {
        // Sliding door, left a hand's width ajar.
        ctx.fillStyle = lit.c(shadeHex(CAR_COLOURS.boxcar, 0.86));
        ctx.fillRect(mid - 1.25, f + 0.02, 2.0, 2.45);
        ctx.strokeStyle = lit.c(INK);
        ctx.lineWidth = 0.04;
        ctx.strokeRect(mid - 1.25, f + 0.02, 2.0, 2.45);
        ctx.beginPath();
        ctx.moveTo(mid - 1.25, f + 0.02);
        ctx.lineTo(mid + 0.75, f + 2.47);
        ctx.moveTo(mid + 0.75, f + 0.02);
        ctx.lineTo(mid - 1.25, f + 2.47);
        ctx.stroke();
        ctx.fillStyle = lit.c('#1E1C1C');
        ctx.fillRect(mid - 1.5, f + 2.5, 3.0, 0.06);
        worldText(s, 'S&S', bx0 + 2.4, f + 1.9, 0.5, lit.c(CREAM), { family: 'rye' });
        worldText(s, '1204', bx0 + 2.4, f + 1.3, 0.3, lit.c(CREAM), { family: 'sans' });
        break;
      }
      case 'armored': {
        // Gun slits.
        ctx.fillStyle = lit.c('#101210');
        for (const gx of [bx0 + 2.2, mid - 0.3, bx1 - 2.8]) ctx.fillRect(gx, f + 1.55, 0.6, 0.11);
        worldText(s, 'U.S. MAIL · ARMORED', mid, f + 0.7, 0.24, lit.c('#C9CED6'), { family: 'sans' });
        break;
      }
      case 'caboose': {
        for (const wx of [bx0 + 1.2, bx1 - 2.0]) {
          if (lamps) {
            ctx.fillStyle = 'rgba(255,190,100,0.55)';
            ctx.fillRect(wx, f + 1.15, 0.8, 0.9);
          }
          ctx.strokeStyle = lit.c(CREAM);
          ctx.lineWidth = 0.05;
          ctx.strokeRect(wx, f + 1.15, 0.8, 0.9);
        }
        worldText(s, 'CABOOSE', mid, top - 0.27, 0.22, lit.c(CREAM), { family: 'rye' });
        // Red marker lamps at the rear end.
        ctx.fillStyle = lit.c(IRON);
        ctx.fillRect(look.x0 + 0.05, r - 0.9, 0.16, 0.3);
        ctx.fillStyle = lamps ? '#FF5A40' : lit.c('#B8392A');
        ctx.fillRect(look.x0 + 0.02, r - 0.84, 0.08, 0.18);
        break;
      }
      case 'powder': {
        this.powderMarks(s, lit, look, car);
        break;
      }
      default:
        break;
    }
  }

  /** DANGER lettering, a red flag, and damage that grows as the powder car's hp drops (spec §7.4). */
  private powderMarks(s: Scene, lit: Lit, look: CarLook, car: CarState): void {
    const ctx = s.ctx;
    const { bx0, bx1, floorY: f, roofY: r } = look;
    const mid = (bx0 + bx1) / 2;
    ctx.fillStyle = lit.c('#B8392A');
    ctx.fillRect(bx0 + 0.3, f + 1.45, bx1 - bx0 - 0.6, 0.9);
    worldText(s, 'DANGER', mid, f + 1.9, 0.62, lit.c('#F4ECD8'), { family: 'rye' });
    worldText(s, 'EXPLOSIVES · KEEP FIRE AWAY', mid, f + 0.95, 0.24, lit.c('#8E2A1E'), { family: 'sans' });
    // Red flag on a staff at the front end.
    const fx = bx1 - 0.3;
    ctx.strokeStyle = lit.c('#1E1C1C');
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(fx, r);
    ctx.lineTo(fx, r + 1.2);
    ctx.stroke();
    const wave = 0.08 * Math.sin(s.t * 9);
    ctx.fillStyle = lit.c('#E0442E');
    ctx.beginPath();
    ctx.moveTo(fx, r + 1.2);
    ctx.quadraticCurveTo(fx - 0.35, r + 1.1 + wave, fx - 0.75, r + 1.05 - wave);
    ctx.lineTo(fx - 0.72, r + 0.7 - wave);
    ctx.quadraticCurveTo(fx - 0.35, r + 0.78 + wave, fx, r + 0.8);
    ctx.closePath();
    ctx.fill();
    // Damage: bullet holes and scorches.
    const lost = Math.max(0, 8 - car.hp);
    ctx.fillStyle = lit.c('#1A1210');
    for (let i = 0; i < lost * 3; i++) {
      const hx = bx0 + 0.6 + ((i * 0.618 * 7.3) % 1) * (bx1 - bx0 - 1.2);
      const hy = f + 0.3 + ((i * 0.414 * 5.1) % 1) * (r - f - 0.8);
      ctx.beginPath();
      ctx.arc(hx, hy, 0.05 + 0.02 * (i % 3), 0, TAU);
      ctx.fill();
    }
    if (lost >= 3) {
      ctx.fillStyle = lit.a('#1A1210', Math.min(0.55, lost * 0.07));
      ctx.beginPath();
      ctx.ellipse(mid - 1.5, f + 0.9, 1.2, 0.7, 0.2, 0, TAU);
      ctx.ellipse(mid + 2.2, r - 0.8, 1.0, 0.5, -0.3, 0, TAU);
      ctx.fill();
    }
  }

  /** What's inside a car (drawn for the cutaway and behind openings). */
  private interior(s: Scene, lit: Lit, look: CarLook, car: CarState): void {
    const ctx = s.ctx;
    const { bx0, bx1, floorY: f, roofY: r } = look;
    const mid = (bx0 + bx1) / 2;
    const top = r - 0.2;
    // Back wall and floor.
    ctx.fillStyle = lit.c(car.kind === 'armored' ? '#3A4036' : '#5A4232');
    ctx.fillRect(bx0, f, bx1 - bx0, top - f);
    ctx.strokeStyle = lit.a('#2A1E16', 0.4);
    ctx.lineWidth = 0.025;
    ctx.beginPath();
    for (let y = f + 0.3; y < top; y += 0.3) {
      ctx.moveTo(bx0, y);
      ctx.lineTo(bx1, y);
    }
    ctx.stroke();
    ctx.fillStyle = lit.c('#3A2A20');
    ctx.fillRect(bx0, f - 0.02, bx1 - bx0, 0.1);
    // A lamp near the ceiling.
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(mid + 1.8, top - 0.35, 0.2, 0.3);
    ctx.fillStyle = '#FFE0A0';
    ctx.fillRect(mid + 1.84, top - 0.3, 0.12, 0.16);
    switch (car.kind) {
      case 'express':
        this.safe(s, lit, mid, f);
        // Mail sacks and parcels.
        ctx.fillStyle = lit.c('#B8A07A');
        ctx.beginPath();
        ctx.ellipse(bx0 + 1.4, f + 0.35, 0.5, 0.35, 0, 0, TAU);
        ctx.ellipse(bx0 + 2.3, f + 0.3, 0.45, 0.3, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = lit.c('#8E6A44');
        ctx.fillRect(bx1 - 2.6, f, 0.9, 0.6);
        ctx.fillRect(bx1 - 2.4, f + 0.6, 0.6, 0.45);
        break;
      case 'passenger':
        for (let x = bx0 + 0.8; x < bx1 - 0.8; x += 1.28) {
          ctx.fillStyle = lit.c('#7A2E22');
          ctx.fillRect(x, f + 0.45, 0.14, 1.0);
          ctx.fillRect(x, f + 0.45, 0.62, 0.14);
          ctx.fillStyle = lit.c('#3A2A20');
          ctx.fillRect(x + 0.1, f, 0.08, 0.45);
        }
        for (let x = bx0 + 1.0; x + 0.7 < bx1 - 0.6; x += 1.28) {
          ctx.fillStyle = lit.c(s.night ? '#27304A' : '#9CC7E8');
          ctx.fillRect(x + 0.05, f + 1.4, 0.6, 0.8);
        }
        break;
      case 'boxcar':
        ctx.fillStyle = lit.c('#8E6A44');
        ctx.fillRect(bx0 + 0.6, f, 1.1, 1.1);
        ctx.fillRect(bx0 + 0.7, f + 1.1, 0.9, 0.8);
        ctx.fillRect(bx1 - 2.2, f, 1.2, 0.9);
        ctx.fillStyle = lit.c('#6A4A2E');
        ctx.beginPath();
        ctx.ellipse(mid + 1.2, f + 0.45, 0.35, 0.45, 0, 0, TAU);
        ctx.ellipse(mid + 2.0, f + 0.45, 0.35, 0.45, 0, 0, TAU);
        ctx.fill();
        break;
      case 'armored':
        ctx.fillStyle = lit.c('#2B2B2E');
        ctx.fillRect(mid - 0.6, f, 1.2, 0.8);
        ctx.fillStyle = lit.c(BRASS);
        ctx.fillRect(mid - 0.6, f + 0.6, 1.2, 0.05);
        ctx.strokeStyle = lit.c(WOOD);
        ctx.lineWidth = 0.06;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          ctx.moveTo(bx0 + 1.2 + i * 0.3, f + 0.5);
          ctx.lineTo(bx0 + 1.3 + i * 0.3, f + 1.8);
        }
        ctx.stroke();
        break;
      case 'caboose':
        // Stove, bunk, desk.
        ctx.fillStyle = lit.c('#1E1C1C');
        ctx.fillRect(bx1 - 1.97, f, 0.6, 0.8);
        ctx.fillRect(bx1 - 1.75, f + 0.8, 0.16, top - f - 0.8);
        ctx.fillStyle = 'rgba(255,140,60,0.6)';
        ctx.fillRect(bx1 - 1.87, f + 0.2, 0.4, 0.2);
        ctx.fillStyle = lit.c('#6B4A2A');
        ctx.fillRect(bx0 + 2.2, f + 0.6, 2.2, 0.15);
        ctx.fillStyle = lit.c('#B8A07A');
        ctx.fillRect(bx0 + 2.3, f + 0.75, 2.0, 0.2);
        break;
      case 'powder':
        for (let i = 0; i < 6; i++) {
          const cx = bx0 + 0.8 + i * 1.6;
          ctx.fillStyle = lit.c('#9A7650');
          ctx.fillRect(cx, f, 1.2, 0.7);
          ctx.fillRect(cx + 0.1, f + 0.7, 1.0, 0.6);
          ctx.fillStyle = lit.c('#B8392A');
          ctx.fillRect(cx + 0.2, f + 0.25, 0.8, 0.18);
          ctx.fillRect(cx + 0.25, f + 0.9, 0.7, 0.16);
        }
        break;
      default:
        break;
    }
  }

  /** The express car's safe (spec §7.4): shut, being cracked, or hanging open. */
  private safe(s: Scene, lit: Lit, mid: number, f: number): void {
    const ctx = s.ctx;
    const st = this.lootStatus;
    const open = st === 'carried' || st === 'dropped' || st === 'stolen';
    ctx.fillStyle = lit.c('#26262A');
    ctx.fillRect(mid - 0.55, f, 1.1, 1.3);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(mid - 0.55, f, 1.1, 1.3);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(mid - 0.5, f + 1.12, 1.0, 0.05);
    ctx.fillRect(mid - 0.5, f + 0.12, 1.0, 0.04);
    if (open) {
      ctx.fillStyle = lit.c('#0E0E10');
      ctx.fillRect(mid - 0.42, f + 0.2, 0.84, 0.86);
      // Door swung toward the viewer, seen edge-on to the right.
      ctx.fillStyle = lit.c('#3A3A40');
      ctx.fillRect(mid + 0.55, f + 0.15, 0.16, 0.95);
      return;
    }
    // Gold lettering and the dial.
    ctx.fillStyle = lit.c('#1A1A1E');
    ctx.fillRect(mid - 0.42, f + 0.2, 0.84, 0.86);
    ctx.strokeStyle = lit.c(BRASS);
    ctx.lineWidth = 0.025;
    ctx.strokeRect(mid - 0.38, f + 0.24, 0.76, 0.78);
    ctx.fillStyle = lit.c('#D8C28A');
    ctx.beginPath();
    ctx.arc(mid + 0.12, f + 0.68, 0.14, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.02;
    ctx.beginPath();
    const a = st === 'cracking' ? s.t * 3 : 0.4;
    ctx.moveTo(mid + 0.12, f + 0.68);
    ctx.lineTo(mid + 0.12 + 0.12 * Math.cos(a), f + 0.68 + 0.12 * Math.sin(a));
    ctx.stroke();
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(mid - 0.3, f + 0.62, 0.16, 0.05);
  }

  /** Set by the renderer each frame before draw(). */
  lootStatus: GameState['loot']['status'] = 'safe';

  // ---- Running gear ----------------------------------------------------------------------------

  private truck(ctx: CanvasRenderingContext2D, lit: Lit, cx: number, odo: number, blur: number): void {
    const a = -odo / CAR_WHEEL_R;
    this.wheel(ctx, lit, cx - 0.8, CAR_WHEEL_R, CAR_WHEEL_R, a, 6, '#2B2B2E', blur);
    this.wheel(ctx, lit, cx + 0.8, CAR_WHEEL_R, CAR_WHEEL_R, a, 6, '#2B2B2E', blur);
    // Arch-bar side frame and bolster.
    ctx.strokeStyle = lit.c('#1A1818');
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.moveTo(cx - 1.05, 0.45);
    ctx.lineTo(cx - 0.6, 0.75);
    ctx.lineTo(cx + 0.6, 0.75);
    ctx.lineTo(cx + 1.05, 0.45);
    ctx.lineTo(cx - 1.05, 0.45);
    ctx.stroke();
    ctx.fillStyle = lit.c('#1A1818');
    ctx.fillRect(cx - 0.3, 0.4, 0.6, 0.5);
    ctx.fillStyle = lit.c('#3A3634');
    ctx.fillRect(cx - 0.92, 0.36, 0.2, 0.16);
    ctx.fillRect(cx + 0.72, 0.36, 0.2, 0.16);
  }

  private wheel(ctx: CanvasRenderingContext2D, lit: Lit, cx: number, cy: number, r: number, angle: number, spokes: number, centre: string, blur: number, counterweight = false): void {
    ctx.fillStyle = lit.c('#1A1818');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = lit.c(centre);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.84, 0, TAU);
    ctx.fill();
    // Spokes fade into a blurred disc at speed so they don't strobe.
    const spokeAlpha = 1 - 0.85 * blur;
    if (spokeAlpha > 0.05) {
      ctx.globalAlpha = spokeAlpha;
      ctx.fillStyle = lit.c('#1A1818');
      ctx.beginPath();
      for (let i = 0; i < spokes; i++) {
        const a = angle + (i / spokes) * TAU;
        const a0 = a - (0.34 / spokes) * 2;
        const a1 = a + (0.34 / spokes) * 2;
        ctx.moveTo(cx + Math.cos(a0) * r * 0.2, cy + Math.sin(a0) * r * 0.2);
        ctx.lineTo(cx + Math.cos(a) * r * 0.82, cy + Math.sin(a) * r * 0.82);
        ctx.lineTo(cx + Math.cos(a1) * r * 0.2, cy + Math.sin(a1) * r * 0.2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (blur > 0) {
      ctx.fillStyle = lit.a('#1A1818', 0.35 * blur);
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.8, 0, TAU);
      ctx.fill();
    }
    if (counterweight) {
      ctx.fillStyle = lit.c('#7A2A1E');
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.8, angle + Math.PI - 0.7, angle + Math.PI + 0.7);
      ctx.arc(cx, cy, r * 0.45, angle + Math.PI + 0.55, angle + Math.PI - 0.55, true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = lit.c('#6E6660');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.16, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = lit.c('#8A8480');
    ctx.lineWidth = 0.035;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 0.02, 0, TAU);
    ctx.stroke();
  }
}

// ---- Shared car parts ------------------------------------------------------------------------------

/** An end platform [x0, x1] at floor height, with a side railing and steps. */
function platform(ctx: CanvasRenderingContext2D, lit: Lit, x0: number, x1: number, f: number, rearEnd: boolean): void {
  ctx.fillStyle = lit.c('#4A3A2E');
  ctx.fillRect(x0, f - 0.1, x1 - x0, 0.1);
  ctx.strokeStyle = lit.c('#1E1C1C');
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  const outer = rearEnd ? x0 + 0.05 : x1 - 0.05;
  ctx.moveTo(outer, f);
  ctx.lineTo(outer, f + 0.95);
  ctx.moveTo(x0, f + 0.95);
  ctx.lineTo(x1, f + 0.95);
  ctx.moveTo(x0, f + 0.5);
  ctx.lineTo(x1, f + 0.5);
  // Steps down.
  ctx.moveTo(outer, f - 0.1);
  ctx.lineTo(outer, f - 0.75);
  ctx.moveTo(outer - 0.18, f - 0.45);
  ctx.lineTo(outer + 0.18, f - 0.45);
  ctx.moveTo(outer - 0.18, f - 0.75);
  ctx.lineTo(outer + 0.18, f - 0.75);
  ctx.stroke();
}

/** A side ladder from y0 to y1 at x. */
function ladder(ctx: CanvasRenderingContext2D, lit: Lit, x: number, y0: number, y1: number): void {
  ctx.strokeStyle = lit.c('#1E1C1C');
  ctx.lineWidth = 0.035;
  ctx.beginPath();
  ctx.moveTo(x - 0.18, y0);
  ctx.lineTo(x - 0.18, y1 + 0.12);
  ctx.moveTo(x + 0.18, y0);
  ctx.lineTo(x + 0.18, y1 + 0.12);
  for (let y = y0 + 0.3; y < y1; y += 0.33) {
    ctx.moveTo(x - 0.18, y);
    ctx.lineTo(x + 0.18, y);
  }
  ctx.stroke();
}

/** The armored car's roof parapet: the far one behind the roof, the near one (front) over figures. */
function parapet(ctx: CanvasRenderingContext2D, lit: Lit, look: CarLook, near: boolean): void {
  const { bx0, bx1, roofY: r } = look;
  const h = 0.52;
  ctx.fillStyle = lit.c(near ? '#4C5548' : '#3A4238');
  ctx.beginPath();
  ctx.moveTo(bx0 + 0.05, r - 0.02);
  // Crenellated top with loopholes.
  const step = 0.9;
  let x = bx0 + 0.05;
  ctx.lineTo(x, r + h);
  while (x + step < bx1 - 0.05) {
    ctx.lineTo(x + step * 0.7, r + h);
    ctx.lineTo(x + step * 0.7, r + h - 0.12);
    ctx.lineTo(x + step, r + h - 0.12);
    ctx.lineTo(x + step, r + h);
    x += step;
  }
  ctx.lineTo(bx1 - 0.05, r + h);
  ctx.lineTo(bx1 - 0.05, r - 0.02);
  ctx.closePath();
  if (near) {
    ctx.globalAlpha = 0.92;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.04;
    ctx.stroke();
    ctx.fillStyle = lit.c('#262B24');
    ctx.beginPath();
    for (let rx = bx0 + 0.25; rx < bx1 - 0.1; rx += 0.4) {
      ctx.moveTo(rx + 0.03, r + 0.12);
      ctx.arc(rx, r + 0.12, 0.03, 0, TAU);
    }
    ctx.fill();
  } else {
    ctx.fill();
  }
}

const shades = new Map<string, Map<number, string>>();

/** A #RRGGBB colour scaled toward black (k < 1), as #RRGGBB (memoised; cacheable by the Lit palettes). */
export function shadeHex(hex: string, k: number): string {
  let m = shades.get(hex);
  if (!m) {
    m = new Map();
    shades.set(hex, m);
  }
  let out = m.get(k);
  if (out === undefined) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * k));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * k));
    const b = Math.min(255, Math.round((n & 255) * k));
    out = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
    m.set(k, out);
  }
  return out;
}
