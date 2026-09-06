/**
 * Where each body ends up on screen, so chrome can be put on it (D159).
 *
 * The solar system is drawn by a custom WebGL layer, and HTML cannot be laid
 * over something it cannot locate. **The thing that draws them is what says
 * where they are** - the layer projects each body with the same matrix it just
 * rendered with, and this holds the arithmetic so it can be tested without a
 * GPU.
 *
 * Any other route is a guess. Projecting the body's *direction* onto the globe
 * with `map.project` is the obvious shortcut and it is wrong: the bodies are at
 * different distances in a 3D scene, and a direction says nothing about where
 * along that ray a sphere was actually drawn.
 */

/** A body's place on screen, in CSS pixels from the top left. */
export interface Marker {
  id: string;
  x: number;
  y: number;
  /** Whether it is in front of the camera at all. */
  inFront: boolean;
}

/**
 * Project a scene point through a column-major 4x4 matrix into CSS pixels.
 *
 * Column-major, which is what both three.js and MapLibre hand out:
 * `element(row, col)` is `m[col * 4 + row]`. Reading it the other way is the
 * transpose, which is a rotation that looks plausible and is wrong everywhere
 * except the axes - the mistake `cameraFrame.ts` documents from the other side.
 */
export interface Projected {
  x: number;
  y: number;
  inFront: boolean;
}

export function project(
  matrix: readonly number[],
  point: readonly [number, number, number],
  width: number,
  height: number,
): Projected {
  const [x, y, z] = point;
  const clip = [0, 1, 2, 3].map(
    (row) =>
      matrix[0 * 4 + row] * x +
      matrix[1 * 4 + row] * y +
      matrix[2 * 4 + row] * z +
      matrix[3 * 4 + row],
  );
  const w = clip[3];
  // Behind the camera, or exactly on its plane. Dividing by this would put the
  // marker somewhere plausible on the opposite side of the screen, which is
  // worse than not drawing it.
  if (!(w > 1e-9)) return { x: 0, y: 0, inFront: false };
  const ndcX = clip[0] / w;
  const ndcY = clip[1] / w;
  return {
    x: (ndcX * 0.5 + 0.5) * width,
    // Flipped: clip space counts up, screen coordinates count down.
    y: (1 - (ndcY * 0.5 + 0.5)) * height,
    inFront: true,
  };
}

/** Whether a marker is inside the viewport, with room for its label. */
export function onScreen(
  marker: Projected,
  width: number,
  height: number,
  margin = 60,
): boolean {
  if (!marker.inFront) return false;
  return (
    marker.x >= -margin &&
    marker.x <= width + margin &&
    marker.y >= -margin &&
    marker.y <= height + margin
  );
}
