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
  IMAGERY_FADE_END,
  IMAGERY_FADE_START,
  IMAGERY_MAX_ZOOM,
  loadPlanetStyle,
  withImagery,
} from './basemap';
import { isRenderable, unrenderableMessage } from './container';
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
    { id: 'background', type: 'background', paint: { 'background-color': '#000' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
  ],
  glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
};

describe('withImagery', () => {
  const style = withImagery(bareStyle);

  it('turns the map into a globe', () => {
    expect(style.projection).toEqual({ type: 'globe' });
  });

  it('puts the imagery directly above the background, under the cartography', () => {
    // Above the background so it is visible; below everything else so water,
    // roads and labels still draw on top and are what remains when it fades.
    const ids = style.layers.map((layer) => layer.id);
    expect(ids).toEqual(['background', 'orbital-imagery', 'water']);
  });

  it('fades the imagery out where it stops being able to keep up', () => {
    const layer = style.layers.find((l) => l.id === 'orbital-imagery');
    expect(layer).toBeDefined();
    expect(asRaster(layer!).paint?.['raster-opacity']).toEqual([
      'interpolate',
      ['linear'],
      ['zoom'],
      IMAGERY_FADE_START,
      1,
      IMAGERY_FADE_END,
      0,
    ]);
    // Gone before the tiles run out, so the last thing seen is imagery that
    // still has pixels rather than one stretched over four zoom levels.
    expect(IMAGERY_FADE_END).toBeLessThan(IMAGERY_MAX_ZOOM);
  });

  it('keeps the vector source it was given', () => {
    expect(style.sources.openmaptiles).toEqual(bareStyle.sources.openmaptiles);
    expect(style.sources['orbital-imagery']).toMatchObject({ type: 'raster' });
  });

  it('requests GIBS tiles in WMTS row/column order', () => {
    // GIBS is WMTS: the path is {z}/{row}/{col}, which is {z}/{y}/{x}. An XYZ
    // service would be {z}/{x}/{y}, and swapping them returns tiles of the
    // wrong place rather than an error -- a mirrored, plausible-looking Earth.
    const source = style.sources['orbital-imagery'];
    const url = source && 'tiles' in source ? source.tiles?.[0] ?? '' : '';
    expect(url).toContain('/{z}/{y}/{x}.');
    expect(url).not.toContain('/{z}/{x}/{y}.');
  });

  it('credits NASA, because the licence asks it to', () => {
    const source = style.sources['orbital-imagery'];
    expect(source && 'attribution' in source ? source.attribution : '').toContain('NASA');
  });

  it('survives a style with no background layer', () => {
    const styleless = withImagery({ ...bareStyle, layers: [bareStyle.layers[1]] });
    expect(styleless.layers[0].id).toBe('orbital-imagery');
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
    expect(style.sources['orbital-imagery']).toBeDefined();
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
