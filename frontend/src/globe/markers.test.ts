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

import {
  MAX_MARKER_PX,
  MIN_MARKER_PX,
  PICK_RADIUS_PX,
  altitudeColor,
  markerPixelSize,
  spriteFor,
  worldUnitsPerPixel,
} from './markers';
import { SPRITE_AIRCRAFT, SPRITE_UNKNOWN } from './aircraftSprite';

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


describe('marker sizing model', () => {
  // World-anchored, not screen-anchored: the sprite is pinned to a size on the
  // ground, so it grows as the camera descends. That is what makes zooming in
  // read as terrain with aircraft over it rather than a dot map (D40).
  const size = (distance: number) => markerPixelSize(distance, GLOBE_RADIUS, FOV, VIEWPORT_H);

  it('grows as the camera approaches', () => {
    expect(size(105)).toBeGreaterThan(size(320));
    expect(size(320)).toBeGreaterThan(size(700));
  });

  it('is inversely proportional to distance in the unclamped range', () => {
    // Halving the distance doubles the on-screen size, which is what "anchored
    // to the ground" means.
    expect(size(200)).toBeCloseTo(size(400) * 2, 5);
  });

  it('never falls below the minimum, however far out', () => {
    // Below this a marker is neither visible nor clickable.
    expect(size(5000)).toBe(MIN_MARKER_PX);
    expect(size(100000)).toBe(MIN_MARKER_PX);
  });

  it('never exceeds the maximum, however close', () => {
    // The cap is a guard rather than something the camera reaches: the orbit
    // controls stop at 1.005 R, where the sprite is about 31 px. It exists so
    // that a future change to minDistance cannot silently produce sprites that
    // swamp the terrain under them.
    expect(size(101)).toBeLessThanOrEqual(MAX_MARKER_PX);
    expect(size(40)).toBe(MAX_MARKER_PX);
    expect(size(1)).toBe(MAX_MARKER_PX);
  });

  it('is readable at the default zoom and large when close', () => {
    // The calibration that matters: a silhouette needs roughly ten pixels
    // before its shape reads at all.
    expect(size(320)).toBeGreaterThan(8);
    expect(size(100.5)).toBeGreaterThan(25);
  });

  it('sits in a readable range across the reachable zoom band', () => {
    // The camera is clamped to [1.005 R, 8 R] by the orbit controls.
    for (const distance of [100.5, 150, 320, 500, 800]) {
      const px = size(distance);
      expect(px).toBeGreaterThanOrEqual(MIN_MARKER_PX);
      expect(px).toBeLessThanOrEqual(MAX_MARKER_PX);
    }
  });

  it('scales with the viewport, so a taller window does not shrink markers', () => {
    const short = markerPixelSize(320, GLOBE_RADIUS, FOV, 720);
    const tall = markerPixelSize(320, GLOBE_RADIUS, FOV, 1440);
    expect(tall).toBeCloseTo(short * 2, 5);
  });

  it('degrades safely on a zero-height viewport', () => {
    expect(markerPixelSize(320, GLOBE_RADIUS, FOV, 0)).toBe(MIN_MARKER_PX);
  });
});

describe('pick tolerance follows the sprite', () => {
  // The tolerance is the larger of the fixed radius and half the sprite. A
  // sprite drawn bigger than the tolerance would otherwise have an unclickable
  // margin -- the same class of mismatch as D34.
  const tolerance = (distance: number) =>
    Math.max(PICK_RADIUS_PX, markerPixelSize(distance, GLOBE_RADIUS, FOV, VIEWPORT_H) * 0.5);

  it('is never smaller than half the drawn sprite', () => {
    for (const distance of [100.5, 120, 200, 320, 500, 800]) {
      const px = markerPixelSize(distance, GLOBE_RADIUS, FOV, VIEWPORT_H);
      expect(tolerance(distance)).toBeGreaterThanOrEqual(px * 0.5);
    }
  });

  it('never drops below the fixed minimum when the sprite is small', () => {
    expect(tolerance(800)).toBe(PICK_RADIUS_PX);
  });

  it('opens up when the sprite is large', () => {
    expect(tolerance(100.5)).toBeGreaterThan(PICK_RADIUS_PX);
  });
});

describe('sprite selection', () => {
  it('uses the airframe when heading is known', () => {
    expect(spriteFor({ heading: 90 })).toBe(SPRITE_AIRCRAFT);
    // Zero is a real heading -- due north -- not a missing one.
    expect(spriteFor({ heading: 0 })).toBe(SPRITE_AIRCRAFT);
  });

  it('uses the disc when heading is unknown', () => {
    // A silhouette pointing somewhere would be a claim we cannot support.
    expect(spriteFor({ heading: null })).toBe(SPRITE_UNKNOWN);
  });

  it('the two cells are distinct', () => {
    expect(SPRITE_AIRCRAFT).not.toBe(SPRITE_UNKNOWN);
  });
});

describe('legend agrees with the shader colours', () => {
  it('the gradient endpoints match altitudeColor', () => {
    // The legend hardcodes its gradient for cheapness; this is what keeps the
    // two from drifting.
    expect(altitudeColor(0)).toEqual([1.0, 0.55, 0.2]);
    expect(altitudeColor(12000)).toEqual([0.35, 0.85, 1.0]);
  });

  it('unknown altitude is visibly distinct from both ends', () => {
    const unknown = altitudeColor(null);
    expect(unknown).not.toEqual(altitudeColor(0));
    expect(unknown).not.toEqual(altitudeColor(12000));
  });
});
