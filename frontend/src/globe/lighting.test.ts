/**
 * Tests for the day/night terminator.
 *
 * These exist because of a defect that survived M4 and every test written
 * since (D41): the globe was lit by dotting a *view-space* normal against a
 * *world-space* sun direction, so the lit patch followed the camera instead of
 * the sun and the whole planet read as night at every rotation. Both textures
 * loaded, the sun vector was a correct unit vector, and every assertion in
 * sun.test.ts passed throughout. What nobody had checked was whether the
 * terminator was in the *right place*.
 *
 * Two things together pin that down:
 *
 * 1. **Where the light should fall**, on the CPU. For a sphere the outward
 *    world-space normal at a surface point is the unit vector to that point,
 *    so the shader's `lambert` term is computable here without a renderer.
 * 2. **That the shader consumes that frame**, by reading the shader source.
 *    There is no GL context under vitest, so the coordinate frame cannot be
 *    checked by rendering -- but the frame is a property of the source, and it
 *    is the exact thing that was wrong.
 *
 * What neither can see is the assembled pipeline. That is measured against a
 * real GL context by the pixel probe in lightingProbe.ts and recorded in the
 * test plan (section 12) -- the same division of labour as the marker rotation
 * work in D40.
 */

import { describe, expect, it } from 'vitest';

import { config } from '../config';
import {
  atmosphereVertexShader,
  createEarthVisuals,
  globeFragmentShader,
  globeVertexShader,
  latLonToVector3,
  sunDirectionFor,
  surfaceLambert,
} from './earth';
import { subsolarPoint } from './sun';

/** GLSL with `//` comments removed, so prose about a term is not mistaken for it. */
function code(shader: string): string {
  return shader
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const JUNE_SOLSTICE = new Date('2026-06-21T12:00:00Z');
const DECEMBER_SOLSTICE = new Date('2026-12-21T12:00:00Z');
const MARCH_EQUINOX = new Date('2026-03-20T12:00:00Z');

/** Dates spread across a year and around the clock. */
const SAMPLE_DATES: Date[] = [];
for (let day = 0; day < 365; day += 11) {
  for (let hour = 0; hour < 24; hour += 5) {
    SAMPLE_DATES.push(new Date(Date.UTC(2026, 0, 1 + day, hour)));
  }
}

/**
 * Area-weighted fraction of the sphere that is lit.
 *
 * Weighted by cos(lat) because an equal-angle grid over-samples the poles, and
 * an unweighted count would report a hemisphere as something other than half.
 *
 * The sun is computed once per date rather than per sample. Calling
 * `surfaceLambert` in the inner loop re-derives the subsolar point for every
 * one of the sixteen thousand points, which made this test slow enough to trip
 * vitest's five-second timeout every few runs -- a flaky test that was flaky
 * for a reason having nothing to do with what it asserts.
 */
function litFraction(date: Date): number {
  const sun = sunDirectionFor(date);
  let lit = 0;
  let total = 0;
  for (let lat = -89; lat <= 89; lat += 2) {
    const weight = Math.cos((lat * Math.PI) / 180);
    for (let lon = -180; lon < 180; lon += 2) {
      total += weight;
      if (latLonToVector3(lat, lon, 1).dot(sun) > 0) lit += weight;
    }
  }
  return lit / total;
}

describe('the sun direction', () => {
  it('points at the subsolar point', () => {
    const date = new Date('2026-08-26T09:30:00Z');
    const { lat, lon } = subsolarPoint(date);
    const sun = sunDirectionFor(date);
    expect(sun.dot(latLonToVector3(lat, lon, 1))).toBeCloseTo(1, 10);
  });

  it('is a unit vector at every hour of the day', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const length = sunDirectionFor(new Date(Date.UTC(2026, 5, 21, hour))).length();
      expect(length).toBeCloseTo(1, 10);
    }
  });

  it('depends on nothing but the date', () => {
    // The defect made the lighting depend on the camera. Nothing but time may
    // move the sun, so the same instant must give a bit-identical vector.
    const date = new Date('2026-08-26T09:30:00Z');
    const first = sunDirectionFor(date);
    const second = sunDirectionFor(new Date(date.getTime()));
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y);
    expect(second.z).toBe(first.z);
  });

  it('sweeps a full turn over a day, rather than staying put', () => {
    const noon = sunDirectionFor(new Date('2026-03-20T12:00:00Z'));
    const midnight = sunDirectionFor(new Date('2026-03-20T00:00:00Z'));
    expect(noon.dot(midnight)).toBeLessThan(-0.98);
  });
});

describe('the terminator is in the right place', () => {
  it('puts the sun overhead at the subsolar point', () => {
    for (const date of SAMPLE_DATES) {
      const { lat, lon } = subsolarPoint(date);
      expect(surfaceLambert(lat, lon, date)).toBeCloseTo(1, 6);
    }
  });

  it('puts the sun directly underfoot at the antipode', () => {
    for (const date of SAMPLE_DATES) {
      const { lat, lon } = subsolarPoint(date);
      const antipode = surfaceLambert(-lat, lon > 0 ? lon - 180 : lon + 180, date);
      expect(antipode).toBeCloseTo(-1, 6);
    }
  });

  it('runs through the points ninety degrees from the sun', () => {
    // The terminator is the great circle a quarter turn from the subsolar
    // point. At an equinox that is the two poles and two meridians.
    const { lon } = subsolarPoint(MARCH_EQUINOX);
    expect(Math.abs(surfaceLambert(90, 0, MARCH_EQUINOX))).toBeLessThan(0.02);
    expect(Math.abs(surfaceLambert(-90, 0, MARCH_EQUINOX))).toBeLessThan(0.02);
    expect(Math.abs(surfaceLambert(0, lon + 90, MARCH_EQUINOX))).toBeLessThan(0.02);
    expect(Math.abs(surfaceLambert(0, lon - 90, MARCH_EQUINOX))).toBeLessThan(0.02);
  });

  it('lights the local noon meridian and darkens local midnight', () => {
    // 12:00 UTC: daylight over Greenwich, night over the dateline.
    const date = new Date('2026-03-20T12:00:00Z');
    expect(surfaceLambert(0, 0, date)).toBeGreaterThan(0.99);
    expect(surfaceLambert(0, 180, date)).toBeLessThan(-0.99);
  });
});

describe('half the planet is always lit and half is always dark', () => {
  // This is the assertion that would have caught the defect. Under the bug the
  // lit region tracked the camera, and at most camera angles the terminator
  // was not on the planet at all -- so the whole globe rendered as night.
  it('has both a lit point and a dark point at every sampled instant', () => {
    for (const date of SAMPLE_DATES) {
      let brightest = -Infinity;
      let darkest = Infinity;
      for (let lat = -80; lat <= 80; lat += 20) {
        for (let lon = -180; lon < 180; lon += 20) {
          const lambert = surfaceLambert(lat, lon, date);
          brightest = Math.max(brightest, lambert);
          darkest = Math.min(darkest, lambert);
        }
      }
      expect(brightest).toBeGreaterThan(0.5);
      expect(darkest).toBeLessThan(-0.5);
    }
  });

  it('lights almost exactly half the surface, whatever the date', () => {
    for (const date of SAMPLE_DATES) {
      // A plane through the centre cuts a sphere in half. The tolerance is the
      // sampling grid's own resolution, not slack in the geometry.
      const fraction = litFraction(date);
      expect(fraction).toBeGreaterThan(0.48);
      expect(fraction).toBeLessThan(0.52);
    }
  });
});

describe('the poles at the solstices', () => {
  it('lights the north pole for a full rotation in June', () => {
    // Midnight sun: at the June solstice the north pole is lit at every hour
    // and the south pole at none. Both poles dark at once -- what the defect
    // produced -- is physically impossible.
    for (let hour = 0; hour < 24; hour += 1) {
      const date = new Date(Date.UTC(2026, 5, 21, hour));
      expect(surfaceLambert(90, 0, date)).toBeGreaterThan(0.3);
      expect(surfaceLambert(-90, 0, date)).toBeLessThan(-0.3);
    }
  });

  it('reverses the poles in December', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const date = new Date(Date.UTC(2026, 11, 21, hour));
      expect(surfaceLambert(90, 0, date)).toBeLessThan(-0.3);
      expect(surfaceLambert(-90, 0, date)).toBeGreaterThan(0.3);
    }
  });

  it('keeps the polar day inside the arctic circle', () => {
    // North of 66.5 the sun does not set at the June solstice, and does not
    // rise at the December one. Checked at 70 degrees, comfortably inside.
    for (let hour = 0; hour < 24; hour += 2) {
      expect(surfaceLambert(70, 0, new Date(Date.UTC(2026, 5, 21, hour)))).toBeGreaterThan(0);
      expect(surfaceLambert(-70, 0, new Date(Date.UTC(2026, 5, 21, hour)))).toBeLessThan(0);
      expect(surfaceLambert(70, 0, new Date(Date.UTC(2026, 11, 21, hour)))).toBeLessThan(0);
      expect(surfaceLambert(-70, 0, new Date(Date.UTC(2026, 11, 21, hour)))).toBeGreaterThan(0);
    }
  });

  it('never leaves both poles dark at once', () => {
    for (const date of SAMPLE_DATES) {
      const north = surfaceLambert(90, 0, date);
      const south = surfaceLambert(-90, 0, date);
      expect(Math.max(north, south)).toBeGreaterThan(-0.01);
      // The poles are antipodal, so their illumination is exactly opposed.
      expect(north).toBeCloseTo(-south, 10);
    }
  });

  it('sees the sun cross the equator between the solstices', () => {
    expect(subsolarPoint(JUNE_SOLSTICE).lat).toBeGreaterThan(23);
    expect(subsolarPoint(DECEMBER_SOLSTICE).lat).toBeLessThan(-23);
    expect(Math.abs(subsolarPoint(MARCH_EQUINOX).lat)).toBeLessThan(0.6);
  });
});

describe('the globe shader lights in world space', () => {
  // The defect in one line: `normalMatrix` transforms a normal into *view*
  // space, and the result was dotted against a world-space sun. These
  // assertions are what stop it coming back.
  const vertex = code(globeVertexShader);
  const fragment = code(globeFragmentShader);
  const worldNormalTerm =
    /vWorldNormal\s*=\s*normalize\(\s*mat3\(\s*modelMatrix\s*\)\s*\*\s*normal\s*\)/;

  it('never derives the globe normal through normalMatrix', () => {
    expect(vertex).not.toMatch(/normalMatrix/);
    expect(fragment).not.toMatch(/normalMatrix/);
  });

  it('passes a world-space normal to the fragment stage', () => {
    expect(vertex).toMatch(worldNormalTerm);
  });

  it('derives its sun-facing normal exactly as the atmosphere does', () => {
    // The atmosphere shader was correct all along and sits in the same file.
    // If the two ever disagree again, one of them is wrong.
    expect(code(atmosphereVertexShader)).toMatch(worldNormalTerm);
  });

  it('dots the sun against the world normal, not a view-space one', () => {
    expect(fragment).toMatch(/vec3 normal = normalize\(vWorldNormal\)/);
    expect(fragment).toMatch(/float lambert = dot\(perturbed, sunDirection\)/);
  });

  it('carries no view-space varying into the lighting at all', () => {
    // vViewPosition and vNormal were the view-space pair. Their absence is
    // what makes the frame mismatch unrepresentable rather than merely fixed.
    expect(fragment).not.toMatch(/vViewPosition/);
    expect(fragment).not.toMatch(/\bvNormal\b/);
    expect(vertex).not.toMatch(/vViewPosition/);
    expect(vertex).not.toMatch(/\bvNormal\b/);
  });

  it('takes the specular view direction from the world-space camera', () => {
    // Blinn-Phong halves the sun direction with the view direction, so a view
    // direction in another frame is the same class of defect, quieter: it
    // shows only as a highlight in the wrong place on water.
    expect(fragment).toMatch(/viewDir = normalize\(cameraPosition - vWorldPosition\)/);
    expect(vertex).toMatch(/vWorldPosition = worldPosition\.xyz/);
  });

  it('builds its tangent frame on the polar axis, which only world space has', () => {
    // The bump map's east/north frame assumes (0, 1, 0) is the polar axis. In
    // view space that is whatever direction the camera calls up, so the relief
    // was lit wrongly too -- a second consequence of the one mismatch.
    expect(fragment).toMatch(/vec3 up = vec3\(0\.0, 1\.0, 0\.0\)/);
    expect(fragment).toMatch(/east = normalize\(cross\(up, normal\)\)/);
  });
});

describe('the material exposes the sun it was given', () => {
  it('updates its uniform when the date changes', () => {
    const earth = createEarthVisuals(100);
    const uniform = earth.material.uniforms.sunDirection.value as THREEVector;

    earth.setSunFromDate(JUNE_SOLSTICE);
    const june = sunDirectionFor(JUNE_SOLSTICE);
    expect(uniform.x).toBeCloseTo(june.x, 10);
    expect(uniform.y).toBeCloseTo(june.y, 10);
    expect(uniform.z).toBeCloseTo(june.z, 10);

    earth.setSunFromDate(DECEMBER_SOLSTICE);
    const december = sunDirectionFor(DECEMBER_SOLSTICE);
    expect(uniform.y).toBeCloseTo(december.y, 10);

    // Six months apart, the sun is north of the equator and then south of it.
    expect(june.y).toBeGreaterThan(0);
    expect(december.y).toBeLessThan(0);

    earth.dispose();
  });

  it('shares one sun vector with the atmosphere', () => {
    // Two sun uniforms that could drift apart would put the halo's terminator
    // somewhere the surface's terminator is not.
    const earth = createEarthVisuals(100);
    const surface = earth.material.uniforms.sunDirection.value;
    const halo = (
      earth.atmosphere.material as unknown as {
        uniforms: Record<string, { value: unknown }>;
      }
    ).uniforms.sunDirection.value;
    expect(halo).toBe(surface);
    earth.dispose();
  });
});

interface THREEVector {
  x: number;
  y: number;
  z: number;
}

describe('the specular glint', () => {
  const fragment = code(globeFragmentShader);

  it('is driven by uniforms, not by literals in the shader', () => {
    // Both numbers are tuned by eye, and a number tuned by eye that can only
    // be changed by editing GLSL and reloading is a number nobody tunes. As
    // uniforms they can be swept from the console against a rendered frame,
    // which is how D48's values were chosen.
    expect(fragment).toMatch(/uniform float specularStrength/);
    expect(fragment).toMatch(/uniform float specularShininess/);
    expect(fragment).toMatch(/pow\(max\(dot\(perturbed, halfway\), 0\.0\), specularShininess\)/);
    expect(fragment).not.toMatch(/, 60\.0\)/);
  });

  it('still lands only on water, and only in daylight', () => {
    // The mask is what keeps the highlight off land, and multiplying by
    // `daylight` is what keeps it off the night side. Retuning the two numbers
    // must not quietly drop either factor.
    expect(fragment).toMatch(/float water = texture2D\(waterTexture, vUv\)\.r/);
    expect(fragment).toMatch(/specular \* water \* daylight \* specularStrength/);
  });

  it('carries the tuned pair through to the material', () => {
    const earth = createEarthVisuals(100);
    expect(earth.material.uniforms.specularStrength.value).toBe(config.specularStrength);
    expect(earth.material.uniforms.specularShininess.value).toBe(config.specularShininess);
    earth.dispose();
  });

  it('defaults to a glint rather than a smudge', () => {
    // Two retunes deep (D48, then D49). The first shrank the lobe and was
    // still rejected by eye, because the quantity that mattered was contrast:
    // the ocean under the glint sits at 9/255, so a peak of 89 is ten times
    // brighter than the water it reflects off. Phone chose 0.08 and 900 from a
    // measured shortlist, where the peak is roughly twice the sea beneath it.
    // The bounds are a direction, not the chosen pair: anything looser is the
    // lamp coming back.
    expect(config.specularShininess).toBeGreaterThanOrEqual(600);
    expect(config.specularStrength).toBeLessThanOrEqual(0.15);
  });

  it('can be retuned live, because a number cannot settle how it looks', () => {
    // The whole point of the setter: whoever is looking at the globe changes
    // both terms from the console, rather than editing GLSL and reloading.
    const earth = createEarthVisuals(100);
    earth.setGlint(0.09, 2000);
    expect(earth.material.uniforms.specularStrength.value).toBe(0.09);
    expect(earth.material.uniforms.specularShininess.value).toBe(2000);
    earth.dispose();
  });
});
