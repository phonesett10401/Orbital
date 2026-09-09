/**
 * Orbital's mark, as the thing it depicts (D177).
 *
 * The About page opens on the logo built in three dimensions rather than shown
 * as a picture of itself. That is not a flourish: `public/logo.svg` is a globe
 * with an orbit wrapped round it and one satellite on the near arc, and this
 * application already draws globes, orbits and satellites from real geometry.
 * Drawing the mark the same way makes it the subject rather than a badge.
 *
 * ## Everything here is generated
 *
 * No image is fetched. The Earth's colour comes from `surfaceTexture`, the
 * procedural latitude bands the solar system page already uses for bodies with
 * no mosaic - so this costs one request fewer than a logo would, works offline
 * like the rest of the app (D30), and cannot go missing.
 *
 * ## What it borrows from the SVG, and what it cannot
 *
 * The wrap is real in both: the ring's radius is larger than the globe's, it is
 * tilted, and half of it passes behind. In the SVG that took two arcs and a
 * clip path, drawn in a deliberate order, because SVG has no depth. Here it is
 * simply true, which is the whole argument for doing it in three dimensions.
 *
 * The one thing not carried over is the terminator's exact shape. The SVG draws
 * it as an ellipse arc because a straight line makes a sphere read flat; here a
 * light does it, and the light is correct by construction.
 */

import * as THREE from 'three';

import { surfaceTexture } from '../planetSurface';

/** Globe radii. The ring must clear the globe or the wrap is a lie. */
const GLOBE_RADIUS = 1;
const RING_RADIUS = 1.42;
const RING_TUBE = 0.018;

/** The satellite, small enough that the ring stays the subject. */
const CRAFT_RADIUS = 0.055;

/**
 * How far the mark is tipped, in radians.
 *
 * Matches the SVG's `rotate(-20)` on the orbit closely enough to read as the
 * same mark, with a little more tilt on the other axis because a ring seen
 * edge-on in three dimensions disappears where a flat ellipse would not.
 */
const TILT_Z = -0.35;
const TILT_X = -1.15;

/** One turn, in milliseconds. Slow: this is a mark, not an animation. */
const TURN_MS = 42_000;

/** The satellite goes round faster than the globe turns, as it should. */
const ORBIT_MS = 14_000;

export interface MarkScene {
  /**
   * Draw one frame.
   *
   * `drift` leans the whole mark toward the pointer, in the same -1..1 the
   * solar page uses, so the two pages respond to a mouse the same way.
   */
  render(elapsedMs: number, drift: { x: number; y: number }): void;
  resize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export function createMarkScene(canvas: HTMLCanvasElement): MarkScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // Transparent, so the page's own ground and grain show through rather than
  // the mark sitting on a black rectangle of its own.
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  camera.position.set(0, 0, 6.2);

  /** Everything tips together, so the wrap holds whatever the pointer does. */
  const mark = new THREE.Group();
  mark.rotation.z = TILT_Z;
  mark.rotation.x = TILT_X;
  scene.add(mark);

  // --- the globe ------------------------------------------------------------
  const texture = new THREE.DataTexture(surfaceTexture('earth', 256), 1, 256, THREE.RGBAFormat);
  texture.needsUpdate = true;
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48),
    // **Darkened deliberately.** The title sits over this, and a lit globe
    // behind a serif is a globe with an unreadable sentence on it. The mark is
    // the ground the words stand on: the ring carries the brightness, the
    // sphere carries the shape.
    new THREE.MeshStandardMaterial({
      map: texture,
      color: 0x2b3f5c,
      roughness: 0.95,
      metalness: 0.04,
    }),
  );
  // Turned inside the tilted group, so the mark leans and the world spins.
  const spinner = new THREE.Group();
  spinner.add(globe);
  mark.add(spinner);

  /** The atmosphere: a shell slightly larger, facing inward, barely there. */
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_RADIUS * 1.045, 48, 32),
    new THREE.MeshBasicMaterial({
      color: 0x4a9fd8,
      transparent: true,
      opacity: 0.1,
      side: THREE.BackSide,
      depthWrite: false,
    }),
  );
  mark.add(halo);

  // --- the orbit ------------------------------------------------------------
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 12, 220),
    new THREE.MeshStandardMaterial({
      color: 0x8ecbff,
      emissive: 0x2f6ea8,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.2,
    }),
  );
  mark.add(ring);

  // --- the satellite --------------------------------------------------------
  const craft = new THREE.Mesh(
    new THREE.SphereGeometry(CRAFT_RADIUS, 16, 12),
    new THREE.MeshStandardMaterial({
      color: 0xf2f8ff,
      emissive: 0xbcdcff,
      emissiveIntensity: 0.7,
      roughness: 0.4,
    }),
  );
  mark.add(craft);

  // --- light ----------------------------------------------------------------
  // One sun and a little fill. The terminator is what makes the sphere read as
  // a sphere, so the key light is well off axis rather than behind the camera.
  const sun = new THREE.DirectionalLight(0xbfd8f5, 1.5);
  sun.position.set(-3.2, 1.6, 2.4);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x16213a, 1.1));

  let width = 1;
  let height = 1;

  return {
    resize(w, h, pixelRatio) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      renderer.setPixelRatio(Math.min(2, pixelRatio));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    },

    render(elapsedMs, drift) {
      spinner.rotation.y = (elapsedMs / TURN_MS) * Math.PI * 2;

      // The satellite rides the ring, which means its position is the ring's
      // own circle - not an orbit computed from anything. This is a mark.
      const angle = (elapsedMs / ORBIT_MS) * Math.PI * 2;
      craft.position.set(Math.cos(angle) * RING_RADIUS, Math.sin(angle) * RING_RADIUS, 0);

      // Leaned, not spun: the tilt is what makes it the logo, so the pointer
      // moves it a few degrees off that rather than replacing it.
      mark.rotation.z = TILT_Z - drift.x * 0.18;
      mark.rotation.x = TILT_X - drift.y * 0.14;

      renderer.render(scene, camera);
    },

    dispose() {
      globe.geometry.dispose();
      (globe.material as THREE.Material).dispose();
      halo.geometry.dispose();
      (halo.material as THREE.Material).dispose();
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
      craft.geometry.dispose();
      (craft.material as THREE.Material).dispose();
      texture.dispose();
      renderer.dispose();
    },
  };
}
