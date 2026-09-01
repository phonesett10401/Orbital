import { describe, expect, it } from 'vitest';

import type { RenderableObject } from '../types';
import {
  REGIME_COLOURS,
  SATELLITE_SELECTION_LAYER,
  SATELLITE_ZOOM,
  SATELLITE_LABEL_LAYER,
  SATELLITE_LABEL_ZOOM,
  SATELLITE_LAYER,
  SATELLITE_SOURCE,
  UNKNOWN_COLOUR,
  colourForRegime,
  radiusForRegime,
  satelliteFeatures,
  satelliteLayers,
} from './satelliteLayer';

const KM = 1000;
const ISS = 420 * KM;
const GPS = 20_200 * KM;
const GEO = 35_786 * KM;
const CLUSTER = 105_466 * KM;

function satellite(overrides: Partial<RenderableObject> = {}): RenderableObject {
  return {
    id: '25544',
    lat: 10,
    lon: 20,
    altitude: ISS,
    velocity: 7658,
    heading: 45,
    label: 'ISS (ZARYA)',
    model: null,
    lastSeen: '2026-09-01T00:00:00Z',
    type: 'satellite',
    renderLat: 10,
    renderLon: 20,
    fromLat: 10,
    fromLon: 20,
    updatedAt: 0,
    lastSeenMs: 0,
    ...overrides,
  };
}

describe('colourForRegime', () => {
  it('gives each regime its own colour', () => {
    const colours = [ISS, GPS, GEO, CLUSTER].map(colourForRegime);
    expect(new Set(colours).size).toBe(4);
  });

  it('matches the regime table', () => {
    expect(colourForRegime(ISS)).toBe(REGIME_COLOURS.LEO);
    expect(colourForRegime(GEO)).toBe(REGIME_COLOURS.GEO);
  });

  it('claims nothing when the altitude is unknown', () => {
    expect(colourForRegime(null)).toBe(UNKNOWN_COLOUR);
    expect(Object.values(REGIME_COLOURS)).not.toContain(UNKNOWN_COLOUR);
  });
});

describe('radiusForRegime', () => {
  it('draws the sparse high orbits larger than the crowded low ones', () => {
    // ~1,390 objects in low orbit against ~40 above it. The few high ones need
    // to stay findable rather than being lost among the many.
    expect(radiusForRegime(GEO)).toBeGreaterThan(radiusForRegime(ISS));
  });

  it('falls back to the low-orbit size for an unknown altitude', () => {
    expect(radiusForRegime(null)).toBe(radiusForRegime(ISS));
  });
});

describe('satelliteFeatures', () => {
  it('draws at the interpolated position, like the aircraft layer', () => {
    const feature = satelliteFeatures([
      satellite({ renderLon: 100.5, renderLat: 13.7, lon: 0, lat: 0 }),
    ]).features[0];
    // renderLon/renderLat, not lon/lat: the same two numbers everything else
    // on this map draws from, so nothing can drift apart.
    expect(feature.geometry.coordinates).toEqual([100.5, 13.7]);
  });

  it('carries the regime so the panel and the legend agree with the dot', () => {
    expect(satelliteFeatures([satellite({ altitude: GEO })]).features[0].properties.regime)
      .toBe('GEO');
  });

  it('marks the selected one and nothing else', () => {
    const features = satelliteFeatures(
      [satellite({ id: 'a' }), satellite({ id: 'b' })],
      'b',
    ).features;
    expect(features.map((f) => f.properties.selected)).toEqual([false, true]);
  });

  it('is empty for no objects rather than throwing', () => {
    expect(satelliteFeatures([]).features).toEqual([]);
  });
});

describe('satelliteLayers', () => {
  it('draws satellite silhouettes, never the aircraft one', () => {
    // A satellite is not an aeroplane. The shapes are per spacecraft family
    // (D101); what must never appear is the airframe.
    const icons = satelliteLayers().find((l) => l.id === SATELLITE_LAYER);
    expect(icons?.type).toBe('symbol');
    expect(JSON.stringify(satelliteLayers())).not.toContain('orbital-aircraft-icon');
  });

  it('lets every feature choose its own silhouette', () => {
    const icons = satelliteLayers().find((l) => l.id === SATELLITE_LAYER);
    const layout = icons?.layout as Record<string, unknown>;
    expect(layout['icon-image']).toEqual(['get', 'icon']);
  });

  it('never hides a satellite to avoid a collision', () => {
    // Dropping a label is a readability trade; dropping a satellite would be
    // losing one.
    const icons = satelliteLayers().find((l) => l.id === SATELLITE_LAYER);
    const layout = icons?.layout as Record<string, unknown>;
    expect(layout['icon-allow-overlap']).toBe(true);
  });

  it('holds the names back until only a handful are on screen', () => {
    const label = satelliteLayers().find((l) => l.id === SATELLITE_LABEL_LAYER);
    expect(label?.minzoom).toBe(SATELLITE_LABEL_ZOOM);
  });

  it('lets names drop out but never the icons', () => {
    const label = satelliteLayers().find((l) => l.id === SATELLITE_LABEL_LAYER);
    // Losing a name is a readability trade. Losing a satellite would be a lie.
    const layout = label?.layout as Record<string, unknown> | undefined;
    expect(layout?.['text-optional']).toBe(true);
  });

  it('keeps every zoom expression as the direct input of its interpolate', () => {
    // Defect #25 and defect #36 were both this: a zoom expression nested
    // inside a multiply. MapLibre discards such a layer *silently*, so the
    // symptom is an empty map and a green test suite.
    const icons = satelliteLayers().find((l) => l.id === SATELLITE_LAYER);
    const layout = icons?.layout as Record<string, unknown> | undefined;
    const size = layout?.['icon-size'] as unknown[];
    expect(size[0]).toBe('interpolate');
    expect(size[2]).toEqual(['zoom']);
  });

  it('validates against the style spec', async () => {
    // The guard the project learned twice: validate everything handed to
    // MapLibre, not only the thing that broke last time.
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = {
      version: 8 as const,
      sources: {
        [SATELLITE_SOURCE]: {
          type: 'geojson',
          data: satelliteFeatures([satellite()]),
        },
      },
      layers: satelliteLayers(),
    };
    const errors = validateStyleMin(style as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });
});

describe('the selection marker', () => {
  it('is a ring, not an icon halo', () => {
    // MapLibre's SDF halo needs a real distance field to fall off through, and
    // these sprites are plain alpha masks. With no gradient the halo floods
    // the icon cell, which drew a white square behind the selected satellite
    // at low zoom (D102).
    const paint = satelliteLayers().find((l) => l.id === SATELLITE_LAYER)
      ?.paint as Record<string, unknown> | undefined;
    expect(paint?.['icon-halo-width']).toBeUndefined();
    expect(paint?.['icon-halo-color']).toBeUndefined();

    const ring = satelliteLayers().find((l) => l.id === SATELLITE_SELECTION_LAYER);
    expect(ring?.type).toBe('circle');
  });

  it('draws the ring under the icons, so it never hides the silhouette', () => {
    const ids = satelliteLayers().map((l) => l.id);
    expect(ids.indexOf(SATELLITE_SELECTION_LAYER)).toBeLessThan(ids.indexOf(SATELLITE_LAYER));
  });

  it('draws a ring for the selected satellite only', () => {
    const ring = satelliteLayers().find((l) => l.id === SATELLITE_SELECTION_LAYER) as
      | { filter?: unknown }
      | undefined;
    expect(ring?.filter).toEqual(['==', ['get', 'selected'], true]);
  });

  it('is a hollow outline, so the satellite shows through it', () => {
    const paint = satelliteLayers().find((l) => l.id === SATELLITE_SELECTION_LAYER)
      ?.paint as Record<string, unknown> | undefined;
    expect(paint?.['circle-color']).toBe('rgba(0, 0, 0, 0)');
    expect(paint?.['circle-stroke-width']).toBe(2);
  });

  it('stays a sensible size from world zoom to close in', () => {
    // The failure was zoom-dependent - the smaller the icon, the more of it
    // was square - so the ring is pinned across the range it broke at.
    const paint = satelliteLayers().find((l) => l.id === SATELLITE_SELECTION_LAYER)
      ?.paint as Record<string, unknown> | undefined;
    const radius = paint?.['circle-radius'] as unknown[];
    expect(radius[0]).toBe('interpolate');
    expect(radius[2]).toEqual(['zoom']);
    const stops = radius.slice(3).filter((_, i) => i % 2 === 1) as number[];
    expect(Math.min(...stops)).toBeGreaterThanOrEqual(8);
    expect(Math.max(...stops)).toBeLessThanOrEqual(24);
  });
});

describe('SATELLITE_ZOOM', () => {
  it('is far wider than the airport zoom, because a satellite moves', () => {
    // An airport does not move, so the camera sits on top of it at zoom 11. A
    // low-orbit satellite crosses the ground at 7.6 km/s and would leave a
    // zoom-11 viewport in under three seconds (D103).
    expect(SATELLITE_ZOOM).toBeLessThan(6);
  });

  it('is close enough to show which part of the world it is over', () => {
    // The question a map answers is "where", so flying to zoom 0 would be
    // arriving nowhere in particular.
    expect(SATELLITE_ZOOM).toBeGreaterThanOrEqual(3);
  });

  it('is past the zoom where names start drawing, so the target is labelled', () => {
    expect(SATELLITE_ZOOM).toBeGreaterThan(SATELLITE_LABEL_ZOOM);
  });
});
