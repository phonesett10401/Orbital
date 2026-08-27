/**
 * Tests for the selected-aircraft model.
 *
 * There is no GL context under vitest, so nothing here renders. What it can
 * test is everything that decides *where the model goes and which way it
 * points* — which is where this class of feature actually goes wrong. The
 * project's own history says so: markers were drawn tail-first for a while
 * because a rotation that was perfect had its direction reversed by a texture
 * flip, and the globe was lit in the wrong coordinate frame for two milestones
 * because a view-space normal and a world-space sun vector were each correct
 * on their own.
 *
 * So the load-bearing test here is the one that pins the model's tangent frame
 * to the *same* frame the marker vertex shader uses. If those two ever drift
 * apart, a selected aircraft snaps to a different heading at the moment it is
 * clicked, and no amount of looking at one of them in isolation would show it.
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { RenderableObject } from '../types';
import { latLonToVector3 } from './earth';
import { MARKER_ALTITUDE, MARKER_WORLD_SIZE, SELECTED_SIZE_MULTIPLIER } from './markers';
import {
  MODEL_MAX_PX,
  MODEL_MIN_PX,
  MODEL_SPAN_UNITS,
  aircraftOrientation,
  canRenderModel,
  createAircraftGeometry,
  createSelectedAircraftLayer,
  modelSpanWorld,
} from './selectedAircraft';

const FOV = 50;
const VIEWPORT_H = 720;
const GLOBE_RADIUS = 100;

function object(overrides: Partial<RenderableObject> = {}): RenderableObject {
  const base: RenderableObject = {
    id: 'abc123',
    lat: 10,
    lon: 20,
    altitude: 9000,
    velocity: null,
    heading: 90,
    label: 'THA600',
    lastSeen: '2026-08-27T00:00:00Z',
    type: 'aircraft',
    renderLat: 10,
    renderLon: 20,
    fromLat: 10,
    fromLon: 20,
    // Older than the ease duration, so positionAt returns the reported
    // position exactly and these tests are not also testing the easing.
    updatedAt: 0,
    lastSeenMs: 0,
  };
  return { ...base, ...overrides };
}

function camera(distance: number): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 10_000);
  cam.position.set(0, 0, distance);
  return cam;
}

/** Apply an orientation to a local axis and get the world direction back. */
function axis(quaternion: THREE.Quaternion, local: THREE.Vector3): THREE.Vector3 {
  return local.clone().applyQuaternion(quaternion);
}

const FORWARD = new THREE.Vector3(0, 0, 1);
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * The direction of travel exactly as the marker vertex shader computes it.
 *
 * Transcribed from the GLSL in markers.ts rather than imported, because the
 * point is to check that two independent expressions of the same frame agree.
 * Importing a shared helper would make the test pass by construction.
 */
function shaderTravelDirection(lat: number, lon: number, headingDeg: number): THREE.Vector3 {
  const position = latLonToVector3(lat, lon, GLOBE_RADIUS * (1 + MARKER_ALTITUDE));
  const up = position.clone().normalize();
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east);
  const heading = (headingDeg * Math.PI) / 180;
  return north
    .clone()
    .multiplyScalar(Math.cos(heading))
    .addScaledVector(east, Math.sin(heading))
    .normalize();
}

describe('canRenderModel', () => {
  it('accepts an ordinary aircraft', () => {
    expect(canRenderModel(object())).toBe(true);
  });

  it('rejects a null heading, which has no direction to draw', () => {
    expect(canRenderModel(object({ heading: null }))).toBe(false);
  });

  it('accepts a heading of exactly zero', () => {
    // Due north is a real heading. A falsy check here would silently refuse to
    // draw every aircraft flying north, which is the classic version of this
    // bug and the reason the contract distinguishes null from zero (D18).
    expect(canRenderModel(object({ heading: 0 }))).toBe(true);
  });

  it('rejects nothing selected', () => {
    expect(canRenderModel(null)).toBe(false);
    expect(canRenderModel(undefined)).toBe(false);
  });
});

describe('aircraftOrientation', () => {
  it('points the nose due north at heading 0', () => {
    // At 0N 0E the outward normal is +Z and north is +Y in this frame.
    const nose = axis(aircraftOrientation(0, 0, 0), FORWARD);
    expect(nose.x).toBeCloseTo(0, 6);
    expect(nose.y).toBeCloseTo(1, 6);
    expect(nose.z).toBeCloseTo(0, 6);
  });

  it('points the nose due east at heading 90', () => {
    const nose = axis(aircraftOrientation(0, 0, 90), FORWARD);
    expect(nose.x).toBeCloseTo(1, 6);
    expect(nose.y).toBeCloseTo(0, 6);
    expect(nose.z).toBeCloseTo(0, 6);
  });

  it('points the nose due south at heading 180', () => {
    const nose = axis(aircraftOrientation(0, 0, 180), FORWARD);
    expect(nose.y).toBeCloseTo(-1, 6);
  });

  it('points the nose due west at heading 270', () => {
    const nose = axis(aircraftOrientation(0, 0, 270), FORWARD);
    expect(nose.x).toBeCloseTo(-1, 6);
  });

  it('stands the model up on the surface, not on its side', () => {
    for (const [lat, lon] of [
      [0, 0],
      [45, 30],
      [-33, 151],
      [60, -120],
    ]) {
      const up = axis(aircraftOrientation(lat, lon, 47), UP);
      const surfaceNormal = latLonToVector3(lat, lon, 1).normalize();
      expect(up.dot(surfaceNormal)).toBeCloseTo(1, 6);
    }
  });

  it('agrees with the marker shader about which way the aircraft is flying', () => {
    // The one that matters: sprite and mesh must share a tangent frame, or the
    // aircraft visibly snaps to a new heading the instant it is selected.
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [13.7, 100.5, 45],
      [51.5, -0.1, 137],
      [-33.9, 151.2, 270],
      [64, -21, 359],
      [-54, 3, 12],
    ];
    for (const [lat, lon, heading] of cases) {
      const nose = axis(aircraftOrientation(lat, lon, heading), FORWARD);
      const expected = shaderTravelDirection(lat, lon, heading);
      expect(nose.dot(expected)).toBeCloseTo(1, 6);
    }
  });

  it('is a rotation, not a reflection', () => {
    // right x up = forward for a right-handed basis. A determinant of -1 would
    // mirror the airframe -- engines and fin all still present, wings still
    // level, and the aeroplane subtly wrong in a way that survives review.
    const quaternion = aircraftOrientation(28, -80, 210);
    const right = axis(quaternion, RIGHT);
    const up = axis(quaternion, UP);
    const forward = axis(quaternion, FORWARD);
    const cross = new THREE.Vector3().crossVectors(right, up);
    expect(cross.dot(forward)).toBeCloseTo(1, 6);
  });

  it('stays finite at the poles, where east is undefined', () => {
    for (const lat of [90, -90]) {
      const nose = axis(aircraftOrientation(lat, 0, 30), FORWARD);
      expect(Number.isFinite(nose.x)).toBe(true);
      expect(Number.isFinite(nose.y)).toBe(true);
      expect(Number.isFinite(nose.z)).toBe(true);
      expect(nose.length()).toBeCloseTo(1, 6);
    }
  });

  it('writes into the quaternion it is given rather than allocating', () => {
    const target = new THREE.Quaternion();
    expect(aircraftOrientation(10, 10, 10, target)).toBe(target);
  });
});

describe('modelSpanWorld', () => {
  /** The span the sprite sizing model asks for, before any clamping. */
  const unclamped = MARKER_WORLD_SIZE * SELECTED_SIZE_MULTIPLIER * GLOBE_RADIUS;

  /** Convert a world span back into the screen pixels it occupies. */
  function pixels(distance: number): number {
    const span = modelSpanWorld(distance, GLOBE_RADIUS, FOV, VIEWPORT_H);
    const visibleHeight = 2 * distance * Math.tan((FOV * Math.PI) / 360);
    return span / (visibleHeight / VIEWPORT_H);
  }

  it('matches the sprite sizing model in the unclamped band', () => {
    // At the default camera distance the size is world-anchored, so the mesh
    // and the sprite it replaces occupy the same span. Selection changes the
    // shape, not the size.
    expect(modelSpanWorld(320, GLOBE_RADIUS, FOV, VIEWPORT_H)).toBeCloseTo(unclamped, 6);
  });

  it('grows as the camera descends', () => {
    expect(modelSpanWorld(150, GLOBE_RADIUS, FOV, VIEWPORT_H)).toBeGreaterThan(0);
    expect(pixels(150)).toBeGreaterThan(pixels(320));
  });

  it('holds a floor when zoomed all the way out', () => {
    // 800 is the far end of the orbit controls' range.
    expect(pixels(800)).toBeCloseTo(MODEL_MIN_PX, 4);
  });

  it('lands at about 55 px on the closest approach, under the ceiling', () => {
    // 100.5 is minDistance, 1.005 R. Pinned as a number rather than a bound,
    // because this is the size the model actually reaches in use and a change
    // to the sizing model should have to admit it here.
    expect(pixels(100.5)).toBeCloseTo(55.3, 1);
  });

  it('leaves the ceiling as an unengaged rail across the reachable range', () => {
    // Stated rather than assumed: nothing between the orbit controls' limits
    // is clamped at the top, so MODEL_MAX_PX is dead code today and is meant
    // to be. If a future change lets the camera closer, this test fails and
    // the ceiling's documentation has to be revisited with it.
    for (const distance of [100.5, 150, 320, 500, 800]) {
      expect(pixels(distance)).toBeLessThan(MODEL_MAX_PX);
    }
  });

  it('still clamps at the ceiling if the camera ever gets closer', () => {
    // The rail works, tested outside the reachable range so it is verified
    // rather than merely believed.
    expect(pixels(40)).toBeCloseTo(MODEL_MAX_PX, 4);
  });

  it('never goes below the sprite floor it replaces', () => {
    // A mesh smaller than the dot it stands in for would read as the selection
    // having shrunk the aircraft.
    expect(MODEL_MIN_PX).toBeGreaterThan(5);
  });

  it('returns zero for a degenerate viewport rather than NaN', () => {
    expect(modelSpanWorld(320, GLOBE_RADIUS, FOV, 0)).toBe(0);
  });
});

describe('createAircraftGeometry', () => {
  const geometry = createAircraftGeometry();

  it('is a single geometry, so the model costs one draw call', () => {
    expect(geometry.attributes.position.count).toBeGreaterThan(0);
    expect(geometry.index).toBeNull();
  });

  it('carries normals for shading and nothing else', () => {
    expect(geometry.attributes.normal).toBeDefined();
    expect(geometry.attributes.normal.count).toBe(geometry.attributes.position.count);
    expect(geometry.attributes.uv).toBeUndefined();
  });

  it('stays low-poly', () => {
    // Not a performance limit -- one mesh could not matter -- but a tripwire
    // against someone quietly swapping in a detailed model, which is the thing
    // task 3 explicitly rules out.
    expect(geometry.attributes.position.count / 3).toBeLessThan(600);
  });

  it('is normalised to a unit wingspan', () => {
    const box = geometry.boundingBox as THREE.Box3;
    expect(box.max.x - box.min.x).toBeCloseTo(MODEL_SPAN_UNITS, 6);
  });

  it('is centred on its own span, so it pivots about itself', () => {
    const box = geometry.boundingBox as THREE.Box3;
    expect(box.min.x + box.max.x).toBeCloseTo(0, 6);
    expect(box.min.z + box.max.z).toBeCloseTo(0, 6);
  });

  it('is airliner-shaped: about as long as it is wide, and much flatter', () => {
    const box = geometry.boundingBox as THREE.Box3;
    const length = box.max.z - box.min.z;
    const height = box.max.y - box.min.y;
    expect(length).toBeGreaterThan(0.8);
    expect(length).toBeLessThan(1.3);
    expect(height).toBeLessThan(length * 0.4);
  });

  it('puts the fin behind the nose, so the model is not built backwards', () => {
    // The tallest point of an airliner is its tail. If the geometry were
    // authored nose-aft, everything else would still look plausible and every
    // aircraft would fly backwards -- which is exactly what happened to the
    // sprites (D40).
    const position = geometry.attributes.position;
    let highest = -Infinity;
    let zAtHighest = 0;
    for (let i = 0; i < position.count; i += 1) {
      const y = position.getY(i);
      if (y > highest) {
        highest = y;
        zAtHighest = position.getZ(i);
      }
    }
    expect(zAtHighest).toBeLessThan(0);
  });
});

describe('the layer', () => {
  it('draws nothing and hides no sprite when there is no selection', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    expect(layer.update(null, 1000, camera(320), VIEWPORT_H)).toBeNull();
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });

  it('starts hidden, so nothing sits inside the planet before the first frame', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });

  it('shows the model and reports the sprite to hide', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    expect(layer.update(object(), 1000, camera(320), VIEWPORT_H)).toBe('abc123');
    expect(layer.mesh.visible).toBe(true);
    layer.dispose();
  });

  it('leaves the sprite alone for an aircraft with no heading', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    expect(layer.update(object({ heading: null }), 1000, camera(320), VIEWPORT_H)).toBeNull();
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });

  it('puts the model exactly where the sprite would have been', () => {
    // No jump on selection: same interpolated position, same legibility shell.
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    const selected = object({ lat: 13.7, lon: 100.5 });
    layer.update(selected, 1000, camera(320), VIEWPORT_H);

    const expected = latLonToVector3(13.7, 100.5, GLOBE_RADIUS * (1 + MARKER_ALTITUDE));
    expect(layer.mesh.position.distanceTo(expected)).toBeCloseTo(0, 6);
    layer.dispose();
  });

  it('sits on the marker shell, not at a literal altitude inside the surface', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    layer.update(object({ altitude: 12_000 }), 1000, camera(320), VIEWPORT_H);
    expect(layer.mesh.position.length()).toBeCloseTo(
      GLOBE_RADIUS * (1 + MARKER_ALTITUDE),
      6,
    );
    layer.dispose();
  });

  it('ignores altitude when placing, because colour carries it', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    layer.update(object({ altitude: 500 }), 1000, camera(320), VIEWPORT_H);
    const low = layer.mesh.position.length();
    layer.update(object({ altitude: 12_000 }), 1000, camera(320), VIEWPORT_H);
    expect(layer.mesh.position.length()).toBeCloseTo(low, 6);
    layer.dispose();
  });

  it('orients the model by heading', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    layer.update(object({ lat: 0, lon: 0, heading: 90 }), 1000, camera(320), VIEWPORT_H);
    const nose = axis(layer.mesh.quaternion, FORWARD);
    expect(nose.x).toBeCloseTo(1, 6);
    layer.dispose();
  });

  it('scales the model with the camera', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    layer.update(object(), 1000, camera(320), VIEWPORT_H);
    const far = layer.mesh.scale.x;
    layer.update(object(), 1000, camera(150), VIEWPORT_H);
    expect(layer.mesh.scale.x).toBeLessThan(far);
    // Uniform, or the airframe would be sheared.
    expect(layer.mesh.scale.y).toBeCloseTo(layer.mesh.scale.x, 9);
    expect(layer.mesh.scale.z).toBeCloseTo(layer.mesh.scale.x, 9);
    layer.dispose();
  });

  it('hides again when the selection is cleared', () => {
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    layer.update(object(), 1000, camera(320), VIEWPORT_H);
    expect(layer.update(null, 1000, camera(320), VIEWPORT_H)).toBeNull();
    expect(layer.mesh.visible).toBe(false);
    layer.dispose();
  });
});


describe('the size ceiling actually binds (D43 regression)', () => {
  // The model sits on the marker shell, so the camera can be a fraction of a
  // unit from it while still being ~101 units from the globe's centre. Sizing
  // measured the wrong one of those, so the clamp evaluated against a distance
  // an order of magnitude too large and never engaged. Measured in the browser:
  // 124 px wingspan at a camera distance of 120 and a viewport-filling model at
  // 105, against a ceiling that is supposed to be 96 px.
  const SHELL = GLOBE_RADIUS * (1 + MARKER_ALTITUDE);

  /** On-screen wingspan, given a camera distance measured from the centre. */
  function screenPx(cameraDistanceFromCentre: number): number {
    const toModel = cameraDistanceFromCentre - SHELL;
    const span = modelSpanWorld(toModel, GLOBE_RADIUS, FOV, VIEWPORT_H);
    const perPixel = (2 * toModel * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_H;
    return span / perPixel;
  }

  it('never exceeds the ceiling anywhere in the reachable camera range', () => {
    // The orbit controls clamp to [1.014 R, 8 R].
    for (const distance of [800, 600, 400, 320, 240, 180, 140, 120, 110, 101.5]) {
      expect(screenPx(distance)).toBeLessThanOrEqual(MODEL_MAX_PX + 1e-6);
    }
  });

  it('never falls below the floor anywhere in the reachable camera range', () => {
    for (const distance of [800, 600, 400, 320, 240, 180, 140, 120, 110, 101.5]) {
      expect(screenPx(distance)).toBeGreaterThanOrEqual(MODEL_MIN_PX - 1e-6);
    }
  });

  it('the ceiling binds on a close approach rather than being dead code', () => {
    // If this ever passes trivially again, the clamp has stopped working.
    expect(screenPx(110)).toBeCloseTo(MODEL_MAX_PX, 6);
    expect(screenPx(120)).toBeCloseTo(MODEL_MAX_PX, 6);
  });

  it('the floor binds when fully zoomed out', () => {
    expect(screenPx(800)).toBeCloseTo(MODEL_MIN_PX, 6);
  });

  it('grows monotonically as the camera approaches', () => {
    const distances = [800, 600, 400, 320, 240, 180];
    const sizes = distances.map(screenPx);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]).toBeGreaterThanOrEqual(sizes[i - 1]);
    }
  });

  it('measuring to the globe centre instead of the model reproduces the bug', () => {
    // The defect, pinned so the distinction cannot be quietly undone: feeding
    // the centre distance leaves the model far past the ceiling close in.
    const wrong = (centreDistance: number) => {
      const span = modelSpanWorld(centreDistance, GLOBE_RADIUS, FOV, VIEWPORT_H);
      const toModel = centreDistance - SHELL;
      const perPixel = (2 * toModel * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_H;
      return span / perPixel;
    };
    expect(wrong(120)).toBeGreaterThan(MODEL_MAX_PX);
    expect(wrong(105)).toBeGreaterThan(MODEL_MAX_PX * 3);
  });
});

describe('the camera cannot enter the marker shell (D43 regression)', () => {
  // At the previous minimum of 1.005 R the camera sat *inside* the 1.012 R
  // shell that markers and the model occupy, so anything directly beneath it
  // fell behind the near plane and vanished — sprites included — at exactly the
  // moment the user had zoomed all the way in.
  const SHELL_FACTOR = 1 + MARKER_ALTITUDE;
  const MIN_DISTANCE_FACTOR = SHELL_FACTOR * 1.002;

  it('the closest camera position is outside the shell', () => {
    expect(MIN_DISTANCE_FACTOR).toBeGreaterThan(SHELL_FACTOR);
  });

  it('a marker beneath the camera stays in front of it', () => {
    const cameraRadius = GLOBE_RADIUS * MIN_DISTANCE_FACTOR;
    const markerRadius = GLOBE_RADIUS * SHELL_FACTOR;
    // Both on the same ray from the centre: the marker is in front only if the
    // camera is further out than it is.
    expect(cameraRadius - markerRadius).toBeGreaterThan(0);
  });

  it('still allows a viewport small enough for the tier 2 poll to engage', () => {
    // D36: the whole reason the minimum is aggressive. The visible cap must stay
    // under the 400 square degree threshold or tier 2 becomes dead code again.
    const altitude = MIN_DISTANCE_FACTOR - 1;
    const capDegrees = (Math.acos(1 / (1 + altitude)) * 180) / Math.PI;
    const bboxAreaSqDeg = (2 * capDegrees) ** 2;
    expect(bboxAreaSqDeg).toBeLessThan(400);
  });
});


describe('update() sizes against the camera-to-model distance (D43 call site)', () => {
  // The tests above pin modelSpanWorld's contract. This one pins the *call
  // site*, which is where the defect actually lived: update() passed the
  // camera's distance from the origin instead of its distance to the model, and
  // every function it called was individually correct.

  /** Camera placed on the ray through the object, `distance` from the centre. */
  function cameraAbove(objectLatLon: RenderableObject, distance: number) {
    const cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 10_000);
    cam.position
      .copy(latLonToVector3(objectLatLon.lat, objectLatLon.lon, 1))
      .multiplyScalar(distance);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    return cam;
  }

  /** What the layer actually renders, in screen pixels of wingspan. */
  function renderedPx(cameraDistanceFromCentre: number): number {
    const target = object();
    const layer = createSelectedAircraftLayer(GLOBE_RADIUS);
    const cam = cameraAbove(target, cameraDistanceFromCentre);
    layer.update(target, 1000, cam, VIEWPORT_H);

    const span = layer.mesh.scale.x * MODEL_SPAN_UNITS;
    const toModel = cam.position.distanceTo(layer.mesh.position);
    const perPixel = (2 * toModel * Math.tan((FOV * Math.PI) / 360)) / VIEWPORT_H;
    layer.dispose();
    return span / perPixel;
  }

  it('stays within the ceiling right down to the closest reachable camera', () => {
    const closest = GLOBE_RADIUS * (1 + MARKER_ALTITUDE) * 1.002;
    for (const distance of [800, 400, 320, 180, 140, 120, 110, closest]) {
      expect(renderedPx(distance)).toBeLessThanOrEqual(MODEL_MAX_PX + 1e-6);
    }
  });

  it('does not collapse below the floor when fully zoomed out', () => {
    expect(renderedPx(800)).toBeGreaterThanOrEqual(MODEL_MIN_PX - 1e-6);
  });

  it('a close approach is capped, not runaway', () => {
    // Before the fix this measured 124 px at 120 and filled the viewport at 105.
    expect(renderedPx(120)).toBeCloseTo(MODEL_MAX_PX, 4);
    expect(renderedPx(110)).toBeCloseTo(MODEL_MAX_PX, 4);
  });
});
