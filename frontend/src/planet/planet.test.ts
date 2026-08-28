/**
 * Tests for the MapLibre planet view's pure parts.
 *
 * MapLibre needs a WebGL context and there is none under vitest, so what is
 * tested is what would be wrong before a single pixel is drawn: the shape of
 * the style, the aircraft as GeoJSON, and the conversion from map bounds to
 * the bounding box the backend has always been given.
 *
 * The recurring failure mode across all three is the same one this project
 * has now met six times: two conventions that are each correct and that
 * disagree. Lon/lat against lat/lon, `{z}/{y}/{x}` against `{z}/{x}/{y}`,
 * degrees that run past 180 against a contract that stops there.
 */

import { describe, expect, it } from 'vitest';
import type {
  LayerSpecification,
  RasterLayerSpecification,
  StyleSpecification,
  SymbolLayerSpecification,
} from 'maplibre-gl';

import { config } from '../config';
import type { RenderableObject } from '../types';
import {
  AIRCRAFT_LAYER,
  AIRCRAFT_SOURCE,
  ICON_AIRCRAFT,
  ICON_UNKNOWN,
  STALE_AFTER_SECONDS,
  aircraftFeatures,
  aircraftLayers,
  colourFor,
} from './aircraftLayer';
import {
  IMAGERY_CROSSFADE_END,
  IMAGERY_CROSSFADE_START,
  IMAGERY_FAR_MAX_ZOOM,
  IMAGERY_NEAR_MAX_ZOOM,
  loadPlanetStyle,
  styleForImagery,
  withImagery,
} from './basemap';
import { isRenderable, unrenderableMessage } from './container';
import { readoutLines, requestCounts } from './diagnostics';
import { boundsToBBox, coversWholeWorld, wrapLongitude } from './viewport';

const NOW = Date.parse('2026-08-28T12:00:00Z');

/**
 * Narrow a layer to the kind it is supposed to be.
 *
 * `LayerSpecification` is a union, so `layout['icon-rotate']` is only a
 * property on some of its members. Asserting the kind first is both what makes
 * the index legal and a test in its own right: a layer that quietly became a
 * circle would fail here rather than at the index.
 */
function asSymbol(layer: LayerSpecification): SymbolLayerSpecification {
  if (layer.type !== 'symbol') throw new Error(`expected a symbol layer, got ${layer.type}`);
  return layer;
}

function asRaster(layer: LayerSpecification): RasterLayerSpecification {
  if (layer.type !== 'raster') throw new Error(`expected a raster layer, got ${layer.type}`);
  return layer;
}

function object(overrides: Partial<RenderableObject> = {}): RenderableObject {
  return {
    id: 'a1',
    lat: 13.75,
    lon: 100.5,
    altitude: 10_000,
    velocity: 240,
    heading: 90,
    label: 'THA932',
    lastSeen: new Date(NOW).toISOString(),
    type: 'aircraft',
    renderLat: 13.8,
    renderLon: 100.6,
    fromLat: 13.75,
    fromLon: 100.5,
    updatedAt: NOW,
    lastSeenMs: NOW,
    ...overrides,
  };
}

const bareStyle: StyleSpecification = {
  version: 8,
  sources: { openmaptiles: { type: 'vector', url: 'https://example.invalid/planet' } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    { id: 'place', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' },
    {
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
    },
  ],
  glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
};

describe('withImagery', () => {
  const style = withImagery(bareStyle);

  it('turns the map into a globe', () => {
    expect(style.projection).toEqual({ type: 'globe' });
  });

  it('makes imagery the ground and puts cartography over it', () => {
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toEqual([
      'orbital-imagery-far',
      'orbital-imagery-near',
      'road',
      'place',
      'building-3d',
    ]);
  });

  it('drops the background and every area fill', () => {
    // This is the defect it exists for. A fill's job is to colour ground, and
    // the basemap's background is #f8f4f0 -- so under the old ordering,
    // zooming anywhere without roads faded real imagery out into a cream
    // screen (D56).
    const types = style.layers.map((layer) => layer.type);
    expect(types).not.toContain('background');
    expect(types).not.toContain('fill');
  });

  it('crossfades the close imagery in over the far one', () => {
    // A dissolve between two photographs of the same ground, rather than a cut
    // between a photograph and a colour.
    const near = style.layers.find((l) => l.id === 'orbital-imagery-near');
    expect(asRaster(near!).paint?.['raster-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      IMAGERY_CROSSFADE_START,
      0,
      IMAGERY_CROSSFADE_END,
      1,
    ]);
    // Fully arrived before the far tier runs out of tiles of its own.
    expect(IMAGERY_CROSSFADE_END).toBeLessThanOrEqual(IMAGERY_FAR_MAX_ZOOM);
  });

  it('carries imagery to where individual buildings are visible', () => {
    // 500 m per pixel is a continent from space. The close tier has to reach
    // the zoom where a person expects to see a building, which is around 18,
    // or the map stops being a map and becomes a blur (D58).
    expect(IMAGERY_NEAR_MAX_ZOOM).toBeGreaterThan(IMAGERY_FAR_MAX_ZOOM);
    expect(IMAGERY_NEAR_MAX_ZOOM).toBeGreaterThanOrEqual(18);
  });

  it('keeps the vector source it was given', () => {
    expect(style.sources.openmaptiles).toEqual(bareStyle.sources.openmaptiles);
    expect(style.sources['orbital-imagery-far']).toMatchObject({ type: 'raster' });
    expect(style.sources['orbital-imagery-near']).toMatchObject({ type: 'raster' });
  });

  it('requests both imagery tiers in WMTS row/column order', () => {
    // Both are WMTS: the path is {z}/{row}/{col}, which is {z}/{y}/{x}. An XYZ
    // template would be {z}/{x}/{y}, and swapping them returns tiles of the
    // wrong place rather than an error -- a mirrored, plausible-looking Earth.
    for (const id of ['orbital-imagery-far', 'orbital-imagery-near']) {
      const source = style.sources[id];
      const url = source && 'tiles' in source ? source.tiles?.[0] ?? '' : '';
      // No trailing dot in the match: Esri's path ends at {x} with no file
      // extension, and requiring one would pass a wrongly-ordered URL that
      // happened to end in `.jpg`.
      expect(url).toContain('/{z}/{y}/{x}');
      expect(url).not.toContain('/{z}/{x}/{y}');
    }
  });

  it('credits both imagery providers, because both licences ask it to', () => {
    const attribution = (id: string) => {
      const source = style.sources[id];
      return source && 'attribution' in source ? source.attribution ?? '' : '';
    };
    expect(attribution('orbital-imagery-far')).toContain('NASA');
    expect(attribution('orbital-imagery-near')).toContain('Esri');
  });

  it('survives a style with nothing but fills', () => {
    const fillsOnly = withImagery({ ...bareStyle, layers: bareStyle.layers.slice(0, 2) });
    expect(fillsOnly.layers.map((l) => l.id)).toEqual([
      'orbital-imagery-far',
      'orbital-imagery-near',
    ]);
  });
});

describe('loadPlanetStyle', () => {
  it('fetches the configured vector style and layers imagery into it', async () => {
    let requested = '';
    const style = await loadPlanetStyle(async (url) => {
      requested = url;
      return bareStyle;
    });
    expect(requested).toBe(config.cityStyleUrl);
    expect(style.sources['orbital-imagery-far']).toBeDefined();
    expect(style.sources['orbital-imagery-near']).toBeDefined();
  });

  it('rejects rather than degrading, because there is no map without a style', async () => {
    await expect(
      loadPlanetStyle(async () => {
        throw new Error('HTTP 503');
      }),
    ).rejects.toThrow('HTTP 503');
  });
});

describe('aircraftFeatures', () => {
  it('writes coordinates as lon/lat, which is GeoJSON and not the contract', () => {
    // Swapping these puts every aircraft in the wrong hemisphere and nothing
    // fails, which is why it is asserted rather than trusted.
    const [feature] = aircraftFeatures([object()], NOW).features;
    expect(feature.geometry.coordinates).toEqual([100.6, 13.8]);
  });

  it('uses the interpolated position, not the last reported one', () => {
    // Aircraft move between polls here exactly as they did on the globe.
    const [feature] = aircraftFeatures([object({ lat: 0, lon: 0 })], NOW).features;
    expect(feature.geometry.coordinates).toEqual([100.6, 13.8]);
  });

  it('marks an unknown heading rather than drawing it as north', () => {
    const [known, unknown] = aircraftFeatures(
      [object(), object({ id: 'b2', heading: null })],
      NOW,
    ).features;
    expect(known.properties.hasHeading).toBe(true);
    expect(unknown.properties.hasHeading).toBe(false);
    expect(unknown.properties.heading).toBe(0);
  });

  it('fades an aircraft that has not reported recently', () => {
    const fresh = aircraftFeatures([object()], NOW).features[0];
    const stale = aircraftFeatures(
      [object({ lastSeenMs: NOW - (STALE_AFTER_SECONDS + 10) * 1000 })],
      NOW,
    ).features[0];
    expect(fresh.properties.stale).toBe(false);
    expect(stale.properties.stale).toBe(true);
  });

  it('carries the id, so a click can select what it hit', () => {
    const [feature] = aircraftFeatures([object()], NOW).features;
    expect(feature.id).toBe('a1');
    expect(feature.properties.id).toBe('a1');
  });
});

describe('colourFor', () => {
  it('is the altitude ramp, converted rather than restated', () => {
    // Two copies of a colour scale drift apart and then the legend lies, so
    // this reads the same function the marker shader does (D28).
    expect(colourFor(0)).toBe('rgb(255, 140, 51)');
    expect(colourFor(12_000)).toBe('rgb(89, 217, 255)');
  });

  it('has a colour for an unknown altitude', () => {
    expect(colourFor(null)).toBe('rgb(158, 158, 173)');
  });
});

describe('aircraftLayers', () => {
  const [rawIcons, rawLabels] = aircraftLayers();
  const icons = asSymbol(rawIcons);
  const labels = asSymbol(rawLabels);

  it('draws every icon and lets labels drop out', () => {
    // Hiding an icon because another is near it would be losing an aircraft.
    // Hiding a callsign is losing a callsign, and forty overlapping ones are
    // worse than none.
    expect(icons.layout?.['icon-allow-overlap']).toBe(true);
    expect(labels.layout?.['text-allow-overlap']).toBe(false);
    expect(labels.layout?.['text-optional']).toBe(true);
  });

  it('picks the silhouette or the disc from the feature', () => {
    expect(icons.layout?.['icon-image']).toEqual([
      'case',
      ['get', 'hasHeading'],
      ICON_AIRCRAFT,
      ICON_UNKNOWN,
    ]);
  });

  it('rotates against the map, which is what a heading means', () => {
    // Rotation aligned to the viewport would turn every aircraft as the user
    // turned the map, which is the same class of mistake as D41's frames.
    expect(icons.layout?.['icon-rotation-alignment']).toBe('map');
    expect(icons.layout?.['icon-rotate']).toEqual(['get', 'heading']);
  });

  it('reads both layers from the one source', () => {
    expect(icons.source).toBe(AIRCRAFT_SOURCE);
    expect(labels.source).toBe(AIRCRAFT_SOURCE);
    expect(icons.id).toBe(AIRCRAFT_LAYER);
  });
});

describe('boundsToBBox', () => {
  const bounds = (west: number, south: number, east: number, north: number) => ({
    getWest: () => west,
    getSouth: () => south,
    getEast: () => east,
    getNorth: () => north,
  });

  it('converts an ordinary view', () => {
    expect(boundsToBBox(bounds(97, 5.5, 106, 20.5))).toEqual({
      lonMin: 97,
      latMin: 5.5,
      lonMax: 106,
      latMax: 20.5,
    });
  });

  it('wraps a longitude that has run past the antimeridian', () => {
    // MapLibre lets the user pan east forever, so after two laps west is 400.
    // The contract parses [-180, 180) and would reject or mis-filter that.
    expect(boundsToBBox(bounds(400, 0, 410, 10)).lonMin).toBeCloseTo(40, 9);
    expect(boundsToBBox(bounds(-200, 0, -190, 10)).lonMin).toBeCloseTo(160, 9);
  });

  it('produces lonMin > lonMax across the antimeridian, as the contract defines', () => {
    // Not a bug to fix: D25 already gives that form a meaning, and the backend
    // implements it.
    const box = boundsToBBox(bounds(170, -10, 190, 10));
    expect(box.lonMin).toBeCloseTo(170, 9);
    expect(box.lonMax).toBeCloseTo(-170, 9);
  });

  it('clamps latitude at the poles', () => {
    // A globe view can put the pole in the middle of the screen, where the
    // bounds come back past 90.
    const box = boundsToBBox(bounds(-10, -95, 10, 95));
    expect(box.latMin).toBe(-90);
    expect(box.latMax).toBe(90);
  });

  it('recognises a view of the whole world', () => {
    expect(coversWholeWorld(bounds(-180, -85, 180, 85))).toBe(true);
    expect(coversWholeWorld(bounds(97, 5, 106, 20))).toBe(false);
  });
});

describe('wrapLongitude', () => {
  it('leaves the ordinary range alone', () => {
    expect(wrapLongitude(0)).toBe(0);
    expect(wrapLongitude(100.5)).toBeCloseTo(100.5, 9);
    expect(wrapLongitude(-179.9)).toBeCloseTo(-179.9, 9);
  });

  it('folds both directions', () => {
    expect(wrapLongitude(181)).toBeCloseTo(-179, 9);
    expect(wrapLongitude(-181)).toBeCloseTo(179, 9);
    expect(wrapLongitude(720)).toBeCloseTo(0, 9);
  });

  it('picks -180 over +180, as the contract does', () => {
    expect(wrapLongitude(180)).toBe(-180);
  });
});

describe('the container guard', () => {
  it('accepts a container with real dimensions', () => {
    expect(isRenderable({ width: 1280, height: 720 })).toBe(true);
  });

  it('rejects a collapsed one', () => {
    // The failure it exists for: MapLibre adds `maplibregl-map` to the
    // container and its stylesheet sets `position: relative` on that class.
    // The stylesheet is a dynamic import, so it lands after the application's
    // own, and at equal specificity the later rule wins -- an absolutely
    // positioned container turns relative, `inset` stops applying, and the box
    // collapses to zero height. No error, no failed request, a blank screen
    // (D55).
    expect(isRenderable({ width: 1280, height: 0 })).toBe(false);
    expect(isRenderable({ width: 0, height: 0 })).toBe(false);
  });

  it('rejects a container too small to be deliberate', () => {
    // A box of a few pixels is the same mistake with the same symptom, and
    // calling it usable would let the interesting case through.
    expect(isRenderable({ width: 8, height: 8 })).toBe(false);
  });

  it('names the likely cause, not just the symptom', () => {
    // "Container has no size" sends the reader to their own layout. The cause
    // was somebody else's stylesheet winning the cascade, and the message says
    // so, because that is the difference between a minute and an evening.
    const message = unrenderableMessage({ width: 1280, height: 0 });
    expect(message).toContain('1280x0');
    expect(message).toContain('maplibregl-map');
    expect(message).toContain('position: relative');
  });
});

describe('the diagnostics readout', () => {
  const counts = { style: 1, gibs: 12, sentinel: 30, vector: 0, glyphs: 0, sprite: 0 };

  it('counts requests by kind from the browser timings', () => {
    const names = [
      'https://tiles.openfreemap.org/styles/liberty',
      'https://gibs.earthdata.nasa.gov/wmts/.../3/2/4.jpeg',
      'https://tiles.maps.eox.at/wmts/1.0.0/.../12/1721/3300.jpg',
      'https://tiles.openfreemap.org/planet/20260823/14/12765/7560.pbf',
      'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf',
    ];
    const result = requestCounts(names);
    expect(result.gibs).toBe(1);
    expect(result.sentinel).toBe(1);
    // The glyph request is also a .pbf, and counting it as a vector tile would
    // hide exactly the failure this panel exists to surface.
    expect(result.glyphs).toBe(1);
  });

  it('calls out a loaded style with no vector tiles', () => {
    // Every road, label and building comes from that one source. If it is
    // silent the imagery underneath looks like the whole map, which is what
    // was reported and what no screenshot could explain.
    const lines = readoutLines({ styleLoaded: true, zoom: 14, layers: 95, features: 0, counts, errors: [] });
    expect(lines.join('\n')).toContain('NO VECTOR TILES');
  });

  it('says nothing of the sort while the style is still loading', () => {
    const lines = readoutLines({ styleLoaded: false, zoom: 2, layers: 0, features: 0, counts, errors: [] });
    expect(lines.join('\n')).not.toContain('NO VECTOR TILES');
    expect(lines[0]).toContain('LOADING');
  });

  it('shows the most recent errors, not the first ones', () => {
    const errors = ['one', 'two', 'three', 'four'];
    const lines = readoutLines({ styleLoaded: true, zoom: 14, layers: 95, features: 900, counts, errors });
    expect(lines.join('\n')).toContain('four');
    expect(lines.join('\n')).not.toContain('one');
  });
});

describe('styling cartography for imagery', () => {
  it('inverts label colours, because the basemap is a light style', () => {
    // Dark text with a white halo is correct on cream and close to invisible
    // on a satellite photograph of a city, which is grey and white and busy.
    const styled = styleForImagery({
      id: 'place_label',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      paint: { 'text-color': '#333', 'text-halo-color': '#fff' },
    });
    expect(styled.type).toBe('symbol');
    const paint = (styled as { paint: Record<string, unknown> }).paint;
    expect(paint['text-color']).toBe('#ffffff');
    expect(String(paint['text-halo-color'])).toContain('0, 0, 0');
  });

  it('darkens road casings and brightens the roads themselves', () => {
    // The casing is the wider line drawn underneath to outline a road. Over
    // imagery it is what makes the road legible at all.
    const casing = styleForImagery({
      id: 'road_minor_casing',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      paint: { 'line-color': '#e0e0e0' },
    });
    const road = styleForImagery({
      id: 'road_minor',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      paint: { 'line-color': '#ffffff' },
    });
    expect(String((casing as { paint: Record<string, unknown> }).paint['line-color'])).toContain(
      '0, 0, 0',
    );
    expect(String((road as { paint: Record<string, unknown> }).paint['line-color'])).toContain(
      '255, 255, 255',
    );
  });

  it('leaves the geometry and zoom rules alone', () => {
    // The hundred layers of tuned cartography are worth keeping; only colour
    // is wrong over imagery.
    const original = {
      id: 'road_major',
      type: 'line' as const,
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 6,
      filter: ['==', ['get', 'class'], 'motorway'] as unknown,
      layout: { 'line-cap': 'round' as const },
      paint: { 'line-width': 3 },
    };
    const styled = styleForImagery(original as never) as typeof original;
    expect(styled.minzoom).toBe(6);
    expect(styled.filter).toEqual(original.filter);
    expect(styled.layout).toEqual(original.layout);
    expect((styled.paint as Record<string, unknown>)['line-width']).toBe(3);
  });

  it('makes buildings translucent so they sit over their own footprint', () => {
    const styled = styleForImagery({
      id: 'building-3d',
      type: 'fill-extrusion',
      source: 'openmaptiles',
      'source-layer': 'building',
      paint: { 'fill-extrusion-height': 10 },
    });
    const paint = (styled as { paint: Record<string, unknown> }).paint;
    expect(paint['fill-extrusion-opacity']).toBeLessThan(1);
    expect(paint['fill-extrusion-height']).toBe(10);
  });
});

describe('the tiles-but-no-features line', () => {
  it('separates a missing source from an invisible one', () => {
    // The two explanations for an empty map look identical in a screenshot.
    const counts = { style: 1, gibs: 4, sentinel: 8, vector: 40, glyphs: 2, sprite: 1 };
    const invisible = readoutLines({
      styleLoaded: true,
      zoom: 15,
      layers: 95,
      features: 0,
      counts,
      errors: [],
    }).join('\n');
    expect(invisible).toContain('TILES BUT NO FEATURES');

    const working = readoutLines({
      styleLoaded: true,
      zoom: 15,
      layers: 95,
      features: 1200,
      counts,
      errors: [],
    }).join('\n');
    expect(working).not.toContain('TILES BUT NO FEATURES');
    expect(working).not.toContain('NO VECTOR TILES');
  });
});
