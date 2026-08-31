import { describe, expect, it } from 'vitest';

import type { Airport } from '../types';
import {
  AIRPORT_SOURCE,
  AIRPORT_ZOOM,
  airportFeature,
  airportLayers,
} from './airportLayer';

const HEATHROW: Airport = {
  icao: 'EGLL',
  iata: 'LHR',
  name: 'London Heathrow Airport',
  municipality: 'London',
  country: 'GB',
  lat: 51.4706,
  lon: -0.461941,
  distanceKm: null,
};

describe('airportFeature', () => {
  it('marks the airport at its own coordinates', () => {
    const [feature] = airportFeature(HEATHROW).features;
    expect(feature.geometry.coordinates).toEqual([-0.461941, 51.4706]);
  });

  it('shows the code people search with, and keeps the unambiguous one', () => {
    const [feature] = airportFeature(HEATHROW).features;
    expect(feature.properties.code).toBe('LHR');
    expect(feature.properties.icao).toBe('EGLL');
  });

  it('falls back to ICAO where there is no IATA code', () => {
    // Most of the 28,291 airports have no IATA code at all.
    const [feature] = airportFeature({ ...HEATHROW, iata: null }).features;
    expect(feature.properties.code).toBe('EGLL');
  });

  it('names the place rather than the aerodrome where it can', () => {
    // "London" locates it; "London Heathrow Airport" mostly repeats the code.
    const [feature] = airportFeature(HEATHROW).features;
    expect(feature.properties.name).toBe('London');
    const [unnamed] = airportFeature({ ...HEATHROW, municipality: null }).features;
    expect(unnamed.properties.name).toBe('London Heathrow Airport');
  });

  it('draws nothing when nothing is focused', () => {
    expect(airportFeature(null).features).toEqual([]);
  });
});

describe('the airport layers', () => {
  it('passes the style-spec validator', async () => {
    // The lesson from defect #25, twice over: a layer MapLibre rejects is
    // dropped silently and no other assertion here can tell.
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = {
      version: 8 as const,
      sources: { [AIRPORT_SOURCE]: { type: 'geojson', data: airportFeature(HEATHROW) } },
      layers: airportLayers(),
      glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
    };
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });

  it('is never dropped, and is never printed through', () => {
    // The two options sound like a pair and do opposite jobs. `allow-overlap`
    // keeps this label drawn; `ignore-placement` would let every other label
    // draw over it - which is how the basemap's own name came out as
    // "Don Mueang Internatio DMK rport" over Bangkok.
    const label = airportLayers().find((l) => l.type === 'symbol');
    const layout = label?.layout as Record<string, unknown>;
    expect(layout['text-allow-overlap']).toBe(true);
    expect(layout['text-ignore-placement']).toBe(false);
    expect(layout['text-optional']).toBeUndefined();
  });

  it('keeps the marker visible at every zoom', () => {
    // Someone who searched Heathrow and then zoomed in has not stopped caring
    // where Heathrow is.
    for (const layer of airportLayers()) {
      expect(layer.maxzoom).toBeUndefined();
      expect(layer.minzoom).toBeUndefined();
    }
  });

  it('goes in close enough for runways to read', () => {
    // The original complaint was arriving somewhere indistinguishable from
    // anywhere else. Runways are recognisable on imagery from about z11.
    expect(AIRPORT_ZOOM).toBeGreaterThanOrEqual(10);
  });
});
