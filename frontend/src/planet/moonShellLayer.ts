/**
 * The lunar spacecraft, drawn at the height they actually orbit at (D136).
 *
 * A custom layer for the same reason the satellite shell is one: MapLibre draws
 * symbols on the surface, and these are not on the surface. `moonShell.ts`
 * carries the geometry and the reason it needs no compression; this is the part
 * that cannot be tested without a GPU, so it stays as small as that allows.
 *
 * Each craft is drawn twice on purpose:
 *
 * - a **tether** from the sub-point on the surface up to the spacecraft, which
 *   is what makes the height legible at all - without it a marker three pixels
 *   above the limb reads as a marker *on* the limb;
 * - the **spacecraft** itself at the top of it.
 *
 * MapLibre keeps the label and the sub-point dot, because text belongs to the
 * layer that can lay text out without overlapping.
 */

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import type { MoonSatellite } from '../moonSatellites';
import { shellRadiusFor } from '../moonShell';
import { isOnNearSide, sphereVector, usesGlobeFrame } from './modelFrame';

export const MOON_SHELL_LAYER = 'orbital-moon-shell';

/** Warm against the Moon's grey, matching the sub-point markers. */
const CRAFT_COLOUR = 0xffd166;
const TETHER_COLOUR = 0xffd166;

export interface MoonShellLayer extends CustomLayerInterface {
  setCraft(craft: MoonSatellite[]): void;
  /**
   * Which spacecraft is at this screen point, if any.
   *
   * A custom layer is not hit-tested by MapLibre, so this is the price of
   * drawing at height - the same bargain the satellite shell made. It answers
   * from what the last frame projected, so what is clickable is what is
   * visible.
   */
  pick(x: number, y: number): string | null;
  drawnCount(): number;
}

/** Where a craft sits in globe space: its sub-point direction, at its radius. */
export function craftPosition(craft: MoonSatellite): [number, number, number] {
  const [x, y, z] = sphereVector(craft.lon, craft.lat);
  const r = shellRadiusFor(craft.altitudeKm);
  return [x * r, y * r, z * r];
}

export function createMoonShellLayer(): MoonShellLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let renderer: THREE.WebGLRenderer | null = null;
  let host: MapLibreMap | null = null;
  let craft: MoonSatellite[] = [];
  let drawn = 0;

  // Where each craft landed on screen last frame, for picking.
  const projected = new Map<string, { x: number; y: number }>();

  const group = new THREE.Group();
  scene.add(group);

  const build = () => {
    group.clear();
    for (const one of craft) {
      const at = craftPosition(one);
      const surface = sphereVector(one.lon, one.lat);

      const tether = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(...surface),
          new THREE.Vector3(...at),
        ]),
        new THREE.LineBasicMaterial({
          color: TETHER_COLOUR,
          transparent: true,
          opacity: 0.55,
        }),
      );
      tether.frustumCulled = false;
      group.add(tether);

      // Small: at this altitude the marker must not be taller than the height
      // it is marking, or the height stops being readable.
      const body = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 12, 10),
        new THREE.MeshBasicMaterial({ color: CRAFT_COLOUR }),
      );
      body.position.set(...at);
      body.frustumCulled = false;
      group.add(body);
    }
  };

  return {
    id: MOON_SHELL_LAYER,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: MapLibreMap, gl: WebGLRenderingContext) {
      host = map;
      renderer = new THREE.WebGLRenderer({
        canvas: (gl as unknown as { canvas: HTMLCanvasElement }).canvas,
        context: gl as unknown as WebGLRenderingContext,
        antialias: true,
      });
      renderer.autoClear = false;
    },

    setCraft(next: MoonSatellite[]) {
      craft = next;
      build();
    },

    render(_gl: WebGLRenderingContext, args: CustomRenderMethodInput) {
      if (!renderer || !host) return;
      const matrix = args.defaultProjectionData?.mainMatrix;
      const transition = args.defaultProjectionData?.projectionTransition ?? 1;
      projected.clear();
      drawn = 0;
      if (!matrix || !usesGlobeFrame(transition) || craft.length === 0) return;

      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
      renderer.resetState();
      renderer.render(scene, camera);

      // Project for picking, and count only what is on the near side - the far
      // half is behind the Moon and must not be clickable through it.
      const plane = args.defaultProjectionData?.clippingPlane;
      for (const one of craft) {
        if (plane && !isOnNearSide(craftPosition(one), plane)) continue;
        const point = host.project([one.lon, one.lat]);
        projected.set(one.id, { x: point.x, y: point.y });
        drawn += 1;
      }
    },

    pick(x: number, y: number): string | null {
      let best: string | null = null;
      let bestDistance = 18;
      for (const [id, point] of projected) {
        const distance = Math.hypot(point.x - x, point.y - y);
        if (distance < bestDistance) {
          best = id;
          bestDistance = distance;
        }
      }
      return best;
    },

    drawnCount() {
      return drawn;
    },
  };
}
