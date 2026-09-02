import { describe, expect, it } from 'vitest';

import {
  COVERAGE_GAPS,
  COVERAGE_LABEL_SOURCE,
  COVERAGE_MAX_ZOOM,
  COVERAGE_MIN_ZOOM,
  COVERAGE_SOURCE,
  coverageFeatures,
  coverageLabelFeatures,
  coverageLayers,
  createHatchImage,
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
      sources: {
        [COVERAGE_SOURCE]: { type: 'geojson', data: coverageFeatures() },
        [COVERAGE_LABEL_SOURCE]: { type: 'geojson', data: coverageLabelFeatures() },
      },
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

describe('one label per region', () => {
  it('labels from points, not polygons', () => {
    // MapLibre labels a polygon once per tile it covers, and these regions
    // span several - "NO RECEIVER COVERAGE" was appearing twice over western
    // China, a few hundred kilometres apart, which reads as two claims.
    const points = coverageLabelFeatures().features;
    expect(points).toHaveLength(COVERAGE_GAPS.length);
    for (const point of points) expect(point.geometry.type).toBe('Point');
  });

  it('puts each anchor inside its own region', () => {
    // A centroid can fall outside a concave shape; these are placed by hand,
    // so the thing worth checking is that they landed in the right place.
    for (const region of COVERAGE_GAPS) {
      const lons = region.ring.map(([lon]) => lon);
      const lats = region.ring.map(([, lat]) => lat);
      const [lon, lat] = region.anchor;
      expect(lon).toBeGreaterThanOrEqual(Math.min(...lons));
      expect(lon).toBeLessThanOrEqual(Math.max(...lons));
      expect(lat).toBeGreaterThanOrEqual(Math.min(...lats));
      expect(lat).toBeLessThanOrEqual(Math.max(...lats));
    }
  });

  it('the label layer reads from the point source', () => {
    const label = coverageLayers().find((l) => l.type === 'symbol');
    expect(label && 'source' in label && label.source).toBe(COVERAGE_LABEL_SOURCE);
  });
});

describe('the hatch', () => {
  it('never throws where there is no canvas', () => {
    // jsdom has no 2d context unless the native canvas package is installed,
    // and a browser can refuse one too. The map must still come up: the
    // pattern is an annotation, and losing it is not losing the map.
    expect(() => createHatchImage()).not.toThrow();
  });

  it('returns either an image or nothing, never a broken one', () => {
    const image = createHatchImage();
    if (image === null) return;
    expect(image.width).toBeGreaterThan(0);
    expect(image.height).toBe(image.width);
  });
});

describe('the shape and its sentence are one statement', () => {
  it('draws no shape at a zoom where the label cannot draw', () => {
    // The fault this catches: the label carried a minzoom and the fill, hatch
    // and outline did not, so below 2.5 a hatched patch drew over western China
    // with nothing to say what it was. An unexplained hole reads as a fault -
    // that is why this layer exists - and an unexplained hatch reads as a
    // *rendering* fault, which impugns the map rather than the data (D111).
    const layers = coverageLayers();
    const windows = layers.map((l) => [l.minzoom, l.maxzoom]);
    for (const w of windows) expect(w).toEqual(windows[0]);
  });

  it('gives every coverage layer a floor, not just the label', () => {
    // Stated separately from the equality above, because four layers that all
    // have `undefined` are also all equal.
    for (const layer of coverageLayers()) {
      expect(typeof layer.minzoom).toBe('number');
      expect(layer.minzoom).toBe(COVERAGE_MIN_ZOOM);
    }
  });

  it('starts fading in no earlier than the floor it is allowed to draw at', () => {
    // A `minzoom` alone would have left the old 1.5 stop unreachable and made
    // the shapes pop into existence at full strength. Both halves of the fix
    // are needed, so both are asserted (D111).
    for (const layer of coverageLayers()) {
      const paint = layer.paint as Record<string, unknown>;
      const key = Object.keys(paint).find((k) => k.endsWith('-opacity'))!;
      const ramp = paint[key] as unknown[];
      expect(ramp[0]).toBe('interpolate');
      expect(ramp[3]).toBe(COVERAGE_MIN_ZOOM);
      expect(ramp[4]).toBe(0);
    }
  });

  it('draws the label light on both grounds, because both are dark', () => {
    // Pre-D108 the flat basemap was cream and this arm was near-black. The
    // ground is #1b212c now and that text would be invisible on it.
    const label = coverageLayers().find((l) => l.type === 'symbol')!;
    const colour = (label.paint as Record<string, unknown>)['text-color'] as unknown[];
    const flatArm = String(colour[3]);
    const luminance = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    };
    expect(luminance(flatArm)).toBeGreaterThan(160);
  });
});
