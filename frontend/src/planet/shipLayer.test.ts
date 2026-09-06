import { describe, expect, it } from 'vitest';

import { STALE_AFTER_SECONDS } from '../interpolate';
import { KIND_COLOUR } from '../shipKind';
import type { RenderableObject } from '../types';
import {
  ICON_SHIP,
  ICON_SHIP_UNKNOWN,
  SHIP_LABEL_LAYER,
  SHIP_LAYER,
  SHIP_SOURCE,
  shipFeatures,
  shipLayers,
} from './shipLayer';

const NOW = 1_788_713_524_127;

function vessel(overrides: Partial<RenderableObject> = {}): RenderableObject {
  return {
    id: '256371000',
    lat: 60.1,
    lon: 24.9,
    renderLat: 60.1,
    renderLon: 24.9,
    altitude: 0,
    velocity: 6.4,
    heading: 61,
    label: 'NOUNOU',
    model: 'Tanker',
    lastSeenMs: NOW,
    type: 'ship',
    ...overrides,
  } as RenderableObject;
}

describe('turning vessels into GeoJSON', () => {
  it('writes coordinates as lon, lat', () => {
    // GeoJSON's order is the reverse of the contract's. Getting it backwards
    // puts every ship in the wrong hemisphere and nothing fails - a vessel at
    // 60N 24E lands at 24N 60E, in the Arabian Sea, looking entirely ordinary.
    const [feature] = shipFeatures([vessel()], NOW).features;
    expect(feature.geometry.coordinates).toEqual([24.9, 60.1]);
  });

  it('uses the interpolated position, not the last reported one', () => {
    // This layer polls once a minute against the aircraft layer's thirty
    // seconds, so without interpolation a moving ship jumps a minute's travel
    // at a time (D71, D165).
    const [feature] = shipFeatures(
      [vessel({ lat: 60.1, lon: 24.9, renderLat: 60.2, renderLon: 25.0 })],
      NOW,
    ).features;
    expect(feature.geometry.coordinates).toEqual([25.0, 60.2]);
  });

  it('colours by vessel type', () => {
    const [feature] = shipFeatures([vessel({ model: 'Tanker' })], NOW).features;
    expect(feature.properties.colour).toBe(KIND_COLOUR.tanker);
  });

  it('gives a vessel of unreported type the neutral colour', () => {
    // 13% of the feed has no metadata row at all (D165), so this is one vessel
    // in eight rather than an edge case.
    const [feature] = shipFeatures([vessel({ model: null })], NOW).features;
    expect(feature.properties.colour).toBe(KIND_COLOUR.other);
  });
});

describe('a heading that was never transmitted', () => {
  it('is marked as absent rather than defaulted to north', () => {
    // 230 of 916 vessels send neither a usable heading nor a usable course.
    // Rotating a hull to zero would point a quarter of the fleet at the North
    // Pole and look deliberate doing it (D18, D40, D165).
    const [feature] = shipFeatures([vessel({ heading: null })], NOW).features;
    expect(feature.properties.hasHeading).toBe(false);
  });

  it('draws the disc, which has no direction to be wrong about', () => {
    const [icons] = shipLayers();
    const layout = icons.layout as Record<string, unknown>;
    expect(layout['icon-image']).toEqual([
      'case',
      ['get', 'hasHeading'],
      ICON_SHIP,
      ICON_SHIP_UNKNOWN,
    ]);
  });

  it('still gives the feature a numeric heading, since MapLibre needs one', () => {
    // The rotation expression reads this on every feature. A null here makes
    // the whole layer invalid, and an invalid layer is dropped silently.
    const [feature] = shipFeatures([vessel({ heading: null })], NOW).features;
    expect(feature.properties.heading).toBe(0);
  });
});

describe('vessels that have not been heard from', () => {
  it('fade rather than vanish', () => {
    // The backend keeps last known positions, so a marker that disappeared
    // would imply the ship had (D33).
    const old = vessel({ lastSeenMs: NOW - (STALE_AFTER_SECONDS + 10) * 1000 });
    const [feature] = shipFeatures([old], NOW).features;
    expect(feature.properties.stale).toBe(true);
  });

  it('are not stale the moment they are a second old', () => {
    const [feature] = shipFeatures([vessel({ lastSeenMs: NOW - 1000 })], NOW).features;
    expect(feature.properties.stale).toBe(false);
  });
});

describe('the layer specifications', () => {
  it('names its own source and nothing else', () => {
    // Sharing the aircraft source would draw both feeds at once, each in the
    // other's colours.
    for (const layer of shipLayers()) {
      expect((layer as { source: string }).source).toBe(SHIP_SOURCE);
    }
  });

  it('draws hulls and names as two layers, so only the names may collide', () => {
    // Hiding a hull because another is near it would be losing a ship, and in
    // a harbour every ship is near another. A hundred overlapping names are
    // worse than none.
    const [icons, labels] = shipLayers();
    expect(icons.id).toBe(SHIP_LAYER);
    expect(labels.id).toBe(SHIP_LABEL_LAYER);
    expect((icons.layout as Record<string, unknown>)['icon-allow-overlap']).toBe(true);
    const labelLayout = labels.layout as Record<string, unknown>;
    expect(labelLayout['text-allow-overlap']).toBe(false);
    expect(labelLayout['text-optional']).toBe(true);
  });

  it('holds the names back until a port is big enough to fit them', () => {
    // Aircraft callsigns start at zoom 5, where a continent holds a few
    // hundred aircraft spread thinly. Ships cluster into harbours, so the same
    // threshold produces one illegible mass (D165).
    const [, labels] = shipLayers();
    expect(labels.minzoom).toBeGreaterThan(5);
  });

  it('rotates against the map rather than the screen', () => {
    // Screen-aligned rotation would keep every hull pointing the same way as
    // the map turned, which is not what a heading is.
    const [icons] = shipLayers();
    expect((icons.layout as Record<string, unknown>)['icon-rotation-alignment']).toBe('map');
  });

  it('keeps the zoom curve as the direct input of the interpolate', () => {
    // MapLibre allows a `zoom` expression only as the direct input of a
    // top-level interpolate. Wrapping it makes the layer invalid, and an
    // invalid layer is dropped with no error at all - every hull would
    // disappear while the names, being a separate layer, stayed put.
    const [icons] = shipLayers();
    const size = (icons.layout as Record<string, unknown>)['icon-size'] as unknown[];
    expect(size[0]).toBe('interpolate');
    expect(size[2]).toEqual(['zoom']);
  });
});
