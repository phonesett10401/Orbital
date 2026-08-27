/**
 * Tests for the globe-to-map hand-off.
 *
 * MapLibre needs a WebGL context and there is none under vitest, so what is
 * tested here is everything except the map: the scale mapping in both
 * directions, the hysteresis that stops the boundary flickering, and the
 * lifecycle around a stubbed loader.
 *
 * The scale mapping is the part worth testing. If it is wrong the world
 * changes size at the instant the renderer changes, which is the one thing
 * that would make the transition unusable, and it is wrong in exactly two
 * ways that look plausible: the 256-versus-512 pixel tile convention (a factor
 * of two) and forgetting that Web Mercator's scale depends on latitude.
 */

import { describe, expect, it, vi } from 'vitest';

import type { CityAircraft } from './cityMode';
import {
  BUILDINGS_MIN_ZOOM,
  CITY_ENTER_ALTITUDE,
  CITY_EXIT_ALTITUDE,
  altitudeForZoom,
  createCityLayer,
  groundHeightKm,
  mapZoomFor,
  shouldEnterCity,
  shouldExitCity,
} from './cityMode';

const FOV = 50;
const HEIGHT = 900;

describe('groundHeightKm', () => {
  it('matches the figure the globe was measured at', () => {
    // The camera's floor is 0.014 radii, where the view is 83 km tall. That
    // number is quoted in D51 and in the argument for city mode existing.
    expect(groundHeightKm(0.014, FOV)).toBeCloseTo(83, 0);
  });

  it('scales linearly with altitude', () => {
    expect(groundHeightKm(0.1, FOV) / groundHeightKm(0.05, FOV)).toBeCloseTo(2, 6);
  });
});

describe('mapZoomFor', () => {
  it('round-trips with altitudeForZoom', () => {
    for (const altitude of [0.014, 0.03, 0.05, 0.09, 0.2]) {
      for (const lat of [0, 13.75, 45, 60]) {
        const zoom = mapZoomFor(altitude, lat, HEIGHT, FOV);
        expect(altitudeForZoom(zoom, lat, HEIGHT, FOV)).toBeCloseTo(altitude, 6);
      }
    }
  });

  it('needs a higher zoom further from the equator, for the same ground', () => {
    // Web Mercator shrinks as latitude rises, so holding the ground distance
    // constant costs zoom. Ignoring this would make the hand-off jump
    // everywhere except the tropics.
    const equator = mapZoomFor(0.05, 0, HEIGHT, FOV);
    const bangkok = mapZoomFor(0.05, 13.75, HEIGHT, FOV);
    const stockholm = mapZoomFor(0.05, 59.3, HEIGHT, FOV);
    expect(bangkok).toBeLessThan(equator);
    expect(stockholm).toBeLessThan(bangkok);
    // cos(59.3) is about half of cos(0), which is one zoom level.
    expect(equator - stockholm).toBeCloseTo(1, 0);
  });

  it('uses the 512-pixel tile convention MapLibre defines zoom against', () => {
    // At zoom z the world is 512 * 2^z pixels around. Getting this wrong by
    // the 256-pixel convention is a factor of two in ground scale, which reads
    // as the world doubling in size at the boundary. One tile of ground at
    // zoom 0 across a 512 px viewport is therefore exactly zoom 0.
    const metresAcrossTheWorld = 40_075_016.686;
    const altitude =
      metresAcrossTheWorld / 1000 / (2 * 6371 * Math.tan((FOV / 2) * (Math.PI / 180)));
    expect(mapZoomFor(altitude, 0, 512, FOV)).toBeCloseTo(0, 6);
  });

  it('hands off far short of where buildings begin', () => {
    // The point of the spike, as a number: entering at matched scale over
    // Bangkok lands around zoom 5, and buildings start at 14. The globe cannot
    // get within eight zoom levels of them, which is why a second renderer is
    // the only way to answer the question at all.
    const zoom = mapZoomFor(CITY_ENTER_ALTITUDE, 13.75, HEIGHT, FOV);
    expect(zoom).toBeCloseTo(5, 0);
    expect(BUILDINGS_MIN_ZOOM - zoom).toBeGreaterThan(8);
  });

  it('hands over while the globe texture still holds up', () => {
    // The measurement that moved this threshold: the colour texture is 9.8 km
    // per texel, and magnification past a handful of texels per screen pixel
    // is the smear of night lights that got reported (D53). Five is soft;
    // thirty-six, which is where the first version handed over, is nothing.
    const TEXEL_KM = 40075 / 4096;
    const viewKm = groundHeightKm(CITY_ENTER_ALTITUDE, FOV);
    const texelsPerPixel = TEXEL_KM / (viewKm / 1080);
    expect(texelsPerPixel).toBeLessThan(8);
  });
});

describe('the hand-off thresholds', () => {
  it('enters below the entry altitude and not above it', () => {
    expect(shouldEnterCity(CITY_ENTER_ALTITUDE - 0.001, false)).toBe(true);
    expect(shouldEnterCity(CITY_ENTER_ALTITUDE + 0.001, false)).toBe(false);
  });

  it('does not enter when already there, or exit when not', () => {
    expect(shouldEnterCity(0.01, true)).toBe(false);
    expect(shouldExitCity(0.5, false)).toBe(false);
  });

  it('leaves a gap between entering and leaving', () => {
    // One threshold for both directions sits exactly where the user is
    // scrolling and flickers between two renderers on every notch.
    expect(CITY_EXIT_ALTITUDE).toBeGreaterThan(CITY_ENTER_ALTITUDE);
    const between = (CITY_ENTER_ALTITUDE + CITY_EXIT_ALTITUDE) / 2;
    expect(shouldEnterCity(between, false)).toBe(false);
    expect(shouldExitCity(between, true)).toBe(false);
  });
});

describe('createCityLayer', () => {
  const stubMap = () => {
    const handlers = new Map<string, () => void>();
    const map = {
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      easeTo: vi.fn(),
      jumpTo: vi.fn(),
      remove: vi.fn(),
      getCenter: vi.fn(() => ({ lat: 13.75, lng: 100.5 })),
      getZoom: vi.fn(() => 9),
    };
    return { map, handlers };
  };

  function layerWith(map: unknown, onExit = vi.fn()) {
    const loadMapLibre = vi.fn(async () => ({
      Map: vi.fn(() => map),
    })) as unknown as () => Promise<typeof import('maplibre-gl')>;
    return { layer: createCityLayer({ onExit, loadMapLibre }), loadMapLibre, onExit };
  }

  it('starts hidden and inactive, and loads nothing', () => {
    const { layer, loadMapLibre } = layerWith(stubMap().map);
    expect(layer.isActive()).toBe(false);
    expect(layer.element.style.display).toBe('none');
    // 800 KB of MapLibre for a globe nobody zooms into would be a poor trade.
    expect(loadMapLibre).not.toHaveBeenCalled();
    layer.dispose();
  });

  it('loads MapLibre once, on the first hand-off', async () => {
    const { map } = stubMap();
    const { layer, loadMapLibre } = layerWith(map);

    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.04 }, FOV);
    expect(loadMapLibre).toHaveBeenCalledTimes(1);
    expect(layer.isActive()).toBe(true);
    expect(layer.element.style.display).toBe('');

    layer.exit();
    await layer.enter({ lat: 18.8, lon: 99, altitude: 0.04 }, FOV);
    expect(loadMapLibre).toHaveBeenCalledTimes(1);
    expect(map.jumpTo).toHaveBeenCalled();
    layer.dispose();
  });

  it('dives toward the zoom where buildings exist', async () => {
    const { map } = stubMap();
    const { layer } = layerWith(map);
    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.05 }, FOV);

    const eased = map.easeTo.mock.calls[0][0] as { zoom: number; pitch: number };
    expect(eased.zoom).toBeGreaterThan(BUILDINGS_MIN_ZOOM - 1);
    // Flat, a footprint is a polygon; the tilt is what makes it a building.
    expect(eased.pitch).toBeGreaterThan(30);
    layer.dispose();
  });

  it('hands the view back where the map ended up', async () => {
    const { map, handlers } = stubMap();
    const onExit = vi.fn();
    const { layer } = layerWith(map, onExit);
    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.04 }, FOV);

    // Zoomed far enough out that the globe should take over again.
    map.getZoom.mockReturnValue(4);
    Object.defineProperty(layer.element, 'clientHeight', { value: HEIGHT });
    handlers.get('zoomend')?.();

    expect(layer.isActive()).toBe(false);
    expect(onExit).toHaveBeenCalledTimes(1);
    const view = onExit.mock.calls[0][0] as { lat: number; altitude: number };
    expect(view.lat).toBeCloseTo(13.75, 6);
    expect(view.altitude).toBeGreaterThanOrEqual(CITY_EXIT_ALTITUDE);
    layer.dispose();
  });

  it('stays put while the map is still zoomed in', async () => {
    const { map, handlers } = stubMap();
    const onExit = vi.fn();
    const { layer } = layerWith(map, onExit);
    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.04 }, FOV);

    map.getZoom.mockReturnValue(9);
    Object.defineProperty(layer.element, 'clientHeight', { value: HEIGHT });
    handlers.get('zoomend')?.();

    expect(onExit).not.toHaveBeenCalled();
    expect(layer.isActive()).toBe(true);
    layer.dispose();
  });
});

describe('aircraft in city mode', () => {
  const aircraft: CityAircraft[] = [
    { id: 'a1', lat: 13.75, lon: 100.5, heading: 270, label: 'THA932' },
    { id: 'b2', lat: 13.8, lon: 100.6, heading: null, label: 'e0ge05' },
  ];

  function stub() {
    const handlers = new Map<string, () => void>();
    const source = { setData: vi.fn() };
    const map = {
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
      easeTo: vi.fn(),
      jumpTo: vi.fn(),
      remove: vi.fn(),
      getCenter: vi.fn(() => ({ lat: 13.75, lng: 100.5 })),
      getZoom: vi.fn(() => 9),
      getSource: vi.fn(() => source),
      hasImage: vi.fn(() => true),
      addImage: vi.fn(),
      addSource: vi.fn(),
      addLayer: vi.fn(),
    };
    const loadMapLibre = vi.fn(async () => ({ Map: vi.fn(() => map) })) as unknown as () => Promise<
      typeof import('maplibre-gl')
    >;
    return { map, source, handlers, loadMapLibre };
  }

  it('is silent before the map exists, rather than throwing', () => {
    // The globe pushes aircraft every time the store changes, including long
    // before anybody zooms in.
    const { loadMapLibre } = stub();
    const layer = createCityLayer({ onExit: vi.fn(), loadMapLibre });
    expect(() => layer.setAircraft(aircraft)).not.toThrow();
    layer.dispose();
  });

  it('pushes them to the map as GeoJSON once it is up', async () => {
    const { map, source, loadMapLibre } = stub();
    const layer = createCityLayer({ onExit: vi.fn(), loadMapLibre });
    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.2 }, FOV);

    layer.setAircraft(aircraft);
    const data = source.setData.mock.calls.at(-1)?.[0] as {
      features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, unknown> }>;
    };
    expect(data.features).toHaveLength(2);
    // GeoJSON is lon/lat, the contract is lat/lon, and swapping them puts every
    // aircraft in the wrong hemisphere without anything failing.
    expect(data.features[0].geometry.coordinates).toEqual([100.5, 13.75]);
    expect(data.features[0].properties.heading).toBe(270);
    expect(data.features[0].properties.label).toBe('THA932');
    void map;
    layer.dispose();
  });

  it('gives an unknown heading no rotation rather than pointing it north', () => {
    // Same rule as the marker atlas and the 3D model: a null heading has no
    // direction to draw (D40, D42). MapLibre has no way to say "no rotation",
    // so this at least does not claim a heading it does not have.
    const { source, loadMapLibre } = stub();
    const layer = createCityLayer({ onExit: vi.fn(), loadMapLibre });
    void layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.2 }, FOV).then(() => {
      layer.setAircraft(aircraft);
      const data = source.setData.mock.calls.at(-1)?.[0] as {
        features: Array<{ properties: Record<string, unknown> }>;
      };
      expect(data.features[1].properties.heading).toBe(0);
      layer.dispose();
    });
  });
});

describe('a hand-off that fails', () => {
  it('hands back instead of stranding the view behind an empty map', async () => {
    // The failure that produced no city mode and no globe either: `active` was
    // set before the await, so a throw left the layer permanently "active",
    // showing a transparent div over the globe and never retrying.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const loadMapLibre = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as () => Promise<typeof import('maplibre-gl')>;

    const layer = createCityLayer({ onExit: vi.fn(), loadMapLibre });
    await layer.enter({ lat: 13.75, lon: 100.5, altitude: 0.2 }, FOV);

    expect(layer.isActive()).toBe(false);
    expect(layer.element.style.display).toBe('none');
    layer.dispose();
  });
});
