// What each seat hears (spec §18.3): the mapping from game state and events to the audio engine's
// layers and one-shots, checked against a recording stand-in for Sfx.

import { describe, expect, it } from 'vitest';
import type { Sfx } from '../src/audio/sfx';
import { RUNS } from '../src/content/runs';
import { newGame } from '../src/sim/game';
import { LURCH_COOLDOWN_SECONDS, TICK_HZ } from '../src/sim/rules';
import type { EngineerView, GameState, HorsemanState, RunDef, SimEvent } from '../src/sim/types';
import { brakeLevel, CAB_BEHIND_FRONT, CabSounds, FORD_HEARD_AHEAD, fordLevel, herdGain, panOf, RiderSounds, windLevel } from '../src/ui/sounds';

const rider = (patch: Partial<Parameters<typeof windLevel>[0]> = {}) => ({ mode: 'active' as const, inside: null, surface: 'roof' as const, ladder: null, ...patch });

interface Call {
  name: string;
  args: unknown[];
}

/** An Sfx that records what it's asked to play. */
function recorder(): { sfx: Sfx; calls: Call[]; named: (name: string) => Call[]; clear: () => void } {
  const calls: Call[] = [];
  const sfx = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args: unknown[]): void => {
          calls.push({ name: String(name), args });
        },
    },
  ) as unknown as Sfx;
  return { sfx, calls, named: (name) => calls.filter((c) => c.name === name), clear: () => (calls.length = 0) };
}

function game(run: RunDef = RUNS[0]): GameState {
  return newGame(run, { seed: 3, consist: ['express', 'boxcar'], upgrades: [], assists: { rider: false, engineer: false } });
}

/** RUNS[0] with a ford over the front `over` metres of the train as it stands at the start, reaching `beyond` past its front. */
function fordedRun(over: number, beyond: number): RunDef {
  const r = structuredClone(RUNS[0]);
  const { edge, off, dir } = r.start;
  const len = r.edges.find((e) => e.id === edge)?.length ?? 0;
  const a = Math.min(len, Math.max(0, off - dir * over));
  const b = Math.min(len, Math.max(0, off + dir * beyond));
  r.fords.push({ id: 'f1', edge, from: Math.min(a, b), to: Math.max(a, b), name: 'Test Ford' });
  return r;
}

function horseman(id: number, x: number): HorsemanState {
  return { id, x, worldV: 10, hp: 1, tier: 1, boss: false, goal: 'safe', mode: 'pace', modeTicks: 0, stamina: 8, targetX: x, aimTicks: 0, cooldownTicks: 0, behindTicks: 0, pickup: false, shyTicks: 60 };
}

describe('the Rider’s soundscape', () => {
  it('wind: full on top, about half on platforms and ladders, none inside or off the train', () => {
    expect(windLevel(rider(), 25)).toBeCloseTo(1 / 1.4);
    expect(windLevel(rider(), 40)).toBe(1);
    expect(windLevel(rider({ surface: 'tenderTop' }), 25)).toBeCloseTo(1 / 1.4);
    expect(windLevel(rider({ surface: 'platform' }), 40)).toBe(0.5);
    expect(windLevel(rider({ surface: null, ladder: 2 }), 40)).toBe(0.5);
    expect(windLevel(rider({ surface: null }), 40)).toBe(1); // in the air between roofs
    expect(windLevel(rider({ surface: 'floor', inside: 3 }), 40)).toBe(0);
    expect(windLevel(rider({ surface: 'cabFloor' }), 40)).toBe(0);
    expect(windLevel(rider({ mode: 'off' }), 40)).toBe(0);
    expect(windLevel(rider(), 0)).toBe(0);
  });

  it('brakes squeal only while the wheels turn', () => {
    expect(brakeLevel(1, 20)).toBe(1);
    expect(brakeLevel(0.5, -20)).toBe(0.5);
    expect(brakeLevel(1, 0.75)).toBe(0.5);
    expect(brakeLevel(1, 0)).toBe(0);
  });

  it('pans by the place across the view, or by the offset from the Rider without one', () => {
    const view = { left: 10, right: 50 };
    expect(panOf(10, view, 30)).toBe(-1);
    expect(panOf(30, view, 0)).toBe(0);
    expect(panOf(80, view, 30)).toBe(1);
    expect(panOf(45, null, 30)).toBeCloseTo(0.5);
  });

  it('hears a ford where the train is wet nearest the Rider, churning harder at speed; the river faintly just ahead', () => {
    const L = 60;
    const inIt = [{ x0: 40, x1: 90 }];
    const on = fordLevel(50, L, inIt, 20);
    expect(on.x).toBe(50); // standing over the water
    expect(on.level).toBeCloseTo(1);
    expect(fordLevel(50, L, inIt, 0).level).toBeCloseTo(0.45); // standing still in it: the river, not the churn
    const back = fordLevel(5, L, inIt, 20);
    expect(back.x).toBe(40); // the wet part nearest a Rider at the rear
    expect(back.level).toBeLessThan(on.level);
    expect(back.level).toBeGreaterThan(0);
    const ahead = fordLevel(55, L, [{ x0: L + 10, x1: L + 40 }], 20);
    expect(ahead.level).toBeGreaterThan(0);
    expect(ahead.level).toBeLessThan(0.3);
    expect(ahead.x).toBe(L + 10);
    expect(fordLevel(55, L, [{ x0: L + FORD_HEARD_AHEAD + 1, x1: L + 60 }], 20).level).toBe(0);
    expect(fordLevel(55, L, [{ x0: -80, x1: -20 }], 20).level).toBe(0); // passed
    expect(fordLevel(55, L, [], 20).level).toBe(0);
  });

  it('hears a herd far off, never quite silent', () => {
    expect(herdGain(0)).toBe(1);
    expect(herdGain(300)).toBeGreaterThan(herdGain(600));
    expect(herdGain(5000)).toBeCloseTo(0.3);
  });

  it('plays the ford, the lurch, shying horses, cattle and a throw from their events', () => {
    const st = game();
    const r = st.rider;
    const L = st.train.length;
    const { sfx, named, clear } = recorder();
    const s = new RiderSounds(sfx);
    const play = (...ev: SimEvent[]): void => s.events(ev, st, null);

    play({ type: 'fordEnter', id: 'f1' });
    const big = named('splash');
    expect(big).toHaveLength(1);
    expect(big[0].args[0]).toBe(true);
    const at = big[0].args[1] as { pan: number; gain: number };
    expect(at.pan).toBeCloseTo(panOf(L, null, r.x)); // up at the loco
    expect(at.gain).toBeGreaterThan(0);

    clear();
    play({ type: 'riderHurt', cause: 'water', hearts: 3 }, { type: 'riderOff', cause: 'water' });
    expect(named('hurt')).toHaveLength(1);
    expect(named('splash').every((c) => c.args[0] === false)).toBe(true);
    expect(named('splash').length).toBeGreaterThan(0);
    expect(named('thud')).toHaveLength(0);

    clear();
    play({ type: 'riderOff', cause: 'tunnel' }, { type: 'banditKnockedOff', id: 9, cause: 'bridge' });
    expect(named('thud')).toHaveLength(2);
    expect(named('splash')).toHaveLength(0);
    clear();
    play({ type: 'banditKnockedOff', id: 9, cause: 'water' });
    expect(named('splash')).toHaveLength(1);
    expect(named('thud')).toHaveLength(0);

    clear();
    play({ type: 'lurch' });
    expect(named('lurch').map((c) => c.args[0])).toEqual(['rider']);

    clear();
    st.horsemen = [horseman(4, r.x + 20)];
    play({ type: 'horseShy', id: 4 }, { type: 'horseShy', id: 99 });
    const neigh = named('whinny');
    expect(neigh).toHaveLength(1); // the horse that isn't there stays quiet
    expect(neigh[0].args[0]).toBeCloseTo(panOf(r.x + 20, null, r.x));
    expect(neigh[0].args[1]).toBeGreaterThan(0);

    clear();
    play({ type: 'thrown', who: 'bandit', id: 9 });
    expect(named('grunt')).toHaveLength(0);
    play({ type: 'thrown', who: 'rider' });
    expect(named('grunt')).toHaveLength(1);

    clear();
    play({ type: 'cattleCalm', id: 'herd' }, { type: 'cattleScatter', id: 'herd' });
    expect(named('cattle').map((c) => c.args[0])).toEqual([false, true]);
    for (const c of named('cattle')) {
      expect(c.args[1]).toBe(1); // far ahead, off to the right, when the herd can't be placed
      expect(c.args[2]).toBeGreaterThan(0);
    }
  });

  it('keeps the river running while the train is in a ford, and quiet when it isn’t', () => {
    const run = fordedRun(20, 10);
    const st = game(run);
    const { sfx, named } = recorder();
    const s = new RiderSounds(sfx);
    s.frame(st, run, true, null);
    const wet = named('fordWater');
    expect(wet).toHaveLength(1);
    expect(wet[0].args[0]).toBeGreaterThan(0);
    expect((wet[0].args[1] as { listener: string }).listener).toBe('rider');
    const dry = recorder();
    const d = new RiderSounds(dry.sfx);
    d.frame(game(), RUNS[0], true, null);
    expect(dry.named('fordWater')[0].args[0]).toBe(0);
    // Paused: every layer falls quiet, the river too.
    s.frame(st, run, false, null);
    expect(named('fordWater').at(-1)?.args[0]).toBe(0);
  });
});

describe('the cab', () => {
  const view = (tick: number, patch: Partial<EngineerView['train']> = {}): EngineerView =>
    ({ tick, train: { v: 12, throttle: 0.5, brake: 0.2, whistle: false, safetyValve: false, spout: 'up', water: 80, waterCap: 100, heldUp: false, ...patch } }) as unknown as EngineerView;

  it('hears a ford under the footplate from the loco wading in until the cab is out', () => {
    const { sfx, named } = recorder();
    const cab = new CabSounds(sfx);
    const level = (): number => named('fordWater').at(-1)?.args[0] as number;
    cab.frame(view(0), true);
    expect(level()).toBe(0);
    cab.event({ type: 'fordEnter', id: 'f1' });
    const plunge = named('splash');
    expect(plunge).toHaveLength(1);
    expect((plunge[0].args[1] as { muffled: boolean }).muffled).toBe(true);
    cab.frame(view(4), true);
    expect(level()).toBeGreaterThan(0.5);
    expect((named('fordWater').at(-1)?.args[1] as { listener: string }).listener).toBe('cab');
    // The front is out; the cab, CAB_BEHIND_FRONT behind it, still has that far to run at 12 m/s.
    cab.event({ type: 'fordExit', id: 'f1' });
    let tick = 4;
    const ticksToClear = Math.ceil((CAB_BEHIND_FRONT / 12) * TICK_HZ);
    while (tick < 4 + ticksToClear - 8) {
      tick += 4;
      cab.frame(view(tick), true);
      expect(level()).toBeGreaterThan(0);
    }
    tick += 16;
    cab.frame(view(tick), true);
    expect(level()).toBe(0);
    cab.stop();
    expect(level()).toBe(0);
  });

  it('hears the lurch the Engineer caused: the brake into emergency at speed, once a cooldown', () => {
    const { sfx, named } = recorder();
    const cab = new CabSounds(sfx);
    cab.frame(view(0, { brake: 1 }), true); // joining with the brake already on: no lurch
    cab.frame(view(4, { brake: 0.3 }), true);
    cab.frame(view(8, { brake: 1 }), true);
    expect(named('lurch').map((c) => c.args[0])).toEqual(['cab']);
    cab.frame(view(12, { brake: 0.3 }), true);
    cab.frame(view(16, { brake: 1 }), true); // too soon after the last
    expect(named('lurch')).toHaveLength(1);
    const later = 8 + LURCH_COOLDOWN_SECONDS * TICK_HZ;
    cab.frame(view(later, { brake: 0.3 }), true);
    cab.frame(view(later + 4, { brake: 1 }), true);
    expect(named('lurch')).toHaveLength(2);
    // Too slow, or held up (the Engineer's hands are up): no lurch.
    const slow = recorder();
    const c2 = new CabSounds(slow.sfx);
    c2.frame(view(0, { brake: 0.2, v: 5 }), true);
    c2.frame(view(4, { brake: 1, v: 5 }), true);
    c2.frame(view(8, { brake: 0.2, heldUp: true }), true);
    c2.frame(view(12, { brake: 1, heldUp: true }), true);
    expect(slow.named('lurch')).toHaveLength(0);
  });
});
