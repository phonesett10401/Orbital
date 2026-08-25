/**
 * The marker layer: every tracked object drawn in a single GPU call.
 *
 * Globe.gl's convenient `pointsData()` API creates one mesh per point. At two
 * thousand markers that is two thousand draw calls, and the frame rate dies.
 * So this layer bypasses it: one `THREE.Points`, one `BufferGeometry`, and
 * per-frame writes into typed arrays that are already allocated (D15).
 *
 * Kept separate from the visual layer (globe/earth.ts) so rendering cost stays
 * attributable when we profile (D16).
 */

import * as THREE from 'three';

import type { RenderableObject } from '../types';
import { ageSeconds, positionAt } from './interpolate';
import { latLonToVector3 } from './earth';

/** Objects older than this are drawn muted, with their age shown on selection. */
export const STALE_AFTER_SECONDS = 120;

/**
 * How far above the surface markers float, as a fraction of globe radius.
 *
 * Not physical: a cruising airliner is 0.2% of Earth's radius up, which would
 * put the marker inside the surface texture. This is a legibility offset, and
 * it is uniform so that altitude is conveyed by colour rather than by height
 * (which would be invisible anyway).
 */
const MARKER_ALTITUDE = 0.012;

const vertexShader = /* glsl */ `
  attribute float size;
  attribute vec3 markerColor;
  attribute float dimmed;

  varying vec3 vColor;
  varying float vDimmed;

  void main() {
    vColor = markerColor;
    vDimmed = dimmed;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Attenuate with distance so markers shrink as the camera pulls back,
    // instead of the globe turning into a solid sheet of dots.
    gl_PointSize = size * (300.0 / -viewPosition.z);
    gl_Position = projectionMatrix * viewPosition;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vDimmed;

  void main() {
    // Round points with a soft edge. gl_PointCoord is the square sprite space.
    vec2 offset = gl_PointCoord - vec2(0.5);
    float dist = length(offset);
    if (dist > 0.5) discard;

    float edge = smoothstep(0.5, 0.35, dist);
    float alpha = edge * (vDimmed > 0.5 ? 0.45 : 1.0);
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/**
 * Colour by altitude: low is warm, cruising is cool.
 *
 * Altitude cannot be shown by height at this scale (see MARKER_ALTITUDE), so
 * it is shown by hue instead. Unknown altitude gets its own neutral grey
 * rather than defaulting into the low-altitude band, because `null` means
 * unknown and must not read as "on the ground".
 */
export function altitudeColor(altitude: number | null): [number, number, number] {
  if (altitude === null) return [0.62, 0.62, 0.68];

  const t = Math.min(1, Math.max(0, altitude / 12000));
  // amber (low) -> yellow-green -> cyan (high)
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [1.0, 0.55, 0.2]],
    [0.5, [0.95, 0.9, 0.35]],
    [1.0, [0.35, 0.85, 1.0]],
  ];

  for (let i = 0; i < stops.length - 1; i += 1) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const local = (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * local,
        c0[1] + (c1[1] - c0[1]) * local,
        c0[2] + (c1[2] - c0[2]) * local,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

export interface MarkerLayer {
  points: THREE.Points;
  /** Rewrite the buffers for this frame. Allocates nothing in the steady state. */
  update(objects: RenderableObject[], nowMs: number, selectedId: string | null): void;
  /** Which object is under the pointer, if any. */
  pick(raycaster: THREE.Raycaster): string | null;
  dispose(): void;
}

export function createMarkerLayer(globeRadius: number, capacity = 4096): MarkerLayer {
  let allocated = capacity;

  let positions = new Float32Array(allocated * 3);
  let colors = new Float32Array(allocated * 3);
  let sizes = new Float32Array(allocated);
  let dimmed = new Float32Array(allocated);
  let ids: string[] = [];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('markerColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('dimmed', new THREE.BufferAttribute(dimmed, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'markers';
  // The bounding sphere is computed once by hand: markers move every frame, and
  // recomputing it per frame would traverse the whole buffer for no benefit.
  // Frustum culling is off for the same reason — the layer is always on screen.
  points.frustumCulled = false;

  function grow(required: number): void {
    while (allocated < required) allocated *= 2;
    positions = new Float32Array(allocated * 3);
    colors = new Float32Array(allocated * 3);
    sizes = new Float32Array(allocated);
    dimmed = new Float32Array(allocated);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('markerColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('dimmed', new THREE.BufferAttribute(dimmed, 1));
  }

  function update(
    objects: RenderableObject[],
    nowMs: number,
    selectedId: string | null,
  ): void {
    if (objects.length > allocated) grow(objects.length);

    ids = new Array(objects.length);
    const radius = globeRadius * (1 + MARKER_ALTITUDE);

    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i];
      const { lat, lon } = positionAt(object, nowMs);
      const vector = latLonToVector3(lat, lon, radius);

      positions[i * 3] = vector.x;
      positions[i * 3 + 1] = vector.y;
      positions[i * 3 + 2] = vector.z;

      const stale = ageSeconds(object, nowMs) > STALE_AFTER_SECONDS;
      const selected = object.id === selectedId;

      const [r, g, b] = selected ? [1, 1, 1] : altitudeColor(object.altitude);
      colors[i * 3] = r;
      colors[i * 3 + 1] = g;
      colors[i * 3 + 2] = b;

      sizes[i] = selected ? 9 : 4.5;
      // Stale objects keep their marker rather than disappearing — an aircraft
      // that stopped reporting has not stopped existing — but they are muted so
      // they cannot be mistaken for live traffic.
      dimmed[i] = stale && !selected ? 1 : 0;

      ids[i] = object.id;
    }

    geometry.setDrawRange(0, objects.length);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.markerColor.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
    geometry.attributes.dimmed.needsUpdate = true;
  }

  function pick(raycaster: THREE.Raycaster): string | null {
    // Points raycasting needs an explicit threshold; the default is far too
    // small to hit a 4-pixel sprite reliably.
    raycaster.params.Points.threshold = globeRadius * 0.012;
    const hits = raycaster.intersectObject(points, false);

    for (const hit of hits) {
      const index = hit.index;
      if (index === undefined || index >= ids.length) continue;
      return ids[index];
    }
    return null;
  }

  return {
    points,
    update,
    pick,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
