import { describe, expect, it } from 'vitest';

import type { SatelliteFamily } from './satelliteFamily';
import { SPAN_METRES, disposeSpacecraft, spacecraftGeometryFor } from './spacecraft';

const FAMILIES: SatelliteFamily[] = [
  'station',
  'constellation',
  'navigation',
  'observation',
  'geoComms',
  'probe',
  'satellite',
  'unidentified',
];

/** Bounding box of a geometry, as [minX, maxX, minY, maxY, minZ, maxZ]. */
function bounds(family: SatelliteFamily): number[] {
  const position = spacecraftGeometryFor(family).getAttribute('position');
  const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < position.count; i += 1) {
    const xyz = [position.getX(i), position.getY(i), position.getZ(i)];
    for (let axis = 0; axis < 3; axis += 1) {
      b[axis * 2] = Math.min(b[axis * 2], xyz[axis]);
      b[axis * 2 + 1] = Math.max(b[axis * 2 + 1], xyz[axis]);
    }
  }
  return b;
}

const width = (f: SatelliteFamily) => bounds(f)[1] - bounds(f)[0];

describe('every family has a body', () => {
  it('builds geometry with vertices for all of them', () => {
    for (const family of FAMILIES) {
      expect(spacecraftGeometryFor(family).getAttribute('position').count).toBeGreaterThan(0);
    }
  });

  it('normalises to about one unit across, as the span scaling assumes', () => {
    // The model layer scales by a span in metres, so a geometry that is not
    // unit-span makes that number mean nothing (same rule as airframe.ts).
    for (const family of FAMILIES) {
      expect(width(family)).toBeGreaterThan(0.4);
      expect(width(family)).toBeLessThanOrEqual(1.05);
    }
  });

  it('caches, so reselecting does not rebuild buffers', () => {
    expect(spacecraftGeometryFor('station')).toBe(spacecraftGeometryFor('station'));
  });
});

describe('the shapes say what the families are', () => {
  it('makes a station the widest thing in orbit', () => {
    // A truss with four arrays. It should be wider than anything else, which
    // is what makes it recognisable at a glance.
    for (const family of FAMILIES.filter((f) => f !== 'station')) {
      expect(width('station')).toBeGreaterThan(width(family));
    }
  });

  it('gives a constellation satellite one array, off to a side', () => {
    // Starlink's defining asymmetry. Its geometry should not be centred on X.
    const [minX, maxX] = bounds('constellation');
    expect(Math.abs(maxX) - Math.abs(minX)).toBeGreaterThan(0.15);
  });

  it('keeps navigation and geostationary symmetric, because their arrays are', () => {
    for (const family of ['navigation', 'geoComms'] as SatelliteFamily[]) {
      const [minX, maxX] = bounds(family);
      expect(Math.abs(maxX + minX)).toBeLessThan(0.05);
    }
  });

  it('points dishes and instruments at the planet, not away from it', () => {
    // +Y is up in the model frame, so anything aimed at the ground extends
    // further below the body than above it. Getting this backwards would put
    // a weather satellite's camera looking at space.
    for (const family of ['navigation', 'observation', 'geoComms'] as SatelliteFamily[]) {
      const [, , minY, maxY] = bounds(family);
      expect(Math.abs(minY)).toBeGreaterThan(Math.abs(maxY));
    }
  });

  it('gives a probe no arrays, which is what makes it look like nothing else', () => {
    // Cluster II is a spin-stabilised drum. Its width comes from booms, so it
    // should be much wider than it is tall.
    const [minX, maxX, minY, maxY] = bounds('probe');
    expect(maxX - minX).toBeGreaterThan((maxY - minY) * 2);
  });

  it('draws the unidentified object as a marker, not a machine', () => {
    // The catalogue does not know what it is, so the geometry must not claim
    // one (D101, D102). A marker is roughly the same in all three axes; a
    // spacecraft is not.
    const [minX, maxX, minY, maxY, minZ, maxZ] = bounds('unidentified');
    const extents = [maxX - minX, maxY - minY, maxZ - minZ];
    expect(Math.max(...extents) / Math.min(...extents)).toBeLessThan(1.3);
  });

  it('gives every family a distinct silhouette width', () => {
    // If two families came out the same size the shapes would be decoration.
    const widths = FAMILIES.map((f) => Number(width(f).toFixed(3)));
    expect(new Set(widths).size).toBeGreaterThanOrEqual(FAMILIES.length - 1);
  });
});

describe('SPAN_METRES', () => {
  it('holds real sizes, with the station the largest', () => {
    // 109 m is the ISS truss; 9 m is a Starlink. At shell zoom the pixel floor
    // decides the drawn size, but these become right the moment you zoom in.
    expect(SPAN_METRES.station).toBeGreaterThan(SPAN_METRES.geoComms);
    expect(SPAN_METRES.geoComms).toBeGreaterThan(SPAN_METRES.constellation);
  });

  it('covers every family, so none falls back to a guess', () => {
    for (const family of FAMILIES) {
      expect(SPAN_METRES[family]).toBeGreaterThan(0);
    }
  });
});

describe('disposeSpacecraft', () => {
  it('lets the cache be rebuilt after release', () => {
    const before = spacecraftGeometryFor('probe');
    disposeSpacecraft();
    expect(spacecraftGeometryFor('probe')).not.toBe(before);
  });
});
