/**
 * Fetch the gas giants' cloud-top textures into public/textures/.
 *
 * The four outer planets have no surface, so nobody publishes a *controlled*
 * mosaic of them: a mosaic ties features to fixed ground, and on a gas giant
 * the features move. What exists instead is an equirectangular image of the
 * cloud tops at a moment, which is enough to wrap on a globe and turn - which
 * is the whole of what "visiting" means here (D193).
 *
 * ## Why these are downloaded rather than read at runtime
 *
 * The reprojection in `planet/plateCarree.ts` happens in a canvas, so it can
 * only read pixels the browser will hand over. Trek allows that
 * (`Access-Control-Allow-Origin: *`) and is why Venus needs nothing local.
 * **Every source for these four refuses it**: solarsystemscope.com, NASA's own
 * photojournal and nasa3d all answer 200 with no CORS header at all, measured.
 * Wikimedia does allow it but only carries a usable map of Jupiter.
 *
 * Served from our own origin the question does not arise, and the app stops
 * depending on a third party being up while somebody is looking at Saturn.
 *
 * ## Why downloaded rather than committed
 *
 * The same reason `copy-textures.mjs` exists: this repository does not commit
 * binaries it can fetch (D30). Run once, skipped forever after - the files are
 * in `.gitignore` beside `earth-night.jpg`, and a build with no network works
 * as long as a previous one has run.
 *
 * ## Licence
 *
 * Solar System Scope's texture set is CC BY 4.0 and derived from NASA imagery.
 * Attribution is not optional under that licence, and it is carried in
 * `bodies.ts` as each body's `attribution`, which MapLibre shows in the corner
 * whenever that world is the one on screen.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'textures');

/**
 * Jupiter gets the large plate and the other three the small one, which is not
 * inconsistency for its own sake.
 *
 * Jupiter has real structure at small scales - belts, festoons, the white
 * ovals - and the extra level is worth its three megabytes. Uranus is
 * effectively featureless in visible light: Voyager 2 found almost nothing
 * there, so a larger plate of it would be more megabytes of smooth gradient.
 *
 * The file names are theirs, not a measurement: `8k_jupiter.jpg` is 4096x2048
 * and `2k_*` are 2048x1024, checked rather than trusted, because the plate's
 * real width is what sets each body's `maxZoom`.
 */
const TEXTURES = [
  ['jupiter-clouds.jpg', 'https://www.solarsystemscope.com/textures/download/8k_jupiter.jpg'],
  ['saturn-clouds.jpg', 'https://www.solarsystemscope.com/textures/download/2k_saturn.jpg'],
  ['uranus-clouds.jpg', 'https://www.solarsystemscope.com/textures/download/2k_uranus.jpg'],
  ['neptune-clouds.jpg', 'https://www.solarsystemscope.com/textures/download/2k_neptune.jpg'],
];

async function have(path) {
  try {
    return (await stat(path)).size > 10_000;
  } catch {
    return false;
  }
}

await mkdir(target, { recursive: true });

let fetched = 0;
let kept = 0;
for (const [name, url] of TEXTURES) {
  const path = join(target, name);
  if (await have(path)) {
    kept += 1;
    continue;
  }
  const response = await fetch(url);
  if (!response.ok) {
    // Loud, and not fatal. A missing texture costs one world; a build that
    // refuses to run because a texture host is down costs all of them.
    console.warn(`[textures] ${name}: ${response.status} from ${url} - skipped`);
    continue;
  }
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
  fetched += 1;
}
console.log(`[textures] cloud tops: ${fetched} fetched, ${kept} already present`);
