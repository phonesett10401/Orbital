/**
 * The marker layer: every tracked object drawn in a single GPU call.
 *
 * Globe.gl's convenient `pointsData()` API creates one mesh per point. At two
 * thousand markers that is two thousand draw calls, and the frame rate dies.
 * So this layer bypasses it: one `THREE.Points`, one `BufferGeometry`, and
 * per-frame writes into typed arrays that are already allocated (D15).
 *
 * Markers are aircraft silhouettes rotated to their direction of travel, not
 * dots. Point sprites are always screen-aligned, so the rotation is done by
 * turning the *texture lookup* inside the sprite — which keeps everything in
 * one draw call. Working out which way "along the heading" points on screen is
 * the interesting part; see the vertex shader (D40).
 *
 * Kept separate from the visual layer (globe/earth.ts) so rendering cost stays
 * attributable when we profile (D16).
 */

import * as THREE from 'three';

import type { RenderableObject } from '../types';
import { ATLAS_CELLS, SPRITE_AIRCRAFT, SPRITE_UNKNOWN, createMarkerAtlas } from './aircraftSprite';
import { STALE_AFTER_SECONDS, ageSeconds, positionAt } from './interpolate';
import { latLonToVector3 } from './earth';
import { scaleFor } from '../wingspan';

/** Objects older than this are drawn muted, with their age shown on selection. */
export { STALE_AFTER_SECONDS };

/**
 * Click tolerance, in screen pixels.
 *
 * Deliberately larger than the sprite at most zooms. A target you must hit
 * within its own radius is not a target — and these targets move.
 *
 * The important part is the unit: **pixels, not world units**. The original
 * threshold was a fixed fraction of the globe radius, so tolerance shrank as
 * the camera pulled back — about 4 px at default zoom and barely 1 px when
 * zoomed out, which is why clicking appeared to do nothing at all (D34).
 */
export const PICK_RADIUS_PX = 12;

/**
 * How far above the surface markers float, as a fraction of globe radius.
 *
 * Not physical: a cruising airliner is 0.2% of Earth's radius up, which would
 * put the marker inside the surface texture. This is a legibility offset, and
 * it is uniform so that altitude is conveyed by colour rather than by height
 * (which would be invisible anyway).
 */
export const MARKER_ALTITUDE = 0.012;

/**
 * Sprite size as a fraction of globe radius — a *world* size, not a screen size.
 *
 * This is what makes zooming in read as terrain with aircraft over it rather
 * than a dot map that never changes: the sprite is anchored to the ground, so
 * it grows as the camera descends.
 *
 * Calibrated, not guessed. Across the reachable camera range (1.005 R to 8 R,
 * set by the orbit controls) 0.04 R gives roughly:
 *
 * | camera distance | sprite |
 * |---|---|
 * | 800 (fully out) | 4 px, raised to the 5 px floor |
 * | 320 (default) | 10 px — silhouette becomes readable |
 * | 200 | 15 px |
 * | 100.5 (closest) | 31 px |
 *
 * An earlier value of 0.02 R was too small: it fell under the floor almost
 * immediately past the default zoom, so most of the range was fixed-size and
 * the scaling did nothing.
 *
 * Not physical — a real airliner at this scale is far under a pixel, so the
 * sprite is exaggerated several hundredfold. It is the size at which a
 * silhouette becomes readable, which is the only thing it can usefully be.
 */
export const MARKER_WORLD_SIZE = 0.04;

/**
 * Screen-size clamps, in CSS pixels.
 *
 * The lower bound keeps markers visible and clickable when zoomed out, where
 * the world-anchored size would fall below two pixels. The upper bound stops a
 * close approach producing sprites that swamp the terrain under them.
 */
export const MIN_MARKER_PX = 5;
export const MAX_MARKER_PX = 44;

/** Selected markers are drawn larger so the selection is unmistakable. */
export const SELECTED_SIZE_MULTIPLIER = 1.8;

/**
 * Vertex shader.
 *
 * Two jobs beyond placing the point.
 *
 * **Screen-space heading.** `heading` is a compass bearing on the globe
 * surface, but a point sprite is a screen-aligned square. To draw the
 * silhouette pointing along its ground track *as the viewer sees it*, we build
 * the heading as a world vector from the local north/east tangent frame,
 * project both the aircraft and a point slightly along that vector into clip
 * space, and take the angle between them on screen. Aspect correction matters:
 * clip space spans [-1,1] on both axes regardless of the viewport shape, so
 * without it every aircraft would appear to fly slightly sideways on a
 * non-square canvas.
 *
 * **World-anchored sizing.** `gl_PointSize` is in device pixels, so a constant
 * value is a constant *screen* size. Dividing a world size by the view distance
 * gives the opposite: a size anchored to the ground that grows on approach.
 * The clamps then bound it at both ends.
 */
const vertexShader = /* glsl */ `
  attribute vec3 markerColor;
  attribute float heading;      // radians, clockwise from true north
  attribute float spriteIndex;  // 0 = airframe, 1 = unknown heading
  attribute float sizeScale;
  attribute float dimmed;

  uniform float pixelsPerWorldUnit;  // viewportHeight / (2 tan(fov/2))
  uniform float aspect;              // width / height
  uniform vec2 sizeClampPx;          // (min, max), device pixels
  uniform float worldSize;

  varying vec3 vColor;
  varying float vDimmed;
  varying float vRotation;
  varying float vSprite;

  void main() {
    vColor = markerColor;
    vDimmed = dimmed;
    vSprite = spriteIndex;

    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewPosition;

    // --- world-anchored size, clamped in screen pixels ---
    float distance = max(-viewPosition.z, 0.001);
    float px = worldSize * sizeScale * pixelsPerWorldUnit / distance;
    gl_PointSize = clamp(px, sizeClampPx.x, sizeClampPx.y);

    // --- direction of travel, in screen space ---
    // Local tangent frame at this point on the sphere. The globe is centred on
    // the origin, so the surface normal is just the normalised position.
    vec3 up = normalize(position);
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), up));
    vec3 north = cross(up, east);
    vec3 travel = north * cos(heading) + east * sin(heading);

    // Project a short step along the heading and measure the on-screen angle.
    // The step is scaled by distance so it stays numerically well-conditioned
    // at every zoom level.
    // Named 'reach' rather than 'step' because step() is a GLSL builtin and
    // shadowing it, while legal, is a trap for the next reader.
    float reach = distance * 0.002;
    vec4 ahead = projectionMatrix * modelViewMatrix * vec4(position + travel * reach, 1.0);
    vec2 here = gl_Position.xy / max(gl_Position.w, 1e-6);
    vec2 there = ahead.xy / max(ahead.w, 1e-6);
    vec2 delta = (there - here) * vec2(aspect, 1.0);

    vRotation = length(delta) > 1e-9 ? atan(delta.y, delta.x) : 1.5707963;
  }
`;

/**
 * Fragment shader.
 *
 * Rotates the sprite's texture lookup so the nose points along `vRotation`,
 * then samples one cell of the atlas. `gl_PointCoord` has its origin at the
 * top left with y increasing downward, so it is flipped into a conventional
 * maths frame before rotating and flipped back afterwards — getting this wrong
 * mirrors every aircraft, which looks plausible and is completely wrong.
 *
 * Samples that rotate outside the cell are discarded rather than clamped,
 * because a clamped sample smears the cell edge outward into a halo.
 */
const fragmentShader = /* glsl */ `
  uniform sampler2D atlas;
  uniform float atlasCells;

  varying vec3 vColor;
  varying float vDimmed;
  varying float vRotation;
  varying float vSprite;

  void main() {
    // Centre on the sprite and flip to y-up.
    vec2 local = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);

    // The silhouette is drawn nose-up, i.e. already pointing at 90 degrees.
    float turn = vRotation - 1.5707963;
    float c = cos(-turn);
    float s = sin(-turn);
    vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);

    if (abs(rotated.x) > 0.5 || abs(rotated.y) > 0.5) discard;

    // Back to texture space (y-down), then into the atlas cell.
    vec2 cellUv = vec2(rotated.x + 0.5, 0.5 - rotated.y);
    vec2 atlasUv = vec2((cellUv.x + vSprite) / atlasCells, cellUv.y);

    vec4 texel = texture2D(atlas, atlasUv);
    if (texel.a < 0.02) discard;

    // The atlas is white with a dark outline; multiplying by the altitude
    // colour tints the body and leaves the outline as a shaded edge (D28).
    float alpha = texel.a * (vDimmed > 0.5 ? 0.45 : 1.0);
    gl_FragColor = vec4(vColor * texel.rgb, alpha);
  }
`;

/**
 * Colour by altitude: low is warm, cruising is cool.
 *
 * Altitude cannot be shown by height at this scale (see MARKER_ALTITUDE), so
 * it is shown by hue instead. Unknown altitude gets its own neutral grey
 * rather than defaulting into the low-altitude band, because `null` means
 * unknown and must not read as "on the ground".
 */
export function altitudeColor(altitude: number | null): [number, number, number] {
  if (altitude === null) return [0.62, 0.62, 0.68];

  const t = Math.min(1, Math.max(0, altitude / 12000));
  // amber (low) -> yellow-green -> cyan (high)
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [1.0, 0.55, 0.2]],
    [0.5, [0.95, 0.9, 0.35]],
    [1.0, [0.35, 0.85, 1.0]],
  ];

  for (let i = 0; i < stops.length - 1; i += 1) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const local = (t - t0) / (t1 - t0);
      return [
        c0[0] + (c1[0] - c0[0]) * local,
        c0[1] + (c1[1] - c0[1]) * local,
        c0[2] + (c1[2] - c0[2]) * local,
      ];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * World-space size of one screen pixel at a given distance from the camera.
 *
 * A perspective camera's visible height at distance `d` is `2 d tan(fov/2)`;
 * dividing by the viewport height in pixels gives world units per pixel. This
 * converts between the two units the layer works in: tolerances and clamps are
 * expressed in pixels, because that is how a user experiences them, while
 * sprite size and pick thresholds have to reach the GPU and the raycaster in
 * world units.
 */
export function worldUnitsPerPixel(
  cameraDistance: number,
  fovDegrees: number,
  viewportHeightPx: number,
): number {
  if (viewportHeightPx <= 0) return 0;
  const visibleHeight = 2 * cameraDistance * Math.tan((fovDegrees * Math.PI) / 360);
  return visibleHeight / viewportHeightPx;
}

/**
 * The sprite's on-screen size in CSS pixels at a given camera distance.
 *
 * Exposed so the sizing model can be asserted directly rather than inferred
 * from what the shader happens to do.
 */
export function markerPixelSize(
  cameraDistance: number,
  globeRadius: number,
  fovDegrees: number,
  viewportHeightPx: number,
  { min = MIN_MARKER_PX, max = MAX_MARKER_PX } = {},
): number {
  const perPixel = worldUnitsPerPixel(cameraDistance, fovDegrees, viewportHeightPx);
  if (perPixel <= 0) return min;
  const world = MARKER_WORLD_SIZE * globeRadius;
  return Math.min(max, Math.max(min, world / perPixel));
}

/** Which atlas cell an object should use. */
export function spriteFor(object: { heading: number | null }): number {
  return object.heading === null ? SPRITE_UNKNOWN : SPRITE_AIRCRAFT;
}

export interface MarkerLayer {
  points: THREE.Points;
  /**
   * Rewrite the buffers for this frame. Allocates nothing in the steady state.
   *
   * `version` should increment whenever the *set* of objects changes — the
   * store's `objectsVersion` does exactly that. It lets the layer skip
   * rewriting the attributes that only change once per poll.
   */
  update(
    objects: RenderableObject[],
    nowMs: number,
    selectedId: string | null,
    version?: number,
  ): void;
  /** Tell the layer the viewport changed, so sizing stays correct. */
  setViewport(widthPx: number, heightPx: number, fovDegrees: number, pixelRatio: number): void;
  /** Which object is under the pointer, if any. */
  pick(
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): string | null;
  /** Hide one object's sprite, e.g. while a 3D model stands in for it. */
  setHidden(id: string | null): void;
  dispose(): void;
}

export function createMarkerLayer(globeRadius: number, capacity = 4096): MarkerLayer {
  let allocated = capacity;

  let positions = new Float32Array(allocated * 3);
  let colors = new Float32Array(allocated * 3);
  let headings = new Float32Array(allocated);
  let sprites = new Float32Array(allocated);
  let sizes = new Float32Array(allocated);
  let dimmed = new Float32Array(allocated);
  let ids: string[] = [];
  let hiddenId: string | null = null;

  const geometry = new THREE.BufferGeometry();
  const bind = () => {
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('markerColor', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('heading', new THREE.BufferAttribute(headings, 1));
    geometry.setAttribute('spriteIndex', new THREE.BufferAttribute(sprites, 1));
    geometry.setAttribute('sizeScale', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('dimmed', new THREE.BufferAttribute(dimmed, 1));
  };
  bind();

  const atlas = createMarkerAtlas();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      atlas: { value: atlas },
      atlasCells: { value: ATLAS_CELLS },
      pixelsPerWorldUnit: { value: 772 },
      aspect: { value: 16 / 9 },
      sizeClampPx: { value: new THREE.Vector2(MIN_MARKER_PX, MAX_MARKER_PX) },
      worldSize: { value: MARKER_WORLD_SIZE * globeRadius },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'markers';
  // Set explicitly rather than left for three to compute lazily. Markers all
  // sit on a shell just above the surface, so this sphere is exact and never
  // needs recomputing — and computing it from the buffer would be wrong
  // anyway, since unused capacity beyond the draw range is still (0, 0, 0).
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    globeRadius * (1 + MARKER_ALTITUDE) * 1.01,
  );
  // Frustum culling is off because the layer is effectively always on screen,
  // and its contents move every frame.
  points.frustumCulled = false;
  // Nothing is drawn until the first update(). Without this the default draw
  // range is the entire allocated buffer, so any render that happens before the
  // first update paints several thousand markers stacked at the globe's centre.
  // The animation loop and globe.gl's render loop are independent, so that
  // ordering is not guaranteed.
  geometry.setDrawRange(0, 0);

  function setViewport(
    widthPx: number,
    heightPx: number,
    fovDegrees: number,
    pixelRatio: number,
  ): void {
    if (heightPx <= 0) return;
    const devicePixels = heightPx * pixelRatio;
    material.uniforms.pixelsPerWorldUnit.value =
      devicePixels / (2 * Math.tan((fovDegrees * Math.PI) / 360));
    material.uniforms.aspect.value = widthPx / heightPx;

    // gl_PointSize is in device pixels, so the CSS-pixel clamps scale with the
    // display. Also bounded by what the GPU will actually accept -- the point
    // size range is 1..1024 on this machine but is far lower on some.
    material.uniforms.sizeClampPx.value.set(
      MIN_MARKER_PX * pixelRatio,
      MAX_MARKER_PX * pixelRatio,
    );
  }

  function grow(required: number): void {
    while (allocated < required) allocated *= 2;
    positions = new Float32Array(allocated * 3);
    colors = new Float32Array(allocated * 3);
    headings = new Float32Array(allocated);
    sprites = new Float32Array(allocated);
    sizes = new Float32Array(allocated);
    dimmed = new Float32Array(allocated);
    bind();
  }

  const DEG_TO_RAD = Math.PI / 180;
  let lastStyleKey: string | null = null;

  /**
   * Only **position** genuinely changes every frame — interpolation moves the
   * markers continuously. Colour, heading, sprite cell, size and the stale flag
   * change at most once per poll, or when the selection changes, or when an
   * object crosses the staleness threshold.
   *
   * Writing all six attributes at 60 Hz cost 1.05 ms per update at 2,000
   * markers, against 0.82 ms for the plain dots that preceded them. Splitting
   * them by how often they actually change brings it back under the old figure
   * while drawing considerably more (D40).
   *
   * The staleness term is bucketed to whole seconds, so a style rewrite happens
   * about once a second in the steady state rather than never — which is what
   * lets a marker fade without waiting for the next poll.
   */
  function update(
    objects: RenderableObject[],
    nowMs: number,
    selectedId: string | null,
    version = 0,
  ): void {
    if (objects.length > allocated) grow(objects.length);

    const styleKey = `${version}|${objects.length}|${selectedId ?? ''}|${hiddenId ?? ''}|${Math.floor(nowMs / 1000)}`;
    const rewriteStyle = styleKey !== lastStyleKey;
    if (rewriteStyle) {
      lastStyleKey = styleKey;
      if (ids.length !== objects.length) ids = new Array(objects.length);
    }

    const radius = globeRadius * (1 + MARKER_ALTITUDE);
    let drawn = 0;

    for (let i = 0; i < objects.length; i += 1) {
      const object = objects[i];
      if (object.id === hiddenId) continue;

      const { lat, lon } = positionAt(object, nowMs);
      const vector = latLonToVector3(lat, lon, radius);

      positions[drawn * 3] = vector.x;
      positions[drawn * 3 + 1] = vector.y;
      positions[drawn * 3 + 2] = vector.z;

      if (rewriteStyle) {
        const stale = ageSeconds(object, nowMs) > STALE_AFTER_SECONDS;
        const selected = object.id === selectedId;

        const [r, g, b] = selected ? [1, 1, 1] : altitudeColor(object.altitude);
        colors[drawn * 3] = r;
        colors[drawn * 3 + 1] = g;
        colors[drawn * 3 + 2] = b;

        // An unknown heading draws the disc, which has no direction to convey.
        // Rotating it is harmless, so no branch is needed in the shader.
        headings[drawn] = object.heading === null ? 0 : object.heading * DEG_TO_RAD;
        sprites[drawn] = object.heading === null ? SPRITE_UNKNOWN : SPRITE_AIRCRAFT;

        // Selection still overrides everything: which aircraft is selected
        // matters more than what kind it is. Otherwise the size comes from
        // the airframe, so the two views agree about how big a 787 is.
        sizes[drawn] = selected ? SELECTED_SIZE_MULTIPLIER : scaleFor(object.model);
        // Stale objects keep their marker rather than disappearing — an aircraft
        // that stopped reporting has not stopped existing — but they are muted
        // so they cannot be mistaken for live traffic.
        dimmed[drawn] = stale && !selected ? 1 : 0;

        ids[drawn] = object.id;
      }

      drawn += 1;
    }

    geometry.setDrawRange(0, drawn);
    geometry.attributes.position.needsUpdate = true;

    if (rewriteStyle) {
      if (ids.length !== drawn) ids.length = drawn;
      geometry.attributes.markerColor.needsUpdate = true;
      geometry.attributes.heading.needsUpdate = true;
      geometry.attributes.spriteIndex.needsUpdate = true;
      geometry.attributes.sizeScale.needsUpdate = true;
      geometry.attributes.dimmed.needsUpdate = true;
    }
  }

  function pick(
    raycaster: THREE.Raycaster,
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ): string | null {
    // Points raycasting needs an explicit threshold, expressed in world units.
    // Deriving it from a pixel radius keeps the click target the same physical
    // size on screen at every zoom level.
    //
    // The tolerance is the larger of the fixed pick radius and half the sprite,
    // so that a sprite drawn bigger than the tolerance never has an unclickable
    // margin — which is exactly the class of mismatch that made clicking fail
    // before (D34).
    const cameraDistance = camera.position.length();
    const perPixel = worldUnitsPerPixel(cameraDistance, camera.fov, viewportHeightPx);
    const spritePx = markerPixelSize(
      cameraDistance,
      globeRadius,
      camera.fov,
      viewportHeightPx,
    );
    raycaster.params.Points.threshold = Math.max(PICK_RADIUS_PX, spritePx * 0.5) * perPixel;

    const hits = raycaster.intersectObject(points, false);
    if (hits.length === 0) return null;

    // A marker on the far side of the globe is hidden behind the planet, but
    // the raycaster has no idea the planet is there. Without this test a
    // generous threshold happily selects an aircraft over Australia while the
    // user is clicking one over Spain. A point P is on the visible side when
    // P . C >= r^2, which is exactly the horizon condition.
    const horizon = globeRadius * globeRadius;
    const camPos = camera.position;

    let bestId: string | null = null;
    let bestDistanceToRay = Infinity;

    for (const hit of hits) {
      const index = hit.index;
      if (index === undefined || index >= ids.length) continue;

      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z = positions[index * 3 + 2];
      if (x * camPos.x + y * camPos.y + z * camPos.z < horizon) continue;

      // Prefer the marker nearest the cursor rather than the nearest along the
      // ray. With a generous tolerance several markers can qualify, and the one
      // the user aimed at is the closest to where they clicked.
      const distanceToRay = hit.distanceToRay ?? 0;
      if (distanceToRay < bestDistanceToRay) {
        bestDistanceToRay = distanceToRay;
        bestId = ids[index];
      }
    }

    return bestId;
  }

  function setHidden(id: string | null): void {
    hiddenId = id;
  }

  return {
    points,
    update,
    setViewport,
    pick,
    setHidden,
    dispose() {
      geometry.dispose();
      material.dispose();
      atlas.dispose();
    },
  };
}
