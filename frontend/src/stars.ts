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
 * ## Why they are drawn near and depth-tested off
 *
 * A star sphere belongs at infinity, and MapLibre's far plane cuts everything
 * past about 20 globe radii (D123) - which is precisely the half of a
 * surrounding sphere a backdrop needs. So the points sit at a modest radius
 * where nothing clips them, with depth testing disabled and a render order
 * that puts them first. Direction is what a star is; distance here is only
 * somewhere to put it.
 */

import catalogue from './fixtures/stars.json';

/** Where the star points are placed. Inside the far plane, by D123's measure. */
export const STAR_SPHERE_RADII = 9;

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
