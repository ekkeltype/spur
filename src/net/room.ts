// Pure helpers for online rooms (spec §14.3): room codes, PeerJS ids and PeerJS options.
// This module never loads PeerJS at runtime (type imports only), so tests can use it in Node.
// peer.ts re-exports everything here.

import type { PeerOptions } from 'peerjs';

/** Room code characters. I, O, 0 and 1 are left out so a code can't be misread off a screen. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;

const PEER_ID_PREFIX = 'spur-';

/**
 * A fresh room code: ROOM_CODE_LENGTH characters from ROOM_ALPHABET.
 * `rand` returns numbers in [0, 1) like Math.random (injectable for tests).
 */
export function makeRoomCode(rand: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const r = rand();
    const index = Number.isFinite(r) ? Math.floor(r * ROOM_ALPHABET.length) : 0;
    code += ROOM_ALPHABET[Math.min(ROOM_ALPHABET.length - 1, Math.max(0, index))];
  }
  return code;
}

// Whitespace plus the dash look-alikes that phones and word processors like to substitute.
const SEPARATORS = /[\s\-‐-―−]/g;

/**
 * Turns whatever the Engineer typed into a room code, or '' if it can't be one.
 *
 * Case, spaces and dashes are ignored ("ab-c de" → "ABCDE"), and full-width characters count as
 * their ASCII twins. There is deliberately no look-alike substitution: I, O, 0 and 1 never appear
 * in a code, so there's no single right answer for which letter someone meant by them, and
 * guessing could quietly send them to a stranger's room. They make the code invalid instead.
 */
export function normalizeRoomCode(input: string): string {
  if (typeof input !== 'string') return '';
  const code = input.normalize('NFKC').toUpperCase().replace(SEPARATORS, '');
  if (code.length !== ROOM_CODE_LENGTH) return '';
  for (const ch of code) {
    if (!ROOM_ALPHABET.includes(ch)) return '';
  }
  return code;
}

/** The PeerJS id the Rider's browser registers for a room. */
export function peerIdFor(code: string): string {
  return `${PEER_ID_PREFIX}${code}`;
}

/**
 * PeerJS 1.5.5's built-in ICE servers (`util.defaultConfig.iceServers`): Google's public STUN
 * server and PeerJS's public TURN relay. Copied so VITE_TURN_URL can add a TURN server on top of
 * the defaults instead of replacing them. tests/room.test.ts checks the copy against PeerJS.
 */
export const PEERJS_DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

type Env = Readonly<Record<string, unknown>>;

/**
 * PeerJS options from Vite env variables (docs/networking.md lists them all). Anything unset keeps
 * PeerJS's default: the public PeerJS server (0.peerjs.com) and the ICE servers above.
 *
 * - VITE_PEER_HOST, VITE_PEER_PORT, VITE_PEER_PATH, VITE_PEER_SECURE, VITE_PEER_KEY: a self-hosted PeerServer.
 * - VITE_ICE_SERVERS: a JSON array of RTCIceServer that replaces the ICE server list.
 * - VITE_TURN_URL (comma-separated URLs allowed), VITE_TURN_USERNAME, VITE_TURN_CREDENTIAL:
 *   one TURN server added to the list (the defaults, or VITE_ICE_SERVERS).
 * - VITE_ICE_TRANSPORT_POLICY: 'relay' forces every connection through TURN (to test a TURN setup).
 * - VITE_PEER_DEBUG: PeerJS log level, 0 (silent) to 3 (everything).
 *
 * Invalid values are ignored with a console warning. `env` is injectable for tests.
 */
export function peerOptionsFromEnv(env: Env = viteEnv()): PeerOptions {
  const options: PeerOptions = {};
  const host = readString(env, 'VITE_PEER_HOST');
  if (host !== undefined) options.host = host;
  const port = readInt(env, 'VITE_PEER_PORT', 1, 65535);
  if (port !== undefined) options.port = port;
  const path = readString(env, 'VITE_PEER_PATH');
  if (path !== undefined) options.path = path;
  const secure = readBool(env, 'VITE_PEER_SECURE');
  if (secure !== undefined) options.secure = secure;
  const key = readString(env, 'VITE_PEER_KEY');
  if (key !== undefined) options.key = key;
  const debug = readInt(env, 'VITE_PEER_DEBUG', 0, 3);
  if (debug !== undefined) options.debug = debug;

  const iceServers = iceServersFromEnv(env);
  const policy = readTransportPolicy(env);
  if (iceServers || policy) {
    const config: RTCConfiguration = { iceServers: iceServers ?? copyIceServers(PEERJS_DEFAULT_ICE_SERVERS) };
    if (policy) config.iceTransportPolicy = policy;
    options.config = config;
  }
  return options;
}

function viteEnv(): Env {
  // import.meta.env only exists under Vite and Vitest.
  return (import.meta.env as Env | undefined) ?? {};
}

function iceServersFromEnv(env: Env): RTCIceServer[] | undefined {
  let servers: RTCIceServer[] | undefined;
  const json = readString(env, 'VITE_ICE_SERVERS');
  if (json !== undefined) servers = parseIceServers(json);

  const turnUrls = (readString(env, 'VITE_TURN_URL') ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url !== '');
  if (turnUrls.length > 0) {
    const turn: RTCIceServer = { urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls };
    const username = readString(env, 'VITE_TURN_USERNAME');
    if (username !== undefined) turn.username = username;
    const credential = readString(env, 'VITE_TURN_CREDENTIAL');
    if (credential !== undefined) turn.credential = credential;
    servers = [...(servers ?? copyIceServers(PEERJS_DEFAULT_ICE_SERVERS)), turn];
  }
  return servers;
}

function parseIceServers(json: string): RTCIceServer[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    warnInvalid('VITE_ICE_SERVERS', 'it is not valid JSON');
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const servers: RTCIceServer[] = [];
  for (const entry of list) {
    const server = toIceServer(entry);
    if (!server) {
      warnInvalid('VITE_ICE_SERVERS', 'every entry needs "urls" (a string or an array of strings)');
      return undefined;
    }
    servers.push(server);
  }
  if (servers.length === 0) {
    warnInvalid('VITE_ICE_SERVERS', 'the list is empty');
    return undefined;
  }
  return servers;
}

function toIceServer(entry: unknown): RTCIceServer | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { urls, username, credential } = entry as Record<string, unknown>;
  const urlsOk =
    (typeof urls === 'string' && urls !== '') ||
    (Array.isArray(urls) && urls.length > 0 && urls.every((u) => typeof u === 'string' && u !== ''));
  if (!urlsOk) return null;
  const server: RTCIceServer = { urls: urls as string | string[] };
  if (typeof username === 'string') server.username = username;
  if (typeof credential === 'string') server.credential = credential;
  return server;
}

function copyIceServers(servers: readonly RTCIceServer[]): RTCIceServer[] {
  return servers.map((s) => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }));
}

function readString(env: Env, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function readInt(env: Env, name: string, min: number, max: number): number | undefined {
  const text = readString(env, name);
  if (text === undefined) return undefined;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) {
    warnInvalid(name, `expected a whole number from ${min} to ${max}`);
    return undefined;
  }
  return n;
}

function readBool(env: Env, name: string): boolean | undefined {
  const text = readString(env, name)?.toLowerCase();
  if (text === undefined) return undefined;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  warnInvalid(name, 'expected true or false');
  return undefined;
}

function readTransportPolicy(env: Env): RTCIceTransportPolicy | undefined {
  const text = readString(env, 'VITE_ICE_TRANSPORT_POLICY')?.toLowerCase();
  if (text === undefined) return undefined;
  if (text === 'all' || text === 'relay') return text;
  warnInvalid('VITE_ICE_TRANSPORT_POLICY', 'expected "all" or "relay"');
  return undefined;
}

function warnInvalid(name: string, why: string): void {
  console.warn(`[spur] Ignoring ${name}: ${why}. Using the PeerJS default instead.`);
}
