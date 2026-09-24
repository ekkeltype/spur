// The timetable chart (spec §11), drawn like a dispatcher's train graph: the clock across, main-line
// distance down (the origin at the top), stations and passing sidings on the left, each charted
// train as an ink line, the player's trace solid and its projection dashed, the deadline, "now",
// and the first predicted conflict in red. The math lives in marey.ts.

import type { AiKind } from '../../sim/types';
import { PALETTE, withAlpha } from '../palette';
import { clockParts, formatClock } from './format';
import { RYE, SANS } from './gauges';
import { chartX, chartY, type Band, type ChartFrame, type Crossing, type LinePt, type Projection } from './marey';

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const PAPER = '#EFE6D2';
const PAPER_PAST = '#E3D6B9';
const INK = PALETTE.ink;
const BLUE_INK = '#2F5584';
const EXPRESS_INK = '#6A3F86';
const RED = PALETTE.signalRed;
const SIDING = 'rgba(138,154,107,0.28)';

export interface ChartTrain {
  id: string;
  name: string;
  kind: AiKind;
  pts: LinePt[];
}

export interface ChartModel {
  /** Clock span and main-line length. */
  t0: number;
  t1: number;
  mMax: number;
  /** The clock now, and where the loco's front is on the main line (null off it or before the first view). */
  clock: number | null;
  pos: number | null;
  trace: readonly LinePt[];
  trains: readonly ChartTrain[];
  bands: readonly Band[];
  stations: readonly { id: string; name: string; m: number; dest: boolean }[];
  deadline: number;
  projection: Projection | null;
  conflict: Crossing | null;
  /** Safe crossings before the conflict (meets in a siding). */
  meets: readonly Crossing[];
  font: number;
}

export class MareyChart {
  /** The plot frame of the last render. */
  frame: ChartFrame | null = null;
  private labelW = 0;
  private labelKey = '';

  render(c: Ctx, W: number, H: number, m: ChartModel): void {
    const f = m.font;
    const u = f / 14;
    // Left axis: wide enough for the longest label, but never more than a third of the panel.
    const key = `${f}|${m.stations.map((s) => s.name).join('|')}`;
    if (key !== this.labelKey) {
      c.font = `700 ${Math.round(f * 0.8)}px ${SANS}`;
      let w = 0;
      for (const s of m.stations) w = Math.max(w, c.measureText(s.name).width + 16 * u);
      this.labelW = w;
      this.labelKey = key;
    }
    const x0 = Math.round(Math.min(W * 0.34, Math.max(60 * u, this.labelW + 10 * u)));
    const x1 = W - Math.round(12 * u);
    const y0 = Math.round(f * 1.9);
    const y1 = H - Math.round(f * 0.9);
    const fr: ChartFrame = { x0, x1, y0, y1, t0: m.t0, t1: m.t1, m0: 0, m1: Math.max(1, m.mMax) };
    this.frame = fr;
    const X = (t: number): number => chartX(fr, t);
    const Y = (mm: number): number => chartY(fr, mm);

    // Paper, with the past a shade darker, as if thumbed.
    c.fillStyle = PAPER;
    c.fillRect(0, 0, W, H);
    if (m.clock !== null) {
      const xn = Math.max(x0, Math.min(x1, X(m.clock)));
      c.fillStyle = PAPER_PAST;
      c.fillRect(x0, y0, xn - x0, y1 - y0);
    }

    // Passing sidings: bands across the plot, named just inside it (the margin is the stations').
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    for (const b of m.bands) {
      const ya = Y(b.lo);
      const yb = Y(b.hi);
      c.fillStyle = SIDING;
      c.fillRect(x0, ya, x1 - x0, Math.max(2, yb - ya));
      c.fillStyle = '#4A5836';
      c.font = `italic 700 ${Math.round(f * 0.7)}px ${SANS}`;
      c.fillText(b.name, x0 + 5 * u, (ya + yb) / 2 + 0.5);
    }

    // Time grid: minutes faint, every 5 minutes stronger and labelled.
    const pxPerMin = ((x1 - x0) / Math.max(1, m.t1 - m.t0)) * 60;
    const labelEvery = pxPerMin * 5 >= 42 * u ? 5 : pxPerMin * 10 >= 42 * u ? 10 : 15;
    const startMin = Math.ceil(m.t0 / 60);
    const endMin = Math.floor(m.t1 / 60);
    c.lineWidth = 1;
    c.font = `700 ${Math.round(f * 0.74)}px ${SANS}`;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    let firstLabel = true;
    // Time labels give way to the NOW tag.
    const nowX = m.clock !== null && m.clock >= m.t0 && m.clock <= m.t1 ? X(m.clock) : null;
    for (let mi = startMin; mi <= endMin; mi++) {
      const x = Math.round(X(mi * 60)) + 0.5;
      const five = mi % 5 === 0;
      if (!five && pxPerMin < 7) continue;
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x, y1);
      c.strokeStyle = withAlpha(INK, five ? 0.22 : 0.08);
      c.stroke();
      if (mi % labelEvery === 0) {
        const p = clockParts(mi * 60);
        const text = firstLabel ? `${p.hm} ${p.ampm}` : p.hm;
        firstLabel = false;
        const half = c.measureText(text).width / 2;
        if (nowX !== null && Math.abs(nowX - x) < half + f * 1.6) continue;
        c.fillStyle = withAlpha(INK, 0.75);
        c.fillText(text, Math.max(half + 2, x), y0 - f * 0.45);
      }
    }

    // Stations: ruled lines with their names in the margin.
    for (const s of m.stations) {
      const y = Math.round(Y(s.m)) + 0.5;
      c.beginPath();
      c.moveTo(x0, y);
      c.lineTo(x1, y);
      c.strokeStyle = s.dest ? withAlpha(PALETTE.mesa, 0.9) : withAlpha(INK, 0.45);
      c.lineWidth = s.dest ? 2 : 1;
      c.stroke();
      c.lineWidth = 1;
      c.fillStyle = s.dest ? PALETTE.mesa : INK;
      c.font = `700 ${Math.round(f * 0.8)}px ${SANS}`;
      c.textAlign = 'right';
      c.textBaseline = 'middle';
      c.fillText(s.name, x0 - 6 * u, y);
    }
    // The plot's frame.
    c.strokeStyle = withAlpha(INK, 0.55);
    c.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);

    // The deadline.
    if (m.deadline >= m.t0 && m.deadline <= m.t1) {
      const x = Math.round(X(m.deadline)) + 0.5;
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x, y1);
      c.setLineDash([6 * u, 4 * u]);
      c.strokeStyle = withAlpha(RED, 0.85);
      c.lineWidth = 2 * u;
      c.stroke();
      c.setLineDash([]);
      c.font = `${Math.round(f * 0.7)}px ${RYE}`;
      c.fillStyle = RED;
      c.textAlign = 'right';
      c.textBaseline = 'top';
      c.fillText('DUE', x - 4 * u, y0 + 4 * u);
    }

    c.save();
    c.beginPath();
    c.rect(x0, y0 - 2, x1 - x0, y1 - y0 + 4);
    c.clip();

    // Scheduled trains.
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const t of m.trains) {
      const col = t.kind === 'express' ? EXPRESS_INK : BLUE_INK;
      this.polyline(c, t.pts, X, Y);
      c.strokeStyle = col;
      c.lineWidth = 2.2 * u;
      c.stroke();
    }

    // The player's trace so far, joined to where the train is now.
    const trace = m.clock !== null && m.pos !== null ? [...m.trace, { t: m.clock, m: m.pos }] : m.trace;
    this.polyline(c, trace, X, Y);
    c.strokeStyle = INK;
    c.lineWidth = 3 * u;
    c.stroke();

    // The projection at the current speed.
    const p = m.projection;
    if (p && p.t1 > p.t0) {
      c.beginPath();
      c.moveTo(X(p.t0), Y(p.m0));
      c.lineTo(X(p.t1), Y(p.m1));
      c.setLineDash([7 * u, 5 * u]);
      c.strokeStyle = withAlpha(INK, 0.8);
      c.lineWidth = 2.2 * u;
      c.stroke();
      c.setLineDash([]);
    }

    // Meets in sidings: hollow rings.
    for (const mt of m.meets) {
      c.beginPath();
      c.arc(X(mt.t), Y(mt.m), 6 * u, 0, TAU);
      c.strokeStyle = '#56643F';
      c.lineWidth = 2 * u;
      c.stroke();
    }
    c.restore();

    // Train names, at the left end of each line inside the plot.
    c.font = `700 ${Math.round(f * 0.74)}px ${SANS}`;
    for (const t of m.trains) {
      const first = t.pts.find((q) => q.m !== null);
      const second = t.pts.find((q, i) => i > 0 && q.m !== null && t.pts[i - 1].m !== null);
      if (!first || first.m === null) continue;
      const x = X(first.t);
      const y = Y(first.m);
      const up = second && second.m !== null ? second.m < first.m : false;
      c.textAlign = 'left';
      c.textBaseline = up ? 'top' : 'bottom';
      const tx = Math.max(x0 + 3 * u, Math.min(x1 - c.measureText(t.name).width - 3 * u, x + 5 * u));
      const ty = Math.max(y0 + 2 * u, Math.min(y1 - 2 * u, y + (up ? 4 : -4) * u));
      c.fillStyle = withAlpha(PAPER, 0.85);
      const tw = c.measureText(t.name).width;
      c.fillRect(tx - 2 * u, up ? ty - 1 : ty - f * 0.95, tw + 4 * u, f * 0.98);
      c.fillStyle = t.kind === 'express' ? EXPRESS_INK : BLUE_INK;
      c.fillText(t.name, tx, ty);
    }

    // Now.
    if (m.clock !== null && m.clock >= m.t0 && m.clock <= m.t1) {
      const x = Math.round(X(m.clock)) + 0.5;
      c.beginPath();
      c.moveTo(x, y0 - 2);
      c.lineTo(x, y1);
      c.strokeStyle = withAlpha(PALETTE.canyon, 0.9);
      c.lineWidth = 1.5 * u;
      c.stroke();
      c.font = `700 ${Math.round(f * 0.66)}px ${SANS}`;
      c.textAlign = 'center';
      c.textBaseline = 'bottom';
      const label = clockParts(m.clock).hm;
      const tw = c.measureText(label).width + 8 * u;
      c.fillStyle = PALETTE.canyon;
      c.beginPath();
      c.roundRect(x - tw / 2, y0 - f * 1.05, tw, f * 0.95, 2 * u);
      c.fill();
      c.fillStyle = PAPER;
      c.fillText(label, x, y0 - f * 0.22);
      if (m.pos !== null) {
        c.beginPath();
        c.arc(x, Y(m.pos), 4.5 * u, 0, TAU);
        c.fillStyle = INK;
        c.fill();
        c.strokeStyle = PALETTE.brass;
        c.lineWidth = 2 * u;
        c.stroke();
      }
    }

    // The conflict.
    const cf = m.conflict;
    if (cf) {
      const x = X(cf.t);
      const y = Y(cf.m);
      const r = 8 * u;
      c.beginPath();
      c.arc(x, y, r + 5 * u, 0, TAU);
      c.fillStyle = withAlpha(RED, 0.18);
      c.fill();
      c.beginPath();
      c.arc(x, y, r, 0, TAU);
      c.fillStyle = RED;
      c.fill();
      c.beginPath();
      c.moveTo(x - r * 0.45, y - r * 0.45);
      c.lineTo(x + r * 0.45, y + r * 0.45);
      c.moveTo(x + r * 0.45, y - r * 0.45);
      c.lineTo(x - r * 0.45, y + r * 0.45);
      c.strokeStyle = PAPER;
      c.lineWidth = 2 * u;
      c.stroke();
      const train = m.trains.find((t) => t.id === cf.train);
      const text = `${train?.name ?? 'A train'} · ${formatClock(cf.t)}`;
      c.font = `700 ${Math.round(f * 0.78)}px ${SANS}`;
      const tw = c.measureText(text).width + 10 * u;
      const th = f * 1.3;
      let bx = x + r + 6 * u;
      if (bx + tw > x1) bx = x - r - 6 * u - tw;
      const by = Math.max(y0 + 2, Math.min(y1 - th - 2, y - th / 2));
      c.beginPath();
      c.roundRect(bx, by, tw, th, 3 * u);
      c.fillStyle = RED;
      c.fill();
      c.fillStyle = '#FFF4EE';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(text, bx + 5 * u, by + th / 2 + 0.5);
    }
  }

  private polyline(c: Ctx, pts: readonly LinePt[], X: (t: number) => number, Y: (m: number) => number): void {
    c.beginPath();
    let pen = false;
    for (const q of pts) {
      if (q.m === null) {
        pen = false;
        continue;
      }
      if (pen) c.lineTo(X(q.t), Y(q.m));
      else c.moveTo(X(q.t), Y(q.m));
      pen = true;
    }
  }
}
