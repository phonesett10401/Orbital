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

/**
 * The prefix every layer Orbital adds carries.
 *
 * The rule below is built on this rather than on a list, and the difference is
 * the whole point - see `NOT_ABOUT_EARTH`.
 */
export const OWN_LAYER_PREFIX = 'orbital-';

/**
 * The only layers of Orbital's own that are **not** statements about Earth.
 *
 * Everything else with the prefix is switched off when the camera leaves, by
 * derivation rather than by enumeration. That inversion is the fix for a real
 * bug: the old hand-written list had drifted out of date, and the drift was
 * invisible because a missing entry does not fail, it just leaves a layer on.
 *
 * Measured on Mars, the list was missing **`orbital-satellite-shell`** - two
 * thousand Earth satellites in orbit around Mars - along with the route casing,
 * the route gap, both leader layers, the satellite labels and the origin
 * marker, while `orbital-route` itself was correctly hidden. Six of the seven
 * had been added to the app after the list was written (D133).
 *
 * With the rule inverted, a new Earth layer is hidden automatically and only a
 * genuinely body-agnostic one needs a line here - which is the direction the
 * mistake should point.
 */
/**
 * Layers that belong to a body other than Earth.
 *
 * D133 made every `orbital-` layer Earth's unless excepted, which was right
 * until something was drawn about somewhere else. The lunar spacecraft are not
 * body-agnostic and they are not Earth's: they belong to the Moon, and they
 * should be **on there and nowhere else** - including not over Mars, which is
 * the same mistake D133 fixed, one body along (D134).
 */
export const LAYER_HOME_BODY: Record<string, string> = {
  'orbital-moon-satellites': 'moon',
  'orbital-moon-satellites-halo': 'moon',
  'orbital-moon-satellites-label': 'moon',
  'orbital-moon-leader': 'moon',
  'orbital-moon-shell': 'moon',
};

/** Which world a layer is a statement about. Earth unless stated otherwise. */
export function homeBodyOf(layerId: string): string {
  return LAYER_HOME_BODY[layerId] ?? 'earth';
}

export const NOT_ABOUT_EARTH = new Set<string>([
  'orbital-imagery-far',
  'orbital-imagery-near',
  // The solar system is the one thing that means *more* off Earth, not less:
  // it is how you see where you have gone.
  'orbital-solar-system',
  // The terminator is Earth-only, but it already has its own control that
  // accounts for the body *and* the reader's setting. Listing it here as well
  // would turn it back on for anyone who had switched it off.
  'orbital-terminator',
]);

/** The two imagery tiers Earth uses. Another world replaces both with one. */
export const IMAGERY_FAR = 'orbital-imagery-far';
export const IMAGERY_NEAR = 'orbital-imagery-near';

export interface StyleLike {
  layers: { id: string; type: string; source?: string }[];
}

/**
 * Orbital's own layer ids, from the style plus any given by the caller.
 *
 * The second half is not optional in practice: **custom layers do not appear in
 * `map.getStyle()`**, so a rule derived from the style alone cannot see the
 * satellite shell, the aircraft model or the solar system - which is exactly
 * how the shell kept drawing around Mars. The caller passes them in.
 */
export function ownLayerIds(style: StyleLike, customLayerIds: readonly string[] = []): string[] {
  return [...style.layers.map((l) => l.id), ...customLayerIds].filter(
    (id) => id.startsWith(OWN_LAYER_PREFIX) && !NOT_ABOUT_EARTH.has(id),
  );
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
  customLayerIds: readonly string[] = [],
): Record<string, 'visible' | 'none'> {
  const onEarth = body.id === 'earth';
  const plan: Record<string, 'visible' | 'none'> = {};

  for (const id of cartographyLayerIds(style)) {
    plan[id] = onEarth ? 'visible' : 'none';
  }
  // Each of Orbital's own layers is shown on the one world it describes.
  for (const id of ownLayerIds(style, customLayerIds)) {
    plan[id] = homeBodyOf(id) === body.id ? 'visible' : 'none';
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

/**
 * Everything that belongs to the world you are standing on, for the handover
 * to the solar system (D139).
 *
 * The same set `visibilityFor` hides when the camera leaves Earth, plus the two
 * imagery tiers - because here the globe itself is what has to go, and imagery
 * is what paints it. The solar system is the one thing kept: it is what the
 * view is handing over *to*.
 *
 * **The aircraft layers are in this set and that is not incidental.** At the
 * zoom where the solar system appears, two thousand aircraft icons cluster into
 * a speckled disc exactly the size of the globe - which is what a whole
 * afternoon of debugging mistook for the globe itself, while every ground layer
 * was already switched off.
 */
export function globeLayerIds(
  style: StyleLike,
  customLayerIds: readonly string[] = [],
): string[] {
  return [
    ...cartographyLayerIds(style),
    ...ownLayerIds(style, customLayerIds),
    IMAGERY_FAR,
    IMAGERY_NEAR,
  ].filter((id) => id !== SOLAR_LAYER);
}

/** The solar system's own layer, which the handover must never hide. */
export const SOLAR_LAYER = 'orbital-solar-system';
