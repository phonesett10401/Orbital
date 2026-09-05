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

/** Set so that Neptune's 30.07 AU lands exactly on `ORBIT_MAX`. */
export const ORBIT_K = ORBIT_MAX / Math.log(1 + 30.0699 / ORBIT_SOFTENING_AU);

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
export function radiusFor(distanceAu: number): number {
  const clamped = Math.max(0, distanceAu);
  return ORBIT_K * Math.log(1 + clamped / ORBIT_SOFTENING_AU);
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
