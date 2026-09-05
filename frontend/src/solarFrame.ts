/**
 * Putting an inertial solar system inside a rotating Earth-fixed globe.
 *
 * `planets.ts` answers in heliocentric **ecliptic** coordinates, which do not
 * turn. MapLibre's globe frame is **Earth-fixed**: a vertex is a longitude and
 * latitude, so the whole frame spins once a day. Drawing one inside the other
 * without accounting for that would make the planets orbit the sky every
 * twenty-four hours, which is wrong in a way that looks almost right - the
 * motion is real, it just belongs to the Earth (D124).
 *
 * ## Getting the rotation angle without a sidereal-time routine
 *
 * The usual answer is to implement GMST. There is a shorter one here: the Sun
 * is the one body whose position this app already knows in **both** frames.
 * `subsolarPoint` returns its right ascension - inertial - and its subsolar
 * longitude - Earth-fixed - for the same instant. Their difference *is* Earth's
 * rotation angle, so it comes free from a function that already has tests
 * against the equinoxes and solstices.
 *
 * ## The origin is whichever world you are standing on
 *
 * MapLibre draws one globe at the centre of its world, so the scene is built
 * around *that* body rather than around the Sun: every position has the
 * origin body's subtracted from it. Not a distortion - a point of view.
 *
 * It defaults to Earth and **must be passed** once the camera can be
 * elsewhere. The first version hard-coded Earth, so standing on Mars drew the
 * Sun one astronomical unit from where Earth would have been: the orbits were
 * correct rings around a Sun in the wrong place, which is the kind of error
 * that looks like a rendering glitch rather than a wrong assumption (D126).
 */

import { subsolarPoint } from './sun';
import { globeRadiiFor, radiusFor } from './solarScale';
import {
  PLANET_IDS,
  type PlanetId,
  orbitalPeriodDays,
  planetPosition,
  type Vector,
} from './planets';

const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

function rotateX(v: Vector, angleRad: number): Vector {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

/**
 * About the polar axis, which in this convention is **+Z, not +Y**.
 *
 * The first version rotated about Y and put the ecliptic pole 90.7 degrees
 * from the globe's pole instead of 23.44 - a right angle out, from mixing the
 * maths convention (+Z north) with the globe convention (+Y north) inside one
 * function. The reordering to globe axes happens once, at the end, and nothing
 * before it may assume the destination frame (D124).
 */
function rotateZ(v: Vector, angleRad: number): Vector {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/**
 * Earth's rotation angle at `date`, in degrees.
 *
 * Right ascension minus subsolar longitude. Both come from `subsolarPoint`,
 * which is tested against the equinoxes, so this inherits that rather than
 * introducing a second solar model to disagree with the first.
 */
export function earthRotationDeg(date: Date): number {
  const sun = subsolarPoint(date);
  return sun.rightAscension - sun.lon;
}

/**
 * An ecliptic vector, in the frame MapLibre's globe layers use.
 *
 * Three rotations, in order:
 *
 * 1. **ecliptic to equatorial** - about the vernal equinox axis, by the
 *    obliquity. This is what makes the planets lie in their own plane rather
 *    than in Earth's equator, tilted the 23.44 degrees they really are.
 * 2. **equatorial to Earth-fixed** - about the polar axis, which is +Z here,
 *    by Earth's rotation angle. Without this the sky turns with the ground.
 * 3. **axis convention** - `modelFrame.sphereVector` puts north along +Y and
 *    the prime meridian along +Z, so the result is reordered to match rather
 *    than left in the maths convention where +Z is north.
 */
/**
 * An **equatorial** vector, in the globe frame.
 *
 * The star catalogue is already equatorial - right ascension and declination -
 * so it needs Earth's rotation but not the obliquity tilt. Applying the tilt
 * to a star would lean the whole sky by 23 degrees against the ecliptic, which
 * is exactly the error that looks like a plausible sky (D128).
 */
export function equatorialToGlobe(v: Vector, date: Date): Vec3 {
  const fixed = rotateZ(v, -earthRotationDeg(date) * DEG);
  return [fixed.y, fixed.z, fixed.x];
}

export function eclipticToGlobe(v: Vector, date: Date): Vec3 {
  // Tilt into the equatorial frame, then hand over: the two paths differ by
  // exactly the obliquity and share everything after it, so they cannot drift.
  const sun = subsolarPoint(date);
  return equatorialToGlobe(rotateX(v, sun.obliquity * DEG), date);
}

/** A body's place in the drawn scene: a globe-frame vector, in globe radii. */
export interface ScenePlacement {
  id: PlanetId | 'sun';
  /** Direction and distance from Earth, in multiples of the globe's radius. */
  at: Vec3;
  /** True heliocentric distance in AU, for the panel to state honestly. */
  distanceAu: number;
}

/**
 * Compress a heliocentric position, keeping its direction exactly.
 *
 * The compression is radial and nothing else - this is the same bargain
 * `satelliteShell` struck and D122 restated: **the arrangement is true and the
 * distances are not.**
 */
function compress(helio: Vector): Vector {
  const r = Math.hypot(helio.x, helio.y, helio.z);
  if (r === 0) return { x: 0, y: 0, z: 0 };
  const scaled = globeRadiiFor(radiusFor(r));
  return { x: (helio.x / r) * scaled, y: (helio.y / r) * scaled, z: (helio.z / r) * scaled };
}

/**
 * Where to draw the Sun and every planet, with Earth at the origin.
 *
 * Earth is absent from the result by construction: it is the origin, and
 * MapLibre is already drawing it.
 */
export function scenePlacements(date: Date, origin: PlanetId = 'earth'): ScenePlacement[] {
  const centre = compress(planetPosition(origin, date));
  const relative = (helio: Vector): Vec3 => {
    const c = compress(helio);
    return eclipticToGlobe({ x: c.x - centre.x, y: c.y - centre.y, z: c.z - centre.z }, date);
  };

  // The Sun's distance is the *origin body's* heliocentric distance, not
  // Earth's. This line kept saying Earth after the rest of the function had
  // been parameterised - the same assumption twice, one of them in the field
  // nobody was looking at (D126).
  const centreHelio = planetPosition(origin, date);
  const out: ScenePlacement[] = [
    {
      id: 'sun',
      at: relative({ x: 0, y: 0, z: 0 }),
      distanceAu: Math.hypot(centreHelio.x, centreHelio.y, centreHelio.z),
    },
  ];

  for (const planet of PLANET_IDS) {
    if (planet === origin) continue;
    const helio = planetPosition(planet, date);
    out.push({
      id: planet,
      at: relative(helio),
      distanceAu: Math.hypot(helio.x, helio.y, helio.z),
    });
  }
  return out;
}

/**
 * One orbit as a closed ring of globe-frame points.
 *
 * Sampled from the planet's own motion over a whole period rather than from an
 * idealised ellipse, so the drawn path is the path the planet will actually
 * take - inclination, eccentricity and all - rather than a circle standing in
 * for one.
 */
export function orbitRing(
  planet: PlanetId,
  date: Date,
  samples = 96,
  origin: PlanetId = 'earth',
): Vec3[] {
  const centre = compress(planetPosition(origin, date));
  // From the semi-major axis, not from where the planet happens to be today.
  // Using the current distance closed an eccentric orbit's ring 32 degrees
  // short of itself, because Mercury at aphelion implies a period a fifth
  // longer than Mercury at perihelion does.
  const periodMs = orbitalPeriodDays(planet) * 86_400_000;

  const points: Vec3[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const at = new Date(date.getTime() + (periodMs * i) / samples);
    const c = compress(planetPosition(planet, at));
    points.push(
      eclipticToGlobe({ x: c.x - centre.x, y: c.y - centre.y, z: c.z - centre.z }, date),
    );
  }
  return points;
}

/**
 * Where on the globe a scene direction points, in degrees.
 *
 * The exact inverse of `modelFrame.sphereVector`, which puts north along +Y
 * and the prime meridian along +Z. Needed because a trip to another planet has
 * to move the camera *toward* it, and MapLibre steers by longitude and
 * latitude rather than by a vector (D136).
 *
 * The length is discarded on purpose: a planet's direction is what a camera
 * can aim at, and its compressed distance is not a place the camera can go.
 */
export function lonLatOf(v: Vec3): { lon: number; lat: number } {
  const [x, y, z] = v;
  const length = Math.hypot(x, y, z);
  if (length === 0) return { lon: 0, lat: 0 };
  const lat = Math.asin(Math.max(-1, Math.min(1, y / length))) / DEG;
  const lon = Math.atan2(x, z) / DEG;
  return { lon, lat };
}
