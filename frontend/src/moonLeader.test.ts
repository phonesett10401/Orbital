import { describe, expect, it } from 'vitest';

import {
  LEADER_PIXELS,
  leaderAngleDeg,
  leaderEnd,
  leaderFeature,
  leaderLength,
} from './moonLeader';

describe('the callout line', () => {
  it('goes up and to the right, which is north-east on a screen', () => {
    // Screen y grows downward, so north is a *smaller* y. This is the one sign
    // nobody can check by reasoning, and getting it wrong sends the callout
    // south-east while looking entirely deliberate.
    const end = leaderEnd({ x: 100, y: 200 });
    expect(end.x).toBeGreaterThan(100);
    expect(end.y).toBeLessThan(200);
  });

  it('is exactly 45 degrees, wherever the spacecraft is', () => {
    for (const from of [
      { x: 0, y: 0 },
      { x: 640, y: 360 },
      { x: 12, y: 900 },
    ]) {
      expect(leaderAngleDeg(from, leaderEnd(from))).toBeCloseTo(45, 9);
    }
  });

  it('stays 45 degrees at any length', () => {
    // The reach is adjustable; the angle is not.
    for (const pixels of [20, 88, 300]) {
      const from = { x: 100, y: 100 };
      expect(leaderAngleDeg(from, leaderEnd(from, pixels))).toBeCloseTo(45, 9);
    }
  });

  it('reaches the distance it says on each axis', () => {
    const from = { x: 0, y: 0 };
    const end = leaderEnd(from, 100);
    expect(end.x - from.x).toBe(100);
    expect(from.y - end.y).toBe(100);
    // The diagonal is therefore longer than the per-axis reach.
    expect(leaderLength(from, end)).toBeCloseTo(Math.SQRT2 * 100, 9);
  });

  it('has a default reach that is visible but not across the screen', () => {
    expect(LEADER_PIXELS).toBeGreaterThan(40);
    expect(LEADER_PIXELS).toBeLessThan(200);
  });
});

describe('the line as GeoJSON', () => {
  it('draws from the spacecraft to the callout end', () => {
    const collection = leaderFeature([10, 20], [11, 21]);
    expect(collection.features).toHaveLength(1);
    expect(collection.features[0].geometry.coordinates).toEqual([
      [10, 20],
      [11, 21],
    ]);
  });

  it('is a valid empty collection when nothing is selected', () => {
    // An empty collection must still be a collection or the source throws.
    expect(leaderFeature(null, null)).toEqual({
      type: 'FeatureCollection',
      features: [],
    });
    expect(leaderFeature([1, 2], null).features).toHaveLength(0);
  });
});
