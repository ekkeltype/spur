// Text for the Engineer's desk (spec §0 note 6: the sim is metric, the desk shows mph, miles and a
// 12-hour clock). Pure: tests/desk.test.ts imports this under Node.

import { MILE, MPH } from '../../sim/rules';
import type { AnyRun } from '../../sim/network';

const DAY = 24 * 3600;
/** A true minus sign: hyphens look like dashes next to Rye's digits. */
const MINUS = '−';

export function clockParts(sec: number): { hm: string; ampm: 'AM' | 'PM' } {
  const s = ((Math.floor(sec) % DAY) + DAY) % DAY;
  const h24 = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return { hm: `${h}:${String(m).padStart(2, '0')}`, ampm: h24 < 12 ? 'AM' : 'PM' };
}

/** "9:05 AM" from seconds since midnight, floored to the minute (a clock never runs ahead). */
export function formatClock(sec: number): string {
  const p = clockParts(sec);
  return `${p.hm} ${p.ampm}`;
}

/** "2:05" for a duration (floored to the second), "1:02:05" past an hour. */
export function formatMmSs(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The contract clock: time left before the deadline, or how late the train already is. */
export function formatRemaining(sec: number): { text: string; overdue: boolean } {
  return sec < 0 ? { text: `${formatMmSs(-sec)} late`, overdue: true } : { text: `${formatMmSs(sec)} left`, overdue: false };
}

export function formatMoney(n: number): string {
  const s = `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
  return n < 0 ? MINUS + s : s;
}

export const toMph = (ms: number): number => ms * MPH;

/** Metres below a kilometre, where a stop is judged ("850 m"), miles beyond ("1.5 mi"). */
export function formatDistance(m: number): string {
  const sign = m < 0 ? MINUS : '';
  const a = Math.abs(m);
  if (a < 999.5) return `${sign}${Math.round(a)} m`;
  const mi = a / MILE;
  return `${sign}${mi < 9.95 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** Below this closing speed (m/s) an ETA means nothing. */
const ETA_MIN_SPEED = 0.3;

/**
 * How long until the train covers `dist` metres at `speed` (m/s, + = toward it): what the Engineer
 * calls out ("Tunnel in 5 seconds!"). "—" when standing or backing away.
 */
export function formatEta(dist: number, speed: number): string {
  if (dist <= 0) return 'now';
  if (speed < ETA_MIN_SPEED) return '—';
  const t = Math.round(dist / speed);
  if (t < 1) return 'now';
  if (t < 60) return `${t} s`;
  if (t < 600) return formatMmSs(t);
  return `${Math.round(t / 60)} min`;
}

/** Speed limits are authored in m/s; plates show whole mph. */
export function limitMph(ms: number): number {
  return Math.round(ms * MPH);
}

/**
 * Switch numbers for the keys 1–9 and the map's glyphs: junctions left to right as drawn (then top
 * to bottom), so the numbers read in map order whatever order the run lists them in.
 */
export function junctionNumbers(run: AnyRun): Map<string, number> {
  const pos = new Map(run.nodes.map((n) => [n.id, n]));
  const sorted = [...run.junctions].sort((a, b) => {
    const na = pos.get(a.node);
    const nb = pos.get(b.node);
    return (na?.x ?? 0) - (nb?.x ?? 0) || (na?.y ?? 0) - (nb?.y ?? 0) || a.node.localeCompare(b.node);
  });
  return new Map(sorted.map((j, i) => [j.node, i + 1]));
}
