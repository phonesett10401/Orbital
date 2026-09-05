/**
 * Saturn's rings, from the radii they actually have.
 *
 * The rings are the one thing in this scene with real structure at the scale it
 * is drawn: a bright B ring, a visibly darker A ring outside it, and the
 * **Cassini division** between them - a 4,600 km gap that a small telescope
 * shows and that is the single feature which makes a drawing of Saturn read as
 * Saturn rather than as a disc with a hoop around it.
 *
 * So the profile is measured rather than invented, in the same spirit as SGP4
 * over drifting dots and a real star catalogue over scattered points. Radii are
 * in **Saturn radii**, dividing the published kilometre figures by Saturn's
 * equatorial radius of 60,268 km:
 *
 * | feature | km | Saturn radii |
 * |---|---|---|
 * | C ring inner | 74,658 | 1.239 |
 * | B ring inner | 92,000 | 1.526 |
 * | Cassini division | 117,580-122,170 | 1.951-2.027 |
 * | A ring outer | 136,775 | 2.269 |
 * | Encke gap | 133,589 | 2.216 |
 *
 * The *size* Saturn is drawn at is compressed, like every other body here - but
 * the ring system's proportions to the planet are exact, which is the same
 * bargain `solarScale` struck: the arrangement is true, the scale is not.
 */

/** Inner edge of the C ring, where anything is visible at all. */
export const RING_INNER = 1.239;
/** Outer edge of the A ring. Nothing past this. */
export const RING_OUTER = 2.269;

interface Band {
  from: number;
  to: number;
  opacity: number;
}

/**
 * Brightness by band, standing in for optical depth.
 *
 * Not the measured optical depths themselves - those run past 1 for the B ring
 * and would clip - but their ordering and rough ratios, which is what the eye
 * reads at this size: B clearly brightest, A about half of it, C a faint haze.
 */
const BANDS: Band[] = [
  { from: 1.239, to: 1.526, opacity: 0.16 }, // C ring - the faint inner haze
  { from: 1.526, to: 1.951, opacity: 1.0 }, // B ring - the bright one
  { from: 1.951, to: 2.027, opacity: 0.05 }, // Cassini division
  { from: 2.027, to: 2.269, opacity: 0.55 }, // A ring
];

/** The Encke gap, a narrow dark line near the A ring's outer edge. */
const ENCKE_AT = 2.216;
const ENCKE_HALF_WIDTH = 0.006;

/**
 * How opaque the ring system is at this radius, in Saturn radii.
 *
 * Zero outside the rings entirely, which is what makes the annulus an annulus
 * rather than a disc.
 */
export function ringOpacity(radii: number): number {
  if (radii < RING_INNER || radii > RING_OUTER) return 0;
  let opacity = 0;
  for (const band of BANDS) {
    if (radii >= band.from && radii <= band.to) {
      opacity = band.opacity;
      break;
    }
  }
  // The Encke gap is a gap, not a band, so it is cut out of whatever it lands
  // in rather than listed alongside the bands it sits inside.
  if (Math.abs(radii - ENCKE_AT) < ENCKE_HALF_WIDTH) opacity *= 0.15;
  // The outermost and innermost edges fade rather than stopping dead: a hard
  // edge at this size reads as an aliasing artefact, and the real A ring edge
  // is sharp but its brightness still falls off.
  const edge = 0.02;
  const fromInner = (radii - RING_INNER) / edge;
  const fromOuter = (RING_OUTER - radii) / edge;
  return opacity * Math.min(1, fromInner, fromOuter, 1);
}

/**
 * The profile as a lookup table across the annulus, for the shader to sample.
 *
 * The table is built *from* `ringOpacity`, so what reaches the screen is the
 * function the tests cover rather than a second copy of the numbers written in
 * GLSL that could drift from it.
 *
 * RGBA rather than a single channel: a one-channel texture is not universally
 * available in WebGL 1, and MapLibre may hand a custom layer either context.
 */
export function ringProfile(samples = 512): Uint8Array {
  const data = new Uint8Array(samples * 4);
  for (let i = 0; i < samples; i += 1) {
    const radii = RING_INNER + ((RING_OUTER - RING_INNER) * i) / (samples - 1);
    const value = Math.round(Math.min(1, Math.max(0, ringOpacity(radii))) * 255);
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = value;
  }
  return data;
}

/**
 * Saturn's north pole, as right ascension in hours and declination in degrees.
 *
 * The IAU value for the invariable pole (RA 40.589 degrees, Dec 83.537). The
 * rings lie in Saturn's equatorial plane, so this direction *is* the ring
 * normal - which is why the rings are seen open or edge-on from Earth over a
 * 29-year cycle rather than always at the same angle.
 */
export const SATURN_POLE_RA_HOURS = 40.589 / 15;
export const SATURN_POLE_DEC_DEG = 83.537;
