// The game loop (spec §15): a run's starting state, and one tick at a time in the spec's order:
// debug commands, the Engineer's commands, the train (which reports what its front covered), the
// other trains, signals and telegrams, wave triggers, the Rider, the bandits, and the outcome.

import { frameRange, framePath, framePoint, frameX, moveSpans, netIndex, pathCrosses } from './network';
import { seedRng } from './rng';
import { HEARTS, SCOPE_MAX, SCOPE_MAX_HEADLAMP, SCOPE_MAX_NIGHT, TICK_HZ, WEAPONS } from './rules';
import { initialSignals, stepSignals } from './signals';
import { initialTraffic, stepTelegrams, stepTraffic } from './traffic';
import { applyEngineerCmd, initialTrain, stepTrain, tryLowerSpout } from './train';
import type {
  Assists,
  CarState,
  CarType,
  DebugCmd,
  EngineerCmd,
  FrameHazard,
  GameState,
  Medal,
  RiderInput,
  RiderState,
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

// SCAFFOLD: replaced by rider.ts's initialRider when the fight module is integrated.
function scaffoldRider(cars: readonly CarState[], upgrades: readonly UpgradeId[], assists: Assists): RiderState {
  const weapons = (['revolver', 'shotgun', 'rifle'] as const).filter((w) => w === 'revolver' || upgrades.includes(w));
  const maxHearts = HEARTS + (upgrades.includes('extraHeart') ? 1 : 0) + (assists.rider ? 2 : 0);
  const riderCar = cars.length > 2 ? 2 : 1;
  const car = cars[riderCar];
  return {
    x: (car.x0 + car.x1) / 2,
    y: riderCar === 1 ? 2.8 : 4.2,
    vx: 0,
    vy: 0,
    onGround: true,
    surface: riderCar === 1 ? 'tenderTop' : 'roof',
    car: riderCar,
    inside: null,
    crouch: false,
    ladder: null,
    facing: 1,
    aim: 0,
    hearts: maxHearts,
    maxHearts,
    weapon: 'revolver',
    weapons: [...weapons],
    ammo: { revolver: WEAPONS.revolver.rounds, shotgun: WEAPONS.shotgun.rounds, rifle: WEAPONS.rifle.rounds },
    reloadTicks: 0,
    cooldownTicks: 0,
    invulnTicks: 0,
    stunTicks: 0,
    mode: 'active',
    respawnTicks: 0,
    scoped: false,
    scopeDist: 200,
    lastFastTick: -1000,
  };
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
      .map((o) => ({ id: o.id, kind: o.kind, edge: o.edge, at: o.at, state: 'present' as const, ticks: 0 })),
    ai: initialTraffic(run),
    signals: initialSignals(),
    rider: scaffoldRider(train.cars, opts.upgrades, opts.assists),
    horsemen: [],
    bandits: [],
    loot: { status: 'safe', crack: 0, x: 0, y: 0, carrier: null, everCracked: false },
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

/** How far behind the rear hazards are looked for (a portal passing over the last car, a Rider fallen off a trestle). */
const HAZARD_BEHIND = 60;

/** Tunnels, low bridges and trestles near the train, in the train frame. */
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
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Debug commands (dev builds only; spec §19)
// ---------------------------------------------------------------------------------------------

function applyDebug(state: GameState, run: RunDef, cmd: DebugCmd, events: SimEvent[]): void {
  switch (cmd.kind) {
    case 'god':
      state.godMode = cmd.on;
      break;
    case 'killBandits':
      for (const b of state.bandits) events.push({ type: 'banditDown', id: b.id, x: b.x, y: b.y, boss: b.boss });
      state.bandits = [];
      state.horsemen = [];
      for (const w of state.waves) w.queued = 0;
      if (state.train.heldUp) {
        state.train.heldUp = false;
        events.push({ type: 'holdupEnded' });
      }
      if (state.loot.status === 'carried' || state.loot.status === 'cracking') {
        state.loot.status = 'safe';
        state.loot.carrier = null;
      }
      break;
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
    // Waves fire as the loco's front passes their trigger (spec §7.1).
    for (const w of state.waves) {
      if (w.triggered) continue;
      const def = run.waves.find((d) => d.id === w.id);
      if (def && pathCrosses(motion.frontPath, def.trigger)) w.triggered = true;
    }
    // The Rider's E lowers the water spout (spec §5.5); nothing else uses E.
    if (input.interactPressed && state.rider.mode === 'active') tryLowerSpout(state, run, events);
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

export function runResult(state: GameState, run: RunDef): RunResult {
  const won = state.phase === 'won';
  const c = run.contract;
  const pay = won ? c.pay : 0;
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
    sideJobPay,
    fines,
    total: won ? pay - latePenalty + sideJobPay - fines : 0,
    medals: medalsFor(state, run),
    stats: { ...state.stats },
  };
}
