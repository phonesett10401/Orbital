/**
 * Which way each planet's axis points.
 *
 * A body drawn as a plain sphere does not need this. A body with **bands** does:
 * bands run along lines of latitude, so a banded planet built in the globe
 * frame without being turned would wear Earth's axis instead of its own. On
 * Uranus that is not a subtlety - its pole lies almost *in* the ecliptic, so
 * the difference between its axis and Earth's is close to a right angle, and
 * getting it wrong would draw the one planet everybody knows is tipped over as
 * though it were upright (D132).
 *
 * The values are the IAU right ascension and declination of the north pole of
 * rotation at J2000, in degrees. They are given in the **equatorial** frame,
 * which is the frame `starDirection` already speaks, so the conversion is the
 * one the star catalogue uses and not a second one written to disagree with it.
 */

import { equatorialToGlobe, type Vec3 } from './solarFrame';
import { starDirection } from './stars';

export interface Pole {
  raDeg: number;
  decDeg: number;
}

export const POLES: Record<string, Pole> = {
  sun: { raDeg: 286.13, decDeg: 63.87 },
  mercury: { raDeg: 281.01, decDeg: 61.45 },
  venus: { raDeg: 272.76, decDeg: 67.16 },
  mars: { raDeg: 317.68, decDeg: 52.89 },
  jupiter: { raDeg: 268.06, decDeg: 64.5 },
  saturn: { raDeg: 40.589, decDeg: 83.537 },
  uranus: { raDeg: 257.31, decDeg: -15.18 },
  neptune: { raDeg: 299.36, decDeg: 42.95 },
};

/**
 * A body's north pole as a unit vector in the globe frame.
 *
 * Falls back to the globe's own north for anything not in the table, which is
 * the same as not turning the body at all.
 */
export function poleDirection(id: string, date: Date): Vec3 {
  const pole = POLES[id];
  if (!pole) return [0, 1, 0];
  // Right ascension is in hours everywhere `starDirection` is used, and the
  // IAU publishes it in degrees - the one place these two conventions meet.
  const dir = starDirection(pole.raDeg / 15, pole.decDeg);
  return equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, date);
}
