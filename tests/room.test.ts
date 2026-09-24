import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PEERJS_DEFAULT_ICE_SERVERS,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  makeRoomCode,
  normalizeRoomCode,
  peerIdFor,
  peerOptionsFromEnv,
} from '../src/net/room';

const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/;

/** Deterministic numbers in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ROOM_ALPHABET', () => {
  it('has 32 distinct characters and none of the look-alikes I, O, 0, 1', () => {
    expect(ROOM_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
    expect(new Set(ROOM_ALPHABET).size).toBe(32);
    for (const ch of 'IO01') expect(ROOM_ALPHABET).not.toContain(ch);
    expect(ROOM_CODE_LENGTH).toBe(5);
  });
});

describe('makeRoomCode', () => {
  it('maps the injected random numbers onto the alphabet', () => {
    expect(makeRoomCode(() => 0)).toBe('AAAAA');
    expect(makeRoomCode(() => 0.999999)).toBe('99999');
    const values = [0, 8 / 32, 13 / 32, 23 / 32, 31 / 32];
    let i = 0;
    expect(makeRoomCode(() => values[i++])).toBe('AJPZ9');
  });

  it('stays inside the alphabet even for out-of-range random numbers', () => {
    expect(makeRoomCode(() => 1)).toBe('99999');
    expect(makeRoomCode(() => -0.5)).toBe('AAAAA');
    expect(makeRoomCode(() => Number.NaN)).toBe('AAAAA');
  });

  it('always makes 5 alphabet characters, and uses the whole alphabet', () => {
    const rand = lcg(42);
    const used = new Set<string>();
    for (let n = 0; n < 2000; n++) {
      const code = makeRoomCode(rand);
      expect(code).toMatch(CODE_PATTERN);
      for (const ch of code) used.add(ch);
    }
    expect(used.size).toBe(32);
  });

  it('uses Math.random by default', () => {
    for (let n = 0; n < 50; n++) expect(makeRoomCode()).toMatch(CODE_PATTERN);
  });

  it('produces codes that normalize to themselves', () => {
    const rand = lcg(7);
    for (let n = 0; n < 200; n++) {
      const code = makeRoomCode(rand);
      expect(normalizeRoomCode(code)).toBe(code);
    }
  });
});

describe('normalizeRoomCode', () => {
  it.each([
    ['ABCDE', 'ABCDE'],
    ['abcde', 'ABCDE'],
    ['  k7pqz ', 'K7PQZ'],
    ['K7P-QZ', 'K7PQZ'],
    ['k 7 p q z', 'K7PQZ'],
    ['K7P\tQZ\n', 'K7PQZ'],
    ['K7P–QZ', 'K7PQZ'], // en dash from autocorrect
    ['ＫＳ７ＰＱ', 'KS7PQ'], // full-width input
    ['2-3-4-5-6', '23456'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeRoomCode(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['    ', 'blank'],
    ['ABCD', 'too short'],
    ['ABCDEF', 'too long'],
    ['ABCD0', 'zero'],
    ['ABCDO', 'letter O'],
    ['ABCD1', 'one'],
    ['ABCDI', 'letter I'],
    ['abcdi', 'lowercase i'],
    ['AB_DE', 'underscore'],
    ['AB.DE', 'dot'],
    ['ÄBCDE', 'accented letter'],
    ['spur-ABCDE', 'a peer id'],
  ])('%j (%s) is invalid', (input) => {
    expect(normalizeRoomCode(input)).toBe('');
  });

  it('returns "" for non-strings instead of throwing', () => {
    expect(normalizeRoomCode(undefined as unknown as string)).toBe('');
    expect(normalizeRoomCode(12345 as unknown as string)).toBe('');
  });
});

describe('peerIdFor', () => {
  it('prefixes the code with spur-', () => {
    expect(peerIdFor('K7PQZ')).toBe('spur-K7PQZ');
  });

  it('makes ids PeerJS accepts', () => {
    // PeerJS's own id rule (util.validateId in PeerJS 1.5.5).
    const valid = /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/;
    const rand = lcg(3);
    for (let n = 0; n < 100; n++) expect(peerIdFor(makeRoomCode(rand))).toMatch(valid);
  });
});

describe('peerOptionsFromEnv', () => {
  it('keeps every PeerJS default when nothing is set', () => {
    expect(peerOptionsFromEnv({})).toEqual({});
    expect(peerOptionsFromEnv({ VITE_PEER_HOST: '  ', VITE_TURN_URL: '' })).toEqual({});
  });

  it('reads the default env without throwing', () => {
    expect(typeof peerOptionsFromEnv()).toBe('object');
  });

  it('points at a self-hosted PeerServer', () => {
    expect(
      peerOptionsFromEnv({
        VITE_PEER_HOST: 'peer.example.com',
        VITE_PEER_PORT: '9000',
        VITE_PEER_PATH: '/spur',
        VITE_PEER_SECURE: 'true',
        VITE_PEER_KEY: 'spurkey',
        VITE_PEER_DEBUG: '2',
      }),
    ).toEqual({ host: 'peer.example.com', port: 9000, path: '/spur', secure: true, key: 'spurkey', debug: 2 });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['false', false],
    ['0', false],
    ['off', false],
  ])('reads VITE_PEER_SECURE=%s as %s', (value, expected) => {
    expect(peerOptionsFromEnv({ VITE_PEER_SECURE: value }).secure).toBe(expected);
  });

  it('ignores invalid numbers and booleans with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      peerOptionsFromEnv({
        VITE_PEER_PORT: 'http',
        VITE_PEER_SECURE: 'maybe',
        VITE_PEER_DEBUG: '9',
        VITE_ICE_TRANSPORT_POLICY: 'tcp',
      }),
    ).toEqual({});
    expect(peerOptionsFromEnv({ VITE_PEER_PORT: '70000' })).toEqual({});
    expect(peerOptionsFromEnv({ VITE_PEER_PORT: '443.5' })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it('replaces the ICE servers with VITE_ICE_SERVERS', () => {
    const servers = [
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'p' },
    ];
    expect(peerOptionsFromEnv({ VITE_ICE_SERVERS: JSON.stringify(servers) })).toEqual({ config: { iceServers: servers } });
    // A single object is accepted too.
    expect(peerOptionsFromEnv({ VITE_ICE_SERVERS: '{"urls":"stun:a.example"}' })).toEqual({
      config: { iceServers: [{ urls: 'stun:a.example' }] },
    });
  });

  it.each([
    ['not JSON', '[{urls:'],
    ['no urls', '[{"username":"u"}]'],
    ['bad urls', '[{"urls":[1,2]}]'],
    ['empty list', '[]'],
    ['a string', '"stun:a.example"'],
  ])('ignores an invalid VITE_ICE_SERVERS (%s) with a warning', (_name, json) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(peerOptionsFromEnv({ VITE_ICE_SERVERS: json })).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('adds a TURN server to the PeerJS defaults', () => {
    const options = peerOptionsFromEnv({
      VITE_TURN_URL: 'turn:turn.example.com:3478',
      VITE_TURN_USERNAME: 'spur',
      VITE_TURN_CREDENTIAL: 's3cret',
    });
    expect(options).toEqual({
      config: {
        iceServers: [
          ...PEERJS_DEFAULT_ICE_SERVERS,
          { urls: 'turn:turn.example.com:3478', username: 'spur', credential: 's3cret' },
        ],
      },
    });
  });

  it('accepts several comma-separated TURN URLs, and adds TURN to VITE_ICE_SERVERS when both are set', () => {
    const options = peerOptionsFromEnv({
      VITE_ICE_SERVERS: '[{"urls":"stun:stun.example.com"}]',
      VITE_TURN_URL: 'turn:t.example.com:3478?transport=udp, turns:t.example.com:5349 ,',
      VITE_TURN_USERNAME: 'u',
    });
    expect(options.config).toEqual({
      iceServers: [
        { urls: 'stun:stun.example.com' },
        { urls: ['turn:t.example.com:3478?transport=udp', 'turns:t.example.com:5349'], username: 'u' },
      ],
    });
  });

  it('can force relayed connections, keeping the default servers', () => {
    expect(peerOptionsFromEnv({ VITE_ICE_TRANSPORT_POLICY: 'relay' })).toEqual({
      config: { iceServers: [...PEERJS_DEFAULT_ICE_SERVERS], iceTransportPolicy: 'relay' },
    });
  });

  it('never hands out the shared default list itself', () => {
    const options = peerOptionsFromEnv({ VITE_ICE_TRANSPORT_POLICY: 'all' });
    const servers = (options.config as RTCConfiguration).iceServers ?? [];
    expect(servers).toEqual(PEERJS_DEFAULT_ICE_SERVERS);
    expect(servers).not.toBe(PEERJS_DEFAULT_ICE_SERVERS);
    expect(servers[1]).not.toBe(PEERJS_DEFAULT_ICE_SERVERS[1]);
  });

  it("PEERJS_DEFAULT_ICE_SERVERS matches PeerJS's own defaults", async () => {
    const mod = (await import('peerjs')) as unknown as Record<string, unknown>;
    type Util = { defaultConfig: { iceServers: unknown } };
    const util = (mod.util ?? (mod.default as Record<string, unknown> | undefined)?.util) as Util | undefined;
    expect(util?.defaultConfig.iceServers).toEqual(PEERJS_DEFAULT_ICE_SERVERS);
  });
});
