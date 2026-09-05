import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLOUR,
  SURFACES,
  hasSurface,
  surfaceColour,
  surfaceTexture,
} from './planetSurface';

const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('the band tables', () => {
  it('cover every latitude with no gaps and no black stripes', () => {
    // A gap samples as the fallback and draws as a stripe at a latitude where
    // nothing is happening, which looks like a rendering fault rather than a
    // missing row of a table.
    for (const [id, bands] of Object.entries(SURFACES)) {
      expect(bands[0].from, id).toBe(-90);
      expect(bands[bands.length - 1].to, id).toBe(90);
      for (let i = 1; i < bands.length; i += 1) {
        expect(bands[i].from, `${id} band ${i}`).toBe(bands[i - 1].to);
      }
    }
  });

  it('stays inside the byte range on every channel', () => {
    for (const bands of Object.values(SURFACES)) {
      for (const band of bands) {
        for (const channel of band.colour) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(255);
        }
      }
    }
  });
});

describe('Jupiter, which is the one worth getting right', () => {
  it('makes the North Equatorial Belt darker than the Equatorial Zone', () => {
    // Belts dark, zones light. If this inverts, Jupiter is drawn as a negative
    // of itself and still looks banded, which is why it is asserted rather
    // than eyeballed.
    const neb = luminance(surfaceColour('jupiter', 12));
    const ez = luminance(surfaceColour('jupiter', 0));
    expect(neb).toBeLessThan(ez * 0.75);
  });

  it('puts the belts at the latitudes they are named for', () => {
    // The NEB runs about 7 to 17 north and the SEB about 7 to 21 south, so the
    // colour must change as those edges are crossed.
    expect(surfaceColour('jupiter', 5)).not.toEqual(surfaceColour('jupiter', 12));
    expect(surfaceColour('jupiter', -5)).not.toEqual(surfaceColour('jupiter', -15));
  });

  it('alternates rather than shading in one direction', () => {
    // A gradient from pole to pole would pass a naive "it varies" check. Belts
    // and zones alternate, so the sequence must go down, up, down.
    const lats = [0, 12, 20, 27];
    const values = lats.map((lat) => luminance(surfaceColour('jupiter', lat)));
    expect(values[1]).toBeLessThan(values[0]);
    expect(values[2]).toBeGreaterThan(values[1]);
    expect(values[3]).toBeLessThan(values[2]);
  });

  it('has more structure than Uranus does', () => {
    // Not every planet should be busy. Uranus really is nearly featureless.
    expect(SURFACES.jupiter.length).toBeGreaterThan(SURFACES.uranus.length * 3);
  });
});

describe('the other bodies', () => {
  it('gives Mars polar caps brighter than its middle', () => {
    expect(luminance(surfaceColour('mars', 87))).toBeGreaterThan(
      luminance(surfaceColour('mars', 0)) * 1.5,
    );
    expect(luminance(surfaceColour('mars', -87))).toBeGreaterThan(
      luminance(surfaceColour('mars', 0)) * 1.5,
    );
  });

  it('keeps Mars red - more red than blue at every latitude but the caps', () => {
    for (const lat of [-60, -20, 0, 30, 60]) {
      const [r, , b] = surfaceColour('mars', lat);
      expect(r).toBeGreaterThan(b * 1.5);
    }
  });

  it('keeps Neptune blue and Uranus paler than it', () => {
    const [nr, , nb] = surfaceColour('neptune', 0);
    expect(nb).toBeGreaterThan(nr * 1.5);
    expect(luminance(surfaceColour('uranus', 0))).toBeGreaterThan(
      luminance(surfaceColour('neptune', 0)),
    );
  });

  it('leaves Venus nearly uniform, because Venus is', () => {
    // Inventing features for a body that has none would be the one dishonest
    // thing in the file.
    const middle = luminance(surfaceColour('venus', 0));
    const pole = luminance(surfaceColour('venus', 70));
    expect(Math.abs(middle - pole) / middle).toBeLessThan(0.15);
  });

  it('falls back to plain grey rather than black for an unknown body', () => {
    expect(surfaceColour('pluto', 0)).toEqual(DEFAULT_COLOUR);
    expect(hasSurface('pluto')).toBe(false);
    expect(hasSurface('jupiter')).toBe(true);
  });
});

describe('the texture the sphere samples', () => {
  it('runs south pole to north pole, matching the sphere UVs', () => {
    // Row zero is uv.y zero, which three.js puts at the south pole. Flipped,
    // Mars would wear its north cap in the south - a mistake that still looks
    // like a planet.
    const mars = surfaceTexture('mars', 256);
    const first = [mars[0], mars[1], mars[2]] as [number, number, number];
    const middle = [mars[128 * 4], mars[128 * 4 + 1], mars[128 * 4 + 2]] as [
      number,
      number,
      number,
    ];
    expect(luminance(first)).toBeGreaterThan(luminance(middle));
  });

  it('is opaque everywhere, so no planet has holes in it', () => {
    const data = surfaceTexture('jupiter', 64);
    for (let i = 0; i < 64; i += 1) expect(data[i * 4 + 3]).toBe(255);
  });

  it('is the size it says it is', () => {
    expect(surfaceTexture('jupiter', 128).length).toBe(128 * 4);
    expect(surfaceTexture('jupiter', 256).length).toBe(256 * 4);
  });

  it('samples the same function the tests check', () => {
    // A second copy of the latitudes could drift from this one.
    const data = surfaceTexture('jupiter', 360);
    const rowFor = (lat: number) => Math.floor(((lat + 90) / 180) * 360);
    const at = (lat: number): [number, number, number] => {
      const i = rowFor(lat) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(luminance(at(12))).toBeLessThan(luminance(at(0)));
  });
});

describe('Earth, which is now drawn as a body like the others', () => {
  it('is mostly blue, because it mostly is', () => {
    const [r, , b] = surfaceColour('earth', 0);
    expect(b).toBeGreaterThan(r * 1.5);
  });

  it('is white at both poles', () => {
    const bright = ([r, g, b]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(bright(surfaceColour('earth', 85))).toBeGreaterThan(bright(surfaceColour('earth', 0)) * 1.8);
    expect(bright(surfaceColour('earth', -85))).toBeGreaterThan(bright(surfaceColour('earth', 0)) * 1.8);
  });

  it('has a profile at all, so it is not drawn as a grey ball', () => {
    // Without one it falls back to the default grey, which is what the world
    // under the camera looked like the first time it was drawn as a body.
    expect(hasSurface('earth')).toBe(true);
  });
});
