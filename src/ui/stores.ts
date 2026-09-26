// Persistent state shared by the UI: the host's save and a role's settings (spec §17).
//
// Several tabs of the game may be open at once. Every write re-reads the save from storage first and
// changes only its own part, and each tab follows the others' writes ('storage' events), so an idle
// tab can't roll back progress another tab made.

import type { Payout } from '../net/protocol';
import {
  defaultSettings,
  loadClientSettings,
  loadSave,
  recordResult,
  SAVE_KEY,
  SaveError,
  takeCampaign,
  writeAsideSave,
  writeClientSettings,
  writeSave,
  type CampaignMerge,
  type SaveV1,
} from '../save/save';
import type { CampaignProgress, Checkpoint, RunResult, Settings } from '../sim/types';

export interface SettingsSource {
  get(): Settings;
  set(s: Settings): void;
  onChange(cb: (s: Settings) => void): () => void;
}

/** Applies only the changed fields to each source, so one role's other choices survive. */
export function patchSettings(sources: readonly SettingsSource[], patch: Partial<Settings>): void {
  for (const src of sources) src.set({ ...src.get(), ...patch });
}

/** The host keeps the whole save (campaign, settings, checkpoint) under spur.save.v1. */
export class SaveStore implements SettingsSource {
  save: SaveV1;
  /** Why the stored save couldn't be used at start-up (it was kept aside), if it couldn't. */
  problem: SaveError | null = null;
  private listeners = new Set<(s: Settings) => void>();
  private saveListeners = new Set<(save: SaveV1) => void>();

  constructor() {
    this.save = loadSave(undefined, (e) => (this.problem = e));
    window.addEventListener('storage', (e) => {
      if (e.key !== SAVE_KEY) return;
      this.save = loadSave();
      this.emit();
    });
  }

  /** The latest save in storage (another tab may have written it since we loaded). */
  private fresh(): SaveV1 {
    return loadSave();
  }

  private write(save: SaveV1): void {
    this.save = save;
    writeSave(save);
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.save.settings);
    for (const cb of this.saveListeners) cb(this.save);
  }

  get(): Settings {
    return this.save.settings;
  }

  set(s: Settings): void {
    this.write({ ...this.fresh(), settings: s });
    for (const cb of this.listeners) cb(s);
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Another tab (or an import) changed the campaign or the checkpoint. */
  onSaveChange(cb: (save: SaveV1) => void): () => void {
    this.saveListeners.add(cb);
    return () => this.saveListeners.delete(cb);
  }

  /** Records a finished run (money, unlocks, medals). */
  record(result: RunResult): { campaign: CampaignProgress; payout: Payout } {
    const out = recordResult(this.fresh(), result);
    this.write(out.save);
    return { campaign: out.save.campaign, payout: out.payout };
  }

  /** A depot change: a purchase, the consist, assists. */
  saveCampaign(campaign: CampaignProgress): void {
    this.write({ ...this.fresh(), campaign });
  }

  saveCheckpoint(checkpoint: Checkpoint | null): void {
    this.write({ ...this.fresh(), checkpoint });
  }

  /** A deliberate overwrite (importing a save code): everything is replaced, the checkpoint too. */
  replace(save: SaveV1): void {
    this.problem = null;
    this.write(save);
    this.emit();
  }

  /**
   * The pair's campaign from the other player's browser (spec §17), and its checkpoint when switching
   * seats: taken by takeCampaign()'s rules, with a different campaign it replaces kept aside.
   */
  takeCampaign(incoming: CampaignProgress, checkpoint?: Checkpoint | null): CampaignMerge {
    const current = this.fresh();
    const out = takeCampaign(current, incoming, checkpoint);
    if (out.outcome === 'keep') return out.outcome;
    if (out.aside) writeAsideSave(out.aside);
    // Lobby updates repeat the same campaign; only a real change is written.
    if (JSON.stringify(out.save) === JSON.stringify(current)) return out.outcome;
    this.write(out.save);
    this.emit();
    return out.outcome;
  }
}

/** The Engineer's client stores only their own settings (spec §17). */
export class ClientSettingsStore implements SettingsSource {
  private settings: Settings;
  private listeners = new Set<(s: Settings) => void>();

  constructor() {
    try {
      this.settings = loadClientSettings();
    } catch {
      this.settings = defaultSettings();
    }
  }

  get(): Settings {
    return this.settings;
  }

  set(s: Settings): void {
    this.settings = s;
    writeClientSettings(s);
    for (const cb of this.listeners) cb(s);
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
