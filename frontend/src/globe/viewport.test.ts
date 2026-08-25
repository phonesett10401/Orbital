/**
 * Tests for camera-to-bounding-box conversion.
 *
 * This box does two jobs: it filters the response, and it tells the backend
 * where to spend its fast tier 2 credits. Getting it too small means aircraft
 * missing from the edge of the screen; getting it wrong near the poles means
 * the same. Over-covering is the safe direction, and these tests pin that
 * direction down.
 */

import { describe, expect, it } from 'vitest';

import { bboxChanged, viewportBBox, visibleAngularRadius } from './viewport';

describe('visibleAngularRadius', () => {
  it('grows as the camera pulls back', () => {
    const close = visibleAngularRadius(0.2);
    const far = visibleAngularRadius(2.5);
    expect(far).toBeGreaterThan(close);
  });

  it('approaches ninety degrees at great height but never reaches it', () => {
    // You can never see a full hemisphere from a finite distance.
    expect(visibleAngularRadius(1000)).toBeLessThan(90);
    expect(visibleAngularRadius(1000)).toBeGreaterThan(85);
  });

  it('is near zero at the surface', () => {
    expect(visibleAngularRadius(0.0001)).toBeLessThan(2);
  });

  it('does not divide by zero at altitude zero', () => {
    expect(Number.isFinite(visibleAngularRadius(0))).toBe(true);
  });
});

describe('viewportBBox', () => {
  it('brackets the camera target', () => {
    const box = viewportBBox({ lat: 40, lng: -74, altitude: 0.3 })!;
    expect(box.latMin).toBeLessThan(40);
    expect(box.latMax).toBeGreaterThan(40);
    expect(box.lonMin).toBeLessThan(-74);
    expect(box.lonMax).toBeGreaterThan(-74);
  });

  it('returns null when zoomed far enough out to see most of the globe', () => {
    // At that zoom a box is meaningless and the tier 2 poll would be skipped.
    expect(viewportBBox({ lat: 0, lng: 0, altitude: 4 })).toBeNull();
  });

  it('widens in longitude as latitude increases', () => {
    // Meridians converge toward the poles, so a cap of fixed angular radius
    // spans more longitude the further north it sits.
    const equator = viewportBBox({ lat: 0, lng: 0, altitude: 0.3 })!;
    const northern = viewportBBox({ lat: 60, lng: 0, altitude: 0.3 })!;
    expect(northern.lonMax - northern.lonMin).toBeGreaterThan(
      equator.lonMax - equator.lonMin,
    );
  });

  it('covers all longitudes near the pole', () => {
    // Every meridian is visible from directly above a pole; a narrow box there
    // would hide most of what is on screen.
    const box = viewportBBox({ lat: 89.5, lng: 0, altitude: 0.3 })!;
    expect(box.lonMin).toBe(-180);
    expect(box.lonMax).toBe(180);
  });

  it('clamps latitude to the valid range', () => {
    const box = viewportBBox({ lat: 88, lng: 0, altitude: 0.5 })!;
    expect(box.latMax).toBeLessThanOrEqual(90);
    expect(box.latMin).toBeGreaterThanOrEqual(-90);
  });

  it('produces a wrapping box near the antimeridian', () => {
    // lonMin > lonMax is how the backend expresses a box across the dateline.
    const box = viewportBBox({ lat: 0, lng: 178, altitude: 0.2 })!;
    expect(box.lonMin).toBeGreaterThan(box.lonMax);
  });

  it('keeps longitudes inside the valid range', () => {
    for (const lng of [-180, -90, 0, 90, 179.9]) {
      const box = viewportBBox({ lat: 20, lng, altitude: 0.25 })!;
      expect(box.lonMin).toBeGreaterThanOrEqual(-180);
      expect(box.lonMax).toBeLessThanOrEqual(180);
    }
  });
});

describe('bboxChanged', () => {
  const box = { latMin: 30, lonMin: -100, latMax: 50, lonMax: -80 };

  it('ignores movement below the threshold', () => {
    // Without this, every frame of a camera drag would fire a request.
    expect(bboxChanged(box, { ...box, latMin: 30.4 })).toBe(false);
  });

  it('reports movement above the threshold', () => {
    expect(bboxChanged(box, { ...box, latMin: 33 })).toBe(true);
  });

  it('treats appearing and disappearing as a change', () => {
    expect(bboxChanged(null, box)).toBe(true);
    expect(bboxChanged(box, null)).toBe(true);
    expect(bboxChanged(null, null)).toBe(false);
  });
});
