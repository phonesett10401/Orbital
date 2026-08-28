/**
 * The airframe itself: one merged geometry, generated in code.
 *
 * It lives outside both views because both draw it. The globe hangs it off a
 * marker shell (D42); the planet view puts it in a tangent frame on the map
 * (D67). Neither of those is a property of the aeroplane, so the aeroplane
 * does not know about either.
 *
 * ## Why the model is built in code rather than loaded
 *
 * There is no glTF loader here and there should not be one. The task is a
 * single generic airframe, and a loading pipeline brings an async load to
 * sequence, a binary asset in git, a licence to track, and a failure mode
 * (model not yet loaded when the user clicks) - all to draw one aeroplane. The
 * sprite atlas is generated for the same reasons and states them at length
 * (D30): the shape stays readable and adjustable in source instead of being an
 * opaque asset.
 *
 * If a future task ever needs per-type models - 737 vs A320 vs Cessna - that
 * is when a loader earns its place. It does not earn it now.
 *
 * ## Its own space
 *
 * +Z is the nose, +Y is up, +X is the starboard wing, and the wingspan is
 * exactly `MODEL_SPAN_UNITS`. A caller therefore scales by "wingspan in
 * whatever units I am working in" and needs to know nothing else.
 */

import * as THREE from 'three';

/**
 * The model's wingspan in local units, before scaling.
 *
 * The geometry is normalised to exactly this so that `mesh.scale` is readable
 * as "wingspan in world units" rather than an arbitrary factor.
 */
export const MODEL_SPAN_UNITS = 1;

/**
 * Add one primitive to the airframe, baked into the model's local space.
 *
 * `applyMatrix4` transforms the normals as well as the positions, and
 * `toNonIndexed` flattens the result so the parts can simply be concatenated —
 * merging indexed geometries means rewriting every index by an offset, and
 * there is no reason to do that for a few hundred triangles.
 */
function bake(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  geometry.applyMatrix4(matrix);
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  // UVs would be carried through every merge and nothing samples a texture here.
  flat.deleteAttribute('uv');
  return flat;
}

/**
 * Place a primitive at (x, y, z), optionally laid along Z.
 *
 * `lieAlongZ` rotates a quarter turn about X, which is what turns a
 * `CylinderGeometry` — built along Y, with `radiusTop` at +Y — into something
 * running fore and aft. **After that rotation `radiusTop` is the FORWARD
 * radius**, because +Y maps to +Z, and +Z is the nose. Every cylinder here is
 * therefore authored as `(forwardRadius, aftRadius)`.
 *
 * That sentence is in the code because its absence cost a defect: the two
 * cones were rotated the other way, which silently swapped their ends and
 * built an aeroplane that pinched to a point where the nose met the fuselage
 * and then flared open at the tip (D50).
 */
function at(x: number, y: number, z: number, lieAlongZ = false): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  if (lieAlongZ) matrix.makeRotationX(Math.PI / 2);
  matrix.setPosition(x, y, z);
  return matrix;
}

/**
 * A thin flat panel with an arbitrary four-cornered plan: a wing, a tailplane
 * or a fin.
 *
 * A `BoxGeometry` cannot sweep or taper, and a rectangular slab with square
 * tips is most of what makes a low-poly airliner read as a dart. Four corners
 * in the plan and a thickness give sweep and taper for the same twelve
 * triangles a box costs.
 *
 * `corners` are [across, along] pairs in order around the outline, and
 * `thickness` is split either side of `offset` on the remaining axis. The
 * panel is built in the XZ plane; the fin passes `vertical` and gets the same
 * outline stood up in XY.
 */
function panel(
  corners: [number, number][],
  thickness: number,
  offset = 0,
  vertical = false,
): THREE.BufferGeometry {
  const half = thickness / 2;
  const place = (across: number, along: number, side: number): [number, number, number] =>
    vertical
      ? [offset + side * half, across, along]
      : [across, offset + side * half, along];

  const top = corners.map(([a, b]) => place(a, b, 1));
  const bottom = corners.map(([a, b]) => place(a, b, -1));

  const tri: number[] = [];
  const push = (...points: [number, number, number][]) => {
    for (const point of points) tri.push(...point);
  };

  // Two faces, wound opposite ways, then a quad down each of the four edges.
  push(top[0], top[1], top[2], top[0], top[2], top[3]);
  push(bottom[0], bottom[2], bottom[1], bottom[0], bottom[3], bottom[2]);
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    push(top[i], bottom[i], bottom[j], top[i], bottom[j], top[j]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A low-poly airliner: fuselage, nose, tail cone, wings, tailplane, fin, and
 * two engines.
 *
 * A few hundred triangles, which is nothing — the constraint that matters is
 * the draw call, not the vertex count, and this is one geometry.
 *
 * Proportions are an airliner's rather than any particular type's: span and
 * length within a few percent of each other, wings a little ahead of centre,
 * engines under and forward of the wing. Recognisable at thirty pixels, which
 * is the only requirement it has.
 *
 * Cylinders use 8 radial segments deliberately. The faceting is visible on a
 * close approach and reads as stylised, where 6 reads as broken.
 */
export function createAircraftGeometry(): THREE.BufferGeometry {
  // Every cylinder below reads (forwardRadius, aftRadius, length) -- see `at`.
  const parts: THREE.BufferGeometry[] = [
    // Fuselage: widest at the front, tapering gently aft.
    bake(new THREE.CylinderGeometry(0.042, 0.036, 0.98, 8, 1), at(0, 0, 0, true)),
    // Nose cone: a point at the front, full fuselage width where it joins.
    bake(new THREE.CylinderGeometry(0.004, 0.042, 0.14, 8, 1), at(0, 0, 0.56, true)),
    // Tail cone: fuselage width at the front, tapering to the tail, and lifted
    // slightly so it runs up into the fin root the way an airliner's does.
    bake(new THREE.CylinderGeometry(0.036, 0.012, 0.12, 8, 1), at(0, 0.012, -0.55, true)),
    // Wings, one panel per side, rooted at the centreline so they meet inside
    // the fuselage and there is no seam to line up. Swept back and tapered:
    // root chord 0.24, tip chord 0.09, tip trailing edge 0.16 aft of the root's.
    bake(
      panel(
        [
          [0, 0.1],
          [-0.5, -0.06],
          [-0.5, -0.15],
          [0, -0.14],
        ],
        0.02,
        -0.012,
      ),
      at(0, 0, 0),
    ),
    bake(
      panel(
        [
          [0, 0.1],
          [0.5, -0.06],
          [0.5, -0.15],
          [0, -0.14],
        ],
        0.02,
        -0.012,
      ),
      at(0, 0, 0),
    ),
    // Tailplane, swept and tapered on the same rules, at a fifth of the span.
    bake(
      panel(
        [
          [-0.19, -0.46],
          [0, -0.39],
          [0, -0.51],
          [-0.19, -0.52],
        ],
        0.016,
        0.01,
      ),
      at(0, 0, 0),
    ),
    bake(
      panel(
        [
          [0.19, -0.46],
          [0, -0.39],
          [0, -0.51],
          [0.19, -0.52],
        ],
        0.016,
        0.01,
      ),
      at(0, 0, 0),
    ),
    // Fin: the same panel stood up in XY, leading edge raked back.
    bake(
      panel(
        [
          [0.015, -0.4],
          [0.185, -0.5],
          [0.185, -0.57],
          [0.015, -0.56],
        ],
        0.016,
        0,
        true,
      ),
      at(0, 0, 0),
    ),
    // Engines, slung under and ahead of the wing as they are on a real one.
    bake(new THREE.CylinderGeometry(0.036, 0.032, 0.17, 8, 1), at(-0.2, -0.05, 0.04, true)),
    bake(new THREE.CylinderGeometry(0.036, 0.032, 0.17, 8, 1), at(0.2, -0.05, 0.04, true)),
  ];

  let vertices = 0;
  for (const part of parts) vertices += part.attributes.position.count;

  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  let offset = 0;
  for (const part of parts) {
    positions.set(part.attributes.position.array as Float32Array, offset * 3);
    normals.set(part.attributes.normal.array as Float32Array, offset * 3);
    offset += part.attributes.position.count;
    part.dispose();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

  // Normalise to an exact unit wingspan and centre the airframe on its own
  // bounding box in X and Z, so `mesh.scale` means wingspan and the model
  // pivots about itself rather than about whichever primitive happened to be
  // built at the origin. Y is left alone: the marker point is where the
  // aircraft is, and the fin belongs above it.
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as THREE.Box3;
  geometry.translate(-(box.min.x + box.max.x) / 2, 0, -(box.min.z + box.max.z) / 2);

  geometry.computeBoundingBox();
  const centred = geometry.boundingBox as THREE.Box3;
  const factor = MODEL_SPAN_UNITS / (centred.max.x - centred.min.x);
  geometry.scale(factor, factor, factor);

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

