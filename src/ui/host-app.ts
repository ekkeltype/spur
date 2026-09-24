// The Rider's side (spec §3, §16): hosts the room, runs the sim, and shows the depot, the briefing,
// the side view and the results.

import type { Sfx } from '../audio/sfx';
import { HostSession, type HostGame } from '../net/host';
import { PeerHost } from '../net/peer';
import type { DepotAction } from '../net/protocol';
import type { Transport } from '../net/transport';
import { RiderRenderer } from '../render/rider/renderer';
import { exportSaveCode, importSaveCode, SaveError } from '../save/save';
import { spoutPrompt } from '../sim/train';
import { NO_INPUT, type GameState, type RunDef, type SimEvent } from '../sim/types';
import { button, clear, copyText, h } from './dom';
import { Hints, hintsOn, Toaster } from './feedback';
import { RiderControls, type AimContext } from './input';
import { depotBoard } from './lobby';
import { briefingScreen, countdownOverlay, pauseOverlay, readyRow, resultsScreen, type PauseView } from './screens';
import { RiderSounds, type ViewSpan } from './sounds';
import type { SaveStore } from './stores';
import { money } from './text';

export interface HostAppOptions {
  root: HTMLElement;
  mode: 'online' | 'local';
  store: SaveStore;
  sfx: Sfx;
  debug: boolean;
  forcedSeed: number | null;
  forcedRun: number | null;
  onExit: () => void;
  onSettings: () => void;
}

interface ScreenCtl {
  name: string;
  el: HTMLElement;
  update(): void;
  destroy?(): void;
}

export class HostApp {
  readonly session: HostSession;
  private peer: PeerHost | null = null;
  private peerError = '';
  private opening = false;
  private destroyed = false;
  private current: ScreenCtl | null = null;
  private play: RiderPlay | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private opts: HostAppOptions) {
    const store = opts.store;
    this.session = new HostSession({
      campaign: store.save.campaign,
      checkpoint: store.save.checkpoint,
      recordResult: (r) => store.record(r),
      saveCampaign: (c) => store.saveCampaign(c),
      saveCheckpoint: (cp) => store.saveCheckpoint(cp),
      forcedSeed: opts.forcedSeed,
      forcedRun: opts.forcedRun,
      debug: opts.debug,
    });
    this.unsubs.push(this.session.onChange(() => this.refresh()));
    this.unsubs.push(this.session.onEvents((ev) => this.play?.onEvents(ev)));
    // Another tab of the game, or an imported save code, changed the save: show it rather than a stale copy.
    this.unsubs.push(store.onSaveChange((save) => this.session.syncSave(save.campaign, save.checkpoint)));
    document.addEventListener('visibilitychange', this.onVisibility);
    this.refresh();
  }

  /** Online: registers a room with the PeerJS signalling server. */
  async openRoom(): Promise<void> {
    if (this.opening || this.peer || this.destroyed) return;
    this.opening = true;
    this.peerError = '';
    this.refresh();
    try {
      // Reuse the code from before a reload, so the Engineer's retrying client finds the room again.
      const peer = await PeerHost.open({ code: readRoomCode() ?? undefined });
      if (this.destroyed) {
        peer.destroy();
        return;
      }
      this.peer = peer;
      writeRoomCode(peer.code);
      peer.onError((msg) => {
        this.peerError = msg;
        this.refresh();
      });
      peer.onRecovered(() => {
        this.peerError = '';
        this.refresh();
      });
      this.session.attachTransport(peer.transport);
    } catch (e) {
      this.peerError = e instanceof Error ? e.message : String(e);
    }
    this.opening = false;
    this.refresh();
  }

  attachTransport(t: Transport): void {
    this.session.attachTransport(t);
  }

  frame(now: number): void {
    this.session.frame(now);
    this.play?.frame(now);
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.play?.destroy();
    this.play = null;
    this.current?.destroy?.();
    this.session.detachTransport();
    this.peer?.destroy();
    clear(this.opts.root);
  }

  private onVisibility = (): void => {
    if (!document.hidden || this.opts.mode !== 'online') return;
    // The sim stops with a hidden page, so don't let a countdown start (or run) meanwhile.
    const s = this.session;
    s.requestPause();
    const waiting = s.screen === 'briefing' || (s.screen === 'playing' && s.mode === 'paused');
    if (waiting && s.hostReady) s.setReady(false);
  };

  /** Dev debug keys (spec §19): ] [ sim speed, G god mode, K kill bandits, N skip 500 m. */
  debugKey(code: string): void {
    if (!import.meta.env.DEV) return;
    const s = this.session;
    let what = '';
    switch (code) {
      case 'BracketRight':
        s.simSpeed = Math.min(8, s.simSpeed * 2);
        what = `sim speed ×${s.simSpeed}`;
        break;
      case 'BracketLeft':
        s.simSpeed = Math.max(0.125, s.simSpeed / 2);
        what = `sim speed ×${s.simSpeed}`;
        break;
      case 'KeyG': {
        const on = !(s.game?.state.godMode ?? false);
        s.queueDebug({ kind: 'god', on });
        what = on ? 'god mode on' : 'god mode off';
        break;
      }
      case 'KeyK':
        s.queueDebug({ kind: 'killBandits' });
        what = 'bandits removed';
        break;
      case 'KeyN':
        s.queueDebug({ kind: 'skip', meters: 500 });
        what = 'skipped 500 m';
        break;
    }
    if (what) this.play?.toast(`Debug: ${what}`);
  }

  private screenKey(): string {
    const s = this.session;
    return s.screen === 'lobby' ? 'lobby' : `${s.screen}:${s.gameId}`;
  }

  private refresh(): void {
    const key = this.screenKey();
    if (!this.current || this.current.name !== key) {
      this.current?.destroy?.();
      if (this.play && !key.startsWith('playing')) {
        this.play.destroy();
        this.play = null;
      }
      this.current = this.build(key);
      clear(this.opts.root);
      this.opts.root.append(this.current.el);
    }
    this.current.update();
  }

  private build(key: string): ScreenCtl {
    const s = this.session;
    const g = s.game;
    const name = key.split(':')[0];
    if (name === 'briefing' && g) {
      const b = briefingScreen({ run: g.run, runCount: s.runs.length, fromCheckpoint: g.fromCheckpoint, replay: g.replay }, 'rider', (r) => s.setReady(r), false, [
        ['Back to the lobby', () => s.toLobby()],
      ]);
      return { name: key, el: b.el, update: () => b.update(s.hostReady, s.clientReady, s.connected) };
    }
    if (name === 'playing' && g) {
      this.play?.destroy();
      const play = new RiderPlay(this, g, this.opts);
      this.play = play;
      return { name: key, el: play.el, update: () => play.update() };
    }
    if (name === 'results' && g && s.result && s.payout) {
      const station = s.retryStation();
      const el = resultsScreen(s.result, s.payout, g.run, 'rider', {
        next: s.hasNext() ? () => s.next() : undefined,
        retry: station ? { station, go: () => s.retryFromCheckpoint() } : undefined,
        restart: () => s.restart(),
        lobby: () => s.toLobby(),
      });
      if (s.payout.total > 0) window.setTimeout(() => this.opts.sfx.cash(), 400);
      return { name: key, el, update: () => {} };
    }
    return this.buildLobby();
  }

  private buildLobby(): ScreenCtl {
    const s = this.session;
    const opts = this.opts;
    const online = opts.mode === 'online';
    const toaster = new Toaster();
    const act = (a: DepotAction): void => {
      const out = s.depot(a);
      if (!out.ok) toaster.show(out.reason, 'danger', 3200);
    };
    const board = depotBoard(act);
    const ready = readyRow('rider', (r) => s.setReady(r));
    const codeEl = h('span', { class: 'room-code' });
    const statusEl = h('div', { class: 'status' });
    const startBtn = button('Start', () => s.start(), 'btn primary big');
    const continueBtn = button('Continue', () => s.continueFromCheckpoint(), 'btn primary big');
    const note = h('span', { class: 'start-note' });

    // Save codes: move the campaign between browsers (spec §17).
    const saveMsg = h('span', { class: 'small muted' });
    if (opts.store.problem) saveMsg.textContent = `${opts.store.problem.message} The old save was kept aside in this browser.`;
    const importField = h('input', { class: 'field', placeholder: 'Paste a save code', ariaLabel: 'Save code to import' });
    const saveTools = h(
      'div',
      { class: 'save-tools' },
      button(
        'Copy save code',
        async () => {
          const ok = await copyText(exportSaveCode(opts.store.save));
          saveMsg.textContent = ok ? 'Save code copied. Keep it somewhere safe.' : "Couldn't copy the code.";
        },
        'btn small-btn',
      ),
      importField,
      button(
        'Import',
        () => {
          try {
            opts.store.replace(importSaveCode(importField.value));
            importField.value = '';
            saveMsg.textContent = 'Save imported.';
          } catch (e) {
            saveMsg.textContent = e instanceof SaveError ? e.message : "That save code couldn't be read.";
          }
        },
        'btn small-btn',
      ),
      saveMsg,
    );
    saveTools.hidden = !opts.store.problem;

    const copied = (what: string) => (ok: boolean) => toaster.show(ok ? `${what} copied` : "Couldn't copy", ok ? 'good' : 'danger', 1800);
    const head = h(
      'header',
      { class: 'depot-head' },
      h('div', { class: 'depot-title' }, h('span', { class: 'brand', text: 'Switch & Spur' }), h('h2', { class: 'display', text: 'Depot' })),
      online
        ? h(
            'div',
            { class: 'room' },
            h('span', { class: 'room-label', text: 'Room' }),
            codeEl,
            button('Copy code', () => void copyText(this.peer?.code ?? '').then(copied('Room code')), 'btn small-btn'),
            button('Copy invite link', () => void copyText(inviteLink(this.peer?.code ?? '')).then(copied('Invite link')), 'btn small-btn'),
          )
        : h('div', { class: 'room local', text: 'Local test: both seats in this window' }),
      statusEl,
      h('span', { class: 'spacer' }),
      button('Save code', () => (saveTools.hidden = !saveTools.hidden), 'btn small-btn'),
      button('Settings', () => opts.onSettings(), 'btn small-btn'),
      button('Leave', () => opts.onExit(), 'btn small-btn'),
    );
    const foot = h('footer', { class: 'depot-foot' }, ready.el, h('span', { class: 'spacer' }), note, continueBtn, startBtn);
    const el = h('div', { class: 'screen depot-screen' }, h('div', { class: 'sheet depot' }, head, saveTools, board.el, foot), toaster.el);

    return {
      name: 'lobby',
      el,
      update: () => {
        codeEl.textContent = this.peer?.code ?? (this.opening ? '·····' : '—');
        const latency = s.latencyMs !== null ? ` (${Math.round(s.latencyMs)} ms)` : '';
        const status = !online
          ? s.connected
            ? 'The Engineer’s desk is on the right.'
            : 'Starting the Engineer’s view…'
          : this.peerError
            ? this.peerError
            : this.opening
              ? 'Opening a room…'
              : s.connected
                ? `The Engineer is connected${latency}`
                : 'Waiting for the Engineer to join';
        clear(statusEl);
        statusEl.append(h('span', { class: `status-dot ${s.connected ? 'open' : this.peerError ? 'error' : 'connecting'}` }), h('span', { class: this.peerError ? 'danger' : '', text: status }));
        if (this.peerError && online && !this.peer) statusEl.append(button('Try again', () => void this.openRoom(), 'btn small-btn'));

        board.update({ lobby: s.lobbyState(), runs: s.runCards() });
        ready.update(s.hostReady, s.clientReady, s.connected);
        const station = s.continueStation();
        const can = s.canStart();
        continueBtn.hidden = station === null;
        continueBtn.textContent = station ? `Continue from ${station}` : 'Continue';
        continueBtn.disabled = !can;
        startBtn.textContent = station ? 'Start afresh' : 'Start';
        startBtn.className = station ? 'btn big' : 'btn primary big';
        startBtn.disabled = !can;
        const cp = s.checkpoint;
        note.textContent = !s.connected
          ? online
            ? 'The Engineer needs to join first.'
            : ''
          : !can
            ? 'Both press Ready, then start.'
            : station
              ? 'Starting afresh discards the checkpoint.'
              : cp
                ? `Starting discards the checkpoint at ${cp.stationName}.`
                : '';
      },
    };
  }
}

const ROOM_CODE_KEY = 'spur.roomCode';

/** A link that opens the join screen with the code filled in. */
function inviteLink(code: string): string {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('join', code);
  return url.toString();
}

function readRoomCode(): string | null {
  try {
    return sessionStorage.getItem(ROOM_CODE_KEY);
  } catch {
    return null;
  }
}

function writeRoomCode(code: string): void {
  try {
    sessionStorage.setItem(ROOM_CODE_KEY, code);
  } catch {
    /* private mode: a reload just gets a new code */
  }
}

// ---------------------------------------------------------------------------
// The play screen: the side view, the Rider's controls and sound
// ---------------------------------------------------------------------------

/** Events kept for the renderer between two frames; more than this means frames stopped (a stall). */
const MAX_PENDING_EVENTS = 4000;

class RiderPlay {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private renderer: RiderRenderer;
  private controls: RiderControls;
  private sounds: RiderSounds;
  private toaster = new Toaster();
  private hints: Hints;
  private pause: PauseView;
  private countdown = countdownOverlay();
  private debugEl = h('div', { class: 'debug-badge' });
  private pending: SimEvent[] = [];
  private runningSince: number | null = null;

  constructor(
    private app: HostApp,
    private game: HostGame,
    private opts: HostAppOptions,
  ) {
    const s = app.session;
    this.canvas = h('canvas', { class: 'rider-canvas' });
    this.renderer = new RiderRenderer(this.canvas);
    this.sounds = new RiderSounds(opts.sfx);
    this.hints = new Hints(() => hintsOn(opts.store.get(), game.run.index === 0));
    this.pause = pauseOverlay('rider', (r) => s.setReady(r), [['Abandon the run and go to the lobby', () => s.toLobby()]]);
    this.controls = new RiderControls({
      onPause: () => s.requestPause(),
      onDebugKey: (code) => app.debugKey(code),
      onAnyInput: () => opts.sfx.unlock(),
      enabled: () => s.screen === 'playing' && s.mode === 'running',
      pausable: () => s.screen === 'playing',
    });
    this.controls.attach(this.canvas);
    s.inputSource = () => this.controls.next(this.aim());
    this.debugEl.hidden = !import.meta.env.DEV || !opts.debug;
    this.el = h('div', { class: 'play rider' }, this.canvas, this.toaster.el, this.hints.el, this.debugEl, this.countdown.el, this.pause.el);
  }

  /** The train-frame x at the view's left and right edges now, for panning by screen position. */
  private viewSpan(): ViewSpan | null {
    const w = this.canvas.clientWidth;
    const hgt = this.canvas.clientHeight;
    if (w <= 0) return null;
    const left = this.renderer.toTrainFrame(0, hgt / 2).x;
    const right = this.renderer.toTrainFrame(w, hgt / 2).x;
    return Number.isFinite(left) && Number.isFinite(right) && right > left ? { left, right } : null;
  }

  private aim(): AimContext | null {
    const r = this.game.state.rider;
    return { rider: { x: r.x, y: r.y, crouch: r.crouch }, toTrainFrame: (px, py) => this.renderer.toTrainFrame(px, py), width: this.canvas.clientWidth };
  }

  toast(text: string): void {
    this.toaster.show(text);
  }

  destroy(): void {
    this.controls.detach();
    this.app.session.inputSource = () => NO_INPUT;
    this.renderer.destroy();
    this.sounds.stop();
  }

  update(): void {
    const s = this.app.session;
    const paused = s.mode === 'paused';
    this.pause.el.hidden = !paused;
    if (paused) {
      this.pause.setReason(
        s.waitingForEngineer
          ? 'Waiting for the Engineer to reconnect…'
          : s.connectionDropped
            ? 'The connection dropped and is back.'
            : s.pausedBy === 'engineer'
              ? 'The Engineer paused the game.'
              : 'You paused the game.',
      );
      this.pause.update(s.hostReady, s.clientReady, s.connected);
    }
  }

  private stationName(id: string): string {
    return this.game.run.stations.find((st) => st.id === id)?.name ?? id;
  }

  onEvents(events: SimEvent[]): void {
    const state = this.game.state;
    if (this.pending.length < MAX_PENDING_EVENTS) this.pending.push(...events);
    this.sounds.events(events, state, this.viewSpan());
    const t = this.toaster;
    for (const e of events) {
      switch (e.type) {
        case 'checkpoint':
          t.show(`Checkpoint saved at ${this.stationName(e.stationId)}`, 'good');
          break;
        case 'heldUp':
          t.show('The Engineer is held up! Clear the cab.', 'danger', 3600);
          this.hints.show('holdup', 'A bandit in the cab has the Engineer at gunpoint: the controls are dead until you clear the cab.');
          break;
        case 'holdupEnded':
          t.show('The cab is clear', 'good');
          break;
        case 'lootTaken':
          t.show('The safe is open! Stop the bandit with the loot.', 'danger', 3600);
          break;
        case 'lootDropped':
          t.show('The loot is down. Walk over it to pick it up.');
          break;
        case 'lootRecovered':
          t.show('Loot recovered', 'good');
          break;
        case 'lootStolen':
          t.show('The loot is gone', 'danger');
          break;
        case 'riderOff':
          t.show(e.cause === 'tunnel' ? 'Knocked off by the tunnel!' : 'Off the train!', 'danger');
          break;
        case 'riderDown':
          t.show('You’re down. Back aboard in a few seconds.', 'danger');
          break;
        case 'fine':
          t.show(e.reason === 'redSignal' ? `Fined ${money(e.amount)}: passed a signal at stop` : `Fined ${money(e.amount)}: too fast after a caution`, 'danger');
          break;
        case 'waterFull':
          t.show('The tender is full', 'good');
          break;
        case 'stationDone':
          t.show(`${this.stationName(e.stationId)}: stop complete`, 'good');
          break;
        case 'shot':
          if (e.by !== 'rider') this.hints.show('cover', 'Crouch (S) to be harder to hit, and click to shoot back.');
          break;
        case 'tunnelEnter':
          this.hints.show('tunnel', 'Tunnels knock anyone on a roof off the train. Ask the Engineer to call them out.');
          break;
        default:
          break;
      }
    }
  }

  frame(now: number): void {
    const s = this.app.session;
    const g = this.game;
    const running = s.mode === 'running';
    const settings = this.opts.store.get();
    try {
      this.renderer.draw({
        state: g.state,
        run: g.run,
        alpha: running ? s.alpha : 0,
        now,
        events: this.pending,
        settings: { screenShake: settings.screenShake, lampLetters: settings.lampLetters },
        prompt: riderPrompt(g.state, g.run),
        frozen: !running,
      });
    } finally {
      this.pending = [];
    }
    this.sounds.frame(g.state, g.run, s.mode !== 'paused', this.viewSpan());
    this.countdown.set(s.mode === 'countdown' ? Math.max(1, Math.ceil((s.countdownEndMs - now) / 1000)) : null);
    if (running) {
      this.runningSince ??= now;
      const t = now - this.runningSince;
      if (t > 1500) this.hints.show('spyglass', 'Hold Shift or the right mouse button on a roof to look ahead with the spyglass. Tell the Engineer what you see.');
      if (t > 30000) this.hints.show('gaps', 'Jump the roof gaps with W or Space. The faster the train, the harder the wind pushes you back.');
    }
    if (import.meta.env.DEV && this.opts.debug) {
      const st = g.state;
      this.debugEl.textContent = `tick ${st.tick} · ×${s.simSpeed}${st.godMode ? ' · god' : ''} · ${st.variant} · ${st.horsemen.length} horsemen, ${st.bandits.length} aboard`;
    }
  }
}

/** The one-line prompt beside the Rider (spec §5.5, §7.4): what E would do here, or what's waiting. */
function riderPrompt(state: GameState, run: RunDef): string | null {
  if (state.rider.mode !== 'active' || state.phase !== 'running') return null;
  const spout = spoutPrompt(state, run);
  if (spout === 'lower') return 'E: lower the water spout';
  if (state.loot.status === 'dropped') return 'The loot is down: walk over it to take it back';
  if (spout === 'align') return 'Water tower: the Engineer must stop with the tender hatch under the spout';
  return null;
}
