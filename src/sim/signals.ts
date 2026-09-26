// Signals and the rulebook (spec §9): what each signal shows, worked out from its block along the
// route the switches set now; the loco passing signals; approach and diverging restrictions and
// fines. Aspects are derived, never stored, so they follow the obstacles, the other trains and the
// switches the moment those change.

import { netIndex, spanDir, spanLength, spansOverlap, switchOf, walk, xOnSpans, type NetIndex } from './network';
import {
  APPROACH_LIMIT,
  BLOCK_MAX,
  DIVERGE_LIMIT,
  RED_SIGNAL_FINE,
  secondsToTicks,
  SIGNAL_DEBOUNCE_SECONDS,
  SPEED_FINE,
  SPEED_FINE_TOLERANCE,
} from './rules';
import type { Aspect, GameState, RunDef, SignalDef, SignalMemo, SimEvent, Span, TickMotion } from './types';

const EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Blocks and aspects (spec §9.2)
// ---------------------------------------------------------------------------------------------

/** The track a signal protects, and the next signal facing the same way, where the block ends (if it does). */
export interface Block {
  spans: Span[];
  next: string | null;
}

function signalDef(run: RunDef, id: string): SignalDef {
  const s = run.signals.find((g) => g.id === id);
  if (!s) throw new Error(`Unknown signal "${id}"`);
  return s;
}

/**
 * A signal's block: from the signal in its facing direction, following the switches as they are
 * now, to the next signal facing the same way, an end node, or BLOCK_MAX.
 */
export function blockOf(state: GameState, run: RunDef, signalId: string): Block {
  const ix = netIndex(run);
  const sig = signalDef(run, signalId);
  const w = walk(ix, state.switches, { edge: sig.edge, off: sig.at, dir: sig.facing }, BLOCK_MAX);
  const spans: Span[] = [];
  let walked = 0;
  for (const s of w.spans) {
    const dir = spanDir(s);
    const len = spanLength(s);
    // The nearest signal on this stretch governing the same direction of travel. One standing where
    // the walk began (the signal itself) doesn't end the block; one just past a node does.
    let next: SignalDef | null = null;
    let nextD = Infinity;
    for (const g of ix.features.get(s.edge)?.signals ?? []) {
      if (g.facing !== dir) continue;
      const d = (g.at - s.from) * dir;
      if (d < -EPS || d > len + EPS || walked + d <= EPS || d >= nextD) continue;
      next = g;
      nextD = d;
    }
    if (next) {
      if (nextD > EPS) spans.push({ edge: s.edge, from: s.from, to: next.at });
      return { spans, next: next.id };
    }
    spans.push({ ...s });
    walked += len;
  }
  return { spans, next: null };
}

/**
 * Is anything in the way on this stretch? An obstacle still on the line (present, or cattle still
 * scattering; not one a train has already pushed aside or smashed through) and any other train on
 * the map, the runaway included. The player's own train never counts: a signal protects the track
 * ahead of it.
 */
function obstructed(state: GameState, block: readonly Span[]): boolean {
  for (const o of state.obstacles) {
    const onLine = o.state === 'present' || o.state === 'scattering';
    if (onLine && xOnSpans(block, { edge: o.edge, off: o.at }) !== null) return true;
  }
  for (const a of state.ai) if (a.active && spansOverlap(a.spans, block)) return true;
  return false;
}

/** What a signal shows right now (spec §9.2). */
export function aspectOf(state: GameState, run: RunDef, signalId: string): Aspect {
  const sig = signalDef(run, signalId);
  const block = blockOf(state, run, signalId);
  if (obstructed(state, block.spans)) return 'stop';
  // One signal ahead only: the next signal shows stop exactly when its own block is obstructed.
  const nextStop = block.next !== null && obstructed(state, blockOf(state, run, block.next).spans);
  // A junction signal reads the leg its switch selects; the reverse leg is the diverging route.
  const diverging = sig.kind === 'junction' && sig.junction !== undefined && switchOf(netIndex(run), state.switches, sig.junction) === 'reverse';
  if (diverging) return nextStop ? 'divergeApproach' : 'divergeClear';
  return nextStop ? 'approach' : 'clear';
}

// ---------------------------------------------------------------------------------------------
// Passing signals, restrictions and fines (spec §9.3)
// ---------------------------------------------------------------------------------------------

export function initialSignals(): SignalMemo {
  return { restriction: null, passed: {} };
}

/** The speed limit (m/s) an approach or diverging restriction imposes now; Infinity when none does. */
export function restrictionLimit(state: GameState): number {
  return state.signals.restriction?.limit ?? Infinity;
}

/**
 * The signals the loco's front passed this tick, in the order it met them: those it crossed (as
 * pathCrosses counts a crossing: the path's start was last tick's end) while travelling their way.
 */
function signalsPassed(ix: NetIndex, frontPath: readonly Span[]): SignalDef[] {
  const hits: { sig: SignalDef; at: number }[] = [];
  let acc = 0;
  frontPath.forEach((s, i) => {
    const dir = spanDir(s);
    const len = spanLength(s);
    for (const g of ix.features.get(s.edge)?.signals ?? []) {
      const d = (g.at - s.from) * dir;
      if (g.facing === dir && d > (i === 0 ? EPS : -EPS) && d <= len + EPS) hits.push({ sig: g, at: acc + d });
    }
    acc += len;
  });
  return hits.sort((a, b) => a.at - b.at).map((h) => h.sig);
}

function fine(state: GameState, reason: 'redSignal' | 'speeding' | 'junction', amount: number, events: SimEvent[]): void {
  state.stats.fines += amount;
  events.push({ type: 'fine', reason, amount });
}

/**
 * Track distance from a junction signal to its junction, walking the way the signal faces with the
 * switches as they are now. If the junction isn't on that walk (a malformed run), the whole walk:
 * at most BLOCK_MAX, past which the next signal ends the restriction anyway.
 */
function distanceToJunction(ix: NetIndex, state: GameState, sig: SignalDef): number {
  const w = walk(ix, state.switches, { edge: sig.edge, off: sig.at, dir: sig.facing }, BLOCK_MAX);
  return w.nodes.find((n) => n.node === sig.junction)?.at ?? w.walked;
}

/**
 * Signals passed and fines (spec §15 step 7). Passing a signal lifts any restriction from the one
 * before; stop is fined at once. Approach and divergeApproach restrict the speed until the next
 * signal; divergeClear until the train's rear has passed the junction beyond it (by the odometer:
 * the distance to the junction plus the train's length), or the next signal if that comes first.
 * Going over the limit (with SPEED_FINE_TOLERANCE) is fined once per signal: 'speeding' under a
 * caution, 'junction' through a diverging junction (only a diverging restriction has a liftAt).
 */
export function stepSignals(state: GameState, run: RunDef, motion: TickMotion, events: SimEvent[]): void {
  if (state.phase !== 'running') return;
  const ix = netIndex(run);
  const t = state.train;
  const memo = state.signals;
  const debounce = secondsToTicks(SIGNAL_DEBOUNCE_SECONDS);
  for (const sig of signalsPassed(ix, motion.frontPath)) {
    const last = memo.passed[sig.id];
    memo.passed[sig.id] = state.tick;
    if (last !== undefined && state.tick - last < debounce) continue;
    // The player's own train never counts toward an aspect, so what the signal shows now is what
    // it showed as the loco came up to it.
    const aspect = aspectOf(state, run, sig.id);
    events.push({ type: 'signalPassed', id: sig.id, aspect });
    memo.restriction = null;
    if (aspect === 'stop') {
      state.stats.redSignals++;
      fine(state, 'redSignal', RED_SIGNAL_FINE, events);
    } else if (aspect === 'approach' || aspect === 'divergeApproach') {
      memo.restriction = { signalId: sig.id, limit: APPROACH_LIMIT, fined: false };
    } else if (aspect === 'divergeClear') {
      const liftAt = t.odometer + distanceToJunction(ix, state, sig) + t.length;
      memo.restriction = { signalId: sig.id, limit: DIVERGE_LIMIT, fined: false, liftAt };
    }
  }
  // Through the junction, the diverging track's own limit applies (spec §9.3).
  if (memo.restriction?.liftAt !== undefined && t.odometer >= memo.restriction.liftAt) memo.restriction = null;
  const r = memo.restriction;
  if (r && !r.fined && Math.abs(t.v) > r.limit * SPEED_FINE_TOLERANCE) {
    r.fined = true;
    state.stats.speedFines++;
    fine(state, r.liftAt === undefined ? 'speeding' : 'junction', SPEED_FINE, events);
  }
}
