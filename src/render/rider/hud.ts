// The Rider's HUD (spec §18.2 layer 10): hearts, the weapon and its rounds (a revolver cylinder,
// two shells, a rifle's tube), reload progress, a strip of the whole train at the top (cars, the
// Rider, bandits aboard as red dots, horsemen alongside, the safe's status, HANDS UP on the loco,
// the powder car's hp), the prompt by the Rider, the spyglass (vignette, range in yards,
// crosshair, flags) and the respawn countdown. Screen space, CSS px.
//
// There is no speedometer: the Rider feels speed through the wind and the scenery (spec §2).

import { FLAG_MAX, QUICK_RELOAD_FACTOR, TICK_HZ, WEAPONS } from '../../sim/rules';
import type { GameState, Weapon } from '../../sim/types';
import { PALETTE } from '../palette';
import { font, roundRect, TAU, type Scene } from './scene';
import { CAR_COLOURS, shadeHex } from './train';

const INK = '#2A2118';
const PAPER = '#EFE6D2';
const BRASS = '#C8A15A';
const RED = PALETTE.signalRed;

const WEAPON_NAME: Record<Weapon, string> = { revolver: 'REVOLVER', shotgun: 'COACH GUN', rifle: 'WINCHESTER' };
const YARDS = 1.09361;

export interface HudInput {
  state: GameState;
  prompt: string | null;
  /** Screen position above the Rider's head, or null when not on screen. */
  riderHead: { x: number; y: number } | null;
  /** 0..1 spyglass raised. */
  scope: number;
  /** The view's train-frame range, for the strip's window bracket. */
  viewX0: number;
  viewX1: number;
}

export class Hud {
  /** Eased cylinder rotation (radians). */
  private cyl = 0;
  private lastAmmo = -1;
  private dryT = -Infinity;

  dryFire(now: number): void {
    this.dryT = now;
  }

  draw(s: Scene, h: HudInput): void {
    const { ctx } = s;
    ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (h.scope > 0.01) this.spyglass(s, h);
    this.strip(s, h);
    this.hearts(s, h.state);
    this.weapon(s, h.state);
    if (h.prompt && h.state.rider.mode === 'active') this.prompt(s, h.prompt, h.riderHead);
    if (h.state.rider.mode !== 'active') this.respawn(s, h.state);
  }

  // ---- Hearts ----------------------------------------------------------------------------------

  private hearts(s: Scene, st: GameState): void {
    const { ctx, cam } = s;
    const r = st.rider;
    const size = Math.max(18, Math.min(34, cam.h * 0.036));
    const pad = Math.max(12, cam.h * 0.018);
    for (let i = 0; i < r.maxHearts; i++) {
      const x = pad + i * size * 1.15 + size / 2;
      const y = pad + size / 2;
      const full = i < r.hearts;
      const last = full && r.hearts === 1 && r.mode === 'active';
      const beat = last ? 1 + 0.12 * Math.max(0, Math.sin(s.now * 8)) : 1;
      heartPath(ctx, x, y, size * 0.5 * beat);
      ctx.fillStyle = full ? RED : 'rgba(20,16,12,0.55)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, size * 0.08);
      ctx.strokeStyle = full ? INK : 'rgba(239,230,210,0.55)';
      ctx.stroke();
      if (full) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.ellipse(x - size * 0.16, y - size * 0.14, size * 0.08, size * 0.05, -0.6, 0, TAU);
        ctx.fill();
      }
    }
  }

  // ---- Weapon ----------------------------------------------------------------------------------

  private weapon(s: Scene, st: GameState): void {
    const { ctx, cam } = s;
    const r = st.rider;
    const w = r.weapon;
    const spec = WEAPONS[w];
    const ammo = r.ammo[w];
    const R = Math.max(24, Math.min(52, cam.h * 0.05));
    const pad = Math.max(12, cam.h * 0.018);
    const cx = pad + R + 4;
    const cy = cam.h - pad - R - 4;
    const reloadTotal = spec.reload * (st.upgrades.includes('quickReload') ? QUICK_RELOAD_FACTOR : 1) * TICK_HZ;
    const reloading = r.reloadTicks > 0;
    const prog = reloading ? 1 - r.reloadTicks / Math.max(1, reloadTotal) : 1;
    // Backing plate.
    ctx.fillStyle = 'rgba(20,16,12,0.6)';
    ctx.beginPath();
    roundRect(ctx, pad - 4, cy - R - 10, R * 2 + 18 + Math.max(110, R * 3.2), R * 2 + 20, 10);
    ctx.fill();
    const dry = s.now - this.dryT < 0.25 ? Math.sin((s.now - this.dryT) * 60) * 3 : 0;
    if (w === 'revolver') this.cylinder(s, cx + dry, cy, R, ammo, spec.rounds, reloading ? prog : -1);
    else if (w === 'shotgun') this.shells(s, cx + dry, cy, R, ammo, spec.rounds, reloading ? prog : -1);
    else this.rounds(s, cx + dry, cy, R, ammo, spec.rounds, reloading ? prog : -1);
    // Name, count and the other guns.
    const tx = cx + R + 14;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PAPER;
    ctx.font = font('sans', Math.max(12, R * 0.34));
    ctx.fillText(WEAPON_NAME[w], tx, cy - R * 0.2);
    ctx.font = font('rye', Math.max(16, R * 0.62));
    const shown = reloading ? Math.floor(prog * spec.rounds) : ammo;
    ctx.fillStyle = reloading ? PAPER : ammo === 0 ? RED : BRASS;
    ctx.fillText(`${shown}/${spec.rounds}`, tx, cy + R * 0.45);
    if ((ammo === 0 || reloading) && Math.floor(s.now * 2.5) % 2 === 0) {
      ctx.font = font('sans', Math.max(11, R * 0.28));
      ctx.fillStyle = reloading ? PAPER : RED;
      ctx.fillText(reloading ? 'RELOADING' : 'R: RELOAD', tx, cy + R * 0.95);
    } else if (r.weapons.length > 1) {
      ctx.font = font('sans', Math.max(10, R * 0.24), 400);
      ctx.fillStyle = 'rgba(239,230,210,0.7)';
      let x = tx;
      const order: Weapon[] = ['revolver', 'shotgun', 'rifle'];
      for (let i = 0; i < order.length; i++) {
        if (!r.weapons.includes(order[i])) continue;
        const label = `${i + 1} ${WEAPON_NAME[order[i]].toLowerCase()}`;
        ctx.fillStyle = order[i] === w ? BRASS : 'rgba(239,230,210,0.55)';
        ctx.fillText(label, x, cy + R * 0.95);
        x += ctx.measureText(label).width + 10;
      }
    }
  }

  private cylinder(s: Scene, cx: number, cy: number, R: number, ammo: number, rounds: number, reload: number): void {
    const { ctx } = s;
    // Rotation eases a chamber per shot; spins while reloading.
    if (this.lastAmmo < 0) this.lastAmmo = ammo;
    const fired = rounds - ammo;
    const target = reload >= 0 ? reload * TAU * 1.5 : (-fired * TAU) / rounds;
    this.cyl += (target - this.cyl) * (s.dt > 0 || reload >= 0 ? 0.35 : 1);
    this.lastAmmo = ammo;
    ctx.fillStyle = '#3C3C42';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = this.cyl + (i / 6) * TAU + TAU / 12;
      const px = cx + Math.cos(a) * R;
      const py = cy + Math.sin(a) * R;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.93, 0, TAU);
    ctx.fillStyle = '#4A4A52';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.stroke();
    const loaded = reload >= 0 ? Math.floor(reload * rounds) : ammo;
    for (let i = 0; i < rounds; i++) {
      const a = this.cyl - Math.PI / 2 + (i / rounds) * TAU;
      const px = cx + Math.cos(a) * R * 0.56;
      const py = cy + Math.sin(a) * R * 0.56;
      const full = i < loaded;
      ctx.beginPath();
      ctx.arc(px, py, R * 0.22, 0, TAU);
      ctx.fillStyle = full ? BRASS : '#141414';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = INK;
      ctx.stroke();
      if (full) {
        ctx.beginPath();
        ctx.arc(px, py, R * 0.08, 0, TAU);
        ctx.fillStyle = '#8A6A30';
        ctx.fill();
      }
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.12, 0, TAU);
    ctx.fillStyle = '#2B2B2E';
    ctx.fill();
    if (reload >= 0) this.ring(ctx, cx, cy, R + 6, reload);
  }

  private shells(s: Scene, cx: number, cy: number, R: number, ammo: number, rounds: number, reload: number): void {
    const { ctx } = s;
    const loaded = reload >= 0 ? Math.floor(reload * rounds) : ammo;
    const w = R * 0.62;
    for (let i = 0; i < rounds; i++) {
      const x = cx - w * 0.75 + i * w * 0.95;
      const full = i < loaded;
      ctx.fillStyle = full ? '#B8392A' : 'rgba(20,16,12,0.7)';
      ctx.beginPath();
      roundRect(ctx, x - w * 0.4, cy - R * 0.9, w * 0.8, R * 1.3, 4);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = full ? BRASS : 'rgba(80,70,60,0.6)';
      ctx.fillRect(x - w * 0.42, cy + R * 0.4, w * 0.84, R * 0.45);
    }
    if (reload >= 0) this.ring(ctx, cx, cy, R + 6, reload);
  }

  private rounds(s: Scene, cx: number, cy: number, R: number, ammo: number, rounds: number, reload: number): void {
    const { ctx } = s;
    const loaded = reload >= 0 ? Math.floor(reload * rounds) : ammo;
    const step = (R * 2) / rounds;
    for (let i = 0; i < rounds; i++) {
      const x = cx - R + step * (i + 0.5);
      const full = i < loaded;
      ctx.fillStyle = full ? BRASS : 'rgba(20,16,12,0.7)';
      ctx.beginPath();
      ctx.moveTo(x - step * 0.3, cy + R * 0.7);
      ctx.lineTo(x - step * 0.3, cy - R * 0.3);
      ctx.lineTo(x, cy - R * 0.75);
      ctx.lineTo(x + step * 0.3, cy - R * 0.3);
      ctx.lineTo(x + step * 0.3, cy + R * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (reload >= 0) this.ring(ctx, cx, cy, R + 6, reload);
  }

  private ring(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, p: number): void {
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = BRASS;
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0, Math.min(1, p)));
    ctx.stroke();
  }

  // ---- Train strip -------------------------------------------------------------------------------

  private strip(s: Scene, h: HudInput): void {
    const { ctx, cam } = s;
    const st = h.state;
    const t = st.train;
    const L = t.length;
    const W = Math.min(cam.w * 0.5, 640);
    const H = Math.max(16, Math.min(26, cam.h * 0.026));
    const x0 = (cam.w - W) / 2;
    const y0 = Math.max(12, cam.h * 0.02) + 6;
    const sx = (x: number): number => x0 + (Math.max(-6, Math.min(L + 6, x)) / L) * W;
    // Plate.
    ctx.fillStyle = 'rgba(20,16,12,0.66)';
    ctx.beginPath();
    roundRect(ctx, x0 - 14, y0 - 12, W + 28, H + 28, 9);
    ctx.fill();
    ctx.strokeStyle = 'rgba(200,161,90,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // The rails.
    ctx.fillStyle = 'rgba(239,230,210,0.35)';
    ctx.fillRect(x0 - 8, y0 + H + 3, W + 16, 1.5);
    // Cars.
    for (let i = t.cars.length - 1; i >= 0; i--) {
      const car = t.cars[i];
      const a = sx(car.x0) + 1;
      const b = sx(car.x1) - 1;
      const col = shadeHex(CAR_COLOURS[car.kind], car.kind === 'powder' ? 1 : 1.35);
      ctx.fillStyle = col;
      if (car.kind === 'loco') {
        // Cab at the rear, boiler, stack.
        const cab = a + (b - a) * 0.3;
        ctx.fillRect(a, y0 + H * 0.05, cab - a, H * 0.95);
        ctx.fillRect(cab, y0 + H * 0.35, b - cab - 2, H * 0.65);
        ctx.fillRect(b - (b - a) * 0.22, y0 - H * 0.05, (b - a) * 0.08, H * 0.4);
        ctx.fillStyle = BRASS;
        ctx.fillRect(cab + (b - cab) * 0.35, y0 + H * 0.2, (b - a) * 0.06, H * 0.18);
      } else if (car.kind === 'tender') {
        ctx.fillRect(a, y0 + H * 0.35, b - a, H * 0.65);
      } else {
        ctx.fillRect(a, y0, b - a, H);
        if (car.kind === 'caboose') ctx.fillRect(a + (b - a) / 3, y0 - H * 0.22, (b - a) / 3, H * 0.24);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(a + 0.5, y0 + (car.kind === 'tender' ? H * 0.35 : 0) + 0.5, b - a - 1, H * (car.kind === 'tender' ? 0.65 : 1) - 1);
      if (car.kind === 'express') this.safeIcon(s, (a + b) / 2, y0 + H / 2, H, st, sx);
      if (car.kind === 'powder') {
        const seg = (b - a - 6) / 8;
        for (let k = 0; k < 8; k++) {
          ctx.fillStyle = k < car.hp ? (car.hp <= 3 ? RED : '#B8392A') : 'rgba(20,16,12,0.6)';
          ctx.fillRect(a + 3 + k * seg + 0.5, y0 + H - 6, seg - 1, 4);
        }
        ctx.fillStyle = INK;
        ctx.font = font('sans', H * 0.52);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', (a + b) / 2, y0 + H * 0.4);
      }
    }
    // What the camera shows.
    const va = sx(h.viewX0);
    const vb = sx(h.viewX1);
    if (vb > va + 2) {
      ctx.strokeStyle = 'rgba(239,230,210,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(va, y0 - 5);
      ctx.lineTo(va, y0 + H + 5);
      ctx.moveTo(vb, y0 - 5);
      ctx.lineTo(vb, y0 + H + 5);
      ctx.stroke();
    }
    // Horsemen alongside: red chevrons under the strip (arrows at the ends when beyond).
    for (const hm of st.horsemen) {
      if (hm.mode === 'gone' || hm.mode === 'falling') continue;
      const beyond = hm.x < -6 ? -1 : hm.x > L + 6 ? 1 : 0;
      const x = sx(hm.x);
      const y = y0 + H + 9;
      ctx.fillStyle = hm.boss ? '#FF6A4A' : RED;
      ctx.beginPath();
      if (beyond === 0) {
        ctx.moveTo(x - 4, y + 4);
        ctx.lineTo(x, y - 2);
        ctx.lineTo(x + 4, y + 4);
      } else {
        const ex = beyond < 0 ? x0 - 10 : x0 + W + 10;
        ctx.moveTo(ex + beyond * 5, y + 1);
        ctx.lineTo(ex - beyond * 2, y - 4);
        ctx.lineTo(ex - beyond * 2, y + 6);
      }
      ctx.closePath();
      ctx.fill();
    }
    // Bandits aboard: red dots; roof high, inside and platforms low.
    for (const b of st.bandits) {
      if (b.mode === 'gone' || b.mode === 'falling') continue;
      const x = sx(b.x);
      const high = b.surface === 'roof' || b.surface === 'cabRoof' || b.surface === 'tenderTop' || b.surface === 'cupola' || b.y > 3;
      const y = high ? y0 + H * 0.28 : y0 + H * 0.72;
      ctx.beginPath();
      ctx.arc(x, y, b.boss ? 5.5 : 4, 0, TAU);
      ctx.fillStyle = RED;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = b.boss ? '#1A1210' : 'rgba(20,16,12,0.9)';
      ctx.stroke();
      if (b.hasLoot) {
        ctx.fillStyle = BRASS;
        ctx.font = font('sans', 11);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', x, y - 10);
      }
    }
    // The Rider.
    const r = st.rider;
    if (r.mode === 'active') {
      const x = sx(r.x);
      const high = r.y > 3;
      const y = high ? y0 - 10 : y0 + H + 10;
      // A paper pin with a brass rim: the one light marker on the strip.
      ctx.fillStyle = PAPER;
      ctx.fillRect(x - 1.5, y0 - 2, 3, H + 4);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const d = high ? 1 : -1;
      ctx.moveTo(x, y + 8 * d);
      ctx.lineTo(x - 7, y - 4 * d);
      ctx.lineTo(x + 7, y - 4 * d);
      ctx.closePath();
      ctx.fillStyle = PAPER;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = BRASS;
      ctx.beginPath();
      ctx.arc(x, y - 1 * d, 2.2, 0, TAU);
      ctx.fill();
    }
    // HANDS UP over the loco.
    if (t.heldUp) {
      const loco = t.cars[0];
      const x = (sx(loco.x0) + sx(loco.x1)) / 2;
      const on = Math.floor(s.now * 3) % 2 === 0;
      ctx.font = font('rye', Math.max(12, H * 0.62));
      const label = 'HANDS UP!';
      const tw = ctx.measureText(label).width;
      const bx = Math.min(x0 + W + 10 - tw / 2, x);
      ctx.fillStyle = on ? RED : '#8E2A1E';
      ctx.beginPath();
      roundRect(ctx, bx - tw / 2 - 8, y0 + H + 14, tw + 16, H * 0.95, 6);
      ctx.fill();
      ctx.fillStyle = PAPER;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, y0 + H + 14 + H * 0.5);
    }
  }

  private safeIcon(s: Scene, x: number, y: number, H: number, st: GameState, sx: (x: number) => number): void {
    const { ctx } = s;
    const loot = st.loot;
    const size = H * 0.62;
    ctx.fillStyle = '#26262A';
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeStyle = loot.status === 'cracking' ? RED : BRASS;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
    ctx.beginPath();
    ctx.arc(x, y, size * 0.22, 0, TAU);
    ctx.strokeStyle = BRASS;
    ctx.stroke();
    if (loot.status === 'cracking' || (loot.status === 'safe' && loot.crack > 0)) {
      // Crack progress under the safe.
      const w = H * 2.2;
      ctx.fillStyle = 'rgba(20,16,12,0.8)';
      ctx.fillRect(x - w / 2, y + H * 0.62, w, 4);
      ctx.fillStyle = loot.status === 'cracking' && Math.floor(s.now * 4) % 2 === 0 ? '#FF6A4A' : RED;
      ctx.fillRect(x - w / 2, y + H * 0.62, w * Math.max(0, Math.min(1, loot.crack)), 4);
    } else if (loot.status === 'stolen') {
      ctx.strokeStyle = RED;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x - size * 0.7, y - size * 0.7);
      ctx.lineTo(x + size * 0.7, y + size * 0.7);
      ctx.moveTo(x + size * 0.7, y - size * 0.7);
      ctx.lineTo(x - size * 0.7, y + size * 0.7);
      ctx.stroke();
    } else if (loot.status === 'dropped') {
      const lx = sx(loot.x);
      if (Math.floor(s.now * 3) % 2 === 0) {
        ctx.fillStyle = PALETTE.signalYellow;
        ctx.font = font('rye', H * 0.8);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('$', lx, y - H * 1.05);
      }
    }
  }

  // ---- Prompt ----------------------------------------------------------------------------------

  private prompt(s: Scene, text: string, at: { x: number; y: number } | null): void {
    const { ctx, cam } = s;
    const m = /^\s*([A-Za-z0-9]{1,5}|Shift|Space)\s*:\s*(.+)$/.exec(text);
    const key = m ? m[1] : null;
    const body = m ? m[2] : text;
    const size = Math.max(13, Math.min(20, cam.h * 0.022));
    ctx.font = font('sans', size);
    const tw = ctx.measureText(body).width;
    const kw = key ? Math.max(size * 1.4, ctx.measureText(key).width + size * 0.8) : 0;
    const w = tw + kw + (key ? size * 0.6 : 0) + size * 1.2;
    const h = size * 1.9;
    let x = at ? at.x : cam.w / 2;
    let y = at ? at.y - h / 2 - 8 : cam.h * 0.7;
    x = Math.max(w / 2 + 8, Math.min(cam.w - w / 2 - 8, x));
    y = Math.max(h + 60, Math.min(cam.h - h - 8, y));
    const left = x - w / 2;
    ctx.fillStyle = 'rgba(239,230,210,0.94)';
    ctx.beginPath();
    roundRect(ctx, left, y - h / 2, w, h, h * 0.3);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
    let tx = left + size * 0.6;
    if (key) {
      ctx.fillStyle = INK;
      ctx.beginPath();
      roundRect(ctx, tx, y - size * 0.72, kw, size * 1.44, 4);
      ctx.fill();
      ctx.fillStyle = BRASS;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, tx + kw / 2, y + 1);
      tx += kw + size * 0.6;
    }
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(body, tx, y + 1);
  }

  // ---- Spyglass ----------------------------------------------------------------------------------

  private spyglass(s: Scene, h: HudInput): void {
    const { ctx, cam } = s;
    const k = h.scope;
    const cx = cam.w / 2;
    const cy = cam.h * 0.48;
    const full = Math.hypot(cam.w, cam.h) * 0.6;
    const R = full + (Math.min(cam.w, cam.h) * 0.43 - full) * easeOut(k);
    ctx.fillStyle = `rgba(8,6,5,${(0.97 * Math.min(1, k * 1.5)).toFixed(3)})`;
    ctx.beginPath();
    ctx.rect(0, 0, cam.w, cam.h);
    ctx.arc(cx, cy, R, 0, TAU, true);
    ctx.fill('evenodd');
    // Soft inner edge.
    const grad = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R);
    grad.addColorStop(0, 'rgba(8,6,5,0)');
    grad.addColorStop(1, `rgba(8,6,5,${(0.75 * k).toFixed(3)})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    if (k < 0.6) return;
    const a = Math.min(1, (k - 0.6) / 0.4);
    ctx.globalAlpha = a;
    // Brass rim.
    ctx.lineWidth = Math.max(5, R * 0.03);
    ctx.strokeStyle = BRASS;
    ctx.beginPath();
    ctx.arc(cx, cy, R + ctx.lineWidth / 2, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#7A5A2A';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 1, 0, TAU);
    ctx.stroke();
    // Crosshair with a gap in the middle, and range ticks.
    ctx.strokeStyle = 'rgba(20,16,12,0.7)';
    ctx.lineWidth = 1.5;
    const gap = R * 0.08;
    ctx.beginPath();
    ctx.moveTo(cx - R * 0.92, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + R * 0.92, cy);
    ctx.moveTo(cx, cy - R * 0.92);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + R * 0.92);
    for (let i = 1; i < 5; i++) {
      const d = (i / 5) * R * 0.9;
      ctx.moveTo(cx - d, cy - 5);
      ctx.lineTo(cx - d, cy + 5);
      ctx.moveTo(cx + d, cy - 5);
      ctx.lineTo(cx + d, cy + 5);
    }
    ctx.stroke();
    // Range readout below the glass.
    const st = h.state;
    const yd = Math.round((st.rider.scopeDist * YARDS) / 5) * 5;
    ctx.font = font('rye', Math.max(18, cam.h * 0.034));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = `${yd} yd ahead`;
    const tw = ctx.measureText(label).width;
    const ly = Math.min(cam.h - 24, cy + R + Math.max(24, cam.h * 0.04));
    ctx.fillStyle = 'rgba(20,16,12,0.8)';
    ctx.beginPath();
    roundRect(ctx, cx - tw / 2 - 14, ly - cam.h * 0.028, tw + 28, cam.h * 0.056, 8);
    ctx.fill();
    ctx.fillStyle = BRASS;
    ctx.fillText(label, cx, ly + 1);
    // Flags.
    ctx.font = font('sans', Math.max(12, cam.h * 0.018));
    ctx.fillStyle = PAPER;
    ctx.textAlign = 'left';
    ctx.fillText(`FLAGS ${st.flags.length}/${FLAG_MAX}  ·  click to flag`, cx + tw / 2 + 24, ly + 1);
    ctx.globalAlpha = 1;
  }

  // ---- Respawn ---------------------------------------------------------------------------------

  private respawn(s: Scene, st: GameState): void {
    const { ctx, cam } = s;
    const r = st.rider;
    const down = r.mode === 'down';
    if (down) {
      ctx.fillStyle = 'rgba(12,8,6,0.45)';
      ctx.fillRect(0, 0, cam.w, cam.h);
    }
    const secs = Math.max(0, Math.ceil(r.respawnTicks / TICK_HZ));
    const total = down ? 10 : st.train.cars.some((c) => c.kind === 'caboose') ? 4 : 6;
    const p = 1 - r.respawnTicks / (total * TICK_HZ);
    const cx = cam.w / 2;
    const cy = cam.h * 0.4;
    const R = Math.max(36, cam.h * 0.07);
    ctx.fillStyle = 'rgba(20,16,12,0.75)';
    ctx.beginPath();
    ctx.arc(cx, cy, R + 12, 0, TAU);
    ctx.fill();
    this.ring(ctx, cx, cy, R + 4, p);
    ctx.fillStyle = down ? RED : PAPER;
    ctx.font = font('rye', R * 1.1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(secs), cx, cy + R * 0.06);
    ctx.font = font('rye', Math.max(18, cam.h * 0.036));
    const title = down ? 'DOWN' : 'OFF THE TRAIN';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(20,16,12,0.85)';
    ctx.strokeText(title, cx, cy - R - 34);
    ctx.fillStyle = down ? RED : PAPER;
    ctx.fillText(title, cx, cy - R - 34);
    ctx.font = font('sans', Math.max(13, cam.h * 0.02));
    const sub = down ? 'Back on at the rear with full hearts' : 'Back on at the rear platform';
    ctx.strokeText(sub, cx, cy + R + 32);
    ctx.fillStyle = PAPER;
    ctx.fillText(sub, cx, cy + R + 32);
  }
}

function easeOut(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return 1 - (1 - u) * (1 - u) * (1 - u);
}

function heartPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + r * 0.9);
  ctx.bezierCurveTo(x - r * 1.35, y + r * 0.05, x - r * 1.05, y - r * 1.05, x, y - r * 0.4);
  ctx.bezierCurveTo(x + r * 1.05, y - r * 1.05, x + r * 1.35, y + r * 0.05, x, y + r * 0.9);
  ctx.closePath();
}
