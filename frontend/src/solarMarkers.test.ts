import { describe, expect, it } from 'vitest';

import { onScreen, project } from './solarMarkers';

/** A plain perspective matrix, column-major, looking down -z. */
function perspective(fov = Math.PI / 2, aspect = 1, near = 0.1, far = 100): number[] {
  const f = 1 / Math.tan(fov / 2);
  const m = new Array(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

const W = 800;
const H = 600;

describe('projecting a body onto the screen', () => {
  it('puts a point straight ahead in the middle', () => {
    const p = project(perspective(), [0, 0, -10], W, H);
    expect(p.inFront).toBe(true);
    expect(p.x).toBeCloseTo(W / 2, 6);
    expect(p.y).toBeCloseTo(H / 2, 6);
  });

  it('puts a point to the right on the right', () => {
    expect(project(perspective(), [5, 0, -10], W, H).x).toBeGreaterThan(W / 2);
  });

  it('puts a point above centre nearer the top, not the bottom', () => {
    // Clip space counts up and screen coordinates count down. Forgetting the
    // flip puts every label on the wrong side of its planet, mirrored about
    // the horizon - which looks like a plausible layout and is upside down.
    expect(project(perspective(), [0, 5, -10], W, H).y).toBeLessThan(H / 2);
  });

  it('refuses a point behind the camera', () => {
    // Dividing by a negative w puts the marker somewhere plausible on the
    // opposite side of the screen, which is worse than not drawing it: a label
    // for a planet that is behind you, sitting confidently over one that is
    // not.
    expect(project(perspective(), [0, 0, 10], W, H).inFront).toBe(false);
  });

  it('refuses a point exactly on the camera plane', () => {
    expect(project(perspective(), [0, 0, 0], W, H).inFront).toBe(false);
  });

  it('reads the matrix column-major, the way three.js and MapLibre hand it out', () => {
    // Transposing gives a rotation that is plausible and wrong everywhere
    // except the axes, which is why this uses an off-axis point: a point on an
    // axis survives the transpose and proves nothing.
    const m = perspective();
    const straight = project(m, [3, 2, -10], W, H);
    const transposed = [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => m[c * 4 + r]));
    const wrong = project(transposed, [3, 2, -10], W, H);
    expect(straight.inFront).toBe(true);
    expect(wrong.x).not.toBeCloseTo(straight.x, 1);
  });

  it('scales with the viewport it is given', () => {
    const wide = project(perspective(), [5, 0, -10], 1600, 600);
    const narrow = project(perspective(), [5, 0, -10], 800, 600);
    expect(wide.x / 1600).toBeCloseTo(narrow.x / 800, 6);
  });
});

describe('deciding whether to draw it', () => {
  it('keeps what is on screen', () => {
    expect(onScreen({ x: 400, y: 300, inFront: true }, W, H)).toBe(true);
  });

  it('keeps something just off the edge, so a label can hang inward', () => {
    expect(onScreen({ x: -20, y: 300, inFront: true }, W, H)).toBe(true);
  });

  it('drops what is far outside', () => {
    expect(onScreen({ x: -400, y: 300, inFront: true }, W, H)).toBe(false);
    expect(onScreen({ x: 400, y: 5000, inFront: true }, W, H)).toBe(false);
  });

  it('drops anything behind the camera wherever it landed', () => {
    expect(onScreen({ x: 400, y: 300, inFront: false }, W, H)).toBe(false);
  });
});
