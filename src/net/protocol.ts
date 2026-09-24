// Network messages (spec §16.2). The Engineer's browser only ever receives the EngineerRun, the
// Engineer view, filtered events, acks and screen-flow messages.

import type {
  Aspect,
  CampaignProgress,
  CarType,
  EngineerCmd,
  EngineerEvent,
  EngineerRun,
  EngineerView,
  RunResult,
  UpgradeId,
} from '../sim/types';

export const PROTOCOL_VERSION = 1;

export type Role = 'rider' | 'engineer';

/** Everything the lobby and depot screens show (spec §3). */
export interface LobbyState {
  campaign: CampaignProgress;
  /** 0-based run index. */
  selectedRun: number;
  /** The full consist for the selected run: required cars plus the chosen optional ones, front to back. */
  consist: CarType[];
  hostReady: boolean;
  clientReady: boolean;
  /** A saved checkpoint the Rider can continue from. */
  checkpoint: { runId: string; stationName: string } | null;
}

/** Lobby actions either player can take (the Engineer sends them as `depot` messages). */
export type DepotAction =
  | { kind: 'selectRun'; index: number }
  | { kind: 'toggleCar'; car: CarType }
  | { kind: 'buy'; item: UpgradeId }
  | { kind: 'assist'; seat: 'rider' | 'engineer'; on: boolean };

/** Dev-only extras for the ?debug=1 overlay. Never sent in production builds. */
export interface DebugInfo {
  obstacles: { id: string; edge: string; at: number; kind: string; state: string }[];
  aspects: Record<string, Aspect>;
  bandits: number;
  horsemen: number;
}

export type Msg =
  | { type: 'hello'; protocol: number }
  | { type: 'welcome'; protocol: number }
  | { type: 'reject'; reason: string }
  | { type: 'ready'; ready: boolean }
  | { type: 'lobby'; lobby: LobbyState }
  | { type: 'depot'; action: DepotAction }
  | { type: 'start'; run: EngineerRun; consist: CarType[]; upgrades: UpgradeId[]; resume: boolean; fromCheckpoint: string | null }
  | { type: 'snapshot'; view: EngineerView }
  | { type: 'event'; event: EngineerEvent }
  | { type: 'cmd'; cmd: EngineerCmd }
  | { type: 'ack'; seq: number; ok: boolean; reason?: string }
  | { type: 'pause'; by: Role; reason?: 'disconnect' }
  | { type: 'countdown'; seconds: number }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'result'; result: RunResult; campaign: CampaignProgress; checkpointName: string | null }
  | { type: 'debug'; info: DebugInfo };

export type MsgType = Msg['type'];

/** Type guard for messages arriving from the wire. */
export function isMsg(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}
