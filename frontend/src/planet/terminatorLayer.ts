/**
 * The day/night terminator, as a shaded mesh over the map.
 *
 * The globe shaded day and night per pixel inside its own Earth shader (D41).
 * MapLibre has no equivalent hook — its raster layers are drawn by its own
 * programs — so this is the one piece of the migration that is a new feature
 * rather than a port.
 *
 * ## Why a shaded mesh and not a GeoJSON polygon
 *
 * A night polygon is the obvious answer and it cannot carry the city lights,
 * which is half of what makes a night side read as one. Checked against
 * MapLibre 6.6.0 rather than assumed: there is **no `raster-color`** paint
 * property (only opacity, hue, brightness, saturation, contrast) and **no
 * `clip` layer type** in this version, so a raster cannot be recoloured so its
 * black background becomes transparent, and it cannot be masked to a polygon.
 * A whole-world lights raster drawn as a normal layer would therefore paint
 * its black background over the daylight half of the world.
 *
 * A mesh solves both at once, and gets a real terminator into the bargain: the
 * alpha comes out of the sun angle per fragment, so the twilight band is a
 * gradient rather than a polygon edge, and the same fragment carries the
 * lights. One custom layer, one texture, no polygon to densify and no
 * antimeridian to split.
 *
 * ## The composite is the globe's, deliberately
 *
 * The globe's shader ends with `mix(lit, lit * 0.15 + nightColor * 1.5,
 * nightMix)`. Ordinary alpha blending computes `src * a + dst * (1 - a)`, so
 * with the lights as the source colour at `1.5` gain and alpha `0.85` at full
 * night, this view composites **exactly what the globe composites**, against
 * satellite imagery instead of the day texture. The terminator's softness
 * (`smoothstep(-0.15, 0.25, ...)`) is the globe's too. Two views disagreeing
 * about where night falls would be worse than either choice of band.
 *
 * The texture is the one the globe already uses, from `config.textures.night`.
 * Nothing new is fetched and nothing new leaves for a third party (D7).
 */

import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

import { subsolarPoint } from '../globe/sun';
import type { Mat4, Vec3 } from './modelFrame';
import { mercatorX, mercatorY, multiplyMat4, sphereVector, usesGlobeFrame } from './modelFrame';

/** The layer's id. */
export const TERMINATOR_LAYER = 'orbital-terminator';

/**
 * The terminator's softness, as `sin(sun elevation)` at full night and full
 * day. Copied from the globe's shader so the two views put night in the same
 * place: about 8.6 degrees below the horizon to 14.5 above.
 */
export const NIGHT_AT = -0.15;
export const DAY_AT = 0.25;

/**
 * Opacity at full night, and the gain on the lights.
 *
 * 0.85 leaves 15% of the imagery showing through, which is the globe's
 * `lit * 0.15`; 1.5 is its `nightColor * 1.5`. Both are config-overridable
 * because they are taste, and the last time a lighting constant was tuned it
 * took a second attempt against the thing it sits on (D49).
 */
export const NIGHT_STRENGTH = 0.85;
export const LIGHTS_GAIN = 1.5;

/**
 * Mercator cannot reach the poles, so its mesh stops where the projection
 * does. This is MapLibre's own limit, not a choice.
 */
const MERCATOR_LIMIT = 85.051129;

/**
 * The zooms between which night fades out entirely.
 *
 * **Measured, not chosen.** The lights texture is 4096 x 2048 for the whole
 * planet, which is 9.8 km per texel, and one texel covers this much of the
 * screen at 40 degrees north:
 *
 * | zoom | screen pixels per texel |
 * |---|---|
 * | 2 | 0.7 |
 * | 4 | 2.6 |
 * | 5 | 5.2 |
 * | 7 | 20.9 |
 * | 10 | **167** |
 *
 * At z10 a single texel spans a sixth of the screen: what is drawn is not city
 * lights but one smeared blob of them, painted over the map at 0.85 opacity,
 * which is what Phone saw as a milky fog over the whole of New Jersey
 * (defect #23). There is no texture that fixes this - a street-scale night
 * would need per-building light data, not a bigger image.
 *
 * So night bows out instead. It is a planetary phenomenon and it is drawn at
 * planetary zooms; by the time the map is showing streets, the map is what the
 * user came for. The same reasoning as the globe-to-city hand-off, which was
 * also settled by measuring texels per pixel rather than by taste (D53).
 */
export const TERMINATOR_FULL_ZOOM = 4;
export const TERMINATOR_GONE_ZOOM = 7;

/**
 * How much of the night to draw at a zoom: 1 out to z4, nothing from z7.
 *
 * Smoothstepped rather than switched, so it dissolves over three zoom levels
 * instead of blinking off mid-gesture.
 */
export function zoomFade(zoom: number): number {
  const t = Math.min(
    1,
    Math.max(0, (zoom - TERMINATOR_FULL_ZOOM) / (TERMINATOR_GONE_ZOOM - TERMINATOR_FULL_ZOOM)),
  );
  return 1 - t * t * (3 - 2 * t);
}

/** How coarse the mesh is, in degrees. */
export const GRID_STEP_DEGREES = 2;

export interface Graticule {
  /** Unit sphere normals, which are the same in both projections. */
  normals: Float32Array;
  /** Equirectangular texture coordinates, north at v = 0. */
  uvs: Float32Array;
  /** Positions on the unit sphere, for the globe frame. */
  spherePositions: Float32Array;
  /** Positions in mercator units, for the mercator frame. */
  mercatorPositions: Float32Array;
  indices: Uint32Array;
}

/**
 * A lat/lon grid covering the world, in both projections at once.
 *
 * Both position sets are built from the same lat/lon pairs and share one index
 * buffer and one set of normals, so the two frames cannot disagree about which
 * vertex is where — they are the same vertex, projected twice.
 *
 * The normals are geographic, not per-frame: `dot(normal, sun)` is the sine of
 * the sun's elevation at that point on the Earth whichever way the map is
 * currently drawn, which is why the shading needs no separate treatment for
 * the two projections.
 */
export function graticule(stepDegrees: number = GRID_STEP_DEGREES): Graticule {
  const columns = Math.round(360 / stepDegrees) + 1;
  const rows = Math.round(180 / stepDegrees) + 1;
  const count = columns * rows;

  const normals = new Float32Array(count * 3);
  const spherePositions = new Float32Array(count * 3);
  const mercatorPositions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  let v = 0;
  for (let row = 0; row < rows; row += 1) {
    const lat = 90 - row * stepDegrees;
    for (let column = 0; column < columns; column += 1) {
      const lon = -180 + column * stepDegrees;
      const normal = sphereVector(lon, lat);
      normals.set(normal, v * 3);
      spherePositions.set(normal, v * 3);
      mercatorPositions[v * 3] = mercatorX(lon);
      mercatorPositions[v * 3 + 1] = mercatorY(
        Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat)),
      );
      mercatorPositions[v * 3 + 2] = 0;
      uvs[v * 2] = (lon + 180) / 360;
      uvs[v * 2 + 1] = (90 - lat) / 180;
      v += 1;
    }
  }

  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let i = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], i);
      i += 6;
    }
  }

  return { normals, uvs, spherePositions, mercatorPositions, indices };
}

/** The unit vector pointing at the sun, in the same space as the normals. */
export function subsolarVector(date: Date): Vec3 {
  const { lat, lon } = subsolarPoint(date);
  return sphereVector(lon, lat);
}

/**
 * The alpha the shader will produce for a given `dot(normal, sun)`.
 *
 * Duplicated from the fragment shader so the band can be tested without a GL
 * context — the shader is the thing that runs, and this is the thing that is
 * checked, so they are kept adjacent and the constants are shared rather than
 * retyped.
 */
export function nightAlpha(sunDot: number, strength: number = NIGHT_STRENGTH): number {
  const t = Math.min(1, Math.max(0, (sunDot - NIGHT_AT) / (DAY_AT - NIGHT_AT)));
  const daylight = t * t * (3 - 2 * t);
  return (1 - daylight) * strength;
}

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vUv = uv;
    vNormal = normal;
    // The positions are already in the projection's own space - sphere units
    // or mercator units - so there is no model matrix to apply here.
    gl_Position = projectionMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D lights;
  uniform bool hasLights;
  uniform vec3 sun;
  uniform float strength;
  uniform float gain;
  uniform float fade;
  uniform vec4 clippingPlane;
  uniform bool clipToHorizon;
  uniform float nightAt;
  uniform float dayAt;

  varying vec2 vUv;
  varying vec3 vNormal;

  void main() {
    vec3 normal = normalize(vNormal);

    // The far side of the globe, where MapLibre draws nothing to hide this.
    if (clipToHorizon && dot(normal, clippingPlane.xyz) + clippingPlane.w < 0.0) discard;

    float night = 1.0 - smoothstep(nightAt, dayAt, dot(normal, sun));
    if (night <= 0.002) discard;

    // Alpha blending does the rest: src * a + dst * (1 - a) darkens the
    // imagery underneath wherever the lights are black, and paints the lights
    // where they are not.
    vec3 lit = hasLights ? texture2D(lights, vUv).rgb * gain : vec3(0.0);
    gl_FragColor = vec4(lit, night * strength * fade);
  }
`;

export interface TerminatorRenderer {
  autoClear: boolean;
  resetState(): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
}

export interface TerminatorLayer extends CustomLayerInterface {
  /** The camera the last frame projected through, for tests to read back. */
  readonly camera: THREE.Camera;
  /** How many draws the last frame made: 0 when off, 1 on the globe, 3 wrapped. */
  drawsLastFrame(): number;
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  describe(): string;
  dispose(): void;
}

export interface TerminatorOptions {
  enabled: boolean;
  /** Equirectangular city lights. The globe's own texture, by default. */
  lightsUrl: string;
  /** Injected in tests; there is no image decoding in the test environment. */
  loadTexture?: (url: string) => THREE.Texture;
  /** Injected in tests, and so the clock can be moved in a demo. */
  now?: () => Date;
  createRenderer?: (
    canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
  ) => TerminatorRenderer;
  strength?: number;
}

/** The three wraps a mercator mesh needs, so panning does not run off its edge. */
const WRAPS = [-1, 0, 1];

export function createTerminatorLayer(options: TerminatorOptions): TerminatorLayer {
  const {
    lightsUrl,
    loadTexture = (url: string) => new THREE.TextureLoader().load(url),
    now = () => new Date(),
    createRenderer = (canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) =>
      new THREE.WebGLRenderer({ canvas, context: gl }),
    strength = NIGHT_STRENGTH,
  } = options;

  let enabled = options.enabled;
  const grid = graticule();

  const attach = (positions: Float32Array) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(grid.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(grid.uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(grid.indices, 1));
    return geometry;
  };
  const globeGeometry = attach(grid.spherePositions);
  const mercatorGeometry = attach(grid.mercatorPositions);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Nothing about this mesh belongs in the depth buffer: it is a wash over
    // what MapLibre has already drawn, and the aircraft layers come after it.
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      lights: { value: null as THREE.Texture | null },
      hasLights: { value: false },
      sun: { value: new THREE.Vector3(0, 0, 1) },
      strength: { value: strength },
      gain: { value: LIGHTS_GAIN },
      fade: { value: 1 },
      clippingPlane: { value: new THREE.Vector4(0, 0, 0, 0) },
      clipToHorizon: { value: false },
      nightAt: { value: NIGHT_AT },
      dayAt: { value: DAY_AT },
    },
  });

  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const mesh = new THREE.Mesh(globeGeometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  scene.add(mesh);

  const camera = new THREE.Camera();
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;

  let renderer: TerminatorRenderer | null = null;
  let map: MapLibreMap | null = null;
  let texture: THREE.Texture | null = null;
  let draws = 0;
  let status = 'never rendered';

  /**
   * Fetch the lights the first time the layer is switched on, not before.
   *
   * Same argument as city mode's lazy load: a user who never turns this on
   * should never pay for the texture, and the layer draws correctly without
   * it — a night side with no lights is dimmer, not broken.
   */
  const ensureTexture = () => {
    if (texture) return;
    texture = loadTexture(lightsUrl);
    // The image runs north-to-south like every equirectangular map, and the
    // texture coordinates are built the same way, so three.js must not flip it.
    texture.flipY = false;
    texture.wrapS = THREE.RepeatWrapping;
    material.uniforms.lights.value = texture;
    material.uniforms.hasLights.value = true;
  };

  return {
    id: TERMINATOR_LAYER,
    type: 'custom',
    // '2d': this deliberately takes no part in the depth buffer.
    renderingMode: '2d',
    camera,

    onAdd(addedMap: MapLibreMap, gl: WebGL2RenderingContext) {
      map = addedMap;
      renderer = createRenderer(addedMap.getCanvas(), gl);
      renderer.autoClear = false;
      if (enabled) ensureTexture();
    },

    render(_gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
      draws = 0;
      if (!renderer || !map) {
        status = 'not added to a map';
        return;
      }
      if (!enabled) {
        status = 'off';
        return;
      }

      // Past the zoom where the lights texture stops being lights, there is
      // nothing worth drawing and a great deal worth not drawing over.
      const fade = zoomFade(map.getZoom());
      if (fade <= 0.002) {
        status = `off above z${TERMINATOR_GONE_ZOOM} (the lights texture is 9.8 km per texel)`;
        return;
      }
      material.uniforms.fade.value = fade;

      const projection = args.defaultProjectionData;
      const globe = usesGlobeFrame(projection.projectionTransition);
      mesh.geometry = globe ? globeGeometry : mercatorGeometry;

      const sun = subsolarVector(now());
      (material.uniforms.sun.value as THREE.Vector3).set(sun[0], sun[1], sun[2]);
      material.uniforms.clipToHorizon.value = globe;
      (material.uniforms.clippingPlane.value as THREE.Vector4).fromArray(
        Array.from(projection.clippingPlane),
      );

      const frame = Array.from(globe ? projection.mainMatrix : projection.fallbackMatrix);
      renderer.resetState();

      // On the globe the mesh *is* the planet and one draw covers it. Under
      // mercator the world repeats east and west, and a single copy would end
      // in a hard edge as soon as the user panned past the antimeridian.
      const offsets = globe ? [0] : WRAPS;
      for (const offset of offsets) {
        camera.projectionMatrix.fromArray(
          offset === 0 ? frame : multiplyMat4(frame, translation(offset)),
        );
        renderer.render(scene, camera);
        draws += 1;
      }

      status = `on · ${globe ? 'globe' : 'mercator'} frame · ${draws} draw${
        draws === 1 ? '' : 's'
      } · fade ${fade.toFixed(2)}${texture ? '' : ' · no lights texture'}`;
    },

    setEnabled(next: boolean) {
      enabled = next;
      if (next) ensureTexture();
    },

    isEnabled() {
      return enabled;
    },

    drawsLastFrame() {
      return draws;
    },

    describe() {
      return status;
    },

    dispose() {
      globeGeometry.dispose();
      mercatorGeometry.dispose();
      material.dispose();
      texture?.dispose();
      renderer = null;
    },
  };
}

/** A column-major translation along mercator X, for the wrapped copies. */
export function translation(x: number): Mat4 {
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ];
}
