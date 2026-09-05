/**
 * Reading the camera back out of MapLibre's projection matrix.
 *
 * A custom layer is handed one thing: a 4x4 world-to-clip matrix. It is not
 * told where the camera is, how far it can see, or where the far plane sits -
 * and the sky needs all three, because a backdrop is defined by the camera
 * rather than by the world.
 *
 * All of that is already *in* the matrix. This module takes it out, with no
 * MapLibre import and no GPU, so the part of the sky that can be tested is
 * tested and only the drawing is left untestable (D129).
 *
 * ## Convention
 *
 * The array is column-major, which is what WebGL and three.js both use:
 * element (row, col) is `m[col * 4 + row]`. Reading it as row-major transposes
 * the matrix, which for a symmetric perspective projection still produces a
 * plausible-looking answer - that is the trap, so `element` exists rather than
 * indices scattered through the file.
 */

export type Vec3 = [number, number, number];

/** A plane as ax + by + cz + d = 0, with the normal pointing into the frustum. */
export interface Plane {
  normal: Vec3;
  d: number;
}

function element(m: ArrayLike<number>, row: number, col: number): number {
  return m[col * 4 + row];
}

/** Row `i` of the matrix, as the four coefficients of a clip coordinate. */
function row(m: ArrayLike<number>, i: number): [number, number, number, number] {
  return [element(m, i, 0), element(m, i, 1), element(m, i, 2), element(m, i, 3)];
}

function normalisePlane(p: [number, number, number, number]): Plane {
  const length = Math.hypot(p[0], p[1], p[2]);
  if (length === 0) return { normal: [0, 0, 0], d: 0 };
  return { normal: [p[0] / length, p[1] / length, p[2] / length], d: p[3] / length };
}

/**
 * The near and far planes, with inward normals.
 *
 * Gribb-Hartmann: in the OpenGL clip convention a point is inside when
 * `-w <= z <= w`, so the near plane is row 3 plus row 2 and the far plane is
 * row 3 minus row 2. Both are then normalised, which is what turns the
 * coefficients into an actual distance when a point is substituted in.
 */
export function depthPlanes(m: ArrayLike<number>): { near: Plane; far: Plane } {
  const r2 = row(m, 2);
  const r3 = row(m, 3);
  return {
    near: normalisePlane([r3[0] + r2[0], r3[1] + r2[1], r3[2] + r2[2], r3[3] + r2[3]]),
    far: normalisePlane([r3[0] - r2[0], r3[1] - r2[1], r3[2] - r2[2], r3[3] - r2[3]]),
  };
}

/** How far a point sits inside a plane. Negative means outside, and clipped. */
export function distanceToPlane(plane: Plane, point: Vec3): number {
  return (
    plane.normal[0] * point[0] +
    plane.normal[1] * point[1] +
    plane.normal[2] * point[2] +
    plane.d
  );
}

/**
 * Where the camera is, in world units.
 *
 * The camera centre is the one point a projection sends to nothing: every clip
 * coordinate, w included, is zero there. So `M . [C, 1] = 0` gives four
 * equations in three unknowns, and any three independent ones solve it. Rows
 * 0, 1 and 3 are used, with rows 0, 1, 2 as the fallback for the degenerate
 * case of an orthographic matrix, where row 3 is constant and carries nothing.
 *
 * Returns null rather than a wrong answer when neither triple is independent -
 * a garbage camera position would place the whole sky somewhere arbitrary and
 * still draw, which is harder to notice than nothing being drawn.
 */
export function cameraPosition(m: ArrayLike<number>): Vec3 | null {
  const candidates: Array<[number, number, number]> = [
    [0, 1, 3],
    [0, 1, 2],
  ];
  for (const [a, b, c] of candidates) {
    const solved = solve3(row(m, a), row(m, b), row(m, c));
    if (solved) return solved;
  }
  return null;
}

/** Cramer's rule on three plane equations, each given as its four coefficients. */
function solve3(
  p: [number, number, number, number],
  q: [number, number, number, number],
  r: [number, number, number, number],
): Vec3 | null {
  const a = [
    [p[0], p[1], p[2]],
    [q[0], q[1], q[2]],
    [r[0], r[1], r[2]],
  ];
  // The constants move to the right-hand side, so the system is A.C = -w.
  const rhs = [-p[3], -q[3], -r[3]];
  const det = det3(a);
  // Scaled against the matrix's own size: an absolute epsilon would call a
  // legitimately small matrix singular, and a large one non-singular when it
  // is only large.
  const scale = Math.max(...a.flat().map(Math.abs), 1);
  if (Math.abs(det) < 1e-12 * scale ** 3) return null;

  const column = (i: number): number[][] =>
    a.map((rowOf, j) => rowOf.map((value, k) => (k === i ? rhs[j] : value)));
  return [det3(column(0)) / det, det3(column(1)) / det, det3(column(2)) / det];
}

function det3(a: number[][]): number {
  return (
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  );
}

/**
 * Everything the sky needs, from the one matrix the layer is given.
 *
 * `near` and `far` are distances from the camera, not the raw plane constants,
 * because that is the question being asked: how far out may something sit and
 * still be drawn.
 */
export interface CameraView {
  at: Vec3;
  near: number;
  far: number;
}

export function readCamera(m: ArrayLike<number>): CameraView | null {
  const at = cameraPosition(m);
  if (!at) return null;
  const { near, far } = depthPlanes(m);
  // The camera is *behind* its own near plane - it is not inside the frustum -
  // so its signed distance is the near distance negated. Taking the raw value
  // returns a near of -0.75 where 0.75 was asked for, which is the sort of sign
  // error that only shows up as a sky drawn inside out (D129).
  const nearDistance = -distanceToPlane(near, at);
  const farDistance = distanceToPlane(far, at);
  // A camera outside its own far plane, or with the two crossed over, means the
  // matrix was not what this assumed. Better to draw no sky than a wrong one.
  if (!Number.isFinite(nearDistance) || !Number.isFinite(farDistance)) return null;
  if (farDistance <= nearDistance) return null;
  return { at, near: nearDistance, far: farDistance };
}
