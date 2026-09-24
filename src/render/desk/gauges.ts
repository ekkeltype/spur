// The cab's instruments (spec §11): brass-rimmed dials for speed and steam, the water glass, and the
// throttle and brake quadrants. Plain drawing functions over a 2D context in CSS px; the cab panel
// (cab.ts) owns the canvases, the needles' easing and the pointer.

import { EMERGENCY_BRAKE, LOW_WATER, P_MAX } from '../../sim/rules';
import { BRAKE_QUADRANT, THROTTLE_NOTCHES, brakeToFraction, brakeZone, throttleNotch } from './levers';
import { PALETTE, withAlpha } from '../palette';

type Ctx = CanvasRenderingContext2D;

export const RYE = 'Rye, "Alegreya Sans", Georgia, serif';
export const SANS = '"Alegreya Sans", system-ui, sans-serif';

const TAU = Math.PI * 2;
/** Dials sweep 270°, from bottom-left clockwise to bottom-right. */
const A0 = Math.PI * 0.75;
const SWEEP = Math.PI * 1.5;

export const SPEED_MAX_MPH = 70;
export const PSI_MAX = 240;
/** The good working band on the steam gauge (spec §5.5: full power from 160 psi, the governor holds ~175). */
export const PSI_GOOD: [number, number] = [160, 190];

const INK = PALETTE.ink;
const BRASS = PALETTE.brass;
const RED = PALETTE.signalRed;
const YELLOW = PALETTE.signalYellow;
const GREEN = PALETTE.signalGreen;
export const WATER_BLUE = '#6FA3CF';

function brassGradient(c: Ctx, x0: number, y0: number, x1: number, y1: number): CanvasGradient {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, '#F0D798');
  g.addColorStop(0.35, '#C8A15A');
  g.addColorStop(0.7, '#8E6D33');
  g.addColorStop(1, '#C2995A');
  return g;
}

function roundRect(c: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

// ---------------------------------------------------------------------------------------------
// Dials
// ---------------------------------------------------------------------------------------------

interface DialSpec {
  max: number;
  major: number;
  minor: number;
  label: string;
  unit: string;
  /** Coloured arcs inside the ticks: [from, to, colour]. */
  bands: [number, number, string][];
  /** A red line across the scale (the steam gauge's P_MAX). */
  redLine?: number;
}

const angleOf = (v: number, max: number): number => A0 + (Math.max(0, Math.min(max, v)) / max) * SWEEP;

/** A brass bezel and a paper face, centred at (x, y), radius r. */
function dialBody(c: Ctx, x: number, y: number, r: number): void {
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.55)';
  c.shadowBlur = r * 0.12;
  c.shadowOffsetY = r * 0.04;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fillStyle = brassGradient(c, x - r, y - r, x + r, y + r);
  c.fill();
  c.restore();
  // The bezel's inner lip.
  c.beginPath();
  c.arc(x, y, r * 0.915, 0, TAU);
  c.fillStyle = '#5E4722';
  c.fill();
  const face = c.createRadialGradient(x, y - r * 0.25, r * 0.1, x, y, r * 0.9);
  face.addColorStop(0, '#F7F0E0');
  face.addColorStop(0.75, '#EDE3CC');
  face.addColorStop(1, '#D8CAA9');
  c.beginPath();
  c.arc(x, y, r * 0.885, 0, TAU);
  c.fillStyle = face;
  c.fill();
}

function dialScale(c: Ctx, x: number, y: number, r: number, spec: DialSpec): void {
  const rt = r * 0.8; // tick outer radius
  // Coloured bands just inside the ticks.
  c.lineCap = 'butt';
  for (const [a, b, col] of spec.bands) {
    if (b <= a) continue;
    c.beginPath();
    c.arc(x, y, rt - r * 0.045, angleOf(a, spec.max), angleOf(b, spec.max));
    c.strokeStyle = col;
    c.lineWidth = r * 0.075;
    c.stroke();
  }
  // Ticks.
  c.strokeStyle = INK;
  for (let v = 0; v <= spec.max + 1e-6; v += spec.minor) {
    const major = Math.abs(v / spec.major - Math.round(v / spec.major)) < 1e-6;
    const a = angleOf(v, spec.max);
    const r0 = major ? rt - r * 0.13 : rt - r * 0.07;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
    c.lineTo(x + Math.cos(a) * rt, y + Math.sin(a) * rt);
    c.lineWidth = major ? Math.max(1.2, r * 0.022) : Math.max(0.8, r * 0.011);
    c.stroke();
  }
  // Numerals.
  c.fillStyle = INK;
  c.font = `700 ${Math.max(8, Math.round(r * 0.135))}px ${SANS}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  for (let v = 0; v <= spec.max + 1e-6; v += spec.major) {
    const a = angleOf(v, spec.max);
    const rn = rt - r * 0.24;
    c.fillText(String(v), x + Math.cos(a) * rn, y + Math.sin(a) * rn);
  }
  if (spec.redLine !== undefined) {
    const a = angleOf(spec.redLine, spec.max);
    c.beginPath();
    c.moveTo(x + Math.cos(a) * (rt - r * 0.2), y + Math.sin(a) * (rt - r * 0.2));
    c.lineTo(x + Math.cos(a) * (rt + r * 0.03), y + Math.sin(a) * (rt + r * 0.03));
    c.strokeStyle = RED;
    c.lineWidth = Math.max(2, r * 0.035);
    c.stroke();
  }
  // Dial name at the top of the face.
  c.fillStyle = withAlpha(INK, 0.62);
  c.font = `${Math.max(7, Math.round(r * 0.1))}px ${RYE}`;
  c.fillText(spec.label, x, y - r * 0.3);
}

function needle(c: Ctx, x: number, y: number, r: number, a: number, color: string): void {
  const len = r * 0.74;
  const tail = r * 0.16;
  const w = Math.max(1.6, r * 0.035);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const px = -sa;
  const py = ca;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.35)';
  c.shadowBlur = r * 0.04;
  c.shadowOffsetY = r * 0.02;
  c.beginPath();
  c.moveTo(x + ca * len, y + sa * len);
  c.lineTo(x + px * w - ca * tail, y + py * w - sa * tail);
  c.lineTo(x - px * w - ca * tail, y - py * w - sa * tail);
  c.closePath();
  c.fillStyle = color;
  c.fill();
  c.restore();
  // Hub.
  c.beginPath();
  c.arc(x, y, r * 0.075, 0, TAU);
  c.fillStyle = brassGradient(c, x - r * 0.08, y - r * 0.08, x + r * 0.08, y + r * 0.08);
  c.fill();
  c.lineWidth = 1;
  c.strokeStyle = '#4A381C';
  c.stroke();
}

function readout(c: Ctx, x: number, y: number, r: number, value: string, unit: string, color: string): void {
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.fillStyle = color;
  c.font = `${Math.round(r * 0.3)}px ${RYE}`;
  c.fillText(value, x, y + r * 0.47);
  c.fillStyle = withAlpha(INK, 0.6);
  c.font = `700 ${Math.max(7, Math.round(r * 0.095))}px ${SANS}`;
  c.fillText(unit, x, y + r * 0.62);
}

export interface SpeedDial {
  mph: number;
  /** The limit at the loco (mph), or null when unknown. */
  limitMph: number | null;
  overspeed: 0 | 1 | 2;
  /** Seconds, for blinking. */
  time: number;
}

export function drawSpeedDial(c: Ctx, x: number, y: number, r: number, d: SpeedDial): void {
  dialBody(c, x, y, r);
  const bands: [number, number, string][] = [];
  if (d.limitMph !== null) {
    bands.push([d.limitMph, d.limitMph * 1.15, withAlpha(YELLOW, 0.85)]);
    bands.push([d.limitMph * 1.15, SPEED_MAX_MPH, withAlpha(RED, 0.7)]);
  }
  dialScale(c, x, y, r, { max: SPEED_MAX_MPH, major: 10, minor: 5, label: 'SPEED', unit: 'MPH', bands });
  if (d.limitMph !== null) {
    // The limit: a red pointer outside the ticks, like a movable index on a real gauge.
    const a = angleOf(d.limitMph, SPEED_MAX_MPH);
    const ro = r * 0.83;
    const ri = r * 0.7;
    c.beginPath();
    c.moveTo(x + Math.cos(a) * ri, y + Math.sin(a) * ri);
    c.lineTo(x + Math.cos(a + 0.07) * ro, y + Math.sin(a + 0.07) * ro);
    c.lineTo(x + Math.cos(a - 0.07) * ro, y + Math.sin(a - 0.07) * ro);
    c.closePath();
    c.fillStyle = PALETTE.blood;
    c.fill();
  }
  const warn = d.overspeed === 2 ? RED : d.overspeed === 1 ? '#B8860B' : INK;
  const blink = d.overspeed === 2 && Math.floor(d.time * 4) % 2 === 0;
  readout(c, x, y, r, String(Math.round(Math.abs(d.mph))), 'MPH', blink ? withAlpha(RED, 0.45) : warn);
  needle(c, x, y, r, angleOf(Math.abs(d.mph), SPEED_MAX_MPH), d.overspeed === 2 ? RED : '#2B1F16');
}

export interface SteamDial {
  psi: number;
  safetyValve: boolean;
  time: number;
}

export function drawSteamDial(c: Ctx, x: number, y: number, r: number, d: SteamDial): void {
  dialBody(c, x, y, r);
  dialScale(c, x, y, r, {
    max: PSI_MAX,
    major: 40,
    minor: 10,
    label: 'STEAM',
    unit: 'PSI',
    bands: [
      [PSI_GOOD[0], PSI_GOOD[1], withAlpha(GREEN, 0.85)],
      [P_MAX, PSI_MAX, withAlpha(RED, 0.7)],
    ],
    redLine: P_MAX,
  });
  readout(c, x, y, r, String(Math.round(d.psi)), 'PSI', INK);
  needle(c, x, y, r, angleOf(d.psi, PSI_MAX), '#2B1F16');
  if (d.safetyValve) {
    // Steam feathering from the valve: little puffs over the top of the gauge.
    const t = d.time;
    for (let k = 0; k < 3; k++) {
      const ph = (t * 1.6 + k / 3) % 1;
      c.beginPath();
      c.arc(x + r * 0.55 + ph * r * 0.25, y - r * 0.95 - ph * r * 0.35, r * (0.08 + ph * 0.1), 0, TAU);
      c.fillStyle = `rgba(244,241,234,${0.55 * (1 - ph)})`;
      c.fill();
    }
  }
}

export interface WaterGlass {
  water: number;
  cap: number;
  /** No reading yet (before the first snapshot): no warnings. */
  idle?: boolean;
  /** Fire lit with no water: the boiler is about to go. */
  dry: boolean;
  filling: boolean;
  time: number;
}

/** The gauge glass: a vertical tube in brass fittings, the level against the tender's capacity. */
export function drawWaterGlass(c: Ctx, x: number, y: number, w: number, h: number, d: WaterGlass): void {
  const cap = Math.max(1, d.cap);
  const level = Math.max(0, Math.min(1, d.water / cap));
  const fit = Math.max(4, w * 0.28); // fitting height
  const tx = x + w * 0.2;
  const tw = w * 0.6;
  const ty = y + fit;
  const th = h - fit * 2;
  // Fittings.
  c.fillStyle = brassGradient(c, x, y, x + w, y + fit);
  roundRect(c, x, y, w, fit, fit * 0.3);
  c.fill();
  c.fillStyle = brassGradient(c, x, y + h - fit, x + w, y + h);
  roundRect(c, x, y + h - fit, w, fit, fit * 0.3);
  c.fill();
  // Tube.
  roundRect(c, tx, ty, tw, th, tw * 0.45);
  c.fillStyle = '#16120E';
  c.fill();
  const low = !d.idle && d.water < LOW_WATER;
  const blink = (low || d.dry) && Math.floor(d.time * 3) % 2 === 0;
  // Water.
  if (level > 0) {
    c.save();
    roundRect(c, tx, ty, tw, th, tw * 0.45);
    c.clip();
    const top = ty + th * (1 - level);
    const g = c.createLinearGradient(tx, 0, tx + tw, 0);
    g.addColorStop(0, '#3E6F99');
    g.addColorStop(0.45, low ? '#C98A3A' : WATER_BLUE);
    g.addColorStop(1, '#335C82');
    c.fillStyle = g;
    c.fillRect(tx, top, tw, ty + th - top);
    // Meniscus, rippling while the spout pours.
    c.fillStyle = 'rgba(255,255,255,0.35)';
    const ripple = d.filling ? Math.sin(d.time * 12) * 1.2 : 0;
    c.fillRect(tx, top + ripple, tw, Math.max(1, th * 0.012));
    c.restore();
  }
  // Glass highlight.
  c.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(c, tx + tw * 0.14, ty + th * 0.04, tw * 0.16, th * 0.92, tw * 0.1);
  c.fill();
  // The low-water mark.
  const ly = ty + th * (1 - LOW_WATER / cap);
  c.beginPath();
  c.moveTo(tx - w * 0.14, ly);
  c.lineTo(tx + tw + w * 0.14, ly);
  c.strokeStyle = RED;
  c.lineWidth = Math.max(1.5, w * 0.05);
  c.stroke();
  // Outline.
  roundRect(c, tx, ty, tw, th, tw * 0.45);
  c.strokeStyle = blink ? RED : 'rgba(200,161,90,0.55)';
  c.lineWidth = blink ? 2 : 1;
  c.stroke();
}

// ---------------------------------------------------------------------------------------------
// Lever quadrants
// ---------------------------------------------------------------------------------------------

export interface QuadrantLook {
  enabled: boolean;
  hover: boolean;
  dragging: boolean;
  /** A refused command: flash red (0..1). */
  flash: number;
  /** Base font px (text scales with the desk). */
  font: number;
}

/** The throttle quadrant's slot, in canvas CSS px: the handle's centre runs from y0 (shut) up to y1 (wide open). */
export function throttleSlot(w: number, h: number, font: number): { x: number; y0: number; y1: number; half: number } {
  const half = Math.max(8, font * 0.95);
  return { x: w * 0.6, y0: h - half - font * 0.35, y1: half + font * 0.35, half };
}

export function drawThrottle(c: Ctx, w: number, h: number, value: number, look: QuadrantLook): void {
  const s = throttleSlot(w, h, look.font);
  const slotW = Math.max(6, w * 0.16);
  const notch = throttleNotch(value);
  c.save();
  if (!look.enabled) c.globalAlpha = 0.45;
  // The plate.
  roundRect(c, s.x - slotW * 1.6, s.y1 - s.half, slotW * 3.2, s.y0 - s.y1 + s.half * 2, slotW * 0.8);
  c.fillStyle = '#2B231B';
  c.fill();
  c.strokeStyle = 'rgba(200,161,90,0.35)';
  c.lineWidth = 1;
  c.stroke();
  // The slot.
  roundRect(c, s.x - slotW / 2, s.y1 - slotW / 2, slotW, s.y0 - s.y1 + slotW, slotW / 2);
  c.fillStyle = '#0D0B09';
  c.fill();
  // Notches and numbers.
  c.textAlign = 'right';
  c.textBaseline = 'middle';
  for (let n = 0; n <= THROTTLE_NOTCHES; n++) {
    const y = s.y0 + ((s.y1 - s.y0) * n) / THROTTLE_NOTCHES;
    const on = n <= notch && notch > 0;
    c.beginPath();
    c.moveTo(s.x - slotW * 1.35, y);
    c.lineTo(s.x - slotW * 0.75, y);
    c.strokeStyle = on ? BRASS : 'rgba(239,230,210,0.35)';
    c.lineWidth = n % 4 === 0 ? 2 : 1.2;
    c.stroke();
    c.fillStyle = n === notch ? '#F2DDA6' : 'rgba(239,230,210,0.55)';
    c.font = `${n === notch ? '700 ' : ''}${Math.round(look.font * (n === notch ? 0.95 : 0.78))}px ${SANS}`;
    c.fillText(String(n), s.x - slotW * 1.75, y);
  }
  // The handle: a brass latch block in the slot with a grip.
  const hy = s.y0 + ((s.y1 - s.y0) * notch) / THROTTLE_NOTCHES;
  const hw = slotW * 2.6;
  const hh = Math.max(8, look.font * 0.9);
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 6;
  c.shadowOffsetY = 2;
  roundRect(c, s.x - hw / 2, hy - hh / 2, hw + slotW * 1.3, hh, hh * 0.45);
  c.fillStyle = look.flash > 0 ? RED : brassGradient(c, s.x - hw / 2, hy - hh / 2, s.x + hw, hy + hh / 2);
  c.fill();
  c.restore();
  // Grip knob.
  c.beginPath();
  c.arc(s.x + hw / 2 + slotW * 1.1, hy, hh * 0.62, 0, TAU);
  c.fillStyle = look.flash > 0 ? RED : '#3A2A1A';
  c.fill();
  c.strokeStyle = look.hover || look.dragging ? '#F2DDA6' : 'rgba(200,161,90,0.8)';
  c.lineWidth = look.hover || look.dragging ? 2 : 1.2;
  c.stroke();
  c.restore();
}

/** The brake quadrant's slot: x0 (left end) … x1 (right end) at height y. */
export function brakeSlot(w: number, h: number, font: number): { x0: number; x1: number; y: number; half: number } {
  const half = Math.max(8, font * 0.9);
  return { x0: half + 2, x1: w - half - 2, y: h * 0.4, half };
}

export function drawBrake(c: Ctx, w: number, h: number, value: number, look: QuadrantLook): void {
  const s = brakeSlot(w, h, look.font);
  const slotH = Math.max(6, h * 0.16);
  const q = BRAKE_QUADRANT;
  const X = (f: number): number => s.x0 + (s.x1 - s.x0) * f;
  c.save();
  if (!look.enabled) c.globalAlpha = 0.45;
  // Plate.
  roundRect(c, s.x0 - s.half * 0.8, s.y - slotH * 1.7, s.x1 - s.x0 + s.half * 1.6, slotH * 3.4, slotH);
  c.fillStyle = '#2B231B';
  c.fill();
  c.strokeStyle = 'rgba(200,161,90,0.35)';
  c.lineWidth = 1;
  c.stroke();
  // Zones behind the slot: service (brass, deepening), emergency (red).
  const g = c.createLinearGradient(X(q.releaseEnd), 0, X(q.serviceEnd), 0);
  g.addColorStop(0, 'rgba(200,161,90,0.12)');
  g.addColorStop(1, 'rgba(200,161,90,0.55)');
  c.fillStyle = g;
  c.fillRect(X(q.releaseEnd), s.y - slotH * 1.25, X(q.serviceEnd) - X(q.releaseEnd), slotH * 2.5);
  c.fillStyle = withAlpha(RED, 0.55);
  c.fillRect(X(q.emergencyStart), s.y - slotH * 1.25, X(1) - X(q.emergencyStart), slotH * 2.5);
  // Slot.
  roundRect(c, s.x0 - slotH / 2, s.y - slotH / 2, s.x1 - s.x0 + slotH, slotH, slotH / 2);
  c.fillStyle = '#0D0B09';
  c.fill();
  // Detent marks.
  c.strokeStyle = 'rgba(239,230,210,0.5)';
  c.lineWidth = 1.2;
  for (const f of [q.releaseEnd, q.serviceEnd, q.emergencyStart]) {
    c.beginPath();
    c.moveTo(X(f), s.y - slotH * 1.25);
    c.lineTo(X(f), s.y + slotH * 1.25);
    c.stroke();
  }
  // Zone labels under the plate.
  c.textBaseline = 'top';
  c.font = `700 ${Math.round(look.font * 0.7)}px ${SANS}`;
  const ly = s.y + slotH * 1.9;
  const zone = brakeZone(value);
  const lab = (text: string, x: number, align: CanvasTextAlign, active: boolean, col: string): void => {
    c.textAlign = align;
    c.fillStyle = active ? col : 'rgba(239,230,210,0.45)';
    c.fillText(text, x, ly);
  };
  lab('RELEASE', X(0) - s.half * 0.6, 'left', zone === 'release', '#F2DDA6');
  lab('SERVICE', (X(q.releaseEnd) + X(q.serviceEnd)) / 2, 'center', zone === 'service', '#F2DDA6');
  lab('EMERG.', X(1) + s.half * 0.6, 'right', zone === 'emergency', '#FF8A70');
  // Handle.
  const hx = X(brakeToFraction(value));
  const hw = Math.max(8, look.font * 0.85);
  const hh = slotH * 3.1;
  c.save();
  c.shadowColor = 'rgba(0,0,0,0.6)';
  c.shadowBlur = 6;
  c.shadowOffsetY = 2;
  roundRect(c, hx - hw / 2, s.y - hh / 2, hw, hh, hw * 0.4);
  c.fillStyle = look.flash > 0 ? RED : zone === 'emergency' ? '#D0452F' : brassGradient(c, hx - hw / 2, s.y - hh / 2, hx + hw / 2, s.y + hh / 2);
  c.fill();
  c.restore();
  roundRect(c, hx - hw / 2, s.y - hh / 2, hw, hh, hw * 0.4);
  c.strokeStyle = look.hover || look.dragging ? '#F2DDA6' : 'rgba(58,42,26,0.9)';
  c.lineWidth = look.hover || look.dragging ? 2 : 1;
  c.stroke();
  // Grip line.
  c.beginPath();
  c.moveTo(hx, s.y - hh * 0.3);
  c.lineTo(hx, s.y + hh * 0.3);
  c.strokeStyle = 'rgba(40,28,16,0.7)';
  c.lineWidth = 1.5;
  c.stroke();
  c.restore();
}

/** The brake as words for the lever's caption. */
export function brakeCaption(value: number): string {
  const z = brakeZone(value);
  if (z === 'release') return 'Released';
  if (z === 'emergency') return 'EMERGENCY';
  return value >= EMERGENCY_BRAKE - 1e-6 ? 'Full service' : `Service ${Math.round((value / EMERGENCY_BRAKE) * 100)}%`;
}
