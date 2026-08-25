/**
 * The visual layer: a lit, textured Earth with a real terminator, an
 * atmospheric halo and a star field.
 *
 * Deliberately kept separate from the marker layer (globe/markers.ts) so that
 * rendering cost stays attributable. When the frame rate drops we need to know
 * whether it is the Earth or the markers, and that question is only answerable
 * if the two are separable (D16).
 *
 * Everything here is texture and shader work on geometry that already exists:
 * a handful of extra texture samples per fragment on one sphere, plus one
 * transparent sphere and a skybox. The per-frame cost is close to constant and
 * does not scale with marker count.
 *
 * Explicitly out of scope, permanently: 3D buildings, terrain meshes, tiled
 * geometry streaming. At globe zoom a building is smaller than one pixel, and
 * the data pipeline would cost more than the rest of the project (D17).
 */

import * as THREE from 'three';

import { config } from '../config';
import { subsolarPoint } from './sun';

/**
 * Fragment shader for the globe surface.
 *
 * Combines four maps into one pass:
 *
 * - **day**: the colour map, shown where the sun is up.
 * - **night**: city lights, faded in where the sun is down.
 * - **topology**: a height map, differenced in the shader to perturb the
 *   normal so mountain ranges catch light. There are no vertex tangents on a
 *   globe.gl sphere, so the tangent frame is derived analytically from the
 *   normal — for a sphere with equirectangular UVs, east and north are exact.
 * - **water**: a mask restricting specular highlight to oceans, so the sea
 *   glints and land stays matte.
 *
 * The terminator is a soft gradient rather than a hard line because the real
 * one is: Earth's atmosphere scatters light past the geometric edge, and a
 * hard line reads as a rendering artefact.
 */
const globeFragmentShader = /* glsl */ `
  uniform sampler2D dayTexture;
  uniform sampler2D nightTexture;
  uniform sampler2D bumpTexture;
  uniform sampler2D waterTexture;
  uniform vec3 sunDirection;
  uniform float bumpScale;
  uniform vec2 bumpTexelSize;

  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec3 vViewPosition;

  void main() {
    vec3 normal = normalize(vNormal);

    // Analytic tangent frame. On a sphere with equirectangular UVs, "east" is
    // perpendicular to both the polar axis and the surface normal.
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 east = normalize(cross(up, normal));
    vec3 north = cross(normal, east);

    // Finite-difference the height map to get a slope, then tilt the normal.
    float h = texture2D(bumpTexture, vUv).r;
    float hEast = texture2D(bumpTexture, vUv + vec2(bumpTexelSize.x, 0.0)).r;
    float hNorth = texture2D(bumpTexture, vUv + vec2(0.0, bumpTexelSize.y)).r;
    vec3 perturbed = normalize(
      normal - bumpScale * ((hEast - h) * east + (hNorth - h) * north) * 40.0
    );

    float lambert = dot(perturbed, sunDirection);

    // Soft terminator, several degrees wide, matching atmospheric scattering.
    float daylight = smoothstep(-0.15, 0.25, lambert);

    vec3 dayColor = texture2D(dayTexture, vUv).rgb;
    vec3 nightColor = texture2D(nightTexture, vUv).rgb;

    // A little ambient so the dark side is never pure black, which reads as a
    // hole in the globe rather than as night.
    vec3 lit = dayColor * (0.06 + 0.94 * max(lambert, 0.0));

    // City lights only where it is genuinely dark, and never over daylight.
    float nightMix = 1.0 - daylight;
    vec3 color = mix(lit, lit * 0.15 + nightColor * 1.5, nightMix);

    // Specular on water only. Blinn-Phong against the view direction.
    float water = texture2D(waterTexture, vUv).r;
    vec3 viewDir = normalize(vViewPosition);
    vec3 halfway = normalize(sunDirection + viewDir);
    float specular = pow(max(dot(perturbed, halfway), 0.0), 60.0);
    color += vec3(0.7, 0.8, 1.0) * specular * water * daylight * 0.6;

    gl_FragColor = vec4(color, 1.0);
  }
`;

const globeVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec2 vUv;
  varying vec3 vViewPosition;

  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -viewPosition.xyz;
    gl_Position = projectionMatrix * viewPosition;
  }
`;

/**
 * Fresnel shader for the atmosphere.
 *
 * A slightly larger sphere rendered from the inside with additive blending.
 * The fresnel term — brightness rising as the surface turns away from the
 * viewer — puts the glow at the limb, which is where an atmosphere is
 * actually visible from space.
 */
const atmosphereFragmentShader = /* glsl */ `
  uniform vec3 glowColor;
  uniform vec3 sunDirection;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;

  void main() {
    float rim = pow(0.72 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 3.0);

    // Dim the halo on the night side, so the glow follows the terminator
    // rather than ringing the planet evenly.
    float daylight = smoothstep(-0.35, 0.35, dot(normalize(vWorldNormal), sunDirection));
    gl_FragColor = vec4(glowColor, 1.0) * clamp(rim, 0.0, 1.0) * (0.25 + 0.75 * daylight);
  }
`;

const atmosphereVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldNormal;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export interface EarthVisuals {
  material: THREE.ShaderMaterial;
  atmosphere: THREE.Mesh;
  starField: THREE.Mesh;
  /** Point the lighting at the sun's real position for `date`. */
  setSunFromDate(date: Date): void;
  dispose(): void;
}

/**
 * Convert a lat/lon into the globe's local coordinate frame.
 *
 * three-globe's convention is exposed by `globe.getCoords()`, but the material
 * is built before the globe is laid out, so the conversion is duplicated here.
 * Matching it exactly matters: an inverted axis puts the sun on the wrong side
 * of the planet, and the terminator would be plausible but wrong.
 */
export function latLonToVector3(lat: number, lon: number, radius = 1): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (90 - lon) * (Math.PI / 180);
  return new THREE.Vector3(
    radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

export function createEarthVisuals(globeRadius: number): EarthVisuals {
  const loader = new THREE.TextureLoader();

  const load = (url: string, srgb: boolean): THREE.Texture => {
    const texture = loader.load(url);
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    return texture;
  };

  const dayTexture = load(config.textures.day, true);
  const nightTexture = load(config.textures.night, true);
  const bumpTexture = load(config.textures.topology, false);
  const waterTexture = load(config.textures.water, false);

  const sunDirection = new THREE.Vector3(1, 0, 0);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayTexture },
      nightTexture: { value: nightTexture },
      bumpTexture: { value: bumpTexture },
      waterTexture: { value: waterTexture },
      sunDirection: { value: sunDirection },
      bumpScale: { value: config.bumpScale },
      // Texel size for the finite difference. Assumes a 2:1 equirectangular
      // map; a wrong value only changes how pronounced the relief looks.
      bumpTexelSize: { value: new THREE.Vector2(1 / 4096, 1 / 2048) },
    },
    vertexShader: globeVertexShader,
    fragmentShader: globeFragmentShader,
  });

  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(globeRadius * 1.02, 64, 64),
    new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(0x3a86ff) },
        sunDirection: { value: sunDirection },
      },
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    }),
  );
  atmosphere.name = 'atmosphere';

  const starTexture = load(config.textures.stars, true);
  const starField = new THREE.Mesh(
    // Large enough to sit behind everything, small enough to stay inside the
    // camera's far plane.
    new THREE.SphereGeometry(globeRadius * 90, 32, 32),
    new THREE.MeshBasicMaterial({
      map: starTexture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  starField.name = 'starField';

  function setSunFromDate(date: Date): void {
    const { lat, lon } = subsolarPoint(date);
    sunDirection.copy(latLonToVector3(lat, lon, 1)).normalize();
  }

  setSunFromDate(new Date());

  return {
    material,
    atmosphere,
    starField,
    setSunFromDate,
    dispose() {
      material.dispose();
      atmosphere.geometry.dispose();
      (atmosphere.material as THREE.Material).dispose();
      starField.geometry.dispose();
      (starField.material as THREE.Material).dispose();
      [dayTexture, nightTexture, bumpTexture, waterTexture, starTexture].forEach((t) =>
        t.dispose(),
      );
    },
  };
}
