import { describe, expect, it } from 'vitest';

import { ELEMENTS, PLANET_IDS } from './planets';
import { MIN_GAP, ORBIT_MAX, allocateRadii, radiusFor } from './solarScale';

describe('sharing the frame out between the orbits', () => {
  it('starts at the centre and ends on the rim', () => {
    // The first anchor is the Sun's own centre; moving it would shift the
    // system off the point it is drawn around.
    const out = allocateRadii([0, 0.2, 0.6, 1], 0.1, 1);
    expect(out[0]).toBe(0);
    expect(out[out.length - 1]).toBeCloseTo(1, 9);
  });

  it('gives every pair at least the floor', () => {
    const out = allocateRadii([0, 0.9, 0.95, 1], 0.1, 1);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i] - out[i - 1]).toBeGreaterThanOrEqual(0.1 - 1e-9);
    }
  });

  it('still lets the curve decide the shape', () => {
    // The floor is a floor, not a flattening: a pair the curve puts far apart
    // must still end up further apart than one it puts close together.
    const out = allocateRadii([0, 0.1, 0.2, 0.9], 0.05, 1);
    expect(out[3] - out[2]).toBeGreaterThan(out[2] - out[1]);
  });

  it('never reorders anything', () => {
    const out = allocateRadii([0, 0.01, 0.02, 0.5, 0.99, 1], 0.05, 1);
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
  });

  it('survives floors that will not fit', () => {
    // Ten pairs at a floor of 0.5 want five frames. It must still be
    // increasing and finite rather than producing NaN or folding back.
    const out = allocateRadii(Array.from({ length: 11 }, (_, i) => i / 10), 0.5, 1);
    for (let i = 1; i < out.length; i += 1) {
      expect(Number.isFinite(out[i])).toBe(true);
      expect(out[i]).toBeGreaterThan(out[i - 1]);
    }
  });

  it('copes with a degenerate curve', () => {
    expect(allocateRadii([])).toEqual([]);
    expect(allocateRadii([0.4])).toEqual([0]);
    // Every anchor identical: no proportion to share by, so share equally.
    const flat = allocateRadii([0, 0, 0], 0.1, 1);
    expect(flat[2] - flat[1]).toBeCloseTo(flat[1] - flat[0], 9);
  });
});

describe('what it does to the real planets', () => {
  const drawn = PLANET_IDS.map((p) => radiusFor(ELEMENTS[p].a));

  it('separates the tightest inner pair far better than the curve alone', () => {
    // Venus to Earth is the tightest pair in the system and was 0.052 of the
    // frame - the crowding that was reported. Pushing bodies outward and
    // renormalising left it at 0.052; taking the room from the outer planets
    // is what actually moved it.
    const venus = radiusFor(ELEMENTS.venus.a);
    const earth = radiusFor(ELEMENTS.earth.a);
    expect(earth - venus).toBeGreaterThan(0.08);
  });

  it('gives every adjacent pair the floor', () => {
    const gaps = drawn.slice(1).map((r, i) => r - drawn[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
  });

  it('keeps Neptune on the rim and everything inside it', () => {
    for (const planet of PLANET_IDS) {
      expect(radiusFor(ELEMENTS[planet].a), planet).toBeLessThanOrEqual(ORBIT_MAX);
    }
  });

  it('keeps Mercury clear of the Sun it used to crowd', () => {
    // The Sun is drawn at 0.06, which is what the inner planets were actually
    // crowding against.
    expect(radiusFor(ELEMENTS.mercury.a)).toBeGreaterThan(0.1);
  });
});
