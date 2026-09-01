/**
 * Satellites on the map.
 *
 * The globe draws satellites at a log-compressed height, because on a globe
 * height is available and it is the information (D96). **A map has no room
 * above it**, so this layer draws the one thing a map can honestly show: the
 * *sub-satellite point*, the spot on the ground each satellite is directly
 * over. That answers "what is passing over me right now", which is a real
 * question, and it cannot answer "how high is it", which is a different one.
 *
 * Two consequences follow, and both are deliberate:
 *
 * - **Altitude is carried by colour**, exactly as the aircraft layer does it —
 *   because here, as there, height is not available as a visual channel. The
 *   colours are by orbit regime rather than a continuous ramp: 97% of the
 *   catalogue is in low orbit, so a continuous scale would render almost
 *   everything the same shade and waste the channel.
 * - **Satellites are circles, not aeroplane silhouettes.** A satellite is not
 *   an aircraft and must not be drawn as one; the aircraft sprite would be a
 *   confident claim about a shape we do not have, which is the same mistake
 *   the globe's airframe guard prevents (D96).
 */

import type { LayerSpecification } from 'maplibre-gl';

import {
  REGIME_RGB,
  UNKNOWN_RGB,
  regimeCss,
  regimeFor,
  type OrbitRegime,
} from '../satelliteShell';
import type { RenderableObject } from '../types';

export const SATELLITE_SOURCE = 'orbital-satellites';
export const SATELLITE_LAYER = 'orbital-satellites';
export const SATELLITE_LABEL_LAYER = 'orbital-satellites-label';

/**
 * Colour per orbit regime.
 *
 * Chosen to run cool-to-warm with increasing altitude, so the ordering reads
 * without consulting the legend, and to stay distinguishable over both the
 * satellite imagery and the flat basemap.
 */
export const REGIME_COLOURS: Record<OrbitRegime, string> = Object.fromEntries(
  (Object.keys(REGIME_RGB) as OrbitRegime[]).map((regime) => {
    const [r, g, b] = REGIME_RGB[regime];
    return [regime, `rgb(${r}, ${g}, ${b})`];
  }),
) as Record<OrbitRegime, string>;

/** What an unknown altitude draws as. Grey claims nothing. */
export const UNKNOWN_COLOUR = `rgb(${UNKNOWN_RGB.join(', ')})`;

export const colourForRegime = regimeCss;

/**
 * Radius in pixels, per regime.
 *
 * Not proportional to altitude — that would say the same thing as the colour
 * and say it worse. It separates the crowded low-orbit band from the sparse
 * high one: there are ~1,390 objects in LEO and ~40 above it, so the few high
 * ones are drawn slightly larger to stay findable rather than lost among the
 * many.
 */
export const REGIME_RADIUS: Record<OrbitRegime, number> = {
  LEO: 2.6,
  MEO: 3.6,
  GEO: 4.2,
  HEO: 4.2,
};

export function radiusForRegime(altitudeM: number | null): number {
  const regime = regimeFor(altitudeM);
  return regime ? REGIME_RADIUS[regime] : REGIME_RADIUS.LEO;
}

export interface SatelliteFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      label: string;
      colour: string;
      radius: number;
      regime: OrbitRegime | null;
      selected: boolean;
    };
  }>;
}

export function satelliteFeatures(
  objects: RenderableObject[],
  selectedId: string | null = null,
): SatelliteFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: objects.map((object) => ({
      type: 'Feature' as const,
      id: object.id,
      geometry: {
        type: 'Point' as const,
        coordinates: [object.renderLon, object.renderLat] as [number, number],
      },
      properties: {
        id: object.id,
        label: object.label,
        colour: colourForRegime(object.altitude),
        radius: radiusForRegime(object.altitude),
        regime: regimeFor(object.altitude),
        selected: object.id === selectedId,
      },
    })),
  };
}

/**
 * Above which zoom the names are drawn.
 *
 * A satellite name is long ("COSMOS 2251 DEB" style) and there are over a
 * thousand of them. Drawn at world zoom they would be a wall of text over the
 * planet, so they wait until the view is narrow enough that only a handful are
 * on screen.
 */
export const SATELLITE_LABEL_ZOOM = 3.5;

export function satelliteLayers(): LayerSpecification[] {
  return [
    {
      id: SATELLITE_LAYER,
      type: 'circle',
      source: SATELLITE_SOURCE,
      paint: {
        'circle-color': ['get', 'colour'],
        // The per-feature radius multiplies each zoom stop rather than the
        // whole curve. **The multiply must be inside the interpolate**: a
        // `zoom` expression is only valid as the direct input of a top-level
        // interpolate, and MapLibre discards an invalid layer silently, which
        // has cost this project two separate outages (defect #25, defect #36).
        'circle-radius': [
          'interpolate',
          ['linear'],
          ['zoom'],
          0, ['*', 0.75, ['get', 'radius']],
          3, ['*', 1.0, ['get', 'radius']],
          6, ['*', 1.6, ['get', 'radius']],
        ],
        'circle-opacity': 0.92,
        'circle-stroke-width': ['case', ['get', 'selected'], 2.2, 0.8],
        'circle-stroke-color': [
          'case',
          ['get', 'selected'],
          'rgb(255, 255, 255)',
          'rgba(8, 12, 20, 0.75)',
        ],
      },
    },
    {
      id: SATELLITE_LABEL_LAYER,
      type: 'symbol',
      source: SATELLITE_SOURCE,
      minzoom: SATELLITE_LABEL_ZOOM,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        // Names may drop out when they collide; the circles never do. Losing a
        // name is a readability trade, losing a satellite would be a lie.
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': 'rgb(232, 238, 246)',
        'text-halo-color': 'rgba(8, 12, 20, 0.85)',
        'text-halo-width': 1.3,
      },
    },
  ];
}
