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

describe('proportions are tempered before they are drawn', () => {
  /** Widest extent across the fuselage, at the centreline. */
  function bodyWidth(geometry: ReturnType<typeof aircraftGeometryFor>): number {
    const position = geometry.attributes.position.array as Float32Array;
    let max = 0;
    for (let i = 0; i < position.length; i += 3) {
      // Only the tube: ignore anything out on the wings.
      if (Math.abs(position[i]) < 0.1) max = Math.max(max, Math.abs(position[i]));
    }
    return max;
  }

  it('never draws a big aircraft with a spindly body', () => {
    // The table is right and a literal reading of it is wrong: an A380's tube
    // really is 0.089 of its span against an A320's 0.110, so applying the
    // ratio faithfully drew the biggest aircraft with the thinnest body. This
    // model is a silhouette a few dozen pixels across whose baseline tube is
    // already exaggerated for legibility, and multiplying an exaggeration by a
    // true ratio gives neither.
    const generic = bodyWidth(aircraftGeometryFor(null));
    for (const code of ['A388', 'B744', 'A333', 'B789', 'A359']) {
      expect(bodyWidth(aircraftGeometryFor(code))).toBeGreaterThan(generic * 0.9);
    }
  });

  it('keeps which aircraft is longer, which is the recognisable part', () => {
    // Tempering pulls magnitudes toward the baseline; it must not flatten the
    // ordering, or the whole exercise is decoration.
    const regional = extent(aircraftGeometryFor('CRJ7'), 2);
    const jumbo = extent(aircraftGeometryFor('A388'), 2);
    const light = extent(aircraftGeometryFor('C172'), 2);
    expect(regional).toBeGreaterThan(jumbo);
    expect(jumbo).toBeGreaterThan(light);
  });

  it('leaves engine count and sweep alone', () => {
    // Those are recognisable rather than proportional, and neither fights
    // legibility, so neither is tempered.
    expect(shapeFor('A388').engines).toBe(4);
    expect(shapeFor('C172').sweep).toBe(0);
  });
});
