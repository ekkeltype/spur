import { describe, expect, it } from 'vitest';
import { banditHitChance, horsemanHitChance, spawnWave, stepBandits } from '../src/sim/bandits';
import { damageBandit, damageHorseman } from '../src/sim/fight';
import { newGame } from '../src/sim/game';
import { trainGeometry } from '../src/sim/geometry';
import { framePath, framePoint, netIndex } from '../src/sim/network';
import { initialLoot, initialRider, stepRider, type FightCtx } from '../src/sim/rider';
import { CAR_SPECS, HORSE_MAX, HORSE_SPRINT, SCOPE_MAX, TICK_HZ } from '../src/sim/rules';
import {
  NO_INPUT,
  type BanditState,
  type CarType,
  type GameState,
  type HorsemanState,
  type RiderInput,
  type RunDef,
  type SimEvent,
  type SurfaceKind,
  type WaveDef,
} from '../src/sim/types';
import { yRun } from './fixtures';

// Express + boxcar: L = 53. Loco [37, 53] (cab [37, 41.5], boarded at 38), tender [28, 37],
// express [13, 28] (platforms at 13.55 and 27.45, floor 1.2, safe at 20.5, roof 4.2),
// boxcar [0, 13] (platforms at 0.55 and 12.45, floor 1.3, roof 4.0).

interface World {
  run: RunDef;
  state: GameState;
  ctx: FightCtx;
}

function world(consist: CarType[] = ['express', 'boxcar'], opts: { seed?: number; critical?: boolean; waves?: WaveDef[] } = {}): World {
  const base = yRun();
  const run = yRun({ waves: opts.waves ?? [], contract: { ...base.contract, critical: opts.critical ?? false } });
  const state = newGame(run, { seed: opts.seed ?? 3, consist, upgrades: [], assists: { rider: false, engineer: false } });
  state.rider = initialRider(state.train.cars, state.upgrades, state.assists);
  state.loot = initialLoot();
  const ctx: FightCtx = {
    state,
    run,
    hazards: [],
    trackPointAt: (x) => framePoint(framePath(netIndex(run), state.switches, state.train.spans, 0, 2000), x),
    scopeMax: SCOPE_MAX,
  };
  return { run, state, ctx };
}

function wave(p: Partial<WaveDef> = {}): WaveDef {
  return { id: 'w1', trigger: { edge: 'e1', off: 300 }, count: 3, from: 'rear', goal: 'hunt', tier: 1, ...p };
}

function bandit(p: Partial<BanditState> = {}): BanditState {
  return {
    id: 90,
    x: 22,
    y: 4.2,
    vx: 0,
    vy: 0,
    onGround: true,
    surface: 'roof',
    ladder: null,
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
    cooldownTicks: 600,
    stunTicks: 0,
    navTarget: null,
    ...p,
  };
}

function horseman(p: Partial<HorsemanState> = {}): HorsemanState {
  return {
    id: 80,
    x: 24,
    worldV: 0,
    hp: 1,
    tier: 1,
    boss: false,
    goal: 'hunt',
    mode: 'pace',
    modeTicks: 0,
    stamina: 8,
    targetX: 24,
    aimTicks: 0,
    cooldownTicks: 600,
    behindTicks: 0,
    pickup: false,
    ...p,
  };
}

/** Runs the Rider (with `input`) and the bandits for n ticks. */
function tick(w: World, n: number, input: Partial<RiderInput> = {}): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    stepRider(w.ctx, { ...NO_INPUT, ...input }, ev);
    stepBandits(w.ctx, ev);
    w.state.tick++;
  }
  return ev;
}

/** Takes the Rider out of the picture (down for good) so bandits can go about their business. */
function riderAway(w: World): void {
  Object.assign(w.state.rider, { mode: 'down', respawnTicks: 1e9 });
}

function placeRider(w: World, x: number, y: number, surface: SurfaceKind): void {
  Object.assign(w.state.rider, { x, y, vx: 0, vy: 0, onGround: true, surface, ladder: null, crouch: false });
}

/** One shot by the Rider at a point. */
function shootAt(w: World, x: number, y: number): SimEvent[] {
  const r = w.state.rider;
  const aim = Math.atan2(y - (r.y + (r.crouch ? 0.8 : 1.35)), x - r.x);
  const ev: SimEvent[] = [];
  r.cooldownTicks = 0;
  stepRider(w.ctx, { ...NO_INPUT, firePressed: true, firing: true, aim }, ev);
  return ev;
}

const alive = (h: { mode: string }): boolean => h.mode !== 'falling' && h.mode !== 'gone';

describe('waves (spec §7.1)', () => {
  it('sends a rear wave galloping up from 45 m behind the rear', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 10;
    const ev: SimEvent[] = [];
    spawnWave(w.ctx, wave({ count: 3, from: 'rear', tier: 2 }), ev);
    expect(ev).toContainEqual({ type: 'waveSpawned', id: 'w1', count: 3, from: 'rear' });
    const hs = w.state.horsemen;
    expect(hs.length).toBe(3);
    expect(new Set(hs.map((h) => h.id)).size).toBe(3);
    for (const h of hs) {
      expect(h.x).toBeLessThanOrEqual(-45);
      expect([h.mode, h.hp, h.goal, h.tier]).toEqual(['approach', 2, 'hunt', 2]);
    }
    expect(w.state.waves.find((q) => q.id === 'w1')?.triggered).toBe(true);
    const before = hs.map((h) => h.x);
    tick(w, 3 * TICK_HZ);
    hs.forEach((h, i) => expect(h.x).toBeGreaterThan(before[i] + 5));
  });

  it('lays an ambush 450 m ahead that stays by the track until the loco is within 60 m', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 15;
    spawnWave(w.ctx, wave({ count: 2, from: 'ahead' }), []);
    const h = w.state.horsemen[0];
    expect([h.mode, h.worldV]).toEqual(['waiting', 0]);
    expect(h.x).toBeGreaterThanOrEqual(53 + 450);
    const x0 = h.x;
    tick(w, TICK_HZ);
    expect(h.x).toBeCloseTo(x0 - 15, 6);
    // (450 − 60) / 15 = 26 s until it wakes.
    tick(w, 24 * TICK_HZ);
    expect(h.mode).toBe('waiting');
    tick(w, 2 * TICK_HZ);
    expect(h.mode).toBe('approach');
  });

  it("spreads a mixed wave's goals over what the train carries, and makes the last one the boss", () => {
    const w = world(['express', 'powder', 'boxcar']);
    spawnWave(w.ctx, wave({ count: 5, goal: 'mixed', boss: true, tier: 3 }), []);
    expect(new Set(w.state.horsemen.map((h) => h.goal))).toEqual(new Set(['safe', 'cab', 'hunt', 'powder']));
    const boss = w.state.horsemen[4];
    expect([boss.boss, boss.hp, boss.goal]).toEqual([true, 8, 'safe']);
    expect(w.state.horsemen.slice(0, 4).every((h) => !h.boss && h.hp === 2)).toBe(true);
    const plain = world(['boxcar']);
    spawnWave(plain.ctx, wave({ count: 6, goal: 'mixed' }), []);
    expect(new Set(plain.state.horsemen.map((h) => h.goal))).toEqual(new Set(['cab', 'hunt']));
    // A safe or powder wave with no such car goes hunting.
    const none = world(['boxcar']);
    spawnWave(none.ctx, wave({ count: 1, goal: 'safe' }), []);
    spawnWave(none.ctx, wave({ id: 'w2', count: 1, goal: 'powder' }), []);
    expect(none.state.horsemen.map((h) => h.goal)).toEqual(['hunt', 'hunt']);
  });

  it('keeps at most 6 horsemen, queueing the rest until there is room', () => {
    const big = wave({ count: 8 });
    const w = world(['express', 'boxcar'], { waves: [big] });
    riderAway(w);
    const ev: SimEvent[] = [];
    spawnWave(w.ctx, big, ev);
    expect(w.state.horsemen.length).toBe(6);
    expect(w.state.waves[0].queued).toBe(2);
    expect(ev).toContainEqual({ type: 'waveSpawned', id: 'w1', count: 8, from: 'rear' });
    damageHorseman(w.ctx, w.state.horsemen[0], 5, ev);
    tick(w, 1);
    expect(w.state.horsemen.filter(alive).length).toBe(6);
    expect(w.state.waves[0].queued).toBe(1);
    damageHorseman(w.ctx, w.state.horsemen[1], 5, ev);
    tick(w, 1);
    expect(w.state.horsemen.filter(alive).length).toBe(6);
    expect(w.state.waves[0].queued).toBe(0);
  });
});

describe('horsemen (spec §7.2)', () => {
  it('gives up after 12 s when the train is faster than a horse can keep up with', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = HORSE_MAX + 1.5;
    w.state.horsemen = [horseman({ x: -20, worldV: HORSE_MAX, goal: 'safe', mode: 'approach' })];
    const h = w.state.horsemen[0];
    tick(w, 11 * TICK_HZ);
    expect(h.mode).toBe('approach');
    tick(w, 2 * TICK_HZ);
    expect(h.mode).toBe('retreat');
    tick(w, 10 * TICK_HZ);
    expect(w.state.horsemen.length).toBe(0);
  });

  it('gives up at once when 70 m behind the rear', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = HORSE_SPRINT + 8;
    spawnWave(w.ctx, wave({ count: 1 }), []);
    const h = w.state.horsemen[0];
    tick(w, 4 * TICK_HZ);
    expect(['retreat', 'gone']).toContain(h.mode);
  });

  it('keeps pace alongside its boarding point, sprinting while its stamina lasts', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 12;
    w.state.horsemen = [horseman({ x: -10, worldV: 12, goal: 'safe', mode: 'approach' })];
    const h = w.state.horsemen[0];
    tick(w, 1);
    expect(h.targetX).toBeCloseTo(13.55, 6); // the express's nearer end
    // Stop it boarding: the train is full.
    w.state.bandits = [1, 2, 3, 4].map((i) => bandit({ id: 100 + i, x: 2 + 2 * i, y: 4, surface: 'roof', cooldownTicks: 1e9 }));
    tick(w, 20 * TICK_HZ);
    expect(Math.abs(h.x - 13.55)).toBeLessThan(1.2);
    expect(h.worldV).toBeCloseTo(12, 0);
    // Faster than HORSE_MAX it can only hold on by sprinting, and its stamina drains.
    w.state.train.v = HORSE_MAX + 2;
    tick(w, 5 * TICK_HZ); // time to accelerate past HORSE_MAX at HORSE_ACCEL
    expect(h.stamina).toBeLessThan(8);
    expect(Math.abs(h.worldV)).toBeGreaterThan(HORSE_MAX);
  });

  it('boards only when the train is no faster than HORSE_MAX + 0.5, after 1.4 s at the platform', () => {
    const fast = world();
    riderAway(fast);
    fast.state.train.v = HORSE_MAX + 1;
    fast.state.horsemen = [horseman({ x: 13.55, targetX: 13.55, worldV: HORSE_MAX + 1, goal: 'safe' })];
    expect(tick(fast, 5 * TICK_HZ).some((e) => e.type === 'banditBoarded')).toBe(false);

    const w = world();
    riderAway(w);
    w.state.train.v = 12;
    w.state.horsemen = [horseman({ x: 13.55, targetX: 13.55, worldV: 12, goal: 'safe' })];
    const early = tick(w, Math.round(1.4 * TICK_HZ) - 5);
    expect(early.some((e) => e.type === 'banditBoarded')).toBe(false);
    const ev = tick(w, 10);
    const boarded = ev.find((e) => e.type === 'banditBoarded');
    expect(boarded).toMatchObject({ type: 'banditBoarded', id: 80, into: 'platform', y: 1.2 });
    expect(boarded && boarded.type === 'banditBoarded' && boarded.x).toBeCloseTo(13.55, 6);
    expect(w.state.horsemen.length).toBe(0);
    expect(w.state.bandits.map((b) => [b.id, b.goal, b.hp, b.surface])).toEqual([[80, 'safe', 1, 'platform']]);
  });

  it('is knocked back from boarding by a hit, and has to start again', () => {
    const w = world();
    w.state.train.v = 12;
    placeRider(w, 16, 4.2, 'roof');
    w.state.horsemen = [horseman({ x: 13.55, targetX: 13.55, worldV: 12, goal: 'safe', hp: 2, tier: 2 })];
    const h = w.state.horsemen[0];
    tick(w, TICK_HZ);
    expect(h.mode).toBe('boarding');
    const ev = shootAt(w, h.x, 2.1);
    expect(ev.find((e) => e.type === 'shot')).toMatchObject({ hit: 'horseman' });
    expect([h.hp, h.mode]).toEqual([1, 'pace']);
    expect(tick(w, TICK_HZ).some((e) => e.type === 'banditBoarded')).toBe(false);
  });

  it('lets no more than 4 bandits aboard: the rest ride alongside', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 10;
    w.state.bandits = [1, 2, 3, 4].map((i) => bandit({ id: 100 + i, x: 2 + 2 * i, y: 4, surface: 'roof', cooldownTicks: 1e9 }));
    w.state.horsemen = [horseman({ x: 13.55, targetX: 13.55, worldV: 10, goal: 'safe' })];
    const ev = tick(w, 5 * TICK_HZ);
    expect(ev.some((e) => e.type === 'banditBoarded')).toBe(false);
    damageBandit(w.ctx, w.state.bandits[0], 5, ev);
    expect(tick(w, 5 * TICK_HZ).some((e) => e.type === 'banditBoarded')).toBe(true);
  });

  it('shoot at an exposed Rider within 30 m after a telegraph, never at one inside a car', () => {
    const w = world();
    w.state.train.v = 10;
    placeRider(w, 20, 4.2, 'roof');
    w.state.horsemen = [horseman({ x: 26, targetX: 26, worldV: 10, goal: 'powder', cooldownTicks: 1e9 })];
    w.state.horsemen[0].goal = 'hunt';
    w.state.horsemen[0].cooldownTicks = 0;
    w.state.bandits = [1, 2, 3, 4].map((i) => bandit({ id: 100 + i, x: 1 + 2 * i, y: 4, surface: 'roof', cooldownTicks: 1e9, goal: 'safe', hp: 99 }));
    const ev = tick(w, 1);
    expect(ev).toContainEqual({ type: 'aim', by: 'horseman', id: 80 });
    const shot = tick(w, Math.round(0.6 * TICK_HZ)).filter((e) => e.type === 'shot' && e.by === 'horseman');
    expect(shot.length).toBe(1);
    expect(shot[0]).toMatchObject({ layer: 'trackside' });
    // Inside the express: no telegraph.
    const inside = world();
    inside.state.train.v = 10;
    placeRider(inside, 20, 1.2, 'floor');
    inside.state.horsemen = [horseman({ x: 22, targetX: 22, worldV: 10, cooldownTicks: 0 })];
    inside.state.bandits = [1, 2, 3, 4].map((i) => bandit({ id: 100 + i, x: 1 + 2 * i, y: 4, surface: 'roof', cooldownTicks: 1e9, goal: 'safe', hp: 99 }));
    expect(tick(inside, 3 * TICK_HZ).some((e) => e.type === 'aim')).toBe(false);
  });
});

describe('hit chances (spec §7.2, §7.3)', () => {
  it('fall off with distance, crouching and moving fast, never below 0.08', () => {
    expect(horsemanHitChance(10, false, false)).toBeCloseTo(0.48, 9);
    expect(horsemanHitChance(10, true, false)).toBeCloseTo(0.288, 9);
    expect(horsemanHitChance(10, false, true)).toBeCloseTo(0.336, 9);
    expect(horsemanHitChance(10, true, true)).toBeCloseTo(0.2016, 9);
    expect(horsemanHitChance(45, false, false)).toBeCloseTo(0.08, 9);
    expect(banditHitChance(10, false)).toBeCloseTo(0.4, 9);
    expect(banditHitChance(10, true)).toBeCloseTo(0.28, 9);
    expect(banditHitChance(40, false)).toBeCloseTo(0.08, 9);
  });
});

describe('boarded bandits (spec §7.3)', () => {
  it('aim for 0.5 s at a Rider in sight within 25 m, then fire', () => {
    const w = world();
    placeRider(w, 16, 4.2, 'roof');
    w.state.bandits = [bandit({ id: 5, x: 22, cooldownTicks: 0 })];
    expect(tick(w, 1)).toContainEqual({ type: 'aim', by: 'bandit', id: 5 });
    const before = tick(w, Math.round(0.5 * TICK_HZ) - 2);
    expect(before.some((e) => e.type === 'shot')).toBe(false);
    const shot = tick(w, 2).filter((e) => e.type === 'shot' && e.by === 'bandit');
    expect(shot.length).toBe(1);
    expect(shot[0]).toMatchObject({ layer: 'train', x0: 22 });
    // Through a roof there's no line of sight: no telegraph.
    const blind = world();
    placeRider(blind, 16, 1.2, 'floor');
    blind.state.bandits = [bandit({ id: 5, x: 22, cooldownTicks: 0, goal: 'cab' })];
    expect(tick(blind, 1).some((e) => e.type === 'aim')).toBe(false);
  });

  it('hurt the Rider now and then, and hold their fire in god mode', () => {
    const shootOut = (god: boolean): { hurt: number; shots: number } => {
      const w = world(['express', 'boxcar'], { seed: 5 });
      w.state.godMode = god;
      placeRider(w, 16, 4.2, 'roof');
      w.state.rider.hearts = 99;
      w.state.rider.maxHearts = 99;
      w.state.bandits = [bandit({ id: 5, x: 20, cooldownTicks: 0, hp: 99 })];
      const ev = tick(w, 60 * TICK_HZ);
      return { hurt: ev.filter((e) => e.type === 'riderHurt').length, shots: ev.filter((e) => e.type === 'shot' && e.by === 'bandit').length };
    };
    const normal = shootOut(false);
    expect(normal.hurt).toBeGreaterThan(3);
    expect(normal.shots).toBeGreaterThan(normal.hurt);
    expect(shootOut(true)).toEqual({ hurt: 0, shots: 0 });
  });

  it('cross from roof to roof with a running jump in still air, and by the ladders in a gale', () => {
    // Express [17, 32] ahead of a passenger car [0, 17]: both roofs at 4.2, 1.6 m apart.
    for (const [v, jumps] of [
      [5, true],
      [25, false],
    ] as const) {
      const w = world(['express', 'passenger']);
      w.state.godMode = true;
      w.state.train.v = v;
      placeRider(w, 29, 4.2, 'roof');
      w.state.bandits = [bandit({ id: 7, x: 8, y: 4.2, surface: 'roof', goal: 'hunt' })];
      let top = 0;
      for (let i = 0; i < 15 * TICK_HZ; i++) {
        tick(w, 1);
        top = Math.max(top, w.state.bandits[0].y);
      }
      const b = w.state.bandits[0];
      expect(b.y).toBe(4.2);
      expect(b.x).toBeGreaterThan(17.8);
      expect(top > 4.5).toBe(jumps);
    }
  });

  it('find their way from a roof down through a hatch to the safe, in any wind', () => {
    for (const v of [5, 25]) {
      const w = world();
      riderAway(w);
      w.state.train.v = v;
      w.state.bandits = [bandit({ id: 7, x: 5, y: 4, surface: 'roof', goal: 'safe' })];
      tick(w, 15 * TICK_HZ);
      const b = w.state.bandits[0];
      expect(b.mode).toBe('cracking');
      expect(b.x).toBeCloseTo(20.5, 0);
      expect(b.y).toBe(1.2);
    }
  });

  it('hunt the Rider across the train, over the tender and down the cars', () => {
    const w = world();
    w.state.godMode = true;
    w.state.train.v = 10;
    placeRider(w, 5, 1.3, 'floor'); // inside the boxcar
    w.state.bandits = [bandit({ id: 7, x: 39, y: 4, surface: 'cabRoof', goal: 'hunt' })];
    tick(w, 30 * TICK_HZ);
    const b = w.state.bandits[0];
    expect(Math.abs(b.x - 5)).toBeLessThan(9);
    expect(b.y).toBeCloseTo(1.3, 6);
  });

  it('climb the ladder they mean to, where two hang side by side (the car end and the tender)', () => {
    // From the express's front platform to the cab: up the tender's rear ladder, whose foot is
    // 0.33 m from the express's front-end ladder, over the coal and down to the deck.
    const w = world();
    riderAway(w);
    w.state.bandits = [bandit({ id: 7, x: 27.45, y: 1.2, surface: 'platform', goal: 'cab' })];
    tick(w, 20 * TICK_HZ);
    expect(w.state.bandits[0].mode).toBe('holdup');
    expect(w.state.train.heldUp).toBe(true);
  });

  it('get to the cab and to the safe from anywhere on a train of every car kind, in still air or a gale', () => {
    const consist: CarType[] = ['express', 'caboose', 'armored', 'powder', 'passenger', 'boxcar'];
    const cars = world(consist).state.train.cars;
    const surfaces = trainGeometry(cars).surfaces;
    const failures: string[] = [];
    for (const goal of ['cab', 'safe'] as const) {
      for (const v of [0, 25]) {
        for (const s of surfaces) {
          const w = world(consist);
          riderAway(w);
          w.state.train.v = v;
          w.state.bandits = [bandit({ id: 7, x: (s.x0 + s.x1) / 2, y: s.y, surface: s.kind, goal })];
          const done = goal === 'cab' ? 'holdup' : 'cracking';
          for (let i = 0; i < 60 * TICK_HZ && w.state.bandits[0]?.mode !== done; i++) tick(w, 1);
          const b = w.state.bandits[0];
          if (b?.mode !== done) failures.push(`${goal} v=${v} from ${s.kind}@${s.x0.toFixed(1)}: ${b ? `${b.mode} at ${b.x.toFixed(2)},${b.y.toFixed(2)}` : 'gone'}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('are swept off by tunnels, and knocked down by low bridges just like the Rider', () => {
    const w = world();
    riderAway(w);
    w.state.bandits = [bandit({ id: 1, x: 20, y: 4.2, surface: 'roof' }), bandit({ id: 2, x: 32, y: 2.8, surface: 'tenderTop' })];
    w.ctx.hazards = [{ kind: 'tunnel', id: 't', x0: 10, x1: 300 }];
    const ev = tick(w, 1);
    expect(ev).toContainEqual({ type: 'banditKnockedOff', id: 1, cause: 'tunnel' });
    expect(w.state.bandits.map((b) => [b.id, alive(b)])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(w.state.stats.banditsDowned).toBe(1);

    const low = world();
    riderAway(low);
    low.state.train.v = 12;
    low.state.bandits = [bandit({ id: 3, x: 20, y: 4.2, surface: 'roof', hp: 2, tier: 2 }), bandit({ id: 4, x: 16, y: 4.2, surface: 'roof', hp: 1 })];
    let bx = 22;
    const ev2: SimEvent[] = [];
    for (let i = 0; i < 60; i++) {
      low.ctx.hazards = [{ kind: 'lowBridge', id: 'b', x0: bx, x1: bx }];
      ev2.push(...tick(low, 1));
      bx -= 12 / TICK_HZ;
    }
    const b3 = low.state.bandits.find((b) => b.id === 3) as BanditState;
    expect(b3.hp).toBe(1);
    expect(alive(b3)).toBe(true);
    expect(ev2).toContainEqual({ type: 'banditKnockedOff', id: 4, cause: 'bridge' });
  });
});

describe('goals (spec §7.4)', () => {
  it('cracks the safe in 18 s, takes the loot and escapes onto a horse: stolen', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 10;
    w.state.bandits = [bandit({ id: 7, x: 13.55, y: 1.2, surface: 'platform', goal: 'safe' })];
    tick(w, 4 * TICK_HZ);
    const b = w.state.bandits[0];
    expect(b.mode).toBe('cracking');
    expect(w.state.loot.status).toBe('cracking');
    const ev = tick(w, 18 * TICK_HZ);
    const cracking = ev.filter((e) => e.type === 'safeCracking').length;
    expect(cracking).toBeGreaterThanOrEqual(14);
    expect(cracking).toBeLessThanOrEqual(19);
    expect(ev).toContainEqual({ type: 'lootTaken' });
    expect(w.state.loot).toMatchObject({ status: 'carried', carrier: 7, everCracked: true });
    expect(b.hasLoot).toBe(true);
    const ev2 = tick(w, 30 * TICK_HZ);
    expect(ev2).toContainEqual({ type: 'lootStolen' });
    expect(w.state.loot.status).toBe('stolen');
    expect(w.state.bandits.length).toBe(0);
    // Got clean away: nothing dropped, nobody downed.
    expect(ev2.some((e) => e.type === 'lootDropped' || e.type === 'banditDown')).toBe(false);
    expect(w.state.phase).toBe('running');
  });

  it('sends a horseman already riding along to hold the getaway horse, never the boss, or one from behind', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 10;
    Object.assign(w.state.loot, { status: 'carried', carrier: 7, crack: 1, everCracked: true });
    w.state.bandits = [bandit({ id: 7, x: 13.55, y: 1.2, surface: 'platform', goal: 'safe', hasLoot: true, mode: 'fleeing' })];
    w.state.horsemen = [
      horseman({ id: 1, x: 27, targetX: 27.45, worldV: 10, goal: 'safe', boss: true, hp: 8, tier: 3 }),
      horseman({ id: 2, x: 30, targetX: 38, worldV: 10, goal: 'cab' }),
    ];
    tick(w, 1);
    expect(w.state.horsemen.map((h) => [h.id, h.pickup])).toEqual([
      [1, false],
      [2, true],
    ]);
    const alone = world();
    riderAway(alone);
    alone.state.train.v = 10;
    Object.assign(alone.state.loot, { status: 'carried', carrier: 7, crack: 1, everCracked: true });
    alone.state.bandits = [bandit({ id: 7, x: 13.55, y: 1.2, surface: 'platform', goal: 'safe', hasLoot: true, mode: 'fleeing' })];
    alone.state.horsemen = [horseman({ id: 1, x: 27, targetX: 27.45, worldV: 10, goal: 'safe', boss: true, hp: 8, tier: 3 })];
    tick(alone, 1);
    expect(alone.state.horsemen.map((h) => [h.boss, h.pickup, h.x <= -45])).toEqual([
      [true, false, false],
      [false, true, true],
    ]);
  });

  it('loses the run when critical cargo is stolen', () => {
    const w = world(['express', 'boxcar'], { critical: true });
    riderAway(w);
    w.state.train.v = 10;
    Object.assign(w.state.loot, { status: 'carried', carrier: 7, crack: 1, everCracked: true });
    w.state.bandits = [bandit({ id: 7, x: 18, y: 1.2, surface: 'floor', goal: 'safe', hasLoot: true, mode: 'fleeing' })];
    const ev = tick(w, 30 * TICK_HZ);
    expect(ev).toContainEqual({ type: 'lootStolen' });
    expect(w.state.phase).toBe('lost');
    expect(w.state.loss?.reason).toBe('lootStolen');
    expect(ev.some((e) => e.type === 'lost' && e.reason === 'lootStolen')).toBe(true);
  });

  it('keeps the cracking progress when the cracker is shot, and waits for no horse when the train is too fast', () => {
    const w = world();
    w.state.train.v = 10;
    placeRider(w, 25, 1.2, 'floor');
    w.state.rider.invulnTicks = 1e9;
    w.state.bandits = [bandit({ id: 7, x: 20.5, y: 1.2, surface: 'floor', goal: 'safe', cooldownTicks: 1e9 })];
    tick(w, 5 * TICK_HZ);
    const progress = w.state.loot.crack;
    expect(progress).toBeGreaterThan(0.2);
    shootAt(w, 20.5, 2.1);
    tick(w, 1);
    expect(w.state.loot).toMatchObject({ status: 'safe', crack: progress });
  });

  it('drops the loot where the carrier is shot, and the Rider walks over it to get it back', () => {
    const w = world();
    w.state.train.v = 10;
    placeRider(w, 24, 1.2, 'floor');
    Object.assign(w.state.loot, { status: 'carried', carrier: 7, crack: 1, everCracked: true });
    w.state.bandits = [bandit({ id: 7, x: 19, y: 1.2, surface: 'floor', goal: 'safe', hasLoot: true, mode: 'fleeing', cooldownTicks: 1e9 })];
    const ev = shootAt(w, 19, 2.1);
    expect(w.state.loot).toMatchObject({ status: 'dropped', carrier: null, y: 1.2 });
    expect(w.state.loot.x).toBeCloseTo(19, 6);
    expect(ev).toContainEqual({ type: 'lootDropped', x: 19, y: 1.2 });
    const back = tick(w, 3 * TICK_HZ, { moveX: -1 });
    expect(back).toContainEqual({ type: 'lootRecovered' });
    expect(w.state.loot.status).toBe('safe');
  });

  it('sends a safe-cracker for dropped loot if he gets there before the Rider', () => {
    const w = world();
    riderAway(w);
    w.state.train.v = 10;
    Object.assign(w.state.loot, { status: 'dropped', x: 18, y: 1.2, carrier: null, crack: 1, everCracked: true });
    w.state.bandits = [bandit({ id: 7, x: 23, y: 1.2, surface: 'floor', goal: 'safe' })];
    const ev = tick(w, 3 * TICK_HZ);
    expect(ev).toContainEqual({ type: 'lootTaken' });
    expect(w.state.loot).toMatchObject({ status: 'carried', carrier: 7 });
    expect(w.state.bandits[0].mode).toBe('fleeing');
  });

  it('holds up the Engineer from the cab until the bandit is shot', () => {
    const w = world();
    w.state.train.v = 10;
    placeRider(w, 32, 2.8, 'tenderTop');
    w.state.rider.invulnTicks = 1e9;
    w.state.horsemen = [horseman({ x: 38, targetX: 38, worldV: 10, goal: 'cab' })];
    const ev = tick(w, 2 * TICK_HZ);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'banditBoarded', into: 'cab' }));
    expect(w.state.train.heldUp).toBe(true);
    expect(w.state.bandits[0].mode).toBe('holdup');
    tick(w, TICK_HZ);
    expect(ev.filter((e) => e.type === 'heldUp').length).toBe(1);
    expect(w.state.stats.holdups).toBe(1);
    // From the deck, through the cab's open back.
    placeRider(w, 36.6, 1.4, 'tenderDeck');
    const b = w.state.bandits[0];
    shootAt(w, b.x, b.y + 0.9);
    expect(alive(b)).toBe(false);
    const after = tick(w, 1);
    expect(after).toContainEqual({ type: 'holdupEnded' });
    expect(w.state.train.heldUp).toBe(false);
  });

  it('powder horsemen shoot the powder car, and at 0 hit points it blows: the run is lost', () => {
    // Powder [15, 27] behind the tender, express [0, 15].
    const w = world(['powder', 'express']);
    w.state.train.v = 10;
    riderAway(w);
    w.state.horsemen = [horseman({ x: 21, targetX: 21, worldV: 10, goal: 'powder', tier: 3, cooldownTicks: 0 })];
    const ev = tick(w, 20 * TICK_HZ);
    const hits = ev.filter((e) => e.type === 'powderHit');
    const shots = ev.filter((e) => e.type === 'shot' && e.by === 'horseman');
    expect(hits.length).toBeGreaterThan(0);
    expect(shots.length).toBeGreaterThan(hits.length);
    const car = w.state.train.cars[2];
    expect(car.hp).toBe(CAR_SPECS.powder.hp - hits.length);
    expect(w.state.stats.carDamage).toBe(hits.length);
    expect(w.state.phase).toBe('running');
    car.hp = 1;
    const ev2 = tick(w, 30 * TICK_HZ);
    expect(ev2).toContainEqual(expect.objectContaining({ type: 'explosion', what: 'powder' }));
    expect(ev2).toContainEqual(expect.objectContaining({ type: 'lost', reason: 'powder' }));
    expect(w.state.phase).toBe('lost');
    expect(w.state.loss?.reason).toBe('powder');
  });
});

describe('determinism', () => {
  it('plays out the same way from the same seed', () => {
    const play = (seed: number): string => {
      const w = world(['express', 'powder', 'boxcar'], { seed });
      w.state.train.v = 12;
      spawnWave(w.ctx, wave({ count: 6, goal: 'mixed', tier: 3, boss: true }), []);
      for (let t = 0; t < 45 * TICK_HZ; t++) {
        const target = w.state.horsemen.find(alive);
        const r = w.state.rider;
        const aim = target ? Math.atan2(2.1 - (r.y + 1.35), target.x - r.x) : 0;
        const ev: SimEvent[] = [];
        stepRider(w.ctx, { ...NO_INPUT, firing: t % 30 === 0, firePressed: t % 30 === 0, aim }, ev);
        stepBandits(w.ctx, ev);
        w.state.tick++;
      }
      return JSON.stringify(w.state);
    };
    const a = play(11);
    expect(play(11)).toBe(a);
    expect(play(12)).not.toBe(a);
  });
});
