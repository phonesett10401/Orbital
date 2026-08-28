/**
 * The style for the MapLibre planet view: satellite from space, map up close.
 *
 * Phase 1 of the migration out of globe.gl (D54). The globe here is MapLibre's
 * own globe projection, so there is one renderer and one continuous zoom from
 * orbit to a street corner, rather than a hand-off between two (D52, D53).
 *
 * ## Two sources, and why the seam between them is a fade
 *
 * - **Imagery**, from NASA GIBS. `BlueMarble_NextGeneration` is 500 m per
 *   pixel, static and cloud-free, which is the "Earth from space" look and
 *   about forty times sharper than the single 9.8 km/texel JPEG the old globe
 *   stretched over the whole planet.
 * - **Vector**, from OpenFreeMap: roads, labels, buildings, sharp at every
 *   zoom because it is geometry rather than pixels.
 *
 * Imagery runs out at zoom 8; vector detail is thin above it and complete
 * below. So the raster fades out exactly where it stops being able to keep up,
 * and the vector map is already underneath it when it does. Neither source is
 * asked to do the other's job, which is what went wrong when one baked texture
 * was asked to cover the whole range.
 *
 * ## Neither source needs an API key, and neither meters us
 *
 * GIBS is NASA open data; OpenFreeMap publishes no cap. That was the condition
 * this whole direction was chosen under. Both are still third-party requests
 * from the browser, which D7 otherwise forbids — the end state is a Protomaps
 * extract and a GIBS mirror behind our own backend, and `config` is where both
 * URLs live so that is a configuration change rather than a code one.
 */

import type { StyleSpecification } from 'maplibre-gl';

import { config } from '../config';

/** The zoom at which GIBS imagery runs out. */
export const IMAGERY_MAX_ZOOM = 8;

/** Where the fade from imagery to vector starts and finishes. */
export const IMAGERY_FADE_START = 5.5;
export const IMAGERY_FADE_END = 7.5;

export const GIBS_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA EOSDIS GIBS</a>';

/**
 * A MapLibre style, built by layering imagery into a vector basemap style.
 *
 * The vector style is fetched rather than written out here: it is 111 layers
 * of cartography that somebody else has already tuned, and rewriting it would
 * be a hobby rather than a task. What this adds is the raster source, one
 * raster layer immediately above the style's background, and the globe
 * projection.
 */
export function withImagery(style: StyleSpecification): StyleSpecification {
  const layers = [...style.layers];

  // Immediately above `background`, so every piece of vector cartography --
  // water, landcover, roads, labels -- still draws on top of the imagery and
  // is what remains once it has faded out.
  const backgroundIndex = layers.findIndex((layer) => layer.type === 'background');
  const insertAt = backgroundIndex >= 0 ? backgroundIndex + 1 : 0;

  layers.splice(insertAt, 0, {
    id: 'orbital-imagery',
    type: 'raster',
    source: 'orbital-imagery',
    paint: {
      // Opaque while it is the sharpest thing available, gone by the zoom
      // where the vector map has more to say than 500 m pixels can.
      'raster-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        IMAGERY_FADE_START,
        1,
        IMAGERY_FADE_END,
        0,
      ],
    },
  });

  return {
    ...style,
    projection: { type: 'globe' },
    sources: {
      ...style.sources,
      'orbital-imagery': {
        type: 'raster',
        tiles: [config.imageryTileUrl],
        tileSize: 256,
        maxzoom: IMAGERY_MAX_ZOOM,
        attribution: GIBS_ATTRIBUTION,
      },
    },
    layers,
  };
}

/**
 * Fetch the vector style and layer imagery into it.
 *
 * A failure here is fatal to the view in a way the geography layers never were
 * — there is no map without a style — so it rejects rather than degrading, and
 * the caller decides what to show instead.
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
