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

/** The thin line bridging a stretch nobody watched. */
export const ROUTE_GAP_LAYER = 'orbital-route-gap';

/**
 * The segment joining the last reported position to where the aircraft is
 * being drawn right now.
 *
 * A separate source, and the reason is both honesty and cost.
 *
 * **Honesty:** the track is what was reported (D6). The marker is drawn at its
 * *interpolated* position, because a marker that only moved once per poll
 * would visibly step (D14). Those are two different claims - one observed, one
 * estimated - and the gap between them is real: `age x speed`, up to the
 * staleness threshold's worth of it (D71). Drawing that gap as more track
 * would file the estimate as an observation. It is drawn dashed instead, so
 * the line reaches the aircraft and still says which part of itself is a
 * guess.
 *
 * **Cost:** the observed track is a densified great-circle polyline and
 * rebuilding it every frame is the expensive part of this layer (D6, D65).
 * This is two points. It can be rewritten on the frame loop, next to the
 * aircraft it is chasing, while the track behind it is rebuilt only when a
 * poll actually adds to it.
 */
export const LEADER_SOURCE = 'orbital-route-leader';
export const LEADER_LAYER = 'orbital-route-leader';
export const LEADER_CASING_LAYER = 'orbital-route-leader-casing';

/**
 * The departure airport, drawn where the track begins.
 *
 * A line that starts at a runway says so much more clearly with a mark on the
 * runway, and the airport's name is in the panel where there is room for it.
 * Empty whenever the origin is unknown - a flight the network picked up in
 * mid-air has no departure point to draw, and inventing one at the start of
 * the track would be claiming exactly what the panel is careful not to (D78).
 */
export const ORIGIN_SOURCE = 'orbital-origin';
export const ORIGIN_LAYER = 'orbital-origin';
export const ORIGIN_LABEL_LAYER = 'orbital-origin-label';

/** Great-circle subdivisions per segment. Enough to look curved, cheap to build. */
export const SEGMENT_STEPS = 12;

/** A jump larger than this between samples is the antimeridian, not travel. */
const WRAP_THRESHOLD_DEG = 180;

const DEG = Math.PI / 180;

export interface RouteFeature {
  type: 'Feature';
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
  properties: { gap: boolean };
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
/**
 * How long a silence has to be before the track admits it is guessing.
 *
 * Coverage gaps are ordinary rather than exceptional: of ten live tracks
 * checked, **eight contained a gap of over five minutes**, some of them
 * sixteen. Drawn as ordinary track those minutes become a confident straight
 * line through country nobody watched the aircraft cross, which is the same
 * claim the panel is careful not to make about the route as a whole (D6, D82).
 *
 * Five minutes is comfortably longer than the six-second sampling and than any
 * ordinary hiccup in it.
 */
export const ROUTE_GAP_SECONDS = 300;

/**
 * And the speed above which a segment is a gap however short it looks.
 *
 * The backend deletes waypoints that are impossible to reach *and* impossible
 * to leave, which catches a lone spike. It cannot catch a **step change** -
 * where the position jumps once and the points after it are self-consistent -
 * because only one side of that is wrong. Measured on live tracks after
 * cleaning: ten tracks still carried fourteen segments implying over 400 m/s.
 *
 * Whatever produced them, the aircraft did not fly that segment at that speed,
 * so we do not know how it got there - which is the definition of a gap, and
 * is drawn as one (D82). Same ceiling as the speed correction (D81).
 */
export const ROUTE_MAX_SPEED_MS = 400;

/** Metres between two points on the sphere. */
function metresBetween(a: TrackPoint, b: TrackPoint): number {
  const R = 6_371_008.8;
  const phi1 = (a.lat * Math.PI) / 180;
  const phi2 = (b.lat * Math.PI) / 180;
  const dPhi = phi2 - phi1;
  const dLambda = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The observed track, split wherever the aircraft went unwatched.
 *
 * Returns one feature per continuous run, plus a `gap: true` feature bridging
 * each silence, so the two can be drawn differently: solid for what was seen,
 * thin and dashed for what was inferred. Flightradar does the same thing and
 * for the same reason - a line is a claim, and these two parts of it are not
 * claims of equal strength.
 */
export function routeFeatures(track: TrackPoint[] | null | undefined): RouteCollection {
  if (!track || track.length < 2) return emptyRoute();

  const features: RouteFeature[] = [];
  let run: Array<[number, number]> = [];

  const flush = () => {
    if (run.length >= 2) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: unwrapLongitudes(run) },
        properties: { gap: false },
      });
    }
    run = [];
  };

  for (let i = 0; i < track.length - 1; i += 1) {
    const from = track[i];
    const to = track[i + 1];
    const silence = (Date.parse(to.timestamp) - Date.parse(from.timestamp)) / 1000;
    const arc = greatCircleLatLon(from, to);
    // Either we were not watching for long enough to know, or what we have
    // could not have happened. Both mean the same thing to a reader.
    const impossible = silence > 0 && metresBetween(from, to) / silence > ROUTE_MAX_SPEED_MS;

    if (silence > ROUTE_GAP_SECONDS || impossible) {
      // End the observed run at this point, bridge the silence with its own
      // feature, and start the next run on the far side of it.
      if (run.length === 0) run.push(arc[0]);
      else run.push(arc[0]);
      flush();
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: unwrapLongitudes(arc) },
        properties: { gap: true },
      });
      run = [arc[arc.length - 1]];
      continue;
    }

    // The last point of each arc is the first of the next, so it is dropped
    // except at the very end -- otherwise every sample is duplicated.
    const slice = i === track.length - 2 ? arc : arc.slice(0, -1);
    run.push(...slice);
  }
  flush();

  return { type: 'FeatureCollection', features };
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
      // Only the observed runs. A casing under the gap line would make the
      // guess as heavy as the evidence.
      filter: ['!', ['get', 'gap']],
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
      filter: ['!', ['get', 'gap']],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 12, 3],
      },
    },
    {
      // Thin, dashed, and no casing: a stretch of flight nobody watched, drawn
      // so it cannot be mistaken for one that was. Same shape as the leader
      // that joins the track to the aircraft, and for the same reason - both
      // are inference rather than observation (D72, D82).
      id: ROUTE_GAP_LAYER,
      type: 'line',
      source: ROUTE_SOURCE,
      filter: ['get', 'gap'],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(255, 255, 255, 0.75)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1, 12, 1.6],
        'line-dasharray': [2.5, 2],
      },
    },
  ];
}

/**
 * The dashed segment from the last reported position to the drawn one.
 *
 * Empty whenever there is nothing honest to draw: no selection, no track to
 * hang it off, or an aircraft being held at its last reported position because
 * the data went stale (D71) - in which case the marker *is* the last reported
 * position and there is no gap to bridge.
 *
 * Great-circle rather than a straight segment, for the same reason the track
 * is (D44): it is a few kilometres here and the difference is invisible, but
 * two ways of joining two points on a sphere is one way too many.
 */
export function leaderFeature(
  track: TrackPoint[] | null | undefined,
  head: { lat: number; lon: number } | null,
): RouteCollection {
  const last = track && track.length > 0 ? track[track.length - 1] : null;
  if (!last || !head) return emptyRoute();
  const arc = unwrapLongitudes(greatCircleLatLon(last, head, 8));
  // A zero-length line is not drawn by MapLibre, but it is also not worth
  // handing over: the two coincide exactly whenever extrapolation is off.
  if (Math.abs(head.lat - last.lat) < 1e-9 && Math.abs(head.lon - last.lon) < 1e-9) {
    return emptyRoute();
  }
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { gap: false },
        geometry: { type: 'LineString', coordinates: arc },
      },
    ],
  };
}

/**
 * The leader's two layers, matching the track's casing-and-line pair (D59) so
 * it reads as the same line, and dashed so it does not claim to be observed.
 */
export function leaderLayers(): import('maplibre-gl').LayerSpecification[] {
  return [
    {
      id: LEADER_CASING_LAYER,
      type: 'line',
      source: LEADER_SOURCE,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': 'rgba(0, 0, 0, 0.55)',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 12, 6],
        'line-dasharray': [1.6, 1.1],
      },
    },
    {
      id: LEADER_LAYER,
      type: 'line',
      source: LEADER_SOURCE,
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.5, 12, 3],
        'line-dasharray': [1.6, 1.1],
      },
    },
  ];
}

export interface OriginPoint {
  lat: number;
  lon: number;
  icao: string;
}

/** The origin airport as a one-point collection, or an empty one. */
export function originFeature(origin: OriginPoint | null | undefined): {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: { icao: string };
    geometry: { type: 'Point'; coordinates: [number, number] };
  }>;
} {
  if (!origin) return { type: 'FeatureCollection', features: [] };
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { icao: origin.icao },
        geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] },
      },
    ],
  };
}

/**
 * A ring at the airport and its code beside it.
 *
 * A ring rather than a filled dot: the aircraft are filled shapes, and a
 * departure point is not another aircraft. It carries the same dark casing
 * every other line on this map does, for the same reason - it has to read over
 * a photograph and over a pale basemap (D59).
 */
export function originLayers(): import('maplibre-gl').LayerSpecification[] {
  return [
    {
      id: ORIGIN_LAYER,
      type: 'circle',
      source: ORIGIN_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 3.5, 10, 6],
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
        'circle-opacity': 1,
      },
    },
    {
      id: ORIGIN_LABEL_LAYER,
      type: 'symbol',
      source: ORIGIN_SOURCE,
      minzoom: 4,
      layout: {
        'text-field': ['get', 'icao'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0, 0, 0, 0.85)',
        'text-halo-width': 1.4,
      },
    },
  ];
}
