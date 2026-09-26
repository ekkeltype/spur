// Small line icons for the desk's DOM (the Ahead list, the log, the Rider card), as inline SVG so
// they stay crisp at any scale. 24×24 viewBox, drawn with currentColor.

import type { AheadKind } from './ahead';

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<AheadKind | 'rider' | 'telegram', string> = {
  // A portal in a hillside, the track running in.
  tunnel: svg('<path d="M2 20h20"/><path d="M5 20v-7a7 7 0 0 1 14 0v7"/><path d="M9 20v-6.5a3 3 0 0 1 6 0V20" fill="currentColor" fill-opacity=".35"/>'),
  // The river running over the rails.
  ford: svg('<path d="M3 19h18"/><path d="M6 17v4M12 17v4M18 17v4" stroke-width="1.5"/><path d="M2 9.5c2.5-2 4.5-2 7 0s4.5 2 7 0 4-2 6-.5"/><path d="M2 14c2.5-2 4.5-2 7 0s4.5 2 7 0 4-2 6-.5"/>'),
  // A beam across the line, low over the roofs.
  lowBridge: svg('<path d="M2 9h20"/><path d="M4 9v11M20 9v11"/><path d="M2 20h20"/><path d="M9 13.5h6" stroke-dasharray="1.5 2"/>'),
  // A timber trestle over a gorge.
  trestle: svg('<path d="M2 7h20"/><path d="M5 7l3 13M11 7l-3 13M13 7l3 13M19 7l-3 13"/><path d="M3 20h18"/>'),
  // A bend in the rails.
  curve: svg('<path d="M4 20c0-9 7-14 16-14"/><path d="M8 20c0-6 5-10 12-10"/>'),
  // A signal post with its head (never an aspect: the Engineer can't see them).
  signal: svg('<path d="M12 22V9"/><circle cx="12" cy="6" r="3.5"/><path d="M8 22h8"/>'),
  // A switch: one track dividing in two.
  junction: svg('<path d="M3 17h7"/><path d="M10 17h11"/><path d="M10 17c4 0 6-9 11-9"/><circle cx="10" cy="17" r="1.6" fill="currentColor"/>'),
  // A depot with its platform.
  station: svg('<path d="M3 11l9-6 9 6"/><path d="M5 10v8h14v-8"/><path d="M10 18v-4h4v4"/><path d="M2 21h20"/>'),
  // A water tank on legs with its spout.
  water: svg('<rect x="5" y="3" width="11" height="8" rx="2"/><path d="M7 11l-1 10M14 11l1 10M6.5 16h8"/><path d="M16 6h3v5"/><path d="M19 13.5c0 1-.6 1.6-1.2 1.6s-1.2-.6-1.2-1.6.6-1.6 1.2-2.6c.6 1 1.2 1.6 1.2 2.6z" fill="currentColor"/>'),
  // Buffers at the end of the track.
  end: svg('<path d="M2 16h12"/><path d="M14 9v10"/><path d="M14 12h4M14 16h4"/><path d="M18 10v8"/>'),
  // The Rider's pennant.
  flag: svg('<path d="M6 22V3"/><path d="M6 4l13 4.5L6 13z" fill="currentColor" fill-opacity=".85"/>'),
  // A figure (the Rider).
  rider: svg('<circle cx="12" cy="5" r="2.6"/><path d="M12 8v7M12 15l-3.5 6M12 15l3.5 6M7 11l5-1.5 5 1.5"/><path d="M8 3.2h8" stroke-width="1.4"/>'),
  // A telegraph key's paper tape.
  telegram: svg('<path d="M3 8h18v8H3z"/><path d="M6 12h2M10 12h1M13 12h3M18 12h1"/>'),
};
