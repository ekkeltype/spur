// The desk's log lines for the Engineer's events (spec §16.3). Pure: the desk supplies names.

import type { EngineerEvent, LossReason } from '../../sim/types';
import { formatDistance, formatMoney } from './format';

export type LogTone = 'info' | 'good' | 'warn' | 'danger' | 'telegram' | 'quiet';

export interface LogText {
  text: string;
  tone: LogTone;
  /** Lines with the same key close together merge into one ("×3") instead of flooding the log. */
  key?: string;
}

export interface LogContext {
  stationName(id: string): string;
  /** "Switch 3 (Mesa Loop W)" */
  switchLabel(id: string): string;
  tunnelName(id: string): string;
  /** "Salt Creek ford" */
  fordName(id: string): string;
  signalName(id: string): string;
  /** The contract's cargo, capitalised ("Payroll"). */
  cargo: string;
  /** For flagPlaced: metres from the loco's front to the flag, if it's ahead on the route. */
  flagDist: number | null;
}

export type FineReason = Extract<EngineerEvent, { type: 'fine' }>['reason'];

const FINE_TEXT: Record<FineReason, string> = {
  redSignal: 'passed a signal at stop',
  speeding: 'too fast after a yellow',
  junction: 'too fast through the junction',
};

/** What a fine was for (spec §9.3), as both seats read it: "Fined $10: too fast after a yellow". */
export function fineText(reason: FineReason): string {
  return FINE_TEXT[reason];
}

const RIDER_OFF_TEXT: Record<Extract<EngineerEvent, { type: 'riderOff' }>['cause'], string> = {
  tunnel: 'The Rider was knocked off in the tunnel',
  water: 'The Rider was washed off the train',
  fall: 'The Rider fell off the train',
};

const LOSS_TEXT: Record<LossReason, string> = {
  collision: 'Collision',
  derailed: 'Derailed',
  obstacle: 'Hit an obstacle on the line',
  boiler: 'The boiler exploded',
  lootStolen: 'The cargo was stolen',
  powder: 'The powder car blew up',
  trestle: 'The trestle collapsed',
  buffers: 'Hit the buffers',
};

export function lossText(reason: LossReason): string {
  return LOSS_TEXT[reason];
}

export function describeEvent(e: EngineerEvent, c: LogContext): LogText | null {
  switch (e.type) {
    case 'switchThrown':
      return e.by === 'engineer'
        ? { text: `${c.switchLabel(e.junction)} set to ${e.state}`, tone: 'info' }
        : { text: `${c.switchLabel(e.junction)} sprung to ${e.state} by the train`, tone: 'warn' };
    case 'whistle':
      return e.on ? { text: 'Whistle', tone: 'quiet', key: 'whistle' } : null;
    case 'overspeed':
      return e.level === 2
        ? { text: 'Far over the limit: she’ll derail!', tone: 'danger', key: 'overspeed2' }
        : { text: 'Over the speed limit: the wheels are squealing', tone: 'warn', key: 'overspeed1' };
    case 'safetyValve':
      return e.on ? { text: 'Safety valve lifting: steam to spare', tone: 'quiet', key: 'valve' } : null;
    case 'lowWater':
      return { text: 'Low water in the tender', tone: 'warn', key: 'lowWater' };
    case 'stationArrived':
      return { text: `Standing at ${c.stationName(e.stationId)}`, tone: 'info' };
    case 'stationDone':
      return { text: `${c.stationName(e.stationId)}: station work done`, tone: 'good' };
    case 'checkpoint':
      return { text: `Checkpoint saved at ${c.stationName(e.stationId)}`, tone: 'good' };
    case 'spout':
      return e.down ? { text: 'Spout down: taking water', tone: 'good' } : { text: 'Spout up', tone: 'quiet' };
    case 'waterFull':
      return { text: 'Tender full', tone: 'good' };
    case 'tunnelEnter':
      return { text: `Into ${c.tunnelName(e.id)}`, tone: 'quiet' };
    case 'tunnelExit':
      return { text: `Out of ${c.tunnelName(e.id)}`, tone: 'quiet' };
    case 'fordEnter':
      return { text: `Into the water at ${c.fordName(e.id)}`, tone: 'quiet' };
    case 'fordExit':
      return { text: 'Out of the water', tone: 'quiet' };
    case 'signalPassed':
      return { text: `Passed ${c.signalName(e.id)}`, tone: 'quiet' };
    case 'fine':
      return { text: `Fined ${formatMoney(e.amount)}: ${fineText(e.reason)}`, tone: 'danger' };
    case 'telegram':
      return { text: e.text, tone: 'telegram' };
    case 'sideJob':
      return e.state === 'aboard' ? { text: 'Passengers aboard', tone: 'good' } : { text: 'Side job delivered', tone: 'good' };
    case 'flagPlaced':
      return {
        text: c.flagDist !== null ? `The Rider flagged the line ${formatDistance(c.flagDist)} ahead` : 'The Rider placed a flag',
        tone: 'warn',
      };
    case 'heldUp':
      return { text: 'Hands up! A bandit has a gun on you', tone: 'danger' };
    case 'holdupEnded':
      return { text: 'The cab is clear: hands down', tone: 'good' };
    case 'gunfire':
      return { text: 'Gunfire outside', tone: 'quiet', key: 'gunfire' };
    case 'riderOff':
      return { text: RIDER_OFF_TEXT[e.cause], tone: 'danger' };
    case 'riderDown':
      return { text: 'The Rider is down', tone: 'danger' };
    case 'riderBack':
      return { text: 'The Rider is back aboard', tone: 'good' };
    case 'lootStolen':
      return { text: `The ${c.cargo.toLowerCase()} was stolen!`, tone: 'danger' };
    case 'lootRecovered':
      return { text: `The ${c.cargo.toLowerCase()} is back in the safe`, tone: 'good' };
    case 'collision':
      return { text: 'Collision!', tone: 'danger' };
    case 'won':
      return { text: 'Arrived: contract complete', tone: 'good' };
    case 'lost':
      return { text: lossText(e.reason), tone: 'danger' };
  }
}
