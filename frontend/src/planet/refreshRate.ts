/**
 * How often the marker sources are worth rebuilding.
 *
 * The frame loop used to rewrite every layer's GeoJSON on **every frame**, so
 * that interpolated positions moved smoothly between polls (D71). Measured at
 * zoom 7 with 2,000 vessels on screen, that cost:
 *
 * | | p50 | p90 | p99 |
 * |---|---|---|---|
 * | rebuilding every frame | 11.6 ms | 18.2 ms | **55.1 ms** |
 * | not rebuilding at all | 4.2 ms | 4.9 ms | 12.4 ms |
 *
 * So 7.4 ms of every frame at the median and 43 ms at the tail — the
 * difference between 86 fps and 238 fps, and the reason the p99 frame took
 * long enough to be seen as a stutter.
 *
 * ## Almost all of that work was invisible
 *
 * A rebuild is only worth doing if something *moved far enough to see*. At
 * zoom 7 one pixel is about 750 m, so a ship making 6 m/s crosses a pixel
 * **once every two minutes**. Rebuilding 2,000 features eighty-nine times a
 * second to animate that is not smoothness, it is arithmetic nobody can
 * perceive.
 *
 * Zoomed in the sum comes out differently, and that is the point: at zoom 14 a
 * pixel is about 6 m, so the same ship moves a pixel every second and an
 * aircraft moves one every 20 ms. The rate has to follow the view rather than
 * being a constant somebody picked.
 *
 * ## What this computes
 *
 * The interval in which the fastest thing on the layer travels half a pixel.
 * Half rather than one, because a marker that jumps a whole pixel at a time
 * reads as a stutter on a slow-moving object; half keeps the motion under the
 * threshold where the step itself becomes the thing you notice.
 *
 * It is a floor, not a schedule: a poll landing, a selection changing or the
 * layer switching all rebuild immediately, because those are not motion and
 * waiting on them would show as lag on a click.
 */

import type { ObjectType } from '../types';

/** Metres per pixel at the equator, zoom 0, in a 512 px tile scheme. */
const EQUATOR_METRES_PER_PIXEL = 156543.03392;

/**
 * The fastest thing each layer draws, in metres per second.
 *
 * Deliberately generous rather than typical: this decides how *often* to
 * redraw, so overestimating costs a few needless rebuilds and underestimating
 * makes the fastest object on screen visibly step. An airliner cruises at
 * about 250 m/s and this allows 350; a fast ferry does 30 m/s and this allows
 * 40.
 *
 * A satellite's sub-satellite point moves at about 7,000 m/s, which sounds
 * decisive and is not: that layer is drawn from computed positions rather than
 * interpolated ones, so it is included for completeness and to keep the table
 * total.
 */
const MAX_SPEED_MS: Record<ObjectType, number> = {
  aircraft: 350,
  satellite: 7800,
  ship: 40,
};

/** Never rebuild more often than the display can show. */
export const MIN_INTERVAL_MS = 16;

/**
 * Never wait longer than this, however slow the layer.
 *
 * At zoom 2 the half-pixel rule would allow a ship four minutes between
 * rebuilds, which is arithmetically true and wrong in practice: the store is
 * replaced every poll, and a cap keeps the picture demonstrably alive rather
 * than relying on nothing else ever needing a redraw.
 */
export const MAX_INTERVAL_MS = 1000;

/** Metres covered by one screen pixel at this zoom and latitude. */
export function metresPerPixel(zoom: number, latitude: number): number {
  const clamped = Math.max(-85, Math.min(85, latitude));
  return (
    (EQUATOR_METRES_PER_PIXEL * Math.cos((clamped * Math.PI) / 180)) / Math.pow(2, zoom)
  );
}

/**
 * The shortest interval worth rebuilding this layer at, in milliseconds.
 *
 * Returns `MIN_INTERVAL_MS` when zoomed far enough in that motion is visible
 * frame to frame, and grows as the view pulls back and the same motion stops
 * being resolvable.
 */
export function rebuildIntervalMs(
  layer: ObjectType,
  zoom: number,
  latitude: number,
): number {
  const speed = MAX_SPEED_MS[layer] ?? MAX_SPEED_MS.aircraft;
  const halfPixelMetres = metresPerPixel(zoom, latitude) / 2;
  const seconds = halfPixelMetres / speed;
  if (!Number.isFinite(seconds)) return MAX_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, seconds * 1000));
}
