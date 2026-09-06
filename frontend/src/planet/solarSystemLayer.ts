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
import {
  equatorialToGlobe,
  orbitRing,
  scenePlacements,
  type ScenePlacement,
} from '../solarFrame';
import { drawnBodyRadius } from '../solarScale';
import { onScreen, project } from '../solarMarkers';
import { PLANET_IDS, type PlanetId } from '../planets';
import { usesGlobeFrame } from './modelFrame';
import {
  STARS,
  STAR_COUNT,
  skyRadius,
  starColour,
  starDirection,
  starSize,
} from '../stars';
import { readCamera } from '../cameraFrame';
import { RING_INNER, RING_OUTER, ringProfile } from '../saturnRings';
import { poleDirection } from '../planetPoles';
import { hasSurface, surfaceTexture } from '../planetSurface';

export const SOLAR_LAYER = 'orbital-solar-system';

/**
 * Above this zoom the system is not drawn.
 *
 * At zoom 0 the globe is 78 px and 18 radii would be 1,400 px off-screen; the
 * planets only have somewhere to be once the globe is small. Below this they
 * fade in, so the transition is a dissolve rather than an appearance.
 */
/**
 * **The handover point, and there is only one.**
 *
 * The planets used to start fading in here at 0.5 while the globe stayed until
 * -1.0, which left a zoom and a half where both worlds were on screen: a
 * full-size Earth sitting among planets drawn a twentieth of its size, with
 * Jupiter smaller than the globe it orbits beside. Every fix aimed at the
 * overlap kept missing because the overlap was not a leak, it was the design -
 * two numbers for one transition (D144).
 *
 * One number now. Above it, the globe and nothing else; below it, the solar
 * system and no globe. The imagery and the atmosphere dissolve on the approach
 * so the swap is not a cut.
 */
export const SOLAR_MAX_ZOOM = -1.0;

/** Where the planets reach full opacity, half a zoom below the handover. */
export const SOLAR_FULL_ZOOM = -1.5;

/** Colours by body, matching the picker's dots so the two agree. */
export const COLOURS: Record<string, number> = {
  sun: 0xffd166, mercury: 0x9c8b7d, venus: 0xe6c884, mars: 0xd1603d,
  jupiter: 0xd7a06a, saturn: 0xe3cfa0, uranus: 0x9fd8e0, neptune: 0x6b8fd6,
};

export interface SolarLayer extends CustomLayerInterface {
  /** Whether the last frame drew anything, for the status readout. */
  report(): string;
  /**
   * Where each body was drawn on screen, in CSS pixels, from the last frame.
   *
   * **Published by the thing that drew them**, because nothing else can know:
   * the bodies are at different distances in a 3D scene, and their direction
   * from the camera says nothing about where along that ray a sphere ended up
   * (D159). Empty whenever the layer is not drawing.
   */
  markers(): BodyMarker[];
}

export interface BodyMarker {
  id: string;
  x: number;
  y: number;
  /** How wide the body is on screen, so a label can clear it. */
  sizePx: number;
}

function radiusKmOf(id: string): number {
  return BODIES.find((b) => b.id === id)?.radiusKm ?? 1_000;
}

/**
 * The world under the camera, and its companion if it has one.
 *
 * Earth and the Moon are **0.0026 AU apart**, which this compression cannot
 * resolve: `radiusFor` maps that separation to less than a thousandth of a
 * globe radius, so drawn truthfully they occupy the same point and the one in
 * front simply hides the other. That is what "the Moon and the Earth overlap"
 * was.
 *
 * They are not one object, so they are not drawn as one. The companion is set
 * beside its partner by a **fixed, admitted offset** - far enough apart to read
 * as two worlds, and no claim at all about where the Moon actually is this
 * week. Everything else in this scene is a real position; this is the one
 * arrangement that is not, and it is here rather than buried in the layer so
 * that it can be said out loud (D140).
 */
export function homeBodies(standingOn: string, _date: Date): ScenePlacement[] {
  const pair: Record<string, string> = { earth: 'moon', moon: 'earth' };
  const companion = pair[standingOn];
  const home: ScenePlacement = {
    id: standingOn as ScenePlacement['id'],
    at: [0, 0, 0],
    distanceAu: 0,
  };
  if (!companion) return [home];
  return [
    home,
    {
      id: companion as ScenePlacement['id'],
      at: [COMPANION_OFFSET, 0, 0],
      distanceAu: 0,
    },
  ];
}

/**
 * How far apart the pair is drawn, in globe radii.
 *
 * Chosen so the two are clearly separate at the zoom the handover happens and
 * still close enough to read as a pair rather than as two unrelated bodies.
 */
export const COMPANION_OFFSET = 0.55;

export function createSolarSystemLayer(
  now: () => Date,
  destination: () => string | null = () => null,
  origin: () => PlanetId = () => 'earth',
  /** The world actually under the camera, which may be a moon. */
  standingOn: () => string = () => 'earth',
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
   * The sky, as a sphere centred on the camera rather than on the Earth.
   *
   * 5,070 real stars. The radius comes from the projection matrix every frame -
   * just inside the far plane - so the sphere always surrounds the camera and
   * always sits behind everything real. `stars.ts` carries the reasoning; the
   * short version is that a fixed radius cannot be both unclipped and beyond
   * the globe, and the camera is 83 globe radii out (D128, D129).
   */
  const starGeometry = new THREE.BufferGeometry();
  const starPositions = new Float32Array(STAR_COUNT * 3);
  // Unit directions in the globe frame, rebuilt only when the Earth has turned
  // far enough to see. Per frame this leaves one multiply and one add per star
  // instead of a coordinate conversion per star.
  const starDirections = new Float32Array(STAR_COUNT * 3);
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
  starGeometry.setAttribute('size', new THREE.BufferAttribute(starSizes, 1));

  /**
   * Points sized per star, which `PointsMaterial` cannot do.
   *
   * The sizes were being computed and thrown away: `PointsMaterial` has one
   * size for the whole cloud, so every star drew identically and `starSize` -
   * tested, magnitude-correct - reached the screen as a constant. A dozen lines
   * of shader is what makes Sirius bigger than its neighbours (D129).
   */
  const SIZE_PIXELS = 80;
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: { scale: { value: SIZE_PIXELS }, opacity: { value: 1 } },
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      uniform float scale;
      varying vec3 vColour;
      void main() {
        vColour = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = max(1.0, size * scale);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform float opacity;
      varying vec3 vColour;
      void main() {
        // Round with a soft edge. A square star is unmistakably a square.
        float d = length(gl_PointCoord - vec2(0.5));
        float alpha = smoothstep(0.5, 0.15, d);
        if (alpha <= 0.0) discard;
        gl_FragColor = vec4(vColour, alpha * opacity);
      }
    `,
    transparent: true,
    // Depth testing on, so the Earth blocks the sky behind it. Depth writing
    // off, so the sky blocks nothing.
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  stars.renderOrder = -1;
  scene.add(stars);
  let starsBuiltFor = 0;

  // What the sky was last hung on. Re-placing 5,070 stars means a 60 kB buffer
  // upload, and the camera is still on most frames - the map repaints for
  // aircraft moving, not only for the reader moving.
  let hungOn: [number, number, number, number] | null = null;

  /** Turn the catalogue into globe-frame directions for this instant. */
  const aimStars = (date: Date) => {
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const dir = starDirection(STARS.ra[i], STARS.dec[i]);
      const v = equatorialToGlobe({ x: dir[0], y: dir[1], z: dir[2] }, date);
      starDirections[i * 3] = v[0];
      starDirections[i * 3 + 1] = v[1];
      starDirections[i * 3 + 2] = v[2];
    }
    starsBuiltFor = date.getTime();
    // The directions changed underneath the cached placement, so it is stale.
    hungOn = null;
  };

  /** Hang the sky on a sphere of this radius around the camera. */
  const placeSky = (at: readonly [number, number, number], radius: number) => {
    // A tenth of a globe radius is far below one pixel at these distances.
    if (
      hungOn &&
      Math.abs(hungOn[0] - at[0]) < 0.1 &&
      Math.abs(hungOn[1] - at[1]) < 0.1 &&
      Math.abs(hungOn[2] - at[2]) < 0.1 &&
      Math.abs(hungOn[3] - radius) < 0.1
    ) {
      return;
    }
    hungOn = [at[0], at[1], at[2], radius];
    for (let i = 0; i < STAR_COUNT; i += 1) {
      starPositions[i * 3] = at[0] + starDirections[i * 3] * radius;
      starPositions[i * 3 + 1] = at[1] + starDirections[i * 3 + 1] * radius;
      starPositions[i * 3 + 2] = at[2] + starDirections[i * 3 + 2] * radius;
    }
    starGeometry.attributes.position.needsUpdate = true;
  };

  // Light from the Sun, so a planet has a day and a night side, with the
  // terminator in the place the geometry puts it.
  //
  // The ambient term is not decoration and not laziness. **The camera's
  // distance is compressed and the system's is compressed differently**: the
  // whole solar system is squeezed into 18 globe radii while the camera sits
  // about 30 out, so it views every planet from *outside* its orbit. Measured
  // phase angles from that vantage point run 141 to 171 degrees - every planet
  // is a new moon. In reality Jupiter seen from Earth never exceeds about 12
  // degrees of phase, because Earth is inside its orbit.
  //
  // So strict phase here is not more honest, it is an artefact of the
  // compression - and it renders the entire system as black discs. The Sun
  // still sets the direction and the terminator; the ambient makes the night
  // side legible rather than absent (D132).
  const sunlight = new THREE.PointLight(0xfff2d0, 2.4, 0, 0);
  const ambient = new THREE.AmbientLight(0x9fb0c8, 1.9);
  scene.add(sunlight, ambient);

/**
 * Stop the far plane cutting the scene in half.
 *
 * Measured: **146 of 679 orbit vertices - 21% - fall outside the far plane**,
 * at every zoom. D129 found why: MapLibre puts the far plane one globe radius
 * past the centre, so anything more than one radius *behind* the Earth is cut.
 * For a scene 18 radii across that removes the far side of every orbit and
 * takes a crescent bite out of any body sitting away from the camera - which
 * is what "the rings go void" was.
 *
 * The projection cannot be widened: the depth values MapLibre already wrote for
 * the globe were written with this one, and remapping them would break which
 * things hide behind the Earth. So the depth is *clamped* instead - a vertex
 * past the far plane is drawn at the far plane rather than discarded. That is
 * also the honest depth for it: it is the farthest thing in the scene, so
 * sitting at the maximum is where it belongs, and the Earth still occludes it
 * (D130).
 */
const clampToFarPlane = (material: THREE.Material): THREE.Material => {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
       gl_Position.z = min(gl_Position.z, gl_Position.w * 0.9999);`,
    );
  };
  return material;
};

  /**
   * A body's latitude profile as a one-pixel-wide strip.
   *
   * `planetSurface.ts` explains why this is generated rather than downloaded;
   * the short version is that a photographic map is megabytes of detail that is
   * invisible at 20 pixels, and what is *visible* is which latitudes are dark.
   * The sphere's own UVs run south pole to north, which is the order the strip
   * is filled in.
   */
  const surfaceMap = (id: string): THREE.DataTexture => {
    const texture = new THREE.DataTexture(surfaceTexture(id, 256), 1, 256, THREE.RGBAFormat);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    // The band colours are written as sRGB bytes, which is how they were
    // chosen; without this they are decoded as linear and every planet comes
    // out washed against the ones drawn from a plain colour.
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  };

  const SPHERE_UP = new THREE.Vector3(0, 1, 0);
  const bodyPole = new THREE.Vector3();

  const spheres = new Map<string, THREE.Mesh>();
  let orbitsBuiltFor = 0;
  let orbitsBuiltAround: PlanetId | null = null;

  const buildOrbits = (date: Date, centre: PlanetId) => {
    orbits.clear();
    for (const planet of PLANET_IDS) {
      if (planet === centre) continue;
      const points = orbitRing(planet, date, 96, centre).map((p) => new THREE.Vector3(...p));
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        clampToFarPlane(
          new THREE.LineBasicMaterial({
            color: COLOURS[planet] ?? 0x8899aa,
            transparent: true,
            opacity: 0.28,
          }),
        ),
      );
      // Same reason as the spheres: an orbit that reaches past the far plane is
      // culled whole, so a ring would disappear rather than shorten.
      line.frustumCulled = false;
      orbits.add(line);
    }
    orbitsBuiltFor = date.getTime();
    orbitsBuiltAround = centre;
  };

  const sphereFor = (id: string): THREE.Mesh => {
    let mesh = spheres.get(id);
    if (!mesh) {
      // The scale every body shares, unchanged since D122. The world under the
      // camera is drawn on this same scale too - see `originSphere` - which is
      // what stops it looming over the system it belongs to (D137).
      const r = drawnBodyRadius(radiusKmOf(id));
      // The Sun emits, so it stays unlit. Everything else is lit *by* it, which
      // is what turns a flat coloured disc into a body with a terminator - and
      // the phase is correct, because the light is where the Sun is.
      const material = clampToFarPlane(
        id === 'sun'
          ? new THREE.MeshBasicMaterial({ color: COLOURS.sun, transparent: true })
          : new THREE.MeshStandardMaterial({
              // White under a texture, so the map's own colours come through
              // rather than being multiplied by a second one.
              color: hasSurface(id) ? 0xffffff : (COLOURS[id] ?? 0xaaaaaa),
              map: hasSurface(id) ? surfaceMap(id) : null,
              transparent: true,
              roughness: 0.95,
              metalness: 0,
            }),
      );
      mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 18), material);
      // **Culling must be off, and D130 is the reason.**
      //
      // three.js culls on the CPU against the frustum it derives from this same
      // projection matrix - including its far plane, which sits one globe radius
      // past the centre. So the objects the shader clamp exists to keep drawing
      // were being thrown away before the shader ever ran, and planets vanished
      // at the angles that put them behind the Earth. The clamp handles the
      // depth; this handles the culling; neither works alone (D133).
      mesh.frustumCulled = false;
      spheres.set(id, mesh);
      bodies.add(mesh);
    }
    return mesh;
  };

  /**
   * Saturn's rings.
   *
   * The one thing in this scene with real structure at the size it is drawn,
   * and the reason it is worth the shader: a bright B ring, a dimmer A ring,
   * and the Cassini division between them. `saturnRings.ts` holds the radii and
   * the tests; this builds an annulus of the right proportions and points it
   * the right way.
   *
   * **Not modelled in Blender, and not because of effort.** The rings are a
   * flat annulus with a radial brightness profile - that is what they are, not
   * a simplification of them - so a mesh would be the same annulus with more
   * triangles and a texture baked at one resolution instead of sampled at the
   * right one. What was actually wrong with the rings was D130's clipping, and
   * no model fixes that (D131).
   */
  let builtForAnchor = '';
  let drawnMarkers: BodyMarker[] = [];
  let ringMesh: THREE.Mesh | null = null;
  let ringMaterial: THREE.ShaderMaterial | null = null;
  const RING_UP = new THREE.Vector3(0, 0, 1);
  const ringNormal = new THREE.Vector3();

  const buildRing = () => {
    const r = drawnBodyRadius(radiusKmOf('saturn'));
    const profile = new THREE.DataTexture(ringProfile(512), 512, 1, THREE.RGBAFormat);
    profile.minFilter = THREE.LinearFilter;
    profile.magFilter = THREE.LinearFilter;
    profile.wrapS = THREE.ClampToEdgeWrapping;
    profile.needsUpdate = true;

    ringMaterial = new THREE.ShaderMaterial({
      uniforms: {
        profile: { value: profile },
        inner: { value: RING_INNER * r },
        outer: { value: RING_OUTER * r },
        tint: { value: new THREE.Color(0xdccdaa) },
        opacity: { value: 1 },
      },
      vertexShader: `
        varying vec2 vLocal;
        void main() {
          // The ring lies in its own XY plane, so the local position is the
          // radial coordinate the profile is indexed by.
          vLocal = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = min(gl_Position.z, gl_Position.w * 0.9999);
        }
      `,
      fragmentShader: `
        precision mediump float;
        uniform sampler2D profile;
        uniform float inner;
        uniform float outer;
        uniform float opacity;
        uniform vec3 tint;
        varying vec2 vLocal;
        void main() {
          float t = (length(vLocal) - inner) / (outer - inner);
          if (t < 0.0 || t > 1.0) discard;
          float a = texture2D(profile, vec2(t, 0.5)).r;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(tint, a * opacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(RING_INNER * r, RING_OUTER * r, 128, 1),
      ringMaterial,
    );
    ringMesh.frustumCulled = false;
    bodies.add(ringMesh);
  };

  /** Point the rings along Saturn's own pole and hang them on the planet. */
  const placeRing = (at: readonly [number, number, number], date: Date, alpha: number, scale: number) => {
    if (!ringMesh || !ringMaterial) return;
    const pole = poleDirection('saturn', date);
    ringNormal.set(pole[0], pole[1], pole[2]).normalize();
    ringMesh.quaternion.setFromUnitVectors(RING_UP, ringNormal);
    ringMesh.position.set(at[0], at[1], at[2]);
    ringMesh.scale.setScalar(scale);
    ringMaterial.uniforms.opacity.value = alpha;
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
        // Cleared, not left standing: labels over bodies that are no longer
        // drawn are the same false claim as a layer drawn where its subject
        // does not exist (D120).
        drawnMarkers = [];
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

      // Body radii are baked into geometry, so anything they depend on has to
      // rebuild them when it changes. **Nothing does, any more.** The one thing
      // that did was the true-scale toggle, which is gone (D156), and a radius
      // depends on neither the date nor the world underfoot - so this anchor is
      // now a constant and the spheres are built exactly once.
      //
      // Kept rather than deleted because the alternative was anchoring on the
      // origin, which would dispose and rebuild eight spheres and a ring in the
      // middle of a flight, for a set of radii that had not changed. The
      // machinery costs one comparison a frame and is where the next thing
      // baked into geometry has to declare itself.
      const anchor = 'radii';
      if (anchor !== builtForAnchor) {
        for (const mesh of spheres.values()) {
          mesh.geometry.dispose();
          bodies.remove(mesh);
        }
        spheres.clear();
        if (ringMesh) {
          ringMesh.geometry.dispose();
          bodies.remove(ringMesh);
          ringMesh = null;
          ringMaterial = null;
        }
        builtForAnchor = anchor;
      }
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
      // The sky turns with the Earth, so the directions are recomputed when the
      // rotation has moved enough to see - about every four minutes of real
      // time - and re-hung on the camera every frame, because the camera moves
      // whenever the reader does.
      if (Math.abs(date.getTime() - starsBuiltFor) > 240_000) aimStars(date);
      const view = readCamera(matrix as unknown as number[]);
      const sky =
        view && skyRadius(view.near, view.far, Math.hypot(...view.at));
      if (view && sky) placeSky(view.at, sky);
      stars.visible = Boolean(view && sky);

      const heading = destination();
      // **The world under the camera, drawn among its neighbours.** MapLibre
      // keeps its globe at radius 1 however far the camera pulls back, so it
      // cannot shrink and ends up looking the size of the Sun. The basemap
      // switches that globe off across this same range and this draws the body
      // properly scaled in its place - which is the whole of "the selected
      // planet should get smaller when I zoom out" (D139).
      // The world under the camera is drawn among its neighbours whenever this
      // layer draws at all, because the globe it replaces is gone by then: the
      // handover and the first frame of the solar system are the same moment
      // (D144).
      const placements: ScenePlacement[] = [
        ...scenePlacements(date, centre),
        ...homeBodies(standingOn(), date),
      ];
      const sun = placements.find((p) => p.id === 'sun');
      if (sun) sunlight.position.set(sun.at[0], sun.at[1], sun.at[2]);
      for (const placement of placements) {
        const mesh = sphereFor(placement.id);
        mesh.position.set(placement.at[0], placement.at[1], placement.at[2]);
        const emphasis = !heading || placement.id === heading ? 1 : 0.35;
        (mesh.material as THREE.Material).opacity = fade * emphasis;
        mesh.scale.setScalar(heading === placement.id ? 1.6 : 1);
        // Stand the body on its own axis. Bands run along latitude, so a
        // planet left in the globe frame would wear Earth's tilt - which on
        // Uranus, whose pole lies almost in the ecliptic, is close to a right
        // angle wrong (D132).
        const pole = poleDirection(placement.id, date);
        bodyPole.set(pole[0], pole[1], pole[2]).normalize();
        mesh.quaternion.setFromUnitVectors(SPHERE_UP, bodyPole);
      }

      const saturn = placements.find((p) => p.id === 'saturn');
      if (saturn) {
        if (!ringMesh) buildRing();
        if (ringMesh) ringMesh.visible = true;
        placeRing(
          saturn.at,
          date,
          fade * (!heading || heading === 'saturn' ? 1 : 0.35),
          heading === 'saturn' ? 1.6 : 1,
        );
      } else if (ringMesh) {
        // Absent from the placements means Saturn is the world being stood on,
        // and the rings are underfoot rather than in the sky.
        ringMesh.visible = false;
      }
      starMaterial.uniforms.opacity.value = fade;
      orbits.children.forEach((line) => {
        ((line as THREE.Line).material as THREE.LineBasicMaterial).opacity = 0.28 * fade;
      });

      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix as unknown as number[]);
      renderer.resetState();
      renderer.render(scene, camera);

      // Where they landed, with the same matrix that just drew them, so the
      // chrome above cannot disagree with the picture (D159).
      const canvas = host?.getCanvas();
      const width = canvas?.clientWidth ?? 0;
      const height = canvas?.clientHeight ?? 0;
      const found: BodyMarker[] = [];
      if (width > 0 && height > 0) {
        const raw = matrix as unknown as number[];
        for (const placement of placements) {
          const at = project(raw, placement.at, width, height);
          if (!onScreen(at, width, height)) continue;
          // The drawn radius through the same projection: a point one radius
          // to the side, so the label clears a big planet and hugs a small one.
          const edge = project(
            raw,
            [placement.at[0] + drawnBodyRadius(radiusKmOf(placement.id)), placement.at[1], placement.at[2]],
            width,
            height,
          );
          found.push({
            id: placement.id,
            x: at.x,
            y: at.y,
            sizePx: edge.inFront ? Math.abs(edge.x - at.x) * 2 : 0,
          });
        }
      }
      drawnMarkers = found;
      // The camera numbers are in the readout deliberately. The last attempt at
      // a sky failed on exactly these three, and none of them were visible.
      const where = view
        ? `cam ${Math.hypot(...view.at).toFixed(0)}r near ${view.near.toFixed(2)} far ${view.far.toFixed(0)}`
        : 'no camera';
      status = `${placements.length} bodies, fade ${fade.toFixed(
        2,
      )}, sky ${sky ? `${sky.toFixed(0)}r` : 'none'}, ${where}`;
    },

    report() {
      return status;
    },

    markers() {
      return drawnMarkers;
    },
  };
}

/** Exported for the readout and for tests that need the zoom rule. */
export function solarIsLive(zoom: number, projectionTransition: number): boolean {
  return zoom <= SOLAR_MAX_ZOOM && usesGlobeFrame(projectionTransition);
}

export type { PlanetId };
