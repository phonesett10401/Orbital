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
import { canEnter } from '../bodies';

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
  // The terminator is Earth-only and it is left to `applyBodyChrome`, which
  // settles the reader's night setting against the world underneath in one
  // place. Hiding it here as well would fight that (D169).
  //
  // `orbital-solar-system` was listed here until D169. There has been no such
  // layer since the solar system became a page with its own camera (D163,
  // D164): the exemption protected nothing, and read as evidence that a layer
  // by that name still existed.
  'orbital-terminator',
]);

/** The two imagery tiers Earth uses. Another world replaces both with one. */
export const IMAGERY_FAR = 'orbital-imagery-far';
export const IMAGERY_NEAR = 'orbital-imagery-near';

/**
 * What the two imagery tiers should be doing, for one world and one basemap.
 *
 * The whole rule, in one place, because it used to be in two and the two
 * disagreed. `visibilityFor` correctly kept the near tier off anywhere but
 * Earth. The basemap toggle turned **both** tiers on whenever the reader had
 * imagery chosen, knew nothing about which world was underneath, and ran
 * afterwards - so it undid the plan every time.
 *
 * Above zoom 7, where the near tier finishes fading in, that served Earth's
 * Esri imagery over other worlds: farmland in Brazil, captioned "Mars ·
 * surface imagery", with the far mosaic still correctly loaded underneath it.
 * Mercury hid the fault for a year by accident - its mosaic stops at zoom 5
 * and the near tier's opacity ramp has not begun there - and it only surfaced
 * when Venus arrived with a mosaic eleven levels deep (D182).
 */
export function imageryVisibility(
  bodyId: string,
  imageryChosen: boolean,
): Record<string, 'visible' | 'none'> {
  return {
    [IMAGERY_FAR]: imageryChosen ? 'visible' : 'none',
    // Earth has two tiers that cross-fade. Every other world has one mosaic,
    // so the near tier has nothing to fade into - and it is still pointed at
    // Earth's tiles, which is the part that makes leaving it on a false claim
    // rather than a wasted layer.
    [IMAGERY_NEAR]: imageryChosen && bodyId === 'earth' ? 'visible' : 'none',
  };
}

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

  // The imagery tiers have one rule and it lives in one function, so the
  // basemap toggle cannot quietly contradict this plan the way it used to.
  Object.assign(plan, imageryVisibility(body.id, true));

  return plan;
}

/**
 * Whether two worlds would be served by the same imagery source.
 *
 * The swap in `PlanetView` used to decide this on the attribution alone, and
 * two worlds crediting the same mission then shared a source: Neptune was
 * drawn with Uranus's plate, because both are Voyager 2 (D193). Exposed here
 * so the rule can be checked without a map.
 */
export function sameImagery(a: Body, b: Body): boolean {
  return surfaceTilesFor(a) === surfaceTilesFor(b);
}

/**
 * The tiles the far imagery source should serve for a body, or null for Earth.
 *
 * Earth is null rather than a URL because its tiles are configuration - two
 * tiers, either overridable by an environment variable - and hard-coding them
 * here would quietly override that.
 */
export function surfaceTilesFor(body: Body): string | null {
  if (body.id === 'earth' || !canEnter(body)) return null;
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
  return canEnter(body) ? body.surface!.maxZoom : 5;
}

/*
 * **`globeLayerIds` is gone, and with it `BACKGROUND_LAYER` and `SOLAR_LAYER`**
 * (D169). It gathered everything painting the globe so the handover could hide
 * it while a custom layer drew the solar system in the space left behind. D164
 * deleted the handover; the function outlived it by five sessions, called by
 * nothing and covered by four passing tests, which is worse than untested code
 * because it reads as a live rule.
 *
 * One thing it knew is worth keeping, because the next person to write a rule
 * over a style will meet it. **The basemap's `background` layer belongs to
 * neither half of the rule below**: `cartographyLayerIds` finds layers by their
 * source and it has none, `ownLayerIds` finds them by the `orbital-` prefix and
 * it has none. It went on painting the globe's disc after everything else was
 * switched off - proved by painting it red and watching the leftover disc turn
 * red (D143). `visibilityFor` leaves it alone deliberately: in globe projection
 * it paints the globe itself, and off Earth the mosaic covers it.
 */
