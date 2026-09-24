// The rulebook (spec §9, §11): signal aspects drawn by day (semaphore arms and lamps) and by night
// (the lamps alone), what each means, the speed rules, and the run's timetable as a table. The
// Engineer never sees a real signal: this page is how they make sense of what the Rider calls out.

import { netIndex } from '../../sim/network';
import { APPROACH_LIMIT, BUFFER_SAFE, DERAIL_FACTOR, DERAIL_INSTANT, DERAIL_SECONDS, DIVERGE_LIMIT, DWELL_SECONDS, OVERSPEED_WARN, RED_SIGNAL_FINE, SPEED_FINE, SPEED_FINE_TOLERANCE, SPOUT_WINDOW, STATION_WINDOW, SWITCH_FOUL_DISTANCE } from '../../sim/rules';
import type { Aspect, EngineerRun } from '../../sim/types';
import { PALETTE } from '../palette';
import { formatClock, formatMoney, limitMph } from './format';
import { lineTimeAt, scheduleLine, sidingBands, type LinePt } from './marey';

type Ctx = CanvasRenderingContext2D;
type Arm = 0 | 45 | 90;

const TAU = Math.PI * 2;

/** Arm positions per head (upper first) for each aspect (spec §9.1). */
const ARMS: Record<Aspect, { one: Arm | null; two: [Arm, Arm] }> = {
  stop: { one: 0, two: [0, 0] },
  approach: { one: 45, two: [45, 0] },
  clear: { one: 90, two: [90, 0] },
  divergeApproach: { one: null, two: [0, 45] },
  divergeClear: { one: null, two: [0, 90] },
};

const LAMP: Record<Arm, { color: string; letter: string }> = {
  0: { color: PALETTE.signalRed, letter: 'R' },
  45: { color: PALETTE.signalYellow, letter: 'Y' },
  90: { color: PALETTE.signalGreen, letter: 'G' },
};

const ROWS: { aspect: Aspect; name: string; rule: string }[] = [
  { aspect: 'stop', name: 'Stop', rule: `Stop before the signal. Passing it costs ${formatMoney(RED_SIGNAL_FINE)}.` },
  { aspect: 'approach', name: 'Approach', rule: `Proceed at ${limitMph(APPROACH_LIMIT)} mph or less until the next signal.` },
  { aspect: 'clear', name: 'Clear', rule: 'Proceed at track speed.' },
  { aspect: 'divergeApproach', name: 'Diverging approach', rule: `The switch is set for the diverging road. ${limitMph(APPROACH_LIMIT)} mph or less until the next signal.` },
  { aspect: 'divergeClear', name: 'Diverging clear', rule: `The switch is set for the diverging road. ${limitMph(DIVERGE_LIMIT)} mph or less through the junction.` },
];

/**
 * One signal picture: a mast with one or two arms and their lamps (day), or the lamps alone on a
 * night sky. Arms point right of the mast; 0° is horizontal, 45° and 90° raised (upper quadrant).
 */
export function drawSignal(c: Ctx, w: number, h: number, arms: readonly Arm[], night: boolean, letters: boolean): void {
  const g = c.createLinearGradient(0, 0, 0, h);
  if (night) {
    g.addColorStop(0, '#0B1026');
    g.addColorStop(1, '#1F2A44');
  } else {
    g.addColorStop(0, '#A9CBE6');
    g.addColorStop(1, '#EFE3C4');
  }
  c.fillStyle = g;
  c.beginPath();
  c.roundRect(0, 0, w, h, Math.min(w, h) * 0.08);
  c.fill();
  const mx = w * 0.4;
  const mastW = Math.max(2, w * 0.06);
  const top = h * 0.12;
  const armLen = w * 0.46;
  const armW = Math.max(3, h * 0.07);
  const lampR = Math.max(3, Math.min(w * 0.12, h * 0.085));
  const pivots = arms.length === 1 ? [h * 0.26] : [h * 0.24, h * 0.56];
  if (!night) {
    // Mast, finial and ground.
    c.fillStyle = '#2B2B2E';
    c.fillRect(mx - mastW / 2, top, mastW, h * 0.86 - top);
    c.beginPath();
    c.arc(mx, top, mastW * 0.9, 0, TAU);
    c.fill();
    c.fillStyle = 'rgba(90,70,40,0.5)';
    c.fillRect(0, h * 0.86, w, h * 0.14);
  }
  arms.forEach((arm, i) => {
    const py = pivots[i];
    const lamp = LAMP[arm];
    // The lamp sits left of the mast, level with its arm's pivot.
    const lx = mx - mastW / 2 - lampR * 1.6;
    if (!night) {
      c.save();
      c.translate(mx, py);
      c.rotate((-arm * Math.PI) / 180);
      c.fillStyle = '#B8322A';
      c.fillRect(0, -armW / 2, armLen, armW);
      c.fillStyle = '#F4EDDC';
      c.fillRect(armLen * 0.72, -armW / 2, armLen * 0.1, armW);
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1;
      c.strokeRect(0, -armW / 2, armLen, armW);
      c.restore();
      c.beginPath();
      c.arc(mx, py, mastW * 0.8, 0, TAU);
      c.fillStyle = '#1A1A1A';
      c.fill();
      // Lamp housing.
      c.beginPath();
      c.arc(lx, py, lampR * 1.35, 0, TAU);
      c.fillStyle = '#2B2B2E';
      c.fill();
    }
    c.save();
    c.shadowColor = lamp.color;
    c.shadowBlur = night ? lampR * 3 : lampR * 1.2;
    c.beginPath();
    c.arc(lx, py, lampR, 0, TAU);
    c.fillStyle = lamp.color;
    c.fill();
    c.restore();
    if (letters) {
      c.fillStyle = '#1A140E';
      c.font = `700 ${Math.round(lampR * 1.35)}px "Alegreya Sans", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(lamp.letter, lx, py + lampR * 0.08);
    }
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

interface SignalCanvas {
  canvas: HTMLCanvasElement;
  arms: Arm[];
  night: boolean;
}

export class Rulebook {
  readonly el: HTMLElement;
  private readonly canvases: SignalCanvas[] = [];
  private drawnKey = '';

  constructor(
    private readonly run: EngineerRun,
    private letters: boolean,
    onClose: () => void,
  ) {
    this.el = el('section', 'desk-rulebook');
    this.el.hidden = true;
    this.el.setAttribute('aria-label', 'Rulebook');
    const head = el('header', 'rb-head');
    const title = el('h2', 'rb-title', 'Rulebook');
    const sub = el('span', 'rb-sub', 'Signals are for the Rider’s eyes. Your desk never shows them: ask.');
    const close = el('button', 'desk-btn rb-close');
    close.type = 'button';
    close.innerHTML = 'Close <kbd>Tab</kbd>';
    close.addEventListener('click', onClose);
    head.append(title, sub, close);

    const body = el('div', 'rb-body');
    body.append(this.buildSignals(), this.buildRules());
    this.el.append(head, body);
  }

  private buildSignals(): HTMLElement {
    const sec = el('div', 'rb-col rb-signals');
    sec.append(el('h3', undefined, 'Signal aspects'));
    const table = el('table', 'rb-aspects');
    const thead = el('thead');
    const r1 = el('tr');
    r1.append(el('th'), Object.assign(el('th', 'rb-group', 'One head'), { colSpan: 2 }), Object.assign(el('th', 'rb-group', 'Two heads'), { colSpan: 2 }), el('th'));
    const r2 = el('tr', 'rb-daynight');
    r2.append(el('th'), el('th', undefined, 'Day'), el('th', undefined, 'Night'), el('th', undefined, 'Day'), el('th', undefined, 'Night'), el('th', 'rb-meaning-h', 'Meaning'));
    thead.append(r1, r2);
    const tbody = el('tbody');
    for (const row of ROWS) {
      const tr = el('tr');
      tr.append(el('th', 'rb-aspect', row.name));
      const a = ARMS[row.aspect];
      for (const heads of [1, 2] as const) {
        for (const night of [false, true]) {
          const td = el('td', 'rb-pic');
          const arms = heads === 1 ? (a.one === null ? null : [a.one]) : [...a.two];
          if (arms) {
            const canvas = el('canvas');
            canvas.setAttribute('role', 'img');
            canvas.setAttribute('aria-label', `${row.name}, ${heads === 1 ? 'one head' : 'two heads'}, ${night ? 'night' : 'day'}`);
            td.append(canvas);
            this.canvases.push({ canvas, arms, night });
          } else {
            td.append(el('span', 'rb-none', '—'));
          }
          tr.append(td);
        }
      }
      tr.append(el('td', 'rb-rule', row.rule));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    sec.append(table);
    const note = el('p', 'rb-note', 'Two heads guard a junction: the upper arm speaks for the straight road, the lower for the diverging one. Throw the switch, then ask the Rider to read it again.');
    sec.append(note);
    return sec;
  }

  private buildRules(): HTMLElement {
    const sec = el('div', 'rb-col rb-rules');
    sec.append(el('h3', undefined, 'Rules of the road'));
    const ul = el('ul', 'rb-list');
    const items: [string, string][] = [
      ['Speed limits', `Posted on the map and in the Ahead list. ${Math.round((OVERSPEED_WARN - 1) * 100)}% over and the wheels squeal; ${Math.round((DERAIL_FACTOR - 1) * 100)}% over for ${DERAIL_SECONDS} s, or ${Math.round((DERAIL_INSTANT - 1) * 100)}% over at once, and she derails.`],
      ['Caution signals', `After an approach aspect, keep under ${limitMph(APPROACH_LIMIT)} mph to the next signal (${formatMoney(SPEED_FINE)} fine over ${limitMph(APPROACH_LIMIT * SPEED_FINE_TOLERANCE)} mph).`],
      ['Stations', `Stop the loco's front within ${STATION_WINDOW} m of the mark and stand ${DWELL_SECONDS} s.`],
      ['Water', `Stop with the tender hatch within ${SPOUT_WINDOW} m of the spout. The Rider lowers it.`],
      ['Switches', `Won't move with a train within ${SWITCH_FOUL_DISTANCE} m of the points. Running through one set against you springs it over.`],
      ['End of track', `Reach the buffers under ${Math.max(1, limitMph(BUFFER_SAFE))} mph.`],
      ['Reverser', 'Moves only when the train is stopped. Space throws the emergency brake.'],
      ['Hands up', 'With a gun on you only the whistle works, until the Rider clears the cab.'],
    ];
    for (const [k, v] of items) {
      const li = el('li');
      li.append(el('b', undefined, `${k}. `), document.createTextNode(v));
      ul.append(li);
    }
    sec.append(ul);
    sec.append(el('h3', undefined, 'Timetable'));
    sec.append(this.buildTimetable());
    return sec;
  }

  private buildTimetable(): HTMLElement {
    const run = this.run;
    const ix = netIndex(run);
    const wrap = el('div', 'rb-timetable');
    const trains = run.aiTrains.filter((t) => t.charted && t.route.length > 0);
    const dest = run.stations.find((s) => s.id === run.contract.destination);
    const contract = el('p', 'rb-contract');
    const destName = dest?.name ?? 'the destination';
    const where = run.contract.title.includes(destName) ? '' : ` to ${destName}`;
    contract.append(el('b', undefined, 'Your orders. '), document.createTextNode(`${run.contract.title}${where}, by ${formatClock(run.contract.deadline)}.`));
    if (trains.length === 0) {
      wrap.append(contract, el('p', 'rb-note', 'No other trains are scheduled on this line.'));
      return wrap;
    }
    type Place = { name: string; lo: number; hi: number; siding: boolean };
    const places: Place[] = [];
    for (const s of run.stations) {
      const e = ix.edge.get(s.edge);
      if (!e?.mainAt) continue;
      const m = e.mainAt[0] + ((e.mainAt[1] - e.mainAt[0]) * s.at) / e.length;
      places.push({ name: s.name, lo: m, hi: m, siding: false });
    }
    for (const b of sidingBands(run)) places.push({ name: b.name, lo: b.lo, hi: b.hi, siding: true });
    places.sort((a, b) => a.lo - b.lo || a.hi - b.hi);

    const lines = trains.map((t) => ({ def: t, pts: scheduleLine(ix, t, t.depart, t.depart + 24 * 3600) }));
    const table = el('table', 'rb-tt');
    const head = el('tr');
    head.append(el('th', undefined, 'At'));
    for (const l of lines) {
      const th = el('th');
      // Where it's bound: the last station it passes on this map.
      let bound: string | null = null;
      let latest = -Infinity;
      for (const p of places) {
        const t = p.siding ? null : lineTimeAt(l.pts, p.lo);
        if (t !== null && t > latest) {
          latest = t;
          bound = p.name;
        }
      }
      const toward = bound ? `toward ${bound}, ` : '';
      th.append(el('span', 'rb-train', l.def.name), el('span', 'rb-dir', `${toward}${limitMph(l.def.speed)} mph`));
      head.append(th);
    }
    const thead = el('thead');
    thead.append(head);
    const tbody = el('tbody');
    for (const p of places) {
      const tr = el('tr', p.siding ? 'rb-siding' : '');
      tr.append(el('th', undefined, p.name));
      for (const l of lines) tr.append(el('td', undefined, visitText(l.pts, p)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    wrap.append(table, contract);
    return wrap;
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  setOpen(on: boolean): void {
    this.el.hidden = !on;
    if (on) this.draw();
  }

  /** Draws (or redraws after a resize) the signal pictures at the canvases' current size. */
  draw(): void {
    if (this.el.hidden) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const first = this.canvases[0]?.canvas.getBoundingClientRect();
    const key = `${first?.width}|${first?.height}|${dpr}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;
    for (const sc of this.canvases) {
      const r = sc.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      sc.canvas.width = Math.round(w * dpr);
      sc.canvas.height = Math.round(h * dpr);
      const c = sc.canvas.getContext('2d');
      if (!c) continue;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSignal(c, w, h, sc.arms, sc.night, this.letters);
    }
  }

  /** Letters on the lamps, for colour-blind players (a setting that can change mid-run). */
  setLetters(on: boolean): void {
    if (on === this.letters) return;
    this.letters = on;
    this.invalidate();
  }

  /** Forget the drawn size (fonts loaded, layout changed). */
  invalidate(): void {
    this.drawnKey = '';
    this.draw();
  }
}

/** "9:08" or "9:08–9:09" (a dwell, or the time through a siding), "—" if the train doesn't pass. */
function visitText(pts: readonly LinePt[], p: { lo: number; hi: number; siding: boolean }): string {
  const a = lineTimeAt(pts, p.lo);
  const b = p.siding ? lineTimeAt(pts, p.hi) : a;
  if (a === null && b === null) return '—';
  let t0 = Math.min(a ?? Infinity, b ?? Infinity);
  let t1 = Math.max(a ?? -Infinity, b ?? -Infinity);
  if (!p.siding) {
    // A stop: how long the line stays at this distance.
    for (let i = 1; i < pts.length; i++) {
      const q0 = pts[i - 1];
      const q1 = pts[i];
      if (q0.m !== null && q1.m !== null && Math.abs(q0.m - p.lo) < 1 && Math.abs(q1.m - p.lo) < 1 && q1.t > t1) t1 = q1.t;
    }
  }
  t0 = Math.floor(t0 / 60) * 60;
  const s0 = clockShort(t0);
  const s1 = clockShort(t1);
  return t1 - t0 >= 60 && s0 !== s1 ? `${s0}–${s1}` : s0;
}

function clockShort(t: number): string {
  return formatClock(t).replace(/ (AM|PM)$/, '');
}
