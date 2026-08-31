/**
 * Where nobody is listening, drawn so the map can say so.
 *
 * Orbital's feeds are networks of volunteer ground receivers. Over most of the
 * world somebody has an aerial on a roof; over the Taklamakan, the Sahara, the
 * Congo basin, central Siberia and the Amazon, almost nobody does. Aircraft
 * cross all of them - the Europe-to-south-east-Asia routes run straight over
 * western China - and none of it is heard.
 *
 * **An unexplained hole reads as a fault.** Phone sketched western China on a
 * screenshot and asked why the aircraft there were missing, which is the
 * correct thing to conclude from a map that shows nothing and says nothing.
 * The aircraft are flying; we simply cannot see them. That is a fact about the
 * data, and this project states facts about its data rather than hiding them -
 * a null heading stays null (D18), an inferred origin admits how far away it
 * was (D78), a scheduled route is labelled scheduled (D88). This is the same
 * rule applied to absence.
 *
 * ## The regions are measured, not remembered
 *
 * Each was checked against the live store before being drawn, as aircraft per
 * 100 square degrees:
 *
 * | region | density | control |
 * |---|---|---|
 * | Congo basin | 0.00 | Western Europe 912 |
 * | Sahara | 0.00 | India 56 |
 * | central Siberia | 0.24 | eastern USA 73 |
 * | western China | 0.27 | |
 * | Amazon basin | 0.36 | |
 *
 * Afghanistan and eastern Iran were candidates and are **not** included: they
 * measured 5.56, twenty times the real gaps. They looked like a gap in an
 * earlier longitude-band reading and are not one.
 *
 * ## What is deliberately left out
 *
 * **Oceans and Antarctica**, which have no receivers either. Over land, empty
 * means unheard. Over the mid-Pacific it means unheard *and* barely flown, and
 * a shape that says "no coverage" would take credit for an emptiness it only
 * partly explains. Drawing them would also swamp the map: they are most of the
 * planet.
 *
 * The polygons are coarse on purpose. They mark roughly where the problem is,
 * which is all anyone needs; a precise boundary would imply a survey nobody
 * has done.
 */

import type { LayerSpecification } from 'maplibre-gl';

import { whenFlat } from './basemap';

export const COVERAGE_SOURCE = 'orbital-coverage';
export const COVERAGE_FILL_LAYER = 'orbital-coverage-fill';
export const COVERAGE_LINE_LAYER = 'orbital-coverage-line';
export const COVERAGE_LABEL_LAYER = 'orbital-coverage-label';

/**
 * Above this zoom the shapes are hidden.
 *
 * The claim is continental. Once someone has zoomed into a city the shape
 * fills the screen, says nothing new, and is only in the way.
 */
export const COVERAGE_MAX_ZOOM = 5.5;

export interface CoverageRegion {
  name: string;
  /** Aircraft per 100 square degrees when this was measured, for the record. */
  density: number;
  ring: [number, number][];
}

/** Coarse outlines of the land where the receiver networks do not reach. */
export const COVERAGE_GAPS: CoverageRegion[] = [
  {
    name: 'Western China',
    density: 0.27,
    ring: [
      [76.5, 39.5], [80, 43.5], [88, 45], [96, 43.5], [103, 39],
      [103, 33], [97, 29.5], [88, 28.5], [80, 30.5], [76.5, 34.5], [76.5, 39.5],
    ],
  },
  {
    name: 'Central Siberia',
    density: 0.24,
    ring: [
      [82, 56], [95, 54.5], [112, 55], [128, 58], [130, 66],
      [120, 71], [104, 72], [90, 71], [82, 66], [82, 56],
    ],
  },
  {
    name: 'The Sahara',
    density: 0.0,
    ring: [
      [1, 20], [10, 17.5], [20, 17], [26, 20], [27, 27],
      [22, 30], [10, 30], [2, 28], [1, 20],
    ],
  },
  {
    name: 'Congo basin',
    density: 0.0,
    ring: [
      [15, 3], [22, 6], [30, 7], [33, 2], [32, -6],
      [26, -10], [18, -8], [14, -3], [15, 3],
    ],
  },
  {
    name: 'Amazon basin',
    density: 0.36,
    ring: [
      [-72, -4], [-64, -1], [-56, 0], [-51, -3], [-52, -9],
      [-60, -12], [-68, -11], [-72, -8], [-72, -4],
    ],
  },
];

export function coverageFeatures() {
  return {
    type: 'FeatureCollection' as const,
    features: COVERAGE_GAPS.map((region) => ({
      type: 'Feature' as const,
      properties: { name: region.name, density: region.density },
      geometry: { type: 'Polygon' as const, coordinates: [region.ring] },
    })),
  };
}

/**
 * Three layers: a wash, its edge, and one line of type.
 *
 * **Quiet on purpose.** This is an annotation about the map, not a thing on
 * the map, and it must never compete with an aircraft. The fill is a few
 * percent, the edge is dashed because a hard boundary would claim a precision
 * these shapes do not have, and the label is small and letter-spaced the way a
 * chart annotation is rather than the way a place name is.
 *
 * All three fade out by `COVERAGE_MAX_ZOOM` rather than switching off, so the
 * shapes do not blink out of existence mid-gesture.
 */
export function coverageLayers(): LayerSpecification[] {
  const fadeOut = (peak: number): unknown => [
    'interpolate',
    ['linear'],
    ['zoom'],
    1.5, 0,
    2.5, peak,
    COVERAGE_MAX_ZOOM - 1, peak,
    COVERAGE_MAX_ZOOM, 0,
  ];

  return [
    {
      id: COVERAGE_FILL_LAYER,
      type: 'fill',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      paint: {
        // Slightly warm grey over imagery, slightly cool over the flat map:
        // each is what reads as "hatched out" against its own ground.
        'fill-color': whenFlat('#8aa0bd', '#cfd8e6'),
        'fill-opacity': fadeOut(0.1) as never,
      },
    } as LayerSpecification,
    {
      id: COVERAGE_LINE_LAYER,
      type: 'line',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      paint: {
        'line-color': whenFlat('#6d84a3', '#dfe7f2'),
        'line-width': 1,
        // Dashed, because these boundaries are approximate and a solid line
        // would claim otherwise.
        'line-dasharray': [3, 3],
        'line-opacity': fadeOut(0.45) as never,
      },
    } as LayerSpecification,
    {
      id: COVERAGE_LABEL_LAYER,
      type: 'symbol',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      minzoom: 2.5,
      layout: {
        'text-field': 'NO RECEIVER COVERAGE',
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-letter-spacing': 0.18,
        'text-max-width': 12,
        'text-allow-overlap': false,
        // If it will not fit, drop it. A truncated or colliding annotation is
        // worse than none, and the shape carries the meaning on its own.
        'text-optional': true,
      },
      paint: {
        'text-color': whenFlat('#4a5a72', '#e8eef8'),
        'text-halo-color': whenFlat('rgba(255,255,255,0.75)', 'rgba(0,0,0,0.6)'),
        'text-halo-width': 1.1,
        'text-opacity': fadeOut(0.75) as never,
      },
    } as LayerSpecification,
  ];
}
