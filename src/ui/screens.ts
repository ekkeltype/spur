// Screen pieces shared by both seats: the briefing, the pause and countdown overlays, the results,
// and plain message screens (spec §3).

import type { Payout, Role } from '../net/protocol';
import { cargoCars } from '../sim/game';
import type { CarType, EngineerRun, RunResult } from '../sim/types';
import { button, h } from './dom';
import { ACT_NAMES, CAR_LABELS, CARGO_NAMES, formatClock, formatDuration, LOSS_TITLES, MEDALS, money, mph, signedMoney } from './text';

export const SEAT_NAMES: Record<Role, string> = { rider: 'the Rider', engineer: 'the Engineer' };
const Seat = (role: Role): string => (role === 'rider' ? 'Rider' : 'Engineer');
const other = (role: Role): Role => (role === 'rider' ? 'engineer' : 'rider');

export type Actions = [label: string, onClick: () => void][];

function actionRow(actions: Actions | undefined): HTMLElement | null {
  if (!actions || actions.length === 0) return null;
  return h('div', { class: 'row center secondary-actions' }, ...actions.map(([l, fn]) => button(l, fn, 'btn small-btn')));
}

function stationName(run: EngineerRun, id: string): string {
  return run.stations.find((s) => s.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------------------------

export interface ReadyView {
  el: HTMLElement;
  update(me: boolean, other: boolean, connected: boolean): void;
}

export function readyRow(role: Role, onReady: (ready: boolean) => void): ReadyView {
  const partner = Seat(other(role));
  const meChip = h('span', { class: 'ready-chip' });
  const otherChip = h('span', { class: 'ready-chip' });
  let meReady = false;
  const btn = button('Ready', () => onReady(!meReady), 'btn primary ready-btn');
  const el = h('div', { class: 'ready-row' }, btn, meChip, otherChip);
  return {
    el,
    update(me, o, connected) {
      meReady = me;
      btn.textContent = me ? 'Not ready' : 'Ready';
      btn.className = me ? 'btn ready-btn' : 'btn primary ready-btn';
      meChip.textContent = me ? 'You are ready' : 'You are not ready';
      meChip.classList.toggle('yes', me);
      otherChip.textContent = !connected ? `The ${partner} is not here yet` : o ? `The ${partner} is ready` : `The ${partner} is not ready`;
      otherChip.classList.toggle('yes', o && connected);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Switching seats (spec §3)
// ---------------------------------------------------------------------------------------------

export interface SwitchSeatsView {
  el: HTMLElement;
  update(me: boolean, them: boolean, switching: boolean, connected: boolean): void;
}

/** The lobby's "Switch seats" box: once both players tick it, the Rider and the Engineer swap seats. */
export function switchSeatsRow(role: Role, onToggle: (on: boolean) => void): SwitchSeatsView {
  const partner = Seat(other(role));
  const box = h('input', { type: 'checkbox', on: { change: () => onToggle(box.checked) } });
  const note = h('span', { class: 'switch-note' });
  const el = h('div', { class: 'switch-row' }, h('label', { class: 'switch-seats' }, box, h('span', { text: 'Switch seats' })), note);
  return {
    el,
    update(me, them, switching, connected) {
      box.checked = me;
      box.disabled = switching || !connected;
      note.textContent = switching
        ? 'Switching seats…'
        : me && !them
          ? `Waiting for the ${partner} to tick it too`
          : them && !me
            ? `The ${partner} wants to switch seats`
            : `When you both tick it, you become the ${partner}`;
      el.classList.toggle('asked', them && !me && !switching);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Controls (spec §6.2, §11)
// ---------------------------------------------------------------------------------------------

export function controlsReminder(role: Role, local = false): HTMLElement {
  const rows: [string, string][] =
    role === 'rider'
      ? [
          ['A / D', 'Walk toward the rear or the loco'],
          ['W or Space', 'Jump. W climbs a ladder, or out of a hatch'],
          ['S', 'Crouch. Drops through a hatch, climbs down'],
          ['E', 'Lower the water spout, pick things up'],
          ['R', 'Reload'],
          ['Q or 1–3', 'Switch weapon'],
          ['Mouse', 'Aim. Left click fires'],
          ['Shift or right mouse', 'Spyglass. Click plants a flag for the Engineer'],
          ['Esc', 'Pause'],
        ]
      : local
        ? [
            ['Mouse', 'Drag the levers, click switches, tabs and the whistle'],
            ['↑ / ↓', 'Throttle a notch up or down'],
            ['← / →', 'Brake less or more'],
            ['H (hold)', 'Whistle'],
            ['1–9', 'Throw switch n'],
            ['Tab', 'Rulebook'],
          ]
        : [
            ['Mouse', 'Drag the levers, click switches and tabs'],
            ['↑ / ↓', 'Throttle a notch up or down'],
            ['← / →', 'Brake less or more'],
            ['Space', 'Emergency brake'],
            ['H (hold)', 'Whistle'],
            ['F / V', 'Firebox up or down'],
            ['X', 'Cycle the reverser (stopped only)'],
            ['1–9', 'Throw switch n'],
            ['Tab', 'Rulebook'],
            ['Esc', 'Pause'],
          ];
  return h('div', { class: 'controls-table' }, ...rows.flatMap(([k, v]) => [h('span', { class: 'key', text: k }), h('span', { text: v })]));
}

// ---------------------------------------------------------------------------------------------
// Briefing (spec §3)
// ---------------------------------------------------------------------------------------------

export interface BriefingInfo {
  run: EngineerRun;
  /** How many runs the campaign has, for "Run 2 of 6". */
  runCount: number;
  fromCheckpoint: string | null;
  replay: boolean;
}

export function briefingScreen(info: BriefingInfo, role: Role, onReady: (ready: boolean) => void, local = false, actions?: Actions): ReadyView {
  const run = info.run;
  const c = run.contract;
  const ready = readyRow(role, onReady);
  const lines = (seat: Role): HTMLElement => {
    const list = seat === 'rider' ? run.briefing.rider : run.briefing.engineer;
    return h(
      'section',
      { class: `briefing-seat ${seat === role ? 'mine' : ''}` },
      h('h3', { class: 'section', text: seat === role ? `New for you, the ${Seat(seat)}` : `New for the ${Seat(seat)}` }),
      list.length > 0 ? h('ul', { class: 'new-lines' }, ...list.map((l) => h('li', { text: l }))) : h('p', { class: 'muted small', text: 'Nothing new this time.' }),
    );
  };
  const pay = info.replay ? `${money(c.pay)} (a replay pays half)` : money(c.pay);
  const el = h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'sheet briefing' },
      h('div', { class: 'kicker', text: `${ACT_NAMES[run.act] ?? `Act ${run.act}`} · Run ${run.index + 1} of ${Math.max(info.runCount, run.index + 1)}` }),
      h('h1', { class: 'display', text: run.name }),
      h('p', { class: 'flavor', text: run.flavor }),
      h(
        'div',
        { class: 'contract-line' },
        h('strong', { text: c.title }),
        h('span', { text: `${CARGO_NAMES[c.cargo]} · ${pay}` }),
        h('span', { text: `${stationName(run, run.origin)} → ${stationName(run, c.destination)}` }),
        h('span', { text: `Departs ${formatClock(run.startClock)} · deadline ${formatClock(c.deadline)}` }),
        c.critical ? h('span', { class: 'badge danger', text: 'Critical cargo' }) : null,
        run.night ? h('span', { class: 'badge night', text: 'Night run' }) : null,
      ),
      info.fromCheckpoint
        ? h('p', { class: 'notice', text: `Continuing from ${info.fromCheckpoint}: the train, the clock and the fight as they were when you left the station.` })
        : null,
      h('div', { class: 'briefing-cols' }, lines('rider'), lines('engineer')),
      h('h3', { class: 'section', text: 'Your controls' }),
      controlsReminder(role, local),
      h('div', { class: 'briefing-foot' }, ready.el, h('span', { class: 'muted small', text: 'Both press Ready for the countdown.' })),
      actionRow(actions),
    ),
  );
  return { el, update: ready.update };
}

// ---------------------------------------------------------------------------------------------
// Overlays
// ---------------------------------------------------------------------------------------------

export interface PauseView extends ReadyView {
  setReason(text: string): void;
}

export function pauseOverlay(role: Role, onReady: (ready: boolean) => void, actions?: Actions): PauseView {
  const reason = h('p', { class: 'muted' });
  const ready = readyRow(role, onReady);
  const el = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'sheet overlay-card' },
      h('h2', { class: 'display', text: 'Paused' }),
      reason,
      h('p', { class: 'small muted', text: 'Both of you press Ready to resume.' }),
      ready.el,
      actionRow(actions),
    ),
  );
  el.hidden = true;
  return {
    el,
    update: ready.update,
    setReason(text) {
      reason.textContent = text;
    },
  };
}

export function countdownOverlay(): { el: HTMLElement; set(n: number | null): void } {
  const num = h('div', { class: 'countdown' });
  const el = h('div', { class: 'overlay clear' }, num);
  el.hidden = true;
  let shown: number | null = null;
  return {
    el,
    set(n) {
      if (n === shown) return;
      shown = n;
      el.hidden = n === null;
      num.textContent = n === null ? '' : String(n);
      // Restart the pop for each number.
      num.classList.remove('pop');
      void num.offsetWidth;
      if (n !== null) num.classList.add('pop');
    },
  };
}

/** A small overlay with a title and a line, e.g. "Reconnecting…". */
export function noticeOverlay(title: string, text: string): HTMLElement {
  const el = h('div', { class: 'overlay' }, h('div', { class: 'sheet overlay-card' }, h('h2', { class: 'display', text: title }), h('p', { class: 'muted', text })));
  el.hidden = true;
  return el;
}

/** A plain screen with a title, a line that can change, and buttons (connecting, lost, rejected…). */
export function messageScreen(title: string, actions: Actions): { el: HTMLElement; setText(text: string): void } {
  const p = h('p', { class: 'muted' });
  const el = h(
    'div',
    { class: 'screen' },
    h('div', { class: 'sheet narrow' }, h('h2', { class: 'display', text: title }), p, h('div', { class: 'row' }, ...actions.map(([l, fn], i) => button(l, fn, i === 0 ? 'btn primary' : 'btn')))),
  );
  return {
    el,
    setText(text) {
      p.textContent = text;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Results (spec §3, §12)
// ---------------------------------------------------------------------------------------------

export interface ResultActions {
  next?: () => void;
  retry?: { station: string; go: () => void };
  restart?: () => void;
  lobby?: () => void;
  leave?: () => void;
}

function arrivalText(r: RunResult): string {
  if (r.arrivedClock === null) return `Deadline ${formatClock(r.deadline)}`;
  const diff = Math.round((r.arrivedClock - r.deadline) / 60);
  const when = diff < 0 ? `${-diff} min early` : diff === 0 ? 'on time' : `${diff} min late`;
  return `Arrived ${formatClock(r.arrivedClock)} · deadline ${formatClock(r.deadline)} · ${when}`;
}

/** "Cargo (boxcar, passenger)": the payout row for the cargo cars, naming the cars that earned it. */
export function cargoLabel(consist: readonly CarType[], run: Pick<EngineerRun, 'requiredCars'>): string {
  const cars = cargoCars(consist, run.requiredCars).map((c) => CAR_LABELS[c.car].toLowerCase());
  return cars.length > 0 ? `Cargo (${cars.join(', ')})` : 'Cargo';
}

function payoutTable(p: Payout, cargo: string): HTMLElement {
  if (!p.won) return h('p', { class: 'muted', text: 'No pay: the contract failed.' });
  const rows: [string, string, string?][] = [['Contract pay', money(p.pay)]];
  if (p.latePenalty > 0) rows.push(['Late penalty', signedMoney(-p.latePenalty), 'minus']);
  // What the optional cars carried (spec §12); a replay halves it with the rest.
  if (p.cargoPay > 0) rows.push([cargo, signedMoney(p.cargoPay)]);
  if (p.sideJobPay > 0) rows.push(['Side jobs', signedMoney(p.sideJobPay)]);
  if (p.fines > 0) rows.push(['Fines', signedMoney(-p.fines), 'minus']);
  if (p.replay) rows.push(['Replay: half pay', signedMoney(-p.replayDiscount), 'minus']);
  return h(
    'div',
    { class: 'payout' },
    ...rows.flatMap(([k, v, cls]) => [h('span', { text: k }), h('span', { class: `amount ${cls ?? ''}`, text: v })]),
    h('span', { class: 'total-rule' }),
    h('span', { class: 'total-label', text: 'Earned' }),
    h('span', { class: 'amount total', text: signedMoney(p.total) }),
  );
}

/** `consist`: the cars behind the tender, which name the cargo row. */
export function resultsScreen(r: RunResult, payout: Payout, run: EngineerRun, role: Role, actions: ResultActions | null, consist: readonly CarType[] = []): HTMLElement {
  const won = r.outcome === 'won';
  const s = r.stats;
  const destination = stationName(run, run.contract.destination);
  const accuracy = s.shotsFired > 0 ? ` (${Math.round((100 * s.hits) / s.shotsFired)}%)` : '';
  const stats: [string, string][] = [
    ['Top speed', mph(s.maxSpeed)],
    ['Shots, hits', `${s.shotsFired}, ${s.hits}${accuracy}`],
    ['Horsemen downed', String(s.horsemenDowned)],
    ['Bandits downed', String(s.banditsDowned)],
    ['Hearts lost', String(s.heartsLost)],
    ['Off the train', String(s.timesOff)],
    ['Down', String(s.timesDown)],
    ['Held up', String(s.holdups)],
    ['Red signals', String(s.redSignals)],
    ['Speeding fines', String(s.speedFines)],
    ['Water stops', String(s.waterStops)],
  ];
  const buttons = h('div', { class: 'row center result-actions' });
  if (actions) {
    if (actions.next) buttons.append(button('Next run', actions.next, 'btn primary'));
    if (actions.retry) buttons.append(button(`Retry from ${actions.retry.station}`, actions.retry.go, actions.next ? 'btn' : 'btn primary'));
    if (actions.restart) buttons.append(button('Restart run', actions.restart, actions.next || actions.retry ? 'btn' : 'btn primary'));
    if (actions.lobby) buttons.append(button('Lobby', actions.lobby));
    if (actions.leave) buttons.append(button('Leave', actions.leave));
  }
  if (role === 'engineer') buttons.prepend(h('span', { class: 'muted waiting-note', text: 'The Rider chooses what happens next.' }));
  return h(
    'div',
    { class: 'screen' },
    h(
      'div',
      { class: 'sheet results' },
      h('div', { class: 'kicker', text: `Run ${run.index + 1} · ${run.name}` }),
      h('h1', { class: `display ${won ? 'good' : 'danger'}`, text: won ? `Arrived at ${destination}` : r.reason ? LOSS_TITLES[r.reason] : 'The run is over' }),
      h('p', { class: 'detail', text: won ? `${run.contract.title}: delivered.` : r.detail || 'The contract failed.' }),
      h('p', { class: 'times muted', text: `Time ${formatDuration(r.timeSec)} · ${arrivalText(r)}` }),
      h(
        'div',
        { class: 'results-cols' },
        h('section', {}, h('h3', { class: 'section', text: 'Payout' }), payoutTable(payout, cargoLabel(consist, run))),
        h(
          'section',
          {},
          h('h3', { class: 'section', text: 'Medals' }),
          won
            ? h(
                'div',
                { class: 'medal-row' },
                ...MEDALS.map((m) => h('div', { class: `medal-card ${r.medals.includes(m.id) ? 'won' : ''}` }, h('strong', { text: m.name }), h('div', { class: 'blurb', text: m.blurb }))),
              )
            : h('p', { class: 'muted', text: 'Medals are for runs that arrive.' }),
        ),
      ),
      h('h3', { class: 'section', text: 'The run' }),
      h('div', { class: 'stats' }, ...stats.flatMap(([k, v]) => [h('span', { class: 'muted', text: k }), h('strong', { text: v })])),
      buttons,
    ),
  );
}
