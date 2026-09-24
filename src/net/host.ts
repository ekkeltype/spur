// The Rider's browser is the host (spec §16.1): it runs the authoritative sim at TICK_HZ, applies the
// Engineer's commands, and sends the Engineer their view, filtered events and acks. It also keeps
// the lobby and depot (spec §3, §12): either player may act there, and the host validates every
// action against the campaign rules in save.ts and broadcasts the result.

import { RUNS } from '../content/runs';
import { buyItem, checkpointOf, isUnlocked, restoreCheckpoint, setAssist, toggleCar, type DepotResult } from '../save/save';
import { composeConsist, isOver, newGame, runResult, step } from '../sim/game';
import { COUNTDOWN_SECONDS, SNAPSHOT_HZ, TICK_HZ } from '../sim/rules';
import { aspectOf } from '../sim/signals';
import { NO_INPUT } from '../sim/types';
import type {
  Assists,
  CampaignProgress,
  CarType,
  Checkpoint,
  DebugCmd,
  EngineerCmd,
  EngineerCmdBody,
  EngineerRun,
  GameState,
  RiderInput,
  RunDef,
  RunResult,
  SimEvent,
  UpgradeId,
} from '../sim/types';
import { filterForEngineer, toEngineerRun, toEngineerView } from '../sim/views';
import { PROTOCOL_VERSION, type DebugInfo, type DepotAction, type LobbyState, type Msg, type Payout, type Role, type RunCard } from './protocol';
import type { Transport, TransportStatus } from './transport';

export type HostScreen = 'lobby' | 'briefing' | 'playing' | 'results';
/** On the playing screen: the 3-2-1, the sim running, or paused. */
export type PlayMode = 'countdown' | 'running' | 'paused';

export interface HostGame {
  run: RunDef;
  runIndex: number;
  seed: number;
  /** The full consist behind the tender, front to back. */
  consist: CarType[];
  upgrades: UpgradeId[];
  assists: Assists;
  /** The run as the Engineer may know it (spec §16.2). */
  engineerRun: EngineerRun;
  state: GameState;
  /** The station's name when this game continued from a checkpoint. */
  fromCheckpoint: string | null;
  /** The run had been won before, so it pays less (spec §12). */
  replay: boolean;
}

/**
 * Dev (?autopilot=1): a plan-following Engineer (src/sim/autopilot.ts), wired in by main.ts. step()
 * is called every tick just before the sim steps; its commands are applied with negative seqs and
 * never acked to the Engineer's client.
 */
export interface AutopilotHook {
  /** A game begins: fresh, restarted, or continued from a checkpoint. */
  begin?(run: RunDef, state: GameState): void;
  step(state: GameState, run: RunDef): EngineerCmdBody[];
}

export interface HostOptions {
  campaign: CampaignProgress;
  checkpoint?: Checkpoint | null;
  /** Saves a finished run (money, unlocks, medals); returns the campaign after it and what it paid. */
  recordResult: (result: RunResult) => { campaign: CampaignProgress; payout: Payout };
  /** Saves the campaign after a depot change (a purchase, the consist, assists). */
  saveCampaign?: (campaign: CampaignProgress) => void;
  /** Saves the checkpoint, or clears it with null. */
  saveCheckpoint?: (checkpoint: Checkpoint | null) => void;
  /** The campaign's runs (tests use their own). */
  runs?: readonly RunDef[];
  forcedSeed?: number | null;
  /** Dev: preselect this run (0-based), even if it's locked. */
  forcedRun?: number | null;
  debug?: boolean;
}

export type DepotOutcome = { ok: true } | { ok: false; reason: string };

const TICK_MS = 1000 / TICK_HZ;
const SNAPSHOT_EVERY = Math.max(1, Math.round(TICK_HZ / SNAPSHOT_HZ));
const PING_MS = 2000;
/** The Engineer hears gunfire at most once per this many ticks: 4 times a second (spec §16.3). */
export const GUNFIRE_MIN_TICKS = Math.ceil(TICK_HZ / 4);

export function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] % 1_000_000_000;
}

/** One line of the lobby's run list (see RunCard). */
export function runCard(run: RunDef, index: number, campaign: CampaignProgress, unlocked: boolean): RunCard {
  const stationName = (id: string): string => run.stations.find((s) => s.id === id)?.name ?? id;
  const done = campaign.completed.find((e) => e.runId === run.id);
  const c = run.contract;
  return {
    id: run.id,
    index,
    act: run.act,
    name: run.name,
    flavor: run.flavor,
    night: run.night,
    startClock: run.startClock,
    originName: stationName(run.origin),
    destinationName: stationName(c.destination),
    contract: { cargo: c.cargo, title: c.title, pay: c.pay, deadline: c.deadline, latePenaltyPerMin: c.latePenaltyPerMin, critical: c.critical },
    sideJobs: run.sideJobs.map((j) => ({ title: j.title, pay: j.pay, needs: j.needs })),
    requiredCars: [...run.requiredCars],
    maxCars: run.maxCars,
    par: run.par,
    unlocked,
    times: done?.times ?? 0,
    best: done ? done.bestTimeSec : null,
    medals: done ? [...done.medals] : [],
  };
}

/**
 * Muffled gunfire for the Engineer (spec §16.3): at most one burst per GUNFIRE_MIN_TICKS, as loud as
 * the loudest shot held back for it. A burst that has to wait goes out as soon as it may.
 */
export class GunfireLimiter {
  private pending = 0;
  private nextTick = Number.NEGATIVE_INFINITY;

  offer(intensity: number): void {
    if (Number.isFinite(intensity)) this.pending = Math.max(this.pending, Math.min(1, intensity));
  }

  /** The burst to send at `tick`, if one is due. */
  take(tick: number): number | null {
    if (this.pending <= 0 || tick < this.nextTick) return null;
    const out = this.pending;
    this.pending = 0;
    this.nextTick = tick + GUNFIRE_MIN_TICKS;
    return out;
  }

  reset(): void {
    this.pending = 0;
    this.nextTick = Number.NEGATIVE_INFINITY;
  }
}

export class HostSession {
  screen: HostScreen = 'lobby';
  mode: PlayMode = 'paused';
  campaign: CampaignProgress;
  checkpoint: Checkpoint | null;
  /** 0-based index into `runs`. */
  selectedRun: number;
  hostReady = false;
  clientReady = false;
  /** The Engineer's transport is open and they have said hello with the right protocol. */
  connected = false;
  transportStatus: TransportStatus = 'closed';
  pausedBy: Role | null = null;
  waitingForEngineer = false;
  /** The Engineer's connection dropped during this pause (they may be back already). */
  connectionDropped = false;
  countdownEndMs = 0;
  game: HostGame | null = null;
  result: RunResult | null = null;
  payout: Payout | null = null;
  latencyMs: number | null = null;
  simSpeed = 1;
  /** The fractional part of the tick, for rendering. */
  alpha = 0;
  /** Counts the games begun, so the app knows when to build a new play screen. */
  gameId = 0;
  readonly runs: readonly RunDef[];

  inputSource: () => RiderInput = () => NO_INPUT;
  /** Dev: see AutopilotHook. */
  autopilot: AutopilotHook | null = null;

  private transport: Transport | null = null;
  private unsubs: (() => void)[] = [];
  private cmdQueue: EngineerCmd[] = [];
  private debugQueue: DebugCmd[] = [];
  private autoSeq = 0;
  private acc = 0;
  private lastFrameMs = 0;
  private lastPingMs = 0;
  private forcedSeed: number | null;
  private readonly forcedRun: number | null;
  private readonly debug: boolean;
  private readonly gunfire = new GunfireLimiter();
  private changeListeners = new Set<() => void>();
  private eventListeners = new Set<(events: SimEvent[]) => void>();

  constructor(private opts: HostOptions) {
    this.runs = opts.runs ?? RUNS;
    this.campaign = opts.campaign;
    this.checkpoint = opts.checkpoint ?? null;
    this.forcedSeed = opts.forcedSeed ?? null;
    this.debug = !!opts.debug;
    const forced = opts.forcedRun ?? null;
    this.forcedRun = forced !== null && Number.isFinite(forced) ? Math.max(0, Math.min(this.runs.length - 1, Math.floor(forced))) : null;
    this.selectedRun = this.forcedRun ?? this.checkpointRunIndex() ?? this.suggestedRun();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  attachTransport(t: Transport): void {
    this.detachTransport();
    this.transport = t;
    this.unsubs.push(t.onMessage((m) => this.onMessage(m)));
    this.unsubs.push(t.onStatus((s) => this.onStatus(s)));
  }

  detachTransport(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.transport = null;
    this.connected = false;
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Every tick's sim events, for the Rider's presentation (renderer effects, audio, toasts). */
  onEvents(cb: (events: SimEvent[]) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.changeListeners) cb();
  }

  private send(msg: Msg): void {
    if (!this.transport || this.transport.status !== 'open') return;
    // Until the Engineer has said hello with the right protocol, they only ever hear a reject.
    if (!this.connected && msg.type !== 'reject') return;
    this.transport.send(msg);
  }

  private sendLobby(): void {
    this.send({ type: 'lobby', lobby: this.lobbyState(), runs: this.runCards() });
  }

  private onStatus(s: TransportStatus): void {
    this.transportStatus = s;
    if (s !== 'open') {
      const wasConnected = this.connected;
      this.connected = false;
      this.clientReady = false;
      if (wasConnected && this.screen === 'playing' && this.game && !isOver(this.game.state)) {
        this.pause('engineer', true);
      }
    }
    this.changed();
  }

  private onMessage(m: Msg): void {
    // Nothing counts from a client that hasn't completed the handshake (e.g. a rejected old build).
    if (m.type !== 'hello' && !this.connected) return;
    switch (m.type) {
      case 'hello':
        if (m.protocol !== PROTOCOL_VERSION) {
          this.send({ type: 'reject', reason: 'Reload the page to get the latest version' });
          return;
        }
        this.connected = true;
        this.clientReady = false;
        this.send({ type: 'welcome', protocol: PROTOCOL_VERSION });
        this.resync();
        break;
      case 'ready':
        this.clientReady = m.ready === true;
        this.afterReadyChange();
        break;
      case 'depot': {
        const out = this.depot(m.action);
        if (!out.ok) this.send({ type: 'depotRefused', reason: out.reason });
        break;
      }
      case 'cmd':
        this.onCmd(m.cmd);
        break;
      case 'pause':
        // Both may press Esc at once (in local test mode one key reaches both seats): the first pause counts.
        if (this.screen === 'playing' && this.mode !== 'paused') this.pause('engineer', false);
        break;
      case 'ping':
        this.send({ type: 'pong', t: m.t });
        break;
      case 'pong':
        this.latencyMs = Math.max(0, performance.now() - m.t);
        break;
      default:
        break;
    }
    this.changed();
  }

  private onCmd(raw: unknown): void {
    const cmd = cleanCmd(raw);
    if (!cmd) {
      const seq = (raw as { seq?: unknown } | null)?.seq;
      if (typeof seq === 'number' && Number.isFinite(seq)) this.send({ type: 'ack', seq, ok: false, reason: 'The host could not read that command' });
      return;
    }
    if (this.screen === 'playing' && this.mode === 'running' && this.game && !isOver(this.game.state)) {
      this.cmdQueue.push(cmd);
    } else {
      this.send({ type: 'ack', seq: cmd.seq, ok: false, reason: 'The game is paused' });
    }
  }

  /** Brings a (re)connected Engineer up to date with whatever screen we're on. */
  private resync(): void {
    if (this.screen === 'lobby' || !this.game) {
      this.sendLobby();
      return;
    }
    const g = this.game;
    this.sendStart(this.screen !== 'briefing');
    if (this.screen === 'briefing') {
      this.send({ type: 'ready', ready: this.hostReady });
      return;
    }
    this.send({ type: 'snapshot', view: toEngineerView(g.state, g.run) });
    if (this.screen === 'results') {
      this.sendResult();
      return;
    }
    // Mid-game: the connection dropped (even if we hadn't noticed yet). Both press Ready to resume.
    if (this.mode !== 'paused') this.pause('engineer', true);
    this.waitingForEngineer = false;
    this.connectionDropped = true;
    this.send({ type: 'pause', by: this.pausedBy ?? 'engineer', reason: 'disconnect' });
    this.send({ type: 'ready', ready: this.hostReady });
  }

  // ---------------------------------------------------------------------------
  // Lobby and depot
  // ---------------------------------------------------------------------------

  /** What both lobby screens show. */
  lobbyState(): LobbyState {
    const run = this.runs[this.selectedRun];
    const cp = this.checkpoint;
    const cpRun = cp ? this.runs.find((r) => r.id === cp.runId) : undefined;
    return {
      campaign: this.campaign,
      selectedRun: this.selectedRun,
      consist: run ? composeConsist(run, this.campaign.consist) : [],
      hostReady: this.hostReady,
      clientReady: this.clientReady,
      checkpoint: cp && cpRun ? { runId: cp.runId, runName: cpRun.name, stationName: cp.stationName } : null,
    };
  }

  /** The lobby's run list. */
  runCards(): RunCard[] {
    return this.runs.map((r, i) => runCard(r, i, this.campaign, this.canPlay(i)));
  }

  /** The run after the furthest one won, within what's unlocked. */
  suggestedRun(): number {
    const unlocked = Math.max(1, Math.min(this.runs.length, this.campaign.unlocked));
    let furthest = -1;
    this.runs.forEach((r, i) => {
      if (this.campaign.completed.some((c) => c.runId === r.id)) furthest = i;
    });
    return Math.max(0, Math.min(unlocked - 1, furthest + 1));
  }

  /** Unlocked in the campaign, or preselected with the dev ?run= parameter. */
  canPlay(index: number): boolean {
    return isUnlocked(this.campaign, index, this.runs) || index === this.forcedRun;
  }

  /**
   * A lobby action by either player (the Engineer's arrive as `depot` messages). Invalid ones change
   * nothing and say why; valid ones are saved and broadcast.
   */
  depot(action: DepotAction): DepotOutcome {
    if (this.screen !== 'lobby') return { ok: false, reason: 'The run has started, so the depot is closed.' };
    if (typeof action !== 'object' || action === null) return { ok: false, reason: "The depot doesn't know that." };
    let result: DepotResult | null = null;
    switch (action.kind) {
      case 'selectRun': {
        const i = action.index;
        if (!Number.isInteger(i) || i < 0 || i >= this.runs.length) return { ok: false, reason: "There's no such run." };
        if (!this.canPlay(i)) return { ok: false, reason: 'That run is locked: win the one before it first.' };
        this.selectedRun = i;
        break;
      }
      case 'toggleCar':
        result = toggleCar(this.campaign, this.runs[this.selectedRun], action.car);
        break;
      case 'buy':
        result = buyItem(this.campaign, action.item);
        break;
      case 'assist':
        result = setAssist(this.campaign, action.seat, action.on === true);
        break;
      default:
        return { ok: false, reason: "The depot doesn't know that." };
    }
    if (result) {
      if (!result.ok) return result;
      this.campaign = result.campaign;
      this.opts.saveCampaign?.(result.campaign);
    }
    this.sendLobby();
    this.changed();
    return { ok: true };
  }

  setReady(ready: boolean): void {
    this.hostReady = ready;
    if (this.screen === 'lobby') this.sendLobby();
    else this.send({ type: 'ready', ready });
    this.afterReadyChange();
    this.changed();
  }

  canStart(): boolean {
    return this.screen === 'lobby' && this.connected && this.hostReady && this.clientReady && this.canPlay(this.selectedRun);
  }

  /** The station to continue from, when the checkpoint belongs to the selected run. */
  continueStation(): string | null {
    const cp = this.checkpoint;
    return cp && cp.runId === this.runs[this.selectedRun]?.id ? cp.stationName : null;
  }

  /** Starts the selected run afresh and shows the briefing. Any checkpoint is discarded (spec §17). */
  start(seed?: number | null): void {
    const index = this.selectedRun;
    const run = this.runs[index];
    if (!run || !this.canPlay(index)) return;
    const chosen = seed ?? this.forcedSeed ?? randomSeed();
    this.forcedSeed = null;
    const consist = composeConsist(run, this.campaign.consist);
    const upgrades = [...this.campaign.owned];
    const assists = { ...this.campaign.assists };
    const state = newGame(run, { seed: chosen, consist, upgrades, assists });
    this.setCheckpoint(null);
    this.begin({ run, runIndex: index, seed: chosen, consist, upgrades, assists, engineerRun: toEngineerRun(run), state, fromCheckpoint: null, replay: this.isReplay(run) });
  }

  /**
   * Continues from the checkpoint (the lobby's "Continue from <station>", the results' "Retry from
   * <station>"): the game as it left the station, restored from a JSON copy, so the checkpoint can
   * be used again. The train, upgrades and assists are the ones it had then.
   */
  continueFromCheckpoint(): void {
    const cp = this.checkpoint;
    if (!cp) return;
    const index = this.runs.findIndex((r) => r.id === cp.runId);
    if (index < 0) {
      this.setCheckpoint(null);
      this.changed();
      return;
    }
    const run = this.runs[index];
    this.selectedRun = index;
    const state = restoreCheckpoint(cp);
    this.begin({
      run,
      runIndex: index,
      seed: cp.seed,
      consist: [...cp.consist],
      upgrades: [...cp.upgrades],
      assists: { ...state.assists },
      engineerRun: toEngineerRun(run),
      state,
      fromCheckpoint: cp.stationName,
      replay: this.isReplay(run),
    });
  }

  private isReplay(run: RunDef): boolean {
    return this.campaign.completed.some((e) => e.runId === run.id);
  }

  private checkpointRunIndex(): number | null {
    const cp = this.checkpoint;
    const i = cp ? this.runs.findIndex((r) => r.id === cp.runId) : -1;
    return i >= 0 ? i : null;
  }

  private begin(game: HostGame): void {
    this.game = game;
    this.gameId++;
    this.result = null;
    this.payout = null;
    this.screen = 'briefing';
    this.mode = 'paused';
    this.pausedBy = null;
    this.waitingForEngineer = false;
    this.connectionDropped = false;
    this.hostReady = false;
    this.clientReady = false;
    this.cmdQueue = [];
    this.debugQueue = [];
    this.gunfire.reset();
    this.acc = 0;
    this.autopilot?.begin?.(game.run, game.state);
    this.sendStart(false);
    this.changed();
  }

  private sendStart(resume: boolean): void {
    const g = this.game;
    if (!g) return;
    this.send({
      type: 'start',
      run: g.engineerRun,
      consist: g.consist,
      upgrades: g.upgrades,
      assists: g.assists,
      replay: g.replay,
      resume,
      fromCheckpoint: g.fromCheckpoint,
    });
  }

  private setCheckpoint(cp: Checkpoint | null): void {
    if (cp === null && this.checkpoint === null) return;
    this.checkpoint = cp;
    this.opts.saveCheckpoint?.(cp);
  }

  private afterReadyChange(): void {
    if (this.screen === 'lobby') {
      this.sendLobby();
      return;
    }
    const waiting = this.screen === 'briefing' || (this.screen === 'playing' && this.mode === 'paused');
    if (waiting && this.hostReady && this.clientReady && this.connected) this.beginCountdown();
  }

  private beginCountdown(): void {
    if (!this.game) return;
    this.screen = 'playing';
    this.mode = 'countdown';
    this.pausedBy = null;
    this.waitingForEngineer = false;
    this.connectionDropped = false;
    this.countdownEndMs = performance.now() + COUNTDOWN_SECONDS * 1000;
    this.send({ type: 'snapshot', view: toEngineerView(this.game.state, this.game.run) });
    this.send({ type: 'countdown', seconds: COUNTDOWN_SECONDS });
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Play
  // ---------------------------------------------------------------------------

  /** Pauses the game (Esc on either side, or the Engineer dropping out). */
  pause(by: Role, waiting: boolean): void {
    if (this.screen !== 'playing' || !this.game || isOver(this.game.state)) return;
    if (waiting) {
      // A dropped connection: keep who paused, if someone already had.
      if (this.mode !== 'paused') this.pausedBy = by;
      this.connectionDropped = true;
    } else {
      this.pausedBy = by;
    }
    this.mode = 'paused';
    this.waitingForEngineer = waiting;
    this.hostReady = false;
    this.clientReady = false;
    this.cmdQueue = [];
    this.send({ type: 'pause', by: this.pausedBy ?? by, reason: this.connectionDropped ? 'disconnect' : undefined });
    this.changed();
  }

  requestPause(): void {
    if (this.screen === 'playing' && this.mode !== 'paused') this.pause('rider', false);
  }

  /** Dev: a debug command for the next tick (debug keys, spec §19). */
  queueDebug(cmd: DebugCmd): void {
    this.debugQueue.push(cmd);
  }

  /** Advances the sim by real time. Call once per animation frame. */
  frame(nowMs: number): void {
    const dt = this.lastFrameMs ? Math.min(250, nowMs - this.lastFrameMs) : 0;
    this.lastFrameMs = nowMs;
    if (nowMs - this.lastPingMs > PING_MS && this.connected) {
      this.lastPingMs = nowMs;
      this.send({ type: 'ping', t: nowMs });
    }
    if (this.screen !== 'playing' || !this.game) return;
    if (this.mode === 'countdown' && nowMs >= this.countdownEndMs) {
      this.mode = 'running';
      this.acc = 0;
      this.changed();
    }
    if (this.mode !== 'running') {
      this.alpha = 0;
      return;
    }
    this.acc += dt * this.simSpeed;
    let ticks = 0;
    while (this.acc >= TICK_MS && ticks < 16) {
      this.acc -= TICK_MS;
      ticks++;
      this.tick();
      if (this.screen !== 'playing' || this.mode !== 'running') return;
    }
    if (ticks >= 16) this.acc = 0; // don't spiral after a stall
    this.alpha = Math.min(1, this.acc / TICK_MS);
  }

  private tick(): void {
    const g = this.game;
    if (!g) return;
    const input = this.inputSource();
    const cmds = this.cmdQueue;
    this.cmdQueue = [];
    if (this.autopilot) {
      for (const body of this.autopilot.step(g.state, g.run)) cmds.push({ ...body, seq: --this.autoSeq });
    }
    const debug = this.debugQueue;
    this.debugQueue = [];
    const events = step(g.state, g.run, input, cmds, import.meta.env.DEV ? debug : []);
    for (const e of events) {
      if (e.type === 'cmdResult') {
        if (e.seq > 0) this.send({ type: 'ack', seq: e.seq, ok: e.ok, reason: e.reason });
        continue;
      }
      if (e.type === 'checkpoint') this.setCheckpoint(checkpointOf(g.state, g.run, e.stationId, g.consist, g.upgrades));
      const forEngineer = filterForEngineer(e);
      if (!forEngineer) continue;
      if (forEngineer.type === 'gunfire') this.gunfire.offer(forEngineer.intensity);
      else this.send({ type: 'event', event: forEngineer });
    }
    const burst = this.gunfire.take(g.state.tick);
    if (burst !== null) this.send({ type: 'event', event: { type: 'gunfire', intensity: burst } });
    if (g.state.tick % SNAPSHOT_EVERY === 0 || isOver(g.state)) {
      this.send({ type: 'snapshot', view: toEngineerView(g.state, g.run) });
      if (import.meta.env.DEV && this.debug) this.send({ type: 'debug', info: this.debugInfo() });
    }
    for (const cb of this.eventListeners) cb(events);
    if (isOver(g.state)) this.finish();
  }

  /** Dev-only: what the ?debug=1 overlays show. */
  debugInfo(): DebugInfo {
    const g = this.game;
    if (!g) return { obstacles: [], aspects: {}, bandits: 0, horsemen: 0 };
    const s = g.state;
    const aspects: DebugInfo['aspects'] = {};
    for (const sg of g.run.signals) aspects[sg.id] = aspectOf(s, g.run, sg.id);
    return {
      obstacles: s.obstacles.map((o) => ({ id: o.id, edge: o.edge, at: o.at, kind: o.kind, state: o.state })),
      aspects,
      bandits: s.bandits.length,
      horsemen: s.horsemen.length,
    };
  }

  private finish(): void {
    const g = this.game;
    if (!g) return;
    const result = runResult(g.state, g.run);
    const { campaign, payout } = this.opts.recordResult(result);
    this.result = result;
    this.payout = payout;
    this.campaign = campaign;
    // A won run's checkpoint is spent (spec §17); a lost one's is kept for "Retry from <station>".
    if (result.outcome === 'won' && this.checkpoint?.runId === g.run.id) this.setCheckpoint(null);
    this.screen = 'results';
    this.mode = 'paused';
    this.pausedBy = null;
    this.hostReady = false;
    this.clientReady = false;
    this.cmdQueue = [];
    this.sendResult();
    this.changed();
  }

  private sendResult(): void {
    if (!this.result || !this.payout) return;
    this.send({ type: 'result', result: this.result, payout: this.payout, campaign: this.campaign, checkpointName: this.retryStation() });
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  /** After a loss: the station "Retry from <station>" goes back to, if this run has a checkpoint. */
  retryStation(): string | null {
    const g = this.game;
    const cp = this.checkpoint;
    return this.result?.outcome === 'lost' && g && cp && cp.runId === g.run.id ? cp.stationName : null;
  }

  hasNext(): boolean {
    const g = this.game;
    return !!g && this.result?.outcome === 'won' && g.runIndex + 1 < this.runs.length && this.canPlay(g.runIndex + 1);
  }

  next(): void {
    if (!this.hasNext() || !this.game) return;
    this.selectedRun = this.game.runIndex + 1;
    this.start();
  }

  /** The same run from the start, with a new seed (so possibly another variant). */
  restart(): void {
    if (!this.game) return;
    this.selectedRun = this.game.runIndex;
    this.start();
  }

  retryFromCheckpoint(): void {
    if (this.retryStation() !== null) this.continueFromCheckpoint();
  }

  /** Back to the lobby: from the results, or abandoning a briefing or a paused game. */
  toLobby(): void {
    const g = this.game;
    const won = this.result?.outcome === 'won';
    this.screen = 'lobby';
    this.game = null;
    this.result = null;
    this.payout = null;
    this.mode = 'paused';
    this.pausedBy = null;
    this.waitingForEngineer = false;
    this.connectionDropped = false;
    this.cmdQueue = [];
    this.hostReady = false;
    this.clientReady = false;
    this.selectedRun = this.checkpointRunIndex() ?? (g && !won ? g.runIndex : this.suggestedRun());
    this.sendLobby();
    this.changed();
  }

  /** Follows a save changed elsewhere (another tab, an imported save code) and tells the Engineer. */
  syncSave(campaign: CampaignProgress, checkpoint: Checkpoint | null): void {
    this.campaign = campaign;
    this.checkpoint = checkpoint;
    if (!this.canPlay(this.selectedRun)) this.selectedRun = this.suggestedRun();
    if (this.screen === 'lobby') this.sendLobby();
    this.changed();
  }
}

// ---------------------------------------------------------------------------------------------
// Commands from the wire
// ---------------------------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * The Engineer's command if it's well-formed, else null. The sim trusts its inputs, and a NaN lever
 * would end up in the (plain JSON) game state, so nothing unchecked from the network reaches it.
 */
export function cleanCmd(raw: unknown): EngineerCmd | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (!finite(c.seq) || !Number.isInteger(c.seq) || c.seq <= 0) return null;
  const seq = c.seq;
  switch (c.kind) {
    case 'throttle':
    case 'brake':
    case 'fire':
      return finite(c.value) ? { seq, kind: c.kind, value: c.value } : null;
    case 'reverser':
      return c.value === -1 || c.value === 0 || c.value === 1 ? { seq, kind: 'reverser', value: c.value } : null;
    case 'whistle':
      return typeof c.on === 'boolean' ? { seq, kind: 'whistle', on: c.on } : null;
    case 'switch':
      return typeof c.junction === 'string' && (c.state === 'normal' || c.state === 'reverse') ? { seq, kind: 'switch', junction: c.junction, state: c.state } : null;
    default:
      return null;
  }
}
