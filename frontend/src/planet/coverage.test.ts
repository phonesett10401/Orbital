import { describe, expect, it } from 'vitest';

import {
  COVERAGE_GAPS,
  COVERAGE_MAX_ZOOM,
  COVERAGE_SOURCE,
  coverageFeatures,
  coverageLayers,
} from './coverageLayer';

/** The densities that justified each shape, and the controls they beat. */
const GAP_CEILING = 0.5;
const LOWEST_CONTROL = 56;

describe('the regions themselves', () => {
  it('only claims regions that measured as empty', () => {
    // Each was checked against the live store before being drawn. The lowest
    // control - India - was 56 per 100 sq deg; every gap is under 0.5.
    for (const region of COVERAGE_GAPS) {
      expect(region.density).toBeLessThan(GAP_CEILING);
      expect(region.density).toBeLessThan(LOWEST_CONTROL);
    }
  });

  it('does not claim Afghanistan, which looked like a gap and is not', () => {
    // It measured 5.56, twenty times the real gaps. It read as a gap in an
    // earlier longitude-band reading, which is exactly the kind of inference
    // this test exists to stop being drawn on a map.
    const names = COVERAGE_GAPS.map((r) => r.name.toLowerCase()).join(' ');
    expect(names).not.toContain('afghan');
    expect(names).not.toContain('iran');
  });

  it('leaves out the oceans, whose emptiness has two causes', () => {
    // Over land, empty means unheard. Over the mid-Pacific it means unheard
    // AND barely flown, and this layer would take credit for both.
    const names = COVERAGE_GAPS.map((r) => r.name.toLowerCase()).join(' ');
    for (const ocean of ['pacific', 'atlantic', 'antarctic', 'ocean']) {
      expect(names).not.toContain(ocean);
    }
  });

  it('draws closed polygons with plausible coordinates', () => {
    for (const region of COVERAGE_GAPS) {
      expect(region.ring.length).toBeGreaterThanOrEqual(4);
      expect(region.ring[0]).toEqual(region.ring[region.ring.length - 1]);
      for (const [lon, lat] of region.ring) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });
});

describe('the layers', () => {
  it('passes the style-spec validator', async () => {
    // The lesson from defect #25, twice: a layer MapLibre rejects is dropped
    // silently, and no other assertion here can tell.
    const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec');
    const style = {
      version: 8 as const,
      sources: { [COVERAGE_SOURCE]: { type: 'geojson', data: coverageFeatures() } },
      layers: coverageLayers(),
      glyphs: 'https://example.invalid/{fontstack}/{range}.pbf',
    };
    expect(validateStyleMin(style as never).map((e) => e.message)).toEqual([]);
  });

  it('stops before the map is zoomed in', () => {
    // The claim is continental. In a city it fills the screen and says nothing.
    for (const layer of coverageLayers()) {
      expect(layer.maxzoom).toBe(COVERAGE_MAX_ZOOM);
    }
  });

  it('never draws over an aircraft', () => {
    // Ordering is PlanetView's job, but the opacities are this file's: an
    // annotation about the ground must not compete with the things on it.
    const [fill] = coverageLayers();
    const opacity = (fill.paint as Record<string, unknown>)['fill-opacity'] as unknown[];
    const peaks = opacity.filter((v) => typeof v === 'number' && v > 0 && v < 1);
    for (const peak of peaks) expect(peak as number).toBeLessThanOrEqual(0.15);
  });

  it('one feature per region, each carrying its name', () => {
    const features = coverageFeatures().features;
    expect(features).toHaveLength(COVERAGE_GAPS.length);
    expect(features.map((f) => f.properties.name)).toEqual(COVERAGE_GAPS.map((r) => r.name));
  });
});
