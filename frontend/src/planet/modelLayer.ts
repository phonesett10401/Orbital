/**
 * The selected aircraft as a 3D model, drawn into MapLibre's own GL context.
 *
 * The globe drew this by owning the renderer (D42). Here MapLibre owns it, so
 * the model goes in as a **custom layer**: MapLibre hands us its context and
 * its matrices mid-frame, we draw one mesh with three.js, and it carries on.
 * That is the whole of the port — the airframe itself is shared source
 * (`src/airframe.ts`) and unchanged, because a low-poly airliner is not a
 * property of either renderer.
 *
 * What did change, and why (D67):
 *
 * - **The frame is a tangent frame on the ground**, not a point on a marker
 *   shell. `modelFrame.ts` carries that arithmetic and the reasoning for it.
 * - **The light is a fixed sun rather than a headlight.** The globe needed a
 *   headlight so a selection over the night side stayed visible against real
 *   lighting; nothing here is unlit.
 * - **The model matrix is folded into the projection matrix in double
 *   precision** before anything reaches the GPU, which is a requirement rather
 *   than a tidiness — see `multiplyMat4`.
 *
 * What did not change is the rule the globe's model was built on: an aircraft
 * with **no heading gets no model** (D18, D40, D42). A mesh commits to a
 * direction on screen and there is none to commit to, so those keep the disc.
 */

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { aircraftGeometryFor } from '../airframe';
import { altitudeColor } from '../globe/markers';
import type { RenderableObject } from '../types';
import { scaleFor, wingspanFor } from '../wingspan';
import {
  MODEL_LIFT_SPANS,
  REAL_SPAN_METRES,
  globeAxes,
  globeModelMatrix,
  isOnNearSide,
  mercatorModelMatrix,
  modelSpanMetres,
  multiplyMat4,
  sunInModelSpace,
  usesGlobeFrame,
} from './modelFrame';

/** The layer's id, exported so the view can place it and the tests can find it. */
export const MODEL_LAYER = 'orbital-aircraft-model';

/**
 * What the layer needs to know about the aircraft it is drawing.
 *
 * Deliberately not a `RenderableObject`: the position here is the interpolated
 * one, the same value the symbol layer draws, and passing the object would
 * invite this layer to interpolate it a second time and disagree.
 */
export interface ModelTarget {
  lon: number;
  lat: number;
  heading: number;
  altitude: number | null;
  /** ICAO type designator, or null. Sets how large the airframe is drawn. */
  model: string | null;
}

/**
 * The one aircraft to draw, or null.
 *
 * `renderLon` / `renderLat` are what `aircraftFeatures` uses for the symbols,
 * so the model cannot drift away from the marker it replaces: they are the
 * same two numbers, read from the same object in the same frame.
 */
export function modelTarget(object: RenderableObject | null | undefined): ModelTarget | null {
  if (!object || object.heading === null) return null;
  // **A satellite gets no model, even though it has a heading.** This mesh is
  // an airframe - fuselage, wings, tailplane, engines, proportioned by ICAO
  // type (D91). Drawing a satellite with it would be a detailed, confident
  // claim about a shape we do not have, which is worse than drawing nothing.
  // Same reasoning as the no-heading case above, and the same guard the globe
  // applies (D96).
  if (object.type === 'satellite') return null;
  return {
    lon: object.renderLon,
    lat: object.renderLat,
    heading: object.heading,
    altitude: object.altitude,
    model: object.model,
  };
}

const vertexShader = /* glsl */ `
  varying vec3 vNormal;

  void main() {
    vNormal = normalize(normal);
    gl_Position = projectionMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 tint;
  uniform vec3 sun;

  varying vec3 vNormal;

  void main() {
    float lambert = max(dot(normalize(vNormal), normalize(sun)), 0.0);
    // An ambient floor, so no face is ever fully black: this is a selection
    // indicator before it is a lit object, and a black facet over dark water
    // reads as the model having disappeared.
    gl_FragColor = vec4(tint * (0.42 + 0.58 * lambert), 1.0);
  }
`;

/**
 * The parts of `THREE.WebGLRenderer` this layer uses.
 *
 * Named as an interface so a test can pass a stand-in. There is no WebGL in
 * the test environment, and without a seam the only testable part of this
 * layer would be the arithmetic - which would leave the two things most
 * likely to be wrong, *which matrix* is used and *when nothing is drawn*,
 * resting on nothing at all.
 */
export interface ModelRenderer {
  autoClear: boolean;
  resetState(): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
}

export interface ModelLayer extends CustomLayerInterface {
  /** The camera the last frame projected through, for tests to read back. */
  readonly camera: THREE.Camera;
  /** Whether the last frame drew anything, which is what the tests assert on. */
  drewLastFrame(): boolean;
  /**
   * One line for the dev readout saying what happened last frame.
   *
   * "No model on screen" has four causes that look identical from outside -
   * nothing selected, no heading to point it with, the aircraft over the
   * horizon, or the layer never having been rendered at all - and this view is
   * looked at on one machine and debugged on another (D57).
   */
  describe(): string;
  dispose(): void;
}

/**
 * Build the layer.
 *
 * `getTarget` is called once per frame rather than the target being pushed in,
 * for the same reason the symbol source is rewritten on a frame loop: the
 * position moves between polls, and a layer that is told about it only when a
 * poll lands would stutter at the poll rate while everything around it glides.
 */
export function createModelLayer(
  getTarget: () => ModelTarget | null,
  createRenderer: (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) => ModelRenderer = (
    canvas,
    gl,
  ) => new THREE.WebGLRenderer({ canvas, context: gl }),
): ModelLayer {
  const camera = new THREE.Camera();
  // The projection matrix we assemble already contains the view and the model
  // transforms, so three.js must not apply a view matrix of its own on top.
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;

  // The generic airframe to begin with; swapped for the selected
  // aircraft's proportions on the first frame it is drawn.
  const geometry = aircraftGeometryFor(null);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      tint: { value: new THREE.Color(1, 1, 1) },
      sun: { value: new THREE.Vector3(0, 1, 0) },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);

  let renderer: ModelRenderer | null = null;
  let map: MapLibreMap | null = null;
  let drew = false;
  let status = 'never rendered';

  return {
    id: MODEL_LAYER,
    type: 'custom',
    camera,
    // '3d' rather than '2d' so MapLibre gives us its depth buffer: the model
    // has to be occluded by the extruded buildings it flies over, not painted
    // on top of them.
    renderingMode: '3d',

    onAdd(addedMap: MapLibreMap, gl: WebGL2RenderingContext) {
      map = addedMap;
      // Sharing MapLibre's canvas and context rather than making our own. A
      // second canvas would need its own compositing pass, would not share the
      // depth buffer, and would have to be kept in sync with every resize.
      renderer = createRenderer(addedMap.getCanvas(), gl);
      renderer.autoClear = false;
    },

    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      drew = false;
      const target = getTarget();
      if (!renderer || !map) {
        status = 'not added to a map';
        return;
      }
      if (!target) {
        status = 'nothing selected, or the selection has no heading';
        return;
      }

      const projection = args.defaultProjectionData;
      const globe = usesGlobeFrame(projection.projectionTransition);

      // Under mercator the scale varies with latitude across the screen, so
      // the aircraft's own latitude is the right one; under globe the sphere
      // has a single scale, set at the map's centre.
      const scaleLat = globe ? map.getCenter().lat : target.lat;
      // The aircraft's own wingspan where the feed named a type, and the same
      // compressed factor the symbols use for the pixel floor - so the model
      // differs by type at every zoom, not only past z16 where true scale
      // takes over.
      const span = modelSpanMetres(
        map.getZoom(),
        scaleLat,
        wingspanFor(target.model) ?? REAL_SPAN_METRES,
        scaleFor(target.model),
      );
      // Proportions as well as size: a four-engined widebody is a different
      // shape, not a larger A320. Cached, so this is a reference swap on the
      // frames where the selection has not changed.
      const wanted = aircraftGeometryFor(target.model);
      if (mesh.geometry !== wanted) mesh.geometry = wanted;

      const lift = span * MODEL_LIFT_SPANS;

      let model: number[];
      if (globe) {
        const { up } = globeAxes(target.lon, target.lat);
        // Over the horizon there is no terrain drawn to hide the model, so it
        // would hang in space on the far side of the planet.
        if (!isOnNearSide(up, projection.clippingPlane)) {
          status = 'selection is over the horizon';
          return;
        }
        model = globeModelMatrix(target.lon, target.lat, target.heading, span, lift);
      } else {
        model = mercatorModelMatrix(target.lon, target.lat, target.heading, span, lift);
      }

      const frame = globe ? projection.mainMatrix : projection.fallbackMatrix;
      camera.projectionMatrix.fromArray(multiplyMat4(Array.from(frame), model));

      const [r, g, b] = altitudeColor(target.altitude);
      (material.uniforms.tint.value as THREE.Color).setRGB(r, g, b);
      const sun = sunInModelSpace(target.heading, !globe);
      (material.uniforms.sun.value as THREE.Vector3).set(sun[0], sun[1], sun[2]);

      // three.js and MapLibre both assume they own the GL state machine, and
      // only one of them can be right; resetting is how three is told that
      // someone else has been touching it.
      renderer.resetState();
      renderer.render(scene, camera);
      drew = true;
      status = `drawing · ${globe ? 'globe' : 'mercator'} frame · ${span.toFixed(0)} m span`;
    },

    onRemove() {
      map = null;
    },

    drewLastFrame() {
      return drew;
    },

    describe() {
      return status;
    },

    dispose() {
      // The geometry is shared and cached (see aircraftGeometryFor), so it is
      // deliberately not disposed here: the globe's layer may still be holding
      // the same mesh.
      material.dispose();
      // The renderer is not disposed: it does not own the context, MapLibre
      // does, and disposing it would take the map's context down with it.
      renderer = null;
    },
  };
}
