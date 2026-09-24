// Network messages (spec §16.2). The Engineer's browser only ever receives the EngineerRun, the
// Engineer view, filtered events, acks and screen-flow messages. Nothing here may carry the seed:
// it picks the run's variant, which is hidden from the Engineer (spec §2).

import type {
  Act,
  Aspect,
  Assists,
  CampaignProgress,
  Cargo,
  CarType,
  EngineerCmd,
  EngineerEvent,
  EngineerRun,
  EngineerView,
  Medal,
  RunResult,
  UpgradeId,
} from '../sim/types';

export const PROTOCOL_VERSION = 1;

export type Role = 'rider' | 'engineer';

/**
 * One line of the lobby's run list: the run's public facts plus the campaign's record of it. The
 * host builds these, so the Engineer's lobby never needs the full RunDefs (and can't disagree with
 * the host about them).
 */
export interface RunCard {
  id: string;
  /** 0-based position in the campaign. */
  index: number;
  act: Act;
  name: string;
  flavor: string;
  night: boolean;
  /** Clock at the start (s since midnight). */
  startClock: number;
  originName: string;
  destinationName: string;
  contract: {
    cargo: Cargo;
    title: string;
    pay: number;
    /** Clock (s since midnight). */
    deadline: number;
    latePenaltyPerMin: number;
    critical: boolean;
  };
  sideJobs: { title: string; pay: number; needs: CarType }[];
  requiredCars: CarType[];
  maxCars: number;
  /** Seconds. */
  par: number;
  unlocked: boolean;
  /** Times won, best time (s) and medals so far. */
  times: number;
  best: number | null;
  medals: Medal[];
}

/** Everything the lobby and depot screens show (spec §3), besides the run list. */
export interface LobbyState {
  campaign: CampaignProgress;
  /** 0-based run index. */
  selectedRun: number;
  /** The full consist for the selected run: required cars plus the chosen optional ones, front to back. */
  consist: CarType[];
  hostReady: boolean;
  clientReady: boolean;
  /** A saved checkpoint the Rider can continue from. */
  checkpoint: { runId: string; runName: string; stationName: string } | null;
}

/** Lobby actions either player can take (the Engineer sends them as `depot` messages). */
export type DepotAction =
  | { kind: 'selectRun'; index: number }
  | { kind: 'toggleCar'; car: CarType }
  | { kind: 'buy'; item: UpgradeId }
  | { kind: 'assist'; seat: 'rider' | 'engineer'; on: boolean };

/** What a finished run paid (spec §12), as the results screen shows it. */
export interface Payout {
  won: boolean;
  pay: number;
  latePenalty: number;
  sideJobPay: number;
  fines: number;
  /** pay − latePenalty (never below 0) + sideJobPay − fines. */
  subtotal: number;
  /** The run had been won before: it pays REPLAY_PAY_FACTOR of a positive subtotal. */
  replay: boolean;
  replayDiscount: number;
  /** What the campaign's money changed by (never takes it below 0). */
  total: number;
}

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
  /** The lobby, and the run list with the campaign's record of each run (always sent by the host; a client keeps its last list if it's missing). */
  | { type: 'lobby'; lobby: LobbyState; runs?: RunCard[] }
  | { type: 'depot'; action: DepotAction }
  /** The host couldn't apply a depot action (from either player); shown to the Engineer. */
  | { type: 'depotRefused'; reason: string }
  | {
      type: 'start';
      run: EngineerRun;
      consist: CarType[];
      upgrades: UpgradeId[];
      assists: Assists;
      /** The run was won before, so it pays less (spec §12). */
      replay: boolean;
      /** A reconnect: the game is under way (or over), not a new briefing. */
      resume: boolean;
      /** The station name when the game continues from a checkpoint. */
      fromCheckpoint: string | null;
    }
  | { type: 'snapshot'; view: EngineerView }
  | { type: 'event'; event: EngineerEvent }
  | { type: 'cmd'; cmd: EngineerCmd }
  | { type: 'ack'; seq: number; ok: boolean; reason?: string }
  | { type: 'pause'; by: Role; reason?: 'disconnect' }
  | { type: 'countdown'; seconds: number }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'result'; result: RunResult; payout: Payout; campaign: CampaignProgress; checkpointName: string | null }
  | { type: 'debug'; info: DebugInfo };

export type MsgType = Msg['type'];

/** Type guard for messages arriving from the wire. */
export function isMsg(x: unknown): x is Msg {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}
