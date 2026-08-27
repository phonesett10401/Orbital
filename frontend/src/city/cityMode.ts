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
 * Just above the camera's own floor of 0.014, so the hand-off happens while
 * the user is still zooming in rather than when they hit the stop.
 */
export const CITY_ENTER_ALTITUDE = 0.05;

/**
 * Altitude at which city mode hands back.
 *
 * Deliberately above the entry altitude. One threshold for both directions
 * puts the boundary exactly where the user is scrolling and flickers between
 * two renderers; the gap is what makes the transition a decision rather than
 * an oscillation.
 */
export const CITY_EXIT_ALTITUDE = 0.09;

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

export interface CityLayer {
  element: HTMLDivElement;
  isActive(): boolean;
  enter(view: CityView, fovDeg: number): Promise<void>;
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

  function handBack(): void {
    if (!map || !active) return;
    const centre = map.getCenter();
    const height = element.clientHeight || 1;
    const altitude = altitudeForZoom(map.getZoom(), centre.lat, height, fov);
    if (altitude < CITY_EXIT_ALTITUDE) return;
    layer.exit();
    onExit({ lat: centre.lat, lon: centre.lng, altitude });
  }

  const layer: CityLayer = {
    element,
    isActive: () => active,

    async enter(view, fovDeg) {
      if (active) return;
      active = true;
      fov = fovDeg;
      element.style.display = '';

      const height = element.clientHeight || 1;
      const zoom = mapZoomFor(view.altitude, view.lat, height, fovDeg);

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
      } else {
        map.jumpTo({ center: [view.lon, view.lat], zoom, pitch: 0 });
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
