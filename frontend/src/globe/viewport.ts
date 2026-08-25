/**
 * Working out what the camera can see, as a bounding box.
 *
 * globe.gl reports the camera as a point of view — latitude, longitude, and an
 * altitude measured in globe radii above the surface — rather than as visible
 * bounds. Converting one to the other is what lets the client tell the backend
 * where the user is looking, which is what drives the fast tier 2 poll (D21).
 *
 * This is an approximation and knowingly so: the visible region of a sphere is
 * a circular cap, not a lat/lon rectangle, and near the poles the two diverge
 * sharply. The box is therefore an over-estimate — it always contains
 * everything visible, and near the poles contains rather more. Over-covering
 * is the safe direction: the backend filters again, and the alternative is
 * aircraft missing from the edge of the screen.
 */

import type { BoundingBox } from '../types';

export interface PointOfView {
  lat: number;
  lng: number;
  /** Camera height above the surface, in globe radii. */
  altitude: number;
}

/**
 * Angular radius of the visible cap, in degrees.
 *
 * For a camera at radius `1 + altitude` looking at a unit sphere, the horizon
 * sits where the line of sight is tangent — giving `cos(theta) = 1/(1+alt)`.
 */
export function visibleAngularRadius(altitude: number): number {
  const clamped = Math.max(altitude, 1e-6);
  return (Math.acos(1 / (1 + clamped)) * 180) / Math.PI;
}

/**
 * The visible cap is wide enough past this that a box stops being a filter.
 *
 * A cap of 60 degrees already spans 120 degrees of latitude — two thirds of
 * the globe — and near the poles it spans every meridian. Sending that box
 * would filter almost nothing while implying to the backend that the user is
 * looking somewhere specific, so above this we send no box at all.
 */
const WHOLE_GLOBE_RADIUS_DEG = 60;

/**
 * A bounding box containing everything the camera can see.
 *
 * Returns `null` when the visible region spans so much of the globe that a box
 * is meaningless — at that zoom the backend should just serve everything, and
 * the tier 2 poll would be skipped anyway.
 */
export function viewportBBox(pov: PointOfView): BoundingBox | null {
  const radius = visibleAngularRadius(pov.altitude);
  if (radius >= WHOLE_GLOBE_RADIUS_DEG) return null;

  const latMin = Math.max(-90, pov.lat - radius);
  const latMax = Math.min(90, pov.lat + radius);

  // Longitude lines converge toward the poles, so a cap of fixed angular
  // radius spans more longitude the further from the equator it sits.
  const cosLat = Math.cos((pov.lat * Math.PI) / 180);
  const lonSpan = cosLat < 0.02 ? 180 : Math.min(180, radius / cosLat);

  if (lonSpan >= 180) {
    return { latMin, lonMin: -180, latMax, lonMax: 180 };
  }

  return {
    latMin,
    latMax,
    lonMin: wrap(pov.lng - lonSpan),
    lonMax: wrap(pov.lng + lonSpan),
  };
}

function wrap(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Whether two boxes differ enough to be worth a new request.
 *
 * Without this, every frame of a camera drag would fire a fetch. The threshold
 * is in degrees and deliberately coarse — the backend snaps the box to its own
 * grid anyway, so sub-degree precision buys nothing.
 */
export function bboxChanged(
  a: BoundingBox | null,
  b: BoundingBox | null,
  thresholdDeg = 1,
): boolean {
  if (a === null || b === null) return a !== b;
  return (
    Math.abs(a.latMin - b.latMin) > thresholdDeg ||
    Math.abs(a.latMax - b.latMax) > thresholdDeg ||
    Math.abs(a.lonMin - b.lonMin) > thresholdDeg ||
    Math.abs(a.lonMax - b.lonMax) > thresholdDeg
  );
}
