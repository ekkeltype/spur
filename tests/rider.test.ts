import { describe, expect, it } from 'vitest';
import { hurtRider } from '../src/sim/fight';
import { newGame } from '../src/sim/game';
import { framePath, framePoint, netIndex } from '../src/sim/network';
import { initialLoot, initialRider, stepRider, type FightCtx } from '../src/sim/rider';
import { RESPAWN_DOWN_SECONDS, RESPAWN_OFF_CABOOSE_SECONDS, RESPAWN_OFF_SECONDS, SCOPE_MAX, TICK_HZ } from '../src/sim/rules';
import {
  NO_INPUT,
  type BanditState,
  type CarType,
  type FrameHazard,
  type GameState,
  type HorsemanState,
  type RiderInput,
  type SimEvent,
  type SurfaceKind,
  type UpgradeId,
} from '../src/sim/types';
import { yRun } from './fixtures';

// Express + boxcar: L = 53. Loco [37, 53] (cab [37, 41.5]), tender [28, 37] (top [28, 36] at 2.8,
// deck [36, 37] at 1.4), express [13, 28] (body [13.8, 27.2], floor 1.2, roof 4.2, hatch at 20.5),
// boxcar [0, 13] (body [0.8, 12.2], floor 1.3, roof 4.0, hatch at 6.5).

interface World {
  state: GameState;
  ctx: FightCtx;
}

function world(consist: CarType[] = ['express', 'boxcar'], upgrades: UpgradeId[] = [], riderAssist = false): World {
  const run = yRun();
  const state = newGame(run, { seed: 7, consist, upgrades, assists: { rider: riderAssist, engineer: false } });
  state.rider = initialRider(state.train.cars, state.upgrades, state.assists);
  state.loot = initialLoot();
  const ctx: FightCtx = {
    state,
    run,
    hazards: [],
    trackPointAt: (x) => framePoint(framePath(netIndex(run), state.switches, state.train.spans, 0, 2000), x),
    scopeMax: SCOPE_MAX,
  };
  return { state, ctx };
}

function input(p: Partial<RiderInput> = {}): RiderInput {
  return { ...NO_INPUT, ...p };
}

/** Runs the Rider for n ticks with the same input (a press only on the first tick). */
function run(w: World, n: number, held: Partial<RiderInput> = {}, pressed: Partial<RiderInput> = {}): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    stepRider(w.ctx, input(i === 0 ? { ...held, ...pressed } : held), ev);
    w.state.tick++;
  }
  return ev;
}

function place(w: World, x: number, y: number, surface: SurfaceKind): void {
  Object.assign(w.state.rider, { x, y, vx: 0, vy: 0, onGround: true, surface, ladder: null, crouch: false });
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

/** The aim (radians) from the Rider's shoulder to a point. */
function aimAt(w: World, x: number, y: number): number {
  const r = w.state.rider;
  return Math.atan2(y - (r.y + (r.crouch ? 0.8 : 1.35)), x - r.x);
}

function shots(ev: SimEvent[]): Extract<SimEvent, { type: 'shot' }>[] {
  return ev.filter((e): e is Extract<SimEvent, { type: 'shot' }> => e.type === 'shot');
}

describe('the Rider at the start (spec §6.3)', () => {
  it('stands on the roof of the first car behind the tender with the hearts and guns owned', () => {
    const w = world();
    const r = w.state.rider;
    expect([r.x, r.y, r.surface, r.car, r.inside]).toEqual([20.5, 4.2, 'roof', 2, null]);
    expect(r.hearts).toBe(5);
    expect(r.maxHearts).toBe(5);
    expect(r.weapons).toEqual(['revolver']);
    expect(r.mode).toBe('active');
    const tough = initialRider(w.state.train.cars, ['extraHeart', 'rifle', 'shotgun'], { rider: true, engineer: false });
    expect(tough.maxHearts).toBe(8);
    expect(tough.hearts).toBe(8);
    expect(tough.weapons).toEqual(['revolver', 'shotgun', 'rifle']);
    // Nothing behind the tender: on the tender top.
    const bare = world([]);
    expect([bare.state.rider.y, bare.state.rider.surface, bare.state.rider.car]).toEqual([2.8, 'tenderTop', 1]);
  });
});

describe('walking and the wind (spec §6.3)', () => {
  it('walks at 4.5 m/s, slower into the wind and faster with it, and the wind turns round when reversing', () => {
    const w = world();
    place(w, 16, 4.2, 'roof');
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.vx).toBeCloseTo(4.5, 9);
    w.state.train.v = 25; // w = 1: into the wind 4.5 × 0.65, with it 4.5 × 1.25
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.vx).toBeCloseTo(2.925, 9);
    run(w, 30, { moveX: -1 });
    expect(w.state.rider.vx).toBeCloseTo(-5.625, 9);
    w.state.train.v = -25;
    run(w, 30, { moveX: -1 });
    expect(w.state.rider.vx).toBeCloseTo(-2.925, 9);
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.vx).toBeCloseTo(5.625, 9);
    // The wind is capped at w = 1.4.
    w.state.train.v = 40;
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.vx).toBeCloseTo(4.5 * (1 - 0.35 * 1.4), 9);
  });

  it('crouch-walks at 2 m/s, and feels no wind inside a car', () => {
    const w = world();
    place(w, 16, 4.2, 'roof');
    run(w, 30, { moveX: 1, down: true });
    expect(w.state.rider.crouch).toBe(true);
    expect(w.state.rider.vx).toBeCloseTo(2, 9);
    w.state.train.v = 25;
    place(w, 16, 1.2, 'floor');
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.inside).toBe(2);
    expect(w.state.rider.vx).toBeCloseTo(4.5, 9);
  });

  it('jumps about 1.5 m high for 0.75 s', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    let top = 0;
    let landedAt = -1;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 90 && landedAt < 0; i++) {
      stepRider(w.ctx, input(i === 0 ? { jump: true, jumpPressed: true } : {}), ev);
      top = Math.max(top, w.state.rider.y - 4.2);
      if (i > 0 && w.state.rider.onGround) landedAt = i;
    }
    expect(top).toBeGreaterThan(1.5);
    expect(top).toBeLessThan(1.55);
    expect(landedAt / TICK_HZ).toBeCloseTo(0.75, 1);
    expect(w.state.rider.x).toBeCloseTo(20, 9);
    expect(ev.filter((e) => e.type === 'jump').length).toBe(1);
    expect(ev.filter((e) => e.type === 'land').length).toBe(1);
  });

  it('clears a roof gap at low speed, but at full speed the wind drops you onto the platform below, unhurt', () => {
    const jumpForward = (v: number): World => {
      const w = world();
      w.state.train.v = v;
      place(w, 10, 4, 'roof'); // the boxcar roof, heading for the express
      let jumped = false;
      for (let i = 0; i < 4 * TICK_HZ; i++) {
        const go = !jumped && w.state.rider.x >= 12.3;
        if (go) jumped = true;
        stepRider(w.ctx, input({ moveX: jumped && !w.state.rider.onGround ? 0 : 1, jump: go, jumpPressed: go }), []);
        if (jumped && w.state.rider.onGround) break;
      }
      return w;
    };
    const slow = jumpForward(5).state.rider;
    expect([slow.surface, slow.y, slow.car]).toEqual(['roof', 4.2, 2]);
    const fast = jumpForward(30).state.rider;
    expect(fast.surface).toBe('platform');
    expect(fast.y).toBeLessThan(1.31);
    expect(fast.x).toBeGreaterThan(12.2);
    expect(fast.x).toBeLessThan(13.8);
    expect(fast.hearts).toBe(5);
    expect(fast.mode).toBe('active');
  });
});

describe('ladders, hatches and doorways (spec §6.2, §6.3)', () => {
  it('climbs a car-end ladder at 2.8 m/s, and climbs down again from the top with S', () => {
    const w = world();
    place(w, 13.6, 1.2, 'platform'); // the express's rear platform
    run(w, 1, { up: true, jump: true }, { jumpPressed: true });
    expect(w.state.rider.ladder).not.toBeNull();
    expect(w.state.rider.vy).toBe(0);
    run(w, 63, { up: true, jump: true });
    expect(w.state.rider.ladder).not.toBeNull(); // 3 m at 2.8 m/s takes 1.07 s
    run(w, 2, { up: true, jump: true });
    const r = w.state.rider;
    expect([r.ladder, r.surface, r.y, r.onGround]).toEqual([null, 'roof', 4.2, true]);
    expect(r.x).toBeCloseTo(14.15, 9);
    run(w, 1, { down: true }, { downPressed: true });
    expect(w.state.rider.ladder).not.toBeNull();
    run(w, 70, { down: true });
    expect([w.state.rider.surface, w.state.rider.y, w.state.rider.ladder]).toEqual(['platform', 1.2, null]);
  });

  it('drops through a roof hatch with S, and climbs back out from beneath it with W', () => {
    const w = world();
    place(w, 20.5, 4.2, 'roof');
    run(w, 40, {}, { down: true, downPressed: true });
    expect([w.state.rider.surface, w.state.rider.y, w.state.rider.inside]).toEqual(['floor', 1.2, 2]);
    run(w, 80, { up: true });
    expect([w.state.rider.surface, w.state.rider.y, w.state.rider.inside]).toEqual(['roof', 4.2, null]);
    // S elsewhere on a roof just crouches.
    place(w, 24, 4.2, 'roof');
    run(w, 10, { down: true }, { downPressed: true });
    expect([w.state.rider.crouch, w.state.rider.y]).toEqual([true, 4.2]);
  });

  it('walks through the doorways, the whole car, and up to the tender, where the coal bunker stops you', () => {
    const w = world();
    place(w, 13.55, 1.2, 'platform');
    run(w, TICK_HZ, { moveX: 1 });
    expect(w.state.rider.inside).toBe(2);
    expect(w.state.rider.surface).toBe('floor');
    run(w, 4 * TICK_HZ, { moveX: 1 });
    expect(w.state.rider.inside).toBeNull();
    expect(w.state.rider.surface).toBe('platform');
    expect(w.state.rider.x).toBeCloseTo(28 - 0.3, 6);
    // Up the tender's rear ladder and along the top, down to the deck and into the cab.
    run(w, 80, { up: true });
    expect(w.state.rider.surface).toBe('tenderTop');
    run(w, 3 * TICK_HZ, { moveX: 1 });
    expect(['tenderDeck', 'cabFloor']).toContain(w.state.rider.surface);
    run(w, 2 * TICK_HZ, { moveX: 1 });
    // The boiler is a wall.
    expect(w.state.rider.surface).toBe('cabFloor');
    expect(w.state.rider.inside).toBe(0);
    expect(w.state.rider.x).toBeCloseTo(41.5 - 0.3, 6);
  });
});

describe('tunnels and low bridges (spec §4.3)', () => {
  const tunnel = (x0: number): FrameHazard => ({ kind: 'tunnel', id: 't1', x0, x1: x0 + 300 });

  it('a tunnel portal knocks you off a roof or the cab roof, standing or crouching', () => {
    for (const [x, y, surface, crouch] of [
      [20, 4.2, 'roof', false],
      [20, 4.2, 'roof', true],
      [39, 4, 'cabRoof', false],
    ] as const) {
      const w = world();
      place(w, x, y, surface);
      w.ctx.hazards = [tunnel(x + 0.5)];
      run(w, 5, { down: crouch });
      expect(w.state.rider.mode).toBe('active');
      w.ctx.hazards = [tunnel(x - 0.1)];
      const ev = run(w, 1, { down: crouch });
      expect(w.state.rider.mode).toBe('off');
      expect(ev).toContainEqual({ type: 'riderOff', cause: 'tunnel' });
      expect(ev).toContainEqual({ type: 'riderHurt', cause: 'tunnel', hearts: 4 });
    }
  });

  it('the tender top, the platforms, the cab floor and the insides are safe in a tunnel', () => {
    for (const [x, y, surface] of [
      [32, 2.8, 'tenderTop'],
      [13.55, 1.2, 'platform'],
      [39, 1.4, 'cabFloor'],
      [20, 1.2, 'floor'],
    ] as const) {
      const w = world();
      place(w, x, y, surface);
      w.ctx.hazards = [tunnel(-100)];
      run(w, 30);
      expect(w.state.rider.mode).toBe('active');
    }
  });

  /** Sweeps a low bridge's beam from ahead of the Rider to behind, at the train's speed. */
  function sweep(w: World, fromX: number, held: Partial<RiderInput> = {}): SimEvent[] {
    const ev: SimEvent[] = [];
    let bx = fromX;
    for (let i = 0; i < 40; i++) {
      w.ctx.hazards = [{ kind: 'lowBridge', id: 'b1', x0: bx, x1: bx }];
      ev.push(...run(w, 1, held));
      bx -= w.state.train.v / TICK_HZ;
    }
    return ev;
  }

  it('a low bridge knocks down a Rider standing on a roof: a heart and a second of stun', () => {
    const w = world();
    w.state.train.v = 12;
    place(w, 20, 4.2, 'roof');
    const ev = sweep(w, 22);
    const r = w.state.rider;
    expect(ev.filter((e) => e.type === 'riderHurt')).toEqual([{ type: 'riderHurt', cause: 'bridge', hearts: 4 }]);
    expect([r.mode, r.y, r.surface]).toEqual(['active', 4.2, 'roof']);
    expect(r.stunTicks).toBeGreaterThan(0);
    // Stunned, the Rider can't move.
    run(w, 10, { moveX: 1 });
    expect(r.x).toBeCloseTo(20, 9);
    run(w, TICK_HZ);
    run(w, 10, { moveX: 1 });
    expect(r.x).toBeGreaterThan(20.3);
  });

  it('crouching passes under a low bridge, and so does anyone on the tender top or in a car', () => {
    for (const [x, y, surface, crouch] of [
      [20, 4.2, 'roof', true],
      [32, 2.8, 'tenderTop', false],
      [20, 1.2, 'floor', false],
    ] as const) {
      const w = world();
      w.state.train.v = 12;
      place(w, x, y, surface);
      const ev = sweep(w, x + 2, { down: crouch });
      expect(ev.some((e) => e.type === 'riderHurt')).toBe(false);
      expect(w.state.rider.hearts).toBe(5);
    }
  });
});

describe('shooting (spec §6.4)', () => {
  it('hits a boarded bandit in the line of sight, with a tracer from the shoulder', () => {
    const w = world();
    place(w, 16, 4.2, 'roof');
    w.state.bandits = [bandit({ x: 22 })];
    const ev = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 22, 5.1) });
    const s = shots(ev);
    expect(s.length).toBe(1);
    expect(s[0]).toMatchObject({ by: 'rider', weapon: 'revolver', layer: 'train', hit: 'bandit', x0: 16 });
    expect(s[0].y0).toBeCloseTo(5.55, 9);
    expect(s[0].x1).toBeCloseTo(21.7, 1);
    expect(w.state.bandits[0].hp).toBe(0);
    expect(w.state.bandits[0].mode).toBe('falling');
    expect(ev).toContainEqual({ type: 'banditDown', id: 90, x: 22, y: 4.2, boss: false });
    expect(w.state.stats).toMatchObject({ shotsFired: 1, hits: 1, banditsDowned: 1 });
    expect(w.state.rider.ammo.revolver).toBe(5);
  });

  it('is stopped by a roof or a wall', () => {
    const w = world();
    place(w, 16, 4.2, 'roof');
    w.state.bandits = [bandit({ x: 22, y: 1.2, surface: 'floor' })]; // inside the express, under the Rider's roof
    const ev = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 22, 2.1) });
    expect(shots(ev)[0]).toMatchObject({ layer: 'train', hit: 'car' });
    expect(w.state.bandits[0].hp).toBe(1);
    expect(w.state.stats).toMatchObject({ shotsFired: 1, hits: 0 });
    // Through the doorway from the platform, it hits.
    place(w, 13.55, 1.2, 'platform');
    run(w, 30);
    const ev2 = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 22, 2.1) });
    expect(shots(ev2)[0].hit).toBe('bandit');
  });

  it('hits horsemen from outside, never their horses, and not at all from inside a car', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    w.state.horsemen = [horseman({ x: 24, hp: 2, tier: 2 })];
    const ev = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 24, 2.1) });
    expect(shots(ev)[0]).toMatchObject({ layer: 'trackside', hit: 'horseman' });
    expect(w.state.horsemen[0].hp).toBe(1);
    run(w, 30);
    const horse = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 24, 1.0) });
    expect(shots(horse)[0].hit).not.toBe('horseman');
    expect(w.state.horsemen[0].hp).toBe(1);
    // From inside the express the horseman can't be hit.
    place(w, 20, 1.2, 'floor');
    run(w, 30);
    const inside = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 24, 2.1) });
    expect(shots(inside)[0].layer).toBe('train');
    expect(w.state.horsemen[0].hp).toBe(1);
  });

  it('shoots trackside through the armored car\'s gun slits, and kills a horseman', () => {
    const w = world(['armored', 'boxcar']); // armored [13, 26], body [13.8, 25.2], floor 1.3
    place(w, 20, 1.3, 'floor');
    w.state.horsemen = [horseman({ x: 24 })];
    const ev = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 24, 2.1) });
    expect(w.state.rider.inside).toBe(2);
    expect(shots(ev)[0]).toMatchObject({ layer: 'trackside', hit: 'horseman' });
    expect(w.state.horsemen[0].mode).toBe('falling');
    expect(ev).toContainEqual({ type: 'horsemanDown', id: 80, x: 24, boss: false });
    expect(w.state.stats.horsemenDowned).toBe(1);
  });

  it('fires at the weapon\'s rate, reloads with R, and reloads by itself on an empty click', () => {
    const w = world(['express', 'boxcar'], ['quickReload']);
    place(w, 16, 4.2, 'roof');
    // Holding the trigger fires every 0.28 s (17 ticks).
    const held = run(w, 17 * 5 + 1, { firing: true, aim: 0.3 }, { firePressed: true });
    expect(shots(held).length).toBe(6);
    expect(w.state.rider.ammo.revolver).toBe(0);
    const click = run(w, 1, {}, { firePressed: true, firing: true });
    expect(click).toContainEqual({ type: 'dryFire' });
    expect(click).toContainEqual({ type: 'reload', weapon: 'revolver' });
    // 1.6 s × 0.65 with the speed loader.
    run(w, Math.round(1.6 * 0.65 * TICK_HZ) - 2);
    expect(w.state.rider.ammo.revolver).toBe(0);
    run(w, 2);
    expect(w.state.rider.ammo.revolver).toBe(6);
    // R tops up a part-empty cylinder in the full 1.6 s without the upgrade.
    const w2 = world();
    place(w2, 16, 4.2, 'roof');
    run(w2, 1, {}, { firePressed: true, firing: true, aim: 0.3 });
    const r = run(w2, 1, {}, { reloadPressed: true });
    expect(r).toContainEqual({ type: 'reload', weapon: 'revolver' });
    run(w2, 1.6 * TICK_HZ - 2);
    expect(w2.state.rider.ammo.revolver).toBe(5);
    run(w2, 2);
    expect(w2.state.rider.ammo.revolver).toBe(6);
  });

  it('switches to owned weapons only; the shotgun fires six pellets', () => {
    const w = world(['express', 'boxcar'], ['shotgun']);
    place(w, 16, 4.2, 'roof');
    run(w, 1, {}, { weaponPressed: 'rifle' });
    expect(w.state.rider.weapon).toBe('revolver');
    run(w, 1, {}, { weaponPressed: 'next' });
    expect(w.state.rider.weapon).toBe('shotgun');
    run(w, 30);
    w.state.bandits = [bandit({ x: 20, hp: 2, tier: 2 })];
    const ev = run(w, 1, {}, { firePressed: true, firing: true, aim: aimAt(w, 20, 5.1) });
    const s = shots(ev);
    expect(s.length).toBe(6);
    expect(s.every((q) => q.weapon === 'shotgun')).toBe(true);
    expect(w.state.bandits[0].mode).toBe('falling');
    expect(w.state.stats.shotsFired).toBe(1);
    expect(w.state.rider.ammo.shotgun).toBe(1);
    run(w, 1, {}, { weaponPressed: 'next' });
    expect(w.state.rider.weapon).toBe('revolver');
  });

  it('aim assist snaps a shot within 6° onto the target', () => {
    // Express + passenger: express [17, 32], passenger [0, 17]; both roofs at 4.2.
    const miss = world(['express', 'passenger']);
    place(miss, 2, 4.2, 'roof');
    miss.state.bandits = [bandit({ x: 27 })];
    const high = aimAt(miss, 27, 7.1); // 2 m over the chest, 25 m away: 4.6° off
    run(miss, 1, {}, { firePressed: true, firing: true, aim: high });
    expect(miss.state.bandits[0].hp).toBe(1);
    const hit = world(['express', 'passenger'], [], true);
    place(hit, 2, 4.2, 'roof');
    hit.state.bandits = [bandit({ x: 27 })];
    run(hit, 1, {}, { firePressed: true, firing: true, aim: high });
    expect(hit.state.bandits[0].hp).toBe(0);
    // 8° off is too far to snap.
    const far = world(['express', 'passenger'], [], true);
    place(far, 2, 4.2, 'roof');
    far.state.bandits = [bandit({ x: 27 })];
    run(far, 1, {}, { firePressed: true, firing: true, aim: aimAt(far, 27, 5.1) + (8 * Math.PI) / 180 });
    expect(far.state.bandits[0].hp).toBe(1);
  });
});

describe('the spyglass and flags (spec §6.5)', () => {
  it('scopes from a roof, the tender top, the cab roof or the cupola; not inside, on a platform or in a tunnel', () => {
    for (const [consist, x, y, surface, ok] of [
      [['express', 'boxcar'], 20, 4.2, 'roof', true],
      [['express', 'boxcar'], 32, 2.8, 'tenderTop', true],
      [['express', 'boxcar'], 39, 4, 'cabRoof', true],
      [['caboose'], 5, 4.7, 'cupola', true],
      [['express', 'boxcar'], 20, 1.2, 'floor', false],
      [['express', 'boxcar'], 13.55, 1.2, 'platform', false],
      [['express', 'boxcar'], 39, 1.4, 'cabFloor', false],
    ] as const) {
      const w = world([...consist]);
      place(w, x, y, surface);
      run(w, 2, { scope: true });
      expect(w.state.rider.scoped).toBe(ok);
    }
    const w = world();
    place(w, 32, 2.8, 'tenderTop');
    w.ctx.hazards = [{ kind: 'tunnel', id: 't', x0: 20, x1: 300 }];
    run(w, 2, { scope: true });
    expect(w.state.rider.scoped).toBe(false);
  });

  it('holds the Rider still and pans the view with the pointer, smoothly, up to the reach of the glass', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    run(w, 3 * TICK_HZ, { scope: true, scopeT: 1, moveX: 1 });
    expect(w.state.rider.x).toBe(20);
    expect(w.state.rider.scopeDist).toBeCloseTo(SCOPE_MAX, 0);
    run(w, 1, { scope: true, scopeT: 0 });
    expect(w.state.rider.scopeDist).toBeLessThan(SCOPE_MAX - 1);
    expect(w.state.rider.scopeDist).toBeGreaterThan(SCOPE_MAX - 100);
    run(w, 3 * TICK_HZ, { scope: true, scopeT: 0 });
    expect(w.state.rider.scopeDist).toBeCloseTo(60, 0);
    // At night the glass reaches 300 m.
    w.ctx.scopeMax = 300;
    run(w, 3 * TICK_HZ, { scope: true, scopeT: 1 });
    expect(w.state.rider.scopeDist).toBeCloseTo(300, 0);
    // Letting go: free to walk again.
    run(w, 30, { moveX: 1 });
    expect(w.state.rider.scoped).toBe(false);
    expect(w.state.rider.x).toBeGreaterThan(20.5);
  });

  it('places a flag at the middle of the view on a click, instead of shooting; at most 3, each for 90 s', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    run(w, 3 * TICK_HZ, { scope: true, scopeT: 0.5 });
    const ev = run(w, 1, { scope: true, scopeT: 0.5 }, { flagPressed: true, firePressed: true, firing: true });
    expect(shots(ev).length).toBe(0);
    expect(w.state.flags.length).toBe(1);
    const flag = w.state.flags[0];
    expect(ev).toContainEqual({ type: 'flagPlaced', flag });
    // The train's front is at e1:200 heading toward b; the flag is scopeDist beyond it.
    expect(flag.point.edge).toBe('e1');
    expect(flag.point.off).toBeCloseTo(200 + w.state.rider.scopeDist, 1);
    expect(flag.tick).toBe(w.state.tick - 1);
    for (let i = 0; i < 3; i++) run(w, 1, { scope: true, scopeT: 0.2 + 0.2 * i }, { flagPressed: true });
    expect(w.state.flags.length).toBe(3);
    expect(w.state.flags.map((f) => f.id)).not.toContain(flag.id);
    run(w, 90 * TICK_HZ - 5);
    expect(w.state.flags.length).toBe(3);
    run(w, 10);
    expect(w.state.flags.length).toBe(0);
  });

  it('drops a flag once the train has passed it', () => {
    const w = world();
    w.state.flags = [{ id: 1, point: { edge: 'e1', off: 180 }, tick: 0 }]; // under the loco
    w.state.flags.push({ id: 2, point: { edge: 'e1', off: 400 }, tick: 0 }); // ahead
    run(w, 1);
    expect(w.state.flags.map((f) => f.id)).toEqual([2]);
  });
});

describe('the caboose, loot and bookkeeping (spec §5.1, §6.6)', () => {
  it('heals a heart every 20 s inside the caboose, up to the maximum', () => {
    const w = world(['express', 'caboose']); // caboose [0, 10], body [0.8, 9.2], floor 1.2
    place(w, 5, 1.2, 'floor');
    w.state.rider.hearts = 3;
    run(w, 20 * TICK_HZ - 1);
    expect(w.state.rider.inside).toBe(3);
    expect(w.state.rider.hearts).toBe(3);
    run(w, 1);
    expect(w.state.rider.hearts).toBe(4);
    run(w, 40 * TICK_HZ);
    expect(w.state.rider.hearts).toBe(5);
    // Not on its roof.
    const roof = world(['express', 'caboose']);
    place(roof, 2, 4, 'roof');
    roof.state.rider.hearts = 3;
    run(roof, 21 * TICK_HZ);
    expect(roof.state.rider.hearts).toBe(3);
  });

  it('recovers dropped loot by walking over it, back to the safe at once', () => {
    const w = world();
    place(w, 16, 4.2, 'roof');
    Object.assign(w.state.loot, { status: 'dropped', x: 18, y: 4.2, carrier: null, crack: 1, everCracked: true });
    const ev = run(w, TICK_HZ, { moveX: 1 });
    expect(ev).toContainEqual({ type: 'lootRecovered' });
    expect(w.state.loot).toMatchObject({ status: 'safe', crack: 0, carrier: null, everCracked: true });
    // Loot on the platform below isn't reached from the roof.
    const w2 = world();
    place(w2, 26, 4.2, 'roof');
    Object.assign(w2.state.loot, { status: 'dropped', x: 27.45, y: 1.2, carrier: null });
    run(w2, 20, { moveX: 1 });
    expect(w2.state.loot.status).toBe('dropped');
  });

  it('keeps the whereabouts current and remembers moving fast (for the bandits\' aim)', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    run(w, 5);
    expect(w.state.rider.lastFastTick).toBe(-1000);
    run(w, 30, { moveX: -1 });
    expect(w.state.rider.lastFastTick).toBe(w.state.tick - 1);
    expect(w.state.rider.car).toBe(2);
    place(w, 5, 1.3, 'floor');
    run(w, 1);
    expect([w.state.rider.car, w.state.rider.inside]).toEqual([3, 3]);
  });
});

describe('falling off and respawning (spec §6.3)', () => {
  it('falls off the rear, loses a heart, and is back on the rear-most platform after 6 s', () => {
    const w = world();
    place(w, 0.55, 1.3, 'platform');
    const r = w.state.rider;
    const ev: SimEvent[] = [];
    for (let i = 0; i < TICK_HZ && r.mode === 'active'; i++) ev.push(...run(w, 1, { moveX: -1 }));
    expect(r.mode).toBe('off');
    expect(r.hearts).toBe(4);
    expect(ev).toContainEqual({ type: 'riderOff', cause: 'fall' });
    expect(ev).toContainEqual({ type: 'riderHurt', cause: 'fall', hearts: 4 });
    expect(w.state.stats.timesOff).toBe(1);
    expect(w.state.stats.heartsLost).toBe(1);
    const quiet = run(w, RESPAWN_OFF_SECONDS * TICK_HZ - 1, { moveX: -1 });
    expect(quiet.some((e) => e.type === 'riderBack')).toBe(false);
    const back = run(w, 1);
    expect(back).toContainEqual({ type: 'riderBack' });
    expect([r.mode, r.x, r.y, r.surface, r.hearts]).toEqual(['active', 0.55, 1.3, 'platform', 4]);
  });

  it('comes back sooner with a caboose', () => {
    const w = world(['express', 'caboose']);
    const last = w.state.train.cars[3];
    place(w, last.x0 + 0.55, 1.2, 'platform');
    run(w, TICK_HZ, { moveX: -1 });
    expect(w.state.rider.mode).toBe('off');
    const ev = run(w, RESPAWN_OFF_CABOOSE_SECONDS * TICK_HZ);
    expect(ev).toContainEqual({ type: 'riderBack' });
  });

  it('goes down on a fall from a trestle, or at 0 hearts, and comes back with full hearts after 10 s', () => {
    const w = world();
    const trestle: FrameHazard = { kind: 'trestle', id: 'tr', x0: -200, x1: 30 };
    w.ctx.hazards = [trestle];
    place(w, 0.55, 1.3, 'platform');
    const ev = run(w, TICK_HZ, { moveX: -1 });
    expect(w.state.rider.mode).toBe('down');
    expect(ev).toContainEqual({ type: 'riderDown' });
    expect(w.state.stats.timesDown).toBe(1);
    const back = run(w, RESPAWN_DOWN_SECONDS * TICK_HZ);
    expect(back).toContainEqual({ type: 'riderBack' });
    expect(w.state.rider.hearts).toBe(5);

    const w2 = world();
    w2.state.rider.hearts = 1;
    place(w2, 0.55, 1.3, 'platform');
    const ev2 = run(w2, TICK_HZ, { moveX: -1 });
    expect(w2.state.rider.mode).toBe('down');
    expect(w2.state.rider.hearts).toBe(0);
    expect(ev2).toContainEqual({ type: 'riderDown' });
    run(w2, RESPAWN_DOWN_SECONDS * TICK_HZ);
    expect([w2.state.rider.mode, w2.state.rider.hearts]).toEqual(['active', 5]);
  });

  it('is invulnerable for 0.8 s after a hit', () => {
    const w = world();
    place(w, 20, 4.2, 'roof');
    const ev: SimEvent[] = [];
    expect(hurtRider(w.ctx, 'bullet', ev)).toBe(true);
    expect(hurtRider(w.ctx, 'bullet', ev)).toBe(false);
    run(w, Math.round(0.8 * TICK_HZ) - 1);
    expect(hurtRider(w.ctx, 'bullet', ev)).toBe(false);
    run(w, 1);
    expect(hurtRider(w.ctx, 'bullet', ev)).toBe(true);
    expect(w.state.rider.hearts).toBe(3);
    expect(ev.filter((e) => e.type === 'riderHurt').map((e) => e.type === 'riderHurt' && e.hearts)).toEqual([4, 3]);
  });

  it('takes no heart in god mode', () => {
    const w = world();
    w.state.godMode = true;
    place(w, 0.55, 1.3, 'platform');
    run(w, TICK_HZ, { moveX: -1 });
    expect(w.state.rider.mode).toBe('off');
    expect(w.state.rider.hearts).toBe(5);
  });
});
