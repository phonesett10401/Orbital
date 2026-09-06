/**
 * The zoom band nobody is left sitting in (D158).
 *
 * ## The measurement this exists because of
 *
 * The handover at `SOLAR_MAX_ZOOM` is a single threshold, and that part is
 * right - D139 to D145 are six attempts at one symptom, and having *two*
 * thresholds was the cause of the last one. What the single threshold does not
 * fix is that the zooms either side of it are both poor views:
 *
 * - From `SOLAR_FULL_ZOOM` up to the handover, the solar system is fading and
 *   is mostly transparent.
 * - From the handover up to about zoom 0, the globe is drawn but tiny. Measured
 *   on a 1990-pixel viewport: **80 pixels wide at the handover, 85 just above
 *   it** - four per cent of the screen.
 *
 * So crossing the handover swapped a full scene for a coin on a black field,
 * and it was reported as "everything went black". It is also why it was never
 * seen here: the same 85-pixel globe is a tenth of an 800-pixel pane and reads
 * as a small globe rather than as nothing.
 *
 * ## Two states, not a continuum
 *
 * The fix is Phone's: the planet view and the solar system are **states**, and
 * the band between them is somewhere you pass through rather than somewhere you
 * stop. Come to rest inside it and the camera finishes the journey it was on.
 *
 * ## Decided when the gesture ends, never during it
 *
 * This runs on `moveend`. Snapping while somebody is still turning a wheel or
 * moving two fingers fights the input, and an interface that pulls against a
 * gesture in progress feels broken in a way that is hard to name. While you are
 * moving, the band renders exactly as it always did - the globe shrinks, the
 * planets fade up. It simply is not where you are left.
 *
 * ## Why it cannot oscillate
 *
 * Both targets are **outside** the band, so the move that settles you can never
 * land you somewhere that needs settling again. The geometry provides the
 * hysteresis; there is no separate constant to keep in step, which is the sort
 * of second number D144 removed.
 */

import { SOLAR_FULL_ZOOM } from './planet/solarSystemLayer';

/**
 * Where the solar system view rests: the planets at full opacity.
 *
 * The same number the layer reaches full opacity at, imported rather than
 * restated - a copy here that drifted would settle the camera at a zoom where
 * the system is still translucent, which is the fault this is fixing.
 */
export const SYSTEM_HOME = SOLAR_FULL_ZOOM;

/**
 * Where the planet view rests when you have zoomed out as far as it goes.
 *
 * Zoom 0, where the globe measures about 155 pixels on a wide screen. Not
 * generous, and deliberately not more: pushing it further would mean a longer
 * jump out of the band, and this is the point at which the globe is unambiguous
 * rather than the point at which it is impressive.
 */
export const PLANET_HOME = 0;

/** Half way, in zoom, which is the direction test. */
const MIDPOINT = (SYSTEM_HOME + PLANET_HOME) / 2;

/**
 * Where the camera should settle to, or null if it is already somewhere good.
 *
 * Null for everything outside the band, including the two homes themselves and
 * anything past them - zoomed right out to the apex of a trip, or right in on a
 * surface, are both fine places to be.
 *
 * **It follows the direction you were going, not the nearer edge.** The nearer
 * edge is wrong in a way that only shows up in use: from the solar system,
 * zooming in a notch reaches about -1.4, which is nearer the system than the
 * planet, so the camera would push straight back out and the view would feel
 * like it refused to be zoomed. Following the gesture means a nudge inward
 * switches to the planet and a nudge outward switches to the system, which is
 * what having two states should feel like.
 *
 * `cameFrom` equal to `zoom` is a move that changed no zoom at all - a pan that
 * ended in the band - and there the nearer edge is the only thing to go on.
 */
export function settleTarget(zoom: number, cameFrom: number): number | null {
  if (zoom <= SYSTEM_HOME || zoom >= PLANET_HOME) return null;
  if (cameFrom > zoom) return SYSTEM_HOME;
  if (cameFrom < zoom) return PLANET_HOME;
  return zoom < MIDPOINT ? SYSTEM_HOME : PLANET_HOME;
}

/** Whether a zoom is one of the two places the camera is allowed to rest. */
export function isSettled(zoom: number): boolean {
  return settleTarget(zoom, zoom) === null;
}

/**
 * How long the camera must be still before a settle is even considered.
 *
 * **The bug this exists because of.** The first version acted on `moveend`,
 * believing that meant "after the gesture". It does not: a wheel emits `move`
 * and `moveend` continuously *while* you scroll, so the settle ran mid-gesture,
 * and its own `easeTo` cancelled MapLibre's scroll-zoom animation and restarted
 * from the target. The faster you scrolled the more of the gesture was eaten,
 * and from the solar system it read as being unable to zoom in at all - ten
 * notches inward measured as ending exactly on `PLANET_HOME`, rubber-banding
 * rather than moving.
 *
 * So the rule is idleness, not an event: nothing happens until the camera has
 * been still for this long, which no gesture in progress ever is. Long enough
 * to outlast MapLibre's own scroll inertia, short enough that letting go feels
 * like the view completing the movement rather than thinking about it.
 */
export const SETTLE_IDLE_MS = 350;

/**
 * How long the settle takes.
 *
 * Long enough to read as the view completing a movement, short enough not to
 * feel like being dragged. Zero when the reader has asked for reduced motion:
 * the destination is the point, and the travel is decoration.
 */
export function settleMs(reducedMotion: boolean): number {
  return reducedMotion ? 0 : 420;
}
