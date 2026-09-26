// Words and numbers as the menus show them: the clock, money, speed, distance and weight, and the
// names of things. Units are the railroad's (spec §0 note 6): mph, yards and miles, and tons.

import { formatDistance } from '../render/desk/format';
import { CARGO_PAY, CAR_SPECS, DRAG, HORSE_MAX, MPH, ROLL, TRACTIVE_MAX } from '../sim/rules';
import type { Cargo, CarKind, CarType, LossReason, Medal } from '../sim/types';

/** Seconds since midnight as a railroad clock: "2:15 PM". */
export function formatClock(sec: number): string {
  const total = Math.floor(Math.max(0, sec) / 60);
  const h24 = Math.floor(total / 60) % 24;
  const m = total % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** A duration: "9:41", or "1:02:05" past an hour. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

/** Whole dollars: "$1,240", "−$40". */
export function money(n: number): string {
  const v = Math.round(n);
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US')}`;
}

/** A signed amount for a payout line: "+$80", "−$50". */
export function signedMoney(n: number): string {
  return n > 0 ? `+${money(n)}` : money(n);
}

export function mph(ms: number): string {
  return `${Math.round(Math.abs(ms) * MPH)} mph`;
}

/** Metres as the railroad reads them: "85 yd", "1,240 yd", "1.2 mi" (the desk's format). */
export function distance(m: number): string {
  return formatDistance(m);
}

/** Tonnes (the sim's) per short ton, the 2,000 lb ton an American railroad weighs its cars in. */
const TONNES_PER_TON = 0.907185;

/** A weight in tons, from the sim's tonnes: "121 tons". */
export function tons(tonnes: number): string {
  return `${Math.round(tonnes / TONNES_PER_TON).toLocaleString('en-US')} tons`;
}

/** Train mass in tonnes: the loco, the tender and the cars. */
export function trainMass(consist: readonly CarKind[]): number {
  return CAR_SPECS.loco.mass + CAR_SPECS.tender.mass + consist.reduce((n, c) => n + CAR_SPECS[c].mass, 0);
}

/**
 * The cars in a consist that carry paying cargo of their own (spec §12, CARGO_PAY), front to back:
 * the optional express, passenger and boxcars. The run's required cars carry the contract, and the
 * armored car and the caboose carry nothing.
 */
export function cargoCars(consist: readonly CarKind[], required: readonly CarType[]): { car: CarType; pay: number }[] {
  const out: { car: CarType; pay: number }[] = [];
  for (const k of consist) {
    if (k === 'loco' || k === 'tender' || required.includes(k)) continue;
    const pay = CARGO_PAY[k] ?? 0;
    if (pay > 0) out.push({ car: k, pay });
  }
  return out;
}

/**
 * Top speed on the level at full throttle and full pressure (spec §5.3): where F/m = ROLL + DRAG·v².
 * An estimate for the depot; grades and pressure change it on the line.
 */
export function topSpeed(massTonnes: number): number {
  const a = TRACTIVE_MAX / Math.max(1, massTonnes) - ROLL;
  return a > 0 ? Math.sqrt(a / DRAG) : 0;
}

/** Horsemen can board at up to this speed (spec §7.2). */
export const BOARDING_SPEED = HORSE_MAX + 0.5;

export const CAR_LABELS: Record<CarKind, string> = {
  loco: 'Loco',
  tender: 'Tender',
  express: 'Express',
  passenger: 'Passenger',
  boxcar: 'Boxcar',
  armored: 'Armored',
  caboose: 'Caboose',
  powder: 'Powder',
};

export const CARGO_NAMES: Record<Cargo, string> = {
  mail: 'Mail',
  payroll: 'Payroll',
  silver: 'Silver',
  cash: 'Bank cash',
  dynamite: 'Dynamite',
  gold: 'Gold',
  freight: 'Freight',
};

export const MEDALS: readonly { id: Medal; name: string; blurb: string }[] = [
  { id: 'onTime', name: 'On time', blurb: 'Arrived by the deadline' },
  { id: 'clean', name: 'Clean', blurb: 'No fines' },
  { id: 'untouched', name: 'Untouched', blurb: 'Safe never cracked, cab never held up, no car hurt' },
];

/** The results headline for each way to lose (spec §3). */
export const LOSS_TITLES: Record<LossReason, string> = {
  collision: 'Collision',
  derailed: 'Derailed',
  obstacle: 'Wrecked on the line',
  boiler: 'The boiler blew',
  lootStolen: 'Robbed',
  powder: 'The powder car blew',
  trestle: 'The trestle gave way',
  buffers: 'Into the buffers',
};

export const ACT_NAMES: Record<number, string> = { 1: 'Act I · Iron Horse', 2: 'Act II · Single Track', 3: 'Act III' };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
