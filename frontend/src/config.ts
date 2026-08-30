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
   * Whether the planet view starts with the day/night terminator drawn.
   *
   * **Off by default, and that is the point.** On the globe the terminator was
   * the view: a lit sphere in space is what the sun is doing to it. On a map
   * it is a wash over the thing the user came to read, and a night side hides
   * the imagery, the roads and the place names underneath it. So it is offered
   * rather than imposed - the button in the corner turns it on, and
   * `VITE_TERMINATOR=on` starts it that way (D68).
   */
  terminator: str(import.meta.env.VITE_TERMINATOR, 'off') !== 'off',

  /**
   * Which basemap the planet view starts on.
   *
   * `imagery` is the satellite photograph with cartography over it; `flat` is
   * the vector basemap on its own, the look every ride-hailing app uses.
   * Imagery by default because it is what makes an aircraft tracker read as
   * one - a flight over a photograph of the ground is the picture the app is
   * for - and the flat map is a button away for anyone who wants to read the
   * map rather than look at it (D75).
   */
  basemap: str(import.meta.env.VITE_BASEMAP, 'imagery') === 'flat' ? 'flat' : 'imagery',

  /**
   * Opacity of the night side at its darkest.
   *
   * 0.85 is not a taste: it leaves 15% of the imagery showing through, which
   * is exactly what the globe's shader leaves (`lit * 0.15`), so the two views
   * darken night by the same amount. Tunable because the last lighting
   * constant tuned here needed a second attempt against what it sits on (D49),
   * and `__orbitalPlanet.terminator` changes it live.
   */
  terminatorStrength: num(import.meta.env.VITE_TERMINATOR_STRENGTH, 0.85),

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
   * Esri World Imagery: sub-metre aerial in cities, to zoom 19 — the level
   * where individual buildings, road markings and vehicles are visible, and
   * about thirty times finer than Sentinel-2's 10 m, which itself stops
   * having tiles of its own at zoom 15 (D58).
   *
   * **No API key, and not unlimited either.** Esri serves this endpoint
   * without authentication and it is what most open-source mapping uses, but
   * the terms expect attribution and an account for production traffic, and
   * Esri may rate-limit. That is a weaker guarantee than NASA's open data, so
   * it applies only close in: the far tier carries every ordinary view.
   *
   * Sentinel-2 cloudless from EOX is the alternative and is a cleaner licence
   * (CC BY, explicitly free) at a third of the reach:
   * `VITE_IMAGERY_CLOSE_TILE_URL=https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`
   */
  imageryCloseTileUrl: str(
    import.meta.env.VITE_IMAGERY_CLOSE_TILE_URL,
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery' +
      '/MapServer/tile/{z}/{y}/{x}',
  ),

  /** How far the close imagery has tiles of its own. */
  imageryCloseMaxZoom: num(import.meta.env.VITE_IMAGERY_CLOSE_MAX_ZOOM, 19),

  /** Freeze the sun at a fixed time, for screenshots and deterministic demos. */
  fixedSunTime: str(import.meta.env.VITE_FIXED_SUN_TIME, ''),
} as const;

export type Config = typeof config;
