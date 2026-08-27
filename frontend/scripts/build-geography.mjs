/**
 * Turn the geography datasets in node_modules into two small static files.
 *
 * Same bargain as the Earth textures (D30): the data arrives with
 * `npm install`, is reduced at build time, and is never committed or fetched
 * from a CDN at runtime. Nothing here costs an OpenSky credit, and the app
 * still works with no network beyond the install.
 *
 * Inputs, all dev dependencies:
 *
 * - `world-atlas`          Natural Earth country boundaries as TopoJSON
 * - `all-the-cities`       GeoNames populated places
 * - `@nwpr/airport-codes`  OurAirports airports
 *
 * Outputs, written to public/geo/:
 *
 * - `borders.json`  shared boundary arcs as lon/lat polylines
 * - `labels.json`   country, city and airport label anchors, each ranked
 *
 * Run by `npm run geography`, and before dev and build alongside the textures.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoArea, geoCentroid, geoContains, geoDistance } from 'd3-geo';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'public', 'geo');

/**
 * Boundary resolution.
 *
 * Natural Earth ships three. 110m is 8,246 points across 595 arcs and about
 * 64 KB once decoded; 50m is ten times that and 10m fifty-eight times. At the
 * closest zoom the camera can reach the globe spans about 9.5 degrees, where
 * 110m is visibly straight-edged in places, but the coastline underneath it is
 * a texture at a fixed resolution regardless — a sharper border over a soft
 * coast reads worse, not better. Swap this to '50m' and re-run if that
 * judgement ever changes.
 */
const RESOLUTION = '110m';

/**
 * Coordinate precision, in decimal places.
 *
 * Three places is about 110 m at the equator. One pixel at the closest
 * reachable zoom covers roughly 2 km, so this is an order of magnitude finer
 * than anything that can be seen, and it halves the file.
 */
const PRECISION = 3;

/**
 * Cities below this are never labelled, at any zoom.
 *
 * A million was far too coarse for most of the world: it put exactly one label
 * on Thailand — Bangkok — and none on Chiang Mai, Udon Thani, Hat Yai or the
 * eighteen other Thai cities over a hundred thousand people (D51). A hundred
 * thousand takes the table from 363 cities to 4,442, which is a bigger file
 * and no more labels on screen: what appears is decided by the altitude tiers
 * and the caps, not by what the file happens to contain.
 */
const MIN_CITY_POPULATION = 100_000;

/** How near a city an airport must be to be considered to serve it. */
const AIRPORT_CITY_RADIUS_KM = 60;

/**
 * Cities this size or larger let an airport through.
 *
 * Also far too coarse, and for a reason worth stating: an airport's importance
 * has very little to do with the size of the town it is named after. Every one
 * of Thailand's international airports was excluded by a 500,000 floor —
 * Phuket serves a city of 89,000, Krabi one of 31,000, Samui one of 50,000 —
 * while all of them are among the busiest in the region (D51). The floor now
 * only exists to keep out airfields with no settlement near them at all.
 */
const MIN_AIRPORT_CITY_POPULATION = 25_000;

const EARTH_RADIUS_KM = 6371;

function round(value) {
  return Number(value.toFixed(PRECISION));
}

// ---- borders ---------------------------------------------------------------

/**
 * Decode a TopoJSON topology's arcs into absolute lon/lat polylines.
 *
 * Arcs are emitted rather than country rings on purpose. TopoJSON already
 * stores a boundary shared by two countries exactly once, and every ring that
 * uses it refers to it by index; expanding to rings would draw the
 * France/Germany border twice, and every coastline once per country that
 * touches it. Emitting arcs keeps the shared edge shared, which is both fewer
 * vertices and -- because the line is translucent -- the difference between a
 * uniform hairline and one that doubles in brightness along internal borders.
 */
export function decodeArcs(topology) {
  const [scaleX, scaleY] = topology.transform.scale;
  const [translateX, translateY] = topology.transform.translate;

  return topology.arcs.map((arc) => {
    const out = [];
    let x = 0;
    let y = 0;
    for (const [dx, dy] of arc) {
      // Quantized topology: each point is a delta from the one before it.
      x += dx;
      y += dy;
      out.push(round(x * scaleX + translateX), round(y * scaleY + translateY));
    }
    return out;
  });
}

// ---- label anchors ---------------------------------------------------------

/**
 * The anchor point for a country's name.
 *
 * `geoCentroid` of the whole feature is wrong often enough to matter: for a
 * country with distant territories it lands in open water -- the United
 * States' is dragged out to sea by Alaska and Hawaii, Norway's north by
 * Svalbard. So the label goes on the largest polygon, and if that polygon's
 * centroid still falls outside it -- the crescent problem, and Croatia and
 * Indonesia are both crescents -- a grid search picks the interior point
 * furthest from the boundary instead.
 *
 * This runs 177 times at build time, so the crude search is free.
 */
export function anchorFor(geometry) {
  const polygons =
    geometry.type === 'MultiPolygon'
      ? geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
      : [geometry];

  let largest = polygons[0];
  let largestArea = geoArea(largest);
  for (const polygon of polygons.slice(1)) {
    const area = geoArea(polygon);
    if (area > largestArea) {
      largest = polygon;
      largestArea = area;
    }
  }

  const centroid = geoCentroid(largest);
  if (geoContains(largest, centroid)) return centroid;
  return poleOfInaccessibility(largest);
}

/** The interior point furthest from the boundary, found by grid search. */
function poleOfInaccessibility(polygon) {
  const ring = polygon.coordinates[0];
  let minLon = 180;
  let maxLon = -180;
  let minLat = 90;
  let maxLat = -90;
  for (const [lon, lat] of ring) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  const STEPS = 48;
  let best = geoCentroid(polygon);
  let bestClearance = -1;
  for (let i = 1; i < STEPS; i += 1) {
    for (let j = 1; j < STEPS; j += 1) {
      const point = [
        minLon + ((maxLon - minLon) * i) / STEPS,
        minLat + ((maxLat - minLat) * j) / STEPS,
      ];
      if (!geoContains(polygon, point)) continue;
      let clearance = Infinity;
      for (const vertex of ring) {
        clearance = Math.min(clearance, geoDistance(point, vertex));
      }
      if (clearance > bestClearance) {
        bestClearance = clearance;
        best = point;
      }
    }
  }
  return best;
}

/**
 * Rank airports by the population of the city they appear to serve.
 *
 * No dataset we have carries a traffic figure or a size class, and inventing
 * one would be the same mistake as inferring a destination from a heading
 * (D6). The population of the nearest large city is not passenger volume, but
 * it is a real number measuring something related, and it is what puts Tokyo's
 * airports above Bristol's.
 *
 * Within one city that measure is flat -- Heathrow, Gatwick, Biggin Hill and
 * Farnborough all serve London and all score 7.5 million -- so a second, also
 * real signal breaks the tie: OpenFlights records the city an airport is
 * filed under, and the four Londons above are filed as London, London, London
 * and Farnborough. Airports whose own city matches the city they scored
 * against sort first. It does not separate Heathrow from Biggin Hill, and
 * nothing in this data can; the label layer answers that by capping how many
 * airports it will draw at once rather than by pretending to a ranking.
 */
export function rankAirports(airports, cities) {
  // Every airport against every city is 7,698 x 9,062 great-circle distances,
  // which took a minute of every `npm run dev`. Cities go into one-degree
  // buckets first and each airport only looks at the nine around it -- the
  // search radius is 60 km, well inside one degree of latitude.
  const buckets = new Map();
  const key = (lat, lon) => `${Math.floor(lat)}|${Math.floor(lon)}`;
  for (const city of cities) {
    const [lon, lat] = city.loc.coordinates;
    const k = key(lat, lon);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(city);
  }

  const ranked = [];
  for (const airport of airports) {
    if (!/^[A-Z]{3}$/.test(airport.iata ?? '')) continue;
    if (!Number.isFinite(airport.latitude) || !Number.isFinite(airport.longitude)) continue;

    let served = 0;
    let servedName = '';
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const near = buckets.get(
          key(Math.floor(airport.latitude) + dLat, Math.floor(airport.longitude) + dLon),
        );
        if (!near) continue;
        for (const city of near) {
          if (city.population <= served) continue;
          const km =
            geoDistance([airport.longitude, airport.latitude], city.loc.coordinates) *
            EARTH_RADIUS_KM;
          if (km <= AIRPORT_CITY_RADIUS_KM) {
            served = city.population;
            servedName = city.name;
          }
        }
      }
    }
    if (served < MIN_AIRPORT_CITY_POPULATION) continue;

    // `primary` decides ties at build time and is not written out: the runtime
    // reads the order, not the flag.
    ranked.push({
      primary:
        (airport.city ?? '').trim().toLowerCase() === servedName.trim().toLowerCase(),
      entry: {
        name: airport.name,
        iata: airport.iata,
        lat: round(airport.latitude),
        lon: round(airport.longitude),
        rank: served,
      },
    });
  }

  ranked.sort(
    (a, b) => b.entry.rank - a.entry.rank || Number(b.primary) - Number(a.primary),
  );
  return ranked.map((r) => r.entry);
}

// ---- main ------------------------------------------------------------------

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

async function main() {
  const topologyPath = require.resolve(`world-atlas/countries-${RESOLUTION}.json`);
  const topology = JSON.parse(await readFile(topologyPath, 'utf8'));

  const borders = {
    resolution: RESOLUTION,
    arcs: decodeArcs(topology),
  };

  const countries = feature(topology, topology.objects.countries).features.map((f) => {
    const [lon, lat] = anchorFor(f.geometry);
    return {
      name: f.properties.name,
      lat: round(lat),
      lon: round(lon),
      // Steradians. Decides which names appear first as the camera pulls
      // back: Russia earns a label at a zoom where Luxembourg cannot.
      rank: Number(geoArea(f.geometry).toFixed(6)),
    };
  });
  countries.sort((a, b) => b.rank - a.rank);

  const allCities = require('all-the-cities');
  const cities = allCities
    .filter((city) => city.population >= MIN_CITY_POPULATION)
    .map((city) => ({
      name: city.name,
      lat: round(city.loc.coordinates[1]),
      lon: round(city.loc.coordinates[0]),
      rank: city.population,
    }))
    .sort((a, b) => b.rank - a.rank);

  const airportSource = require('@nwpr/airport-codes');
  const airports = rankAirports(
    airportSource.default ?? airportSource,
    allCities.filter((city) => city.population >= MIN_AIRPORT_CITY_POPULATION),
  );

  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'borders.json'), JSON.stringify(borders));
  await writeFile(
    join(target, 'labels.json'),
    JSON.stringify({ countries, cities, airports }),
  );

  const points = borders.arcs.reduce((total, arc) => total + arc.length / 2, 0);
  console.log(
    `[geography] ${borders.arcs.length} arcs, ${points} points ` +
      `(${((await sizeOf(join(target, 'borders.json'))) / 1024).toFixed(0)} KB); ` +
      `${countries.length} countries, ${cities.length} cities, ` +
      `${airports.length} airports ` +
      `(${((await sizeOf(join(target, 'labels.json'))) / 1024).toFixed(0)} KB)`,
  );
}

await main();
