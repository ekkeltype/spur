// What a lineside signal shows (spec §9.1): arm angles and lamp colours per aspect, top head
// first. The Rider reads these; the Engineer never sees them (spec §2).

import type { Aspect } from '../../sim/types';

export type LampColour = 'red' | 'yellow' | 'green';

export interface HeadLook {
  /** Degrees above horizontal: 0 = stop, 45 = caution, 90 = clear (upper-quadrant semaphore). */
  arm: 0 | 45 | 90;
  lamp: LampColour;
}

const STOP: HeadLook = { arm: 0, lamp: 'red' };
const CAUTION: HeadLook = { arm: 45, lamp: 'yellow' };
const CLEAR: HeadLook = { arm: 90, lamp: 'green' };

/**
 * The heads of a signal showing `aspect`, top first. A one-head (block) signal never shows the
 * diverging aspects (they're junction signals'); if asked, it shows the plain aspect with the same
 * speed meaning, so it never looks more permissive than the rule.
 */
export function signalHeads(aspect: Aspect, heads: 1 | 2): HeadLook[] {
  if (heads === 1) {
    switch (aspect) {
      case 'stop':
        return [{ ...STOP }];
      case 'approach':
      case 'divergeApproach':
        return [{ ...CAUTION }];
      default:
        return [{ ...CLEAR }];
    }
  }
  switch (aspect) {
    case 'stop':
      return [{ ...STOP }, { ...STOP }];
    case 'approach':
      return [{ ...CAUTION }, { ...STOP }];
    case 'clear':
      return [{ ...CLEAR }, { ...STOP }];
    case 'divergeApproach':
      return [{ ...STOP }, { ...CAUTION }];
    case 'divergeClear':
      return [{ ...STOP }, { ...CLEAR }];
  }
}

/** Lamp letters for colour-blind players (settings.lampLetters). */
export function lampLetter(c: LampColour): 'R' | 'Y' | 'G' {
  return c === 'red' ? 'R' : c === 'yellow' ? 'Y' : 'G';
}
