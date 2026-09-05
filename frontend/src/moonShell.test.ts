import { describe, expect, it } from 'vitest';

import { MOON_RADIUS_KM, exaggeration, shellRadiusFor } from './moonShell';

describe('height above the Moon', () => {
  it('puts the surface at one radius', () => {
    expect(shellRadiusFor(0)).toBe(1);
  });

  it('places the real spacecraft where they really are', () => {
    // LRO 71-105 km, Chandrayaan-2 about 102, Danuri about 213. The whole
    // fleet lives between the surface and 1.13 radii, which is why none of
    // this needs the compression Earth's shell cannot do without (D96).
    expect(shellRadiusFor(70.9)).toBeCloseTo(1.0408, 4);
    expect(shellRadiusFor(213)).toBeCloseTo(1.1226, 4);
    expect(shellRadiusFor(213)).toBeLessThan(1.13);
  });

  it('is exactly linear in altitude, with nothing traded away', () => {
    // The claim that makes this shell different from Earth's, asserted rather
    // than promised in a comment: doubling the altitude doubles the height.
    const a = shellRadiusFor(100) - 1;
    const b = shellRadiusFor(200) - 1;
    expect(b / a).toBeCloseTo(2, 9);
    expect(exaggeration()).toBe(1);
  });

  it('measures from the same radius the backend does', () => {
    // Two different Moon radii in one project would show as a spacecraft that
    // sits a kilometre inside the ground.
    expect(MOON_RADIUS_KM).toBe(1737.4);
    expect(shellRadiusFor(MOON_RADIUS_KM)).toBe(2);
  });

  it('does not put a spacecraft underground for a negative altitude', () => {
    // Interpolation across a pole can undershoot by a hair; the surface is the
    // floor rather than an assertion failure in the middle of an animation.
    expect(shellRadiusFor(-5)).toBe(1);
  });
});
