// The route map (spec §11): the run's network as a painted track diagram, fitted to its panel or
// following the train. Track from the nodes' x/y and the edges' `via` points; features placed along
// each edge's polyline in proportion to their offset; the switches as numbered, clickable glyphs;
// the player's train along its spans, charted trains in sight and the Rider's flags on top. Signal
// posts are grey: the desk never shows aspects (spec §9.3), except in the ?debug=1 overlay.

import type { DebugInfo } from '../../net/protocol';
import { edgeOf, fouls, spanDir, type NetIndex } from '../../sim/network';
import { FLAG_TTL_SECONDS, SWITCH_FOUL_DISTANCE, TICK_HZ } from '../../sim/rules';
import type { AiTrainDef, EdgeKind, EngineerView, Span, SwitchState } from '../../sim/types';
import { PALETTE, withAlpha } from '../palette';
import { limitMph } from './format';
import { RYE, SANS, WATER_BLUE } from './gauges';

type Ctx = CanvasRenderingContext2D;

const TAU = Math.PI * 2;
const BOARD = '#171A17';
const BOARD_EDGE = '#0F110F';
const TRACK = PALETTE.paper;
const ROUTE = '#E3BE6E';
const TRAIN = '#F0C66A';
const OTHER = '#E0674A';
const SIGNAL_GREY = '#8D8A84';
const TUNNEL = '#050505';
const TRESTLE = '#A8683E';

/** In follow mode the panel shows about this much track across. */
const FOLLOW_METRES = 3200;
/** Seconds for the camera to settle after a change. */
const CAMERA_TAU = 0.22;

interface EdgeGeom {
  id: string;
  kind: EdgeKind;
  /** Metres. */
  length: number;
  /** Polyline in map units: x0, y0, x1, y1, … from a to b. */
  xs: number[];
  ys: number[];
  /** Cumulative polyline length at each vertex (map units). */
  cum: number[];
}

interface Pt {
  x: number;
  y: number;
  /** Unit tangent in screen space, in the edge's a→b direction. */
  tx: number;
  ty: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MapFlash {
  junction: string;
  kind: 'refused' | 'thrown';
  /** ms */
  at: number;
}

export interface MapModel {
  view: EngineerView | null;
  /** Switch settings to draw (the view's, with unconfirmed throws applied). */
  switches: Record<string, SwitchState>;
  /** Junctions thrown but not yet confirmed by the host. */
  pending: ReadonlySet<string>;
  numbers: ReadonlyMap<string, number>;
  /** The track the train will take from its leading end, following the switches. */
  route: readonly Span[];
  hover: string | null;
  flashes: readonly MapFlash[];
  follow: boolean;
  destination: string;
  debug: DebugInfo | null;
  /** The switches accept input (not paused, not held up). */
  enabled: boolean;
  /** Base font px of the desk. */
  font: number;
  /** ms */
  now: number;
}

export class RouteMap {
  private readonly geom = new Map<string, EdgeGeom>();
  private readonly bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  /** Map units per metre along the track (median over the edges). */
  private readonly upm: number;
  private readonly aiDefs = new Map<string, AiTrainDef>();
  /** The transform of the last render: screen = ((x − cx)·s + W/2, (y − cy)·s·k + H/2). */
  private cam = { cx: 0, cy: 0, s: 1, k: 1, W: 0, H: 0, ready: false };
  private camMoving = false;
  private lastNow = 0;
  /** Switch discs as drawn, for hit testing (CSS px). */
  private discs: { id: string; x: number; y: number; r: number; nx: number; ny: number }[] = [];
  private placed: Rect[] = [];
  private u = 1;

  constructor(
    private readonly ix: NetIndex,
  ) {
    const run = ix.run;
    const node = ix.node;
    const ratios: number[] = [];
    for (const e of run.edges) {
      const a = node.get(e.a);
      const b = node.get(e.b);
      if (!a || !b) continue;
      const xs = [a.x, ...(e.via ?? []).map((p) => p[0]), b.x];
      const ys = [a.y, ...(e.via ?? []).map((p) => p[1]), b.y];
      const cum = [0];
      for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
      this.geom.set(e.id, { id: e.id, kind: e.kind, length: e.length, xs, ys, cum });
      for (let i = 0; i < xs.length; i++) {
        this.bbox.x0 = Math.min(this.bbox.x0, xs[i]);
        this.bbox.x1 = Math.max(this.bbox.x1, xs[i]);
        this.bbox.y0 = Math.min(this.bbox.y0, ys[i]);
        this.bbox.y1 = Math.max(this.bbox.y1, ys[i]);
      }
      const total = cum[cum.length - 1];
      if (e.length > 0 && total > 0) ratios.push(total / e.length);
    }
    ratios.sort((p, q) => p - q);
    this.upm = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 0.01;
    if (!Number.isFinite(this.bbox.x0)) Object.assign(this.bbox, { x0: 0, y0: 0, x1: 1, y1: 1 });
    for (const d of run.aiTrains) this.aiDefs.set(d.id, d);
  }

  /** The camera is still moving or a flash is animating: keep rendering. */
  animating(model: MapModel): boolean {
    return this.camMoving || model.flashes.some((f) => model.now - f.at < 900) || model.pending.size > 0;
  }

  /** The switch (junction id) whose glyph is under a CSS px point, or null. */
  switchAt(px: number, py: number): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const d of this.discs) {
      const dd = Math.hypot(px - d.x, py - d.y);
      const dn = Math.hypot(px - d.nx, py - d.ny);
      const hit = Math.min(dd - d.r * 1.35, dn - d.r * 1.2);
      if (hit <= 0 && hit < bestD) {
        bestD = hit;
        best = d.id;
      }
    }
    return best;
  }

  render(c: Ctx, W: number, H: number, m: MapModel): void {
    this.u = m.font / 14;
    const dt = this.cam.ready ? Math.min(0.1, Math.max(0, (m.now - this.lastNow) / 1000)) : 1;
    this.lastNow = m.now;
    this.updateCamera(W, H, m, dt);
    this.placed = [];
    this.discs = [];

    this.drawBoard(c, W, H);
    this.reserveTrack();
    this.reserveDiscs(m);
    const trainLabels = this.placeTrainLabels(c, m);
    this.drawTrack(c);
    this.drawRoute(c, m);
    this.drawFeatures(c, m);
    this.drawLabels(c, m);
    this.drawSwitchLegs(c, m);
    this.drawOtherTrains(c, m, trainLabels);
    this.drawTrain(c, m);
    this.drawFlags(c, m);
    this.drawSwitchDiscs(c, m);
    if (m.debug) this.drawDebug(c, m, m.debug);
    if (m.hover) this.drawTooltip(c, W, H, m, m.hover);
  }

  // -------------------------------------------------------------------------------------------
  // Camera

  private fitScale(W: number, H: number): { s: number; k: number } {
    const b = this.bbox;
    const mx = 3.4 * 14 * this.u;
    const my = 3.6 * 14 * this.u;
    const bw = Math.max(1e-6, b.x1 - b.x0);
    const bh = b.y1 - b.y0;
    const sx = (W - 2 * mx) / bw;
    if (bh < 1e-6) return { s: Math.max(0.01, sx), k: 1 };
    const sy = (H - 2 * my) / bh;
    const s = Math.max(0.01, Math.min(sx, sy));
    // Schematics are long and flat: let the vertical spread use up to 3× the horizontal scale.
    const k = Math.max(1, Math.min(3, sy / s));
    return { s, k };
  }

  private updateCamera(W: number, H: number, m: MapModel, dt: number): void {
    const fit = this.fitScale(W, H);
    const b = this.bbox;
    let tx = (b.x0 + b.x1) / 2;
    let ty = (b.y0 + b.y1) / 2;
    let ts = fit.s;
    const front = m.view && m.view.train.spans.length > 0 ? m.view.train.spans[m.view.train.spans.length - 1] : null;
    if (m.follow && front) {
      ts = Math.max(fit.s * 1.6, W / (FOLLOW_METRES * this.upm));
      const p = this.mapPoint(front.edge, front.to);
      const lead = this.mapTangent(front.edge, front.to);
      const dir = spanDir(front) * (m.view && m.view.train.v < -0.2 ? -1 : 1);
      tx = p.x + lead.x * dir * ((W * 0.18) / ts);
      ty = p.y + lead.y * dir * ((W * 0.18) / ts);
      // Keep the map in view rather than empty board past its ends.
      const halfW = W / 2 / ts;
      if (b.x1 - b.x0 > 2 * halfW) tx = Math.max(b.x0 + halfW * 0.8, Math.min(b.x1 - halfW * 0.8, tx));
      else tx = (b.x0 + b.x1) / 2;
      const halfH = H / 2 / (ts * fit.k);
      if (b.y1 - b.y0 > 2 * halfH) ty = Math.max(b.y0 + halfH * 0.7, Math.min(b.y1 - halfH * 0.7, ty));
      else ty = (b.y0 + b.y1) / 2;
    }
    const c = this.cam;
    if (!c.ready || c.W !== W || c.H !== H) {
      // The first frame and a resize snap (no animation across layouts); a mode change glides.
      Object.assign(c, { cx: tx, cy: ty, s: ts });
      c.ready = true;
    }
    const a = 1 - Math.exp(-dt / CAMERA_TAU);
    c.cx += (tx - c.cx) * a;
    c.cy += (ty - c.cy) * a;
    c.s = Math.exp(Math.log(c.s) + (Math.log(ts) - Math.log(c.s)) * a);
    c.k = fit.k;
    c.W = W;
    c.H = H;
    const settled = Math.abs(tx - c.cx) * c.s < 0.3 && Math.abs(ty - c.cy) * c.s < 0.3 && Math.abs(ts / c.s - 1) < 0.002;
    if (settled) {
      c.cx = tx;
      c.cy = ty;
      c.s = ts;
    }
    this.camMoving = !settled;
  }

  private sx(x: number): number {
    return (x - this.cam.cx) * this.cam.s + this.cam.W / 2;
  }

  private sy(y: number): number {
    return (y - this.cam.cy) * this.cam.s * this.cam.k + this.cam.H / 2;
  }

  // -------------------------------------------------------------------------------------------
  // Geometry along edges

  private locate(g: EdgeGeom, off: number): { i: number; f: number } {
    const total = g.cum[g.cum.length - 1];
    const d = g.length > 0 ? (Math.max(0, Math.min(g.length, off)) / g.length) * total : 0;
    let i = 1;
    while (i < g.cum.length - 1 && g.cum[i] < d) i++;
    const seg = g.cum[i] - g.cum[i - 1];
    return { i, f: seg > 0 ? (d - g.cum[i - 1]) / seg : 0 };
  }

  private mapPoint(edge: string, off: number): { x: number; y: number } {
    const g = this.geom.get(edge);
    if (!g) return { x: 0, y: 0 };
    const { i, f } = this.locate(g, off);
    return { x: g.xs[i - 1] + (g.xs[i] - g.xs[i - 1]) * f, y: g.ys[i - 1] + (g.ys[i] - g.ys[i - 1]) * f };
  }

  private mapTangent(edge: string, off: number): { x: number; y: number } {
    const g = this.geom.get(edge);
    if (!g) return { x: 1, y: 0 };
    const { i } = this.locate(g, off);
    const dx = g.xs[i] - g.xs[i - 1];
    const dy = g.ys[i] - g.ys[i - 1];
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  /** Screen point and screen-space tangent (a→b) at an offset on an edge. */
  private pt(edge: string, off: number): Pt {
    const p = this.mapPoint(edge, off);
    const t = this.mapTangent(edge, off);
    const tx = t.x * this.cam.s;
    const ty = t.y * this.cam.s * this.cam.k;
    const l = Math.hypot(tx, ty) || 1;
    return { x: this.sx(p.x), y: this.sy(p.y), tx: tx / l, ty: ty / l };
  }

  /** Adds the polyline between two offsets on an edge (either order) to the current path. */
  private trace(c: Ctx, edge: string, from: number, to: number, move = true): void {
    const g = this.geom.get(edge);
    if (!g) return;
    const a = this.locate(g, from);
    const b = this.locate(g, to);
    const pa = this.mapPoint(edge, from);
    const pb = this.mapPoint(edge, to);
    if (move) c.moveTo(this.sx(pa.x), this.sy(pa.y));
    else c.lineTo(this.sx(pa.x), this.sy(pa.y));
    if (to >= from) for (let i = a.i; i < b.i; i++) c.lineTo(this.sx(g.xs[i]), this.sy(g.ys[i]));
    else for (let i = a.i - 1; i >= b.i; i--) c.lineTo(this.sx(g.xs[i]), this.sy(g.ys[i]));
    c.lineTo(this.sx(pb.x), this.sy(pb.y));
  }

  private traceSpans(c: Ctx, spans: readonly Span[]): void {
    let first = true;
    for (const s of spans) {
      this.trace(c, s.edge, s.from, s.to, first);
      first = false;
    }
  }

  private trackWidth(kind: EdgeKind): number {
    const u = this.u;
    return kind === 'main' ? 3.4 * u : kind === 'branch' ? 2.8 * u : 2.2 * u;
  }

  // -------------------------------------------------------------------------------------------
  // Labels

  private tryPlace(r: Rect, pad = 2): boolean {
    for (const p of this.placed) {
      if (r.x < p.x + p.w + pad && r.x + r.w + pad > p.x && r.y < p.y + p.h + pad && r.y + r.h + pad > p.y) return false;
    }
    if (r.x < 2 || r.y < 2 || r.x + r.w > this.cam.W - 2 || r.y + r.h > this.cam.H - 2) return false;
    this.placed.push(r);
    return true;
  }

  private reserve(r: Rect): void {
    this.placed.push(r);
  }

  // -------------------------------------------------------------------------------------------
  // Layers

  private drawBoard(c: Ctx, W: number, H: number): void {
    c.fillStyle = BOARD;
    c.fillRect(0, 0, W, H);
    const g = c.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) * 0.7);
    g.addColorStop(0, 'rgba(255,255,255,0.03)');
    g.addColorStop(1, withAlpha(BOARD_EDGE, 0.45));
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
  }

  private drawTrack(c: Ctx): void {
    c.lineCap = 'round';
    c.lineJoin = 'round';
    // Casing first so crossings and junctions stay clean.
    for (const g of this.geom.values()) {
      c.beginPath();
      this.trace(c, g.id, 0, g.length);
      c.strokeStyle = BOARD_EDGE;
      c.lineWidth = this.trackWidth(g.kind) + 3 * this.u;
      c.stroke();
    }
    const kinds: EdgeKind[] = ['spur', 'siding', 'branch', 'main'];
    for (const k of kinds) {
      for (const g of this.geom.values()) {
        if (g.kind !== k) continue;
        c.beginPath();
        this.trace(c, g.id, 0, g.length);
        c.strokeStyle = withAlpha(TRACK, k === 'main' ? 0.86 : k === 'branch' ? 0.74 : k === 'siding' ? 0.62 : 0.5);
        c.lineWidth = this.trackWidth(k);
        c.stroke();
      }
    }
    // Buffer stops at dead ends.
    for (const n of this.ix.run.nodes) {
      const end = this.endOf(n.id);
      if (!end) continue;
      const { p } = end;
      const L = 6 * this.u;
      c.beginPath();
      c.moveTo(p.x - p.ty * L, p.y + p.tx * L);
      c.lineTo(p.x + p.ty * L, p.y - p.tx * L);
      c.strokeStyle = '#B04A36';
      c.lineWidth = 3 * this.u;
      c.lineCap = 'butt';
      c.stroke();
      c.lineCap = 'round';
    }
  }

  /** An end node's point on the screen and which way is "out" along its track, or null for other nodes. */
  private endOf(nodeId: string): { p: Pt; out: 1 | -1 } | null {
    const n = this.ix.node.get(nodeId);
    if (!n || n.kind !== 'end') return null;
    const inc = this.ix.incident.get(n.id)?.[0];
    if (!inc) return null;
    const e = edgeOf(this.ix, inc.edge);
    return { p: this.pt(e.id, inc.end === 'a' ? 0 : e.length), out: inc.end === 'a' ? -1 : 1 };
  }

  private drawRoute(c: Ctx, m: MapModel): void {
    if (m.route.length === 0) return;
    // The route the switches set, lit from the train and fading with distance.
    const total = m.route.reduce((n, s) => n + Math.abs(s.to - s.from), 0);
    const chunks = 14;
    let acc = 0;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const s of m.route) {
      const len = Math.abs(s.to - s.from);
      const dir = spanDir(s);
      const pieces = Math.max(1, Math.ceil((len / Math.max(1, total)) * chunks));
      for (let k = 0; k < pieces; k++) {
        const a = s.from + (dir * len * k) / pieces;
        const b = s.from + (dir * len * (k + 1)) / pieces;
        const t = (acc + (len * (k + 0.5)) / pieces) / Math.max(1, total);
        const alpha = 0.95 - 0.75 * t;
        const g = this.geom.get(s.edge);
        if (!g) continue;
        c.beginPath();
        this.trace(c, s.edge, a, b);
        c.strokeStyle = withAlpha(ROUTE, alpha * 0.22);
        c.lineWidth = this.trackWidth(g.kind) + 7 * this.u;
        c.stroke();
        c.strokeStyle = withAlpha(ROUTE, alpha);
        c.lineWidth = this.trackWidth(g.kind);
        c.stroke();
      }
      acc += len;
    }
  }

  /** The features' marks on the track. Their labels come later, in order of importance (drawLabels). */
  private drawFeatures(c: Ctx, m: MapModel): void {
    const run = this.ix.run;
    const u = this.u;
    c.lineCap = 'round';

    // Mileposts: faint ticks, only when there's room for them (quarter miles only zoomed in).
    const ppm = this.pxPerMile();
    if (ppm > 55) {
      for (const mp of run.mileposts) {
        if (mp.mile % 1 !== 0 && ppm < 220) continue;
        const p = this.pt(mp.edge, mp.at);
        const nx = -p.ty;
        const ny = p.tx;
        c.beginPath();
        c.moveTo(p.x + nx * 3 * u, p.y + ny * 3 * u);
        c.lineTo(p.x + nx * 7 * u, p.y + ny * 7 * u);
        c.strokeStyle = 'rgba(239,230,210,0.3)';
        c.lineWidth = 1;
        c.stroke();
      }
    }

    // Tunnels: dark bars with portals.
    for (const t of run.tunnels) {
      const g = this.geom.get(t.edge);
      if (!g) continue;
      const w = this.trackWidth(g.kind) + 8 * u;
      c.beginPath();
      this.trace(c, t.edge, t.from, t.to);
      c.lineCap = 'butt';
      c.strokeStyle = 'rgba(239,230,210,0.4)';
      c.lineWidth = w + 2;
      c.stroke();
      c.strokeStyle = TUNNEL;
      c.lineWidth = w;
      c.stroke();
      c.setLineDash([3 * u, 3 * u]);
      c.strokeStyle = 'rgba(239,230,210,0.35)';
      c.lineWidth = 1.2 * u;
      c.stroke();
      c.setLineDash([]);
      for (const off of [t.from, t.to]) {
        const p = this.pt(t.edge, off);
        const L = w / 2 + 3 * u;
        c.beginPath();
        c.moveTo(p.x - p.ty * L, p.y + p.tx * L);
        c.lineTo(p.x + p.ty * L, p.y - p.tx * L);
        c.strokeStyle = TRACK;
        c.lineWidth = 2 * u;
        c.stroke();
      }
      c.lineCap = 'round';
    }

    // Trestles: brown, with flared abutments; burning ones glow.
    for (const t of run.trestles) {
      const g = this.geom.get(t.edge);
      if (!g) continue;
      const w = this.trackWidth(g.kind) + 2 * u;
      c.save();
      if (t.burning) {
        c.shadowColor = '#FF7A2A';
        c.shadowBlur = 10 * u;
      }
      c.beginPath();
      this.trace(c, t.edge, t.from, t.to);
      c.strokeStyle = TRESTLE;
      c.lineWidth = w;
      c.lineCap = 'butt';
      c.stroke();
      c.restore();
      for (const [off, sgn] of [
        [t.from, -1],
        [t.to, 1],
      ] as const) {
        const p = this.pt(t.edge, off);
        const L = w / 2 + 3 * u;
        for (const side of [-1, 1]) {
          const nx = -p.ty * side;
          const ny = p.tx * side;
          const d = t.to >= t.from ? sgn : -sgn;
          c.beginPath();
          c.moveTo(p.x + nx * (w / 2), p.y + ny * (w / 2));
          c.lineTo(p.x + nx * L + p.tx * d * 4 * u, p.y + ny * L + p.ty * d * 4 * u);
          c.strokeStyle = TRESTLE;
          c.lineWidth = 1.8 * u;
          c.stroke();
        }
      }
    }

    // Low bridges: a pair of ticks across the line.
    for (const b of run.lowBridges) {
      const p = this.pt(b.edge, b.at);
      const L = 7 * u;
      for (const k of [-1.6, 1.6]) {
        const ox = p.tx * k * u;
        const oy = p.ty * k * u;
        c.beginPath();
        c.moveTo(p.x + ox - p.ty * L, p.y + oy + p.tx * L);
        c.lineTo(p.x + ox + p.ty * L, p.y + oy - p.tx * L);
        c.strokeStyle = PALETTE.sand;
        c.lineWidth = 1.8 * u;
        c.lineCap = 'butt';
        c.stroke();
      }
      c.lineCap = 'round';
      this.reserve({ x: p.x - L, y: p.y - L, w: 2 * L, h: 2 * L });
    }

    // Curves: a caution line along one side (the limit plate comes with the labels).
    for (const cv of run.curves) {
      const g = this.geom.get(cv.edge);
      if (!g) continue;
      const off = this.trackWidth(g.kind) / 2 + 3.5 * u;
      const steps = 12;
      c.beginPath();
      for (let k = 0; k <= steps; k++) {
        const o = cv.from + ((cv.to - cv.from) * k) / steps;
        const p = this.pt(cv.edge, o);
        const x = p.x - p.ty * off;
        const y = p.y + p.tx * off;
        if (k === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.strokeStyle = withAlpha(PALETTE.signalYellow, 0.85);
      c.lineWidth = 2 * u;
      c.stroke();
    }

    // Signal posts, grey: where the signals stand and which way they face, never what they show.
    for (const s of run.signals) {
      const p = this.pt(s.edge, s.at);
      const d = s.facing; // governs travel in the edge's a→b (1) or b→a (−1) direction
      const hx = p.tx * d;
      const hy = p.ty * d;
      // Right-hand side of the direction it governs.
      const nx = -hy;
      const ny = hx;
      const L = 8 * u;
      const hr = 3.2 * u;
      const color = m.debug?.aspects[s.id] ? aspectColor(m.debug.aspects[s.id]) : SIGNAL_GREY;
      c.beginPath();
      c.moveTo(p.x + nx * 2 * u, p.y + ny * 2 * u);
      c.lineTo(p.x + nx * L, p.y + ny * L);
      c.lineTo(p.x + nx * L + hx * 3 * u, p.y + ny * L + hy * 3 * u);
      c.strokeStyle = SIGNAL_GREY;
      c.lineWidth = 1.5 * u;
      c.stroke();
      c.beginPath();
      c.arc(p.x + nx * L + hx * (3 * u + hr), p.y + ny * L + hy * (3 * u + hr), hr, 0, TAU);
      c.fillStyle = color;
      c.fill();
      if (s.kind === 'junction') {
        c.strokeStyle = SIGNAL_GREY;
        c.lineWidth = 1;
        c.beginPath();
        c.arc(p.x + nx * L + hx * (3 * u + hr), p.y + ny * L + hy * (3 * u + hr), hr + 2 * u, 0, TAU);
        c.stroke();
      }
      this.reserve({ x: p.x + nx * L - hr * 2, y: p.y + ny * L - hr * 2, w: hr * 4 + Math.abs(hx) * 6 * u, h: hr * 4 + Math.abs(hy) * 6 * u });
    }

    // Water towers: a blue tank beside the line.
    for (const w of run.waterTowers) {
      const p = this.pt(w.edge, w.at);
      const n = this.upNormal(p);
      const d = 12 * u;
      const cx = p.x + n.x * d;
      const cy = p.y + n.y * d;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(cx, cy);
      c.strokeStyle = withAlpha(WATER_BLUE, 0.7);
      c.lineWidth = 1.2 * u;
      c.stroke();
      const s = 5 * u;
      c.beginPath();
      c.roundRect(cx - s, cy - s * 1.1, s * 2, s * 1.6, s * 0.4);
      c.fillStyle = WATER_BLUE;
      c.fill();
      c.beginPath();
      c.moveTo(cx - s * 0.7, cy + s * 0.5);
      c.lineTo(cx - s * 0.9, cy + s * 1.3);
      c.moveTo(cx + s * 0.7, cy + s * 0.5);
      c.lineTo(cx + s * 0.9, cy + s * 1.3);
      c.strokeStyle = WATER_BLUE;
      c.lineWidth = 1.2 * u;
      c.stroke();
      this.reserve({ x: cx - s * 1.4, y: cy - s * 1.5, w: s * 2.8, h: s * 3 });
    }

    // Stations: the platform and the stop mark across the line (the name comes with the labels).
    for (const st of run.stations) {
      const p = this.pt(st.edge, st.at);
      const g = this.geom.get(st.edge);
      const half = (st.platform / 2) * this.upm * this.cam.s;
      if (g && half > 2) {
        c.beginPath();
        this.trace(c, st.edge, st.at - st.platform / 2, st.at + st.platform / 2);
        c.strokeStyle = 'rgba(239,230,210,0.35)';
        c.lineWidth = this.trackWidth(g.kind) + 5 * u;
        c.lineCap = 'butt';
        c.stroke();
        c.lineCap = 'round';
      }
      const L = 6 * u;
      c.beginPath();
      c.moveTo(p.x - p.ty * L, p.y + p.tx * L);
      c.lineTo(p.x + p.ty * L, p.y - p.tx * L);
      c.strokeStyle = TRACK;
      c.lineWidth = 2 * u;
      c.stroke();
    }
  }

  private pxPerMile(): number {
    return 1609.34 * this.upm * this.cam.s;
  }

  /** The unit normal at a track point that points up the screen (or left, on vertical track). */
  private upNormal(p: Pt): { x: number; y: number } {
    let x = p.ty;
    let y = -p.tx;
    if (y > 0 || (Math.abs(y) < 1e-6 && x > 0)) {
      x = -x;
      y = -y;
    }
    return { x, y };
  }

  /**
   * Places for a w×h label near a track point, best first: `d` px off the track on the preferred
   * side (+1 = up the screen), then the other side, then further out, then slid along the track.
   */
  private spots(p: Pt, w: number, h: number, d: number, side: 1 | -1): Rect[] {
    const n = this.upNormal(p);
    const out: Rect[] = [];
    const at = (dist: number, sd: number, slide: number): Rect => {
      // How far the box's centre sits from the track so its near edge is `dist` away.
      const reach = dist + Math.abs(n.x) * (w / 2) + Math.abs(n.y) * (h / 2);
      const cx = p.x + n.x * reach * sd + p.tx * slide;
      const cy = p.y + n.y * reach * sd + p.ty * slide;
      return { x: cx - w / 2, y: cy - h / 2, w, h };
    };
    for (const k of [1, 1.8]) for (const sd of [side, -side]) out.push(at(d * k, sd, 0));
    for (const slide of [w * 0.6, -w * 0.6]) for (const sd of [side, -side]) out.push(at(d, sd, slide));
    return out;
  }

  /** Whether a screen point is on the canvas (with a margin): labels for what's off it aren't drawn. */
  private onScreen(p: { x: number; y: number }, margin = 0): boolean {
    return p.x >= -margin && p.y >= -margin && p.x <= this.cam.W + margin && p.y <= this.cam.H + margin;
  }

  /** The first free spot (reserving it), or with `force` the first spot regardless. */
  private place(spots: Rect[], pad = 2, force = false): Rect | null {
    for (const r of spots) if (this.tryPlace(r, pad)) return r;
    if (!force || spots.length === 0) return null;
    const r = { ...spots[0] };
    r.x = Math.max(2, Math.min(this.cam.W - r.w - 2, r.x));
    r.y = Math.max(2, Math.min(this.cam.H - r.h - 2, r.y));
    this.placed.push(r);
    return r;
  }

  /**
   * Every label, most important first so it gets the room: station names and speed limits always
   * show; ends, tunnel and trestle names and milepost numbers only where they fit.
   */
  private drawLabels(c: Ctx, m: MapModel): void {
    const run = this.ix.run;
    const u = this.u;
    const f = m.font;
    const stations = [...run.stations].sort((a, b) => (a.id === m.destination ? -1 : b.id === m.destination ? 1 : 0));
    for (const st of stations) this.stationBox(c, st.name, this.pt(st.edge, st.at), st.id === m.destination, st.checkpoint, m);
    for (const cv of run.curves) this.limitPlate(c, cv.edge, (cv.from + cv.to) / 2, limitMph(cv.limit), m);
    // Slower track beyond a switch (sidings, cutoffs): a plate just past the points, where its limit begins.
    for (const j of run.junctions) {
      const trunk = this.ix.edge.get(j.trunk);
      if (!trunk) continue;
      for (const id of [j.normal, j.reverse]) {
        const leg = this.ix.edge.get(id);
        if (!leg || leg.speedLimit >= trunk.speedLimit) continue;
        const into = Math.min(120, leg.length / 3);
        this.limitPlate(c, leg.id, leg.a === j.node ? into : leg.length - into, limitMph(leg.speedLimit), m);
      }
    }
    // Dead ends: their names beyond the buffers.
    c.font = `${Math.round(f * 0.72)}px ${SANS}`;
    for (const n of run.nodes) {
      const end = this.endOf(n.id);
      if (!end || !n.label) continue;
      const { p, out } = end;
      const w = c.measureText(n.label).width;
      const h = f * 0.95;
      const beyond = 10 * u + w / 2;
      const r0 = { x: p.x + p.tx * out * beyond - w / 2, y: p.y + p.ty * out * beyond - h / 2, w, h };
      const r = this.place([r0, ...this.spots(p, w, h, 8 * u, -1)]);
      if (!r) continue;
      c.fillStyle = 'rgba(239,230,210,0.5)';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(n.label, r.x + w / 2, r.y + h / 2 + 0.5);
    }
    // Named sidings, loops, cutoffs and branches: once per name, on its longest piece of track.
    const named = new Map<string, { id: string; length: number }>();
    for (const e of run.edges) {
      if (e.kind === 'main' || !e.name) continue;
      const best = named.get(e.name);
      if (!best || e.length > best.length) named.set(e.name, { id: e.id, length: e.length });
    }
    for (const [name, e] of named) this.featureLabel(c, e.id, e.length / 2, name, `italic ${Math.round(f * 0.74)}px ${SANS}`, 'rgba(239,230,210,0.55)', 1);
    for (const t of run.tunnels) this.featureLabel(c, t.edge, (t.from + t.to) / 2, t.name, `${Math.round(f * 0.72)}px ${SANS}`, 'rgba(239,230,210,0.62)', 1);
    for (const t of run.trestles) {
      const label = t.burning ? `${t.name} (burning)` : t.name;
      this.featureLabel(c, t.edge, (t.from + t.to) / 2, label, `${Math.round(f * 0.72)}px ${SANS}`, t.burning ? '#FFB27A' : '#D39A70', -1);
    }
    if (this.pxPerMile() > 55) {
      c.font = `${Math.round(f * 0.62)}px ${SANS}`;
      for (const mp of run.mileposts) {
        if (mp.mile % 1 !== 0) continue; // numbers on whole miles only
        const p = this.pt(mp.edge, mp.at);
        const text = String(mp.mile);
        const w = c.measureText(text).width + 2;
        const h = f * 0.75;
        const r = this.place(this.spots(p, w, h, 8 * u, -1).slice(0, 2), 1);
        if (!r) continue;
        c.fillStyle = 'rgba(239,230,210,0.34)';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(text, r.x + w / 2, r.y + h / 2);
      }
    }
  }

  /** A feature's name beside it where there's room (else left off: the Ahead list names it too). */
  private featureLabel(c: Ctx, edge: string, off: number, text: string, font: string, color: string, side: 1 | -1): void {
    const p = this.pt(edge, off);
    c.font = font;
    const w = c.measureText(text).width;
    const h = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? '12') * 1.15;
    const r = this.place(this.spots(p, w, h, 9 * this.u, side));
    if (!r) return;
    c.fillStyle = color;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, r.x + w / 2, r.y + h / 2 + 0.5);
  }

  /** A curve's speed limit on a yellow-rimmed plate (always shown). */
  private limitPlate(c: Ctx, edge: string, off: number, mph: number, m: MapModel): void {
    const p = this.pt(edge, off);
    if (!this.onScreen(p)) return;
    const u = this.u;
    const text = String(mph);
    c.font = `700 ${Math.round(m.font * 0.78)}px ${SANS}`;
    const w = Math.max(c.measureText(text).width + 8 * u, 18 * u);
    const h = m.font * 1.15;
    const r = this.place(this.spots(p, w, h, 8 * u, -1), 2, true);
    if (!r) return;
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, 3 * u);
    c.fillStyle = '#231C0B';
    c.fill();
    c.strokeStyle = PALETTE.signalYellow;
    c.lineWidth = 1.4 * u;
    c.stroke();
    c.fillStyle = PALETTE.signalYellow;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, r.x + r.w / 2, r.y + r.h / 2 + 0.5);
  }

  /** A station's name on a paper box beside its stop mark (always shown), the destination rimmed in brass. */
  private stationBox(c: Ctx, name: string, p: Pt, dest: boolean, checkpoint: boolean, m: MapModel): void {
    if (!this.onScreen(p)) return;
    const u = this.u;
    c.font = `700 ${Math.round(m.font * 0.84)}px ${SANS}`;
    const label = checkpoint ? `${name} ◆` : name;
    const tw = c.measureText(label).width;
    const padX = 6 * u;
    const w = tw + padX * 2 + (dest ? 14 * u : 0);
    const h = m.font * 1.45;
    const r = this.place(this.spots(p, w, h, 12 * u, 1), 3, true);
    if (!r) return;
    // A leader from the stop mark to the nearest point of the box.
    const lx = Math.max(r.x, Math.min(r.x + r.w, p.x));
    const ly = Math.max(r.y, Math.min(r.y + r.h, p.y));
    const len = Math.hypot(lx - p.x, ly - p.y);
    if (len > 6 * u) {
      c.beginPath();
      c.moveTo(p.x + ((lx - p.x) / len) * 6 * u, p.y + ((ly - p.y) / len) * 6 * u);
      c.lineTo(lx, ly);
      c.strokeStyle = 'rgba(239,230,210,0.55)';
      c.lineWidth = 1;
      c.stroke();
    }
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, 3 * u);
    c.fillStyle = PALETTE.paper;
    c.fill();
    if (dest) {
      c.strokeStyle = PALETTE.brass;
      c.lineWidth = 2.5 * u;
      c.stroke();
    }
    c.fillStyle = PALETTE.ink;
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    const cy = r.y + r.h / 2;
    c.fillText(label, r.x + padX + (dest ? 14 * u : 0), cy + 0.5);
    if (dest) drawStar(c, r.x + padX + 5 * u, cy, 5 * u, PALETTE.mesa);
  }

  /** The switch points: the set leg drawn through, the other leg opened. */
  private drawSwitchLegs(c: Ctx, m: MapModel): void {
    const u = this.u;
    for (const j of this.ix.run.junctions) {
      const state = m.switches[j.node] ?? j.initial;
      const set = state === 'normal' ? j.normal : j.reverse;
      const unset = state === 'normal' ? j.reverse : j.normal;
      const node = this.ix.node.get(j.node);
      if (!node) continue;
      const x = this.sx(node.x);
      const y = this.sy(node.y);
      const dSet = this.legDir(j.node, set);
      const dUnset = this.legDir(j.node, unset);
      const dTrunk = this.legDir(j.node, j.trunk);
      const gs = this.geom.get(set);
      const width = gs ? this.trackWidth(gs.kind) : 3 * u;
      const pending = m.pending.has(j.node);
      // The open leg: a gap at the points.
      c.beginPath();
      c.moveTo(x + dUnset.x * 1.5 * u, y + dUnset.y * 1.5 * u);
      c.lineTo(x + dUnset.x * 9 * u, y + dUnset.y * 9 * u);
      c.strokeStyle = BOARD;
      c.lineWidth = width + 2.5 * u;
      c.lineCap = 'butt';
      c.stroke();
      // The set road through the points.
      c.beginPath();
      c.moveTo(x + dTrunk.x * 10 * u, y + dTrunk.y * 10 * u);
      c.lineTo(x, y);
      c.lineTo(x + dSet.x * 16 * u, y + dSet.y * 16 * u);
      c.strokeStyle = pending ? withAlpha(PALETTE.brass, 0.55) : '#F4D48C';
      c.lineWidth = width + 0.8 * u;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.stroke();
    }
  }

  /** Unit screen direction from a junction node along one of its edges. */
  private legDir(nodeId: string, edgeId: string): { x: number; y: number } {
    const g = this.geom.get(edgeId);
    const e = this.ix.edge.get(edgeId);
    if (!g || !e) return { x: 1, y: 0 };
    const fromA = e.a === nodeId;
    const n = g.xs.length;
    const x0 = fromA ? g.xs[0] : g.xs[n - 1];
    const y0 = fromA ? g.ys[0] : g.ys[n - 1];
    const x1 = fromA ? g.xs[1] : g.xs[n - 2];
    const y1 = fromA ? g.ys[1] : g.ys[n - 2];
    const dx = (x1 - x0) * this.cam.s;
    const dy = (y1 - y0) * this.cam.s * this.cam.k;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  }

  /** Labels keep off the rails: the track is reserved as a chain of small boxes along each polyline. */
  private reserveTrack(): void {
    const step = 10 * this.u;
    for (const g of this.geom.values()) {
      const half = this.trackWidth(g.kind) / 2 + 1.5 * this.u;
      for (let i = 1; i < g.xs.length; i++) {
        const x0 = this.sx(g.xs[i - 1]);
        const y0 = this.sy(g.ys[i - 1]);
        const x1 = this.sx(g.xs[i]);
        const y1 = this.sy(g.ys[i]);
        const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
        for (let k = 0; k <= n; k++) {
          const x = x0 + ((x1 - x0) * k) / n;
          const y = y0 + ((y1 - y0) * k) / n;
          this.reserve({ x: x - half, y: y - half, w: half * 2, h: half * 2 });
        }
      }
    }
  }

  /** Where each switch's numbered disc goes: beside the points, away from the diverging leg. Reserved before any label. */
  private reserveDiscs(m: MapModel): void {
    const u = this.u;
    const r = Math.max(10, 10.5 * u);
    const order = [...this.ix.run.junctions].sort((a, b) => (m.numbers.get(a.node) ?? 99) - (m.numbers.get(b.node) ?? 99));
    for (const j of order) {
      const node = this.ix.node.get(j.node);
      if (!node) continue;
      const x = this.sx(node.x);
      const y = this.sy(node.y);
      const dN = this.legDir(j.node, j.normal);
      const dR = this.legDir(j.node, j.reverse);
      let bx = dN.x + dR.x;
      let by = dN.y + dR.y;
      const bl = Math.hypot(bx, by) || 1;
      bx /= bl;
      by /= bl;
      // Best: beside the points, away from where the reverse leg diverges, a little back along the
      // trunk. When a neighbour's disc or the rails are in the way (the two switches of a short
      // loop), try the other side, then further out, then back along the trunk.
      let px = -by;
      let py = bx;
      if (px * dR.x + py * dR.y > 0) {
        px = -px;
        py = -py;
      }
      const d = r + 9 * u;
      const spots: [number, number][] = [
        [px * d - bx * 3 * u, py * d - by * 3 * u],
        [-px * d - bx * 3 * u, -py * d - by * 3 * u],
        [px * d * 1.9 - bx * 3 * u, py * d * 1.9 - by * 3 * u],
        [-px * d * 1.9 - bx * 3 * u, -py * d * 1.9 - by * 3 * u],
        [px * d - bx * d * 1.2, py * d - by * d * 1.2],
        [-px * d - bx * d * 1.2, -py * d - by * d * 1.2],
      ];
      const box = (ox: number, oy: number): Rect => ({ x: x + ox - r - 2, y: y + oy - r - 2, w: 2 * r + 4, h: 2 * r + 4 });
      const free = spots.find(([ox, oy]) => this.discs.every((q) => Math.hypot(q.x - (x + ox), q.y - (y + oy)) >= q.r + r + 3) && this.tryPlace(box(ox, oy), 0));
      const [ox, oy] = free ?? spots[0];
      if (!free) this.reserve(box(ox, oy));
      this.discs.push({ id: j.node, x: x + ox, y: y + oy, r, nx: x, ny: y });
    }
  }

  private drawSwitchDiscs(c: Ctx, m: MapModel): void {
    const u = this.u;
    const view = m.view;
    for (const d of this.discs) {
      const j = this.ix.junction.get(d.id);
      if (!j) continue;
      const { x: cx, y: cy, r, nx: x, ny: y } = d;
      const ll = Math.hypot(cx - x, cy - y) || 1;
      const px = (cx - x) / ll;
      const py = (cy - y) / ll;

      const n = m.numbers.get(j.node) ?? 0;
      const hover = m.hover === j.node;
      const pending = m.pending.has(j.node);
      const fouled = !!view && (fouls(this.ix, view.train.spans, j.node, SWITCH_FOUL_DISTANCE) || view.trains.some((t) => fouls(this.ix, t.spans, j.node, SWITCH_FOUL_DISTANCE)));
      const flash = [...m.flashes].reverse().find((f) => f.junction === j.node && m.now - f.at < 900);
      const ft = flash ? (m.now - flash.at) / 900 : 1;

      // Leader from the disc to the points.
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(cx - px * r, cy - py * r);
      c.strokeStyle = 'rgba(200,161,90,0.6)';
      c.lineWidth = 1.2;
      c.stroke();

      if (flash) {
        const col = flash.kind === 'refused' ? PALETTE.signalRed : '#F4D48C';
        c.beginPath();
        c.arc(cx, cy, r + 3 + ft * 14 * u, 0, TAU);
        c.strokeStyle = withAlpha(col, (1 - ft) * 0.9);
        c.lineWidth = 3 * u;
        c.stroke();
      }
      c.save();
      c.shadowColor = hover ? 'rgba(244,212,140,0.65)' : 'rgba(0,0,0,0.6)';
      c.shadowBlur = hover ? 12 : 4;
      c.shadowOffsetY = hover ? 0 : 1.5;
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      const refusedNow = flash?.kind === 'refused' && ft < 1;
      if (refusedNow) c.fillStyle = PALETTE.signalRed;
      else {
        const g = c.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
        g.addColorStop(0, m.enabled ? '#F2D493' : '#9C8A68');
        g.addColorStop(1, m.enabled ? '#A57E3C' : '#6C5E45');
        c.fillStyle = g;
      }
      c.fill();
      c.restore();
      c.beginPath();
      c.arc(cx, cy, r, 0, TAU);
      c.strokeStyle = hover ? '#FFF3D6' : '#3E2E17';
      c.lineWidth = hover ? 2.2 : 1.4;
      if (pending) c.setLineDash([3, 2.5]);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = PALETTE.ink;
      c.font = `${Math.round(r * 1.05)}px ${RYE}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(n > 0 ? String(n) : '·', cx, cy + r * 0.08);
      if (fouled) {
        // A padlock nub: a train is on the points, the switch won't move.
        const lx = cx + r * 0.72;
        const ly = cy - r * 0.72;
        c.beginPath();
        c.arc(lx, ly, r * 0.42, 0, TAU);
        c.fillStyle = '#2A2118';
        c.fill();
        c.strokeStyle = PALETTE.signalRed;
        c.lineWidth = 1.4;
        c.stroke();
        c.beginPath();
        c.moveTo(lx - r * 0.2, ly);
        c.lineTo(lx + r * 0.2, ly);
        c.strokeStyle = PALETTE.signalRed;
        c.stroke();
      }
    }
  }

  /**
   * Other trains' name tags are placed before any feature label so they always find room (a train
   * in sight matters more than a tunnel's name); they're drawn later, over the track.
   */
  private placeTrainLabels(c: Ctx, m: MapModel): { name: string; r: Rect; ax: number; ay: number }[] {
    const view = m.view;
    if (!view) return [];
    const u = this.u;
    const out: { name: string; r: Rect; ax: number; ay: number }[] = [];
    c.font = `700 ${Math.round(m.font * 0.78)}px ${SANS}`;
    for (const t of view.trains) {
      if (t.spans.length === 0) continue;
      const last = t.spans[t.spans.length - 1];
      const p = this.pt(last.edge, last.to);
      const name = this.aiDefs.get(t.id)?.name ?? t.id;
      const w = c.measureText(name).width + 10 * u;
      const h = m.font * 1.3;
      for (const [ox, oy] of [
        [0, 1],
        [0, -1],
        [-1, 1],
        [1, -1],
      ]) {
        const cx = p.x + ox * (w / 2 + 6 * u);
        const cy = p.y + oy * (15 * u + h / 2);
        const r = { x: cx - w / 2, y: cy - h / 2, w, h };
        if (!this.tryPlace(r)) continue;
        out.push({ name, r, ax: p.x, ay: p.y });
        break;
      }
    }
    return out;
  }

  private drawOtherTrains(c: Ctx, m: MapModel, labels: readonly { name: string; r: Rect; ax: number; ay: number }[]): void {
    const view = m.view;
    if (!view) return;
    const u = this.u;
    for (const t of view.trains) if (t.spans.length > 0) this.drawTrainBody(c, t.spans, OTHER, '#FFD3C4', 6 * u);
    c.font = `700 ${Math.round(m.font * 0.78)}px ${SANS}`;
    for (const l of labels) {
      const { r } = l;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      c.beginPath();
      c.moveTo(l.ax, l.ay);
      c.lineTo(Math.max(r.x, Math.min(r.x + r.w, l.ax)), l.ay < r.y ? r.y : r.y + r.h);
      c.strokeStyle = withAlpha(OTHER, 0.8);
      c.lineWidth = 1.2;
      c.stroke();
      c.beginPath();
      c.roundRect(r.x, r.y, r.w, r.h, 3 * u);
      c.fillStyle = 'rgba(40,14,8,0.92)';
      c.fill();
      c.strokeStyle = OTHER;
      c.stroke();
      c.fillStyle = '#FFD3C4';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(l.name, cx, cy + 0.5);
    }
  }

  private drawTrain(c: Ctx, m: MapModel): void {
    const view = m.view;
    if (!view || view.train.spans.length === 0) return;
    const u = this.u;
    const spans = view.train.spans;
    const last = spans[spans.length - 1];
    const p = this.pt(last.edge, last.to);
    // A locator ring so the train is found at a glance, even when it's only a few pixels long.
    const pulse = (m.now / 1000) % 2;
    c.beginPath();
    c.arc(p.x, p.y, 13 * u + pulse * 3 * u, 0, TAU);
    c.strokeStyle = withAlpha(TRAIN, 0.28 * (1 - pulse / 2));
    c.lineWidth = 2 * u;
    c.stroke();
    this.drawTrainBody(c, spans, TRAIN, '#FFF4D6', 7 * u);
  }

  /** A train as a thick bar along its spans with an arrowhead at its front. */
  private drawTrainBody(c: Ctx, spans: readonly Span[], color: string, head: string, width: number): void {
    const u = this.u;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    this.traceSpans(c, spans);
    c.strokeStyle = '#0B0908';
    c.lineWidth = width + 3.5 * u;
    c.stroke();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
    const last = spans[spans.length - 1];
    const p = this.pt(last.edge, last.to);
    const d = spanDir(last);
    const hx = p.tx * d;
    const hy = p.ty * d;
    const L = width * 1.5;
    const W = width * 1.05;
    c.beginPath();
    c.moveTo(p.x + hx * L, p.y + hy * L);
    c.lineTo(p.x - hy * W, p.y + hx * W);
    c.lineTo(p.x + hy * W, p.y - hx * W);
    c.closePath();
    c.fillStyle = head;
    c.fill();
    c.strokeStyle = '#0B0908';
    c.lineWidth = 1.5 * u;
    c.stroke();
  }

  private drawFlags(c: Ctx, m: MapModel): void {
    const view = m.view;
    if (!view) return;
    const u = this.u;
    for (const fl of view.flags) {
      const age = Math.max(0, (view.tick - fl.tick) / TICK_HZ);
      const fade = Math.max(0.35, 1 - age / FLAG_TTL_SECONDS);
      const p = this.pt(fl.point.edge, fl.point.off);
      const top = 22 * u;
      c.globalAlpha = fade;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x, p.y - top);
      c.strokeStyle = '#F4EDDC';
      c.lineWidth = 1.6 * u;
      c.stroke();
      c.beginPath();
      c.moveTo(p.x, p.y - top);
      c.lineTo(p.x + 13 * u, p.y - top + 4.5 * u);
      c.lineTo(p.x, p.y - top + 9 * u);
      c.closePath();
      c.fillStyle = PALETTE.signalRed;
      c.fill();
      c.font = `700 ${Math.round(m.font * 0.72)}px ${SANS}`;
      c.fillStyle = '#FFB4A6';
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(`${Math.round(age)} s`, p.x + 15 * u, p.y - top + 4.5 * u);
      c.globalAlpha = 1;
      c.beginPath();
      c.arc(p.x, p.y, 2.5 * u, 0, TAU);
      c.fillStyle = PALETTE.signalRed;
      c.fill();
    }
  }

  private drawDebug(c: Ctx, m: MapModel, info: DebugInfo): void {
    const u = this.u;
    c.font = `700 ${Math.round(m.font * 0.7)}px ${SANS}`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    for (const o of info.obstacles) {
      if (!this.geom.has(o.edge)) continue;
      const p = this.pt(o.edge, o.at);
      const s = 5 * u;
      c.beginPath();
      c.moveTo(p.x - s, p.y - s);
      c.lineTo(p.x + s, p.y + s);
      c.moveTo(p.x + s, p.y - s);
      c.lineTo(p.x - s, p.y + s);
      c.strokeStyle = o.state === 'present' ? '#FF4FD8' : 'rgba(255,79,216,0.45)';
      c.lineWidth = 2.5 * u;
      c.stroke();
      const text = `${o.kind} (${o.state})`;
      const tw = c.measureText(text).width + 8 * u;
      const th = m.font * 1.05;
      c.fillStyle = 'rgba(40,6,34,0.9)';
      c.fillRect(p.x - tw / 2, p.y - s - 4 * u - th, tw, th);
      c.fillStyle = '#FF9BEA';
      c.fillText(text, p.x, p.y - s - 4 * u - th * 0.12);
    }
    c.textAlign = 'left';
    c.textBaseline = 'top';
    c.fillStyle = '#FF9BEA';
    c.fillText(`DEBUG · bandits ${info.bandits} · horsemen ${info.horsemen}`, 8 * u, 8 * u);
  }

  private drawTooltip(c: Ctx, W: number, H: number, m: MapModel, id: string): void {
    const j = this.ix.junction.get(id);
    const disc = this.discs.find((d) => d.id === id);
    if (!j || !disc) return;
    const u = this.u;
    const state = m.switches[id] ?? j.initial;
    const n = m.numbers.get(id);
    const leg = this.ix.edge.get(state === 'normal' ? j.normal : j.reverse);
    const legName = leg?.name ?? (leg ? leg.kind : '');
    const view = m.view;
    const fouled = !!view && (fouls(this.ix, view.train.spans, id, SWITCH_FOUL_DISTANCE) || view.trains.some((t) => fouls(this.ix, t.spans, id, SWITCH_FOUL_DISTANCE)));
    const lines = [
      `${n ? `Switch ${n} · ` : ''}${j.name}`,
      `Set ${state}${legName ? ` → ${legName}` : ''}`,
      fouled ? 'A train is on the points: it won’t move' : m.enabled ? `Click${n && n <= 9 ? ` or press ${n}` : ''} to throw` : 'Controls are locked',
    ];
    c.font = `700 ${Math.round(m.font * 0.86)}px ${SANS}`;
    const w0 = c.measureText(lines[0]).width;
    c.font = `${Math.round(m.font * 0.8)}px ${SANS}`;
    const w = Math.max(w0, c.measureText(lines[1]).width, c.measureText(lines[2]).width) + 16 * u;
    const lh = m.font * 1.25;
    const h = lh * 3 + 10 * u;
    let x = disc.x + disc.r + 8 * u;
    let y = disc.y - h / 2;
    if (x + w > W - 4) x = disc.x - disc.r - 8 * u - w;
    y = Math.max(4, Math.min(H - h - 4, y));
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 10;
    c.beginPath();
    c.roundRect(x, y, w, h, 5 * u);
    c.fillStyle = 'rgba(28,23,18,0.96)';
    c.fill();
    c.restore();
    c.strokeStyle = 'rgba(200,161,90,0.6)';
    c.lineWidth = 1;
    c.stroke();
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.fillStyle = '#F4D48C';
    c.font = `700 ${Math.round(m.font * 0.86)}px ${SANS}`;
    c.fillText(lines[0], x + 8 * u, y + 5 * u + lh / 2);
    c.font = `${Math.round(m.font * 0.8)}px ${SANS}`;
    c.fillStyle = PALETTE.paper;
    c.fillText(lines[1], x + 8 * u, y + 5 * u + lh * 1.5);
    c.fillStyle = fouled ? '#FF9A86' : 'rgba(239,230,210,0.6)';
    c.fillText(lines[2], x + 8 * u, y + 5 * u + lh * 2.5);
  }
}

function aspectColor(a: string): string {
  if (a === 'stop') return PALETTE.signalRed;
  if (a === 'clear' || a === 'divergeClear') return PALETTE.signalGreen;
  return PALETTE.signalYellow;
}

function drawStar(c: Ctx, x: number, y: number, r: number, color: string): void {
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.45;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) c.moveTo(px, py);
    else c.lineTo(px, py);
  }
  c.closePath();
  c.fillStyle = color;
  c.fill();
}
