/**
 * The worlds Orbital can show, and the honest difference between them.
 *
 * Four can be *landed on*: they have a global surface mosaic in Web Mercator,
 * which is the only projection a MapLibre raster source can consume. The rest
 * appear in the picker and cannot be entered, each for a stated reason - a
 * control that offers a capability the renderer lacks is a wrong answer rather
 * than a missing feature, which this project has already paid for once (D93).
 *
 * ## Why these four and not more
 *
 * Probed rather than assumed, and the probing changed the answer twice.
 *
 * **NASA Trek serves Mercury, the Moon and Mars** and looked like the source
 * until the tile grid gave it away: `z0` is *two* tiles wide and one tall,
 * which is equirectangular. Web Mercator's `z0` is a single tile. MapLibre
 * raster sources have no plate carree support, so Trek is unusable here
 * whatever its coverage.
 *
 * **OpenPlanetaryMap serves the same three in Web Mercator**, `z0` a single
 * tile, and is what these URLs point at. Mercury was very nearly written off:
 * it is absent from OPM's own basemap page and only turned up by guessing
 * `opm-mercury-basemap-v0-1` after `v0-2` returned 404 (D120).
 *
 * Venus, Ceres, Vesta, Titan, Europa, Io and Pluto were all probed on the same
 * naming pattern and all 404. Venus is the interesting absence: it has a
 * complete Magellan radar map, just not one served as Mercator tiles here.
 *
 * ## The gas giants are a different kind of no
 *
 * Jupiter, Saturn, Uranus and Neptune have **no solid surface**. That is not a
 * missing dataset that might appear later; there is no ground to map, and a
 * "zoom to a place on Jupiter" would be a category error rather than a gap.
 * The picker says so rather than leaving them looking unfinished.
 */

export type BodyId =
  | 'sun'
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune';

export interface Body {
  id: BodyId;
  name: string;
  /** Mean radius in kilometres. Real values; nothing here is to scale yet. */
  radiusKm: number;
  /** Sun, planet or moon - the picker groups by this. */
  kind: 'star' | 'planet' | 'moon';
  /** Tiles, when there is a surface we can put under a camera. */
  surface?: {
    tiles: string;
    maxZoom: number;
    attribution: string;
  };
  /** Why not, when there is not. Shown to the reader, so it must be true. */
  noSurfaceReason?: string;
}

const OPM = 'https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named';

/**
 * OpenPlanetaryMap asks for credit and the data underneath it has its own.
 *
 * Each mosaic is somebody's mission: MESSENGER at Mercury, LRO at the Moon,
 * Viking at Mars. Crediting the tile server and not the spacecraft would name
 * the courier rather than the source.
 */
const OPM_CREDIT = (mission: string) =>
  `Basemap <a href="https://www.openplanetary.org/opm">OpenPlanetaryMap</a> · imagery ${mission}`;

export const BODIES: Body[] = [
  {
    id: 'sun',
    name: 'Sun',
    radiusKm: 696_000,
    kind: 'star',
    noSurfaceReason: 'A star has no surface to stand on',
  },
  {
    id: 'mercury',
    name: 'Mercury',
    radiusKm: 2_439.7,
    kind: 'planet',
    surface: {
      tiles: `${OPM}/opm-mercury-basemap-v0-1/all/{z}/{x}/{y}.png`,
      maxZoom: 5,
      attribution: OPM_CREDIT('NASA MESSENGER MDIS'),
    },
  },
  {
    id: 'venus',
    name: 'Venus',
    radiusKm: 6_051.8,
    kind: 'planet',
    noSurfaceReason: 'Mapped by radar through the cloud, but not as tiles we can use',
  },
  {
    id: 'earth',
    name: 'Earth',
    radiusKm: 6_371.0,
    kind: 'planet',
    surface: {
      // Earth keeps the imagery it already had: two tiers, its own vector
      // cartography over the top, and every layer this app was built for.
      tiles: '',
      maxZoom: 19,
      attribution: '',
    },
  },
  {
    id: 'moon',
    name: 'Moon',
    radiusKm: 1_737.4,
    kind: 'moon',
    surface: {
      tiles: `${OPM}/opm-moon-basemap-v0-1/all/{z}/{x}/{y}.png`,
      maxZoom: 7,
      attribution: OPM_CREDIT('NASA LRO'),
    },
  },
  {
    id: 'mars',
    name: 'Mars',
    radiusKm: 3_389.5,
    kind: 'planet',
    surface: {
      tiles: `${OPM}/opm-mars-basemap-v0-2/all/{z}/{x}/{y}.png`,
      maxZoom: 8,
      attribution: OPM_CREDIT('NASA Viking MDIM21'),
    },
  },
  {
    id: 'jupiter',
    name: 'Jupiter',
    radiusKm: 69_911,
    kind: 'planet',
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
  {
    id: 'saturn',
    name: 'Saturn',
    radiusKm: 58_232,
    kind: 'planet',
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
  {
    id: 'uranus',
    name: 'Uranus',
    radiusKm: 25_362,
    kind: 'planet',
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
  {
    id: 'neptune',
    name: 'Neptune',
    radiusKm: 24_622,
    kind: 'planet',
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
];

export const EARTH: Body = BODIES.find((b) => b.id === 'earth')!;

export function bodyFor(id: BodyId): Body {
  return BODIES.find((b) => b.id === id) ?? EARTH;
}

/** Whether a camera can be put on this world. */
export function isLandable(body: Body): boolean {
  return body.surface !== undefined;
}

/**
 * Whether the Earth-only layers should be drawn.
 *
 * Aircraft, satellites, airports, the receiver-coverage shapes and the
 * terminator are all statements about Earth. Over Mars they are not stale or
 * empty, they are **meaningless** - and a layer drawn where its subject does
 * not exist is a stronger false claim than one drawn late (D120).
 */
export function showsEarthLayers(bodyId: BodyId): boolean {
  return bodyId === 'earth';
}
