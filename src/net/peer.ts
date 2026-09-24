// Online play over PeerJS (spec §14.2, §14.3, §14.6).
//
// The Rider's browser registers the PeerJS id `spur-<CODE>` with the signalling server and waits;
// The Engineer's browser dials it. After the handshake the game talks over a direct WebRTC data channel
// ({ reliable: true, serialization: 'json' }); the signalling server is only needed to (re)connect.
//
// Two wire extras stay invisible above the Transport:
// - PeerJS 1.5.5's JSON channel refuses messages of 16300+ bytes, so bigger ones go as chunk frames;
// - "bye" frames say why a connection is ending, because WebRTC itself doesn't: when a page closes,
//   the other side only finds out from the ICE timeout, 5–10 s later. A page that goes away (tab
//   closed, reload) says 'leaving', which counts as a drop, so a reloaded host can be found again.
// The Rider closing the room on purpose says 'closed', and a replaced connection 'replaced'; both
//   stop the Engineer's client at once instead of letting it retry for a minute.
// Frames have a `spur` field and no `type`, so isMsg() never mistakes them for game messages.

import Peer, { type DataConnection, type PeerOptions } from 'peerjs';
import { Listeners, TransportHub } from './local';
import { isMsg, type Msg } from './protocol';
import { makeRoomCode, normalizeRoomCode, peerIdFor, peerOptionsFromEnv } from './room';
import type { Transport } from './transport';

export {
  PEERJS_DEFAULT_ICE_SERVERS,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  makeRoomCode,
  normalizeRoomCode,
  peerIdFor,
  peerOptionsFromEnv,
} from './room';

// ---------------------------------------------------------------------------------------------
// Timings and limits
// ---------------------------------------------------------------------------------------------

/** Host: registering the room may take this long before the server counts as unreachable. */
const REGISTER_TIMEOUT_MS = 15_000;
/** Host: how many codes to try when the chosen one is taken. */
const MAX_CODE_ATTEMPTS = 6;
/** Host: backoff for re-registering after losing the signalling server: 1 s, 2 s, 4 s … 15 s. */
const RESIGNAL_BASE_MS = 1_000;
const RESIGNAL_MAX_MS = 15_000;
/** Host: a re-registration that neither succeeds nor fails in this time is abandoned and retried. */
const RESIGNAL_TIMEOUT_MS = 15_000;
/** Host: failed re-registrations in a row before the outage is reported through onError. */
const RESIGNAL_REPORT_AFTER = 3;
/** Client: pause after a failed attempt, and how long to keep trying after a drop (spec §14.6). */
const RETRY_INTERVAL_MS = 2_000;
const RETRY_WINDOW_MS = 60_000;
/** Client: how long the first connection may take, retries included. */
const FIRST_CONNECT_WINDOW_MS = 30_000;
/** Client: one attempt (signalling plus the WebRTC handshake) may take this long. */
const ATTEMPT_TIMEOUT_MS = 10_000;
const MIN_ATTEMPT_MS = 3_000;
/** ICE 'disconnected' can heal by itself; it only counts as a drop once it has lasted this long. */
const ICE_GRACE_MS = 2_500;
/** Time given to a bye frame to leave before its connection is torn down. */
const BYE_FLUSH_MS = 500;
/** PeerJS 1.5.5 refuses JSON messages of 16300 bytes or more; stay a little below. */
const MAX_FRAME_BYTES = 16_000;
/** UTF-16 units per chunk: at most 3 UTF-8 bytes each after JSON escaping, so a frame stays under the limit. */
const CHUNK_UNITS = 5_000;
const MAX_CHUNKS = 1_000;

const CONNECT_OPTIONS = { reliable: true, serialization: 'json' };

const TEXT = {
  unreachable: "Can't reach the matchmaking server. Check your internet connection and try again.",
  noRoom: 'No room with that code. Check the code with the Rider and try again.',
  badCode: "That isn't a room code. Codes are 5 letters and digits, like K7PQZ.",
  cantConnect: "Couldn't connect to the Rider's browser. Some networks block direct connections between players.",
  lost: "Lost the connection to the Rider and couldn't reconnect.",
  hostLeft: 'The Rider closed the room.',
  replaced: "Someone else joined the Rider's room with this code, so this connection was closed.",
  noFreeCode: "Couldn't get a free room code. Try again in a moment.",
  signalLost: "Lost contact with the matchmaking server. Retrying; until it's back, the Engineer can't join or rejoin.",
  noWebRTC:
    "This browser can't make peer-to-peer connections (WebRTC), which online play needs. Try a recent Chrome, Firefox, Edge or Safari.",
} as const;

type Timer = ReturnType<typeof setTimeout>;

// ---------------------------------------------------------------------------------------------
// Host (the Rider)
// ---------------------------------------------------------------------------------------------

export interface PeerHostOptions {
  /**
   * Try this code first, e.g. the one from before a page reload, so the Engineer's retrying client finds
   * the room again. A fresh code is used if it's invalid or taken.
   */
  code?: string;
  /** Defaults to peerOptionsFromEnv(). */
  peerOptions?: PeerOptions;
}

/** The Rider's side: owns the room and accepts the Engineer's connection (and their reconnections). */
export class PeerHost {
  /**
   * Registers `spur-<CODE>` with the signalling server; if that id is taken ('unavailable-id'),
   * generates a new code and retries. Rejects with a readable Error if the signalling server is
   * unreachable. If you stop caring before it settles, destroy() the host it resolves with.
   */
  static open(opts: PeerHostOptions = {}): Promise<PeerHost> {
    return new PeerHost(opts.peerOptions ?? peerOptionsFromEnv()).register(opts.code);
  }

  /**
   * ONE stable Transport for the whole session: 'connecting' until the Engineer connects, 'open' while
   * they're connected, 'closed' when they drop, and 'open' again when they (re)connect. A newer
   * connection replaces the current one, which shows as 'closed' then 'open'. close() = destroy().
   */
  readonly transport: Transport;

  private readonly hub: TransportHub;
  private readonly errors = new Listeners<string>();
  private readonly recoveries = new Listeners<void>();
  private roomCode = '';
  private peer: Peer | null = null;
  private registered = false;
  private destroyed = false;
  /** The Engineer's connection once open, and a newer one still being set up. */
  private current: Link | null = null;
  private pending: Link | null = null;
  private resignalTimer: Timer | undefined;
  private resignalWatchdog: Timer | undefined;
  private resignalFailures = 0;
  private readonly stopPageHide: () => void;

  private constructor(private readonly peerOptions: PeerOptions) {
    this.hub = new TransportHub(
      { send: (msg) => this.current?.send(msg), close: () => this.destroy() },
      'connecting',
    );
    this.transport = this.hub;
    // Closing or reloading the page: a drop for the Engineer, who keeps retrying (see PeerHostOptions.code).
    this.stopPageHide = onPageHide(() => this.current?.sendBye('leaving'));
  }

  /** The room code for the Engineer to type. */
  get code(): string {
    return this.roomCode;
  }

  /** Readable problems after open(), such as a lasting loss of the signalling server. */
  onError(cb: (message: string) => void): () => void {
    return this.errors.add(cb);
  }

  /** Called when the signalling server is back after an outage that onError reported. */
  onRecovered(cb: () => void): () => void {
    return this.recoveries.add(cb);
  }

  /** Closes the room for good. The Engineer's client is told, so it stops at once instead of retrying. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopPageHide();
    clearTimeout(this.resignalTimer);
    clearTimeout(this.resignalWatchdog);
    this.pending?.dispose();
    this.pending = null;
    let flushMs = 0;
    if (this.current) {
      flushMs = this.current.sendBye('closed') ? BYE_FLUSH_MS : 0;
      this.current.dispose(flushMs);
      this.current = null;
    }
    this.hub.finish();
    this.errors.clear();
    const peer = this.peer;
    if (peer && !peer.destroyed) {
      if (flushMs > 0) setTimeout(() => peer.destroy(), flushMs);
      else peer.destroy();
    }
  }

  private register(preferredCode?: string): Promise<PeerHost> {
    return new Promise<PeerHost>((resolve, reject) => {
      let attempts = 0;
      let timer: Timer | undefined;

      const fail = (message: string): void => {
        clearTimeout(timer);
        this.destroy();
        reject(new Error(message));
      };

      const tryCode = (code: string): void => {
        attempts++;
        this.roomCode = code;
        clearTimeout(timer);
        timer = setTimeout(() => fail(TEXT.unreachable), REGISTER_TIMEOUT_MS);
        let peer: Peer;
        try {
          peer = new Peer(peerIdFor(code), this.peerOptions);
        } catch (err) {
          fail(`Online play isn't available here: ${errorText(err)}`);
          return;
        }
        this.peer = peer;
        const isCurrent = (): boolean => peer === this.peer && !this.destroyed;

        peer.on('open', () => {
          if (!isCurrent()) return;
          if (!this.registered) {
            this.registered = true;
            clearTimeout(timer);
            resolve(this);
          }
          this.onSignallingOpen();
        });
        peer.on('error', (err) => {
          if (!isCurrent()) return;
          if (this.registered) {
            this.onPeerError(err.type, err.message);
          } else if (err.type === 'unavailable-id') {
            peer.destroy();
            if (attempts < MAX_CODE_ATTEMPTS) tryCode(makeRoomCode());
            else fail(TEXT.noFreeCode);
          } else {
            fail(describeError(err.type, err.message));
          }
        });
        // Losing the signalling server doesn't break a live data channel, but it would stop the Engineer
        // from (re)joining, so keep the room id registered.
        peer.on('disconnected', () => {
          if (isCurrent() && this.registered) this.onSignallingLost();
        });
        peer.on('connection', (conn) => {
          if (isCurrent()) this.onConnection(conn);
          else conn.close();
        });
      };

      tryCode((preferredCode !== undefined && normalizeRoomCode(preferredCode)) || makeRoomCode());
    });
  }

  private onConnection(conn: DataConnection): void {
    this.pending?.dispose(); // only the newest attempt matters
    const link: Link = new Link(conn, {
      open: () => this.onLinkOpen(link),
      message: (msg) => {
        if (link === this.current) this.hub.deliver(msg);
      },
      bye: () => this.onLinkLost(link), // whatever the reason, they're gone
      lost: () => this.onLinkLost(link),
    });
    this.pending = link;
  }

  private onLinkOpen(link: Link): void {
    if (this.destroyed || link !== this.pending) {
      link.dispose();
      return;
    }
    this.pending = null;
    const previous = this.current;
    this.current = link;
    if (previous) {
      // One Engineer at a time. Usually the newcomer *is* them, back after a drop the host hadn't
      // noticed yet; otherwise the old client is told why it was cut off.
      previous.dispose(previous.sendBye('replaced') ? BYE_FLUSH_MS : 0);
      this.hub.setStatus('closed');
    }
    this.hub.setStatus('open');
  }

  private onLinkLost(link: Link): void {
    link.dispose();
    if (link === this.pending) {
      this.pending = null;
    } else if (link === this.current) {
      this.current = null;
      this.hub.setStatus('closed');
    }
  }

  private onSignallingOpen(): void {
    clearTimeout(this.resignalWatchdog);
    this.resignalWatchdog = undefined;
    const reported = this.resignalFailures >= RESIGNAL_REPORT_AFTER;
    this.resignalFailures = 0;
    if (reported) this.recoveries.emit(undefined);
  }

  private onSignallingLost(): void {
    if (this.destroyed || this.resignalTimer !== undefined) return;
    clearTimeout(this.resignalWatchdog);
    this.resignalWatchdog = undefined;
    const delay = Math.min(RESIGNAL_MAX_MS, RESIGNAL_BASE_MS * 2 ** this.resignalFailures);
    this.resignalFailures++;
    if (this.resignalFailures === RESIGNAL_REPORT_AFTER) this.errors.emit(TEXT.signalLost);
    this.resignalTimer = setTimeout(() => {
      this.resignalTimer = undefined;
      const peer = this.peer;
      if (this.destroyed || !peer || peer.destroyed || !peer.disconnected) return;
      try {
        peer.reconnect();
      } catch (err) {
        console.warn('[spur] Reconnecting to the matchmaking server failed:', err);
        this.onSignallingLost();
        return;
      }
      // If the socket neither opens nor fails, give up on it; the 'disconnected' event that
      // follows schedules the next try.
      this.resignalWatchdog = setTimeout(() => {
        this.resignalWatchdog = undefined;
        if (!this.destroyed && peer === this.peer && !peer.open && !peer.disconnected) peer.disconnect();
      }, RESIGNAL_TIMEOUT_MS);
    }, delay);
  }

  private onPeerError(type: string, message: string): void {
    switch (type) {
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
      case 'unavailable-id': // our id was grabbed while we were away; keep retrying
        // PeerJS disconnects from the server after these; onSignallingLost() takes over.
        console.warn(`[spur] Matchmaking server: ${message}`);
        return;
      case 'webrtc':
        console.warn(`[spur] WebRTC error on an incoming connection: ${message}`);
        return;
      default:
        console.warn(`[spur] PeerJS error (${type}): ${message}`);
        this.errors.emit(describeError(type, message));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Client (the Engineer)
// ---------------------------------------------------------------------------------------------

export interface PeerClientOptions {
  /** How long to keep retrying after the connection drops. Default 60 s (spec §14.6). */
  retryWindowMs?: number;
  /** Pause after a failed attempt before the next one. Default 2 s (spec §14.6). */
  retryIntervalMs?: number;
  /** How long the very first connection may take, retries included. Default 30 s. */
  firstConnectWindowMs?: number;
  /** Defaults to peerOptionsFromEnv(). */
  peerOptions?: PeerOptions;
}

type AttemptFailure = 'timeout' | 'no-room' | 'signalling' | 'webrtc';

/** The Engineer's side: dials the Rider's room and redials after a drop. */
export class PeerClient {
  /**
   * Starts connecting to room `code` immediately (the code is normalized first). Subscribe to
   * onError and transport.onStatus right away: failures are reported asynchronously.
   */
  static connect(code: string, opts: PeerClientOptions = {}): PeerClient {
    return new PeerClient(code, opts);
  }

  /**
   * 'connecting' → 'open'. When the connection drops, goes back to 'connecting' and retries every
   * 2 s for 60 s, then 'closed' for good (as it does when the first connection fails, when the Rider
   * closes the room, or on close()/destroy()). onError says why.
   */
  readonly transport: Transport;

  private readonly hub: TransportHub;
  private readonly errors = new Listeners<string>();
  private readonly code: string;
  private readonly peerOptions: PeerOptions;
  private readonly retryWindowMs: number;
  private readonly retryIntervalMs: number;
  private peer: Peer | null = null;
  private link: Link | null = null;
  private everOpened = false;
  private destroyed = false;
  /** performance.now() after which no new attempt starts. */
  private deadline: number;
  private lastFailure: AttemptFailure = 'timeout';
  private attemptTimer: Timer | undefined;
  private retryTimer: Timer | undefined;
  private readonly stopPageHide: () => void;

  private constructor(code: string, opts: PeerClientOptions) {
    this.hub = new TransportHub(
      { send: (msg) => this.link?.send(msg), close: () => this.destroy() },
      'connecting',
    );
    this.transport = this.hub;
    this.stopPageHide = onPageHide(() => this.link?.sendBye('leaving'));
    this.peerOptions = opts.peerOptions ?? peerOptionsFromEnv();
    this.retryWindowMs = positiveOr(opts.retryWindowMs, RETRY_WINDOW_MS);
    this.retryIntervalMs = positiveOr(opts.retryIntervalMs, RETRY_INTERVAL_MS);
    this.deadline = performance.now() + positiveOr(opts.firstConnectWindowMs, FIRST_CONNECT_WINDOW_MS);
    this.code = normalizeRoomCode(code);
    if (this.code === '') {
      this.retryTimer = setTimeout(() => this.fail(TEXT.badCode), 0);
      return;
    }
    this.attempt();
  }

  /** Readable reasons for giving up, e.g. "No room with that code…". */
  onError(cb: (message: string) => void): () => void {
    return this.errors.add(cb);
  }

  /** Stops for good: no more retries; the transport goes 'closed'. The Rider's side is told. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopPageHide();
    clearTimeout(this.attemptTimer);
    clearTimeout(this.retryTimer);
    let flushMs = 0;
    if (this.link) {
      flushMs = this.link.sendBye('closed') ? BYE_FLUSH_MS : 0;
      this.link.dispose(flushMs);
      this.link = null;
    }
    this.dropPeer(flushMs);
    this.hub.finish();
    this.errors.clear();
  }

  private attempt(): void {
    this.retryTimer = undefined;
    if (this.destroyed) return;
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) {
      this.giveUp();
      return;
    }
    // A fresh Peer per attempt: an error about an earlier attempt (the server may report a missing
    // room more than once) can't be taken for this one's, and a Peer that lost the server is never reused.
    this.dropPeer();
    this.attemptTimer = setTimeout(
      () => this.attemptFailed('timeout'),
      Math.min(ATTEMPT_TIMEOUT_MS, Math.max(MIN_ATTEMPT_MS, remaining)),
    );
    let peer: Peer;
    try {
      peer = new Peer(`${peerIdFor(this.code)}-${makeRoomCode()}${makeRoomCode()}`, this.peerOptions);
    } catch (err) {
      this.fail(`Online play isn't available here: ${errorText(err)}`);
      return;
    }
    this.peer = peer;
    peer.on('open', () => {
      if (peer === this.peer && !this.destroyed && !this.link) this.dial(peer);
    });
    peer.on('error', (err) => {
      if (peer === this.peer && !this.destroyed) this.onPeerError(err.type, err.message);
    });
  }

  private dial(peer: Peer): void {
    // PeerJS returns undefined (despite its types) if the peer lost the server in the meantime.
    const conn = peer.connect(peerIdFor(this.code), CONNECT_OPTIONS) as DataConnection | undefined;
    if (!conn) {
      this.attemptFailed('signalling');
      return;
    }
    const link: Link = new Link(conn, {
      open: () => {
        if (link === this.link) this.onOpen();
      },
      message: (msg) => {
        if (link === this.link) this.hub.deliver(msg);
      },
      bye: (reason) => {
        if (link !== this.link) return;
        if (reason === 'leaving') this.onLinkLost(); // their page is closing or reloading: retry
        else this.fail(reason === 'replaced' ? TEXT.replaced : TEXT.hostLeft);
      },
      lost: () => {
        if (link === this.link) this.onLinkLost();
      },
    });
    this.link = link;
  }

  private onOpen(): void {
    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.everOpened = true;
    this.hub.setStatus('open');
  }

  private onLinkLost(): void {
    if (this.hub.status !== 'open') {
      this.attemptFailed('webrtc'); // failed during the handshake
      return;
    }
    // A drop: retry at once, then every retryIntervalMs, for retryWindowMs.
    this.link?.dispose();
    this.link = null;
    this.hub.setStatus('connecting');
    this.deadline = performance.now() + this.retryWindowMs;
    this.lastFailure = 'timeout';
    this.attempt();
  }

  private onPeerError(type: string, message: string): void {
    const connected = this.hub.status === 'open';
    switch (type) {
      case 'peer-unavailable':
        if (!connected) this.attemptFailed('no-room');
        return;
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
      case 'disconnected':
      case 'unavailable-id':
        // Once connected, the signalling server doesn't matter until the next attempt, which
        // starts with a fresh Peer anyway.
        if (!connected) this.attemptFailed('signalling');
        return;
      case 'webrtc':
        // Often harmless (a late ICE candidate); the attempt timeout or ICE failure decides.
        console.warn(`[spur] WebRTC error: ${message}`);
        return;
      default:
        // Browser or configuration problems: retrying won't help.
        this.fail(describeError(type, message));
    }
  }

  private attemptFailed(reason: AttemptFailure): void {
    if (this.destroyed) return;
    clearTimeout(this.attemptTimer);
    this.attemptTimer = undefined;
    this.link?.dispose();
    this.link = null;
    this.dropPeer();
    if (reason === 'no-room' && !this.everOpened) {
      this.fail(TEXT.noRoom); // most likely a typo; after a drop it's the Rider reloading, so keep trying
      return;
    }
    this.lastFailure = reason;
    if (performance.now() + this.retryIntervalMs >= this.deadline) {
      this.giveUp();
      return;
    }
    this.retryTimer = setTimeout(() => this.attempt(), this.retryIntervalMs);
  }

  private giveUp(): void {
    if (this.everOpened) this.fail(TEXT.lost);
    else if (this.lastFailure === 'signalling') this.fail(TEXT.unreachable);
    else this.fail(TEXT.cantConnect);
  }

  /** Reports why, then stops for good. */
  private fail(message: string): void {
    if (this.destroyed) return;
    this.errors.emit(message);
    this.destroy();
  }

  private dropPeer(delayMs = 0): void {
    const peer = this.peer;
    this.peer = null;
    if (!peer || peer.destroyed) return;
    if (delayMs > 0) setTimeout(() => peer.destroy(), delayMs);
    else peer.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Link: one DataConnection with framing and drop detection
// ---------------------------------------------------------------------------------------------

/** 'closed': ended on purpose. 'replaced': a newer connection took over. 'leaving': the page is going away. */
type ByeReason = 'closed' | 'replaced' | 'leaving';
interface ChunkFrame {
  spur: 'chunk';
  id: number;
  n: number;
  of: number;
  data: string;
}
interface ByeFrame {
  spur: 'bye';
  reason: ByeReason;
}
type Frame = ChunkFrame | ByeFrame;

interface LinkEvents {
  open(): void;
  message(msg: Msg): void;
  bye(reason: ByeReason): void;
  /** The connection closed or failed, before or after opening. At most once. */
  lost(): void;
}

const encoder = new TextEncoder();

class Link {
  /** Events still reach the owner. */
  private active = true;
  private closeRequested = false;
  private iceTimer: Timer | undefined;
  private nextChunkId = 1;
  private readonly inbox = new ChunkInbox();

  constructor(
    private readonly conn: DataConnection,
    private readonly events: LinkEvents,
  ) {
    conn.on('open', () => {
      if (this.active) this.events.open();
    });
    conn.on('data', (data) => this.receive(data));
    conn.on('close', () => this.lose());
    conn.on('error', (err) => {
      if (err.type === 'not-open-yet') return; // a send raced a close; the close event follows
      if (err.type === 'message-too-big') {
        console.error(`[spur] PeerJS refused a message: ${err.message}`); // can't happen: we chunk
        return;
      }
      this.lose();
    });
    // PeerJS's close event can lag far behind a dead network; the ICE state notices sooner.
    conn.on('iceStateChanged', (state) => this.onIceState(state));
  }

  private get isOpen(): boolean {
    return this.active && this.conn.open;
  }

  send(msg: Msg): void {
    if (!this.isOpen) return;
    const json = JSON.stringify(msg);
    if (json.length * 3 < MAX_FRAME_BYTES || encoder.encode(json).byteLength < MAX_FRAME_BYTES) {
      void this.conn.send(msg);
      return;
    }
    const parts = splitText(json, CHUNK_UNITS);
    if (parts.length > MAX_CHUNKS) {
      console.error(`[spur] Not sending a "${msg.type}" message of ${json.length} characters: too big.`);
      return;
    }
    const id = this.nextChunkId++;
    parts.forEach((data, n) => {
      const frame: ChunkFrame = { spur: 'chunk', id, n, of: parts.length, data };
      void this.conn.send(frame);
    });
  }

  /** Sends a bye frame. Returns whether it went out. */
  sendBye(reason: ByeReason): boolean {
    if (!this.isOpen) return false;
    const frame: ByeFrame = { spur: 'bye', reason };
    void this.conn.send(frame);
    return true;
  }

  /** Stops reporting events and closes the connection, after `delayMs` (to let a bye frame leave). */
  dispose(delayMs = 0): void {
    this.active = false;
    this.clearIceTimer();
    if (this.closeRequested) return;
    this.closeRequested = true;
    const close = (): void => {
      try {
        this.conn.close();
      } catch (err) {
        console.warn('[spur] Closing a connection failed:', err);
      }
    };
    if (delayMs > 0) setTimeout(close, delayMs);
    else close();
  }

  private receive(data: unknown): void {
    if (!this.active) return;
    let payload = data;
    if (isFrameShaped(data)) {
      const frame = parseFrame(data);
      if (!frame) return; // unknown frame kind, e.g. from a newer version
      if (frame.spur === 'bye') {
        this.events.bye(frame.reason);
        return;
      }
      payload = this.inbox.add(frame);
      if (payload === undefined) return;
    }
    if (isMsg(payload)) this.events.message(payload);
    else console.warn('[spur] Ignored a malformed network message.');
  }

  private onIceState(state: RTCIceConnectionState): void {
    if (!this.active) return;
    if (state === 'failed' || state === 'closed') {
      this.lose();
    } else if (state === 'disconnected') {
      this.iceTimer ??= setTimeout(() => {
        this.iceTimer = undefined;
        this.lose();
      }, ICE_GRACE_MS);
    } else {
      this.clearIceTimer(); // checking, connected, completed: healthy again
    }
  }

  private lose(): void {
    if (!this.active) return;
    this.active = false;
    this.clearIceTimer();
    this.events.lost();
  }

  private clearIceTimer(): void {
    clearTimeout(this.iceTimer);
    this.iceTimer = undefined;
  }
}

/** Reassembles chunked messages. The channel is reliable and ordered, so chunks come in sequence. */
class ChunkInbox {
  private id = 0;
  private of = 0;
  private parts: string[] = [];

  /** Returns the parsed message once its last chunk is in, otherwise undefined. */
  add(frame: ChunkFrame): unknown {
    if (frame.n === 0) {
      this.id = frame.id;
      this.of = frame.of;
      this.parts = [];
    } else if (frame.id !== this.id || frame.of !== this.of || frame.n !== this.parts.length) {
      this.of = 0; // out of sequence: drop the partial message
      this.parts = [];
      return undefined;
    }
    this.parts.push(frame.data);
    if (this.parts.length < this.of) return undefined;
    const json = this.parts.join('');
    this.of = 0;
    this.parts = [];
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return undefined;
    }
  }
}

function isFrameShaped(data: unknown): data is Record<string, unknown> {
  return typeof data === 'object' && data !== null && 'spur' in data && !('type' in data);
}

function parseFrame(f: Record<string, unknown>): Frame | null {
  if (f.spur === 'bye') {
    // An unknown reason (from a newer version) gets the gentlest reading: a drop, not an ending.
    return { spur: 'bye', reason: f.reason === 'closed' || f.reason === 'replaced' ? f.reason : 'leaving' };
  }
  const { id, n, of, data } = f;
  if (
    f.spur === 'chunk' &&
    isIndex(id) &&
    isIndex(n) &&
    isIndex(of) &&
    typeof data === 'string' &&
    n < of &&
    of <= MAX_CHUNKS
  ) {
    return { spur: 'chunk', id, n, of, data };
  }
  return null;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Splits text into pieces of at most `size` UTF-16 units without cutting a surrogate pair. */
function splitText(text: string, size: number): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function describeError(type: string, message: string): string {
  switch (type) {
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return TEXT.unreachable;
    case 'peer-unavailable':
      return TEXT.noRoom;
    case 'browser-incompatible':
      return TEXT.noWebRTC;
    case 'ssl-unavailable':
      return "The matchmaking server doesn't accept secure connections. Check VITE_PEER_SECURE (docs/networking.md).";
    case 'invalid-key':
      return 'The matchmaking server rejected the API key. Check VITE_PEER_KEY (docs/networking.md).';
    default:
      return `Online play failed (${type}): ${message}`;
  }
}

/** Runs `cb` when the page is closed, reloaded or navigated away from. Returns a remover. */
function onPageHide(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('pagehide', cb);
  return () => window.removeEventListener('pagehide', cb);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
