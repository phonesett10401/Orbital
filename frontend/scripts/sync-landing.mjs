/**
 * Copy the landing page out of the scroll-craft workspace into public/landing/.
 *
 * The page is built in `<repo>/scrollcraft/builds/orbital/`, which is ignored
 * in full (`.gitignore`) and is not part of Orbital: it is a third-party
 * generator's build workspace holding 453 MB of verification screenshots, a
 * brief, four shoot harnesses and an API key. None of that belongs in a
 * repository submitted as our own work.
 *
 * What ships is nine files totalling under a megabyte, copied here and
 * committed. Vite copies `public/` into `dist/` verbatim, so they arrive at
 * `/landing` on the same deployment as the app, with no second Vercel project,
 * no second domain and no routing rule - the app routes by hash (D153), so it
 * occupies `/` alone and a sibling directory cannot collide with it.
 *
 * ## Why an allowlist rather than a directory copy
 *
 * `scrollcraft/builds/orbital/.env` holds a generation API key, and `lab/` is
 * 453 MB. A recursive copy with exclusions fails open: anything added to the
 * workspace later travels by default, and the one that would hurt is a
 * credential. Naming the nine files fails closed instead - a new asset has to
 * be added here deliberately, and nothing else can ever come with it.
 *
 * ## Why this is not wired into prebuild
 *
 * It would be a no-op on Vercel, where the workspace does not exist, so it is
 * tempting. But run locally it would silently overwrite `public/landing/` from
 * the workspace on every build - so an edit made to the committed copy would
 * vanish at the next `npm run dev` with no message. Manual and loud is the
 * safer shape: the workspace is the source, this is the publisher, and
 * publishing is a thing you decide to do.
 *
 *   npm run landing
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'scrollcraft', 'builds', 'orbital');
const target = join(here, '..', 'public', 'landing');

/**
 * Every file the page needs, and nothing else.
 *
 * `scrollcraft.css` and `scrollcraft.js` are the engine, vendored per-build by
 * the generator and MIT-licensed; `motion.js` is this page's own choreography.
 * The eight WebP plates are the only binaries, 636 KB together.
 */
const FILES = [
  'index.html',
  'motion.js',
  'scrollcraft.css',
  'scrollcraft.js',
  'assets/globe-close.webp',
  'assets/globe.webp',
  'assets/light.webp',
  'assets/mars.webp',
  'assets/satellites.webp',
  'assets/sky.webp',
  'assets/solar.webp',
  'assets/track.webp',
];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

if ((await sizeOf(join(source, 'index.html'))) < 0) {
  // Not an error. A fresh clone has no workspace and does not need one: the
  // page is committed, and this script only exists to republish it.
  console.log(`[landing] no scroll-craft workspace at ${source} - nothing to sync`);
  process.exit(0);
}

let copied = 0;
let bytes = 0;
for (const name of FILES) {
  const from = join(source, name);
  const size = await sizeOf(from);
  if (size < 0) {
    // Loud and fatal, unlike the cloud textures. A missing texture costs one
    // world; a landing page missing one of its plates is a broken page, and it
    // would be broken on the deployment rather than here.
    console.error(`[landing] missing ${name} in the workspace`);
    process.exitCode = 1;
    continue;
  }
  await mkdir(dirname(join(target, name)), { recursive: true });
  await copyFile(from, join(target, name));
  copied += 1;
  bytes += size;
}
console.log(`[landing] ${copied} files, ${(bytes / 1024).toFixed(0)} KB -> public/landing/`);
