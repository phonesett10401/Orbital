/**
 * Making the solar system fit on a screen, and saying so.
 *
 * This is `satelliteShell.ts` again, two orders of magnitude worse. There the
 * spread was 0.010 to 16.39 Earth radii; here it is measured as:
 *
 * | | spread |
 * |---|---|
 * | orbit radius, Mercury to Neptune | **77.7 : 1** |
 * | body radius, Moon to Sun | **401 : 1** |
 *
 * **True scale is not merely awkward, it is impossible.** With Neptune's orbit
 * drawn 500 pixels across, the Sun is 0.077 px and Earth is 0.0007 px. Not
 * small - absent. There is no viewport and no zoom at which the real numbers
 * produce a picture, which is why every orrery ever built lies about at least
 * one axis, and why this file exists to lie deliberately and in one place.
 *
 * ## Two axes, two compressions, because they are independent
 *
 * Earth's orbit is **23,000 times** its own radius. A single scale that made
 * the orbits fit would make the bodies invisible, and one that made the bodies
 * visible would put Neptune far outside any frame. So distance and size are
 * compressed separately - which is the honest description of what an orrery
 * is, rather than an approximation of one.
 *
 * ## Angle is true; only distance is compressed
 *
 * `radiusFor` maps a heliocentric *distance* and nothing else. The angular
 * position computed in `planets.ts` is passed through untouched, so a
 * conjunction is a real conjunction and a planet on the far side of the Sun is
 * really there. An orbit path is drawn by compressing each of its points'
 * radius, which keeps the ellipse's orientation and its perihelion in the
 * right direction while shortening the whole figure.
 *
 * That is the same bargain `satelliteShell.ts` struck: **the arrangement is
 * true and the distances are not.**
 */

import { ELEMENTS, PLANET_IDS } from './planets';

/** Astronomical unit in kilometres, for turning body radii into orbit units. */
export const AU_KM = 149_597_870.7;

// ---- distance ------------------------------------------------------------

/**
 * Softening for the orbit compression, in AU.
 *
 * Chosen at 0.3 so Mercury lands at 0.18 of Neptune's radius rather than on
 * top of the Sun. A larger softening pushes the inner four together; a smaller
 * one spreads them and crushes the giants against the rim.
 */
export const ORBIT_SOFTENING_AU = 0.3;

/** Where Neptune sits, in the unit everything else is a fraction of. */
export const ORBIT_MAX = 1.0;

/**
 * Neptune's **aphelion**, not its semi-major axis.
 *
 * a(1+e) = 30.06992276 x 1.00859048 = 30.328 AU. Normalising on the axis put
 * Neptune's real positions slightly outside the frame for the half of its
 * orbit spent beyond the mean - a small error, but the kind that shows as a
 * planet clipping the rim rather than as a wrong number anywhere.
 */
export const NEPTUNE_APHELION_AU = 30.328;

/** Set so Neptune at its furthest lands exactly on `ORBIT_MAX`. */
export const ORBIT_K = ORBIT_MAX / Math.log(1 + NEPTUNE_APHELION_AU / ORBIT_SOFTENING_AU);

/**
 * A heliocentric distance in AU, compressed to a drawable radius.
 *
 * Logarithmic with a softening term, so it is finite and smooth at zero: a bare
 * logarithm sends the Sun's own surface to minus infinity, and a linear scale
 * spends 96% of the frame on the four gas giants.
 *
 * Monotonic by construction, which is the property that actually matters -
 * whatever the compression does to the numbers, a planet further out is drawn
 * further out, always.
 */
/**
 * The least share of the frame any two neighbouring orbits get.
 *
 * ## Why the compression alone cannot do this
 *
 * Measured across the whole family of curves. With the softening at 0.3 the
 * inner four occupy 0.21 of the frame radius; at 0.05 they occupy 0.20, at 1.0
 * they occupy 0.18, and raising the normalised log to a power moves it by less
 * than a hundredth. The reason is not the tuning: **Venus and Earth are 0.28 AU
 * apart while Neptune is 30 AU out**, and no monotone map of one axis gives the
 * inner pairs more than a sliver while still fitting Neptune in the frame.
 *
 * ## And why widening alone does not either
 *
 * The first attempt pushed each crowded body outward until it cleared its
 * neighbour, then renormalised so Neptune stayed on the rim. That is very
 * nearly a no-op, and measurably so: Venus to Earth went from 0.0518 to 0.0520.
 * Pushing everything out and then scaling everything back down returns almost
 * exactly what it started with.
 *
 * **Room for the inner planets has to be taken from the outer ones.** There is
 * one frame, so a gap that grows is a gap that shrinks somewhere else, and
 * saying which is the whole decision. Every adjacent pair is given `MIN_GAP` of
 * the frame first, and what is left over is shared out in proportion to the
 * logarithm - so the curve still decides the *shape*, and this decides the
 * floor.
 *
 * It is the same bargain already struck for the Moon, drawn beside the Earth at
 * a fixed offset because 0.0026 AU cannot be resolved at all (D140). The
 * distance axis is already false; `SCALE_NOTE` says so on screen.
 */
export const MIN_GAP = 0.07;

/**
 * Turn a set of ascending curve values into radii that fill `max` exactly, with
 * every neighbouring pair at least `minGap` apart.
 *
 * The first anchor stays at zero - it is the Sun's own centre, and moving it
 * would shift the system off the point it is drawn around.
 *
 * Strictly increasing by construction, which is the property that matters:
 * every gap is at least `minGap`, which is positive, so a planet further out is
 * drawn further out however the proportions fall.
 */
export function allocateRadii(
  curve: readonly number[],
  minGap = MIN_GAP,
  max = 1,
): number[] {
  if (curve.length === 0) return [];
  if (curve.length === 1) return [0];
  const gaps = curve.slice(1).map((r, i) => Math.max(0, r - curve[i]));
  const total = gaps.reduce((a, b) => a + b, 0);
  // What is left after every pair has taken its floor. Negative would mean the
  // floors alone overflow the frame, and then the floors are all there is.
  const spare = Math.max(0, max - minGap * gaps.length);
  const out = [0];
  for (const gap of gaps) {
    const share = total === 0 ? spare / gaps.length : (gap / total) * spare;
    out.push(out[out.length - 1] + minGap + share);
  }
  return out;
}

function logCurve(distanceAu: number): number {
  const clamped = Math.max(0, distanceAu);
  return ORBIT_K * Math.log(1 + clamped / ORBIT_SOFTENING_AU);
}

/**
 * The distances the curve is pinned to: each planet's own orbit, plus the
 * centre and Neptune's aphelion so the ends stay where they were.
 *
 * Mean orbits rather than today's positions, so the shape of the scale does not
 * change from one day to the next. A planet's eccentricity still moves it along
 * the curve; it does not move the curve.
 */
const ANCHOR_AU = [0, ...PLANET_IDS.map((p) => ELEMENTS[p].a), NEPTUNE_APHELION_AU];

/** The same anchors after the crowded ones have been pushed apart. */
const ANCHOR_R = allocateRadii(ANCHOR_AU.map(logCurve), MIN_GAP, ORBIT_MAX);

/**
 * A heliocentric distance in AU, compressed to a drawable radius.
 *
 * **Piecewise linear through the planets' own orbits**, rather than the bare
 * logarithm it used to be. The logarithm is still what decides where the
 * anchors go - it is finite and smooth at zero, where a bare log sends the
 * Sun's surface to minus infinity, and it spends the frame far better than a
 * linear scale, which gives 96% of it to the four giants. What the anchors add
 * is `MIN_BODY_GAP` between neighbours, which no choice of logarithm could
 * (see that constant for the measurements).
 *
 * Monotonic by construction, which is the property that actually matters -
 * whatever the compression does to the numbers, a planet further out is drawn
 * further out, always. Linear interpolation between strictly increasing anchors
 * is strictly increasing, and beyond the last anchor it continues on the final
 * segment's slope rather than flattening, so nothing outside the planets folds
 * back on itself.
 */
export function radiusFor(distanceAu: number): number {
  const d = Math.max(0, distanceAu);
  for (let i = 1; i < ANCHOR_AU.length; i += 1) {
    if (d <= ANCHOR_AU[i]) {
      const span = ANCHOR_AU[i] - ANCHOR_AU[i - 1];
      const across = span === 0 ? 0 : (d - ANCHOR_AU[i - 1]) / span;
      return ANCHOR_R[i - 1] + across * (ANCHOR_R[i] - ANCHOR_R[i - 1]);
    }
  }
  const n = ANCHOR_AU.length - 1;
  const slope = (ANCHOR_R[n] - ANCHOR_R[n - 1]) / (ANCHOR_AU[n] - ANCHOR_AU[n - 1]);
  return ANCHOR_R[n] + (d - ANCHOR_AU[n]) * slope;
}

// ---- size ----------------------------------------------------------------

/**
 * Softening for the body compression, in kilometres.
 *
 * 3,000 km sits just under Mars, so the four small rocky bodies stay
 * distinguishable from each other instead of collapsing onto the floor.
 */
export const BODY_SOFTENING_KM = 3_000;

/**
 * The Moon, the smallest thing drawn, and the Sun, the largest.
 *
 * **In the same unit as `radiusFor`**, where 1.0 is Neptune's orbit radius, so
 * a renderer multiplies both by one number and nothing has to remember a
 * conversion. The first version of this file had bodies in pixels and orbits
 * in frame fractions, which meant `exaggerationOf` needed a magic factor of a
 * thousand to produce a plausible-looking answer - a fudge covering a units
 * mismatch, and the sort of number that survives review because it is only
 * ever printed (D122).
 *
 * At a 500-pixel frame radius these are 3 px and 30 px.
 */
export const BODY_MIN = 0.006;
export const BODY_MAX = 0.060;

const BODY_LOG_MIN = Math.log(1 + 1_737.4 / BODY_SOFTENING_KM);
const BODY_LOG_MAX = Math.log(1 + 696_000 / BODY_SOFTENING_KM);

export const BODY_K = (BODY_MAX - BODY_MIN) / (BODY_LOG_MAX - BODY_LOG_MIN);

/**
 * A body radius in kilometres, compressed to a drawable radius.
 *
 * The Moon lands on `BODY_MIN` and the Sun on `BODY_MAX`: a true ratio of
 * **401 : 1 drawn as 10 : 1**, in the same unit as `radiusFor`. Every
 * intermediate body keeps its order, and bodies that really are nearly the
 * same size - Venus and Earth, Uranus and Neptune - stay nearly the same size, which is the part a reader can check
 * against what they already know.
 */
export function bodyRadiusFor(radiusKm: number): number {
  const clamped = Math.max(0, radiusKm);
  return BODY_MIN + BODY_K * (Math.log(1 + clamped / BODY_SOFTENING_KM) - BODY_LOG_MIN);
}

// ---- where it is drawn ---------------------------------------------------

/**
 * Neptune's orbit, expressed in globe radii, for MapLibre's own renderer.
 *
 * **Phase 4 was planned as a second renderer and does not need one.** The
 * plan was a three.js scene for space crossfading with MapLibre at a zoom
 * boundary, because MapLibre draws one globe and a solar system is not one
 * globe. But `satelliteShellLayer` and `modelLayer` already run three.js
 * *inside* MapLibre's GL context, on a unit sphere where a radius is a
 * multiple of the globe's own - so the question was never whether two
 * renderers can hand over, only how far the one already here reaches (D123).
 *
 * Measured on screen, at MapLibre's hard floor of zoom -2, as the fraction of
 * a ring's **near side** that lands inside the clip volume:
 *
 * | ring | visible |
 * |---|---|
 * | 2.4 (the satellite shell today) | 64% |
 * | 10 | 55% |
 * | **20** | **52% - the whole near side** |
 * | 40 | 11% |
 * | 80 | 2% |
 *
 * The far half of every ring is behind the far plane at any radius, which is
 * not a limit but the existing behaviour: the shell already draws only the
 * near side, culled against the same horizon plane.
 *
 * 18 rather than 20, so the outermost orbit is inside the frame rather than
 * exactly on the boundary where a resize would push it out.
 *
 * **`minZoom` must be -2 for this to hold.** MapLibre refuses anything lower -
 * it is a library cap, not a setting - and at -1.6 the 20-radius ring drops
 * from 52% to 30%.
 */
export const GLOBE_RADII_AT_NEPTUNE = 18;

/** MapLibre's own floor. Nothing below this exists to be configured. */
export const MAPLIBRE_MIN_ZOOM = -2;

/** A compressed radius in `radiusFor` units, as a multiple of the globe's. */
export function globeRadiiFor(scaled: number): number {
  return scaled * GLOBE_RADII_AT_NEPTUNE;
}

// ---- saying so -----------------------------------------------------------

/**
 * How badly a body is exaggerated where it is drawn, as a multiple.
 *
 * Measured across the eight planets at this scale: **628x for Jupiter to
 * 4,580x for Neptune**, with Earth at 989x. The giants need least help because
 * they are already large next to their orbits; Neptune needs most because it
 * is small and very far out.
 *
 * Exists to be *shown*, not to be used in the maths. Every other layer in this
 * app states what it is doing to the truth - the satellite key says the shell
 * is compressed, the aircraft panel says how old a position is, the coverage
 * layer says where nobody is listening - and a solar system drawn a thousand
 * times out of proportion should not be the one thing that stays quiet.
 */
export function exaggerationOf(radiusKm: number, distanceAu: number): number {
  if (distanceAu <= 0 || radiusKm <= 0) return 1;
  const trueRatio = radiusKm / AU_KM / distanceAu;
  const drawnRatio = bodyRadiusFor(radiusKm) / radiusFor(distanceAu);
  return drawnRatio / trueRatio;
}

/** One line for the key, so the compression is never implicit. */
export const SCALE_NOTE =
  'Distances and sizes are compressed separately — angles are true, nothing is to scale';

/** Earth's mean radius, the unit true sizes are quoted in. */
export const EARTH_RADIUS_KM = 6371;

/**
 * A body's drawn radius in globe radii.
 *
 * The Sun at 1.08 globe radii and Earth at 0.241 - a true ratio of 109:1 drawn
 * as 4.5:1, so the small bodies exist on screen at all.
 *
 * **There was a toggle here that drew the true ratio instead, and it is gone
 * (D156).** It worked, and it was not worth what it cost: it held the Sun fixed
 * and let everything else fall to its real proportion, which is the honest
 * comparison, but the result is a screen with one disc on it and nine specks
 * too small to click. Confirming it worked at all took two temporary probes and
 * a line in the debug readout, and the honest thing it had to say is said
 * better by `SCALE_NOTE`, which is on screen permanently and costs nobody a
 * mode: **nothing here is to scale, and the compression is the only reason
 * there is anything to look at.**
 *
 * Distances were never touched by it in any case. There is no setting at which
 * they can be true: Neptune's orbit is 706,076 globe radii against a far plane
 * one radius past the centre (D129).
 */
export function drawnBodyRadius(radiusKm: number): number {
  return globeRadiiFor(bodyRadiusFor(radiusKm));
}

/** The Sun's radius, the yardstick exaggeration is measured against. */
export const SUN_RADIUS_KM = 695_700;

/**
 * How much bigger than life a body is drawn, relative to the Sun.
 *
 * One would mean honest, and nothing here is one - which is the point. This is
 * what makes `SCALE_NOTE`'s claim executable rather than a caption: the
 * compression is a number, and it can be asserted.
 */
export function bodyExaggeration(radiusKm: number): number {
  const drawnRatio = drawnBodyRadius(radiusKm) / drawnBodyRadius(SUN_RADIUS_KM);
  const realRatio = radiusKm / SUN_RADIUS_KM;
  return realRatio === 0 ? 1 : drawnRatio / realRatio;
}
