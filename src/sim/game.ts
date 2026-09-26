// The game loop (spec §15): a run's starting state, and one tick at a time in the spec's order:
// debug commands, the Engineer's commands, the train (which reports what its front covered), the
// other trains, signals and telegrams, wave triggers, the Rider, the bandits, and the outcome.

import { spawnWave, stepBandits } from './bandits';
import { banditAlive, damageBandit, damageHorseman, horsemanAlive, type FightCtx } from './fight';
import { frameRange, framePath, framePoint, frameX, moveSpans, netIndex, pathCrosses, type FramePath } from './network';
import { initialLoot, initialRider, stepRider } from './rider';
import { seedRng } from './rng';
import { CARGO_PAY, SCOPE_MAX, SCOPE_MAX_HEADLAMP, SCOPE_MAX_NIGHT, TICK_HZ } from './rules';
import { initialSignals, stepSignals } from './signals';
import { initialTraffic, stepTelegrams, stepTraffic } from './traffic';
import { applyEngineerCmd, initialTrain, stepTrain, tryLowerSpout } from './train';
import type {
  Assists,
  CarKind,
  CarType,
  DebugCmd,
  EngineerCmd,
  FrameHazard,
  GameState,
  Medal,
  RiderInput,
  RunDef,
  RunResult,
  SimEvent,
  SwitchState,
  UpgradeId,
} from './types';

export interface NewGameOptions {
  seed: number;
  /** The full consist behind the tender, front to back (see composeConsist). */
  consist: CarType[];
  upgrades: UpgradeId[];
  assists: Assists;
}

/** A run's consist: its required cars, then the chosen optional ones, without duplicates, at most maxCars. */
export function composeConsist(run: RunDef, optional: readonly CarType[]): CarType[] {
  const out: CarType[] = [...run.requiredCars];
  for (const c of optional) if (!out.includes(c) && out.length < run.maxCars) out.push(c);
  return out.slice(0, Math.max(run.maxCars, run.requiredCars.length));
}

/** Clock (s since midnight) now. */
export function clockOf(state: GameState): number {
  return state.clock0 + state.tick / TICK_HZ;
}

/** The variant a seed picks (spec §13). */
export function variantFor(run: RunDef, seed: number): string {
  return run.variants[(seed >>> 0) % run.variants.length];
}

/** How far the spyglass reaches now (spec §6.5). */
export function scopeMaxFor(state: GameState, run: RunDef): number {
  if (!run.night) return SCOPE_MAX;
  return state.upgrades.includes('headlamp') ? SCOPE_MAX_HEADLAMP : SCOPE_MAX_NIGHT;
}

export function newGame(run: RunDef, opts: NewGameOptions): GameState {
  const variant = variantFor(run, opts.seed);
  const train = initialTrain(run, opts.consist, opts.upgrades, opts.assists);
  const switches: Record<string, SwitchState> = {};
  for (const j of run.junctions) switches[j.node] = j.initial;
  return {
    runId: run.id,
    seed: opts.seed,
    variant,
    tick: 0,
    rng: seedRng(opts.seed),
    phase: 'running',
    loss: null,
    clock0: run.startClock,
    arrivedClock: null,
    upgrades: [...opts.upgrades],
    assists: { ...opts.assists },
    train,
    switches,
    obstacles: run.obstacles
      .filter((o) => !o.variants || o.variants.includes(variant))
      .map((o) => ({ id: o.id, kind: o.kind, edge: o.edge, at: o.at, state: 'present' as const, ticks: 0, calmTicks: 0 })),
    ai: initialTraffic(run),
    signals: initialSignals(),
    rider: initialRider(train.cars, opts.upgrades, opts.assists),
    horsemen: [],
    bandits: [],
    loot: initialLoot(),
    waves: run.waves.filter((w) => !w.variants || w.variants.includes(variant)).map((w) => ({ id: w.id, triggered: false, queued: 0 })),
    flags: [],
    telegramsSent: [],
    sideJobs: run.sideJobs.map((j) => ({ id: j.id, state: 'pending' as const })),
    stats: {
      shotsFired: 0,
      hits: 0,
      horsemenDowned: 0,
      banditsDowned: 0,
      heartsLost: 0,
      timesOff: 0,
      timesDown: 0,
      redSignals: 0,
      speedFines: 0,
      fines: 0,
      waterStops: 0,
      holdups: 0,
      maxSpeed: 0,
      carDamage: 0,
    },
    nextId: 1,
    godMode: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The train frame around the train, for the people on it (spec §6.1)
// ---------------------------------------------------------------------------------------------

/**
 * How far behind the rear hazards are looked for (a portal passing over the last car, a Rider fallen
 * off a trestle, a ford a horseman is still wading): as far back as riders are followed.
 */
const HAZARD_BEHIND = 100;
/** …and ahead of the loco's front (a portal or beam about to reach the cab roof). */
const HAZARD_AHEAD = 40;

/** Tunnels, low bridges, trestles and fords near the train, in the train frame. */
export function hazardsNear(state: GameState, run: RunDef, ahead: number): FrameHazard[] {
  const ix = netIndex(run);
  const fp = framePath(ix, state.switches, state.train.spans, HAZARD_BEHIND, ahead);
  const out: FrameHazard[] = [];
  const seen = new Set<string>();
  for (const s of fp.spans) {
    const f = ix.features.get(s.edge);
    if (!f) continue;
    for (const t of f.tunnels) {
      const r = frameRange(fp, t.edge, t.from, t.to);
      if (r && !seen.has(t.id)) out.push({ kind: 'tunnel', id: t.id, x0: r[0], x1: r[1] });
      seen.add(t.id);
    }
    for (const b of f.lowBridges) {
      const x = frameX(fp, { edge: b.edge, off: b.at });
      if (x !== null && !seen.has(b.id)) out.push({ kind: 'lowBridge', id: b.id, x0: x, x1: x });
      seen.add(b.id);
    }
    for (const t of f.trestles) {
      const r = frameRange(fp, t.edge, t.from, t.to);
      if (r && !seen.has(t.id)) out.push({ kind: 'trestle', id: t.id, x0: r[0], x1: r[1], burning: !!t.burning });
      seen.add(t.id);
    }
    for (const fd of f.fords) {
      const r = frameRange(fp, fd.edge, fd.from, fd.to);
      if (r && !seen.has(fd.id)) out.push({ kind: 'ford', id: fd.id, x0: r[0], x1: r[1] });
      seen.add(fd.id);
    }
  }
  return out;
}

/**
 * The context the Rider and bandit modules work in this tick (spec §15 steps 9–12), built after the
 * train has moved. The spyglass's track lookup is only built if a flag is actually placed.
 */
export function fightContext(state: GameState, run: RunDef): FightCtx {
  const scopeMax = scopeMaxFor(state, run);
  let fp: FramePath | null = null;
  return {
    state,
    run,
    hazards: hazardsNear(state, run, HAZARD_AHEAD),
    trackPointAt(x: number) {
      fp ??= framePath(netIndex(run), state.switches, state.train.spans, 0, scopeMax + 50);
      return framePoint(fp, x);
    },
    scopeMax,
  };
}

// ---------------------------------------------------------------------------------------------
// Debug commands (dev builds only; spec §19)
// ---------------------------------------------------------------------------------------------

function applyDebug(state: GameState, run: RunDef, cmd: DebugCmd, events: SimEvent[]): void {
  switch (cmd.kind) {
    case 'god':
      state.godMode = cmd.on;
      break;
    case 'killBandits': {
      const ctx = fightContext(state, run);
      for (const b of state.bandits) if (banditAlive(b)) damageBandit(ctx, b, b.hp, events);
      for (const h of state.horsemen) if (horsemanAlive(h)) damageHorseman(ctx, h, h.hp, events);
      for (const w of state.waves) w.queued = 0;
      break;
    }
    case 'skip': {
      const m = moveSpans(netIndex(run), state.switches, state.train.spans, cmd.meters);
      state.train.spans = m.spans;
      state.train.odometer += m.moved;
      break;
    }
    case 'water':
      state.train.water = state.train.waterCap;
      break;
  }
}

// ---------------------------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------------------------

/** Advances the game by one tick. Mutates `state`; returns the tick's events. */
export function step(state: GameState, run: RunDef, input: RiderInput, cmds: EngineerCmd[], debug: DebugCmd[] = []): SimEvent[] {
  const events: SimEvent[] = [];
  if (state.phase !== 'running') return events;
  for (const d of debug) applyDebug(state, run, d, events);
  for (const c of cmds) applyEngineerCmd(state, run, c, events);

  const motion = stepTrain(state, run, events);
  stepTraffic(state, run, motion, events);
  stepSignals(state, run, motion, events);
  stepTelegrams(state, run, motion, events);

  if (state.phase === 'running') {
    const ctx = fightContext(state, run);
    // Waves fire as the loco's front passes their trigger (spec §7.1).
    for (const w of state.waves) {
      if (w.triggered) continue;
      const def = run.waves.find((d) => d.id === w.id);
      if (def && pathCrosses(motion.frontPath, def.trigger)) {
        w.triggered = true;
        spawnWave(ctx, def, events);
      }
    }
    // The Rider's E lowers the water spout (spec §5.5); nothing else uses E.
    if (input.interactPressed && state.rider.mode === 'active') tryLowerSpout(state, run, events);
    stepRider(ctx, input, events);
    stepBandits(ctx, events);
  }

  state.tick++;
  return events;
}

/** The track point at train-frame x, looking up to `ahead` metres past the front (spyglass flags). */
export function trackPointAtX(state: GameState, run: RunDef, x: number, ahead: number): { edge: string; off: number } | null {
  const fp = framePath(netIndex(run), state.switches, state.train.spans, HAZARD_BEHIND, ahead);
  return framePoint(fp, x);
}

export function isOver(state: GameState): boolean {
  return state.phase !== 'running';
}

// ---------------------------------------------------------------------------------------------
// Results (spec §12)
// ---------------------------------------------------------------------------------------------

/** The medals a won run earned. */
export function medalsFor(state: GameState, run: RunDef): Medal[] {
  if (state.phase !== 'won') return [];
  const out: Medal[] = [];
  if (state.arrivedClock !== null && state.arrivedClock <= run.contract.deadline) out.push('onTime');
  if (state.stats.fines === 0) out.push('clean');
  if (!state.loot.everCracked && state.loot.status !== 'stolen' && state.stats.holdups === 0 && state.stats.carDamage === 0) out.push('untouched');
  return out;
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

/** What the optional cargo cars in a consist earn on a win (spec §12). */
export function cargoPayFor(run: Pick<RunDef, 'requiredCars'>, cars: readonly CarKind[]): number {
  return cargoCars(cars, run.requiredCars).reduce((n, c) => n + c.pay, 0);
}

export function runResult(state: GameState, run: RunDef): RunResult {
  const won = state.phase === 'won';
  const c = run.contract;
  const pay = won ? c.pay : 0;
  const cargoPay = won ? cargoPayFor(run, state.train.cars.map((car) => car.kind)) : 0;
  const lateSec = won && state.arrivedClock !== null ? state.arrivedClock - c.deadline : 0;
  const latePenalty = won && lateSec > 0 ? Math.min(pay, Math.ceil(lateSec / 60) * c.latePenaltyPerMin) : 0;
  const sideJobPay = won
    ? state.sideJobs.filter((j) => j.state === 'done').reduce((n, j) => n + (run.sideJobs.find((d) => d.id === j.id)?.pay ?? 0), 0)
    : 0;
  const fines = state.stats.fines;
  return {
    runId: run.id,
    outcome: won ? 'won' : 'lost',
    reason: state.loss?.reason ?? null,
    detail: state.loss?.detail ?? '',
    timeSec: state.tick / TICK_HZ,
    arrivedClock: state.arrivedClock,
    deadline: c.deadline,
    pay,
    latePenalty,
    cargoPay,
    sideJobPay,
    fines,
    total: won ? pay - latePenalty + cargoPay + sideJobPay - fines : 0,
    medals: medalsFor(state, run),
    stats: { ...state.stats },
  };
}
