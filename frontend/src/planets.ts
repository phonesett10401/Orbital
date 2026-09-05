/**
 * Where the planets are, computed from constants.
 *
 * The same shape as the satellite layer and one step further: satellites need
 * element sets fetched from somewhere and refreshed every few days, while a
 * planet's orbit is described by six numbers and six rates that were published
 * once and do not change. **This module makes no request, ever** - there is no
 * upstream to be down, no quota, no cache and no staleness. It is the only
 * layer in Orbital that cannot fail (D121).
 *
 * ## The method
 *
 * JPL's *Approximate Positions of the Planets*: each element is a value at
 * J2000 plus a linear rate per Julian century, Kepler's equation is solved for
 * the eccentric anomaly, and the result is rotated from the orbital plane into
 * the J2000 ecliptic. Accurate to roughly an arcminute over 1800-2050, which
 * is four orders of magnitude better than anything a screen a thousand pixels
 * wide could show.
 *
 * ## What the numbers are of
 *
 * The Earth row is the **Earth-Moon barycentre**, not the Earth. They differ
 * by about 4,700 km - the barycentre is inside the Earth - which is 3e-5 AU
 * and invisible here, but the tests compare against Horizons body `3` rather
 * than `399` so the comparison is of like with like.
 *
 * Positions are heliocentric ecliptic J2000, in astronomical units, right
 * handed: +X toward the March equinox, +Z toward ecliptic north.
 */

/** Days per Julian century, and the Julian date of J2000.0. */
const J2000 = 2451545.0;
const CENTURY_DAYS = 36525.0;
const DEG = Math.PI / 180;

export type PlanetId =
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

/**
 * One planet's orbit: six elements at J2000 and six rates per century.
 *
 * `a` semi-major axis (AU), `e` eccentricity, `i` inclination,
 * `l` mean longitude, `peri` longitude of perihelion, `node` longitude of the
 * ascending node - the last four in degrees.
 *
 * Transcribed from JPL's table for 1800-2050. Every digit matters: the rates
 * are multiplied by centuries, so an error in the sixth decimal of `lRate`
 * moves a planet by a degree within a lifetime.
 */
interface Elements {
  a: number; aRate: number;
  e: number; eRate: number;
  i: number; iRate: number;
  l: number; lRate: number;
  peri: number; periRate: number;
  node: number; nodeRate: number;
}

export const ELEMENTS: Record<PlanetId, Elements> = {
  mercury: {
    a: 0.38709927, aRate: 0.00000037,
    e: 0.20563593, eRate: 0.00001906,
    i: 7.00497902, iRate: -0.00594749,
    l: 252.25032350, lRate: 149472.67411175,
    peri: 77.45779628, periRate: 0.16047689,
    node: 48.33076593, nodeRate: -0.12534081,
  },
  venus: {
    a: 0.72333566, aRate: 0.00000390,
    e: 0.00677672, eRate: -0.00004107,
    i: 3.39467605, iRate: -0.00078890,
    l: 181.97909950, lRate: 58517.81538729,
    peri: 131.60246718, periRate: 0.00268329,
    node: 76.67984255, nodeRate: -0.27769418,
  },
  earth: {
    a: 1.00000261, aRate: 0.00000562,
    e: 0.01671123, eRate: -0.00004392,
    i: -0.00001531, iRate: -0.01294668,
    l: 100.46457166, lRate: 35999.37244981,
    peri: 102.93768193, periRate: 0.32327364,
    node: 0.0, nodeRate: 0.0,
  },
  mars: {
    a: 1.52371034, aRate: 0.00001847,
    e: 0.09339410, eRate: 0.00007882,
    i: 1.84969142, iRate: -0.00813131,
    l: -4.55343205, lRate: 19140.30268499,
    peri: -23.94362959, periRate: 0.44441088,
    node: 49.55953891, nodeRate: -0.29257343,
  },
  jupiter: {
    a: 5.20288700, aRate: -0.00011607,
    e: 0.04838624, eRate: -0.00013253,
    i: 1.30439695, iRate: -0.00183714,
    l: 34.39644051, lRate: 3034.74612775,
    peri: 14.72847983, periRate: 0.21252668,
    node: 100.47390909, nodeRate: 0.20469106,
  },
  saturn: {
    a: 9.53667594, aRate: -0.00125060,
    e: 0.05386179, eRate: -0.00050991,
    i: 2.48599187, iRate: 0.00193609,
    l: 49.95424423, lRate: 1222.49362201,
    peri: 92.59887831, periRate: -0.41897216,
    node: 113.66242448, nodeRate: -0.28867794,
  },
  uranus: {
    a: 19.18916464, aRate: -0.00196176,
    e: 0.04725744, eRate: -0.00004397,
    i: 0.77263783, iRate: -0.00242939,
    l: 313.23810451, lRate: 428.48202785,
    peri: 170.95427630, periRate: 0.40805281,
    node: 74.01692503, nodeRate: 0.04240589,
  },
  neptune: {
    a: 30.06992276, aRate: 0.00026291,
    e: 0.00859048, eRate: 0.00005105,
    i: 1.77004347, iRate: 0.00035372,
    l: -55.12002969, lRate: 218.45945325,
    peri: 44.96476227, periRate: -0.32241464,
    node: 131.78422574, nodeRate: -0.00508664,
  },
};

/** Heliocentric ecliptic J2000, in astronomical units. */
export interface Vector {
  x: number;
  y: number;
  z: number;
}

export function julianDay(when: Date): number {
  // Unix epoch is JD 2440587.5, and 86 400 000 ms make a day. No leap seconds:
  // an arcminute-accurate method cannot see them.
  return when.getTime() / 86_400_000 + 2440587.5;
}

/** Centuries from J2000, the argument every element rate is multiplied by. */
export function centuriesSinceJ2000(when: Date): number {
  return (julianDay(when) - J2000) / CENTURY_DAYS;
}

/** Fold an angle into -180..180, where Kepler's equation converges fastest. */
export function wrapDegrees(angle: number): number {
  const folded = ((angle + 180) % 360 + 360) % 360;
  return folded - 180;
}

/**
 * Solve `E - e* sin E = M` for the eccentric anomaly, in degrees.
 *
 * Newton-Raphson from `M` itself, which is close enough for every planet -
 * even Mercury's 0.206 eccentricity converges in four or five passes. The
 * iteration cap is a guard rather than a working limit: an orbit that has not
 * converged by then has an eccentricity no planet has, and returning a
 * confidently wrong angle would be worse than stopping.
 */
export function solveKepler(meanAnomalyDeg: number, eccentricity: number): number {
  const eStar = (180 / Math.PI) * eccentricity;
  let e = meanAnomalyDeg + eStar * Math.sin(meanAnomalyDeg * DEG);

  for (let pass = 0; pass < 32; pass += 1) {
    const dM = meanAnomalyDeg - (e - eStar * Math.sin(e * DEG));
    const dE = dM / (1 - eccentricity * Math.cos(e * DEG));
    e += dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  return e;
}

/**
 * Where one planet is, heliocentric ecliptic J2000, in AU.
 *
 * Takes a `Date` rather than a Julian day so callers cannot get the epoch
 * wrong, which is the mistake that cost this project a day on TLE years
 * (D95): reading a two-digit year as 2075 instead of 1975 turned a stale
 * element set into a confident future one.
 */
export function planetPosition(planet: PlanetId, when: Date): Vector {
  const el = ELEMENTS[planet];
  const t = centuriesSinceJ2000(when);

  const a = el.a + el.aRate * t;
  const e = el.e + el.eRate * t;
  const i = (el.i + el.iRate * t) * DEG;
  const l = el.l + el.lRate * t;
  const peri = el.peri + el.periRate * t;
  const node = el.node + el.nodeRate * t;

  // Argument of perihelion, and the mean anomaly folded to where Kepler's
  // equation is best behaved.
  const omega = (peri - node) * DEG;
  const meanAnomaly = wrapDegrees(l - peri);
  const eccentric = solveKepler(meanAnomaly, e) * DEG;

  // In the orbital plane, perihelion along +x.
  const xOrb = a * (Math.cos(eccentric) - e);
  const yOrb = a * Math.sqrt(1 - e * e) * Math.sin(eccentric);

  const cosO = Math.cos(omega);
  const sinO = Math.sin(omega);
  const cosN = Math.cos(node * DEG);
  const sinN = Math.sin(node * DEG);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  return {
    x: (cosO * cosN - sinO * sinN * cosI) * xOrb + (-sinO * cosN - cosO * sinN * cosI) * yOrb,
    y: (cosO * sinN + sinO * cosN * cosI) * xOrb + (-sinO * sinN + cosO * cosN * cosI) * yOrb,
    z: sinO * sinI * xOrb + cosO * sinI * yOrb,
  };
}

/** Distance from the Sun, in AU. */
export function heliocentricDistance(planet: PlanetId, when: Date): number {
  const { x, y, z } = planetPosition(planet, when);
  return Math.hypot(x, y, z);
}

/**
 * Sidereal period in days, from the semi-major axis.
 *
 * Kepler's third law rather than a table of periods, so the period and the
 * position cannot disagree about `a`.
 *
 * **The solar mass only**, which makes this systematically long for the heavy
 * planets: the two-body period involves `M + m`, and Jupiter is 1/1047 of a
 * solar mass, so its true period is about 478 ppm shorter than this returns.
 * Measured against the element table's own `lRate`, Jupiter's disagreement is
 * 448 ppm - very nearly all of it this. It matters for nothing here; a
 * half-day error in a twelve-year orbit is invisible on a screen and the
 * function is used for framing, not prediction.
 */
export function orbitalPeriodDays(planet: PlanetId): number {
  return 365.256898326 * Math.pow(ELEMENTS[planet].a, 1.5);
}

export const PLANET_IDS = Object.keys(ELEMENTS) as PlanetId[];
