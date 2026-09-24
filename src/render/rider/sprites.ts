// Small cached canvases: soft glows (added with 'lighter' for lamps, flashes and fire) and puffs
// (smoke, steam, dust). Drawing a cached radial sprite is far cheaper than building a gradient
// per light per frame.

export type Sprite = HTMLCanvasElement;

const glows = new Map<string, Sprite>();
const puffs = new Map<string, Sprite>();

function canvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } | null {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  return g ? { c, g } : null;
}

/** A radial glow: `rgb` (like '255,200,120') at full strength in the middle, fading to nothing. */
export function glowSprite(rgb: string): Sprite | null {
  let s = glows.get(rgb);
  if (s) return s;
  const size = 128;
  const made = canvas(size);
  if (!made) return null;
  const { c, g } = made;
  const h = size / 2;
  const grad = g.createRadialGradient(h, h, 0, h, h, h);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.18, `rgba(${rgb},0.62)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.2)`);
  grad.addColorStop(0.75, `rgba(${rgb},0.05)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  s = c;
  glows.set(rgb, s);
  return s;
}

/**
 * A soft, slightly lumpy puff of `rgb`, for smoke, steam and dust. `variant` picks one of a few
 * lump layouts so a trail of puffs doesn't look stamped.
 */
export function puffSprite(rgb: string, variant: number): Sprite | null {
  const key = `${rgb}|${variant & 3}`;
  let s = puffs.get(key);
  if (s) return s;
  const size = 96;
  const made = canvas(size);
  if (!made) return null;
  const { c, g } = made;
  const h = size / 2;
  const lumps = [
    [0, 0, 0.62],
    [-0.28, 0.12, 0.42],
    [0.3, 0.08, 0.44],
    [0.05, -0.26, 0.4],
    [-0.12, 0.3, 0.36],
  ];
  const v = variant & 3;
  for (let i = 0; i < lumps.length; i++) {
    const [lx, ly, lr] = lumps[i];
    const rot = v * 1.3;
    const x = h + (lx * Math.cos(rot) - ly * Math.sin(rot)) * h * 0.8;
    const y = h + (lx * Math.sin(rot) + ly * Math.cos(rot)) * h * 0.8;
    const r = lr * h * 0.8;
    const grad = g.createRadialGradient(x, y - r * 0.2, 0, x, y, r);
    grad.addColorStop(0, `rgba(${rgb},0.9)`);
    grad.addColorStop(0.55, `rgba(${rgb},0.55)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  s = c;
  puffs.set(key, s);
  return s;
}

/** Drops every cached sprite (the renderer is being destroyed). */
export function clearSprites(): void {
  glows.clear();
  puffs.clear();
}
