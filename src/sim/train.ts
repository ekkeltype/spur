// The player's train (spec §5, §8): the consist's layout in the train frame, the Engineer's
// commands (and the lurch of a slammed brake), and one tick of the train — boiler, motion along the
// track, speed limits, what the loco's front runs into (tunnels, fords, trestles, obstacles), the
// whistle and the cattle, station stops and water.

import {
  edgeOf,
  fouls,
  framePath,
  frameX,
  frontHead,
  gradeAt,
  limitAt,
  moveSpans,
  netIndex,
  pathCrosses,
  rearHead,
  spansFromFront,
  switchOf,
  walk,
  xOnSpans,
  type EdgeFeatures,
  type NetIndex,
} from './network';
import {
  AIR_BRAKES_FACTOR,
  BIG_TENDER_CAP,
  BRAKE_MAX,
  BUFFER_SAFE,
  CAB_LENGTH,
  CAR_SPECS,
  CATTLE_CALM_SECONDS,
  DERAIL_FACTOR,
  DERAIL_INSTANT,
  DERAIL_SECONDS,
  dragCoef,
  DRY_EXPLODE_SECONDS,
  DT,
  DWELL_SECONDS,
  EMERGENCY_BRAKE,
  FIRE_MAX,
  FULL_POWER_PSI,
  GOVERNOR_GAIN,
  GOVERNOR_HYSTERESIS,
  GOVERNOR_TARGET_PSI,
  GRAVITY,
  HEAT_LOSS,
  HOLDUP_BRAKE,
  HOLDUP_EASE,
  LOW_WATER,
  LURCH_COOLDOWN_SECONDS,
  LURCH_MIN_SPEED,
  MPH,
  OBSTACLE_SAFE,
  OBSTACLE_SCATTER_SECONDS,
  OVERSPEED_WARN,
  P_MAX,
  P_START,
  REVERSER_MAX_SPEED,
  ROLL,
  secondsToTicks,
  SPOUT_MAX_SPEED,
  SPOUT_PROMPT_RANGE,
  SPOUT_REACH,
  SPOUT_WINDOW,
  STATION_STOP_SPEED,
  STATION_WINDOW,
  STEAM_BASE,
  STEAM_PER_FIRE,
  STEAM_PER_MS,
  STOP_EPSILON,
  SWITCH_FOUL_DISTANCE,
  TENDER_HATCH_FROM_REAR,
  TICK_HZ,
  tractiveMax,
  WATER_CAP,
  WATER_FILL_RATE,
  WATER_PER_PSI,
  WHISTLE_EARSHOT,
  WHISTLE_SCARE_MAX,
  WHISTLE_SCARE_MIN,
  WHISTLE_SCARE_SECONDS,
  WHISTLE_STEAM,
} from './rules';
import type {
  Assists,
  CarKind,
  CarState,
  CarType,
  EngineerCmd,
  GameState,
  LossReason,
  ObstacleKind,
  ObstacleState,
  RunDef,
  SimEvent,
  StationDef,
  SwitchState,
  TickMotion,
  TrackHead,
  TrainState,
  UpgradeId,
  WaterTowerDef,
} from './types';

// ---- Tunables (to move into rules.ts) ---------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// The consist (spec §5.1, §6.1)
// ---------------------------------------------------------------------------------------------

/**
 * Loco, tender, then the consist, front to back, in the train frame: the loco's front at x = L and
 * the last car's rear at x = 0. Cars abut; platforms and bridge plates are inside each car's extent.
 */
export function layoutConsist(consist: readonly CarType[]): { cars: CarState[]; length: number; mass: number } {
  const kinds: CarKind[] = ['loco', 'tender', ...consist];
  const length = kinds.reduce((n, k) => n + CAR_SPECS[k].length, 0);
  const cars: CarState[] = [];
  let x1 = length;
  let mass = 0;
  for (const kind of kinds) {
    const spec = CAR_SPECS[kind];
    cars.push({ kind, x0: x1 - spec.length, x1, hp: spec.hp });
    x1 -= spec.length;
    mass += spec.mass;
  }
  return { cars, length, mass };
}

/** The train at the start of a run: stopped at the origin's platform, its stop already made (spec §3). */
export function initialTrain(run: RunDef, consist: readonly CarType[], upgrades: readonly UpgradeId[], _assists: Assists): TrainState {
  const { cars, length, mass } = layoutConsist(consist);
  const switches: Record<string, SwitchState> = {};
  for (const j of run.junctions) switches[j.node] = j.initial;
  const waterCap = upgrades.includes('bigTender') ? BIG_TENDER_CAP : WATER_CAP;
  return {
    cars,
    length,
    mass,
    spans: spansFromFront(netIndex(run), switches, run.start, length),
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
    // Long enough ago that the first lurch isn't held back by the cooldown.
    lurchTick: -secondsToTicks(LURCH_COOLDOWN_SECONDS),
    // Nobody dwells at the origin: the run starts with that stop complete.
    stationStop: { stationId: run.origin, ticks: secondsToTicks(DWELL_SECONDS), done: true },
    lastStation: run.origin,
    pendingCheckpoint: null,
  };
}

// ---------------------------------------------------------------------------------------------
// The Engineer's commands (spec §5.2)
// ---------------------------------------------------------------------------------------------

const HELD_UP = "Hands up! There's a gun on you.";

/** Is any train standing on the junction's edges within SWITCH_FOUL_DISTANCE of its node? */
export function switchFouled(ix: NetIndex, state: GameState, junction: string): boolean {
  if (fouls(ix, state.train.spans, junction, SWITCH_FOUL_DISTANCE)) return true;
  return state.ai.some((a) => a.active && fouls(ix, a.spans, junction, SWITCH_FOUL_DISTANCE));
}

/** Carries out one command; returns why it was refused, or null. */
function carryOut(state: GameState, run: RunDef, cmd: EngineerCmd, events: SimEvent[]): string | null {
  const t = state.train;
  if (t.heldUp && cmd.kind !== 'whistle') return HELD_UP;
  switch (cmd.kind) {
    case 'throttle':
    case 'brake': {
      if (!Number.isFinite(cmd.value)) return "That lever doesn't go there.";
      const was = t[cmd.kind];
      t[cmd.kind] = Math.max(0, Math.min(1, cmd.value));
      if (cmd.kind === 'brake') lurch(state, was, events);
      return null;
    }
    case 'fire':
      if (!Number.isFinite(cmd.value)) return "That lever doesn't go there.";
      if (governed(state)) return 'The governor is tending the fire.';
      t.fire = Math.max(0, Math.min(FIRE_MAX, Math.round(cmd.value)));
      return null;
    case 'reverser':
      if (cmd.value !== -1 && cmd.value !== 0 && cmd.value !== 1) return "That lever doesn't go there.";
      if (cmd.value === t.reverser) return null;
      if (Math.abs(t.v) >= REVERSER_MAX_SPEED) return 'Stop the train before moving the reverser.';
      t.reverser = cmd.value;
      return null;
    case 'whistle':
      if (!!cmd.on !== t.whistle) {
        t.whistle = !!cmd.on;
        events.push({ type: 'whistle', on: t.whistle });
      }
      return null;
    case 'switch': {
      const ix = netIndex(run);
      if (!ix.junction.has(cmd.junction) || (cmd.state !== 'normal' && cmd.state !== 'reverse')) return 'There is no such switch.';
      if (switchOf(ix, state.switches, cmd.junction) === cmd.state) return null;
      if (switchFouled(ix, state, cmd.junction)) return 'A train is standing on that switch.';
      state.switches[cmd.junction] = cmd.state;
      events.push({ type: 'switchThrown', junction: cmd.junction, state: cmd.state, by: 'engineer' });
      return null;
    }
  }
}

/** Applies one Engineer command and answers it with exactly one cmdResult (refusals carry a reason for the desk). */
export function applyEngineerCmd(state: GameState, run: RunDef, cmd: EngineerCmd, events: SimEvent[]): void {
  const refused = carryOut(state, run, cmd, events);
  events.push(refused === null ? { type: 'cmdResult', seq: cmd.seq, ok: true } : { type: 'cmdResult', seq: cmd.seq, ok: false, reason: refused });
}

/** The brake lever in emergency: above full service, EMERGENCY_BRAKE itself (spec §5.2). */
const emergency = (brake: number): boolean => brake > EMERGENCY_BRAKE;

/**
 * Slamming the brakes (spec §5.2): the lever going into emergency (from `was`, out of it) at
 * LURCH_MIN_SPEED or more lurches the train, at most once per LURCH_COOLDOWN_SECONDS. Holding it
 * there doesn't lurch again, and full service never does. Commands come first in a tick, so the
 * Rider and bandit modules see lurchTick === state.tick in the same step and do the rest.
 */
function lurch(state: GameState, was: number, events: SimEvent[]): void {
  const t = state.train;
  if (emergency(was) || !emergency(t.brake) || Math.abs(t.v) < LURCH_MIN_SPEED) return;
  if (state.tick - t.lurchTick < secondsToTicks(LURCH_COOLDOWN_SECONDS)) return;
  t.lurchTick = state.tick;
  events.push({ type: 'lurch' });
}

/**
 * A bandit in the cab eases the throttle shut, puts the brake on and has the fire let down (spec
 * §5.2). With the fire out a hold-up costs time and pressure, but can't boil the boiler dry while
 * the Engineer's hands are up.
 */
function holdUpOverride(t: TrainState): void {
  if (!t.heldUp) return;
  const ease = HOLDUP_EASE * DT;
  t.throttle = Math.max(0, t.throttle - ease);
  t.brake = t.brake < HOLDUP_BRAKE ? Math.min(HOLDUP_BRAKE, t.brake + ease) : Math.max(HOLDUP_BRAKE, t.brake - ease);
  t.fire = 0;
}

// ---------------------------------------------------------------------------------------------
// Losses
// ---------------------------------------------------------------------------------------------

/** m/s → whole mph, for loss details. */
const mph = (v: number): number => Math.round(Math.abs(v) * MPH);

/** Ends the run (once): the first loss of a tick wins. `detail` is a sentence for the results screen. */
function lose(state: GameState, events: SimEvent[], reason: LossReason, detail: string): void {
  if (state.phase !== 'running') return;
  state.phase = 'lost';
  state.loss = { reason, detail };
  events.push({ type: 'lost', reason, detail });
}

// ---------------------------------------------------------------------------------------------
// Boiler and water (spec §5.5)
// ---------------------------------------------------------------------------------------------

/** Height (m above the rails) of the boiler's centre, where its explosion is drawn. */
const BOILER_Y = 2.6;

/** Steam the cylinders draw (psi/s): throttle by speed, and none in neutral. */
function cylinderDraw(t: TrainState): number {
  return t.reverser === 0 ? 0 : t.throttle * (STEAM_BASE + STEAM_PER_MS * Math.abs(t.v));
}

/** The governor upgrade or the Engineer assist fires the boiler (spec §5.5, §12). */
export function governed(state: GameState): boolean {
  return state.upgrades.includes('governor') || state.assists.engineer;
}

/**
 * The firebox notch that holds about GOVERNOR_TARGET_PSI: enough to cover the cylinders and heat
 * loss, plus a correction toward the target, changing notch only when clearly needed. With no water
 * it drops the fire, since there's nothing to boil and a lit fire would wreck the boiler.
 */
export function governorFire(t: TrainState): number {
  if (t.water <= 0) return 0;
  const ideal = (cylinderDraw(t) + HEAT_LOSS + GOVERNOR_GAIN * (GOVERNOR_TARGET_PSI - t.pressure)) / STEAM_PER_FIRE;
  if (Math.abs(ideal - t.fire) <= 0.5 + GOVERNOR_HYSTERESIS) return t.fire;
  return Math.max(0, Math.min(FIRE_MAX, Math.round(ideal)));
}

function boiler(state: GameState, events: SimEvent[]): void {
  const t = state.train;
  if (governed(state) && !t.heldUp) t.fire = governorFire(t);
  const raised = t.water > 0 ? STEAM_PER_FIRE * t.fire : 0;
  // The whistle blows off steam too, so leaning on it costs pressure (spec §5.2).
  const whistle = t.whistle ? WHISTLE_STEAM : 0;
  const p = t.pressure + (raised - cylinderDraw(t) - HEAT_LOSS - whistle) * DT;
  // At P_MAX with a surplus the safety valve lifts and the surplus is lost (its water with it).
  const valve = p > P_MAX;
  if (valve !== t.safetyValve) {
    t.safetyValve = valve;
    events.push({ type: 'safetyValve', on: valve });
  }
  t.pressure = Math.max(0, Math.min(P_MAX, p));
  const before = t.water;
  t.water = Math.max(0, t.water - WATER_PER_PSI * raised * DT);
  // Warn on the way down through LOW_WATER: once, and again after a refill has lifted it back above.
  if (before >= LOW_WATER && t.water < LOW_WATER) events.push({ type: 'lowWater' });
  if (t.water > 0 || t.fire === 0) {
    t.dryTicks = 0;
    return;
  }
  t.dryTicks++;
  if (t.dryTicks >= secondsToTicks(DRY_EXPLODE_SECONDS)) {
    const loco = t.cars[0];
    events.push({ type: 'explosion', x: loco.x1 - (loco.x1 - loco.x0 - CAB_LENGTH) / 2, y: BOILER_Y, what: 'boiler' });
    lose(state, events, 'boiler', 'The boiler ran dry with the fire lit and blew apart.');
  }
}

// ---------------------------------------------------------------------------------------------
// Motion (spec §5.3)
// ---------------------------------------------------------------------------------------------

/**
 * Updates the speed for one tick: `a = F/m − resist − grade − brake`. Resistance and brakes oppose
 * motion and can bring the train to a stand, but never push it the other way; a standing train
 * moves only when throttle or gravity beats what rolling resistance and the brakes hold.
 */
function accelerate(ix: NetIndex, state: GameState): void {
  const t = state.train;
  const front = frontHead(t.spans);
  const power = Math.min(1, t.pressure / FULL_POWER_PSI);
  // kN / t = m/s². The grade is under the loco, signed by the way the train faces on that edge.
  const drive = (tractiveMax(state.upgrades) * t.throttle * power * t.reverser) / t.mass - GRAVITY * gradeAt(ix, front) * front.dir;
  const brake = t.brake * BRAKE_MAX * (state.upgrades.includes('airBrakes') ? AIR_BRAKES_FACTOR : 1);
  const hold = ROLL + brake;
  if (t.v === 0) {
    t.v = Math.abs(drive) <= hold ? 0 : (drive - Math.sign(drive) * hold) * DT;
    return;
  }
  const dir = Math.sign(t.v);
  let v = t.v + (drive - dir * (ROLL + dragCoef(state.upgrades) * t.v * t.v + brake)) * DT;
  if (Math.sign(v) !== dir) v = 0;
  if (Math.abs(v) < STOP_EPSILON && Math.abs(drive) <= hold) v = 0;
  t.v = v;
}

// ---------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------

/**
 * One tick of the player's train (spec §15 steps 3–6). Returns what the train did, for the modules
 * that trigger on the loco's front passing things (traffic, signals, waves, telegrams).
 */
export function stepTrain(state: GameState, run: RunDef, events: SimEvent[]): TickMotion {
  if (state.phase !== 'running') return { frontPath: [], moved: 0 };
  const ix = netIndex(run);
  const t = state.train;

  holdUpOverride(t);
  t.whistleTicks = t.whistle ? t.whistleTicks + 1 : 0;
  boiler(state, events);
  if (state.phase !== 'running') return { frontPath: [], moved: 0 };
  accelerate(ix, state);
  const before = frontHead(t.spans);
  const motion = move(ix, state, events);
  if (state.phase !== 'running') return motion;
  speedLimits(ix, state, events);
  if (state.phase !== 'running') return motion;
  passTunnelsFordsAndTrestles(ix, state, before, motion, events);
  if (state.phase !== 'running') return motion;
  obstacles(ix, state, motion, events);
  if (state.phase !== 'running') return motion;
  stations(ix, state, run, events);
  if (state.phase !== 'running') return motion;
  fillFromSpout(state, motion, events);
  return motion;
}

/** The nearest present rockslide within `dist` ahead of the loco's front, and how far ahead it is. */
function rocksAhead(ix: NetIndex, state: GameState, front: TrackHead, dist: number): { rock: ObstacleState; at: number } | null {
  const path = walk(ix, state.switches, front, dist).spans;
  let best: { rock: ObstacleState; at: number } | null = null;
  for (const o of state.obstacles) {
    if (o.kind !== 'rocks' || o.state !== 'present') continue;
    const at = o.edge === front.edge && Math.abs(o.at - front.off) < 1e-6 ? 0 : xOnSpans(path, { edge: o.edge, off: o.at });
    if (at !== null && (!best || at < best.at)) best = { rock: o, at };
  }
  return best;
}

/** Moves the train by v·DT along the track, springing trailing switches and stopping at the buffers. */
function move(ix: NetIndex, state: GameState, events: SimEvent[]): TickMotion {
  const t = state.train;
  const front = frontHead(t.spans);
  let d = t.v * DT;
  // A rockslide stops the train against it, or wrecks it (spec §8): nothing moves forward through it.
  const rocks = d > 0 ? rocksAhead(ix, state, front, d) : null;
  if (rocks) {
    d = rocks.at;
    // Touching them already (pinned against them) is no new contact.
    if (rocks.at > 1e-6) {
      const severe = t.v > OBSTACLE_SAFE.rocks;
      events.push({ type: 'obstacleHit', id: rocks.rock.id, kind: 'rocks', severe });
      if (severe) lose(state, events, 'obstacle', `Ran into a rockslide at ${mph(t.v)} mph.`);
    }
  }
  const m = moveSpans(ix, state.switches, t.spans, d);
  if (rocks) t.v = 0;
  // The front's path this tick, walked with the switches as the move found them.
  const frontPath = m.moved > 0 ? walk(ix, state.switches, front, m.moved).spans : [];
  t.spans = m.spans;
  t.odometer += m.moved;
  for (const tr of m.trails) {
    state.switches[tr.junction] = tr.state;
    events.push({ type: 'switchThrown', junction: tr.junction, state: tr.state, by: 'trailing' });
  }
  if (m.blocked) {
    // The leading end reached an end node (spec §4.1).
    if (Math.abs(t.v) > BUFFER_SAFE) {
      const label = ix.node.get(endNodeAhead(ix, t.v > 0 ? frontHead(t.spans) : rearHead(t.spans)))?.label;
      lose(state, events, 'buffers', `Hit the buffers${label ? ` at ${label}` : ''} at ${mph(t.v)} mph.`);
    }
    t.v = 0;
  }
  state.stats.maxSpeed = Math.max(state.stats.maxSpeed, Math.abs(t.v));
  return { frontPath, moved: m.moved };
}

// ---------------------------------------------------------------------------------------------
// Speed limits (spec §5.4)
// ---------------------------------------------------------------------------------------------

/** The track limit at the loco's front: the edge's speed, lowered by any curve covering it (m/s). */
export function limitHere(state: GameState, run: RunDef): number {
  return limitAt(netIndex(run), frontHead(state.train.spans));
}

function speedLimits(ix: NetIndex, state: GameState, events: SimEvent[]): void {
  const t = state.train;
  const front = frontHead(t.spans);
  const limit = limitAt(ix, front);
  const speed = Math.abs(t.v);
  const level: 0 | 1 | 2 = speed > limit * DERAIL_FACTOR ? 2 : speed > limit * OVERSPEED_WARN ? 1 : 0;
  // The squeal and the derail warning sound as they begin; the gauge shows them while they last.
  if (level > t.overspeed) events.push({ type: 'overspeed', level: level as 1 | 2 });
  t.overspeed = level;
  t.overspeedTicks = level === 2 ? t.overspeedTicks + 1 : 0;
  if (speed <= limit * DERAIL_INSTANT && t.overspeedTicks < secondsToTicks(DERAIL_SECONDS)) return;
  const e = edgeOf(ix, front.edge);
  const curve = ix.features.get(front.edge)?.curves.some((c) => front.off >= c.from && front.off <= c.to && c.limit === limit);
  const detail = curve
    ? `Took the ${e.name ? `${e.name} ` : ''}curve at ${mph(speed)} mph (limit ${mph(limit)}).`
    : `Derailed at ${mph(speed)} mph${e.name ? ` on ${e.name}` : ''}, where the limit is ${mph(limit)}.`;
  lose(state, events, 'derailed', detail);
}

// ---------------------------------------------------------------------------------------------
// What the loco's front passes (spec §4.3, §8)
// ---------------------------------------------------------------------------------------------

/** A feature covering a stretch of its edge. */
interface Stretch {
  edge: string;
  from: number;
  to: number;
}

/** Is a point on a feature's stretch of its edge? */
const within = (h: TrackHead, f: Stretch): boolean =>
  h.edge === f.edge && h.off >= Math.min(f.from, f.to) - 1e-6 && h.off <= Math.max(f.from, f.to) + 1e-6;

/** The stretches of one kind the loco's front left and entered this tick, going from `before` to `after`. */
function crossed<F extends Stretch>(of: (h: TrackHead) => readonly F[], before: TrackHead, after: TrackHead): { left: F[]; entered: F[] } {
  const was = of(before).filter((f) => within(before, f));
  const now = of(after).filter((f) => within(after, f));
  return { left: was.filter((f) => !now.includes(f)), entered: now.filter((f) => !was.includes(f)) };
}

/**
 * Tunnels and fords are entered and left by the loco's front either way (backing out of one leaves
 * it); trestles are announced, and a burning one judged, when the front enters moving forward.
 */
function passTunnelsFordsAndTrestles(ix: NetIndex, state: GameState, before: TrackHead, motion: TickMotion, events: SimEvent[]): void {
  if (motion.moved === 0) return;
  const after = frontHead(state.train.spans);
  const near = (h: TrackHead): EdgeFeatures | undefined => ix.features.get(h.edge);
  const tunnels = crossed((h) => near(h)?.tunnels ?? [], before, after);
  for (const tn of tunnels.left) events.push({ type: 'tunnelExit', id: tn.id });
  for (const tn of tunnels.entered) events.push({ type: 'tunnelEnter', id: tn.id });
  const fords = crossed((h) => near(h)?.fords ?? [], before, after);
  for (const fd of fords.left) events.push({ type: 'fordExit', id: fd.id });
  for (const fd of fords.entered) events.push({ type: 'fordEnter', id: fd.id });
  if (motion.moved < 0) return;
  for (const tr of near(after)?.trestles ?? []) {
    if (!within(after, tr) || within(before, tr)) continue;
    events.push({ type: 'trestleEnter', id: tr.id, burning: !!tr.burning });
    const speed = Math.abs(state.train.v);
    if (tr.burning && speed < tr.burning.minSpeed) {
      lose(state, events, 'trestle', `The burning ${tr.name} gave way: the train went onto it at ${mph(speed)} mph and needed ${mph(tr.burning.minSpeed)}.`);
    }
  }
}

const OBSTACLE_LOSS: Record<ObstacleKind, string> = {
  rocks: 'Ran into a rockslide',
  cattle: 'Ploughed into cattle on the line',
  barricade: 'Hit a barricade on the line',
};

/**
 * The herds still on the line ahead of the loco's front, along the route the switches set now,
 * within `range` metres, with how far ahead each one is (m), nearest first (spec §8).
 */
export function herdsAhead(ix: NetIndex, state: GameState, range: number): { herd: ObstacleState; d: number }[] {
  const herds = state.obstacles.filter((o) => o.kind === 'cattle' && o.state === 'present');
  if (herds.length === 0) return [];
  const path = walk(ix, state.switches, frontHead(state.train.spans), range).spans;
  const out: { herd: ObstacleState; d: number }[] = [];
  for (const herd of herds) {
    const d = xOnSpans(path, { edge: herd.edge, off: herd.at });
    if (d !== null) out.push({ herd, d });
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * Cattle and the whistle (spec §8). A herd hears the whistle from WHISTLE_EARSHOT. Heard from
 * beyond the scare window it gets used to it: calm, and deaf to it, until CATTLE_CALM_SECONDS after
 * the last sound it heard. A blast that reaches WHISTLE_SCARE_SECONDS with the herd inside the
 * window scatters it, unless it's calm. So the blast has to begin inside the window: an early one,
 * or one held down all the way in, leaves the herd on the line. Herds hit or gone are left alone.
 */
function whistleAtCattle(ix: NetIndex, state: GameState, events: SimEvent[]): void {
  const t = state.train;
  const heard = t.whistle ? herdsAhead(ix, state, WHISTLE_EARSHOT) : [];
  const blast = t.whistleTicks === secondsToTicks(WHISTLE_SCARE_SECONDS);
  for (const o of state.obstacles) {
    if (o.kind !== 'cattle' || o.state !== 'present') continue;
    const d = heard.find((h) => h.herd === o)?.d ?? null;
    if (d !== null && d > WHISTLE_SCARE_MAX) {
      if (o.calmTicks === 0) events.push({ type: 'cattleCalm', id: o.id });
      o.calmTicks = secondsToTicks(CATTLE_CALM_SECONDS);
      continue;
    }
    if (o.calmTicks > 0) o.calmTicks--;
    if (blast && d !== null && d >= WHISTLE_SCARE_MIN && o.calmTicks === 0) {
      o.state = 'scattering';
      o.ticks = 0;
      events.push({ type: 'cattleScatter', id: o.id });
    }
  }
}

/**
 * The whistle at the cattle (a herd still leaving is still on the line); cattle and barricades are
 * judged when the loco's front reaches them moving forward: pushed aside or smashed through at a
 * safe speed, a wreck above it. Rocks stop the train in move().
 */
function obstacles(ix: NetIndex, state: GameState, motion: TickMotion, events: SimEvent[]): void {
  const t = state.train;
  whistleAtCattle(ix, state, events);
  for (const o of state.obstacles) {
    const onLine = o.state === 'present' || (o.kind === 'cattle' && o.state === 'scattering');
    if (o.kind === 'rocks' || !onLine || !pathCrosses(motion.frontPath, { edge: o.edge, off: o.at })) continue;
    const severe = Math.abs(t.v) > OBSTACLE_SAFE[o.kind];
    o.state = 'hit';
    o.ticks = 0;
    events.push({ type: 'obstacleHit', id: o.id, kind: o.kind, severe });
    if (severe) lose(state, events, 'obstacle', `${OBSTACLE_LOSS[o.kind]} at ${mph(t.v)} mph.`);
  }
  for (const o of state.obstacles) {
    if (o.state !== 'scattering') continue;
    o.ticks++;
    if (o.ticks >= secondsToTicks(OBSTACLE_SCATTER_SECONDS)) {
      o.state = 'gone';
      events.push({ type: 'obstacleCleared', id: o.id, kind: o.kind });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stations (spec §5.6)
// ---------------------------------------------------------------------------------------------

/** The station whose stop mark is nearest the loco's front, within ±STATION_WINDOW (along the track). */
function stationAtFront(ix: NetIndex, state: GameState, run: RunDef): StationDef | null {
  const t = state.train;
  const fp = framePath(ix, state.switches, t.spans, 0, STATION_WINDOW);
  let best: StationDef | null = null;
  let bestD = Infinity;
  for (const st of run.stations) {
    const x = frameX(fp, { edge: st.edge, off: st.at });
    const d = x === null ? Infinity : Math.abs(x - t.length);
    if (d <= STATION_WINDOW && d < bestD) {
      best = st;
      bestD = d;
    }
  }
  return best;
}

/** Side-job passengers alight at their destination and board at their station, if there's a car for them. Idempotent. */
function serveSideJobs(state: GameState, run: RunDef, stationId: string, events: SimEvent[]): void {
  for (const job of state.sideJobs) {
    const def = run.sideJobs.find((d) => d.id === job.id);
    if (!def) continue;
    if (job.state === 'aboard' && def.to === stationId) {
      job.state = 'done';
      events.push({ type: 'sideJob', id: job.id, state: 'done' });
    } else if (job.state === 'pending' && def.from === stationId && state.train.cars.some((c) => c.kind === def.needs)) {
      job.state = 'aboard';
      events.push({ type: 'sideJob', id: job.id, state: 'aboard' });
    }
  }
}

function completeStop(state: GameState, run: RunDef, st: StationDef, events: SimEvent[]): void {
  const t = state.train;
  t.lastStation = st.id;
  events.push({ type: 'stationDone', stationId: st.id });
  serveSideJobs(state, run, st.id, events);
  if (st.waterColumn && t.water < t.waterCap) {
    t.water = t.waterCap;
    state.stats.waterStops++;
    events.push({ type: 'waterFull' });
  }
  if (st.id === run.contract.destination) {
    state.phase = 'won';
    state.arrivedClock = state.clock0 + state.tick / TICK_HZ;
    events.push({ type: 'won' });
  } else if (st.checkpoint) {
    t.pendingCheckpoint = st.id;
  }
}

/** Moving off from a completed checkpoint stop saves the checkpoint (spec §3). */
function moveOff(t: TrainState, events: SimEvent[]): void {
  if (!t.pendingCheckpoint) return;
  events.push({ type: 'checkpoint', stationId: t.pendingCheckpoint });
  t.pendingCheckpoint = null;
}

/**
 * Stopped (|v| < STATION_STOP_SPEED) with the loco's front in a station's window, the stop completes
 * after DWELL_SECONDS; moving first resets it. A completed stop stays put until the front leaves the
 * window, so standing or creeping along the platform never makes the same stop twice.
 */
function stations(ix: NetIndex, state: GameState, run: RunDef, events: SimEvent[]): void {
  const t = state.train;
  const stopped = Math.abs(t.v) < STATION_STOP_SPEED;
  const here = stationAtFront(ix, state, run);
  const stop = t.stationStop;
  if (stop && here?.id !== stop.stationId) {
    moveOff(t, events);
    t.stationStop = null;
  } else if (stop && !stopped) {
    if (stop.done) moveOff(t, events);
    else t.stationStop = null;
  } else if (stop && here && !stop.done) {
    stop.ticks++;
    if (stop.ticks >= secondsToTicks(DWELL_SECONDS)) {
      stop.done = true;
      completeStop(state, run, here, events);
    }
  }
  if (!t.stationStop && here && stopped) {
    t.stationStop = { stationId: here.id, ticks: 0, done: false };
    events.push({ type: 'stationArrived', stationId: here.id });
  }
  // Passengers waiting at the origin board before the train leaves: its stop was made before the run began.
  if (t.stationStop?.done && state.phase === 'running') serveSideJobs(state, run, t.stationStop.stationId, events);
}

// ---------------------------------------------------------------------------------------------
// Water towers and the spout (spec §5.5)
// ---------------------------------------------------------------------------------------------

/** Train-frame x of the tender's water hatch (see views.hatchPoint for it on the track). */
export function hatchX(t: TrainState): number {
  return t.cars[1].x0 + TENDER_HATCH_FROM_REAR;
}

/** The water tower whose spout is nearest the hatch within `range` (along the track), and how far ahead of the hatch it is. */
function towerNearHatch(state: GameState, run: RunDef, range: number): { tower: WaterTowerDef; ahead: number } | null {
  if (run.waterTowers.length === 0) return null;
  const t = state.train;
  const hx = hatchX(t);
  const fp = framePath(netIndex(run), state.switches, t.spans, range, range);
  let best: { tower: WaterTowerDef; ahead: number } | null = null;
  for (const w of run.waterTowers) {
    const x = frameX(fp, { edge: w.edge, off: w.at });
    if (x === null || Math.abs(x - hx) > range) continue;
    if (!best || Math.abs(x - hx) < Math.abs(best.ahead)) best = { tower: w, ahead: x - hx };
  }
  return best;
}

function riderAtHatch(state: GameState): boolean {
  const r = state.rider;
  return r.mode === 'active' && r.surface === 'tenderTop' && Math.abs(r.x - hatchX(state.train)) <= SPOUT_REACH;
}

/**
 * The Rider presses E on the tender (spec §5.5): the spout comes down if the train is stopped with
 * the hatch under a spout, the tender has room, and the Rider stands by the hatch (`force` skips the
 * Rider, for the autopilot and tests). True if it came down.
 */
export function tryLowerSpout(state: GameState, run: RunDef, events: SimEvent[], opts: { force?: boolean } = {}): boolean {
  const t = state.train;
  if (state.phase !== 'running' || t.spout === 'down' || t.water >= t.waterCap || Math.abs(t.v) >= SPOUT_MAX_SPEED) return false;
  if (!opts.force && !riderAtHatch(state)) return false;
  const near = towerNearHatch(state, run, SPOUT_WINDOW);
  if (!near) return false;
  t.spout = 'down';
  t.spoutTower = near.tower.id;
  state.stats.waterStops++;
  events.push({ type: 'spout', down: true });
  return true;
}

/**
 * The Rider's HUD prompt on the tender top: 'lower' when E would bring the spout down, 'align' when
 * a spout is near the hatch but the train isn't standing with the hatch under it (a call to the
 * Engineer), else null.
 */
export function spoutPrompt(state: GameState, run: RunDef): 'lower' | 'align' | null {
  const t = state.train;
  const r = state.rider;
  if (state.phase !== 'running' || t.spout === 'down' || t.water >= t.waterCap) return null;
  if (r.mode !== 'active' || r.surface !== 'tenderTop') return null;
  const near = towerNearHatch(state, run, SPOUT_PROMPT_RANGE);
  if (!near) return null;
  if (Math.abs(t.v) >= SPOUT_MAX_SPEED || Math.abs(near.ahead) > SPOUT_WINDOW) return 'align';
  return riderAtHatch(state) ? 'lower' : null;
}

/** While the spout is down the tender fills; full, the spout swings back up. Moving the train raises it at once. */
function fillFromSpout(state: GameState, motion: TickMotion, events: SimEvent[]): void {
  const t = state.train;
  if (t.spout !== 'down') return;
  if (motion.moved === 0) {
    t.water = Math.min(t.waterCap, t.water + WATER_FILL_RATE * DT);
    if (t.water < t.waterCap) return;
    events.push({ type: 'waterFull' });
  }
  t.spout = 'up';
  t.spoutTower = null;
  events.push({ type: 'spout', down: false });
}

/** The node a heading runs into at the end of its edge. */
function endNodeAhead(ix: NetIndex, h: TrackHead): string {
  const e = edgeOf(ix, h.edge);
  return h.dir === 1 ? e.b : e.a;
}
