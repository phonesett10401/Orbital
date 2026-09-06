/**
 * The real sky, behind everything else.
 *
 * 5,070 stars down to magnitude 6.0 - the naked-eye limit - from the HYG
 * catalogue, which is public domain. Real right ascensions, real declinations,
 * real magnitudes, so what appears behind the planets is **Orion where Orion
 * is**, turning with the Earth and staying fixed while the planets move
 * against it (D128).
 *
 * That is the same choice the rest of this project keeps making: SGP4 rather
 * than drifting dots, Keplerian elements rather than circles, a coverage layer
 * rather than a hole. A scattering of random points would have looked similar
 * from a distance and been worth nothing when anybody looked twice.
 *
 * ## The Sun is in the catalogue, and had to come out
 *
 * HYG's row zero is Sol, at magnitude -26.7 and zero distance. Left in, it
 * draws a star at right ascension 0 and declination 0 that is not there - the
 * one place in the sky guaranteed to look deliberate.
 *
 * ## The sphere is centred on the camera, not on the Earth
 *
 * A backdrop belongs at infinity, and the first attempt put one at a fixed
 * radius around the globe. That cannot work: at zoom -2 the camera is about 83
 * globe radii out, so a sphere small enough to survive clipping is a sphere the
 * camera is *outside* - it draws as a ball of points with a visible edge, which
 * is exactly how it looked (D128).
 *
 * Centring the sphere on the camera fixes both halves at once. Every star is
 * then the same distance away whichever way the camera turns, so the sphere can
 * be placed just inside the far plane where it is behind everything real; and
 * the camera is always inside it, so it has no edge. Moving the sphere with the
 * camera means no parallax, which is what being at infinity means anyway.
 *
 * Depth testing is *on*, unlike the first attempt: at that radius the Earth is
 * nearer than the sky and should block it. Depth writing is off, because a
 * backdrop should never hide anything (D129).
 */

import catalogue from './fixtures/stars.json';


/** Dimmest star kept. Six is what an unaided eye reaches on a good night. */
export const FAINTEST_MAGNITUDE = 6.0;


export interface StarCatalogue {
  ra: number[];
  dec: number[];
  mag: number[];
  ci: number[];
}

export const STARS = catalogue as StarCatalogue;

export const STAR_COUNT = STARS.ra.length;

/**
 * A star's direction in the equatorial frame, as a unit vector.
 *
 * Right ascension arrives in **hours**, which is the catalogue's unit and the
 * one everybody gets wrong: fifteen degrees to the hour. Declination is
 * already degrees.
 *
 * Returned in the maths convention (+Z north, +X toward the vernal equinox),
 * because that is what `solarFrame` rotates from - the star sphere and the
 * planets must share a frame or the constellations will sit at an angle to the
 * ecliptic that no one can name.
 */
export function starDirection(raHours: number, decDeg: number): [number, number, number] {
  const ra = raHours * 15 * (Math.PI / 180);
  const dec = decDeg * (Math.PI / 180);
  const cos = Math.cos(dec);
  return [Math.cos(ra) * cos, Math.sin(ra) * cos, Math.sin(dec)];
}

/**
 * How large to draw a star of this magnitude.
 *
 * Magnitude is logarithmic and backwards - smaller is brighter, and five
 * magnitudes is a hundredfold in flux. Drawing raw flux would make Sirius
 * enormous and everything else invisible, so this is deliberately compressed,
 * the same bargain `solarScale` struck with distance.
 */
export function starSize(mag: number): number {
  const clamped = Math.min(FAINTEST_MAGNITUDE, Math.max(-1.5, mag));
  return 0.012 + 0.055 * ((FAINTEST_MAGNITUDE - clamped) / (FAINTEST_MAGNITUDE + 1.5)) ** 1.6;
}

/**
 * A star's colour from its B-V index, as red, green and blue in 0..1.
 *
 * Not decoration: B-V is a temperature measurement. Rigel really is blue and
 * Betelgeuse really is red, and a sky of uniform white points throws away a
 * fact the catalogue is handing over for free.
 *
 * The mapping is a coarse fit rather than a blackbody integral - at two pixels
 * a star is a colour, not a spectrum.
 */
export function starColour(ci: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (ci + 0.4) / 2.4));
  // Blue-white at low B-V through white to orange-red at high.
  const r = 0.62 + 0.38 * t;
  const g = 0.74 + 0.20 * t - 0.30 * t * t;
  const b = 1.0 - 0.55 * t * t;
  return [r, Math.max(0, g), Math.max(0, b)];
}
