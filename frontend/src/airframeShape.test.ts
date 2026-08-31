import { describe, expect, it } from 'vitest';

import { MODEL_SPAN_UNITS, aircraftGeometryFor, createAircraftGeometry } from './airframe';
import { DEFAULT_SHAPE, shapeFor } from './airframeShape';

/** The widest extent along an axis, which for X is the wingspan. */
function extent(geometry: ReturnType<typeof createAircraftGeometry>, axis: 0 | 1 | 2): number {
  const position = geometry.attributes.position.array as Float32Array;
  let min = Infinity;
  let max = -Infinity;
  for (let i = axis; i < position.length; i += 3) {
    if (position[i] < min) min = position[i];
    if (position[i] > max) max = position[i];
  }
  return max - min;
}

describe('shapeFor', () => {
  it('gives four engines to the aircraft that have four', () => {
    // The most recognisable thing an airliner has from above, and the most
    // visible way one generic airframe was wrong.
    for (const code of ['A388', 'B744', 'B748', 'A343', 'A346']) {
      expect(shapeFor(code).engines).toBe(4);
    }
  });

  it('gives two to everything else', () => {
    for (const code of ['A320', 'B789', 'A359', 'B77W', 'C172']) {
      expect(shapeFor(code).engines).toBe(2);
    }
  });

  it('knows a regional jet is long for its span and an A380 is short', () => {
    // 1.39 against 0.91 - most of what tells them apart in plan view.
    expect(shapeFor('CRJ7').lengthRatio).toBeGreaterThan(1.3);
    expect(shapeFor('A388').lengthRatio).toBeLessThan(1);
  });

  it('knows a widebody has a relatively THINNER tube than a narrowbody', () => {
    // The counterintuitive one, and the reason this table holds measurements
    // rather than impressions: the A380's fuselage is nearly twice as wide in
    // metres, and its wings are more than twice as long.
    expect(shapeFor('A388').fuselageRatio).toBeLessThan(shapeFor('A320').fuselageRatio);
  });

  it('draws a light aircraft with a straight wing', () => {
    // Drawn with a jet's sweep, a Cessna reads as a very small airliner.
    expect(shapeFor('C172').sweep).toBe(0);
    expect(shapeFor('AT76').sweep).toBe(0);
    expect(shapeFor('A320').sweep).toBe(1);
  });

  it('falls back to the generic airframe for a type it has no dimensions for', () => {
    // Honest: we know how big it is and not what shape it is.
    expect(shapeFor(null)).toEqual(DEFAULT_SHAPE);
    expect(shapeFor('ZZZZ')).toEqual(DEFAULT_SHAPE);
  });
});

describe('the geometry built from a shape', () => {
  it('keeps the wingspan normalised whatever the proportions', () => {
    // The one invariant every caller depends on: scale is "wingspan in world
    // units". A shape that changed the span would silently break both
    // renderers' sizing.
    for (const code of [null, 'A320', 'A388', 'C172', 'CRJ7']) {
      const span = extent(aircraftGeometryFor(code), 0);
      expect(span).toBeCloseTo(MODEL_SPAN_UNITS, 2);
    }
  });

  it('makes a four-engined aircraft out of more triangles than a twin', () => {
    const four = aircraftGeometryFor('A388').attributes.position.count;
    const two = aircraftGeometryFor('A359').attributes.position.count;
    expect(four).toBeGreaterThan(two);
  });

  it('draws a long aircraft longer, nose to tail', () => {
    expect(extent(aircraftGeometryFor('CRJ7'), 2)).toBeGreaterThan(
      extent(aircraftGeometryFor('A388'), 2),
    );
  });

  it('returns the same mesh for the same shape', () => {
    // An A320 and an A20N have identical dimensions, so they are one geometry.
    expect(aircraftGeometryFor('A320')).toBe(aircraftGeometryFor('A20N'));
  });

  it('returns different meshes for different shapes', () => {
    expect(aircraftGeometryFor('A388')).not.toBe(aircraftGeometryFor('A320'));
  });
});

describe('how fat the body is drawn', () => {
  /**
   * Half-width of the fuselage.
   *
   * Measured **ahead of the wing** rather than by an x window. The wing panels
   * run from the centreline outward, so no threshold on x can separate tube
   * from wing root - and a window tight enough to try clipped the very widths
   * this is here to measure once the body got fatter. The wing occupies z from
   * about +0.1 aft; forward of z 0.3 there is nothing but fuselage and nose.
   */
  function bodyHalfWidth(geometry: ReturnType<typeof aircraftGeometryFor>): number {
    const position = geometry.attributes.position.array as Float32Array;
    let max = 0;
    for (let i = 0; i < position.length; i += 3) {
      if (position[i + 2] > 0.3) max = Math.max(max, Math.abs(position[i]));
    }
    return max;
  }

  const width = (code: string | null) => bodyHalfWidth(aircraftGeometryFor(code)) * 2;

  it('draws a widebody two to three times fatter than a light aircraft', () => {
    // Asked for directly, after "big planes are still thin" twice. It is a
    // drawing decision and not a proportion: the true figures say the largest
    // aircraft have the THINNEST tubes for their span, which is what made them
    // look frail in the first place.
    const ratio = width('A388') / width('C172');
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(3);
  });

  it('grows the body with size, without a step between classes', () => {
    // A 757 has to sit between a narrowbody and a widebody rather than
    // snapping to one of them.
    const order = ['C172', 'CRJ7', 'A320', 'B752', 'B763', 'B789'];
    const widths = order.map(width);
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeGreaterThan(widths[i - 1]);
    }
  });

  it('is never thinner than the sprite it replaces', () => {
    // Selecting an aircraft swaps a sprite for this mesh, and D67 requires the
    // swap to change the shape and nothing else. The model was 0.084 body
    // widths per span against the sprite's 0.146 and visibly slimmed on
    // selection. The sprite's white FILL is 0.083 - the same aeroplane - so
    // the entire difference was its dark outline, which a mesh has no
    // equivalent of.
    const SPRITE_FILL = 0.083;
    for (const code of [null, 'C172', 'A320', 'A388']) {
      expect(width(code)).toBeGreaterThan(SPRITE_FILL * 1.15);
    }
  });

  it('keeps length and sweep doing their own jobs', () => {
    // Body weight is size-driven; length and sweep still come from the table,
    // and tempering must not have flattened them.
    expect(extent(aircraftGeometryFor('CRJ7'), 2)).toBeGreaterThan(
      extent(aircraftGeometryFor('A388'), 2),
    );
    expect(shapeFor('A388').engines).toBe(4);
    expect(shapeFor('C172').sweep).toBe(0);
  });
});
