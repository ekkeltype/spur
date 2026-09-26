// Shared types (spec §15). Everything reachable from GameState is plain JSON: no Maps, classes,
// NaN or Infinity (spec §0 note 2), so it can be sent, saved as a checkpoint and restored.
// Module-private types live in their modules; only what crosses a module boundary is here.

import type { RngState } from './rng';

/** Direction along an edge: +1 = a→b, −1 = b→a. */
export type Dir = 1 | -1;

// =============================================================================================
// The network (spec §4) — static, part of the RunDef
// =============================================================================================

export type NodeKind = 'link' | 'end' | 'junction';

export interface NetNode {
  id: string;
  kind: NodeKind;
  /** Schematic map position (arbitrary units; the desk fits the whole map to its panel). */
  x: number;
  y: number;
  label?: string;
}

export type EdgeKind = 'main' | 'branch' | 'siding' | 'spur';
export type Terrain = 'desert' | 'canyon' | 'hills' | 'river' | 'town' | 'mesa';

export interface NetEdge {
  id: string;
  a: string;
  b: string;
  /** Metres. */
  length: number;
  kind: EdgeKind;
  /** Track speed on this edge, m/s. */
  speedLimit: number;
  terrain: Terrain;
  /** Main-line distance (m) at a and at b, for the timetable chart (spec §4.4). */
  mainAt?: [number, number];
  /** Extra schematic points between a and b, for drawing. */
  via?: [number, number][];
  name?: string;
}

export type SwitchState = 'normal' | 'reverse';

export interface JunctionDef {
  /** The junction node's id; also the switch's id. */
  node: string;
  trunk: string;
  normal: string;
  reverse: string;
  initial: SwitchState;
  /** Shown on the map and in the Ahead list, e.g. "Dry Gulch Jct." */
  name: string;
}

/** A point on the network: `off` metres from the edge's `a` node. */
export interface TrackPoint {
  edge: string;
  off: number;
}

/** A point plus a heading along its edge. */
export interface TrackHead {
  edge: string;
  off: number;
  dir: Dir;
}

/**
 * A stretch of one edge that something occupies or traverses, walked from `from` to `to`
 * (`to < from` means it runs b→a there). Lists of spans are ordered rear → front.
 */
export interface Span {
  edge: string;
  from: number;
  to: number;
}

// ---- Features (spec §4.3) --------------------------------------------------------------------

export interface TunnelDef {
  id: string;
  edge: string;
  from: number;
  to: number;
  name: string;
}

export interface LowBridgeDef {
  id: string;
  edge: string;
  at: number;
  name?: string;
}

export interface TrestleDef {
  id: string;
  edge: string;
  from: number;
  to: number;
  name: string;
  /** A burning trestle collapses unless the loco enters it at ≥ minSpeed (m/s). */
  burning?: { minSpeed: number };
}

/**
 * A ford (spec §4.3): the river runs over the line here, FORD_WATER_Y deep. Anyone on the train
 * whose feet are below the water is washed off; horses wade.
 */
export interface FordDef {
  id: string;
  edge: string;
  from: number;
  to: number;
  name: string;
}

export interface StationDef {
  id: string;
  name: string;
  edge: string;
  /** The stop mark: the loco's front stops here (±STATION_WINDOW). */
  at: number;
  /** Platform length (m), centred on the stop mark; scenery. */
  platform: number;
  /** Departing after a completed stop saves a checkpoint. */
  checkpoint: boolean;
  /** A water column at the platform: a completed stop refills the tender. */
  waterColumn?: boolean;
}

export interface WaterTowerDef {
  id: string;
  edge: string;
  /** The spout's position. */
  at: number;
  name?: string;
}

export interface CurveDef {
  id: string;
  edge: string;
  from: number;
  to: number;
  /** m/s */
  limit: number;
}

export interface GradeDef {
  edge: string;
  from: number;
  to: number;
  /** Rise per metre in the a→b direction (0.015 = 1.5 % uphill toward b). */
  grade: number;
}

export interface MilepostDef {
  edge: string;
  at: number;
  mile: number;
}

export type SignalKind = 'block' | 'junction';

export interface SignalDef {
  id: string;
  edge: string;
  at: number;
  /** The direction of travel the signal governs. */
  facing: Dir;
  kind: SignalKind;
  /** Junction signals: the junction (node id) just beyond the signal. */
  junction?: string;
  name?: string;
}

export type Aspect = 'stop' | 'approach' | 'clear' | 'divergeApproach' | 'divergeClear';

export type ObstacleKind = 'rocks' | 'cattle' | 'barricade';

export interface ObstacleDef {
  id: string;
  kind: ObstacleKind;
  edge: string;
  at: number;
  /** Present only in these variants; undefined = always. */
  variants?: string[];
}

// ---- Bandit waves (spec §7.1) ----------------------------------------------------------------

export type BanditGoal = 'safe' | 'cab' | 'hunt' | 'powder';
export type Tier = 1 | 2 | 3;

export interface WaveDef {
  id: string;
  /** Fires when the loco's front passes this point moving forward. */
  trigger: TrackPoint;
  count: number;
  from: 'rear' | 'ahead';
  /** 'mixed' spreads the wave across safe / cab / hunt (and powder when there is a powder car). */
  goal: BanditGoal | 'mixed';
  tier: Tier;
  /** The wave's last horseman is the boss (8 HP). */
  boss?: boolean;
  variants?: string[];
}

// ---- Other trains (spec §10) -----------------------------------------------------------------

export type AiKind = 'freight' | 'express' | 'runaway';

export interface RouteLeg {
  edge: string;
  dir: Dir;
}

export interface AiTrainDef {
  id: string;
  /** "No. 7 Freight" */
  name: string;
  kind: AiKind;
  /** Number of cars, for drawing. */
  cars: number;
  /** Metres. */
  length: number;
  /** Scheduled trains: the whole route, from where the front enters to where the rear leaves. Empty for the runaway. */
  route: RouteLeg[];
  /** Clock (s since midnight) when the front is at the start of route[0]. */
  depart: number;
  /** Cruising speed, m/s. */
  speed: number;
  /** Waits: the front's route distance and the dwell in seconds. */
  stops: { at: number; dwell: number }[];
  /** Shown on the Engineer's timetable. The runaway never is. */
  charted: boolean;
  /** Runaway only: where it starts, which way it rolls, what sets it off, and the telegram that warns of it. */
  runaway?: { start: TrackPoint; dir: Dir; trigger: TrackPoint; telegram: string };
}

export interface TelegramDef {
  id: string;
  /** Sent when the loco passes `at` (moving forward), or at `clock`, whichever is given. */
  at?: TrackPoint;
  clock?: number;
  text: string;
}

// ---- Contracts and the run (spec §12, §13) ---------------------------------------------------

export type Cargo = 'mail' | 'payroll' | 'silver' | 'cash' | 'dynamite' | 'gold' | 'freight';

export interface ContractDef {
  cargo: Cargo;
  /** "Payroll for the Pale Rock mine" */
  title: string;
  pay: number;
  /** Station id. */
  destination: string;
  /** Clock (s since midnight). */
  deadline: number;
  latePenaltyPerMin: number;
  /** Losing the cargo fails the run. */
  critical: boolean;
}

export interface SideJobDef {
  id: string;
  title: string;
  pay: number;
  /** Station ids: pick up at `from`, deliver at `to`. */
  from: string;
  to: string;
  needs: CarType;
}

/**
 * A known-good drive (spec §13), followed by the autopilot (tests, dev tool). The autopilot owns the
 * interpretation; see src/sim/autopilot.ts.
 */
export interface RunPlan {
  /** Preferred cruising speed, m/s (always capped by limits and signals). */
  cruise: number;
  /** Switch settings, applied in order as the train comes within reach of each junction. */
  switches: { junction: string; state: SwitchState }[];
  /** Station and water tower ids to stop at, in order. */
  stops: string[];
  /** Stop the loco's front at `at` and wait there until `until` (clock), e.g. for a meet. */
  holds: { at: TrackPoint; until: number }[];
  /** Blow the whistle for a second when the loco's front passes these points. */
  whistles: TrackPoint[];
  /** Hold at least this speed from `from` onward (e.g. the run-up to a burning trestle). */
  minSpeeds: { from: TrackPoint; speed: number }[];
}

export type Act = 1 | 2 | 3;

export interface Briefing {
  /** "New this time" lines for each seat. */
  rider: string[];
  engineer: string[];
}

export interface RunDef {
  id: string;
  /** 0-based position in the campaign. */
  index: number;
  act: Act;
  name: string;
  flavor: string;
  briefing: Briefing;
  /** Clock at tick 0, s since midnight. */
  startClock: number;
  night: boolean;

  nodes: NetNode[];
  edges: NetEdge[];
  junctions: JunctionDef[];
  /** Edge ids from the origin to the destination: the timetable chart's axis. */
  mainLine: string[];

  tunnels: TunnelDef[];
  lowBridges: LowBridgeDef[];
  trestles: TrestleDef[];
  fords: FordDef[];
  stations: StationDef[];
  waterTowers: WaterTowerDef[];
  curves: CurveDef[];
  grades: GradeDef[];
  mileposts: MilepostDef[];
  signals: SignalDef[];

  /** Hidden from the Engineer. */
  obstacles: ObstacleDef[];
  /** Hidden from the Engineer. */
  waves: WaveDef[];
  /** Scheduled trains (charted) and the runaway (uncharted, hidden from the Engineer). */
  aiTrains: AiTrainDef[];
  telegrams: TelegramDef[];

  contract: ContractDef;
  sideJobs: SideJobDef[];

  /** Where the loco's front starts, and which way the train faces. */
  start: TrackHead;
  /** Station id the train starts at (stopped at its platform). */
  origin: string;
  /** Water in the tender at the start (0..100). */
  initialWater: number;
  /** Variant names (≥ 1); the seed picks one. Obstacles and waves may be limited to variants. */
  variants: string[];
  /** Always in the consist (e.g. 'express' for payroll, 'powder' for dynamite). */
  requiredCars: CarType[];
  /** Cars behind the tender, at most. */
  maxCars: number;
  /** Seconds, for display ("a good run"). */
  par: number;
  /** One plan per variant name. */
  plan: Record<string, RunPlan>;
}

/** What the Engineer's client is told about the run: no obstacles, waves, runaway, variants or plan. */
export type EngineerRun = Omit<RunDef, 'obstacles' | 'waves' | 'plan' | 'variants'>;

// =============================================================================================
// Cars, upgrades, assists (spec §5.1, §12)
// =============================================================================================

export type CarType = 'express' | 'passenger' | 'boxcar' | 'armored' | 'caboose' | 'powder';
export type CarKind = 'loco' | 'tender' | CarType;

export type UpgradeId =
  | 'shotgun'
  | 'rifle'
  | 'extraHeart'
  | 'quickReload'
  | 'airBrakes'
  | 'bigTender'
  | 'governor'
  | 'headlamp'
  | 'armored'
  | 'caboose';

export interface Assists {
  /** +2 hearts and aim assist. */
  rider: boolean;
  /** Automatic firebox and conflict advice on the chart. */
  engineer: boolean;
}

export type Weapon = 'revolver' | 'shotgun' | 'rifle';

// =============================================================================================
// Game state (spec §15)
// =============================================================================================

export type Phase = 'running' | 'won' | 'lost';

export type LossReason = 'collision' | 'derailed' | 'obstacle' | 'boiler' | 'lootStolen' | 'powder' | 'trestle' | 'buffers';

export interface CarState {
  kind: CarKind;
  /** Train-frame extent (spec §6.1): x0 < x1, the loco's front is at x1 of car 0. */
  x0: number;
  x1: number;
  /** Hit points (powder car); other cars keep their full value. */
  hp: number;
}

export interface TrainState {
  /** Front to back: loco, tender, then the consist. */
  cars: CarState[];
  /** Train length L: the loco's front is at x = L in the train frame. */
  length: number;
  /** Tonnes. */
  mass: number;
  /** The track the train occupies, rear → front. */
  spans: Span[];
  /** m/s along the train: + = toward the loco's front. */
  v: number;
  /** Signed distance travelled (m), for scrolling scenery. */
  odometer: number;

  throttle: number;
  brake: number;
  reverser: -1 | 0 | 1;
  /** Firebox 0..3. */
  fire: number;
  /** psi */
  pressure: number;
  water: number;
  waterCap: number;
  safetyValve: boolean;
  /** Ticks at 0 water with the fire lit. */
  dryTicks: number;

  whistle: boolean;
  /** Ticks the whistle has been held (0 when off). */
  whistleTicks: number;

  /** A bandit is in the cab: Engineer commands are refused. */
  heldUp: boolean;

  /** 0 = within limits, 1 = squealing, 2 = about to derail. */
  overspeed: 0 | 1 | 2;
  /** Ticks spent above the derail threshold. */
  overspeedTicks: number;

  spout: 'up' | 'down';
  /** The water tower the spout is lowered from. */
  spoutTower: string | null;

  /**
   * The tick of the last lurch (spec §5.2): the brake slammed into emergency at speed. The Rider and
   * bandit modules react on the tick it happens (lurchTick === state.tick). Far in the past at the start.
   */
  lurchTick: number;

  /** Standing at a station: ticks stopped and whether the stop completed. */
  stationStop: { stationId: string; ticks: number; done: boolean } | null;
  /** The last station whose stop completed. */
  lastStation: string | null;
  /** A completed checkpoint stop, waiting for the train to move off to be saved. */
  pendingCheckpoint: string | null;
}

export interface ObstacleState {
  id: string;
  kind: ObstacleKind;
  edge: string;
  at: number;
  /** 'scattering' = cattle leaving (gone after OBSTACLE_SCATTER_SECONDS); 'hit' = pushed or smashed through. */
  state: 'present' | 'scattering' | 'gone' | 'hit';
  ticks: number;
  /**
   * Cattle only (spec §8): ticks left during which the herd ignores the whistle, having got used to
   * it by hearing it from too far off. 0 = it will listen.
   */
  calmTicks: number;
}

export interface AiTrainState {
  id: string;
  /** On the map now. */
  active: boolean;
  /** Left the map for good (or, for the runaway, wrecked). */
  done: boolean;
  /** Occupied track, rear → front in its direction of travel. */
  spans: Span[];
  /** Current speed, m/s (for drawing and sound). */
  v: number;
  /** Runaway: set off and rolling. */
  started: boolean;
  /** Runaway: hit the buffers (or another obstacle) and was wrecked. */
  wrecked: boolean;
}

export interface SignalMemo {
  /**
   * A speed restriction in force until the loco passes the next signal. A diverging-clear one also
   * lifts once the train's odometer reaches `liftAt` (its rear past the junction, spec §9.3).
   */
  restriction: { signalId: string; limit: number; fined: boolean; liftAt?: number } | null;
  /** Signal id → tick the loco's front last crossed it (debounces repeated crossings). */
  passed: Record<string, number>;
}

export type RiderMode = 'active' | 'off' | 'down';

export type SurfaceKind = 'roof' | 'floor' | 'platform' | 'tenderTop' | 'tenderDeck' | 'cabFloor' | 'cabRoof' | 'cupola';

export interface RiderState {
  /** Train frame, metres; (x, y) is the feet's centre. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  /** What the Rider stands on, or null in the air or on a ladder. */
  surface: SurfaceKind | null;
  /** Car index under or around the Rider (nearest car), for the Engineer's "whereabouts". */
  car: number;
  /** Inside a car's interior (index), for the cutaway and cover; null otherwise. */
  inside: number | null;
  crouch: boolean;
  /** Index into the geometry's ladders while climbing, else null. */
  ladder: number | null;
  facing: Dir;
  /** Radians in the train frame: 0 = toward the loco (+x), π/2 = straight up. */
  aim: number;

  hearts: number;
  maxHearts: number;
  weapon: Weapon;
  weapons: Weapon[];
  ammo: Record<Weapon, number>;
  reloadTicks: number;
  cooldownTicks: number;
  invulnTicks: number;
  stunTicks: number;

  mode: RiderMode;
  respawnTicks: number;

  scoped: boolean;
  /** Spyglass look-ahead beyond the loco's front, metres. */
  scopeDist: number;
  /** Tick of the last time the Rider moved faster than 3 m/s (for bandit aim). */
  lastFastTick: number;
  /** Ticks spent inside the caboose toward the next healed heart. */
  healTicks: number;
}

export interface HorsemanState {
  id: number;
  /** Train frame x. */
  x: number;
  /** Speed along the track, m/s, same sign convention as the train's v. */
  worldV: number;
  hp: number;
  tier: Tier;
  boss: boolean;
  goal: BanditGoal;
  mode: 'waiting' | 'approach' | 'pace' | 'boarding' | 'retreat' | 'falling' | 'gone';
  modeTicks: number;
  /** Seconds of sprint left. */
  stamina: number;
  /** Train-frame x the horseman is heading for. */
  targetX: number;
  /** Counting down a shot's telegraph; 0 = not aiming. */
  aimTicks: number;
  cooldownTicks: number;
  /** Ticks spent unable to keep up. */
  behindTicks: number;
  /** A horse waiting for a looter to jump down to. */
  pickup: boolean;
  /** Ticks left shying from a lurch's brake squeal (spec §5.2): no boarding, no shooting, falling back. */
  shyTicks: number;
}

export interface BanditState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  surface: SurfaceKind | null;
  ladder: number | null;
  crouch: boolean;
  facing: Dir;
  hp: number;
  tier: Tier;
  boss: boolean;
  goal: BanditGoal;
  mode: 'moving' | 'cracking' | 'holdup' | 'fleeing' | 'fighting' | 'falling' | 'gone';
  modeTicks: number;
  hasLoot: boolean;
  aimTicks: number;
  cooldownTicks: number;
  stunTicks: number;
  /** Ticks until a burning trestle's flames can burn this bandit again (spec §4.3). */
  burnTicks: number;
  /** Navigation target (a node index in the train's nav graph), or null. */
  navTarget: number | null;
}

export interface LootState {
  status: 'safe' | 'cracking' | 'carried' | 'dropped' | 'stolen';
  /** Cracking progress 0..1 (kept when a cracker is interrupted). */
  crack: number;
  /** Where dropped loot lies (train frame). */
  x: number;
  y: number;
  /** Bandit id carrying it. */
  carrier: number | null;
  /** Was the safe ever cracked open this run (medal). */
  everCracked: boolean;
}

export interface WaveState {
  id: string;
  triggered: boolean;
  /** Spawns waiting for room under the caps. */
  queued: number;
}

export interface FlagState {
  id: number;
  point: TrackPoint;
  tick: number;
}

export interface SideJobState {
  id: string;
  state: 'pending' | 'aboard' | 'done';
}

export interface RunStats {
  shotsFired: number;
  hits: number;
  horsemenDowned: number;
  banditsDowned: number;
  heartsLost: number;
  timesOff: number;
  timesDown: number;
  redSignals: number;
  speedFines: number;
  /** Dollars. */
  fines: number;
  waterStops: number;
  holdups: number;
  /** m/s */
  maxSpeed: number;
  /** Damage to the powder car or other harm to cars (medal). */
  carDamage: number;
}

export interface GameState {
  runId: string;
  seed: number;
  variant: string;
  tick: number;
  rng: RngState;
  phase: Phase;
  loss: { reason: LossReason; detail: string } | null;
  /** Clock at tick 0 (s since midnight). clock = clock0 + tick / TICK_HZ. */
  clock0: number;
  /** Clock when the destination stop completed. */
  arrivedClock: number | null;

  upgrades: UpgradeId[];
  assists: Assists;

  train: TrainState;
  /** Junction node id → setting. */
  switches: Record<string, SwitchState>;
  obstacles: ObstacleState[];
  ai: AiTrainState[];
  signals: SignalMemo;

  rider: RiderState;
  horsemen: HorsemanState[];
  bandits: BanditState[];
  loot: LootState;
  waves: WaveState[];
  flags: FlagState[];
  telegramsSent: string[];
  sideJobs: SideJobState[];

  stats: RunStats;
  /** Next id for horsemen, bandits and flags. */
  nextId: number;
  /** Debug: the Rider can't be hurt and bandits don't shoot. */
  godMode: boolean;
}

// =============================================================================================
// Per-tick context passed between sim modules by game.ts
// =============================================================================================

/** What the train did this tick (returned by the train step; used by triggers). */
export interface TickMotion {
  /** Track the loco's front covered this tick while moving forward, in order (empty when reversing or stopped). */
  frontPath: Span[];
  /** Signed distance moved this tick (m). */
  moved: number;
}

/** A track hazard for the people on the train, in the train frame (lowBridge: x0 = x1). */
export interface FrameHazard {
  kind: 'tunnel' | 'lowBridge' | 'trestle' | 'ford';
  id: string;
  x0: number;
  x1: number;
  burning?: boolean;
}

// =============================================================================================
// Inputs and commands
// =============================================================================================

export interface RiderInput {
  /** −1 toward the rear (A), +1 toward the loco (D). */
  moveX: -1 | 0 | 1;
  /** W held (climb). */
  up: boolean;
  /** S held (crouch, climb down). */
  down: boolean;
  downPressed: boolean;
  /** W or Space held. */
  jump: boolean;
  jumpPressed: boolean;
  interactPressed: boolean;
  /** Mouse held. */
  firing: boolean;
  firePressed: boolean;
  reloadPressed: boolean;
  /** Q = 'next', 1–3 = a specific weapon. */
  weaponPressed: Weapon | 'next' | null;
  /** Radians in the train frame: 0 = toward the loco, π/2 = up. */
  aim: number;
  /** Spyglass held. */
  scope: boolean;
  /** 0..1: the pointer's horizontal position across the view while scoped. */
  scopeT: number;
  /** Left click while scoped: place a flag. */
  flagPressed: boolean;
}

export const NO_INPUT: RiderInput = {
  moveX: 0,
  up: false,
  down: false,
  downPressed: false,
  jump: false,
  jumpPressed: false,
  interactPressed: false,
  firing: false,
  firePressed: false,
  reloadPressed: false,
  weaponPressed: null,
  aim: 0,
  scope: false,
  scopeT: 0.5,
  flagPressed: false,
};

export type EngineerCmdBody =
  | { kind: 'throttle'; value: number }
  | { kind: 'brake'; value: number }
  | { kind: 'reverser'; value: -1 | 0 | 1 }
  | { kind: 'fire'; value: number }
  | { kind: 'whistle'; on: boolean }
  | { kind: 'switch'; junction: string; state: SwitchState };

export type EngineerCmd = { seq: number } & EngineerCmdBody;

/** Dev-only commands (debug keys). */
export type DebugCmd =
  | { kind: 'god'; on: boolean }
  | { kind: 'killBandits' }
  | { kind: 'skip'; meters: number }
  | { kind: 'water' };

// =============================================================================================
// Events (spec §15, §16.3)
// =============================================================================================

export type ShotLayer = 'train' | 'trackside';
export type HurtCause = 'bullet' | 'bridge' | 'tunnel' | 'water' | 'fall' | 'explosion' | 'lurch' | 'fire';

export type SimEvent =
  // Engineer commands
  | { type: 'cmdResult'; seq: number; ok: boolean; reason?: string }
  // Train
  | { type: 'switchThrown'; junction: string; state: SwitchState; by: 'engineer' | 'trailing' }
  | { type: 'whistle'; on: boolean }
  | { type: 'overspeed'; level: 1 | 2 }
  | { type: 'safetyValve'; on: boolean }
  | { type: 'lowWater' }
  | { type: 'stationArrived'; stationId: string }
  | { type: 'stationDone'; stationId: string }
  | { type: 'checkpoint'; stationId: string }
  | { type: 'spout'; down: boolean }
  | { type: 'waterFull' }
  | { type: 'tunnelEnter'; id: string }
  | { type: 'tunnelExit'; id: string }
  /** The loco's front enters or leaves a ford (either way, like tunnels). */
  | { type: 'fordEnter'; id: string }
  | { type: 'fordExit'; id: string }
  | { type: 'trestleEnter'; id: string; burning: boolean }
  /** The brake slammed into emergency at speed (spec §5.2): horses shy, standing figures are thrown. */
  | { type: 'lurch' }
  | { type: 'signalPassed'; id: string; aspect: Aspect }
  /** redSignal: passed a stop; speeding: over 20 mph after a caution; junction: over 30 mph through a diverging junction. */
  | { type: 'fine'; reason: 'redSignal' | 'speeding' | 'junction'; amount: number }
  /** A herd heard the whistle from too far off and got used to it (spec §8). */
  | { type: 'cattleCalm'; id: string }
  /** A herd starts to leave the line. */
  | { type: 'cattleScatter'; id: string }
  | { type: 'obstacleCleared'; id: string; kind: ObstacleKind }
  | { type: 'obstacleHit'; id: string; kind: ObstacleKind; severe: boolean }
  | { type: 'telegram'; id: string; text: string }
  | { type: 'aiEntered'; id: string }
  | { type: 'aiLeft'; id: string }
  | { type: 'runawayLoose'; id: string }
  | { type: 'runawayWrecked'; id: string }
  | { type: 'sideJob'; id: string; state: 'aboard' | 'done' }
  // Rider and fighting
  /** `id`: the bandit or horseman who fired (absent for the Rider's shots). */
  | { type: 'shot'; by: 'rider' | 'bandit' | 'horseman'; id?: number; weapon: Weapon; layer: ShotLayer; x0: number; y0: number; x1: number; y1: number; hit: 'rider' | 'bandit' | 'horseman' | 'car' | 'none' }
  | { type: 'aim'; by: 'bandit' | 'horseman'; id: number }
  | { type: 'reload'; weapon: Weapon }
  | { type: 'dryFire' }
  | { type: 'jump' }
  | { type: 'land'; hard: boolean }
  | { type: 'riderHurt'; cause: HurtCause; hearts: number }
  | { type: 'riderOff'; cause: 'tunnel' | 'water' | 'fall' }
  /** Thrown forward by a lurch (spec §5.2): the Rider, or a bandit by id. */
  | { type: 'thrown'; who: 'rider' | 'bandit'; id?: number }
  | { type: 'riderDown' }
  | { type: 'riderBack' }
  | { type: 'flagPlaced'; flag: FlagState }
  | { type: 'waveSpawned'; id: string; count: number; from: 'rear' | 'ahead' }
  | { type: 'horsemanDown'; id: number; x: number; boss: boolean }
  | { type: 'banditBoarded'; id: number; x: number; y: number; into: 'platform' | 'cab' }
  | { type: 'banditDown'; id: number; x: number; y: number; boss: boolean }
  | { type: 'banditKnockedOff'; id: number; cause: 'tunnel' | 'bridge' | 'water' | 'fire' }
  /** A horseman's horse shies at a lurch's squeal (spec §5.2). */
  | { type: 'horseShy'; id: number }
  | { type: 'heldUp' }
  | { type: 'holdupEnded' }
  | { type: 'safeCracking'; progress: number }
  | { type: 'lootTaken' }
  | { type: 'lootDropped'; x: number; y: number }
  | { type: 'lootRecovered' }
  | { type: 'lootStolen' }
  | { type: 'powderHit'; hp: number }
  // Outcome
  | { type: 'collision'; with: string }
  | { type: 'explosion'; x: number; y: number; what: 'boiler' | 'powder' | 'runaway' | 'collision' }
  | { type: 'won' }
  | { type: 'lost'; reason: LossReason; detail: string };

/** The subset of events the Engineer's client receives (spec §16.3). */
export type EngineerEvent =
  | Extract<
      SimEvent,
      {
        type:
          | 'switchThrown'
          | 'whistle'
          | 'overspeed'
          | 'safetyValve'
          | 'lowWater'
          | 'stationArrived'
          | 'stationDone'
          | 'checkpoint'
          | 'spout'
          | 'waterFull'
          | 'tunnelEnter'
          | 'tunnelExit'
          | 'fordEnter'
          | 'fordExit'
          | 'fine'
          | 'telegram'
          | 'sideJob'
          | 'flagPlaced'
          | 'heldUp'
          | 'holdupEnded'
          | 'riderOff'
          | 'riderDown'
          | 'riderBack'
          | 'lootStolen'
          | 'lootRecovered'
          | 'collision'
          | 'won'
          | 'lost';
      }
    >
  /** A signal was passed; the Engineer never learns its aspect. */
  | { type: 'signalPassed'; id: string }
  /** Muffled gunfire from outside: loudness 0..1 only, rate-limited by the host. */
  | { type: 'gunfire'; intensity: number };

// =============================================================================================
// Views (spec §16.3) and the Rider's trackside scan (spec §15)
// =============================================================================================

export interface EngineerView {
  tick: number;
  /** s since midnight */
  clock: number;
  phase: Phase;
  loss: GameState['loss'];
  train: {
    spans: Span[];
    length: number;
    v: number;
    throttle: number;
    brake: number;
    reverser: -1 | 0 | 1;
    fire: number;
    pressure: number;
    water: number;
    waterCap: number;
    whistle: boolean;
    heldUp: boolean;
    overspeed: 0 | 1 | 2;
    safetyValve: boolean;
    spout: 'up' | 'down';
    stationStop: { stationId: string; progress: number } | null;
    /** The last station whose stop was completed (the origin at the start). */
    lastStation: string | null;
    /** Main-line distance of the loco's front, if it can be projected. */
    mainPos: number | null;
    /** The tender's water hatch, for the spout-distance readout. */
    hatch: TrackPoint;
    /** The current speed limit at the loco (track, curve or signal restriction), m/s. */
    limit: number;
  };
  switches: Record<string, SwitchState>;
  /** Charted trains within sight (spec §10.1). */
  trains: { id: string; spans: Span[]; mainPos: number | null }[];
  flags: FlagState[];
  rider: { car: number; roof: boolean; mode: RiderMode };
  /** Dollars fined so far this run. */
  fines: number;
  cargo: 'ok' | 'stolen';
  /** Side jobs (all public). */
  sideJobs: SideJobState[];
}

export type TracksideItem =
  | { kind: 'terrain'; x0: number; x1: number; terrain: Terrain; edge: string; edgeKind: EdgeKind }
  | { kind: 'tunnel'; id: string; x0: number; x1: number; name: string }
  | { kind: 'lowBridge'; id: string; x: number }
  | { kind: 'trestle'; id: string; x0: number; x1: number; name: string; burning: boolean }
  /** The river over the line (spec §4.3): water FORD_WATER_Y deep between x0 and x1. */
  | { kind: 'ford'; id: string; x0: number; x1: number; name: string }
  | { kind: 'station'; id: string; x: number; platform: number; name: string }
  | { kind: 'water'; id: string; x: number; spoutDown: boolean }
  /** facing: 'toward' = it governs the train's direction of travel (the Rider sees its face). */
  | { kind: 'signal'; id: string; x: number; facing: 'toward' | 'away'; heads: 1 | 2; aspect: Aspect }
  | { kind: 'milepost'; x: number; mile: number }
  | { kind: 'curve'; id: string; x0: number; x1: number; limit: number }
  | { kind: 'junction'; id: string; x: number; state: SwitchState; name: string }
  /** `calm`: cattle that got used to the whistle, heads up and ignoring it (spec §8). */
  | { kind: 'obstacle'; id: string; x: number; obstacle: ObstacleKind; state: ObstacleState['state']; calm: boolean }
  /** lane 'same' = on the train's own track (ahead or behind); 'adjacent' = a parallel track (sidings, loops). */
  | { kind: 'train'; id: string; x0: number; x1: number; lane: 'same' | 'adjacent'; ai: AiKind; v: number; cars: number };

// =============================================================================================
// Campaign, saves, results (spec §12, §17)
// =============================================================================================

export type Medal = 'onTime' | 'clean' | 'untouched';

export interface CompletedEntry {
  runId: string;
  bestTimeSec: number;
  medals: Medal[];
  /** Times won. */
  times: number;
}

export interface CampaignProgress {
  /** Runs 0..unlocked−1 can be played. */
  unlocked: number;
  money: number;
  owned: UpgradeId[];
  completed: CompletedEntry[];
  assists: Assists;
  /** The optional cars last chosen, front to back (required cars are added per run). */
  consist: CarType[];
}

export interface Checkpoint {
  runId: string;
  seed: number;
  stationId: string;
  stationName: string;
  consist: CarType[];
  upgrades: UpgradeId[];
  state: GameState;
}

export interface Settings {
  masterVolume: number;
  effectsVolume: number;
  screenShake: boolean;
  hints: 'first' | 'always' | 'never';
  /** Letters on signal lamps (R, Y, G) for colour-blind players. */
  lampLetters: boolean;
}

export interface RunResult {
  runId: string;
  outcome: 'won' | 'lost';
  reason: LossReason | null;
  detail: string;
  timeSec: number;
  arrivedClock: number | null;
  deadline: number;
  pay: number;
  latePenalty: number;
  /** The optional cargo cars' own pay (spec §12, CARGO_PAY). */
  cargoPay: number;
  sideJobPay: number;
  fines: number;
  /** pay − latePenalty (≥ 0) + cargoPay + sideJobPay − fines, before any replay discount. */
  total: number;
  medals: Medal[];
  stats: RunStats;
}
