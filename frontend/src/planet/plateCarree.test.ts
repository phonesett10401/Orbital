import { describe, expect, it } from 'vitest';

import {
  MERCATOR_LIMIT_DEG,
  MOSAICS,
  type Mosaic,
  type TrekMosaic,
  TILE,
  coversTile,
  gridSize,
  latToY,
  lonToX,
  parseTileUrl,
  planStitch,
  rowSource,
  sourceLevel,
  sourceTileUrl,
  tileLat,
  tileLonSpan,
} from './plateCarree';

/** A full-coverage mosaic, so tests about geometry are not tests about Venus. */
const WHOLE: Mosaic = {
  from: 'trek',
  world: 'Test',
  layer: 'Test_Global',
  format: 'png',
  maxLevel: 6,
  lonOrigin: -180,
  south: -90,
  north: 90,
};

describe('Mercator geometry', () => {
  it('puts the top of the world at the projection limit, not at the pole', () => {
    // The whole reason a mosaic can never show its own poles here.
    expect(tileLat(0, 0, 0)).toBeCloseTo(MERCATOR_LIMIT_DEG, 6);
    expect(tileLat(0, 0, 1)).toBeCloseTo(-MERCATOR_LIMIT_DEG, 6);
  });

  it('crosses the equator exactly halfway down the world', () => {
    expect(tileLat(0, 0, 0.5)).toBeCloseTo(0, 9);
    expect(tileLat(1, 1, 0)).toBeCloseTo(0, 9);
  });

  it('spaces latitude unevenly, which is the thing being corrected for', () => {
    // Mercator's rows are not equal in degrees, and the direction matters:
    // near the pole a row of tiles covers FEWER degrees, because the
    // projection has stretched those degrees over more pixels. If they were
    // equal, no reprojection would be needed and this module would not exist.
    const polar = tileLat(2, 0, 0) - tileLat(2, 0, 1);
    const equator = tileLat(2, 1, 0) - tileLat(2, 1, 1);
    expect(polar).toBeLessThan(equator / 3);
  });

  it('divides longitude evenly, which is why only one axis is warped', () => {
    expect(tileLonSpan(0, 0)).toEqual({ west: -180, east: 180 });
    expect(tileLonSpan(2, 0).west).toBe(-180);
    expect(tileLonSpan(2, 3).east).toBe(180);
    const a = tileLonSpan(3, 2);
    const b = tileLonSpan(3, 5);
    expect(a.east - a.west).toBeCloseTo(b.east - b.west, 12);
  });
});

describe('choosing the source level', () => {
  it('matches the horizontal scale exactly', () => {
    // Level L is 2^(L+1) tiles across 360 degrees; Mercator z is 2^z. The
    // match is L = z - 1, and the assertion is that the pixel sizes agree.
    for (const z of [2, 5, 8]) {
      const level = sourceLevel(z, { ...WHOLE, maxLevel: 12 });
      const sourceDegPerPx = 360 / gridSize(WHOLE, level).width;
      const destDegPerPx = 360 / (Math.pow(2, z) * TILE);
      expect(sourceDegPerPx).toBeCloseTo(destDegPerPx, 12);
    }
  });

  it('never asks for a level the mosaic does not have', () => {
    expect(sourceLevel(14, WHOLE)).toBe(6);
    expect(sourceLevel(0, WHOLE)).toBe(0);
  });
});

describe('placing a coordinate in the grid', () => {
  it('maps the corners of a -180 grid to the corners of its pixels', () => {
    const { width, height } = gridSize(WHOLE, 3);
    expect(lonToX(-180, WHOLE, 3)).toBeCloseTo(0, 9);
    expect(lonToX(0, WHOLE, 3)).toBeCloseTo(width / 2, 9);
    expect(latToY(90, WHOLE, 3)).toBeCloseTo(0, 9);
    expect(latToY(-90, WHOLE, 3)).toBeCloseTo(height, 9);
    expect(latToY(0, WHOLE, 3)).toBeCloseTo(height / 2, 9);
  });

  it('turns the grid for a mosaic that starts at zero', () => {
    // Titan and Enceladus are published 0..360. Reading them as -180..180
    // does not fail, it quietly serves the far side of the world.
    const turned: Mosaic = { ...WHOLE, lonOrigin: 0 };
    const { width } = gridSize(turned, 2);
    expect(lonToX(0, turned, 2)).toBeCloseTo(0, 9);
    expect(lonToX(-90, turned, 2)).toBeCloseTo((270 / 360) * width, 9);
    expect(lonToX(179, turned, 2)).toBeCloseTo((179 / 360) * width, 9);
  });
});

describe('the tile address', () => {
  it('puts row before column, the way Trek does', () => {
    const url = sourceTileUrl(MOSAICS.venus as TrekMosaic, 4, 9, 21);
    expect(url).toContain('/default028mm/4/9/21.png');
    expect(url).toContain('/Venus/EQ/');
  });

  it('reads a pc url and refuses anything else', () => {
    expect(parseTileUrl('pc://venus/5/12/9')).toEqual({ key: 'venus', z: 5, x: 12, y: 9 });
    expect(parseTileUrl('pc://Venus/5/12/9.png')?.key).toBe('venus');
    expect(parseTileUrl('https://example.test/5/12/9')).toBeNull();
    expect(parseTileUrl('pc://venus/5/12')).toBeNull();
  });
});

describe('what the mosaic does not cover', () => {
  /**
   * A mosaic that stops short of both poles, which is the shape of every
   * spacecraft that mapped from a polar orbit and did not fill the caps.
   *
   * Synthetic on purpose. This used to be Venus, whose left-look plate stopped
   * at 84 north - and when Venus moved to a mosaic that does reach the poles,
   * three tests about *geometry* failed because they were really tests about a
   * product (D194).
   */
  const CAPLESS: Mosaic = { ...WHOLE, south: -80, north: 84 };

  it('declines a tile entirely above or below the imagery', () => {
    // The top tile of z2 runs 85.05 down to 66.5, so it is partly covered; a
    // z6 tile up at the cap is not covered at all.
    expect(coversTile(CAPLESS, 2, 0)).toBe(true);
    expect(coversTile(CAPLESS, 6, 0)).toBe(false);
    expect(planStitch(CAPLESS, 6, 0, 0)).toBeNull();
  });

  it('leaves rows above the imagery transparent rather than smearing one', () => {
    const plan = planStitch(CAPLESS, 2, 0, 0);
    expect(plan).not.toBeNull();
    // Row 0 of this tile sits at 85 north, above the mosaic's 84.
    expect(rowSource(CAPLESS, 2, 0, 0, plan!)).toBeNull();
    // A row well inside the coverage reads real pixels.
    const inside = rowSource(CAPLESS, 2, 0, 200, plan!);
    expect(inside).not.toBeNull();
    expect(inside!.height).toBeGreaterThan(0);
  });

  it('covers every row when the mosaic reaches both poles', () => {
    // Which is what Venus now is, and the reason the three tests above had to
    // stop being about Venus.
    const plan = planStitch(MOSAICS.venus, 2, 0, 0);
    expect(plan).not.toBeNull();
    expect(rowSource(MOSAICS.venus, 2, 0, 0, plan!)).not.toBeNull();
  });
});

describe('stitching the source tiles', () => {
  it('reads the whole grid for the single tile at z0', () => {
    const plan = planStitch(WHOLE, 0, 0, 0);
    expect(plan).not.toBeNull();
    expect(plan!.level).toBe(0);
    // z0 asks for the entire world, and at level 0 that is both tiles.
    expect(plan!.patches.map((p) => p.col).sort()).toEqual([0, 1]);
  });

  it('carries the seam round instead of folding the world into one tile', () => {
    // A mosaic published 0..360 puts its join in the middle of the Mercator
    // tile that spans -180..180, so the right edge lands left of the left one.
    const turned: Mosaic = { ...WHOLE, lonOrigin: 0 };
    const plan = planStitch(turned, 0, 0, 0);
    expect(plan).not.toBeNull();
    expect(plan!.width).toBe(gridSize(turned, 0).width);
    expect(plan!.patches).toHaveLength(2);
    // Both grid columns are read, and the one that wrapped is placed second.
    expect(plan!.patches.map((p) => p.col)).toEqual([1, 0]);
    expect(plan!.patches[1].dx).toBeGreaterThan(plan!.patches[0].dx);
  });

  it('asks for one source tile per destination tile away from the seam', () => {
    const plan = planStitch(WHOLE, 5, 9, 15);
    expect(plan).not.toBeNull();
    expect(plan!.patches.length).toBeLessThanOrEqual(4);
    expect(plan!.width).toBeGreaterThanOrEqual(TILE);
  });

  it('stretches the latitude axis, which is the point of the whole module', () => {
    // A tile at the top of the world fills its 256 rows from a much SHORTER
    // strip of source pixels than a tile on the equator does, because that is
    // what Mercator's stretch means undone. Equal strips would mean the
    // reprojection was doing nothing at all.
    const polar = planStitch(WHOLE, 3, 0, 0)!;
    const equator = planStitch(WHOLE, 3, 0, 4)!;
    expect(polar.height).toBeLessThan(equator.height / 3);
    expect(polar.height).toBeGreaterThan(0);
  });

  it('reads every source row it claims to, with no gaps between slices', () => {
    const plan = planStitch(WHOLE, 4, 5, 6)!;
    let previous = 0;
    for (let row = 0; row < TILE; row++) {
      const slice = rowSource(WHOLE, 4, 6, row, plan);
      expect(slice).not.toBeNull();
      expect(slice!.top).toBeCloseTo(previous, 6);
      previous = slice!.top + slice!.height;
    }
    expect(previous).toBeCloseTo(plan.height, 0);
  });
});
