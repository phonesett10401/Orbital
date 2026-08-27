/**
 * Geography labels: country names, city names, airport codes.
 *
 * The data comes from the same build-time reduction as the borders
 * (`scripts/build-geography.mjs`), so this layer costs no API credit and no
 * runtime download beyond one 125 KB file.
 *
 * **Labels are DOM, not GL, and that is a deliberate departure.** Every other
 * layer in this project is a single draw call, and text is the one thing that
 * bargain does not fit: glyphs in WebGL mean either a texture per string --
 * one draw call each, which is the trap D15 exists to avoid -- or a signed
 * distance field atlas, which is a font pipeline, a packer, and a shader for
 * something the browser already does better. Absolutely positioned `<div>`s
 * are crisp at any device pixel ratio, restyle from CSS, and cost one
 * transform write per visible label. The cost is bounded by never letting more
 * than MAX_LABELS exist at once, which is also what keeps the globe readable.
 *
 * React is kept out of this exactly as it is kept out of the markers (D3): the
 * elements are pooled and written to directly from the animation loop.
 *
 * Three problems a label on a sphere has that a label on a map does not:
 *
 * - **It can be on the far side.** Hidden by the horizon test, the same
 *   `P . C >= r^2` used for marker picking, written out here rather than
 *   shared so the two cannot drift silently into agreement.
 * - **It can be off screen**, which projection tells us, and behind the
 *   camera, which projection tells us only if we check the sign.
 * - **There can be far too many.** Density is the whole design problem: the
 *   layer resolves progressively, showing almost nothing when zoomed out and
 *   adding cities and then airports as the camera comes in.
 */

import * as THREE from 'three';

import { latLonToVector3 } from './earth';

/** Height of the label anchor, in globe radii. Just above the border shell. */
export const LABEL_ALTITUDE = 0.001;

/**
 * The hard ceiling on labels drawn at once.
 *
 * Chosen for legibility rather than for cost -- forty names on a globe is
 * already a busy map, and the DOM work at forty is immeasurable next to the
 * frame. The cap is what makes the layer's cost independent of how many
 * countries, cities and airports happen to be in view.
 */
export const MAX_LABELS = 40;

/** Padding around a label's box when testing it against its neighbours, in px. */
const COLLISION_PADDING = 4;

/**
 * The most airports drawn at once, whatever else fits.
 *
 * Airports are the only class whose ranking cannot order its own members: a
 * London view offers Heathrow, Gatwick, Luton, Stansted, City, Biggin Hill,
 * Farnborough, Northolt and Rochester, and every one of them serves London, so
 * every one scores 7.5 million (see `rankAirports`). Without a cap the greedy
 * placement fills the screen with three-letter codes and pushes out the city
 * and country names above them -- measured: 40 labels over London at 0.1
 * radii, of which 36 were airports.
 *
 * A cap is the honest answer to a ranking we do not have. Eight is the number
 * at which a busy hub still shows its major fields and the rest of the map
 * survives.
 */
const MAX_AIRPORT_LABELS = 8;

export type LabelKind = 'country' | 'city' | 'airport';

export interface LabelDatum {
  name: string;
  lat: number;
  lon: number;
  /** Country: area in steradians. City: population. Airport: population served. */
  rank: number;
  iata?: string;
}

export interface LabelData {
  countries: LabelDatum[];
  cities: LabelDatum[];
  airports: LabelDatum[];
}

export interface LabelCandidate {
  kind: LabelKind;
  text: string;
  rank: number;
  position: THREE.Vector3;
}

export interface PlacedLabel extends LabelCandidate {
  x: number;
  y: number;
  width: number;
}

/**
 * What is allowed to appear at a given camera altitude, in globe radii above
 * the surface.
 *
 * The thresholds are not arithmetic, they are a judgement about when a name
 * stops helping and starts crowding, and they are written down here so the
 * judgement is arguable rather than buried:
 *
 * | Altitude | Reads as | Shown |
 * |---|---|---|
 * | above 3.0 | the whole planet, small | nothing -- at this size a country name covers the country |
 * | 1.0 to 3.0 | a hemisphere | the twelve largest countries |
 * | 0.35 to 1.0 | a continent | thirty countries, cities above 5 million |
 * | 0.12 to 0.35 | a large country | cities above 1 million |
 * | 0.06 to 0.12 | a region, several hundred km across | cities above 300,000, airports as codes |
 * | below 0.06 | a province, under 200 km across | cities above 100,000, airports by name |
 *
 * Airports arrive late because they are the densest class and their ranking
 * cannot order its own members (D44); at the last step the three-letter code
 * gives way to the airport's name, which is the level of detail somebody
 * looking at one province actually wants (D51).
 *
 * The two bottom steps exist because the table used to stop at a million
 * people, which put one label on Thailand and none on Chiang Mai, Hat Yai or
 * Udon Thani. The data now goes down to a hundred thousand, and these tiers
 * are what let it appear without crowding the view when it should not.
 */
export function labelBudget(altitude: number): {
  countries: number;
  cityMinRank: number;
  airports: boolean;
  airportNames: boolean;
} {
  const tier = (countries: number, cityMinRank: number, airports = false, airportNames = false) =>
    ({ countries, cityMinRank, airports, airportNames });

  if (altitude >= 3) return tier(0, Infinity);
  if (altitude >= 1) return tier(12, Infinity);
  if (altitude >= 0.35) return tier(30, 5_000_000);
  if (altitude >= 0.12) return tier(30, 1_000_000);
  if (altitude >= 0.06) return tier(30, 300_000, true, false);
  return tier(30, 100_000, true, true);
}

/**
 * Candidates for a budget, in the order they should be offered for placement.
 *
 * Countries first, then cities, then airports: when two labels collide the
 * larger thing wins, which is the same order a paper atlas uses. Within a
 * class the order is by rank, which the build step already sorted.
 */
export function candidatesFor(
  data: LabelData,
  budget: ReturnType<typeof labelBudget>,
  globeRadius: number,
): LabelCandidate[] {
  const radius = globeRadius * (1 + LABEL_ALTITUDE);
  const out: LabelCandidate[] = [];

  for (const country of data.countries.slice(0, budget.countries)) {
    out.push({
      kind: 'country',
      text: country.name,
      rank: country.rank,
      position: latLonToVector3(country.lat, country.lon, radius),
    });
  }

  if (Number.isFinite(budget.cityMinRank)) {
    for (const city of data.cities) {
      if (city.rank < budget.cityMinRank) break; // sorted by rank, descending
      out.push({
        kind: 'city',
        text: city.name,
        rank: city.rank,
        position: latLonToVector3(city.lat, city.lon, radius),
      });
    }
  }

  if (budget.airports) {
    for (const airport of data.airports) {
      out.push({
        kind: 'airport',
        // The code is the compact form for a regional view; the name is what
        // somebody looking at one province is asking for. Both come from the
        // same row, so this costs nothing but a branch.
        text: budget.airportNames ? airport.name ?? airport.iata ?? '' : airport.iata ?? airport.name ?? '',
        rank: airport.rank,
        position: latLonToVector3(airport.lat, airport.lon, radius),
      });
    }
  }

  return out;
}

/**
 * Whether a point on the globe faces the camera.
 *
 * `P . C >= r^2` is the horizon condition: at equality the line of sight is
 * tangent to the sphere. Labels sit a thousandth of a radius above the
 * surface, which is deliberately not accounted for -- a name that pops in
 * exactly at the limb is worse than one that appears a fraction of a degree
 * early, and the geometric tangent is the honest boundary.
 */
export function facesCamera(
  position: THREE.Vector3,
  cameraPosition: THREE.Vector3,
  globeRadius: number,
): boolean {
  return position.dot(cameraPosition) >= globeRadius * globeRadius;
}

/**
 * Project a world point to pixels, or null if it is not on screen.
 *
 * `Vector3.project` divides by w, which flips the sign of everything behind
 * the camera: a point directly behind projects to plausible-looking
 * coordinates in the opposite corner. The horizon test above already excludes
 * the far side of the globe, but the camera can also be pushed close enough
 * that a near-side point falls outside the frustum, so both the depth and the
 * bounds are checked -- and NaN before either of them, because it satisfies
 * neither test and fails both.
 */
export function projectToScreen(
  position: THREE.Vector3,
  camera: THREE.Camera,
  width: number,
  height: number,
  scratch = new THREE.Vector3(),
): { x: number; y: number } | null {
  scratch.copy(position).project(camera);
  // NaN first, and not as a formality. Every comparison below is false for
  // NaN, so a single bad number walks through both bounds tests and comes out
  // as a plausible-looking pixel coordinate. It happens for real: a camera
  // built while its container reports zero width has an aspect of 0/0, and
  // every projection through it is NaN. Found that way, in the running app.
  if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y) || !Number.isFinite(scratch.z)) {
    return null;
  }
  if (scratch.z > 1 || scratch.z < -1) return null;
  if (scratch.x < -1 || scratch.x > 1 || scratch.y < -1 || scratch.y > 1) return null;
  return {
    x: ((scratch.x + 1) / 2) * width,
    y: ((1 - scratch.y) / 2) * height,
  };
}

/**
 * Greedy placement: offer labels in order, keep the ones that do not overlap
 * something already kept, and never let airports take more than their share.
 *
 * Greedy rather than optimal because the ordering already encodes what matters
 * -- a country name beats a city name beats an airport code -- and because the
 * set is recomputed as the camera moves, so an optimal solve would be thrown
 * away a quarter of a second later. What greedy guarantees, and what the eye
 * actually notices, is that no two labels are ever drawn on top of each other.
 */
export function placeLabels(
  candidates: Array<LabelCandidate & { x: number; y: number; width: number }>,
  lineHeight: number,
  maxLabels = MAX_LABELS,
  maxAirports = MAX_AIRPORT_LABELS,
): PlacedLabel[] {
  const placed: PlacedLabel[] = [];
  let airports = 0;

  for (const candidate of candidates) {
    if (placed.length >= maxLabels) break;
    if (candidate.kind === 'airport' && airports >= maxAirports) continue;

    const halfWidth = candidate.width / 2 + COLLISION_PADDING;
    const halfHeight = lineHeight / 2 + COLLISION_PADDING;

    const clashes = placed.some(
      (other) =>
        Math.abs(other.x - candidate.x) < halfWidth + other.width / 2 + COLLISION_PADDING &&
        Math.abs(other.y - candidate.y) < halfHeight + lineHeight / 2 + COLLISION_PADDING,
    );
    if (clashes) continue;

    if (candidate.kind === 'airport') airports += 1;
    placed.push(candidate);
  }

  return placed;
}

// ---- the DOM layer ---------------------------------------------------------

/**
 * How often the visible SET is recomputed, in milliseconds.
 *
 * Positions are rewritten every frame -- a label that lagged the globe by a
 * quarter of a second while dragging would look broken -- but deciding which
 * labels to show walks every candidate and does collision tests, and that
 * answer does not change meaningfully at 60 Hz. Splitting the two is what
 * keeps this layer's per-frame cost proportional to the forty labels drawn
 * rather than to the 1,569 that exist.
 */
const SELECTION_INTERVAL_MS = 200;

/** Font used to measure label widths. Must match `.geo-label` in styles.css. */
const LABEL_FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

/** Line height used for collision boxes, in px. Matches the CSS. */
const LABEL_LINE_HEIGHT = 14;

export interface LabelLayer {
  element: HTMLDivElement;
  /** Labels currently drawn. Read by tests and by the console handle. */
  count: number;
  load(fetchData: () => Promise<LabelData>): Promise<void>;
  update(camera: THREE.PerspectiveCamera, width: number, height: number, now: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/**
 * Measure text width once per string.
 *
 * A canvas is the only way to know a string's width without laying it out, and
 * laying out forty candidates that may not be drawn is the cost this avoids.
 * Where there is no 2D context -- under vitest, and on Safari before 16.4 --
 * the fallback is a per character estimate, wrong by a few pixels, which can
 * move a collision decision and cannot move a correctness one.
 */
export function createTextMeasurer(): (text: string) => number {
  const cache = new Map<string, number>();
  let context: OffscreenCanvasRenderingContext2D | null = null;
  // OffscreenCanvas rather than a detached <canvas>: it measures identically,
  // never touches the document, and is absent under jsdom, which gives the
  // fallback below a real path to exercise instead of a stub that logs.
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(1, 1).getContext('2d');
    if (context) context.font = LABEL_FONT;
  }

  return (text: string) => {
    const cached = cache.get(text);
    if (cached !== undefined) return cached;
    const width = context ? context.measureText(text).width : text.length * 6.2;
    cache.set(text, width);
    return width;
  };
}

export function createLabelLayer(globeRadius: number): LabelLayer {
  const element = document.createElement('div');
  element.className = 'geo-labels';

  const measure = createTextMeasurer();
  const scratch = new THREE.Vector3();

  let data: LabelData | null = null;
  let chosen: PlacedLabel[] = [];
  let lastSelection = 0;
  let visible = true;

  // Candidates depend only on the budget, and the budget changes only when the
  // camera crosses a tier -- a few times in a session. Rebuilding the list
  // every selection allocated 1,422 vectors five times a second to get the
  // same answer, so it is cached against the budget that produced it.
  let cacheKey = '';
  let cached: LabelCandidate[] = [];

  // One pooled element per possible label. Creating and destroying nodes as
  // the camera moves would churn the DOM every frame the set changed; forty
  // spans that are shown, hidden and rewritten cost nothing.
  const pool: HTMLSpanElement[] = [];
  for (let i = 0; i < MAX_LABELS; i += 1) {
    const span = document.createElement('span');
    span.className = 'geo-label';
    span.style.display = 'none';
    element.appendChild(span);
    pool.push(span);
  }

  function select(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    if (!data) {
      chosen = [];
      return;
    }

    const altitude = (camera.position.length() - globeRadius) / globeRadius;
    const budget = labelBudget(altitude);
    const key = `${budget.countries}/${budget.cityMinRank}/${budget.airports}`;
    if (key !== cacheKey) {
      cacheKey = key;
      cached = candidatesFor(data, budget, globeRadius);
    }

    const projected: Array<LabelCandidate & { x: number; y: number; width: number }> = [];

    for (const candidate of cached) {
      if (!facesCamera(candidate.position, camera.position, globeRadius)) continue;
      const screen = projectToScreen(candidate.position, camera, width, height, scratch);
      if (!screen) continue;
      projected.push({ ...candidate, ...screen, width: measure(candidate.text) });
    }

    chosen = placeLabels(projected, LABEL_LINE_HEIGHT);
  }

  function update(
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
    now: number,
  ): void {
    if (!visible || !data) {
      for (const span of pool) span.style.display = 'none';
      layer.count = 0;
      return;
    }

    if (now - lastSelection >= SELECTION_INTERVAL_MS || lastSelection === 0) {
      lastSelection = now;
      select(camera, width, height);
    }

    let drawn = 0;
    for (const label of chosen) {
      // Re-tested every frame, not only at selection: between selections the
      // camera keeps moving, and a label that has crossed the limb must go
      // now, not up to 200 ms later.
      if (!facesCamera(label.position, camera.position, globeRadius)) continue;
      const screen = projectToScreen(label.position, camera, width, height, scratch);
      if (!screen) continue;

      const span = pool[drawn];
      if (span.textContent !== label.text) {
        span.textContent = label.text;
        span.className = `geo-label geo-label--${label.kind}`;
      }
      span.style.display = '';
      span.style.transform = `translate(-50%, -50%) translate(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px)`;
      drawn += 1;
    }

    for (let i = drawn; i < pool.length; i += 1) pool[i].style.display = 'none';
    layer.count = drawn;
  }

  const layer: LabelLayer = {
    element,
    count: 0,
    async load(fetchData: () => Promise<LabelData>) {
      data = await fetchData();
      lastSelection = 0;
      cacheKey = '';
    },
    update,
    setVisible(next: boolean) {
      visible = next;
      if (!next) {
        for (const span of pool) span.style.display = 'none';
        layer.count = 0;
      }
    },
    dispose() {
      element.remove();
    },
  };

  return layer;
}
