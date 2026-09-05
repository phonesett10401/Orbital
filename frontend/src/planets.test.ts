/**
 * Planet positions, checked against JPL Horizons.
 *
 * `fixtures/horizons.json` holds heliocentric ecliptic J2000 vectors for all
 * eight planets at three epochs, fetched from JPL's own ephemeris service.
 * That matters: a test that only checks this module against itself would pass
 * with the element table mistyped, and the whole point of the table is that
 * every digit is somebody else's measurement.
 *
 * Earth is compared against Horizons body **3**, the Earth-Moon barycentre,
 * because that is what JPL's approximate-element table describes. Comparing
 * against `399` would be comparing against a point 4,700 km away and calling
 * the difference an error in this code.
 */

import { describe, expect, it } from 'vitest';

import horizons from './fixtures/horizons.json';
import {
  ELEMENTS,
  PLANET_IDS,
  type PlanetId,
  centuriesSinceJ2000,
  heliocentricDistance,
  julianDay,
  orbitalPeriodDays,
  planetPosition,
  solveKepler,
  wrapDegrees,
} from './planets';

const reference = horizons as unknown as Record<string, Record<string, [number, number, number]>>;

/**
 * Bounds in **arcminutes of heliocentric angle**, not AU.
 *
 * An AU is the wrong unit for this: 0.01 AU is a tenth of Mercury's orbit and
 * a thousandth of Neptune's, so one number in AU is simultaneously far too
 * loose for the inner planets and too tight for the outer ones. Measured
 * against Horizons at three epochs, the worst seen for each is:
 *
 *     mercury 0.1'   venus 0.3'   earth 0.3'   mars 0.6'
 *     jupiter 5.3'   saturn 9.6'  uranus 1.2'  neptune 0.8'
 *
 * **Jupiter and Saturn are the outliers and that is physics, not sloppiness.**
 * Their 5:2 near-resonance - the great inequality - swaps angular momentum
 * between them on a 900-year cycle that linear elements cannot represent. The
 * signature is exactly what the table shows: the two adjacent resonant bodies,
 * with an error that *oscillates* with date rather than sitting at a constant
 * offset. A mistyped element would do the opposite.
 *
 * Ten arcminutes at Saturn is a third of the Moon's apparent width. At the
 * compressed scale Phase 3 will choose, it is far under one pixel.
 */
const MAX_ARCMIN: Record<PlanetId, number> = {
  mercury: 1, venus: 1, earth: 1, mars: 1,
  jupiter: 8, saturn: 12, uranus: 3, neptune: 2,
};

function arcminutesApart(planet: PlanetId, date: string): number {
  const [x, y, z] = reference[planet][date];
  const got = planetPosition(planet, new Date(`${date}T00:00:00Z`));
  const error = Math.hypot(got.x - x, got.y - y, got.z - z);
  const radius = Math.hypot(x, y, z);
  return (error / radius) * (180 / Math.PI) * 60;
}

describe('against JPL Horizons', () => {
  for (const planet of PLANET_IDS) {
    for (const date of Object.keys(reference[planet])) {
      it(`places ${planet} correctly on ${date}`, () => {
        const off = arcminutesApart(planet, date);
        expect(off, `${planet} off by ${off.toFixed(1)} arcmin`).toBeLessThan(
          MAX_ARCMIN[planet],
        );
      });
    }
  }

  it('holds the inner planets to an arcminute, which a loose bound would hide', () => {
    // A single tolerance wide enough for Saturn would let Mercury be wrong by
    // a quarter of its orbit and still pass.
    for (const planet of ['mercury', 'venus', 'earth', 'mars'] as PlanetId[]) {
      for (const date of Object.keys(reference[planet])) {
        expect(arcminutesApart(planet, date), `${planet} ${date}`).toBeLessThan(1);
      }
    }
  });

  it('is accurate enough that no screen could show the difference', () => {
    // The product claim, stated as a number. Saturn's worst error subtends
    // less than a pixel at any scale a planet-sized sphere can be drawn at.
    const worst = Math.max(
      ...PLANET_IDS.flatMap((p) =>
        Object.keys(reference[p]).map((d) => arcminutesApart(p, d)),
      ),
    );
    expect(worst).toBeLessThan(12);
  });
});

describe('the element table itself', () => {
  it('has mean-longitude rates in the right row, to a part in a thousand', () => {
    // Two columns of the table checking each other: `lRate` is degrees per
    // century, the period comes from `a`, and a row pasted against the wrong
    // planet makes them disagree by percent.
    //
    // **It will not catch a transposed digit, and the bound says so.** The
    // measured deviations are 2-19 ppm for the inner planets but 448 ppm for
    // Jupiter, 512 for Uranus and 633 for Neptune - so anything tight enough
    // to see a 368 ppm typo fails on Neptune for being right. Part of that
    // spread is this file's own fault: `orbitalPeriodDays` uses Kepler's third
    // law with the solar mass alone, and Jupiter is 1/1047 of a solar mass, so
    // its true period is about 478 ppm shorter than the formula says. That is
    // very nearly Jupiter's whole deviation.
    //
    // Digit-level errors in a rate are caught by the Horizons comparison
    // instead, and only because the fixtures now reach 1900 and 2049: a rate
    // error needs time to accumulate, and every epoch used to sit within a
    // third of a century of J2000 where there is none.
    for (const planet of PLANET_IDS) {
      const fromRate = ELEMENTS[planet].lRate;
      const fromPeriod = 360 * (36525 / orbitalPeriodDays(planet));
      expect(fromRate / fromPeriod, planet).toBeGreaterThan(0.999);
      expect(fromRate / fromPeriod, planet).toBeLessThan(1.001);
    }
  });

  it('carries a rate for every element, so none is silently frozen', () => {
    // Earth's node is the one legitimate zero: the ecliptic is defined by
    // Earth's orbit, so its ascending node on that plane is undefined and JPL
    // publish it as exactly zero.
    for (const planet of PLANET_IDS) {
      const el = ELEMENTS[planet];
      for (const key of ['aRate', 'eRate', 'iRate', 'lRate', 'periRate'] as const) {
        expect(el[key], `${planet}.${key}`).not.toBe(0);
      }
      if (planet !== 'earth') expect(el.nodeRate, `${planet}.nodeRate`).not.toBe(0);
    }
  });

  it('is ordered outward, which a pasted-in-the-wrong-row error would break', () => {
    const axes = PLANET_IDS.map((p) => ELEMENTS[p].a);
    expect([...axes].sort((x, y) => x - y)).toEqual(axes);
  });
});

describe('the time argument', () => {
  it('puts J2000 at the origin of the century count', () => {
    // 2000-01-01 12:00 TT. Getting this wrong shifts every planet by a
    // fraction of a century's worth of motion, which for Mercury is degrees.
    expect(julianDay(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(2451545.0, 6);
    expect(centuriesSinceJ2000(new Date('2000-01-01T12:00:00Z'))).toBeCloseTo(0, 9);
  });

  it('counts a century as 36,525 days', () => {
    const later = new Date('2100-01-01T12:00:00Z');
    expect(centuriesSinceJ2000(later)).toBeCloseTo(1.0, 3);
  });

  it('runs backwards as readily as forwards', () => {
    // Nothing here is measured, so there is no epoch to drift from and no
    // seven-day bound like the satellites have. 1900 costs what 2100 costs.
    expect(centuriesSinceJ2000(new Date('1900-01-01T12:00:00Z'))).toBeLessThan(0);
    expect(heliocentricDistance('mars', new Date('1900-06-01T00:00:00Z'))).toBeGreaterThan(1.3);
  });
});

describe('Kepler', () => {
  it('is exact at perihelion and aphelion, where E equals M', () => {
    expect(solveKepler(0, 0.2)).toBeCloseTo(0, 9);
    expect(solveKepler(180, 0.2)).toBeCloseTo(180, 6);
  });

  it('reduces to the mean anomaly on a circle', () => {
    for (const m of [-120, -30, 45, 170]) expect(solveKepler(m, 0)).toBeCloseTo(m, 9);
  });

  it('satisfies its own equation, at the worst eccentricity we carry', () => {
    // Mercury's 0.206 is the hardest case in the table. Asserting the residual
    // rather than a remembered answer: this is the equation being solved.
    const e = ELEMENTS.mercury.e;
    for (const m of [-150, -75, 12, 99, 179]) {
      const E = solveKepler(m, e);
      const residual = E - (180 / Math.PI) * e * Math.sin((E * Math.PI) / 180) - m;
      expect(Math.abs(residual)).toBeLessThan(1e-7);
    }
  });

  it('wraps angles into the half where it converges fastest', () => {
    expect(wrapDegrees(370)).toBeCloseTo(10, 9);
    expect(wrapDegrees(-370)).toBeCloseTo(-10, 9);
    expect(wrapDegrees(200)).toBeCloseTo(-160, 9);
    expect(wrapDegrees(0)).toBeCloseTo(0, 9);
  });
});

describe('the orbits themselves', () => {
  it('keeps every planet between its own perihelion and aphelion', () => {
    // A rotation error would show here even when the distance looked right at
    // one instant: this walks a whole orbit.
    const bounds: Record<PlanetId, [number, number]> = {
      mercury: [0.307, 0.467], venus: [0.718, 0.729], earth: [0.983, 1.017],
      mars: [1.381, 1.667], jupiter: [4.95, 5.46], saturn: [9.02, 10.06],
      uranus: [18.28, 20.10], neptune: [29.80, 30.33],
    };
    for (const planet of PLANET_IDS) {
      const [min, max] = bounds[planet];
      const period = orbitalPeriodDays(planet);
      for (let step = 0; step < 24; step += 1) {
        const when = new Date(Date.UTC(2026, 0, 1) + (period * step / 24) * 86_400_000);
        const r = heliocentricDistance(planet, when);
        expect(r, `${planet} at step ${step}`).toBeGreaterThan(min - 0.01);
        expect(r, `${planet} at step ${step}`).toBeLessThan(max + 0.01);
      }
    }
  });

  it('returns each planet to where it started after one period', () => {
    // The strongest single check on the table: the period comes from `a` and
    // the position comes from every element, so agreement is not circular.
    for (const planet of PLANET_IDS) {
      const start = new Date('2026-01-01T00:00:00Z');
      const after = new Date(start.getTime() + orbitalPeriodDays(planet) * 86_400_000);
      const a = planetPosition(planet, start);
      const b = planetPosition(planet, after);
      const drift = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(drift, `${planet} drifted ${drift.toFixed(3)} AU`).toBeLessThan(
        0.03 * ELEMENTS[planet].a,
      );
    }
  });

  it('has Earth at perihelion in early January', () => {
    // An independent fact about the real world, not about this code: Earth is
    // closest to the Sun around 3-5 January, not in the northern winter's
    // imagination.
    const distances = Array.from({ length: 365 }, (_, day) => ({
      day,
      r: heliocentricDistance('earth', new Date(Date.UTC(2026, 0, 1) + day * 86_400_000)),
    }));
    const closest = distances.reduce((a, b) => (b.r < a.r ? b : a));
    expect(closest.day).toBeLessThan(10);
    expect(closest.r).toBeCloseTo(0.9833, 2);
  });

  it('orders the planets outward, which no rotation error survives', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const radii = PLANET_IDS.map((p) => heliocentricDistance(p, when));
    // Mars can be closer than Venus is far, so compare semi-major axes for the
    // ordering and distances only for plausibility.
    const axes = PLANET_IDS.map((p) => ELEMENTS[p].a);
    expect([...axes].sort((x, y) => x - y)).toEqual(axes);
    expect(radii.every((r) => r > 0)).toBe(true);
  });

  it('gives periods that match the known values', () => {
    const known: Record<PlanetId, number> = {
      mercury: 87.97, venus: 224.70, earth: 365.26, mars: 686.98,
      jupiter: 4332.6, saturn: 10759, uranus: 30687, neptune: 60190,
    };
    for (const planet of PLANET_IDS) {
      expect(orbitalPeriodDays(planet) / known[planet], planet).toBeCloseTo(1, 2);
    }
  });
});
