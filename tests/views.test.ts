// The information boundary (spec §2, §16.3): what the Engineer receives must not depend on anything
// only the Rider can see, apart from the documented fields (held up, cargo stolen, the Rider's
// whereabouts). And trackside() must place the world correctly in the train frame.

import { describe, expect, it } from 'vitest';
import { newGame } from '../src/sim/game';
import type { AiTrainDef, GameState, RunDef, SimEvent } from '../src/sim/types';
import { filterForEngineer, toEngineerRun, toEngineerView, trackside } from '../src/sim/views';
import { loopRun, yRun } from './fixtures';

const ASSISTS = { rider: false, engineer: false };

const freight: AiTrainDef = {
  id: 'f7',
  name: 'No. 7 Freight',
  kind: 'freight',
  cars: 8,
  length: 150,
  route: [
    { edge: 'm3', dir: -1 },
    { edge: 'm2', dir: -1 },
    { edge: 'm1', dir: -1 },
  ],
  depart: 12 * 3600,
  speed: 10,
  stops: [],
  charted: true,
};

const runaway: AiTrainDef = {
  id: 'runaway',
  name: 'Runaway cars',
  kind: 'runaway',
  cars: 3,
  length: 40,
  route: [],
  depart: 0,
  speed: 0,
  stops: [],
  charted: false,
  runaway: { start: { edge: 'm3', off: 900 }, dir: -1, trigger: { edge: 'm1', off: 500 }, telegram: 'Cars loose at the east end.' },
};

function hiddenRun(): RunDef {
  return loopRun({
    aiTrains: [freight, runaway],
    obstacles: [{ id: 'rocks1', kind: 'rocks', edge: 'm2', at: 200 }],
    waves: [{ id: 'w1', trigger: { edge: 'm1', off: 400 }, count: 3, from: 'rear', goal: 'mixed', tier: 1 }],
    variants: ['A', 'B'],
    plan: {
      A: { cruise: 15, switches: [], stops: [], holds: [], whistles: [], minSpeeds: [] },
      B: { cruise: 15, switches: [], stops: [], holds: [], whistles: [], minSpeeds: [] },
    },
  });
}

describe('toEngineerRun', () => {
  it('strips obstacles, waves, the plan, the variants and uncharted trains', () => {
    const e = toEngineerRun(hiddenRun()) as unknown as Record<string, unknown>;
    expect(e.obstacles).toBeUndefined();
    expect(e.waves).toBeUndefined();
    expect(e.plan).toBeUndefined();
    expect(e.variants).toBeUndefined();
    expect((e.aiTrains as AiTrainDef[]).map((t) => t.id)).toEqual(['f7']);
    // Nothing about the runaway anywhere in the payload.
    expect(JSON.stringify(e)).not.toMatch(/runaway|Cars loose/i);
  });
});

describe('toEngineerView leaks nothing hidden', () => {
  const run = hiddenRun();
  const base = (): GameState => newGame(run, { seed: 7, consist: ['express', 'boxcar'], upgrades: [], assists: ASSISTS });

  it('ignores bandits, horsemen, obstacles, cracking progress, the Rider’s private state and the runaway', () => {
    const a = base();
    const b = base();
    const r = b.rider;
    b.horsemen.push({
      id: 9, x: -20, worldV: 12, hp: 2, tier: 2, boss: false, goal: 'safe', mode: 'approach', modeTicks: 5,
      stamina: 8, targetX: 40, aimTicks: 10, cooldownTicks: 0, behindTicks: 0, pickup: false, shyTicks: 0,
    });
    b.bandits.push({
      id: 10, x: 30, y: 4.2, vx: 1, vy: 0, onGround: true, surface: 'roof', ladder: null, crouch: false, facing: 1,
      hp: 2, tier: 2, boss: false, goal: 'safe', mode: 'moving', modeTicks: 0, hasLoot: false, aimTicks: 0,
      cooldownTicks: 0, stunTicks: 0, navTarget: null,
    });
    b.obstacles[0].state = 'hit';
    b.loot.status = 'cracking';
    b.loot.crack = 0.6;
    b.loot.everCracked = true;
    r.hearts = 1;
    r.ammo.revolver = 0;
    r.aim = 2;
    r.scoped = true;
    r.scopeDist = 400;
    r.x += 0.5; // still on the same car's roof
    b.ai[1] = { ...b.ai[1], active: true, started: true, spans: [{ edge: 'm3', from: 900, to: 860 }], v: 5 };
    b.waves[0].triggered = true;
    b.stats.hits = 7;
    b.stats.banditsDowned = 3;
    b.rng = [1, 2, 3, 4];
    expect(toEngineerView(b, run)).toEqual(toEngineerView(a, run));
  });

  it('does change for the documented fields', () => {
    const a = base();
    const held = base();
    held.train.heldUp = true;
    expect(toEngineerView(held, run).train.heldUp).toBe(true);
    const stolen = base();
    stolen.loot.status = 'stolen';
    expect(toEngineerView(stolen, run).cargo).toBe('stolen');
    const off = base();
    off.rider.mode = 'off';
    expect(toEngineerView(off, run).rider.mode).toBe('off');
    expect(toEngineerView(a, run).cargo).toBe('ok');
  });

  it('shows a charted train only within sight', () => {
    const s = base();
    s.ai[0] = { ...s.ai[0], active: true, spans: [{ edge: 'm3', from: 1000, to: 900 }], v: 10 };
    // Our train is at m1 ~300 (main 300); the freight's front at main 2300: out of sight.
    expect(toEngineerView(s, run).trains).toEqual([]);
    s.ai[0].spans = [
      { edge: 'm2', from: 300, to: 150 },
    ];
    expect(toEngineerView(s, run).trains.map((t) => t.id)).toEqual(['f7']);
  });
});

describe('filterForEngineer', () => {
  it('passes the Engineer’s events and drops the Rider’s', () => {
    const keep: SimEvent[] = [
      { type: 'switchThrown', junction: 'P', state: 'reverse', by: 'engineer' },
      { type: 'telegram', id: 't', text: 'hello' },
      { type: 'heldUp' },
      { type: 'lootStolen' },
      { type: 'stationDone', stationId: 'dest' },
      { type: 'won' },
    ];
    for (const e of keep) expect(filterForEngineer(e)).toEqual(e);
    const drop: SimEvent[] = [
      { type: 'aim', by: 'horseman', id: 3 },
      { type: 'banditBoarded', id: 1, x: 3, y: 4, into: 'cab' },
      { type: 'lootDropped', x: 1, y: 2 },
      { type: 'safeCracking', progress: 0.5 },
      { type: 'powderHit', hp: 3 },
      { type: 'obstacleHit', id: 'rocks1', kind: 'rocks', severe: false },
      { type: 'obstacleCleared', id: 'c', kind: 'cattle' },
      { type: 'runawayLoose', id: 'runaway' },
      { type: 'waveSpawned', id: 'w1', count: 3, from: 'rear' },
      { type: 'riderHurt', cause: 'bullet', hearts: 2 },
      { type: 'horsemanDown', id: 3, x: 1, boss: false },
    ];
    for (const e of drop) expect(filterForEngineer(e)).toBeNull();
  });

  it('turns shots into muffled gunfire without positions, and hides signal aspects', () => {
    const shot: SimEvent = { type: 'shot', by: 'horseman', weapon: 'revolver', layer: 'trackside', x0: 1, y0: 2, x1: 3, y1: 4, hit: 'none' };
    const g = filterForEngineer(shot);
    expect(g?.type).toBe('gunfire');
    expect(Object.keys(g ?? {}).sort()).toEqual(['intensity', 'type']);
    expect(filterForEngineer({ type: 'signalPassed', id: 's1', aspect: 'stop' })).toEqual({ type: 'signalPassed', id: 's1' });
  });
});

describe('trackside', () => {
  it('places features ahead, under and behind the train in the train frame', () => {
    const run = yRun({
      tunnels: [{ id: 't1', edge: 'e1', from: 400, to: 600, name: 'Juniper Tunnel' }],
      lowBridges: [{ id: 'b1', edge: 'e1', at: 150 }],
      trestles: [{ id: 'r1', edge: 'e2', from: 100, to: 200, name: 'Sage Creek', burning: { minSpeed: 13.4 } }],
      waterTowers: [{ id: 'w1', edge: 'e1', at: 700 }],
      curves: [{ id: 'c1', edge: 'e1', from: 800, to: 900, limit: 11 }],
      mileposts: [{ edge: 'e1', at: 804.67, mile: 0.5 }],
      signals: [
        { id: 's1', edge: 'e1', at: 650, facing: 1, kind: 'junction', junction: 'J1' },
        { id: 's2', edge: 'e1', at: 660, facing: -1, kind: 'block' },
      ],
    });
    const s = newGame(run, { seed: 1, consist: [], upgrades: [], assists: ASSISTS });
    // Loco + tender = 25 m; the loco's front at e1 200 → the rear at e1 175 (x = 0).
    const L = s.train.length;
    expect(L).toBe(25);
    const items = trackside(s, run, 100, 1200);
    const find = (kind: string, id?: string) => items.find((i) => i.kind === kind && (id === undefined || ('id' in i && i.id === id)));
    expect(find('tunnel', 't1')).toMatchObject({ x0: L + 200, x1: L + 400 });
    expect(find('lowBridge', 'b1')).toMatchObject({ x: -25 }); // 25 m behind the rear
    expect(find('water', 'w1')).toMatchObject({ x: L + 500, spoutDown: false });
    expect(find('signal', 's1')).toMatchObject({ x: L + 450, facing: 'toward', heads: 2 });
    expect(find('signal', 's2')).toMatchObject({ facing: 'away', heads: 1 });
    expect(find('curve', 'c1')).toMatchObject({ x0: L + 600, x1: L + 700, limit: 11 });
    expect(find('junction', 'J1')).toMatchObject({ x: L + 800, state: 'normal' });
    expect(find('trestle', 'r1')).toMatchObject({ x0: L + 900, x1: L + 1000, burning: true });
    expect(find('station', 'orig')).toMatchObject({ x: L });
    const terrain = items.filter((i) => i.kind === 'terrain');
    expect(terrain[0]).toMatchObject({ x0: -100 });
  });

  it('shows another train on our own track ahead, and one on the parallel track beside us', () => {
    const run = loopRun({ aiTrains: [freight] });
    const s = newGame(run, { seed: 1, consist: [], upgrades: [], assists: ASSISTS });
    const L = s.train.length; // front at m1 300
    s.ai[0] = { ...s.ai[0], active: true, spans: [{ edge: 'm1', from: 900, to: 750 }], v: 10 };
    let t = trackside(s, run, 50, 1000).find((i) => i.kind === 'train');
    expect(t).toMatchObject({ lane: 'same', x0: L + 450, x1: L + 600 });
    // Now we stand in the siding (s1) and the freight passes on the main (m2).
    s.switches.P = 'reverse';
    s.train.spans = [{ edge: 's1', from: 100, to: 125 }];
    s.ai[0].spans = [{ edge: 'm2', from: 300, to: 200 }];
    t = trackside(s, run, 50, 1000).find((i) => i.kind === 'train');
    // Our front is at main 1125; the freight covers main 1200..1300 → x = L + 75 .. L + 175.
    expect(t).toMatchObject({ lane: 'adjacent', x0: L + 75, x1: L + 175 });
  });
});
