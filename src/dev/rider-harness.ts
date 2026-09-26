// Dev-only harness for the Rider's view (src/render/rider), served by Vite at /rider.html. Not part
// of the production build (only index.html is a build entry).
//
// It builds a GameState with newGame for a run in src/content/runs.ts (each scene picks a run that
// has what it shows) and advances it with the sim's step(). Everything the scene is about is staged
// by writing the state directly: the Rider's poses, bandits aboard, horsemen alongside, obstacles,
// other trains, signals and their aspects, time of day, and synthesized events (shots, aims,
// explosions, a lurch, a ford entered, figures washed off). A staged scene restores its figures
// after every step and drops the sim's own fight events, so screenshots are repeatable whatever the
// Rider and bandit modules do. Signals and fords a scene needs are added to its own copy of the run
// on a plain stretch of the main line, so no scene depends on where the content puts them.
//
// The "play" scene is interactive. If the sim's step() drives the Rider (probed at startup), play
// uses the real game loop with keyboard input; otherwise a small physics of its own on the real
// train geometry. Keys: A/D walk, W/Space jump (W climbs a ladder, or out of a hatch), S crouch
// (climbs down, or drops through a hatch), E interact, mouse aims, click fires, R reloads, Q or 1–3
// weapons, Shift or right mouse raises the spyglass (click places a flag), ↑/↓ throttle, ←/→ brake,
// H whistle.
//
// Harness keys: [ / ] previous / next scene, P pause, ` hide the panel, M screen shake, L lamp
// letters, G debug labels, N night on/off. Query: ?scene=name, ?hud=0, ?run=id (for play).
//
// Automation (Playwright): window.harness — scenario(name), scenarios(), render(frames),
// timing(frames), pause(), resume(), settings(), emit(events), state(), run(), items(), renderer().

import { RUNS } from '../content/runs';
import { trainLook } from '../render/rider/cars';
import { RiderRenderer, type RiderFrame } from '../render/rider/renderer';
import { trainGeometry } from '../sim/geometry';
import { spawnWave } from '../sim/bandits';
import { fightContext, newGame, step } from '../sim/game';
import { framePath, framePoint, frontHead, mainPos, netIndex, rearHead, spansFromFront, walk } from '../sim/network';
import { CAR_SPECS, DT, FLAG_MAX, RIDER_SHOULDER, RIDER_SHOULDER_CROUCH, SCOPE_MAX, SCOPE_MIN, TICK_HZ, WEAPONS } from '../sim/rules';
import { NO_INPUT } from '../sim/types';
import type {
  AiTrainDef,
  Aspect,
  BanditState,
  CarType,
  Dir,
  EngineerCmd,
  GameState,
  HorsemanState,
  ObstacleKind,
  RiderInput,
  RiderState,
  RunDef,
  SignalDef,
  SimEvent,
  Span,
  SurfaceKind,
  TrackHead,
  TracksideItem,
  Weapon,
} from '../sim/types';
import { trackside } from '../sim/views';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLElement;
const scenesEl = document.getElementById('scenes') as HTMLElement;
const params = new URLSearchParams(location.search);
if (params.get('hud') === '0') document.body.classList.add('nohud');

function runFor(id: string | null | undefined): RunDef {
  return RUNS.find((r) => r.id === id) ?? RUNS[0];
}

let baseRun: RunDef = runFor(params.get('run'));
let run: RunDef = baseRun;
let state: GameState;
let renderer: RiderRenderer | null = null;
let running = true;
let auto = false;
let nowMs = 0;
let lastMs = 0;
let acc = 0;
let pending: SimEvent[] = [];
let settings = { screenShake: true, lampLetters: false };
let debugLabels = false;
let prompt: string | null = null;
let aspectOverride: Record<string, Aspect> | null = null;
/** Dev camera: a train-frame x to look at, or null to follow the Rider. */
let cameraAt: ((st: GameState) => number) | null = null;
let hold: ((st: GameState, t: number) => void) | null = null;
let sceneName = 'day';
let sceneTime = 0;
let seq = 1;
const cmds: EngineerCmd[] = [];
const drawMs: number[] = [];

// ---------------------------------------------------------------------------------------------
// Building a staged game

interface Extras {
  /** Which run to stage on (default: the first). */
  run?: string;
  consist?: CarType[];
  night?: boolean;
  /** Clock at the start (h); staged scenes default to noon. */
  hour?: number;
  signals?: { d: number; facing: 'with' | 'against'; heads: 1 | 2; id: string }[];
  mileposts?: { at: TrackHead; mile: number }[];
  /** Fords `len` metres long from `d` metres along the main line (clipped to one edge). */
  fords?: { d: number; len: number; id: string; name: string }[];
}

const FULL: CarType[] = ['express', 'passenger', 'boxcar', 'armored', 'caboose'];

function initialSwitches(r: RunDef): Record<string, 'normal' | 'reverse'> {
  const sw: Record<string, 'normal' | 'reverse'> = {};
  for (const j of r.junctions) sw[j.node] = j.initial;
  return sw;
}

/** Direction the main line runs along each edge, from the run's start. */
function mainDirs(r: RunDef): Map<string, Dir> {
  const w = walk(netIndex(r), initialSwitches(r), r.start, 50_000);
  const m = new Map<string, Dir>();
  for (const s of w.spans) if (!m.has(s.edge)) m.set(s.edge, s.to >= s.from ? 1 : -1);
  return m;
}

/** A point `d` metres along the main line from the run's start (following the switches). */
function alongMain(r: RunDef, d: number): TrackHead {
  return walk(netIndex(r), initialSwitches(r), r.start, d).end;
}

/** The point `d` metres before `p` (heading `dir`), still heading `dir`; negative d is after it. */
function before(r: RunDef, p: TrackHead, d: number): TrackHead {
  const ix = netIndex(r);
  const sw = initialSwitches(r);
  if (d < 0) return walk(ix, sw, p, -d).end;
  const back = walk(ix, sw, { edge: p.edge, off: p.off, dir: p.dir === 1 ? -1 : 1 }, d).end;
  return { edge: back.edge, off: back.off, dir: back.dir === 1 ? -1 : 1 };
}

/**
 * A distance along the main line (from the start, at least `from`) where nothing trackside lies
 * within `back` metres behind or `ahead` metres past the loco's front: a plain stretch to stage on.
 */
function clearAlong(r: RunDef, from: number, back = 115, ahead = 90): number {
  const ix = netIndex(r);
  const m0 = mainPos(ix, r.start) ?? 0;
  const marks: [number, number][] = [];
  const mark = (edge: string, a: number, b: number, pad: number): void => {
    const p = mainPos(ix, { edge, off: a });
    const q = mainPos(ix, { edge, off: b });
    if (p !== null && q !== null) marks.push([Math.min(p, q) - pad, Math.max(p, q) + pad]);
  };
  for (const t of r.tunnels) mark(t.edge, t.from, t.to, 40);
  for (const t of r.trestles) mark(t.edge, t.from, t.to, 10);
  for (const b of r.lowBridges) mark(b.edge, b.at, b.at, 30);
  for (const s of r.stations) mark(s.edge, s.at, s.at, s.platform / 2 + 15);
  for (const w of r.waterTowers) mark(w.edge, w.at, w.at, 10);
  for (const g of r.signals) mark(g.edge, g.at, g.at, 5);
  for (const j of r.junctions) {
    const e = r.edges.find((x) => x.id === j.trunk);
    if (e) mark(e.id, e.a === j.node ? 0 : e.length, e.a === j.node ? 0 : e.length, 50);
  }
  for (let d = from; d < 30_000; d += 20) {
    const f = m0 + d;
    if (!marks.some(([a, b]) => b > f - back && a < f + ahead)) return d;
  }
  return from;
}

function fresh(ex: Extras = {}): void {
  baseRun = runFor(ex.run ?? RUNS[0].id);
  const r: RunDef = structuredClone(baseRun);
  if (ex.night !== undefined) r.night = ex.night;
  r.startClock = (ex.hour ?? 12) * 3600;
  // Positions come from the base run: netIndex() caches per run object, so the copy must not be
  // indexed until every extra feature is in it.
  for (const sg of ex.signals ?? []) {
    const p = alongMain(baseRun, sg.d);
    const def: SignalDef = { id: sg.id, edge: p.edge, at: p.off, facing: sg.facing === 'with' ? p.dir : ((-p.dir) as Dir), kind: sg.heads === 2 ? 'junction' : 'block' };
    if (sg.heads === 2 && r.junctions[0]) def.junction = r.junctions[0].node;
    else if (sg.heads === 2) def.kind = 'block';
    r.signals.push(def);
  }
  for (const m of ex.mileposts ?? []) r.mileposts.push({ edge: m.at.edge, at: m.at.off, mile: m.mile });
  for (const fd of ex.fords ?? []) {
    // A ford lies on one edge: the one its start is on.
    const p = alongMain(baseRun, fd.d);
    const len = baseRun.edges.find((e) => e.id === p.edge)?.length ?? p.off;
    const end = p.dir === 1 ? Math.min(len, p.off + fd.len) : Math.max(0, p.off - fd.len);
    r.fords.push({ id: fd.id, name: fd.name, edge: p.edge, from: Math.min(p.off, end), to: Math.max(p.off, end) });
  }
  run = r;
  state = newGame(run, { seed: 7, consist: ex.consist ?? FULL, upgrades: ['shotgun', 'rifle', 'headlamp'], assists: { rider: false, engineer: false } });
  state.godMode = true;
  state.waves = [];
  hold = null;
  prompt = null;
  aspectOverride = null;
  cameraAt = null;
  pending = [];
  sceneTime = 0;
  renderer?.destroy();
  renderer = new RiderRenderer(canvas);
}

/** Puts the loco's front at `front` (the whole train laid back behind it). */
function placeFront(front: TrackHead): void {
  state.train.spans = spansFromFront(netIndex(run), state.switches, front, state.train.length);
}

/** Places the train so that after `frames` frames at speed v its front is `d` metres before `p`, and keeps it at that speed. */
function approachPoint(p: TrackHead, d: number, v: number, frames: number, throttle = 0.6): void {
  placeFront(before(run, p, d + (v * frames) / 60));
  cruise(v, throttle);
}

function cruise(v: number, throttle = 0.6): void {
  state.train.v = v;
  state.train.throttle = throttle;
  state.train.brake = 0;
  addHold((st) => {
    st.train.v = v;
    st.train.throttle = throttle;
    st.train.brake = 0;
  });
}

function addHold(fn: (st: GameState, t: number) => void): void {
  const prev = hold;
  hold = (st, t) => {
    prev?.(st, t);
    fn(st, t);
  };
}

function feature(kind: 'tunnel' | 'lowBridge' | 'trestle' | 'station' | 'water' | 'curve'): TrackHead | null {
  const dirs = mainDirs(run);
  const at = (edge: string, off: number): TrackHead | null => {
    const dir = dirs.get(edge);
    return dir ? { edge, off, dir } : null;
  };
  const range = (edge: string, from: number, to: number): TrackHead | null => at(edge, dirs.get(edge) === 1 ? from : to);
  switch (kind) {
    case 'tunnel': {
      const t = run.tunnels.find((x) => dirs.has(x.edge));
      return t ? range(t.edge, t.from, t.to) : null;
    }
    case 'trestle': {
      const t = run.trestles.find((x) => dirs.has(x.edge));
      return t ? range(t.edge, t.from, t.to) : null;
    }
    case 'curve': {
      const t = run.curves.find((x) => dirs.has(x.edge));
      return t ? range(t.edge, t.from, t.to) : null;
    }
    case 'lowBridge': {
      const b = run.lowBridges.find((x) => dirs.has(x.edge));
      return b ? at(b.edge, b.at) : null;
    }
    case 'station': {
      const s = run.stations.find((x) => x.id === run.origin) ?? run.stations[0];
      return s ? at(s.edge, s.at) : null;
    }
    case 'water': {
      const w = run.waterTowers.find((x) => dirs.has(x.edge));
      return w ? at(w.edge, w.at) : null;
    }
  }
}

/** A plain stretch of the current run, `extra` metres further along. */
function plain(extra = 0, from = 600): TrackHead {
  return alongMain(run, clearAlong(run, from) + extra);
}

/**
 * A ford scene on the first run: a ford `len` metres long whose start is `ahead` metres past the
 * loco's front once `frames` frames have run at `v` (negative: the front is that far into it).
 */
function fordScene(ahead: number, len: number, v: number, frames: number, ex: Extras = {}): void {
  const d = clearAlong(RUNS[0], 700, 150, 140);
  fresh({ ...ex, fords: [{ d: d + ahead, len, id: 'ford1', name: 'Cottonwood Ford' }] });
  approachPoint(alongMain(run, d), 0, v, frames, 0.7);
}

/**
 * A scout-alert scene: cattle standing 400 m past the loco's front when the frame is taken, `frames`
 * frames in at 12 m/s, and the Rider on the express roof looking ahead (`look` may raise the spyglass).
 */
function scoutScene(frames: number, look?: (st: GameState, t: number) => void, ex: Extras = {}): void {
  fresh(ex);
  approachPoint(plain(), 0, 12, frames, 0.6);
  riderAt(carIndex('express'), 'roof', 1.5, { facing: 1, aim: 0.15 });
  obstacle('herd1', 'cattle', 400 + 12 * (frames / 60));
  stage([], []);
  if (look) addHold(look);
  settle(frames);
}

/** The train 45 m into a ford at 10 m/s: the Rider dry on a roof, a bandit washed off, a horse wading. */
function fordInside(ex: Extras = {}): string {
  fordScene(-45, 95, 10, 80, ex);
  const exp = carIndex('express');
  riderAt(exp, 'roof', 2, { facing: 1, aim: 0.15 });
  const c = state.train.cars[exp];
  stage([bandit(121, exp, 'platformRear', 0, { facing: 1 })], [horseman(122, c.x1 + 5, { mode: 'pace', worldV: 5 })], (t, b) => {
    if (t > 1) b.length = 0;
  });
  settle(60);
  emit({ type: 'banditKnockedOff', id: 121, cause: 'water' });
  settle(20);
  return 'Inside a ford at 10 m/s: the Rider dry on the express roof, a bandit washed off its platform, a horseman wading';
}

// ---- Figures ---------------------------------------------------------------------------------

function carIndex(kind: string): number {
  const i = state.train.cars.findIndex((c) => c.kind === kind);
  return i >= 0 ? i : Math.min(2, state.train.cars.length - 1);
}

type Where = 'roof' | 'platformRear' | 'platformFront' | 'inside' | 'cab' | 'ladder';

/** Where a figure stands on car `car`, from the train's real geometry. */
function spot(car: number, where: Where, dx = 0): { x: number; y: number; surface: SurfaceKind | null; ladder: number | null } {
  const look = trainLook(state.train.cars).cars[car];
  const c = state.train.cars[car];
  const mid = (look.bx0 + look.bx1) / 2;
  switch (where) {
    case 'roof':
      if (c.kind === 'loco') return { x: c.x0 + 2.2 + dx, y: look.roofY, surface: 'cabRoof', ladder: null };
      if (c.kind === 'tender') return { x: mid + dx, y: look.roofY, surface: 'tenderTop', ladder: null };
      return { x: mid + dx, y: look.roofY, surface: 'roof', ladder: null };
    case 'platformRear':
      return { x: (look.decks[0] ? (look.decks[0][0] + look.decks[0][1]) / 2 : look.x0 + 0.5) + dx, y: look.floorY, surface: 'platform', ladder: null };
    case 'platformFront': {
      const d = look.decks[look.decks.length - 1];
      return { x: (d ? (d[0] + d[1]) / 2 : look.x1 - 0.5) + dx, y: look.floorY, surface: 'platform', ladder: null };
    }
    case 'inside':
      return { x: mid + dx, y: look.floorY, surface: 'floor', ladder: null };
    case 'cab':
      return { x: c.x0 + 1.1 + dx, y: CAR_SPECS.loco.floorY, surface: 'cabFloor', ladder: null };
    case 'ladder': {
      const geo = trainGeometry(state.train.cars);
      const li = geo.ladders.findIndex((l) => l.car === car && l.kind === 'end');
      const l = geo.ladders[li];
      return { x: (l ? l.x : look.bx0) + dx, y: look.floorY + 1.3, surface: null, ladder: li >= 0 ? li : null };
    }
  }
}

function riderAt(car: number, where: Where, dx = 0, extra: Partial<RiderState> = {}): void {
  const p = spot(car, where, dx);
  Object.assign(state.rider, {
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    onGround: where !== 'ladder',
    surface: p.surface,
    car,
    inside: where === 'inside' ? car : null,
    crouch: false,
    ladder: p.ladder,
    mode: 'active',
    scoped: false,
    ...extra,
  });
}

function bandit(id: number, car: number, where: Where, dx: number, extra: Partial<BanditState> = {}): BanditState {
  const p = spot(car, where, dx);
  return {
    id,
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    onGround: where !== 'ladder',
    surface: p.surface,
    ladder: p.ladder,
    crouch: false,
    facing: -1,
    hp: 1,
    tier: 1,
    boss: false,
    goal: 'hunt',
    mode: 'moving',
    modeTicks: 0,
    hasLoot: false,
    aimTicks: 0,
    cooldownTicks: 0,
    stunTicks: 0,
    burnTicks: 0,
    navTarget: null,
    ...extra,
  };
}

function horseman(id: number, x: number, extra: Partial<HorsemanState> = {}): HorsemanState {
  return {
    id,
    x,
    worldV: state.train.v,
    hp: 1,
    tier: 1,
    boss: false,
    goal: 'safe',
    mode: 'pace',
    modeTicks: 0,
    stamina: 8,
    targetX: x,
    aimTicks: 0,
    cooldownTicks: 0,
    behindTicks: 0,
    pickup: false,
    shyTicks: 0,
    ...extra,
  };
}

/**
 * Keeps the staged Rider, bandits and horsemen as staged after every sim step (`anim` may move
 * them with the scene's clock). Scene holds added later can still override what this restores.
 */
function stage(bandits: BanditState[], horsemen: HorsemanState[], anim?: (t: number, b: BanditState[], h: HorsemanState[]) => void): void {
  const riderCopy = structuredClone(state.rider);
  const banditsCopy = structuredClone(bandits);
  const horsemenCopy = structuredClone(horsemen);
  addHold((st, t) => {
    Object.assign(st.rider, structuredClone(riderCopy));
    const b = structuredClone(banditsCopy);
    const h = structuredClone(horsemenCopy);
    anim?.(t, b, h);
    st.bandits = b;
    st.horsemen = h;
  });
  hold?.(state, 0);
}

/**
 * Another train on our track, `ahead` metres past our front (or behind our rear, `behindUs`), `len`
 * long, coming at us or going away.
 */
function aiOnOurTrack(id: string, kind: AiTrainDef['kind'], ahead: number, len: number, cars: number, oncoming: boolean, v: number, behindUs = false): void {
  const w = walk(netIndex(run), state.switches, behindUs ? rearHead(state.train.spans) : frontHead(state.train.spans), ahead + len);
  const spans: Span[] = [];
  let acc0 = 0;
  for (const s of w.spans) {
    const l = Math.abs(s.to - s.from);
    const a = Math.max(ahead, acc0);
    const b = Math.min(ahead + len, acc0 + l);
    if (b > a) {
      const dir = s.to >= s.from ? 1 : -1;
      spans.push({ edge: s.edge, from: s.from + dir * (a - acc0), to: s.from + dir * (b - acc0) });
    }
    acc0 += l;
  }
  const ordered = oncoming ? spans.map((s) => ({ edge: s.edge, from: s.to, to: s.from })).reverse() : spans;
  run.aiTrains.push({ id, name: id, kind, cars, length: len, route: [], depart: 0, speed: v, stops: [], charted: kind !== 'runaway' });
  // done: the sim's traffic leaves a staged train alone; trackside() still shows it (it's active).
  state.ai.push({ id, active: true, done: true, spans: ordered, v, started: true, wrecked: false });
}

function obstacle(id: string, kind: ObstacleKind, ahead: number, st: 'present' | 'scattering' | 'hit' = 'present', ticks = 0): void {
  const p = walk(netIndex(run), state.switches, frontHead(state.train.spans), ahead).end;
  state.obstacles.push({ id, kind, edge: p.edge, at: p.off, state: st, ticks, calmTicks: 0 });
}

function emit(...ev: SimEvent[]): void {
  pending.push(...ev);
}

// ---------------------------------------------------------------------------------------------
// Scenes

const SCENES: Record<string, () => string> = {
  day() {
    fresh();
    approachPoint(plain(), 0, 14, 90);
    riderAt(carIndex('express'), 'roof', 1.5, { facing: 1, aim: 0.15 });
    stage([], []);
    settle(90);
    return 'The Rider on the express roof, 14 m/s, midday';
  },
  loco() {
    fresh();
    approachPoint(plain(), 0, 11, 90, 0.8);
    riderAt(1, 'roof', 1.2, { facing: 1, aim: 0.3 });
    stage([], []);
    settle(90);
    return 'At the loco: smoke, drivers, the Engineer in the cab';
  },
  horsemen() {
    fresh();
    approachPoint(plain(), 0, 15, 120);
    const ex = carIndex('express');
    riderAt(carIndex('passenger'), 'roof', -2, { facing: 1, aim: -0.25 });
    const c = state.train.cars[ex];
    const pa = state.train.cars[carIndex('passenger')];
    stage(
      [],
      [
        horseman(1, pa.x0 + 2, { mode: 'approach', worldV: 17.5 }),
        horseman(2, c.x0 + 0.55, { mode: 'boarding', goal: 'safe' }),
        horseman(3, pa.x1 - 5, { mode: 'pace', aimTicks: 20, tier: 2 }),
        horseman(4, c.x0 + 7, { mode: 'pace', tier: 3 }),
      ],
      (t, _b, h) => {
        h[0].x = pa.x0 + 2 + ((t * 2.5) % 6);
      },
    );
    settle(110);
    emit({ type: 'aim', by: 'horseman', id: 3 });
    settle(14);
    return 'Horsemen: approaching, boarding the express, aiming (glint), pacing';
  },
  bandits() {
    fresh();
    approachPoint(plain(), 0, 13, 90);
    const ex = carIndex('express');
    const pa = carIndex('passenger');
    riderAt(pa, 'roof', -3, { facing: 1, aim: 0.02, crouch: true });
    stage(
      [
        bandit(11, ex, 'roof', -2.5, { facing: -1, mode: 'fighting', aimTicks: 20 }),
        bandit(12, ex, 'platformRear', 0, { facing: -1, tier: 2 }),
        bandit(13, ex, 'inside', 0.7, { facing: -1, mode: 'cracking', goal: 'safe', tier: 3 }),
        bandit(14, pa, 'ladder', 0, { facing: 1 }),
      ],
      [],
      (t, b) => {
        b[3].y = CAR_SPECS.passenger.floorY + 0.2 + ((t * 1.2) % 2.4);
      },
    );
    addHold((st) => {
      st.loot.status = 'cracking';
      st.loot.crack = 0.45;
    });
    settle(80);
    emit({ type: 'aim', by: 'bandit', id: 11 });
    settle(12);
    return 'Bandits: on a roof aiming, on a platform, cracking the safe (through the door), on a ladder';
  },
  holdup() {
    fresh();
    approachPoint(plain(), 0, 6, 90, 0);
    riderAt(1, 'roof', -2, { facing: 1, aim: -0.2 });
    stage([bandit(21, 0, 'cab', 0, { mode: 'holdup', goal: 'cab', facing: 1, tier: 2 })], []);
    addHold((st) => {
      st.train.heldUp = true;
    });
    settle(80);
    return 'A bandit holds up the Engineer (hands up); HANDS UP on the strip';
  },
  safe() {
    fresh();
    approachPoint(plain(), 0, 12, 90);
    const ex = carIndex('express');
    riderAt(ex, 'inside', -3.2, { facing: 1, aim: 0.05 });
    stage([bandit(31, ex, 'inside', 0.9, { mode: 'cracking', goal: 'safe', facing: -1, boss: true, hp: 8 })], []);
    addHold((st) => {
      st.loot.status = 'cracking';
      st.loot.crack = 0.72;
    });
    settle(60);
    for (let i = 0; i < 3; i++) emit({ type: 'safeCracking', progress: 0.72 });
    settle(4);
    return 'Inside the express car (cut away): the boss cracking the safe';
  },
  walk() {
    fresh();
    approachPoint(plain(), 0, 12, 60);
    const pa = carIndex('passenger');
    riderAt(pa, 'roof', 0, { facing: 1, aim: 0.1 });
    const c = state.train.cars[pa];
    stage([], []);
    addHold((st, t) => {
      st.rider.x = (c.x0 + c.x1) / 2 - 3 + ((t * 3.4) % 6);
    });
    settle(47);
    return 'The Rider walking toward the loco, mid-stride, coat in the wind';
  },
  crouch() {
    fresh();
    approachPoint(plain(), 0, 18, 60);
    riderAt(carIndex('boxcar'), 'roof', 0, { facing: 1, crouch: true, aim: 0.35 });
    stage([], []);
    settle(60);
    return 'Crouching on the boxcar roof, aiming up';
  },
  ladder() {
    fresh();
    approachPoint(plain(), 0, 10, 60);
    const bx = carIndex('boxcar');
    riderAt(bx, 'ladder', 0, { facing: 1 });
    stage([], []);
    addHold((st, t) => {
      st.rider.y = CAR_SPECS.boxcar.floorY + 0.3 + ((t * 1.4) % 2.2);
    });
    settle(52);
    return 'Climbing a boxcar ladder';
  },
  jump() {
    fresh();
    approachPoint(plain(), 0, 16, 60);
    const pa = carIndex('passenger');
    const look = trainLook(state.train.cars).cars[pa];
    riderAt(pa, 'roof', 0, { facing: 1, aim: 0.6, onGround: false, surface: null, x: look.bx1 + 0.8, y: 5.3 });
    stage([], []);
    settle(60);
    return 'Jumping the roof gap between cars';
  },
  inside() {
    fresh();
    approachPoint(plain(), 0, 12, 60);
    const pa = carIndex('passenger');
    riderAt(pa, 'inside', 2, { facing: -1, aim: Math.PI - 0.05 });
    stage([bandit(41, pa, 'inside', -4.5, { facing: 1, mode: 'fighting', aimTicks: 20 })], []);
    settle(60);
    return 'Inside the passenger car (cut away), a bandit at the far end';
  },
  scope() {
    run = runFor(RUNS[0].id);
    const d = clearAlong(run, 600, 115, 380);
    fresh({ signals: [{ d: d + 254, facing: 'with', heads: 1, id: 'sg1' }] });
    approachPoint(alongMain(run, d), 0, 12, 60);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 260 });
    obstacle('cattle1', 'cattle', 272);
    aspectOverride = { sg1: 'stop' };
    stage([], []);
    settle(40);
    const fp = framePath(netIndex(run), state.switches, state.train.spans, 0, 800);
    const p1 = framePoint(fp, state.train.length + 263);
    if (p1) state.flags.push({ id: 1, point: p1, tick: state.tick - 60 });
    settle(20);
    return 'Spyglass at ~260 m: a signal at stop, cattle beyond, the flag on them';
  },
  signals() {
    // Two-head (junction) signals need a run with a junction to guard.
    const withJunction = RUNS.find((r) => r.junctions.length > 0) ?? RUNS[0];
    run = withJunction;
    const d = clearAlong(run, 600, 115, 140);
    fresh({
      run: withJunction.id,
      signals: [
        { d: d + 14, facing: 'with', heads: 1, id: 'a' },
        { d: d + 19.5, facing: 'with', heads: 1, id: 'b' },
        { d: d + 25, facing: 'with', heads: 1, id: 'c' },
        { d: d + 30.5, facing: 'with', heads: 2, id: 'd' },
        { d: d + 36, facing: 'with', heads: 2, id: 'e' },
        { d: d + 41.5, facing: 'against', heads: 1, id: 'f' },
      ],
    });
    approachPoint(alongMain(run, d), 0, 0, 1, 0);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.1 });
    aspectOverride = { a: 'stop', b: 'approach', c: 'clear', d: 'divergeApproach', e: 'divergeClear', f: 'clear' };
    // A gallery: the camera parked on the signals (in play the Rider reads them through the spyglass).
    cameraAt = (st) => st.train.length + 28;
    stage([], []);
    settle(40);
    settings.lampLetters = true;
    settle(2);
    return 'Signals, left to right: stop, approach, clear (1 head); diverge approach, diverge clear (2 heads); one facing away. Lamp letters on';
  },
  signalsNight() {
    SCENES.signals();
    run.night = true;
    settle(30);
    return 'The same signals at night: lamps only';
  },
  signalsScope() {
    const withJunction = RUNS.find((r) => r.junctions.length > 0) ?? RUNS[0];
    run = withJunction;
    const d = clearAlong(run, 600, 115, 300);
    fresh({ run: withJunction.id, signals: [{ d: d + 180, facing: 'with', heads: 2, id: 'j' }] });
    approachPoint(alongMain(run, d), 0, 10, 40, 0.4);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 186 });
    aspectOverride = { j: 'divergeApproach' };
    stage([], []);
    settle(40);
    return 'Reading a junction signal through the spyglass: diverging route, approach';
  },
  oncomingWide() {
    fresh();
    approachPoint(plain(0, 800), 0, 0, 1, 0);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.1 });
    aiOnOurTrack('freight7', 'freight', 30, 120, 8, true, 0);
    cameraAt = (st) => st.train.length + 42;
    stage([], []);
    settle(20);
    return 'An oncoming freight, stopped 30 m ahead (camera parked)';
  },
  tunnel() {
    fresh();
    const p = feature('tunnel');
    if (!p) return 'no tunnel on this run';
    approachPoint(p, -6, 12, 70, 0.7);
    riderAt(1, 'roof', 0.5, { facing: 1, aim: 0.1, crouch: true });
    stage([], []);
    settle(70);
    return 'The loco entering the tunnel: dark inside, headlamp';
  },
  tunnelInside() {
    fresh();
    const p = feature('tunnel');
    if (!p) return 'no tunnel on this run';
    approachPoint(p, -45, 10, 70, 0.7);
    riderAt(1, 'roof', -1, { facing: -1, aim: Math.PI - 0.1 });
    stage([bandit(51, carIndex('express'), 'platformFront', 0, { facing: 1, mode: 'fighting', aimTicks: 20 })], []);
    settle(70);
    return 'Inside the tunnel: the Rider on the tender top, a bandit on a platform';
  },
  lowbridge() {
    fresh();
    const p = feature('lowBridge');
    if (!p) return 'no low bridge on this run';
    const ex = carIndex('express');
    riderAt(ex, 'roof', 0, { facing: 1, crouch: true, aim: 0.2 });
    // The bridge 8 m ahead of the Rider when the frame is taken.
    const ahead = state.train.length - state.rider.x - 8;
    approachPoint(p, -ahead, 10, 60);
    stage([], []);
    settle(60);
    return 'A low bridge just ahead: the Rider crouches; its telltales hang before it';
  },
  trestle() {
    fresh();
    const p = feature('trestle');
    if (!p) return 'no trestle on this run';
    approachPoint(p, -48, 15, 60);
    riderAt(carIndex('passenger'), 'roof', 0, { facing: 1, aim: 0.1 });
    stage([], []);
    settle(60);
    return 'Crossing a trestle over a gorge';
  },
  burning() {
    fresh({ run: RUNS.find((r) => r.trestles.some((t) => t.burning))?.id });
    const p = feature('trestle');
    if (!p) return 'no trestle on this run';
    approachPoint(p, -14, 15, 70, 1);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.1 });
    stage([], []);
    settle(70);
    return 'Crossing the burning trestle at speed';
  },
  station() {
    fresh();
    const p = feature('station');
    if (!p) return 'no station on this run';
    placeFront(p);
    cruise(0, 0);
    riderAt(carIndex('express'), 'roof', 4, { facing: 1, aim: 0.05 });
    stage([], []);
    settle(60);
    return 'Stopped at the origin station';
  },
  water() {
    fresh({ run: RUNS.find((r) => r.waterTowers.length > 0)?.id });
    const p = feature('water');
    if (!p) return 'no water tower on this run';
    // The tender's hatch under the spout.
    const hatch = trainLook(state.train.cars).tenderHatchX;
    placeFront(before(run, p, -(state.train.length - hatch)));
    cruise(0, 0);
    riderAt(1, 'roof', -2.2, { facing: -1, aim: Math.PI - 0.2 });
    stage([], []);
    addHold((st) => {
      st.train.spout = 'down';
      st.train.spoutTower = run.waterTowers[0]?.id ?? null;
      st.train.water = Math.min(st.train.water, 60);
    });
    prompt = 'E: raise the spout';
    settle(60);
    return 'At the water tower, spout down and filling; a prompt by the Rider';
  },
  night() {
    fresh({ night: true, hour: 22 });
    approachPoint(plain(), 0, 15, 110, 0.8);
    const ex = carIndex('express');
    riderAt(carIndex('passenger'), 'roof', 3, { facing: -1, aim: Math.PI - 0.25 });
    const c = state.train.cars[ex];
    stage([bandit(61, ex, 'roof', -1, { facing: 1, mode: 'fighting', aimTicks: 20 })], [horseman(62, c.x1 - 3, { mode: 'pace', aimTicks: 20 }), horseman(63, c.x0 + 5, { mode: 'pace', tier: 2 })]);
    settle(100);
    emit({ type: 'aim', by: 'horseman', id: 62 });
    const m = state.rider;
    emit({ type: 'shot', by: 'rider', weapon: 'revolver', layer: 'train', x0: m.x, y0: m.y + 1.35, x1: c.x1 - 8, y1: 5.4, hit: 'bandit' });
    settle(2);
    return 'Night: lamps, lit windows, a muzzle flash lighting the scene';
  },
  nightLoco() {
    fresh({ night: true, hour: 22 });
    approachPoint(plain(), 0, 14, 90, 0.8);
    riderAt(1, 'roof', 1, { facing: 1, aim: 0.1 });
    stage([], []);
    settle(90);
    return 'Night at the loco: headlamp beam, firebox glow';
  },
  rocks() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 20 });
    obstacle('rocks1', 'rocks', 22);
    stage([], []);
    settle(30);
    return 'A rockslide on the line (spyglass)';
  },
  cattle() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 20 });
    obstacle('cattle1', 'cattle', 22);
    stage([], []);
    settle(45);
    return 'Cattle on the line (spyglass)';
  },
  cattleScatter() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 20 });
    obstacle('cattle1', 'cattle', 22, 'scattering', 90);
    stage([], []);
    addHold((st) => {
      const o = st.obstacles.find((x) => x.id === 'cattle1');
      if (o) {
        o.state = 'scattering';
        o.ticks = Math.min(239, o.ticks + 1);
      }
    });
    settle(40);
    return 'Cattle scattering after the whistle';
  },
  barricade() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 20 });
    obstacle('bar1', 'barricade', 22);
    stage([], []);
    settle(30);
    return 'A barricade on the line (spyglass)';
  },
  oncoming() {
    fresh();
    approachPoint(plain(0, 800), 0, 6, 40, 0.3);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 64 });
    aiOnOurTrack('freight7', 'freight', 60, 120, 8, true, 10);
    stage([], []);
    settle(40);
    return 'An oncoming freight on our track (spyglass)';
  },
  runaway() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 42 });
    aiOnOurTrack('runaway', 'runaway', 30, 44, 4, true, 12);
    stage([], []);
    settle(30);
    return 'The runaway rolling at us (spyglass)';
  },
  adjacent() {
    const withSiding = RUNS.find((r) => r.edges.some((e) => e.kind === 'siding' && e.mainAt));
    fresh({ run: withSiding?.id });
    const siding = run.edges.find((e) => e.kind === 'siding' && e.mainAt);
    const main = siding ? run.edges.find((e) => e.kind === 'main' && e.mainAt && siding.mainAt && e.mainAt[0] === siding.mainAt[0]) : undefined;
    if (!siding || !main) return 'no passing loop on this run';
    placeFront({ edge: main.id, off: Math.min(main.length - 10, 300), dir: 1 });
    cruise(0, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.1 });
    run.aiTrains.push({ id: 'ex9', name: 'Express 9', kind: 'express', cars: 4, length: 90, route: [], depart: 0, speed: 14, stops: [], charted: true });
    state.ai.push({ id: 'ex9', active: true, done: true, spans: [{ edge: siding.id, from: 150, to: 240 }], v: 14, started: true, wrecked: false });
    stage([], []);
    addHold((st) => {
      const a = st.ai.find((x) => x.id === 'ex9');
      if (a) a.spans = [{ edge: siding.id, from: a.spans[0].from + 14 * DT, to: a.spans[0].to + 14 * DT }];
    });
    settle(40);
    return 'An express passing on the loop beside us';
  },
  effects() {
    fresh();
    approachPoint(plain(), 0, 14, 80);
    const ex = carIndex('express');
    const pa = carIndex('passenger');
    riderAt(pa, 'roof', 4, { facing: -1, aim: Math.PI - 0.08 });
    const c = state.train.cars[ex];
    const b0 = bandit(71, ex, 'roof', 1, { facing: 1, mode: 'fighting', aimTicks: 20, hp: 2 });
    const h0 = horseman(72, c.x0 + 5, { mode: 'pace', aimTicks: 20 });
    stage([b0], [h0]);
    settle(80);
    const r = state.rider;
    emit({ type: 'aim', by: 'horseman', id: 72 });
    emit({ type: 'shot', by: 'rider', weapon: 'revolver', layer: 'train', x0: r.x, y0: r.y + 1.35, x1: b0.x + 0.1, y1: b0.y + 1.3, hit: 'bandit' });
    emit({ type: 'shot', by: 'bandit', weapon: 'revolver', layer: 'train', x0: b0.x, y0: b0.y + 1.35, x1: r.x + 3, y1: r.y + 2.4, hit: 'none' });
    emit({ type: 'shot', by: 'horseman', weapon: 'revolver', layer: 'trackside', x0: h0.x, y0: 2.3, x1: c.x0 + 8, y1: 2.6, hit: 'car' });
    emit({ type: 'explosion', x: c.x0 - 18, y: 0.5, what: 'runaway' });
    settle(3);
    return 'Tracers, muzzle flashes, hits, an aim glint and an explosion';
  },
  shotgun() {
    fresh();
    approachPoint(plain(), 0, 12, 60);
    const pa = carIndex('passenger');
    riderAt(pa, 'roof', -2, { facing: 1, aim: 0.05, weapon: 'shotgun' });
    stage([], []);
    settle(60);
    const r = state.rider;
    for (let i = 0; i < 6; i++) emit({ type: 'shot', by: 'rider', weapon: 'shotgun', layer: 'train', x0: r.x, y0: r.y + 1.35, x1: r.x + 16, y1: r.y + 1.35 + (i - 2.5) * 0.45, hit: 'none' });
    settle(2);
    return 'A shotgun blast';
  },
  hurt() {
    fresh();
    approachPoint(plain(), 0, 12, 60);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.2, hearts: 2, invulnTicks: 40 });
    stage([], []);
    settle(56);
    emit({ type: 'riderHurt', cause: 'bullet', hearts: 2 });
    settle(4);
    return 'Hurt: red flash, shake, two hearts left';
  },
  off() {
    fresh();
    approachPoint(plain(), 0, 14, 60);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.2 });
    stage([], []);
    settle(50);
    emit({ type: 'riderOff', cause: 'fall' });
    let left = 6 * TICK_HZ;
    addHold((st) => {
      st.rider.mode = 'off';
      st.rider.respawnTicks = Math.max(0, --left);
    });
    settle(30);
    return 'Off the train: tumbling, and the respawn countdown';
  },
  down() {
    fresh();
    approachPoint(plain(), 0, 14, 60);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, hearts: 0 });
    stage([], []);
    let left = 10 * TICK_HZ;
    addHold((st) => {
      st.rider.mode = 'down';
      st.rider.respawnTicks = Math.max(0, --left);
    });
    settle(40);
    return 'Down: the long countdown';
  },
  dawn() {
    fresh({ hour: 6.3 });
    approachPoint(plain(), 0, 12, 90);
    riderAt(carIndex('express'), 'roof', 1.5, { facing: 1, aim: 0.15 });
    stage([], []);
    settle(90);
    return 'Dawn';
  },
  dusk() {
    fresh({ hour: 18.45 });
    approachPoint(plain(), 0, 12, 90);
    riderAt(carIndex('express'), 'roof', 1.5, { facing: 1, aim: 0.15 });
    stage([], [horseman(81, state.train.cars[carIndex('express')].x0 + 4, { mode: 'pace', tier: 2 })]);
    settle(90);
    return 'Dusk';
  },
  powder() {
    fresh({ consist: ['powder', 'express', 'boxcar'] });
    approachPoint(plain(), 0, 14, 80);
    const pw = carIndex('powder');
    riderAt(carIndex('express'), 'roof', -2, { facing: 1, aim: 0.25 });
    const c = state.train.cars[pw];
    stage([], [horseman(91, (c.x0 + c.x1) / 2 + 2, { mode: 'pace', goal: 'powder', aimTicks: 20 }), horseman(92, c.x1 + 5, { mode: 'pace', goal: 'powder', tier: 3 })]);
    addHold((st) => {
      st.train.cars[pw].hp = 2;
    });
    settle(80);
    emit({ type: 'powderHit', hp: 2 });
    settle(4);
    return 'The powder car badly hurt (2 hp), smoking; horsemen shooting at it';
  },
  cars1() {
    fresh();
    approachPoint(plain(), 0, 10, 60);
    riderAt(carIndex('boxcar'), 'roof', -3, { facing: -1, aim: Math.PI - 0.1 });
    stage([], []);
    settle(60);
    return 'Passenger car and boxcar';
  },
  cars2() {
    fresh();
    approachPoint(plain(), 0, 10, 60);
    riderAt(carIndex('armored'), 'roof', -3, { facing: -1, aim: Math.PI - 0.1, crouch: true });
    stage([], []);
    settle(60);
    return 'Armored car (parapet) and caboose (cupola)';
  },
  curve() {
    run = runFor(RUNS[0].id);
    const c = feature('curve');
    if (!c) return 'no curve on this run';
    fresh({ mileposts: [{ at: before(run, c, 13), mile: 7 }] });
    const p = feature('curve') ?? c;
    placeFront(before(run, p, 4));
    cruise(0, 0);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.1 });
    cameraAt = (st) => st.train.length - 6;
    stage([], []);
    settle(30);
    return 'A speed board before a curve, and a milepost';
  },
  junction() {
    fresh({ run: RUNS.find((r) => r.junctions.length > 0)?.id });
    const j = run.junctions[0];
    const trunk = j ? run.edges.find((e) => e.id === j.trunk) : undefined;
    if (!j || !trunk) return 'no junction on this run';
    const dir = mainDirs(run).get(trunk.id) ?? 1;
    const off = trunk.b === j.node ? trunk.length : 0;
    placeFront(before(run, { edge: trunk.id, off, dir }, 2));
    cruise(0, 0);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.1 });
    cameraAt = (st) => st.train.length + 8;
    stage([], []);
    settle(30);
    return 'A junction: the switch stand and the other leg';
  },
  reload() {
    fresh();
    approachPoint(plain(), 0, 12, 60);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.2 });
    stage([], []);
    addHold((st) => {
      st.rider.ammo.revolver = 0;
      st.rider.reloadTicks = Math.round(WEAPONS.revolver.reload * TICK_HZ * 0.45);
    });
    settle(30);
    return 'Reloading the revolver';
  },
  // ---- Round 2: fords, the lurch, calm cattle, the lookout, signals read in passing ----
  ford() {
    // The front 2.5 m into the water at 12 m/s: fordEnter a quarter of a second ago.
    fordScene(-2.5, 70, 12, 75);
    riderAt(1, 'roof', -1, { facing: 1, aim: 0.05 });
    stage([], []);
    settle(60);
    emit({ type: 'fordEnter', id: 'ford1' });
    settle(15);
    return 'The loco ploughing into a ford at 12 m/s, seen from the tender top (the lookout)';
  },
  fordAhead() {
    fordScene(14, 60, 12, 60);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.05 });
    stage([], []);
    settle(60);
    return 'A ford coming up 14 m ahead of the loco, seen from the cab roof (the lookout)';
  },
  fordInside() {
    return fordInside();
  },
  fordDusk() {
    fordInside({ hour: 18.6 });
    return 'Inside a ford at dusk';
  },
  fordNight() {
    fordInside({ night: true, hour: 22 });
    return 'Inside a ford at night';
  },
  fordStill() {
    // Standing in the water: no bow waves, just the river running past the wheels.
    fordScene(-30, 70, 0, 1);
    riderAt(carIndex('express'), 'roof', 3, { facing: 1, aim: 0.1 });
    stage([], []);
    settle(60);
    return 'Stopped in a ford: the current and ripples, no spray';
  },
  washedWait() {
    // Off the train with the respawn due, but the rear platform is still in the water: held.
    fordScene(-100, 112, 5, 60);
    riderAt(carIndex('caboose'), 'platformRear', 0, { facing: 1, aim: 0 });
    stage([], []);
    addHold((st) => {
      st.rider.mode = 'off';
      st.rider.respawnTicks = 0;
    });
    settle(60);
    return 'Washed off, the respawn held: the rear platform is still in the ford';
  },
  washed() {
    fordScene(-47, 95, 10, 70);
    riderAt(carIndex('express'), 'platformRear', 0, { facing: 1, aim: 0 });
    stage([], []);
    settle(50);
    emit({ type: 'riderHurt', cause: 'water', hearts: 4 }, { type: 'riderOff', cause: 'water' });
    let left = 6 * TICK_HZ;
    addHold((st) => {
      st.rider.mode = 'off';
      st.rider.respawnTicks = Math.max(0, --left);
    });
    settle(20);
    return 'Washed off an express platform in a ford: into the water and carried away';
  },
  lurch() {
    fresh();
    approachPoint(plain(), 0, 15, 105);
    const ex = carIndex('express');
    const pa = carIndex('passenger');
    riderAt(pa, 'roof', 1, { facing: 1, aim: 0.15, crouch: true });
    const c = state.train.cars[ex];
    const p = state.train.cars[pa];
    const at = 90 / 60;
    stage(
      [bandit(131, ex, 'roof', -3, { facing: -1, mode: 'fighting', tier: 2 })],
      [horseman(132, c.x0 + 3, { mode: 'pace' }), horseman(133, c.x1 - 1, { mode: 'boarding', goal: 'safe', tier: 2 }), horseman(134, p.x0 + 5, { mode: 'approach', tier: 3 })],
      (t, b, h) => {
        const since = t - at;
        if (since < 0) return;
        // Thrown toward the loco (spec §5.2): a hop forward, then staggering while stunned.
        const hop = Math.min(since, 0.23);
        b[0].x += 4 * hop;
        b[0].y += Math.max(0, 2.5 * hop - 11 * hop * hop);
        b[0].onGround = since >= 0.23;
        b[0].stunTicks = since < 0.83 ? Math.round((0.83 - since) * TICK_HZ) : 0;
        // The horses shy at the squeal and drop back 8 m/s below the train.
        for (const hm of h) {
          const total = hm.tier === 3 ? 1.5 : 2.5;
          hm.shyTicks = Math.max(0, Math.round((total - since) * TICK_HZ));
          hm.x -= 8 * Math.min(since, total) * 0.35;
          hm.worldV = 15 - 8;
          if (hm.mode === 'boarding') hm.mode = 'pace';
        }
      },
    );
    addHold((st) => {
      st.train.brake = 1;
    });
    settle(90);
    emit({ type: 'lurch' }, { type: 'horseShy', id: 132 }, { type: 'horseShy', id: 133 }, { type: 'horseShy', id: 134 }, { type: 'thrown', who: 'bandit', id: 131 });
    settle(15);
    return 'The lurch: the brake slammed into emergency; horses shy and rear, a bandit thrown forward, the Rider braced';
  },
  cattleCalm() {
    fresh();
    approachPoint(plain(), 0, 0, 1, 0);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, scoped: true, scopeDist: 20 });
    obstacle('cattle1', 'cattle', 22);
    stage([], []);
    addHold((st) => {
      const o = st.obstacles.find((x) => x.id === 'cattle1');
      if (o) o.calmTicks = 300;
    });
    settle(45);
    return 'A herd that heard the whistle too soon: heads up, turned to the train (spyglass)';
  },
  cattleAhead() {
    fresh();
    approachPoint(plain(), 0, 3, 60, 0);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.05 });
    obstacle('cattle1', 'cattle', 21);
    stage([], []);
    addHold((st) => {
      const o = st.obstacles.find((x) => x.id === 'cattle1');
      if (o) o.calmTicks = 300;
    });
    settle(60);
    return 'A calm herd 18 m ahead, from the cab roof (the lookout)';
  },
  lookout() {
    const d = clearAlong(RUNS[0], 600, 115, 60);
    fresh({ signals: [{ d: d + 15, facing: 'with', heads: 1, id: 'sg1' }] });
    placeFront(alongMain(run, d));
    cruise(0, 0);
    riderAt(0, 'roof', 0.5, { facing: 1, aim: 0.05 });
    aspectOverride = { sg1: 'stop' };
    stage([], []);
    settle(60);
    return 'The lookout from the cab roof: waiting at a signal 15 m ahead, read without the spyglass';
  },
  lookoutTender() {
    const d = clearAlong(RUNS[0], 600, 115, 60);
    fresh({ signals: [{ d: d + 20, facing: 'with', heads: 1, id: 'sg1' }] });
    placeFront(alongMain(run, d));
    cruise(0, 0);
    riderAt(1, 'roof', 0, { facing: 1, aim: 0.05 });
    aspectOverride = { sg1: 'clear' };
    stage([], []);
    settle(60);
    return 'The lookout from the tender top: a signal 20 m ahead';
  },
  signalPass() {
    const d = clearAlong(RUNS[0], 600, 130, 60);
    fresh({ signals: [{ d: d - 21, facing: 'with', heads: 1, id: 'sp' }] });
    approachPoint(alongMain(run, d), 0, 20, 60, 1);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.1 });
    aspectOverride = { sp: 'approach' };
    stage([], []);
    settle(60);
    return 'A signal sweeping past at 20 m/s (45 mph), at approach: read as it passes';
  },
  signalPassNight() {
    const withJunction = RUNS.find((r) => r.junctions.length > 0) ?? RUNS[0];
    const d = clearAlong(withJunction, 600, 130, 60);
    fresh({ run: withJunction.id, night: true, hour: 22, signals: [{ d: d - 21, facing: 'with', heads: 2, id: 'sp' }] });
    approachPoint(alongMain(run, d), 0, 20, 60, 1);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1, aim: 0.1 });
    aspectOverride = { sp: 'divergeApproach' };
    stage([], []);
    settle(60);
    return 'A two-head signal sweeping past at night, diverging approach: lamps only';
  },
  // ---- Round 3: the scout alert (render/rider/scout.ts) ----
  scout() {
    scoutScene(90);
    return 'The scout alert: cattle standing 400 m (435 yd) ahead, beyond the view: the ! at the right edge';
  },
  scoutPop() {
    scoutScene(14);
    return 'The scout alert popping in, a quarter of a second after the herd came within reach';
  },
  scoutSeen() {
    scoutScene(160, (st, t) => {
      // A second's look at the herd through the spyglass, then the glass comes down.
      st.rider.scoped = t > 0.4 && t < 1.4;
      st.rider.scopeDist = 400 + 12 * (160 / 60 - t);
    });
    return 'The same herd after a second’s look through the spyglass: the ! has gone';
  },
  scoutNight() {
    scoutScene(90, undefined, { night: true, hour: 22 });
    return 'Night, with the headlamp (the spyglass reaches 490 yd): cattle 435 yd ahead, the ! at the right edge';
  },
  scoutLookout() {
    fresh();
    approachPoint(plain(), 0, 12, 90);
    riderAt(0, 'roof', 0, { facing: 1, aim: 0.05 });
    obstacle('herd1', 'cattle', 250 + 12 * (90 / 60));
    stage([], []);
    settle(90);
    return 'On the lookout (the cab roof), cattle 275 yd ahead: the ! at the right edge';
  },
  scoutBack() {
    fresh();
    placeFront(plain(0, 700));
    cruise(-4, 0);
    riderAt(carIndex('caboose'), 'roof', -1, { facing: -1, aim: Math.PI - 0.1 });
    aiOnOurTrack('runaway', 'runaway', 300, 44, 4, true, 8, true);
    stage([], []);
    settle(90);
    return 'Backing at 4 m/s (9 mph) with the runaway 330 yd behind: the ! at the left edge';
  },
  play() {
    const r = runFor(params.get('run'));
    fresh({ run: r.id, hour: r.startClock / 3600, night: r.night });
    state.godMode = false;
    state.waves = structuredClone(newGame(run, { seed: 7, consist: FULL, upgrades: [], assists: { rider: false, engineer: false } }).waves);
    approachPoint(plain(0, 300), 0, 12, 1);
    riderAt(carIndex('express'), 'roof', 0, { facing: 1 });
    hold = SIM_RIDER ? null : playTick;
    if (SIM_RIDER) {
      // The real bandits: the run's first wave, galloping up now.
      const wave = run.waves.find((w) => w.from === 'rear') ?? run.waves[0];
      if (wave) spawnWave(fightContext(state, run), { ...wave, count: Math.max(3, wave.count) }, pending);
    } else {
      const c = state.train.cars[carIndex('express')];
      state.bandits = [bandit(101, carIndex('boxcar'), 'roof', 1, { facing: 1, mode: 'fighting' })];
      state.horsemen = [horseman(102, c.x0 + 4, { mode: 'pace' }), horseman(103, c.x1 + 10, { mode: 'pace', tier: 2 })];
    }
    auto = false;
    return SIM_RIDER ? 'Play (the real Rider and bandit sim)' : 'Play (harness physics)';
  },
};

const ORDER = Object.keys(SCENES);

/** Sim events a staged scene keeps (the train's own); fights are staged, so theirs are dropped. */
const STAGED_KEEP = new Set<SimEvent['type']>(['whistle', 'overspeed', 'safetyValve', 'spout', 'waterFull', 'tunnelEnter', 'tunnelExit', 'trestleEnter', 'obstacleCleared', 'obstacleHit', 'explosion', 'collision', 'runawayWrecked']);

/** Advances `frames` frames at 60 fps: sim ticks, staged holds, and a draw each frame. */
function settle(frames: number): void {
  for (let i = 0; i < frames; i++) {
    nowMs += 1000 / 60;
    tick();
    draw(0, false);
  }
}

function tick(): void {
  if (sceneName === 'play') {
    engineerKeys();
    const input = SIM_RIDER ? keyboardInput() : NO_INPUT;
    pending.push(...step(state, run, input, cmds.splice(0)));
    hold?.(state, sceneTime);
    pressed.clear();
    mouseClicked = false;
    return;
  }
  const ev = step(state, run, NO_INPUT, cmds.splice(0));
  sceneTime += DT;
  hold?.(state, sceneTime);
  for (const e of ev) if (STAGED_KEEP.has(e.type)) pending.push(e);
}

function itemsFor(): TracksideItem[] | undefined {
  if (!aspectOverride) return undefined;
  // As far as the scout alert looks (the spyglass's reach the way the train runs), and the spyglass's view.
  const backing = state.train.v < -0.3;
  const items = trackside(state, run, backing ? SCOPE_MAX + 60 : 120, Math.max(200, state.rider.scopeDist + 120, backing ? 0 : SCOPE_MAX + 60));
  for (const it of items) if (it.kind === 'signal' && aspectOverride[it.id]) it.aspect = aspectOverride[it.id];
  return items;
}

function draw(alpha: number, frozen = !running): void {
  if (!renderer) return;
  const frame: RiderFrame = { state, run, alpha, now: nowMs, events: pending.splice(0), settings, prompt, frozen, items: itemsFor(), debug: debugLabels, cameraX: cameraAt?.(state) };
  const t0 = performance.now();
  renderer.draw(frame);
  drawMs.push(performance.now() - t0);
  if (drawMs.length > 240) drawMs.shift();
}

function scenario(name: string): string {
  const fn = SCENES[name];
  if (!fn) throw new Error(`unknown scene ${name}; try ${ORDER.join(', ')}`);
  sceneName = name;
  auto = name !== 'play';
  settings = { screenShake: true, lampLetters: false };
  const out = fn();
  markScene();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Play

const keys = new Set<string>();
const pressed = new Set<string>();
let mouseX = 0;
let mouseY = 0;
let mouseDown = false;
let mouseClicked = false;
let rightDown = false;

/** Does the sim's step() move the Rider itself (the fight modules integrated)? */
function probeSimRider(): boolean {
  try {
    const r = RUNS[0];
    const st = newGame(r, { seed: 1, consist: ['express'], upgrades: [], assists: { rider: false, engineer: false } });
    st.rider.onGround = false;
    st.rider.surface = null;
    st.rider.y += 1;
    st.rider.vy = 0;
    const y0 = st.rider.y;
    step(st, r, NO_INPUT, []);
    return st.rider.y < y0 - 1e-6;
  } catch {
    return false;
  }
}
const SIM_RIDER = probeSimRider();

function engineerKeys(): void {
  const t = state.train;
  if (keys.has('ArrowUp')) cmds.push({ seq: seq++, kind: 'throttle', value: Math.min(1, t.throttle + 0.01) });
  if (keys.has('ArrowDown')) cmds.push({ seq: seq++, kind: 'throttle', value: Math.max(0, t.throttle - 0.01) });
  if (keys.has('ArrowRight')) cmds.push({ seq: seq++, kind: 'brake', value: Math.min(1, t.brake + 0.01) });
  if (keys.has('ArrowLeft')) cmds.push({ seq: seq++, kind: 'brake', value: Math.max(0, t.brake - 0.01) });
  const whistle = keys.has('KeyH');
  if (whistle !== t.whistle) cmds.push({ seq: seq++, kind: 'whistle', on: whistle });
}

function aimFromMouse(r: RiderState): number {
  const target = renderer?.toTrainFrame(mouseX, mouseY) ?? { x: r.x + 1, y: r.y };
  return Math.atan2(target.y - (r.y + (r.crouch ? RIDER_SHOULDER_CROUCH : RIDER_SHOULDER)), target.x - r.x);
}

function keyboardInput(): RiderInput {
  const scope = keys.has('ShiftLeft') || keys.has('ShiftRight') || rightDown;
  let weapon: Weapon | 'next' | null = null;
  if (pressed.has('KeyQ')) weapon = 'next';
  if (pressed.has('Digit1')) weapon = 'revolver';
  if (pressed.has('Digit2')) weapon = 'shotgun';
  if (pressed.has('Digit3')) weapon = 'rifle';
  return {
    moveX: ((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)) as -1 | 0 | 1,
    up: keys.has('KeyW'),
    down: keys.has('KeyS'),
    downPressed: pressed.has('KeyS'),
    jump: keys.has('KeyW') || keys.has('Space'),
    jumpPressed: pressed.has('KeyW') || pressed.has('Space'),
    interactPressed: pressed.has('KeyE'),
    firing: mouseDown && !scope,
    firePressed: mouseClicked && !scope,
    reloadPressed: pressed.has('KeyR'),
    weaponPressed: weapon,
    aim: aimFromMouse(state.rider),
    scope,
    scopeT: Math.max(0, Math.min(1, mouseX / Math.max(1, canvas.clientWidth))),
    flagPressed: mouseClicked && scope,
  };
}

/** The harness's own Rider physics on the real geometry (used until step() drives the Rider). */
function playTick(st: GameState): void {
  const r = st.rider;
  const dt = DT;
  const geo = trainGeometry(st.train.cars);
  if (r.mode !== 'active') {
    if (--r.respawnTicks <= 0) {
      Object.assign(r, { mode: 'active', x: geo.respawn.x, y: geo.respawn.y, vx: 0, vy: 0, onGround: true, surface: 'platform', inside: null, ladder: null });
      if (r.hearts <= 0) r.hearts = r.maxHearts;
      pending.push({ type: 'riderBack' });
    }
    return;
  }
  const inp = keyboardInput();
  r.aim = inp.aim;
  r.scoped = inp.scope && r.onGround && r.inside === null;
  if (r.scoped) {
    r.scopeDist = SCOPE_MIN + (SCOPE_MAX - SCOPE_MIN) * inp.scopeT;
    if (inp.flagPressed) {
      const p = framePoint(framePath(netIndex(run), st.switches, st.train.spans, 0, r.scopeDist + 10), st.train.length + r.scopeDist);
      if (p) {
        // FLAG_MAX flags: a new one replaces the oldest (spec §6.5).
        const flag = { id: st.nextId++, point: p, tick: st.tick };
        st.flags.push(flag);
        while (st.flags.length > FLAG_MAX) st.flags.shift();
        pending.push({ type: 'flagPlaced', flag });
      }
    }
    return;
  }
  // Weapons.
  if (inp.weaponPressed && inp.weaponPressed !== 'next' && r.weapons.includes(inp.weaponPressed)) r.weapon = inp.weaponPressed;
  const spec = WEAPONS[r.weapon];
  if (r.cooldownTicks > 0) r.cooldownTicks--;
  if (r.reloadTicks > 0 && --r.reloadTicks === 0) r.ammo[r.weapon] = spec.rounds;
  if (inp.reloadPressed && r.ammo[r.weapon] < spec.rounds && r.reloadTicks === 0) r.reloadTicks = Math.round(spec.reload * TICK_HZ);
  if (inp.firePressed && r.cooldownTicks === 0 && r.reloadTicks === 0) {
    if (r.ammo[r.weapon] === 0) {
      pending.push({ type: 'dryFire' });
      r.reloadTicks = Math.round(spec.reload * TICK_HZ);
    } else {
      r.ammo[r.weapon]--;
      r.cooldownTicks = Math.round(spec.interval * TICK_HZ);
      fire(st, spec.pellets, spec.range, spec.spread);
    }
  }
  // Ladders: hang at the ladder's x, climb with W/S, step off at the top or bottom.
  if (r.ladder !== null) {
    const l = geo.ladders[r.ladder];
    r.vy = inp.up ? 2.8 : inp.down ? -2.8 : 0;
    r.y += r.vy * dt;
    if (r.y >= l.y1) Object.assign(r, { x: l.topX, y: l.y1, ladder: null, onGround: true, vy: 0, surface: geo.surfaces[l.top]?.kind ?? 'roof', inside: null });
    else if (r.y <= l.y0) Object.assign(r, { y: l.y0, ladder: null, onGround: true, vy: 0, surface: geo.surfaces[l.bottom]?.kind ?? 'platform', inside: l.kind === 'hatch' ? l.car : null });
    return;
  }
  if (r.onGround) {
    for (let li = 0; li < geo.ladders.length; li++) {
      const l = geo.ladders[li];
      if (inp.jumpPressed && Math.abs(r.x - l.x) < 0.45 && Math.abs(r.y - l.y0) < 0.05 && (l.kind !== 'hatch' || r.inside === l.car)) {
        Object.assign(r, { ladder: li, car: l.car, x: l.x, onGround: false, surface: null });
        return;
      }
      if (inp.downPressed && Math.abs(r.x - l.topX) < 0.45 && Math.abs(r.y - l.y1) < 0.05) {
        Object.assign(r, { ladder: li, car: l.car, x: l.x, y: l.y1 - 0.05, onGround: false, surface: null });
        return;
      }
    }
  }
  // Walking with the wind (spec §6.3), jumping, gravity, landing on the geometry's surfaces.
  const w = Math.min(1.4, (st.train.v / 25) ** 2);
  const exposed = r.inside === null && r.surface !== 'cabFloor';
  const top = r.crouch ? 2.0 : 4.5;
  const vmax = inp.moveX > 0 ? top * (1 - (exposed ? 0.35 * w : 0)) : inp.moveX < 0 ? top * (1 + (exposed ? 0.25 * w : 0)) : 0;
  r.crouch = inp.down && r.onGround;
  const want = inp.moveX * vmax;
  if (r.onGround) r.vx += Math.max(-35 * dt, Math.min(35 * dt, want - r.vx));
  else if (exposed) r.vx -= 2.4 * w * dt;
  if (inp.moveX !== 0) r.facing = inp.moveX > 0 ? 1 : -1;
  if (inp.jumpPressed && r.onGround && !r.crouch) {
    r.vy = 8.2;
    r.onGround = false;
    r.surface = null;
    pending.push({ type: 'jump' });
  }
  const prevY = r.y;
  if (!r.onGround) r.vy -= 22 * dt;
  const nx = r.x + r.vx * dt;
  let ny = r.y + (r.onGround ? 0 : r.vy * dt);
  const interior = geo.interiors.find((it) => it.car !== 0 && nx > it.x0 && nx < it.x1 && r.y >= it.floorY - 0.05 && r.y < it.ceilY);
  if (interior && ny + 1.8 > interior.ceilY) {
    ny = interior.ceilY - 1.8;
    r.vy = Math.min(0, r.vy);
  }
  if (r.onGround) {
    const under = geo.surfaces.find((sf) => nx >= sf.x0 - 0.3 && nx <= sf.x1 + 0.3 && Math.abs(sf.y - r.y) < 0.36);
    if (!under) {
      r.onGround = false;
      r.surface = null;
    } else {
      ny = under.y;
      r.surface = under.kind;
      r.car = under.car;
    }
  } else if (r.vy <= 0) {
    for (const sf of geo.surfaces) {
      if (nx >= sf.x0 - 0.3 && nx <= sf.x1 + 0.3 && prevY >= sf.y - 0.001 && ny <= sf.y) {
        ny = sf.y;
        r.vy = 0;
        r.onGround = true;
        r.surface = sf.kind;
        r.car = sf.car;
        pending.push({ type: 'land', hard: prevY - ny > 1.2 });
        break;
      }
    }
  }
  r.x = nx;
  r.y = ny;
  r.inside = r.surface === 'floor' ? r.car : r.onGround ? null : r.inside;
  if (r.y < 0.4 || r.x < -2 || r.x > st.train.length + 2) {
    pending.push({ type: 'riderOff', cause: 'fall' });
    r.hearts = Math.max(0, r.hearts - 1);
    r.mode = r.hearts <= 0 ? 'down' : 'off';
    r.respawnTicks = (r.mode === 'down' ? 10 : 6) * TICK_HZ;
    if (r.mode === 'down') pending.push({ type: 'riderDown' });
  }
  // The staged bandit and horsemen take potshots, so glints and tracers can be seen.
  const tt = st.tick % 240;
  if (tt === 60) pending.push({ type: 'aim', by: 'bandit', id: 101 });
  if (tt === 90) {
    const b = st.bandits.find((x) => x.id === 101);
    if (b) pending.push({ type: 'shot', by: 'bandit', weapon: 'revolver', layer: 'train', x0: b.x, y0: b.y + 1.35, x1: r.x + (Math.random() - 0.5) * 3, y1: r.y + 1 + Math.random() * 2, hit: 'none' });
  }
  if (tt === 150) pending.push({ type: 'aim', by: 'horseman', id: 102 });
  if (tt === 186) {
    const h = st.horsemen.find((x) => x.id === 102);
    if (h) pending.push({ type: 'shot', by: 'horseman', weapon: 'revolver', layer: 'trackside', x0: h.x, y0: 2.3, x1: r.x + (Math.random() - 0.5) * 3, y1: r.y + 1 + Math.random() * 2, hit: 'none' });
  }
  for (const b of st.bandits) b.aimTicks = tt >= 60 && tt < 90 ? 20 : 0;
  for (const h of st.horsemen) {
    h.aimTicks = h.id === 102 && tt >= 150 && tt < 186 ? 20 : 0;
    h.worldV = st.train.v + (h.id === 103 ? 0.4 * Math.sin(st.tick / 90) : 0);
    h.x += (h.worldV - st.train.v) * dt;
  }
}

function fire(st: GameState, pellets: number, range: number, spreadDeg: number): void {
  const r = st.rider;
  const sx = r.x;
  const sy = r.y + (r.crouch ? RIDER_SHOULDER_CROUCH : RIDER_SHOULDER);
  for (let p = 0; p < pellets; p++) {
    const a = r.aim + ((Math.random() * 2 - 1) * spreadDeg * Math.PI) / 180;
    let hit: 'none' | 'bandit' = 'none';
    let best = range;
    for (const b of st.bandits) {
      const bx = b.x - sx;
      const by = b.y + 1.1 - sy;
      const along = bx * Math.cos(a) + by * Math.sin(a);
      const off = Math.abs(-bx * Math.sin(a) + by * Math.cos(a));
      if (along > 0 && along < best && off < 0.45) {
        best = along;
        hit = 'bandit';
      }
    }
    if (Math.sin(a) < 0) best = Math.min(best, (sy + 0.3) / -Math.sin(a));
    pending.push({ type: 'shot', by: 'rider', weapon: r.weapon, layer: 'train', x0: sx, y0: sy, x1: sx + Math.cos(a) * best, y1: sy + Math.sin(a) * best, hit });
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
  if (e.repeat) return;
  switch (e.code) {
    case 'BracketLeft':
    case 'BracketRight': {
      const i = ORDER.indexOf(sceneName);
      scenario(ORDER[(i + (e.code === 'BracketRight' ? 1 : ORDER.length - 1)) % ORDER.length]);
      break;
    }
    case 'KeyP':
      running = !running;
      break;
    case 'Backquote':
      document.body.classList.toggle('nohud');
      break;
    case 'KeyM':
      settings = { ...settings, screenShake: !settings.screenShake };
      break;
    case 'KeyL':
      settings = { ...settings, lampLetters: !settings.lampLetters };
      break;
    case 'KeyG':
      debugLabels = !debugLabels;
      break;
    case 'KeyN':
      run.night = !run.night;
      break;
    default:
      break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;
});
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2) rightDown = true;
  else {
    mouseDown = true;
    mouseClicked = true;
  }
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) rightDown = false;
  else mouseDown = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------------------------------------
// Real-time loop and the panel

function frame(ms: number): void {
  const dt = lastMs ? Math.min(0.1, (ms - lastMs) / 1000) : 1 / 60;
  lastMs = ms;
  // Automation pauses the loop, so the canvas keeps the frame a scene settled on.
  if (running) {
    nowMs += dt * 1000;
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 8) {
      acc -= DT;
      n++;
      tick();
    }
    if (n === 8) acc = 0;
    draw(acc * TICK_HZ);
  } else if (!auto) {
    draw(0, true);
  }
  updatePanel();
  requestAnimationFrame(frame);
}

function markScene(): void {
  for (const b of Array.from(scenesEl.children)) b.classList.toggle('on', (b as HTMLElement).dataset.scene === sceneName);
}

function buildPanel(): void {
  for (const name of ORDER) {
    const b = document.createElement('button');
    b.textContent = name;
    b.dataset.scene = name;
    b.addEventListener('click', () => {
      scenario(name);
      canvas.focus();
    });
    scenesEl.appendChild(b);
  }
}

let panelTick = 0;
function updatePanel(): void {
  if (document.body.classList.contains('nohud') || ++panelTick % 10 !== 0) return;
  const avg = drawMs.reduce((a, b) => a + b, 0) / Math.max(1, drawMs.length);
  const r = state.rider;
  info.innerHTML =
    `<b>${sceneName}</b> · ${run.name}${run.night ? ' · night' : ''}${running ? '' : ' · paused'} · v ${state.train.v.toFixed(1)} m/s · odo ${state.train.odometer.toFixed(0)} m${sceneName === 'play' ? (SIM_RIDER ? ' · sim physics' : ' · harness physics') : ''}\n` +
    `rider ${r.mode} x ${r.x.toFixed(1)} y ${r.y.toFixed(2)} ${r.surface ?? 'air'}${r.inside !== null ? ` inside ${r.inside}` : ''}${r.scoped ? ` scoped ${r.scopeDist.toFixed(0)} m` : ''}\n` +
    `draw ${avg.toFixed(2)} ms avg · particles ${renderer?.particles ?? 0}\n` +
    `[ ] scene · P pause · \` panel · M shake ${settings.screenShake ? 'on' : 'off'} · L letters ${settings.lampLetters ? 'on' : 'off'} · G labels · N night`;
}

// ---------------------------------------------------------------------------------------------
// Automation

/** Draw time over `frames` frames of the current scene (the sim running), plus the raster flush. */
function timing(frames = 300): { avgMs: number; p95Ms: number; maxMs: number; flushAvgMs: number; flushP95Ms: number } {
  const times: number[] = [];
  const flush: number[] = [];
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < frames; i++) {
    nowMs += 1000 / 60;
    tick();
    const t0 = performance.now();
    draw(0.5, false);
    const t1 = performance.now();
    ctx?.getImageData(0, 0, 1, 1);
    const t2 = performance.now();
    times.push(t1 - t0);
    flush.push(t2 - t0);
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const fsorted = flush.slice().sort((a, b) => a - b);
  return {
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted[sorted.length - 1],
    flushAvgMs: flush.reduce((a, b) => a + b, 0) / flush.length,
    flushP95Ms: fsorted[Math.floor(fsorted.length * 0.95)],
  };
}

/**
 * Real-time frame pacing: runs the live loop (rAF, the sim stepping) for `frames` frames and reports
 * the achieved frame intervals and the draw time, so raster cost shows up as missed frames.
 */
function rafTiming(frames = 300): Promise<{ fps: number; avgIntervalMs: number; p95IntervalMs: number; worstIntervalMs: number; drawAvgMs: number }> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    const draws: number[] = [];
    let last = 0;
    let n = 0;
    running = true;
    auto = false;
    const step = (ms: number): void => {
      if (last) intervals.push(ms - last);
      last = ms;
      draws.push(drawMs[drawMs.length - 1] ?? 0);
      if (++n < frames) {
        requestAnimationFrame(step);
        return;
      }
      const sorted = intervals.slice().sort((a, b) => a - b);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      resolve({
        fps: 1000 / avg,
        avgIntervalMs: avg,
        p95IntervalMs: sorted[Math.floor(sorted.length * 0.95)],
        worstIntervalMs: sorted[sorted.length - 1],
        drawAvgMs: draws.reduce((a, b) => a + b, 0) / draws.length,
      });
    };
    requestAnimationFrame(step);
  });
}

const harness = {
  scenario,
  rafTiming,
  scenarios: (): string[] => ORDER.slice(),
  render(frames = 1): void {
    settle(frames);
  },
  timing,
  pause(): void {
    running = false;
  },
  resume(): void {
    running = true;
  },
  settings(s: Partial<typeof settings>): void {
    settings = { ...settings, ...s };
  },
  emit,
  state: (): GameState => state,
  run: (): RunDef => run,
  items: (ahead = 400): TracksideItem[] => trackside(state, run, 120, ahead),
  renderer: (): RiderRenderer | null => renderer,
  /** Dev profiling: skip these layers (see RiderRenderer.devSkip). */
  skip(layers: string[]): void {
    if (renderer) renderer.devSkip = new Set(layers);
  },
  simRider: SIM_RIDER,
};

declare global {
  interface Window {
    harness: typeof harness;
  }
}
window.harness = harness;

buildPanel();
scenario(params.get('scene') ?? 'day');
requestAnimationFrame(frame);
