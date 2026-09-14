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
 * naming pattern and all 404.
 *
 * ## Venus, and the projection that was never the real limit
 *
 * That last paragraph stood for months and it was the wrong conclusion from
 * the right measurement. OPM does not serve Venus; **Trek does**, at 75 m per
 * pixel, and its tiles carry `Access-Control-Allow-Origin: *`. The obstacle
 * was never the data, it was that plate carrée cannot be handed to a MapLibre
 * raster source - and that is a transformation, not a wall.
 *
 * `planet/plateCarree.ts` does the transformation in the browser: MapLibre
 * asks for a Mercator tile, the handler fetches the plate carrée tiles under
 * it and squeezes the latitude axis. Venus is the world that mattered, because
 * it is the last **planet** with ground to stand on.
 *
 * Trek also has Ceres, Vesta, Io, Europa, Ganymede, Titan, Enceladus and
 * Phobos behind the same handler, and they were wired up and then taken back
 * out. This list is the solar system's planets, the Sun and the Moon, and
 * eighteen rows of moons and minor bodies is a different product from the one
 * this is (D192). They are one `Mosaic` entry and one entry here each, if that
 * is ever the product wanted.
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
  /** Tiles, when there is imagery we can put under a camera. */
  surface?: {
    tiles: string;
    maxZoom: number;
    attribution: string;
    /**
     * What the reader is actually looking at.
     *
     * `ground` is a controlled mosaic of somewhere you could stand. `cloud` is
     * the top of an atmosphere with nothing underneath it, which is every word
     * of that different: it has no fixed coordinates, it was true on one date,
     * and it is weather rather than terrain. Labelling the two the same way
     * would be the D120 mistake with better pictures.
     */
    shows?: 'ground' | 'cloud';
    /**
     * When the imagery was taken, for anything that moves.
     *
     * Required in spirit for `cloud` and meaningless for `ground`: Viking's
     * Mars is the same Mars, and Cassini's Jupiter is not the same Jupiter -
     * the Great Red Spot has lost about a third of its width since.
     */
    epoch?: string;
    /**
     * The thing about this imagery a reader would otherwise get wrong.
     *
     * Shown to them, so it must be true. Was `gap`, for what a mosaic failed
     * to cover; the useful cases turned out to be wider than that - the most
     * important thing about Venus's map is not a hole in it but that it is
     * radar, because nothing has ever photographed that surface.
     */
    caveat?: string;
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

/**
 * The same courtesy for the worlds that come through the reprojection.
 *
 * Trek is the tile server; the mosaic behind it is somebody's mission, and
 * crediting only the server would name the courier again.
 */
const TREK_CREDIT = (mission: string) =>
  `Basemap <a href="https://trek.nasa.gov/">NASA Solar System Treks</a> · imagery ${mission}`;

/**
 * The gas giants' plates, which are somebody's work under a licence.
 *
 * CC BY 4.0 requires the credit, so it is not a courtesy here the way the
 * others are - it is the condition of use, and MapLibre shows it in the corner
 * whenever that world is the one on screen.
 */
const CLOUD_CREDIT = (mission: string) =>
  `Texture <a href="https://www.solarsystemscope.com/textures/">Solar System Scope</a>` +
  ` (CC BY 4.0) · ${mission}`;

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
    surface: {
      // Reprojected in the browser from Trek's plate carrée grid. See
      // `planet/plateCarree.ts`; `venus` is the key in its `MOSAICS`.
      tiles: 'pc://venus/{z}/{x}/{y}',
      // The mosaic's own deepest level is 4, and one Mercator level sits
      // above each plate carrée level, so 5. Probed by walking levels until
      // the server 404ed, not divided out of the stated resolution.
      maxZoom: 5,
      attribution: TREK_CREDIT('NASA Magellan, C3-MDIR global mosaic'),
      // The one thing a reader would otherwise get wrong. Venus's surface has
      // never been photographed: the cloud is opaque in visible light, and
      // every image of the ground is radar looking through it.
      caveat: 'Radar, not a photograph — nothing has ever seen this surface through the cloud',
    },
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
    surface: {
      tiles: 'pc://jupiter/{z}/{x}/{y}',
      // One plate, 4096 pixels across, so this is where the detail runs out. A
      // level over it rather than exactly on it: overzooming a cloud top by
      // one is honest blur, and these have no fine structure to lose.
      maxZoom: 5,
      attribution: CLOUD_CREDIT('cloud tops after NASA Cassini and Voyager imagery'),
      shows: 'cloud',
      epoch: 'cloud tops, not a surface',
    },
    // **Not a surface, and the picker says so.** There is nothing under this
    // to stand on; what is drawn is the top of an atmosphere. Kept as its own
    // sentence rather than folded into the label because the label has two
    // words to work with and this is the part that matters.
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
  {
    id: 'saturn',
    name: 'Saturn',
    radiusKm: 58_232,
    kind: 'planet',
    surface: {
      tiles: 'pc://saturn/{z}/{x}/{y}',
      // One plate, 2048 pixels across, so this is where the detail runs out. A
      // level over it rather than exactly on it: overzooming a cloud top by
      // one is honest blur, and these have no fine structure to lose.
      maxZoom: 4,
      attribution: CLOUD_CREDIT('cloud tops after NASA Cassini imagery'),
      shows: 'cloud',
      epoch: 'cloud tops, not a surface',
    },
    // **Not a surface, and the picker says so.** There is nothing under this
    // to stand on; what is drawn is the top of an atmosphere. Kept as its own
    // sentence rather than folded into the label because the label has two
    // words to work with and this is the part that matters.
    noSurfaceReason: 'No solid surface — cloud all the way down',
  },
  {
    id: 'uranus',
    name: 'Uranus',
    radiusKm: 25_362,
    kind: 'planet',
    surface: {
      tiles: 'pc://uranus/{z}/{x}/{y}',
      // One plate, 2048 pixels across, so this is where the detail runs out. A
      // level over it rather than exactly on it: overzooming a cloud top by
      // one is honest blur, and these have no fine structure to lose.
      maxZoom: 4,
      attribution: CLOUD_CREDIT('cloud tops after NASA Voyager 2 imagery'),
      shows: 'cloud',
      epoch: 'cloud tops, not a surface',
    },
    // **Not a surface, and the picker says so.** There is nothing under this
    // to stand on; what is drawn is the top of an atmosphere. Kept as its own
    // sentence rather than folded into the label because the label has two
    // words to work with and this is the part that matters.
    noSurfaceReason: 'No solid surface — fluid all the way down, and almost featureless to the eye',
  },
  {
    id: 'neptune',
    name: 'Neptune',
    radiusKm: 24_622,
    kind: 'planet',
    surface: {
      tiles: 'pc://neptune/{z}/{x}/{y}',
      // One plate, 2048 pixels across, so this is where the detail runs out. A
      // level over it rather than exactly on it: overzooming a cloud top by
      // one is honest blur, and these have no fine structure to lose.
      maxZoom: 4,
      attribution: CLOUD_CREDIT('cloud tops after NASA Voyager 2 imagery'),
      shows: 'cloud',
      epoch: 'cloud tops, not a surface',
    },
    // **Not a surface, and the picker says so.** There is nothing under this
    // to stand on; what is drawn is the top of an atmosphere. Kept as its own
    // sentence rather than folded into the label because the label has two
    // words to work with and this is the part that matters.
    noSurfaceReason: 'No solid surface — fluid all the way down',
  },
];

export const EARTH: Body = BODIES.find((b) => b.id === 'earth')!;

export function bodyFor(id: BodyId): Body {
  return BODIES.find((b) => b.id === id) ?? EARTH;
}

/**
 * Whether the camera can be put on this world at all.
 *
 * Named for what it decides - whether the picker lets you go - rather than for
 * standing on anything. It used to be `canEnter`, which was the same
 * question while every world with imagery had ground under it, and became a
 * false claim the moment Jupiter did not (D193).
 */
export function canEnter(body: Body): boolean {
  return body.surface !== undefined;
}

/**
 * Whether what you would see is ground rather than weather.
 *
 * Drives the wording, nowhere else. A world can be entered and still not be a
 * place, and the interface has to be able to say so.
 */
export function standsOnGround(body: Body): boolean {
  return body.surface !== undefined && body.surface.shows !== 'cloud';
}

/** What the imagery for a world is, in two words, for a label. */
export function imageryLabel(body: Body): string {
  if (!body.surface) return 'No imagery';
  return standsOnGround(body) ? 'Surface imagery' : 'Cloud tops';
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
