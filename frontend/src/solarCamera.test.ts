import { describe, expect, it } from 'vitest';

import { GLOBE_RADII_AT_NEPTUNE } from './solarScale';
import {
  DEFAULT_DISTANCE,
  FOV,
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  cameraPosition,
  initialCamera,
  orbit,
  pan,
  pinchFactor,
  worldPerPixel,
  zoom,
} from './solarCamera';

const HEIGHT = 800;

describe('where it starts', () => {
  it('sits back far enough for Neptune to fit', () => {
    // The whole system has to be on screen the moment the page opens, or the
    // first thing the reader does is hunt for it.
    const halfHeight = Math.tan(FOV / 2) * DEFAULT_DISTANCE;
    expect(halfHeight).toBeGreaterThan(GLOBE_RADII_AT_NEPTUNE);
  });

  it('looks slightly down, so the orbits read as rings', () => {
    // Edge on, a solar system is a line of dots.
    const start = initialCamera();
    expect(start.pitch).toBeGreaterThan(0.2);
    expect(start.pitch).toBeLessThan(MAX_PITCH);
  });

  it('starts centred on the Sun', () => {
    expect(initialCamera().target).toEqual([0, 0, 0]);
  });
});

describe('where the camera actually is', () => {
  it('stands off the target by exactly its distance', () => {
    const c = { ...initialCamera(), yaw: 0.7, pitch: 0.3, distance: 12 };
    const p = cameraPosition(c);
    const away = Math.hypot(p[0] - c.target[0], p[1] - c.target[1], p[2] - c.target[2]);
    expect(away).toBeCloseTo(12, 9);
  });

  it('is above the ecliptic when the pitch is positive', () => {
    expect(cameraPosition({ ...initialCamera(), pitch: 0.5 })[1]).toBeGreaterThan(0);
  });

  it('follows the target when the target moves', () => {
    const moved = { ...initialCamera(), target: [5, 0, -3] as [number, number, number] };
    const p = cameraPosition(moved);
    expect(p[0]).toBeCloseTo(5, 9);
    expect(p[2]).toBeCloseTo(-3 + cameraPosition(initialCamera())[2], 9);
  });
});

describe('dragging the scene', () => {
  it('moves the world exactly one pixel per pixel', () => {
    // **The thing the map's camera could not do at any damping.** Panning there
    // rotated the viewpoint, so bodies moved at different rates and some moved
    // the opposite way (D160). Here the scene slides with the pointer.
    const c = initialCamera();
    const perPixel = worldPerPixel(c, HEIGHT);
    const dragged = pan(c, 100, 0, HEIGHT);
    const moved = Math.hypot(
      dragged.target[0] - c.target[0],
      dragged.target[1] - c.target[1],
      dragged.target[2] - c.target[2],
    );
    expect(moved).toBeCloseTo(100 * perPixel, 9);
  });

  it('sends the scene the way the hand went, whatever the yaw', () => {
    // Dragging right always sends the scene right, which is what "the same
    // gesture means the same thing" costs: the target moves in the camera's own
    // frame rather than the world's.
    for (const yaw of [0, 1, 2, 4, 6]) {
      const c = { ...initialCamera(), yaw };
      const dragged = pan(c, 100, 0, HEIGHT);
      const before = cameraPosition(c);
      const after = cameraPosition(dragged);
      // The camera's right vector, and the movement projected onto it.
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const along = (after[0] - before[0]) * rightX + (after[2] - before[2]) * rightZ;
      expect(along, `yaw ${yaw}`).toBeLessThan(0);
    }
  });

  it('scales with the distance, so it tracks at any zoom', () => {
    // A fixed world-per-pixel would make the scene crawl when zoomed out and
    // fly when zoomed in.
    const near = worldPerPixel({ ...initialCamera(), distance: 10 }, HEIGHT);
    const far = worldPerPixel({ ...initialCamera(), distance: 100 }, HEIGHT);
    expect(far / near).toBeCloseTo(10, 6);
  });

  it('is not fooled by a viewport with no height', () => {
    // Measured before the first frame, a canvas is zero by zero, and dividing
    // by it puts the target at infinity - from which nothing ever comes back.
    expect(worldPerPixel(initialCamera(), 0)).toBe(0);
    expect(pan(initialCamera(), 50, 50, 0).target).toEqual([0, 0, 0]);
  });
});

describe('zooming', () => {
  it('moves by a proportion, not a fixed step', () => {
    // A notch covers the same share of the remaining distance wherever you
    // are, which is what makes it even across a scene eighteen radii wide.
    expect(zoom({ ...initialCamera(), distance: 40 }, 0.5).distance).toBeCloseTo(20, 9);
    expect(zoom({ ...initialCamera(), distance: 10 }, 0.5).distance).toBeCloseTo(5, 9);
  });

  it('stops before the camera reaches the middle of the Sun', () => {
    let c = initialCamera();
    for (let i = 0; i < 60; i += 1) c = zoom(c, 0.7);
    expect(c.distance).toBe(MIN_DISTANCE);
  });

  it('stops before the system becomes a speck', () => {
    let c = initialCamera();
    for (let i = 0; i < 60; i += 1) c = zoom(c, 1.4);
    expect(c.distance).toBe(MAX_DISTANCE);
  });
});

describe('turning around it', () => {
  it('never tips past straight down', () => {
    // At the pole the yaw stops meaning anything and the view flips.
    expect(orbit(initialCamera(), 0, 9).pitch).toBe(MAX_PITCH);
    expect(orbit(initialCamera(), 0, -9).pitch).toBe(-MAX_PITCH);
  });

  it('turns freely about the vertical', () => {
    expect(orbit(initialCamera(), 3, 0).yaw).toBeCloseTo(3, 9);
  });

  it('keeps the distance while turning', () => {
    const c = orbit({ ...initialCamera(), distance: 33 }, 1, 0.2);
    expect(c.distance).toBe(33);
    expect(MIN_DISTANCE).toBeLessThan(MAX_DISTANCE);
  });
});

describe('pinchFactor', () => {
  it('brings the scene closer when the fingers spread', () => {
    // Spreading means "closer" on every touch screen, and closer here is a
    // smaller distance - so the factor has to be below 1.
    expect(pinchFactor(100, 200)).toBeLessThan(1);
  });

  it('pushes it away when they close', () => {
    expect(pinchFactor(200, 100)).toBeGreaterThan(1);
  });

  it('covers the same proportion whatever the scale', () => {
    // The whole reason this is a ratio: doubling the gap has to mean the same
    // thing at Mercury and at Neptune.
    expect(pinchFactor(50, 100)).toBeCloseTo(pinchFactor(400, 800), 10);
  });

  it('does nothing when the gap is not a real measurement', () => {
    // Two fingers in the same place, or a reading taken before the second one
    // moved. Dividing by it would send the camera to infinity.
    for (const [a, b] of [[0, 100], [100, 0], [-5, 100], [Number.NaN, 100]]) {
      expect(pinchFactor(a, b)).toBe(1);
    }
  });
});
