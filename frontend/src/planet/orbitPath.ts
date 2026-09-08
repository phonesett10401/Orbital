/**
 * The selected satellite's orbit, as vertices on the same shell (D170).
 *
 * ## The one thing this file exists to get right
 *
 * The shell is **logarithmic**. `satelliteShell.ts` explains why at length: the
 * true range runs from 420 km to 105,466 km, so at true scale low orbit is a
 * film on the surface and the outer catalogue is off the end of the camera. The
 * drawing trades accuracy for legibility on purpose.
 *
 * An orbit path drawn at true scale would therefore **not pass through the
 * satellite it belongs to.** It would be a ring floating somewhere else, and
 * the reader would have no way to tell which of the two was lying. So every
 * point goes through `shellPosition` - the same function the marker uses, not a
 * copy of it - and the line passes through the marker by construction rather
 * than by agreement.
 *
 * ## What that costs, and it is worth saying out loud
 *
 * **An eccentric orbit is not drawn as its true shape.** A logarithm applied to
 * a radius is not a similarity transform: a Molniya orbit, 600 km at perigee
 * and 39,900 at apogee, is compressed enormously more at its high end than its
 * low one, so the drawn curve is far rounder than the real one. The claim this
 * drawing makes is the same one the shell makes and no more - *higher on screen
 * means higher in orbit* - and the true numbers stay in the panel.
 *
 * A near-circular orbit, which is most of the catalogue, is barely distorted at
 * all: the altitude varies by a few kilometres out of hundreds, and the shell
 * curve is smooth across that.
 *
 * ## Why the path is open
 *
 * The backend returns half a period back and half forward, and the two ends do
 * not meet: these are Earth-fixed positions and the Earth turns underneath the
 * orbit, about 22.5 degrees of longitude per low revolution. Nothing here
 * closes the loop. A closed ellipse would be the truth about a frame this view
 * does not use.
 */

import type { OrbitPoint } from '../types';
import { shellPosition } from './satelliteShellLayer';

/**
 * The path as a flat XYZ buffer in MapLibre's globe space.
 *
 * Flat rather than an array of triples because that is what a
 * `BufferAttribute` wants, and building the intermediate array only to unpack
 * it again is the kind of per-frame garbage the shell layer already avoids.
 */
export function orbitVertices(points: readonly OrbitPoint[]): Float32Array<ArrayBuffer> {
  const vertices = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i += 1) {
    const [x, y, z] = shellPosition(points[i].lon, points[i].lat, points[i].altitude);
    vertices[i * 3] = x;
    vertices[i * 3 + 1] = y;
    vertices[i * 3 + 2] = z;
  }
  return vertices;
}

/**
 * Whether a path is worth drawing at all.
 *
 * Two points make a line segment across the planet rather than an orbit, and a
 * path that short means something went wrong upstream rather than that the
 * orbit is short. Drawing it would put a chord through the globe.
 */
export function isDrawablePath(points: readonly OrbitPoint[] | undefined): boolean {
  return points !== undefined && points.length >= 3;
}
