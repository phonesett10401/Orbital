/**
 * Satellites drawn at height, as a shell standing off the planet.
 *
 * This is the picture the globe renderer existed for, rebuilt on MapLibre after
 * that renderer was deleted (D96, D104, D105). It works because two things I
 * had assumed were obstacles were not:
 *
 * - **The planet view is a sphere, not a map.** `basemap.ts` sets
 *   `projection: { type: 'globe' }`, and a custom layer under it is handed a
 *   matrix that projects a *unit sphere* where a vertex is a direction from the
 *   centre and altitude is a radial scale (`modelFrame.ts` documents this from
 *   MapLibre's own vertex shader). So `shellFor`, which already returns globe
 *   radii above the surface, needs no conversion at all: the vertex is simply
 *   `up * (1 + shell)`.
 * - **The camera goes below zoom 0**, so the globe shrinks and leaves room for
 *   the shell around it. Phone established that in thirty seconds by dragging
 *   a zoom slider, after I had written a decision claiming otherwise.
 *
 * ## Why a custom layer and not symbols
 *
 * MapLibre's symbol and circle layers place features by longitude and latitude
 * and draw them on the surface. There is no `z`. Standing something off the
 * ground means putting geometry into MapLibre's own GL context, which is what
 * `modelLayer.ts` already does for the selected aircraft's mesh — this is the
 * same mechanism with a much larger lift and a thousand points instead of one.
 *
 * ## What it costs
 *
 * **Picking.** A symbol layer is hit-tested by MapLibre for free; a custom
 * layer is not. Clicking a satellite on the shell needs its own raycast, which
 * `pick()` here does in screen space against the same projected positions the
 * frame drew.
 */

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { regimeRgb, shellFor } from '../satelliteShell';
import type { RenderableObject } from '../types';
import { globeAxes, isOnNearSide, usesGlobeFrame } from './modelFrame';
import { ATLAS_CELLS, atlasCellFor, createSatelliteAtlasCanvas } from './satelliteSprite';

export const SHELL_LAYER = 'orbital-satellite-shell';

/**
 * Above this zoom the shell is not drawn and the ground symbols take over.
 *
 * The shell is a statement about the *whole* constellation, and it is only
 * legible while the whole planet is in frame. Zoomed into a country, satellites
 * standing 1.3 radii off the surface are far outside the viewport, so the
 * honest thing to draw is where they are over the ground instead (D97).
 */
export const SHELL_MAX_ZOOM = 3.2;

/**
 * Screen size of a satellite on the shell, in pixels.
 *
 * Bigger than a dot needs to be, because these are no longer dots: a
 * silhouette has to survive being drawn at this size or the family it names is
 * invisible and the shape is decoration (D101, D106). Ten pixels is about the
 * floor at which the one-panel constellation reads differently from the
 * two-panel navigation shape.
 */
const POINT_MIN_PX = 10.0;
const POINT_MAX_PX = 20.0;

/** How much bigger the selected one is drawn. */
const SELECTED_SCALE = 2.4;

const vertexShader = /* glsl */ `
  attribute vec3 tint;
  attribute float size;
  attribute float cell;

  varying vec3 vTint;
  varying float vCell;

  void main() {
    vTint = tint;
    vCell = cell;
    gl_Position = projectionMatrix * vec4(position, 1.0);
    gl_PointSize = size;
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D atlas;
  uniform float atlasCells;

  varying vec3 vTint;
  varying float vCell;

  void main() {
    // The silhouette for this satellite's family, out of the strip. Same
    // shapes the map's symbols draw, from the same table, so the two views
    // cannot disagree about what a navigation satellite looks like (D106).
    //
    // gl_PointCoord runs y-down, which is the canvas's own convention, so no
    // flip is needed here -- unlike the aircraft atlas, which is sampled from
    // a mesh and needed its flipY turned off for the same reason (D40).
    vec2 cellUv = gl_PointCoord;
    vec2 uv = vec2((cellUv.x + vCell) / atlasCells, cellUv.y);
    vec4 texel = texture2D(atlas, uv);
    if (texel.a < 0.08) discard;
    gl_FragColor = vec4(vTint * texel.rgb, texel.a);
  }
`;

export interface ShellRenderer {
  autoClear: boolean;
  resetState(): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
}

export interface ShellLayer extends CustomLayerInterface {
  /** How many satellites the last frame drew. Read by tests and the readout. */
  drawnCount(): number;
  /** One line for the dev readout saying what happened last frame. */
  describe(): string;
  /**
   * Which satellite is at this screen point, if any.
   *
   * A custom layer is not hit-tested by MapLibre, so this is the price of
   * drawing at height. It answers from the positions the **last frame**
   * projected, so what is clickable is exactly what is visible.
   */
  pick(x: number, y: number): string | null;
  dispose(): void;
}

/** Whether the shell is what should be drawn right now. */
export function shellIsLive(zoom: number, projectionTransition: number): boolean {
  return zoom <= SHELL_MAX_ZOOM && usesGlobeFrame(projectionTransition);
}

/**
 * Where a satellite sits in MapLibre's globe space.
 *
 * Pure, and exported because it is the whole of the geometry: everything else
 * in this file is buffers and GL state. `shellFor` returns globe radii above
 * the surface and the globe frame wants a radial scale from the centre, so the
 * conversion is one addition.
 */
export function shellPosition(
  lon: number,
  lat: number,
  altitudeM: number | null,
): [number, number, number] {
  const { up } = globeAxes(lon, lat);
  const radius = 1 + shellFor(altitudeM);
  return [up[0] * radius, up[1] * radius, up[2] * radius];
}

/**
 * The family silhouettes as one texture the point shader can sample.
 *
 * `flipY` is left at three's default here, unlike the aircraft atlas: this is
 * sampled with `gl_PointCoord`, which already runs y-down in canvas
 * orientation, so flipping would put the satellites upside down rather than
 * fixing them.
 */
function createAtlasTexture(): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(createSatelliteAtlasCanvas());
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  // The shader discards outside the shape, but a wrapped sample at a cell
  // boundary would still bleed the neighbouring family in.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function createShellLayer(
  getSatellites: () => { objects: RenderableObject[]; selectedId: string | null },
  createRenderer: (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) => ShellRenderer = (
    canvas,
    gl,
  ) => new THREE.WebGLRenderer({ canvas, context: gl }),
  capacity = 4096,
): ShellLayer {
  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;

  let allocated = capacity;
  let positions = new Float32Array(allocated * 3);
  let tints = new Float32Array(allocated * 3);
  let sizes = new Float32Array(allocated);
  let cells = new Float32Array(allocated);
  let ids: string[] = [];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('cell', new THREE.BufferAttribute(cells, 1));

  const atlas = createAtlasTexture();
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      atlas: { value: atlas },
      atlasCells: { value: ATLAS_CELLS },
    },
  });

  const points = new THREE.Points(geometry, material);
  points.matrixAutoUpdate = false;
  points.frustumCulled = false;
  scene.add(points);

  let renderer: ShellRenderer | null = null;
  let map: MapLibreMap | null = null;
  let drawn = 0;
  let status = 'never rendered';
  /** Last frame's clip-space positions, kept so `pick` can answer from them. */
  let projected: Array<{ id: string; x: number; y: number; size: number }> = [];

  function grow(needed: number): void {
    allocated = Math.max(needed, allocated * 2);
    positions = new Float32Array(allocated * 3);
    tints = new Float32Array(allocated * 3);
    sizes = new Float32Array(allocated);
    cells = new Float32Array(allocated);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('tint', new THREE.BufferAttribute(tints, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('cell', new THREE.BufferAttribute(cells, 1));
  }

  return {
    id: SHELL_LAYER,
    type: 'custom',
    renderingMode: '3d',

    onAdd(addedMap: MapLibreMap, gl: WebGL2RenderingContext) {
      map = addedMap;
      renderer = createRenderer(addedMap.getCanvas(), gl);
      renderer.autoClear = false;
    },

    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      drawn = 0;
      projected = [];
      if (!renderer || !map) {
        status = 'not added to a map';
        return;
      }

      const projection = args.defaultProjectionData;
      const zoom = map.getZoom();
      if (!shellIsLive(zoom, projection.projectionTransition)) {
        status = `not drawn - zoom ${zoom.toFixed(1)} is past ${SHELL_MAX_ZOOM}`;
        return;
      }

      const { objects, selectedId } = getSatellites();
      if (objects.length === 0) {
        status = 'no satellites';
        return;
      }
      if (objects.length > allocated) grow(objects.length);

      // Points shrink as the camera pulls back, so the shell reads as a cloud
      // of objects at world zoom and as distinct satellites close in, rather
      // than as a constant speckle at both.
      const spread = Math.min(1, Math.max(0, (zoom + 2) / (SHELL_MAX_ZOOM + 2)));
      const basePx = POINT_MIN_PX + (POINT_MAX_PX - POINT_MIN_PX) * spread;
      const pixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

      let behind = 0;
      for (const object of objects) {
        const position = shellPosition(object.renderLon, object.renderLat, object.altitude);
        // Occlusion. MapLibre's clipping plane cuts the far hemisphere at the
        // *surface* horizon, so testing an elevated point against it hides a
        // satellite slightly before the planet truly covers it. Conservative
        // in the right direction: a satellite that should be hidden never
        // shows through the Earth, which is the error that would look broken.
        if (!isOnNearSide(position, projection.clippingPlane)) {
          behind += 1;
          continue;
        }

        const selected = object.id === selectedId;
        const [r, g, b] = regimeRgb(object.altitude);

        positions[drawn * 3] = position[0];
        positions[drawn * 3 + 1] = position[1];
        positions[drawn * 3 + 2] = position[2];
        tints[drawn * 3] = selected ? 1 : r / 255;
        tints[drawn * 3 + 1] = selected ? 1 : g / 255;
        tints[drawn * 3 + 2] = selected ? 1 : b / 255;
        sizes[drawn] = basePx * pixelRatio * (selected ? SELECTED_SCALE : 1);
        cells[drawn] = atlasCellFor(object.label);
        ids[drawn] = object.id;
        drawn += 1;
      }

      geometry.setDrawRange(0, drawn);
      geometry.getAttribute('position').needsUpdate = true;
      geometry.getAttribute('tint').needsUpdate = true;
      geometry.getAttribute('size').needsUpdate = true;
      geometry.getAttribute('cell').needsUpdate = true;

      const matrix = Array.from(projection.mainMatrix);
      camera.projectionMatrix.fromArray(matrix);
      projected = projectAll(matrix, positions, sizes, ids, drawn, map);

      renderer.resetState();
      renderer.render(scene, camera);
      status = `drawing - ${drawn} on the shell, ${behind} behind the planet`;
    },

    onRemove() {
      map = null;
    },

    drawnCount() {
      return drawn;
    },

    describe() {
      return status;
    },

    pick(x: number, y: number) {
      let best: string | null = null;
      let bestDistance = Infinity;
      for (const candidate of projected) {
        // Half the drawn size, with a floor: a 3 px dot is unclickable at its
        // own radius, and defect #5 was exactly this - a tolerance so tight
        // that clicking a marker did nothing.
        const tolerance = Math.max(candidate.size / 2, 8);
        const distance = Math.hypot(candidate.x - x, candidate.y - y);
        if (distance <= tolerance && distance < bestDistance) {
          best = candidate.id;
          bestDistance = distance;
        }
      }
      return best;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      atlas.dispose();
      renderer = null;
    },
  };
}

/**
 * Project the drawn points to screen pixels, for `pick`.
 *
 * Done once per frame rather than per click so a click answers from exactly
 * what the last frame drew — the alternative is re-deriving positions at click
 * time and having the two disagree about where a moving object was.
 */
function projectAll(
  matrix: number[],
  positions: Float32Array,
  sizes: Float32Array,
  ids: string[],
  count: number,
  map: MapLibreMap,
): Array<{ id: string; x: number; y: number; size: number }> {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const out: Array<{ id: string; x: number; y: number; size: number }> = [];

  for (let i = 0; i < count; i += 1) {
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    const clipX = matrix[0] * px + matrix[4] * py + matrix[8] * pz + matrix[12];
    const clipY = matrix[1] * px + matrix[5] * py + matrix[9] * pz + matrix[13];
    const clipW = matrix[3] * px + matrix[7] * py + matrix[11] * pz + matrix[15];
    if (clipW <= 0) continue; // behind the camera
    out.push({
      id: ids[i],
      x: ((clipX / clipW) * 0.5 + 0.5) * width,
      y: (1 - ((clipY / clipW) * 0.5 + 0.5)) * height,
      size: sizes[i],
    });
  }
  return out;
}
