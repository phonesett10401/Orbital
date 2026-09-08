/**
 * The solar system, drawn in a context of its own (D163).
 *
 * The same scene `solarSystemLayer.ts` drew, built from the same tested data -
 * `scenePlacements`, `orbitRing`, `surfaceTexture`, `ringProfile`,
 * `poleDirection`, the star catalogue - but with **its own renderer and its own
 * camera** instead of borrowing MapLibre's.
 *
 * ## What owning the camera removes
 *
 * Every one of these was a real defect, and none of them was a solar-system
 * problem:
 *
 * - **No far-plane clamp.** MapLibre's far plane sits one globe radius past the
 *   centre at every zoom (D129), so every material needed `onBeforeCompile` to
 *   pin `gl_Position.z` inside it. Ours is set where we want it, so the shaders
 *   are ordinary shaders.
 * - **No `frustumCulled = false`.** three.js culls on the CPU against the same
 *   borrowed frustum, which threw away objects the clamp existed to keep (D130).
 *   With a frustum that matches the scene, culling is correct and worth having.
 *   Whatever is off screen is off screen.
 * - **No sky arithmetic.** `skyRadius` existed to find a radius that survived a
 *   far plane that moved with the zoom, and returned null when there was no room
 *   at all. Here the stars sit at a fixed radius inside a far plane we chose.
 * - **No handover, no band, no settle.** Those exist because one camera had to
 *   serve two pictures at wildly different scales (D139-D145, D158, D161).
 * - **Panning is a translation.** The map's camera always looks at the centre of
 *   the world it stands on, so a drag rotated the viewpoint and bodies moved at
 *   different rates - some the wrong way (D160). Here the target moves.
 *
 * D125 rejected a second renderer, and was right at the time: that was for
 * drawing the system *inside* the globe view, where both would run at once. As
 * separate pages only one exists at a time, so the objection does not carry.
 */

import * as THREE from 'three';

import { BODIES } from '../bodies';
import { poleDirection } from '../planetPoles';
import { hasSurface, surfaceTexture } from '../planetSurface';
import { PLANET_IDS, type PlanetId } from '../planets';
import { RING_INNER, RING_OUTER, ringProfile } from '../saturnRings';
import { type SolarCamera, FOV, cameraPosition } from '../solarCamera';
import { orbitRing, scenePlacements, type ScenePlacement } from '../solarFrame';
import { onScreen, project } from '../solarMarkers';
import { drawnBodyRadius } from '../solarScale';
import { FAINTEST_MAGNITUDE, STARS, starColour, starDirection } from '../stars';
import { COLOURS, homeBodies, type BodyMarker } from './solarBodies';

/**
 * Where the stars sit, in globe radii.
 *
 * Far enough to be unreachable at any zoom the camera allows, near enough to
 * stay comfortably inside the far plane. A number rather than a calculation,
 * which is the whole point of owning the frustum.
 */
const SKY_RADIUS = 600;

/**
 * How bright a star is drawn, from its magnitude.
 *
 * The brightest in the catalogue is about -1.4 and the faintest is the cutoff.
 * Never quite zero: a star at the limit should be *nearly* invisible rather
 * than absent, which is what makes the field have depth instead of a hard edge.
 */
function starBrightness(mag: number): number {
  const across = (FAINTEST_MAGNITUDE - mag) / (FAINTEST_MAGNITUDE + 1.5);
  return 0.25 + 0.75 * Math.min(1, Math.max(0, across));
}

/** Near and far, chosen for a scene 18 radii wide seen from up to 150 away. */
const NEAR = 0.05;
const FAR = 2_000;

function radiusKmOf(id: string): number {
  return BODIES.find((b) => b.id === id)?.radiusKm ?? 1_000;
}

export interface SolarScene {
  render(camera: SolarCamera, date: Date, origin: PlanetId, standingOn: string): void;
  /** Where each body landed on screen last frame, for the labels. */
  markers(): BodyMarker[];
  /**
   * Where a body is in the scene, in world units, or null if it is not drawn.
   *
   * Screen coordinates are no use for flying a camera to something: panning by
   * a screen delta is not the inverse of the projection once the camera has any
   * pitch, so the correction overshoots and runs away rather than converging.
   * Moving the camera *target* to the body itself always converges, because it
   * is the same space the body is in (D171).
   */
  positionOf(id: string): [number, number, number] | null;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export function createSolarScene(canvas: HTMLCanvasElement): SolarScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x05070d, 1);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera((FOV * 180) / Math.PI, 1, NEAR, FAR);

  // The Sun lights everything, from where the Sun actually is, which is what
  // gives each body a terminator on the correct side (D145).
  const sunlight = new THREE.PointLight(0xfff4e0, 3, 0, 0);
  scene.add(sunlight);
  // Enough that a night side is dark rather than absent.
  scene.add(new THREE.AmbientLight(0x334155, 0.55));

  // ---- stars ----
  const starGeometry = new THREE.BufferGeometry();
  const count = STARS.ra.length;
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const dir = starDirection(STARS.ra[i], STARS.dec[i]);
    positions[i * 3] = dir[0] * SKY_RADIUS;
    positions[i * 3 + 1] = dir[1] * SKY_RADIUS;
    positions[i * 3 + 2] = dir[2] * SKY_RADIUS;
    // **Already 0-1, not 0-255.** Dividing by 255 here made every star three
    // thousandths of its colour, which is black on black - the field was being
    // drawn perfectly and was invisible.
    const [r, g, b] = starColour(STARS.ci?.[i] ?? 0);
    // `PointsMaterial` has one size for the whole field, so magnitude is spent
    // on brightness instead. That is the right axis anyway: a faint star is
    // faint, and drawing it larger to say so would be backwards.
    const brightness = starBrightness(STARS.mag[i]);
    colours[i * 3] = r * brightness;
    colours[i * 3 + 1] = g * brightness;
    colours[i * 3 + 2] = b * brightness;
  }
  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starGeometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const stars = new THREE.Points(
    starGeometry,
    new THREE.PointsMaterial({
      // A fixed pixel size rather than one that shrinks with distance: these
      // are meant to be a backdrop at an unreachable radius, and attenuating
      // them would make the sky dim as the camera pulls back, which is the
      // opposite of what a sky does.
      size: 1.7,
      sizeAttenuation: false,
      vertexColors: true,
    }),
  );
  // The sky is a backdrop: it must never be culled and never occlude.
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  scene.add(stars);

  // ---- bodies and orbits ----
  const bodies = new THREE.Group();
  const orbits = new THREE.Group();
  scene.add(orbits);
  scene.add(bodies);

  const spheres = new Map<string, THREE.Mesh>();
  const SPHERE_UP = new THREE.Vector3(0, 1, 0);
  const pole = new THREE.Vector3();

  const surfaceMap = (id: string): THREE.DataTexture => {
    const texture = new THREE.DataTexture(surfaceTexture(id, 256), 1, 256, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // Written as sRGB bytes, which is how the band colours were chosen.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  const sphereFor = (id: string): THREE.Mesh => {
    let mesh = spheres.get(id);
    if (!mesh) {
      const r = drawnBodyRadius(radiusKmOf(id));
      // The Sun emits; everything else is lit by it.
      const material =
        id === 'sun'
          ? new THREE.MeshBasicMaterial({ color: COLOURS.sun })
          : new THREE.MeshStandardMaterial({
              color: hasSurface(id) ? 0xffffff : (COLOURS[id] ?? 0xaaaaaa),
              map: hasSurface(id) ? surfaceMap(id) : null,
              roughness: 0.95,
              metalness: 0,
            });
      mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 24), material);
      spheres.set(id, mesh);
      bodies.add(mesh);
    }
    return mesh;
  };

  let orbitsFor = 0;
  let orbitsAround: PlanetId | null = null;
  const buildOrbits = (date: Date, centre: PlanetId) => {
    orbits.clear();
    for (const planet of PLANET_IDS) {
      if (planet === centre) continue;
      const points = orbitRing(planet, date, 128, centre).map((p) => new THREE.Vector3(...p));
      orbits.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({
            color: COLOURS[planet] ?? 0x8899aa,
            transparent: true,
            opacity: 0.3,
          }),
        ),
      );
    }
    orbitsFor = date.getTime();
    orbitsAround = centre;
  };

  // ---- Saturn's rings ----
  let ring: THREE.Mesh | null = null;
  /** Last frame's placements, so `positionOf` can answer from what was drawn. */
  let lastPlacements: ScenePlacement[] = [];
  const buildRing = () => {
    const saturnR = drawnBodyRadius(radiusKmOf('saturn'));
    const profile = new THREE.DataTexture(ringProfile(512), 512, 1, THREE.RGBAFormat);
    profile.minFilter = THREE.LinearFilter;
    profile.magFilter = THREE.LinearFilter;
    profile.colorSpace = THREE.SRGBColorSpace;
    profile.needsUpdate = true;
    const geometry = new THREE.RingGeometry(saturnR * RING_INNER, saturnR * RING_OUTER, 128, 1);
    // Remap the UVs so the profile runs across the ring's width rather than
    // around it, which is what makes the Cassini division a gap and not a
    // wedge.
    const uv = geometry.attributes.uv;
    const position = geometry.attributes.position;
    for (let i = 0; i < uv.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const radius = Math.hypot(x, y);
      const across =
        (radius - saturnR * RING_INNER) / (saturnR * (RING_OUTER - RING_INNER));
      uv.setXY(i, across, 0.5);
    }
    uv.needsUpdate = true;
    ring = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        map: profile,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    bodies.add(ring);
  };

  let drawn: BodyMarker[] = [];
  let width = 1;
  let height = 1;

  return {
    positionOf(id) {
      const found = lastPlacements.find((p) => p.id === id);
      return found ? [found.at[0], found.at[1], found.at[2]] : null;
    },

    resize(w, h, pixelRatio) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setPixelRatio(Math.min(2, pixelRatio));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },

    render(view, date, origin, standingOn) {
      const at = cameraPosition(view);
      camera.position.set(at[0], at[1], at[2]);
      camera.lookAt(view.target[0], view.target[1], view.target[2]);
      camera.updateMatrixWorld();
      // The sky travels with the camera, so it can never be reached.
      stars.position.copy(camera.position);

      if (Math.abs(date.getTime() - orbitsFor) > 86_400_000 || orbitsAround !== origin) {
        buildOrbits(date, origin);
      }

      // The world underfoot is one of the bodies here, drawn at its own scale
      // rather than as a globe kept at radius 1 whatever the zoom (D137) - and
      // with its companion beside it, because the Earth and the Moon cannot be
      // told apart at this compression (D140).
      const placements: ScenePlacement[] = [
        ...scenePlacements(date, origin),
        ...homeBodies(standingOn),
      ];

      lastPlacements = placements;

      const sun = placements.find((p) => p.id === 'sun');
      if (sun) sunlight.position.set(sun.at[0], sun.at[1], sun.at[2]);

      const present = new Set<string>();
      for (const placement of placements) {
        present.add(placement.id);
        const mesh = sphereFor(placement.id);
        mesh.visible = true;
        mesh.position.set(placement.at[0], placement.at[1], placement.at[2]);
        // Stand each body on its own axis: bands run along latitude, and a
        // planet left in the ecliptic frame wears Earth's tilt - which on
        // Uranus is close to a right angle wrong (D132).
        const axis = poleDirection(placement.id, date);
        pole.set(axis[0], axis[1], axis[2]).normalize();
        mesh.quaternion.setFromUnitVectors(SPHERE_UP, pole);
      }
      for (const [id, mesh] of spheres) mesh.visible = present.has(id);

      const saturn = placements.find((p) => p.id === 'saturn');
      if (saturn) {
        if (!ring) buildRing();
        if (ring) {
          ring.visible = true;
          ring.position.set(saturn.at[0], saturn.at[1], saturn.at[2]);
          const axis = poleDirection('saturn', date);
          pole.set(axis[0], axis[1], axis[2]).normalize();
          // The ring lies in Saturn's equator, which is the plane its pole is
          // normal to - so the disc's own up is that pole.
          ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), pole);
        }
      } else if (ring) {
        ring.visible = false;
      }

      renderer.render(scene, camera);

      // Where they landed, with the matrix that just drew them (D159).
      const matrix = new THREE.Matrix4()
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
        .toArray();
      const found: BodyMarker[] = [];
      for (const placement of placements) {
        const point = project(matrix, placement.at, width, height);
        if (!onScreen(point, width, height)) continue;
        const r = drawnBodyRadius(radiusKmOf(placement.id));
        const edge = project(
          matrix,
          [placement.at[0] + r, placement.at[1], placement.at[2]],
          width,
          height,
        );
        found.push({
          id: placement.id,
          x: point.x,
          y: point.y,
          sizePx: edge.inFront ? Math.abs(edge.x - point.x) * 2 : 0,
        });
      }
      drawn = found;
    },

    markers() {
      return drawn;
    },

    dispose() {
      for (const mesh of spheres.values()) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
      spheres.clear();
      ring?.geometry.dispose();
      starGeometry.dispose();
      renderer.dispose();
    },
  };
}
