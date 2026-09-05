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
import { equatorialToGlobe, orbitRing, scenePlacements } from '../solarFrame';
import { bodyRadiusFor, globeRadiiFor } from '../solarScale';
import { PLANET_IDS, type PlanetId } from '../planets';
import { usesGlobeFrame } from './modelFrame';
import {
  STARS,
  STAR_COUNT,
  STAR_SPHERE_RADII,
  starColour,
  starDirection,
  starSize,
} from '../stars';

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

export function createSolarSystemLayer(
  now: () => Date,
  destination: () => string | null = () => null,
  origin: () => PlanetId = () => 'earth',
): SolarLayer {
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

  /**
   * The sky, built once and rotated per frame.
   *
   * 5,070 real stars. Depth testing is off and the render order is negative,
   * so they are a backdrop rather than geometry: MapLibre's far plane cuts
   * everything past about 20 radii, which is exactly the half of a surrounding
   * sphere a backdrop would need, so the points sit near instead and simply
   * never occlude (D128).
   */
  const starGeometry = new THREE.BufferGeometry();
  const starPositions = new Float32Array(STAR_COUNT * 3);
  const starColours = new Float32Array(STAR_COUNT * 3);
  const starSizes = new Float32Array(STAR_COUNT);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const [r, g, b] = starColour(STARS.ci[i]);
    starColours[i * 3] = r;
    starColours[i * 3 + 1] = g;
    starColours[i * 3 + 2] = b;
    starSizes[i] = starSize(STARS.mag[i]);
  }
  starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(starColours, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      vertexColors: true,
      size: 0.06,
      sizeAttenuation: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  stars.renderOrder = -1;

  // **Not added to the scene, and the measurement says why.**
  //
  // A backdrop has to be at infinity. This projection cannot reach it: the
  // camera sits **83 globe radii** from the centre at zoom -2, and sampling the
  // clip volume shows a sphere at 30 radii is 24% visible, at 50 it is 1%, and
  // at 80 nothing renders at all. A sphere small enough to survive is a sphere
  // the camera is outside - so it draws as a ball of points with a visible
  // edge, which is exactly what it looked like (D128).
  //
  // The catalogue, the frame conversion and the colours are all correct and
  // tested; only the placement is wrong, and the fix is a screen-space backdrop
  // rather than geometry - stars projected from the camera's own orientation,
  // which is a different piece of work. Left here, off, rather than shipped
  // looking wrong or deleted and rebuilt from scratch.
  const STARS_AS_GEOMETRY_WORK = false;
  if (STARS_AS_GEOMETRY_WORK) scene.add(stars);
  let starsBuiltFor = 0;

  const placeStars = (date: Date) => {
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const dir = starDirection(STARS.ra[i], STARS.dec[i]);
      const v = equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, date);
      starPositions[i * 3] = v[0] * STAR_SPHERE_RADII;
      starPositions[i * 3 + 1] = v[1] * STAR_SPHERE_RADII;
      starPositions[i * 3 + 2] = v[2] * STAR_SPHERE_RADII;
    }
    starGeometry.attributes.position.needsUpdate = true;
    starsBuiltFor = date.getTime();
  };

  // Light from the Sun, so a planet has a day and a night side that are
  // actually correct rather than a flat disc of colour.
  const sunlight = new THREE.PointLight(0xfff2d0, 3.2, 0, 0);
  const ambient = new THREE.AmbientLight(0x223044, 1.1);
  scene.add(sunlight, ambient);

  const spheres = new Map<string, THREE.Mesh>();
  let orbitsBuiltFor = 0;
  let orbitsBuiltAround: PlanetId | null = null;

  const buildOrbits = (date: Date, centre: PlanetId) => {
    orbits.clear();
    for (const planet of PLANET_IDS) {
      if (planet === centre) continue;
      const points = orbitRing(planet, date, 96, centre).map((p) => new THREE.Vector3(...p));
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
    orbitsBuiltAround = centre;
  };

  const sphereFor = (id: string): THREE.Mesh => {
    let mesh = spheres.get(id);
    if (!mesh) {
      // Radius from `solarScale`, in the same unit as the orbit distances -
      // which is the units fix D122 made, and why no conversion appears here.
      const r = globeRadiiFor(bodyRadiusFor(radiusKmOf(id)));
      // The Sun emits, so it stays unlit. Everything else is lit *by* it, which
      // is what turns a flat coloured disc into a body with a terminator - and
      // the phase is correct, because the light is where the Sun is.
      const material =
        id === 'sun'
          ? new THREE.MeshBasicMaterial({ color: COLOURS.sun, transparent: true })
          : new THREE.MeshStandardMaterial({
              color: COLOURS[id] ?? 0xaaaaaa,
              transparent: true,
              roughness: 0.95,
              metalness: 0,
            });
      mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), material);
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
      const centre = origin();
      // Rebuilt when the day changes *or* the world does: the rings are drawn
      // relative to the body under the camera, so standing somewhere else is a
      // different picture rather than the same one moved (D126).
      if (
        Math.abs(date.getTime() - orbitsBuiltFor) > 86_400_000 ||
        orbitsBuiltAround !== centre
      ) {
        buildOrbits(date, centre);
      }

      // The destination is brightened while a trip is in progress, and dimmed
      // relative to it. This is not decoration: the position it is drawn at is
      // a real one from real elements, so what the reader sees growing brighter
      // is genuinely where that planet is now (D126).
      // The sky turns with the Earth, so it is rebuilt when the rotation has
      // moved enough to see - about every four minutes of real time.
      if (Math.abs(date.getTime() - starsBuiltFor) > 240_000) placeStars(date);

      const heading = destination();
      const placements = scenePlacements(date, centre);
      const sun = placements.find((p) => p.id === 'sun');
      if (sun) sunlight.position.set(...sun.at);
      for (const placement of placements) {
        const mesh = sphereFor(placement.id);
        mesh.position.set(...placement.at);
        const emphasis = !heading || placement.id === heading ? 1 : 0.35;
        (mesh.material as THREE.Material).opacity = fade * emphasis;
        mesh.scale.setScalar(heading === placement.id ? 1.6 : 1);
      }
      (stars.material as THREE.PointsMaterial).opacity = fade;
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
