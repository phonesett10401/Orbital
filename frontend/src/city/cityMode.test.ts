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

  it('hands off well short of where buildings begin', () => {
    // The point of the spike, as a number: entering at matched scale over
    // Bangkok lands at zoom 7.8, and buildings start at 14. The globe cannot
    // get within six zoom levels of them, which is why a second renderer is
    // the only way to answer the question at all.
    const zoom = mapZoomFor(CITY_ENTER_ALTITUDE, 13.75, HEIGHT, FOV);
    expect(zoom).toBeCloseTo(7.8, 1);
    expect(BUILDINGS_MIN_ZOOM - zoom).toBeGreaterThan(5);
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
    map.getZoom.mockReturnValue(6);
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

    map.getZoom.mockReturnValue(15);
    Object.defineProperty(layer.element, 'clientHeight', { value: HEIGHT });
    handlers.get('zoomend')?.();

    expect(onExit).not.toHaveBeenCalled();
    expect(layer.isActive()).toBe(true);
    layer.dispose();
  });
});
