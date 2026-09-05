/**
 * Drawing the lunar spacecraft on the Moon (D134).
 *
 * Deliberately plainer than the satellite layer beside it. That one colours by
 * orbit regime and picks a silhouette per spacecraft type because it is
 * separating sixteen hundred objects; here there are three, each with a name
 * worth reading, so the label *is* the encoding and a colour ramp would be
 * three arbitrary colours pretending to mean something.
 */

import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';

export const MOON_SOURCE = 'orbital-moon-satellites';
export const MOON_LAYER = 'orbital-moon-satellites';
export const MOON_HALO_LAYER = 'orbital-moon-satellites-halo';
export const MOON_LABEL_LAYER = 'orbital-moon-satellites-label';

/** Warm against the Moon's grey, which is the only contrast available. */
export const MOON_CRAFT_COLOUR = '#ffd166';

export function moonSource(): SourceSpecification {
  return {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  } as SourceSpecification;
}

/**
 * Three layers: a soft halo, the marker, and the name.
 *
 * The halo is not decoration - the lunar mosaic is mid-grey almost everywhere,
 * and a small warm dot on it is legible only if something separates the two.
 */
export function moonSatelliteLayers(): LayerSpecification[] {
  return [
    {
      id: MOON_HALO_LAYER,
      type: 'circle',
      source: MOON_SOURCE,
      paint: {
        'circle-radius': 9,
        'circle-color': MOON_CRAFT_COLOUR,
        'circle-opacity': 0.18,
        'circle-blur': 0.6,
      },
    },
    {
      id: MOON_LAYER,
      type: 'circle',
      source: MOON_SOURCE,
      paint: {
        'circle-radius': 4,
        'circle-color': MOON_CRAFT_COLOUR,
        'circle-stroke-color': '#20160a',
        'circle-stroke-width': 1,
      },
    },
    {
      id: MOON_LABEL_LAYER,
      type: 'symbol',
      source: MOON_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#ffe9b8',
        'text-halo-color': '#1a1208',
        'text-halo-width': 1.4,
      },
    },
  ] as LayerSpecification[];
}
