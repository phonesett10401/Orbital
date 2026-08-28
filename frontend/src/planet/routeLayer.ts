/**
 * The observed track of the selected aircraft, as MapLibre layers.
 *
 * "Route" means the path we have *watched* since the aircraft entered our
 * polling window — not a filed flight plan (D6). The detail panel says so in
 * words; this module draws what it is given, and the two things it has to get
 * right are the same two the globe's version did, arrived at differently.
 *
 * **Interpolate along great circles.** The backend samples at the poll
 * interval, so consecutive points can be hundreds of kilometres apart. On a
 * Mercator map a straight segment between two such points is a rhumb line,
 * which is not the path the aircraft flew: from London to Tokyo it runs
 * hundreds of kilometres south of the truth. This is the opposite of the
 * border layer's rule (D44), and for the opposite reason — an aircraft flies a
 * great circle, a boundary follows a parallel.
 *
 * **Do not let the line wrap the world.** A track from +179 to -179 is two
 * degrees of travel and, drawn from the raw coordinates, a stripe all the way
 * back across the map. The globe layer solved this by dropping the segment
 * (D6); here the longitudes are *unwrapped* instead — allowed to run past 180
 * — which MapLibre draws correctly and which loses nothing.
 */

import type { TrackPoint } from '../types';

/** Ids, exported so the view can add and update them. */
export const ROUTE_SOURCE = 'orbital-route';
export const ROUTE_LAYER = 'orbital-route';
export const ROUTE_CASING_LAYER = 'orbital-route-casing';

/** Great-circle subdivisions per segment. Enough to look curved, cheap to build. */
export const SEGMENT_STEPS = 12;

/** A jump larger than this between samples is the antimeridian, not travel. */
const WRAP_THRESHOLD_DEG = 180;

const DEG = Math.PI / 180;

export interface RouteFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  properties: Record<string, never>;
}

export type RouteCollection = {
  type: 'FeatureCollection';
  features: RouteFeature[];
};

/** An empty collection, for when there is nothing selected or nothing to draw. */
export function emptyRoute(): RouteCollection {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Interpolate along the great circle between two points.
 *
 * Spherical linear interpolation on the unit vectors, which follows the
 * shortest surface path and behaves correctly across the antimeridian and near
 * the poles — the two places interpolating lat/lon directly goes wrong.
 * Transcribed rather than shared with the globe's version, which works in
 * three-dimensional scene coordinates: a shared helper would have to be right
 * for both and is a worse fit for each.
 */
export function greatCircleLatLon(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  steps = SEGMENT_STEPS,
): Array<[number, number]> {
  const toVector = ({ lat, lon }: { lat: number; lon: number }) => [
    Math.cos(lat * DEG) * Math.cos(lon * DEG),
    Math.cos(lat * DEG) * Math.sin(lon * DEG),
    Math.sin(lat * DEG),
  ];

  const a = toVector(from);
  const b = toVector(to);
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);

  // Coincident or antipodal: no unique arc, so give back the ends.
  if (omega < 1e-9) {
    return [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ];
  }

  const sinOmega = Math.sin(omega);
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const scaleA = Math.sin((1 - t) * omega) / sinOmega;
    const scaleB = Math.sin(t * omega) / sinOmega;
    const x = a[0] * scaleA + b[0] * scaleB;
    const y = a[1] * scaleA + b[1] * scaleB;
    const z = a[2] * scaleA + b[2] * scaleB;
    out.push([
      (Math.atan2(y, x) / DEG),
      (Math.asin(z / Math.hypot(x, y, z)) / DEG),
    ]);
  }
  return out;
}

/**
 * Keep a line continuous across the antimeridian.
 *
 * Each longitude is shifted by whole turns so it stays within half a world of
 * the one before it. The result runs past 180 rather than jumping to -180, and
 * MapLibre draws that as the short way round — which is the way the aircraft
 * actually went.
 */
export function unwrapLongitudes(coordinates: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let offset = 0;

  coordinates.forEach(([lon, lat], index) => {
    if (index > 0) {
      const previous = coordinates[index - 1][0] + offset;
      const candidate = lon + offset;
      if (candidate - previous > WRAP_THRESHOLD_DEG) offset -= 360;
      else if (previous - candidate > WRAP_THRESHOLD_DEG) offset += 360;
    }
    out.push([lon + offset, lat]);
  });

  return out;
}

/**
 * The track as a single GeoJSON line, or an empty collection.
 *
 * One point is a position, not a path: two are the minimum that can be drawn,
 * and the panel already explains that a route builds up as the aircraft is
 * watched.
 */
export function routeFeatures(track: TrackPoint[] | null | undefined): RouteCollection {
  if (!track || track.length < 2) return emptyRoute();

  const coordinates: Array<[number, number]> = [];
  for (let i = 0; i < track.length - 1; i += 1) {
    const arc = greatCircleLatLon(track[i], track[i + 1]);
    // The last point of each arc is the first of the next, so it is dropped
    // except at the very end -- otherwise every sample is duplicated.
    const slice = i === track.length - 2 ? arc : arc.slice(0, -1);
    coordinates.push(...slice);
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: unwrapLongitudes(coordinates) },
        properties: {},
      },
    ],
  };
}

/**
 * Two layers: a dark casing and a bright line over it.
 *
 * The same reasoning as the cartography's roads (D59). A single white line is
 * invisible over pale terrain and a single dark one is invisible over water;
 * the pair reads on both, which matters more here than anywhere else, since
 * the route is the answer to "where has this aircraft been".
 */
export function routeLayers(): import('maplibre-gl').LayerSpecification[] {
  return [
    {
      id: ROUTE_CASING_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(0, 0, 0, 0.55)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 12, 6],
      },
    },
    {
      id: ROUTE_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 12, 3],
      },
    },
  ];
}
