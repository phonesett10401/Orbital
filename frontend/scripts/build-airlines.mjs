/**
 * Reduce the OpenFlights airline list to an ICAO designator lookup.
 *
 * Same bargain as the textures (D30) and the geography data (D44): the source
 * arrives with `npm install`, is reduced here at build time, and is never
 * fetched from a third party at runtime. Output is `public/data/airlines.json`,
 * a plain map from three-letter ICAO designator to airline name.
 *
 * Run by `npm run airlines`, and before dev and build as part of
 * `npm run assets`.
 */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'data');

/** OpenFlights writes an unset field as this. */
const NULL_FIELD = '\\N';

/**
 * Every designator is kept, not only the ones flagged active.
 *
 * The obvious reduction is to drop `active: N` rows: 5,774 designators become
 * 996, and the file shrinks from 148 KB to 23 KB. It is also wrong. The flag
 * is community-maintained and stale in both directions — FedEx and UPS are
 * both marked inactive, and between them they are a large fraction of the
 * cargo traffic in any real feed. Dropping them to save 125 KB of a file
 * fetched once, on demand, and cached by the browser is a bad trade.
 *
 * The flag is still used, as a tie-break: where one designator has several
 * rows, the active one wins. Only three designators have more than one active
 * row, and two of those are duplicates of the same airline.
 */
function chooseRow(rows) {
  return rows.find((row) => row.active === 'Y') ?? rows[0];
}

export function buildTable(airlines) {
  const byCode = new Map();

  for (const airline of airlines) {
    const code = (airline.icao ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) continue;

    const name = (airline.name ?? '').trim();
    if (!name || name === NULL_FIELD) continue;

    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ ...airline, name });
  }

  const table = {};
  for (const [code, rows] of [...byCode].sort(([a], [b]) => (a < b ? -1 : 1))) {
    table[code] = chooseRow(rows).name;
  }
  return table;
}

async function main() {
  const source = require('airline-codes/airlines.json');
  const table = buildTable(Array.isArray(source) ? source : (source.airlines ?? []));

  await mkdir(target, { recursive: true });
  const path = join(target, 'airlines.json');
  await writeFile(path, JSON.stringify(table));

  const size = (await stat(path)).size / 1024;
  console.log(
    `[airlines] ${Object.keys(table).length} ICAO designators (${size.toFixed(0)} KB)`,
  );
}

await main();
