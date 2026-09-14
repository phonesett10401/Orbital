/**
 * Plate carrée in, Web Mercator out.
 *
 * MapLibre's raster sources speak exactly one tiling scheme: Web Mercator,
 * where `z0` is a single tile. NASA's Solar System Treks publish their global
 * mosaics in plate carrée, where `z0` is **two tiles wide and one tall**, and
 * that one mismatch is the whole reason `bodies.ts` could only ever offer three
 * worlds - the three OpenPlanetaryMap happens to serve in Mercator. Venus was
 * written off in the same breath, with a complete Magellan radar map of it
 * sitting on a server we could already reach (D120).
 *
 * Two measurements turned that around:
 *
 * - Trek serves global mosaics for Venus, and for Ceres, Vesta, Io, Europa,
 *   Ganymede, Titan, Enceladus and Phobos besides, all with
 *   `Access-Control-Allow-Origin: *`. The pixels can be fetched, redrawn and
 *   handed to MapLibre without a proxy and without anything on the backend.
 *   **Only Venus is wired up**, deliberately: Orbital shows the solar system's
 *   planets, and a picker with eighteen rows in it is a different product from
 *   the one this is (D192). The rest are one `Mosaic` entry each if that ever
 *   changes.
 * - The two projections are **identical in longitude**. Both are linear in it.
 *   So the reprojection is not a general warp at all; it is one axis, and it
 *   can be done a destination row at a time with `drawImage`.
 *
 * What follows is a `maplibregl.addProtocol` handler. MapLibre asks for a
 * Mercator tile at `pc://<mosaic>/{z}/{x}/{y}`; this works out which plate
 * carrée tiles lie under it, stitches them, squeezes the latitude axis, and
 * returns a PNG. Everything above `renderTile` is arithmetic with no canvas in
 * it, which is what the tests exercise.
 */

/** Every tile in both schemes, on both servers. */
export const TILE = 256;

/**
 * Where Web Mercator stops.
 *
 * The projection runs to infinity at the poles, so every implementation cuts
 * it. This is the cut that makes the world square, and it is why no mosaic can
 * ever show its own poles through a Mercator tile - a real loss, worth stating
 * rather than papering over.
 */
export const MERCATOR_LIMIT_DEG = 85.05112877980659;

/** The scheme this module answers for. */
export const PROTOCOL = 'pc';

/** What every source has in common, whatever shape it arrives in. */
interface Plate {
  /**
   * Where the grid's longitude starts.
   *
   * Trek uses both conventions and does not say which in the tile path: Venus
   * and Mercury run -180..180, Titan and Enceladus run 0..360. Getting this
   * wrong does not fail, it silently serves the far side of the world - which
   * is why it is a field rather than an assumption.
   */
  lonOrigin: 0 | -180;
  /** The latitudes it covers. Magellan stops short of both poles. */
  south: number;
  north: number;
}

/** A pyramid of plate carrée tiles, which is what Trek publishes. */
export interface TrekMosaic extends Plate {
  from: 'trek';
  /** Trek's path segment for the world, capitalised as Trek capitalises it. */
  world: string;
  /** Trek's product label, which is also the layer id inside the tile path. */
  layer: string;
  /** What Trek serves this one as. Mixed across the catalogue; both are real. */
  format: 'jpg' | 'png';
  /** The deepest level the mosaic actually has. Probed, never assumed. */
  maxLevel: number;
}

/**
 * One equirectangular image, which is what exists for a world with no surface.
 *
 * Nobody publishes a controlled mosaic of a gas giant, and the reason is not
 * neglect: a mosaic ties features to fixed ground, and on Jupiter the features
 * move - its equator rotates about five minutes faster than its mid-latitudes,
 * which is why there are two rotation systems for it. So what is available is
 * a plate of the cloud tops at a moment, and the moment is part of the claim
 * (D193).
 */
export interface ImagePlate extends Plate {
  from: 'image';
  /** Served from our own origin, because no host of these allows CORS. */
  url: string;
  /** The plate's own pixel size. Measured from the file, not from its name. */
  width: number;
  height: number;
}

export type Mosaic = TrekMosaic | ImagePlate;

/**
 * The mosaics this build serves, keyed by the name used in a `pc://` url.
 *
 * Each `maxLevel` here was found by walking levels until the server returned
 * 404, not by dividing the stated resolution - the two disagree often enough
 * that the arithmetic is a hypothesis and the 404 is the answer.
 */
export const MOSAICS: Record<string, Mosaic> = {
  venus: {
    from: 'trek',
    world: 'Venus',
    // **Not the 75 m left-look plate**, which is sixty times sharper and the
    // wrong answer. Magellan mapped in strips from a polar orbit, so that one
    // carries its own orbit seams as black bands across every view and stops
    // at 84 north and 80 south, leaving two holes: a striped, capless, grey
    // Venus that reads as a broken render rather than as a planet.
    //
    // This is the synthesised global mosaic, colourised, complete to both
    // poles and gap-free. It costs six levels of depth and buys a world that
    // looks like the one people have seen.
    layer: 'Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m',
    format: 'png',
    maxLevel: 4,
    lonOrigin: -180,
    south: -90,
    north: 90,
  },

  /*
   * The four with no ground, wrapped in the cloud tops they do have.
   *
   * Served from our own origin because every host of these refuses CORS -
   * solarsystemscope.com, NASA's photojournal and nasa3d all answer 200 with
   * no header at all, and a canvas cannot read what the browser will not hand
   * over. `scripts/fetch-cloud-textures.mjs` puts them in `public/textures`.
   *
   * Full coverage in latitude, which is true of the plate and is not quite the
   * same claim as it is for a mosaic: a gas giant has no poles to photograph
   * in the sense a rocky world does, only cloud that keeps going.
   */
  jupiter: {
    from: 'image',
    url: '/textures/jupiter-clouds.jpg',
    width: 4096,
    height: 2048,
    lonOrigin: -180,
    south: -90,
    north: 90,
  },
  saturn: {
    from: 'image',
    url: '/textures/saturn-clouds.jpg',
    width: 2048,
    height: 1024,
    lonOrigin: -180,
    south: -90,
    north: 90,
  },
  uranus: {
    from: 'image',
    url: '/textures/uranus-clouds.jpg',
    width: 2048,
    height: 1024,
    lonOrigin: -180,
    south: -90,
    north: 90,
  },
  neptune: {
    from: 'image',
    url: '/textures/neptune-clouds.jpg',
    width: 2048,
    height: 1024,
    lonOrigin: -180,
    south: -90,
    north: 90,
  },
};

/** The latitude a fraction of the way down a Web Mercator tile. */
export function tileLat(z: number, y: number, rowFraction: number): number {
  const n = Math.PI * (1 - (2 * (y + rowFraction)) / Math.pow(2, z));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** The longitudes a Web Mercator tile column spans. */
export function tileLonSpan(z: number, x: number): { west: number; east: number } {
  const span = 360 / Math.pow(2, z);
  const west = -180 + x * span;
  return { west, east: west + span };
}

/**
 * The plate carrée level whose pixels are the size of the Mercator level's.
 *
 * Level L holds `2^(L+1)` tiles across 360 degrees and Mercator level z holds
 * `2^z` across the same, so `L = z - 1` matches the horizontal scale exactly.
 * Anything else either throws away pixels the mosaic has or invents pixels it
 * does not - and the second is the one that looks fine until you compare it
 * with the source.
 */
export function sourceLevel(z: number, mosaic: Mosaic): number {
  if (mosaic.from === 'image') return 0;
  return Math.max(0, Math.min(mosaic.maxLevel, z - 1));
}

/**
 * The size of the source grid, in pixels.
 *
 * A Trek level doubles each time; a single plate has one size and `level` is
 * meaningless for it. Taking the mosaic rather than just the level is what
 * lets every function below serve both without asking which it has.
 */
export function gridSize(mosaic: Mosaic, level: number): { width: number; height: number } {
  if (mosaic.from === 'image') return { width: mosaic.width, height: mosaic.height };
  const rows = Math.pow(2, level);
  return { width: rows * 2 * TILE, height: rows * TILE };
}

/** Where a longitude falls in the grid, in pixels from its left edge. */
export function lonToX(lon: number, mosaic: Mosaic, level: number): number {
  const { width } = gridSize(mosaic, level);
  const turned = lon - mosaic.lonOrigin;
  const wrapped = turned - Math.floor(turned / 360) * 360;
  return (wrapped / 360) * width;
}

/** Where a latitude falls in the grid, in pixels from its top edge. */
export function latToY(lat: number, mosaic: Mosaic, level: number): number {
  const { height } = gridSize(mosaic, level);
  return ((90 - lat) / 180) * height;
}

/** The address of one plate carrée tile. Trek orders the path row before col. */
export function sourceTileUrl(
  mosaic: TrekMosaic,
  level: number,
  row: number,
  col: number,
): string {
  return (
    `https://trek.nasa.gov/tiles/${mosaic.world}/EQ/${mosaic.layer}` +
    `/1.0.0//default/default028mm/${level}/${row}/${col}.${mosaic.format}`
  );
}

export interface TileRequest {
  key: string;
  z: number;
  x: number;
  y: number;
}

const URL_SHAPE = /^pc:\/\/([a-z0-9_-]+)\/(\d+)\/(\d+)\/(\d+)(?:\.\w+)?$/i;

/** Read a `pc://<mosaic>/{z}/{x}/{y}` url, or null if it is not one. */
export function parseTileUrl(url: string): TileRequest | null {
  const m = URL_SHAPE.exec(url);
  if (!m) return null;
  return { key: m[1].toLowerCase(), z: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

/** Whether any of this mosaic lies under a Mercator tile at all. */
export function coversTile(mosaic: Mosaic, z: number, y: number): boolean {
  return tileLat(z, y, 1) < mosaic.north && tileLat(z, y, 0) > mosaic.south;
}

/**
 * The plate carrée tiles a Mercator tile needs, and where to put each one.
 *
 * Columns wrap: a Mercator tile at the seam wants the grid's last column and
 * its first, and at `z0` it wants the whole grid. Rows never wrap, because
 * latitude does not.
 */
export interface Patch {
  /** Where the pixels come from. */
  url: string;
  /** Where this piece sits in the stitched strip, and how big it is there. */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Trek's grid address, kept so the stitch can be checked without fetching. */
  row?: number;
  col?: number;
}

export interface Stitch {
  level: number;
  /** The strip's size in source pixels. */
  width: number;
  height: number;
  /** The strip's top edge, as a latitude, for the warp to measure against. */
  topY: number;
  patches: Patch[];
}

export function planStitch(mosaic: Mosaic, z: number, x: number, y: number): Stitch | null {
  if (!coversTile(mosaic, z, y)) return null;

  const level = sourceLevel(z, mosaic);
  const grid = gridSize(mosaic, level);
  const { west, east } = tileLonSpan(z, x);

  const x0 = lonToX(west, mosaic, level);
  let x1 = lonToX(east, mosaic, level);
  // A tile that straddles the grid's seam comes back with its right edge to
  // the left of its left edge. Carry it round rather than clamping, or the
  // whole world folds into the one tile that crosses the join.
  if (x1 <= x0) x1 += grid.width;

  const topY = latToY(Math.min(tileLat(z, y, 0), mosaic.north), mosaic, level);
  const botY = latToY(Math.max(tileLat(z, y, 1), mosaic.south), mosaic, level);

  const width = Math.max(1, Math.ceil(x1 - x0));
  const height = Math.max(1, Math.ceil(botY - topY));
  const patches: Patch[] = [];

  if (mosaic.from === 'image') {
    // One plate, laid whole into the strip at a negative offset so the strip
    // is the window onto it. Laid twice when the window crosses the seam -
    // the second copy a full turn to the right - which is the same carry the
    // tile branch does, expressed once instead of per column.
    for (let turn = 0; turn * grid.width < x1; turn++) {
      const dx = turn * grid.width - x0;
      if (dx > width) break;
      patches.push({ url: mosaic.url, dx, dy: -topY, dw: grid.width, dh: grid.height });
    }
    return { level, width, height, topY, patches };
  }

  const colFrom = Math.floor(x0 / TILE);
  const colTo = Math.floor((x1 - 1e-9) / TILE);
  const rowFrom = Math.floor(topY / TILE);
  const rowTo = Math.floor((botY - 1e-9) / TILE);
  const cols = grid.width / TILE;
  const rows = grid.height / TILE;

  for (let r = rowFrom; r <= rowTo; r++) {
    if (r < 0 || r >= rows) continue;
    for (let c = colFrom; c <= colTo; c++) {
      const col = ((c % cols) + cols) % cols;
      patches.push({
        url: sourceTileUrl(mosaic, level, r, col),
        row: r,
        col,
        dx: c * TILE - x0,
        dy: r * TILE - topY,
        dw: TILE,
        dh: TILE,
      });
    }
  }
  return { level, width, height, topY, patches };
}

/**
 * Where one destination row reads from in the stitched strip.
 *
 * Returned in strip coordinates, so the caller needs no latitudes. `null`
 * means the row is off the top or bottom of what the mosaic covers, and the
 * caller should leave it transparent rather than stretching the nearest pixel
 * across it.
 */
export function rowSource(
  mosaic: Mosaic,
  z: number,
  y: number,
  row: number,
  stitch: Stitch,
): { top: number; height: number } | null {
  const latTop = tileLat(z, y, row / TILE);
  const latBottom = tileLat(z, y, (row + 1) / TILE);
  if (latBottom >= mosaic.north || latTop <= mosaic.south) return null;

  const a = latToY(Math.min(latTop, mosaic.north), mosaic, stitch.level) - stitch.topY;
  const b = latToY(Math.max(latBottom, mosaic.south), mosaic, stitch.level) - stitch.topY;
  return { top: a, height: Math.max(b - a, 0.01) };
}

/* -------------------------------------------------------------- the canvas */

type Bitmap = ImageBitmap | HTMLImageElement;

/**
 * Source tiles already fetched.
 *
 * A cap rather than a full LRU: the working set while panning is a handful of
 * tiles and the cost of being wrong is one refetch, so the bookkeeping of a
 * real eviction policy would cost more than it saves.
 */
const CACHE_LIMIT = 160;
const cache = new Map<string, Bitmap>();
const inFlight = new Map<string, Promise<Bitmap | null>>();

function remember(url: string, bitmap: Bitmap): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, bitmap);
}

async function fetchTile(url: string, signal?: AbortSignal): Promise<Bitmap | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = inFlight.get(url);
  if (pending) return pending;

  const job = (async () => {
    try {
      const response = await fetch(url, { signal });
      // A 404 is ordinary here. Trek's grids are ragged at the edges and a
      // missing tile is a hole in the mosaic, not a failure of the request.
      if (!response.ok) return null;
      const bitmap = await createImageBitmap(await response.blob());
      remember(url, bitmap);
      return bitmap;
    } catch {
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();
  inFlight.set(url, job);
  return job;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function toBytes(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not encode the reprojected tile');
  return blob.arrayBuffer();
}

/**
 * Fetch, stitch and squeeze one tile.
 *
 * The squeeze is `TILE` calls to `drawImage`, one per destination row, each
 * reading the slice of the strip that row's own latitudes land on. A coarser
 * banding would be cheaper and is invisible at the equator, where Mercator is
 * nearly linear; it is *not* invisible at 70 degrees, which is exactly where
 * the interesting parts of these mosaics are.
 */
export async function renderTile(
  mosaic: Mosaic,
  z: number,
  x: number,
  y: number,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const out = canvasOf(TILE, TILE);
  const plan = planStitch(mosaic, z, x, y);
  if (!plan || plan.patches.length === 0) return toBytes(out);

  const strip = canvasOf(plan.width, plan.height);
  const sctx = strip.getContext('2d');
  const octx = out.getContext('2d');
  if (!sctx || !octx) return toBytes(out);

  const bitmaps = await Promise.all(plan.patches.map((p) => fetchTile(p.url, signal)));
  bitmaps.forEach((bitmap, i) => {
    if (!bitmap) return;
    const p = plan.patches[i];
    sctx.drawImage(bitmap, p.dx, p.dy, p.dw, p.dh);
  });

  for (let row = 0; row < TILE; row++) {
    const slice = rowSource(mosaic, z, y, row, plan);
    if (!slice) continue;
    octx.drawImage(strip, 0, slice.top, plan.width, slice.height, 0, row, TILE, 1);
  }
  return toBytes(out);
}

/* ------------------------------------------------------------ the protocol */

let registered = false;

export interface ProtocolHost {
  addProtocol: (
    scheme: string,
    load: (
      params: { url: string },
      controller: AbortController,
    ) => Promise<{ data: ArrayBuffer }>,
  ) => void;
}

/**
 * Teach a MapLibre instance to answer `pc://` urls.
 *
 * Idempotent, because the view that calls it is dynamically imported and a
 * remount would otherwise register a second handler for the same scheme.
 */
export function registerPlateCarree(host: ProtocolHost): void {
  if (registered) return;
  registered = true;
  host.addProtocol(PROTOCOL, async (params, controller) => {
    const request = parseTileUrl(params.url);
    if (!request) throw new Error(`not a ${PROTOCOL} tile url: ${params.url}`);
    const mosaic = MOSAICS[request.key];
    if (!mosaic) throw new Error(`no mosaic registered as "${request.key}"`);
    return {
      data: await renderTile(mosaic, request.z, request.x, request.y, controller.signal),
    };
  });
}

/** Testing seam: forget that the protocol was ever registered. */
export function resetPlateCarreeForTest(): void {
  registered = false;
  cache.clear();
  inFlight.clear();
}
