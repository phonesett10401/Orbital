/**
 * Copy the Earth textures out of node_modules into public/textures/.
 *
 * three-globe ships NASA Blue Marble imagery in its example assets, but its
 * package `exports` map does not expose that directory, so it cannot be
 * imported directly by the bundler. Copying is the simple, robust answer.
 *
 * Doing this at build time rather than committing the files keeps ~4 MB of
 * binaries out of git while leaving the app self-contained offline: the assets
 * arrive with `npm install` and never need a CDN.
 *
 * To use higher-resolution imagery, drop your own files into public/textures/
 * and point the matching VITE_* variable at them; this script only writes the
 * default names, and skips any file that is already present and current.
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'node_modules', 'three-globe', 'example', 'img');
const target = join(here, '..', 'public', 'textures');

const TEXTURES = [
  // City lights, and nothing else. The other four -- day colour, height map,
  // water mask and star field -- existed to light a three.js sphere, and that
  // renderer is gone (D104). The imagery now comes from tiles; what tiles
  // cannot supply is which places are lit at night.
  //
  // `three-globe` is kept as a devDependency purely as the source of this one
  // file. That looks odd now that nothing renders with it, and the alternative
  // is worse: committing a 700 KB binary, which this project deliberately does
  // not do for generated assets (D30).
  'earth-night.jpg',
];

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

await mkdir(target, { recursive: true });

let copied = 0;
for (const name of TEXTURES) {
  const from = join(source, name);
  const to = join(target, name);

  const fromSize = await sizeOf(from);
  if (fromSize < 0) {
    console.error(
      `[textures] missing ${name} in three-globe. Run npm install, or supply your own via VITE_EARTH_*_TEXTURE.`,
    );
    process.exitCode = 1;
    continue;
  }

  // Skip identical files so this is cheap to run before every dev start, and
  // so a hand-placed higher-resolution replacement is not clobbered.
  if ((await sizeOf(to)) === fromSize) continue;

  await copyFile(from, to);
  copied += 1;
}

if (copied > 0) console.log(`[textures] copied ${copied} file(s) to public/textures`);
