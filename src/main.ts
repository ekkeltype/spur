// Boot and screen routing (spec §3, §19).
//
// Query parameters: ?local=1 (local test mode) and ?join=CODE (the join screen with the code filled
// in) work in every build. Dev builds also read ?run=N (1-based, or a run id) to preselect a run,
// ?seed=S for the next start, ?debug=1 for the overlays, and ?autopilot=1 for a self-driving
// Engineer.

import './ui/styles.css';
import { Sfx } from './audio/sfx';
import { RUNS } from './content/runs';
import type { AutopilotHook } from './net/host';
import { createLocalPair } from './net/local';
import { autopilotStep, newAutopilot, type AutopilotState } from './sim/autopilot';
import { tryLowerSpout } from './sim/train';
import { ClientApp } from './ui/client-app';
import { h } from './ui/dom';
import { HostApp } from './ui/host-app';
import { settingsScreen } from './ui/settings';
import { ClientSettingsStore, patchSettings, SaveStore, type SettingsSource } from './ui/stores';
import { titleScreen } from './ui/title';

interface Active {
  frame(now: number): void;
  destroy(): void;
}

const root = document.getElementById('app')!;
const sfx = new Sfx();
const store = new SaveStore();
const clientStore = new ClientSettingsStore();
const params = new URLSearchParams(location.search);
const dev = import.meta.env.DEV;
const debug = dev && params.get('debug') === '1';
const seedParam = dev && params.has('seed') ? Number.parseInt(params.get('seed') ?? '', 10) : Number.NaN;
const forcedSeed = Number.isFinite(seedParam) ? seedParam >>> 0 : null;
const forcedRun = dev ? runFromParam(params.get('run')) : null;
const autopilot = dev && params.get('autopilot') === '1';

/** ?run=2 picks the second run; a run id works too. */
function runFromParam(v: string | null): number | null {
  if (v === null || v === '') return null;
  const byId = RUNS.findIndex((r) => r.id === v);
  if (byId >= 0) return byId;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= RUNS.length ? n - 1 : null;
}

/**
 * Dev, ?autopilot=1: the plan-following Engineer (src/sim/autopilot.ts) drives the train, so one
 * person can play the Rider's side against a competent Engineer. It lowers the spout by itself.
 */
function autopilotHook(): AutopilotHook | null {
  let ap: AutopilotState | null = null;
  return {
    begin: (run, state) => {
      ap = newAutopilot(run, state.variant);
    },
    step: (state, run) => {
      ap ??= newAutopilot(run, state.variant);
      const out = autopilotStep(ap, state, run);
      if (out.lowerSpout) tryLowerSpout(state, run, [], { force: true });
      return out.cmds;
    },
  };
}

function applyAutopilot(host: HostApp): void {
  if (!autopilot) return;
  host.session.autopilot = autopilotHook();
  if (!host.session.autopilot) console.info('[spur] ?autopilot=1: no autopilot is wired in yet (see autopilotHook in main.ts).');
}

let active: Active[] = [];

// The speakers follow the settings of the seat on screen: the host save, or the Engineer's own settings.
let volumeSource: SettingsSource = store;
function applyVolumes(): void {
  const s = volumeSource.get();
  sfx.setVolumes(s.masterVolume, s.effectsVolume);
}
function useVolumes(source: SettingsSource): void {
  volumeSource = source;
  applyVolumes();
}
applyVolumes();
store.onChange(() => volumeSource === store && applyVolumes());
clientStore.onChange(() => volumeSource === clientStore && applyVolumes());
window.addEventListener('pointerdown', () => sfx.unlock());
window.addEventListener('keydown', () => sfx.unlock());

function stopAll(): void {
  for (const a of active) a.destroy();
  active = [];
  sfx.stopAll();
}

function show(el: HTMLElement): void {
  root.replaceChildren(el);
}

function showTitle(): void {
  stopAll();
  useVolumes(store);
  show(
    titleScreen({
      host: startHost,
      join: () => startJoin(),
      local: startLocal,
      settings: () => showSettings([store, clientStore], showTitle),
      notice: store.problem ? `${store.problem.message} The old save was kept aside in this browser; you can keep playing with a fresh campaign.` : undefined,
    }),
  );
}

/** A settings screen in place of the current page; `back` restores what was there. */
function showSettings(sources: SettingsSource[], back: () => void): void {
  show(
    settingsScreen(
      () => sources[0].get(),
      (patch) => patchSettings(sources, patch),
      back,
      () => sfx.uiClick(),
    ),
  );
}

/** Settings on top of a running app, without tearing it down. */
function settingsOver(host: HTMLElement, sources: SettingsSource[]): void {
  const layer = h('div', { class: 'settings-layer' });
  layer.append(
    settingsScreen(
      () => sources[0].get(),
      (patch) => patchSettings(sources, patch),
      () => layer.remove(),
      () => sfx.uiClick(),
    ),
  );
  host.append(layer);
}

function startHost(): void {
  stopAll();
  useVolumes(store);
  const pane = h('div', { class: 'app-root' });
  const wrap = h('div', { class: 'app-wrap' }, pane);
  show(wrap);
  const host = new HostApp({
    root: pane,
    mode: 'online',
    store,
    sfx,
    debug,
    forcedSeed,
    forcedRun,
    onExit: showTitle,
    onSettings: () => settingsOver(wrap, [store]),
  });
  applyAutopilot(host);
  active = [host];
  exposeForChecks({ host });
  void host.openRoom();
}

function startJoin(code?: string): void {
  stopAll();
  useVolumes(clientStore);
  const pane = h('div', { class: 'app-root' });
  const wrap = h('div', { class: 'app-wrap' }, pane);
  show(wrap);
  const client = new ClientApp({
    root: pane,
    mode: 'online',
    settings: clientStore,
    sfx,
    debug,
    onExit: showTitle,
    onSettings: () => settingsOver(wrap, [clientStore]),
    initialCode: code,
  });
  active = [client];
  exposeForChecks({ client });
  if (code) client.join(code);
}

function startLocal(): void {
  stopAll();
  useVolumes(store);
  const leftRoot = h('div', { class: 'app-root' });
  const rightRoot = h('div', { class: 'app-root' });
  const left = h('div', { class: 'pane' }, leftRoot, h('div', { class: 'pane-label', text: 'Rider · keyboard and mouse' }));
  const right = h('div', { class: 'pane' }, rightRoot, h('div', { class: 'pane-label', text: 'Engineer · mouse' }));
  const split = h('div', { class: 'split' }, left, right);
  show(split);
  const pair = createLocalPair();
  const host = new HostApp({
    root: leftRoot,
    mode: 'local',
    store,
    sfx,
    debug,
    forcedSeed,
    forcedRun,
    onExit: showTitle,
    onSettings: () => settingsOver(split, [store]),
  });
  const client = new ClientApp({
    root: rightRoot,
    mode: 'local',
    settings: store,
    sfx: null, // one set of speakers: the Rider's audio only
    debug,
    onExit: showTitle,
    onSettings: () => settingsOver(split, [store]),
    autoReady: true,
  });
  applyAutopilot(host);
  host.attachTransport(pair.host);
  client.attachTransport(pair.client);
  active = [host, client, { frame: () => {}, destroy: () => pair.host.close() }];
  exposeForChecks({ host, client, pair });
}

/** Dev builds: window.__spur = { host, client, pair } (whichever exist) for automated end-to-end checks. */
function exposeForChecks(apps: Record<string, unknown>): void {
  if (dev) (window as unknown as { __spur?: unknown }).__spur = apps;
}

function loop(now: number): void {
  for (const a of active) {
    try {
      a.frame(now);
    } catch (e) {
      console.error(e);
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

if (params.get('local') === '1') startLocal();
else if (params.get('join')) startJoin(params.get('join') ?? undefined);
else showTitle();
