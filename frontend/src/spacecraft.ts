/**
 * Spacecraft geometry, built in code, one shape per family.
 *
 * The counterpart to `airframe.ts`: that file builds an aeroplane for the
 * selected aircraft, this one builds a satellite for the selected satellite.
 * Both exist because the crowd is drawn as silhouettes and the *selection* is
 * drawn as the thing itself — a sprite carries identity at 10 px, geometry
 * carries it once an object is big enough to repay the triangles (D42, D67,
 * D106).
 *
 * ## The frame these are built in
 *
 * `modelFrame.ts` hands the mesh a tangent frame where **+Y is up, away from
 * the Earth**, **+Z is the direction of travel**, and +X completes it. So:
 *
 * - Solar arrays extend along **X**, which is how they sit on a real
 *   spacecraft relative to its orbit — perpendicular to the direction of
 *   travel, rotating to face the Sun.
 * - Antennas, dishes and imaging instruments point along **−Y**, at the ground
 *   they are talking to or looking at.
 * - A truss runs along **X**, which is what makes a station read as a station.
 *
 * That is not decoration: it is why these look right rather than merely
 * different from each other.
 *
 * ## Sizes are real, and mostly will not matter
 *
 * `SPAN_METRES` holds each family's actual span — the ISS really is 109 m tip
 * to tip, a Starlink about 9 m. At the zoom the shell is drawn at, every one of
 * them is far under a pixel, so the model layer's pixel floor decides the size
 * and these numbers do nothing. They are here because they are true, they cost
 * nothing, and they become the right answer the moment somebody zooms in.
 */

import * as THREE from 'three';

import type { SatelliteFamily } from './satelliteFamily';

/**
 * Every geometry is normalised so its widest extent is 1 unit.
 *
 * Same convention as `airframe.ts`: the model layer scales by a span in metres,
 * so the geometry must be unit-span or the scaling means nothing.
 */
export const SPACECRAFT_SPAN_UNITS = 1;

/** Real tip-to-tip span, in metres. */
export const SPAN_METRES: Record<SatelliteFamily, number> = {
  station: 109, // the ISS truss
  constellation: 9, // a Starlink with its single array
  navigation: 17, // GPS Block III
  observation: 14, // a NOAA-class weather satellite
  geoComms: 31, // a large geostationary bus, arrays extended
  probe: 5, // Cluster II, a spinning drum
  satellite: 10, // unremarkable, because we do not know
  unidentified: 8,
};

/** A flat solar array: wide in X, thin in Y, tall in Z. */
function array(width: number, length: number, x: number): THREE.BufferGeometry {
  const panel = new THREE.BoxGeometry(width, 0.012, length);
  panel.translate(x, 0, 0);
  return panel;
}

/** The spacecraft body. */
function bus(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** A dish or instrument looking at the ground, along -Y. */
function dish(radius: number, depth: number, y: number): THREE.BufferGeometry {
  const cone = new THREE.ConeGeometry(radius, depth, 12, 1, true);
  // A cone points +Y by default; flip it to look down at the planet.
  cone.rotateX(Math.PI);
  cone.translate(0, y, 0);
  return cone;
}

function boom(length: number, y: number): THREE.BufferGeometry {
  const rod = new THREE.CylinderGeometry(0.012, 0.012, length, 6);
  rod.rotateZ(Math.PI / 2);
  rod.translate(0, y, 0);
  return rod;
}

/**
 * Merge parts into one geometry.
 *
 * Written by hand rather than pulled from `BufferGeometryUtils` to keep the
 * import surface small — the same reason `airframe.ts` composes its own.
 */
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];

  for (const part of parts) {
    const nonIndexed = part.index ? part.toNonIndexed() : part;
    const position = nonIndexed.getAttribute('position');
    const normal = nonIndexed.getAttribute('normal');
    for (let i = 0; i < position.count; i += 1) {
      positions.push(position.getX(i), position.getY(i), position.getZ(i));
      normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
    }
    if (nonIndexed !== part) nonIndexed.dispose();
    part.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geometry;
}

const BUILD: Record<SatelliteFamily, () => THREE.BufferGeometry> = {
  // A truss with four arrays and a spine of modules. The widest thing in
  // orbit, and the only one whose arrays come in pairs along an axis.
  station: () =>
    merge([
      bus(0.96, 0.05, 0.05), // truss
      bus(0.13, 0.11, 0.32), // pressurised modules, along the direction of travel
      array(0.18, 0.4, -0.4),
      array(0.18, 0.4, -0.15),
      array(0.18, 0.4, 0.15),
      array(0.18, 0.4, 0.4),
    ]),

  // One array, off to a side. The asymmetry is the whole recognisable feature.
  constellation: () =>
    merge([bus(0.2, 0.06, 0.28), array(0.62, 0.5, 0.34)]),

  // Two arrays and an antenna aimed at the hemisphere below.
  navigation: () =>
    merge([bus(0.22, 0.22, 0.22), array(0.28, 0.34, -0.3), array(0.28, 0.34, 0.3), dish(0.09, 0.14, -0.18)]),

  // A tall body, one array, and an instrument looking straight down.
  observation: () =>
    merge([bus(0.2, 0.3, 0.22), array(0.42, 0.32, 0.34), dish(0.07, 0.16, -0.22)]),

  // Two arrays and a large dish. The dish is what separates it from
  // navigation, so it is drawn big enough to be unmistakable.
  geoComms: () =>
    merge([bus(0.24, 0.22, 0.24), array(0.3, 0.3, -0.3), array(0.3, 0.3, 0.3), dish(0.17, 0.22, -0.2)]),

  // A drum with booms and no arrays at all - spin-stabilised, body-mounted.
  probe: () => {
    const drum = new THREE.CylinderGeometry(0.22, 0.22, 0.2, 6);
    return merge([drum, boom(0.88, 0), boom(0.48, 0.14)]);
  },

  // A named satellite whose family we could not place. A plain bus with two
  // short arrays: unmistakably a spacecraft, committing to nothing about which
  // kind (D102).
  satellite: () =>
    merge([bus(0.26, 0.22, 0.26), array(0.2, 0.24, -0.3), array(0.2, 0.24, 0.3)]),

  // The catalogue does not know what this is, so neither does the geometry. An
  // octahedron is a marker in three dimensions - it says "an object" and
  // nothing more, the same claim the flat view's dot makes.
  unidentified: () => new THREE.OctahedronGeometry(0.28, 0),
};

/**
 * Geometries are built once and shared.
 *
 * There are eight of them and the selection changes often, so rebuilding on
 * every selection would allocate and discard buffers for no reason. Same cache
 * as `aircraftGeometryFor`.
 */
const cache = new Map<SatelliteFamily, THREE.BufferGeometry>();

export function spacecraftGeometryFor(family: SatelliteFamily): THREE.BufferGeometry {
  const existing = cache.get(family);
  if (existing) return existing;
  const built = BUILD[family]();
  built.computeBoundingSphere();
  cache.set(family, built);
  return built;
}

/** Release the cache. Called when the layer holding these goes away. */
export function disposeSpacecraft(): void {
  for (const geometry of cache.values()) geometry.dispose();
  cache.clear();
}
