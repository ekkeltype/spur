// The Rider's camera (spec §18.2): about 19 m of height visible, the rail tops at 76 % of the
// height, following the Rider horizontally. World coordinates are the train frame (spec §6.1):
// x in metres along the train (the loco on the right), y in metres above the rail tops.
//
// The mapping is a pure scale and offset, so it inverts exactly: the app aims with worldX/worldY
// of the camera last drawn (RiderRenderer.toTrainFrame), shake and zoom included, so the point
// under the cursor is the point the player sees there.
//
// The lookout (round 2): a Rider standing on the cab roof or the tender top and looking ahead gets
// a longer lead and, when the view is too narrow for it, a gentle zoom out, so the view reaches
// past the loco's front far enough to see a signal the train is waiting at without the spyglass.

export const VIEW_HEIGHT_M = 19;
export const RAIL_FRACTION = 0.76;

/** The lookout's view reaches this far past the loco's front (m)… */
export const LOOKOUT_REACH = 27;
/** …keeping the Rider at least this far inside the view's left edge (m)… */
export const LOOKOUT_MARGIN = 3;
/** …zooming out to show at most this much more of the world than the usual 19 m of height. */
export const LOOKOUT_ZOOM_MAX = 1.4;

export interface Camera {
  /** Train-frame x at the centre of the view (m). */
  x: number;
  /** CSS px per metre. */
  k: number;
  /** How much more of the world than usual the view shows (1 = VIEW_HEIGHT_M of height). */
  zoom: number;
  /** View size, CSS px. */
  w: number;
  h: number;
  /** Screen y of the rail tops without shake (CSS px). */
  railY: number;
  /** Screen shake offset (CSS px). */
  shakeX: number;
  shakeY: number;
}

export function makeCamera(w: number, h: number, x: number, shakeX = 0, shakeY = 0, zoom = 1): Camera {
  const cam: Camera = { x: 0, k: 1, zoom: 1, w: 1, h: 1, railY: 0, shakeX: 0, shakeY: 0 };
  placeCamera(cam, w, h, x, shakeX, shakeY, zoom);
  return cam;
}

/** Updates a camera in place (no allocation per frame). `zoom` above 1 shows more of the world. */
export function placeCamera(cam: Camera, w: number, h: number, x: number, shakeX: number, shakeY: number, zoom = 1): void {
  cam.w = Math.max(1, w);
  cam.h = Math.max(1, h);
  cam.zoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  cam.k = cam.h / (VIEW_HEIGHT_M * cam.zoom);
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
 * The lookout's zoom for a Rider at `riderX` on a train `length` long, in a view `aspect` wide
 * (width over height): just enough (1..LOOKOUT_ZOOM_MAX) for the view to reach LOOKOUT_REACH past
 * the loco's front with the Rider LOOKOUT_MARGIN inside its left edge.
 */
export function lookoutZoom(riderX: number, length: number, aspect: number): number {
  const need = length + LOOKOUT_REACH - (riderX - LOOKOUT_MARGIN);
  const z = need / (VIEW_HEIGHT_M * Math.max(0.1, aspect));
  return Math.min(LOOKOUT_ZOOM_MAX, Math.max(1, Number.isFinite(z) ? z : 1));
}

/**
 * The lookout's camera centre at `zoom`: as far ahead as reaching LOOKOUT_REACH past the front
 * needs, but never so far that the Rider comes closer than LOOKOUT_MARGIN to the left edge.
 */
export function lookoutCentre(riderX: number, length: number, aspect: number, zoom: number): number {
  const half = (VIEW_HEIGHT_M * zoom * Math.max(0.1, aspect)) / 2;
  return Math.min(length + LOOKOUT_REACH - half, riderX - LOOKOUT_MARGIN + half);
}

/**
 * Frame-rate independent exponential easing: where `cur` gets to after `dt` seconds heading for
 * `target` with time constant `tau` (seconds). tau ≤ 0 jumps straight to the target.
 */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (cur - target) * Math.exp(-Math.max(0, dt) / tau);
}
