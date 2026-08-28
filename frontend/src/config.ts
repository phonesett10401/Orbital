/**
 * Frontend configuration, from Vite environment variables.
 *
 * Texture paths are config-driven so resolution can be traded against load
 * time without a code change. The defaults are NASA Blue Marble imagery that
 * ships inside `three-globe` — already a dependency of globe.gl — copied into
 * `public/textures/` by `scripts/copy-textures.mjs` before dev and build. So
 * the globe looks like Earth out of the box, with no CDN dependency, no
 * binaries committed to this repository, and no network needed beyond
 * `npm install` (D30).
 *
 * To use higher-resolution imagery, drop files into `public/textures/` and set
 * the matching `VITE_*` variable to e.g. `/textures/earth-8k.jpg`.
 */

const TEXTURE_DIR = '/textures';
const earthDay = `${TEXTURE_DIR}/earth-blue-marble.jpg`;
const earthNight = `${TEXTURE_DIR}/earth-night.jpg`;
const earthTopology = `${TEXTURE_DIR}/earth-topology.png`;
const earthWater = `${TEXTURE_DIR}/earth-water.png`;
const nightSky = `${TEXTURE_DIR}/night-sky.png`;

function str(value: string | undefined, fallback: string): string {
  return value && value.length > 0 ? value : fallback;
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  /** Backend base URL. The Vite dev server proxies /api, so this is usually ''. */
  apiBase: str(import.meta.env.VITE_API_BASE, ''),

  /** How often the browser asks the backend for new positions. */
  pollIntervalMs: num(import.meta.env.VITE_POLL_INTERVAL_MS, 10_000),

  /** Maximum markers requested. Matches the backend's thinning cap (D15). */
  maxObjects: num(import.meta.env.VITE_MAX_OBJECTS, 2000),

  textures: {
    /** Equirectangular colour map. NASA Blue Marble by default. */
    day: str(import.meta.env.VITE_EARTH_DAY_TEXTURE, earthDay),
    /** City lights, blended in on the unlit side by sun angle. */
    night: str(import.meta.env.VITE_EARTH_NIGHT_TEXTURE, earthNight),
    /** Height map, used to perturb normals so terrain catches light. */
    topology: str(import.meta.env.VITE_EARTH_BUMP_TEXTURE, earthTopology),
    /** Water mask, driving specular reflection so oceans shine and land does not. */
    water: str(import.meta.env.VITE_EARTH_SPECULAR_TEXTURE, earthWater),
    /** Star field on the inside of a large background sphere. */
    stars: str(import.meta.env.VITE_STARFIELD_TEXTURE, nightSky),
  },

  /**
   * Height exaggeration for the bump map.
   *
   * Real relief is invisible at this scale — Everest is 0.14% of Earth's
   * radius — so this is deliberately not physical. It exists to make mountain
   * ranges legible, and is tuned by eye.
   */
  bumpScale: num(import.meta.env.VITE_BUMP_SCALE, 0.035),

  /**
   * Strength of the specular glint on water, and how tightly it falls off.
   *
   * Not physical, and tuned by eye like `bumpScale` — what is being chosen is
   * how sun glint should read at globe scale.
   *
   * The history is worth carrying, because it is a lesson about measuring the
   * wrong quantity. It shipped at 0.6 and 60: a patch 18° of arc across, which
   * was plainly a smudge. Retuned to 0.35 and 400 it measured 6° across and a
   * tenth of the area — better by every number recorded, and still a glowing
   * ball to somebody looking at it. The number that mattered was never the
   * size: the ocean beneath the glint sits at 9/255, so a peak of 89 is ten
   * times brighter than the water it is supposed to be reflecting off, which
   * reads as a lamp behind the planet rather than as sun on the sea. At 0.08
   * and 900 the peak is 20, about twice the water under it: a sheen you catch
   * at the right sun angle rather than a light source (D49).
   *
   * Raising the exponent tightens the lobe; raising the strength brightens it.
   * `__orbital.earth.setGlint(strength, shininess)` changes both live.
   */
  specularStrength: num(import.meta.env.VITE_SPECULAR_STRENGTH, 0.08),
  specularShininess: num(import.meta.env.VITE_SPECULAR_SHININESS, 900),

  /**
   * Basemap style for city mode, the zoom-in spike (D52).
   *
   * OpenFreeMap: no API key, no registration, no usage cap, OpenStreetMap data
   * under ODbL. Its Liberty style already carries a `building-3d`
   * fill-extrusion layer from zoom 14, which is the thing being evaluated.
   *
   * **This is the one request in the app that leaves for a third party**, and
   * it contradicts D7 — the browser talks to our backend and nothing else. It
   * is a deliberate, visible exception for a spike. If city mode becomes real,
   * this points at a Protomaps `.pmtiles` extract served by our own backend:
   * one static file, no third party at runtime, no limits at all.
   */
  cityStyleUrl: str(
    import.meta.env.VITE_CITY_STYLE_URL,
    'https://tiles.openfreemap.org/styles/liberty',
  ),

  /**
   * Whether zooming past the threshold hands over to city mode at all.
   *
   * On by default because the spike exists to be looked at, and off with
   * `VITE_CITY_MODE=off` — which is also the switch that restores the
   * project's usual posture of the browser talking to nothing but our own
   * backend (D7).
   */
  cityMode: str(import.meta.env.VITE_CITY_MODE, 'on') !== 'off',

  /**
   * Which renderer draws the world.
   *
   * `globe` is globe.gl and everything built on it; `planet` is the MapLibre
   * view being migrated to (D54). Two entry points rather than a rewrite in
   * place: the working globe is untouched while the new one reaches parity,
   * and abandoning the direction costs deleting a folder.
   */
  view: str(import.meta.env.VITE_VIEW, 'globe') === 'planet' ? 'planet' : 'globe',

  /**
   * Globe altitude, in radii, at which city mode takes over.
   *
   * Tunable because it is a judgement about where the globe stops being worth
   * looking at, and that is measured rather than felt: the colour texture is
   * 9.8 km per texel, which at 0.35 radii is about five texels per screen
   * pixel and at 0.05 is thirty-six (D53). `__orbital.city` reports the
   * current altitude, so the boundary can be found by eye and set here.
   */
  cityEnterAltitude: num(import.meta.env.VITE_CITY_ALTITUDE, 0.35),

  /**
   * Satellite imagery for the planet view, as XYZ tiles.
   *
   * NASA GIBS, no API key and no registration: `BlueMarble_NextGeneration` is
   * static, cloud-free and 500 m per pixel — about forty times sharper than
   * the single JPEG the globe.gl view stretched over the whole planet, and it
   * runs out at zoom 8, where the vector map takes over (D54).
   *
   * Note the path order. GIBS is WMTS, so it is `{z}/{row}/{col}` — which is
   * `{z}/{y}/{x}`, not the `{z}/{x}/{y}` of an XYZ service. Swapping them
   * returns tiles of the wrong place rather than an error.
   */
  imageryTileUrl: str(
    import.meta.env.VITE_IMAGERY_TILE_URL,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration' +
      '/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
  ),

  /**
   * Close-range imagery, where the 500 m one runs out.
   *
   * Sentinel-2 cloudless from EOX: 10 m per pixel, cloud-free, global, to zoom
   * 15 — fifty times finer than GIBS and the difference between "a continent
   * from space" and "the field next to the runway". No API key.
   *
   * **Its terms are fair use rather than unlimited**, which the low-zoom
   * source is not, and that is why there are two: GIBS carries every view of
   * the planet and this one is only reached by zooming past a continent. The
   * attribution EOX asks for is carried on the source. Self-hosting is the
   * answer if this ever sees real traffic.
   */
  imageryCloseTileUrl: str(
    import.meta.env.VITE_IMAGERY_CLOSE_TILE_URL,
    'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default' +
      '/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
  ),

  /** Freeze the sun at a fixed time, for screenshots and deterministic demos. */
  fixedSunTime: str(import.meta.env.VITE_FIXED_SUN_TIME, ''),
} as const;

export type Config = typeof config;
