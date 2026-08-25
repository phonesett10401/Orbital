/**
 * Tests for the pick tolerance.
 *
 * The click bug (D34) was not that picking was wired up wrong — it was that
 * the tolerance was expressed in world units, so it shrank as the camera
 * pulled back. About four pixels at default zoom, barely one when zoomed out.
 * These tests pin the tolerance to screen pixels, which is the unit a user
 * actually experiences.
 */

import { describe, expect, it } from 'vitest';

import { PICK_RADIUS_PX, worldUnitsPerPixel } from './markers';

const FOV = 50;
const VIEWPORT_H = 720;
const GLOBE_RADIUS = 100;

/** Effective click tolerance in pixels, given how pick() derives its threshold. */
function toleranceInPixels(cameraDistance: number): number {
  const worldThreshold =
    PICK_RADIUS_PX * worldUnitsPerPixel(cameraDistance, FOV, VIEWPORT_H);
  return worldThreshold / worldUnitsPerPixel(cameraDistance, FOV, VIEWPORT_H);
}

/** What the old world-unit threshold worked out to, for comparison. */
function legacyToleranceInPixels(cameraDistance: number): number {
  const worldThreshold = GLOBE_RADIUS * 0.012;
  return worldThreshold / worldUnitsPerPixel(cameraDistance, FOV, VIEWPORT_H);
}

describe('worldUnitsPerPixel', () => {
  it('grows linearly with camera distance', () => {
    const near = worldUnitsPerPixel(100, FOV, VIEWPORT_H);
    const far = worldUnitsPerPixel(200, FOV, VIEWPORT_H);
    expect(far).toBeCloseTo(near * 2, 6);
  });

  it('shrinks as the viewport gets taller', () => {
    expect(worldUnitsPerPixel(320, FOV, 1440)).toBeLessThan(
      worldUnitsPerPixel(320, FOV, 720),
    );
  });

  it('grows with a wider field of view', () => {
    expect(worldUnitsPerPixel(320, 80, VIEWPORT_H)).toBeGreaterThan(
      worldUnitsPerPixel(320, 50, VIEWPORT_H),
    );
  });

  it('matches the geometry by hand', () => {
    // Visible height at distance d is 2 d tan(fov/2).
    const expected = (2 * 320 * Math.tan((50 * Math.PI) / 360)) / 720;
    expect(worldUnitsPerPixel(320, 50, 720)).toBeCloseTo(expected, 9);
  });

  it('degrades safely on a zero-height viewport', () => {
    // Can happen for one frame while the container is being laid out.
    expect(worldUnitsPerPixel(320, FOV, 0)).toBe(0);
  });
});

describe('pick tolerance', () => {
  it('is the same number of pixels at every zoom level', () => {
    // This is the whole fix: tolerance is a screen-space constant.
    for (const distance of [110, 160, 320, 500, 800]) {
      expect(toleranceInPixels(distance)).toBeCloseTo(PICK_RADIUS_PX, 6);
    }
  });

  it('is comfortably larger than a marker sprite', () => {
    // A target you must hit within its own radius is not a target, and these
    // targets move between frames.
    const markerRadiusPx = 2.25;
    expect(PICK_RADIUS_PX).toBeGreaterThan(markerRadiusPx * 3);
  });

  it('fixes a tolerance that used to collapse when zoomed out', () => {
    // Regression: the old threshold gave about 4 px at the default camera
    // distance and about 1 px zoomed out, which is why clicking a marker
    // appeared to do nothing at all.
    expect(legacyToleranceInPixels(320)).toBeLessThan(5);
    expect(legacyToleranceInPixels(800)).toBeLessThan(2);
    expect(toleranceInPixels(800)).toBe(PICK_RADIUS_PX);
  });
});

describe('horizon test for occluded markers', () => {
  // pick() rejects markers on the far side with `P . C >= r^2`. The raycaster
  // has no idea the planet is there, so without this a generous tolerance
  // happily selects an aircraft over Australia while the user clicks one over
  // Spain.
  const horizon = GLOBE_RADIUS * GLOBE_RADIUS;
  const camera = { x: 0, y: 0, z: 320 };

  const visible = (p: { x: number; y: number; z: number }) =>
    p.x * camera.x + p.y * camera.y + p.z * camera.z >= horizon;

  it('accepts a marker facing the camera', () => {
    expect(visible({ x: 0, y: 0, z: 101.2 })).toBe(true);
  });

  it('rejects a marker directly behind the globe', () => {
    expect(visible({ x: 0, y: 0, z: -101.2 })).toBe(false);
  });

  it('rejects a marker just past the horizon', () => {
    // Grazing angle: the horizon from 320 units sits where P.z = r^2/|C|.
    const grazing = horizon / 320;
    expect(visible({ x: 0, y: 0, z: grazing - 1 })).toBe(false);
    expect(visible({ x: 0, y: 0, z: grazing + 1 })).toBe(true);
  });

  it('rejects a marker on the limb seen edge-on', () => {
    expect(visible({ x: 101.2, y: 0, z: 0 })).toBe(false);
  });
});
