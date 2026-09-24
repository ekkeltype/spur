// Trackside structures in the Rider's view (spec §18.2 layer 5): stations, water towers, signals,
// mileposts, speed boards, switch stands, tunnel portals and mountains, trestles over gorges, low
// bridges, obstacles and other trains. All come from trackside() in the train frame; this tick's
// x plus Scene.shift places them at render time.
//
// Signals follow spec §9.1 exactly (signal-look.ts): a signal facing the train shows its arms and
// lamps; one facing away shows the arm's back and no lamp colour; at night only lamps are seen.
// Depth: structures on the far side of the track are drawn behind the train; switch stands,
// mileposts and speed boards stand on the near side; a tunnel's rock and portals, a low bridge's
// deck and the telltales before it hang in front of everything on the train.

import { MPH } from '../../sim/rules';
import type { AiKind, Aspect, JunctionDef, RunDef, TracksideItem } from '../../sim/types';
import { LAMP } from '../palette';
import type { Lit } from './materials';
import { hash01, noise1 } from './parallax';
import { BALLAST_Y, FLOOR_Y, HORIZON_Y, LANE_Y, MID_BASE_Y, NEAR_Y } from './scenery';

/** How far below the rims the gorge's V is drawn (off the bottom of the view). */
const GORGE_BOTTOM_DROP = 6;
import { clamp01, setWorld, TAU, TUNNEL_CEILING, worldText, type Scene } from './scene';
import { lampLetter, signalHeads, type LampColour } from './signal-look';
import { glowSprite } from './sprites';

const INK = '#2A2118';
const IRON = '#2B2B2E';
const BRASS = '#C8A15A';
const WOOD = '#6B4A2A';
const DARKWOOD = '#4A3626';
const STONE = '#9A8672';

/** Low bridge beam bottom: the highest roof (4.2) plus the clearance (spec §4.3). */
export const LOW_BRIDGE_Y = 5.4;
/** Telltales hang this far before a low bridge, on both sides. */
export const TELLTALE_DIST = 25;

const LAMP_RGB: Record<LampColour, string> = { red: '255,90,64', yellow: '255,196,70', green: '110,230,130' };

/** One other train at render time, with which end its loco is at. */
export interface AiDraw {
  id: string;
  x0: number;
  x1: number;
  lane: 'same' | 'adjacent';
  ai: AiKind;
  v: number;
  cars: number;
  /** +1: the loco (or leading end) is at x1; −1: at x0. */
  front: 1 | -1;
  /** Distance rolled, for wheels. */
  roll: number;
}

export class TracksidePainter {
  /** Eased 0..1 per tunnel id: the near face is cut away while the train is inside. */
  private readonly cut = new Map<string, number>();

  // ---- Behind the train ------------------------------------------------------------------------

  /**
   * The gorge under a trestle (drawn before the track). Looking across the line we look along the
   * gorge: behind the track it recedes toward the hills as a narrowing valley; in front of it, the
   * ground breaks off at jagged rims into a V that drops out of sight.
   */
  drawGorges(s: Scene, items: readonly TracksideItem[]): void {
    const { ctx } = s;
    setWorld(s);
    const lit = s.lit;
    for (const it of items) {
      if (it.kind !== 'trestle') continue;
      const x0 = it.x0 + s.shift;
      const x1 = it.x1 + s.shift;
      if (x1 < s.left - 10 || x0 > s.right + 10) continue;
      const w = x1 - x0;
      const seed = hashId(it.id);
      // The valley behind the track, hazier with distance.
      const far = new Path2D();
      far.moveTo(x0 - 0.4, -0.3);
      far.lineTo(x0 + w * 0.3, MID_BASE_Y + 0.25);
      far.lineTo(x1 - w * 0.3, MID_BASE_Y + 0.25);
      far.lineTo(x1 + 0.4, -0.3);
      far.closePath();
      const fg = ctx.createLinearGradient(0, MID_BASE_Y + 0.25, 0, -0.3);
      fg.addColorStop(0, lit.c('#B07A5A'));
      fg.addColorStop(1, lit.c('#6E3E2A'));
      ctx.fillStyle = fg;
      ctx.fill(far);
      ctx.save();
      ctx.clip(far);
      ctx.strokeStyle = lit.a('#4A2618', 0.35);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      for (let k = 1; k < 6; k++) {
        const t = k / 6;
        ctx.moveTo(x0 + w * 0.3 * t, -0.3 + (MID_BASE_Y + 0.55) * t);
        ctx.lineTo(x1 - w * 0.3 * t, -0.3 + (MID_BASE_Y + 0.55) * t);
      }
      ctx.stroke();
      // A glint of the river, far down the gorge.
      ctx.fillStyle = lit.a('#9CC7E8', 0.6);
      ctx.fillRect(x0 + w * 0.42, MID_BASE_Y + 0.05, w * 0.16, 0.08);
      ctx.restore();
      // The V below the track: jagged rims dropping out of sight, dark in the depths.
      const v = new Path2D();
      v.moveTo(x0 - 0.6, BALLAST_Y + 0.15);
      const steps = 7;
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const jag = (hash01(seed + k, 71) - 0.5) * 0.9;
        v.lineTo(x0 - 0.6 + w * 0.3 * t + jag, BALLAST_Y + 0.15 - (GORGE_BOTTOM_DROP * t));
      }
      for (let k = steps; k >= 1; k--) {
        const t = k / steps;
        const jag = (hash01(seed + 40 + k, 72) - 0.5) * 0.9;
        v.lineTo(x1 + 0.6 - w * 0.3 * t + jag, BALLAST_Y + 0.15 - (GORGE_BOTTOM_DROP * t));
      }
      v.lineTo(x1 + 0.6, BALLAST_Y + 0.15);
      v.closePath();
      const dg = ctx.createLinearGradient(0, BALLAST_Y, 0, BALLAST_Y - GORGE_BOTTOM_DROP * 0.8);
      dg.addColorStop(0, lit.c('#5A3222'));
      dg.addColorStop(0.45, lit.c('#2E1A12'));
      dg.addColorStop(1, lit.c('#120A06'));
      ctx.fillStyle = dg;
      ctx.fill(v);
      // Sunlit lips of the rims.
      ctx.strokeStyle = lit.c('#C08A62');
      ctx.lineWidth = 0.14;
      ctx.stroke(v);
    }
  }

  drawBack(s: Scene, items: readonly TracksideItem[], run: RunDef): void {
    setWorld(s);
    for (const it of items) {
      switch (it.kind) {
        case 'tunnel':
          this.tunnelBack(s, it.x0 + s.shift, it.x1 + s.shift);
          break;
        case 'station':
          this.station(s, it.x + s.shift, it.platform, it.name, run.stations.find((st) => st.id === it.id)?.waterColumn ?? false);
          break;
        case 'water':
          this.waterTower(s, it.x + s.shift);
          break;
        case 'signal':
          this.signal(s, it.x + s.shift, it.facing, it.heads, it.aspect);
          break;
        case 'lowBridge':
          this.lowBridgeBack(s, it.x + s.shift);
          break;
        case 'trestle':
          this.trestle(s, it.x0 + s.shift, it.x1 + s.shift, it.burning);
          break;
        case 'junction':
          this.divergingTrack(s, it.x + s.shift, junctionFacing(items, it.x, run.junctions.find((j) => j.node === it.id)));
          break;
        default:
          break;
      }
    }
  }

  /** Obstacles on the line (drawn after the track, before the train). */
  drawObstacles(s: Scene, items: readonly TracksideItem[], obstacleTicks: (id: string) => number): void {
    setWorld(s);
    for (const it of items) {
      if (it.kind !== 'obstacle') continue;
      const x = it.x + s.shift;
      if (x < s.left - 12 || x > s.right + 12) continue;
      const seed = hashId(it.id);
      const lit = s.lit;
      if (it.obstacle === 'rocks') rocksPile(s.ctx, lit, x, seed);
      else if (it.obstacle === 'barricade') barricade(s, lit, x, seed, it.state === 'hit');
      else cattle(s, lit, x, seed, it.state, obstacleTicks(it.id));
    }
  }

  /** Other trains: adjacent ones before our train (behind it), same-lane ones with it. */
  drawTrains(s: Scene, trains: readonly AiDraw[], lane: 'same' | 'adjacent'): void {
    setWorld(s);
    for (const t of trains) {
      if (t.lane !== lane) continue;
      if (t.x1 < s.left - 5 || t.x0 > s.right + 5) continue;
      const { ctx } = s;
      ctx.save();
      if (lane === 'adjacent') {
        // A parallel track a little farther away: higher on screen, slightly smaller, hazier.
        ctx.translate(0, 0.95);
        ctx.scale(1, 0.92);
        this.adjacentRails(s, t.x0 - 12, t.x1 + 12);
      }
      aiTrain(s, s.lit, t);
      ctx.restore();
    }
  }

  private adjacentRails(s: Scene, x0: number, x1: number): void {
    const { ctx } = s;
    const lit = s.lit;
    const a = Math.max(x0, s.left - 2);
    const b = Math.min(x1, s.right + 2);
    if (b <= a) return;
    ctx.fillStyle = lit.c('#7E6E5C');
    ctx.fillRect(a, -0.75, b - a, 0.5);
    ctx.fillStyle = lit.c('#3E3028');
    ctx.beginPath();
    for (let x = Math.floor((a + s.odo) / 0.62) * 0.62 - s.odo; x < b; x += 0.62) ctx.rect(x - 0.12, -0.28, 0.24, 0.14);
    ctx.fill();
    ctx.fillStyle = lit.c('#4A4440');
    ctx.fillRect(a, -0.14, b - a, 0.14);
  }

  // ---- In front of the train, before the figures ------------------------------------------------

  /** The water tower's spout (it reaches over the tender) and near-side signs and stands. */
  drawNear(s: Scene, items: readonly TracksideItem[], filling: boolean): void {
    setWorld(s);
    for (const it of items) {
      switch (it.kind) {
        case 'water':
          this.spout(s, it.x + s.shift, it.spoutDown, filling && it.spoutDown);
          break;
        case 'milepost':
          milepost(s, it.x + s.shift, it.mile);
          break;
        case 'curve':
          speedBoard(s, it.x0 + s.shift - 6, it.limit);
          break;
        case 'junction':
          switchStand(s, it.x + s.shift - 4, it.state);
          break;
        default:
          break;
      }
    }
  }

  // ---- In front of everything ---------------------------------------------------------------------

  /**
   * Tunnel rock and portals, low bridge decks and telltale cords. `trainIn(x0, x1)` says whether
   * the train occupies a range: a tunnel's near face is cut away while the train is inside.
   */
  drawFront(s: Scene, items: readonly TracksideItem[], trainIn: (x0: number, x1: number) => boolean): void {
    setWorld(s);
    for (const it of items) {
      if (it.kind === 'tunnel') {
        const x0 = it.x0 + s.shift;
        const x1 = it.x1 + s.shift;
        const target = trainIn(x0, x1) ? 1 : 0;
        const prev = this.cut.get(it.id) ?? target;
        const next = s.dt > 0 ? prev + (target - prev) * (1 - Math.exp(-s.dt / 0.18)) : prev;
        this.cut.set(it.id, next);
        this.tunnelFront(s, x0, x1, it.name, next);
      } else if (it.kind === 'lowBridge') {
        this.lowBridgeFront(s, it.x + s.shift);
      }
    }
  }

  // ---- Night and tunnel lights (additive) ---------------------------------------------------------

  drawLights(s: Scene, items: readonly TracksideItem[], trains: readonly AiDraw[]): void {
    const { ctx } = s;
    setWorld(s);
    const dark = s.night ? 1 : s.sky.light < 0.75 ? 0.6 : 0;
    ctx.globalCompositeOperation = 'lighter';
    for (const it of items) {
      if (it.kind === 'signal' && it.facing === 'toward') {
        const x = it.x + s.shift;
        if (x < s.left - 6 || x > s.right + 6) continue;
        const heads = signalHeads(it.aspect, it.heads);
        for (let h = 0; h < heads.length; h++) {
          const y = signalLampY(h);
          glow(ctx, LAMP_RGB[heads[h].lamp], x + 0.42, y, s.night ? 2.2 : 1.1, s.night ? 0.95 : 0.45);
        }
      } else if (it.kind === 'station' && dark > 0) {
        const x = it.x + s.shift;
        for (let lx = x - it.platform / 2 + 6; lx < x + it.platform / 2; lx += 15) glow(ctx, '255,190,110', lx, 3.35, 2.4, 0.7 * dark);
        glow(ctx, '255,190,110', x - it.platform / 4, 3.2, 5, 0.35 * dark);
      } else if (it.kind === 'junction' && dark > 0) {
        glow(ctx, it.state === 'normal' ? LAMP_RGB.green : LAMP_RGB.yellow, it.x + s.shift - 4, 0.95, 1.2, 0.8 * dark);
      } else if (it.kind === 'trestle' && it.burning) {
        const x0 = it.x0 + s.shift;
        const x1 = it.x1 + s.shift;
        const fl = 0.8 + 0.2 * Math.sin(s.t * 11) * Math.sin(s.t * 5.3);
        for (let x = x0 + 2; x < x1; x += 5) glow(ctx, '255,130,40', x, -0.6, 5.5, 0.55 * fl);
      }
    }
    for (const t of trains) {
      if (t.x1 < s.left - 60 || t.x0 > s.right + 60 || t.ai === 'runaway') continue;
      const lx = t.front === 1 ? t.x1 - 1.7 : t.x0 + 1.7;
      const ly = 3.8 + (t.lane === 'adjacent' ? 0.95 : 0);
      glow(ctx, '255,240,200', lx, ly, s.night ? 3.2 : 1.4, s.night ? 1 : 0.5);
      if (s.night) beam(ctx, lx, ly, t.front, 45, 0.35);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---- Structures ---------------------------------------------------------------------------------

  private station(s: Scene, x: number, platformLen: number, name: string, column: boolean): void {
    const { ctx } = s;
    const lit = s.lit;
    const p0 = x - platformLen / 2;
    const p1 = x + platformLen / 2;
    if (p1 < s.left - 20 || p0 > s.right + 20) return;
    // Platform along the far side.
    ctx.fillStyle = lit.c('#7A5E44');
    ctx.fillRect(p0, 0.25, p1 - p0, 0.75);
    ctx.fillStyle = lit.c('#9A7A58');
    ctx.fillRect(p0, 0.95, p1 - p0, 0.12);
    // Depot building behind it, name board on the roof.
    const bx = x - platformLen / 4;
    const bw = Math.min(14, platformLen * 0.4);
    const b0 = bx - bw / 2;
    ctx.fillStyle = lit.c('#C9A77A');
    ctx.fillRect(b0, 1.0, bw, 4.4);
    ctx.strokeStyle = lit.a(INK, 0.25);
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (let lx = b0 + 0.3; lx < b0 + bw; lx += 0.3) {
      ctx.moveTo(lx, 1.0);
      ctx.lineTo(lx, 5.4);
    }
    ctx.stroke();
    // Bay window and doors.
    ctx.fillStyle = lit.c('#8E6A44');
    ctx.fillRect(bx - 1.2, 1.0, 2.4, 3.6);
    const win = s.night ? '#F2C46A' : lit.c('#2A2622');
    ctx.fillStyle = win;
    for (const wx of [b0 + 1.2, bx - 0.8, bx + 0.2, b0 + bw - 2.2]) ctx.fillRect(wx, 2.6, 0.7, 1.2);
    ctx.fillStyle = lit.c('#4A3626');
    ctx.fillRect(b0 + 3.0, 1.0, 1.1, 2.4);
    ctx.fillRect(b0 + bw - 4.0, 1.0, 1.1, 2.4);
    // Roof with deep eaves over the platform.
    ctx.fillStyle = lit.c('#5E3A2A');
    ctx.beginPath();
    ctx.moveTo(b0 - 1.4, 5.1);
    ctx.lineTo(b0 + bw + 1.4, 5.1);
    ctx.lineTo(b0 + bw - 0.6, 6.5);
    ctx.lineTo(b0 + 0.6, 6.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.stroke();
    // Name board.
    const nb = Math.min(bw - 1, 0.42 * name.length + 1.2);
    ctx.fillStyle = lit.c('#EFE6D2');
    ctx.fillRect(bx - nb / 2, 6.55, nb, 0.85);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.06;
    ctx.strokeRect(bx - nb / 2, 6.55, nb, 0.85);
    ctx.fillStyle = lit.c(DARKWOOD);
    ctx.fillRect(bx - nb / 2 + 0.4, 6.1, 0.12, 0.45);
    ctx.fillRect(bx + nb / 2 - 0.52, 6.1, 0.12, 0.45);
    worldText(s, name.toUpperCase(), bx, 6.98, 0.52, lit.c(INK), { family: 'rye' });
    // Lamp posts along the platform.
    for (let lx = p0 + 6; lx < p1; lx += 15) {
      ctx.fillStyle = lit.c(IRON);
      ctx.fillRect(lx - 0.05, 1.0, 0.1, 2.2);
      ctx.fillRect(lx - 0.18, 3.1, 0.36, 0.5);
      ctx.fillStyle = s.night ? '#FFE0A0' : lit.c('#D8D0B8');
      ctx.fillRect(lx - 0.12, 3.18, 0.24, 0.32);
    }
    // Baggage cart and crates.
    ctx.fillStyle = lit.c(WOOD);
    ctx.fillRect(p0 + 3, 1.25, 2.0, 0.2);
    ctx.fillRect(p0 + 3.2, 1.45, 0.8, 0.6);
    ctx.fillRect(p1 - 5, 1.07, 0.9, 0.7);
    if (column) this.waterColumn(s, x - 23);
  }

  private waterColumn(s: Scene, x: number): void {
    const { ctx } = s;
    const lit = s.lit;
    ctx.fillStyle = lit.c(IRON);
    ctx.fillRect(x - 0.2, 0.3, 0.4, 3.6);
    ctx.fillRect(x - 0.35, 0.3, 0.7, 0.3);
    ctx.fillRect(x - 1.4, 3.7, 1.6, 0.2);
    ctx.fillStyle = lit.c(BRASS);
    ctx.fillRect(x - 0.25, 3.9, 0.5, 0.1);
  }

  private waterTower(s: Scene, x: number): void {
    const { ctx } = s;
    const lit = s.lit;
    if (x < s.left - 10 || x > s.right + 10) return;
    const t0 = x - 1.4;
    const t1 = x + 3.2;
    // Legs and bracing.
    ctx.strokeStyle = lit.c(DARKWOOD);
    ctx.lineWidth = 0.22;
    ctx.beginPath();
    ctx.moveTo(t0 + 0.2, 6.0);
    ctx.lineTo(t0 - 0.2, 0.5);
    ctx.moveTo(t1 - 0.2, 6.0);
    ctx.lineTo(t1 + 0.2, 0.5);
    ctx.moveTo((t0 + t1) / 2, 6.0);
    ctx.lineTo((t0 + t1) / 2, 0.6);
    ctx.stroke();
    ctx.lineWidth = 0.08;
    ctx.beginPath();
    ctx.moveTo(t0, 1.6);
    ctx.lineTo(t1, 4.6);
    ctx.moveTo(t1, 1.6);
    ctx.lineTo(t0, 4.6);
    ctx.moveTo(t0 - 0.1, 3.2);
    ctx.lineTo(t1 + 0.1, 3.2);
    ctx.stroke();
    // Tank with iron hoops and a conical roof.
    ctx.fillStyle = lit.c('#8A6A48');
    ctx.fillRect(t0 - 0.2, 6.0, t1 - t0 + 0.4, 3.4);
    ctx.strokeStyle = lit.a(INK, 0.3);
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    for (let lx = t0; lx < t1 + 0.2; lx += 0.28) {
      ctx.moveTo(lx, 6.0);
      ctx.lineTo(lx, 9.4);
    }
    ctx.stroke();
    ctx.fillStyle = lit.c(IRON);
    for (const hy of [6.35, 7.2, 8.1, 9.0]) ctx.fillRect(t0 - 0.24, hy, t1 - t0 + 0.48, 0.07);
    ctx.fillStyle = lit.c('#5E3A2A');
    ctx.beginPath();
    ctx.moveTo(t0 - 0.5, 9.4);
    ctx.lineTo((t0 + t1) / 2, 10.5);
    ctx.lineTo(t1 + 0.5, 9.4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(t0 - 0.2, 6.0, t1 - t0 + 0.4, 3.4);
  }

  private spout(s: Scene, x: number, down: boolean, filling: boolean): void {
    const { ctx } = s;
    const lit = s.lit;
    if (x < s.left - 6 || x > s.right + 6) return;
    const px = x + 0.1;
    const py = 6.1;
    // Down: hanging to just above the tender's hatch; up: raised along the tank.
    const ex = down ? x : px + 1.1;
    const ey = down ? 3.1 : py + 2.9;
    ctx.lineCap = 'round';
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.34;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.strokeStyle = lit.c('#5A5048');
    ctx.lineWidth = 0.26;
    ctx.stroke();
    // Canvas sock at the end.
    ctx.fillStyle = lit.c('#B8A07A');
    ctx.beginPath();
    if (down) ctx.rect(ex - 0.16, ey - 0.3, 0.32, 0.4);
    else ctx.arc(ex, ey, 0.17, 0, TAU);
    ctx.fill();
    // Pull chain.
    ctx.strokeStyle = lit.c('#1E1C1C');
    ctx.lineWidth = 0.03;
    ctx.beginPath();
    ctx.moveTo((px + ex) / 2, (py + ey) / 2);
    ctx.lineTo((px + ex) / 2 - 0.2, down ? 3.6 : 4.8);
    ctx.stroke();
    ctx.lineCap = 'butt';
    if (filling) {
      // Water pouring into the hatch.
      ctx.fillStyle = 'rgba(170,205,235,0.75)';
      for (let i = 0; i < 6; i++) {
        const ph = (s.t * 3 + i / 6) % 1;
        ctx.fillRect(ex - 0.1 + 0.03 * Math.sin(i * 2.1 + s.t * 20), ey - 0.3 - ph * 0.25, 0.2, 0.1);
      }
    }
  }

  private signal(s: Scene, x: number, facing: 'toward' | 'away', heads: 1 | 2, aspect: Aspect): void {
    const { ctx } = s;
    if (x < s.left - 6 || x > s.right + 6) return;
    const lit = s.lit;
    const top = heads === 2 ? 7.2 : 6.9;
    // Mast with a ladder, finial and a base.
    ctx.fillStyle = lit.c('#D8D0C0');
    ctx.fillRect(x - 0.13, 0.35, 0.26, top - 0.35);
    ctx.fillStyle = lit.c(IRON);
    ctx.fillRect(x - 0.13, 0.35, 0.26, 0.9);
    ctx.fillRect(x - 0.2, top, 0.4, 0.1);
    ctx.beginPath();
    ctx.moveTo(x - 0.12, top + 0.1);
    ctx.lineTo(x, top + 0.45);
    ctx.lineTo(x + 0.12, top + 0.1);
    ctx.fill();
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.03;
    ctx.strokeRect(x - 0.13, 0.35, 0.26, top - 0.35);
    ctx.beginPath();
    ctx.moveTo(x + 0.2, 0.6);
    ctx.lineTo(x + 0.2, top - 0.6);
    ctx.moveTo(x + 0.4, 0.6);
    ctx.lineTo(x + 0.4, top - 0.6);
    for (let y = 0.9; y < top - 0.6; y += 0.35) {
      ctx.moveTo(x + 0.2, y);
      ctx.lineTo(x + 0.4, y);
    }
    ctx.stroke();
    const looks = signalHeads(aspect, heads);
    const toward = facing === 'toward';
    for (let h = 0; h < looks.length; h++) {
      const y = signalLampY(h);
      const hd = looks[h];
      // Arm: toward the train (−x) when facing it; the other way when seen from behind.
      if (!s.night) {
        const a = (hd.arm * Math.PI) / 180;
        const dir = toward ? -1 : 1;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(dir === -1 ? -a : a);
        ctx.scale(dir, 1);
        ctx.fillStyle = lit.c(toward ? '#C8372A' : '#EDE6D6');
        ctx.beginPath();
        ctx.moveTo(0.1, -0.13);
        ctx.lineTo(1.75, -0.16);
        ctx.lineTo(1.75, 0.16);
        ctx.lineTo(0.1, 0.13);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = lit.c(INK);
        ctx.lineWidth = 0.035;
        ctx.stroke();
        ctx.fillStyle = lit.c(toward ? '#F4ECD8' : '#1E1C1C');
        ctx.fillRect(1.3, -0.15, 0.2, 0.3);
        ctx.restore();
      }
      // Lamp case on the mast; its lens shows the aspect colour only from the front.
      ctx.fillStyle = lit.c('#1A1818');
      ctx.beginPath();
      ctx.arc(x + 0.42, y, 0.24, 0, TAU);
      ctx.fill();
      if (toward) {
        ctx.fillStyle = LAMP[hd.lamp];
        ctx.beginPath();
        ctx.arc(x + 0.42, y, 0.16, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.arc(x + 0.38, y + 0.05, 0.05, 0, TAU);
        ctx.fill();
        if (s.lampLetters) {
          worldText(s, lampLetter(hd.lamp), x + 0.95, y, 0.42, '#FFFFFF', { stroke: 'rgba(20,16,12,0.9)', family: 'sans' });
        }
      } else {
        ctx.fillStyle = lit.c('#3A3634');
        ctx.beginPath();
        ctx.arc(x + 0.42, y, 0.08, 0, TAU);
        ctx.fill();
      }
    }
  }

  private lowBridgeBack(s: Scene, x: number): void {
    const { ctx } = s;
    const lit = s.lit;
    for (const tx of [x - TELLTALE_DIST, x + TELLTALE_DIST]) {
      if (tx < s.left - 4 || tx > s.right + 4) continue;
      // Telltale gantry: a post on the far side with an arm over the track.
      ctx.fillStyle = lit.c(DARKWOOD);
      ctx.fillRect(tx - 0.12, 0.3, 0.24, 6.7);
      ctx.fillRect(tx - 0.9, 6.55, 1.8, 0.16);
      ctx.strokeStyle = lit.c(DARKWOOD);
      ctx.lineWidth = 0.08;
      ctx.beginPath();
      ctx.moveTo(tx, 5.9);
      ctx.lineTo(tx - 0.7, 6.55);
      ctx.moveTo(tx, 5.9);
      ctx.lineTo(tx + 0.7, 6.55);
      ctx.stroke();
    }
    if (x < s.left - 6 || x > s.right + 6) return;
    // The far bent of the overpass.
    ctx.fillStyle = lit.c(DARKWOOD);
    ctx.fillRect(x - 1.45, 0.4, 0.3, LOW_BRIDGE_Y - 0.4);
    ctx.fillRect(x + 1.15, 0.4, 0.3, LOW_BRIDGE_Y - 0.4);
    ctx.strokeStyle = lit.c(DARKWOOD);
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.moveTo(x - 1.3, 1.0);
    ctx.lineTo(x + 1.3, LOW_BRIDGE_Y - 0.5);
    ctx.moveTo(x + 1.3, 1.0);
    ctx.lineTo(x - 1.3, LOW_BRIDGE_Y - 0.5);
    ctx.stroke();
  }

  private lowBridgeFront(s: Scene, x: number): void {
    const { ctx } = s;
    const lit = s.lit;
    for (const tx of [x - TELLTALE_DIST, x + TELLTALE_DIST]) {
      if (tx < s.left - 4 || tx > s.right + 4) continue;
      // Cords hang to just above a crouching figure's head, flicking in the wind.
      ctx.strokeStyle = lit.c('#3A2E26');
      ctx.lineWidth = 0.035;
      ctx.beginPath();
      for (let i = -3; i <= 3; i++) {
        const cx = tx + i * 0.26;
        const sway = (0.15 + 0.35 * s.wind) * Math.sin(s.t * 7 + i * 1.7);
        ctx.moveTo(cx, 6.55);
        ctx.quadraticCurveTo(cx - 0.05, 6.0, cx - 0.2 * s.wind - sway * 0.3, LOW_BRIDGE_Y - 0.05);
      }
      ctx.stroke();
    }
    if (x < s.left - 6 || x > s.right + 6) return;
    // Deck girder with bolts, the road's railing above.
    ctx.fillStyle = lit.c('#5A4030');
    ctx.fillRect(x - 1.7, LOW_BRIDGE_Y, 3.4, 1.05);
    ctx.fillStyle = lit.c('#3A2A20');
    ctx.fillRect(x - 1.7, LOW_BRIDGE_Y, 3.4, 0.16);
    ctx.fillStyle = lit.c(IRON);
    for (let bx = x - 1.45; bx < x + 1.6; bx += 0.5) {
      ctx.beginPath();
      ctx.arc(bx, LOW_BRIDGE_Y + 0.55, 0.05, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = lit.c(WOOD);
    ctx.fillRect(x - 1.7, LOW_BRIDGE_Y + 1.05, 3.4, 0.14);
    ctx.fillRect(x - 1.65, LOW_BRIDGE_Y + 1.19, 0.14, 0.85);
    ctx.fillRect(x + 1.51, LOW_BRIDGE_Y + 1.19, 0.14, 0.85);
    ctx.fillRect(x - 1.7, LOW_BRIDGE_Y + 1.9, 3.4, 0.12);
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.05;
    ctx.strokeRect(x - 1.7, LOW_BRIDGE_Y, 3.4, 1.05);
    // Hazard stripes on the beam's face.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 1.7, LOW_BRIDGE_Y + 0.16, 3.4, 0.28);
    ctx.clip();
    ctx.fillStyle = lit.c('#E8DCC0');
    for (let bx = x - 2; bx < x + 2; bx += 0.5) {
      ctx.beginPath();
      ctx.moveTo(bx, LOW_BRIDGE_Y + 0.16);
      ctx.lineTo(bx + 0.25, LOW_BRIDGE_Y + 0.16);
      ctx.lineTo(bx + 0.53, LOW_BRIDGE_Y + 0.44);
      ctx.lineTo(bx + 0.28, LOW_BRIDGE_Y + 0.44);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private trestle(s: Scene, x0: number, x1: number, burning: boolean): void {
    const { ctx } = s;
    const lit = s.lit;
    if (x1 < s.left - 5 || x0 > s.right + 5) return;
    const bottom = BALLAST_Y - GORGE_BOTTOM_DROP;
    const a = Math.max(x0, s.left - 3);
    const b = Math.min(x1, s.right + 3);
    // Bents every 4.5 m (world-fixed).
    const pitch = 4.5;
    const n0 = Math.ceil((a - x0) / pitch);
    const n1 = Math.floor((b - x0) / pitch);
    ctx.strokeStyle = lit.c(burning ? '#3A2418' : '#5A4030');
    ctx.lineWidth = 0.24;
    ctx.beginPath();
    for (let n = n0; n <= n1; n++) {
      const bx = x0 + n * pitch;
      ctx.moveTo(bx - 0.35, -0.8);
      ctx.lineTo(bx - 0.7, bottom);
      ctx.moveTo(bx + 0.35, -0.8);
      ctx.lineTo(bx + 0.7, bottom);
    }
    ctx.stroke();
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    for (let n = n0 - 1; n <= n1; n++) {
      const bx = x0 + n * pitch;
      const nx = bx + pitch;
      for (let y = -0.9; y > bottom; y -= 2.2) {
        ctx.moveTo(Math.max(x0, bx), y);
        ctx.lineTo(Math.min(x1, nx), y - 2.2);
        ctx.moveTo(Math.min(x1, nx), y);
        ctx.lineTo(Math.max(x0, bx), y - 2.2);
        ctx.moveTo(Math.max(x0, bx), y - 2.2);
        ctx.lineTo(Math.min(x1, nx), y - 2.2);
      }
    }
    ctx.stroke();
    // Deck: stringers and close-set bridge ties, guard timber.
    ctx.fillStyle = lit.c(burning ? '#3A2418' : '#4A3426');
    ctx.fillRect(a, -0.9, b - a, 0.55);
    ctx.fillStyle = lit.c('#2E2018');
    ctx.beginPath();
    for (let x = Math.floor((a + s.odo) / 0.45) * 0.45 - s.odo; x < b; x += 0.45) ctx.rect(x - 0.1, -0.34, 0.2, 0.2);
    ctx.fill();
    ctx.fillStyle = lit.c('#5A4030');
    ctx.fillRect(a, -0.4, b - a, 0.08);
    if (burning) this.flames(s, a, b, x0);
  }

  /** Flames licking up the trestle's timbers and deck. */
  private flames(s: Scene, a: number, b: number, x0: number): void {
    const { ctx } = s;
    ctx.globalCompositeOperation = 'lighter';
    for (let x = Math.floor((a - x0) / 1.3) * 1.3 + x0; x < b; x += 1.3) {
      const n = Math.round((x - x0) / 1.3);
      const h = 0.6 + 1.6 * hash01(n, 5) + 0.5 * Math.sin(s.t * (6 + hash01(n, 6) * 5) + n);
      const w = 0.45 + 0.35 * hash01(n, 7);
      const y = -0.9 - 1.8 * hash01(n, 8);
      const sway = 0.25 * Math.sin(s.t * 4 + n * 1.3);
      ctx.fillStyle = 'rgba(255,120,30,0.55)';
      ctx.beginPath();
      ctx.moveTo(x - w, y);
      ctx.quadraticCurveTo(x - w * 0.6, y + h * 0.6, x + sway, y + h);
      ctx.quadraticCurveTo(x + w * 0.6, y + h * 0.6, x + w, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,210,90,0.55)';
      ctx.beginPath();
      ctx.moveTo(x - w * 0.5, y);
      ctx.quadraticCurveTo(x - w * 0.3, y + h * 0.4, x + sway * 0.6, y + h * 0.65);
      ctx.quadraticCurveTo(x + w * 0.3, y + h * 0.4, x + w * 0.5, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private divergingTrack(s: Scene, x: number, facing: boolean): void {
    const { ctx } = s;
    const lit = s.lit;
    const dir = facing ? 1 : -1;
    const len = 45;
    if (Math.max(x, x + dir * len) < s.left - 2 || Math.min(x, x + dir * len) > s.right + 2) return;
    // The other leg curves away into the distance: up the screen, fading.
    const steps = 18;
    ctx.lineWidth = 0.12;
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps;
      const t1 = (i + 1) / steps;
      const xa = x + dir * len * t0;
      const xb = x + dir * len * t1;
      const ya = 1.4 * t0 * t0 - 0.05;
      const yb = 1.4 * t1 * t1 - 0.05;
      ctx.globalAlpha = 1 - t0 * 0.8;
      ctx.strokeStyle = lit.c('#4A4440');
      ctx.beginPath();
      ctx.moveTo(xa, ya);
      ctx.lineTo(xb, yb);
      ctx.moveTo(xa, ya + 0.35 * t0);
      ctx.lineTo(xb, yb + 0.35 * t1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ---- Tunnels -----------------------------------------------------------------------------------

  private tunnelBack(s: Scene, x0: number, x1: number): void {
    const { ctx } = s;
    const lit = s.lit;
    if (x1 < s.left - 40 || x0 > s.right + 40) return;
    // The mountain's flanks behind the portals, with strata.
    const a0 = Math.max(x0 - 32, s.left - 2);
    const b0 = Math.min(x1 + 32, s.right + 2);
    if (b0 > a0) {
      const hill = new Path2D();
      hill.moveTo(a0, HORIZON_Y - 0.3);
      for (let x = a0; x <= b0 + 1.2; x += 1.2) hill.lineTo(Math.min(x, b0), mountainHeight(Math.min(x, b0), x0, x1));
      hill.lineTo(b0, HORIZON_Y - 0.3);
      hill.closePath();
      ctx.fillStyle = lit.c('#8A5A40');
      ctx.fill(hill);
      ctx.save();
      ctx.clip(hill);
      this.strata(ctx, lit, a0, b0, 3.2, 22, '#6E4430');
      ctx.restore();
    }
    // The cavity: dark rock with timber sets, from the track bed to the ceiling.
    const a = Math.max(x0, s.left - 2);
    const b = Math.min(x1, s.right + 2);
    if (b <= a) return;
    const dark = s.litTunnel;
    ctx.fillStyle = dark.c('#2A221C');
    ctx.fillRect(a, BALLAST_Y - 0.2, b - a, TUNNEL_CEILING - BALLAST_Y + 0.2);
    ctx.fillStyle = dark.c('#4A3A2E');
    for (let x = Math.ceil((a - x0) / 4) * 4 + x0; x < b; x += 4) {
      ctx.fillRect(x - 0.15, 0.2, 0.3, TUNNEL_CEILING - 0.2);
      ctx.fillRect(x - 0.9, TUNNEL_CEILING - 0.35, 1.8, 0.3);
    }
  }

  /** Cracks down the rock face, placed along the track so they scroll with it. */
  private fissures(ctx: CanvasRenderingContext2D, lit: Lit, a: number, b: number, x0: number): void {
    ctx.strokeStyle = lit.a('#2A160E', 0.45);
    ctx.lineWidth = 0.07;
    ctx.beginPath();
    const pitch = 5.5;
    for (let n = Math.floor((a - x0) / pitch); x0 + n * pitch < b; n++) {
      const x = x0 + n * pitch + hash01(n, 61) * 3;
      let y = TUNNEL_CEILING + 1 + hash01(n, 62) * 3;
      ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) {
        y += 0.6 + hash01(n * 5 + k, 63) * 0.9;
        ctx.lineTo(x + (hash01(n * 5 + k, 64) - 0.5) * 0.9, y);
      }
    }
    ctx.stroke();
  }

  /** Rock strata: pale and dark bands, meant to be clipped to a rock shape. */
  private strata(ctx: CanvasRenderingContext2D, lit: Lit, a: number, b: number, y0: number, y1: number, dark: string): void {
    ctx.fillStyle = lit.a(dark, 0.45);
    for (let y = y0; y < y1; y += 1.7) ctx.fillRect(a, y, b - a, 0.28 + 0.12 * Math.sin(y * 3.1));
    ctx.fillStyle = lit.a('#C89070', 0.25);
    for (let y = y0 + 0.8; y < y1; y += 2.9) ctx.fillRect(a, y, b - a, 0.16);
  }

  private tunnelFront(s: Scene, x0: number, x1: number, name: string, cut: number): void {
    const { ctx } = s;
    const lit = s.lit;
    if (x1 < s.left - 40 || x0 > s.right + 40) return;
    const bottom = FLOOR_Y;
    const a = Math.max(x0 - 2, s.left - 2);
    const b = Math.min(x1 + 2, s.right + 2);
    const ia = Math.max(x0, s.left - 2);
    const ib = Math.min(x1, s.right + 2);
    if (b > a) {
      // Rock above the ceiling, over the whole tunnel.
      const rock = new Path2D();
      rock.moveTo(a, TUNNEL_CEILING);
      for (let x = a; x <= b + 1; x += 1.2) rock.lineTo(Math.min(x, b), Math.max(TUNNEL_CEILING + 1.5, mountainHeight(Math.min(x, b), x0, x1)));
      rock.lineTo(b, TUNNEL_CEILING);
      rock.closePath();
      ctx.fillStyle = lit.c('#7A4A34');
      ctx.fill(rock);
      ctx.save();
      ctx.clip(rock);
      this.strata(ctx, lit, a, b, TUNNEL_CEILING + 0.6, 24, '#4A2A1E');
      // Weight over the tunnel: darker toward the ceiling, and a few fissures.
      const grad = ctx.createLinearGradient(0, TUNNEL_CEILING, 0, TUNNEL_CEILING + 4);
      grad.addColorStop(0, lit.a('#1E120C', 0.55));
      grad.addColorStop(1, lit.a('#1E120C', 0));
      ctx.fillStyle = grad;
      ctx.fillRect(a, TUNNEL_CEILING, b - a, 4);
      this.fissures(ctx, lit, a, b, x0);
      ctx.restore();
      ctx.fillStyle = lit.c('#3A241A');
      ctx.fillRect(a, TUNNEL_CEILING - 0.05, b - a, 0.3);
    }
    if (ib > ia) {
      // Inside, the track itself is in the dark.
      ctx.fillStyle = 'rgba(8,6,5,0.72)';
      ctx.fillRect(ia, BALLAST_Y - 0.15, ib - ia, -BALLAST_Y + 0.17);
      // Below the track bed the section cuts through solid rock.
      ctx.save();
      ctx.beginPath();
      ctx.rect(ia, bottom, ib - ia, BALLAST_Y - 0.15 - bottom);
      ctx.clip();
      ctx.fillStyle = lit.c('#6E4430');
      ctx.fillRect(ia, bottom, ib - ia, BALLAST_Y - 0.15 - bottom);
      ctx.strokeStyle = lit.a('#3A2016', 0.5);
      ctx.lineWidth = 0.06;
      ctx.beginPath();
      for (let x = Math.floor(ia / 0.8) * 0.8; x < ib + 2; x += 0.8) {
        ctx.moveTo(x, BALLAST_Y - 0.15);
        ctx.lineTo(x - 1.4, bottom);
      }
      ctx.stroke();
      ctx.restore();
      // The near face, cut away while the train is inside (so the Rider can see into it).
      if (cut < 0.99) {
        ctx.globalAlpha = 1 - cut;
        const face = new Path2D();
        face.rect(ia, BALLAST_Y - 0.2, ib - ia, TUNNEL_CEILING - BALLAST_Y + 0.25);
        ctx.fillStyle = lit.c('#8A5A40');
        ctx.fill(face);
        ctx.save();
        ctx.clip(face);
        this.strata(ctx, lit, ia, ib, BALLAST_Y, TUNNEL_CEILING, '#5E3A2A');
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
    // Portals: masonry facing above the ceiling, and the near jamb beside the train below it.
    for (const px of [x0, x1]) {
      if (px < s.left - 3 || px > s.right + 3) continue;
      const out = px === x0 ? -1 : 1;
      const fx = px + (out < 0 ? -1.1 : -0.2);
      const jx = px + (out < 0 ? -0.55 : -0.05);
      ctx.fillStyle = lit.c(STONE);
      ctx.fillRect(fx, TUNNEL_CEILING, 1.3, 3.2);
      ctx.fillRect(jx, BALLAST_Y - 0.15, 0.6, TUNNEL_CEILING - BALLAST_Y + 0.15);
      ctx.strokeStyle = lit.a(INK, 0.45);
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      for (let y = BALLAST_Y + 0.3; y < TUNNEL_CEILING; y += 0.55) {
        ctx.moveTo(jx, y);
        ctx.lineTo(jx + 0.6, y);
      }
      for (let y = TUNNEL_CEILING + 0.5; y < TUNNEL_CEILING + 3.2; y += 0.55) {
        ctx.moveTo(fx, y);
        ctx.lineTo(fx + 1.3, y);
      }
      ctx.stroke();
      ctx.strokeStyle = lit.c(INK);
      ctx.lineWidth = 0.05;
      ctx.strokeRect(jx, BALLAST_Y - 0.15, 0.6, TUNNEL_CEILING - BALLAST_Y + 0.15);
      ctx.strokeRect(fx, TUNNEL_CEILING, 1.3, 3.2);
      // Keystone at the crown and a cornice.
      ctx.fillStyle = lit.c('#B8A48C');
      ctx.fillRect(px + (out < 0 ? -0.75 : -0.15), TUNNEL_CEILING - 0.1, 0.9, 0.7);
      ctx.fillRect(px + (out < 0 ? -1.3 : -0.3), TUNNEL_CEILING + 3.1, 1.6, 0.3);
    }
    // Name board on the rock over the entrance portal.
    if (x0 > s.left - 8 && x0 < s.right + 8) {
      const nb = Math.max(4, 0.34 * name.length + 1);
      const cx = x0 + nb / 2 - 0.9;
      ctx.fillStyle = lit.c('#3A2A20');
      ctx.fillRect(cx - nb / 2, TUNNEL_CEILING + 1.35, nb, 0.85);
      ctx.strokeStyle = lit.c(BRASS);
      ctx.lineWidth = 0.05;
      ctx.strokeRect(cx - nb / 2 + 0.08, TUNNEL_CEILING + 1.43, nb - 0.16, 0.69);
      worldText(s, name.toUpperCase(), cx, TUNNEL_CEILING + 1.78, 0.42, lit.c('#EFE6D2'), { family: 'rye' });
    }
  }
}

// ---- Helpers ----------------------------------------------------------------------------------------

export function signalLampY(head: number): number {
  return head === 0 ? 6.6 : 4.8;
}

function glow(ctx: CanvasRenderingContext2D, rgb: string, x: number, y: number, r: number, a: number): void {
  const g = glowSprite(rgb);
  if (!g || a <= 0.01) return;
  ctx.globalAlpha = Math.min(1, a);
  ctx.drawImage(g, x - r, y - r, 2 * r, 2 * r);
  ctx.globalAlpha = 1;
}

/** A lamp's beam along the track (additive): a long soft wedge. */
export function beam(ctx: CanvasRenderingContext2D, x: number, y: number, dir: 1 | -1, len: number, a: number): void {
  const grad = ctx.createLinearGradient(x, y, x + dir * len, y);
  grad.addColorStop(0, `rgba(255,236,190,${(0.55 * a).toFixed(3)})`);
  grad.addColorStop(0.3, `rgba(255,230,180,${(0.25 * a).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(255,230,180,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.2);
  ctx.lineTo(x + dir * len, y + 2.2);
  ctx.lineTo(x + dir * len, y - 4.4);
  ctx.lineTo(x, y - 0.3);
  ctx.closePath();
  ctx.fill();
}

function mountainHeight(x: number, x0: number, x1: number): number {
  const n = 1.6 * noise1(x / 6, 17) + 0.8 * noise1(x / 2.1, 18);
  if (x < x0) {
    const d = x0 - x;
    return HORIZON_Y + Math.max(0, (9.5 - HORIZON_Y) * Math.pow(Math.max(0, 1 - d / 30), 1.4)) + n * (1 - d / 32);
  }
  if (x > x1) {
    const d = x - x1;
    return HORIZON_Y + Math.max(0, (9.5 - HORIZON_Y) * Math.pow(Math.max(0, 1 - d / 30), 1.4)) + n * (1 - d / 32);
  }
  const inside = Math.min(x - x0, x1 - x);
  return 9.5 + Math.min(9, inside * 0.3) + n;
}

/** Whether our path takes a junction as a facing move (the other leg diverges ahead, +x). */
function junctionFacing(items: readonly TracksideItem[], x: number, j: JunctionDef | undefined): boolean {
  if (!j) return true;
  for (const it of items) {
    if (it.kind === 'terrain' && Math.abs(it.x0 - x) < 0.01) return it.edge !== j.trunk;
  }
  return true;
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

function milepost(s: Scene, x: number, mile: number): void {
  const { ctx } = s;
  if (x < s.left - 2 || x > s.right + 2) return;
  const lit = s.lit;
  const y0 = NEAR_Y;
  ctx.fillStyle = lit.c('#EDE6D6');
  ctx.fillRect(x - 0.09, y0, 0.18, 1.5);
  ctx.fillRect(x - 0.34, y0 + 1.05, 0.68, 0.5);
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = 0.03;
  ctx.strokeRect(x - 0.34, y0 + 1.05, 0.68, 0.5);
  worldText(s, String(mile), x, y0 + 1.3, 0.36, lit.c(INK), { family: 'sans' });
}

function speedBoard(s: Scene, x: number, limit: number): void {
  const { ctx } = s;
  if (x < s.left - 2 || x > s.right + 2) return;
  const lit = s.lit;
  const mph = Math.round(limit * MPH);
  const y0 = NEAR_Y;
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x - 0.06, y0, 0.12, 1.7);
  ctx.fillStyle = lit.c('#F2B632');
  ctx.beginPath();
  ctx.moveTo(x, y0 + 2.35);
  ctx.lineTo(x + 0.55, y0 + 1.8);
  ctx.lineTo(x, y0 + 1.25);
  ctx.lineTo(x - 0.55, y0 + 1.8);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = 0.04;
  ctx.stroke();
  worldText(s, String(mph), x, y0 + 1.8, 0.38, lit.c(INK), { family: 'sans' });
}

function switchStand(s: Scene, x: number, state: 'normal' | 'reverse'): void {
  const { ctx } = s;
  if (x < s.left - 2 || x > s.right + 2) return;
  const lit = s.lit;
  const y0 = BALLAST_Y - 0.2;
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x - 0.06, y0, 0.12, 1.9);
  ctx.fillRect(x - 0.25, y0, 0.5, 0.18);
  // Target: a green disc when normal, a yellow blade turned edge-on beside it when reversed.
  if (state === 'normal') {
    ctx.fillStyle = lit.c('#4FA85C');
    ctx.beginPath();
    ctx.arc(x, y0 + 1.55, 0.3, 0, TAU);
    ctx.fill();
  } else {
    ctx.fillStyle = lit.c('#E0A22A');
    ctx.fillRect(x - 0.34, y0 + 1.3, 0.68, 0.46);
  }
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = 0.035;
  ctx.stroke();
  ctx.fillStyle = lit.c('#1A1818');
  ctx.fillRect(x - 0.1, y0 + 1.95, 0.2, 0.2);
  ctx.fillStyle = state === 'normal' ? LAMP.green : LAMP.yellow;
  ctx.fillRect(x - 0.06, y0 + 1.99, 0.12, 0.12);
}

function rocksPile(ctx: CanvasRenderingContext2D, lit: Lit, x: number, seed: number): void {
  const n = 9;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const h = hash01(seed + i, 3);
      const r = 0.35 + 0.55 * hash01(seed + i, 4);
      const ox = (hash01(seed + i, 5) - 0.5) * 4.2;
      const back = hash01(seed + i, 6) > 0.5;
      if ((pass === 0) !== back) continue;
      const oy = (back ? 0.35 : -0.15) + (1 - Math.abs(ox) / 2.2) * 0.8 * hash01(seed + i, 7);
      ctx.fillStyle = lit.c(h < 0.5 ? '#8A6A56' : '#A07A62');
      ctx.beginPath();
      ctx.ellipse(x + ox, oy + r * 0.7, r * 1.15, r * 0.8, h * 0.8, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = lit.c(INK);
      ctx.lineWidth = 0.04;
      ctx.stroke();
      ctx.fillStyle = lit.a('#F0E0C8', 0.25);
      ctx.beginPath();
      ctx.ellipse(x + ox - r * 0.3, oy + r * 1.05, r * 0.45, r * 0.22, 0, 0, TAU);
      ctx.fill();
    }
  }
}

function barricade(s: Scene, lit: Lit, x: number, seed: number, smashed: boolean): void {
  const { ctx } = s;
  ctx.lineCap = 'round';
  if (smashed) {
    ctx.strokeStyle = lit.c('#6B4A2A');
    ctx.lineWidth = 0.2;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const ox = (hash01(seed + i, 9) - 0.5) * 9;
      const a = hash01(seed + i, 10) * Math.PI;
      const len = 0.8 + hash01(seed + i, 11);
      const y = LANE_Y + 0.5 + hash01(seed + i, 12) * 0.9;
      ctx.moveTo(x + ox - Math.cos(a) * len, y - Math.sin(a) * len * 0.3);
      ctx.lineTo(x + ox + Math.cos(a) * len, y + Math.sin(a) * len * 0.3);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
    return;
  }
  // Sawhorses of rough logs, a crossbeam, barrels and a wagon wheel.
  for (const ox of [-1.4, 1.4]) {
    ctx.strokeStyle = lit.c(INK);
    ctx.lineWidth = 0.26;
    ctx.beginPath();
    ctx.moveTo(x + ox - 0.8, -0.1);
    ctx.lineTo(x + ox + 0.8, 1.9);
    ctx.moveTo(x + ox + 0.8, -0.1);
    ctx.lineTo(x + ox - 0.8, 1.9);
    ctx.stroke();
    ctx.strokeStyle = lit.c('#6B4A2A');
    ctx.lineWidth = 0.18;
    ctx.stroke();
  }
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(x - 2.6, 1.05);
  ctx.lineTo(x + 2.6, 1.15);
  ctx.stroke();
  ctx.strokeStyle = lit.c('#7A5634');
  ctx.lineWidth = 0.22;
  ctx.stroke();
  ctx.lineCap = 'butt';
  ctx.fillStyle = lit.c('#6A4A2E');
  ctx.fillRect(x - 0.4, -0.05, 0.75, 1.0);
  ctx.strokeStyle = lit.c(IRON);
  ctx.lineWidth = 0.05;
  ctx.strokeRect(x - 0.4, 0.15, 0.75, 0.05);
  ctx.strokeRect(x - 0.4, 0.7, 0.75, 0.05);
  ctx.strokeStyle = lit.c('#4A3626');
  ctx.lineWidth = 0.08;
  ctx.beginPath();
  ctx.arc(x + 2.2, 0.75, 0.75, 0, TAU);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    ctx.moveTo(x + 2.2, 0.75);
    ctx.lineTo(x + 2.2 + Math.cos(a) * 0.75, 0.75 + Math.sin(a) * 0.75);
  }
  ctx.stroke();
  // A torn red rag tied on: the gang's mark.
  ctx.fillStyle = lit.c('#C8372A');
  ctx.beginPath();
  ctx.moveTo(x + 1.4, 1.9);
  ctx.lineTo(x + 1.95, 1.75 + 0.06 * Math.sin(s.t * 8));
  ctx.lineTo(x + 1.5, 1.45);
  ctx.closePath();
  ctx.fill();
}

/** Longhorns on the line: idle, scattering away from the track, or pushed aside. */
function cattle(s: Scene, lit: Lit, x: number, seed: number, state: string, ticks: number): void {
  const { ctx } = s;
  const n = 4;
  const scatter = state === 'scattering' ? clamp01(ticks / 240) : 0;
  for (let i = 0; i < n; i++) {
    const hx = x + (i - (n - 1) / 2) * 2.3 + (hash01(seed + i, 21) - 0.5) * 1.2;
    const back = i % 2 === 1;
    const dir: 1 | -1 = hash01(seed + i, 22) < 0.5 ? 1 : -1;
    let cx = hx;
    let cy = back ? 0.35 : -0.25;
    let alpha = 1;
    let trot = 0;
    if (scatter > 0) {
      const e = scatter * scatter;
      cx += dir * 9 * e;
      cy += 3.2 * e;
      alpha = 1 - clamp01((scatter - 0.6) / 0.4);
      trot = 1;
    } else if (state === 'hit') {
      cy += 1.4;
      cx += dir * 3;
    }
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    steer(ctx, lit, cx, cy, dir, s.t + i * 1.7, trot, hash01(seed + i, 23), scatter > 0 ? 1 - scatter * 0.3 : 1);
    ctx.globalAlpha = 1;
  }
}

function steer(ctx: CanvasRenderingContext2D, lit: Lit, x: number, y: number, dir: 1 | -1, t: number, trot: number, r: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(dir * scale, scale);
  const coat = lit.c(r < 0.33 ? '#8E5A34' : r < 0.66 ? '#C9A27A' : '#5A3A28');
  const ink = lit.c(INK);
  ctx.lineCap = 'round';
  // Legs (trotting when scattering).
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.13;
  ctx.beginPath();
  const leg = (lx: number, ph: number): void => {
    const a = trot * 0.45 * Math.sin(t * 9 + ph);
    ctx.moveTo(lx, 0.75);
    ctx.lineTo(lx + Math.sin(a) * 0.72, 0.03);
  };
  leg(-0.75, 0);
  leg(-0.55, Math.PI);
  leg(0.55, Math.PI);
  leg(0.75, 0);
  ctx.stroke();
  // Body.
  ctx.fillStyle = coat;
  ctx.beginPath();
  ctx.ellipse(0, 1.0, 1.05, 0.42, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.04;
  ctx.stroke();
  // Head bobbing, with long horns.
  const bob = 0.06 * Math.sin(t * 1.6) + (trot ? 0.05 * Math.sin(t * 9) : 0);
  const hx = 1.12;
  const hy = 1.05 + bob - (trot ? 0 : 0.18 * (0.5 + 0.5 * Math.sin(t * 0.7)));
  ctx.fillStyle = coat;
  ctx.beginPath();
  ctx.ellipse(hx, hy, 0.3, 0.2, -0.5, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = lit.c('#E8DCC0');
  ctx.lineWidth = 0.05;
  ctx.beginPath();
  ctx.moveTo(hx - 0.1, hy + 0.15);
  ctx.quadraticCurveTo(hx - 0.5, hy + 0.35, hx - 0.75, hy + 0.55);
  ctx.moveTo(hx - 0.02, hy + 0.15);
  ctx.quadraticCurveTo(hx + 0.4, hy + 0.35, hx + 0.6, hy + 0.6);
  ctx.stroke();
  // Tail swish.
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.04;
  ctx.beginPath();
  ctx.moveTo(-1.02, 1.1);
  ctx.quadraticCurveTo(-1.2, 0.8, -1.15 + 0.15 * Math.sin(t * 2.3), 0.45);
  ctx.stroke();
  ctx.restore();
  ctx.lineCap = 'butt';
}

// ---- Other trains ---------------------------------------------------------------------------------

function aiTrain(s: Scene, lit: Lit, t: AiDraw): void {
  const { ctx } = s;
  ctx.save();
  // Draw in a local frame with the leading end at +x.
  if (t.front === 1) ctx.translate(t.x0, 0);
  else {
    ctx.translate(t.x1, 0);
    ctx.scale(-1, 1);
  }
  const len = t.x1 - t.x0;
  const hasLoco = t.ai !== 'runaway';
  const locoLen = hasLoco ? 16 : 0;
  const tenderLen = hasLoco ? 9 : 0;
  const nCars = Math.max(1, t.cars);
  const carLen = Math.max(6, (len - locoLen - tenderLen) / nCars);
  const spin = -t.roll / 0.42;
  let x = 0;
  for (let i = 0; i < nCars; i++) {
    const kind = t.ai === 'express' ? 'coach' : t.ai === 'runaway' ? (i % 2 === 0 ? 'gondola' : 'box') : i === nCars - 1 ? 'caboose' : i % 3 === 1 ? 'tank' : 'box';
    genericCar(ctx, lit, x, x + carLen - 0.6, kind, spin, s.night, i);
    x += carLen;
  }
  if (hasLoco) {
    genericTender(ctx, lit, x, spin);
    genericLoco(ctx, lit, x + tenderLen, -t.roll / 0.8, s.night);
  }
  if (t.ai === 'runaway' && Math.abs(t.v) > 2) {
    // Sparks from dragging brakes.
    ctx.fillStyle = 'rgba(255,200,90,0.9)';
    for (let i = 0; i < 8; i++) {
      const px = (hash01(i + Math.floor(s.t * 30), 3) * len) | 0;
      ctx.fillRect(px, 0.05 + hash01(i, 4) * 0.2, 0.25, 0.05);
    }
  }
  ctx.restore();
}

function genericCar(ctx: CanvasRenderingContext2D, lit: Lit, x0: number, x1: number, kind: 'box' | 'coach' | 'gondola' | 'tank' | 'caboose', spin: number, night: boolean, i: number): void {
  const colours = ['#7A3E2C', '#5E4A3A', '#8E4A33', '#4A4A3E'];
  const body = kind === 'coach' ? '#2E4B3C' : kind === 'caboose' ? '#B5563A' : kind === 'tank' ? '#2B2B2E' : colours[i % colours.length];
  // Wheels.
  for (const wx of [x0 + 1.2, x0 + 2.8, x1 - 2.8, x1 - 1.2]) {
    ctx.fillStyle = lit.c('#1A1818');
    ctx.beginPath();
    ctx.arc(wx, 0.42, 0.42, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = lit.c('#6E6660');
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(wx, 0.42);
    ctx.lineTo(wx + Math.cos(spin) * 0.36, 0.42 + Math.sin(spin) * 0.36);
    ctx.stroke();
  }
  ctx.fillStyle = lit.c('#1E1C1C');
  ctx.fillRect(x0, 0.85, x1 - x0, 0.3);
  ctx.fillStyle = lit.c(body);
  if (kind === 'gondola') {
    ctx.fillRect(x0, 1.15, x1 - x0, 1.3);
    ctx.fillStyle = lit.c('#6E6660');
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, 2.45, (x1 - x0) * 0.42, 0.45, 0, Math.PI, TAU);
    ctx.fill();
  } else if (kind === 'tank') {
    ctx.beginPath();
    ctx.roundRect(x0 + 0.3, 1.2, x1 - x0 - 0.6, 1.9, 0.9);
    ctx.fill();
    ctx.fillRect((x0 + x1) / 2 - 0.4, 3.0, 0.8, 0.35);
  } else {
    ctx.fillRect(x0, 1.15, x1 - x0, 2.85);
    ctx.fillStyle = lit.c('#3E3430');
    ctx.fillRect(x0 - 0.05, 3.95, x1 - x0 + 0.1, 0.2);
    if (kind === 'coach' || kind === 'caboose') {
      for (let wx = x0 + 1; wx < x1 - 1; wx += 1.3) {
        ctx.fillStyle = night ? '#F2C46A' : lit.c('#1A1614');
        ctx.fillRect(wx, 2.3, 0.7, 0.9);
      }
    }
    if (kind === 'caboose') {
      ctx.fillStyle = lit.c(body);
      ctx.fillRect((x0 + x1) / 2 - 1.3, 4.1, 2.6, 0.6);
    }
  }
  ctx.strokeStyle = lit.c(INK);
  ctx.lineWidth = 0.05;
  ctx.strokeRect(x0, 1.15, x1 - x0, kind === 'gondola' ? 1.3 : kind === 'tank' ? 1.9 : 2.85);
}

function genericTender(ctx: CanvasRenderingContext2D, lit: Lit, x0: number, spin: number): void {
  genericCar(ctx, lit, x0 + 0.2, x0 + 8.8, 'box', spin, false, 3);
  ctx.fillStyle = lit.c('#2A2422');
  ctx.fillRect(x0 + 0.2, 1.15, 8.6, 1.6);
  ctx.fillStyle = lit.c('#141212');
  ctx.fillRect(x0 + 2, 2.75, 6.6, 0.25);
}

function genericLoco(ctx: CanvasRenderingContext2D, lit: Lit, x0: number, spin: number, night: boolean): void {
  // Drivers.
  for (const wx of [x0 + 5.5, x0 + 7.75]) {
    ctx.fillStyle = lit.c('#1A1818');
    ctx.beginPath();
    ctx.arc(wx, 0.8, 0.8, 0, TAU);
    ctx.fill();
    ctx.fillStyle = lit.c('#6A2A1E');
    ctx.beginPath();
    ctx.arc(wx, 0.8, 0.66, 0, TAU);
    ctx.fill();
  }
  ctx.strokeStyle = lit.c('#B8B8BE');
  ctx.lineWidth = 0.1;
  ctx.beginPath();
  ctx.moveTo(x0 + 5.5 + Math.cos(spin) * 0.34, 0.8 + Math.sin(spin) * 0.34);
  ctx.lineTo(x0 + 7.75 + Math.cos(spin) * 0.34, 0.8 + Math.sin(spin) * 0.34);
  ctx.stroke();
  for (const wx of [x0 + 11, x0 + 12.85]) {
    ctx.fillStyle = lit.c('#1A1818');
    ctx.beginPath();
    ctx.arc(wx, 0.42, 0.42, 0, TAU);
    ctx.fill();
  }
  // Boiler, smokebox, stack, dome, cab, pilot, headlamp.
  ctx.fillStyle = lit.c('#3A4048');
  ctx.fillRect(x0 + 4.5, 1.7, 9.4, 1.7);
  ctx.fillStyle = lit.c('#1E1E22');
  ctx.fillRect(x0 + 12.4, 1.65, 1.5, 1.8);
  ctx.fillRect(x0 + 12.7, 3.4, 0.5, 0.7);
  ctx.beginPath();
  ctx.moveTo(x0 + 12.3, 4.1);
  ctx.lineTo(x0 + 13.6, 4.1);
  ctx.lineTo(x0 + 13.5, 4.75);
  ctx.lineTo(x0 + 12.4, 4.75);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = lit.c(BRASS);
  ctx.beginPath();
  ctx.ellipse(x0 + 9, 3.45, 0.4, 0.55, 0, Math.PI, TAU);
  ctx.fill();
  ctx.fillStyle = lit.c('#2A2422');
  ctx.fillRect(x0, 1.3, 4.5, 2.6);
  ctx.fillRect(x0 - 0.15, 3.85, 4.8, 0.18);
  ctx.fillStyle = night ? '#F2C46A' : lit.c('#141212');
  ctx.fillRect(x0 + 0.7, 2.4, 2.2, 1.1);
  ctx.fillStyle = lit.c(IRON);
  ctx.fillRect(x0 + 13.3, 3.45, 0.95, 0.65);
  ctx.fillStyle = '#FFF1C8';
  ctx.beginPath();
  ctx.ellipse(x0 + 14.27, 3.78, 0.07, 0.24, 0, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = lit.c('#5A2A1E');
  ctx.lineWidth = 0.07;
  ctx.beginPath();
  for (let i = 0; i <= 4; i++) {
    ctx.moveTo(x0 + 14.0 + i * 0.1, 0.95);
    ctx.lineTo(x0 + 14.2 + i * 0.4, 0.12);
  }
  ctx.stroke();
}
