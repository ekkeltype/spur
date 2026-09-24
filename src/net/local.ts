// In-memory transports (spec §14.2). Local test mode runs the real host and client code over a
// LocalPair, and the tests use it too. Every message makes a JSON round trip, like on the wire, so
// data that doesn't survive JSON (Maps, typed arrays, class instances, NaN) misbehaves here first
// instead of only online. Dev builds also log where such data is.
//
// TransportHub (status + listeners) is shared with the PeerJS transport in peer.ts.

import { isMsg, type Msg } from './protocol';
import type { Transport, TransportStatus } from './transport';

/** What a TransportHub delegates to the actual link. */
export interface TransportDriver {
  /** Called only while the hub is 'open'. */
  send(msg: Msg): void;
  close(): void;
}

/**
 * A listener list. A listener that throws is logged and doesn't stop the others; one removed while
 * a value is being delivered isn't called any more; each add() is its own subscription.
 */
export class Listeners<T> {
  private readonly subs = new Set<{ cb: (value: T) => void }>();

  add(cb: (value: T) => void): () => void {
    const sub = { cb };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  emit(value: T): void {
    for (const sub of [...this.subs]) {
      if (this.subs.has(sub)) safeCall(sub.cb, value);
    }
  }

  clear(): void {
    this.subs.clear();
  }
}

export function safeCall<T>(cb: (value: T) => void, value: T): void {
  try {
    cb(value);
  } catch (err) {
    console.error('[spur] A network listener threw:', err);
  }
}

/**
 * Status and listener bookkeeping for one Transport. The owner drives it with setStatus(),
 * deliver() and finish(); code above the transport only sees the Transport interface.
 */
export class TransportHub implements Transport {
  private current: TransportStatus;
  private finished = false;
  private readonly messageListeners = new Listeners<Msg>();
  private readonly statusListeners = new Listeners<TransportStatus>();

  constructor(
    private readonly driver: TransportDriver,
    initial: TransportStatus,
  ) {
    this.current = initial;
  }

  get status(): TransportStatus {
    return this.current;
  }

  send(msg: Msg): void {
    if (this.current !== 'open') return;
    if (import.meta.env.DEV) warnIfNotWireSafe(msg);
    this.driver.send(msg);
  }

  onMessage(cb: (msg: Msg) => void): () => void {
    return this.finished ? () => {} : this.messageListeners.add(cb);
  }

  onStatus(cb: (s: TransportStatus) => void): () => void {
    // Subscribe before the immediate call, so a status change made inside it still reaches cb.
    const unsubscribe = this.finished ? () => {} : this.statusListeners.add(cb);
    safeCall(cb, this.current);
    return unsubscribe;
  }

  close(): void {
    this.driver.close();
  }

  /** Owner side: changes the status and tells the listeners. Ignored once finished. */
  setStatus(status: TransportStatus): void {
    if (this.finished || status === this.current) return;
    this.current = status;
    this.statusListeners.emit(status);
  }

  /** Owner side: hands a received message to the listeners. Ignored unless open. */
  deliver(msg: Msg): void {
    if (this.current === 'open') this.messageListeners.emit(msg);
  }

  /** Owner side: closed for good. Listeners hear 'closed' (if they haven't yet) and nothing after. */
  finish(): void {
    if (this.finished) return;
    this.setStatus('closed');
    this.finished = true;
    this.messageListeners.clear();
    this.statusListeners.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// LocalPair
// ---------------------------------------------------------------------------------------------

export interface LocalPair {
  host: Transport;
  client: Transport;
  /** Simulates a network failure: both ends go 'closed' and in-flight or new messages are lost. */
  drop(): void;
  /** Ends a drop: both ends go back to 'open'. */
  restore(): void;
}

/**
 * Two linked in-memory transports. Both start 'open'. Messages arrive asynchronously, in order,
 * `latencyMs` (default 0) after being sent, as JSON copies. close() on either end closes both for good.
 */
export function createLocalPair(opts: { latencyMs?: number } = {}): LocalPair {
  const latency = opts.latencyMs;
  const latencyMs = typeof latency === 'number' && Number.isFinite(latency) && latency > 0 ? latency : 0;
  // Bumped by drop() and close(): anything sent under an older epoch is discarded on arrival.
  let epoch = 0;
  let closedForGood = false;

  const closeBoth = (): void => {
    if (closedForGood) return;
    closedForGood = true;
    epoch++;
    host.finish();
    client.finish();
  };

  const driverTo = (receiver: () => TransportHub): TransportDriver => ({
    send(msg) {
      const wire = JSON.stringify(msg); // throws on BigInt or cycles, as a real send would
      const sentIn = epoch;
      setTimeout(() => {
        if (sentIn !== epoch) return;
        const copy: unknown = JSON.parse(wire);
        if (isMsg(copy)) receiver().deliver(copy);
      }, latencyMs);
    },
    close: closeBoth,
  });

  const host: TransportHub = new TransportHub(driverTo(() => client), 'open');
  const client: TransportHub = new TransportHub(driverTo(() => host), 'open');

  return {
    host,
    client,
    drop() {
      if (closedForGood) return;
      epoch++;
      host.setStatus('closed');
      client.setStatus('closed');
    },
    restore() {
      if (closedForGood) return;
      host.setStatus('open');
      client.setStatus('open');
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Dev-only wire check
// ---------------------------------------------------------------------------------------------

const reported = new Set<string>();

/** Logs (once per spot) data that JSON would change on the way: it would arrive different online. */
function warnIfNotWireSafe(msg: Msg): void {
  const problem = findWireProblem(msg, 'msg', 0);
  if (problem === null) return;
  const text = `[spur] "${msg.type}" message: ${problem}. Send plain objects, arrays, strings, finite numbers and booleans.`;
  if (reported.has(text)) return;
  reported.add(text);
  console.warn(text);
}

function findWireProblem(value: unknown, path: string, depth: number): string | null {
  if (depth > 64) return null; // JSON.stringify has already rejected cycles
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value) ? null : `${path} is ${value}, which arrives as null`;
    case 'function':
    case 'symbol':
      return `${path} is a ${typeof value}, which JSON drops`;
    case 'object': {
      if (value === null) return null;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const problem = findWireProblem(value[i], `${path}[${i}]`, depth + 1);
          if (problem) return problem;
        }
        return null;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'class instance';
        return `${path} is a ${name}, which arrives as ${name === 'Date' ? 'a string' : 'a plain object'}`;
      }
      for (const [key, v] of Object.entries(value)) {
        const problem = findWireProblem(v, `${path}.${key}`, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    default:
      return null;
  }
}
