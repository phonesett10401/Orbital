/**
 * The style for the planet view: imagery everywhere, cartography on top.
 *
 * Phase 1 of the migration out of globe.gl (D54), corrected after somebody
 * looked at it (D56). The globe here is MapLibre's own globe projection, so
 * there is one renderer and one continuous zoom from orbit to a street corner
 * rather than a hand-off between two (D52, D53).
 *
 * ## Imagery is the ground, at every zoom
 *
 * The first attempt layered imagery *under* a vector basemap and faded it out
 * at zoom 7.5. Below that the basemap was the ground — and the basemap's
 * background is `#f8f4f0`, so zooming into anywhere without roads gave a cream
 * screen. Fading real imagery out into a blank fill is precisely backwards.
 *
 * So imagery runs the whole way, in two tiers, and the vector tiles contribute
 * only what imagery cannot say:
 *
 * | | Source | Resolution | Reaches | Terms |
 * |---|---|---|---|---|
 * | Far | NASA GIBS `BlueMarble_NextGeneration` | 500 m | z8 | open data, unmetered |
 * | Near | Esri World Imagery | **sub-metre** | z19 | no key, attribution, not unlimited |
 * | Over both | OpenFreeMap vector | — | z14+ | no key, no cap |
 *
 * Two imagery sources rather than one because their terms differ, and the
 * split is deliberate rather than incidental: NASA's open data is unmetered
 * and carries every ordinary view of the planet, while the close tier — which
 * is only reached by zooming past a continent — comes from a commercial
 * provider that serves it without a key but does not promise to forever
 * (D58). If this ever needs to survive real traffic, both are configuration.
 *
 * ## What the vector tiles are allowed to draw
 *
 * Only what sits *on* the ground rather than replacing it: lines (roads,
 * boundaries, rivers), symbols (labels, icons) and extrusions (buildings).
 * Every area fill and the background are dropped, because their whole job is
 * to colour ground that imagery is already showing — and it is their colour
 * that produced the cream screen.
 */

import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';

import { config } from '../config';

/** Where each imagery tier stops having tiles of its own. */
export const IMAGERY_FAR_MAX_ZOOM = 8;
export const IMAGERY_NEAR_MAX_ZOOM = config.imageryCloseMaxZoom;

/** Where the close imagery fades in over the far one. */
export const IMAGERY_CROSSFADE_START = 5;
export const IMAGERY_CROSSFADE_END = 7;

export const GIBS_ATTRIBUTION =
  'Imagery <a href="https://earthdata.nasa.gov/gibs">NASA EOSDIS GIBS</a>';

/**
 * Whatever the close tier is, it is somebody's imagery and wants crediting.
 *
 * Both candidates require attribution, so this names both rather than guessing
 * from the URL: showing one line too many is a smaller fault than showing the
 * wrong one, or none.
 */
export const CLOSE_IMAGERY_ATTRIBUTION =
  'Close imagery <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics ' +
  '· or <a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH ' +
  '(Contains modified Copernicus Sentinel data)';

/**
 * The vector layer types that draw *on* the ground rather than replacing it.
 *
 * `fill` and `background` are deliberately absent. A fill's purpose is to
 * colour an area — water blue, parks green, everything else cream — which is
 * exactly what imagery is there to do, and better.
 */
/**
 * The two looks, and the state property that chooses between them.
 *
 * `imagery` is a photograph of the ground with cartography drawn over it.
 * `flat` is the vector basemap on its own - land, water, parks and buildings
 * drawn as areas - which is the look every ride-hailing app uses, and which
 * Liberty already contains: **16 fill layers and a background** that the
 * imagery build discards.
 *
 * ## One style, not two
 *
 * The switch is a MapLibre **global state** property, read by `global-state`
 * expressions in the paint of every layer. The alternative was `setStyle` with
 * a second stylesheet, and that would mean tearing down and re-adding the
 * aircraft, their tracks, the leader, the model and the terminator on every
 * toggle - five layers, three sources, two custom layers and a texture, all
 * re-created at the moment the user is watching. One style whose colours are
 * expressions has none of that: `setGlobalStateProperty` and the next frame is
 * the other map.
 *
 * It also means the flat mode costs **no extra network**. The fills come from
 * the vector tiles already being fetched for the roads and labels; only the
 * imagery requests stop.
 */
export const BASEMAP_STATE = 'basemap';
export const BASEMAP_IMAGERY = 'imagery';
export const BASEMAP_FLAT = 'flat';

/**
 * `flat` when the vector basemap is showing, `imagery` when the photograph is.
 *
 * Every colour in this file goes through here, so no layer can end up styled
 * for one mode and drawn in the other.
 */
export function whenFlat<T>(flat: T, imagery: T): ExpressionSpecification {
  return [
    'match',
    ['global-state', BASEMAP_STATE],
    BASEMAP_FLAT,
    flat,
    imagery,
  ] as unknown as ExpressionSpecification;
}

export const KEPT_LAYER_TYPES = new Set(['line', 'symbol', 'fill-extrusion']);

/**
 * Restyle one cartographic layer to read over imagery.
 *
 * The basemap is a light style: white roads on cream, dark text with a white
 * halo. Every one of those choices is correct against its own background and
 * close to invisible against a satellite photograph of a city, which is grey
 * and white and busy. Google's satellite mode does the same thing this does —
 * light roads with dark casings, bright labels with dark halos — because it is
 * what survives on top of a photograph (D59).
 *
 * The geometry, the zoom rules and the label placement are untouched: those are
 * the hundred layers of tuned cartography worth keeping. Only colour changes.
 */
export function styleForImagery(layer: LayerSpecification): LayerSpecification {
  if (layer.type === 'symbol') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        // White on a dark halo over a photograph; near-black on a light halo
        // over a pale basemap. Each is unreadable on the other background.
        'text-color': whenFlat('#39404d', '#ffffff'),
        'text-halo-color': whenFlat('rgba(255, 255, 255, 0.9)', 'rgba(0, 0, 0, 0.85)'),
        'text-halo-width': whenFlat(1.2, 1.6),
        'icon-halo-color': whenFlat('rgba(255, 255, 255, 0.9)', 'rgba(0, 0, 0, 0.85)'),
        'icon-halo-width': 1.2,
      },
    } as LayerSpecification;
  }

  if (layer.type === 'line') {
    // Casings are the wider line drawn under a road to outline it. Over
    // imagery they are what makes a road legible at all, so they go dark and
    // the road itself stays bright. Over the flat basemap the relationship
    // inverts: white roads, a pale grey casing, which is the look every
    // ride-hailing map uses because the ground behind it is already light.
    const isCasing = /casing|outline/.test(layer.id);
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'line-color': isCasing
          ? whenFlat('#dfe4ec', 'rgba(0, 0, 0, 0.55)')
          : whenFlat('#ffffff', 'rgba(255, 255, 255, 0.9)'),
        'line-opacity': isCasing ? whenFlat(1, 0.85) : whenFlat(1, 0.95),
      },
    } as LayerSpecification;
  }

  if (layer.type === 'fill-extrusion') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'fill-extrusion-color': whenFlat('#e3e7ee', '#d7dee8'),
        // Translucent over imagery so the building reads as a volume over its
        // own footprint in the photograph rather than replacing it. Opaque on
        // the flat map, where there is no photograph to preserve.
        'fill-extrusion-opacity': whenFlat(0.95, 0.6),
      },
    } as LayerSpecification;
  }

  // Fills and the background are Liberty's own palette, kept as authored -
  // that palette *is* the flat map, and it is the one part of this style
  // nobody here can draw better than its authors. They are simply switched
  // off when a photograph is doing their job.
  if (layer.type === 'fill') {
    return {
      ...layer,
      paint: { ...layer.paint, 'fill-opacity': whenFlat(fillOpacityOf(layer), 0) },
    } as LayerSpecification;
  }

  if (layer.type === 'background') {
    return {
      ...layer,
      paint: { ...layer.paint, 'background-opacity': whenFlat(1, 0) },
    } as LayerSpecification;
  }

  return layer;
}

/**
 * Liberty's own opacity for a fill layer, or 1.
 *
 * Read back rather than overwritten with 1: several of its fills are
 * deliberately semi-transparent - hillshade-like landcover, park washes - and
 * flattening them all to opaque would be a different map, not a restyled one.
 * Only expressions are dropped, because a `match` cannot switch between an
 * expression and a number, and the layers that use one are not the ones whose
 * transparency carries meaning.
 */
function fillOpacityOf(layer: LayerSpecification): number {
  const paint = (layer as { paint?: Record<string, unknown> }).paint;
  const opacity = paint?.['fill-opacity'];
  return typeof opacity === 'number' ? opacity : 1;
}

/**
 * Build the planet style from a vector basemap style.
 *
 * The vector style is fetched rather than written here: it is a hundred layers
 * of tuned cartography, and the useful part of it — where roads go, what gets
 * a label, how buildings extrude — survives this filter intact.
 */
export function withImagery(style: StyleSpecification): StyleSpecification {
  // Every layer is kept now, including the 16 fills and the background that
  // the imagery-only build used to discard: they are the flat basemap, and
  // they are switched on and off by paint expressions rather than by being
  // present or absent (D75).
  //
  // **Except the basemap's own raster.** Liberty's second layer is Natural
  // Earth shaded relief at 0.6 opacity, and keeping it drew a pale grey wash
  // over our satellite imagery - most visibly over the ocean, which is where
  // there is nothing else to hide it (defect #26). It is ground, like the
  // fills, but unlike them it cannot simply be switched off by opacity: its
  // own opacity is a zoom curve, so gating it would mean rewriting someone
  // else's expression from the inside. Dropping it costs the flat map some
  // relief shading that ride-hailing maps do not have anyway, and saves
  // fetching a second raster source in both modes.
  const cartography = style.layers
    .filter((layer) => layer.type !== 'raster')
    .map(styleForImagery);

  const far: LayerSpecification = {
    id: 'orbital-imagery-far',
    type: 'raster',
    source: 'orbital-imagery-far',
    paint: { 'raster-opacity': whenFlat(0, 1) },
  };

  const near: LayerSpecification = {
    id: 'orbital-imagery-near',
    type: 'raster',
    source: 'orbital-imagery-near',
    paint: {
      // Fades in over the far tier rather than replacing it, so the seam is a
      // dissolve between two photographs of the same ground rather than a cut.
      // The crossfade between the two photographs, ending at "however much
      // photograph this mode shows" rather than at 1.
      //
      // **The switch goes in the outputs, not around the whole thing.** A
      // `zoom` expression may only be the input to a *top-level* step or
      // interpolate, so multiplying this by the mode - the obvious way to
      // write it - is rejected by the style spec, and a rejected paint
      // property fails the entire style: 0 layers, black screen, no map
      // (defect #25). Checked against the spec's own validator rather than by
      // reasoning about it.
      'raster-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        IMAGERY_CROSSFADE_START,
        0,
        IMAGERY_CROSSFADE_END,
        whenFlat(0, 1),
      ],
    },
  };

  return {
    ...style,
    projection: { type: 'globe' },
    sources: {
      ...style.sources,
      'orbital-imagery-far': {
        type: 'raster',
        tiles: [config.imageryTileUrl],
        tileSize: 256,
        maxzoom: IMAGERY_FAR_MAX_ZOOM,
        attribution: GIBS_ATTRIBUTION,
      },
      'orbital-imagery-near': {
        type: 'raster',
        tiles: [config.imageryCloseTileUrl],
        tileSize: 256,
        maxzoom: IMAGERY_NEAR_MAX_ZOOM,
        attribution: CLOSE_IMAGERY_ATTRIBUTION,
      },
    },
    // Imagery first so it is the ground; cartography over it, in the order the
    // basemap's authors chose.
    layers: [far, near, ...cartography],
  };
}

/**
 * Replace every `url`-style vector source with the tile list it points at.
 *
 * A vector source can be declared two ways: with `tiles`, a list of templates,
 * or with `url`, a TileJSON document that MapLibre must fetch and read the
 * templates out of. The basemap uses the second form, and in this application
 * that second request never completed — the map ran with 93 layers of
 * cartography and requested **not one vector tile**, silently, with no error
 * event and the style stuck reporting itself as still loading (D60).
 *
 * The same document fetches perfectly from the page. So it is fetched here,
 * where the result can be seen and a failure is an exception rather than a
 * quiet absence, and the source is handed to MapLibre already resolved.
 *
 * The indirection is worth losing anyway: the tile path contains a dated build
 * (`/planet/20260823_080002_pt/`) that changes weekly, so resolving it at load
 * time is also what keeps the templates current.
 */
export async function resolveVectorSources(
  style: StyleSpecification,
  fetchJson: (url: string) => Promise<Record<string, unknown>>,
): Promise<StyleSpecification> {
  const sources: StyleSpecification['sources'] = { ...style.sources };

  for (const [name, source] of Object.entries(style.sources)) {
    if (source.type !== 'vector' || !('url' in source) || !source.url) continue;

    const tileJson = await fetchJson(source.url);
    const tiles = tileJson.tiles as string[] | undefined;
    if (!tiles?.length) throw new Error(`${source.url}: TileJSON has no tiles`);

    sources[name] = {
      type: 'vector',
      tiles,
      minzoom: (tileJson.minzoom as number) ?? 0,
      maxzoom: (tileJson.maxzoom as number) ?? 14,
      attribution: (tileJson.attribution as string) ?? undefined,
    };
  }

  return { ...style, sources };
}

/**
 * Fetch the vector style, resolve its sources, and build the planet style.
 *
 * A failure here is fatal in a way the geography layers never were — there is
 * no map without a style — so it rejects rather than degrading, and the caller
 * decides what to show instead.
 */
export async function loadPlanetStyle(
  fetchStyle: (url: string) => Promise<StyleSpecification> = defaultFetch,
  fetchJson: (url: string) => Promise<Record<string, unknown>> = defaultFetchJson,
): Promise<StyleSpecification> {
  const style = await fetchStyle(config.cityStyleUrl);
  return withImagery(await resolveVectorSources(style, fetchJson));
}

async function defaultFetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

async function defaultFetch(url: string): Promise<StyleSpecification> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as StyleSpecification;
}

/**
 * The id of the first label in the style, or null if it has none.
 *
 * **Night goes underneath this.** Drawn over the top instead, the wash dims the
 * place names along with the ground, and on the night side they stop being
 * readable while the day side's stay crisp - which is not what night does to a
 * map. A map's labels are not lit by the sun; they are annotation, drawn on top
 * of the world rather than in it. The same reasoning already applies to the
 * aircraft, their tracks and their callsigns, which are added after the
 * terminator for exactly this reason (defect #24, D74).
 *
 * The first symbol layer is the boundary because Liberty orders its layers the
 * way every cartographic style does: ground, then lines, then labels. So
 * inserting here puts night above the imagery and the roads and below every
 * piece of text in the style, without naming a single layer id that could be
 * renamed upstream.
 */
export function firstLabelLayerId(style: {
  layers?: Array<{ id: string; type: string }>;
} | null | undefined): string | null {
  for (const layer of style?.layers ?? []) {
    if (layer.type === 'symbol') return layer.id;
  }
  return null;
}
