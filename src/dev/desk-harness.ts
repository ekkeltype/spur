// Dev-only bench for the Engineer's desk (src/render/desk), served by Vite at /desk.html (never part
// of the game build). It mounts the desk for a bench run (a main line with a passing loop and a
// quarry spur, signals, two tunnels, a low bridge, a trestle, three stations, a water tower and one
// charted opposing freight), converted with views.toEngineerRun, and drives it from a small fake
// host: simple train kinematics and boiler on the real network code (moveSpans, spansFromFront),
// the freight from the real timetable functions, and buttons to fake the events a real game sends.
//
// URL: /desk.html?scene=depart|cruise|station|water|meet|siding|heldup|events|backing|late|enroute
//        &run=1..6&assist=1&letters=1&keyboard=local&lag=60&paused=1&freeze=1&ui=0&rulebook=1&follow=1&debug=1
// (run=N loads campaign run N from src/content/runs.ts instead of the bench run; its scenes are
// the generic depart and enroute.)
// (paused=1 shows the game paused: the desk disabled; freeze=1 only stops the fake host, for screenshots.)
// window.harness drives it from automation (see the Harness interface at the bottom).

import { RUNS } from '../content/runs';
import type { DebugInfo } from '../net/protocol';
import { EngineerDesk } from '../render/desk/desk';
import {
  fouls,
  framePath,
  frontHead,
  limitAt,
  mainPos,
  moveSpans,
  netIndex,
  pointAt,
  spansFromFront,
  spansLength,
  spansOverlap,
  walk,
  xOnSpans,
} from '../sim/network';
import {
  BRAKE_MAX,
  BUFFER_SAFE,
  CAR_SPECS,
  COUPLER_GAP,
  DERAIL_FACTOR,
  DRAG,
  DWELL_SECONDS,
  FIRE_MAX,
  FULL_POWER_PSI,
  HEAT_LOSS,
  LOW_WATER,
  OVERSPEED_WARN,
  P_MAX,
  REVERSER_MAX_SPEED,
  ROLL,
  SIGHT_RANGE,
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
  TRACTIVE_MAX,
  WATER_FILL_RATE,
  WATER_PER_PSI,
} from '../sim/rules';
import { routeDistanceAt, routeSpans } from '../sim/schedule';
import type {
  AiTrainDef,
  Aspect,
  CarType,
  EngineerCmdBody,
  EngineerEvent,
  EngineerView,
  FlagState,
  Phase,
  RiderMode,
  RunDef,
  Span,
  SwitchState,
} from '../sim/types';
import { toEngineerRun } from '../sim/views';

// ---------------------------------------------------------------------------------------------
// The bench run
// ---------------------------------------------------------------------------------------------

const H9 = 9 * 3600;
const MPH = (mph: number): number => mph / 2.23694;

const FREIGHT: AiTrainDef = {
  id: 'no7',
  name: 'No. 7 Freight',
  kind: 'freight',
  cars: 10,
  length: 180,
  // In at the east end, west along the main line (through the loop on the main), out at Juniper yard.
  route: [
    { edge: 'm5', dir: -1 },
    { edge: 'm4', dir: -1 },
    { edge: 'm3', dir: -1 },
    { edge: 'm2', dir: -1 },
    { edge: 'm1', dir: -1 },
  ],
  depart: H9 + 20,
  speed: 11,
  // A 40 s stop at Mesa (m3 450): 1600 + 2400 + 450 m along its route.
  stops: [{ at: 4450, dwell: 40 }],
  charted: true,
};

const BENCH: RunDef = {
  id: 'bench',
  index: 0,
  act: 2,
  name: 'Single Track',
  flavor: 'The desk bench: a loop, a spur and a freight coming the other way.',
  briefing: { rider: [], engineer: [] },
  startClock: H9,
  night: false,
  nodes: [
    { id: 'W', kind: 'end', x: 0, y: 0, label: 'Juniper yard' },
    { id: 'J1', kind: 'junction', x: 22, y: 0 },
    { id: 'S', kind: 'end', x: 30, y: -4.2, label: 'Quarry' },
    { id: 'P', kind: 'junction', x: 40, y: 0 },
    { id: 'Q', kind: 'junction', x: 52, y: 0 },
    { id: 'R', kind: 'link', x: 72, y: 2.4 },
    { id: 'E', kind: 'end', x: 90, y: 2.4, label: 'End of track' },
  ],
  edges: [
    { id: 'm1', a: 'W', b: 'J1', length: 2600, kind: 'main', speedLimit: MPH(50), terrain: 'desert', mainAt: [0, 2600] },
    { id: 'sp', a: 'J1', b: 'S', length: 700, kind: 'spur', speedLimit: MPH(15), terrain: 'canyon', mainAt: [2600, 3200], via: [[25, -1.4], [27.5, -3.6]], name: 'Quarry spur' },
    { id: 'm2', a: 'J1', b: 'P', length: 1500, kind: 'main', speedLimit: MPH(50), terrain: 'desert', mainAt: [2600, 4100] },
    { id: 'm3', a: 'P', b: 'Q', length: 900, kind: 'main', speedLimit: MPH(40), terrain: 'mesa', mainAt: [4100, 5000] },
    { id: 's1', a: 'P', b: 'Q', length: 900, kind: 'siding', speedLimit: MPH(15), terrain: 'mesa', mainAt: [4100, 5000], via: [[42.5, 2.6], [49.5, 2.6]], name: 'Mesa Loop' },
    { id: 'm4', a: 'Q', b: 'R', length: 2400, kind: 'main', speedLimit: MPH(50), terrain: 'canyon', mainAt: [5000, 7400], via: [[62, 0], [66, 2.4]] },
    { id: 'm5', a: 'R', b: 'E', length: 1600, kind: 'main', speedLimit: MPH(40), terrain: 'town', mainAt: [7400, 9000] },
  ],
  junctions: [
    { node: 'J1', trunk: 'm1', normal: 'm2', reverse: 'sp', initial: 'normal', name: 'Quarry switch' },
    { node: 'P', trunk: 'm2', normal: 'm3', reverse: 's1', initial: 'normal', name: 'Mesa Loop west' },
    { node: 'Q', trunk: 'm4', normal: 'm3', reverse: 's1', initial: 'normal', name: 'Mesa Loop east' },
  ],
  mainLine: ['m1', 'm2', 'm3', 'm4', 'm5'],
  tunnels: [
    { id: 't1', edge: 'm1', from: 1100, to: 1450, name: 'Juniper Tunnel' },
    { id: 't2', edge: 'm4', from: 2000, to: 2250, name: 'Hogback Tunnel' },
  ],
  lowBridges: [{ id: 'b1', edge: 'm1', at: 2000, name: 'Ranch road bridge' }],
  trestles: [{ id: 'r1', edge: 'm4', from: 800, to: 1000, name: 'Sage Creek Trestle' }],
  stations: [
    { id: 'juniper', name: 'Juniper', edge: 'm1', at: 350, platform: 80, checkpoint: false },
    { id: 'mesa', name: 'Mesa', edge: 'm3', at: 450, platform: 70, checkpoint: true },
    { id: 'coyote', name: 'Coyote Bend', edge: 'm5', at: 1300, platform: 80, checkpoint: false },
  ],
  waterTowers: [{ id: 'w1', edge: 'm2', at: 1200, name: 'Dry Creek tank' }],
  curves: [
    { id: 'c1', edge: 'm2', from: 300, to: 700, limit: MPH(30) },
    { id: 'c2', edge: 'm4', from: 1500, to: 1900, limit: MPH(25) },
  ],
  grades: [],
  mileposts: [
    { edge: 'm1', at: 1609, mile: 1 },
    { edge: 'm2', at: 619, mile: 2 },
    { edge: 'm3', at: 728, mile: 3 },
    { edge: 'm4', at: 1437, mile: 4 },
    { edge: 'm5', at: 647, mile: 5 },
  ],
  signals: [
    { id: 'g1', edge: 'm1', at: 2450, facing: 1, kind: 'junction', junction: 'J1' },
    { id: 'g2', edge: 'm2', at: 1380, facing: 1, kind: 'junction', junction: 'P', name: 'Mesa west home' },
    { id: 'g3', edge: 'm4', at: 160, facing: -1, kind: 'junction', junction: 'Q', name: 'Mesa east home' },
    { id: 'g4', edge: 'm4', at: 1200, facing: 1, kind: 'block' },
    { id: 'g5', edge: 'm2', at: 120, facing: -1, kind: 'block' },
  ],
  obstacles: [{ id: 'o1', kind: 'cattle', edge: 'm4', at: 2700 }],
  waves: [],
  aiTrains: [FREIGHT],
  telegrams: [{ id: 'tg1', clock: H9 + 45, text: 'No 7 freight westbound on time stop take the siding at Mesa stop' }],
  contract: { cargo: 'mail', title: 'Mail for Coyote Bend', pay: 150, destination: 'coyote', deadline: H9 + 16 * 60, latePenaltyPerMin: 5, critical: false },
  sideJobs: [{ id: 'sj1', title: '4 passengers', pay: 60, from: 'mesa', to: 'coyote', needs: 'passenger' }],
  start: { edge: 'm1', off: 350, dir: 1 },
  origin: 'juniper',
  initialWater: 100,
  variants: ['main'],
  requiredCars: ['express'],
  maxCars: 5,
  par: 780,
  plan: { main: { cruise: 18, switches: [], stops: ['coyote'], holds: [], whistles: [], minSpeeds: [] } },
};

/** ?run=1..6 loads that campaign run; anything else is the bench run. */
const RUN_NO = Number(new URLSearchParams(location.search).get('run') ?? 0);
const RUN: RunDef = RUNS[RUN_NO - 1] ?? BENCH;
const IS_BENCH = RUN === BENCH;
const ENGINEER_RUN = toEngineerRun(RUN);
const ix = netIndex(RUN);
/** The timetabled trains the fake host runs (the runaway stays out of the bench). */
const CHARTED = RUN.aiTrains.filter((t) => t.charted && t.kind !== 'runaway' && t.route.length > 0);

const CONSIST: CarType[] = IS_BENCH
  ? ['express', 'boxcar', 'passenger']
  : [...RUN.requiredCars, ...(['express', 'passenger', 'boxcar'] as CarType[]).filter((c) => !RUN.requiredCars.includes(c))].slice(0, Math.max(3, RUN.requiredCars.length));
const KINDS = ['loco', 'tender', ...CONSIST] as const;
/** The whole train with its coupler gaps, and its mass (spec §5.1). */
const TRAIN_LENGTH = KINDS.reduce((n, k) => n + CAR_SPECS[k].length, 0) + COUPLER_GAP * (KINDS.length - 1);
const TRAIN_MASS = KINDS.reduce((n, k) => n + CAR_SPECS[k].mass, 0);
/** The tender hatch, from the loco's front (spec §5.5). */
const HATCH_BACK = CAR_SPECS.loco.length + COUPLER_GAP + CAR_SPECS.tender.length - TENDER_HATCH_FROM_REAR;

// ---------------------------------------------------------------------------------------------
// The fake host
// ---------------------------------------------------------------------------------------------

interface Fake {
  tick: number;
  phase: Phase;
  loss: EngineerView['loss'];
  spans: Span[];
  v: number;
  throttle: number;
  brake: number;
  reverser: -1 | 0 | 1;
  fire: number;
  pressure: number;
  water: number;
  whistle: boolean;
  heldUp: boolean;
  overspeed: 0 | 1 | 2;
  overTicks: number;
  safetyValve: boolean;
  spout: 'up' | 'down';
  spoutTicks: number;
  stationStop: { stationId: string; ticks: number; done: boolean } | null;
  switches: Record<string, SwitchState>;
  flags: FlagState[];
  rider: { car: number; roof: boolean; mode: RiderMode };
  fines: number;
  cargo: 'ok' | 'stolen';
  inTunnel: string | null;
  telegramsSent: string[];
  aiActive: boolean;
  nextFlag: number;
  sideJobs: { id: string; state: 'pending' | 'aboard' | 'done' }[];
}

function initialSwitches(): Record<string, SwitchState> {
  const s: Record<string, SwitchState> = {};
  for (const j of RUN.junctions) s[j.node] = j.initial;
  return s;
}

function freshState(): Fake {
  const switches = initialSwitches();
  return {
    tick: 0,
    phase: 'running',
    loss: null,
    spans: spansFromFront(ix, switches, RUN.start, TRAIN_LENGTH),
    v: 0,
    throttle: 0,
    brake: 0,
    reverser: 1,
    fire: 2,
    pressure: 180,
    water: RUN.initialWater,
    whistle: false,
    heldUp: false,
    overspeed: 0,
    overTicks: 0,
    safetyValve: false,
    spout: 'up',
    spoutTicks: 0,
    stationStop: null,
    switches,
    flags: [],
    rider: { car: 3, roof: true, mode: 'active' },
    fines: 0,
    cargo: 'ok',
    inTunnel: null,
    telegramsSent: [],
    aiActive: false,
    nextFlag: 1,
    sideJobs: RUN.sideJobs.map((j) => ({ id: j.id, state: 'pending' as const })),
  };
}

class FakeHost {
  s: Fake = freshState();
  events: EngineerEvent[] = [];
  assist = false;

  clock(): number {
    return RUN.startClock + this.s.tick / TICK_HZ;
  }

  reset(): void {
    this.s = freshState();
    this.events = [];
  }

  private emit(e: EngineerEvent): void {
    this.events.push(e);
  }

  /** Applies an Engineer command; returns the refusal reason, or null. */
  apply(cmd: EngineerCmdBody): string | null {
    const s = this.s;
    if (s.phase !== 'running') return 'The run is over';
    if (s.heldUp && cmd.kind !== 'whistle') return "Hands up! There's a gun on you";
    switch (cmd.kind) {
      case 'throttle':
        s.throttle = Math.max(0, Math.min(1, cmd.value));
        return null;
      case 'brake':
        s.brake = Math.max(0, Math.min(1, cmd.value));
        return null;
      case 'reverser':
        if (Math.abs(s.v) >= REVERSER_MAX_SPEED) return 'The reverser only moves when the train is stopped';
        s.reverser = cmd.value;
        return null;
      case 'fire':
        s.fire = Math.max(0, Math.min(FIRE_MAX, Math.round(cmd.value)));
        return null;
      case 'whistle':
        if (cmd.on !== s.whistle) this.emit({ type: 'whistle', on: cmd.on });
        s.whistle = cmd.on;
        return null;
      case 'switch': {
        const onPoints = (spans: Span[]): boolean => spans.length > 0 && fouls(ix, spans, cmd.junction, SWITCH_FOUL_DISTANCE);
        if (onPoints(s.spans) || this.aiSpans().some((a) => onPoints(a.spans))) return 'A train is standing on the points';
        if (s.switches[cmd.junction] !== cmd.state) {
          s.switches[cmd.junction] = cmd.state;
          this.emit({ type: 'switchThrown', junction: cmd.junction, state: cmd.state, by: 'engineer' });
        }
        return null;
      }
    }
  }

  /** Where each timetabled train is now (empty spans off the map). */
  aiSpans(): { def: AiTrainDef; spans: Span[] }[] {
    return CHARTED.map((def) => ({ def, spans: routeSpans(ix, def, routeDistanceAt(def, this.clock())) }));
  }

  step(dt: number): void {
    const s = this.s;
    if (s.phase !== 'running') return;
    s.tick++;
    // Hold-up: the bandit eases the throttle shut and sets the brake (spec §5.2).
    if (s.heldUp) {
      s.throttle = Math.max(0, s.throttle - 0.6 * dt);
      s.brake += Math.sign(0.5 - s.brake) * Math.min(Math.abs(0.5 - s.brake), 0.6 * dt);
    }
    if (this.assist) s.fire = s.pressure < 168 ? 3 : s.pressure < 176 ? 2 : s.pressure < 188 ? 1 : 0;
    // Boiler (spec §5.5).
    const produce = s.water > 0 ? STEAM_PER_FIRE * s.fire : 0;
    const use = s.reverser !== 0 ? s.throttle * (STEAM_BASE + STEAM_PER_MS * Math.abs(s.v)) : 0;
    const net = produce - use - HEAT_LOSS;
    const p = s.pressure + net * dt;
    const valve = p >= P_MAX && net > 0;
    if (valve !== s.safetyValve) this.emit({ type: 'safetyValve', on: valve });
    s.safetyValve = valve;
    s.pressure = Math.max(0, Math.min(P_MAX, p));
    const wasLow = s.water < LOW_WATER;
    s.water = Math.max(0, s.water - WATER_PER_PSI * produce * dt);
    if (!wasLow && s.water < LOW_WATER) this.emit({ type: 'lowWater' });
    // Motion (spec §5.3), flat track.
    const force = TRACTIVE_MAX * s.throttle * Math.min(1, s.pressure / FULL_POWER_PSI) * s.reverser;
    const drive = force / TRAIN_MASS;
    const brakeA = s.brake * BRAKE_MAX;
    if (Math.abs(s.v) < STOP_EPSILON && Math.abs(drive) <= ROLL + brakeA) s.v = 0;
    else {
      const dir = s.v !== 0 ? Math.sign(s.v) : Math.sign(drive);
      const a = drive - dir * (ROLL + DRAG * s.v * s.v + brakeA);
      const nv = s.v + a * dt;
      s.v = s.v !== 0 && Math.sign(nv) !== Math.sign(s.v) ? 0 : nv;
    }
    const before = frontHead(s.spans);
    if (s.v !== 0) {
      const mv = moveSpans(ix, s.switches, s.spans, s.v * dt);
      if (mv.moved > 0) {
        const path = walk(ix, s.switches, before, mv.moved).spans;
        for (const tg of RUN.telegrams) {
          if (tg.at && !s.telegramsSent.includes(tg.id) && xOnSpans(path, tg.at) !== null) {
            s.telegramsSent.push(tg.id);
            this.emit({ type: 'telegram', id: tg.id, text: tg.text });
          }
        }
      }
      s.spans = mv.spans;
      for (const t of mv.trails) {
        s.switches[t.junction] = t.state;
        this.emit({ type: 'switchThrown', junction: t.junction, state: t.state, by: 'trailing' });
      }
      if (mv.blocked) {
        if (Math.abs(s.v) > BUFFER_SAFE) this.lose('buffers', 'Hit the buffers');
        s.v = 0;
      }
      s.stationStop = s.stationStop && Math.abs(s.v) > STATION_STOP_SPEED ? null : s.stationStop;
    }
    // Limits (spec §5.4).
    const front = frontHead(s.spans);
    const limit = limitAt(ix, front);
    const speed = Math.abs(s.v);
    const level: 0 | 1 | 2 = speed > limit * DERAIL_FACTOR ? 2 : speed > limit * OVERSPEED_WARN ? 1 : 0;
    if (level > s.overspeed) this.emit({ type: 'overspeed', level: level as 1 | 2 });
    s.overspeed = level;
    s.overTicks = level === 2 ? s.overTicks + 1 : 0;
    // Stations (spec §5.6).
    if (Math.abs(s.v) < STATION_STOP_SPEED) {
      for (const st of RUN.stations) {
        const d = distTo(s.spans, { edge: st.edge, off: st.at });
        if (d === null || Math.abs(d) > STATION_WINDOW) continue;
        if (!s.stationStop || s.stationStop.stationId !== st.id) {
          s.stationStop = { stationId: st.id, ticks: 0, done: false };
          this.emit({ type: 'stationArrived', stationId: st.id });
        }
        const ss = s.stationStop;
        ss.ticks++;
        if (!ss.done && ss.ticks >= DWELL_SECONDS * TICK_HZ) {
          ss.done = true;
          this.emit({ type: 'stationDone', stationId: st.id });
          for (const job of s.sideJobs) {
            const def = RUN.sideJobs.find((j) => j.id === job.id);
            if (def?.from === st.id && job.state === 'pending') {
              job.state = 'aboard';
              this.emit({ type: 'sideJob', id: job.id, state: 'aboard' });
            } else if (def?.to === st.id && job.state === 'aboard') {
              job.state = 'done';
              this.emit({ type: 'sideJob', id: job.id, state: 'done' });
            }
          }
          if (st.id === RUN.contract.destination) {
            s.phase = 'won';
            this.emit({ type: 'won' });
          }
        }
      }
    } else if (s.stationStop) s.stationStop = null;
    // Water: the fake Rider lowers the spout a second after the hatch stops under it.
    const hatch = hatchPoint(s.spans);
    const tower = RUN.waterTowers.find((w) => {
      const x = xOnSpans(s.spans, { edge: w.edge, off: w.at });
      const hx = xOnSpans(s.spans, hatch);
      return x !== null && hx !== null && Math.abs(x - hx) <= SPOUT_WINDOW;
    });
    if (s.spout === 'down') {
      if (!tower || Math.abs(s.v) > 0.1) {
        s.spout = 'up';
        this.emit({ type: 'spout', down: false });
      } else {
        s.water = Math.min(100, s.water + WATER_FILL_RATE * dt);
        if (s.water >= 100) {
          s.spout = 'up';
          this.emit({ type: 'waterFull' });
        }
      }
    } else if (tower && Math.abs(s.v) < 0.1 && s.water < 99) {
      s.spoutTicks++;
      if (s.spoutTicks > TICK_HZ) {
        s.spout = 'down';
        s.spoutTicks = 0;
        this.emit({ type: 'spout', down: true });
      }
    } else s.spoutTicks = 0;
    // Tunnels.
    const inT = RUN.tunnels.find((t) => t.edge === front.edge && front.off >= t.from && front.off <= t.to)?.id ?? null;
    if (inT !== s.inTunnel) {
      if (s.inTunnel) this.emit({ type: 'tunnelExit', id: s.inTunnel });
      if (inT) this.emit({ type: 'tunnelEnter', id: inT });
      s.inTunnel = inT;
    }
    // Telegrams.
    for (const tg of RUN.telegrams) {
      if (tg.clock !== undefined && this.clock() >= tg.clock && !s.telegramsSent.includes(tg.id)) {
        s.telegramsSent.push(tg.id);
        this.emit({ type: 'telegram', id: tg.id, text: tg.text });
      }
    }
    // Timetabled trains, and collisions with them.
    for (const a of this.aiSpans()) {
      if (a.spans.length === 0 || !spansOverlap(s.spans, a.spans)) continue;
      this.emit({ type: 'collision', with: a.def.id });
      this.lose('collision', `Hit ${a.def.name}`);
    }
    // Flags expire after 90 s or once the train is past them.
    s.flags = s.flags.filter((f) => s.tick - f.tick < 90 * TICK_HZ && xOnSpans(s.spans, f.point) === null);
    if (s.overTicks > 1.5 * TICK_HZ) this.lose('derailed', 'Derailed');
  }

  private lose(reason: NonNullable<EngineerView['loss']>['reason'], detail: string): void {
    const s = this.s;
    if (s.phase !== 'running') return;
    s.phase = 'lost';
    s.loss = { reason, detail };
    s.v = 0;
    this.emit({ type: 'lost', reason, detail });
  }

  view(): EngineerView {
    const s = this.s;
    const front = frontHead(s.spans);
    // Charted trains within sight (spec §10.1), as views.toEngineerView reports them.
    const trains: EngineerView['trains'] = [];
    const fp = framePath(ix, s.switches, s.spans, SIGHT_RANGE, SIGHT_RANGE);
    const ours = mainPos(ix, front);
    for (const a of this.aiSpans()) {
      if (a.spans.length === 0) continue;
      const theirs = mainPos(ix, frontHead(a.spans));
      if (spansOverlap(fp.spans, a.spans) || (ours !== null && theirs !== null && Math.abs(ours - theirs) <= SIGHT_RANGE)) {
        trains.push({ id: a.def.id, spans: a.spans.map((x) => ({ ...x })), mainPos: theirs });
      }
    }
    return {
      tick: s.tick,
      clock: this.clock(),
      phase: s.phase,
      loss: s.loss ? { ...s.loss } : null,
      train: {
        spans: s.spans.map((x) => ({ ...x })),
        length: TRAIN_LENGTH,
        v: s.v,
        throttle: s.throttle,
        brake: s.brake,
        reverser: s.reverser,
        fire: s.fire,
        pressure: s.pressure,
        water: s.water,
        waterCap: 100,
        whistle: s.whistle,
        heldUp: s.heldUp,
        overspeed: s.overspeed,
        safetyValve: s.safetyValve,
        spout: s.spout,
        stationStop: s.stationStop ? { stationId: s.stationStop.stationId, progress: s.stationStop.done ? 1 : Math.min(1, s.stationStop.ticks / (DWELL_SECONDS * TICK_HZ)) } : null,
        mainPos: mainPos(ix, front),
        hatch: hatchPoint(s.spans),
        limit: limitAt(ix, front),
      },
      switches: { ...s.switches },
      trains,
      flags: s.flags.map((f) => ({ ...f, point: { ...f.point } })),
      rider: { ...s.rider },
      fines: s.fines,
      cargo: s.cargo,
      sideJobs: s.sideJobs.map((j) => ({ ...j })),
    };
  }

  // ---- Faked events (the bench's buttons) ------------------------------------------------------

  telegram(text = 'Runaway loose on the quarry grade stop keep the spur switch set stop'): void {
    this.emit({ type: 'telegram', id: `x${this.s.tick}`, text });
  }

  holdUp(on: boolean): void {
    if (this.s.heldUp === on) return;
    this.s.heldUp = on;
    this.emit(on ? { type: 'heldUp' } : { type: 'holdupEnded' });
  }

  riderTo(mode: RiderMode, car = 3, roof = true): void {
    const r = this.s.rider;
    if (mode === 'off' && r.mode === 'active') this.emit({ type: 'riderOff', cause: 'fall' });
    if (mode === 'down' && r.mode !== 'down') this.emit({ type: 'riderDown' });
    if (mode === 'active' && r.mode !== 'active') this.emit({ type: 'riderBack' });
    this.s.rider = { car, roof, mode };
  }

  flagAhead(metres = 420): void {
    const s = this.s;
    const w = walk(ix, s.switches, frontHead(s.spans), metres);
    const flag: FlagState = { id: s.nextFlag++, point: { edge: w.end.edge, off: w.end.off }, tick: s.tick };
    s.flags.push(flag);
    if (s.flags.length > 3) s.flags.shift();
    this.emit({ type: 'flagPlaced', flag });
  }

  fine(amount: 50 | 10): void {
    this.s.fines += amount;
    this.emit({ type: 'fine', reason: amount === 50 ? 'redSignal' : 'speeding', amount });
  }

  loot(stolen: boolean): void {
    this.s.cargo = stolen ? 'stolen' : 'ok';
    this.emit(stolen ? { type: 'lootStolen' } : { type: 'lootRecovered' });
  }

  gunfire(): void {
    this.emit({ type: 'gunfire', intensity: 0.5 });
  }

  /** Puts the train's front at a point, running at v. */
  place(front: { edge: string; off: number; dir: 1 | -1 }, v: number, clock: number, set: Partial<Fake> = {}): void {
    const s = this.s;
    Object.assign(s, set);
    s.spans = spansFromFront(ix, s.switches, front, TRAIN_LENGTH);
    s.v = v;
    s.tick = Math.round((clock - RUN.startClock) * TICK_HZ);
    s.inTunnel = RUN.tunnels.find((t) => t.edge === front.edge && front.off >= t.from && front.off <= t.to)?.id ?? null;
    s.telegramsSent = RUN.telegrams.filter((t) => t.clock !== undefined && t.clock <= clock).map((t) => t.id);
  }
}

function hatchPoint(spans: readonly Span[]): { edge: string; off: number } {
  const p = pointAt(spans, spansLength(spans) - HATCH_BACK);
  return { edge: p.edge, off: p.off };
}

/** Signed metres from the loco's front to a point (+ ahead), within the train or 60 m ahead. */
function distTo(spans: readonly Span[], p: { edge: string; off: number }): number | null {
  const L = spansLength(spans);
  const on = xOnSpans(spans, p);
  if (on !== null) return on - L;
  const w = walk(ix, initialSwitches(), frontHead(spans), 60);
  const d = xOnSpans(w.spans, p);
  return d;
}

// ---------------------------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------------------------

const SCENES = ['depart', 'cruise', 'station', 'water', 'meet', 'siding', 'heldup', 'events', 'backing', 'late', 'enroute'] as const;
/** The scenes a campaign run supports (the others are laid out on the bench run's track). */
const GENERIC: readonly string[] = ['depart', 'enroute'];
type SceneName = (typeof SCENES)[number];

interface SceneSetup {
  /** The trace so far: (clock, main-line position) points the desk is fed first. */
  history: [number, number][];
}

function setupScene(host: FakeHost, name: SceneName): SceneSetup {
  host.reset();
  const sw = host.s.switches;
  const at = (min: number, sec = 0): number => H9 + min * 60 + sec;
  switch (IS_BENCH || GENERIC.includes(name) ? name : 'enroute') {
    case 'depart':
      return { history: [] };
    case 'enroute': {
      // A few miles down the line, running, roughly on time.
      const main = RUN.mainLine.reduce((n, id) => n + (ix.edge.get(id)?.length ?? 0), 0);
      const w = walk(ix, sw, RUN.start, Math.min(main * 0.4, 6500));
      const t0 = RUN.startClock;
      const clock = t0 + 30 + w.walked / 13;
      host.place(w.end, 15, clock, { throttle: 0.5, pressure: 178, water: Math.max(25, RUN.initialWater - 30) });
      const m0 = mainPos(ix, RUN.start) ?? 0;
      return { history: [[t0, m0], [t0 + 30, m0], [clock, mainPos(ix, w.end) ?? m0]] };
    }
    case 'cruise':
      host.place({ edge: 'm1', off: 900, dir: 1 }, 18.5, at(1, 20), { throttle: 0.625, fire: 2, pressure: 176, water: 84 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(0, 50), 470], [at(1, 20), 900]] };
    case 'station':
      host.place({ edge: 'm3', off: 440, dir: 1 }, 1.6, at(5, 48), { throttle: 0, brake: 0.34, pressure: 181, water: 58 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(3, 0), 2700], [at(4, 30), 3900], [at(5, 48), 4540]] };
    case 'water':
      host.place({ edge: 'm2', off: 1200 + HATCH_BACK - 5.5, dir: 1 }, 1.1, at(4, 25), { throttle: 0, brake: 0.51, pressure: 168, water: 17 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(3, 0), 2700], [at(4, 25), 3818]] };
    case 'meet':
      host.assist = true;
      host.place({ edge: 'm2', off: 820, dir: 1 }, 14.5, at(3, 20), { throttle: 0.5, pressure: 183, water: 62 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(2, 40), 2600], [at(3, 20), 3420]] };
    case 'siding':
      host.assist = true;
      sw.P = 'reverse';
      host.place({ edge: 's1', off: 820, dir: 1 }, 0, at(7, 10), { throttle: 0, brake: 0.51, pressure: 186, water: 55 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(3, 0), 2700], [at(4, 50), 4200], [at(5, 40), 4920], [at(7, 10), 4920]] };
    case 'heldup':
      host.place({ edge: 'm2', off: 150, dir: 1 }, 15.5, at(2, 30), { throttle: 0.5, brake: 0.2, pressure: 172, water: 70 });
      host.holdUp(true);
      host.riderTo('active', 4, true);
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(2, 30), 2750]] };
    case 'events':
      host.place({ edge: 'm1', off: 1650, dir: 1 }, 17, at(2, 0), { throttle: 0.625, pressure: 178, water: 76 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(2, 0), 1650]] };
    case 'backing':
      sw.J1 = 'reverse';
      host.place({ edge: 'sp', off: 620, dir: 1 }, -2.2, at(4, 10), { throttle: 0.25, reverser: -1, pressure: 180, water: 66 });
      return { history: [[at(0), 350], [at(0, 20), 360], [at(1, 20), 900], [at(2, 40), 2600], [at(3, 30), 3140], [at(4, 10), 3100]] };
    case 'late':
      host.place({ edge: 'm5', off: 1150, dir: 1 }, 6, at(16, 40), { throttle: 0, brake: 0.34, pressure: 150, water: 31 });
      host.s.sideJobs = [{ id: 'sj1', state: 'aboard' }];
      host.s.fines = 60;
      return { history: [[at(0), 350], [at(0, 20), 360], [at(3, 0), 2700], [at(5, 0), 4150], [at(9, 30), 4920], [at(12, 0), 6900], [at(16, 40), 8550]] };
  }
}

/** Replays a scene's history into the desk so its chart shows a plausible trace. */
function feedHistory(desk: EngineerDesk, host: FakeHost, setup: SceneSetup, now: number): void {
  const v = host.view();
  const pts = setup.history;
  for (let i = 1; i < pts.length; i++) {
    const [ta, ma] = pts[i - 1];
    const [tb, mb] = pts[i];
    for (let t = ta; t < tb; t += 2) {
      const m = ma + ((mb - ma) * (t - ta)) / Math.max(1, tb - ta);
      desk.setView({ ...v, clock: t, tick: Math.round((t - RUN.startClock) * TICK_HZ), train: { ...v.train, mainPos: m } }, now);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage') as HTMLElement;
const bench = document.getElementById('bench') as HTMLElement;
const pausedEl = document.getElementById('paused') as HTMLElement;
if (params.get('ui') === '0') document.body.classList.add('noui');

const host = new FakeHost();
let sceneName: SceneName = (SCENES as readonly string[]).includes(params.get('scene') ?? '') ? (params.get('scene') as SceneName) : 'depart';
let assist = params.get('assist') === '1';
let letters = params.get('letters') === '1';
let keyboard: 'full' | 'local' = params.get('keyboard') === 'local' ? 'local' : 'full';
const lagMs = Number(params.get('lag') ?? 60);
let timeScale = 1;
let paused = params.get('paused') === '1';
let frozen = params.get('freeze') === '1';
let debugOn = params.get('debug') === '1';
let desk: EngineerDesk | null = null;
let acc = 0;
let viewAcc = 0;
let last = performance.now();
const sent: string[] = [];

function makeDesk(): void {
  desk?.destroy();
  const d = new EngineerDesk(ENGINEER_RUN, {
    onCmd: (cmd) => {
      sent.push(`${cmd.kind}${'value' in cmd ? ` ${cmd.value}` : 'on' in cmd ? ` ${cmd.on}` : ` ${cmd.junction} ${cmd.state}`}`);
      if (sent.length > 8) sent.shift();
      // Half the lag there, half back.
      window.setTimeout(() => {
        const reason = host.apply(cmd);
        if (reason) window.setTimeout(() => desk?.refused(reason, performance.now(), cmd), lagMs / 2);
      }, lagMs / 2);
    },
    onPause: () => setPaused(true),
    keyboard,
    lampLetters: letters,
    assist,
    consist: CONSIST,
  });
  desk = d;
  stage.append(d.el);
  host.assist = assist;
}

function loadScene(name: SceneName): void {
  sceneName = name;
  const setup = setupScene(host, name);
  // Scenes that want the assist turn it on; otherwise the toggle decides.
  if (host.assist && !assist) {
    assist = true;
  }
  makeDesk();
  const now = performance.now();
  const d = desk;
  if (!d) return;
  feedHistory(d, host, setup, now);
  d.setView(host.view(), now);
  flushEvents(now);
  if (name === 'events') fakeEventBurst(now);
  if (params.get('rulebook') === '1') d.setRulebook(true);
  if (params.get('follow') === '1') d.setFollow(true);
  d.setDebug(debugOn ? debugInfo() : null);
  d.setEnabled(!paused);
  pausedEl.hidden = !paused;
  syncBench();
}

function fakeEventBurst(now: number): void {
  host.telegram('No 7 freight westbound on time stop take the siding at Mesa stop');
  host.gunfire();
  host.gunfire();
  host.fine(10);
  host.riderTo('off', 0, false);
  host.flagAhead(460);
  flushEvents(now);
}

/** Hands the desk the host's pending events, and a fresh view when anything happened. */
function flushEvents(now: number): void {
  const ev = host.events.splice(0);
  for (const e of ev) desk?.onEvent(e, now);
  if (ev.length > 0) desk?.setView(host.view(), now);
}

function debugInfo(): DebugInfo {
  const cycle: Aspect[] = ['clear', 'approach', 'stop'];
  const aspects: Record<string, Aspect> = {};
  RUN.signals.forEach((g, i) => (aspects[g.id] = cycle[i % cycle.length]));
  return { obstacles: RUN.obstacles.map((o) => ({ id: o.id, edge: o.edge, at: o.at, kind: o.kind, state: 'present' })), aspects, bandits: 1, horsemen: 3 };
}

function setPaused(p: boolean): void {
  paused = p;
  pausedEl.hidden = !p;
  desk?.setEnabled(!p);
  syncBench();
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') document.body.classList.toggle('noui');
  if (e.code !== 'Escape' || e.repeat) return;
  // Resuming is the app's pause screen's job; in local mode Esc is the Rider's (the desk leaves it).
  if (paused) setPaused(false);
  else if (keyboard === 'local') setPaused(true);
});

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!paused && !frozen && desk) {
    acc += dt * timeScale;
    viewAcc += dt;
    const stepDt = 1 / TICK_HZ;
    let n = 0;
    while (acc >= stepDt && n < 600) {
      host.step(stepDt);
      acc -= stepDt;
      n++;
    }
    if (viewAcc >= 1 / 15) {
      viewAcc = 0;
      desk.setView(host.view(), now);
      if (debugOn) desk.setDebug(debugInfo());
    }
    flushEvents(now);
  }
  desk?.frame(now);
  updateStats();
  requestAnimationFrame(frame);
}

// ---- The bench drawer -------------------------------------------------------------------------

function button(label: string, onClick: () => void, pressed?: () => boolean): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => {
    onClick();
    syncBench();
  });
  if (pressed) b.dataset.pressed = '1';
  (b as HTMLButtonElement & { pressed?: () => boolean }).pressed = pressed;
  return b;
}

const toggles: (HTMLButtonElement & { pressed?: () => boolean })[] = [];
const stats = document.createElement('div');
stats.className = 'stats';

function section(title: string, ...items: HTMLElement[]): void {
  const h = document.createElement('h3');
  h.textContent = title;
  const row = document.createElement('div');
  row.className = 'row';
  row.append(...items);
  bench.append(h, row);
}

function buildBench(): void {
  const sel = document.createElement('select');
  for (const s of SCENES) sel.append(new Option(s, s));
  sel.value = sceneName;
  sel.addEventListener('change', () => loadScene(sel.value as SceneName));
  sel.id = 'scene-select';
  const runSel = document.createElement('select');
  runSel.append(new Option('Bench run', '0'));
  RUNS.forEach((r, i) => runSel.append(new Option(`${i + 1}. ${r.name}`, String(i + 1))));
  runSel.value = String(IS_BENCH ? 0 : RUN_NO);
  runSel.addEventListener('change', () => {
    const q = new URLSearchParams(location.search);
    q.set('run', runSel.value);
    location.search = q.toString();
  });
  section('Run', runSel);
  section('Scene', sel, button('Reload', () => loadScene(sceneName)));
  const t = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement => {
    const b = button(label, () => set(!get()), get) as HTMLButtonElement & { pressed?: () => boolean };
    toggles.push(b);
    return b;
  };
  section(
    'Desk options',
    t('Assist', () => assist, (v) => ((assist = v), loadScene(sceneName))),
    t('Lamp letters', () => letters, (v) => ((letters = v), loadScene(sceneName))),
    t('Local keys', () => keyboard === 'local', (v) => ((keyboard = v ? 'local' : 'full'), loadScene(sceneName))),
    t('Debug', () => debugOn, (v) => ((debugOn = v), desk?.setDebug(v ? debugInfo() : null))),
    t('Paused', () => paused, (v) => setPaused(v)),
    t('Frozen', () => frozen, (v) => (frozen = v)),
  );
  section(
    'Time',
    t('×1', () => timeScale === 1, () => (timeScale = 1)),
    t('×4', () => timeScale === 4, () => (timeScale = 4)),
    t('×10', () => timeScale === 10, () => (timeScale = 10)),
    button('+30 s', () => {
      for (let k = 0; k < 30 * TICK_HZ; k++) host.step(1 / TICK_HZ);
    }),
  );
  section(
    'Fake events',
    button('Telegram', () => host.telegram()),
    t('Held up', () => host.s.heldUp, (v) => host.holdUp(v)),
    button('Flag ahead', () => host.flagAhead()),
    button('Fine $50', () => host.fine(50)),
    button('Fine $10', () => host.fine(10)),
    button('Gunfire', () => host.gunfire()),
    button('Loot stolen', () => host.loot(true)),
    button('Recovered', () => host.loot(false)),
  );
  section(
    'The Rider',
    button('Roof car 3', () => host.riderTo('active', 4, true)),
    button('Inside car 1', () => host.riderTo('active', 2, false)),
    button('Tender', () => host.riderTo('active', 1, true)),
    button('Cab', () => host.riderTo('active', 0, false)),
    button('Off', () => host.riderTo('off')),
    button('Down', () => host.riderTo('down')),
  );
  bench.append(stats);
}

function syncBench(): void {
  for (const b of toggles) b.setAttribute('aria-pressed', String(!!b.pressed?.()));
  const sel = document.getElementById('scene-select') as HTMLSelectElement | null;
  if (sel) sel.value = sceneName;
}

let statsAt = 0;
function updateStats(): void {
  const now = performance.now();
  if (now - statsAt < 250) return;
  statsAt = now;
  const s = host.s;
  stats.textContent = [
    `${(Math.abs(s.v) * 2.23694).toFixed(1)} mph  T ${s.throttle.toFixed(2)}  B ${s.brake.toFixed(2)}`,
    `rev ${s.reverser}  fire ${s.fire}  ${s.pressure.toFixed(0)} psi  water ${s.water.toFixed(1)}`,
    `${host.clock().toFixed(0)} s  ${s.phase}`,
    'sent:',
    ...sent.slice(-5).map((x) => `  ${x}`),
  ].join('\n');
}

// ---- Automation --------------------------------------------------------------------------------

interface Harness {
  scenes: readonly string[];
  desk: () => EngineerDesk | null;
  scene(name: string): void;
  pause(p: boolean): void;
  /** Runs the fake host for `seconds` of game time at once (views and events follow). */
  step(seconds: number): void;
  holdUp(on: boolean): void;
  telegram(text?: string): void;
  flag(metres?: number): void;
  fine(amount: 50 | 10): void;
  rider(mode: RiderMode, car?: number, roof?: boolean): void;
  loot(stolen: boolean): void;
  set(patch: Partial<Fake>): void;
  state(): Fake;
  sent(): string[];
  /** Puts the loco's front at a point, running at v (m/s). */
  place(edge: string, off: number, v?: number, dir?: 1 | -1): void;
  /** Makes the host refuse the desk's last command (or `cmd`) with a reason. */
  refuse(reason: string): void;
  /** Times `n` snapshot-and-frame cycles (the fake host advancing 1/15 s each): ms per cycle. */
  bench(n?: number): { avgMs: number; p95Ms: number; maxMs: number; slow: [number, number][] };
}

const harness: Harness = {
  scenes: SCENES,
  desk: () => desk,
  scene: (name) => loadScene((SCENES as readonly string[]).includes(name) ? (name as SceneName) : 'depart'),
  pause: (p) => setPaused(p),
  step: (seconds) => {
    for (let k = 0; k < seconds * TICK_HZ; k++) host.step(1 / TICK_HZ);
    const now = performance.now();
    desk?.setView(host.view(), now);
    flushEvents(now);
  },
  holdUp: (on) => host.holdUp(on),
  telegram: (text) => host.telegram(text),
  flag: (m) => host.flagAhead(m),
  fine: (a) => host.fine(a),
  rider: (mode, car, roof) => host.riderTo(mode, car, roof),
  loot: (stolen) => host.loot(stolen),
  set: (patch) => Object.assign(host.s, patch),
  state: () => host.s,
  sent: () => [...sent],
  place: (edge, off, v = 0, dir = 1) => {
    host.place({ edge, off, dir }, v, host.clock());
    desk?.setView(host.view(), performance.now());
  },
  refuse: (reason) => desk?.refused(reason, performance.now()),
  bench: (n = 120) => {
    const times: number[] = [];
    const d = desk;
    if (!d) return { avgMs: 0, p95Ms: 0, maxMs: 0, slow: [] };
    let now = performance.now();
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < TICK_HZ / 15; i++) host.step(1 / TICK_HZ);
      now += 1000 / 15;
      const t0 = performance.now();
      d.setView(host.view(), now);
      flushEvents(now);
      d.frame(now);
      times.push(performance.now() - t0);
    }
    const slow = times.map((t, i): [number, number] => [i, Math.round(t)]).filter(([, t]) => t > 8);
    times.sort((a, b) => a - b);
    return { avgMs: times.reduce((a, b) => a + b, 0) / n, p95Ms: times[Math.floor(n * 0.95)], maxMs: times[n - 1], slow };
  },
};
(window as unknown as { harness: Harness }).harness = harness;

buildBench();
loadScene(sceneName);
requestAnimationFrame(frame);
