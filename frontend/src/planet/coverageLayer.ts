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
export const COVERAGE_LABEL_SOURCE = 'orbital-coverage-labels';
export const COVERAGE_FILL_LAYER = 'orbital-coverage-fill';
export const COVERAGE_LINE_LAYER = 'orbital-coverage-line';
export const COVERAGE_HATCH_LAYER = 'orbital-coverage-hatch';
export const COVERAGE_HATCH_IMAGE = 'orbital-coverage-hatch-image';
export const COVERAGE_LABEL_LAYER = 'orbital-coverage-label';

/**
 * Above this zoom the shapes are hidden.
 *
 * The claim is continental. Once someone has zoomed into a city the shape
 * fills the screen, says nothing new, and is only in the way.
 */
export const COVERAGE_MAX_ZOOM = 5.5;

/**
 * Below this zoom the shapes are hidden too, not just the label.
 *
 * **The shape and its label are one statement.** The label carries a `minzoom`
 * of its own because at world zoom the region is a few hundred pixels across
 * and the type does not fit in it; the fill, hatch and outline carried none, so
 * between zoom 0 and here a hatched patch drew over western China and central
 * Siberia with nothing at all to say what it was.
 *
 * That is the exact failure this layer exists to prevent, one level up. An
 * unexplained *hole* reads as a fault, which is why the shapes were drawn; an
 * unexplained *hatch* reads as a rendering fault, which is worse, because it
 * impugns the map rather than the data. It was diagnosed as a broken fill twice
 * in one session by someone who had read this file (D111).
 *
 * So all four layers share one window. Nothing here draws unless the sentence
 * that explains it draws with it.
 */
export const COVERAGE_MIN_ZOOM = 2.5;

export interface CoverageRegion {
  name: string;
  /** Aircraft per 100 square degrees when this was measured, for the record. */
  density: number;
  ring: [number, number][];
  /**
   * Where the one label goes.
   *
   * Given explicitly rather than left to a centroid, for two reasons. A
   * polygon's centroid can land outside a concave shape, and - the reason this
   * exists - MapLibre labels a polygon **once per tile it covers**, so a
   * region spanning a tile boundary was drawing "NO RECEIVER COVERAGE" twice a
   * few hundred kilometres apart, which reads as two separate claims. One
   * point in one feature can only be labelled once.
   */
  anchor: [number, number];
}

/** Coarse outlines of the land where the receiver networks do not reach. */
export const COVERAGE_GAPS: CoverageRegion[] = [
  {
    name: 'Western China',
    anchor: [88, 36.5],
    density: 0.27,
    ring: [
      [76.5, 39.5], [80, 43.5], [88, 45], [96, 43.5], [103, 39],
      [103, 33], [97, 29.5], [88, 28.5], [80, 30.5], [76.5, 34.5], [76.5, 39.5],
    ],
  },
  {
    name: 'Central Siberia',
    anchor: [105, 63],
    density: 0.24,
    ring: [
      [82, 56], [95, 54.5], [112, 55], [128, 58], [130, 66],
      [120, 71], [104, 72], [90, 71], [82, 66], [82, 56],
    ],
  },
  {
    name: 'The Sahara',
    anchor: [14, 23.5],
    density: 0.0,
    ring: [
      [1, 20], [10, 17.5], [20, 17], [26, 20], [27, 27],
      [22, 30], [10, 30], [2, 28], [1, 20],
    ],
  },
  {
    name: 'Congo basin',
    anchor: [24, -1],
    density: 0.0,
    ring: [
      [15, 3], [22, 6], [30, 7], [33, 2], [32, -6],
      [26, -10], [18, -8], [14, -3], [15, 3],
    ],
  },
  {
    name: 'Amazon basin',
    anchor: [-62, -5.5],
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
 * One point per region, for the label.
 *
 * Separate from the polygons because MapLibre labels a polygon once per tile
 * it covers, and these regions are large enough to span several - which drew
 * the same annotation two or three times over one shape.
 */
export function coverageLabelFeatures() {
  return {
    type: 'FeatureCollection' as const,
    features: COVERAGE_GAPS.map((region) => ({
      type: 'Feature' as const,
      properties: { name: region.name },
      geometry: { type: 'Point' as const, coordinates: region.anchor },
    })),
  };
}

/**
 * A diagonal hatch, drawn once into a small tile.
 *
 * Hatching is how a printed chart has always marked "this area is excluded",
 * and it survives being laid over satellite imagery in a way a flat wash does
 * not: the eye reads regular diagonals as an overlay and irregular ground
 * texture as terrain, so the region stops looking like an unusually pale
 * desert and starts looking annotated.
 *
 * **Deliberately sparse.** Two thin strokes per tile, not a fill. The point is
 * to be legible at a glance and ignorable while looking at aircraft, and a
 * dense hatch would be neither.
 *
 * Returned as ImageData rather than a URL: the same reasoning as the sprite
 * atlas (D30), which is that a generated asset stays adjustable in source
 * instead of becoming an opaque binary in git.
 */
export function createHatchImage(size = 8): ImageData | null {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, size, size);
  context.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  context.lineWidth = 1;
  // Two strokes, offset by the tile so the diagonal continues across the seam
  // instead of breaking into dashes at every tile edge.
  for (const offset of [0, size]) {
    context.beginPath();
    context.moveTo(-1 + offset, size + 1);
    context.lineTo(size + 1 + offset, -1);
    context.stroke();
  }
  return context.getImageData(0, 0, size, size);
}

/**
 * Four layers: a wash, a hatch, a firm edge, and one line of type.
 *
 * **Quiet, but not invisible.** The first version was a 10% wash with a thin
 * dashed edge, and over satellite imagery it read as nothing at all - the
 * boundary was invisible and the region just looked like pale desert, which is
 * exactly what it is a photograph of. An annotation that cannot be
 * distinguished from the ground it annotates has failed.
 *
 * So: the edge is solid, brighter and twice the width, with a soft blur under
 * it to lift it off busy terrain; and the fill is hatched. Diagonals are what
 * makes it read as *drawn on* rather than *photographed* - the eye takes
 * regular lines as an overlay and irregular texture as landscape. The hatch is
 * two thin strokes per eight-pixel tile, which is enough to register and
 * little enough to look through.
 *
 * It must still never compete with an aircraft. Everything here is white at
 * low opacity over a dark photograph; the aircraft are saturated colour.
 *
 * All of it fades out by `COVERAGE_MAX_ZOOM` rather than switching off, so the
 * shapes do not blink out mid-gesture.
 */
export function coverageLayers(): LayerSpecification[] {
  // The fade-in begins where the layer is allowed to draw at all, not before.
  //
  // It used to start at 1.5 and reach full at 2.5, which is precisely the
  // window the label's own floor excluded - so for a whole zoom level the
  // hatch faded up over western China with no sentence attached to it. Closing
  // that with a `minzoom` alone would have left these stops unreachable and
  // turned the appearance into a pop, so the curve moves with the floor.
  const fadeOut = (peak: number): unknown => [
    'interpolate',
    ['linear'],
    ['zoom'],
    COVERAGE_MIN_ZOOM, 0,
    COVERAGE_MIN_ZOOM + 0.8, peak,
    COVERAGE_MAX_ZOOM - 1, peak,
    COVERAGE_MAX_ZOOM, 0,
  ];

  return [
    {
      id: COVERAGE_FILL_LAYER,
      type: 'fill',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      minzoom: COVERAGE_MIN_ZOOM,
      paint: {
        // Both grounds are dark since D108, so both want the light wash. The
        // vector arm used to be a mid slate, correct against cream and close to
        // invisible against #1b212c.
        'fill-color': whenFlat('#cddaee', '#e8eef8'),
        'fill-opacity': fadeOut(0.09) as never,
      },
    } as LayerSpecification,
    {
      // The hatch is its own layer because a fill may have a colour or a
      // pattern, not both, and the wash underneath is what keeps the hatch
      // from reading as loose lines lying on open ground.
      id: COVERAGE_HATCH_LAYER,
      type: 'fill',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      minzoom: COVERAGE_MIN_ZOOM,
      paint: {
        'fill-pattern': COVERAGE_HATCH_IMAGE,
        'fill-opacity': fadeOut(0.5) as never,
      },
    } as LayerSpecification,
    {
      id: COVERAGE_LINE_LAYER,
      type: 'line',
      source: COVERAGE_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      minzoom: COVERAGE_MIN_ZOOM,
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': whenFlat('#dce6f4', '#ffffff'),
        'line-width': 2,
        // A soft edge under the stroke, so the boundary survives being drawn
        // over mountain shadow and cloud without needing to be loud.
        'line-blur': 0.6,
        'line-opacity': fadeOut(0.8) as never,
      },
    } as LayerSpecification,
    {
      id: COVERAGE_LABEL_LAYER,
      type: 'symbol',
      // The point source, not the polygons: see coverageLabelFeatures.
      source: COVERAGE_LABEL_SOURCE,
      maxzoom: COVERAGE_MAX_ZOOM,
      minzoom: COVERAGE_MIN_ZOOM,
      layout: {
        'text-field': 'NO RECEIVER COVERAGE',
        'text-font': ['Noto Sans Regular'],
        'text-size': 10.5,
        'text-letter-spacing': 0.2,
        'text-max-width': 9,
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': whenFlat('#e4ecf8', '#ffffff'),
        'text-halo-color': whenFlat('rgba(6,9,14,0.8)', 'rgba(0,0,0,0.72)'),
        'text-halo-width': 1.4,
        'text-opacity': fadeOut(0.9) as never,
      },
    } as LayerSpecification,
  ];
}
