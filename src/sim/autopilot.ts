// The autopilot (spec §13, §19): a deterministic stand-in Engineer that drives a run by its plan
// (RunPlan), for the campaign feasibility tests, balance checks and the ?autopilot=1 dev mode. It
// plays by the Engineer's commands, knows what the desk shows (route, switches, limits, other
// trains), and acts on what a good Rider would call out (signal aspects, obstacles, trains ahead).
//
// How it reads a plan (types.ts leaves the interpretation here):
// - switches: in order. Each is set once the loco's front is within AP_SWITCH_REACH of its junction
//   by track (any route) and no train stands on it; an entry already matching is done. It never
//   runs past a junction whose planned setting it hasn't made yet.
// - stops: station and water tower ids, in order; the destination is added if the list doesn't end
//   with it. A station: the loco's front on the stop mark until the stop completes. A water tower:
//   the tender hatch under the spout, `lowerSpout` until the tender is full (skipped when it's
//   already full on coming within AP_TOWER_DECIDE of the tower).
// - holds: in order. Stop the loco's front at `at` and wait until the clock reaches `until`; a hold
//   whose time has passed is dropped.
// - whistles: a blast of AP_WHISTLE_SECONDS starting AP_WHISTLE_LEAD before each point, and another
//   as the loco's front passes it (so a point at the cattle or one where to blow both work).
// - minSpeeds: from the moment the train is over `from`, for AP_MIN_SPEED_SPAN metres, it holds at
//   least that speed (plus a margin), even a little over a limit, never near a derail.
// Beyond the plan it keeps under the track limits and signal restrictions, stops short of signals
// at stop, the buffers, other trains and rockslides, runs at burning trestles fast enough, slows for
// cattle and barricades and whistles cattle off the line, and fires the boiler unless a governor does.

import { edgeOf, framePath, frontHead, gradeAt, limitAt, netIndex, spanDir, spanLength, spansLength, switchOf, xOnSpans, type FramePath, type NetIndex } from './network';
import {
  AIR_BRAKES_FACTOR,
  APPROACH_LIMIT,
  BRAKE_MAX,
  DIVERGE_LIMIT,
  DRAG,
  FULL_POWER_PSI,
  GRAVITY,
  OBSTACLE_SAFE,
  REVERSER_MAX_SPEED,
  ROLL,
  SPOUT_MAX_SPEED,
  SPOUT_WINDOW,
  STATION_WINDOW,
  TICK_HZ,
  TRACTIVE_MAX,
  secondsToTicks,
} from './rules';
import { aspectOf } from './signals';
import { governed, governorFire, hatchX, switchFouled } from './train';
import type { Aspect, Dir, EngineerCmdBody, GameState, RunDef, RunPlan, SignalDef, SwitchState, TrackPoint } from './types';

// ---- Tunables (the autopilot's own; not game rules) --------------------------------------------

/** Plan switches are set once their junction is this close by track (m). */
export const AP_SWITCH_REACH = 800;
/** Looks at least this far ahead (m); further at speed. */
export const AP_LOOKAHEAD = 500;
/** And this far behind the train, to find a target it overshot. */
export const AP_LOOKBEHIND = 150;
/** Plans its braking at this fraction of full service braking… */
export const AP_BRAKE_PLAN = 0.6;
/** …and starts braking for something once it needs this fraction of that. */
export const AP_BRAKE_TRIGGER = 0.9;
/** Speed keeping: m/s² asked for per m/s off the target. */
export const AP_SPEED_GAIN = 1;
/** Aims this fraction under a track limit… */
export const AP_LIMIT_MARGIN = 0.97;
/** …and this fraction under a signal restriction. */
export const AP_SIGNAL_LIMIT_MARGIN = 0.95;
/** A required minimum speed may take it this far over a track limit (under the squeal). */
export const AP_LIMIT_STRETCH = 1.12;
/** Stops the loco's front this far short of a signal at stop… */
export const AP_SIGNAL_MARGIN = 12;
/** …a junction whose planned setting isn't made yet… */
export const AP_JUNCTION_MARGIN = 30;
/** …the buffers… */
export const AP_BUFFER_MARGIN = 8;
/** …another train… */
export const AP_TRAIN_MARGIN = 80;
/** …and a rockslide. */
export const AP_ROCKS_MARGIN = 20;
/** Passes cattle and barricades at this fraction of their safe speed. */
export const AP_OBSTACLE_MARGIN = 0.8;
/** Whistles at cattle between these distances ahead (m), inside the scare window. */
export const AP_CATTLE_WHISTLE: readonly [number, number] = [60, 300];
/** Within this distance of a burning trestle it holds the trestle's minimum speed plus a margin. */
export const AP_TRESTLE_RUNUP = 600;
export const AP_TRESTLE_MARGIN = 0.6;
/** A plan min speed is held this much over, for this far past its start (m). */
export const AP_MIN_SPEED_MARGIN = 0.3;
export const AP_MIN_SPEED_SPAN = 1500;
/** Arrived when stopped this close to the mark (m): a station, a spout, a hold point. */
export const AP_STATION_TOLERANCE = STATION_WINDOW - 3;
export const AP_TOWER_TOLERANCE = SPOUT_WINDOW - 0.5;
export const AP_HOLD_TOLERANCE = 3;
/** Backs up to an overshot target at up to this speed. */
export const AP_BACK_SPEED = 1.5;
/** Brake held while standing. */
export const AP_HOLD_BRAKE = 0.6;
/** Moves a lever only when it's this far off (or to an end stop), as a person would, not every tick. */
export const AP_LEVER_STEP = 0.02;
/** A whistle blast: this long, starting this far ahead of a whistle point. */
export const AP_WHISTLE_SECONDS = 1.2;
export const AP_WHISTLE_LEAD = 300;
/** Gives up on a water tower whose spout nobody lowers after this long. */
export const AP_SPOUT_WAIT_SECONDS = 45;
/**
 * A water tower stop is only skipped for a full tender once the tower is this close (m): about the
 * planned braking distance from full speed. Judged any earlier, a tender full at the start would
 * skip a tower it needs by the time it gets there.
 */
export const AP_TOWER_DECIDE = 600;

const EPS = 1e-6;

// ---- State --------------------------------------------------------------------------------------

/** The autopilot's memory between ticks: plain JSON, like GameState. */
export interface AutopilotState {
  variant: string;
  /** The next entry of the plan's switch list. */
  nextSwitch: number;
  /** Stops to make, in order: the plan's, then the destination if the plan doesn't end there. */
  stops: string[];
  nextStop: number;
  /** The next of the plan's holds. */
  nextHold: number;
  /** Per plan whistle point: 0 = blow on the approach, 1 = blow passing it, 2 = done. */
  whistles: number[];
  /** The tick the current blast ends. */
  whistleUntil: number;
  /** Per plan min speed: 0 = not reached, 1 = in force since odometer `at`, 2 = done. */
  minSpeeds: { state: 0 | 1 | 2; at: number }[];
  /** A signal restriction (m/s) carried from the last signal passed until the next one. */
  restriction: number | null;
  /** The first signal ahead facing the train, and the aspect it last showed. */
  signalAhead: { id: string; aspect: Aspect } | null;
  /** Ticks stood at the current water tower with the spout still up. */
  towerWait: number;
  /** What it's doing, in words (the dev overlay, test messages). */
  note: string;
  /** Has it caught up with a run already under way (its first tick)? */
  caughtUp: boolean;
}

const NO_PLAN: RunPlan = { cruise: 15, switches: [], stops: [], holds: [], whistles: [], minSpeeds: [] };

function planOf(run: RunDef, variant: string): RunPlan {
  return run.plan[variant] ?? run.plan[run.variants[0]] ?? NO_PLAN;
}

export function newAutopilot(run: RunDef, variant: string): AutopilotState {
  const plan = planOf(run, variant);
  const stops = [...plan.stops];
  if (stops[stops.length - 1] !== run.contract.destination) stops.push(run.contract.destination);
  return {
    variant,
    nextSwitch: 0,
    stops,
    nextStop: 0,
    nextHold: 0,
    whistles: plan.whistles.map(() => 0),
    whistleUntil: 0,
    minSpeeds: plan.minSpeeds.map(() => ({ state: 0 as const, at: 0 })),
    restriction: null,
    signalAhead: null,
    towerWait: 0,
    note: 'Ready',
    caughtUp: false,
  };
}

/**
 * A run already under way (a restored checkpoint, a dev-mode handover): the stops up to the last one
 * made are done, and leading switch entries for junctions the train has left behind, out of reach,
 * are spent. At the origin nothing is skipped: a junction off the train's route (one that diverts
 * the runaway, say) is set when it comes within reach.
 */
function catchUp(ap: AutopilotState, ix: NetIndex, run: RunDef, state: GameState, plan: RunPlan): void {
  const t = state.train;
  if (t.lastStation === null || t.lastStation === run.origin) return;
  const made = ap.stops.indexOf(t.lastStation);
  if (made >= 0) ap.nextStop = Math.max(ap.nextStop, made + 1);
  // The way the train came: behind its rear, following the switches as its passage left them.
  const network = run.edges.reduce((n, e) => n + e.length, 0);
  const behind = new Set(nodesOn(ix, stretchesOf(framePath(ix, state.switches, t.spans, network, 0))).map((n) => n.node));
  while (ap.nextSwitch < plan.switches.length) {
    const j = plan.switches[ap.nextSwitch].junction;
    if (!behind.has(j) || trackDistanceToNode(ix, run, state, j) <= AP_SWITCH_REACH) break;
    ap.nextSwitch++;
  }
}

// ---- The track around the train, in the train frame ---------------------------------------------

/** One span of the frame path with its train-frame extent and the train's direction on it. */
interface Stretch {
  edge: string;
  from: number;
  to: number;
  x0: number;
  x1: number;
  dir: Dir;
}

function stretchesOf(fp: FramePath): Stretch[] {
  const out: Stretch[] = [];
  let x = fp.x0;
  for (const s of fp.spans) {
    const len = spanLength(s);
    out.push({ edge: s.edge, from: s.from, to: s.to, x0: x, x1: x + len, dir: spanDir(s) });
    x += len;
  }
  return out;
}

/** Frame x of an offset on a stretch's edge, or null if the stretch doesn't cover it. */
function xOn(st: Stretch, off: number): number | null {
  if (off < Math.min(st.from, st.to) - EPS || off > Math.max(st.from, st.to) + EPS) return null;
  return st.x0 + Math.abs(off - st.from);
}

/** Frame x of a track point on the path, or null. */
function xOf(path: readonly Stretch[], p: TrackPoint): number | null {
  for (const st of path) {
    if (st.edge !== p.edge) continue;
    const x = xOn(st, p.off);
    if (x !== null) return x;
  }
  return null;
}

/** The nodes the path runs through, with their frame x. */
function nodesOn(ix: NetIndex, path: readonly Stretch[]): { node: string; x: number }[] {
  const out: { node: string; x: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const e = edgeOf(ix, path[i].edge);
    out.push({ node: path[i].dir === 1 ? e.b : e.a, x: path[i].x1 });
  }
  return out;
}

/** The nearest frame x at which a stretch of an edge [lo, hi] lies on the path, or null. */
function nearestX(path: readonly Stretch[], edge: string, a: number, b: number): number | null {
  let best: number | null = null;
  for (const st of path) {
    if (st.edge !== edge) continue;
    const lo = Math.max(Math.min(st.from, st.to), Math.min(a, b));
    const hi = Math.min(Math.max(st.from, st.to), Math.max(a, b));
    if (hi < lo - EPS) continue;
    const x = Math.min(st.x0 + Math.abs(lo - st.from), st.x0 + Math.abs(hi - st.from));
    if (best === null || x < best) best = x;
  }
  return best;
}

// ---- Distances to junctions (for setting switches in reach) --------------------------------------

const junctionDistances = new WeakMap<RunDef, Map<string, Map<string, number>>>();

/** Shortest track distance from every node to `target`, whatever the switches (cached per run). */
function distancesTo(ix: NetIndex, run: RunDef, target: string): Map<string, number> {
  let perRun = junctionDistances.get(run);
  if (!perRun) {
    perRun = new Map();
    junctionDistances.set(run, perRun);
  }
  const hit = perRun.get(target);
  if (hit) return hit;
  const dist = new Map<string, number>([[target, 0]]);
  const open = new Set<string>([target]);
  while (open.size > 0) {
    let cur = '';
    let best = Infinity;
    for (const n of open) {
      const d = dist.get(n) ?? Infinity;
      if (d < best) {
        best = d;
        cur = n;
      }
    }
    open.delete(cur);
    for (const { edge } of ix.incident.get(cur) ?? []) {
      const e = edgeOf(ix, edge);
      const other = e.a === cur ? e.b : e.a;
      if (best + e.length < (dist.get(other) ?? Infinity)) {
        dist.set(other, best + e.length);
        open.add(other);
      }
    }
  }
  perRun.set(target, dist);
  return dist;
}

function trackDistanceToNode(ix: NetIndex, run: RunDef, state: GameState, node: string): number {
  const front = frontHead(state.train.spans);
  const e = edgeOf(ix, front.edge);
  const d = distancesTo(ix, run, node);
  return Math.min(front.off + (d.get(e.a) ?? Infinity), e.length - front.off + (d.get(e.b) ?? Infinity));
}

// ---- The tick -------------------------------------------------------------------------------------

/** A speed cap from `d` metres ahead of the reference point on: at most `v` there (0 = stop there). */
interface Cap {
  d: number;
  v: number;
}

/** Where the autopilot means to stop next: a plan stop or hold, measured from its reference point. */
interface Target {
  kind: 'station' | 'tower' | 'hold';
  name: string;
  /** Metres from the reference point (the loco's front, or the hatch for a tower) to the mark; + = ahead. */
  r: number | null;
  tolerance: number;
}

const RESTRICTS: Record<Aspect, number | null> = {
  stop: APPROACH_LIMIT,
  approach: APPROACH_LIMIT,
  divergeApproach: APPROACH_LIMIT,
  divergeClear: DIVERGE_LIMIT,
  clear: null,
};

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const lever = (x: number): number => Math.round(clamp01(x) * 100) / 100;

function clockText(clock: number): string {
  const m = Math.floor(clock / 60);
  return `${Math.floor(m / 60) % 24}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * One tick of the autopilot: the commands to send this tick, and whether to lower the water spout
 * (the caller does it with tryLowerSpout(..., { force: true }), standing in for the Rider).
 */
export function autopilotStep(ap: AutopilotState, state: GameState, run: RunDef): { cmds: EngineerCmdBody[]; lowerSpout: boolean } {
  const cmds: EngineerCmdBody[] = [];
  if (state.phase !== 'running') return { cmds, lowerSpout: false };
  const ix = netIndex(run);
  const plan = planOf(run, ap.variant);
  const t = state.train;
  if (!ap.caughtUp) {
    ap.caughtUp = true;
    catchUp(ap, ix, run, state, plan);
  }
  const L = t.length;
  const clock = state.clock0 + state.tick / TICK_HZ;
  const bMax = BRAKE_MAX * (state.upgrades.includes('airBrakes') ? AIR_BRAKES_FACTOR : 1);
  const bPlan = AP_BRAKE_PLAN * bMax;
  const ahead = Math.max(AP_LOOKAHEAD, (t.v * t.v) / (2 * bPlan) + 200);
  const fp = framePath(ix, state.switches, t.spans, AP_LOOKBEHIND, ahead);
  const path = stretchesOf(fp);
  const onward = path.filter((st) => st.x1 > L + EPS);

  // Switches, in plan order, as their junctions come within reach.
  let pending: { junction: string; state: SwitchState } | null = null;
  while (ap.nextSwitch < plan.switches.length) {
    const want = plan.switches[ap.nextSwitch];
    if (!ix.junction.has(want.junction)) {
      ap.nextSwitch++;
      continue;
    }
    pending = want;
    if (trackDistanceToNode(ix, run, state, want.junction) > AP_SWITCH_REACH) break;
    if (switchOf(ix, state.switches, want.junction) === want.state) {
      ap.nextSwitch++;
      pending = null;
      continue;
    }
    if (!t.heldUp && !switchFouled(ix, state, want.junction)) cmds.push({ kind: 'switch', junction: want.junction, state: want.state });
    break;
  }

  // Signals ahead facing the train; passing one carries its restriction to the next (spec §9.3).
  const signals: { sig: SignalDef; x: number }[] = [];
  for (const st of onward) {
    for (const sig of ix.features.get(st.edge)?.signals ?? []) {
      const x = sig.facing === st.dir ? xOn(st, sig.at) : null;
      if (x !== null && x > L + EPS) signals.push({ sig, x });
    }
  }
  signals.sort((a, b) => a.x - b.x);
  const aspects = signals.map((s) => aspectOf(state, run, s.sig.id));
  if (ap.signalAhead && ap.signalAhead.id !== signals[0]?.sig.id) {
    const was = ap.signalAhead;
    const def = run.signals.find((s) => s.id === was.id);
    if (def && xOnSpans(t.spans, { edge: def.edge, off: def.at }) !== null) ap.restriction = RESTRICTS[was.aspect];
  }
  ap.signalAhead = signals.length > 0 ? { id: signals[0].sig.id, aspect: aspects[0] } : null;

  // Minimum speeds: the plan's, and a burning trestle's run-up.
  let minReq = 0;
  plan.minSpeeds.forEach((m, i) => {
    const ms = ap.minSpeeds[i];
    if (!ms) return;
    if (ms.state === 0 && xOnSpans(t.spans, m.from) !== null) {
      ms.state = 1;
      ms.at = t.odometer;
    }
    if (ms.state === 1 && t.odometer - ms.at > AP_MIN_SPEED_SPAN) ms.state = 2;
    if (ms.state === 1) minReq = Math.max(minReq, m.speed + AP_MIN_SPEED_MARGIN);
  });
  for (const st of onward) {
    for (const tr of ix.features.get(st.edge)?.trestles ?? []) {
      if (!tr.burning) continue;
      const x = xOn(st, st.dir === 1 ? Math.min(tr.from, tr.to) : Math.max(tr.from, tr.to));
      if (x !== null && x > L && x - L <= AP_TRESTLE_RUNUP) minReq = Math.max(minReq, tr.burning.minSpeed + AP_TRESTLE_MARGIN);
    }
  }
  const eff = (limit: number): number => Math.max(limit * AP_LIMIT_MARGIN, Math.min(minReq, limit * AP_LIMIT_STRETCH));

  // The next stop and hold.
  while (ap.nextStop < ap.stops.length) {
    const id = ap.stops[ap.nextStop];
    const station = run.stations.find((s) => s.id === id);
    const tower = station ? undefined : run.waterTowers.find((w) => w.id === id);
    const madeStop = station && t.stationStop?.stationId === id && t.stationStop.done;
    const towerX = tower ? xOf(path, { edge: tower.edge, off: tower.at }) : null;
    // Off the look-ahead path (null) means farther on than the autopilot is looking yet.
    const towerNear = towerX !== null && towerX - hatchX(t) <= AP_TOWER_DECIDE;
    const tankFull = tower && towerNear && t.spout === 'up' && t.water >= t.waterCap - 1;
    const gaveUp = tower && ap.towerWait > secondsToTicks(AP_SPOUT_WAIT_SECONDS);
    if (station && !madeStop) break;
    if (tower && !tankFull && !gaveUp) break;
    ap.nextStop++;
    ap.towerWait = 0;
  }
  while (ap.nextHold < plan.holds.length && clock >= plan.holds[ap.nextHold].until) ap.nextHold++;

  const targets: Target[] = [];
  const stopId = ap.stops[ap.nextStop];
  const station = run.stations.find((s) => s.id === stopId);
  const tower = run.waterTowers.find((w) => w.id === stopId);
  if (station) {
    const x = xOf(path, { edge: station.edge, off: station.at });
    targets.push({ kind: 'station', name: station.name, r: x === null ? null : x - L, tolerance: AP_STATION_TOLERANCE });
  } else if (tower) {
    const x = xOf(path, { edge: tower.edge, off: tower.at });
    targets.push({ kind: 'tower', name: tower.name ?? 'the water tower', r: x === null ? null : x - hatchX(t), tolerance: AP_TOWER_TOLERANCE });
  }
  const hold = plan.holds[ap.nextHold];
  if (hold) {
    const x = xOf(path, hold.at);
    targets.push({ kind: 'hold', name: `hold until ${clockText(hold.until)}`, r: x === null ? null : x - L, tolerance: AP_HOLD_TOLERANCE });
  }

  // Everything that caps the speed ahead.
  const caps: Cap[] = [];
  for (const st of onward) {
    const e = edgeOf(ix, st.edge);
    if (st.x0 > L) caps.push({ d: st.x0 - L, v: eff(e.speedLimit) });
    for (const c of ix.features.get(st.edge)?.curves ?? []) {
      const x = nearestX([st], st.edge, c.from, c.to);
      if (x !== null && x > L) caps.push({ d: x - L, v: eff(c.limit) });
    }
  }
  signals.forEach(({ x }, i) => {
    const aspect = aspects[i];
    if (aspect === 'stop') caps.push({ d: x - L - AP_SIGNAL_MARGIN, v: 0 });
    else if (RESTRICTS[aspect] !== null) caps.push({ d: x - L, v: (RESTRICTS[aspect] ?? 0) * AP_SIGNAL_LIMIT_MARGIN });
  });
  const pathEnd = fp.x0 + spansLength(fp.spans);
  if (pathEnd < L + ahead - 1) caps.push({ d: pathEnd - L - AP_BUFFER_MARGIN, v: 0 });
  if (pending && switchOf(ix, state.switches, pending.junction) !== pending.state) {
    for (const n of nodesOn(ix, path)) if (n.node === pending.junction && n.x > L) caps.push({ d: n.x - L - AP_JUNCTION_MARGIN, v: 0 });
  }
  for (const a of state.ai) {
    if (!a.active) continue;
    for (const s of a.spans) {
      const x = nearestX(onward, s.edge, s.from, s.to);
      if (x !== null && x > L - EPS) caps.push({ d: x - L - AP_TRAIN_MARGIN, v: 0 });
    }
  }
  for (const o of state.obstacles) {
    const onLine = o.state === 'present' || (o.kind === 'cattle' && o.state === 'scattering');
    const x = onLine ? xOf(onward, { edge: o.edge, off: o.at }) : null;
    if (x === null || x <= L) continue;
    caps.push(o.kind === 'rocks' ? { d: x - L - AP_ROCKS_MARGIN, v: 0 } : { d: x - L, v: OBSTACLE_SAFE[o.kind] * AP_OBSTACLE_MARGIN });
  }

  // Which way to go: on toward the targets, or back to one overshot.
  let dirT: 1 | -1 = 1;
  let arrived: Target | null = null;
  for (const tg of targets) {
    if (tg.r === null) continue;
    if (Math.abs(tg.r) <= tg.tolerance && Math.abs(t.v) < 0.05) arrived ??= tg;
    else if (tg.r < -tg.tolerance) dirT = -1;
    else caps.push({ d: Math.max(0, tg.r), v: 0 });
  }

  let throttle = 0;
  let brake = AP_HOLD_BRAKE;
  let reverser = t.reverser;
  let lowerSpout = false;
  if (arrived) {
    // Waiting out a dwell, a fill or a hold.
    ap.note = arrived.kind === 'station' ? `Standing at ${arrived.name}` : arrived.kind === 'tower' ? `Filling at ${arrived.name}` : `Waiting: ${arrived.name}`;
    if (arrived.kind === 'tower' && t.spout === 'up' && t.water < t.waterCap) {
      lowerSpout = Math.abs(t.v) < SPOUT_MAX_SPEED;
      ap.towerWait++;
    }
  } else if (dirT === -1) {
    // Overshot: back up to the mark, gently.
    const tg = targets.find((g) => g.r !== null && g.r < -g.tolerance);
    const back = tg && tg.r !== null ? -tg.r : 0;
    ap.note = `Backing to ${tg?.name ?? 'the mark'}`;
    if (t.v > 0.05 || (t.reverser !== -1 && Math.abs(t.v) >= REVERSER_MAX_SPEED)) {
      throttle = 0;
      brake = 1;
    } else {
      reverser = -1;
      const u = Math.max(0, -t.v);
      const vCap = Math.min(AP_BACK_SPEED, Math.sqrt(2 * bPlan * back));
      const aNeed = (u * u) / (2 * Math.max(back, 0.05));
      const aDes = aNeed >= AP_BRAKE_TRIGGER * bPlan ? -aNeed : Math.max(-bPlan, AP_SPEED_GAIN * (vCap - u));
      ({ throttle, brake } = leversFor(ix, state, -1, aDes, bMax));
    }
  } else if (t.v < -0.05 || (t.reverser !== 1 && Math.abs(t.v) >= REVERSER_MAX_SPEED)) {
    // Rolling the wrong way: stop first.
    throttle = 0;
    brake = 1;
  } else {
    reverser = 1;
    const u = Math.max(0, t.v);
    const signalLimit = Math.min(ap.restriction ?? Infinity, state.signals.restriction?.limit ?? Infinity) * AP_SIGNAL_LIMIT_MARGIN;
    let vCap = Math.min(Math.max(plan.cruise, minReq), eff(limitAt(ix, frontHead(t.spans))), signalLimit);
    let aNeed = 0;
    for (const c of caps) {
      const d = Math.max(0, c.d);
      vCap = Math.min(vCap, Math.sqrt(c.v * c.v + 2 * bPlan * d));
      if (u > c.v) aNeed = Math.max(aNeed, (u * u - c.v * c.v) / (2 * Math.max(d, 0.05)));
    }
    if (vCap < 0.3 && u < 0.05) {
      // Nothing to move for (a red signal, a train ahead, the end of the line): stand.
      ap.note = 'Standing';
    } else {
      const aDes = aNeed >= AP_BRAKE_TRIGGER * bPlan ? -aNeed : Math.max(-bPlan, AP_SPEED_GAIN * (vCap - u));
      ({ throttle, brake } = leversFor(ix, state, 1, aDes, bMax));
      const next = targets.find((g) => g.r !== null && g.r >= 0);
      ap.note = next && next.r !== null && next.r < 400 ? `Stopping at ${next.name}` : 'Driving';
    }
  }

  // The whistle: plan points, and cattle the Rider would point out.
  let blow = false;
  plan.whistles.forEach((p, i) => {
    const w = ap.whistles[i];
    const x = w === undefined || w >= 2 ? null : xOf(path, p);
    if (x === null) return;
    if (w === 0 && x - L <= AP_WHISTLE_LEAD) {
      blow = true;
      ap.whistles[i] = x - L > 0 ? 1 : 2;
    } else if (w === 1 && x - L <= 0) {
      blow = true;
      ap.whistles[i] = 2;
    }
  });
  for (const o of state.obstacles) {
    if (o.kind !== 'cattle' || o.state !== 'present') continue;
    const x = xOf(onward, { edge: o.edge, off: o.at });
    if (x !== null && x - L >= AP_CATTLE_WHISTLE[0] && x - L <= AP_CATTLE_WHISTLE[1]) blow = true;
  }
  if (blow) ap.whistleUntil = Math.max(ap.whistleUntil, state.tick + secondsToTicks(AP_WHISTLE_SECONDS));
  const whistle = state.tick < ap.whistleUntil;
  if (whistle !== t.whistle) cmds.push({ kind: 'whistle', on: whistle });

  if (t.heldUp) {
    // Only the whistle works with a gun on you (spec §5.2).
    ap.note = 'Held up';
    return { cmds, lowerSpout: false };
  }
  if (reverser !== t.reverser) cmds.push({ kind: 'reverser', value: reverser });
  const newThrottle = leverMove(throttle, t.throttle);
  const newBrake = leverMove(brake, t.brake);
  if (newThrottle !== null) cmds.push({ kind: 'throttle', value: newThrottle });
  if (newBrake !== null) cmds.push({ kind: 'brake', value: newBrake });
  if (!governed(state)) {
    const fire = governorFire({ ...t, throttle: newThrottle ?? t.throttle, reverser });
    if (fire !== t.fire) cmds.push({ kind: 'fire', value: fire });
  }
  return { cmds, lowerSpout };
}

/** A lever position worth sending: past the deadband, or all the way to an end stop; else null. */
function leverMove(want: number, now: number): number | null {
  const v = lever(want);
  if (v === now) return null;
  return v === 0 || v === 1 || Math.abs(v - now) >= AP_LEVER_STEP ? v : null;
}

/**
 * Throttle and brake that give about `aDes` (m/s² along `dirT`) at this speed, grade and pressure,
 * from the train's own dynamics (spec §5.3). Assumes the reverser is set for `dirT`.
 */
function leversFor(ix: NetIndex, state: GameState, dirT: 1 | -1, aDes: number, bMax: number): { throttle: number; brake: number } {
  const t = state.train;
  const front = frontHead(t.spans);
  const u = Math.max(0, t.v * dirT);
  const natural = -GRAVITY * gradeAt(ix, front) * front.dir * dirT - ROLL - DRAG * u * u;
  if (aDes > natural) {
    const power = Math.max(0.05, Math.min(1, t.pressure / FULL_POWER_PSI));
    return { throttle: clamp01(((aDes - natural) * t.mass) / (TRACTIVE_MAX * power)), brake: 0 };
  }
  return { throttle: 0, brake: clamp01((natural - aDes) / bMax) };
}
