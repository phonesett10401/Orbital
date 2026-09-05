import { describe, expect, it } from 'vitest';

import { POLES, poleDirection } from './planetPoles';
import { sphereVector } from './planet/modelFrame';

const DATE = new Date('2026-09-05T00:00:00Z');

describe('the pole table', () => {
  it('lays Uranus almost on its side', () => {
    // The one everybody knows. A declination near zero means the pole lies
    // close to the ecliptic plane, which is why Uranus rolls around its orbit.
    expect(Math.abs(POLES.uranus.decDeg)).toBeLessThan(25);
  });

  it('keeps the others upright by comparison', () => {
    for (const id of ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'neptune']) {
      expect(Math.abs(POLES[id].decDeg)).toBeGreaterThan(40);
    }
  });

  it('stays inside the real ranges', () => {
    for (const pole of Object.values(POLES)) {
      expect(pole.raDeg).toBeGreaterThanOrEqual(0);
      expect(pole.raDeg).toBeLessThan(360);
      expect(Math.abs(pole.decDeg)).toBeLessThanOrEqual(90);
    }
  });
});

describe('pointing a body', () => {
  it('returns a unit vector', () => {
    for (const id of Object.keys(POLES)) {
      const [x, y, z] = poleDirection(id, DATE);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
    }
  });

  it('does not point every planet the same way', () => {
    // The failure this catches is a pole lookup that silently falls through to
    // the default for everything, which would look like working code.
    const jupiter = poleDirection('jupiter', DATE);
    const uranus = poleDirection('uranus', DATE);
    const dot =
      jupiter[0] * uranus[0] + jupiter[1] * uranus[1] + jupiter[2] * uranus[2];
    expect(Math.abs(dot)).toBeLessThan(0.8);
  });

  it('tilts a planet away from the globe axis rather than aligning with it', () => {
    // If this ever returns the globe's north for a real planet, the bands are
    // wearing Earth's axis and the tilt has been lost.
    const north = sphereVector(0, 90);
    const uranus = poleDirection('uranus', DATE);
    const dot = uranus[0] * north[0] + uranus[1] * north[1] + uranus[2] * north[2];
    expect(Math.abs(dot)).toBeLessThan(0.5);
  });

  it('falls back to the globe axis for a body it does not know', () => {
    expect(poleDirection('pluto', DATE)).toEqual([0, 1, 0]);
  });

  it('turns with the Earth, because the globe frame does', () => {
    const a = poleDirection('jupiter', DATE);
    const b = poleDirection('jupiter', new Date(DATE.getTime() + 6 * 3_600_000));
    const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot).toBeLessThan(0.99);
  });
});
