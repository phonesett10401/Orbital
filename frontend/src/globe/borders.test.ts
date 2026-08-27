/**
 * Tests for the country boundary layer.
 *
 * The load-bearing test here is the one about interpolation: borders are
 * densified in lon/lat, not along great circles, and the two differ by about
 * 100 km on a border like the 49th parallel. Both are correct interpolations
 * of something; only one is correct for a boundary defined as a line of
 * constant latitude. As in D42, the great-circle comparison is written out
 * here rather than imported from `route.ts`, so the test cannot agree with the
 * code by construction.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BORDER_ALTITUDE,
  MAX_SEGMENT_DEG,
  type BorderData,
  buildBorderPositions,
  createBorderLayer,
  densifyArc,
} from './borders';

const GLOBE_RADIUS = 100;

/** Great-circle interpolation, transcribed rather than imported. */
function slerpLatLon(
  a: [number, number],
  b: [number, number],
  t: number,
): [number, number] {
  const toXyz = ([lon, lat]: [number, number]) => {
    const phi = (lat * Math.PI) / 180;
    const lambda = (lon * Math.PI) / 180;
    return [
      Math.cos(phi) * Math.cos(lambda),
      Math.cos(phi) * Math.sin(lambda),
      Math.sin(phi),
    ];
  };
  const [ax, ay, az] = toXyz(a);
  const [bx, by, bz] = toXyz(b);
  const dot = Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz));
  const omega = Math.acos(dot);
  const sa = Math.sin((1 - t) * omega) / Math.sin(omega);
  const sb = Math.sin(t * omega) / Math.sin(omega);
  const x = ax * sa + bx * sb;
  const y = ay * sa + by * sb;
  const z = az * sa + bz * sb;
  return [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.asin(z / Math.hypot(x, y, z)) * 180) / Math.PI,
  ];
}

describe('densifyArc', () => {
  it('emits vertex pairs, as LineSegments consumes them', () => {
    const out = densifyArc([0, 0, 10, 0], 10);
    expect(out.length).toBe(4);
    expect(out).toEqual([0, 0, 10, 0]);
  });

  it('returns nothing for an arc with fewer than two points', () => {
    expect(densifyArc([1, 2])).toEqual([]);
    expect(densifyArc([])).toEqual([]);
  });

  it('subdivides a long segment to the step size', () => {
    const out = densifyArc([0, 0, 4, 0], 1);
    // Four one-degree steps, two vertices each.
    expect(out.length).toBe(4 * 4);
    expect(out.slice(0, 4)).toEqual([0, 0, 1, 0]);
    expect(out.slice(-4)).toEqual([3, 0, 4, 0]);
  });

  it('keeps the original endpoints exactly', () => {
    const out = densifyArc([-123.3, 49, -95.15, 49], MAX_SEGMENT_DEG);
    expect(out[0]).toBeCloseTo(-123.3, 6);
    expect(out[1]).toBeCloseTo(49, 6);
    expect(out[out.length - 2]).toBeCloseTo(-95.15, 6);
    expect(out[out.length - 1]).toBeCloseTo(49, 6);
  });

  it('holds a parallel, where a great circle would bow off it', () => {
    // The Canada/United States border west of the Lake of the Woods is the
    // 49th parallel. Natural Earth stores it as two points ~2,000 km apart.
    const from: [number, number] = [-123.3, 49];
    const to: [number, number] = [-95.15, 49];

    const out = densifyArc([...from, ...to], MAX_SEGMENT_DEG);
    for (let i = 1; i < out.length; i += 2) {
      expect(out[i]).toBeCloseTo(49, 9);
    }

    // And the alternative really is different: a great circle between the same
    // two points leaves the parallel by more than a tenth of a degree, about
    // 12 km, which would put the border visibly inside Canada.
    const [, midLat] = slerpLatLon(from, to, 0.5);
    expect(midLat - 49).toBeGreaterThan(0.1);
  });

  it('drops a segment that jumps the antimeridian', () => {
    expect(densifyArc([179.5, 10, -179.5, 10], 1)).toEqual([]);
    // ...but keeps an ordinary segment near the dateline.
    expect(densifyArc([178, 10, 179, 10], 1).length).toBe(4);
  });
});

describe('buildBorderPositions', () => {
  const data: BorderData = {
    resolution: 'test',
    arcs: [[0, 0, 30, 0], [10, 40, 10, 70]],
  };

  it('puts every vertex on the border shell', () => {
    const positions = buildBorderPositions(data, GLOBE_RADIUS);
    const shell = GLOBE_RADIUS * (1 + BORDER_ALTITUDE);
    expect(positions.length % 6).toBe(0); // whole segments, three floats each
    for (let i = 0; i < positions.length; i += 3) {
      const radius = Math.hypot(positions[i], positions[i + 1], positions[i + 2]);
      expect(radius).toBeCloseTo(shell, 4);
    }
  });

  it('never lets a segment sag into the planet', () => {
    // This is what the shell height buys, and why the step size and the
    // altitude are a pair rather than two independent numbers: the midpoint of
    // a straight chord between two shell points is closer to the centre than
    // either end.
    const positions = buildBorderPositions(data, GLOBE_RADIUS);
    for (let i = 0; i + 5 < positions.length; i += 6) {
      const midpoint = [
        (positions[i] + positions[i + 3]) / 2,
        (positions[i + 1] + positions[i + 4]) / 2,
        (positions[i + 2] + positions[i + 5]) / 2,
      ];
      expect(Math.hypot(...midpoint)).toBeGreaterThan(GLOBE_RADIUS);
    }
  });

  it('subdivides according to the step size', () => {
    const coarse = buildBorderPositions(data, GLOBE_RADIUS, 30);
    const fine = buildBorderPositions(data, GLOBE_RADIUS, 1);
    expect(fine.length).toBeGreaterThan(coarse.length * 10);
  });
});

describe('createBorderLayer', () => {
  it('starts empty and invisible, so the globe does not wait for it', () => {
    const layer = createBorderLayer(GLOBE_RADIUS);
    expect(layer.line.visible).toBe(false);
    expect(layer.vertexCount).toBe(0);
    layer.dispose();
  });

  it('draws once loaded, and reports what it drew', async () => {
    const layer = createBorderLayer(GLOBE_RADIUS);
    await layer.load(async () => ({ resolution: 'test', arcs: [[0, 0, 1, 0]] }));
    expect(layer.line.visible).toBe(true);
    expect(layer.vertexCount).toBe(2);
    expect(layer.line.geometry.getAttribute('position').count).toBe(2);
    layer.dispose();
  });

  it('stays hidden when asked to show nothing it has', () => {
    const layer = createBorderLayer(GLOBE_RADIUS);
    layer.setVisible(true);
    expect(layer.line.visible).toBe(false);
    layer.dispose();
  });

  it('is one object, so it is one draw call', async () => {
    const layer = createBorderLayer(GLOBE_RADIUS);
    await layer.load(async () => ({ resolution: 'test', arcs: [[0, 0, 1, 0], [2, 2, 3, 3]] }));
    expect(layer.line.children.length).toBe(0);
    expect(layer.line.type).toBe('LineSegments');
    layer.dispose();
  });
});

// ---- against the real generated data ---------------------------------------

// Vitest runs from the frontend root, and the generated file lives under it.
// Skipped rather than failed when absent: a fresh checkout has not run
// `npm run geography` yet, and a red suite there would be reporting on the
// build step, not on this code.
const bordersPath = join(process.cwd(), 'public', 'geo', 'borders.json');
const generated = existsSync(bordersPath);

describe.skipIf(!generated)('the generated borders.json', () => {
  const data = generated
    ? (JSON.parse(readFileSync(bordersPath, 'utf8')) as BorderData)
    : ({ resolution: '', arcs: [] } as BorderData);

  it('is the resolution the build script chose', () => {
    expect(data.resolution).toBe('110m');
  });

  it('holds arcs, not rings, so shared borders are stored once', () => {
    // 595 arcs for 177 countries is only possible because a boundary between
    // two of them is one arc. Rings would be several thousand.
    expect(data.arcs.length).toBeLessThan(1000);
    expect(data.arcs.length).toBeGreaterThan(400);
  });

  it('is all real coordinates', () => {
    for (const arc of data.arcs) {
      expect(arc.length % 2).toBe(0);
      for (let i = 0; i < arc.length; i += 2) {
        expect(Math.abs(arc[i])).toBeLessThanOrEqual(180);
        expect(Math.abs(arc[i + 1])).toBeLessThanOrEqual(90);
      }
    }
  });

  it('stays inside the vertex budget once densified', () => {
    // The whole layer is one buffer and one draw call, but it is still memory
    // and still vertex work every frame. Measured at 20,082 vertices, 235 KB
    // of positions; the ceiling here is a guard against a resolution change
    // being made without anyone noticing what it costs.
    const positions = buildBorderPositions(data, GLOBE_RADIUS);
    expect(positions.length / 3).toBeLessThan(30_000);
  });
});
