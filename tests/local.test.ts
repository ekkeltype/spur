import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalPair } from '../src/net/local';
import type { Msg } from '../src/net/protocol';
import type { Transport, TransportStatus } from '../src/net/transport';

type AckMsg = Extract<Msg, { type: 'ack' }>;
type LobbyMsg = Extract<Msg, { type: 'lobby' }>;

const ping = (t: number): Msg => ({ type: 'ping', t });

function collect(transport: Transport): Msg[] {
  const got: Msg[] = [];
  transport.onMessage((m) => got.push(m));
  return got;
}

function statuses(transport: Transport): TransportStatus[] {
  const seen: TransportStatus[] = [];
  transport.onStatus((s) => seen.push(s));
  return seen;
}

/** Runs the timers that are due now (latency 0). */
const flush = (): void => {
  vi.advanceTimersByTime(1);
};

describe('createLocalPair', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with both ends open', () => {
    const { host, client } = createLocalPair();
    expect(host.status).toBe('open');
    expect(client.status).toBe('open');
  });

  it('delivers asynchronously and in order, both ways', () => {
    const { host, client } = createLocalPair();
    const atClient = collect(client);
    const atHost = collect(host);

    host.send(ping(1));
    host.send(ping(2));
    client.send({ type: 'pong', t: 1 });
    host.send(ping(3));
    expect(atClient).toEqual([]); // nothing arrives synchronously
    expect(atHost).toEqual([]);

    flush();
    expect(atClient).toEqual([ping(1), ping(2), ping(3)]);
    expect(atHost).toEqual([{ type: 'pong', t: 1 }]);
  });

  it('keeps the order across many messages', () => {
    const { host, client } = createLocalPair({ latencyMs: 5 });
    const atClient = collect(client);
    for (let i = 0; i < 200; i++) host.send(ping(i));
    vi.advanceTimersByTime(5);
    expect(atClient.map((m) => (m.type === 'ping' ? m.t : -1))).toEqual([...Array(200).keys()]);
  });

  it('delivers latencyMs after sending', () => {
    const { host, client } = createLocalPair({ latencyMs: 50 });
    const atClient = collect(client);
    host.send(ping(1));
    vi.advanceTimersByTime(49);
    expect(atClient).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(atClient).toEqual([ping(1)]);
  });

  it('deep-copies messages through JSON, like the wire', () => {
    const { host, client } = createLocalPair();
    const atClient = collect(client);
    const campaign = {
      unlocked: 2,
      money: 150,
      owned: [],
      completed: [{ runId: 'first-light', bestTimeSec: 400, medals: ['onTime'], times: 1 }],
      assists: { rider: false, engineer: false },
      consist: [],
    };
    const lobby: LobbyMsg = {
      type: 'lobby',
      lobby: { campaign, selectedRun: 0, consist: ['express'], hostReady: false, clientReady: false, checkpoint: null, switchSeats: { rider: false, engineer: false, switching: false } },
    } as LobbyMsg;
    host.send(lobby);
    // Mutating after send must not reach the receiver.
    lobby.lobby.hostReady = true;
    lobby.lobby.campaign.completed[0].medals.push('clean');
    lobby.lobby.campaign.unlocked = 5;
    flush();

    const received = atClient[0] as LobbyMsg;
    expect(received).not.toBe(lobby);
    expect(received.lobby.hostReady).toBe(false);
    expect(received.lobby.campaign).toEqual({
      unlocked: 2,
      money: 150,
      owned: [],
      completed: [{ runId: 'first-light', bestTimeSec: 400, medals: ['onTime'], times: 1 }],
      assists: { rider: false, engineer: false },
      consist: [],
    });
  });

  it('applies JSON semantics: undefined fields vanish, non-JSON data is mangled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, client } = createLocalPair();
    const atClient = collect(client);
    const ack: AckMsg = { type: 'ack', seq: 1, ok: true, reason: undefined };
    host.send(ack);
    // A Map smuggled into a message arrives as {} — exactly what would happen online.
    host.send({ type: 'ack', seq: 2, ok: true, reason: new Map([['a', 1]]) } as unknown as Msg);
    host.send({ type: 'ping', t: Number.NaN });
    flush();

    expect(atClient[0]).toEqual({ type: 'ack', seq: 1, ok: true });
    expect('reason' in atClient[0]).toBe(false);
    expect((atClient[1] as unknown as { reason: unknown }).reason).toEqual({});
    expect(atClient[2]).toEqual({ type: 'ping', t: null });
    if (import.meta.env.DEV) {
      const warnings = warn.mock.calls.map((c) => String(c[0]));
      expect(warnings.some((w) => w.includes('msg.reason is a Map'))).toBe(true);
      expect(warnings.some((w) => w.includes('msg.t is NaN'))).toBe(true);
    }
  });

  it('only delivers data that looks like a Msg', () => {
    const { host, client } = createLocalPair();
    const atClient = collect(client);
    host.send({ nope: true } as unknown as Msg);
    host.send(ping(7));
    flush();
    expect(atClient).toEqual([ping(7)]);
  });

  it('calls status listeners immediately and on every change, without repeats', () => {
    const pair = createLocalPair();
    const hostSeen = statuses(pair.host);
    const clientSeen = statuses(pair.client);
    expect(hostSeen).toEqual(['open']);

    pair.drop();
    pair.drop(); // no change, no call
    pair.restore();
    pair.restore();
    expect(hostSeen).toEqual(['open', 'closed', 'open']);
    expect(clientSeen).toEqual(['open', 'closed', 'open']);
    expect(pair.host.status).toBe('open');
  });

  it('drop() loses in-flight and new messages; restore() lets new ones through', () => {
    const pair = createLocalPair({ latencyMs: 10 });
    const atClient = collect(pair.client);
    const atHost = collect(pair.host);

    pair.host.send(ping(1)); // in flight when the network fails
    vi.advanceTimersByTime(5);
    pair.drop();
    expect(pair.host.status).toBe('closed');
    expect(pair.client.status).toBe('closed');
    pair.host.send(ping(2)); // sent while down
    pair.client.send({ type: 'pong', t: 2 });
    vi.advanceTimersByTime(50);
    expect(atClient).toEqual([]);

    pair.host.send(ping(3)); // still down
    pair.restore();
    vi.advanceTimersByTime(50);
    expect(atClient).toEqual([]); // nothing from before the restore resurfaces

    pair.host.send(ping(4));
    pair.client.send({ type: 'pong', t: 4 });
    vi.advanceTimersByTime(10);
    expect(atClient).toEqual([ping(4)]);
    expect(atHost).toEqual([{ type: 'pong', t: 4 }]);
  });

  it('a message in flight across a drop and restore is still lost', () => {
    const pair = createLocalPair({ latencyMs: 20 });
    const atClient = collect(pair.client);
    pair.host.send(ping(1));
    pair.drop();
    pair.restore();
    vi.advanceTimersByTime(100);
    expect(atClient).toEqual([]);
  });

  it.each(['host', 'client'] as const)('close() on the %s end closes both for good', (end) => {
    const pair = createLocalPair();
    const hostSeen = statuses(pair.host);
    const clientSeen = statuses(pair.client);
    const atClient = collect(pair.client);
    const atHost = collect(pair.host);
    pair.host.send(ping(1)); // in flight

    pair[end].close();
    expect(pair.host.status).toBe('closed');
    expect(pair.client.status).toBe('closed');
    expect(hostSeen).toEqual(['open', 'closed']);
    expect(clientSeen).toEqual(['open', 'closed']);

    pair.restore(); // no way back
    pair.drop();
    pair.host.send(ping(2));
    pair.client.send(ping(3));
    pair[end].close(); // closing twice is harmless
    vi.advanceTimersByTime(100);
    expect(pair.host.status).toBe('closed');
    expect(hostSeen).toEqual(['open', 'closed']);
    expect(atClient).toEqual([]);
    expect(atHost).toEqual([]);

    const late: TransportStatus[] = [];
    pair.client.onStatus((s) => late.push(s));
    expect(late).toEqual(['closed']);
  });

  it('unsubscribe functions stop further calls', () => {
    const pair = createLocalPair();
    const messages: Msg[] = [];
    const seen: TransportStatus[] = [];
    const offMessage = pair.client.onMessage((m) => messages.push(m));
    const offStatus = pair.client.onStatus((s) => seen.push(s));

    pair.host.send(ping(1));
    flush();
    offMessage();
    offMessage(); // twice is harmless
    pair.host.send(ping(2));
    flush();
    expect(messages).toEqual([ping(1)]);

    offStatus();
    pair.drop();
    expect(seen).toEqual(['open']);
  });

  it('supports several listeners; one that throws does not stop the others', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pair = createLocalPair();
    const first: Msg[] = [];
    const last: Msg[] = [];
    pair.client.onMessage((m) => first.push(m));
    pair.client.onMessage(() => {
      throw new Error('listener bug');
    });
    pair.client.onMessage((m) => last.push(m));
    const firstStatus: TransportStatus[] = [];
    const lastStatus: TransportStatus[] = [];
    pair.client.onStatus((s) => firstStatus.push(s));
    pair.client.onStatus(() => {
      throw new Error('status listener bug');
    }); // throws during the immediate call too, and onStatus itself must not throw
    pair.client.onStatus((s) => lastStatus.push(s));

    pair.host.send(ping(1));
    pair.host.send(ping(2));
    flush();
    pair.drop();

    expect(first).toEqual([ping(1), ping(2)]);
    expect(last).toEqual([ping(1), ping(2)]);
    expect(firstStatus).toEqual(['open', 'closed']);
    expect(lastStatus).toEqual(['open', 'closed']);
    expect(error).toHaveBeenCalled();
  });

  it('treats each subscription separately, and skips listeners removed mid-delivery', () => {
    const pair = createLocalPair();
    const calls: string[] = [];
    const twice = (): void => {
      calls.push('twice');
    };
    const offA = pair.client.onMessage(twice);
    pair.client.onMessage(twice);
    let offC = (): void => {};
    pair.client.onMessage(() => {
      calls.push('remover');
      offC();
    });
    offC = pair.client.onMessage(() => calls.push('removed'));

    pair.host.send(ping(1));
    flush();
    expect(calls).toEqual(['twice', 'twice', 'remover']);

    offA(); // removes one of the two subscriptions of `twice`
    calls.length = 0;
    pair.host.send(ping(2));
    flush();
    expect(calls).toEqual(['twice', 'remover']);
  });

  it('a status listener that closes the transport still hears the close', () => {
    const pair = createLocalPair();
    const seen: TransportStatus[] = [];
    pair.host.onStatus((s) => {
      seen.push(s);
      if (s === 'open') pair.host.close();
    });
    expect(seen).toEqual(['open', 'closed']);
    expect(pair.client.status).toBe('closed');
  });

  it('pairs are independent', () => {
    const a = createLocalPair();
    const b = createLocalPair();
    const atB = collect(b.client);
    a.host.send(ping(1));
    a.drop();
    flush();
    expect(atB).toEqual([]);
    expect(b.host.status).toBe('open');
  });
});
