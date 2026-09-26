// The depot (spec §3, §12): both players see the same board and either can act on it. The run list
// with medals, the selected run's contract, the train (required cars fixed, carrying the contract;
// optional ones coupled or not, each cargo car with what it pays), assists per seat, and the shop.
// Every action goes to the host, which validates it; the board only shows what the host last said,
// and disables what it knows the host would refuse.

import type { DepotAction, LobbyState, RunCard } from '../net/protocol';
import { availableCars } from '../save/save';
import { CARGO_PAY, CAR_SPECS, REPLAY_PAY_FACTOR, SHOP, type ShopItem } from '../sim/rules';
import type { CarKind, CarType } from '../sim/types';
import { button, clear, h } from './dom';
import { ACT_NAMES, BOARDING_SPEED, CAR_LABELS, CARGO_NAMES, cargoCars, distance, formatClock, formatDuration, MEDALS, money, mph, plural, tons, topSpeed, trainMass } from './text';

export interface DepotModel {
  lobby: LobbyState;
  runs: readonly RunCard[];
}

export interface DepotView {
  el: HTMLElement;
  update(model: DepotModel): void;
}

/** Optional cars in the order the chips list them (powder cars are only ever required). */
const CHIP_CARS: readonly CarType[] = ['express', 'passenger', 'boxcar', 'armored', 'caboose'];

const SHOP_GROUPS: readonly [ShopItem['seat'], string][] = [
  ['rider', 'For the Rider'],
  ['engineer', 'For the Engineer'],
  ['train', 'Cars'],
];

/** A section that rebuilds its content only when its key changes. */
function keyed(el: HTMLElement): (key: string, build: () => Node[]) => void {
  let last = '';
  return (key, build) => {
    if (key === last) return;
    last = key;
    clear(el);
    el.append(...build());
  };
}

export function depotBoard(act: (action: DepotAction) => void): DepotView {
  const runsEl = h('div', { class: 'run-list' });
  const contractEl = h('div', { class: 'contract' });
  const trainEl = h('div', { class: 'train' });
  const assistsEl = h('div', { class: 'assists' });
  const shopEl = h('div', { class: 'shop' });
  const el = h(
    'div',
    { class: 'depot-grid' },
    h('section', { class: 'depot-runs' }, h('h3', { class: 'section', text: 'Runs' }), runsEl),
    h(
      'section',
      { class: 'depot-plan' },
      contractEl,
      h('h3', { class: 'section', text: 'The train' }),
      trainEl,
      h('h3', { class: 'section', text: 'Assists' }),
      assistsEl,
    ),
    h('section', { class: 'depot-shop' }, h('h3', { class: 'section', text: 'Shop' }), shopEl),
  );
  const runs = keyed(runsEl);
  const contract = keyed(contractEl);
  const train = keyed(trainEl);
  const assists = keyed(assistsEl);
  const shop = keyed(shopEl);

  return {
    el,
    update({ lobby, runs: cards }) {
      const card = cards[lobby.selectedRun];
      runs(JSON.stringify([cards.map((c) => [c.id, c.unlocked, c.times, c.best, c.medals]), lobby.selectedRun]), () => runList(cards, lobby.selectedRun, act));
      if (!card) return;
      contract(JSON.stringify([card, lobby.checkpoint]), () => contractCard(card, lobby));
      const c = lobby.campaign;
      train(JSON.stringify([card.id, card.requiredCars, card.maxCars, card.times > 0, lobby.consist, c.consist, c.owned]), () => trainSection(card, lobby, act));
      assists(JSON.stringify(c.assists), () => assistToggles(lobby, act));
      shop(JSON.stringify([c.money, c.owned]), () => shopList(lobby, act));
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

function medalPips(earned: readonly string[]): HTMLElement {
  return h(
    'span',
    { class: 'pips', ariaLabel: `${earned.length} of ${MEDALS.length} medals` },
    ...MEDALS.map((m) => h('span', { class: `pip ${earned.includes(m.id) ? 'on' : ''}`, title: `${m.name}: ${m.blurb}${earned.includes(m.id) ? '' : ' (not yet)'}` })),
  );
}

function runList(cards: readonly RunCard[], selected: number, act: (a: DepotAction) => void): Node[] {
  const out: Node[] = [];
  let lastAct = -1;
  for (const card of cards) {
    if (card.act !== lastAct) {
      lastAct = card.act;
      out.push(h('div', { class: 'act-head', text: ACT_NAMES[card.act] ?? `Act ${card.act}` }));
    }
    const sub = !card.unlocked
      ? 'Locked: win the run before it'
      : card.times > 0 && card.best !== null
        ? `Best ${formatDuration(card.best)} · won ${card.times}×`
        : `${CARGO_NAMES[card.contract.cargo]} · ${money(card.contract.pay)}`;
    const item = h(
      'button',
      {
        class: `run-item ${card.index === selected ? 'selected' : ''} ${card.unlocked ? '' : 'locked'}`,
        type: 'button',
        disabled: !card.unlocked,
        title: card.unlocked ? card.flavor : 'Win the run before it to unlock this one',
        attrs: { 'aria-current': card.index === selected ? 'true' : 'false' },
        on: { click: () => act({ kind: 'selectRun', index: card.index }) },
      },
      h('span', { class: 'run-num', text: String(card.index + 1) }),
      h('span', { class: 'run-text' }, h('strong', { text: card.name }), h('span', { class: 'run-sub', text: sub })),
      card.unlocked ? medalPips(card.medals) : h('span', { class: 'lock', text: 'Locked', ariaLabel: 'Locked' }),
    );
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------------------------

function contractCard(card: RunCard, lobby: LobbyState): Node[] {
  const c = card.contract;
  const replay = card.times > 0;
  const facts: [string, Node | string][] = [
    [
      'Contract',
      h(
        'span',
        {},
        `${c.title} · ${CARGO_NAMES[c.cargo]}`,
        c.critical ? h('span', { class: 'badge danger', text: 'Critical', title: 'Losing the cargo fails the run' }) : null,
      ),
    ],
    ['Route', `${card.originName} → ${card.destinationName}`],
    [
      'Times',
      h(
        'span',
        {},
        `Departs ${formatClock(card.startClock)} · due by ${formatClock(c.deadline)} · late costs ${money(c.latePenaltyPerMin)} a minute`,
        card.night ? h('span', { class: 'badge night', text: 'Night' }) : null,
      ),
    ],
    [
      'Pays',
      replay
        ? h('span', {}, h('strong', { text: money(Math.round(c.pay * REPLAY_PAY_FACTOR)) }), h('span', { class: 'muted', text: ` (${money(c.pay)}, but a replay pays half)` }))
        : h('strong', { text: money(c.pay) }),
    ],
  ];
  for (const job of card.sideJobs) facts.push(['Side job', `${job.title}, ${money(job.pay)} (needs a ${CAR_LABELS[job.needs].toLowerCase()} car)`]);
  const out: Node[] = [
    h('div', { class: 'kicker', text: `${ACT_NAMES[card.act] ?? `Act ${card.act}`} · Run ${card.index + 1}` }),
    h('h2', { class: 'display run-title', text: card.name }),
    h('p', { class: 'flavor', text: card.flavor, title: card.flavor }),
    h('div', { class: 'facts' }, ...facts.flatMap(([k, v]) => [h('span', { class: 'fact-key', text: k }), h('span', { class: 'fact-val' }, v)])),
  ];
  const cp = lobby.checkpoint;
  if (cp && cp.runId === card.id) out.push(h('p', { class: 'notice', text: `A checkpoint waits at ${cp.stationName}. The Rider can continue from there.` }));
  return out;
}

// ---------------------------------------------------------------------------------------------
// The train
// ---------------------------------------------------------------------------------------------

/** What a car carries, for its title: the contract, paying cargo, or nothing. */
function carries(kind: CarKind, required: boolean): string {
  if (required) return 'it carries the contract';
  const pay = kind === 'loco' || kind === 'tender' ? 0 : (CARGO_PAY[kind] ?? 0);
  return pay > 0 ? `its cargo pays ${money(pay)} on arrival` : '';
}

function carBox(kind: CarKind, required: boolean): HTMLElement {
  const spec = CAR_SPECS[kind];
  const what = carries(kind, required);
  return h(
    'div',
    { class: `car car-${kind} ${required ? 'required' : ''}`, style: { flexGrow: String(spec.length) }, title: `${CAR_LABELS[kind]}: ${distance(spec.length)}, ${tons(spec.mass)}${what ? `; ${what}` : ''}` },
    h('span', { class: 'car-name', text: CAR_LABELS[kind] }),
  );
}

function trainSection(card: RunCard, lobby: LobbyState, act: (a: DepotAction) => void): Node[] {
  const consist = lobby.consist;
  const chosen = lobby.campaign.consist;
  const available = availableCars(lobby.campaign);
  const full = consist.length >= card.maxCars;
  // The loco is on the right, as in the Rider's view (spec §6.1).
  const strip = h(
    'div',
    { class: 'car-strip', ariaLabel: `Train: ${['Loco', 'Tender', ...consist.map((c) => CAR_LABELS[c])].join(', ')}` },
    ...[...consist].reverse().map((c) => carBox(c, card.requiredCars.includes(c))),
    carBox('tender', false),
    carBox('loco', false),
  );
  const chips = h('div', { class: 'chips' });
  // The contract's own cars come first: always coupled, carrying the contract (spec §12).
  for (const car of card.requiredCars) {
    const label = CAR_LABELS[car];
    chips.append(h('span', { class: 'chip required', text: `${label} · carries the contract`, title: `The contract rides in the ${label.toLowerCase()} car: it's always coupled, and pays nothing extra` }));
  }
  for (const car of CHIP_CARS) {
    if (card.requiredCars.includes(car)) continue;
    const label = CAR_LABELS[car];
    // Cargo cars say what they pay (spec §12): "Boxcar +$30".
    const pay = CARGO_PAY[car] ?? 0;
    const text = pay > 0 ? `${label} +${money(pay)}` : label;
    const what = pay > 0 ? `: its cargo pays ${money(pay)} on arrival` : ': it carries no cargo';
    if (consist.includes(car)) {
      chips.append(button(text, () => act({ kind: 'toggleCar', car }), 'chip on', { title: `Uncouple the ${label.toLowerCase()} car${what}`, attrs: { 'aria-pressed': 'true' } }));
    } else if (chosen.includes(car)) {
      chips.append(button(`${label} · no room`, () => act({ kind: 'toggleCar', car }), 'chip noroom', { title: `Chosen, but this run takes only ${card.maxCars} cars. Click to take it off the list.` }));
    } else if (available.includes(car)) {
      chips.append(
        button(text, () => act({ kind: 'toggleCar', car }), 'chip', {
          disabled: full,
          title: full ? `The train is full: ${card.maxCars} cars at most` : `Couple the ${label.toLowerCase()} car${what}`,
          attrs: { 'aria-pressed': 'false' },
        }),
      );
    } else {
      chips.append(h('span', { class: 'chip locked', text: `${label} · in the shop`, title: 'Buy it in the shop to couple it' }));
    }
  }
  const mass = trainMass(consist);
  const top = topSpeed(mass);
  const cargo = cargoCars(consist, card.requiredCars).reduce((n, c) => n + c.pay, 0);
  const replay = card.times > 0;
  return [
    strip,
    h('div', { class: 'chips-row' }, h('span', { class: 'chips-label', text: 'Couple' }), chips),
    h(
      'p',
      { class: 'train-stats' },
      h('strong', { text: `${plural(consist.length, 'car')} of ${card.maxCars}` }),
      // What the cargo pays, next to what its weight costs.
      ` · ${cargo > 0 ? `cargo pays ${money(cargo)}` : 'no paying cargo'} · ${tons(mass)} · top speed about ${mph(top)}`,
      h('br'),
      h('span', {
        class: 'small muted',
        text: `Cargo cars pay on arrival${replay ? ' (half on a replay)' : ''}, but heavier trains are slower, and horsemen can board at ${mph(BOARDING_SPEED)} or less.`,
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------
// Assists and the shop
// ---------------------------------------------------------------------------------------------

function assistToggles(lobby: LobbyState, act: (a: DepotAction) => void): Node[] {
  const a = lobby.campaign.assists;
  const toggle = (seat: 'rider' | 'engineer', title: string, blurb: string): HTMLElement =>
    h(
      'button',
      {
        class: `toggle ${a[seat] ? 'on' : ''}`,
        type: 'button',
        attrs: { 'aria-pressed': String(a[seat]) },
        on: { click: () => act({ kind: 'assist', seat, on: !a[seat] }) },
      },
      h('span', { class: 'switch', ariaLabel: a[seat] ? 'On' : 'Off' }),
      h('span', { class: 'toggle-text' }, h('strong', { text: title }), h('span', { class: 'small muted', text: blurb })),
    );
  return [toggle('rider', 'Rider assist', '+2 hearts and aim assist'), toggle('engineer', 'Engineer assist', 'Automatic firebox, conflict advice on the chart')];
}

function shopList(lobby: LobbyState, act: (a: DepotAction) => void): Node[] {
  const c = lobby.campaign;
  const out: Node[] = [h('div', { class: 'purse' }, h('span', { class: 'purse-label', text: 'Money' }), h('span', { class: 'purse-amount', text: money(c.money) }))];
  for (const [seat, title] of SHOP_GROUPS) {
    const group = h('div', { class: 'shop-group' }, h('div', { class: 'shop-head', text: title }));
    out.push(group);
    for (const item of SHOP.filter((s) => s.seat === seat)) {
      const owned = c.owned.includes(item.id);
      const short = !owned && c.money < item.cost;
      group.append(
        h(
          'div',
          { class: `shop-item ${owned ? 'owned' : ''}` },
          h('span', { class: 'shop-text' }, h('strong', { text: item.name }), h('span', { class: 'shop-blurb', text: item.blurb })),
          owned
            ? h('span', { class: 'owned-tag', text: 'Owned' })
            : button(money(item.cost), () => act({ kind: 'buy', item: item.id }), 'btn small-btn buy', {
                disabled: short,
                title: short ? `Not enough money: it costs ${money(item.cost)}` : `Buy the ${item.name} for ${money(item.cost)}`,
              }),
        ),
      );
    }
  }
  return out;
}
