// The desk's DOM panels (spec §11): the header, the Ahead list, the precision-stop readout, the
// Rider's whereabouts, the log and the telegraph. Each builds its element once and updates it from
// a snapshot, touching the DOM only where something changed. What an Ahead row says is a pure
// function (aheadRow), so tests/desk.test.ts reads it under Node.

import type { NetIndex } from '../../sim/network';
import { CAR_SPECS, BUFFER_SAFE } from '../../sim/rules';
import type { CarType, EngineerRun, EngineerView } from '../../sim/types';
import { slowAdvice, TRAIN_HAZARDS, type AheadItem, type StopTarget } from './ahead';
import { btn, capitalise, el, escapeHtml, kbd, setClass, setHtml, setText } from './dom';
import { lossText, type LogTone } from './events';
import { clockParts, formatClock, formatDistance, formatEta, formatMoney, formatRemaining, formatYards, limitMph, toMph, windowYards } from './format';
import { ICONS } from './icons';

/** Rows in the Ahead list (spec §11). */
export const AHEAD_ROWS = 6;
/** ETAs below these (s) are called out in yellow, then red. */
const SOON_S = 10;
const IMMINENT_S = 4;
/** Below this speed (m/s) the train is standing: an ETA means nothing. */
const STANDING = 0.3;
/** Log lines kept. */
const LOG_MAX = 80;
/** Lines with the same key within this much game time merge (s). */
const LOG_MERGE_S = 8;

function panel(cls: string, title: string): { root: HTMLElement; head: HTMLElement; h2: HTMLElement } {
  const root = el('section', `desk-panel ${cls}`);
  const head = el('div', 'desk-panel-head');
  const h2 = el('h2', undefined, title);
  head.append(h2);
  root.append(head);
  return { root, head, h2 };
}

// ---------------------------------------------------------------------------------------------
// Header: the clock, the run, the contract, time left, fines and the cargo
// ---------------------------------------------------------------------------------------------

export class HeaderPanel {
  readonly el: HTMLElement;
  private readonly time: HTMLElement;
  private readonly ampm: HTMLElement;
  private readonly contract: HTMLElement;
  private readonly jobs: HTMLElement;
  private readonly left: { box: HTMLElement; lbl: HTMLElement; val: HTMLElement };
  private readonly fines: { box: HTMLElement; lbl: HTMLElement; val: HTMLElement };
  private readonly cargo: { box: HTMLElement; lbl: HTMLElement; val: HTMLElement };
  private jobsKey = '';

  constructor(
    private readonly run: EngineerRun,
    onPause: () => void,
  ) {
    this.el = el('header', 'desk-head');
    const clock = el('div', 'dh-clock');
    this.time = el('span', 'dh-time', '—');
    this.ampm = el('span', 'dh-ampm');
    clock.append(this.time, this.ampm);
    const runBox = el('div', 'dh-run');
    this.contract = el('div', 'dh-contract');
    runBox.append(el('div', 'dh-runname', run.name), this.contract);
    // Side jobs (spec §12) ride along on the contract line as small chips.
    this.jobs = el('span', 'dh-jobs');
    const stat = (label: string): { box: HTMLElement; lbl: HTMLElement; val: HTMLElement } => {
      const box = el('div', 'dh-stat');
      const lbl = el('span', 'dk-lbl', label);
      const val = el('span', 'dk-val', '—');
      box.append(lbl, val);
      return { box, lbl, val };
    };
    this.left = stat('Time left');
    this.fines = stat('Fines');
    this.cargo = stat(capitalise(run.contract.cargo));
    const pause = btn('desk-btn dh-pause', `Pause ${kbd('Esc')}`, onPause);
    this.el.append(clock, runBox, this.left.box, this.fines.box, this.cargo.box, pause);

    // "Mail for Coyote Bend · due 9:16 AM", naming the destination only when the title doesn't.
    const c = run.contract;
    const dest = run.stations.find((s) => s.id === c.destination)?.name ?? 'the destination';
    this.contract.append(document.createTextNode(c.title));
    if (!c.title.includes(dest)) this.contract.append(document.createTextNode(' to '), el('b', undefined, dest));
    this.contract.append(document.createTextNode(' · due '), el('b', undefined, formatClock(c.deadline)), this.jobs);
  }

  update(view: EngineerView, recovered: boolean): void {
    const p = clockParts(view.clock);
    setText(this.time, p.hm);
    setText(this.ampm, p.ampm);
    const L = this.left;
    if (view.phase === 'won') {
      setText(L.lbl, 'Contract');
      setText(L.val, 'Arrived');
      setClass(L.box, 'dk-overdue', false);
      setClass(L.box, 'dk-good', true);
    } else if (view.phase === 'lost') {
      setText(L.lbl, 'Run over');
      setText(L.val, view.loss ? lossText(view.loss.reason) : 'Lost');
      setClass(L.box, 'dk-overdue', true);
      setClass(L.box, 'dk-good', false);
    } else {
      const r = formatRemaining(this.run.contract.deadline - view.clock);
      setText(L.lbl, r.overdue ? 'Late by' : 'Time left');
      setText(L.val, r.text.split(' ')[0]);
      setClass(L.box, 'dk-overdue', r.overdue);
      setClass(L.box, 'dk-good', false);
    }
    this.updateJobs(view);
    setText(this.fines.val, formatMoney(view.fines));
    setClass(this.fines.box, 'dk-bad', view.fines > 0);
    setClass(this.fines.box, 'dk-zero', view.fines === 0);
    const stolen = view.cargo === 'stolen';
    setText(this.cargo.val, stolen ? 'Stolen!' : recovered ? 'Recovered' : 'Aboard');
    setClass(this.cargo.box, 'dk-bad', stolen);
    setClass(this.cargo.box, 'dk-good', !stolen && recovered);
  }

  private updateJobs(view: EngineerView): void {
    const key = view.sideJobs.map((j) => `${j.id}:${j.state}`).join('|');
    if (key === this.jobsKey) return;
    this.jobsKey = key;
    this.jobs.innerHTML = '';
    const name = (id: string): string => this.run.stations.find((x) => x.id === id)?.name ?? id;
    for (const def of this.run.sideJobs) {
      const st = view.sideJobs.find((j) => j.id === def.id)?.state ?? 'pending';
      const chip = el('span', `dh-job dk-${st}`);
      chip.title = `${def.title}: ${name(def.from)} → ${name(def.to)}, ${formatMoney(def.pay)}`;
      chip.textContent = `${def.title} · ${st === 'pending' ? `wait at ${name(def.from)}` : st === 'aboard' ? `to ${name(def.to)}` : 'done'}`;
      this.jobs.append(chip);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The Ahead list: what the Engineer reads out
// ---------------------------------------------------------------------------------------------

/** What one row of the Ahead list says: HTML for the name and the line under it, text for the rest. */
export interface AheadRowText {
  /** The row's classes: its kind, and how close it is (dk-soon, dk-imminent, or dk-here while the train is on it). */
  cls: string;
  name: string;
  detail: string;
  eta: string;
  dist: string;
  /** The longer explanation, on hover. */
  title: string;
}

/** A standing train this close to a signal (m) is waiting at it: the Rider reads it from there. */
const AT_SIGNAL = 100;

/**
 * One row of the Ahead list for an item, with the train running toward it at `speed` (m/s). The
 * switch `numbers` and the network (for the names of the legs beyond a switch) come from the desk.
 */
export function aheadRow(it: AheadItem, speed: number, ix: NetIndex, numbers: ReadonlyMap<string, number>): AheadRowText {
  const inside = it.until !== undefined;
  const secs = speed > STANDING ? it.dist / speed : Infinity;
  const brake = it.limit !== undefined && slowAdvice(it.dist, speed, it.limit) === 'brake';
  const urgency = inside ? ' dk-here' : brake || secs <= IMMINENT_S ? ' dk-imminent' : secs <= SOON_S ? ' dk-soon' : '';
  return {
    cls: `ah-row ah-${it.kind}${urgency}`,
    name: aheadName(it, numbers),
    detail: aheadDetail(it, speed, ix),
    eta: inside ? 'now' : formatEta(it.dist, speed),
    // The hazards to the people aboard hold until the whole train is past them.
    dist: inside ? `${TRAIN_HAZARDS.has(it.kind) ? 'clear in' : 'out in'} ${formatDistance(it.until ?? 0)}` : formatDistance(it.dist),
    title: aheadTitle(it),
  };
}

function aheadName(it: AheadItem, numbers: ReadonlyMap<string, number>): string {
  switch (it.kind) {
    case 'curve':
      return `Curve <span class="dk-plate">${limitMph(it.limit ?? 0)} mph</span>`;
    case 'junction': {
      const n = numbers.get(it.id);
      return `${n ? `<span class="dk-num">${n}</span>` : ''}${escapeHtml(it.name)}`;
    }
    case 'station':
      return `${escapeHtml(it.name)}${it.destination ? ' ★' : ''}`;
    default:
      return escapeHtml(it.name);
  }
}

/** The line under the name: what it means for the train, and the call to make to the Rider. */
function aheadDetail(it: AheadItem, speed: number, ix: NetIndex): string {
  const len = it.length !== undefined ? formatDistance(it.length) : '';
  switch (it.kind) {
    // The calls for the people aboard (spec §4.3): down for tunnels, up for fords, duck for beams,
    // inside for a burning trestle.
    case 'tunnel':
      return `Tunnel, ${len}: <span class="dk-warn">get down</span>`;
    case 'ford':
      return `Ford, ${len}: <span class="dk-warn">get up top</span>`;
    case 'lowBridge':
      return '<span class="dk-warn">Low beam: duck up top</span>';
    case 'trestle':
      return it.minSpeed !== undefined
        ? `<span class="${toMph(speed) < limitMph(it.minSpeed) ? 'dk-bad' : 'dk-warn'}">Burning! Cross at ${limitMph(it.minSpeed)} mph or more</span> · <span class="dk-warn">get inside</span>`
        : `Trestle, ${len}`;
    case 'curve':
      return `${len} long${advice(it, speed)}`;
    case 'signal':
      // Read as the train passes (spec §9.1), except a junction signal: read before the switch, a
      // red there means the road it's set for is blocked, so throw the switch and ask again.
      if (it.guards) return 'Ask early. <span class="dk-warn">Red</span>: the road set is blocked';
      return speed <= STANDING && it.dist <= AT_SIGNAL ? 'What does it show now?' : 'As it passes: what does it show?';
    case 'junction': {
      const j = it.junction;
      if (!j) return '';
      if (!j.facing) return j.against ? '<span class="dk-warn">Trailing: it will spring over</span>' : 'Trailing through';
      const leg = ix.edge.get(j.leg);
      const legName = leg?.name ?? leg?.kind ?? '';
      // Onto slower track (a siding, a cutoff): its limit holds from the moment the loco crosses.
      // The switch's name already says where it leads, so the limit takes the leg name's place.
      if (it.limit !== undefined) return `Set <b>${j.state}</b> · <span class="dk-plate">${limitMph(it.limit)} mph</span> beyond${advice(it, speed)}`;
      return `Set <b>${j.state}</b>${legName ? ` → ${escapeHtml(legName)}` : ''}`;
    }
    case 'station': {
      const tags = [it.destination ? 'destination' : '', it.checkpoint ? 'checkpoint' : '', it.waterColumn ? 'water column' : ''].filter(Boolean);
      return tags.length > 0 ? capitalise(tags.join(' · ')) : 'Station stop mark';
    }
    case 'water':
      return 'Water tower: hatch to spout';
    case 'end':
      return `<span class="dk-bad">End of track: under ${Math.max(1, limitMph(BUFFER_SAFE))} mph</span>`;
    case 'flag':
      return '<span class="dk-warn">Something the Rider spotted</span>';
  }
}

/** For a slower limit ahead: slow down while there's room, brake now once there isn't. */
function advice(it: AheadItem, speed: number): string {
  if (it.limit === undefined) return '';
  const a = slowAdvice(it.dist, speed, it.limit);
  return a === 'brake' ? ' · <span class="dk-bad">brake now!</span>' : a === 'slow' ? ' · <span class="dk-bad">slow down</span>' : '';
}

/** The hover text: the whole rule behind a terse row. */
function aheadTitle(it: AheadItem): string {
  switch (it.kind) {
    case 'tunnel':
      return 'A tunnel sweeps everyone above the car floors off the train, the tender top too. Call it early: the Rider gets down to a platform or inside.';
    case 'ford':
      return 'The river runs over the line: it washes everyone below the car roofs off the train. Call it early: the Rider gets up on a roof or the tender top.';
    case 'lowBridge':
      return 'The beam knocks down anyone standing on a roof or the tender top. The Rider crouches to pass under it.';
    case 'signal':
      return it.guards
        ? 'A junction signal speaks for the road the switch is set for. Have the Rider read it before you get there: red means that road is blocked, so throw the switch and ask again.'
        : 'The Rider reads it as the train passes. After a yellow, the next signal is at stop: stop at it.';
    default:
      return '';
  }
}

interface AheadRow {
  li: HTMLLIElement;
  icon: HTMLElement;
  name: HTMLElement;
  detail: HTMLElement;
  eta: HTMLElement;
  dist: HTMLElement;
  kind: string;
}

export class AheadPanel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly rows: AheadRow[];
  private readonly empty: HTMLElement;

  constructor(
    private readonly ix: NetIndex,
    private readonly numbers: ReadonlyMap<string, number>,
  ) {
    const p = panel('desk-ahead', 'Ahead');
    this.el = p.root;
    this.title = p.h2;
    const list = el('ol', 'ahead-list');
    this.rows = Array.from({ length: AHEAD_ROWS }, () => {
      const li = el('li', 'ah-row');
      const icon = el('span', 'ah-icon');
      const main = el('span', 'ah-main');
      const name = el('span', 'ah-name');
      const detail = el('span', 'ah-detail');
      main.append(name, detail);
      const when = el('span', 'ah-when');
      const eta = el('span', 'ah-eta');
      const dist = el('span', 'ah-dist');
      when.append(eta, dist);
      li.append(icon, main, when);
      li.hidden = true;
      list.append(li);
      return { li, icon, name, detail, eta, dist, kind: '' };
    });
    this.empty = el('p', 'ahead-empty', 'Waiting for the train…');
    this.el.append(this.empty, list);
  }

  /** `reversing`: the list runs from the rear, backing up (spec §4.2). */
  update(view: EngineerView, items: readonly AheadItem[], reversing: boolean): void {
    const v = view.train.v;
    const speed = reversing ? -v : v;
    setText(this.title, reversing ? 'Behind (backing)' : 'Ahead');
    this.empty.hidden = items.length > 0;
    setText(this.empty, view.train.spans.length === 0 ? 'Waiting for the train…' : 'Nothing on the line for miles.');
    this.rows.forEach((row, i) => {
      const it = items[i];
      row.li.hidden = !it;
      if (!it) return;
      if (row.kind !== it.kind) {
        row.icon.innerHTML = ICONS[it.kind];
        row.kind = it.kind;
      }
      const t = aheadRow(it, speed, this.ix, this.numbers);
      if (row.li.className !== t.cls) row.li.className = t.cls;
      if (row.li.title !== t.title) row.li.title = t.title;
      setHtml(row.name, t.name);
      setHtml(row.detail, t.detail);
      setText(row.eta, t.eta);
      setText(row.dist, t.dist);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// The precision-stop readout (spec §5.5, §5.6, §11)
// ---------------------------------------------------------------------------------------------

export class StopPanel {
  readonly el: HTMLElement;
  private key = '';

  constructor(private readonly run: EngineerRun) {
    this.el = el('div', 'cab-stop dk-idle');
    this.update(null, null, null);
  }

  /** `next`: the next station or water tower along the route, for the idle line. */
  update(view: EngineerView | null, tg: StopTarget | null, next: { name: string; dist: number } | null): void {
    const box = this.el;
    if (!view || !tg) {
      const text = next ? `No stop in reach. Next: <b>${escapeHtml(next.name)}</b> in ${formatDistance(next.dist)}` : view ? 'No station or water ahead on this road.' : 'Precision stop: waits for the train.';
      const key = `idle|${text}`;
      if (key === this.key) return;
      this.key = key;
      box.className = 'cab-stop dk-idle';
      box.innerHTML = `<div class="st-idle">${text}</div>`;
      return;
    }
    const inWindow = Math.abs(tg.dist) <= tg.window;
    const past = tg.dist < -tg.window;
    const kind = tg.kind === 'station' ? (tg.id === this.run.contract.destination ? 'Destination' : 'Station') : 'Water';
    // Whole yards all the way in: this readout is for the last few (spec §5.5, §5.6).
    const main = inWindow ? 'On the mark' : past ? `${formatYards(tg.dist)} past` : formatYards(tg.dist);
    const off = formatYards(tg.dist) === '0 yd' ? 'dead on' : `${formatYards(tg.dist)} ${tg.dist > 0 ? 'short' : 'over'}`;
    const small = inWindow ? off : past ? 'back her up' : tg.kind === 'station' ? 'to the stop mark' : 'hatch to spout';
    // The ruler: the mark three quarters along, the train's end coming in from the left.
    const lo = tg.kind === 'station' ? -90 : -24;
    const hi = tg.kind === 'station' ? 30 : 8;
    const pct = (x: number): number => ((Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo)) * 100;
    const sub = this.subline(view, tg, inWindow);
    const key = [kind, tg.name, main, small, Math.round(pct(-tg.dist) * 10), sub].join('|');
    if (key === this.key) return;
    this.key = key;
    box.className = `cab-stop${inWindow ? ' dk-on-mark' : ''}${past ? ' dk-past' : ''}`;
    box.innerHTML =
      `<div class="st-head"><span class="st-kind">${kind}</span><span class="st-name">${escapeHtml(tg.name)}</span></div>` +
      `<div class="st-dist">${main}<small>${small}</small></div>` +
      `<div class="st-ruler"><div class="st-window" style="left:${pct(-tg.window)}%;width:${pct(tg.window) - pct(-tg.window)}%"></div>` +
      `<div class="st-mark" style="left:${pct(0)}%"></div><div class="st-pos" style="left:${pct(-tg.dist)}%"></div></div>` +
      `<div class="st-sub">${sub}</div>`;
  }

  private subline(view: EngineerView, tg: StopTarget, inWindow: boolean): string {
    const standing = Math.abs(view.train.v) < 0.3;
    const stopAt = view.train.stationStop;
    if (tg.kind === 'station') {
      if (stopAt && stopAt.stationId === tg.id) {
        const done = stopAt.progress >= 1;
        return `${done ? 'Station work done: clear to go' : 'Stand still: station work'}<div class="st-bar${done ? ' dk-done' : ''}"><i style="width:${Math.round(stopAt.progress * 100)}%"></i></div>`;
      }
      if (inWindow) return standing ? 'Hold her here' : 'Stop now';
      return `Stop the loco's front within ${windowYards(tg.window)}`;
    }
    if (view.train.spout === 'down') return 'Spout down: taking water. Hold still.';
    if (inWindow) return standing ? 'Rider: lower the spout (E on the tender)' : 'Stop now: the hatch is under the spout';
    return `Stop with the tender hatch within ${windowYards(tg.window)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// The Rider's whereabouts (spec §2, §16.3)
// ---------------------------------------------------------------------------------------------

export class RiderPanel {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly where: HTMLElement;
  private readonly strip: HTMLElement;
  private stripCount = -1;

  constructor(private readonly consist: readonly CarType[] | undefined) {
    const p = panel('desk-rider', 'The Rider');
    this.el = p.root;
    const body = el('div', 'dk-rider-body');
    this.status = el('div', 'dk-rider-status');
    this.where = el('div', 'dk-rider-where');
    this.strip = el('div', 'dk-consist');
    body.append(this.status, this.where, this.strip);
    this.el.append(body);
    this.update(null);
  }

  update(view: EngineerView | null): void {
    let status = 'Aboard';
    let where = 'Waiting for the train';
    let bad = false;
    const r = view?.rider;
    if (r?.mode === 'off') {
      status = 'Off the train!';
      where = 'Catching up: back aboard at the rear';
      bad = true;
    } else if (r?.mode === 'down') {
      status = 'Down';
      where = 'Out of the fight for a few seconds';
      bad = true;
    } else if (r && r.car <= 0) {
      status = r.roof ? 'On the cab roof' : 'In the cab';
      where = r.roof ? 'Mind the tunnels' : 'Right beside you';
    } else if (r && r.car === 1) {
      status = r.roof ? 'On the tender' : 'On the tender deck';
      where = r.roof ? 'On the coal, by the water hatch' : 'Just behind the cab';
    } else if (r) {
      const n = r.car - 1;
      const type = this.consist?.[n - 1];
      status = r.roof ? 'On the roof' : 'Inside';
      where = `Car ${n}${type ? ` (${type})` : ''}, ${n === 1 ? 'first behind the tender' : `${n} back from the tender`}`;
    }
    setHtml(this.status, `${ICONS.rider}<span>${status}</span>`);
    setClass(this.status, 'dk-bad', bad);
    setText(this.where, where);
    this.updateStrip(view);
  }

  /** The mini train: the loco on the right, as the Rider sees it (spec §6.1), the Rider's car lit. */
  private updateStrip(view: EngineerView | null): void {
    let n = this.consist?.length ?? -1;
    if (n < 0) {
      // No consist given: estimate the cars behind the tender from the train's length.
      const rest = view ? view.train.length - CAR_SPECS.loco.length - CAR_SPECS.tender.length : 0;
      n = Math.round(rest / 14.6);
    }
    n = Math.max(0, n);
    if (n !== this.stripCount) {
      this.stripCount = n;
      this.strip.innerHTML = '';
      for (let k = n + 1; k >= 0; k--) {
        const i = el('i', k === 0 ? 'dk-loco' : k === 1 ? 'dk-tender' : '');
        i.dataset.car = String(k);
        this.strip.append(i);
      }
    }
    const r = view?.rider;
    for (const i of Array.from(this.strip.children) as HTMLElement[]) {
      const here = !!r && r.mode === 'active' && Math.max(0, Math.min(n + 1, r.car)) === Number(i.dataset.car);
      setClass(i, 'dk-here', here);
      setClass(i, 'dk-roof', here && !!r?.roof);
      setClass(i, 'dk-inside', here && !r?.roof);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The log and the telegraph
// ---------------------------------------------------------------------------------------------

interface LogEntry {
  el: HTMLLIElement;
  key: string | undefined;
  clock: number;
  count: number;
}

export class LogPanel {
  readonly el: HTMLElement;
  private readonly list: HTMLOListElement;
  private entries: LogEntry[] = [];

  constructor() {
    const p = panel('desk-log', 'Log');
    this.el = p.root;
    this.list = el('ol');
    this.list.setAttribute('aria-live', 'polite');
    this.el.append(this.list);
  }

  /** Adds a line at the top (newest first); a keyed line close to the same one merges into it (×n). */
  add(text: string, tone: LogTone, clock: number, key?: string): void {
    const top = this.entries[0];
    if (key && top && top.key === key && clock - top.clock < LOG_MERGE_S) {
      top.count++;
      top.clock = clock;
      const c = top.el.querySelector('.dk-count');
      if (c) c.textContent = `×${top.count}`;
      return;
    }
    const li = el('li', `log-line dk-${tone}`);
    const txt = el('span', 'dk-txt', text);
    txt.append(el('span', 'dk-count'));
    li.append(el('time', undefined, clockParts(clock).hm), el('span', 'dk-dot'), txt);
    this.list.prepend(li);
    this.list.scrollTop = 0;
    this.entries.unshift({ el: li, key, clock, count: 1 });
    while (this.entries.length > LOG_MAX) this.entries.pop()?.el.remove();
  }
}

export class TelegraphPanel {
  readonly el: HTMLElement;
  private readonly tape: HTMLElement;

  constructor() {
    const p = panel('desk-telegram', 'Telegraph');
    this.el = p.root;
    const wrap = el('div', 'dk-tape-wrap');
    this.tape = el('div', 'dk-tape dk-none', 'No telegrams yet.');
    wrap.append(this.tape);
    this.el.append(wrap);
  }

  /** The latest telegram, as paper tape, with a little arrival animation. */
  show(text: string): void {
    this.tape.className = 'dk-tape';
    this.tape.textContent = text;
    void this.tape.offsetWidth;
    this.tape.classList.add('dk-fresh');
  }
}
