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
  resolveVectorSources,
  IMAGERY_LAYERS,
  IMAGERY_NEAR_MIN_ZOOM,
  DARKEST_GROUND,
  DARKEST_WATER,
  DARK_GROUND,
  DARK_WATER,
  REGION_LABEL_SIZE,
  styleForImagery,
  withImagery,
  firstLabelLayerId,
  BASEMAP_DARK,
  BASEMAP_FLAT,
  BASEMAP_MODES,
  BASEMAP_IMAGERY,
  BASEMAP_STATE,
  basemapDimLayer,
  whenBasemap,
  whenFlat,
  ATMOSPHERE_BLEND,
} from './basemap';
import { createBasemapControl } from './basemapControl';
import { isRenderable, unrenderableMessage, whenRenderable } from './container';
import { readoutLines, requestCounts, tileUrlFor, vectorSourceState } from './diagnostics';
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
    model: null,
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
  sources: {
    openmaptiles: { type: 'vector', url: 'https://example.invalid/planet' },
    // Liberty ships a shaded-relief raster, and the fixture has to have one
    // too: without it the test asserting that we drop it could not fail
    // (defect #26, and the D63 rule about tests that cannot come out the other
    // way).
    ne2_shaded: { type: 'raster', tiles: ['https://example.invalid/{z}/{x}/{y}.png'], tileSize: 256 },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    {
      id: 'natural_earth',
      type: 'raster',
      source: 'ne2_shaded',
      paint: {
        'raster-opacity': ['interpolate', ['exponential', 1.5], ['zoom'], 0, 0.6, 6, 0.1],
      },
    },
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

/**
 * Read one arm of a `whenFlat` expression.
 *
 * Every colour in the style is now a two-armed `match` on the basemap state,
 * so a test that wants to know what a layer looks like has to say *which map*
 * it is asking about. Asserting the raw expression instead would pin the
 * encoding rather than the appearance, and would pass just as happily with the
 * two arms swapped (D75).
 */
function forMode(value: unknown, mode: 'flat' | 'dark' | 'imagery'): unknown {
  if (!Array.isArray(value) || value[0] !== 'match') return value;
  // ['match', input, 'flat', flat, 'dark', dark, imagery]
  if (mode === 'flat') return value[3];
  if (mode === 'dark') return value[5];
  return value[6];
}

describe('withImagery', () => {
  const style = withImagery(bareStyle);

  it('turns the map into a globe', () => {
    expect(style.projection).toEqual({ type: 'globe' });
  });

  it('lays the vector ground under the imagery, and the rest over it', () => {
    // Imagery used to be first, which made it the ground - and made a tile
    // that had not arrived a hole showing black. It is a layer over a ground
    // now: fills and the background beneath it, lines and labels above (D113).
    const ids = style.layers.map((layer) => layer.id);
    const far = ids.indexOf('orbital-imagery-far');
    const near = ids.indexOf('orbital-imagery-near');
    expect(near).toBe(far + 1);

    const typeOf = (id: string) => style.layers.find((l) => l.id === id)!.type;
    const below = ids.slice(0, far).map(typeOf);
    const above = ids.slice(near + 1).map(typeOf);

    // Nothing but ground below, and no ground at all above.
    expect(below.every((t) => t === 'background' || t === 'fill')).toBe(true);
    expect(above.some((t) => t === 'background' || t === 'fill')).toBe(false);
    expect(ids).toContain('road');
    expect(ids).toContain('building-3d');
  });

  it('keeps each group in the order the basemap authors chose', () => {
    // Splitting the layers must not reshuffle them. Cartographic order inside
    // each group is a hundred layers of tuning worth keeping.
    const source = withImagery(bareStyle);
    const ids = source.layers.map((l) => l.id).filter((id) => !id.startsWith('orbital-'));
    const original = bareStyle.layers
      .filter((l) => l.type !== 'raster')
      .map((l) => l.id);
    const isGround = (id: string) => {
      const t = bareStyle.layers.find((l) => l.id === id)!.type;
      return t === 'background' || t === 'fill';
    };
    expect(ids).toEqual([...original.filter(isGround), ...original.filter((i) => !isGround(i))]);
  });

  it('drops the relief raster the basemap ships, which would paint over the imagery', () => {
    // Liberty's second layer is Natural Earth shaded relief at 0.6 opacity.
    // Kept, it draws a pale wash over the satellite photograph - obvious over
    // the ocean, where nothing else covers it (defect #26). The only rasters in
    // the finished style are the two this file adds.
    const rasters = style.layers.filter((l) => l.type === 'raster').map((l) => l.id);
    expect(rasters).toEqual(['orbital-imagery-far', 'orbital-imagery-near']);
  });

  it('keeps the background and the fills, switched off rather than deleted', () => {
    // They used to be dropped, and dropping them was right while there was
    // only one look: a fill's job is to colour ground, and the basemap's cream
    // background faded real imagery into a blank screen (D56). They are the
    // flat basemap, so they are now kept and their opacity is an expression
    // that is zero while a photograph is showing (D75).
    const types = style.layers.map((layer) => layer.type);
    expect(types).toContain('background');
    expect(types).toContain('fill');

    // And they are drawn in *every* mode now, not switched off under a
    // photograph: they are the substrate it sits on, so a tile still in flight
    // shows dark land and sea in the right shapes rather than nothing (D113).
    // The photograph is opaque, so imagery mode looks unchanged once it lands.
    const background = style.layers.find((l) => l.type === 'background');
    expect((background as { paint: Record<string, unknown> }).paint['background-opacity']).toBe(1);
    const fill = style.layers.find((l) => l.type === 'fill');
    expect((fill as { paint: Record<string, unknown> }).paint['fill-opacity']).toBe(1);
  });

  it('turns the imagery off in the other direction', () => {
    // The switch has to cut both ways, or flat mode is a photograph with
    // cartography drawn twice over it. It used to be wrapped in the handover
    // dissolve, so this reached for the interpolate's last *output*; with the
    // dissolve gone (D164) the switch is the whole property again.
    const far = style.layers.find((l) => l.id === 'orbital-imagery-far');
    expect(asRaster(far!).paint?.['raster-opacity']).toEqual(whenFlat(0, 1));
  });

  it('shows the imagery at every zoom, with nothing to hand over to', () => {
    // This used to assert a fade to nothing at the handover, so a custom layer
    // could draw the solar system in the space the globe left. There is no such
    // layer: the solar system is a page with its own camera (D163, D164).
    const far = style.layers.find((l) => l.id === 'orbital-imagery-far');
    const opacity = asRaster(far!).paint?.['raster-opacity'];
    expect(JSON.stringify(opacity)).not.toContain('zoom');
  });

  it('crossfades the close imagery in over the far one', () => {
    // A dissolve between two photographs of the same ground, rather than a cut
    // between a photograph and a colour.
    const near = style.layers.find((l) => l.id === 'orbital-imagery-near');
    // The crossfade ends at however much photograph this mode shows. The
    // switch is inside the outputs because `zoom` may only be the input to a
    // top-level interpolate - see the validation test below, which is the one
    // that would have caught getting this wrong (defect #25).
    expect(asRaster(near!).paint?.['raster-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      IMAGERY_CROSSFADE_START,
      0,
      IMAGERY_CROSSFADE_END,
      whenFlat(0, 1),
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
    // They are kept rather than dropped (D75), and since D113 they are kept
    // *on*: the ground is the substrate the photograph sits on, so "survives"
    // now means the style still has a ground and the imagery still sits above
    // it. Sliced by position, because the fixture's second layer is the
    // shaded-relief raster and that is dropped.
    const fillsOnly = withImagery({ ...bareStyle, layers: bareStyle.layers.slice(0, 2) });
    const at = fillsOnly.layers.findIndex((l) => l.id === 'orbital-imagery-far');
    expect(at).toBeGreaterThan(0);
    expect(fillsOnly.layers.slice(at).map((l) => l.id)).toEqual([
      'orbital-imagery-far',
      'orbital-imagery-near',
    ]);
    for (const layer of fillsOnly.layers.slice(0, at)) {
      const paint = (layer as { paint: Record<string, unknown> }).paint;
      const opacity = paint[layer.type === 'background' ? 'background-opacity' : 'fill-opacity'];
      expect(opacity).toBe(1);
    }
  });
});

describe('loadPlanetStyle', () => {
  it('fetches the configured vector style and layers imagery into it', async () => {
    let requested = '';
    const style = await loadPlanetStyle(
      async (url) => {
        requested = url;
        return bareStyle;
      },
      // The bare style's source is declared with `url`, so the resolver asks
      // for its TileJSON too.
      async () => ({ tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'], maxzoom: 14 }),
    );
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
  const counts = { style: 1, gibs: 12, close: 30, vectorMainThread: 0, glyphs: 0, sprite: 0 };
  const template = 'https://tiles.example/planet/{z}/{x}/{y}.pbf';
  const drawing = { present: true, loaded: true, tiles: 24, template, maxzoom: 14 };

  it('counts imagery requests by kind from the browser timings', () => {
    const names = [
      'https://tiles.openfreemap.org/styles/liberty',
      'https://gibs.earthdata.nasa.gov/wmts/.../3/2/4.jpeg',
      'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1/2',
      'https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf',
    ];
    const result = requestCounts(names);
    expect(result.gibs).toBe(1);
    // Whichever close tier is configured, not a named vendor: the readout
    // once reported "sentinel 0" while Esri tiles were streaming (D60).
    expect(result.close).toBe(1);
    expect(result.glyphs).toBe(1);
  });

  it('calls out a style with no vector source at all', () => {
    const lines = readoutLines({
      styleLoaded: true,
      zoom: 14,
      layers: 95,
      features: 0,
      vector: { present: false, loaded: false, tiles: 0, template: null, maxzoom: 14 },
      counts,
      errors: [],
    });
    expect(lines.join('\n')).toContain('NO VECTOR SOURCE');
  });

  it('separates a source with no tiles from tiles with no features', () => {
    // The two look identical in a screenshot, and the difference is where to
    // start looking: the network, or the paint.
    const noTiles = readoutLines({
      styleLoaded: true,
      zoom: 14,
      layers: 95,
      features: 0,
      vector: { present: true, loaded: false, tiles: 0, template, maxzoom: 14 },
      counts,
      errors: [],
    }).join('\n');
    expect(noTiles).toContain('SOURCE NOT LOADED');

    const noFeatures = readoutLines({
      styleLoaded: true,
      zoom: 14,
      layers: 95,
      features: 0,
      vector: drawing,
      counts,
      errors: [],
    }).join('\n');
    expect(noFeatures).toContain('LOADED BUT NO FEATURES');
  });

  it('says nothing of the sort when the map is working', () => {
    // A diagnostic that cries wolf gets ignored.
    const lines = readoutLines({
      styleLoaded: true,
      zoom: 14,
      layers: 95,
      features: 1200,
      vector: drawing,
      counts,
      errors: [],
    }).join('\n');
    expect(lines).not.toContain('NO VECTOR SOURCE');
    expect(lines).not.toContain('SOURCE NOT LOADED');
    expect(lines).not.toContain('LOADED BUT NO FEATURES');
  });

  it('shows the most recent errors, not the first ones', () => {
    const errors = ['one', 'two', 'three', 'four'];
    const lines = readoutLines({
      styleLoaded: true,
      zoom: 14,
      layers: 95,
      features: 900,
      vector: drawing,
      counts,
      errors,
    }).join('\n');
    expect(lines).toContain('four');
    expect(lines).not.toContain('one');
  });

  it('reports the source cache rather than counting requests', () => {
    // Vector tiles are fetched inside a Web Worker, and
    // `performance.getEntriesByType` on the main thread cannot see a worker's
    // requests -- so the old counter could only ever read zero, which is
    // exactly what it did while being believed (D61).
    const map = {
      getSource: () => ({ type: 'vector' }),
      isSourceLoaded: () => true,
      getStyle: () => ({ sources: { openmaptiles: { tiles: ['https://t/{z}/{x}/{y}.pbf'] } } }),
      style: { sourceCaches: { openmaptiles: { _tiles: { a: 1, b: 2, c: 3 } } } },
    } as unknown as import('maplibre-gl').Map;
    expect(vectorSourceState(map, 'openmaptiles')).toMatchObject({
      present: true,
      loaded: true,
      tiles: 3,
    });
  });

  it('survives the internals it reads not being there', () => {
    const map = {
      getSource: () => undefined,
      isSourceLoaded: () => {
        throw new Error('no such source');
      },
    } as unknown as import('maplibre-gl').Map;
    expect(vectorSourceState(map, 'openmaptiles')).toMatchObject({
      present: false,
      loaded: false,
      tiles: 0,
    });
  });
});

describe('styling cartography for imagery', () => {
  it('draws light text on a dark halo on every map, because all three are dark', () => {
    // This used to assert the opposite for the flat map, and correctly: it was
    // a light style then, so it wanted dark text on a white halo. The palette
    // is dark at the source now (D108), and a near-black label on a white halo
    // would be the unreadable one.
    const styled = styleForImagery({
      id: 'place_label',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      paint: { 'text-color': '#333', 'text-halo-color': '#fff' },
    });
    expect(styled.type).toBe('symbol');
    const paint = (styled as { paint: Record<string, unknown> }).paint;
    expect(forMode(paint['text-color'], 'imagery')).toBe('#ffffff');
    expect(String(forMode(paint['text-halo-color'], 'imagery'))).toContain('0, 0, 0');
    // The vector maps get a dimmer text and a darker halo than the photograph:
    // a photograph is busier, so it needs the brighter label to survive it.
    for (const mode of ['flat', 'dark'] as const) {
      expect(String(forMode(paint['text-color'], mode))).not.toBe('#ffffff');
      expect(String(forMode(paint['text-halo-color'], mode))).toContain('6, 9, 14');
    }
    // And the dark map's label is dimmer still than the plain map's, because
    // it is the mode whose whole job is to stay out of the way.
    expect(forMode(paint['text-color'], 'dark')).not.toBe(forMode(paint['text-color'], 'flat'));
  });

  it('hides patterned fills, which are the one thing recolouring cannot reach', () => {
    // `fill-pattern` draws a sprite and ignores `fill-color` outright, so a
    // patterned layer would keep the light style's hatching on a dark map.
    const patterned = styleForImagery({
      id: 'landcover_wetland',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      paint: { 'fill-pattern': 'wetland_bg_11', 'fill-opacity': 0.8 },
    });
    expect((patterned as { paint: Record<string, unknown> }).paint['fill-opacity']).toBe(0);
  });

  it('recolours the ground instead of inheriting the style s light palette', () => {
    // The reversal at the heart of D108. Liberty s fills are a light palette
    // and were passed through untouched; what that kept was not the
    // cartography but the brightness, which is the one thing this map cannot
    // inherit.
    const water = styleForImagery({
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      paint: { 'fill-color': 'rgb(158,189,255)' },
    });
    const paint = (water as { paint: Record<string, unknown> }).paint;
    expect(forMode(paint['fill-color'], 'flat')).toBe(DARK_WATER);
    expect(forMode(paint['fill-color'], 'dark')).toBe(DARKEST_WATER);
  });

  it('keeps land and water apart, which is the whole picture at world zoom', () => {
    // The reason a ready-made dark style was rejected: they put land and water
    // within a couple of per cent of each other, which is fine on a city
    // rectangle and turns a globe into a black disc. Compared as luminance
    // rather than by eye, because by eye is how it was missed.
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    expect(luminance(DARK_GROUND) - luminance(DARK_WATER)).toBeGreaterThan(8);
    expect(luminance(DARKEST_GROUND) - luminance(DARKEST_WATER)).toBeGreaterThan(3);
  });

  it('shrinks country and state names, and leaves every other label alone', () => {
    // Country names are sized for a map showing one region; Orbital shows a
    // globe, where every country on the daylit half is on screen at once.
    const country = styleForImagery({
      id: 'label_country_1',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      layout: { 'text-size': ['interpolate', ['linear'], ['zoom'], 1, 9, 4, 17] as never },
    });
    expect((country as { layout: Record<string, unknown> }).layout['text-size']).toBe(
      REGION_LABEL_SIZE,
    );

    const poi = styleForImagery({
      id: 'poi_r1',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'poi',
      layout: { 'text-size': 12 },
    });
    expect((poi as { layout: Record<string, unknown> }).layout['text-size']).toBe(12);
  });

  it('sizes region labels with one top-level zoom interpolate, not a product', () => {
    // A `zoom` expression may only be the direct input of a top-level step or
    // interpolate, so 'the style s own ramp, times a factor' is rejected - and
    // a rejected paint property drops the entire style with no error at all
    // (defect #25). It also has to actually get smaller as you zoom out.
    const ramp = REGION_LABEL_SIZE as unknown as unknown[];
    expect(ramp[0]).toBe('interpolate');
    expect(ramp[2]).toEqual(['zoom']);
    const sizes = ramp.slice(3).filter((_, i) => i % 2 === 1) as number[];
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes[0]).toBeLessThan(sizes[sizes.length - 1]);
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
    expect(forMode(paint['fill-extrusion-opacity'], 'imagery')).toBeLessThan(1);
    // Opaque on the flat map: there is no photograph underneath to preserve.
    expect(forMode(paint['fill-extrusion-opacity'], 'flat')).toBeGreaterThan(
      forMode(paint['fill-extrusion-opacity'], 'imagery') as number,
    );
    expect(paint['fill-extrusion-height']).toBe(10);
  });
});


describe('what the map is allowed to ask the network for', () => {
  it('does not request close imagery at a zoom that draws it at zero', () => {
    // `raster-opacity: 0` does not stop a tile being fetched. Measured in the
    // running app at zoom 2.8: 72 far tiles and 76 close ones, and only the 72
    // were on screen - competing for the same six connections per host as the
    // tiles the user was waiting to see (D112).
    const style = withImagery(bareStyle);
    const near = style.layers.find((l) => l.id === 'orbital-imagery-near')!;
    expect(near.minzoom).toBe(IMAGERY_NEAR_MIN_ZOOM);
    expect(IMAGERY_NEAR_MIN_ZOOM).toBeLessThan(IMAGERY_CROSSFADE_START);
  });

  it('keeps headroom, so the close tier is loaded before it is needed', () => {
    // Gating exactly on the crossfade would make the seam a pop instead of a
    // dissolve: the tiles would start loading at the zoom they must already be
    // visible at.
    expect(IMAGERY_CROSSFADE_START - IMAGERY_NEAR_MIN_ZOOM).toBeGreaterThan(0);
    expect(IMAGERY_CROSSFADE_START - IMAGERY_NEAR_MIN_ZOOM).toBeLessThanOrEqual(1);
  });

  it('names both imagery layers, so a caller can hide them without guessing', () => {
    // `visibility` is layout and takes no expression, so hiding imagery on the
    // vector maps has to be imperative - and it must not miss a layer.
    const style = withImagery(bareStyle);
    const raster = style.layers.filter((l) => l.type === 'raster').map((l) => l.id);
    expect([...IMAGERY_LAYERS].sort()).toEqual(raster.sort());
  });
});

describe('resolveVectorSources', () => {
  const tileJson = {
    tiles: ['https://tiles.example/planet/20260823/{z}/{x}/{y}.pbf'],
    minzoom: 0,
    maxzoom: 14,
    attribution: 'OpenStreetMap',
  };

  const styleWithUrlSource: StyleSpecification = {
    version: 8,
    sources: { openmaptiles: { type: 'vector', url: 'https://tiles.example/planet' } },
    layers: [{ id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' }],
  };

  it('replaces a TileJSON reference with the tiles it points at', async () => {
    // The defect: MapLibre has to fetch that document itself, and in this
    // application that request never completed -- 93 layers of cartography and
    // not one vector tile requested, with no error (D60).
    const resolved = await resolveVectorSources(styleWithUrlSource, async () => tileJson);
    const source = resolved.sources.openmaptiles;
    expect(source).toMatchObject({ type: 'vector', tiles: tileJson.tiles, maxzoom: 14 });
    expect('url' in source).toBe(false);
  });

  it('asks for the document the source pointed at', async () => {
    let requested = '';
    await resolveVectorSources(styleWithUrlSource, async (url) => {
      requested = url;
      return tileJson;
    });
    expect(requested).toBe('https://tiles.example/planet');
  });

  it('leaves sources that already list their tiles alone', async () => {
    const raster: StyleSpecification = {
      version: 8,
      sources: { imagery: { type: 'raster', tiles: ['https://example/{z}/{y}/{x}'] } },
      layers: [],
    };
    const resolved = await resolveVectorSources(raster, async () => {
      throw new Error('should not fetch');
    });
    expect(resolved.sources.imagery).toEqual(raster.sources.imagery);
  });

  it('fails loudly on a TileJSON with no tiles', async () => {
    // Quietly accepting it is how the original defect stayed invisible: a
    // source that resolves to nothing looks exactly like one that works.
    await expect(
      resolveVectorSources(styleWithUrlSource, async () => ({ tiles: [] })),
    ).rejects.toThrow('no tiles');
  });
});

describe('tileUrlFor', () => {
  const template = 'https://tiles.example/planet/{z}/{x}/{y}.pbf';

  it('builds the tile that covers a point', () => {
    // Bangkok at zoom 14 is a known tile; getting x and y the wrong way round
    // is the mistake this whole project keeps making, so it is pinned.
    expect(tileUrlFor(template, 13.75, 100.5, 14, 14)).toBe(
      'https://tiles.example/planet/14/12765/7560.pbf',
    );
  });

  it('clamps to the source maximum, because vector sources overzoom', () => {
    // Past its maximum a source keeps drawing its deepest tiles, so the tile
    // worth testing is the one at that depth, not one that does not exist.
    expect(tileUrlFor(template, 13.75, 100.5, 17.4, 14)).toBe(
      tileUrlFor(template, 13.75, 100.5, 14, 14),
    );
  });
});

describe('whenRenderable', () => {
  it('resolves at once for a container that already has a box', async () => {
    const element = { clientWidth: 1280, clientHeight: 720 } as unknown as Element;
    await expect(whenRenderable(element)).resolves.toEqual({ width: 1280, height: 720 });
  });

  it('waits, rather than handing MapLibre a container with no size', async () => {
    // Warning was not enough. MapLibre measures the container once, at
    // construction, and a zero measurement leaves it on a 400x300 canvas that
    // does not recover when the layout settles -- observed as a 1280x720
    // container with a 400x300 canvas inside it (D62).
    const element = { clientWidth: 0, clientHeight: 0 } as unknown as Element;
    // Typed loosely on purpose: the stub assigns it from inside a class the
    // compiler cannot see through.
    let trigger: undefined | (() => void);
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        trigger = callback;
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;

    const pending = whenRenderable(element);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    (element as { clientWidth: number }).clientWidth = 800;
    (element as { clientHeight: number }).clientHeight = 600;
    (trigger as undefined | (() => void))?.();
    await expect(pending).resolves.toEqual({ width: 800, height: 600 });

    globalThis.ResizeObserver = original;
  });
});

describe('the readout does not judge on internals', () => {
  it('stays quiet when the map says loaded and is drawing, whatever the tile count', () => {
    // Observed: `cached tiles 0` while 120 features drew from a source
    // reporting itself loaded. The tile count reads MapLibre's internals and
    // was wrong; `loaded` and `features` are public API and were right (D65).
    const lines = readoutLines({
      styleLoaded: false,
      zoom: 4.8,
      layers: 97,
      features: 120,
      vector: { present: true, loaded: true, tiles: 0, template: 'https://t/{z}/{x}/{y}.pbf', maxzoom: 14 },
      counts: { style: 1, gibs: 114, close: 24, vectorMainThread: 0, glyphs: 3, sprite: 2 },
      errors: [],
    }).join('\n');
    expect(lines).not.toContain('SOURCE NOT LOADED');
    expect(lines).not.toContain('LOADED BUT NO FEATURES');
  });
});

describe('firstLabelLayerId', () => {
  // Where night belongs in the stack. Drawn over the top it dims the place
  // names with the ground, and the night side stops being readable while the
  // day side stays crisp - which is not what night does to a map (defect #24).
  const style = {
    layers: [
      { id: 'imagery-far', type: 'raster' },
      { id: 'imagery-close', type: 'raster' },
      { id: 'road-motorway', type: 'line' },
      { id: 'building-3d', type: 'fill-extrusion' },
      { id: 'place_label_city', type: 'symbol' },
      { id: 'label_country_1', type: 'symbol' },
    ],
  };

  it('finds the first piece of text in the style', () => {
    expect(firstLabelLayerId(style)).toBe('place_label_city');
  });

  it('puts night above the ground and below every label', () => {
    // Asserted as an ordering rather than as an id, because the id is
    // Liberty's and could be renamed upstream: what matters is that every
    // symbol layer ends up after the insertion point and no raster or line
    // does.
    const at = style.layers.findIndex((l) => l.id === firstLabelLayerId(style));
    style.layers.forEach((layer, index) => {
      if (layer.type === 'symbol') expect(index).toBeGreaterThanOrEqual(at);
      else expect(index).toBeLessThan(at);
    });
  });

  it('says so when the style has no labels at all', () => {
    // Then the layer goes on top, which is the old behaviour and still better
    // than throwing at a name that is not there.
    expect(firstLabelLayerId({ layers: [{ id: 'a', type: 'raster' }] })).toBeNull();
    expect(firstLabelLayerId({ layers: [] })).toBeNull();
    expect(firstLabelLayerId(null)).toBeNull();
    expect(firstLabelLayerId(undefined)).toBeNull();
  });
});

describe('the basemap switch', () => {
  it('reads one state property, so nothing can be styled for the wrong map', () => {
    // Every colour in the style goes through `whenFlat`, and they all read the
    // same property. A layer keyed on something else would look right in one
    // mode and wrong in the other with nothing to catch it.
    const expression = whenFlat('A', 'B') as unknown[];
    expect(expression[0]).toBe('match');
    expect(expression[1]).toEqual(['global-state', BASEMAP_STATE]);
    expect(expression[2]).toBe(BASEMAP_FLAT);
    expect(expression[3]).toBe('A');
    expect(expression[4]).toBe(BASEMAP_DARK);
    expect(expression[6]).toBe('B');
  });

  it('gives the dark map the ground styling, never the imagery styling', () => {
    // The trap the third mode opens: every existing call site was written as
    // two arms, and a two-armed match sends every unlisted value to the
    // fallback - which is the *imagery* arm. Left alone, switching to `dark`
    // would have drawn the photograph's colours on a map with no photograph in
    // it, and turned the imagery raster back on underneath. `whenFlat` maps
    // dark onto the flat arm for exactly this reason.
    expect(forMode(whenFlat('ground', 'photo'), 'dark')).toBe('ground');
    expect(forMode(whenBasemap('a', 'b', 'c'), 'dark')).toBe('b');
  });

  it('is a switch, not a style swap', () => {
    // The point of doing it this way: `setStyle` would tear down and re-add
    // the aircraft, their tracks, the leader, the model and the terminator on
    // every press. This is one property, and the next frame is the other map.
    expect(BASEMAP_IMAGERY).not.toBe(BASEMAP_FLAT);
  });
});

describe('the basemap control', () => {
  it('offers the map you are not looking at', () => {
    // A button labelled with its current state reads as a status line and gets
    // pressed by someone trying to confirm what they see (D68).
    const onImagery = createBasemapControl(() => {}, 'imagery');
    expect(onImagery.button.title).toBe('Show the plain map');

    const onFlat = createBasemapControl(() => {}, 'flat');
    expect(onFlat.button.title).toBe('Show the dark map');
    expect(onFlat.button.classList.contains('is-on')).toBe(true);

    const onDark = createBasemapControl(() => {}, 'dark');
    expect(onDark.button.title).toBe('Show satellite imagery');
  });

  it('can be taken away for a world with only one basemap', () => {
    // Two of the three modes are Earth's vector cartography, which is switched
    // off the moment the camera leaves. Pressing this on the Moon replaced the
    // mosaic with a blank grey disc, and pressing it again got a darker blank
    // disc (D169). Off Earth the choice does not exist rather than failing.
    const control = createBasemapControl(() => {}, 'imagery');
    const container = control.onAdd?.(null as never) as HTMLElement;
    expect(container.hidden).toBe(false);
    control.setAvailable(false);
    expect(container.hidden).toBe(true);
    control.setAvailable(true);
    expect(container.hidden).toBe(false);
  });

  it('does not claim to be a toggle, because it is a cycle', () => {
    // `aria-pressed` has two values and this has three. Leaving it on would
    // tell a screen reader the button is a checkbox that is currently off,
    // which is a false statement about a control that cycles.
    const control = createBasemapControl(() => {}, 'imagery');
    expect(control.button.hasAttribute('aria-pressed')).toBe(false);
  });

  it('cycles back to where it started, visiting each map once', () => {
    const control = createBasemapControl(() => {}, 'imagery');
    const seen: string[] = [];
    for (let i = 0; i < BASEMAP_MODES.length; i += 1) {
      control.button.click();
      seen.push(control.button.title);
    }
    expect(new Set(seen).size).toBe(BASEMAP_MODES.length);
    expect(control.button.title).toBe('Show the plain map');
  });

  it('reports each change once', () => {
    const changes: string[] = [];
    const control = createBasemapControl((mode) => changes.push(mode), 'imagery');
    control.button.click();
    control.button.click();
    expect(changes).toEqual(['flat', 'dark']);
  });

  it('can be told about a change it did not cause', () => {
    const control = createBasemapControl(() => {}, 'imagery');
    control.setMode('dark');
    expect(control.button.title).toBe('Show satellite imagery');
  });

  it('hands MapLibre a control group to place', () => {
    const control = createBasemapControl(() => {}, 'imagery');
    const element = control.onAdd({} as import('maplibre-gl').Map);
    expect(element.className).toContain('maplibregl-ctrl-group');
    expect(element.contains(control.button)).toBe(true);
  });
});

describe('the assembled style is valid, according to the spec itself', () => {
  // **The test that was missing.** Every other assertion here checks that the
  // style says what this file meant it to say; none of them could tell whether
  // MapLibre would accept it. It would not: wrapping the zoom crossfade in a
  // multiplication is rejected outright, and a rejected paint property fails
  // the *whole* style - 0 layers, a black screen, and a working map replaced by
  // nothing (defect #25). The suite was green throughout.
  //
  // So the style is now handed to the style spec's own validator, which is the
  // same code MapLibre validates with. Asking the authority beats asserting the
  // shape, and it is the technique D32 and 19.17 already established for
  // arithmetic MapLibre also knows.

  it('passes the style-spec validator', async () => {
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = withImagery(bareStyle);
    const errors = validateStyleMin(style as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it('is still valid with a zoom-dependent paint property in the input', async () => {
    // The exact shape that broke: a layer whose opacity already interpolates on
    // zoom before this file touches it.
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const withZoomFade = {
      ...bareStyle,
      layers: [
        ...bareStyle.layers,
        {
          id: 'fading-road',
          type: 'line' as const,
          source: 'openmaptiles',
          'source-layer': 'transportation',
          paint: {
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0, 10, 1],
          },
        },
      ],
    };
    const errors = validateStyleMin(withImagery(withZoomFade as never) as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });
});

describe('basemapDimLayer', () => {
  it('dims the flat map and leaves the imagery one alone', () => {
    // The complaint was the flat basemap specifically: cream land and white
    // roads under two thousand bright aircraft, with nothing reading as
    // foreground. Imagery is already dark and busy and needs none of this.
    const paint = basemapDimLayer(0.32).paint as Record<string, unknown>;
    expect(forMode(paint['background-opacity'], 'flat')).toBe(0.32);
    expect(forMode(paint['background-opacity'], 'imagery')).toBe(0);
  });

  it('dims toward the page rather than toward grey', () => {
    // Blending to a neutral grey washes the map out; blending to the near
    // black the page already uses reads as the map receding into it.
    const paint = basemapDimLayer(0.32).paint as Record<string, unknown>;
    expect(paint['background-color']).toBe('#05070c');
  });

  it('is a background layer, so its position is what scopes it', () => {
    // It dims everything added before it and nothing after. That is the whole
    // mechanism, and it only holds because PlanetView adds it immediately
    // before the aircraft.
    expect(basemapDimLayer(0.2).type).toBe('background');
  });
});

describe('our own layers pass the validator too', () => {
  // **Defect #25 happened a second time, in a different layer.** The guard
  // above was added after wrapping a zoom crossfade in a multiplication broke
  // the basemap style - and then `icon-size` was written as
  // `['*', ['interpolate', ['zoom'], ...], ['get', 'scale']]`, which is the
  // same mistake with the same cause: MapLibre allows a `zoom` expression only
  // as the direct input of a top-level `step` or `interpolate`.
  //
  // It was invisible in exactly the way the first one was. The aircraft icon
  // layer was rejected and dropped while the callsign layer, being separate,
  // carried on drawing - so the map showed labels floating over an empty sea
  // and 543 tests stayed green. The fix is to multiply each *stop* instead of
  // the curve.
  //
  // The lesson the first guard half-learned: validate everything handed to
  // MapLibre, not just the part that broke last time.

  it('validates the aircraft layers against the style spec', async () => {
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = {
      ...bareStyle,
      sources: {
        ...bareStyle.sources,
        [AIRCRAFT_SOURCE]: { type: 'geojson', data: aircraftFeatures([], NOW) },
      },
      layers: [...bareStyle.layers, ...aircraftLayers()],
    };
    const errors = validateStyleMin(style as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it('validates the basemap dim layer', async () => {
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = {
      ...bareStyle,
      layers: [...bareStyle.layers, basemapDimLayer(0.32)],
    };
    const errors = validateStyleMin(style as never);
    expect(errors.map((e) => `${e.message}`)).toEqual([]);
  });

  it('still scales an aircraft by its airframe after the fix', async () => {
    // The fix must keep the behaviour, not just the validity: a widebody is
    // still drawn larger than a narrowbody at every zoom stop.
    const [icons] = aircraftLayers();
    const size = (icons.layout as Record<string, unknown>)['icon-size'];
    expect(Array.isArray(size) && size[0]).toBe('interpolate');
    // Every stop output multiplies the per-feature scale.
    const stops = (size as unknown[]).slice(3);
    const outputs = stops.filter((_, i) => i % 2 === 1);
    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(Array.isArray(output) && output[0]).toBe('*');
    }
  });
});

describe('the globe halo', () => {
  const style = withImagery(bareStyle);

  it('is off at every zoom', () => {
    // D141 faded it with the globe; Phone asked for it gone entirely, having
    // seen both. A flat value rather than a zoom expression, so it cannot drift
    // out of step with the handover the way the faded version could (D145).
    const sky = (style as { sky?: Record<string, unknown> }).sky;
    expect(sky?.['atmosphere-blend']).toBe(0);
    expect(ATMOSPHERE_BLEND).toBe(0);
  });

  // The three tests that were here asserted the globe/solar handover: that the
  // two thresholds were one number, that the globe dissolved just before it,
  // and that the planets faded in below it. **There is no handover.** The solar
  // system is a page with its own camera (D163, D164), so the globe is the
  // globe at every zoom this map reaches and nothing fades into anything.
});
