/**
 * The ships, as MapLibre layers.
 *
 * A parallel to `aircraftLayer.ts` rather than a variation on it: its own
 * source, its own two layers, its own icons. They are not merged, and the
 * reason is that the two feeds disagree about almost everything that decides
 * how a symbol is drawn - what the colour means, what a null heading means,
 * how big the thing should be, and how many of them sit on top of each other.
 * A shared layer with expressions branching on `type` would be one file where
 * every rule has to state which layer it is for.
 *
 * What carries over unchanged is what is about *meaning* rather than drawing:
 *
 * - **A null heading is not drawn as north** (D18, D40). 230 of 916 vessels
 *   transmit no usable heading, so they get the disc, exactly as an aircraft
 *   without a track does.
 * - **Stale vessels fade** rather than vanish (D33), because the backend keeps
 *   last known positions and a marker that disappeared would imply the ship
 *   had.
 *
 * And what does not:
 *
 * **Colour is the vessel's type, not its height.** Every ship is at sea level,
 * so the altitude ramp would paint the entire fleet one colour; and a speed
 * ramp would do nearly as badly, because four fifths of them are stopped
 * (D165). What varies is what the vessel *is*.
 *
 * **Labels start much later.** Aircraft callsigns appear at zoom 5, where a
 * continent holds a few hundred aircraft spread thinly. Ships cluster in
 * harbours - a hundred vessels inside a few kilometres - so their names at
 * that zoom would be one illegible mass, and the collision handling would drop
 * almost all of them anyway. Zoom 8 is where a port is big enough on screen
 * for its names to fit between its ships.
 */

import type { LayerSpecification } from 'maplibre-gl';

import { STALE_AFTER_SECONDS } from '../interpolate';
import { shipColour } from '../shipKind';
import type { RenderableObject } from '../types';

/** Layer and source ids, exported so the view can hit-test against them. */
export const SHIP_SOURCE = 'orbital-ships';
export const SHIP_LAYER = 'orbital-ships';
export const SHIP_LABEL_LAYER = 'orbital-ships-label';

/** Image ids for the two silhouettes. */
export const ICON_SHIP = 'orbital-ship-icon';
export const ICON_SHIP_UNKNOWN = 'orbital-ship-unknown';

export interface ShipFeatureCollection {
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
    };
  }>;
}

/**
 * Turn the store's vessels into GeoJSON.
 *
 * Coordinates are lon/lat, which is GeoJSON's order and the reverse of the
 * contract's - getting it backwards puts every ship in the wrong hemisphere
 * without anything failing, so the tests assert it rather than trusting it.
 *
 * Positions are the *interpolated* ones, so a vessel under way moves between
 * polls. That matters more here than it looks: this layer polls once a minute
 * against the aircraft layer's thirty seconds, so without interpolation a
 * moving ship would jump a minute's travel at a time.
 */
export function shipFeatures(
  objects: RenderableObject[],
  nowMs: number,
): ShipFeatureCollection {
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
          colour: shipColour(object.model),
          stale: ageSeconds > STALE_AFTER_SECONDS,
        },
      };
    }),
  };
}

/**
 * The two layers: hulls, and vessel names above them.
 *
 * Split for the same reason the aircraft ones are, and the reason applies more
 * strongly here. A hull must always be drawn - hiding one because another is
 * near it would be losing a ship, and in a harbour every ship is near another.
 * A name is text, and a hundred overlapping names are worse than none, so
 * names are allowed to drop out.
 */
export function shipLayers(): LayerSpecification[] {
  return [
    {
      id: SHIP_LAYER,
      type: 'symbol',
      source: SHIP_SOURCE,
      layout: {
        'icon-image': ['case', ['get', 'hasHeading'], ICON_SHIP, ICON_SHIP_UNKNOWN],
        // Smaller than the aircraft curve at every zoom, and deliberately.
        // Aircraft are spread across a sky; ships pack into harbours, and a
        // symbol sized for open water turns a port into one solid shape. No
        // per-feature factor: the feed carries a hull length for most vessels
        // and it was tempting to size by it, but the range is 10 m to 400 m
        // and scaling by that makes a pilot boat invisible next to a tanker.
        // The aircraft layer gets away with a size class because a Cessna and
        // an A380 differ by a factor of six, not forty.
        'icon-size': [
          'interpolate',
          ['linear'],
          ['zoom'],
          2, 0.1,
          8, 0.17,
          14, 0.3,
        ],
        'icon-rotate': ['get', 'heading'],
        // Rotation relative to the map's north, which is what a heading is.
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        // Requires the icon to be registered with `sdf: true`, which is what
        // lets one silhouette be tinted per vessel rather than needing one
        // image per colour.
        'icon-color': ['get', 'colour'],
        'icon-opacity': ['case', ['get', 'stale'], 0.45, 1],
      },
    },
    {
      id: SHIP_LABEL_LAYER,
      type: 'symbol',
      source: SHIP_SOURCE,
      // See the module docstring: 5 is right for aircraft and unreadable for
      // ships, which cluster.
      minzoom: 8,
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
