// The transport abstraction (spec §14.2). Everything above it is identical for
// the in-memory pair (local test mode, tests) and PeerJS (online play).

import type { Msg } from './protocol';

export type TransportStatus = 'connecting' | 'open' | 'closed';

export interface Transport {
  /** Sends a message. Silently dropped while the transport is not open. */
  send(msg: Msg): void;
  /** Registers a message listener. Returns a function that removes it. */
  onMessage(cb: (msg: Msg) => void): () => void;
  /** Registers a status listener; it is called immediately with the current status. Returns an unsubscribe. */
  onStatus(cb: (s: TransportStatus) => void): () => void;
  /** Current status. */
  readonly status: TransportStatus;
  close(): void;
}
