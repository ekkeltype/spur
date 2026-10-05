// Every tunable (spec §14). Numbers are the spec's starting values; tune them here, nowhere else.

import type { CarKind, CarType, UpgradeId, Weapon } from './types';

// ---- Simulation ---------------------------------------------------------------------------------

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
/**
 * Seconds of the world per second of the wall clock (spec §16.1): the host runs TICK_HZ × TIME_SCALE
 * ticks a real second. The sim never sees it; what shows the players a duration (an ETA, a respawn
 * count) or a rate (the engine's beats) converts at the edge.
 */
export const TIME_SCALE = 1.25;
/** EngineerView snapshots per real second. */
export const SNAPSHOT_HZ = 15;
export const COUNTDOWN_SECONDS = 3;
/** Real seconds of the opening shot before the countdown, when a run leaves its origin (spec §3). */
export const INTRO_SECONDS = 6.5;

/** mph per m/s. */
export const MPH = 2.23694;
/** Metres per mile. */
export const MILE = 1609.34;
/** Metres per yard. Players read speeds in mph and distances in yards and miles (spec §0 note 6). */
export const YARD = 0.9144;

export const secondsToTicks = (s: number): number => Math.round(s * TICK_HZ);

// ---- The consist (spec §5.1) ---------------------------------------------------------------------

export interface CarSpec {
  length: number;
  /** Tonnes. */
  mass: number;
  /** Interior floor height (m above rail); the cab floor for the loco, the deck for the tender. */
  floorY: number;
  /** Roof (walkable top) height; the cab roof for the loco, the coal top for the tender. */
  roofY: number;
  /** Starting hit points (only the powder car's matter). */
  hp: number;
}

export const CAR_SPECS: Record<CarKind, CarSpec> = {
  loco: { length: 16, mass: 70, floorY: 1.4, roofY: 4.0, hp: 1 },
  tender: { length: 9, mass: 20, floorY: 1.4, roofY: 2.8, hp: 1 },
  express: { length: 15, mass: 25, floorY: 1.2, roofY: 4.2, hp: 1 },
  passenger: { length: 17, mass: 28, floorY: 1.2, roofY: 4.2, hp: 1 },
  boxcar: { length: 13, mass: 24, floorY: 1.3, roofY: 4.0, hp: 1 },
  armored: { length: 13, mass: 42, floorY: 1.3, roofY: 3.9, hp: 1 },
  caboose: { length: 10, mass: 14, floorY: 1.2, roofY: 4.0, hp: 1 },
  powder: { length: 12, mass: 30, floorY: 1.3, roofY: 3.9, hp: 12 },
};

/** The loco's cab: its rear this many metres. */
export const CAB_LENGTH = 4.5;
/** Caboose cupola: raised roof over the middle third. */
export const CUPOLA_Y = 4.7;
/** End platform depth inside each car (not loco/tender), and the bridge plate between cars. */
export const PLATFORM_DEPTH = 0.5;
export const COUPLER_GAP = 0.6;
/** The tender's water hatch: this far from the tender's rear. */
export const TENDER_HATCH_FROM_REAR = 2;
/** The tender's front deck (joins the cab) is this long, at floorY. */
export const TENDER_DECK = 1;

export const DEFAULT_MAX_CARS = 5;

// ---- Train motion (spec §5.3, §5.4) --------------------------------------------------------------

export const TRACTIVE_MAX = 60; // kN, stock
export const FULL_POWER_PSI = 160;
export const ROLL = 0.02; // m/s²
export const DRAG = 0.0007; // per (m/s)², stock

/** The loco's tractive effort at full throttle and pressure (kN), with its power tiers (spec §12). */
export function tractiveMax(upgrades: readonly UpgradeId[]): number {
  return TRACTIVE_MAX * tierFactor(POWER_TIERS, upgrades);
}

/** The train's drag coefficient (per (m/s)²), with the loco's speed tiers (spec §12). */
export function dragCoef(upgrades: readonly UpgradeId[]): number {
  return DRAG * tierFactor(SPEED_TIERS, upgrades);
}
export const GRAVITY = 9.81;
export const BRAKE_MAX = 1.1; // m/s² at brake = 1
export const AIR_BRAKES_FACTOR = 1.35;
/** Brake lever above this is the emergency application (sparks, louder squeal). */
export const EMERGENCY_BRAKE = 0.85;

// ---- The lurch: slamming the brakes (spec §5.2) ------------------------------------------------------

/** The brake going into emergency lurches the train only at this speed or more (m/s, 18 mph)… */
export const LURCH_MIN_SPEED = 8;
/** …and at most once in this many seconds. */
export const LURCH_COOLDOWN_SECONDS = 8;
/** Anyone standing outside is thrown toward the loco: a hop this fast forward (m/s)… */
export const LURCH_HOP_VX = 4;
/** …and up (m/s)… */
export const LURCH_HOP_VY = 2.5;
/** …then staggered this long: no control, no shooting. Crouching, ladders and interiors brace you. */
export const LURCH_STAGGER_SECONDS = 0.6;
/** …or this long for a bandit, who isn't expecting it (the slam is the crew's trick). */
export const LURCH_BANDIT_STAGGER_SECONDS = 1.8;
/** Horsemen alongside, within this far of either end of the train, shy at the squeal… */
export const HORSE_SHY_RANGE = 40;
/** …for this long (s): no boarding, no aim, no shots… */
export const HORSE_SHY_SECONDS = 2.5;
/** …or this long for tier 3 and the boss… */
export const HORSE_SHY_SECONDS_VETERAN = 1.5;
/** …while the horse drops to this much below the train's speed (m/s), falling back. */
export const HORSE_SHY_REL = 8;
/** The reverser can only be moved below this speed. */
export const REVERSER_MAX_SPEED = 0.5;
/** Below this speed with no net force the train is stopped. */
export const STOP_EPSILON = 0.05;
/** Reaching an end node faster than this is a loss (buffers). */
export const BUFFER_SAFE = 1.5;

export const OVERSPEED_WARN = 1.15;
export const DERAIL_FACTOR = 1.4;
export const DERAIL_SECONDS = 1.5;
export const DERAIL_INSTANT = 1.7;

/** Switches can't be thrown while a train occupies any junction edge within this distance of the node. */
export const SWITCH_FOUL_DISTANCE = 20;

// ---- Boiler and water (spec §5.5) ------------------------------------------------------------------

export const P_MAX = 200;
export const P_START = 180;
export const STEAM_PER_FIRE = 7; // psi/s per firebox notch
export const STEAM_BASE = 3; // psi/s at full throttle, standing
export const STEAM_PER_MS = 0.5; // extra psi/s per m/s at full throttle
export const HEAT_LOSS = 0.5; // psi/s
export const WATER_PER_PSI = 0.02;
export const WATER_CAP = 100;
export const BIG_TENDER_CAP = 140;
export const LOW_WATER = 20;
export const DRY_EXPLODE_SECONDS = 6;
export const GOVERNOR_TARGET_PSI = 175;
export const FIRE_MAX = 3;

/** Blowing the whistle draws this much steam (psi/s), so leaning on it costs pressure (spec §5.2). */
export const WHISTLE_STEAM = 3;

export const WATER_FILL_RATE = 12; // per second
export const SPOUT_WINDOW = 3; // ± m between the tender hatch and the spout
export const SPOUT_REACH = 1.5; // ± m between the Rider and the hatch
export const SPOUT_MAX_SPEED = 0.1;

// ---- Stations (spec §5.6) ------------------------------------------------------------------------

export const STATION_WINDOW = 15; // ± m around the stop mark
export const STATION_STOP_SPEED = 0.3;
export const DWELL_SECONDS = 8;

// ---- Obstacles (spec §8) -------------------------------------------------------------------------

export const OBSTACLE_SAFE: Record<'rocks' | 'cattle' | 'barricade', number> = {
  rocks: 1.5,
  cattle: 10,
  barricade: 7,
};
/**
 * Cattle and the whistle (spec §8): a blast of WHISTLE_SCARE_SECONDS with the loco between these
 * distances short of the herd scatters it (70–270 yards)…
 */
export const WHISTLE_SCARE_MIN = 70 * YARD;
export const WHISTLE_SCARE_MAX = 270 * YARD;
export const WHISTLE_SCARE_SECONDS = 0.5;
/** …but a herd hears it from this far (m), and one that hears it from beyond the window gets used to it… */
export const WHISTLE_EARSHOT = 700;
/** …ignoring the whistle until this long after the last sound of it (s). */
export const CATTLE_CALM_SECONDS = 8;
export const OBSTACLE_SCATTER_SECONDS = 4;

// ---- Signals (spec §9) ---------------------------------------------------------------------------

export const BLOCK_MAX = 2500;
export const APPROACH_LIMIT = 9; // m/s (20 mph)
export const DIVERGE_LIMIT = 13.4; // m/s (30 mph) through the junction on divergeClear
export const SPEED_FINE_TOLERANCE = 1.1;
export const RED_SIGNAL_FINE = 50;
export const SPEED_FINE = 10;

// ---- Round 2: the train, cattle, signals and the autopilot (train.ts, signals.ts, autopilot.ts) ----

// ---- Other trains (spec §10) ---------------------------------------------------------------------

/** Charted trains show on the Engineer's map within this track distance of the player's train. */
export const SIGHT_RANGE = 1500;
export const RUNAWAY_MAX = 14;
export const RUNAWAY_ACCEL = 0.4;

// ---- The Rider (spec §6) -------------------------------------------------------------------------

export const RIDER_WALK = 4.5;
export const RIDER_CROUCH_WALK = 2.0;
export const RIDER_ACCEL = 35;
export const RIDER_JUMP_V = 8.2;
export const RIDER_GRAVITY = 22;
export const LADDER_SPEED = 2.8;
export const RIDER_HEIGHT = 1.8;
export const RIDER_CROUCH_HEIGHT = 1.0;
export const RIDER_WIDTH = 0.6;
/** Shots leave from this height above the feet (crouched: RIDER_SHOULDER_CROUCH). */
export const RIDER_SHOULDER = 1.35;
export const RIDER_SHOULDER_CROUCH = 0.8;

export const WIND_REF_SPEED = 25;
export const WIND_MAX = 1.4;
export const WIND_AIR_ACCEL = 2.4; // m/s² at w = 1
export const WIND_WALK_FWD = 0.35; // fraction of walk speed lost into the wind at w = 1
export const WIND_WALK_BACK = 0.25; // fraction gained with the wind at w = 1

export const HEARTS = 5;
export const INVULN_SECONDS = 0.8;
/**
 * A burning trestle's flames burn anyone outside the car bodies (spec §4.3): the Rider loses a heart
 * as they reach them, and another each time the invulnerability after a hit runs out while they
 * stay in them; a bandit loses a hit point as often.
 */
export const FIRE_BURN_SECONDS = INVULN_SECONDS;
export const STUN_SECONDS = 1.0;
export const RESPAWN_OFF_SECONDS = 6;
export const RESPAWN_OFF_CABOOSE_SECONDS = 4;
export const RESPAWN_DOWN_SECONDS = 10;
export const CABOOSE_HEAL_SECONDS = 20;
export const FAST_MOVE = 3; // m/s: bandits aim worse at a Rider moving faster than this…
export const FAST_MOVE_WINDOW = 0.3; // …within the last this-many seconds

/** Low bridge clearance above the roof (or tender top) the figure stands on: standing figures hit it, crouching ones pass. */
export const LOW_BRIDGE_CLEARANCE = 1.2;

/**
 * Fords (spec §4.3): the water stands this deep over the rails (m). Feet below it (platforms, the
 * tender deck, the cab, interiors) are washed off; the roofs, the cab roof and the tender top are dry.
 */
export const FORD_WATER_Y = 2.0;
/** Horses wade through a ford at this speed at most (m/s), so they fall behind the train. */
export const FORD_HORSE_SPEED = 5;

/** The spyglass's near end: close enough to check a signal the train is standing at (spec §6.5). */
export const SCOPE_MIN = 20;
export const SCOPE_MAX = 650;
export const SCOPE_MAX_NIGHT = 300;
export const SCOPE_MAX_HEADLAMP = 450;
/** One flag: a new one replaces it (spec §6.5). */
export const FLAG_MAX = 1;
export const FLAG_TTL_SECONDS = 90;

export const AIM_ASSIST_DEGREES = 6;

export interface WeaponSpec {
  rounds: number;
  /** Seconds between shots. */
  interval: number;
  reload: number;
  damage: number;
  range: number;
  /** Half-angle spread, degrees. */
  spread: number;
  pellets: number;
}

export const WEAPONS: Record<Weapon, WeaponSpec> = {
  revolver: { rounds: 6, interval: 0.28, reload: 1.6, damage: 1, range: 60, spread: 1.5, pellets: 1 },
  shotgun: { rounds: 2, interval: 0.5, reload: 2.2, damage: 1, range: 18, spread: 7, pellets: 6 },
  rifle: { rounds: 8, interval: 0.55, reload: 2.6, damage: 2, range: 120, spread: 0.5, pellets: 1 },
};
export const QUICK_RELOAD_FACTOR = 0.65;

// ---- Bandits (spec §7) ---------------------------------------------------------------------------

export const MAX_HORSEMEN = 6;
export const MAX_BANDITS_ABOARD = 4;
export const HORSE_MAX = 21;
export const HORSE_SPRINT = 25;
export const HORSE_STAMINA_SECONDS = 8;
export const HORSE_STAMINA_REGEN = 1 / 3;
export const HORSE_ACCEL = 3;
export const HORSE_SPAWN_BEHIND = 45;
export const HORSE_AMBUSH_AHEAD = 450;
export const HORSE_AMBUSH_WAKE = 60;
export const HORSE_GIVE_UP_SECONDS = 12;
export const HORSE_GIVE_UP_BEHIND = 70;
export const BOARD_TOLERANCE = 1.2;
export const BOARD_SECONDS = 1.4;

export const HORSEMAN_HP: Record<1 | 2 | 3, number> = { 1: 1, 2: 2, 3: 2 };
export const BOSS_HP = 8;
export const HORSEMAN_RANGE = 30;
export const HORSEMAN_INTERVAL: Record<1 | 2 | 3, [number, number]> = { 1: [2.5, 4], 2: [2.5, 4], 3: [1.8, 3] };
export const HORSEMAN_TELEGRAPH: Record<1 | 2 | 3, number> = { 1: 0.6, 2: 0.6, 3: 0.45 };
export const HORSEMAN_ACCURACY_BASE = 0.6;
export const HORSEMAN_ACCURACY_FALLOFF = 0.012; // per metre
export const ACCURACY_MIN = 0.08;
export const CROUCH_ACCURACY = 0.6;
export const MOVING_ACCURACY = 0.7;

export const BANDIT_WALK = 3.8;
export const BANDIT_RANGE = 25;
export const BANDIT_INTERVAL: [number, number] = [2, 3.5];
export const BANDIT_TELEGRAPH = 0.5;
export const BANDIT_ACCURACY_BASE = 0.55;
export const BANDIT_ACCURACY_FALLOFF = 0.015;
export const BANDIT_CROUCH_ACCURACY = 0.7;

export const CRACK_SECONDS: Record<1 | 2 | 3, number> = { 1: 18, 2: 18, 3: 14 };
export const POWDER_HIT_CHANCE = 0.4;

// ---- Round 2: figures, hazards and horses (fight.ts, rider.ts, bandits.ts, body.ts) ---------------

// ---- Economy (spec §12) --------------------------------------------------------------------------

export const REPLAY_PAY_FACTOR = 0.5;

/**
 * What an optional cargo car earns on a win (spec §12): parcels, fares, freight. Required cars carry
 * the contract and earn nothing extra; the armored car and the caboose carry no cargo.
 */
export const CARGO_PAY: Readonly<Partial<Record<CarType, number>>> = { express: 40, passenger: 30, boxcar: 30 };

/** The loco's two lines of tiered upgrades (spec §12): how hard she pulls, and how fast she runs. */
export type LocoLine = 'power' | 'speed';

export interface ShopItem {
  id: UpgradeId;
  name: string;
  cost: number;
  /** Who it's for; 'loco' is the locomotive's tiers. */
  seat: 'rider' | 'engineer' | 'train' | 'loco';
  blurb: string;
  /** A loco tier's line; its tiers are listed in order. */
  line?: LocoLine;
  /** The tier that must be owned first. */
  requires?: UpgradeId;
}

export const SHOP: readonly ShopItem[] = [
  { id: 'shotgun', name: 'Coach gun', cost: 150, seat: 'rider', blurb: 'Two barrels, six pellets each. Clears a platform.' },
  { id: 'rifle', name: 'Winchester rifle', cost: 250, seat: 'rider', blurb: 'Eight rounds, twice the damage, reaches far.' },
  { id: 'extraHeart', name: 'Leather duster', cost: 120, seat: 'rider', blurb: 'One more heart.' },
  { id: 'quickReload', name: 'Speed loader', cost: 100, seat: 'rider', blurb: 'Reloads a third faster.' },
  { id: 'airBrakes', name: 'Westinghouse air brakes', cost: 180, seat: 'engineer', blurb: 'Brakes bite 35% harder.' },
  { id: 'bigTender', name: 'Big tender', cost: 140, seat: 'engineer', blurb: 'Carries 140 water instead of 100.' },
  { id: 'governor', name: 'Firebox governor', cost: 200, seat: 'engineer', blurb: 'Keeps the pressure near 175 psi by itself.' },
  { id: 'headlamp', name: 'Carbide headlamp', cost: 90, seat: 'engineer', blurb: 'The spyglass sees 490 yards at night instead of 330.' },
  { id: 'armored', name: 'Armored car', cost: 220, seat: 'train', blurb: 'A roof parapet for cover and gun slits to shoot from inside. Heavy.' },
  { id: 'caboose', name: 'Caboose', cost: 160, seat: 'train', blurb: 'Respawn faster, and heal while inside.' },
  { id: 'power1', name: 'Bored-out cylinders', cost: 120, seat: 'loco', line: 'power', blurb: 'Pulls 15% harder: quicker away, stronger up grades.' },
  { id: 'power2', name: 'Balanced slide valves', cost: 240, seat: 'loco', line: 'power', requires: 'power1', blurb: 'Pulls 30% harder than stock.' },
  { id: 'power3', name: 'Vauclain compound', cost: 400, seat: 'loco', line: 'power', requires: 'power2', blurb: 'Uses its steam twice: pulls 50% harder than stock.' },
  { id: 'speed1', name: 'Babbitt bearings', cost: 100, seat: 'loco', line: 'speed', blurb: 'Less friction: top speed about 5% over stock.' },
  { id: 'speed2', name: 'Balanced drivers', cost: 200, seat: 'loco', line: 'speed', requires: 'speed1', blurb: 'Counterweighted wheels: top speed about 12% over stock.' },
  { id: 'speed3', name: 'Tall drivers', cost: 350, seat: 'loco', line: 'speed', requires: 'speed2', blurb: 'Seventy-inch wheels: top speed about 20% over stock.' },
];

/**
 * The loco's tiers (spec §12), each the whole gain over stock: the power tiers multiply the
 * tractive effort, the speed tiers the drag (top speed goes as 1/√ of it: +5%, +12%, +20%).
 */
export const POWER_TIERS: readonly (readonly [UpgradeId, number])[] = [
  ['power1', 1.15],
  ['power2', 1.3],
  ['power3', 1.5],
];
export const SPEED_TIERS: readonly (readonly [UpgradeId, number])[] = [
  ['speed1', 0.9],
  ['speed2', 0.8],
  ['speed3', 0.7],
];

/** The factor of the highest tier owned, or 1 for stock. */
function tierFactor(tiers: readonly (readonly [UpgradeId, number])[], upgrades: readonly UpgradeId[]): number {
  let f = 1;
  for (const [id, factor] of tiers) if (upgrades.includes(id)) f = factor;
  return f;
}

/** Cars anyone can add to a consist without buying them. */
export const FREE_CARS: readonly CarType[] = ['express', 'passenger', 'boxcar'];

// ---- The train (train.ts) ------------------------------------------------------------------

/** Governor: extra psi/s of firing asked for per psi below GOVERNOR_TARGET_PSI (spec §5.5). */
export const GOVERNOR_GAIN = 0.5;
/** Governor: how far (in notches) past the halfway point the ideal fire must be before it changes notch, so it doesn't flicker. */
export const GOVERNOR_HYSTERESIS = 0.3;
/** Held up (spec §5.2): the sim eases the brake to this… */
export const HOLDUP_BRAKE = 0.5;
/** …and the throttle to 0, moving each lever at most this much per second. */
export const HOLDUP_EASE = 1;
/** The Rider's 'align' prompt shows once a spout is within this many metres of the hatch (spec §5.5). */
export const SPOUT_PROMPT_RANGE = 40;

// ---- Signals (signals.ts) ------------------------------------------------------------------

/**
 * The loco crossing the same signal again within this many seconds (rolling back and forth over it)
 * is one passing, not several: one event, one fine.
 */
export const SIGNAL_DEBOUNCE_SECONDS = 3;

// ---- Figures on the train (body.ts) --------------------------------------------------------

/** W grabs a ladder within this horizontal distance of it. */
export const LADDER_REACH = 0.35;
/** S at the top of a ladder mounts it within this distance of where it tops out. */
export const LADDER_TOP_REACH = 0.35;
/** Space on a ladder jumps off it with this fraction of a full jump. */
export const LADDER_JUMP = 0.5;
/** Landing faster than this (m/s) is a hard landing (a louder thud). */
export const HARD_LANDING = 9;
/** Feet below this height (m above the rails, under every floor) means off the train. */
export const FALL_OFF_Y = 0.6;

// ---- Fighting (fight.ts) -------------------------------------------------------------------

/**
 * Feet higher than this inside a tunnel hit its roof (spec §4.3): anything above floor level does —
 * a car roof (3.9–4.7 m), the cab roof (4.0 m) and the tender top (2.8 m). Platforms, the tender
 * deck, the cab floor (1.2–1.4 m) and interiors are safe.
 */
export const TUNNEL_FEET_Y = 2.3;
/** A horseman's rider as a target (spec §7.2: riders can be hit, horses can't): half-width, saddle to hat. */
export const HORSEMAN_HALF_W = 0.35;
export const HORSEMAN_Y0 = 1.5;
export const HORSEMAN_Y1 = 2.7;
/** Where a horseman's shots leave from, and where shots at one are aimed. */
export const HORSEMAN_GUN_Y = 2.3;
export const HORSEMAN_CHEST_Y = 2.1;
/** Downed or swept-off figures fall for this long (for drawing) before they're gone. */
export const FALL_SECONDS = 1.0;
/** A hit knocks a boarding horseman back by this much speed (spec §7.2: "a hit during boarding knocks them off"). */
export const BOARD_KNOCKBACK = 2;

// ---- The Rider (rider.ts) ------------------------------------------------------------------

/** Changing weapons takes this long before the next shot. */
export const WEAPON_SWITCH_SECONDS = 0.25;
/**
 * A miss that passes this close to a horseman was aimed into the trackside lane: its tracer flies
 * on past the train instead of stopping at the car body behind (it's in front of it).
 */
export const NEAR_MISS = 1.5;
/** The spyglass view eases toward the pointer with this time constant. */
export const SCOPE_SMOOTH_SECONDS = 0.3;
/** Dropped loot is picked up by feet within this distance of it (and this close in height). */
export const LOOT_REACH = 0.6;
export const LOOT_REACH_Y = 0.5;

// ---- Bandits (bandits.ts) ------------------------------------------------------------------

/** Members of a wave start this far apart. */
export const SPAWN_SPACING = 4;
/** A horseman closes on his mark at up to this much faster than the train (m/s)… */
export const HORSE_CLOSE = 6;
/** …braking with this share of HORSE_ACCEL so he doesn't overshoot. */
export const HORSE_BRAKE = 0.8;
/** Within this of his mark a horseman is pacing; past twice this he's approaching again. */
export const PACE_RANGE = 4;
/** Giving up: rein in to this much slower than the train, and gone after RETREAT_SECONDS. */
export const RETREAT_REL = 8;
export const RETREAT_SECONDS = 6;
/** Powder horsemen spread along the powder car this far apart. */
export const POWDER_SPREAD = 3;
/** A hunting bandit closes to this range of the Rider (with a clear shot) before standing to fight. */
export const HUNT_CLOSE = 8;
/** Missed shots fly on this far past their target. */
export const MISS_CARRY = 4;
/** Height of a powder hit on the car's side. */
export const POWDER_HIT_Y = 2.4;
