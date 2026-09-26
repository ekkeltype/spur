// The Engineer's side (spec §3, §11, §16): joins a room, shows the depot and the briefing, then the
// desk, which sends the Engineer's commands and shows what the host sends back.

import type { Sfx } from '../audio/sfx';
import { ClientSession, type ClientGame } from '../net/client';
import { PeerClient, PeerHost } from '../net/peer';
import { normalizeRoomCode } from '../net/room';
import type { Transport } from '../net/transport';
import { EngineerDesk } from '../render/desk/desk';
import type { DebugInfo, SwitchSave } from '../net/protocol';
import type { EngineerEvent } from '../sim/types';
import { button, clear, h } from './dom';
import { Hints, hintsOn, Toaster } from './feedback';
import { depotBoard } from './lobby';
import { briefingScreen, countdownOverlay, messageScreen, noticeOverlay, pauseOverlay, readyRow, resultsScreen, switchSeatsRow, type Actions, type PauseView } from './screens';
import { CabSounds } from './sounds';
import type { SaveStore, SettingsSource } from './stores';

export interface ClientAppOptions {
  root: HTMLElement;
  mode: 'online' | 'local';
  settings: SettingsSource;
  /** null: silent (local test mode plays the Rider's audio only). */
  sfx: Sfx | null;
  debug: boolean;
  onExit: () => void;
  onSettings: () => void;
  initialCode?: string;
  /** Local test mode: the Engineer is always ready, so one person can drive both views. */
  autoReady?: boolean;
  /** Online: this browser's save, which keeps a copy of the pair's campaign (spec §17). */
  store?: SaveStore;
  /** Shown in the lobby once, e.g. "You're the Engineer now." */
  note?: string;
  /** Both ticked "Switch seats" and the save arrived: host in `peer`, the room opened for it (spec §3). */
  onTakeRiderSeat?: (peer: PeerHost, save: SwitchSave) => void;
}

/** Switching seats: how long the room opened for the Rider's seat waits for the save before closing. */
const SWITCH_SAVE_WAIT_MS = 15000;

interface ScreenCtl {
  name: string;
  el: HTMLElement;
  update(): void;
  destroy?(): void;
}

export class ClientApp {
  session: ClientSession | null = null;
  private peer: PeerClient | null = null;
  private peerError = '';
  private code = '';
  private current: ScreenCtl | null = null;
  private play: EngineerPlay | null = null;
  private unsubs: (() => void)[] = [];
  private note: string | null;
  /** Switching seats: the room opened for the Rider's seat, until the save arrives. */
  private switchPeer: PeerHost | null = null;
  private switchOpening = false;
  private switchTimer: number | undefined;
  private destroyed = false;

  constructor(private opts: ClientAppOptions) {
    this.note = opts.note ?? null;
    this.refresh();
  }

  /** Local test mode: use an in-memory transport. */
  attachTransport(t: Transport): void {
    this.setSession(new ClientSession(t));
  }

  private setSession(session: ClientSession): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.session?.destroy();
    this.session = session;
    this.unsubs.push(session.onChange(() => this.refresh()));
    const store = this.opts.store;
    if (store && this.opts.mode === 'online') this.unsubs.push(session.onCampaign((c) => store.takeCampaign(c)));
    this.unsubs.push(session.onSwitchBegin(() => void this.openRoomForSwitch(session)));
    this.unsubs.push(session.onSwitchSave((save) => this.takeRiderSeat(save)));
    this.refresh();
  }

  /** Both ticked "Switch seats": open a room for the Rider's seat, and tell the Rider's browser where. */
  private async openRoomForSwitch(session: ClientSession): Promise<void> {
    if (this.opts.mode !== 'online' || this.switchPeer || this.switchOpening) return;
    this.switchOpening = true;
    try {
      const peer = await PeerHost.open();
      if (this.destroyed || this.session !== session || session.status !== 'open') {
        peer.destroy();
        return;
      }
      this.switchPeer = peer;
      session.sendSwitchRoom(peer.code);
      this.switchTimer = window.setTimeout(() => this.dropSwitchRoom(), SWITCH_SAVE_WAIT_MS);
    } catch (e) {
      session.sendSwitchFailed(e instanceof Error ? e.message : String(e));
    } finally {
      this.switchOpening = false;
    }
  }

  private dropSwitchRoom(): void {
    window.clearTimeout(this.switchTimer);
    this.switchTimer = undefined;
    this.switchPeer?.destroy();
    this.switchPeer = null;
  }

  /** The save arrived: this browser hosts now, in the room it opened (the app takes over the room). */
  private takeRiderSeat(save: SwitchSave): void {
    const peer = this.switchPeer;
    if (!peer || !this.opts.onTakeRiderSeat) return;
    window.clearTimeout(this.switchTimer);
    this.switchTimer = undefined;
    this.switchPeer = null;
    const take = this.opts.onTakeRiderSeat;
    // Leave the session's own callbacks before the app is torn down.
    window.setTimeout(() => take(peer, save), 0);
  }

  join(rawCode: string): void {
    const code = normalizeRoomCode(rawCode);
    if (!code) {
      this.peerError = "That isn't a room code. Codes are 5 letters and digits, like K7PQZ.";
      this.refresh();
      return;
    }
    this.code = code;
    this.peerError = '';
    this.peer?.destroy();
    this.peer = PeerClient.connect(code);
    this.peer.onError((msg) => {
      this.peerError = msg;
      this.refresh();
    });
    const store = this.opts.store;
    this.setSession(new ClientSession(this.peer.transport, { campaign: () => store?.save.campaign ?? null }));
  }

  /** Drops the current connection attempt and shows the join screen again. */
  private backToJoin(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.session?.destroy();
    this.session = null;
    this.peer?.destroy();
    this.peer = null;
    this.opts.initialCode = this.code;
    this.refresh();
  }

  frame(now: number): void {
    this.session?.frame(now);
    this.play?.frame(now);
  }

  destroy(): void {
    this.destroyed = true;
    this.dropSwitchRoom();
    for (const u of this.unsubs) u();
    this.play?.destroy();
    this.play = null;
    this.current?.destroy?.();
    this.session?.destroy();
    this.peer?.destroy();
    clear(this.opts.root);
  }

  private screenKey(): string {
    const s = this.session;
    if (!s) return 'join';
    if (s.screen === 'rejected') return 'rejected';
    if (s.status === 'closed' && (this.opts.mode === 'online' || s.everConnected)) return 'lost';
    if (!s.everConnected || s.screen === 'connecting') return 'connecting';
    if (s.screen === 'lobby') return 'lobby';
    return `${s.screen}:${s.game?.id ?? 0}`;
  }

  private refresh(): void {
    const s = this.session;
    if (this.opts.autoReady && s && !s.ready && s.status === 'open') {
      const waiting = (s.screen === 'lobby' && s.lobby !== null) || s.screen === 'briefing' || (s.screen === 'playing' && s.mode === 'paused');
      if (waiting) {
        s.setReady(true);
        return;
      }
    }
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
    const online = this.opts.mode === 'online';
    const leave: Actions = online ? [['Leave', () => this.opts.onExit()]] : [];
    const name = key.split(':')[0];
    switch (name) {
      case 'join':
        return this.buildJoin();
      case 'connecting': {
        const m = messageScreen(online ? `Joining room ${this.code}…` : 'Starting…', online ? [['Cancel', () => this.opts.onExit()]] : []);
        return { name: key, el: m.el, update: () => m.setText(this.peerError || 'Looking for the Rider. This usually takes a few seconds.') };
      }
      case 'lost': {
        const title = s?.everConnected ? 'Connection lost' : "Can't join";
        const m = messageScreen(
          title,
          online
            ? [
                ['Try again', () => this.backToJoin()],
                ['Back to the title', () => this.opts.onExit()],
              ]
            : [['Back to the title', () => this.opts.onExit()]],
        );
        return { name: key, el: m.el, update: () => m.setText(this.peerError || "Lost the connection to the Rider and couldn't reconnect.") };
      }
      case 'rejected': {
        const m = messageScreen("Can't join", [['Back to the title', () => this.opts.onExit()]]);
        return { name: key, el: m.el, update: () => m.setText(s?.rejectReason ?? '') };
      }
      case 'briefing':
        if (s?.game) {
          const game = s.game;
          const b = briefingScreen(
            { run: game.run, runCount: s.runs.length, fromCheckpoint: game.fromCheckpoint, replay: game.replay },
            'engineer',
            (r) => s.setReady(r),
            !online,
            leave,
          );
          return { name: key, el: b.el, update: () => b.update(s.ready, s.hostReady, s.status === 'open') };
        }
        break;
      case 'playing':
        if (s?.game) {
          this.play?.destroy();
          const play = new EngineerPlay(s, s.game, this.opts);
          this.play = play;
          return { name: key, el: play.el, update: () => play.update() };
        }
        break;
      case 'results':
        if (s?.game && s.result && s.payout) {
          const el = resultsScreen(s.result, s.payout, s.game.run, 'engineer', online ? { leave: () => this.opts.onExit() } : null, s.game.consist);
          if (s.payout.total > 0 && this.opts.sfx) {
            const sfx = this.opts.sfx;
            window.setTimeout(() => sfx.cash(), 400);
          }
          return { name: key, el, update: () => {} };
        }
        break;
      default:
        break;
    }
    return this.buildLobby(key);
  }

  private buildJoin(): ScreenCtl {
    const input = h('input', {
      class: 'field code-input',
      placeholder: 'ABCDE',
      value: this.opts.initialCode ?? '',
      attrs: { maxlength: '7', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Room code' },
    });
    const err = h('p', { class: 'danger small' });
    const go = (): void => this.join(input.value);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    const el = h(
      'div',
      { class: 'screen' },
      h(
        'div',
        { class: 'sheet narrow join' },
        h('h2', { class: 'display', text: 'Join as Engineer' }),
        h('p', { class: 'muted', text: 'Type the room code the Rider sees in the depot.' }),
        h('div', { class: 'row' }, input, button('Join', go, 'btn primary big')),
        err,
        h('div', { class: 'row end' }, button('Settings', () => this.opts.onSettings(), 'btn small-btn'), button('Back', () => this.opts.onExit(), 'btn small-btn')),
      ),
    );
    window.setTimeout(() => input.focus(), 0);
    return { name: 'join', el, update: () => (err.textContent = this.peerError) };
  }

  private buildLobby(key: string): ScreenCtl {
    const s = this.session!;
    const online = this.opts.mode === 'online';
    const toaster = new Toaster();
    const board = depotBoard((a) => s.depot(a));
    const ready = readyRow('engineer', (r) => s.setReady(r));
    const switchRow = online ? switchSeatsRow('engineer', (on) => s.setSwitchSeats(on)) : null;
    const statusEl = h('div', { class: 'status' });
    const unsub = s.onDepotRefusal((reason) => toaster.show(reason, 'danger', 3200));
    const head = h(
      'header',
      { class: 'depot-head' },
      h('div', { class: 'depot-title' }, h('span', { class: 'brand', text: 'Switch & Spur' }), h('h2', { class: 'display', text: 'Depot' })),
      online
        ? h('div', { class: 'room' }, h('span', { class: 'room-label', text: 'Room' }), h('span', { class: 'room-code', text: this.code }))
        : h('div', { class: 'room local', text: 'Local test: the Engineer' }),
      statusEl,
      h('span', { class: 'spacer' }),
      button('Settings', () => this.opts.onSettings(), 'btn small-btn'),
      online ? button('Leave', () => this.opts.onExit(), 'btn small-btn') : null,
    );
    const foot = h('footer', { class: 'depot-foot' }, ready.el, switchRow?.el, h('span', { class: 'spacer' }), h('span', { class: 'start-note', text: 'The Rider starts the run when you’re both ready.' }));
    const el = h('div', { class: 'screen depot-screen' }, h('div', { class: 'sheet depot' }, head, board.el, foot), toaster.el);
    return {
      name: key,
      el,
      update: () => {
        if (s.lobby) board.update({ lobby: s.lobby, runs: s.runs });
        ready.update(s.ready, s.hostReady, s.status === 'open');
        const sw = s.lobby?.switchSeats;
        if (sw) switchRow?.update(sw.engineer, sw.rider, sw.switching, s.status === 'open');
        if (this.note) {
          toaster.show(this.note, 'good', 5000);
          this.note = null;
        }
        const latency = s.latencyMs !== null && online ? ` (${Math.round(s.latencyMs)} ms)` : '';
        clear(statusEl);
        statusEl.append(h('span', { class: `status-dot ${s.status === 'open' ? 'open' : 'connecting'}` }), h('span', { text: s.status === 'open' ? `Connected to the Rider${latency}` : 'Reconnecting…' }));
      },
      destroy: unsub,
    };
  }
}

// ---------------------------------------------------------------------------
// The play screen: the desk, with the pause and countdown over it
// ---------------------------------------------------------------------------

/** The signal hint comes this many seconds before the first signal. */
const SIGNAL_HINT_S = 15;

class EngineerPlay {
  readonly el: HTMLElement;
  private desk: EngineerDesk;
  private hints: Hints;
  private pause: PauseView;
  private countdown = countdownOverlay();
  private reconnecting = noticeOverlay('Reconnecting…', 'Lost contact with the Rider. Trying again every 2 seconds.');
  private debugEl = h('div', { class: 'debug-badge' });
  private sounds: CabSounds | null;
  private enabled: boolean | null = null;
  private lastDebug: DebugInfo | null = null;
  private runningSince: number | null = null;
  private unsubs: (() => void)[] = [];

  constructor(
    private session: ClientSession,
    game: ClientGame,
    private opts: ClientAppOptions,
  ) {
    const local = opts.mode === 'local';
    const settings = opts.settings.get();
    this.sounds = opts.sfx ? new CabSounds(opts.sfx) : null;
    this.desk = new EngineerDesk(game.run, {
      onCmd: (cmd) => {
        session.sendCmd(cmd);
        this.sounds?.cmd(cmd, performance.now());
      },
      onPause: () => session.requestPause(),
      keyboard: local ? 'local' : 'full',
      lampLetters: settings.lampLetters,
      assist: game.assists.engineer,
      consist: game.consist,
      governor: game.upgrades.includes('governor'),
    });
    this.hints = new Hints(() => hintsOn(opts.settings.get(), !game.replay));
    this.pause = pauseOverlay('engineer', (r) => session.setReady(r), opts.mode === 'online' ? [['Leave', () => opts.onExit()]] : undefined);
    this.debugEl.hidden = !import.meta.env.DEV || !opts.debug;
    this.el = h(
      'div',
      { class: 'play engineer' },
      h('div', { class: 'desk-host' }, this.desk.el),
      this.hints.el,
      this.debugEl,
      this.countdown.el,
      this.pause.el,
      this.reconnecting,
    );
    this.unsubs.push(session.onSnapshot((view) => this.desk.setView(view, performance.now())));
    this.unsubs.push(session.onEvent((e) => this.onEvent(e)));
    this.unsubs.push(session.onRefusal((reason, cmd) => this.desk.refused(reason, performance.now(), cmd)));
    this.unsubs.push(opts.settings.onChange((s) => this.desk.setLampLetters(s.lampLetters)));
    // Joining a game under way (or the countdown's first snapshot) arrives before this screen exists.
    if (session.view) this.desk.setView(session.view, performance.now());
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.desk.destroy();
    this.sounds?.stop();
  }

  private onEvent(e: EngineerEvent): void {
    this.desk.onEvent(e, performance.now());
    this.sounds?.event(e);
    switch (e.type) {
      case 'gunfire':
        this.hints.show('gunfire', 'That’s gunfire outside. Ask the Rider what’s happening.');
        break;
      case 'heldUp':
        this.hints.show('heldup', 'A bandit has you at gunpoint. Only the whistle works until the Rider clears the cab.');
        break;
      case 'telegram':
        this.hints.show('telegram', 'Telegrams can change the plan. Read them out to the Rider.');
        break;
      case 'flagPlaced':
        this.hints.show('flag', 'The Rider planted a flag on your map: something is there. Ask what.');
        break;
      default:
        break;
    }
  }

  /** A signal is coming up on the Ahead list, SIGNAL_HINT_S or less away at the current speed. */
  private signalComing(): boolean {
    const near = this.desk.nearest('signal');
    return near !== null && near.secs <= SIGNAL_HINT_S;
  }

  update(): void {
    const s = this.session;
    const paused = s.mode === 'paused';
    this.pause.el.hidden = !paused;
    if (paused) {
      this.pause.setReason(s.pauseReason === 'disconnect' ? 'The connection dropped and is back.' : s.pausedBy === 'engineer' ? 'You paused the game.' : 'The Rider paused the game.');
      this.pause.update(s.ready, s.hostReady, s.status === 'open');
    }
    this.reconnecting.hidden = s.status !== 'connecting' || !s.everConnected;
  }

  frame(now: number): void {
    const s = this.session;
    const running = s.mode === 'running';
    if (running !== this.enabled) {
      this.enabled = running;
      this.desk.setEnabled(running);
    }
    this.desk.frame(now);
    this.countdown.set(s.mode === 'countdown' ? Math.max(1, Math.ceil((s.countdownEndMs - now) / 1000)) : null);
    this.sounds?.frame(s.view, s.mode !== 'paused');
    if (running) {
      this.runningSince ??= now;
      const t = now - this.runningSince;
      if (t > 1500) this.hints.show('callouts', 'Call out tunnels, low bridges and fords before the train gets there: the Rider can’t see the map.');
      // The first signal coming up (spec §9.1), once the opening hint has had its time.
      if (t > 9000 && this.signalComing()) this.hints.show('signals', 'Ask the Rider what each signal shows as you pass it. After a yellow, stop at the next one: the Ahead list shows where.');
    }
    if (import.meta.env.DEV && this.opts.debug) {
      if (s.debugInfo !== this.lastDebug) {
        this.lastDebug = s.debugInfo;
        this.desk.setDebug(s.debugInfo);
      }
      this.debugEl.textContent = `est tick ${s.estTick(now).toFixed(1)} · view ${s.view?.tick ?? '–'}`;
    }
  }
}
