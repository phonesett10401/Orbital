/**
 * A real 3D aircraft for the selected object, and only for the selected object.
 *
 * Every other aircraft stays a sprite in the single-draw-call marker layer
 * (D15, D40). Selection swaps exactly one of them for a mesh: `markers.ts`
 * already had `setHidden(id)` for this, so the sprite disappears in the same
 * frame the mesh appears and nothing is ever drawn twice.
 *
 * The budget is **one extra draw call**, so this is one `THREE.Mesh` with one
 * merged geometry and one material — not a `Group` of parts, which would cost
 * a call each.
 *
 * ## Why the model is built in code rather than loaded
 *
 * There is no glTF loader here and there should not be one. The task is a
 * single generic airframe, and a loading pipeline brings an async load to
 * sequence, a binary asset in git, a licence to track, and a failure mode
 * (model not yet loaded when the user clicks) — all to draw one aeroplane. The
 * sprite atlas is generated for the same reasons and states them at length
 * (D30): the shape stays readable and adjustable in source instead of being an
 * opaque asset.
 *
 * If a future task ever needs per-type models — 737 vs A320 vs Cessna — that
 * is when a loader earns its place. It does not earn it now.
 */

import * as THREE from 'three';

import { createAircraftGeometry } from '../airframe';
import type { RenderableObject } from '../types';
import { scaleFor } from '../wingspan';
import { latLonToVector3 } from './earth';
import { positionAt } from './interpolate';
import {
  MARKER_ALTITUDE,
  MARKER_WORLD_SIZE,
  SELECTED_SIZE_MULTIPLIER,
  worldUnitsPerPixel,
} from './markers';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Screen-size clamps for the model, in CSS pixels.
 *
 * The same idea as the sprite's clamps and deliberately different numbers.
 *
 * **The floor is what does the work.** A sprite at 5 px is still a
 * recognisable dot, but a shaded mesh that small is a flickering smudge, and
 * the whole point of the model is that you can see it is an aeroplane. Fully
 * zoomed out the world-anchored size works out at about 7 px, so the floor
 * engages and holds it at 16.
 *
 * **The ceiling never engages in the camera range the user can reach**, and is
 * kept as a rail rather than removed. Measured across that range — 1.005 R to
 * 8 R, set by the orbit controls:
 *
 * | camera distance | model |
 * |---|---|
 * | 800 (fully out) | 7 px, raised to the 16 px floor |
 * | 320 (default) | 17 px |
 * | 150 | 37 px |
 * | 100.5 (closest) | 55 px |
 *
 * 55 px is where a close approach naturally lands, and it is a good size, so
 * the ceiling sits above it rather than cutting it back. Note this is where
 * the model and the sprite deliberately part company: a *selected sprite* is
 * clamped to MAX_MARKER_PX (44 px), because a 55 px flat silhouette swamps the
 * terrain under it, while the mesh at 55 px reads as an aircraft above the
 * terrain. If the orbit controls ever let the camera closer, the ceiling
 * starts binding and stops the model filling the screen.
 */
export const MODEL_MIN_PX = 16;
export const MODEL_MAX_PX = 96;


/**
 * Whether an object can be drawn as a model at all.
 *
 * **A null heading disqualifies it.** The mesh is an oriented object: drawing
 * it means committing to a direction on screen, and there is no direction to
 * commit to. Pointing it north anyway would be exactly the kind of confident
 * wrong answer this project refuses elsewhere — it is why the sprite atlas has
 * a separate directionless disc for unknown headings (D40), and why the
 * backend distinguishes `null` from zero (D18). So an object with no heading
 * keeps its disc, and no model appears.
 */
export function canRenderModel(object: RenderableObject | null | undefined): boolean {
  return !!object && object.heading !== null;
}

/**
 * The model's wingspan in world units, given the distance from the camera **to
 * the model** — not to the globe's centre.
 *
 * Derived from the *sprite's* sizing model rather than invented, so selecting
 * an aircraft does not change how big it looks: same world size, same selected
 * multiplier, same per-airframe factor, only the clamps differ. World-anchored, so it grows on approach
 * exactly as the sprites around it do, until the ceiling binds.
 *
 * **The distinction is the whole bug this signature exists to prevent.** The
 * first version measured from the camera to the globe's centre, which is a fine
 * proxy while the camera is far away and completely wrong as it approaches: the
 * camera can be 0.2 units from an aircraft while still being 101 units from the
 * centre. The clamp then evaluates against a distance an order of magnitude too
 * large, never binds, and the model grows without limit — measured at 124 px at
 * a camera distance of 120 and filling the entire viewport at 105, against a
 * ceiling that is supposed to be 96 px (D43).
 *
 * The sprite shader never had this problem because `gl_PointSize` divides by
 * `-viewPosition.z`, which *is* the true view depth to the point. This function
 * now measures the same thing.
 */
export function modelSpanWorld(
  cameraToModelDistance: number,
  globeRadius: number,
  fovDegrees: number,
  viewportHeightPx: number,
  { min = MODEL_MIN_PX, max = MODEL_MAX_PX, airframeScale = 1 } = {},
): number {
  const perPixel = worldUnitsPerPixel(cameraToModelDistance, fovDegrees, viewportHeightPx);
  if (perPixel <= 0) return 0;
  // `airframeScale` goes in **before** the clamp, which is where the sprite
  // shader applies it too (`worldSize * sizeScale` is what gets clamped). After
  // the clamp it would let a widebody exceed the ceiling that exists to stop a
  // close approach filling the viewport.
  const world = MARKER_WORLD_SIZE * SELECTED_SIZE_MULTIPLIER * airframeScale * globeRadius;
  const px = Math.min(max, Math.max(min, world / perPixel));
  return px * perPixel;
}

/**
 * The orientation that puts the model's nose along the object's ground track.
 *
 * The local tangent frame is built exactly as the marker vertex shader builds
 * it — `up` from the position, `east` from the world Y axis, `north` from
 * their cross product — because the two must agree. If the sprite and the mesh
 * disagreed about which way is north, the aircraft would visibly snap to a new
 * heading at the instant it was selected, and that is the sort of mismatch
 * between two individually-correct pieces of code that has produced most of
 * this project's defects.
 *
 * The model is authored nose along +Z, wings along X, canopy along +Y, so the
 * basis is (right, up, forward) and `right = up x forward` keeps it
 * right-handed — a determinant of -1 here would mirror the airframe, which
 * looks entirely plausible and is entirely wrong (the same trap as the atlas's
 * `flipY`, D40).
 */
export function aircraftOrientation(
  lat: number,
  lon: number,
  headingDeg: number,
  target = new THREE.Quaternion(),
): THREE.Quaternion {
  const up = latLonToVector3(lat, lon, 1).normalize();

  // Degenerate exactly at the poles, where every direction is south (or north)
  // and "east" has no meaning. Any consistent choice will do; the aircraft is
  // one pixel from the pole and its heading is unmeasurable there anyway.
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  else east.normalize();

  const north = new THREE.Vector3().crossVectors(up, east);

  const heading = headingDeg * DEG_TO_RAD;
  const forward = north
    .clone()
    .multiplyScalar(Math.cos(heading))
    .addScaledVector(east, Math.sin(heading))
    .normalize();

  const right = new THREE.Vector3().crossVectors(up, forward);

  return target.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, forward),
  );
}

/**
 * Shading.
 *
 * Lit by a fixed key light **in view space** — a headlight that follows the
 * camera. That is precisely the mistake D41 spent a session fixing in the
 * globe shader, so it is worth saying why it is deliberate here: the globe is
 * a world object whose lighting *is* the information, because it shows where
 * the sun is. This is a selection indicator, and its job is to stay legible. A
 * selected aircraft over the night side lit by the real sun would be a black
 * mesh on a black ocean, and the user would think the click had failed.
 *
 * The ambient floor exists for the same reason: no face is ever fully unlit.
 */
const vertexShader = /* glsl */ `
  varying vec3 vNormalView;

  void main() {
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 tint;

  varying vec3 vNormalView;

  void main() {
    // Up and slightly over the viewer's shoulder, which is where a viewer
    // expects light to come from.
    vec3 key = normalize(vec3(0.35, 0.7, 0.62));
    float lambert = max(dot(normalize(vNormalView), key), 0.0);
    gl_FragColor = vec4(tint * (0.45 + 0.55 * lambert), 1.0);
  }
`;

export interface SelectedAircraftLayer {
  mesh: THREE.Mesh;
  /**
   * Place the model for this frame.
   *
   * Returns **the id whose sprite must now be hidden**, or null if no model is
   * being drawn — so the caller can feed it straight to `markers.setHidden()`
   * and the two layers cannot disagree about who is drawing what.
   */
  update(
    object: RenderableObject | null,
    nowMs: number,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): string | null;
  dispose(): void;
}

export function createSelectedAircraftLayer(globeRadius: number): SelectedAircraftLayer {
  const geometry = createAircraftGeometry();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      // White, matching the colour the marker layer already gives a selected
      // sprite, so the swap changes the shape and nothing else.
      tint: { value: new THREE.Color(1, 1, 1) },
    },
    vertexShader,
    fragmentShader,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'selected-aircraft';
  // Nothing is selected at startup, and an unplaced mesh at the origin would
  // sit inside the planet.
  mesh.visible = false;
  // Opaque and depth-tested, unlike the marker layer. That is why the far side
  // of the globe needs no horizon test here: the planet writes depth, so it
  // occludes the model for free, where a point sprite had to be culled by hand
  // (D34).

  function update(
    object: RenderableObject | null,
    nowMs: number,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): string | null {
    if (!object || !canRenderModel(object)) {
      mesh.visible = false;
      return null;
    }

    // The same interpolated position the sprite would have been drawn at, on
    // the same legibility shell. Not the aircraft's true altitude: 12 km is
    // 0.19 world units on a 100-unit globe, six times *below* the shell the
    // markers already float on, so a literal altitude would drop the model
    // into the surface texture at the moment of selection and make it jump.
    // Altitude is carried by colour, as it has been since D28.
    const { lat, lon } = positionAt(object, nowMs);
    mesh.position.copy(latLonToVector3(lat, lon, globeRadius * (1 + MARKER_ALTITUDE)));
    aircraftOrientation(lat, lon, object.heading as number, mesh.quaternion);
    // Position first, then size: the scale depends on how far the camera is
    // from *this model*, which cannot be known until it has been placed.
    mesh.scale.setScalar(
      modelSpanWorld(
        camera.position.distanceTo(mesh.position),
        globeRadius,
        camera.fov,
        viewportHeightPx,
        // The same factor the sprite beside it uses, so the aircraft does not
        // change size at the moment it is selected.
        { airframeScale: scaleFor(object.model) },
      ),
    );
    mesh.visible = true;
    return object.id;
  }

  return {
    mesh,
    update,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
