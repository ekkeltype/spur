// Colour tokens (spec §18.1). Frontier desert, iron and brass; one accent per meaning:
// red = stop or danger, yellow = caution, green = clear, brass = controls.

export const PALETTE = {
  sand: '#D9B77E',
  canyon: '#B5563A',
  mesa: '#8E4A33',
  sage: '#8A9A6B',
  iron: '#2B2B2E',
  brass: '#C8A15A',
  paper: '#EFE6D2',
  ink: '#2A2118',
  night: '#0E1428',
  signalRed: '#E0442E',
  signalYellow: '#F2B632',
  signalGreen: '#5BC46B',
  lunar: '#DDE6F0',
  smoke: '#D8D2C8',
  steam: '#F4F1EA',
  blood: '#9E2B1E',
  coal: '#1C1A1A',
  rust: '#7A3B22',
  shadow: '#3A2A20',
} as const;

/** Sky gradients, top → horizon. */
export const SKIES = {
  dawn: ['#8FB3D9', '#F6C9A0'],
  day: ['#9CC7E8', '#F2DDB0'],
  dusk: ['#2E3A59', '#F28C4B'],
  night: ['#0B1026', '#1F2A44'],
} as const;

/** Signal lamp colours by aspect colour name. */
export const LAMP = {
  red: PALETTE.signalRed,
  yellow: PALETTE.signalYellow,
  green: PALETTE.signalGreen,
} as const;

/** Mixes a hex colour toward black by (1 − k); k = 1 keeps the colour. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * k);
  const g = Math.round(((n >> 8) & 255) * k);
  const b = Math.round((n & 255) * k);
  return `rgb(${r},${g},${b})`;
}

/** Hex colour with alpha, as an rgba() string. */
export function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Linear mix of two hex colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const na = parseInt(a.slice(1), 16);
  const nb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => Math.round(((na >> shift) & 255) * (1 - t) + ((nb >> shift) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
