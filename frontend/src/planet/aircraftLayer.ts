/**
 * The aircraft, as MapLibre layers.
 *
 * The old globe drew two thousand aircraft as one `THREE.Points` with a custom
 * shader, because that was the only way to keep it to a single draw call
 * (D15, D40). MapLibre's symbol layer is that same idea, written by people who
 * do it for a living: one buffer, batched, with collision handling and
 * rotation for free. So this is not a reimplementation of the marker layer —
 * it is the marker layer's job handed to something that already does it.
 *
 * What carries over unchanged is everything the marker layer decided that was
 * about *meaning* rather than about drawing:
 *
 * - **Colour by altitude** (D28), same ramp, because height above ground is
 *   the one channel a flat map cannot show by position.
 * - **A null heading is not drawn as north** (D18, D40). MapLibre has no way
 *   to say "unrotated", so those aircraft get the disc instead of the
 *   silhouette, exactly as the sprite atlas does.
 * - **Stale aircraft fade** rather than vanish (D33): the backend keeps last
 *   known positions, and a marker that disappears would imply the aircraft
 *   did.
 */

import type { LayerSpecification } from 'maplibre-gl';

import { altitudeColor } from '../altitudeColor';
import { STALE_AFTER_SECONDS } from '../interpolate';
import type { RenderableObject } from '../types';
import { scaleFor } from '../wingspan';

/** Layer and source ids, exported so the view can hit-test against them. */
export const AIRCRAFT_SOURCE = 'orbital-aircraft';
export const AIRCRAFT_LAYER = 'orbital-aircraft';
export const AIRCRAFT_LABEL_LAYER = 'orbital-aircraft-label';

/** Image ids for the two silhouettes. */
export const ICON_AIRCRAFT = 'orbital-aircraft-icon';
export const ICON_UNKNOWN = 'orbital-aircraft-unknown';

/**
 * Older than this and the marker dims, as it does on the globe (D33).
 *
 * Imported rather than restated: this number also decides how long a marker
 * may be dead-reckoned, and the two drifting apart is what put an aircraft
 * kilometres from the end of its own track (D71).
 */
export { STALE_AFTER_SECONDS };

export interface AircraftFeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      label: string;
      heading: number;
      hasHeading: boolean;
      colour: string;
      stale: boolean;
      modelled: boolean;
    };
  }>;
}

/**
 * Turn the store's objects into GeoJSON.
 *
 * Coordinates are lon/lat, which is GeoJSON's order and the reverse of the
 * contract's. Getting it backwards puts every aircraft in the wrong hemisphere
 * without anything failing, so it is asserted in the tests rather than trusted.
 *
 * Positions are the *interpolated* ones the globe draws, not the last reported
 * ones, so aircraft move between polls here exactly as they did there.
 *
 * `modelledId` is the aircraft being drawn as a 3D model, if any. It is marked
 * here rather than hidden by an imperative call so that the two layers cannot
 * disagree about who is drawing it - the same argument `setHidden` settled on
 * the globe (D42), one frame of data deciding both.
 */
export function aircraftFeatures(
  objects: RenderableObject[],
  nowMs: number,
  modelledId: string | null = null,
): AircraftFeatureCollection {
  return {
    type: 'FeatureCollection',
    features: objects.map((object) => {
      const ageSeconds = (nowMs - object.lastSeenMs) / 1000;
      return {
        type: 'Feature' as const,
        id: object.id,
        geometry: {
          type: 'Point' as const,
          coordinates: [object.renderLon, object.renderLat] as [number, number],
        },
        properties: {
          id: object.id,
          label: object.label,
          heading: object.heading ?? 0,
          hasHeading: object.heading !== null,
          colour: colourFor(object.altitude),
          // Size from what the aircraft actually is. 1 where the feed did not
          // say, which is the size everything used to be.
          scale: scaleFor(object.model),
          stale: ageSeconds > STALE_AFTER_SECONDS,
          modelled: object.id === modelledId && object.heading !== null,
        },
      };
    }),
  };
}

/**
 * Which aircraft a click selected, if any.
 *
 * Split out from the view because it is the whole of the decision, and because
 * the decision used to be spread across two handlers that could disagree: one
 * selected when it found a feature, the other deselected when it found none,
 * and a click that satisfied both left the aircraft selected and then not
 * (D69). A single function returning "this one, or nothing" cannot do that.
 *
 * A hit on the callsign counts as a hit on its aircraft. The label is drawn for
 * the aircraft and reads as part of it, so treating it as a miss would make a
 * click land on the map and clear the selection the user was aiming at.
 */
export function selectionFromHits(
  hits: Array<{ properties?: Record<string, unknown> | null }> | null | undefined,
): string | null {
  for (const hit of hits ?? []) {
    const id = hit.properties?.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}

/**
 * The aircraft features under a point, or an empty list.
 *
 * `queryRenderedFeatures` throws if a layer it is given does not exist, which
 * happens in the window between the style loading and our layers being added -
 * and a click in that window must do nothing, not tear the view down.
 */
export interface Queryable<P> {
  queryRenderedFeatures(point: P, options: { layers: string[] }): Array<{
    properties?: Record<string, unknown> | null;
  }>;
}

export function hitsAt<P>(
  map: Queryable<P>,
  point: P,
  /**
   * Which layers count as a hit. Defaults to the aircraft layers.
   *
   * The satellite layer passes its own, so one click handler serves both modes
   * without either knowing about the other - and, more to the point, without a
   * second handler that could disagree with this one about what was clicked
   * (D69).
   */
  layers: string[] = [AIRCRAFT_LAYER, AIRCRAFT_LABEL_LAYER],
): Array<{ properties?: Record<string, unknown> | null }> {
  try {
    return map.queryRenderedFeatures(point, { layers });
  } catch {
    return [];
  }
}

/**
 * The altitude ramp from D28, as a CSS colour MapLibre can use.
 *
 * `altitudeColor` returns linear 0..1 channels for the shader; MapLibre wants
 * a colour string. Same ramp, same numbers, converted rather than restated —
 * two copies of a colour scale drift apart and the legend then lies.
 */
export function colourFor(altitude: number | null): string {
  const [r, g, b] = altitudeColor(altitude);
  const channel = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  return `rgb(${channel(r)}, ${channel(g)}, ${channel(b)})`;
}

/**
 * The two layers: silhouettes, and callsigns above them.
 *
 * Split because they collide differently. An aircraft icon must always be
 * drawn — hiding one because another is near it would be losing an aircraft —
 * while its callsign is text, and forty overlapping callsigns are worse than
 * none. So icons overlap freely and labels are allowed to drop out.
 */
export function aircraftLayers(): LayerSpecification[] {
  return [
    {
      id: AIRCRAFT_LAYER,
      type: 'symbol',
      source: AIRCRAFT_SOURCE,
      layout: {
        'icon-image': ['case', ['get', 'hasHeading'], ICON_AIRCRAFT, ICON_UNKNOWN],
        // Grows with zoom, but nothing like linearly: an aircraft is a symbol
        // on a map, not a scale model of an aeroplane. The per-feature factor
        // multiplies each stop rather than the curve, so the zoom behaviour
        // that was tuned stays exactly as it was and only the relative sizes
        // of aircraft change.
        //
        // **The multiply has to be inside the interpolate, not outside it.**
        // MapLibre allows a `zoom` expression only as the direct input of a
        // top-level `step` or `interpolate`; wrapping the curve in a `*` makes
        // the whole layer invalid, and an invalid layer is dropped silently -
        // every aircraft icon disappeared while the callsigns, being a
        // separate layer, stayed exactly where they were.
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2, ['*', 0.14, ['get', 'scale']],
          8, ['*', 0.22, ['get', 'scale']],
          14, ['*', 0.34, ['get', 'scale']],
        ],
        'icon-rotate': ['get', 'heading'],
        // Rotation is relative to the map's north, which is what a heading is.
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        // Requires the icon to be registered with `sdf: true`, which is what
        // lets one silhouette be tinted per aircraft instead of one image per
        // colour. The trade is that MapLibre reads the alpha channel as a
        // distance field, so a plain mask gives a harder edge than the atlas's
        // antialiased one.
        'icon-color': ['get', 'colour'],
        // The selected aircraft's symbol goes to zero opacity rather than
        // being filtered out, because the 3D model that replaces it is not a
        // feature and cannot be clicked: `queryRenderedFeatures` still returns
        // an invisible symbol, so clicking the model still hits the aircraft,
        // and its callsign still holds its place in label collision. Filtering
        // would make the selected aircraft the one thing on the map that
        // cannot be clicked (D67).
        'icon-opacity': ['case', ['get', 'modelled'], 0, ['case', ['get', 'stale'], 0.45, 1]],
      },
    },
    {
      id: AIRCRAFT_LABEL_LAYER,
      type: 'symbol',
      source: AIRCRAFT_SOURCE,
      minzoom: 5,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': '#e8ecf4',
        'text-halo-color': 'rgba(0, 0, 0, 0.85)',
        'text-halo-width': 1.4,
      },
    },
  ];
}
