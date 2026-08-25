/**
 * Moving markers smoothly between polls.
 *
 * This is not a polish feature. The backend polls the whole globe every five
 * minutes to stay inside the OpenSky credit budget (D21), so without
 * interpolation every marker would sit motionless and then teleport. Dead
 * reckoning is what makes that interval acceptable — and therefore what makes
 * the quota arithmetic work.
 *
 * Two mechanisms, and they do different jobs:
 *
 * 1. **Dead reckoning.** Project the last known position forward along its
 *    heading at its velocity. This is what produces motion between updates.
 * 2. **Easing.** When a real update arrives the true position will not match
 *    where we had extrapolated to. Snapping there would make every marker jump
 *    in unison on each poll — more jarring than not animating at all — so we
 *    ease from the drawn position to the truth over about a second.
 *
 * All pure functions: no renderer, no globe, no DOM. That is what makes the
 * behaviour testable, which matters because the failure mode is subtle and
 * visual.
 */

import type { RenderableObject, TrackedObject } from '../types';

/** Mean Earth radius in metres (IUGG). Matches the backend's app/geo.py. */
export const EARTH_RADIUS_M = 6_371_008.8;

const DEG = Math.PI / 180;

/** How long to blend from the extrapolated position to a newly received one. */
export const EASE_DURATION_MS = 1000;

/**
 * Stop extrapolating after this long without an update.
 *
 * An aircraft that has not reported for ten minutes has not necessarily flown
 * 150 km in a straight line — it may have turned, landed, or simply dropped
 * out of coverage. Continuing to fly the marker confidently across the map
 * would be inventing data. Past this point the marker holds its last known
 * position, and the UI shows how old it is.
 */
export const MAX_EXTRAPOLATION_MS = 10 * 60 * 1000;

export interface LatLon {
  lat: number;
  lon: number;
}

export function wrapLongitude(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Project a position forward along a great circle.
 *
 * Mirrors `destination_point` in the backend's app/geo.py. Both treat the
 * Earth as a sphere; the ~0.3% ellipsoid difference is a few metres over the
 * distance covered between polls, far below one screen pixel (D12).
 */
export function destinationPoint(
  lat: number,
  lon: number,
  headingDeg: number,
  distanceM: number,
): LatLon {
  if (distanceM === 0) return { lat, lon };

  const angular = distanceM / EARTH_RADIUS_M;
  const lat1 = lat * DEG;
  const lon1 = lon * DEG;
  const bearing = headingDeg * DEG;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAng = Math.sin(angular);
  const cosAng = Math.cos(angular);

  // Clamp against floating-point drift just outside [-1, 1], which would make
  // asin return NaN and silently remove the marker.
  const sinLat2 = Math.min(
    1,
    Math.max(-1, sinLat1 * cosAng + cosLat1 * sinAng * Math.cos(bearing)),
  );
  const lat2 = Math.asin(sinLat2);

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * sinAng * cosLat1,
      cosAng - sinLat1 * sinLat2,
    );

  return { lat: lat2 / DEG, lon: wrapLongitude(lon2 / DEG) };
}

/**
 * Interpolate along the shorter path between two longitudes.
 *
 * Blending 179 to -179 numerically would sweep the marker the long way round
 * the planet. Instead the difference is wrapped into [-180, 180) first.
 */
export function lerpLongitude(from: number, to: number, t: number): number {
  const delta = wrapLongitude(to - from);
  return wrapLongitude(from + delta * t);
}

/** Smoothstep, so eased motion starts and ends gently rather than linearly. */
export function smoothstep(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Where a marker should be drawn right now.
 *
 * Dead-reckons from the last reported position, then eases from wherever the
 * marker was drawn when the update landed. Objects with unknown velocity or
 * heading do not move — an unknown value is not zero, and pretending otherwise
 * would send every stationary aircraft due north.
 */
export function positionAt(object: RenderableObject, nowMs: number): LatLon {
  const sinceUpdate = nowMs - object.updatedAt;

  const canExtrapolate =
    object.velocity !== null &&
    object.heading !== null &&
    object.velocity > 0 &&
    nowMs - object.lastSeenMs < MAX_EXTRAPOLATION_MS;

  let target: LatLon = { lat: object.lat, lon: object.lon };
  if (canExtrapolate) {
    // Extrapolate from when the SOURCE saw it, not from when we received it,
    // otherwise every marker lags by the age of the snapshot.
    const elapsedS = (nowMs - object.lastSeenMs) / 1000;
    target = destinationPoint(
      object.lat,
      object.lon,
      object.heading as number,
      (object.velocity as number) * elapsedS,
    );
  }

  if (sinceUpdate >= EASE_DURATION_MS) return target;

  const t = smoothstep(sinceUpdate / EASE_DURATION_MS);
  return {
    lat: object.fromLat + (target.lat - object.fromLat) * t,
    lon: lerpLongitude(object.fromLon, target.lon, t),
  };
}

/**
 * Fold a freshly polled object into the renderable set.
 *
 * `previous` is what we were drawing, if anything. Easing starts from that
 * drawn position rather than from the previous *reported* position, so a
 * marker never visibly jumps backwards to correct itself.
 */
export function toRenderable(
  object: TrackedObject,
  previous: RenderableObject | undefined,
  nowMs: number,
): RenderableObject {
  const lastSeenMs = Date.parse(object.lastSeen);
  const from = previous
    ? positionAt(previous, nowMs)
    : { lat: object.lat, lon: object.lon };

  return {
    ...object,
    lastSeenMs: Number.isNaN(lastSeenMs) ? nowMs : lastSeenMs,
    fromLat: from.lat,
    fromLon: from.lon,
    renderLat: from.lat,
    renderLon: from.lon,
    updatedAt: nowMs,
  };
}

/**
 * How stale an object is, for display and for muting its marker.
 *
 * The backend keeps last-known positions rather than deleting them, so the
 * frontend has to distinguish "here now" from "here nine minutes ago" — an
 * aircraft that stopped reporting has not stopped existing.
 */
export function ageSeconds(object: RenderableObject, nowMs: number): number {
  return Math.max(0, (nowMs - object.lastSeenMs) / 1000);
}
