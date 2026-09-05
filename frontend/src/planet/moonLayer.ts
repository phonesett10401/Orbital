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
        'circle-radius': 5,
        'circle-color': MOON_CRAFT_COLOUR,
        'circle-opacity': 0.16,
        'circle-blur': 0.7,
      },
    },
    {
      // **The sub-point, deliberately small.** It marks the ground beneath the
      // spacecraft, and the spacecraft itself is drawn 13 pixels above it by
      // the 3D shell. At the size this started - a 9 pixel halo over a 4 pixel
      // dot - the marker was wider than the height it was marking and covered
      // the tether completely, so real altitude was computed, drawn, and
      // invisible (D136).
      id: MOON_LAYER,
      type: 'circle',
      source: MOON_SOURCE,
      paint: {
        'circle-radius': 2.2,
        'circle-color': MOON_CRAFT_COLOUR,
        'circle-opacity': 0.85,
      },
    },
    {
      id: MOON_LABEL_LAYER,
      type: 'symbol',
      source: MOON_SOURCE,
      layout: {
        'text-field': ['get', 'label'],
        'text-size': 11,
        'text-offset': [0, 1.1],
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

export const MOON_LEADER_SOURCE = 'orbital-moon-leader';
export const MOON_LEADER_LAYER = 'orbital-moon-leader';

export function moonLeaderSource(): SourceSpecification {
  return {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  } as SourceSpecification;
}

/**
 * The callout line from the selected spacecraft.
 *
 * Drawn under the markers so it reads as leaving the spacecraft rather than
 * crossing it, and thin: it is a pointer, not a track. Nothing about its
 * geometry is here - `moonLeader.ts` computes it in screen space, because a 45
 * degree callout means 45 degrees to the eye (D136).
 */
export function moonLeaderLayer(): LayerSpecification {
  return {
    id: MOON_LEADER_LAYER,
    type: 'line',
    source: MOON_LEADER_SOURCE,
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': MOON_CRAFT_COLOUR,
      'line-width': 1.4,
      'line-opacity': 0.85,
    },
  } as LayerSpecification;
}
