/**
 * The style for the planet view: imagery everywhere, cartography on top.
 *
 * Phase 1 of the migration out of globe.gl (D54), corrected after somebody
 * looked at it (D56). The globe here is MapLibre's own globe projection, so
 * there is one renderer and one continuous zoom from orbit to a street corner
 * rather than a hand-off between two (D52, D53).
 *
 * ## Imagery is the ground, at every zoom
 *
 * The first attempt layered imagery *under* a vector basemap and faded it out
 * at zoom 7.5. Below that the basemap was the ground — and the basemap's
 * background is `#f8f4f0`, so zooming into anywhere without roads gave a cream
 * screen. Fading real imagery out into a blank fill is precisely backwards.
 *
 * So imagery runs the whole way, in two tiers, and the vector tiles contribute
 * only what imagery cannot say:
 *
 * | | Source | Resolution | Reaches | Terms |
 * |---|---|---|---|---|
 * | Far | NASA GIBS `BlueMarble_NextGeneration` | 500 m | z8 | open data, unmetered |
 * | Near | EOX Sentinel-2 cloudless | 10 m | z15 | no key, **fair use** |
 * | Over both | OpenFreeMap vector | — | z14+ | no key, no cap |
 *
 * Two imagery sources rather than one because their terms differ. GIBS is
 * NASA's public service and carries every view of the planet; Sentinel-2 is a
 * courtesy from a company that asks not to be pointed at production traffic,
 * and is only reached by zooming past a continent. If this ever needs to
 * survive real traffic, both are configuration.
 *
 * ## What the vector tiles are allowed to draw
 *
 * Only what sits *on* the ground rather than replacing it: lines (roads,
 * boundaries, rivers), symbols (labels, icons) and extrusions (buildings).
 * Every area fill and the background are dropped, because their whole job is
 * to colour ground that imagery is already showing — and it is their colour
 * that produced the cream screen.
 */

import type { LayerSpecification, StyleSpecification } from 'maplibre-gl';

import { config } from '../config';

/** Where each imagery tier stops having tiles of its own. */
export const IMAGERY_FAR_MAX_ZOOM = 8;
export const IMAGERY_NEAR_MAX_ZOOM = 15;

/** Where the close imagery fades in over the far one. */
export const IMAGERY_CROSSFADE_START = 5;
export const IMAGERY_CROSSFADE_END = 7;

export const GIBS_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA EOSDIS GIBS</a>';

export const SENTINEL_ATTRIBUTION =
  '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH ' +
  '(Contains modified Copernicus Sentinel data)';

/**
 * The vector layer types that draw *on* the ground rather than replacing it.
 *
 * `fill` and `background` are deliberately absent. A fill's purpose is to
 * colour an area — water blue, parks green, everything else cream — which is
 * exactly what imagery is there to do, and better.
 */
export const KEPT_LAYER_TYPES = new Set(['line', 'symbol', 'fill-extrusion']);

/**
 * Build the planet style from a vector basemap style.
 *
 * The vector style is fetched rather than written here: it is a hundred layers
 * of tuned cartography, and the useful part of it — where roads go, what gets
 * a label, how buildings extrude — survives this filter intact.
 */
export function withImagery(style: StyleSpecification): StyleSpecification {
  const cartography = style.layers.filter((layer) => KEPT_LAYER_TYPES.has(layer.type));

  const far: LayerSpecification = {
    id: 'orbital-imagery-far',
    type: 'raster',
    source: 'orbital-imagery-far',
    paint: { 'raster-opacity': 1 },
  };

  const near: LayerSpecification = {
    id: 'orbital-imagery-near',
    type: 'raster',
    source: 'orbital-imagery-near',
    paint: {
      // Fades in over the far tier rather than replacing it, so the seam is a
      // dissolve between two photographs of the same ground rather than a cut.
      'raster-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        IMAGERY_CROSSFADE_START,
        0,
        IMAGERY_CROSSFADE_END,
        1,
      ],
    },
  };

  return {
    ...style,
    projection: { type: 'globe' },
    sources: {
      ...style.sources,
      'orbital-imagery-far': {
        type: 'raster',
        tiles: [config.imageryTileUrl],
        tileSize: 256,
        maxzoom: IMAGERY_FAR_MAX_ZOOM,
        attribution: GIBS_ATTRIBUTION,
      },
      'orbital-imagery-near': {
        type: 'raster',
        tiles: [config.imageryCloseTileUrl],
        tileSize: 256,
        maxzoom: IMAGERY_NEAR_MAX_ZOOM,
        attribution: SENTINEL_ATTRIBUTION,
      },
    },
    // Imagery first so it is the ground; cartography over it, in the order the
    // basemap's authors chose.
    layers: [far, near, ...cartography],
  };
}

/**
 * Fetch the vector style and build the planet style from it.
 *
 * A failure here is fatal in a way the geography layers never were — there is
 * no map without a style — so it rejects rather than degrading, and the caller
 * decides what to show instead.
 */
export async function loadPlanetStyle(
  fetchStyle: (url: string) => Promise<StyleSpecification> = defaultFetch,
): Promise<StyleSpecification> {
  return withImagery(await fetchStyle(config.cityStyleUrl));
}

async function defaultFetch(url: string): Promise<StyleSpecification> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as StyleSpecification;
}
