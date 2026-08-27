/**
 * City mode: a spike, not a feature yet.
 *
 * The globe stops at 89 km altitude, where a view is 83 km tall and the colour
 * texture is 9.8 km per pixel (D17 and the note in D51). Buildings live three
 * orders of magnitude below that. This module answers the question "what would
 * it feel like to keep zooming?" by handing off, below a threshold, to a
 * MapLibre map centred on the same spot — which does have tiles, and does have
 * 3D buildings.
 *
 * **What makes it a spike and not a decision.** Two renderers means two of
 * everything the eye can see: no aircraft in city mode, no terminator, no
 * markers, no route. It is here to be looked at, and to answer whether the
 * OpenStreetMap building data over Thailand is good enough to be worth the
 * migration that would make it a real feature. See D52.
 *
 * ## Tiles
 *
 * OpenFreeMap: no API key, no registration, no usage cap, OpenStreetMap data
 * under ODbL with attribution. That is what makes it usable here at all — the
 * providers with free tiers all meter them.
 *
 * **It is still a third-party request from the browser, which this project
 * does not otherwise permit** (D7: the browser talks to our backend and
 * nothing else). For a spike that is an acceptable, visible exception. The
 * answer if this becomes real is a Protomaps `.pmtiles` extract of the region
 * served by our own backend — one static file, no third party at runtime, and
 * no limits of any kind. `config.cityStyleUrl` is what would be repointed.
 *
 * ## Scale continuity
 *
 * The hand-off is at matched scale: the ground distance across the viewport is
 * the same on both sides of the boundary, computed rather than guessed, so the
 * world does not jump size at the moment the renderer changes. Entering then
 * eases down toward the zoom where buildings begin, which is the only way to
 * make the transition legible — at matched scale alone, the first frame of
 * city mode looks like the globe with the planet switched off.
 */

import { config } from '../config';
import { createAircraftIconCanvas } from '../globe/aircraftSprite';

/** Mean Earth radius, km. The globe's own scale is in radii. */
const EARTH_RADIUS_KM = 6371;

/**
 * Ground metres per pixel at zoom 0 on the equator, for 512 px tiles.
 *
 * MapLibre's zoom is defined against 512 px tiles, so this is half the figure
 * quoted for the 256 px slippy-map convention. Getting this wrong is a factor
 * of two in the hand-off, which reads as the world doubling in size.
 */
const METERS_PER_PIXEL_AT_ZOOM_0 = 78271.51696;

const DEG_TO_RAD = Math.PI / 180;

/**
 * Altitude, in globe radii, at which the globe hands over.
 *
 * The first version handed over at 0.05, which was far too late. The colour
 * texture is 9.8 km per texel, so magnification against a 1080-pixel viewport
 * runs:
 *
 * | altitude | view | texels per screen pixel |
 * |---|---|---|
 * | 0.60 | 3,565 km | 3.0 |
 * | 0.35 | 2,080 km | 5.1 |
 * | 0.20 | 1,188 km | 8.9 |
 * | 0.05 | 297 km | **35.6** |
 * | 0.014 | 83 km | **127** |
 *
 * At thirty-five texels per pixel there is no image left, only a smear of
 * night lights -- which is exactly how it was described when somebody looked
 * at it (D53). The hand-off belongs where the globe still reads as a planet,
 * and the map, being vector, is sharp at every zoom below that.
 *
 * 0.35 also happens to be where the label tiers start showing cities (D45), so
 * the rule is legible: when city names appear, the city map takes over.
 */
export const CITY_ENTER_ALTITUDE = config.cityEnterAltitude;

/**
 * Altitude at which city mode hands back.
 *
 * Deliberately above the entry altitude. One threshold for both directions
 * puts the boundary exactly where the user is scrolling and flickers between
 * two renderers; the gap is what makes the transition a decision rather than
 * an oscillation.
 */
export const CITY_EXIT_ALTITUDE = config.cityEnterAltitude * 1.5;

/** Buildings appear at this zoom in the OpenMapTiles schema. */
export const BUILDINGS_MIN_ZOOM = 14;

/** How far past the hand-off to ease, so the mode change is visible. */
const ENTRY_DIVE_ZOOM = 13.5;

/** The ground distance across the viewport's height, in km. */
export function groundHeightKm(altitudeRadii: number, fovDeg: number): number {
  return 2 * altitudeRadii * EARTH_RADIUS_KM * Math.tan((fovDeg / 2) * DEG_TO_RAD);
}

/**
 * The MapLibre zoom that shows the same ground distance the globe was showing.
 *
 * Web Mercator's scale depends on latitude, so this is not a constant mapping:
 * the same zoom covers about a quarter as much ground at 60 degrees north as
 * it does on the equator, and ignoring that would make the hand-off jump for
 * everywhere except the tropics.
 */
export function mapZoomFor(
  altitudeRadii: number,
  lat: number,
  viewportHeightPx: number,
  fovDeg: number,
): number {
  const metres = groundHeightKm(altitudeRadii, fovDeg) * 1000;
  const perPixel = metres / viewportHeightPx;
  return Math.log2((METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos(lat * DEG_TO_RAD)) / perPixel);
}

/** The inverse, for handing back to the globe at the scale the map was at. */
export function altitudeForZoom(
  zoom: number,
  lat: number,
  viewportHeightPx: number,
  fovDeg: number,
): number {
  const perPixel = (METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos(lat * DEG_TO_RAD)) / 2 ** zoom;
  const metres = perPixel * viewportHeightPx;
  return metres / 1000 / (2 * EARTH_RADIUS_KM * Math.tan((fovDeg / 2) * DEG_TO_RAD));
}

/** Whether the globe should hand over, given where the camera is now. */
export function shouldEnterCity(altitudeRadii: number, active: boolean): boolean {
  return !active && altitudeRadii <= CITY_ENTER_ALTITUDE;
}

/** Whether city mode should hand back. */
export function shouldExitCity(altitudeRadii: number, active: boolean): boolean {
  return active && altitudeRadii >= CITY_EXIT_ALTITUDE;
}

export interface CityView {
  lat: number;
  lon: number;
  altitude: number;
}

/** The minimum an aircraft needs for city mode to draw it. */
export interface CityAircraft {
  id: string;
  lat: number;
  lon: number;
  heading: number | null;
  label: string;
}

export interface CityLayer {
  element: HTMLDivElement;
  isActive(): boolean;
  enter(view: CityView, fovDeg: number): Promise<void>;
  /** Draw these aircraft on the map. Ignored while the map is not up. */
  setAircraft(aircraft: CityAircraft[]): void;
  exit(): void;
  dispose(): void;
}

export interface CityLayerOptions {
  /** Called when the user has zoomed back out far enough to want the globe. */
  onExit(view: CityView): void;
  /** Test seam: what to load instead of the real MapLibre. */
  loadMapLibre?: () => Promise<typeof import('maplibre-gl')>;
}

/**
 * The real loader: the library and its stylesheet, together.
 *
 * The stylesheet is not optional. Without it the attribution control renders
 * unstyled, and attribution is a licence condition of the tiles, not a
 * decoration. Both are dynamic imports so neither is in the bundle until
 * somebody actually zooms in.
 */
async function loadMapLibreWithStyles(): Promise<typeof import('maplibre-gl')> {
  await import('maplibre-gl/dist/maplibre-gl.css');
  return import('maplibre-gl');
}

/**
 * Create the city layer.
 *
 * MapLibre is imported dynamically, on the first hand-off. It is about 800 KB
 * of JavaScript, and a globe that nobody zooms into should not pay for it.
 */
export function createCityLayer({
  onExit,
  loadMapLibre = loadMapLibreWithStyles,
}: CityLayerOptions): CityLayer {
  const element = document.createElement('div');
  element.className = 'city-map';
  element.style.display = 'none';

  type MapLibreMap = import('maplibre-gl').Map;
  let map: MapLibreMap | null = null;
  let active = false;
  let fov = 50;
  /** Held so the layer can be created with whatever is current when it loads. */
  let pending: CityAircraft[] = [];

  /**
   * The aircraft, as GeoJSON.
   *
   * City mode used to draw none, which was defensible for a spike and
   * indefensible once the hand-off moved up to 0.35 radii: that is most of the
   * zoom range somebody watching aeroplanes actually uses, and an aircraft
   * tracker that hides the aircraft when you look closely is not one (D53).
   */
  function featuresFor(aircraft: CityAircraft[]) {
    return {
      type: 'FeatureCollection' as const,
      features: aircraft.map((a) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [a.lon, a.lat] },
        properties: {
          label: a.label,
          // MapLibre rotates icons clockwise from north, which is the same
          // convention the contract uses for heading (D18), so this passes
          // through untouched. A null heading gets no rotation and the icon
          // reads as pointing north, so those are dropped instead.
          heading: a.heading ?? 0,
        },
      })),
    };
  }

  function handBack(): void {
    if (!map || !active) return;
    const centre = map.getCenter();
    const height = element.clientHeight || 1;
    const altitude = altitudeForZoom(map.getZoom(), centre.lat, height, fov);
    if (altitude < CITY_EXIT_ALTITUDE) return;
    layer.exit();
    onExit({ lat: centre.lat, lon: centre.lng, altitude });
  }

  function addAircraftLayer(): void {
    if (!map || map.getSource('orbital-aircraft')) return;
    if (!map.hasImage('orbital-aircraft-icon')) {
      const canvas = createAircraftIconCanvas();
      const context = canvas.getContext('2d');
      if (context) {
        map.addImage(
          'orbital-aircraft-icon',
          context.getImageData(0, 0, canvas.width, canvas.height),
        );
      }
    }

    map.addSource('orbital-aircraft', { type: 'geojson', data: featuresFor(pending) });
    map.addLayer({
      id: 'orbital-aircraft',
      type: 'symbol',
      source: 'orbital-aircraft',
      layout: {
        'icon-image': 'orbital-aircraft-icon',
        'icon-size': 0.2,
        'icon-rotate': ['get', 'heading'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#e8ecf4',
        'text-halo-color': 'rgba(0,0,0,0.85)',
        'text-halo-width': 1.4,
      },
    });
  }

  const layer: CityLayer = {
    element,
    isActive: () => active,

    setAircraft(aircraft) {
      pending = aircraft;
      const source = map?.getSource('orbital-aircraft');
      // `setData` exists on a GeoJSON source and the union type does not know
      // which kind this is, so the check is the narrowing.
      if (source && 'setData' in source) {
        (source as { setData: (data: unknown) => void }).setData(featuresFor(aircraft));
      }
    },

    async enter(view, fovDeg) {
      if (active) return;
      active = true;
      fov = fovDeg;
      element.style.display = '';

      const height = element.clientHeight || 1;
      const zoom = mapZoomFor(view.altitude, view.lat, height, fovDeg);

      try {
        if (!map) {
          const maplibre = await loadMapLibre();
          map = new maplibre.Map({
            container: element,
            style: config.cityStyleUrl,
            center: [view.lon, view.lat],
            zoom,
            pitch: 0,
            attributionControl: { compact: true },
          });
          // Zooming out past the boundary is how the user asks for the globe
          // back, so the map itself is what watches for it.
          map.on('zoomend', handBack);
          map.on('load', () => addAircraftLayer());
        } else {
          map.jumpTo({ center: [view.lon, view.lat], zoom, pitch: 0 });
        }
      } catch (error) {
        // A failed hand-off must hand back, not strand the view. Leaving
        // `active` true would show an empty transparent div over the globe
        // forever and never retry, which is a worse outcome than no city mode.
        console.warn('[city] hand-off failed', error);
        active = false;
        element.style.display = 'none';
        return;
      }

      // Matched scale means the first frame looks exactly like the globe with
      // the planet switched off, so the mode change needs to be shown: ease
      // down to where buildings exist and tilt, which is what makes them read
      // as buildings rather than as footprints.
      map.easeTo({
        zoom: Math.max(zoom, ENTRY_DIVE_ZOOM),
        pitch: 55,
        duration: 1600,
      });
    },

    exit() {
      active = false;
      element.style.display = 'none';
    },

    dispose() {
      map?.remove();
      map = null;
      element.remove();
    },
  };

  return layer;
}
