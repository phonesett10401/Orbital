import { describe, expect, it } from 'vitest';

import { equatorialToGlobe } from './solarFrame';
import { sphereVector } from './planet/modelFrame';
import {
  FAINTEST_MAGNITUDE,
  STARS,
  STAR_COUNT,
  STAR_SPHERE_RADII,
  starColour,
  starDirection,
  starSize,
} from './stars';
import { GLOBE_RADII_AT_NEPTUNE } from './solarScale';

describe('the catalogue', () => {
  it('holds the naked-eye sky and nothing fainter', () => {
    expect(STAR_COUNT).toBeGreaterThan(4_500);
    expect(Math.max(...STARS.mag)).toBeLessThanOrEqual(FAINTEST_MAGNITUDE);
  });

  it('has every column the same length', () => {
    // Flat parallel arrays are compact and silently misalign if one is short.
    for (const column of [STARS.dec, STARS.mag, STARS.ci]) {
      expect(column.length).toBe(STAR_COUNT);
    }
  });

  it('does not contain the Sun', () => {
    // HYG's row zero is Sol at magnitude -26.7 and zero distance. Left in, it
    // draws a star at RA 0 Dec 0 that is not there - the one place in the sky
    // guaranteed to look deliberate (D128).
    expect(Math.min(...STARS.mag)).toBeGreaterThan(-2);
  });

  it('stays inside the real ranges for its coordinates', () => {
    // Right ascension is in hours, not degrees, which is the unit everybody
    // gets wrong. A catalogue read as degrees would put every star in a
    // twenty-four degree stripe.
    expect(Math.min(...STARS.ra)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...STARS.ra)).toBeLessThanOrEqual(24);
    expect(Math.min(...STARS.dec)).toBeGreaterThanOrEqual(-90);
    expect(Math.max(...STARS.dec)).toBeLessThanOrEqual(90);
  });

  it('spreads over the whole sky rather than a band', () => {
    // The check that catches a units error the ranges would not: real stars
    // reach both poles and every hour of right ascension.
    const hours = new Set(STARS.ra.map((r) => Math.floor(r)));
    expect(hours.size).toBe(24);
    expect(Math.max(...STARS.dec)).toBeGreaterThan(80);
    expect(Math.min(...STARS.dec)).toBeLessThan(-80);
  });
});

describe('where a star points', () => {
  it('returns a unit vector', () => {
    for (const [ra, dec] of [[0, 0], [6, 45], [18, -60], [23.5, 89]]) {
      const [x, y, z] = starDirection(ra, dec);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    }
  });

  it('treats right ascension as hours', () => {
    // Six hours is a quarter turn. Read as degrees it would be a sixtieth.
    const a = starDirection(0, 0);
    const b = starDirection(6, 0);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot).toBeCloseTo(0, 6);
  });

  it('puts the north celestial pole on the axis', () => {
    const [x, y, z] = starDirection(0, 90);
    expect(z).toBeCloseTo(1, 9);
    expect(Math.hypot(x, y)).toBeCloseTo(0, 9);
  });

  it('lands the celestial pole on the globe pole, not tilted off it', () => {
    // Stars are already equatorial, so they take Earth's rotation but not the
    // obliquity. Applying the tilt would lean the whole sky 23 degrees against
    // the ecliptic - a plausible-looking sky in the wrong place (D128).
    const date = new Date('2026-09-05T00:00:00Z');
    const dir = starDirection(0, 90);
    const globe = equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, date);
    const north = sphereVector(0, 90);
    const dot = globe[0] * north[0] + globe[1] * north[1] + globe[2] * north[2];
    expect(dot).toBeCloseTo(1, 6);
  });

  it('turns the rest of the sky with the Earth', () => {
    // The pole is the one direction rotation cannot move, so it proves nothing
    // on its own. A star on the equator must sweep about 15 degrees an hour.
    const start = new Date('2026-09-05T00:00:00Z');
    const later = new Date(start.getTime() + 3_600_000);
    const dir = starDirection(6, 0);
    const a = equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, start);
    const b = equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, later);
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const degrees = (Math.acos(Math.min(1, dot)) * 180) / Math.PI;
    expect(degrees).toBeGreaterThan(13);
    expect(degrees).toBeLessThan(17);
  });
});

describe('how a star is drawn', () => {
  it('makes brighter stars bigger, and monotonically', () => {
    // Magnitude runs backwards - smaller is brighter - which is the sign error
    // waiting to happen.
    let previous = Infinity;
    for (let mag = -1.5; mag <= 6; mag += 0.25) {
      const size = starSize(mag);
      expect(size).toBeLessThan(previous);
      previous = size;
    }
  });

  it('compresses a hundredfold flux range into a usable one', () => {
    // Five magnitudes is a factor of 100 in flux. Drawn raw, Sirius would be
    // enormous and everything else invisible - the same bargain solarScale
    // struck with distance.
    const ratio = starSize(-1.44) / starSize(6);
    expect(ratio).toBeGreaterThan(2);
    expect(ratio).toBeLessThan(20);
  });

  it('keeps every star visible at all', () => {
    for (const mag of [-1.44, 0, 2, 4, 6]) expect(starSize(mag)).toBeGreaterThan(0);
  });

  it('colours by temperature, blue-hot to red-cool', () => {
    // B-V is a measurement, not decoration: Rigel really is blue and
    // Betelgeuse really is red.
    const [rBlue, , bBlue] = starColour(-0.3);
    const [rRed, , bRed] = starColour(1.8);
    expect(bBlue).toBeGreaterThan(rBlue);
    expect(rRed).toBeGreaterThan(bRed);
  });

  it('stays inside the unit range for every index in the catalogue', () => {
    for (const ci of STARS.ci) {
      for (const channel of starColour(ci)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('where the sky sits', () => {
  it('is inside the far plane, because a backdrop that is clipped is not one', () => {
    // MapLibre cuts everything past about 20 radii, which is exactly the half
    // of a surrounding sphere a backdrop needs (D123). So the points sit near
    // and never occlude instead.
    expect(STAR_SPHERE_RADII).toBeLessThan(GLOBE_RADII_AT_NEPTUNE);
    expect(STAR_SPHERE_RADII).toBeGreaterThan(2.4);
  });
});
