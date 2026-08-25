/**
 * The route polyline for the selected object.
 *
 * "Route" here means the path we have OBSERVED since the object entered our
 * polling window — not a filed flight plan (D6). The line therefore starts
 * wherever we first saw the aircraft, which may be thirty seconds ago. The
 * detail panel says so in words; this module just draws what it is given.
 *
 * Two things the drawing has to get right:
 *
 * - **Interpolate along great circles**, not between raw points. The backend
 *   samples at the poll interval, so consecutive points can be hundreds of
 *   kilometres apart; a straight segment between them would visibly cut
 *   through the globe.
 * - **Split at the antimeridian.** A segment from +179 to -179 is two degrees
 *   long, but drawn naively it sweeps 358 degrees the wrong way around the
 *   planet — a stripe across the entire map.
 */

import * as THREE from 'three';

import type { TrackPoint } from '../types';
import { latLonToVector3 } from './earth';
import { wrapLongitude } from './interpolate';

/** Slightly above the markers, so the line is not hidden by them. */
const ROUTE_ALTITUDE = 0.0125;

/** Great-circle subdivisions per segment. Enough to look curved, cheap to build. */
const SEGMENT_STEPS = 12;

/** A jump larger than this is treated as an antimeridian wrap, not real travel. */
const WRAP_THRESHOLD_DEG = 180;

export interface RouteLayer {
  line: THREE.LineSegments;
  setTrack(track: TrackPoint[] | null): void;
  dispose(): void;
}

/**
 * Interpolate along the great circle between two points.
 *
 * Uses spherical linear interpolation on the unit vectors, which follows the
 * shortest surface path and behaves correctly across the antimeridian and near
 * the poles — both places where interpolating lat/lon directly goes wrong.
 */
export function greatCirclePoints(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  steps = SEGMENT_STEPS,
  radius = 1,
): THREE.Vector3[] {
  const a = latLonToVector3(from.lat, from.lon, 1);
  const b = latLonToVector3(to.lat, to.lon, 1);

  const dot = Math.min(1, Math.max(-1, a.dot(b)));
  const omega = Math.acos(dot);

  // Coincident or antipodal points have no unique arc; fall back to the ends.
  if (omega < 1e-6) return [a.multiplyScalar(radius), b.multiplyScalar(radius)];

  const sinOmega = Math.sin(omega);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const scaleA = Math.sin((1 - t) * omega) / sinOmega;
    const scaleB = Math.sin(t * omega) / sinOmega;
    out.push(
      new THREE.Vector3(
        (a.x * scaleA + b.x * scaleB) * radius,
        (a.y * scaleA + b.y * scaleB) * radius,
        (a.z * scaleA + b.z * scaleB) * radius,
      ),
    );
  }
  return out;
}

/**
 * Whether a pair of consecutive points wraps the antimeridian.
 *
 * A genuine two-degree hop across the dateline and a 358-degree flight
 * backwards are indistinguishable from the numbers alone, so we assume the
 * short one: aircraft do not teleport, and the poll interval bounds how far
 * anything can have moved.
 */
export function crossesAntimeridian(lonA: number, lonB: number): boolean {
  return Math.abs(lonB - lonA) > WRAP_THRESHOLD_DEG;
}

export function createRouteLayer(globeRadius: number): RouteLayer {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });

  const line = new THREE.LineSegments(geometry, material);
  line.name = 'route';
  line.frustumCulled = false;
  line.visible = false;

  function setTrack(track: TrackPoint[] | null): void {
    if (!track || track.length < 2) {
      line.visible = false;
      geometry.setDrawRange(0, 0);
      return;
    }

    const radius = globeRadius * (1 + ROUTE_ALTITUDE);
    const vertices: number[] = [];

    for (let i = 0; i < track.length - 1; i += 1) {
      const from = track[i];
      const to = track[i + 1];

      // Skip the wrapping segment rather than drawing a stripe across the map.
      // The gap is one poll interval wide and reads as a dashed line, which is
      // a far smaller lie than a line through the Atlantic.
      if (crossesAntimeridian(wrapLongitude(from.lon), wrapLongitude(to.lon))) continue;

      const arc = greatCirclePoints(from, to, SEGMENT_STEPS, radius);
      // LineSegments consumes vertex pairs, so each sub-segment is emitted twice.
      for (let j = 0; j < arc.length - 1; j += 1) {
        vertices.push(arc[j].x, arc[j].y, arc[j].z);
        vertices.push(arc[j + 1].x, arc[j + 1].y, arc[j + 1].z);
      }
    }

    if (vertices.length === 0) {
      line.visible = false;
      geometry.setDrawRange(0, 0);
      return;
    }

    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(vertices), 3),
    );
    geometry.setDrawRange(0, vertices.length / 3);
    geometry.attributes.position.needsUpdate = true;
    line.visible = true;
  }

  return {
    line,
    setTrack,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
