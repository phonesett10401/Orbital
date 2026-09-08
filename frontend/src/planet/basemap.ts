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

/*
 * **`SOLAR_HANDOVER_START` and `SOLAR_HANDOVER_FULL` are gone** (D169). They
 * were the zooms at which the globe dissolved into the solar system, and one
 * of them had carried `@deprecated ... kept only until the style tests move
 * on` since D164. The style tests had moved on; nothing read either.
 */

/**
 * MapLibre's own atmosphere around the globe. **Off.**
 *
 * 0.8 is the library's default and D141 kept it at close zoom, on the argument
 * that a soft edge makes the globe look like a planet rather than a circle.
 * Phone asked for the opposite - *"the sun light should not apply when we zoom
 * into our earth"* - and having seen both, that is the call that counts (D145).
 *
 * It also removes a zoom expression and a pair of constants that had to agree
 * with the solar layer, so the halo can no longer outlive the globe by drifting
 * out of step with it. That was the whole of D141.
 *
 * The warm rim that remains at the limb is **not this**: it is land catching
 * the edge of the sphere in the NASA imagery, and it is present with the sky
 * removed entirely. Checked, so nobody hunts it again.
 */
export const ATMOSPHERE_BLEND = 0;

export const IMAGERY_CROSSFADE_START = 5;
export const IMAGERY_CROSSFADE_END = 7;

/**
 * Below this the close imagery is not merely invisible - it is not requested.
 *
 * **`raster-opacity: 0` does not stop a tile being fetched.** MapLibre loads
 * the tiles a layer covers regardless of what its paint does with them, so the
 * close tier was pulling Esri tiles for the whole visible hemisphere at world
 * zoom and drawing every one of them at zero. Measured in the running app at
 * zoom 2.8: **72 far tiles and 76 close ones**, and only the 72 were on screen.
 *
 * A browser allows about six connections per host, so those requests were not
 * free - they were competing with the tiles the user was waiting to see, which
 * is exactly the "the earth takes ages to appear" complaint (D112).
 *
 * Half a zoom level below the crossfade rather than exactly on it, so the close
 * tier still has headroom to load before it is needed and the seam stays a
 * dissolve rather than a pop.
 */
export const IMAGERY_NEAR_MIN_ZOOM = IMAGERY_CROSSFADE_START - 0.5;

/** The imagery layer ids, so a caller can hide both without naming them. */
export const IMAGERY_LAYERS = ['orbital-imagery-far', 'orbital-imagery-near'] as const;

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
export const BASEMAP_DARK = 'dark';

/** The three looks, in the order the corner button cycles them. */
export const BASEMAP_MODES = [BASEMAP_IMAGERY, BASEMAP_FLAT, BASEMAP_DARK] as const;
export type BasemapMode = (typeof BASEMAP_MODES)[number];

/**
 * Pick a value per basemap mode.
 *
 * `dark` is the third look (D109): the same cartography as `flat`, with the
 * ground taken down to near-black so that fourteen hundred satellites are the
 * brightest thing on screen. It is a *palette*, not a second stylesheet -
 * swapping in a ready-made dark style would mean `setStyle`, which is what the
 * whole global-state design exists to avoid, and would cost the 111 layers
 * and the `building-3d` extrusion this style was chosen for (D108).
 */
export function whenBasemap<T>(flat: T, dark: T, imagery: T): ExpressionSpecification {
  return [
    'match',
    ['global-state', BASEMAP_STATE],
    BASEMAP_FLAT,
    flat,
    BASEMAP_DARK,
    dark,
    imagery,
  ] as unknown as ExpressionSpecification;
}

/**
 * `flat` when either vector map is showing, `imagery` when the photograph is.
 *
 * The default for everything that distinguishes *ground* from *photograph* -
 * whether the imagery raster draws, whether the fills do. Only the properties
 * that genuinely differ between the two vector looks reach for `whenBasemap`,
 * so adding the third mode could not silently give a layer its imagery styling
 * on a map with no imagery in it.
 */
export function whenFlat<T>(flat: T, imagery: T): ExpressionSpecification {
  return whenBasemap(flat, flat, imagery);
}

/** The id of the layer that dims the flat basemap. */
export const BASEMAP_DIM_LAYER = 'orbital-basemap-dim';

/**
 * A layer that dims the cartography without touching what is drawn over it.
 *
 * The flat basemap is a light style and correct as one. It is wrong under two
 * thousand small bright aircraft: everything is bright, so nothing reads as
 * foreground. Over imagery the problem does not arise, because a satellite
 * photograph is dark and busy and the aircraft sit clearly on top of it.
 *
 * **Why a layer rather than a canvas filter.** A CSS `brightness()` on the
 * canvas would dim the aircraft too, which is precisely backwards. Inserted
 * here - after the whole basemap, before the aircraft - it dims the map and
 * leaves every marker, track and label of ours at full strength.
 *
 * Internal contrast is preserved: an alpha blend toward black moves every
 * basemap colour by the same proportion, so a road still reads against its
 * ground and a label still reads against its halo. It is the map as a whole
 * that recedes, which is what "too bright" was asking for.
 *
 * Zero in imagery mode, so the toggle costs nothing there.
 */
export function basemapDimLayer(strength: number): LayerSpecification {
  return {
    id: BASEMAP_DIM_LAYER,
    type: 'background',
    paint: {
      'background-color': '#05070c',
      // Nothing to dim in the other two: imagery has none of this problem, and
      // the dark mode's ground is already near-black by palette. Dimming it
      // again would flatten its remaining contrast rather than add any.
      'background-opacity': whenBasemap(strength, 0, 0),
    },
  } as LayerSpecification;
}

/**
 * The dark ground for the flat map, by Liberty layer id.
 *
 * Liberty's own palette is a *light* palette - cream land, blue water, pale
 * green parks - and this file used to pass its fills through untouched, on the
 * reasoning that nobody here can draw a basemap better than its authors. That
 * reasoning was sound and its conclusion was still wrong, because the thing
 * being kept was not the cartography but the **brightness**, and brightness is
 * the one property of a basemap that Orbital cannot inherit: what sits on top
 * of it is two thousand small bright aircraft, or fourteen hundred satellites.
 *
 * So the *arrangement* is still Liberty's - which areas exist, where they are,
 * what gets a label - and only the lightness is ours. Switching to a
 * ready-made dark style instead would have cost 64 of the 111 layers and the
 * `building-3d` extrusion, which is the one thing Liberty was chosen for
 * (D108).
 *
 * Land and water are the pair that has to survive at world zoom, where they
 * are most of the picture and nothing else is: `#1b212c` against `#080f1c` is
 * a deliberate two-step, because the ready-made dark styles put them within
 * two per cent of each other and the globe reads as a black disc.
 */
export const DARK_GROUND = '#1b212c';
export const DARK_WATER = '#080f1c';

export const DARK_FILL_COLORS: Record<string, string> = {
  water: DARK_WATER,
  landcover_wetland: '#12202a',
  park: '#16241a',
  landcover_wood: '#152219',
  landcover_grass: '#17251b',
  landcover_ice: '#232a35',
  landcover_sand: '#262117',
  landuse_residential: '#1f2530',
  landuse_pitch: '#1a2320',
  landuse_track: '#1a2320',
  landuse_cemetery: '#1a2320',
  landuse_school: '#1c2422',
  landuse_hospital: '#2a1c22',
  aeroway_fill: '#1e242e',
  road_area_pattern: '#1e242e',
  building: '#232936',
};

/**
 * The dark counterpart of one fill layer, or the default ground.
 *
 * Unknown ids fall back to the ground colour rather than being left as
 * authored: a style is free to add a fill layer, and inheriting one cream
 * patch into a dark map is worse than inheriting no patch at all.
 */
export function darkFillColor(layerId: string): string {
  return DARK_FILL_COLORS[layerId] ?? DARK_GROUND;
}

/**
 * The third look: the map recedes to near-black and keeps only its lines.
 *
 * Where `flat` is a dark map you are meant to read, this is a dark map you are
 * meant to see *past*. So it is one ground colour for every fill rather than a
 * palette - parks, sand and residential all stop being worth a hue when the
 * point of the mode is that nothing on the ground competes with what is above
 * it. Water keeps its own value, because the coastline is the one piece of
 * ground information that stays useful at orbital zoom.
 */
export const DARKEST_GROUND = '#0a0d12';
export const DARKEST_WATER = '#04060a';

export function darkestFillColor(layerId: string): string {
  return layerId === 'water' ? DARKEST_WATER : DARKEST_GROUND;
}

/**
 * The label layers whose size is ours rather than the style's.
 *
 * Country and state names are sized by their styles for a *map* - a rectangle
 * showing one region - and Orbital shows them on a globe, where every country
 * on the daylit half is on screen at once. Liberty asks for 17 px country
 * names by zoom 4; at that zoom the whole Pacific is visible and the names
 * collide into a mat of text over the thing the user is here to look at.
 */
export function isRegionLabel(layerId: string): boolean {
  return layerId.includes('country') || layerId.includes('state');
}

/**
 * How big a country or state name may be, by zoom.
 *
 * **A top-level `interpolate`, not a multiplier on the style's own ramp.** The
 * obvious way to write "the same but smaller" is to multiply the existing
 * expression by a factor, and a `zoom` expression may only be the direct input
 * of a top-level step or interpolate - so a product of two of them is rejected,
 * and a rejected paint property drops the entire style with no error at all
 * (defect #25, D25).
 *
 * The curve rejoins the style's own sizing by zoom 7, where a viewport holds a
 * country rather than a hemisphere and the original sizes are right again.
 */
export const REGION_LABEL_SIZE = [
  'interpolate',
  ['linear'],
  ['zoom'],
  0,
  7,
  3,
  10,
  5,
  13,
  7,
  16,
] as unknown as ExpressionSpecification;

/*
 * **`KEPT_LAYER_TYPES` is gone** (D169). It named the basemap layer types that
 * survived into imagery mode - and nothing imported it, in this file or any
 * other. D75 had already replaced "drop the layer" with "switch it off by
 * expression", so the set stopped being the rule and stayed on as a
 * description of one, which is the more expensive kind of wrong: it read like
 * something the code obeyed. The one exclusion that is still real is written
 * where it happens, in `withImagery`.
 */

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
    // Both grounds are dark now, so both want light text on a dark halo. They
    // are still written as two arms rather than one colour: a photograph is
    // busier than a flat fill, so it needs the brighter text and the heavier
    // halo, and collapsing them would tune one mode by accident.
    // Spread rather than assigned, because a symbol layer may legitimately
    // have no `layout` at all and writing `layout: undefined` puts the key
    // there with nothing in it - which the style spec rejects, and a rejected
    // property drops the whole style silently (defect #25). Caught by the
    // spec validator, not by reading.
    const sized = isRegionLabel(layer.id)
      ? { layout: { ...layer.layout, 'text-size': REGION_LABEL_SIZE } }
      : {};
    return {
      ...layer,
      ...sized,
      paint: {
        ...layer.paint,
        'text-color': whenBasemap('#aab4c4', '#8791a1', '#ffffff'),
        'text-halo-color': whenFlat('rgba(6, 9, 14, 0.85)', 'rgba(0, 0, 0, 0.85)'),
        'text-halo-width': whenFlat(1.4, 1.6),
        'icon-halo-color': whenFlat('rgba(6, 9, 14, 0.85)', 'rgba(0, 0, 0, 0.85)'),
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
        // The road is lighter than its ground in both modes and the casing is
        // darker, which is the relationship that makes a road read at all. On
        // the flat map the road stops at a mid grey rather than white: white
        // roads on a dark ground are brighter than the aircraft above them,
        // which is the whole fault this palette exists to fix.
        'line-color': isCasing
          ? whenFlat('rgba(0, 0, 0, 0.55)', 'rgba(0, 0, 0, 0.55)')
          : whenBasemap('#5a6478', '#39414f', 'rgba(255, 255, 255, 0.9)'),
        'line-opacity': isCasing ? whenFlat(0.9, 0.85) : whenFlat(1, 0.95),
      },
    } as LayerSpecification;
  }

  if (layer.type === 'fill-extrusion') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'fill-extrusion-color': whenBasemap('#2a313f', '#171c25', '#d7dee8'),
        // Translucent over imagery so the building reads as a volume over its
        // own footprint in the photograph rather than replacing it. Opaque on
        // the flat map, where there is no photograph to preserve.
        'fill-extrusion-opacity': whenFlat(0.95, 0.6),
      },
    } as LayerSpecification;
  }

  // Fills and the background are the flat map, and they are recoloured rather
  // than inherited (D108). The colour is set outright instead of through
  // `whenFlat` because these layers draw at opacity 0 in imagery mode, so
  // there is no second value to preserve - and several of Liberty's fill
  // colours are zoom expressions, which a two-armed `match` cannot switch
  // against a plain colour anyway.
  if (layer.type === 'fill') {
    // **A patterned fill cannot be recoloured.** `fill-pattern` draws a sprite
    // from the style's own image atlas and `fill-color` is ignored entirely,
    // so these layers would keep Liberty's light hatching on a dark map - the
    // one patch of the old palette that recolouring cannot reach. Hidden
    // rather than left showing: a pale hatch over dark ground reads as a
    // rendering fault, which is what it would be.
    const patterned = 'fill-pattern' in (layer.paint ?? {});
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'fill-color': whenBasemap(
          darkFillColor(layer.id),
          darkestFillColor(layer.id),
          darkFillColor(layer.id),
        ),
        // Drawn in every mode now, because this is the substrate the imagery
        // sits on rather than an alternative to it (D113).
        'fill-opacity': patterned ? 0 : fillOpacityOf(layer),
      },
    } as LayerSpecification;
  }

  if (layer.type === 'background') {
    return {
      ...layer,
      paint: {
        ...layer.paint,
        'background-color': whenBasemap(DARK_GROUND, DARKEST_GROUND, DARK_GROUND),
        // Always on: it is what a tile that has not arrived shows instead of
        // black, and the photograph covers it the moment one does.
        'background-opacity': 1,
      },
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

  // **The vector ground goes underneath the photograph, not over it.**
  //
  // Imagery arrives as raster tiles, which are large and slow; the vector
  // tiles carrying land, water and the coastline between them are a fraction
  // of the size and land first. Drawn in the style's own order, every one of
  // those fills sits *above* the imagery, so the only way to see a photograph
  // was to take them to zero - and then a tile that had not arrived yet showed
  // the one thing underneath it, which is nothing. That is the black
  // rectangles: not a stall, an empty substrate (D113).
  //
  // Split here so the ground can be laid first. The photograph is opaque, so
  // once a tile arrives it covers the fill under it completely and imagery
  // mode looks exactly as it did; where a tile has not arrived, the reader
  // gets dark land and sea in the right shapes instead of a hole.
  const isGround = (layer: LayerSpecification) =>
    layer.type === 'background' || layer.type === 'fill';
  const ground = cartography.filter(isGround);
  const overlay = cartography.filter((layer) => !isGround(layer));

  const far: LayerSpecification = {
    id: 'orbital-imagery-far',
    type: 'raster',
    source: 'orbital-imagery-far',
    paint: {
      // **The globe dissolves on its way out.** Everything else about the
      // handover is a visibility switch, which cannot be half-done; this is the
      // one part that can fade, and it is the part carrying the picture, so
      // fading it is what turns a cut into a transition (D144).
      //
      // A top-level interpolate on zoom whose *outputs* are the mode
      // expression - the only shape the style spec allows, and the same one the
      // near tier uses. A `zoom` expression nested deeper is rejected, and a
      // rejected paint property fails the entire style (defect #25).
      // **No zoom fade any more** (D164). This dissolved the globe as the old
      // handover approached, so a custom layer could draw the solar system in
      // the space it left. The solar system is a page with its own camera now
      // (D163), so there is nothing to hand over to and the imagery is simply
      // the imagery at every zoom this map reaches.
      'raster-opacity': whenFlat(0, 1),
    },
  };

  const near: LayerSpecification = {
    id: 'orbital-imagery-near',
    type: 'raster',
    source: 'orbital-imagery-near',
    minzoom: IMAGERY_NEAR_MIN_ZOOM,
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
    // No atmosphere at any zoom. See `ATMOSPHERE_BLEND`.
    sky: { 'atmosphere-blend': ATMOSPHERE_BLEND },
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
    // Ground, then the photograph over it, then the rest of the cartography in
    // the order the basemap's authors chose. The photograph is no longer "the
    // ground" - it is a layer over one, which is what stops a missing tile
    // being a hole (D113).
    layers: [...ground, far, near, ...overlay],
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
