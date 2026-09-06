/**
 * The words and the key that change with the active layer.
 *
 * Everything visible around the map was written for aircraft, and switching
 * layers left it all saying the wrong thing at once: a subtitle reading "live
 * aircraft" over a sky of satellites, a search box offering "UAL1234 or LHR",
 * an altitude scale topping out at 12 km next to objects 35,786 km up, and a
 * count reading "364 aircraft".
 *
 * None of that is cosmetic. **Chrome that describes the wrong subject is a
 * false statement about what is on screen**, and it is the kind a viewer
 * believes, because chrome is where they look to find out what they are
 * looking at.
 *
 * Kept as data rather than as branches inside four components, so the whole
 * set can be read in one place and tested without rendering anything - the
 * same reason `routeSummary` and `satelliteFacts` exist.
 */

import { REGIME_RGB, UNKNOWN_RGB, type OrbitRegime } from '../satelliteShell';
import { KIND_COLOUR, KIND_LABEL, KIND_ORDER } from '../shipKind';
import type { ObjectType } from '../types';

export interface ScaleStop {
  /** Colour swatch, as CSS. */
  colour: string;
  /** What it means. */
  label: string;
}

export interface ShapeNote {
  /**
   * Which glyph the key draws.
   *
   * `ship` was added with the layer (D165) rather than reusing `aircraft`.
   * They differ only in outline, and it was tempting to leave it - but a key
   * showing an aeroplane beside the words "bow points the way it is pointing"
   * is the same false statement about the subject that this whole module
   * exists to prevent, made in the one place a reader goes to decode the map.
   */
  glyph: 'aircraft' | 'ship' | 'disc' | 'dot';
  text: string;
}

export interface LayerChrome {
  /** Under the wordmark. */
  subtitle: string;
  /** The search box's placeholder. */
  searchPlaceholder: string;
  /** Singular and plural for the object count. */
  countNoun: [string, string];
  /** Heading above the key's colour scale. */
  scaleTitle: string;
  /** The colour scale itself, as discrete swatches or a gradient. */
  scale: { kind: 'gradient'; stops: string[]; ticks: string[] } | { kind: 'bands'; bands: ScaleStop[] };
  /** What the marker shapes mean. */
  shapes: ShapeNote[];
  /**
   * What the status bar says about freshness.
   *
   * `null` means the layer has no age to report and the field should be left
   * out entirely - which is the honest answer for a computed position, and
   * better than the "data age never" a null age was rendering as (D95).
   */
  freshness: 'age' | null;
}

const AIRCRAFT_TICKS = ['ground', '6 km', '12 km'];

const REGIME_LABELS: Record<OrbitRegime, string> = {
  LEO: 'Low orbit · under 2,000 km',
  MEO: 'Medium orbit · to 34,000 km',
  GEO: 'Geostationary · 35,786 km',
  HEO: 'High or elliptical · beyond',
};

const rgb = (c: readonly [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

export function satelliteBands(): ScaleStop[] {
  const order: OrbitRegime[] = ['LEO', 'MEO', 'GEO', 'HEO'];
  return [
    ...order.map((regime) => ({ colour: rgb(REGIME_RGB[regime]), label: REGIME_LABELS[regime] })),
    { colour: rgb(UNKNOWN_RGB), label: 'Altitude unknown' },
  ];
}

export function shipBands(): ScaleStop[] {
  return KIND_ORDER.map((kind) => ({ colour: KIND_COLOUR[kind], label: KIND_LABEL[kind] }));
}

export function chromeFor(layer: ObjectType, gradientStops: string[]): LayerChrome {
  if (layer === 'ship') {
    return {
      // Says where, because this source cannot see anywhere else. A subtitle
      // reading "live ships" over an empty Pacific is a false statement of
      // exactly the kind this module exists to prevent: the reader would
      // conclude the sea was quiet rather than that we are not looking at it
      // (D165).
      subtitle: 'ships in the Baltic',
      searchPlaceholder: 'Search vessel name or MMSI, e.g. VIKING GRACE or 230982000',
      countNoun: ['ship', 'ships'],
      scaleTitle: 'Vessel type',
      // Bands, and not the altitude ramp: every ship is at sea level, so a
      // height scale would paint the whole fleet one colour. Nor a speed ramp,
      // because four fifths of them are stopped - what varies here is what the
      // vessel *is*.
      scale: { kind: 'bands', bands: shipBands() },
      shapes: [
        { glyph: 'ship', text: 'Heading known — bow points the way it is pointing' },
        { glyph: 'disc', text: 'Heading not transmitted' },
        { glyph: 'dot', text: 'Faded — last reported over 2 minutes ago' },
      ],
      // Polled and observed, like aircraft: somebody had to have heard it.
      freshness: 'age',
    };
  }

  if (layer === 'satellite') {
    return {
      subtitle: 'satellites on orbit',
      // No callsigns and no airports up here. The catalogue number is the
      // stable identifier and the name is what anyone would actually type.
      searchPlaceholder: 'Search satellite name or catalogue number, e.g. ISS or 25544',
      countNoun: ['satellite', 'satellites'],
      scaleTitle: 'Orbit',
      // Bands, not a ramp: the aircraft gradient spans 12 km and saturates,
      // and even a rescaled one would be useless because 97% of the catalogue
      // sits in the bottom 6% of the range.
      scale: { kind: 'bands', bands: satelliteBands() },
      shapes: [
        {
          glyph: 'disc',
          text: 'Shape shows what kind of spacecraft it is — station, constellation, navigation, observation, geostationary, science',
        },
        {
          glyph: 'disc',
          text: 'A plain body means a named satellite whose kind we have not recognised',
        },
        {
          glyph: 'dot',
          text: 'A dot means the catalogue itself has not identified the object',
        },
      ],
      // A computed position has no age. "Data age never" is what a null age
      // rendered as, which reads as a fault rather than as inapplicable.
      freshness: null,
    };
  }

  return {
    subtitle: 'live aircraft',
    searchPlaceholder: 'Search callsign or airport, e.g. UAL1234 or LHR',
    countNoun: ['aircraft', 'aircraft'],
    scaleTitle: 'Altitude',
    scale: { kind: 'gradient', stops: gradientStops, ticks: AIRCRAFT_TICKS },
    shapes: [
      { glyph: 'aircraft', text: 'Heading known — nose points along the track' },
      { glyph: 'disc', text: 'Heading unknown' },
      { glyph: 'dot', text: 'Faded — last reported over 2 minutes ago' },
    ],
    freshness: 'age',
  };
}

/** "364 satellites", "1 aircraft" - the plural the count actually needs. */
export function countLabel(layer: ObjectType, count: number): string {
  const [one, many] = chromeFor(layer, []).countNoun;
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
