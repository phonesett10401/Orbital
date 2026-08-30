/**
 * Tests for the observed track on the planet view.
 *
 * Two things carry the layer, and they pull in opposite directions from the
 * border layer's rules, which is why both are pinned rather than assumed: a
 * route follows a great circle because that is what an aircraft flies, where a
 * boundary follows a parallel because that is what a boundary is (D44); and a
 * track across the antimeridian is made continuous rather than dropped.
 */

import { describe, expect, it } from 'vitest';

import type { TrackPoint } from '../types';
import {
  LEADER_SOURCE,
  ORIGIN_LABEL_LAYER,
  ORIGIN_LAYER,
  ORIGIN_SOURCE,
  ROUTE_CASING_LAYER,
  ROUTE_LAYER,
  ROUTE_SOURCE,
  leaderFeature,
  leaderLayers,
  originFeature,
  originLayers,
  greatCircleLatLon,
  routeFeatures,
  routeLayers,
  unwrapLongitudes,
} from './routeLayer';

function point(lat: number, lon: number): TrackPoint {
  return { lat, lon, altitude: 10_000, timestamp: '2026-08-28T12:00:00Z' };
}

describe('greatCircleLatLon', () => {
  it('keeps the endpoints', () => {
    const arc = greatCircleLatLon({ lat: 51.5, lon: -0.1 }, { lat: 35.7, lon: 139.7 }, 8);
    expect(arc[0][0]).toBeCloseTo(-0.1, 6);
    expect(arc[0][1]).toBeCloseTo(51.5, 6);
    expect(arc[arc.length - 1][0]).toBeCloseTo(139.7, 6);
    expect(arc[arc.length - 1][1]).toBeCloseTo(35.7, 6);
  });

  it('bows toward the pole, which is the path actually flown', () => {
    // London to Tokyo: the great circle runs far north of the straight line a
    // Mercator map would draw between them. Drawing the straight line would
    // put the aircraft hundreds of kilometres from where it went.
    const london = { lat: 51.5, lon: -0.1 };
    const tokyo = { lat: 35.7, lon: 139.7 };
    const arc = greatCircleLatLon(london, tokyo, 12);
    const midpoint = arc[6];
    const straightLat = (london.lat + tokyo.lat) / 2;
    expect(midpoint[1]).toBeGreaterThan(straightLat + 10);
  });

  it('handles coincident points without dividing by zero', () => {
    const arc = greatCircleLatLon({ lat: 13.75, lon: 100.5 }, { lat: 13.75, lon: 100.5 });
    expect(arc).toHaveLength(2);
    expect(arc[0]).toEqual([100.5, 13.75]);
  });
});

describe('unwrapLongitudes', () => {
  it('leaves an ordinary line alone', () => {
    const line: Array<[number, number]> = [
      [100, 13],
      [101, 13],
      [102, 13],
    ];
    expect(unwrapLongitudes(line)).toEqual(line);
  });

  it('carries a crossing past 180 instead of jumping back', () => {
    // Two degrees of travel. Drawn from the raw coordinates it is a stripe all
    // the way back across the map; unwrapped it is two degrees.
    const crossing: Array<[number, number]> = [
      [179, 10],
      [-179, 10],
    ];
    const [first, second] = unwrapLongitudes(crossing);
    expect(first[0]).toBe(179);
    expect(second[0]).toBe(181);
    expect(Math.abs(second[0] - first[0])).toBe(2);
  });

  it('works westward too, and across several turns', () => {
    const westward: Array<[number, number]> = [
      [-179, 0],
      [179, 0],
      [177, 0],
    ];
    const unwrapped = unwrapLongitudes(westward);
    expect(unwrapped.map(([lon]) => lon)).toEqual([-179, -181, -183]);
  });
});

describe('routeFeatures', () => {
  it('draws nothing for a track too short to be a path', () => {
    // One point is a position. The panel already explains that a route builds
    // up as the aircraft is watched (D6).
    expect(routeFeatures(null).features).toHaveLength(0);
    expect(routeFeatures([]).features).toHaveLength(0);
    expect(routeFeatures([point(13, 100)]).features).toHaveLength(0);
  });

  it('is one line, densified, from a two-point track', () => {
    const collection = routeFeatures([point(13, 100), point(14, 101)]);
    expect(collection.features).toHaveLength(1);
    const { coordinates } = collection.features[0].geometry;
    expect(coordinates.length).toBeGreaterThan(2);
    expect(coordinates[0]).toEqual([100, 13]);
    expect(coordinates[coordinates.length - 1][0]).toBeCloseTo(101, 6);
  });

  it('does not repeat the sample where two arcs meet', () => {
    // Each arc ends where the next begins; keeping both would duplicate every
    // reported position and put a visible kink at each one.
    const collection = routeFeatures([point(0, 0), point(0, 10), point(0, 20)]);
    const { coordinates } = collection.features[0].geometry;
    const at10 = coordinates.filter(([lon]) => Math.abs(lon - 10) < 1e-9);
    expect(at10).toHaveLength(1);
  });

  it('stays continuous across the antimeridian', () => {
    const collection = routeFeatures([point(10, 178), point(10, -178)]);
    const { coordinates } = collection.features[0].geometry;
    for (let i = 1; i < coordinates.length; i += 1) {
      expect(Math.abs(coordinates[i][0] - coordinates[i - 1][0])).toBeLessThan(180);
    }
    expect(coordinates[coordinates.length - 1][0]).toBeGreaterThan(180);
  });
});

describe('routeLayers', () => {
  it('draws a dark casing under a bright line', () => {
    // A single white line vanishes over pale terrain and a single dark one
    // over water. The route is the answer to "where has this aircraft been",
    // so it has to survive both (D59).
    const [casing, line] = routeLayers();
    expect(casing.id).toBe(ROUTE_CASING_LAYER);
    expect(line.id).toBe(ROUTE_LAYER);
    expect(String((casing as { paint: Record<string, unknown> }).paint['line-color'])).toContain(
      '0, 0, 0',
    );
    expect((line as { paint: Record<string, unknown> }).paint['line-color']).toBe('#ffffff');
  });

  it('reads both layers from the one source', () => {
    // Narrowed rather than indexed: `LayerSpecification` is a union and a
    // background layer has no source at all, so asserting the kind first is
    // part of the test.
    for (const layer of routeLayers()) {
      expect(layer.type).toBe('line');
      expect((layer as { source: string }).source).toBe(ROUTE_SOURCE);
    }
  });

  it('keeps the casing wider than the line at every zoom it defines', () => {
    const width = (layer: { paint: Record<string, unknown> }) =>
      (layer.paint['line-width'] as unknown[]).filter((v) => typeof v === 'number') as number[];
    const [casing, line] = routeLayers();
    const casingWidths = width(casing as { paint: Record<string, unknown> });
    const lineWidths = width(line as { paint: Record<string, unknown> });
    // Pairs are [zoom, width, zoom, width]; compare the widths only.
    for (let i = 1; i < casingWidths.length; i += 2) {
      expect(casingWidths[i]).toBeGreaterThan(lineWidths[i]);
    }
  });
});

describe('leaderFeature', () => {
  // Phone's observation, and it is a better description of the defect than
  // mine was: "when the plane moves on, the line end is left behind". The
  // track ends at the last *reported* position; the marker is drawn at its
  // *interpolated* one (D14), so the two are permanently `age x speed` apart
  // even when the data is perfectly fresh (D72).

  it('draws nothing without both ends', () => {
    expect(leaderFeature(null, { lat: 1, lon: 2 }).features).toHaveLength(0);
    expect(leaderFeature([], { lat: 1, lon: 2 }).features).toHaveLength(0);
    expect(leaderFeature([point(13, 100)], null).features).toHaveLength(0);
  });

  it('joins the last reported position to where the aircraft is drawn', () => {
    const collection = leaderFeature([point(13, 100), point(13.5, 100.5)], { lat: 13.6, lon: 100.6 });
    expect(collection.features).toHaveLength(1);
    const { coordinates } = collection.features[0].geometry;
    // Starts at the track's last point, not its first.
    expect(coordinates[0][0]).toBeCloseTo(100.5, 6);
    expect(coordinates[0][1]).toBeCloseTo(13.5, 6);
    expect(coordinates[coordinates.length - 1][0]).toBeCloseTo(100.6, 6);
    expect(coordinates[coordinates.length - 1][1]).toBeCloseTo(13.6, 6);
  });

  it('draws nothing when the marker is sitting on its last report', () => {
    // Which is what a stale aircraft does now (D71): the extrapolation stops,
    // the marker holds the reported position, and there is no gap to bridge.
    // A zero-length dashed stub at the nose would be noise.
    const collection = leaderFeature([point(13, 100), point(13.5, 100.5)], { lat: 13.5, lon: 100.5 });
    expect(collection.features).toHaveLength(0);
  });

  it('stays continuous across the antimeridian', () => {
    const collection = leaderFeature([point(10, 179.9)], { lat: 10, lon: -179.9 });
    const { coordinates } = collection.features[0].geometry;
    for (let i = 1; i < coordinates.length; i += 1) {
      expect(Math.abs(coordinates[i][0] - coordinates[i - 1][0])).toBeLessThan(180);
    }
  });
});

describe('leaderLayers', () => {
  it('is dashed, because it is an estimate and the track is not', () => {
    // The one thing that must not be lost: the track is what was observed
    // (D6). Drawing the gap as more solid track would file dead reckoning as
    // an observation.
    for (const layer of leaderLayers()) {
      const paint = (layer as { paint: Record<string, unknown> }).paint;
      expect(paint['line-dasharray']).toBeDefined();
      expect((layer as { source: string }).source).toBe(LEADER_SOURCE);
    }
    for (const layer of routeLayers()) {
      expect((layer as { paint: Record<string, unknown> }).paint['line-dasharray']).toBeUndefined();
    }
  });

  it('matches the track it continues, casing and all', () => {
    // Same widths at the same zooms, so it reads as the same line rather than
    // a second one that happens to start nearby.
    const [casing, line] = leaderLayers();
    const [trackCasing, trackLine] = routeLayers();
    const width = (l: unknown) => (l as { paint: Record<string, unknown> }).paint['line-width'];
    expect(width(casing)).toEqual(width(trackCasing));
    expect(width(line)).toEqual(width(trackLine));
  });
});

describe('the departure airport', () => {
  // The track now begins at the runway rather than wherever we happened to
  // start watching (D78), and a line that starts at an airport says so much
  // more clearly with a mark on it.

  it('draws nothing when the origin is unknown', () => {
    // A flight the network picked up in mid-air has no departure point, and
    // putting a ring at the start of the track anyway would claim exactly what
    // the panel is careful not to.
    expect(originFeature(null).features).toHaveLength(0);
    expect(originFeature(undefined).features).toHaveLength(0);
  });

  it('puts one point at the airport, in lon/lat order', () => {
    // Getting the order backwards is a whole hemisphere of wrong that still
    // draws a ring somewhere plausible.
    const collection = originFeature({ lat: -33.9461, lon: 151.1772, icao: 'YSSY' });
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].geometry.coordinates).toEqual([151.1772, -33.9461]);
    expect(collection.features[0].properties.icao).toBe('YSSY');
  });

  it('is a ring, not another filled shape', () => {
    // The aircraft are filled shapes. A departure point is not an aircraft,
    // and at a glance a second filled dot on the line reads as one.
    const [ring, label] = originLayers();
    expect(ring.id).toBe(ORIGIN_LAYER);
    expect(ring.type).toBe('circle');
    const paint = (ring as { paint: Record<string, unknown> }).paint;
    expect(paint['circle-color']).toBe('rgba(0, 0, 0, 0)');
    expect(paint['circle-stroke-width']).toBeGreaterThan(0);
    expect(label.id).toBe(ORIGIN_LABEL_LAYER);
    expect(label.type).toBe('symbol');
  });

  it('reads both layers from the one source', () => {
    for (const layer of originLayers()) {
      expect((layer as { source: string }).source).toBe(ORIGIN_SOURCE);
    }
  });

  it('holds the code back until there is room for it', () => {
    // At z2 the ring is a few pixels and a four-letter code beside every one
    // of them is noise; the airport's full name is in the panel regardless.
    const [, label] = originLayers();
    expect((label as { minzoom?: number }).minzoom).toBeGreaterThan(2);
  });
});
