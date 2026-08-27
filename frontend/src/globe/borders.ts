/**
 * Country boundaries, as one line layer.
 *
 * The data is Natural Earth, reduced to shared arcs at build time by
 * `scripts/build-geography.mjs` and served from `public/geo/borders.json`. It
 * costs no API credit, is fetched once, and never changes, so this layer is
 * built exactly once and then only drawn.
 *
 * Two things the drawing has to get right, and they are not the same two as
 * the route layer:
 *
 * - **Densify in lon/lat, not along great circles.** The route layer
 *   interpolates along great circles because an aircraft flying from A to B
 *   follows one (D6). A border does not: the 49th parallel between Canada and
 *   the United States is a line of constant latitude, and the Natural Earth
 *   data stores it as two points thousands of kilometres apart. Interpolating
 *   that as a great circle would bow it north by about 100 km. Interpolating
 *   it in lon/lat holds the parallel, which is what the boundary actually is.
 *
 * - **Lift the line off the surface.** A straight chord between two points one
 *   degree apart sinks about 3.8e-5 radii below the sphere, and a border drawn
 *   at exactly the globe radius z-fights with the texture everywhere else. The
 *   line sits on a shell just above the surface, far below the marker shell so
 *   aircraft still draw over it.
 */

import * as THREE from 'three';

import { latLonToVector3 } from './earth';
import { crossesAntimeridian } from './route';

/**
 * Height of the border shell, in globe radii.
 *
 * Twenty times the worst chord sag at the densification step below, and a
 * fifteenth of MARKER_ALTITUDE, so borders clear the planet without ever
 * reaching the aircraft.
 */
export const BORDER_ALTITUDE = 0.0008;

/**
 * Longest segment, in degrees, before a border arc is subdivided.
 *
 * At one degree the chord sag is 3.8e-5 radii, a twentieth of the shell the
 * line sits on, so no subdivided border dips into the planet. Smaller steps
 * are free to compute and are not free to draw.
 */
export const MAX_SEGMENT_DEG = 1;

export interface BorderData {
  resolution: string;
  /** Flat [lon, lat, lon, lat, ...] per arc. */
  arcs: number[][];
}

export interface BorderLayer {
  line: THREE.LineSegments;
  /** Vertex count actually drawn, for the performance budget. */
  vertexCount: number;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Subdivide one arc so no segment spans more than `maxStep` degrees.
 *
 * Interpolation is linear in lon/lat by design -- see the note at the top of
 * the file. A segment that jumps the antimeridian is dropped rather than
 * drawn: Natural Earth clips its arcs at the dateline, so any such jump is an
 * artefact of the data rather than a boundary that genuinely wraps.
 */
export function densifyArc(arc: number[], maxStep = MAX_SEGMENT_DEG): number[] {
  const out: number[] = [];
  if (arc.length < 4) return out;

  for (let i = 0; i + 3 < arc.length; i += 2) {
    const lon0 = arc[i];
    const lat0 = arc[i + 1];
    const lon1 = arc[i + 2];
    const lat1 = arc[i + 3];

    if (crossesAntimeridian(lon0, lon1)) continue;

    const span = Math.max(Math.abs(lon1 - lon0), Math.abs(lat1 - lat0));
    const steps = Math.max(1, Math.ceil(span / maxStep));

    for (let s = 0; s < steps; s += 1) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      // LineSegments consumes vertex pairs, so each step is emitted twice.
      out.push(lon0 + (lon1 - lon0) * t0, lat0 + (lat1 - lat0) * t0);
      out.push(lon0 + (lon1 - lon0) * t1, lat0 + (lat1 - lat0) * t1);
    }
  }

  return out;
}

/** Build the position buffer for every arc, in world units. */
export function buildBorderPositions(
  data: BorderData,
  globeRadius: number,
  maxStep = MAX_SEGMENT_DEG,
): Float32Array {
  const radius = globeRadius * (1 + BORDER_ALTITUDE);
  const positions: number[] = [];

  for (const arc of data.arcs) {
    const densified = densifyArc(arc, maxStep);
    for (let i = 0; i + 1 < densified.length; i += 2) {
      const point = latLonToVector3(densified[i + 1], densified[i], radius);
      positions.push(point.x, point.y, point.z);
    }
  }

  return new Float32Array(positions);
}

/**
 * Create the border layer.
 *
 * The layer is created empty and filled by `load`, so the globe is interactive
 * before the data arrives and a failed fetch costs a missing line rather than
 * a missing app -- the same rule the aircraft feed follows (D29).
 */
export function createBorderLayer(globeRadius: number): BorderLayer & {
  load(fetchData: () => Promise<BorderData>): Promise<void>;
} {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicMaterial({
    color: 0x8fb3d9,
    transparent: true,
    // Faint on purpose. Borders are a reference grid for the aircraft, not the
    // subject: at full strength a 595-arc web competes with the markers, which
    // is what the layer exists to make readable.
    opacity: 0.28,
    depthWrite: false,
  });

  const line = new THREE.LineSegments(geometry, material);
  line.name = 'borders';
  // The whole planet's worth of arcs is one object with one bounding sphere
  // centred on the globe; three.js would cull it only when the globe itself is
  // off screen, so the test is pure cost.
  line.frustumCulled = false;
  line.visible = false;

  const layer = {
    line,
    vertexCount: 0,
    setVisible(visible: boolean) {
      line.visible = visible && layer.vertexCount > 0;
    },
    async load(fetchData: () => Promise<BorderData>) {
      const data = await fetchData();
      const positions = buildBorderPositions(data, globeRadius);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      layer.vertexCount = positions.length / 3;
      line.visible = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };

  return layer;
}
