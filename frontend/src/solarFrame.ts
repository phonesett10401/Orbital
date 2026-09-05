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
 * ## What Earth being at the origin means
 *
 * MapLibre draws Earth at the centre of its world, so the scene is built
 * around Earth rather than around the Sun: every body's compressed
 * heliocentric position has Earth's subtracted from it. That is not a
 * distortion, it is where the reader is standing. The Sun ends up about one
 * compressed AU away in the direction it really is, and the orbits stay proper
 * rings about it.
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
export function eclipticToGlobe(v: Vector, date: Date): Vec3 {
  const sun = subsolarPoint(date);
  const equatorial = rotateX(v, sun.obliquity * DEG);
  const fixed = rotateZ(equatorial, -earthRotationDeg(date) * DEG);
  // Maths convention (+Z north, +X toward the equinox) into the globe frame
  // (+Y north, +Z on the prime meridian, +X east of it).
  return [fixed.y, fixed.z, fixed.x];
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
export function scenePlacements(date: Date): ScenePlacement[] {
  const earth = compress(planetPosition('earth', date));
  const relative = (helio: Vector): Vec3 => {
    const c = compress(helio);
    return eclipticToGlobe({ x: c.x - earth.x, y: c.y - earth.y, z: c.z - earth.z }, date);
  };

  const out: ScenePlacement[] = [
    { id: 'sun', at: relative({ x: 0, y: 0, z: 0 }), distanceAu: Math.hypot(
      planetPosition('earth', date).x,
      planetPosition('earth', date).y,
      planetPosition('earth', date).z,
    ) },
  ];

  for (const planet of PLANET_IDS) {
    if (planet === 'earth') continue;
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
export function orbitRing(planet: PlanetId, date: Date, samples = 96): Vec3[] {
  const earth = compress(planetPosition('earth', date));
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
      eclipticToGlobe({ x: c.x - earth.x, y: c.y - earth.y, z: c.z - earth.z }, date),
    );
  }
  return points;
}
