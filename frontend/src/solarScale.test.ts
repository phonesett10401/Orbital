/**
 * The compression, checked against what it has to survive.
 *
 * These are not tests of arithmetic - they are tests that a picture is
 * possible. The satellite shell's equivalent (D105) caught a scale that put
 * Cluster II outside any reachable camera, and it caught it here rather than
 * on a screen.
 */

import { describe, expect, it } from 'vitest';

import { BODIES } from './bodies';
import { ELEMENTS, PLANET_IDS, type PlanetId, heliocentricDistance } from './planets';
import {
  AU_KM,
  GLOBE_RADII_AT_NEPTUNE,
  MAPLIBRE_MIN_ZOOM,
  NEPTUNE_APHELION_AU,
  globeRadiiFor,
  BODY_MAX,
  BODY_MIN,
  ORBIT_MAX,
  SCALE_NOTE,
  bodyRadiusFor,
  exaggerationOf,
  radiusFor,
  drawnBodyRadius,
  bodyExaggeration,
} from './solarScale';

const AT = new Date('2026-09-05T00:00:00Z');

describe('why any compression at all', () => {
  it('shows that true scale draws nothing', () => {
    // The measurement the whole file rests on: at true scale, with Neptune's
    // orbit 500 px across, the Sun is a fourteenth of a pixel and Earth is a
    // thousandth of one. Not small - absent.
    const pxPerAu = 500 / 30.07;
    const sunPx = (696_000 / AU_KM) * pxPerAu;
    const earthPx = (6_371 / AU_KM) * pxPerAu;
    expect(sunPx).toBeLessThan(0.1);
    expect(earthPx).toBeLessThan(0.001);
  });

  it('confirms the two axes cannot share one scale', () => {
    // Earth's orbit is about 23,000 times its own radius, which is why
    // distance and size are compressed separately rather than together.
    expect((1 * AU_KM) / 6_371).toBeGreaterThan(20_000);
  });
});

describe('orbit distance', () => {
  it('is monotonic, which is the property that actually matters', () => {
    // Whatever the compression does to the numbers, further out must draw
    // further out. Checked densely rather than at the eight planets, because
    // eight samples would miss a kink between them.
    let previous = -1;
    for (let au = 0; au <= 35; au += 0.05) {
      const r = radiusFor(au);
      expect(r, `at ${au} AU`).toBeGreaterThan(previous);
      previous = r;
    }
  });

  it('puts every planet inside the frame, Neptune on the rim', () => {
    for (const planet of PLANET_IDS) {
      const r = radiusFor(heliocentricDistance(planet, AT));
      expect(r, planet).toBeGreaterThan(0);
      expect(r, planet).toBeLessThanOrEqual(ORBIT_MAX * 1.02);
    }
    // Neptune at its furthest is the thing that must fit, not its mean.
    expect(radiusFor(NEPTUNE_APHELION_AU)).toBeCloseTo(ORBIT_MAX, 6);
  });

  it('keeps Mercury clear of the Sun rather than crushed onto it', () => {
    // The failure a linear scale gives: 96% of the frame spent on the four
    // giants and the inner four in a smudge at the centre.
    expect(radiusFor(ELEMENTS.mercury.a)).toBeGreaterThan(0.15);
  });

  it('leaves every adjacent pair separately clickable', () => {
    // At a 500 px frame radius the tightest gap must still be worth aiming
    // at. Venus to Earth is the tightest, and it is 26 px.
    const drawn = PLANET_IDS.map((p) => radiusFor(ELEMENTS[p].a));
    const gaps = drawn.slice(1).map((r, i) => r - drawn[i]);
    expect(Math.min(...gaps) * 500).toBeGreaterThan(20);
  });

  it('is finite and sane at the origin', () => {
    // A bare logarithm sends the Sun's own centre to minus infinity; the
    // softening term is what stops that.
    expect(radiusFor(0)).toBe(0);
    expect(Number.isFinite(radiusFor(0))).toBe(true);
    expect(radiusFor(-5)).toBe(0);
  });
});

describe('body size', () => {
  it('is monotonic across every radius we draw', () => {
    let previous = -1;
    for (const km of [0, 500, 1_737, 2_440, 3_390, 6_052, 6_371, 24_622, 25_362, 58_232, 69_911, 696_000]) {
      const r = bodyRadiusFor(km);
      expect(r, `at ${km} km`).toBeGreaterThan(previous);
      previous = r;
    }
  });

  it('lands the Moon on the floor and the Sun on the ceiling', () => {
    expect(bodyRadiusFor(1_737.4)).toBeCloseTo(BODY_MIN, 6);
    expect(bodyRadiusFor(696_000)).toBeCloseTo(BODY_MAX, 6);
  });

  it('draws a 401:1 spread as about 10:1', () => {
    const trueSpread = 696_000 / 1_737.4;
    const drawnSpread = bodyRadiusFor(696_000) / bodyRadiusFor(1_737.4);
    expect(trueSpread).toBeGreaterThan(400);
    expect(drawnSpread).toBeCloseTo(10, 0);
  });

  it('keeps bodies that really are alike looking alike', () => {
    // The part a reader can check against what they already know: Venus and
    // Earth are within 5% of each other, and so are Uranus and Neptune.
    const ratio = (a: number, b: number) => bodyRadiusFor(a) / bodyRadiusFor(b);
    expect(ratio(6_371, 6_051.8)).toBeGreaterThan(0.95);
    expect(ratio(6_371, 6_051.8)).toBeLessThan(1.05);
    expect(ratio(25_362, 24_622)).toBeGreaterThan(0.95);
    expect(ratio(25_362, 24_622)).toBeLessThan(1.05);
  });

  it('never draws a planet larger than the Sun', () => {
    for (const body of BODIES) {
      if (body.id === 'sun') continue;
      expect(bodyRadiusFor(body.radiusKm), body.name).toBeLessThan(bodyRadiusFor(696_000));
    }
  });

  it('is in the same unit as the orbit scale', () => {
    // The bug this replaced: bodies in pixels, orbits in frame fractions, and
    // a magic factor of a thousand in `exaggerationOf` covering the mismatch.
    // The Sun must be a small fraction of Neptune's orbit, not thirty times it.
    expect(bodyRadiusFor(696_000)).toBeLessThan(ORBIT_MAX * 0.1);
    expect(bodyRadiusFor(696_000)).toBeGreaterThan(radiusFor(ELEMENTS.mercury.a) * 0.1);
  });
});

describe('where MapLibre can actually draw it', () => {
  it('keeps the whole system inside the measured reach', () => {
    // Measured on screen at zoom -2: a ring at 20 globe radii shows 52% of
    // itself, which is its entire near side; at 40 it shows 11%. Neptune sits
    // at 18 so the outermost orbit is inside the frame rather than exactly on
    // the boundary where a resize would push it out (D123).
    expect(globeRadiiFor(ORBIT_MAX)).toBe(GLOBE_RADII_AT_NEPTUNE);
    expect(GLOBE_RADII_AT_NEPTUNE).toBeLessThan(20);
  });

  it('fits Neptune at aphelion, not merely at its mean distance', () => {
    // The bug this caught: ORBIT_K was normalised on the semi-major axis, so
    // for the half of its orbit spent beyond the mean Neptune drew outside the
    // frame. Small, and the kind that shows as a planet clipping the rim
    // rather than as a wrong number anywhere.
    const furthest = Math.max(
      ...Array.from({ length: 200 }, (_, i) =>
        heliocentricDistance('neptune', new Date(Date.UTC(2026, 0, 1) + i * 110 * 86_400_000)),
      ),
    );
    expect(globeRadiiFor(radiusFor(furthest))).toBeLessThanOrEqual(GLOBE_RADII_AT_NEPTUNE);
  });

  it('leaves the satellite shell room underneath', () => {
    // The shell stands off at about 2.4 radii. Mercury is the innermost orbit
    // and must not be drawn inside it, or the two layers overlap at the one
    // zoom where both are visible.
    expect(globeRadiiFor(radiusFor(0.387))).toBeGreaterThan(2.4);
  });

  it('holds every planet between the shell and the reach', () => {
    for (const planet of PLANET_IDS) {
      const r = globeRadiiFor(radiusFor(ELEMENTS[planet].a));
      expect(r, planet).toBeGreaterThan(2.4);
      expect(r, planet).toBeLessThanOrEqual(GLOBE_RADII_AT_NEPTUNE);
    }
  });

  it('names the floor MapLibre imposes rather than one we chose', () => {
    // `setMinZoom(-6)` throws: "minZoom must be between -2 and the current
    // maxZoom". It is a library cap, so treating it as a preference would be
    // a decision nobody can act on.
    expect(MAPLIBRE_MIN_ZOOM).toBe(-2);
  });
});

describe('saying what was done to the truth', () => {
  it('reports an exaggeration in the hundreds to thousands', () => {
    // Measured: 628x for Jupiter to 4,580x for Neptune. If this ever returns
    // something near 1 the compression has quietly stopped happening.
    const factors = PLANET_IDS.map((planet: PlanetId) => {
      const body = BODIES.find((b) => b.id === planet)!;
      return exaggerationOf(body.radiusKm, ELEMENTS[planet].a);
    });
    for (const factor of factors) {
      expect(factor).toBeGreaterThan(100);
      expect(factor).toBeLessThan(10_000);
    }
    expect(Math.min(...factors)).toBeGreaterThan(500);
  });

  it('refuses to divide by a body that is not there', () => {
    expect(exaggerationOf(0, 1)).toBe(1);
    expect(exaggerationOf(6_371, 0)).toBe(1);
    expect(Number.isFinite(exaggerationOf(6_371, 1))).toBe(true);
  });

  it('carries a note that names both compressions and the thing left true', () => {
    // Every other layer states what it is doing to the truth. A solar system
    // drawn a thousand times out of proportion must not be the quiet one.
    expect(SCALE_NOTE).toMatch(/compress/i);
    expect(SCALE_NOTE).toMatch(/angle/i);
    expect(SCALE_NOTE).toMatch(/(nothing|not)[^.]{0,12}to scale/i);
  });
});

describe('true size against the compression', () => {
  const SUN = 695_700;
  const JUPITER = 69_911;
  const EARTH = 6_371;
  const MOON = 1_737.4;
  const MERCURY = 2_439.7;

  it('leaves the compressed scale exactly as it was', () => {
    // The mode is an addition, not a change. If these move, every body in the
    // default view has quietly resized.
    expect(drawnBodyRadius(SUN)).toBeCloseTo(1.08, 2);
    expect(drawnBodyRadius(EARTH)).toBeCloseTo(0.241, 3);
    expect(drawnBodyRadius(MOON)).toBeCloseTo(0.108, 3);
  });

  it('holds the Sun still and shrinks the planets to their real share of it', () => {
    // Anchoring the other way - Earth fixed, Sun true - would put the Sun 26
    // globe radii across and swallow the scene, demonstrating nothing except
    // that the switch had been thrown.
    expect(drawnBodyRadius(SUN, true)).toBeCloseTo(drawnBodyRadius(SUN), 6);
    expect(drawnBodyRadius(EARTH, true)).toBeCloseTo(drawnBodyRadius(SUN) / 109.2, 3);
    expect(drawnBodyRadius(JUPITER, true)).toBeLessThan(drawnBodyRadius(JUPITER));
  });

  it('makes the difference large enough to be the point', () => {
    // If true mode looked much like compressed mode there would be no reason
    // for it. Earth should become roughly a tenth of its compressed size.
    expect(drawnBodyRadius(EARTH) / drawnBodyRadius(EARTH, true)).toBeGreaterThan(20);
  });

  it('keeps the ordering identical in both modes', () => {
    // Compression may squeeze, but it must never reorder: a mode where Mercury
    // outgrew Jupiter would be worse than the thing it replaced.
    for (const mode of [false, true]) {
      const sizes = [MOON, MERCURY, EARTH, JUPITER, SUN].map((r) =>
        drawnBodyRadius(r, mode),
      );
      for (let i = 1; i < sizes.length; i += 1) {
        expect(sizes[i], `mode ${mode} step ${i}`).toBeGreaterThan(sizes[i - 1]);
      }
    }
  });

  it('reports its own exaggeration honestly', () => {
    // True mode claims to be true; this makes the claim executable.
    for (const r of [SUN, JUPITER, EARTH, MOON, MERCURY]) {
      expect(bodyExaggeration(r, true), `${r}`).toBeCloseTo(1, 9);
    }
    // Compressed mode inflates everything smaller than the Sun.
    expect(bodyExaggeration(EARTH, false)).toBeGreaterThan(1);
    expect(bodyExaggeration(MOON, false)).toBeGreaterThan(bodyExaggeration(EARTH, false));
  });

  it('keeps the whole system inside the scene in both modes', () => {
    for (const mode of [false, true]) {
      expect(drawnBodyRadius(SUN, mode)).toBeLessThan(GLOBE_RADII_AT_NEPTUNE);
    }
  });
});
