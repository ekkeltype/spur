// Saves (spec §17): the host's campaign, settings and checkpoint under spur.save.v1, the Engineer's
// own settings under spur.settings.v1, save codes, and the campaign rules the depot and the
// results screen apply (money, unlocks, replays, the shop and the consist).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeConsist, newGame, step } from '../src/sim/game';
import { REPLAY_PAY_FACTOR, SHOP } from '../src/sim/rules';
import { NO_INPUT, type CampaignProgress, type Checkpoint, type GameState, type Medal, type RunDef, type RunResult, type Settings } from '../src/sim/types';
import {
  CLIENT_SETTINGS_KEY,
  SAVE_KEY,
  SaveError,
  UNREADABLE_SAVE_KEY,
  availableCars,
  buyItem,
  checkpointOf,
  defaultCampaign,
  defaultSave,
  defaultSettings,
  exportSaveCode,
  importSaveCode,
  isCompleted,
  isUnlocked,
  loadClientSettings,
  loadSave,
  migrate,
  payoutFor,
  recordResult,
  restoreCheckpoint,
  setAssist,
  toggleCar,
  writeClientSettings,
  writeSave,
  type SaveV1,
} from '../src/save/save';
import { yRun } from './fixtures';

const NEWER = 'This save is from a newer version of Switch & Spur. Update the game to use it.';
const NOT_A_SAVE = "This isn't a Switch & Spur save.";
const BAD_CODE = "That save code isn't valid. Make sure you copied the whole code.";

// A six-run campaign on the fixture network, so these tests don't depend on the real content.
const IDS = ['first-light', 'payroll', 'signal-country', 'single-track', 'night-freight', 'blackwater'];
const RUNS6: RunDef[] = IDS.map((id, index) =>
  yRun({
    id,
    index,
    act: index < 3 ? 1 : 2,
    name: `Run ${index + 1}`,
    requiredCars: index === 1 ? ['express'] : index === 4 ? ['powder'] : [],
    maxCars: index === 0 ? 3 : 5,
  }),
);
const idx = (id: string): number => IDS.indexOf(id);

type MemoryStorage = Storage & { data: Map<string, string> };

/** A tiny in-memory Storage for Node. */
function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

/** Storage that throws on every call, like blocked site data or a full quota. */
function brokenStorage(): Storage {
  const fail = (): never => {
    throw new Error('QuotaExceededError');
  };
  return {
    get length() {
      return 0;
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

function result(runId: string, outcome: 'won' | 'lost', timeSec: number, medals: Medal[] = [], money: Partial<RunResult> = {}): RunResult {
  const pay = money.pay ?? 200;
  const latePenalty = money.latePenalty ?? 0;
  const sideJobPay = money.sideJobPay ?? 0;
  const fines = money.fines ?? 0;
  return {
    runId,
    outcome,
    reason: outcome === 'won' ? null : 'derailed',
    detail: outcome === 'won' ? '' : 'Took the curve too fast.',
    timeSec,
    arrivedClock: outcome === 'won' ? 13 * 3600 : null,
    deadline: 13 * 3600 + 600,
    pay,
    latePenalty,
    cargoPay: money.cargoPay ?? 0,
    sideJobPay,
    fines,
    total: money.total ?? Math.max(0, pay - latePenalty) + (money.cargoPay ?? 0) + sideJobPay - fines,
    medals,
    stats: {
      shotsFired: 10,
      hits: 4,
      horsemenDowned: 2,
      banditsDowned: 1,
      heartsLost: 1,
      timesOff: 0,
      timesDown: 0,
      redSignals: 0,
      speedFines: 0,
      fines,
      waterStops: 1,
      holdups: 0,
      maxSpeed: 22,
      carDamage: 0,
    },
  };
}

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

function fromBase64(code: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(code), (c) => c.charCodeAt(0)));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function campaign(patch: Partial<CampaignProgress> = {}): CampaignProgress {
  return { ...defaultCampaign(), ...patch };
}

function sampleSave(): SaveV1 {
  return {
    version: 1,
    campaign: {
      unlocked: idx('signal-country') + 1,
      money: 340,
      owned: ['shotgun', 'caboose'],
      completed: [
        { runId: 'first-light', bestTimeSec: 412.5, medals: ['onTime', 'untouched'], times: 2 },
        { runId: 'payroll', bestTimeSec: 590, medals: [], times: 1 },
      ],
      assists: { rider: true, engineer: false },
      consist: ['passenger', 'caboose'],
    },
    settings: {
      masterVolume: 0.5,
      effectsVolume: 0.25,
      screenShake: false,
      hints: 'never',
      lampLetters: true,
    },
    checkpoint: null,
  };
}

/** A game of run 2 part-way along, as if it had just left a checkpoint station. */
function gameMidway(): { run: RunDef; state: GameState } {
  const run = RUNS6[1];
  const consist = composeConsist(run, ['passenger']);
  const state = newGame(run, { seed: 77, consist, upgrades: ['shotgun'], assists: { rider: false, engineer: true } });
  state.tick = 5400;
  state.train.v = 12.5;
  state.train.water = 61.25;
  state.stats.shotsFired = 9;
  state.flags.push({ id: 3, point: { edge: 'e1', off: 640 }, tick: 5300 });
  return { run, state };
}

function sampleCheckpoint(): Checkpoint {
  const { run, state } = gameMidway();
  return checkpointOf(state, run, 'orig', ['express', 'passenger'], ['shotgun']);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defaults', () => {
  it('defaultSettings has the documented values', () => {
    expect(defaultSettings(false)).toEqual({
      masterVolume: 0.8,
      effectsVolume: 0.8,
      screenShake: true,
      hints: 'first',
      lampLetters: false,
    });
    expect(defaultSettings()).toEqual(defaultSettings(false)); // Node has no matchMedia
  });

  it('reduced motion turns off screen shake', () => {
    expect(defaultSettings(true).screenShake).toBe(false);
    expect(defaultSettings(true).masterVolume).toBe(0.8);
  });

  it('a new campaign has the first run open, no money, nothing owned and no assists', () => {
    expect(defaultCampaign()).toEqual({
      unlocked: 1,
      money: 0,
      owned: [],
      completed: [],
      assists: { rider: false, engineer: false },
      consist: [],
    });
    expect(defaultSave(true)).toEqual({ version: 1, campaign: defaultCampaign(), settings: defaultSettings(true), checkpoint: null });
  });
});

describe('writeSave and loadSave', () => {
  it('round-trips through storage under spur.save.v1', () => {
    const storage = memoryStorage();
    writeSave(sampleSave(), storage);
    expect([...storage.data.keys()]).toEqual([SAVE_KEY]);
    expect(SAVE_KEY).toBe('spur.save.v1');
    expect(loadSave(storage, undefined, RUNS6)).toEqual(sampleSave());
  });

  it('returns defaults when there is no save', () => {
    expect(loadSave(memoryStorage())).toEqual(defaultSave());
  });

  it('never throws on corrupt JSON; keeps the unreadable text and reports it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage({ [SAVE_KEY]: '{"version":1,"campaign":' });
    const problems: SaveError[] = [];
    expect(loadSave(storage, (e) => problems.push(e))).toEqual(defaultSave());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toBeInstanceOf(SaveError);
    expect(storage.data.get(UNREADABLE_SAVE_KEY)).toBe('{"version":1,"campaign":');
    expect(UNREADABLE_SAVE_KEY).toBe('spur.save.unreadable');
  });

  it('falls back to defaults for a newer save, with the exact message, without losing it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const newer = JSON.stringify({ version: 2, campaign: { unlocked: 5, completed: [] }, extra: true });
    const storage = memoryStorage({ [SAVE_KEY]: newer });
    const problems: string[] = [];
    expect(loadSave(storage, (e) => problems.push(e.message))).toEqual(defaultSave());
    expect(problems).toEqual([NEWER]);
    expect(storage.data.get(UNREADABLE_SAVE_KEY)).toBe(newer);
  });

  it.each([['null'], ['42'], ['"text"'], ['[]'], ['{}'], ['{"version":1}'], ['{"version":"1"}']])('never throws on garbage %s', (text) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadSave(memoryStorage({ [SAVE_KEY]: text }))).toEqual(defaultSave());
  });

  it('a throwing onProblem callback does not make loadSave throw', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const storage = memoryStorage({ [SAVE_KEY]: 'garbage' });
    expect(
      loadSave(storage, () => {
        throw new Error('ui bug');
      }),
    ).toEqual(defaultSave());
  });

  it('never throws when storage is unavailable or full', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadSave(brokenStorage())).toEqual(defaultSave());
    expect(() => writeSave(sampleSave(), brokenStorage())).not.toThrow();
    expect(loadClientSettings(brokenStorage())).toEqual(defaultSettings());
    expect(() => writeClientSettings(defaultSettings(), brokenStorage())).not.toThrow();
  });

  it('works without any storage at all (Node has no localStorage)', () => {
    expect(loadSave()).toEqual(defaultSave());
    expect(() => writeSave(sampleSave())).not.toThrow();
    expect(loadClientSettings()).toEqual(defaultSettings());
    expect(() => writeClientSettings(defaultSettings())).not.toThrow();
  });
});

describe('save codes', () => {
  it('round-trips export → import', () => {
    const save = sampleSave();
    const code = exportSaveCode(save);
    expect(code).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(fromBase64(code))).toEqual(save);
    expect(importSaveCode(code, RUNS6)).toEqual(save);
  });

  it('leaves the checkpoint out, so codes stay short enough to paste', () => {
    const save = { ...sampleSave(), checkpoint: sampleCheckpoint() };
    const code = exportSaveCode(save);
    expect(importSaveCode(code, RUNS6)).toEqual({ ...save, checkpoint: null });
    expect(code.length).toBeLessThan(exportSaveCode(sampleSave()).length + 8);
  });

  it('is unicode-safe', () => {
    const save = sampleSave();
    save.campaign.completed.push({ runId: 'ferrocarril-ñandú-🚂', bestTimeSec: 1, medals: [], times: 1 });
    expect(importSaveCode(exportSaveCode(save), RUNS6)).toEqual(save);
  });

  it('tolerates whitespace and line breaks anywhere, URL-safe base64 and missing padding', () => {
    const save = sampleSave();
    const code = exportSaveCode(save);
    const chopped = `  \n${code.replace(/(.{7})/g, '$1 \n\t')}  \r\n`;
    expect(importSaveCode(chopped, RUNS6)).toEqual(save);
    const urlSafe = code.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(importSaveCode(urlSafe, RUNS6)).toEqual(save);
  });

  it('accepts plain save JSON too', () => {
    expect(importSaveCode(`  ${JSON.stringify(sampleSave(), null, 2)}  `, RUNS6)).toEqual(sampleSave());
  });

  it('refuses a newer save with the exact message', () => {
    const code = toBase64(JSON.stringify({ version: 3, campaign: { unlocked: 1, completed: [] } }));
    expect(() => importSaveCode(code)).toThrow(SaveError);
    expect(() => importSaveCode(code)).toThrow(NEWER);
  });

  it.each([
    ['empty', '', 'Paste a save code first.'],
    ['blank', ' \n ', 'Paste a save code first.'],
    ['not base64', '%%% not a code %%%', BAD_CODE],
    ['base64 of text', toBase64('hello there'), BAD_CODE],
    ['truncated', exportSaveCode(sampleSave()).slice(0, 41), BAD_CODE],
    ['invalid UTF-8', btoa('\xff\xfe{'), BAD_CODE],
    ['base64 of an array', toBase64('[1,2,3]'), NOT_A_SAVE],
    ['base64 of an unrelated object', toBase64('{"name":"x"}'), NOT_A_SAVE],
    ['broken JSON', '{"version":1,', BAD_CODE],
  ])('rejects garbage (%s) with a clear SaveError', (_name, code, message) => {
    expect(() => importSaveCode(code)).toThrow(SaveError);
    expect(() => importSaveCode(code)).toThrow(message);
  });
});

describe('migrate', () => {
  it('passes a clean v1 save through unchanged', () => {
    expect(migrate(sampleSave(), RUNS6)).toEqual(sampleSave());
  });

  it('reads an unversioned save (campaign fields at the top level or nested) as version 1', () => {
    expect(migrate({ unlocked: 2, money: 50 }, RUNS6).campaign).toEqual(campaign({ unlocked: 2, money: 50 }));
    expect(migrate({ campaign: { unlocked: 2 } }, RUNS6).campaign.unlocked).toBe(2);
    expect(migrate({ version: 0, money: 5 }, RUNS6).campaign.money).toBe(5);
    expect(migrate({ unlocked: 1, settings: { masterVolume: 0.3, hints: true } }).settings).toEqual({ ...defaultSettings(), masterVolume: 0.3, hints: 'first' });
    expect(migrate({ unlocked: 1, settings: { hints: false } }).settings.hints).toBe('never');
  });

  it('fills missing or invalid settings with defaults and clamps volumes', () => {
    const raw = {
      version: 1,
      campaign: { unlocked: 1 },
      settings: { masterVolume: 1.7, effectsVolume: -0.2, screenShake: 'yes', hints: 'sometimes', lampLetters: 1, unknownField: 1 },
    };
    expect(migrate(raw).settings).toEqual({ masterVolume: 1, effectsVolume: 0, screenShake: true, hints: 'first', lampLetters: false });
    expect(migrate({ version: 1, campaign: {} }).settings).toEqual(defaultSettings());
    expect(migrate({ version: 1, campaign: {}, settings: 'loud' }).settings).toEqual(defaultSettings());
    expect(migrate({ version: 1, campaign: {}, settings: { masterVolume: Number.NaN } }).settings.masterVolume).toBe(0.8);
  });

  it.each([
    [99, 6],
    [0, 1],
    [-3, 1],
    [2.7, 2],
    ['3', 1],
    [null, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('clamps unlocked=%s to %s', (unlocked, expected) => {
    expect(migrate({ version: 1, campaign: { unlocked } }, RUNS6).campaign.unlocked).toBe(expected);
  });

  it('raises unlocked to cover completed runs', () => {
    const save = migrate({ version: 1, campaign: { unlocked: 1, completed: [{ runId: 'single-track', bestTimeSec: 700, medals: [], times: 1 }] } }, RUNS6);
    expect(save.campaign.unlocked).toBe(idx('single-track') + 2); // winning a run opens the next
    const last = migrate({ version: 1, campaign: { completed: [{ runId: 'blackwater', bestTimeSec: 900, times: 1 }] } }, RUNS6);
    expect(last.campaign.unlocked).toBe(RUNS6.length);
  });

  it('cleans completed entries: drops invalid ones, merges duplicates, orders medals and runs', () => {
    const save = migrate(
      {
        version: 1,
        campaign: {
          unlocked: 2,
          completed: [
            { runId: 'future-run', bestTimeSec: 10, medals: [], times: 1 },
            { runId: 'payroll', bestTimeSec: 600, medals: ['untouched', 'untouched', 7, 'onTime', 'swift'], times: 2 },
            { runId: 'first-light', bestTimeSec: 500, medals: ['clean'], times: 1 },
            { runId: 'first-light', bestTimeSec: 450, medals: ['onTime'], times: 3 },
            { runId: '', bestTimeSec: 1, medals: [] },
            { runId: 'signal-country', bestTimeSec: -5, medals: [] },
            { runId: 'signal-country', bestTimeSec: Number.NaN, medals: [] },
            { runId: 'signal-country', medals: [] },
            { runId: 'single-track', bestTimeSec: 800, medals: 'onTime', times: 'many' },
            { runId: 'night-freight', bestTimeSec: 900, medals: [], times: 0 },
            'first-light',
            null,
          ],
        },
      },
      RUNS6,
    );
    expect(save.campaign.completed).toEqual([
      { runId: 'first-light', bestTimeSec: 450, medals: ['onTime', 'clean'], times: 4 },
      { runId: 'payroll', bestTimeSec: 600, medals: ['onTime', 'untouched'], times: 2 },
      { runId: 'single-track', bestTimeSec: 800, medals: [], times: 1 },
      { runId: 'night-freight', bestTimeSec: 900, medals: [], times: 1 },
      { runId: 'future-run', bestTimeSec: 10, medals: [], times: 1 },
    ]);
    expect(save.campaign.unlocked).toBe(RUNS6.length);
  });

  it('keeps money a whole number of dollars, never negative', () => {
    const money = (m: unknown): number => migrate({ version: 1, campaign: { money: m } }).campaign.money;
    expect(money(340)).toBe(340);
    expect(money(12.9)).toBe(12);
    expect(money(-40)).toBe(0);
    expect(money('500')).toBe(0);
    expect(money(Number.NaN)).toBe(0);
    expect(money(Number.POSITIVE_INFINITY)).toBe(0);
    expect(money(null)).toBe(0);
  });

  it('keeps only known upgrades, once each, in shop order', () => {
    const owned = migrate({ version: 1, campaign: { owned: ['rifle', 'jetpack', 'shotgun', 'rifle', 3, 'caboose'] } }).campaign.owned;
    expect(owned).toEqual(['shotgun', 'rifle', 'caboose']);
    expect(migrate({ version: 1, campaign: { owned: 'everything' } }).campaign.owned).toEqual([]);
  });

  it('keeps assists as two booleans', () => {
    expect(migrate({ version: 1, campaign: { assists: { rider: true, engineer: 'yes' } } }).campaign.assists).toEqual({ rider: true, engineer: false });
    expect(migrate({ version: 1, campaign: { assists: 'on' } }).campaign.assists).toEqual({ rider: false, engineer: false });
  });

  it('keeps only cars that can be chosen: the free ones, and bought ones once owned', () => {
    const consist = (c: unknown, owned: unknown[] = []): unknown => migrate({ version: 1, campaign: { consist: c, owned } }).campaign.consist;
    expect(consist(['boxcar', 'express', 'boxcar', 'hovercar', 'powder', 'caboose'])).toEqual(['express', 'boxcar']);
    expect(consist(['caboose', 'armored', 'passenger'], ['caboose'])).toEqual(['passenger', 'caboose']);
    expect(consist('boxcar')).toEqual([]);
  });

  it.each([2, 7, 1000])('refuses version %s with the exact message', (version) => {
    expect(() => migrate({ version, campaign: { unlocked: 1 } })).toThrow(SaveError);
    expect(() => migrate({ version, campaign: { unlocked: 1 } })).toThrow(NEWER);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'save'],
    ['an array', [{ unlocked: 1 }]],
    ['an empty object', {}],
    ['an unrelated object', { name: 'x', score: 3 }],
    ['a string version', { version: '1', campaign: { unlocked: 1 } }],
    ['a negative version', { version: -1, campaign: { unlocked: 1 } }],
    ['a fractional version', { version: 1.5, campaign: { unlocked: 1 } }],
    ['v1 without campaign', { version: 1, settings: {} }],
    ['v1 with a broken campaign', { version: 1, campaign: 'unlocked everything' }],
  ])('throws a SaveError with a message for %s', (_name, raw) => {
    expect(() => migrate(raw)).toThrow(SaveError);
    try {
      migrate(raw);
    } catch (err) {
      expect((err as SaveError).message.length).toBeGreaterThan(10);
      expect((err as SaveError).name).toBe('SaveError');
    }
  });
});

describe('checkpoints', () => {
  it('capture a deep copy of the game at the station', () => {
    const { run, state } = gameMidway();
    const cp = checkpointOf(state, run, 'orig', ['express', 'passenger'], ['shotgun']);
    expect(cp).toMatchObject({ runId: 'payroll', seed: 77, stationId: 'orig', stationName: 'Origin', consist: ['express', 'passenger'], upgrades: ['shotgun'] });
    expect(cp.state).toEqual(state);
    state.train.water = 3;
    state.flags[0].point.off = 1;
    expect(cp.state.train.water).toBe(61.25);
    expect(cp.state.flags[0].point.off).toBe(640);
  });

  it('round-trip through storage, and restore to an equal, independent game state', () => {
    const { state } = gameMidway();
    const storage = memoryStorage();
    writeSave({ ...sampleSave(), checkpoint: sampleCheckpoint() }, storage);
    const loaded = loadSave(storage, undefined, RUNS6);
    expect(loaded.checkpoint).not.toBeNull();
    const restored = restoreCheckpoint(loaded.checkpoint!);
    expect(restored).toEqual(state);
    restored.train.v = 0;
    expect(loaded.checkpoint!.state.train.v).toBe(12.5);
  });

  it('drop a checkpoint the current build could not resume', () => {
    const load = (cp: unknown): Checkpoint | null => migrate({ ...sampleSave(), checkpoint: cp }, RUNS6).checkpoint;
    const good = sampleCheckpoint();
    expect(load(good)).toEqual(good);
    expect(load(null)).toBeNull();
    expect(load('Mesa')).toBeNull();
    expect(load({ ...good, runId: 'no-such-run' })).toBeNull();
    expect(load({ ...good, stationId: 7 })).toBeNull();
    expect(load({ ...good, seed: 'seventy' })).toBeNull();
    expect(load({ ...good, seed: 78 })).toBeNull(); // the state belongs to another seed
    expect(load({ ...good, consist: ['express', 'zeppelin'] })).toBeNull();
    expect(load({ ...good, state: { ...good.state, runId: 'first-light' } })).toBeNull();
    expect(load({ ...good, state: { ...good.state, phase: 'lost' } })).toBeNull();
    expect(load({ ...good, state: 'mid-run' })).toBeNull();
    // Saved by an older build, before the sim had fields it now reads.
    const { stats: _stats, ...noStats } = good.state;
    expect(load({ ...good, state: noStats })).toBeNull();
    const { dryTicks: _dry, ...oldTrain } = good.state.train;
    expect(load({ ...good, state: { ...good.state, train: oldTrain } })).toBeNull();
    expect(load({ ...good, state: { ...good.state, bandits: {} } })).toBeNull();
    // Extra fields are fine: optional ones the sim adds as it goes, or ones a newer build dropped.
    const grown = { ...good, state: { ...good.state, rider: { ...good.state.rider, healTicks: 30 }, tornado: 1 } };
    expect(load(grown)).toEqual(grown);
  });

  it('survive a game the sim has been stepping (a state the sim grew must still load)', () => {
    const run = RUNS6[2];
    const state = newGame(run, { seed: 5, consist: composeConsist(run, ['boxcar']), upgrades: [], assists: { rider: false, engineer: false } });
    step(state, run, NO_INPUT, [{ seq: 1, kind: 'throttle', value: 1 }]);
    for (let k = 0; k < 600 && state.phase === 'running'; k++) step(state, run, NO_INPUT, []);
    const cp = checkpointOf(state, run, 'orig', composeConsist(run, ['boxcar']), []);
    const storage = memoryStorage();
    writeSave({ ...sampleSave(), checkpoint: cp }, storage);
    expect(loadSave(storage, undefined, RUNS6).checkpoint).toEqual(cp);
  });

  it('keep upgrades known and names readable', () => {
    const cp = migrate({ ...sampleSave(), checkpoint: { ...sampleCheckpoint(), upgrades: ['shotgun', 'jetpack'] } }, RUNS6).checkpoint;
    expect(cp?.upgrades).toEqual(['shotgun']);
  });
});

describe('payouts and recordResult', () => {
  it('pays the contract on a first win, unlocks the next run and records time, medals and count', () => {
    const { save, payout } = recordResult(defaultSave(false), result('first-light', 'won', 431.5, ['untouched', 'onTime'], { pay: 120, latePenalty: 10, sideJobPay: 80, fines: 50 }), RUNS6);
    expect(payout).toEqual({ won: true, pay: 120, latePenalty: 10, sideJobPay: 80, fines: 50, subtotal: 140, replay: false, replayDiscount: 0, total: 140 });
    expect(save.campaign).toEqual(
      campaign({ unlocked: 2, money: 140, completed: [{ runId: 'first-light', bestTimeSec: 431.5, medals: ['onTime', 'untouched'], times: 1 }] }),
    );
  });

  it(`pays ${REPLAY_PAY_FACTOR * 100}% on replays, keeps the best time and the union of medals`, () => {
    let { save } = recordResult(defaultSave(false), result('first-light', 'won', 400, ['onTime']), RUNS6);
    expect(save.campaign.money).toBe(200);
    const second = recordResult(save, result('first-light', 'won', 520, ['clean'], { pay: 201 }), RUNS6);
    expect(second.payout).toMatchObject({ subtotal: 201, replay: true, replayDiscount: 100, total: 101 });
    save = second.save;
    expect(save.campaign.money).toBe(301);
    expect(save.campaign.completed).toEqual([{ runId: 'first-light', bestTimeSec: 400, medals: ['onTime', 'clean'], times: 2 }]);
    save = recordResult(save, result('first-light', 'won', 350, ['untouched']), RUNS6).save;
    expect(save.campaign.completed[0]).toEqual({ runId: 'first-light', bestTimeSec: 350, medals: ['onTime', 'clean', 'untouched'], times: 3 });
    expect(save.campaign.unlocked).toBe(2);
  });

  it('fines beyond the pay cost money, but never below zero, and a replay does not halve them', () => {
    const start = { ...defaultSave(false), campaign: campaign({ money: 30, completed: [{ runId: 'first-light', bestTimeSec: 1, medals: [], times: 1 }] }) };
    const { save, payout } = recordResult(start, result('first-light', 'won', 500, [], { pay: 20, fines: 60 }), RUNS6);
    expect(payout).toMatchObject({ subtotal: -40, replay: true, replayDiscount: 0, total: -40 });
    expect(save.campaign.money).toBe(0);
  });

  it('losses change nothing (no pay, no fines), but still return a new object', () => {
    const before = sampleSave();
    const { save, payout } = recordResult(before, result('signal-country', 'lost', 100, ['onTime'], { fines: 50 }), RUNS6);
    expect(save).toEqual(before);
    expect(save).not.toBe(before);
    expect(save.campaign).not.toBe(before.campaign);
    expect(payout).toMatchObject({ won: false, total: 0 });
  });

  it('leaves the checkpoint to the session', () => {
    const before = { ...sampleSave(), checkpoint: sampleCheckpoint() };
    expect(recordResult(before, result('payroll', 'won', 100), RUNS6).save.checkpoint).toEqual(before.checkpoint);
  });

  it('never mutates its input', () => {
    const frozen = deepFreeze({ ...sampleSave(), checkpoint: sampleCheckpoint() });
    const copy = JSON.parse(JSON.stringify(frozen)) as SaveV1;
    expect(() => recordResult(frozen, result('first-light', 'won', 10, ['clean']), RUNS6)).not.toThrow();
    expect(() => recordResult(frozen, result('blackwater', 'won', 10), RUNS6)).not.toThrow();
    const next = recordResult(frozen, result('first-light', 'won', 10, ['clean']), RUNS6).save;
    next.campaign.completed[0].medals.push('onTime');
    next.settings.masterVolume = 0;
    next.checkpoint!.state.tick = 0;
    expect(frozen).toEqual(copy);
  });

  it('keeps completed entries in campaign order, and the last run keeps unlocked at the number of runs', () => {
    let save = recordResult(defaultSave(false), result('single-track', 'won', 700), RUNS6).save;
    save = recordResult(save, result('first-light', 'won', 400), RUNS6).save;
    expect(save.campaign.completed.map((e) => e.runId)).toEqual(['first-light', 'single-track']);
    save = recordResult(save, result('blackwater', 'won', 900), RUNS6).save;
    expect(save.campaign.unlocked).toBe(RUNS6.length);
    expect(isCompleted(save.campaign, 'blackwater')).toBe(true);
  });

  it('ignores runs of unknown ids and never unlocks fewer runs than before', () => {
    const { save, payout } = recordResult(sampleSave(), result('not-a-run', 'won', 100, ['onTime']), RUNS6);
    expect(save).toEqual(sampleSave());
    expect(payout.total).toBe(0);
    const high = { ...sampleSave(), campaign: { ...sampleSave().campaign, unlocked: 5 } };
    expect(recordResult(high, result('first-light', 'won', 1), RUNS6).save.campaign.unlocked).toBe(5);
  });

  it('payoutFor rounds to whole dollars and survives garbage numbers', () => {
    const r = result('first-light', 'won', 1, [], { pay: 99.6, total: Number.NaN });
    expect(payoutFor(r, false)).toMatchObject({ pay: 100, subtotal: 0, total: 0 });
    expect(payoutFor(result('first-light', 'won', 1, [], { pay: 101 }), true)).toMatchObject({ subtotal: 101, replayDiscount: 50, total: 51 });
  });
});

describe('isUnlocked and isCompleted', () => {
  it('a fresh campaign has only the first run open', () => {
    expect(RUNS6.map((_, i) => isUnlocked(defaultCampaign(), i, RUNS6))).toEqual([true, false, false, false, false, false]);
  });

  it('rejects indices outside the campaign', () => {
    const c = campaign({ unlocked: 6 });
    for (const i of [-1, 6, 1.5, Number.NaN]) expect(isUnlocked(c, i, RUNS6)).toBe(false);
  });

  it('follows wins through the campaign', () => {
    let save = defaultSave(false);
    RUNS6.forEach((run, i) => {
      expect(isUnlocked(save.campaign, i, RUNS6)).toBe(true);
      if (i + 1 < RUNS6.length) expect(isUnlocked(save.campaign, i + 1, RUNS6)).toBe(false);
      save = recordResult(save, result(run.id, 'won', 500), RUNS6).save;
      expect(isCompleted(save.campaign, run.id)).toBe(true);
    });
    expect(RUNS6.every((_, i) => isUnlocked(save.campaign, i, RUNS6))).toBe(true);
  });

  it('a completed run stays playable', () => {
    const c = campaign({ unlocked: 1, completed: [{ runId: 'night-freight', bestTimeSec: 1, medals: [], times: 1 }] });
    expect(isUnlocked(c, idx('night-freight'), RUNS6)).toBe(true);
    expect(isUnlocked(c, idx('payroll'), RUNS6)).toBe(false);
  });
});

describe('the depot', () => {
  it('sells upgrades for money, once each', () => {
    const rich = campaign({ money: 400 });
    const bought = buyItem(rich, 'rifle');
    expect(bought).toEqual({ ok: true, campaign: { ...rich, money: 150, owned: ['rifle'] } });
    const again = buyItem(bought.ok ? bought.campaign : rich, 'rifle');
    expect(again).toEqual({ ok: false, reason: 'You already own the Winchester rifle.' });
    expect(buyItem(campaign({ money: 149 }), 'shotgun')).toEqual({ ok: false, reason: 'Not enough money: the Coach gun costs $150.' });
    expect(buyItem(rich, 'jetpack' as never)).toEqual({ ok: false, reason: "The depot doesn't sell that." });
    expect(rich).toEqual(campaign({ money: 400 })); // untouched
  });

  it('keeps purchases in shop order', () => {
    let c = campaign({ money: 2000 });
    for (const item of ['caboose', 'shotgun', 'governor'] as const) {
      const out = buyItem(c, item);
      if (out.ok) c = out.campaign;
    }
    expect(c.owned).toEqual(SHOP.map((s) => s.id).filter((id) => ['caboose', 'shotgun', 'governor'].includes(id)));
  });

  it('offers the free cars, and bought cars once owned', () => {
    expect(availableCars(campaign())).toEqual(['express', 'passenger', 'boxcar']);
    expect(availableCars(campaign({ owned: ['caboose', 'rifle', 'armored'] }))).toEqual(['express', 'passenger', 'boxcar', 'armored', 'caboose']);
  });

  it('adds and removes optional cars, in a fixed front-to-back order', () => {
    const run = RUNS6[2];
    let out = toggleCar(campaign({ owned: ['caboose'] }), run, 'caboose');
    expect(out).toMatchObject({ ok: true, campaign: { consist: ['caboose'] } });
    out = toggleCar(out.ok ? out.campaign : campaign(), run, 'passenger');
    expect(out).toMatchObject({ ok: true, campaign: { consist: ['passenger', 'caboose'] } });
    out = toggleCar(out.ok ? out.campaign : campaign(), run, 'caboose');
    expect(out).toMatchObject({ ok: true, campaign: { consist: ['passenger'] } });
  });

  it('refuses required cars, cars not owned, powder cars and a full train', () => {
    expect(toggleCar(campaign(), RUNS6[1], 'express')).toEqual({ ok: false, reason: 'The contract needs the express car.' });
    expect(toggleCar(campaign(), RUNS6[2], 'armored')).toEqual({ ok: false, reason: 'Buy the armored car at the depot first.' });
    expect(toggleCar(campaign(), RUNS6[2], 'powder')).toEqual({ ok: false, reason: 'Only dynamite contracts carry a powder car.' });
    // Run 1 takes at most 3 cars behind the tender.
    const full = campaign({ consist: ['express', 'passenger', 'boxcar'], owned: ['caboose'] });
    expect(composeConsist(RUNS6[0], full.consist)).toHaveLength(3);
    expect(toggleCar(full, RUNS6[0], 'caboose')).toEqual({ ok: false, reason: 'The train is full: at most 3 cars behind the tender.' });
    // A chosen car that doesn't fit this run can still be taken off the list.
    const tooMany = campaign({ consist: ['express', 'passenger', 'boxcar', 'caboose'], owned: ['caboose'] });
    expect(toggleCar(tooMany, RUNS6[0], 'caboose')).toMatchObject({ ok: true, campaign: { consist: ['express', 'passenger', 'boxcar'] } });
    expect(toggleCar(campaign(), RUNS6[0], 'zeppelin' as never)).toEqual({ ok: false, reason: "There's no such car." });
  });

  it('switches assists per seat', () => {
    expect(setAssist(campaign(), 'engineer', true)).toEqual({ ok: true, campaign: campaign({ assists: { rider: false, engineer: true } }) });
    expect(setAssist(campaign(), 'fireman' as never, true)).toEqual({ ok: false, reason: 'There is no such seat.' });
  });
});

describe("the Engineer's client settings", () => {
  it('round-trip under their own key', () => {
    const storage = memoryStorage();
    const settings: Settings = { ...defaultSettings(false), effectsVolume: 0.1, lampLetters: true, hints: 'always' };
    writeClientSettings(settings, storage);
    expect([...storage.data.keys()]).toEqual([CLIENT_SETTINGS_KEY]);
    expect(CLIENT_SETTINGS_KEY).toBe('spur.settings.v1');
    expect(loadClientSettings(storage)).toEqual(settings);
    expect(loadSave(storage)).toEqual(defaultSave()); // separate from the host's save
  });

  it('fall back to defaults when missing or corrupt, and fill missing fields', () => {
    expect(loadClientSettings(memoryStorage())).toEqual(defaultSettings());
    expect(loadClientSettings(memoryStorage({ [CLIENT_SETTINGS_KEY]: '{oops' }))).toEqual(defaultSettings());
    expect(loadClientSettings(memoryStorage({ [CLIENT_SETTINGS_KEY]: '[1]' }))).toEqual(defaultSettings());
    expect(loadClientSettings(memoryStorage({ [CLIENT_SETTINGS_KEY]: '{"masterVolume":0.2,"hints":"never"}' }))).toEqual({
      ...defaultSettings(),
      masterVolume: 0.2,
      hints: 'never',
    });
  });
});
