// The run's opening shot (spec §3): its timeline, the running gear's kinematics, the steam, the title's
// movement, the sound's cues, and whole frames drawn through a stand-in canvas. The beats the engine's
// sound queues (Sfx's own scheduling, replayed here) land when the drivers reach them in the picture.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUFF_PATTERN, LOOKAHEAD, patternEvents, type Sfx } from '../src/audio/sfx';
import { RUNS } from '../src/content/runs';
import {
  BEAT_TRAVEL,
  beatTime,
  bellSwing,
  driverAngle,
  FIRST_BEAT_AT,
  gearAt,
  INTRO_CRUISE,
  INTRO_CUES,
  introCamera,
  IntroRenderer,
  introPuffs,
  introSpeed,
  introThrottle,
  introTimeAt,
  introTitleLook,
  introTravel,
  THROTTLE_AT,
} from '../src/render/intro';
import { INTRO_SECONDS } from '../src/sim/rules';
import { introInfo, IntroSounds } from '../src/ui/intro';

const FRAME = 1 / 60;
const times = (step = FRAME): number[] => Array.from({ length: Math.ceil(INTRO_SECONDS / step) + 1 }, (_, i) => Math.min(INTRO_SECONDS, i * step));

describe('the opening shot’s timeline', () => {
  it('stands, then pulls away and settles at a steady speed', () => {
    expect(introSpeed(0)).toBe(0);
    expect(introSpeed(THROTTLE_AT)).toBe(0);
    expect(introTravel(THROTTLE_AT)).toBe(0);
    let last = 0;
    for (const t of times()) {
      const v = introSpeed(t);
      expect(v).toBeGreaterThanOrEqual(last);
      expect(v).toBeLessThanOrEqual(INTRO_CRUISE);
      last = v;
    }
    expect(introSpeed(INTRO_SECONDS)).toBe(INTRO_CRUISE);
  });

  it('travels the integral of its speed, and finds the time for a distance', () => {
    let s = 0;
    for (let t = 0; t < INTRO_SECONDS; t += 0.001) s += introSpeed(t + 0.0005) * 0.001;
    expect(introTravel(INTRO_SECONDS)).toBeCloseTo(s, 2);
    for (const d of [0.1, 1.25, 5, 20, 29]) expect(introTravel(introTimeAt(d))).toBeCloseTo(d, 9);
  });

  it('beats every quarter turn of the drivers, the first landing with the title', () => {
    expect(BEAT_TRAVEL).toBe(CHUFF_PATTERN.offsets[1]);
    for (let k = 1; k < 20; k++) {
      expect(introTravel(beatTime(k))).toBeCloseTo(k * BEAT_TRAVEL, 9);
      // A quarter turn of the drivers per beat.
      expect(driverAngle(introTravel(beatTime(k))) - driverAngle(introTravel(beatTime(k - 1 || 1)))).toBeCloseTo(k === 1 ? 0 : -Math.PI / 2, 9);
    }
    expect(FIRST_BEAT_AT).toBeGreaterThan(THROTTLE_AT + 0.5);
    expect(FIRST_BEAT_AT).toBeLessThan(INTRO_SECONDS / 2);
    const look = introTitleLook(FIRST_BEAT_AT + 0.1, true);
    expect(introTitleLook(FIRST_BEAT_AT - 0.1, true).name.opacity).toBe(0);
    expect(look.name.opacity).toBeGreaterThan(0.9);
  });

  it('keeps every cue inside the shot, the whistle and the bells before the engine fades', () => {
    const cues = [...INTRO_CUES.valve, ...INTRO_CUES.bells, INTRO_CUES.lever, ...INTRO_CUES.whistle, INTRO_CUES.engineOff];
    for (const c of cues) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(INTRO_SECONDS);
    }
    expect(INTRO_CUES.whistle[1]).toBeLessThan(INTRO_CUES.engineOff);
    expect(INTRO_CUES.lever).toBeLessThanOrEqual(THROTTLE_AT);
    expect(introThrottle(INTRO_CUES.lever - 0.01)).toBe(0);
    expect(introThrottle(THROTTLE_AT)).toBeGreaterThan(0.5);
    // The bell swings as it rings, and is still once it's done.
    expect(Math.abs(bellSwing(INTRO_CUES.bells[0] + 0.1))).toBeGreaterThan(0.05);
    expect(bellSwing(0)).toBe(0);
    expect(bellSwing(INTRO_SECONDS)).toBe(0);
  });
});

describe('the engine’s sound keeps time with the picture', () => {
  /** Sfx's pump, replayed: each frame queues the beats up to LOOKAHEAD ahead at the speed it's given. */
  function audioBeats(speedAt: (t: number) => number): number[] {
    const beats: number[] = [];
    let odo = 0;
    let schedT = 0.01;
    for (const t of times()) {
      const horizon = t + LOOKAHEAD;
      const v = speedAt(t);
      if (horizon > schedT) {
        if (v > 0) {
          for (const ev of patternEvents(CHUFF_PATTERN, odo, v, schedT, horizon)) beats.push(ev.t);
          odo += v * (horizon - schedT);
        }
        schedT = horizon;
      }
    }
    return beats.filter((b) => b < INTRO_CUES.engineOff);
  }

  it('lands each beat within a frame or so of the drivers’ quarter turn, given the speed LOOKAHEAD ahead', () => {
    const heard = audioBeats((t) => introSpeed(t + LOOKAHEAD));
    expect(heard.length).toBeGreaterThan(10);
    for (const [i, t] of heard.entries()) expect(Math.abs(t - beatTime(i + 1))).toBeLessThan(0.04);
  });

  it('would fall behind by the lookahead if given the speed now', () => {
    const heard = audioBeats(introSpeed);
    expect(heard[0] - beatTime(1)).toBeGreaterThan(0.15);
  });
});

describe('the running gear', () => {
  it('keeps the rods their length and the crosshead on its guides through a turn', () => {
    const xs: number[] = [];
    for (let i = 0; i < 64; i++) {
      const theta = -(i / 64) * Math.PI * 2;
      const g = gearAt(theta);
      const [px, py] = g.pins[1];
      expect(Math.hypot(g.cross[0] - px, g.cross[1] - py)).toBeCloseTo(2.2, 9);
      expect(g.cross[1]).toBeCloseTo(0.95, 9);
      expect(Math.hypot(g.pins[1][0] - g.pins[0][0], g.pins[1][1] - g.pins[0][1])).toBeCloseTo(2.25, 9);
      expect(Math.hypot(g.stem[0] - g.die[0], g.stem[1] - g.die[1])).toBeCloseTo(1.3, 9);
      xs.push(g.cross[0]);
    }
    // The crosshead's stroke is twice the crank, and stays between the guides' yoke and the cylinder.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.68, 1);
    expect(Math.min(...xs) - 0.2).toBeGreaterThan(3.69);
    expect(Math.max(...xs) + 0.2).toBeLessThan(5.02);
  });

  it('rolls the drivers clockwise, so the engine runs to the right', () => {
    expect(driverAngle(1)).toBeLessThan(0);
  });
});

describe('the steam', () => {
  it('curls from the cocks at a stand, blasts with the throttle, and coughs from the stack on each beat', () => {
    const standing = introPuffs(0.5);
    expect(standing.length).toBeGreaterThan(0);
    const opened = introPuffs(THROTTLE_AT + 0.1).filter((p) => !p.smoke);
    expect(opened.length).toBeGreaterThan(standing.filter((p) => !p.smoke).length);
    const coughs = (t: number): number => introPuffs(t).filter((p) => p.smoke && p.y > 5.45 && p.alpha > 0.3).length;
    expect(coughs(FIRST_BEAT_AT + 0.05)).toBeGreaterThan(0);
    for (const t of times(0.05)) {
      const puffs = introPuffs(t);
      expect(puffs.length).toBeLessThan(260);
      for (const p of puffs) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.r)).toBe(true);
        expect(p.alpha).toBeGreaterThanOrEqual(0);
        expect(p.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it('shuts the cocks once the engine is rolling', () => {
    const late = introPuffs(INTRO_SECONDS - 0.5).filter((p) => !p.smoke);
    expect(late).toEqual([]);
  });
});

describe('the title', () => {
  it('fades up from black, stamps the name on, and fades out onto the play screen', () => {
    expect(introTitleLook(0, true).veil).toBe(1);
    expect(introTitleLook(1, true).veil).toBe(0);
    expect(introTitleLook(FIRST_BEAT_AT + 0.05, true).name.scale).toBeGreaterThan(1.05);
    const held = introTitleLook(4, true);
    expect(held).toMatchObject({ opacity: 1, bars: 1, rule: 1, name: { opacity: 1, scale: 1 } });
    expect(held.route.opacity).toBe(1);
    expect(introTitleLook(INTRO_SECONDS, true).opacity).toBe(0);
  });

  it('only fades, without motion', () => {
    for (const t of times(0.05)) {
      const look = introTitleLook(t, false);
      expect(look.name.scale).toBe(1);
      expect(look.name.dy).toBe(0);
      expect(look.kicker.dy).toBe(0);
      expect(look.route.dy).toBe(0);
    }
    expect(introCamera(0, false)).toEqual(introCamera(INTRO_SECONDS, false));
    expect(introCamera(0, true).w).toBeLessThan(introCamera(INTRO_SECONDS, true).w);
  });

  it('names the act, the run, the way and the time', () => {
    const info = introInfo(RUNS[0]);
    expect(info.kicker).toBe('Act I · Iron Horse · Run 1');
    expect(info.name).toBe(RUNS[0].name);
    expect(info.route).toMatch(/^Juniper → Coyote Bend · departs \d{1,2}:\d\d AM$/);
    expect(introInfo(RUNS[4]).night).toBe(true);
  });
});

describe('the shot’s sounds', () => {
  const fakeSfx = () => {
    const calls: [string, unknown[]][] = [];
    const sfx = new Proxy({} as Record<string, unknown>, {
      get: (_t, name: string) => (...args: unknown[]) => calls.push([name, args]),
    }) as unknown as Sfx;
    const named = (name: string): unknown[][] => calls.filter(([n]) => n === name).map(([, a]) => a);
    return { sfx, calls, named };
  };

  it('rings the bell three times, clanks the lever once, and blows one whistle, frame by frame', () => {
    const { sfx, named } = fakeSfx();
    const sounds = new IntroSounds(sfx);
    for (const t of times()) sounds.frame(t);
    expect(named('bell')).toHaveLength(3);
    expect(named('lever')).toHaveLength(1);
    const whistle = named('whistle').map(([on]) => on);
    const starts = whistle.filter((on, i) => on === true && whistle[i - 1] !== true);
    expect(starts).toHaveLength(1);
    const engine = named('engine');
    // A fresh voice first, then the speed, then silence before the picture fades.
    expect(engine[0]).toEqual([null]);
    expect(engine.some(([p]) => p !== null && (p as { speed: number }).speed > 0)).toBe(true);
    expect(engine.at(-1)).toEqual([null]);
  });

  it('skips cues it arrives too late for, and silences its layers when stopped', () => {
    const { sfx, named, calls } = fakeSfx();
    const sounds = new IntroSounds(sfx);
    sounds.frame(3);
    sounds.frame(3 + FRAME);
    expect(named('bell')).toHaveLength(0);
    expect(named('lever')).toHaveLength(0);
    calls.length = 0;
    sounds.stop();
    expect(named('engine')).toEqual([[null]]);
    expect(named('whistle')).toEqual([[false, 'rider']]);
    expect(named('safetyValve')).toEqual([[false]]);
    // Played again, it starts over.
    calls.length = 0;
    for (const t of times()) sounds.frame(t);
    expect(named('bell')).toHaveLength(3);
  });
});

// ---- Whole frames, through a stand-in canvas ------------------------------------------------------

function fakeContext(log: string[]): CanvasRenderingContext2D {
  const store: Record<string | symbol, unknown> = {};
  return new Proxy(store, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern') return () => ({ addColorStop: () => undefined });
      return (...args: unknown[]) => {
        log.push(String(prop));
        for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) log.push(`bad ${String(prop)}`);
      };
    },
    set(t, prop, v) {
      t[prop] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(w: number, h: number, log: string[]): HTMLCanvasElement {
  const ctx = fakeContext(log);
  return { width: w, height: h, style: {}, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }) } as unknown as HTMLCanvasElement;
}

describe('the opening shot, drawn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws every run, day and night, from the first frame to the last, with finite numbers', () => {
    const log: string[] = [];
    vi.stubGlobal('window', { devicePixelRatio: 2 });
    vi.stubGlobal('document', { createElement: () => fakeCanvas(64, 64, []) });
    for (const [w, h] of [
      [1280, 720],
      [1920, 800],
      [1024, 768],
    ]) {
      const r = new IntroRenderer(fakeCanvas(w, h, log));
      for (const run of RUNS) {
        const info = introInfo(run);
        for (const motion of [true, false]) {
          for (const t of times(0.25)) r.draw(t, { clock: info.clock, night: info.night, motion, seed: info.seed });
        }
      }
    }
    expect(log.filter((l) => l.startsWith('bad '))).toEqual([]);
    expect(log.filter((l) => l === 'drawImage').length).toBeGreaterThan(0);
    expect(log.filter((l) => l === 'arc').length).toBeGreaterThan(0);
  });
});
