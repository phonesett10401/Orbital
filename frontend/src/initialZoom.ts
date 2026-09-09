/**
 * The zoom that fits the whole planet in the viewport it is being drawn into.
 *
 * A constant zoom is a statement about how big the window is, and it was
 * written on a desktop. At 375 x 812 the globe is cropped on every side: the
 * first thing a phone shows is a piece of Asia, not a planet, and the one
 * gesture that would fix it - pinching out - is the gesture a new reader is
 * least likely to try (D180).
 *
 * MapLibre's globe draws the sphere at `512 * 2^zoom / PI` pixels across, the
 * same world size its mercator projection uses. That is not a guess: solving
 * it for the 800-pixel-tall window this application was built in returns 2.06,
 * and the zoom chosen there by eye was 2. The formula agrees with the value it
 * is replacing, which is the reason to trust it on a screen nobody tested.
 */

/**
 * How much of the shortest side the planet should occupy.
 *
 * Not 1. The globe needs to sit *in* the frame rather than touch it, and on a
 * phone the frame is not the viewport: a header sits over the top of the map
 * and a status bar over the bottom, so a globe that exactly fits the window is
 * a globe with its poles under the chrome.
 */
export const GLOBE_FIT = 0.85;

/**
 * The zoom this application has always opened at, and the ceiling here.
 *
 * Fitting is only ever allowed to pull the camera *back*. A large monitor
 * would otherwise open closer than 2 and change the view for every reader who
 * never had the problem this solves.
 */
export const DEFAULT_ZOOM = 2;

/** Pixels across the globe at zoom 0, from MapLibre's 512-pixel world. */
const GLOBE_AT_ZOOM_0 = 512 / Math.PI;

export function initialZoom(width: number, height: number): number {
  const shortest = Math.min(width, height);

  // A container measured before layout reports zero, and log2(0) is -Infinity -
  // a camera pushed out past the end of the universe rather than a slightly
  // wrong one. The default is the honest answer when the question is unanswerable.
  if (!Number.isFinite(shortest) || shortest <= 0) return DEFAULT_ZOOM;

  const fitted = Math.log2((shortest * GLOBE_FIT) / GLOBE_AT_ZOOM_0);
  return Math.min(DEFAULT_ZOOM, Math.round(fitted * 1000) / 1000);
}
