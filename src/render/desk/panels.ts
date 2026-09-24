// The desk's DOM panels (spec §11): the header, the Ahead list, the precision-stop readout, the
// Rider's whereabouts, the log and the telegraph. Each builds its element once and updates it from
// a snapshot, touching the DOM only where something changed.

import type { NetIndex } from '../../sim/network';
import { CAR_SPECS, BUFFER_SAFE } from '../../sim/rules';
import type { CarType, EngineerRun, EngineerView } from '../../sim/types';
import type { AheadItem, StopTarget } from './ahead';
import { btn, capitalise, el, escapeHtml, kbd, setClass, setHtml, setText } from './dom';
import { lossText, type LogTone } from './events';
import { clockParts, formatClock, formatDistance, formatEta, formatMoney, formatRemaining, limitMph, toMph } from './format';
import { ICONS } from './icons';

/** Rows in the Ahead list (spec §11). */
export const AHEAD_ROWS = 6;
/** ETAs below these (s) are called out in yellow, then red. */
const SOON_S = 10;
const IMMINENT_S = 4;
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
      const lbl = el('span', 'lbl', label);
      const val = el('span', 'val', '—');
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
      setClass(L.box, 'overdue', false);
      setClass(L.box, 'good', true);
    } else if (view.phase === 'lost') {
      setText(L.lbl, 'Run over');
      setText(L.val, view.loss ? lossText(view.loss.reason) : 'Lost');
      setClass(L.box, 'overdue', true);
      setClass(L.box, 'good', false);
    } else {
      const r = formatRemaining(this.run.contract.deadline - view.clock);
      setText(L.lbl, r.overdue ? 'Late by' : 'Time left');
      setText(L.val, r.text.split(' ')[0]);
      setClass(L.box, 'overdue', r.overdue);
      setClass(L.box, 'good', false);
    }
    this.updateJobs(view);
    setText(this.fines.val, formatMoney(view.fines));
    setClass(this.fines.box, 'bad', view.fines > 0);
    setClass(this.fines.box, 'zero', view.fines === 0);
    const stolen = view.cargo === 'stolen';
    setText(this.cargo.val, stolen ? 'Stolen!' : recovered ? 'Recovered' : 'Aboard');
    setClass(this.cargo.box, 'bad', stolen);
    setClass(this.cargo.box, 'good', !stolen && recovered);
  }

  private updateJobs(view: EngineerView): void {
    const key = view.sideJobs.map((j) => `${j.id}:${j.state}`).join('|');
    if (key === this.jobsKey) return;
    this.jobsKey = key;
    this.jobs.innerHTML = '';
    const name = (id: string): string => this.run.stations.find((x) => x.id === id)?.name ?? id;
    for (const def of this.run.sideJobs) {
      const st = view.sideJobs.find((j) => j.id === def.id)?.state ?? 'pending';
      const chip = el('span', `dh-job ${st}`);
      chip.title = `${def.title}: ${name(def.from)} → ${name(def.to)}, ${formatMoney(def.pay)}`;
      chip.textContent = `${def.title} · ${st === 'pending' ? `wait at ${name(def.from)}` : st === 'aboard' ? `to ${name(def.to)}` : 'done'}`;
      this.jobs.append(chip);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The Ahead list: what the Engineer reads out
// ---------------------------------------------------------------------------------------------

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
      const inside = it.until !== undefined;
      const secs = speed > 0.3 ? it.dist / speed : Infinity;
      const urgency = inside ? ' here' : secs <= IMMINENT_S ? ' imminent' : secs <= SOON_S ? ' soon' : '';
      const cls = `ah-row ah-${it.kind}${urgency}`;
      if (row.li.className !== cls) row.li.className = cls;
      setHtml(row.name, this.name(it));
      setHtml(row.detail, this.detail(it, speed));
      setText(row.eta, inside ? 'now' : formatEta(it.dist, speed));
      setText(row.dist, inside ? `out in ${formatDistance(it.until ?? 0)}` : formatDistance(it.dist));
    });
  }

  private name(it: AheadItem): string {
    switch (it.kind) {
      case 'curve':
        return `Curve <span class="plate">${limitMph(it.limit ?? 0)} mph</span>`;
      case 'junction': {
        const n = this.numbers.get(it.id);
        return `${n ? `<span class="num">${n}</span>` : ''}${escapeHtml(it.name)}`;
      }
      case 'station':
        return `${escapeHtml(it.name)}${it.destination ? ' ★' : ''}`;
      default:
        return escapeHtml(it.name);
    }
  }

  /** The line under the name: what it means for the train, and for the Rider on the roofs. */
  private detail(it: AheadItem, speed: number): string {
    const len = it.length !== undefined ? formatDistance(it.length) : '';
    switch (it.kind) {
      case 'tunnel':
        return `Tunnel, ${len}: <span class="warn">off the roofs</span>`;
      case 'lowBridge':
        return '<span class="warn">Low beam: duck on the roofs</span>';
      case 'trestle':
        return it.minSpeed !== undefined
          ? `<span class="${toMph(speed) < limitMph(it.minSpeed) ? 'bad' : 'warn'}">Burning! Cross at ${limitMph(it.minSpeed)} mph or more</span>`
          : `Trestle, ${len}`;
      case 'curve':
        return `${len} long${speed > (it.limit ?? Infinity) * 1.02 ? ' · <span class="bad">slow down</span>' : ''}`;
      case 'signal':
        return 'Ask the Rider what it shows';
      case 'junction': {
        const j = it.junction;
        if (!j) return '';
        if (!j.facing) return j.against ? '<span class="warn">Trailing: it will spring over</span>' : 'Trailing through';
        const leg = this.ix.edge.get(j.leg);
        const legName = leg?.name ?? leg?.kind ?? '';
        return `Set <b>${j.state}</b>${legName ? ` → ${escapeHtml(legName)}` : ''}`;
      }
      case 'station': {
        const tags = [it.destination ? 'destination' : '', it.checkpoint ? 'checkpoint' : '', it.waterColumn ? 'water column' : ''].filter(Boolean);
        return tags.length > 0 ? capitalise(tags.join(' · ')) : 'Station stop mark';
      }
      case 'water':
        return 'Water tower: hatch to spout';
      case 'end':
        return `<span class="bad">End of track: under ${Math.max(1, limitMph(BUFFER_SAFE))} mph</span>`;
      case 'flag':
        return '<span class="warn">Something the Rider spotted</span>';
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The precision-stop readout (spec §5.5, §5.6, §11)
// ---------------------------------------------------------------------------------------------

export class StopPanel {
  readonly el: HTMLElement;
  private key = '';

  constructor(private readonly run: EngineerRun) {
    this.el = el('div', 'cab-stop idle');
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
      box.className = 'cab-stop idle';
      box.innerHTML = `<div class="st-idle">${text}</div>`;
      return;
    }
    const inWindow = Math.abs(tg.dist) <= tg.window;
    const past = tg.dist < -tg.window;
    const kind = tg.kind === 'station' ? (tg.id === this.run.contract.destination ? 'Destination' : 'Station') : 'Water';
    const main = inWindow ? 'On the mark' : past ? `${Math.round(-tg.dist)} m past` : formatDistance(tg.dist);
    const off = Math.abs(tg.dist) < 0.5 ? 'dead on' : `${Math.round(Math.abs(tg.dist))} m ${tg.dist > 0 ? 'short' : 'over'}`;
    const small = inWindow ? off : past ? 'back her up' : tg.kind === 'station' ? 'to the stop mark' : 'hatch to spout';
    // The ruler: the mark three quarters along, the train's end coming in from the left.
    const lo = tg.kind === 'station' ? -90 : -24;
    const hi = tg.kind === 'station' ? 30 : 8;
    const pct = (x: number): number => ((Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo)) * 100;
    const sub = this.subline(view, tg, inWindow);
    const key = [kind, tg.name, main, small, Math.round(pct(-tg.dist) * 10), sub].join('|');
    if (key === this.key) return;
    this.key = key;
    box.className = `cab-stop${inWindow ? ' on-mark' : ''}${past ? ' past' : ''}`;
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
        return `${done ? 'Station work done: clear to go' : 'Stand still: station work'}<div class="st-bar${done ? ' done' : ''}"><i style="width:${Math.round(stopAt.progress * 100)}%"></i></div>`;
      }
      if (inWindow) return standing ? 'Hold her here' : 'Stop now';
      return `Stop the loco's front within ${tg.window} m`;
    }
    if (view.train.spout === 'down') return 'Spout down: taking water. Hold still.';
    if (inWindow) return standing ? 'Rider: lower the spout (E on the tender)' : 'Stop now: the hatch is under the spout';
    return `Stop with the tender hatch within ${tg.window} m`;
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
    const body = el('div', 'rider-body');
    this.status = el('div', 'rider-status');
    this.where = el('div', 'rider-where');
    this.strip = el('div', 'consist');
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
    setClass(this.status, 'bad', bad);
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
        const i = el('i', k === 0 ? 'loco' : k === 1 ? 'tender' : '');
        i.dataset.car = String(k);
        this.strip.append(i);
      }
    }
    const r = view?.rider;
    for (const i of Array.from(this.strip.children) as HTMLElement[]) {
      const here = !!r && r.mode === 'active' && Math.max(0, Math.min(n + 1, r.car)) === Number(i.dataset.car);
      setClass(i, 'here', here);
      setClass(i, 'roof', here && !!r?.roof);
      setClass(i, 'inside', here && !r?.roof);
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
      const c = top.el.querySelector('.count');
      if (c) c.textContent = `×${top.count}`;
      return;
    }
    const li = el('li', `log-line ${tone}`);
    const txt = el('span', 'txt', text);
    txt.append(el('span', 'count'));
    li.append(el('time', undefined, clockParts(clock).hm), el('span', 'dot'), txt);
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
    const wrap = el('div', 'tape-wrap');
    this.tape = el('div', 'tape none', 'No telegrams yet.');
    wrap.append(this.tape);
    this.el.append(wrap);
  }

  /** The latest telegram, as paper tape, with a little arrival animation. */
  show(text: string): void {
    this.tape.className = 'tape';
    this.tape.textContent = text;
    void this.tape.offsetWidth;
    this.tape.classList.add('fresh');
  }
}
