// Signals (spec §9). SCAFFOLD: aspectOf's signature is final; the signals agent implements it and
// adds passing detection, restrictions and fines.

import type { Aspect, GameState, RunDef } from './types';

/** What a signal shows right now (spec §9.2). */
export function aspectOf(_state: GameState, _run: RunDef, _signalId: string): Aspect {
  return 'clear';
}
