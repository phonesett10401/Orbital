/**
 * The solar system, drawn around the Earth MapLibre is already drawing.
 *
 * A custom layer in MapLibre's own GL context, exactly like
 * `satelliteShellLayer` and for the reason D123 found: the renderer already
 * here reaches about 20 globe radii, and the compressed system needs 18. There
 * is no second renderer and no crossfade.
 *
 * Everything about *where* is in `solarFrame.ts`, everything about *how big*
 * is in `solarScale.ts`, and neither imports MapLibre. This file is the part
 * that cannot be tested without a GPU, so it is kept as small as that allows.
 *
 * ## When it draws
 *
 * Only when the globe is small enough to have room around it. The satellite
 * shell owns 2.4 radii out to zoom 3.2; this owns everything beyond, and below
 * `SOLAR_MAX_ZOOM` the planets appear. Both can be on screen at once, which is
 * the point - the shell is the near neighbourhood and this is the rest.
 */

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { BODIES } from '../bodies';
import { orbitRing, scenePlacements } from '../solarFrame';
import { bodyRadiusFor, globeRadiiFor } from '../solarScale';
import { PLANET_IDS, type PlanetId } from '../planets';
import { usesGlobeFrame } from './modelFrame';

export const SOLAR_LAYER = 'orbital-solar-system';

/**
 * Above this zoom the system is not drawn.
 *
 * At zoom 0 the globe is 78 px and 18 radii would be 1,400 px off-screen; the
 * planets only have somewhere to be once the globe is small. Below this they
 * fade in, so the transition is a dissolve rather than an appearance.
 */
export const SOLAR_MAX_ZOOM = 0.5;
export const SOLAR_FULL_ZOOM = -1.0;

/** Colours by body, matching the picker's dots so the two agree. */
const COLOURS: Record<string, number> = {
  sun: 0xffd166, mercury: 0x9c8b7d, venus: 0xe6c884, mars: 0xd1603d,
  jupiter: 0xd7a06a, saturn: 0xe3cfa0, uranus: 0x9fd8e0, neptune: 0x6b8fd6,
};

export interface SolarLayer extends CustomLayerInterface {
  /** Whether the last frame drew anything, for the status readout. */
  report(): string;
}

function radiusKmOf(id: string): number {
  return BODIES.find((b) => b.id === id)?.radiusKm ?? 1_000;
}

export function createSolarSystemLayer(now: () => Date): SolarLayer {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  let renderer: THREE.WebGLRenderer | null = null;
  // The map itself, because the zoom is **not** in the render arguments.
  // Reading `args.zoom` with a `?? 0` fallback silently supplied a constant:
  // the layer drew at every zoom and its fade sat at 0.33 forever, which looked
  // like a working feature rather than a missing one (D125).
  let host: MapLibreMap | null = null;
  let status = 'not drawn yet';

  // Orbit paths change only over months, so they are built once and reused.
  // Rebuilding 96 propagations per planet per frame would be the whole budget.
  const orbits = new THREE.Group();
  const bodies = new THREE.Group();
  scene.add(orbits, bodies);

  const spheres = new Map<string, THREE.Mesh>();
  let orbitsBuiltFor = 0;

  const buildOrbits = (date: Date) => {
    orbits.clear();
    for (const planet of PLANET_IDS) {
      if (planet === 'earth') continue;
      const points = orbitRing(planet, date, 96).map((p) => new THREE.Vector3(...p));
      orbits.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: COLOURS[planet] ?? 0x8899aa,
            transparent: true,
            opacity: 0.28,
          }),
        ),
      );
    }
    orbitsBuiltFor = date.getTime();
  };

  const sphereFor = (id: string): THREE.Mesh => {
    let mesh = spheres.get(id);
    if (!mesh) {
      // Radius from `solarScale`, in the same unit as the orbit distances -
      // which is the units fix D122 made, and why no conversion appears here.
      const r = globeRadiiFor(bodyRadiusFor(radiusKmOf(id)));
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 16, 12),
        new THREE.MeshBasicMaterial({ color: COLOURS[id] ?? 0xaaaaaa, transparent: true }),
      );
      spheres.set(id, mesh);
      bodies.add(mesh);
    }
    return mesh;
  };

  return {
    id: SOLAR_LAYER,
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

    render(_gl: WebGLRenderingContext, args: CustomRenderMethodInput) {
      if (!renderer) return;
      const matrix = args.defaultProjectionData?.mainMatrix;
      const transition = args.defaultProjectionData?.projectionTransition ?? 1;
      const zoom = host?.getZoom();
      if (zoom === undefined) return;

      if (!matrix || !usesGlobeFrame(transition) || zoom > SOLAR_MAX_ZOOM) {
        status = `not drawn - zoom ${zoom.toFixed(1)} past ${SOLAR_MAX_ZOOM}`;
        return;
      }

      // A dissolve rather than an appearance: the planets are faint at the
      // handover and solid once the globe is small.
      const fade = Math.min(
        1,
        Math.max(0, (SOLAR_MAX_ZOOM - zoom) / (SOLAR_MAX_ZOOM - SOLAR_FULL_ZOOM)),
      );

      const date = now();
      if (Math.abs(date.getTime() - orbitsBuiltFor) > 86_400_000) buildOrbits(date);

      const placements = scenePlacements(date);
      for (const placement of placements) {
        const mesh = sphereFor(placement.id);
        mesh.position.set(...placement.at);
        (mesh.material as THREE.MeshBasicMaterial).opacity = fade;
      }
      orbits.children.forEach((line) => {
        ((line as THREE.Line).material as THREE.LineBasicMaterial).opacity = 0.28 * fade;
      });

      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
      renderer.resetState();
      renderer.render(scene, camera);
      status = `${placements.length} bodies, fade ${fade.toFixed(2)}`;
    },

    report() {
      return status;
    },
  };
}

/** Exported for the readout and for tests that need the zoom rule. */
export function solarIsLive(zoom: number, projectionTransition: number): boolean {
  return zoom <= SOLAR_MAX_ZOOM && usesGlobeFrame(projectionTransition);
}

export type { PlanetId };
