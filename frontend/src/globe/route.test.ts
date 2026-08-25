/**
 * Tests for route geometry and marker colouring.
 *
 * Pure maths only — no WebGL context is created, so these run in jsdom. The
 * rendering itself is verified by running the app; what is testable here is
 * the geometry that decides whether the line follows the Earth or cuts through
 * it.
 */

import { describe, expect, it } from 'vitest';

import { altitudeColor } from './markers';
import { crossesAntimeridian, greatCirclePoints } from './route';

describe('greatCirclePoints', () => {
  it('produces the requested number of subdivisions', () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 30 }, 12);
    expect(points).toHaveLength(13); // steps + 1
  });

  it('starts and ends at the given points', () => {
    const from = { lat: 10, lon: 20 };
    const to = { lat: -30, lon: 100 };
    const points = greatCirclePoints(from, to, 8, 1);
    const first = points[0];
    const last = points[points.length - 1];
    expect(first.length()).toBeCloseTo(1, 6);
    expect(last.length()).toBeCloseTo(1, 6);
  });

  it('keeps every intermediate point on the sphere', () => {
    // The bug this guards: linear interpolation between endpoints produces a
    // chord that visibly sinks through the surface on long segments.
    const points = greatCirclePoints({ lat: 50, lon: -100 }, { lat: 20, lon: 40 }, 16, 101);
    for (const point of points) {
      expect(point.length()).toBeCloseTo(101, 3);
    }
  });

  it('handles coincident points without producing NaN', () => {
    const points = greatCirclePoints({ lat: 10, lon: 10 }, { lat: 10, lon: 10 }, 8, 1);
    for (const point of points) {
      expect(Number.isNaN(point.x)).toBe(false);
      expect(Number.isNaN(point.y)).toBe(false);
      expect(Number.isNaN(point.z)).toBe(false);
    }
  });

  it('scales to the requested radius', () => {
    const points = greatCirclePoints({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }, 4, 50);
    expect(points[0].length()).toBeCloseTo(50, 6);
  });
});

describe('crossesAntimeridian', () => {
  it('detects the seam', () => {
    // Drawn naively, this segment sweeps 358 degrees the wrong way around the
    // planet — a stripe across the entire map.
    expect(crossesAntimeridian(179, -179)).toBe(true);
    expect(crossesAntimeridian(-179, 179)).toBe(true);
  });

  it('ignores ordinary movement', () => {
    expect(crossesAntimeridian(10, 12)).toBe(false);
    expect(crossesAntimeridian(-100, -80)).toBe(false);
  });

  it('does not fire on a large but legitimate span', () => {
    expect(crossesAntimeridian(-80, 80)).toBe(false);
  });
});

describe('altitudeColor', () => {
  it('gives unknown altitude its own neutral colour', () => {
    // `null` means unknown and must not read as "on the ground".
    const unknown = altitudeColor(null);
    const ground = altitudeColor(0);
    expect(unknown).not.toEqual(ground);
  });

  it('shifts from warm at low altitude to cool at cruise', () => {
    const [lowR, , lowB] = altitudeColor(0);
    const [highR, , highB] = altitudeColor(12000);
    expect(lowR).toBeGreaterThan(lowB);
    expect(highB).toBeGreaterThan(highR);
  });

  it('clamps above the top of the scale', () => {
    expect(altitudeColor(50_000)).toEqual(altitudeColor(12_000));
  });

  it('clamps below zero', () => {
    // Barometric altitude can read slightly negative near sea level.
    expect(altitudeColor(-50)).toEqual(altitudeColor(0));
  });

  it('returns components in the zero-to-one range three.js expects', () => {
    for (const altitude of [null, 0, 3000, 8000, 12000, 20000]) {
      for (const channel of altitudeColor(altitude)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});
