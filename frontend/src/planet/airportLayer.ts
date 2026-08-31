/**
 * The airport you searched for, marked so you can see it is an airport.
 *
 * Searching an airport used to fly the camera to its coordinates and stop.
 * That is technically correct and useless: the globe rolls, the motion ends
 * over a patch of ground, and nothing on screen says which patch is the thing
 * you asked for. From altitude one field looks like another.
 *
 * So two changes travel together and neither works alone. The camera goes in
 * **close enough that the airport is a recognisable shape** - runways read as
 * runways on imagery by about z11 - and the place is **marked and named**, so
 * the answer is identifiable before the imagery is legible and still
 * identifiable after.
 *
 * Kept separate from the departure-airport ring (`routeLayer.ts`) even though
 * both draw an airport. That one is an inference about a flight and is drawn
 * quietly beneath it; this is the direct answer to a question the user just
 * asked, and it should be the most obvious thing on the screen for a moment.
 */

import type { LayerSpecification } from 'maplibre-gl';

import type { Airport } from '../types';

export const AIRPORT_SOURCE = 'orbital-airport';
export const AIRPORT_HALO_LAYER = 'orbital-airport-halo';
export const AIRPORT_RING_LAYER = 'orbital-airport-ring';
export const AIRPORT_LABEL_LAYER = 'orbital-airport-label';

/** How close the camera goes. Runways read as runways from about here. */
export const AIRPORT_ZOOM = 11;

export function airportFeature(airport: Airport | null) {
  return {
    type: 'FeatureCollection' as const,
    features: airport
      ? [
          {
            type: 'Feature' as const,
            properties: {
              // IATA is what people search and what appears on a boarding
              // pass; ICAO is the unambiguous one. Show the familiar code and
              // keep the other for the second line.
              code: airport.iata ?? airport.icao,
              icao: airport.icao,
              name: airport.municipality ?? airport.name,
            },
            geometry: {
              type: 'Point' as const,
              coordinates: [airport.lon, airport.lat] as [number, number],
            },
          },
        ]
      : [],
  };
}

/**
 * A soft halo, a hard ring, and two lines of type.
 *
 * The halo is what makes this findable while the camera is still moving and
 * the ring is only a few pixels across; the ring is what makes it precise once
 * it arrives. Both grow with zoom, because at z11 a fixed-radius ring would
 * sit inside the airport rather than around it.
 *
 * Nothing here fades out at high zoom. A user who searched for Heathrow and
 * zoomed further in has not stopped caring where Heathrow is.
 */
export function airportLayers(): LayerSpecification[] {
  return [
    {
      id: AIRPORT_HALO_LAYER,
      type: 'circle',
      source: AIRPORT_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 10, 8, 22, 12, 46],
        'circle-color': '#4ea1ff',
        'circle-opacity': 0.18,
        'circle-stroke-color': '#4ea1ff',
        'circle-stroke-width': 1,
        'circle-stroke-opacity': 0.35,
      },
    } as LayerSpecification,
    {
      id: AIRPORT_RING_LAYER,
      type: 'circle',
      source: AIRPORT_SOURCE,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 7, 12, 10],
        'circle-color': 'rgba(0, 0, 0, 0)',
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2.5,
      },
    } as LayerSpecification,
    {
      id: AIRPORT_LABEL_LAYER,
      type: 'symbol',
      source: AIRPORT_SOURCE,
      layout: {
        'text-field': ['concat', ['get', 'code'], '\n', ['get', 'name']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.4],
        'text-anchor': 'top',
        'text-line-height': 1.3,
        // Never dropped. This is the answer to the question that moved the
        // camera here, so losing it to a label collision would undo the search.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': 'rgba(0, 0, 0, 0.85)',
        'text-halo-width': 1.6,
      },
    } as LayerSpecification,
  ];
}
