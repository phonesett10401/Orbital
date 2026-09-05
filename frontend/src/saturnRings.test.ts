import { describe, expect, it } from 'vitest';

import { RING_INNER, RING_OUTER, ringOpacity, ringProfile } from './saturnRings';

describe('the ring profile', () => {
  it('is empty where there are no rings', () => {
    // Inside the C ring and outside the A ring there is nothing, which is what
    // makes this an annulus rather than a disc with a pattern on it.
    expect(ringOpacity(1.0)).toBe(0);
    expect(ringOpacity(1.2)).toBe(0);
    expect(ringOpacity(2.4)).toBe(0);
    expect(ringOpacity(10)).toBe(0);
  });

  it('puts the Cassini division between the two bright rings', () => {
    // The one feature that makes a drawing read as Saturn. If this stops being
    // a dip, the rings have become a plain hoop.
    const b = ringOpacity(1.8);
    const cassini = ringOpacity(1.99);
    const a = ringOpacity(2.15);
    expect(cassini).toBeLessThan(b / 4);
    expect(cassini).toBeLessThan(a / 4);
  });

  it('makes the B ring the brightest and the C ring the faintest', () => {
    const c = ringOpacity(1.4);
    const b = ringOpacity(1.8);
    const a = ringOpacity(2.15);
    expect(b).toBeGreaterThan(a);
    expect(a).toBeGreaterThan(c);
    expect(c).toBeGreaterThan(0);
  });

  it('cuts the Encke gap out of the A ring without removing the ring', () => {
    const gap = ringOpacity(2.216);
    const beside = ringOpacity(2.15);
    expect(gap).toBeLessThan(beside / 2);
    expect(beside).toBeGreaterThan(0);
  });

  it('fades at both edges rather than stopping dead', () => {
    expect(ringOpacity(RING_INNER + 0.001)).toBeLessThan(ringOpacity(RING_INNER + 0.05));
    expect(ringOpacity(RING_OUTER - 0.001)).toBeLessThan(ringOpacity(RING_OUTER - 0.05));
  });

  it('never leaves the unit range, at any radius', () => {
    for (let r = 0.5; r < 3; r += 0.001) {
      expect(ringOpacity(r)).toBeGreaterThanOrEqual(0);
      expect(ringOpacity(r)).toBeLessThanOrEqual(1);
    }
  });
});

describe('the lookup table the shader samples', () => {
  it('spans the annulus, so sampling zero to one covers the rings', () => {
    const data = ringProfile(512);
    expect(data.length).toBe(512 * 4);
    // The ends are the ring edges, which fade, so they are dim but the middle
    // of the B ring is not.
    const middleOfB = Math.round(((1.8 - RING_INNER) / (RING_OUTER - RING_INNER)) * 511);
    expect(data[middleOfB * 4]).toBeGreaterThan(200);
  });

  it('is built from the same function the tests check', () => {
    // A second copy of the radii written in GLSL could drift from this one.
    const data = ringProfile(512);
    const at = (radii: number) =>
      data[Math.round(((radii - RING_INNER) / (RING_OUTER - RING_INNER)) * 511) * 4];
    expect(at(1.99)).toBeLessThan(at(1.8) / 4);
  });

  it('carries the value on every channel, so any format reads the same', () => {
    const data = ringProfile(64);
    for (let i = 0; i < 64; i += 1) {
      expect(data[i * 4 + 1]).toBe(data[i * 4]);
      expect(data[i * 4 + 3]).toBe(data[i * 4]);
    }
  });
});
