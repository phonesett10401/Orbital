/**
 * The solar system's own camera (D163).
 *
 * ## Why it has one at all
 *
 * Until now the solar system was drawn as a MapLibre custom layer, borrowing
 * the map's projection matrix, its camera, its far plane and its zoom. Nearly
 * every defect of the last several sessions traces to that borrowing:
 *
 * - the far plane sits **one globe radius past the centre at every zoom**, which
 *   is why the sky had to be centred on the camera to exist at all (D129);
 * - the globe/solar handover took six attempts (D139-D145);
 * - between the two views was a band where neither was worth looking at (D158);
 * - and dragging was a **turn, not a slide**, because the map's camera always
 *   looks at the centre of the world it is standing on - measured, 100 pixels of
 *   pan moved Jupiter 432 pixels and Neptune 435 the *other* way (D160).
 *
 * None of those are solar-system problems. They are all "this is not our
 * camera" problems, and the fix for all of them is the same one.
 *
 * ## What this is
 *
 * An orbit camera: a target it looks at, a distance it sits back at, and two
 * angles. Panning moves the **target**, which is a genuine translation - the
 * whole scene slides under the pointer at exactly the pointer's speed, which is
 * the thing the map's camera could not do at any damping.
 *
 * Kept as plain data with pure operations so the arithmetic can be tested
 * without a GPU, which is how `cameraFrame.ts` earned its keep on the other
 * side of the same problem.
 */

import { GLOBE_RADII_AT_NEPTUNE } from './solarScale';

export interface SolarCamera {
  /** The point the camera looks at, in globe radii. */
  target: [number, number, number];
  /** How far back it sits. */
  distance: number;
  /** Rotation about the vertical axis, radians. */
  yaw: number;
  /** Tilt above the ecliptic, radians. Clamped short of straight down. */
  pitch: number;
}

/** Vertical field of view, radians. */
export const FOV = (45 * Math.PI) / 180;

/**
 * Far enough back that Neptune's orbit fits with a little room.
 *
 * `r / tan(fov/2)` is the distance at which a radius exactly fills the height,
 * and the extra tenth keeps the outermost orbit off the edge of the frame.
 */
export const DEFAULT_DISTANCE = (GLOBE_RADII_AT_NEPTUNE * 1.1) / Math.tan(FOV / 2);

/** How close and how far the camera may get. */
export const MIN_DISTANCE = 1.5;
export const MAX_DISTANCE = DEFAULT_DISTANCE * 3;

/**
 * Looking slightly down on the ecliptic, which is what makes it read as a
 * system of rings rather than a line of dots.
 */
export const DEFAULT_PITCH = (28 * Math.PI) / 180;

/** Never straight down, where the yaw becomes meaningless and the view flips. */
export const MAX_PITCH = (89 * Math.PI) / 180;

export function initialCamera(): SolarCamera {
  return {
    target: [0, 0, 0],
    distance: DEFAULT_DISTANCE,
    yaw: 0,
    pitch: DEFAULT_PITCH,
  };
}

/** Where the camera sits, from its target and angles. */
export function cameraPosition(camera: SolarCamera): [number, number, number] {
  const { target, distance, yaw, pitch } = camera;
  const horizontal = Math.cos(pitch) * distance;
  return [
    target[0] + horizontal * Math.sin(yaw),
    target[1] + Math.sin(pitch) * distance,
    target[2] + horizontal * Math.cos(yaw),
  ];
}

/**
 * How many world units one screen pixel covers at the target's depth.
 *
 * This is the whole of the 1:1 drag: the visible height at the target is
 * `2 * distance * tan(fov/2)`, so dividing by the viewport's height in pixels
 * gives the world distance a pixel is worth. Move the target by that much per
 * pixel dragged and the scene tracks the pointer exactly.
 */
export function worldPerPixel(camera: SolarCamera, viewportHeight: number): number {
  if (viewportHeight <= 0) return 0;
  return (2 * camera.distance * Math.tan(FOV / 2)) / viewportHeight;
}

/**
 * Slide the scene under the pointer.
 *
 * The target moves in the camera's own right and up directions, so a drag feels
 * the same whatever the yaw is - dragging right always sends the scene right.
 */
export function pan(
  camera: SolarCamera,
  dxPixels: number,
  dyPixels: number,
  viewportHeight: number,
): SolarCamera {
  const scale = worldPerPixel(camera, viewportHeight);
  // Right is perpendicular to the view direction in the horizontal plane.
  const rightX = Math.cos(camera.yaw);
  const rightZ = -Math.sin(camera.yaw);
  // Up in screen terms leans with the pitch: at a shallow angle a vertical drag
  // is mostly across the ecliptic, and looking straight down it is entirely so.
  const upY = Math.cos(camera.pitch);
  const upX = -Math.sin(camera.pitch) * Math.sin(camera.yaw);
  const upZ = -Math.sin(camera.pitch) * Math.cos(camera.yaw);
  return {
    ...camera,
    target: [
      camera.target[0] - (dxPixels * rightX + dyPixels * upX) * scale,
      camera.target[1] - dyPixels * upY * scale,
      camera.target[2] - (dxPixels * rightZ + dyPixels * upZ) * scale,
    ],
  };
}

/**
 * Move in or out by a factor, clamped.
 *
 * Multiplicative rather than additive, so a notch of the wheel covers the same
 * *proportion* of the remaining distance wherever you are - which is what makes
 * zooming feel even across a scene eighteen globe radii wide.
 */
export function zoom(camera: SolarCamera, factor: number): SolarCamera {
  const wanted = camera.distance * factor;
  return {
    ...camera,
    distance: Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, wanted)),
  };
}

/**
 * The zoom factor for a pinch that changed the gap between two fingers.
 *
 * Expressed as a ratio rather than a delta for the same reason the wheel is
 * (see `zoom`): the same finger movement should cover the same *proportion* of
 * the remaining distance whether you are looking at Mercury or at Neptune.
 *
 * Spreading the fingers (`to > from`) returns a factor below 1, which `zoom`
 * turns into a smaller distance - the scene comes closer, which is what
 * spreading means everywhere else on a touch screen.
 *
 * A gap of zero is not a pinch, it is two fingers in the same place or a
 * measurement taken before the second one moved, and dividing by it would send
 * the camera to infinity.
 */
export function pinchFactor(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return 1;
  return from / to;
}

/** Turn the camera around the scene. */
export function orbit(camera: SolarCamera, dYaw: number, dPitch: number): SolarCamera {
  return {
    ...camera,
    yaw: camera.yaw + dYaw,
    pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, camera.pitch + dPitch)),
  };
}
