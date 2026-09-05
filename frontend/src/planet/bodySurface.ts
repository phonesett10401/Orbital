/**
 * Putting a different world under the camera.
 *
 * A body swap is **not** a `setStyle`. That would tear down and re-add the
 * aircraft, their tracks, the leader, the model, the terminator, the satellite
 * shell and every source behind them - the same objection D75 raised against
 * doing it for the imagery toggle, and the reason that toggle is a paint
 * expression instead.
 *
 * So the style stays and three things change:
 *
 * 1. the imagery source's tiles, via `setTiles`
 * 2. the visibility of the vector cartography, which is Earth's roads, labels
 *    and coastlines and describes nowhere else
 * 3. the visibility of everything Orbital itself draws about Earth
 *
 * The third is the one that matters. Aircraft, satellites, airports, receiver
 * coverage and the terminator are all statements about Earth; over Mars they
 * are not stale or empty but **meaningless**, and a layer drawn where its
 * subject does not exist is a stronger false claim than one drawn late (D120).
 */

import type { Body } from '../bodies';
import { isLandable } from '../bodies';

/** Layers Orbital adds that only make sense on Earth. */
export const EARTH_ONLY_LAYERS = [
  'orbital-aircraft',
  'orbital-aircraft-label',
  'orbital-aircraft-model',
  'orbital-route',
  'orbital-airport-halo',
  'orbital-airport-ring',
  'orbital-airport-label',
  'orbital-coverage-fill',
  'orbital-coverage-line',
  'orbital-coverage-hatch',
  'orbital-coverage-label',
  'orbital-satellites',
  'orbital-satellites-selection',
] as const;

/** The two imagery tiers Earth uses. Another world replaces both with one. */
export const IMAGERY_FAR = 'orbital-imagery-far';
export const IMAGERY_NEAR = 'orbital-imagery-near';

export interface StyleLike {
  layers: { id: string; type: string; source?: string }[];
}

/**
 * The vector cartography layer ids in a style - everything drawn from tiles.
 *
 * Found by source rather than listed, because the basemap brings a hundred and
 * eleven of them and any hand-written list would be wrong by the next style
 * update. Orbital's own layers have no `source-layer` from the vector tiles,
 * so filtering on the source name is enough to separate them.
 */
export function cartographyLayerIds(style: StyleLike, vectorSource = 'openmaptiles'): string[] {
  return style.layers.filter((l) => l.source === vectorSource).map((l) => l.id);
}

/**
 * What every layer's visibility should be, for one body.
 *
 * Returned as data rather than applied here so it can be tested without a map:
 * there is no MapLibre in this project's test environment, and a rule that
 * only exists inside an imperative callback is a rule nothing can check.
 */
export function visibilityFor(
  body: Body,
  style: StyleLike,
): Record<string, 'visible' | 'none'> {
  const onEarth = body.id === 'earth';
  const plan: Record<string, 'visible' | 'none'> = {};

  for (const id of cartographyLayerIds(style)) {
    plan[id] = onEarth ? 'visible' : 'none';
  }
  for (const id of EARTH_ONLY_LAYERS) {
    plan[id] = onEarth ? 'visible' : 'none';
  }

  // Earth has two imagery tiers that cross-fade; every other world has one
  // mosaic, so the near tier has nothing to fade into and stays off.
  plan[IMAGERY_FAR] = 'visible';
  plan[IMAGERY_NEAR] = onEarth ? 'visible' : 'none';

  return plan;
}

/**
 * The tiles the far imagery source should serve for a body, or null for Earth.
 *
 * Earth is null rather than a URL because its tiles are configuration - two
 * tiers, either overridable by an environment variable - and hard-coding them
 * here would quietly override that.
 */
export function surfaceTilesFor(body: Body): string | null {
  if (body.id === 'earth' || !isLandable(body)) return null;
  return body.surface!.tiles;
}

/**
 * How far in the camera may go on this world.
 *
 * Not cosmetic: past a mosaic's own maximum zoom MapLibre overzooms, which on
 * a 5-level Mercury mosaic means a blurred rectangle presented with the same
 * confidence as a sharp one.
 */
export function maxZoomFor(body: Body): number {
  return isLandable(body) ? body.surface!.maxZoom : 5;
}
