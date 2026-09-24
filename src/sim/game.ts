// The game loop entry points (spec §15). SCAFFOLD: the API below is final; the internals are a
// placeholder until the train, traffic, signals, rider and bandit modules are integrated (milestone 3).

import { moveSpans, netIndex, spansFromFront } from './network';
import { seedRng } from './rng';
import { CAR_SPECS, DT, HEARTS, P_START, TICK_HZ, WATER_CAP, WEAPONS } from './rules';
import type {
  Assists,
  CarState,
  CarType,
  DebugCmd,
  EngineerCmd,
  GameState,
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

// SCAFFOLD: replaced by train.ts's layoutConsist during integration.
function layoutCars(consist: readonly CarType[]): { cars: CarState[]; length: number; mass: number } {
  const kinds = ['loco', 'tender', ...consist] as const;
  const length = kinds.reduce((n, k) => n + CAR_SPECS[k].length, 0);
  let x1 = length;
  let mass = 0;
  const cars: CarState[] = [];
  for (const kind of kinds) {
    const spec = CAR_SPECS[kind];
    cars.push({ kind, x0: x1 - spec.length, x1, hp: spec.hp });
    x1 -= spec.length;
    mass += spec.mass;
  }
  return { cars, length, mass };
}

export function newGame(run: RunDef, opts: NewGameOptions): GameState {
  const ix = netIndex(run);
  const rng = seedRng(opts.seed);
  const variant = run.variants[(opts.seed >>> 0) % run.variants.length];
  const { cars, length, mass } = layoutCars(opts.consist);
  const switches: Record<string, SwitchState> = {};
  for (const j of run.junctions) switches[j.node] = j.initial;
  const spans = spansFromFront(ix, switches, run.start, length);
  const waterCap = opts.upgrades.includes('bigTender') ? 140 : WATER_CAP;
  const weapons = (['revolver', 'shotgun', 'rifle'] as const).filter((w) => w === 'revolver' || opts.upgrades.includes(w));
  const maxHearts = HEARTS + (opts.upgrades.includes('extraHeart') ? 1 : 0) + (opts.assists.rider ? 2 : 0);
  const riderCar = cars.length > 2 ? 2 : 1;
  return {
    runId: run.id,
    seed: opts.seed,
    variant,
    tick: 0,
    rng,
    phase: 'running',
    loss: null,
    clock0: run.startClock,
    arrivedClock: null,
    upgrades: [...opts.upgrades],
    assists: { ...opts.assists },
    train: {
      cars,
      length,
      mass,
      spans,
      v: 0,
      odometer: 0,
      throttle: 0,
      brake: 0,
      reverser: 1,
      fire: 2,
      pressure: P_START,
      water: Math.min(waterCap, run.initialWater),
      waterCap,
      safetyValve: false,
      dryTicks: 0,
      whistle: false,
      whistleTicks: 0,
      heldUp: false,
      overspeed: 0,
      overspeedTicks: 0,
      spout: 'up',
      spoutTower: null,
      stationStop: null,
      lastStation: run.origin,
      pendingCheckpoint: null,
    },
    switches,
    obstacles: run.obstacles
      .filter((o) => !o.variants || o.variants.includes(variant))
      .map((o) => ({ id: o.id, kind: o.kind, edge: o.edge, at: o.at, state: 'present' as const, ticks: 0 })),
    ai: run.aiTrains.map((t) => ({ id: t.id, active: false, done: false, spans: [], v: 0, started: false, wrecked: false })),
    signals: { restriction: null, passed: {} },
    rider: {
      x: (cars[riderCar].x0 + cars[riderCar].x1) / 2,
      y: CAR_SPECS[cars[riderCar].kind].roofY,
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
    },
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

/** Advances the game by one tick. Mutates `state`; returns the tick's events. */
export function step(state: GameState, run: RunDef, _input: RiderInput, cmds: EngineerCmd[], _debug: DebugCmd[] = []): SimEvent[] {
  const events: SimEvent[] = [];
  if (state.phase !== 'running') return events;
  const t = state.train;
  for (const c of cmds) {
    // SCAFFOLD: the real command handling lives in train.ts.
    if (c.kind === 'throttle') t.throttle = Math.max(0, Math.min(1, c.value));
    else if (c.kind === 'brake') t.brake = Math.max(0, Math.min(1, c.value));
    else if (c.kind === 'switch') state.switches[c.junction] = c.state;
    events.push({ type: 'cmdResult', seq: c.seq, ok: true });
  }
  // SCAFFOLD: crude motion so the shell has something moving.
  t.v = Math.max(0, t.v + (t.throttle * 0.5 - t.brake * 1.1 - 0.02) * DT);
  const m = moveSpans(netIndex(run), state.switches, t.spans, t.v * DT);
  t.spans = m.spans;
  t.odometer += m.moved;
  if (m.blocked) t.v = 0;
  state.tick++;
  return events;
}

export function isOver(state: GameState): boolean {
  return state.phase !== 'running';
}

export function runResult(state: GameState, run: RunDef): RunResult {
  const timeSec = state.tick / TICK_HZ;
  return {
    runId: run.id,
    outcome: state.phase === 'won' ? 'won' : 'lost',
    reason: state.loss?.reason ?? null,
    detail: state.loss?.detail ?? '',
    timeSec,
    arrivedClock: state.arrivedClock,
    deadline: run.contract.deadline,
    pay: 0,
    latePenalty: 0,
    sideJobPay: 0,
    fines: state.stats.fines,
    total: 0,
    medals: [],
    stats: { ...state.stats },
  };
}
