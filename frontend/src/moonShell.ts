/**
 * Where a lunar spacecraft sits above the Moon (D136).
 *
 * ## This one is not compressed, and that is the point
 *
 * Earth's satellite shell compresses altitude logarithmically because it has
 * to: geostationary orbit is **6.6 Earth radii**, so drawing it true would put
 * most of the catalogue off screen or crush low orbit into the surface (D96).
 * Every altitude on that shell is therefore a drawn value, not a real one.
 *
 * The Moon does not have that problem. Everything in orbit there is *low*:
 *
 * | spacecraft | altitude | Moon radii |
 * |---|---|---|
 * | LRO | 71-105 km | 1.041-1.060 |
 * | Chandrayaan-2 | 102 km | 1.059 |
 * | Danuri | 213 km | 1.123 |
 *
 * The whole range fits between the surface and 1.13 radii, so it is drawn
 * **exactly where it is**. No softening, no logarithm, no note explaining what
 * was traded away. It is the only place in Orbital where a height on screen is
 * the height something is at.
 *
 * The consequence, stated because it is not a bug: at a zoom where the whole
 * Moon fits on screen, 70 km is about three pixels. It looks like almost
 * nothing, because compared to the Moon it *is* almost nothing. Zooming in
 * separates the spacecraft from its shadow on the surface.
 */

/** The Moon's IAU radius, the same figure the backend measures altitude from. */
export const MOON_RADIUS_KM = 1737.4;

/**
 * A spacecraft's distance from the Moon's centre, in Moon radii.
 *
 * One at the surface. The backend sends altitude above the surface, so this is
 * the one conversion between the two, in one place, tested.
 */
export function shellRadiusFor(altitudeKm: number): number {
  return 1 + Math.max(0, altitudeKm) / MOON_RADIUS_KM;
}

/**
 * How much of the drawn height is real. Always exactly 1.
 *
 * Kept as a function rather than a comment so the claim is executable: if
 * anybody ever adds compression here, this stops returning 1 and the test that
 * asserts it fails, which is the only way a promise like this survives.
 */
export function exaggeration(): number {
  return 1;
}
