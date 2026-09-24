// The Rider's camera (spec §18.2): about 19 m of height visible, the rail tops at 76 % of the
// height, following the Rider horizontally. World coordinates are the train frame (spec §6.1):
// x in metres along the train (the loco on the right), y in metres above the rail tops.
//
// The mapping is a pure scale and offset, so it inverts exactly: the app aims with worldX/worldY
// of the camera last drawn (RiderRenderer.toTrainFrame), shake included, so the point under the
// cursor is the point the player sees there.

export const VIEW_HEIGHT_M = 19;
export const RAIL_FRACTION = 0.76;

export interface Camera {
  /** Train-frame x at the centre of the view (m). */
  x: number;
  /** CSS px per metre. */
  k: number;
  /** View size, CSS px. */
  w: number;
  h: number;
  /** Screen y of the rail tops without shake (CSS px). */
  railY: number;
  /** Screen shake offset (CSS px). */
  shakeX: number;
  shakeY: number;
}

export function makeCamera(w: number, h: number, x: number, shakeX = 0, shakeY = 0): Camera {
  const cam: Camera = { x: 0, k: 1, w: 1, h: 1, railY: 0, shakeX: 0, shakeY: 0 };
  placeCamera(cam, w, h, x, shakeX, shakeY);
  return cam;
}

/** Updates a camera in place (no allocation per frame). */
export function placeCamera(cam: Camera, w: number, h: number, x: number, shakeX: number, shakeY: number): void {
  cam.w = Math.max(1, w);
  cam.h = Math.max(1, h);
  cam.k = cam.h / VIEW_HEIGHT_M;
  cam.railY = cam.h * RAIL_FRACTION;
  cam.x = x;
  cam.shakeX = shakeX;
  cam.shakeY = shakeY;
}

export function screenX(cam: Camera, x: number): number {
  return cam.w / 2 + (x - cam.x) * cam.k + cam.shakeX;
}

export function screenY(cam: Camera, y: number): number {
  return cam.railY - y * cam.k + cam.shakeY;
}

export function worldX(cam: Camera, px: number): number {
  return cam.x + (px - cam.w / 2 - cam.shakeX) / cam.k;
}

export function worldY(cam: Camera, py: number): number {
  return (cam.railY + cam.shakeY - py) / cam.k;
}

/** Half the view's width in metres. */
export function halfWidthM(cam: Camera): number {
  return cam.w / (2 * cam.k);
}

/**
 * Frame-rate independent exponential easing: where `cur` gets to after `dt` seconds heading for
 * `target` with time constant `tau` (seconds). tau ≤ 0 jumps straight to the target.
 */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-Math.max(0, dt) / tau);
}
