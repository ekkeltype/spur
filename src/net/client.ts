// The Engineer's side (spec §16.1): a thin client. It holds the EngineerRun and the latest view from
// the host, sends commands with sequence numbers, and surfaces the host's refusals. Everything it
// knows arrives through the messages in protocol.ts.

import { TICK_HZ, TIME_SCALE } from '../sim/rules';
import type {
  Assists,
  CampaignProgress,
  CarType,
  EngineerCmd,
  EngineerCmdBody,
  EngineerEvent,
  EngineerRun,
  EngineerView,
  RunResult,
  UpgradeId,
} from '../sim/types';
import { PROTOCOL_VERSION, type DebugInfo, type DepotAction, type LobbyState, type Msg, type Payout, type Role, type RunCard, type SwitchSave } from './protocol';
import type { Transport, TransportStatus } from './transport';

export type ClientScreen = 'connecting' | 'lobby' | 'briefing' | 'playing' | 'results' | 'rejected';
export type ClientMode = 'countdown' | 'running' | 'paused';

/** The game the host started, as the Engineer knows it. */
export interface ClientGame {
  /** Counts the games this client has seen, so the app knows when to build a new desk. */
  id: number;
  run: EngineerRun;
  consist: CarType[];
  upgrades: UpgradeId[];
  assists: Assists;
  replay: boolean;
  fromCheckpoint: string | null;
}

export interface Refusal {
  text: string;
  /** performance.now() when it arrived. */
  t: number;
}

/** Real milliseconds per host tick: the world runs TIME_SCALE times the wall clock. */
const TICK_MS = 1000 / (TICK_HZ * TIME_SCALE);
const PING_MS = 2000;

export interface ClientOptions {
  /** This browser's copy of the pair's campaign, brought along in the hello (spec §17), if it has one. */
  campaign?: () => CampaignProgress | null;
}

export class ClientSession {
  screen: ClientScreen = 'connecting';
  mode: ClientMode = 'paused';
  status: TransportStatus = 'connecting';
  everConnected = false;
  rejectReason = '';
  lobby: LobbyState | null = null;
  /** The lobby's run list, from the last lobby message. */
  runs: RunCard[] = [];
  game: ClientGame | null = null;
  view: EngineerView | null = null;
  ready = false;
  hostReady = false;
  pausedBy: Role | null = null;
  pauseReason: 'disconnect' | null = null;
  countdownEndMs = 0;
  result: RunResult | null = null;
  payout: Payout | null = null;
  campaign: CampaignProgress | null = null;
  /** After a loss: the station the Rider can retry from. */
  checkpointName: string | null = null;
  latencyMs: number | null = null;
  debugInfo: DebugInfo | null = null;
  /** The last command the host refused (held up, paused…). */
  lastRefusal: Refusal | null = null;
  /** The last depot action the host refused (not enough money, the train is full…). */
  lastDepotRefusal: Refusal | null = null;

  private seq = 0;
  private gameCount = 0;
  private pending = new Map<number, EngineerCmd>();
  private snapTick = 0;
  /** Local time at which host tick 0 would have happened, smoothed over snapshots. */
  private originMs: number | null = null;
  private lastPingMs = 0;
  private unsubs: (() => void)[] = [];
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<(e: EngineerEvent) => void>();
  private snapshotListeners = new Set<(view: EngineerView) => void>();
  private refusalListeners = new Set<(reason: string, cmd?: EngineerCmd) => void>();
  private depotRefusalListeners = new Set<(reason: string) => void>();
  private campaignListeners = new Set<(campaign: CampaignProgress) => void>();
  private switchBeginListeners = new Set<() => void>();
  private switchSaveListeners = new Set<(save: SwitchSave) => void>();

  constructor(
    private transport: Transport,
    private opts: ClientOptions = {},
  ) {
    this.unsubs.push(transport.onStatus((s) => this.onStatus(s)));
    this.unsubs.push(transport.onMessage((m) => this.onMessage(m)));
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Every filtered event from the host, as it arrives. */
  onEvent(cb: (e: EngineerEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** Every new view (about SNAPSHOT_HZ a second while running). */
  onSnapshot(cb: (view: EngineerView) => void): () => void {
    this.snapshotListeners.add(cb);
    return () => this.snapshotListeners.delete(cb);
  }

  /** A command the host refused, with its reason. */
  /** A command the host refused: the reason, and the command itself when this client sent it. */
  onRefusal(cb: (reason: string, cmd?: EngineerCmd) => void): () => void {
    this.refusalListeners.add(cb);
    return () => this.refusalListeners.delete(cb);
  }

  /** A depot action the host refused, with its reason. */
  onDepotRefusal(cb: (reason: string) => void): () => void {
    this.depotRefusalListeners.add(cb);
    return () => this.depotRefusalListeners.delete(cb);
  }

  /** The pair's campaign as the host has it now (every lobby update and result), for this browser's copy. */
  onCampaign(cb: (campaign: CampaignProgress) => void): () => void {
    this.campaignListeners.add(cb);
    return () => this.campaignListeners.delete(cb);
  }

  /** Both ticked "Switch seats": this browser is to open a room for the Rider's seat (spec §3). */
  onSwitchBegin(cb: () => void): () => void {
    this.switchBeginListeners.add(cb);
    return () => this.switchBeginListeners.delete(cb);
  }

  /** The save to host with has arrived: this browser takes the Rider's seat. */
  onSwitchSave(cb: (save: SwitchSave) => void): () => void {
    this.switchSaveListeners.add(cb);
    return () => this.switchSaveListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  private send(msg: Msg): void {
    if (this.transport.status === 'open') this.transport.send(msg);
  }

  private onStatus(s: TransportStatus): void {
    this.status = s;
    if (s === 'open') {
      this.everConnected = true;
      const campaign = this.opts.campaign?.() ?? null;
      this.send(campaign ? { type: 'hello', protocol: PROTOCOL_VERSION, campaign } : { type: 'hello', protocol: PROTOCOL_VERSION });
    }
    this.changed();
  }

  private onMessage(m: Msg): void {
    // A version reject is final: nothing the host sends afterwards changes this screen.
    if (this.screen === 'rejected') return;
    const now = performance.now();
    switch (m.type) {
      case 'welcome':
        break;
      case 'reject':
        this.screen = 'rejected';
        this.rejectReason = m.reason;
        break;
      case 'lobby':
        this.lobby = m.lobby;
        if (Array.isArray(m.runs)) this.runs = m.runs;
        this.campaign = m.lobby.campaign;
        for (const cb of this.campaignListeners) cb(m.lobby.campaign);
        this.ready = m.lobby.clientReady;
        this.hostReady = m.lobby.hostReady;
        if (this.screen !== 'lobby') {
          this.screen = 'lobby';
          this.game = null;
          this.view = null;
          this.result = null;
          this.payout = null;
        }
        break;
      case 'depotRefused':
        this.lastDepotRefusal = { text: m.reason, t: now };
        for (const cb of this.depotRefusalListeners) cb(m.reason);
        break;
      case 'start': {
        // A reconnect to the same game keeps its desk; anything else is a new game.
        const same = m.resume && this.game !== null && this.game.run.id === m.run.id;
        this.game = {
          id: same && this.game ? this.game.id : ++this.gameCount,
          run: m.run,
          consist: m.consist,
          upgrades: m.upgrades,
          assists: m.assists,
          replay: m.replay,
          fromCheckpoint: m.fromCheckpoint,
        };
        this.ready = false;
        this.hostReady = false;
        this.result = null;
        this.payout = null;
        this.pending.clear();
        if (!m.resume) {
          this.view = null;
          this.screen = 'briefing';
        } else {
          this.screen = 'playing';
        }
        this.mode = 'paused';
        break;
      }
      case 'ready':
        this.hostReady = m.ready;
        break;
      case 'snapshot':
        this.applySnapshot(m.view, now);
        for (const cb of this.snapshotListeners) cb(m.view);
        break;
      case 'event':
        for (const cb of this.eventListeners) cb(m.event);
        break;
      case 'ack': {
        const cmd = this.pending.get(m.seq);
        this.pending.delete(m.seq);
        if (!m.ok) {
          const reason = m.reason ?? 'Not allowed';
          this.lastRefusal = { text: reason, t: now };
          for (const cb of this.refusalListeners) cb(reason, cmd);
        }
        break;
      }
      case 'pause':
        this.screen = 'playing';
        this.mode = 'paused';
        this.pausedBy = m.by;
        this.pauseReason = m.reason ?? null;
        this.ready = false;
        this.hostReady = false;
        break;
      case 'countdown':
        this.screen = 'playing';
        this.mode = 'countdown';
        this.pausedBy = null;
        this.pauseReason = null;
        this.countdownEndMs = now + m.seconds * 1000;
        this.ready = false;
        this.hostReady = false;
        this.originMs = null;
        break;
      case 'ping':
        this.send({ type: 'pong', t: m.t });
        break;
      case 'pong':
        this.latencyMs = Math.max(0, now - m.t);
        break;
      case 'result':
        this.result = m.result;
        this.payout = m.payout;
        this.campaign = m.campaign;
        for (const cb of this.campaignListeners) cb(m.campaign);
        this.checkpointName = m.checkpointName;
        this.screen = 'results';
        this.mode = 'paused';
        this.ready = false;
        this.hostReady = false;
        break;
      case 'debug':
        this.debugInfo = m.info;
        break;
      case 'switchBegin':
        for (const cb of this.switchBeginListeners) cb();
        break;
      case 'switchSave':
        for (const cb of this.switchSaveListeners) cb(m.save);
        break;
      default:
        break;
    }
    this.changed();
  }

  private applySnapshot(view: EngineerView, now: number): void {
    const prevTick = this.view?.tick ?? -1;
    this.view = view;
    this.snapTick = view.tick;
    // Clock sync: smooth the implied origin of tick 0; jump when far off (start, resume, sim speed).
    const sample = now - view.tick * TICK_MS;
    if (this.originMs === null || Math.abs(sample - this.originMs) > 400 || view.tick < prevTick) this.originMs = sample;
    else this.originMs += (sample - this.originMs) * 0.1;
  }

  /** Estimated host tick now (fractional), frozen while not running: lets the desk smooth between snapshots. */
  estTick(now: number): number {
    if (!this.view) return 0;
    if (this.mode !== 'running' || this.originMs === null) return this.snapTick;
    const t = (now - this.originMs) / TICK_MS;
    return Math.max(this.snapTick - 1, Math.min(this.snapTick + 12, t));
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  setReady(ready: boolean): void {
    this.ready = ready;
    this.send({ type: 'ready', ready });
    this.changed();
  }

  requestPause(): void {
    if (this.screen === 'playing' && this.mode !== 'paused') this.send({ type: 'pause', by: 'engineer' });
  }

  /** A lobby action: the host applies it (or says why not) and sends everyone the new lobby. */
  depot(action: DepotAction): void {
    this.send({ type: 'depot', action });
  }

  /** The Engineer ticks or unticks "Switch seats" (spec §3). */
  setSwitchSeats(on: boolean): void {
    this.send({ type: 'switchSeats', on });
  }

  /** The room for the Rider's seat is open (or couldn't be): the host hands over, or stays. */
  sendSwitchRoom(code: string): void {
    this.send({ type: 'switchRoom', code });
  }

  sendSwitchFailed(reason: string): void {
    this.send({ type: 'switchFailed', reason });
  }

  /** Sends a command to the host; returns its sequence number. The ack arrives later. */
  sendCmd(body: EngineerCmdBody): number {
    const cmd = { ...body, seq: ++this.seq } as EngineerCmd;
    this.pending.set(cmd.seq, cmd);
    this.send({ type: 'cmd', cmd });
    return cmd.seq;
  }

  /** Commands sent and not yet acked. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  frame(now: number): void {
    if (now - this.lastPingMs > PING_MS && this.status === 'open') {
      this.lastPingMs = now;
      this.send({ type: 'ping', t: now });
    }
    if (this.mode === 'countdown' && now >= this.countdownEndMs) {
      this.mode = 'running';
      this.changed();
    }
  }
}
