// Text for the Engineer's desk (spec §0 note 6: the sim is metric, the desk shows mph, yards and
// miles, and a 12-hour clock). Pure: tests/desk.test.ts imports this under Node. The menus use
// the same distance format (ui/text.ts).

import { MILE, MPH, TIME_SCALE, YARD } from '../../sim/rules';
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

/** Yards in a mile (1,760). */
const MILE_YARDS = Math.round(MILE / YARD);

/**
 * Metres as whole yards, rounded as a distance is read out: to 1 yd under 100, to 5 under 1,000 and
 * to 10 beyond (DECISIONS.md, round 2). Unsigned.
 */
export function roundYards(m: number): number {
  const yd = Math.abs(m) / YARD;
  const step = yd < 100 ? 1 : yd < 1000 ? 5 : 10;
  return Math.round(yd / step) * step;
}

/**
 * A distance as the railroad reads it (spec §0 note 6): yards below a mile ("85 yd", "1,240 yd"),
 * miles with one decimal from a mile up ("1.2 mi"). Never metres.
 */
export function formatDistance(m: number): string {
  const yd = roundYards(m);
  if (Math.abs(m) >= MILE || yd >= MILE_YARDS) return `${m < 0 ? MINUS : ''}${(Math.abs(m) / MILE).toFixed(1)} mi`;
  return `${m < 0 && yd > 0 ? MINUS : ''}${yd.toLocaleString('en-US')} yd`;
}

/**
 * Whole yards, never coarser: the precision-stop readout's distances to the stop mark and the spout,
 * where the last few yards are the point ("437 yd", "3 yd"). Unsigned.
 */
export function formatYards(m: number): string {
  return `${Math.round(Math.abs(m) / YARD).toLocaleString('en-US')} yd`;
}

/** A tolerance in whole yards, rounded down so keeping within it keeps within the rule ("16 yd" for 15 m). */
export function windowYards(m: number): string {
  return `${Math.floor(Math.abs(m) / YARD + 1e-9)} yd`;
}

/** Below this closing speed (m/s) an ETA means nothing. */
const ETA_MIN_SPEED = 0.3;

/**
 * Real seconds until the train covers `dist` metres at `speed` (the sim's m/s, + = toward it):
 * the world runs TIME_SCALE times the wall clock, and the players count on the wall clock.
 * Infinity when standing or backing away.
 */
export function secondsTo(dist: number, speed: number): number {
  return speed < ETA_MIN_SPEED ? Infinity : Math.max(0, dist) / (speed * TIME_SCALE);
}

/**
 * How long until the train covers `dist` metres at `speed` (m/s, + = toward it), in real seconds:
 * what the Engineer calls out ("Tunnel in 5 seconds!"). "—" when standing or backing away.
 */
export function formatEta(dist: number, speed: number): string {
  if (dist <= 0) return 'now';
  if (speed < ETA_MIN_SPEED) return '—';
  const t = Math.round(secondsTo(dist, speed));
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
