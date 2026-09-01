/**
 * How high above the globe a satellite is drawn.
 *
 * The aircraft layer does not have this problem and says so: `MARKER_ALTITUDE`
 * is a single uniform offset, because a cruising airliner is 0.2% of Earth's
 * radius up and any honest height would put the marker inside the surface
 * texture. Altitude is carried by colour there instead.
 *
 * Satellites cannot do that. Height *is* the information — the difference
 * between a Starlink and a GPS satellite is mostly how far out it is — and the
 * range is enormous:
 *
 * | | altitude | Earth radii |
 * |---|---|---|
 * | ISS | 420 km | 0.07 |
 * | Starlink | 550 km | 0.09 |
 * | GPS | 20,200 km | 3.2 |
 * | Geostationary | 35,786 km | 5.6 |
 * | Cluster II at apogee | 105,466 km | 16.5 |
 *
 * **True scale does not work.** The orbit controls stop the camera at 8 R, so
 * a geostationary satellite is only just reachable and Cluster II is outside
 * the camera's range entirely — invisible, at the exact moment the user has
 * asked to look at satellites. Meanwhile everything in low orbit, which is
 * most of the catalogue, collapses into a film on the surface.
 *
 * So the mapping is **logarithmic**, and that is the same trade recorded in
 * D91 and D92: the accurate number and the legible one are different, the
 * drawing chooses legibility on purpose, and the true value stays in the data
 * where the panel can show it.
 *
 * Logarithmic rather than banded shells because it is **strictly monotonic**.
 * Two satellites at different altitudes are never drawn at the same height, so
 * "higher on screen" always means "higher in orbit" — which is the one claim
 * this drawing makes, and it should never be false.
 */

/** Where the lowest satellite sits, in globe radii above the surface.
 *
 * Above `MARKER_ALTITUDE` (0.012) and well above the border layer, so a
 * satellite is never confused with something drawn on the ground.
 */
export const SHELL_MIN = 0.05;

/**
 * Curve constants, solved against three anchor points.
 *
 * `shell = SHELL_MIN + SHELL_K * ln(1 + altitudeKm / SHELL_SOFTENING)`
 *
 * - 550 km (the Starlink shell, where most of the catalogue lives) → 0.28 R
 * - 35,786 km (geostationary) → 1.05 R
 *
 * Those two fix the ratio, which pins `SHELL_SOFTENING` at about 260 km, and
 * the second then fixes `SHELL_K`. The softening term also keeps the curve
 * finite at zero altitude, where a bare logarithm would go to negative
 * infinity.
 */
export const SHELL_SOFTENING_KM = 260;
export const SHELL_K = 0.203;

/**
 * Everything is inside this, including the most eccentric orbits in the
 * catalogue. 1.27 R above the surface is 2.27 R from the centre — comfortably
 * within the camera's 8 R limit, so the whole constellation is visible at the
 * default zoom rather than requiring the user to pull back and hunt for it.
 */
export const SHELL_MAX = 1.35;

/**
 * Draw height for a satellite, in globe radii above the surface.
 *
 * `altitudeM` is the real altitude in metres, exactly as the contract carries
 * it. Null altitude falls back to the low-orbit floor rather than the ground:
 * an unknown satellite is far more likely to be in low orbit than sitting on
 * the surface, and drawing it on the surface would be a claim we cannot make.
 */
export function shellFor(altitudeM: number | null): number {
  if (altitudeM === null || !Number.isFinite(altitudeM) || altitudeM <= 0) {
    return SHELL_MIN;
  }
  const km = altitudeM / 1000;
  const shell = SHELL_MIN + SHELL_K * Math.log(1 + km / SHELL_SOFTENING_KM);
  return Math.min(shell, SHELL_MAX);
}

/** Orbit regimes, for the legend and the detail panel. */
export type OrbitRegime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

/**
 * Which regime an altitude falls in.
 *
 * The boundaries are the conventional ones: low orbit ends at 2,000 km,
 * geostationary is 35,786 km, and anything appreciably beyond that is on a
 * high or highly elliptical orbit. This is **derived**, which is exactly why
 * it is computed here rather than being put in the `model` field where it
 * would masquerade as something the source said (D94).
 */
export function regimeFor(altitudeM: number | null): OrbitRegime | null {
  if (altitudeM === null || !Number.isFinite(altitudeM)) return null;
  const km = altitudeM / 1000;
  if (km < 2_000) return 'LEO';
  if (km < 34_000) return 'MEO';
  if (km < 37_500) return 'GEO';
  return 'HEO';
}
