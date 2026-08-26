/**
 * Pixel-readback probe for the day/night terminator.
 *
 * lighting.test.ts checks two halves of the problem — where the light *should*
 * fall, and whether the shader *source* is in the right coordinate frame — but
 * neither runs a shader. vitest has no GL context, and the defect this exists
 * for (D41) lived in the assembled pipeline: the shader compiled, the uniforms
 * were right, the astronomy was right, and the picture was still wrong. Only
 * rendering it shows that.
 *
 * So this renders the real scene, with the real material, through a real GL
 * context, reads the pixels back, and measures the light. It is committed
 * rather than thrown away deliberately: the equivalent probe for marker
 * rotation was a console snippet, and its numbers could not be reproduced
 * afterwards without writing it again. A measurement harness is code too (D40).
 *
 * Run it from the browser console against a running dev server:
 *
 *     __orbital.probeLighting()
 *
 * ## What this harness has to defend against
 *
 * Three confounds, each of which produced a confident wrong answer before it
 * was found. They are the reason for most of the code below.
 *
 * - **The other layers.** The atmosphere is a back-side additive shell whose
 *   glow is anchored to the camera, and it covers the planet completely. Left
 *   visible, every measurement here is really a measurement of the halo — it
 *   even reads *inverted*, because the back face of the shell that the camera
 *   sees faces away from the sun. Markers and the star field can also land on
 *   a sampled pixel. All four are hidden while measuring, which is exactly
 *   what keeping the layers separable was for (D16).
 * - **The build-in animation.** three-globe animates the globe from a scale of
 *   1e-6 up to 1 over 600 ms, driven by requestAnimationFrame. In a hidden or
 *   background tab rAF never fires, the tween never runs, and the planet stays
 *   microscopic — so the frame contains no Earth at all while every object in
 *   the scene still reports `visible: true`. `assertGlobeRendered` refuses to
 *   measure until the globe is really there and really in frame.
 * - **Texture, mistaken for light.** Absolute brightness at a point confounds
 *   lighting with whatever the Blue Marble imagery shows there: ocean is dark
 *   in daylight, ice is bright in the dark, and Antarctica is brighter at
 *   midnight than the Arctic Ocean is at noon. Every comparison below is
 *   therefore of *the same texel against itself*, varying only the camera or
 *   the date.
 *
 * And one from task 2, designed around rather than discovered again: the probe
 * camera's aspect must match the render target's shape. A square target with a
 * 16:9 projection produced a false 15.6-degree rotation error that looked
 * exactly like a shader bug.
 */

import * as THREE from 'three';

import { latLonToVector3, sunDirectionFor, surfaceLambert } from './earth';
import { subsolarPoint } from './sun';

const SIZE = 512;

/** How far out the probe camera sits, in globe radii. */
const CAMERA_DISTANCE = 3.2;

/**
 * Only sample well inside the disc.
 *
 * Near the limb a 3x3 patch of pixels spans tens of degrees of surface, so a
 * reading there is an average over a huge area and varies with the camera for
 * reasons that have nothing to do with the lighting.
 */
const MAX_NDC = 0.6;

/**
 * Directions to view a given point from, as offsets in degrees of latitude and
 * longitude from the point itself.
 *
 * Generated per point rather than from one fixed set of camera positions, so
 * every view has the point comfortably inside MAX_NDC. A fixed set leaves most
 * points visible from only two or three cameras, and an invariance measured
 * over two samples is barely an invariance at all.
 */
const VIEW_OFFSETS: Array<[number, number]> = [
  [0, 0],
  [0, 25],
  [0, -25],
  [20, 0],
  [-20, 0],
  [0, 45],
  [0, -45],
  [30, 30],
  [-30, -30],
];

const ORIENTATIONS: Array<{ lat: number; lon: number; label: string }> = [
  { lat: 0, lon: 0, label: 'equator, prime meridian' },
  { lat: 0, lon: 90, label: 'equator, 90E' },
  { lat: 0, lon: 180, label: 'equator, antimeridian' },
  { lat: 0, lon: -90, label: 'equator, 90W' },
  { lat: 45, lon: 30, label: '45N 30E' },
  { lat: -45, lon: -120, label: '45S 120W' },
  { lat: 80, lon: 0, label: 'high north' },
  { lat: -80, lon: 0, label: 'high south' },
];

export interface LightingProbeReport {
  date: string;
  subsolar: { lat: number; lon: number };
  /** The same texel, the same instant, seen from eight camera orientations. */
  cameraInvariance: Array<{
    lat: number;
    lon: number;
    expectedLambert: number;
    views: number;
    min: number;
    max: number;
    spread: number;
  }>;
  /**
   * Where the light actually is, per camera orientation: the angle between the
   * disc's brightness centroid and the sun, against the angle between that
   * centroid and the camera axis.
   */
  sunwardBias: Array<{
    label: string;
    toSunDegrees: number;
    toCameraDegrees: number;
    sunSeparationDegrees: number;
  }>;
  /** Mean disc luminance with the sun in front of the planet, and behind it. */
  discMeanLuminance: Array<{
    label: string;
    sunNear: number;
    sunFar: number;
    ratio: number;
  }>;
  /** The same polar cap at both solstices: polar day against polar night. */
  poles: Array<{ cap: string; june: number; december: number; ratio: number }>;
}

interface ProbeDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** The live camera, read for its field of view only. */
  camera: THREE.PerspectiveCamera;
  /** The globe's material, used to find the globe mesh in the scene. */
  material: THREE.Material;
  globeRadius: number;
  /** Layers hidden while measuring, so only the Earth is in frame. */
  otherLayers: THREE.Object3D[];
  setSunFromDate(date: Date): void;
}

export function createLightingProbe(deps: ProbeDeps) {
  const target = new THREE.WebGLRenderTarget(SIZE, SIZE);
  const buffer = new Uint8Array(SIZE * SIZE * 4);
  // Aspect 1, because the target is square. This is the line that was wrong in
  // the task 2 probe, so it is stated rather than inherited.
  const camera = new THREE.PerspectiveCamera(deps.camera.fov, 1, 0.1, 100_000);

  let globeMesh: THREE.Mesh | null = null;
  deps.scene.traverse((object) => {
    if ((object as THREE.Mesh).material === deps.material) globeMesh = object as THREE.Mesh;
  });

  /**
   * The radius the globe actually occupies in world space.
   *
   * Not assumed equal to `globeRadius`: three-globe's build-in tween leaves it
   * at a millionth of that until an animation frame has run.
   */
  function renderedGlobeRadius(): number {
    if (!globeMesh) return 0;
    deps.scene.updateMatrixWorld(true);
    globeMesh.geometry.computeBoundingSphere();
    const geometryRadius = globeMesh.geometry.boundingSphere?.radius ?? 0;
    const e = globeMesh.matrixWorld.elements;
    return geometryRadius * Math.hypot(e[0], e[1], e[2]);
  }

  function renderFrom(lat: number, lon: number): void {
    camera.position.copy(latLonToVector3(lat, lon, deps.globeRadius * CAMERA_DISTANCE));
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const previous = deps.renderer.getRenderTarget();
    deps.renderer.setRenderTarget(target);
    deps.renderer.render(deps.scene, camera);
    deps.renderer.setRenderTarget(previous);
    deps.renderer.readRenderTargetPixels(target, 0, 0, SIZE, SIZE, buffer);
  }

  /** Luminance at a pixel, 0-1, Rec. 709 weights. */
  function luminanceAt(px: number, py: number): number {
    const i = (py * SIZE + px) * 4;
    return (0.2126 * buffer[i] + 0.7152 * buffer[i + 1] + 0.0722 * buffer[i + 2]) / 255;
  }

  /**
   * Mean luminance of a small patch at a surface point, or null if that point
   * is over the horizon or too close to the limb to measure.
   *
   * The horizon test is the one picking uses (D34): projection alone happily
   * reports a point on the far side of the planet as being on screen.
   */
  function sampleSurface(lat: number, lon: number): number | null {
    const point = latLonToVector3(lat, lon, deps.globeRadius);
    if (point.dot(camera.position.clone().sub(point)) <= 0) return null;

    const ndc = point.clone().project(camera);
    if (Math.abs(ndc.x) > MAX_NDC || Math.abs(ndc.y) > MAX_NDC) return null;

    const px = Math.round(((ndc.x + 1) / 2) * (SIZE - 1));
    // readRenderTargetPixels returns rows bottom-up, and NDC y also runs
    // bottom-up, so these agree without a flip. Stated because assuming the
    // opposite mirrors every result about the equator, which looks plausible.
    const py = Math.round(((ndc.y + 1) / 2) * (SIZE - 1));

    let total = 0;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) total += luminanceAt(px + dx, py + dy);
    }
    return total / 9;
  }

  /**
   * Refuse to measure a frame that does not contain the planet.
   *
   * Both halves matter. The scene graph can say the globe is a millionth of
   * its size, and even at full size a mis-set camera can leave it out of
   * frame; either way the probe would otherwise report confident numbers about
   * an empty image.
   */
  function assertGlobeRendered(): void {
    const radius = renderedGlobeRadius();
    if (Math.abs(radius - deps.globeRadius) > deps.globeRadius * 0.01) {
      throw new Error(
        `the globe is at world radius ${radius.toFixed(6)}, not ${deps.globeRadius}. ` +
          "three-globe's build-in tween runs on requestAnimationFrame, which does not " +
          'fire in a hidden or background tab. Bring the tab to the front and re-run.',
      );
    }

    // Sampled within 30 degrees of the sub-camera point, so every one of them
    // is comfortably inside MAX_NDC. A wider grid would fail this check for a
    // reason that is about the probe's own sampling window rather than about
    // the globe -- which it did, on the first run.
    renderFrom(0, 0);
    let onSurface = 0;
    const probes = [];
    for (let lat = -30; lat <= 30; lat += 15) {
      for (let lon = -30; lon <= 30; lon += 15) probes.push([lat, lon]);
    }
    for (const [lat, lon] of probes) {
      if (sampleSurface(lat, lon) !== null) onSurface += 1;
    }
    if (onSurface < probes.length) {
      throw new Error(
        `only ${onSurface} of ${probes.length} surface samples landed in frame; the ` +
          'globe is not where the probe expects it.',
      );
    }
  }

  /**
   * The direction the light is coming from, as the rendered image sees it.
   *
   * Every visible surface point is weighted by its luminance and summed as a
   * world-space vector; the result points at the brightest part of the disc.
   * Texture makes it an imperfect estimate of the subsolar direction -- a
   * bright desert pulls it, a dark ocean pushes it -- but averaging over
   * several hundred samples leaves the light as the dominant term.
   *
   * This is the measurement that speaks directly to D41. The defect put the
   * bright region at the centre of the screen whatever the sun was doing, so
   * the question it answers is not "is the disc lit" but "is it lit *toward
   * the sun* or *toward the camera*".
   */
  function brightnessCentroid(): THREE.Vector3 | null {
    const centroid = new THREE.Vector3();
    let weight = 0;

    for (let lat = -80; lat <= 80; lat += 4) {
      for (let lon = -180; lon < 180; lon += 4) {
        const luminance = sampleSurface(lat, lon);
        if (luminance === null) continue;
        centroid.addScaledVector(latLonToVector3(lat, lon, 1), luminance);
        weight += luminance;
      }
    }
    return weight > 0 && centroid.length() > 1e-9 ? centroid.normalize() : null;
  }

  /** Mean luminance over the visible disc. */
  function discMean(): number {
    let total = 0;
    let count = 0;
    for (let lat = -80; lat <= 80; lat += 4) {
      for (let lon = -180; lon < 180; lon += 4) {
        const luminance = sampleSurface(lat, lon);
        if (luminance === null) continue;
        total += luminance;
        count += 1;
      }
    }
    return count ? total / count : 0;
  }

  /** Mean luminance of a polar cap, sampled from directly above it. */
  function capLuminance(pole: 1 | -1): number {
    renderFrom(pole * 80, 0);
    let total = 0;
    let count = 0;
    for (let lat = 72; lat <= 88; lat += 4) {
      for (let lon = -180; lon < 180; lon += 15) {
        const luminance = sampleSurface(pole * lat, lon);
        if (luminance === null) continue;
        total += luminance;
        count += 1;
      }
    }
    return count ? total / count : 0;
  }

  function run(when = new Date()): LightingProbeReport {
    const hidden = deps.otherLayers.map((layer) => layer.visible);
    deps.otherLayers.forEach((layer) => {
      layer.visible = false;
    });

    try {
      deps.setSunFromDate(when);
      assertGlobeRendered();

      const subsolar = subsolarPoint(when);
      const points = [
        { lat: 0, lon: subsolar.lon },
        { lat: 0, lon: subsolar.lon + 60 },
        { lat: 40, lon: subsolar.lon - 40 },
        { lat: -30, lon: subsolar.lon + 120 },
        { lat: 55, lon: subsolar.lon + 170 },
        { lat: 0, lon: subsolar.lon + 180 },
      ].map((p) => ({ lat: p.lat, lon: ((p.lon + 540) % 360) - 180 }));

      // ---- camera invariance ---------------------------------------------
      // The defect's signature: brightness that changes when only the camera
      // moves. The sun is fixed for the whole sweep.
      const cameraInvariance = points.map((point) => {
        const values: number[] = [];
        for (const [dLat, dLon] of VIEW_OFFSETS) {
          const viewLat = Math.max(-89, Math.min(89, point.lat + dLat));
          renderFrom(viewLat, point.lon + dLon);
          const luminance = sampleSurface(point.lat, point.lon);
          if (luminance !== null) values.push(luminance);
        }
        const min = Math.min(...values);
        const max = Math.max(...values);
        return {
          lat: point.lat,
          lon: point.lon,
          expectedLambert: surfaceLambert(point.lat, point.lon, when),
          views: values.length,
          min,
          max,
          spread: max - min,
        };
      });

      // ---- where the light is, per camera ---------------------------------
      // The discriminating measurement. If the lighting followed the camera,
      // the bright region would sit on the camera axis; if it follows the sun,
      // it sits toward the sun. Both angles are reported so the comparison is
      // visible rather than asserted.
      const sun = sunDirectionFor(when);
      const degrees = (a: THREE.Vector3, b: THREE.Vector3) =>
        (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;

      deps.setSunFromDate(when);
      const sunwardBias: LightingProbeReport['sunwardBias'] = [];
      const discMeanLuminance: LightingProbeReport['discMeanLuminance'] = [];

      for (const orientation of ORIENTATIONS) {
        const cameraAxis = latLonToVector3(orientation.lat, orientation.lon, 1);
        renderFrom(orientation.lat, orientation.lon);
        const centroid = brightnessCentroid();
        const sunNear = discMean();

        if (centroid) {
          sunwardBias.push({
            label: orientation.label,
            toSunDegrees: degrees(centroid, sun),
            toCameraDegrees: degrees(centroid, cameraAxis),
            sunSeparationDegrees: degrees(cameraAxis, sun),
          });
        }

        // The same camera and the same texels, with the sun moved to the far
        // side of the planet. Only the light differs, so the texture cancels
        // in the ratio.
        deps.setSunFromDate(new Date(when.getTime() + 12 * 3600_000));
        renderFrom(orientation.lat, orientation.lon);
        const sunFar = discMean();
        deps.setSunFromDate(when);

        discMeanLuminance.push({
          label: orientation.label,
          sunNear,
          sunFar,
          ratio: sunFar > 0 ? sunNear / sunFar : Infinity,
        });
      }

      // ---- the polar caps at the solstices --------------------------------
      // The same cap at both solstices: identical texels, opposite lighting.
      // Comparing the two *caps* instead would compare Arctic sea ice against
      // the Antarctic ice sheet, which differ by more than the sun does.
      const june = new Date('2026-06-21T12:00:00Z');
      const december = new Date('2026-12-21T12:00:00Z');

      deps.setSunFromDate(june);
      const northJune = capLuminance(1);
      const southJune = capLuminance(-1);
      deps.setSunFromDate(december);
      const northDecember = capLuminance(1);
      const southDecember = capLuminance(-1);

      const poles = [
        {
          cap: 'north',
          june: northJune,
          december: northDecember,
          ratio: northDecember > 0 ? northJune / northDecember : Infinity,
        },
        {
          cap: 'south',
          june: southJune,
          december: southDecember,
          ratio: southJune > 0 ? southDecember / southJune : Infinity,
        },
      ];

      deps.setSunFromDate(when);

      return {
        date: when.toISOString(),
        subsolar,
        cameraInvariance,
        sunwardBias,
        discMeanLuminance,
        poles,
      };
    } finally {
      deps.otherLayers.forEach((layer, i) => {
        layer.visible = hidden[i];
      });
    }
  }

  function dispose(): void {
    target.dispose();
  }

  return { run, dispose, renderedGlobeRadius };
}
