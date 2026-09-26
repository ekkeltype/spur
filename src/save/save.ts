// Saving (spec §17). The host keeps the campaign, settings and checkpoint in localStorage under
// spur.save.v1; the Engineer's client keeps only their own settings under spur.settings.v1.
// Loading falls back to defaults on missing, corrupt or unavailable storage, and writing never
// throws (quota, private mode). A save that can't be read is copied to UNREADABLE_SAVE_KEY first,
// so it's never lost to the defaults being saved over it (for example a save from a newer version
// opened in an old tab).
//
// The campaign rules the depot and the results screen apply (spec §12: the shop, the consist,
// assists, payouts, unlocks) live here too, as pure functions on CampaignProgress. Every function
// that needs the run list takes it last, defaulting to the campaign's RUNS, so tests can use their own.

import { RUNS } from '../content/runs';
import type { Payout } from '../net/protocol';
import { composeConsist, newGame } from '../sim/game';
import { DEFAULT_MAX_CARS, FREE_CARS, REPLAY_PAY_FACTOR, SHOP } from '../sim/rules';
import type {
  Assists,
  CampaignProgress,
  CarKind,
  CarType,
  Checkpoint,
  CompletedEntry,
  GameState,
  Medal,
  RunDef,
  RunResult,
  Settings,
  UpgradeId,
} from '../sim/types';

export const SAVE_KEY = 'spur.save.v1';
/** The Engineer's client stores only their own settings. */
export const CLIENT_SETTINGS_KEY = 'spur.settings.v1';
/** Where loadSave() keeps the raw text of a save it couldn't read. */
export const UNREADABLE_SAVE_KEY = 'spur.save.unreadable';

export interface SaveV1 {
  version: 1;
  campaign: CampaignProgress;
  settings: Settings;
  /** The last checkpoint (spec §17), or null. */
  checkpoint: Checkpoint | null;
}

type Runs = readonly RunDef[];

export class SaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SaveError';
  }
}

const NEWER_VERSION = 'This save is from a newer version of Switch & Spur. Update the game to use it.';
const NOT_A_SAVE = "This isn't a Switch & Spur save.";
const DAMAGED = "This save is damaged and can't be read.";
const BAD_CODE = "That save code isn't valid. Make sure you copied the whole code.";
const EMPTY_CODE = 'Paste a save code first.';

/** Medals in the order the results screen lists them. */
export const MEDAL_ORDER: readonly Medal[] = ['onTime', 'clean', 'untouched'];

/** Every car type, in the order optional cars are coupled behind the required ones (the caboose last). */
const CAR_ORDER: readonly CarType[] = ['express', 'passenger', 'boxcar', 'armored', 'caboose', 'powder'];
/** Cars bought in the shop (their UpgradeId is the car type). */
const BOUGHT_CARS: readonly CarType[] = ['armored', 'caboose'];

export const CAR_NAMES: Record<CarKind, string> = {
  loco: 'locomotive',
  tender: 'tender',
  express: 'express car',
  passenger: 'passenger car',
  boxcar: 'boxcar',
  armored: 'armored car',
  caboose: 'caboose',
  powder: 'powder car',
};

// ---------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------

/**
 * Default settings. Screen shake starts off for players who ask their system for reduced motion;
 * when the argument is omitted, that preference is read from the browser if it can be.
 */
export function defaultSettings(prefersReducedMotion: boolean = systemPrefersReducedMotion()): Settings {
  return {
    masterVolume: 0.8,
    effectsVolume: 0.8,
    screenShake: !prefersReducedMotion,
    hints: 'first',
    lampLetters: false,
  };
}

/** A new campaign: the first run open, no money, nothing owned, no assists, no optional cars. */
export function defaultCampaign(): CampaignProgress {
  return { unlocked: 1, money: 0, owned: [], completed: [], assists: { rider: false, engineer: false }, consist: [] };
}

export function defaultSave(prefersReducedMotion?: boolean): SaveV1 {
  return { version: 1, campaign: defaultCampaign(), settings: defaultSettings(prefersReducedMotion), checkpoint: null };
}

function systemPrefersReducedMotion(): boolean {
  try {
    return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Migration and validation
// ---------------------------------------------------------------------------------------------

/**
 * Turns parsed save data into a clean SaveV1.
 *
 * - An object without `version` (or with version 0) is read as version 1, with the campaign's fields
 *   at the top level or inside `campaign` (a hand-made or trimmed save). It must have at least one
 *   campaign field.
 * - Missing or invalid settings fields get their defaults; volumes are clamped to 0..1.
 * - Money is a whole number ≥ 0; owned upgrades are known ones, once each, in shop order; the
 *   optional consist keeps cars that can be chosen (the free ones, bought ones once owned).
 * - `unlocked` is clamped to 1..runs.length and raised to cover every completed run.
 * - Completed entries need a runId and a finite, non-negative best time; others are dropped.
 *   Duplicates merge (best time, union of medals, sum of wins). Entries for unknown runs are kept.
 * - A checkpoint this build couldn't resume is dropped (see cleanCheckpoint).
 *
 * Throws SaveError for newer versions and for data that isn't a save.
 */
export function migrate(raw: unknown, runs: Runs = RUNS): SaveV1 {
  if (!isRecord(raw)) throw new SaveError(NOT_A_SAVE);
  if (!('version' in raw)) return unversioned(raw, runs);
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) throw new SaveError(DAMAGED);
  if (version > 1) throw new SaveError(NEWER_VERSION);
  if (version === 0) return unversioned(raw, runs);
  if (!isRecord(raw.campaign)) throw new SaveError(DAMAGED);
  return { version: 1, campaign: cleanCampaign(raw.campaign, runs), settings: cleanSettings(raw.settings), checkpoint: cleanCheckpoint(raw.checkpoint, runs) };
}

const CAMPAIGN_FIELDS = ['unlocked', 'completed', 'money', 'owned'];

function unversioned(raw: Record<string, unknown>, runs: Runs): SaveV1 {
  const campaign = isRecord(raw.campaign) ? raw.campaign : raw;
  if (!isRecord(raw.campaign) && !CAMPAIGN_FIELDS.some((f) => f in campaign)) throw new SaveError(NOT_A_SAVE);
  return { version: 1, campaign: cleanCampaign(campaign, runs), settings: cleanSettings(raw.settings), checkpoint: cleanCheckpoint(raw.checkpoint, runs) };
}

function cleanCampaign(raw: Record<string, unknown>, runs: Runs): CampaignProgress {
  const byRun = new Map<string, CompletedEntry>();
  if (Array.isArray(raw.completed)) {
    for (const item of raw.completed) {
      const entry = cleanEntry(item);
      if (!entry) continue;
      const earlier = byRun.get(entry.runId);
      byRun.set(entry.runId, earlier ? mergeEntries(earlier, entry) : entry);
    }
  }
  const completed = sortEntries([...byRun.values()], runs);
  let unlocked = typeof raw.unlocked === 'number' && Number.isFinite(raw.unlocked) ? Math.floor(raw.unlocked) : 1;
  for (const entry of completed) {
    const index = runIndex(entry.runId, runs);
    if (index >= 0) unlocked = Math.max(unlocked, index + 2); // winning a run opens the next
  }
  const owned = cleanOwned(raw.owned);
  return {
    unlocked: clamp(unlocked, 1, Math.max(1, runs.length)),
    money: cleanMoney(raw.money),
    owned,
    completed,
    assists: cleanAssists(raw.assists),
    consist: cleanConsist(raw.consist, owned),
  };
}

function cleanEntry(raw: unknown): CompletedEntry | null {
  if (!isRecord(raw)) return null;
  const { runId, bestTimeSec, medals, times } = raw;
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof bestTimeSec !== 'number' || !Number.isFinite(bestTimeSec) || bestTimeSec < 0) return null;
  const wins = typeof times === 'number' && Number.isFinite(times) ? Math.max(1, Math.floor(times)) : 1;
  return { runId, bestTimeSec, medals: cleanMedals(Array.isArray(medals) ? medals : []), times: wins };
}

function mergeEntries(a: CompletedEntry, b: CompletedEntry): CompletedEntry {
  return {
    runId: a.runId,
    bestTimeSec: Math.min(a.bestTimeSec, b.bestTimeSec),
    medals: cleanMedals([...a.medals, ...b.medals]),
    times: a.times + b.times,
  };
}

/** Known medals only, once each, in MEDAL_ORDER. */
function cleanMedals(list: readonly unknown[]): Medal[] {
  return MEDAL_ORDER.filter((m) => list.includes(m));
}

/** Campaign order; unknown runs last, in their original order. */
function sortEntries(entries: CompletedEntry[], runs: Runs): CompletedEntry[] {
  const rank = (e: CompletedEntry): number => {
    const i = runIndex(e.runId, runs);
    return i >= 0 ? i : runs.length;
  };
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.order - b.order)
    .map(({ entry }) => entry);
}

function cleanMoney(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cleanOwned(value: unknown): UpgradeId[] {
  if (!Array.isArray(value)) return [];
  return SHOP.map((s) => s.id).filter((id) => value.includes(id));
}

function cleanAssists(value: unknown): Assists {
  const r = isRecord(value) ? value : {};
  return { rider: r.rider === true, engineer: r.engineer === true };
}

/** The optional cars last chosen: ones that can be chosen, once each, in coupling order. */
function cleanConsist(value: unknown, owned: readonly UpgradeId[]): CarType[] {
  if (!Array.isArray(value)) return [];
  const choosable = availableCars({ owned });
  return CAR_ORDER.filter((c) => choosable.includes(c) && value.includes(c)).slice(0, DEFAULT_MAX_CARS);
}

function cleanSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isRecord(raw)) return d;
  return {
    masterVolume: cleanVolume(raw.masterVolume, d.masterVolume),
    effectsVolume: cleanVolume(raw.effectsVolume, d.effectsVolume),
    screenShake: typeof raw.screenShake === 'boolean' ? raw.screenShake : d.screenShake,
    hints: cleanHints(raw.hints, d.hints),
    lampLetters: typeof raw.lampLetters === 'boolean' ? raw.lampLetters : d.lampLetters,
  };
}

function cleanVolume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : fallback;
}

function cleanHints(value: unknown, fallback: Settings['hints']): Settings['hints'] {
  if (value === 'first' || value === 'always' || value === 'never') return value;
  if (value === true) return 'first'; // an on/off switch
  if (value === false) return 'never';
  return fallback;
}

// ---------------------------------------------------------------------------------------------
// Checkpoints (spec §17)
// ---------------------------------------------------------------------------------------------

/**
 * A checkpoint of the game as it leaves a checkpoint station: a deep copy, so the running game
 * can't change it afterwards.
 */
export function checkpointOf(state: GameState, run: RunDef, stationId: string, consist: readonly CarType[], upgrades: readonly UpgradeId[]): Checkpoint {
  const station = run.stations.find((s) => s.id === stationId);
  return {
    runId: run.id,
    seed: state.seed,
    stationId,
    stationName: station?.name ?? stationId,
    consist: [...consist],
    upgrades: [...upgrades],
    state: deepCopy(state),
  };
}

/** The checkpoint's game state, as a fresh copy to play on (a JSON round trip, spec §0 note 2). */
export function restoreCheckpoint(cp: Checkpoint): GameState {
  return deepCopy(cp.state);
}

/** Parts of GameState whose own fields are compared with this build's (see cleanCheckpoint). */
const STATE_PARTS = ['train', 'rider', 'loot', 'stats', 'signals'] as const;

/**
 * A stored checkpoint this build can resume, or null. Besides its own fields, the state must be of
 * the checkpoint's run and seed and still running, and have every field a GameState from this
 * build's newGame() has: at the top level (arrays where this build has arrays) and in the train,
 * the Rider, the loot, the stats and the signal memo. A checkpoint saved by an older build, missing
 * fields the sim now reads, would otherwise break the sim on its first tick. Extra fields are
 * fine: the sim may add optional ones as it goes (the Rider's healTicks), and unknown ones are ignored.
 */
export function cleanCheckpoint(raw: unknown, runs: Runs = RUNS): Checkpoint | null {
  if (!isRecord(raw)) return null;
  const { runId, seed, stationId, stationName, consist, state } = raw;
  const run = runs.find((r) => r.id === runId);
  if (!run || typeof stationId !== 'string' || typeof stationName !== 'string') return null;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) return null;
  if (!Array.isArray(consist) || !consist.every((c) => CAR_ORDER.includes(c as CarType))) return null;
  if (!isRecord(state) || state.runId !== run.id || state.seed !== seed || state.phase !== 'running' || typeof state.tick !== 'number') return null;
  const upgrades = cleanOwned(raw.upgrades);
  let fresh: GameState;
  try {
    fresh = newGame(run, { seed, consist: consist as CarType[], upgrades, assists: cleanAssists(state.assists) });
  } catch {
    return null;
  }
  if (!hasFieldsOf(state, fresh)) return null;
  for (const [key, value] of Object.entries(fresh)) {
    if (Array.isArray(value) !== Array.isArray(state[key])) return null;
  }
  for (const part of STATE_PARTS) if (!hasFieldsOf(state[part], fresh[part])) return null;
  return { runId: run.id, seed, stationId, stationName, consist: [...(consist as CarType[])], upgrades, state: state as unknown as GameState };
}

/** `saved` is an object with at least the fields of `model`. */
function hasFieldsOf(saved: unknown, model: unknown): boolean {
  return isRecord(saved) && isRecord(model) && Object.keys(model).every((k) => k in saved);
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

/**
 * The host's save, or defaults if there is none or it can't be read (never throws). An unreadable
 * save is kept under UNREADABLE_SAVE_KEY and reported to `onProblem`, e.g. to tell the player
 * their save is from a newer version. `storage` defaults to localStorage when there is one.
 */
export function loadSave(storage?: Storage, onProblem?: (error: SaveError) => void, runs: Runs = RUNS): SaveV1 {
  const store = storageOrDefault(storage);
  const text = readItem(store, SAVE_KEY);
  if (text === null) return defaultSave();
  try {
    return migrate(JSON.parse(text), runs);
  } catch (err) {
    const error = err instanceof SaveError ? err : new SaveError(DAMAGED);
    console.warn(`[spur] ${error.message} Starting a fresh save; the old one is kept as "${UNREADABLE_SAVE_KEY}".`);
    if (store) writeItem(store, UNREADABLE_SAVE_KEY, text);
    if (onProblem) {
      try {
        onProblem(error);
      } catch (listenerError) {
        console.error(listenerError);
      }
    }
    return defaultSave();
  }
}

/** Stores the host's save. Never throws: a full or blocked storage just means it isn't saved. */
export function writeSave(save: SaveV1, storage?: Storage): void {
  const store = storageOrDefault(storage);
  if (store) writeItem(store, SAVE_KEY, JSON.stringify(save));
}

/** The Engineer's own settings, or defaults (never throws). */
export function loadClientSettings(storage?: Storage): Settings {
  const text = readItem(storageOrDefault(storage), CLIENT_SETTINGS_KEY);
  if (text === null) return defaultSettings();
  try {
    return cleanSettings(JSON.parse(text));
  } catch {
    return defaultSettings();
  }
}

export function writeClientSettings(settings: Settings, storage?: Storage): void {
  const store = storageOrDefault(storage);
  if (store) writeItem(store, CLIENT_SETTINGS_KEY, JSON.stringify(settings));
}

function storageOrDefault(storage: Storage | undefined): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null; // accessing it throws when site data is blocked
  } catch {
    return null;
  }
}

function readItem(store: Storage | null, key: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function writeItem(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch (err) {
    console.warn(`[spur] Couldn't save "${key}":`, err);
  }
}

// ---------------------------------------------------------------------------------------------
// Save codes (spec §17: export and import, as in Clew)
// ---------------------------------------------------------------------------------------------

/**
 * The save as base64 of its UTF-8 JSON. The checkpoint (a whole game state) is left out: codes are
 * for moving a campaign between browsers, and it would make them many times longer.
 */
export function exportSaveCode(save: SaveV1): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...save, checkpoint: null }));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Reads a save code (whitespace and line breaks anywhere are ignored; URL-safe base64 and missing
 * padding are fine; plain save JSON is accepted too) and migrates it. Throws SaveError with a
 * message for the player.
 */
export function importSaveCode(code: string, runs: Runs = RUNS): SaveV1 {
  const text = typeof code === 'string' ? code.trim() : '';
  if (text === '') throw new SaveError(EMPTY_CODE);
  let json = text;
  if (!text.startsWith('{')) {
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(text.replace(/\s+/g, '')));
    } catch {
      throw new SaveError(BAD_CODE);
    }
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SaveError(BAD_CODE);
  }
  return migrate(raw, runs);
}

function base64ToBytes(base64: string): Uint8Array {
  let b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('not base64');
  b64 = b64.replace(/=+$/, '');
  if (b64.length % 4 === 1) throw new Error('truncated base64');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Payouts and campaign progress (spec §12)
// ---------------------------------------------------------------------------------------------

/**
 * What a finished run pays. A win pays the sim's total (pay − late penalty, never below 0, + cargo
 * + side jobs − fines); a replay takes REPLAY_PAY_FACTOR of it when it's positive, cargo included,
 * so fines are never halved. A loss pays nothing and costs nothing. Amounts are whole dollars.
 */
export function payoutFor(result: RunResult, replay: boolean): Payout {
  const fines = dollars(result.fines);
  if (result.outcome !== 'won') {
    return { won: false, pay: 0, latePenalty: 0, cargoPay: 0, sideJobPay: 0, fines, subtotal: 0, replay, replayDiscount: 0, total: 0 };
  }
  const subtotal = dollars(result.total);
  const replayDiscount = replay && subtotal > 0 ? subtotal - Math.round(subtotal * REPLAY_PAY_FACTOR) : 0;
  return {
    won: true,
    pay: dollars(result.pay),
    latePenalty: dollars(result.latePenalty),
    cargoPay: dollars(result.cargoPay),
    sideJobPay: dollars(result.sideJobPay),
    fines,
    subtotal,
    replay,
    replayDiscount,
    total: subtotal - replayDiscount,
  };
}

/**
 * Applies a finished run. A win adds its payout to the money (never below 0), unlocks the next run
 * (up to the last), and records the best time (the minimum), the union of medals and one more win.
 * Losses, and runs of unknown ids, change nothing. The checkpoint is the session's business.
 * Returns a new SaveV1; the input is never mutated.
 */
export function recordResult(save: SaveV1, result: RunResult, runs: Runs = RUNS): { save: SaveV1; payout: Payout } {
  const next = deepCopy(save);
  const index = runIndex(result.runId, runs);
  const campaign = next.campaign;
  const existing = campaign.completed.find((e) => e.runId === result.runId);
  const payout = payoutFor(result, !!existing);
  if (index < 0) return { save: next, payout: payoutFor({ ...result, outcome: 'lost' }, false) };
  if (result.outcome !== 'won') return { save: next, payout };

  campaign.money = Math.max(0, campaign.money + payout.total);
  campaign.unlocked = clamp(Math.max(campaign.unlocked, index + 2), 1, runs.length);
  const time = Number.isFinite(result.timeSec) ? Math.max(0, result.timeSec) : 0;
  if (existing) {
    existing.bestTimeSec = Math.min(existing.bestTimeSec, time);
    existing.medals = cleanMedals([...existing.medals, ...result.medals]);
    existing.times += 1;
  } else {
    campaign.completed.push({ runId: result.runId, bestTimeSec: time, medals: cleanMedals(result.medals), times: 1 });
  }
  campaign.completed = sortEntries(campaign.completed, runs);
  return { save: next, payout };
}

export function isCompleted(campaign: CampaignProgress, runId: string): boolean {
  return campaign.completed.some((e) => e.runId === runId);
}

/** Whether run `index` (0-based) can be played: winning one opens the next, and a won run stays open. */
export function isUnlocked(campaign: CampaignProgress, index: number, runs: Runs = RUNS): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= runs.length) return false;
  return index < campaign.unlocked || isCompleted(campaign, runs[index].id);
}

// ---------------------------------------------------------------------------------------------
// The depot: shop, consist and assists (spec §12)
// ---------------------------------------------------------------------------------------------

export type DepotResult = { ok: true; campaign: CampaignProgress } | { ok: false; reason: string };

const refuse = (reason: string): DepotResult => ({ ok: false, reason });

/** Optional cars this campaign can couple: the free ones, and bought ones once owned. */
export function availableCars(campaign: { owned: readonly UpgradeId[] }): CarType[] {
  return CAR_ORDER.filter((c) => FREE_CARS.includes(c) || (BOUGHT_CARS.includes(c) && campaign.owned.includes(c as UpgradeId)));
}

/** Buys a shop item with the campaign's money. */
export function buyItem(campaign: CampaignProgress, item: UpgradeId): DepotResult {
  const entry = SHOP.find((s) => s.id === item);
  if (!entry) return refuse("The depot doesn't sell that.");
  if (campaign.owned.includes(entry.id)) return refuse(`You already own the ${entry.name}.`);
  if (campaign.money < entry.cost) return refuse(`Not enough money: the ${entry.name} costs $${entry.cost}.`);
  const owned = cleanOwned([...campaign.owned, entry.id]);
  return { ok: true, campaign: { ...campaign, money: campaign.money - entry.cost, owned } };
}

/**
 * Adds an optional car to the train for `run`, or takes it off the list. The run's required cars
 * are always coupled; the others go behind them in a fixed order, as many as fit in run.maxCars.
 * A car on the list that doesn't fit this run can still be taken off.
 */
export function toggleCar(campaign: CampaignProgress, run: RunDef, car: CarType): DepotResult {
  if (!CAR_ORDER.includes(car)) return refuse("There's no such car.");
  if (run.requiredCars.includes(car)) return refuse(`The contract needs the ${CAR_NAMES[car]}.`);
  if (campaign.consist.includes(car)) {
    return { ok: true, campaign: { ...campaign, consist: campaign.consist.filter((c) => c !== car) } };
  }
  if (car === 'powder') return refuse('Only dynamite contracts carry a powder car.');
  if (!availableCars(campaign).includes(car)) return refuse(`Buy the ${CAR_NAMES[car]} at the depot first.`);
  if (composeConsist(run, campaign.consist).length >= run.maxCars) {
    return refuse(`The train is full: at most ${run.maxCars} cars behind the tender.`);
  }
  const consist = CAR_ORDER.filter((c) => c === car || campaign.consist.includes(c));
  return { ok: true, campaign: { ...campaign, consist } };
}

export function setAssist(campaign: CampaignProgress, seat: 'rider' | 'engineer', on: boolean): DepotResult {
  if (seat !== 'rider' && seat !== 'engineer') return refuse('There is no such seat.');
  return { ok: true, campaign: { ...campaign, assists: { ...campaign.assists, [seat]: on === true } } };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function runIndex(runId: string, runs: Runs): number {
  return runs.findIndex((r) => r.id === runId);
}

function dollars(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
