import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  cameraPosition,
  depthPlanes,
  distanceToPlane,
  readCamera,
  type Vec3,
} from './cameraFrame';

/**
 * A world-to-clip matrix for a camera that is somewhere specific and looking
 * somewhere specific, so the tests check a known answer rather than an
 * internally consistent one.
 */
function viewProjection(
  at: Vec3,
  lookAt: Vec3,
  near: number,
  far: number,
  fov = 45,
  aspect = 1.6,
): number[] {
  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
  camera.position.set(...at);
  camera.lookAt(new THREE.Vector3(...lookAt));
  camera.updateMatrixWorld(true);
  return new THREE.Matrix4()
    .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    .toArray();
}

describe('finding the camera', () => {
  it('recovers a position that was never in the matrix explicitly', () => {
    const at: Vec3 = [12, -4, 83];
    const found = cameraPosition(viewProjection(at, [0, 0, 0], 0.5, 200));
    expect(found).not.toBeNull();
    for (let i = 0; i < 3; i += 1) expect((found as Vec3)[i]).toBeCloseTo(at[i], 4);
  });

  it('is not fooled by a camera far from the origin', () => {
    // The globe view sits about 83 radii out, where a matrix read as row-major
    // still returns a finite, plausible-looking vector.
    const at: Vec3 = [0, 0, 83];
    const found = cameraPosition(viewProjection(at, [0, 0, 0], 1, 300)) as Vec3;
    expect(found[2]).toBeCloseTo(83, 3);
    expect(Math.hypot(found[0], found[1])).toBeCloseTo(0, 3);
  });

  it('works when the camera is tilted rather than looking down an axis', () => {
    const at: Vec3 = [30, 40, 50];
    const found = cameraPosition(viewProjection(at, [1, -2, 3], 0.1, 500)) as Vec3;
    for (let i = 0; i < 3; i += 1) expect(found[i]).toBeCloseTo(at[i], 3);
  });

  it('returns null for a matrix with no camera in it', () => {
    expect(cameraPosition(new Array(16).fill(0))).toBeNull();
  });
});

describe('the depth planes', () => {
  it('measures the distances the camera was built with', () => {
    const view = readCamera(viewProjection([0, 0, 83], [0, 0, 0], 0.75, 210));
    expect(view).not.toBeNull();
    expect((view as { near: number }).near).toBeCloseTo(0.75, 4);
    expect((view as { far: number }).far).toBeCloseTo(210, 3);
  });

  it('points both normals inward, so inside is positive', () => {
    const m = viewProjection([0, 0, 83], [0, 0, 0], 1, 200);
    const { near, far } = depthPlanes(m);
    // A point just in front of the camera is inside both.
    const inside: Vec3 = [0, 0, 33];
    expect(distanceToPlane(near, inside)).toBeGreaterThan(0);
    expect(distanceToPlane(far, inside)).toBeGreaterThan(0);
  });

  it('calls a point beyond the far plane outside', () => {
    const m = viewProjection([0, 0, 83], [0, 0, 0], 1, 200);
    const { far } = depthPlanes(m);
    // 200 units in front of the camera is the plane itself; past it is out.
    expect(distanceToPlane(far, [0, 0, -130])).toBeLessThan(0);
    expect(distanceToPlane(far, [0, 0, -110])).toBeGreaterThan(0);
  });

  it('measures along the view direction, not from the world origin', () => {
    // The same far distance for a camera in a different place proves the
    // measurement is relative to the camera rather than to the scene.
    const a = readCamera(viewProjection([0, 0, 83], [0, 0, 0], 1, 200));
    const b = readCamera(viewProjection([600, -200, 15], [0, 0, 0], 1, 200));
    expect((a as { far: number }).far).toBeCloseTo((b as { far: number }).far, 3);
  });

  it('refuses a matrix whose planes are crossed over', () => {
    expect(readCamera(new Array(16).fill(0))).toBeNull();
  });
});
