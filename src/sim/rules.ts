// Every tunable (spec §14). Numbers are the spec's starting values; tune them here, nowhere else.

import type { CarKind, CarType, UpgradeId, Weapon } from './types';

// ---- Simulation ---------------------------------------------------------------------------------

export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;
/** EngineerView snapshots per second. */
export const SNAPSHOT_HZ = 15;
export const COUNTDOWN_SECONDS = 3;

/** mph per m/s. */
export const MPH = 2.23694;
/** Metres per mile. */
export const MILE = 1609.34;

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

export const TRACTIVE_MAX = 60; // kN
export const FULL_POWER_PSI = 160;
export const ROLL = 0.02; // m/s²
export const DRAG = 0.0007; // per (m/s)²
export const GRAVITY = 9.81;
export const BRAKE_MAX = 1.1; // m/s² at brake = 1
export const AIR_BRAKES_FACTOR = 1.35;
/** Brake lever above this is the emergency application (sparks, louder squeal). */
export const EMERGENCY_BRAKE = 0.85;
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
export const WHISTLE_SCARE_MIN = 40;
export const WHISTLE_SCARE_MAX = 350;
export const WHISTLE_SCARE_SECONDS = 0.5;
export const OBSTACLE_SCATTER_SECONDS = 4;

// ---- Signals (spec §9) ---------------------------------------------------------------------------

export const BLOCK_MAX = 2500;
export const APPROACH_LIMIT = 9; // m/s (20 mph)
export const DIVERGE_LIMIT = 13.4; // m/s (30 mph) through the junction on divergeClear
export const SPEED_FINE_TOLERANCE = 1.1;
export const RED_SIGNAL_FINE = 50;
export const SPEED_FINE = 10;

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
export const STUN_SECONDS = 1.0;
export const RESPAWN_OFF_SECONDS = 6;
export const RESPAWN_OFF_CABOOSE_SECONDS = 4;
export const RESPAWN_DOWN_SECONDS = 10;
export const CABOOSE_HEAL_SECONDS = 20;
export const FAST_MOVE = 3; // m/s: bandits aim worse at a Rider moving faster than this…
export const FAST_MOVE_WINDOW = 0.3; // …within the last this-many seconds

/** Low bridge clearance above the roof the figure stands on: standing figures hit it, crouching ones pass. */
export const LOW_BRIDGE_CLEARANCE = 1.2;

export const SCOPE_MIN = 60;
export const SCOPE_MAX = 650;
export const SCOPE_MAX_NIGHT = 300;
export const SCOPE_MAX_HEADLAMP = 450;
export const FLAG_MAX = 3;
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

// ---- Economy (spec §12) --------------------------------------------------------------------------

export const REPLAY_PAY_FACTOR = 0.5;

export interface ShopItem {
  id: UpgradeId;
  name: string;
  cost: number;
  seat: 'rider' | 'engineer' | 'train';
  blurb: string;
}

export const SHOP: readonly ShopItem[] = [
  { id: 'shotgun', name: 'Coach gun', cost: 150, seat: 'rider', blurb: 'Two barrels, six pellets each. Clears a platform.' },
  { id: 'rifle', name: 'Winchester rifle', cost: 250, seat: 'rider', blurb: 'Eight rounds, twice the damage, reaches far.' },
  { id: 'extraHeart', name: 'Leather duster', cost: 120, seat: 'rider', blurb: 'One more heart.' },
  { id: 'quickReload', name: 'Speed loader', cost: 100, seat: 'rider', blurb: 'Reloads a third faster.' },
  { id: 'airBrakes', name: 'Westinghouse air brakes', cost: 180, seat: 'engineer', blurb: 'Brakes bite 35% harder.' },
  { id: 'bigTender', name: 'Big tender', cost: 140, seat: 'engineer', blurb: 'Carries 140 water instead of 100.' },
  { id: 'governor', name: 'Firebox governor', cost: 200, seat: 'engineer', blurb: 'Keeps the pressure near 175 psi by itself.' },
  { id: 'headlamp', name: 'Carbide headlamp', cost: 90, seat: 'engineer', blurb: 'The spyglass sees 450 m at night instead of 300 m.' },
  { id: 'armored', name: 'Armored car', cost: 220, seat: 'train', blurb: 'A roof parapet for cover and gun slits to shoot from inside. Heavy.' },
  { id: 'caboose', name: 'Caboose', cost: 160, seat: 'train', blurb: 'Respawn faster, and heal while inside.' },
];

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
 * Feet higher than this inside a tunnel hit its roof (spec §4.3): standing or crouching on a car
 * roof (3.9–4.7 m) or the cab roof (4.0 m) does, the tender top (2.8 m) doesn't — unless you jump.
 */
export const TUNNEL_FEET_Y = 3.5;
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
