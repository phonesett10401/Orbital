/**
 * The planet view: one renderer, from orbit to a street corner.
 *
 * Phase 1 of the migration off globe.gl (D54). It stands beside `GlobeView`
 * rather than replacing it — `VITE_VIEW=planet` picks this one — so the
 * working globe is untouched until this reaches parity, and abandoning the
 * direction costs deleting a folder.
 *
 * What it shares with the globe, because none of it was ever about rendering:
 * the store, the polling hooks, the contract, search, the detail panel, the
 * status bar. What it replaces is the drawing — and, in doing so, deletes the
 * border and label layers outright, since the basemap draws both better than
 * we did (D44, D45).
 *
 * React is kept out of the hot path here exactly as it is in `GlobeView`
 * (D3): the map is imperative, held in a ref, and fed from a store
 * subscription rather than from props.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { config } from '../config';
import { useOrbitalStore } from '../state/store';
import {
  AIRCRAFT_LABEL_LAYER,
  AIRCRAFT_LAYER,
  AIRCRAFT_SOURCE,
  ICON_AIRCRAFT,
  ICON_UNKNOWN,
  aircraftFeatures,
  aircraftLayers,
  hitsAt,
  selectionFromHits,
} from './aircraftLayer';
import {
  BASEMAP_IMAGERY,
  BASEMAP_STATE,
  IMAGERY_LAYERS,
  basemapDimLayer,
  firstLabelLayerId,
  loadPlanetStyle,
} from './basemap';
import {
  AIRPORT_HALO_LAYER,
  AIRPORT_LABEL_LAYER,
  AIRPORT_RING_LAYER,
  AIRPORT_SOURCE,
  airportFeature,
  airportLayers,
} from './airportLayer';
import { createSatelliteIconCanvases } from './satelliteSprite';
import { setVisibility } from './layerSync';
import { publishMarkerSource, publishZoomSource } from './solarMarkerFeed';
import { prefersReducedMotion } from '../motion';
import {
  PAN_DAMPING,
  SETTLE_IDLE_MS,
  SYSTEM_HOME,
  settleMs,
  settleTarget,
} from '../viewSettle';
import { journeyMs } from '../journey';
import { SHELL_LAYER, SHELL_MAX_ZOOM, createShellLayer, type ShellLayer } from './satelliteShellLayer';
import {
  SOLAR_LAYER,
  SOLAR_MAX_ZOOM,
  createSolarSystemLayer,
  type SolarLayer,
} from './solarSystemLayer';
import {
  MOON_LABEL_LAYER,
  MOON_LAYER,
  MOON_LEADER_SOURCE,
  MOON_SOURCE,
  moonLeaderLayer,
  moonLeaderSource,
  moonSatelliteLayers,
  moonSource,
} from './moonLayer';
import {
  MOON_SHELL_LAYER,
  createMoonShellLayer,
  type MoonShellLayer,
} from './moonShellLayer';
import {
  leaderEnd as moonLeaderEnd,
  leaderFeature as moonLeaderFeature,
} from '../moonLeader';
import {
  drawable as drawableCraft,
  toFeatures as moonFeatures,
  type MoonSatellite,
} from '../moonSatellites';
import { fetchMoonSatellites } from '../api/client';
import {
  SATELLITE_LABEL_LAYER,
  SATELLITE_LAYER,
  SATELLITE_SOURCE,
  satelliteFeatures,
  satelliteLayers,
} from './satelliteLayer';

/**
 * Layers that belong to the aircraft view and are hidden in satellite mode.
 *
 * Airport markers and the receiver-coverage annotation are both statements
 * about *aircraft* tracking. Leaving them up while the user is looking at
 * orbits mixes two subjects with nothing to do with each other (D96). The
 * observed track and its leader go too: a satellite's path is computed rather
 * than watched, so the line drawn for an aircraft would be making a claim
 * about a satellite that nothing here supports.
 */
const AIRCRAFT_FURNITURE = [
  AIRPORT_HALO_LAYER,
  AIRPORT_RING_LAYER,
  AIRPORT_LABEL_LAYER,
  COVERAGE_FILL_LAYER,
  COVERAGE_HATCH_LAYER,
  COVERAGE_LINE_LAYER,
  COVERAGE_LABEL_LAYER,
  ROUTE_LAYER,
  ROUTE_CASING_LAYER,
  ROUTE_GAP_LAYER,
  LEADER_LAYER,
  LEADER_CASING_LAYER,
];
import { createBasemapControl } from './basemapControl';
import {
  COVERAGE_FILL_LAYER,
  COVERAGE_HATCH_IMAGE,
  COVERAGE_HATCH_LAYER,
  COVERAGE_LABEL_LAYER,
  COVERAGE_LABEL_SOURCE,
  COVERAGE_LINE_LAYER,
  COVERAGE_SOURCE,
  coverageFeatures,
  coverageLabelFeatures,
  coverageLayers,
  createHatchImage,
} from './coverageLayer';
import { MODEL_LAYER, createModelLayer, modelTarget } from './modelLayer';
import { createTerminatorControl } from './terminatorControl';
import { createTerminatorLayer } from './terminatorLayer';
import {
  LEADER_CASING_LAYER,
  LEADER_LAYER,
  LEADER_SOURCE,
  ORIGIN_SOURCE,
  ROUTE_CASING_LAYER,
  ROUTE_GAP_LAYER,
  ROUTE_LAYER,
  ROUTE_SOURCE,
  leaderFeature,
  leaderLayers,
  originFeature,
  originLayers,
  routeFeatures,
  routeLayers,
} from './routeLayer';
import { createAircraftIconCanvas, createUnknownIconCanvas } from './aircraftSprite';
import { whenRenderable } from './container';
import { createDiagnosticsPanel } from './diagnostics';
import {
  STALL_AFTER_MS,
  STALL_DETAIL,
  STALL_TITLE,
  classifyFailure,
  type PlanetFailure,
} from './status';
import { boundsToBBox, coversWholeWorld } from './viewport';
import { bodyFor } from '../bodies';
import { MAPLIBRE_MIN_ZOOM } from '../solarScale';
import { easingFor, flightPlan, swapsWorld } from '../bodyFlight';
import type { PlanetId } from '../planets';
import { lonLatOf, scenePlacements } from '../solarFrame';
import { GIBS_ATTRIBUTION, IMAGERY_FAR_MAX_ZOOM } from './basemap';
import {
  IMAGERY_FAR,
  maxZoomFor,
  surfaceTilesFor,
  visibilityFor,
  globeLayerIds,
  BACKGROUND_LAYER,
} from './bodySurface';

/** How often to republish the viewport, matching the globe view's cadence. */
const VIEWPORT_UPDATE_MS = 500;

/**
 * Show the imagery layers only on the map that has imagery in it.
 *
 * Paint expressions already take them to zero opacity on the two vector maps,
 * and that is not enough: **MapLibre fetches the tiles a layer covers whether
 * or not its paint draws them.** So flat and dark mode were pulling a full
 * hemisphere of satellite photography per pan and throwing all of it away,
 * against a browser budget of about six connections per host - the same budget
 * the tiles the user is actually waiting for have to come out of (D112).
 *
 * `visibility` is a layout property and takes no expression, so this cannot be
 * folded into `whenBasemap` with the colours. It is set imperatively wherever
 * the mode is set, which is why both callers go through here.
 */
/**
 * Put a body under the camera.
 *
 * Not a `setStyle`: that would tear down every custom layer and source this
 * view has added, which is the objection D75 raised against doing it for the
 * imagery toggle. The style stays; the tiles and the visibilities change
 * (D120).
 */
/**
 * Poll the lunar spacecraft while the Moon is the world below.
 *
 * Thirty seconds, against a backend that answers from a six-hour window held
 * in memory - so this costs one local request and no upstream call at all. The
 * positions move about half a degree of ground track a minute, which at the
 * zoom a lunar map is read at is a fraction of the marker.
 *
 * A failure leaves the last positions on the map rather than clearing them: an
 * empty Moon and an unreachable backend look identical, and of the two the
 * last known position is the more useful lie to avoid telling (D134).
 */
/** A scene direction as a MapLibre centre. `solarFrame` owns the conversion. */
function lonLatCenter(at: readonly [number, number, number]): [number, number] {
  const { lon, lat } = lonLatOf(at as [number, number, number]);
  return [lon, lat];
}

/**
 * The zoom at which the globe gives way to the solar system (D139).
 *
 * The same point the solar layer reaches full opacity, so one picture fades out
 * exactly as the other finishes fading in.
 */
const SOLAR_HANDOVER_ZOOM = SOLAR_MAX_ZOOM;

/**
 * Switch between standing on a world and looking at the system it belongs to.
 *
 * MapLibre draws the world under the camera at radius 1 whatever the zoom, so
 * pulling back does not shrink it: at the point where the solar system appears,
 * the Earth is still a full globe sitting beside a Sun drawn at 1.08 radii, and
 * it looks the same size as it. Phone reported exactly that.
 *
 * The globe cannot be resized, so it is switched off instead, and the solar
 * layer draws the same body properly scaled among its neighbours. `applyBody`
 * does the restoring, because it already knows what each world should show.
 */
function applySolarView(map: import('maplibre-gl').Map, inSolarView: boolean): void {
  const style = map.getStyle();
  if (!style) return;
  if (!inSolarView) {
    applyBody(map, useOrbitalStore.getState().activeBody);
    // Restored here rather than by `applyBody`, which decides visibility from
    // the cartography and Orbital's own layers and has never had an opinion
    // about the background (D143).
    if (map.getLayer(BACKGROUND_LAYER)) {
      map.setLayoutProperty(BACKGROUND_LAYER, 'visibility', 'visible');
    }
    return;
  }
  for (const id of globeLayerIds(style as never, [SHELL_LAYER, MODEL_LAYER, MOON_SHELL_LAYER])) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
}

/**
 * Put the globe's layers in whatever state the current zoom calls for.
 *
 * **Idempotent, and called from everywhere that could disturb it**: the zoom
 * handler, startup, and after every `applyBody`. It has to be, because
 * `applyBody` decides visibility from the *body* alone and knows nothing about
 * the handover - so a body change, or the one `applyBody` does at startup,
 * silently switched the globe back on underneath a solar view that had already
 * hidden it. Reading the zoom here rather than tracking a flag means the two
 * cannot disagree (D141).
 */
function syncGlobeVisibility(map: import('maplibre-gl').Map): void {
  applySolarView(map, map.getZoom() <= SOLAR_HANDOVER_ZOOM);
}

/**
 * The body the solar system is drawn around, which is never a moon.
 *
 * The Moon rides with Earth here - 0.0026 AU apart, below anything this
 * compression can show - and it has no orbital elements of its own, so
 * anything asking `planets.ts` a question must ask it about Earth instead.
 * One place, because asking it in two and getting it right in one is exactly
 * what happened (D140).
 */
function solarOrigin(): PlanetId {
  const body = useOrbitalStore.getState().activeBody;
  return (body === 'moon' ? 'earth' : body) as PlanetId;
}

/** Close enough to see the spacecraft apart from its own shadow. */
const MOON_CLOSE_ZOOM = 2.2;
/** Long enough to read as travel, short enough not to be a wait. */
const MOON_EASE_MS = 900;

/**
 * Keep the callout line pinned to the selected spacecraft.
 *
 * Recomputed on every camera move, because the line is 45 degrees **on screen**
 * and the only way to stay that way while the globe turns is to redo the screen
 * arithmetic each time. `moonLeader.ts` owns the geometry (D136).
 */
function drawMoonLeader(
  map: import('maplibre-gl').Map,
  craft: MoonSatellite | undefined,
): void {
  const source = map.getSource(MOON_LEADER_SOURCE);
  if (!source || !('setData' in source)) return;
  // Called on the source, not pulled off it: `setData` is a method and loses
  // its binding the moment it is held in a variable.
  const target = source as { setData: (data: unknown) => void };
  if (!craft) {
    target.setData(moonLeaderFeature(null, null));
    useOrbitalStore.getState().setMoonPanelAt(null);
    return;
  }
  const from = map.project([craft.lon, craft.lat]);
  const to = moonLeaderEnd({ x: from.x, y: from.y });
  const end = map.unproject([to.x, to.y]);
  target.setData(moonLeaderFeature([craft.lon, craft.lat], [end.lng, end.lat]));
  // The panel hangs off the far end of the line, so the two are one object
  // rather than a line and a distant box that happen to be about the same
  // spacecraft (D137).
  useOrbitalStore.getState().setMoonPanelAt({ x: to.x, y: to.y });
}

function startMoonPoll(
  map: import('maplibre-gl').Map,
  onCraft: (craft: MoonSatellite[]) => void,
): { stop: () => void } {
  let stopped = false;
  const controller = new AbortController();

  const draw = async () => {
    try {
      const snapshot = await fetchMoonSatellites(controller.signal);
      if (stopped) return;
      const features = moonFeatures(snapshot.objects ?? []);
      const source = map.getSource(MOON_SOURCE);
      if (source && 'setData' in source) {
        (source as { setData: (data: unknown) => void }).setData(features);
      }
      // What the status bar counts and the panel reads: the craft actually
      // drawable, not the ones that exist. A craft whose ephemeris window has
      // run out is absent from both, rather than frozen in either.
      const craft = drawableCraft(snapshot.objects ?? []);
      useOrbitalStore.getState().setMoonCraft(craft);
      onCraft(craft);
    } catch {
      // Keep what is drawn. See the note above.
    }
  };

  void draw();
  const timer = window.setInterval(draw, 30_000);
  return {
    stop: () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
    },
  };
}

function applyBody(map: import('maplibre-gl').Map, bodyId: string): void {
  const body = bodyFor(bodyId as never);
  const style = map.getStyle();
  if (!style) return;

  // **The source is replaced, not re-pointed.** `setTiles` swaps the URLs and
  // leaves the source's `attribution` behind, so Mars was being served under
  // "Imagery NASA EOSDIS GIBS" - crediting the wrong mission for somebody
  // else's data, which is a licence fault rather than a cosmetic one. MapLibre
  // reads attribution when a source is added, so changing it means removing
  // the layer, removing the source, and putting both back (D120).
  const tiles = surfaceTilesFor(body);
  const wanted = tiles
    ? { tiles: [tiles], attribution: body.surface!.attribution, maxzoom: body.surface!.maxZoom }
    : { tiles: [config.imageryTileUrl], attribution: GIBS_ATTRIBUTION, maxzoom: IMAGERY_FAR_MAX_ZOOM };

  const existing = map.getStyle()?.sources?.[IMAGERY_FAR] as { attribution?: string } | undefined;
  if (existing?.attribution !== wanted.attribution) {
    const layer = map.getStyle()?.layers?.find((l) => l.id === IMAGERY_FAR);
    // Put it back where it was: under the cartography, over the ground fill.
    const all = map.getStyle()?.layers ?? [];
    const below = all[all.findIndex((x) => x.id === IMAGERY_FAR) + 1]?.id;
    if (layer) map.removeLayer(IMAGERY_FAR);
    if (map.getSource(IMAGERY_FAR)) map.removeSource(IMAGERY_FAR);
    map.addSource(IMAGERY_FAR, {
      type: 'raster',
      tiles: wanted.tiles,
      tileSize: 256,
      maxzoom: wanted.maxzoom,
      attribution: wanted.attribution,
    });
    if (layer) map.addLayer(layer as never, below);
  }

  // Custom layers are **absent from `getStyle()`**, so they have to be named
  // here or the rule cannot see them - which is how two thousand Earth
  // satellites ended up in orbit around Mars (D133).
  for (const [id, visibility] of Object.entries(
    visibilityFor(body, style as never, [SHELL_LAYER, MODEL_LAYER, SOLAR_LAYER]),
  )) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }

  // Past a mosaic's own maximum zoom MapLibre overzooms, which on Mercury's
  // five levels means a blurred rectangle shown with the confidence of a sharp
  // one. The floor stays where it is - that is the globe's, not the body's.
  map.setMaxZoom(maxZoomFor(body));
  map.triggerRepaint();
}

function setImageryVisible(map: import('maplibre-gl').Map, mode: string): void {
  const visibility = mode === BASEMAP_IMAGERY ? 'visible' : 'none';
  for (const id of IMAGERY_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
  }
}

export function PlanetView() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Three pieces of state, and only these three, because the map itself is
  // imperative and stays out of React (D3). `attempt` exists to let Retry
  // re-run the effect: incrementing it tears the old map down through the
  // normal cleanup path rather than adding a second way to dispose of one.
  const [failure, setFailure] = useState<PlanetFailure | null>(null);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setFailure(null);
    setStalled(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let map: import('maplibre-gl').Map | null = null;
    let unsubscribe: (() => void) | null = null;
    let diagnostics: ReturnType<typeof createDiagnosticsPanel> | null = null;
    let model: ReturnType<typeof createModelLayer> | null = null;
    let shell: ShellLayer | null = null;
    let solar: SolarLayer | null = null;
    let terminator: ReturnType<typeof createTerminatorLayer> | null = null;
    let moonPoll: { stop: () => void } | null = null;
    let moonShell: MoonShellLayer | null = null;
    // Redrawn as the camera moves, because the callout is 45 degrees on screen.
    const refreshLeader = () => {
      if (!map) return;
      const state = useOrbitalStore.getState();
      drawMoonLeader(map, state.moonCraft.find((c) => c.id === state.selectedMoonId));
    };
    let cleanUpResize: (() => void) | null = null;
    let frame = 0;
    let stallTimer = 0;

    void (async () => {
      try {
        // Dynamic, so the 800 KB of MapLibre is fetched by the view that uses
        // it rather than by the bundle every visitor loads.
        await import('maplibre-gl/dist/maplibre-gl.css');
        const maplibre = await import('maplibre-gl');
        const style = await loadPlanetStyle();
        if (disposed) return;

        // Wait for the container to have a box before handing it over. MapLibre
        // measures it once, at construction, and a zero measurement leaves it on
        // a 400x300 canvas that does not recover when the layout settles: the
        // container ends up full size with a tiny canvas inside it, and no
        // vector tile is ever requested for a viewport that small (D62).
        await whenRenderable(container);
        if (disposed) return;

        map = new maplibre.Map({
          container,
          style,
          center: [100.5, 13.75],
          zoom: 2,
          // **Below zero on purpose.** The default floor is 0, where the globe
          // fills the frame - and an orbital shell standing 1.35 radii off the
          // surface needs the planet to shrink so there is room around it
          // (D105). Phone established that MapLibre permits this by dragging a
          // zoom slider to -2, which is where the globe becomes a speck; -1.6
          // is enough to hold the whole constellation with the planet still
          // recognisable.
          // MapLibre's own floor, not a taste. It refuses anything lower, and
          // the difference is not cosmetic: a ring at 18 globe radii shows 52%
          // of its near side at -2 and 30% at -1.6, so the outer solar system
          // is either in frame or it is not (D123).
          minZoom: MAPLIBRE_MIN_ZOOM,
          attributionControl: { compact: true },
        });

        // A map that never finishes loading looks exactly like one that failed,
        // and it is not the same thing: it may still arrive. So it gets its own
        // notice on a clock rather than a failure, and the clock is cleared by
        // `load` below.
        stallTimer = window.setTimeout(() => {
          if (!disposed) setStalled(true);
        }, STALL_AFTER_MS);

        // Dev-only, and it earns its place: the map is looked at on one machine
        // and debugged on another, and a screenshot shows what is drawn while
        // saying nothing about why. This puts the why on screen (D57).
        //
        // Appended *after* construction: MapLibre expects the container it is
        // given to be its own, and handing it one that already has children is
        // a difference from every working configuration tested (D62).
        if (import.meta.env.DEV) {
          diagnostics = createDiagnosticsPanel();
          container.appendChild(diagnostics.element);
        }

        // And keep it sized: the first measurement is not a promise about the
        // rest of the session.
        const resizeObserver = new ResizeObserver(() => map?.resize());
        resizeObserver.observe(container);
        cleanUpResize = () => resizeObserver.disconnect();

        diagnostics?.attach(
          map,
          () => model?.describe() ?? 'layer not added',
          () => terminator?.describe() ?? 'layer not added',
        );

        map.on('load', () => {
          if (!map) return;
          window.clearTimeout(stallTimer);
          setStalled(false);

          // Which of the two looks the style's expressions resolve to. Set
          // before anything else is added, so the first frame is already the
          // right map rather than the imagery flashing up and being switched.
          map.setGlobalStateProperty(BASEMAP_STATE, config.basemap);
          setImageryVisible(map, config.basemap);

          // A handle for the console, in development only.
          //
          // Every rendering defect in this project has been diagnosed by
          // looking at the running map, and until now that meant reasoning
          // about a style nobody could interrogate - `queryRenderedFeatures`
          // and `getLayer` were unreachable from outside. Stripped from the
          // production bundle by the constant folding on `import.meta.env.DEV`.
          if (import.meta.env.DEV) {
            (window as unknown as { __orbitalMap?: unknown }).__orbitalMap = map;
          }

          // SDF, so one silhouette can be tinted per aircraft by altitude rather
          // than baking an image per colour (D28).
          for (const [id, canvas] of [
            [ICON_AIRCRAFT, createAircraftIconCanvas()],
            [ICON_UNKNOWN, createUnknownIconCanvas()],
            // One silhouette per spacecraft family, SDF like the aircraft so
            // each is tinted by its orbit regime rather than baked per colour
            // (D101).
            ...createSatelliteIconCanvases(),
          ] as Array<readonly [string, HTMLCanvasElement]>) {
            const context = canvas.getContext('2d');
            if (!context || map.hasImage(id)) continue;
            map.addImage(id, context.getImageData(0, 0, canvas.width, canvas.height), {
              sdf: true,
            });
          }

          // Night goes in **below the first label**, and above everything
          // else. The ground is what the sun is or is not shining on; the
          // labels are annotation drawn on top of the world rather than part
          // of it, and dimming them leaves the night side unreadable while the
          // day side stays crisp (D74). The aircraft, their tracks and their
          // callsigns come later still, because they are the reason the view
          // is open.
          terminator = createTerminatorLayer({
            enabled: config.terminator,
            lightsUrl: config.textures.night,
            strength: config.terminatorStrength,
          });
          map.addLayer(terminator, firstLabelLayerId(map.getStyle()) ?? undefined);

          // Photograph, plain map or dark map. Above the night toggle in the
          // corner because it changes more of the screen than night does.
          const basemapControl = createBasemapControl((mode) => {
            if (!map) return;
            map.setGlobalStateProperty(BASEMAP_STATE, mode);
            setImageryVisible(map, mode);
            map.triggerRepaint();
          }, config.basemap);
          map.addControl(basemapControl, 'top-right');

          const control = createTerminatorControl((enabled) => {
            terminator?.setEnabled(enabled);
            // A custom layer only draws when MapLibre repaints, and switching a
            // uniform is not a reason it knows about.
            map?.triggerRepaint();
          }, config.terminator);
          // Top right. Bottom left was tried first and was wrong: the legend
          // occupies that corner and the status bar is painted over what is left
          // of it, so the button was in the DOM, invisible, and not clickable -
          // `elementFromPoint` returned the status bar. The dev readout moves
          // down to make room, because it is the thing that can afford to.
          map.addControl(control, 'top-right');

          // The route goes in first, so the aircraft symbols draw over their own
          // track rather than under it.
          //
          // Seeded from the store rather than empty, because the subscription
          // below only fires on *change*: an aircraft selected while the map was
          // still loading has already had its one detail fetch, and its track
          // would never be drawn at all.
          map.addSource(ROUTE_SOURCE, {
            type: 'geojson',
            data: routeFeatures(useOrbitalStore.getState().selectedDetail?.track),
          });
          for (const layer of routeLayers()) map.addLayer(layer);

          // And the dashed segment that keeps the track attached to the
          // aircraft. Its own source because it is rewritten every frame while
          // the track behind it is rewritten once per poll (D72).
          map.addSource(LEADER_SOURCE, { type: 'geojson', data: leaderFeature(null, null) });
          for (const layer of leaderLayers()) map.addLayer(layer);

          // The departure airport, seeded from the store for the same reason
          // the route is: the subscription below only fires on change (D65).
          map.addSource(ORIGIN_SOURCE, {
            type: 'geojson',
            data: originFeature(useOrbitalStore.getState().selectedDetail?.origin),
          });
          for (const layer of originLayers()) map.addLayer(layer);

          // Dims the flat basemap, and nothing above it. Added here rather
          // than in the style so its position is the thing that defines it:
          // everything before this line recedes, everything after stays at
          // full strength.
          if (config.flatBasemapDim > 0) map.addLayer(basemapDimLayer(config.flatBasemapDim));

          // Where the receiver networks do not reach, so an empty region reads
          // as unheard rather than as broken.
          //
          // **After the dim, not before.** The dim is for the basemap; this is
          // an annotation about the basemap and has to stay legible over the
          // dimmed version of it. Still below the aircraft, which nothing may
          // compete with.
          const hatch = createHatchImage();
          if (hatch && !map.hasImage(COVERAGE_HATCH_IMAGE)) {
            // Not SDF: this one is drawn in its own colour rather than tinted.
            map.addImage(COVERAGE_HATCH_IMAGE, hatch);
          }
          map.addSource(COVERAGE_SOURCE, { type: 'geojson', data: coverageFeatures() });
          map.addSource(COVERAGE_LABEL_SOURCE, {
            type: 'geojson',
            data: coverageLabelFeatures(),
          });
          for (const layer of coverageLayers()) map.addLayer(layer);

          // The airport a search flew to, above the coverage annotation and
          // below the aircraft: it is the answer to a question the user just
          // asked, so nothing on the ground may hide it and no aircraft may be
          // hidden by it.
          map.addSource(AIRPORT_SOURCE, {
            type: 'geojson',
            data: airportFeature(useOrbitalStore.getState().focusedAirport),
          });
          for (const layer of airportLayers()) map.addLayer(layer);

          map.addSource(AIRCRAFT_SOURCE, {
            type: 'geojson',
            data: aircraftFeatures([], Date.now()),
          });
          for (const layer of aircraftLayers()) map.addLayer(layer);

          // Satellites, drawn as their sub-satellite point. A map has no room
          // above it, so this shows *where* rather than *how high* - the globe
          // is where altitude is available (D96, D97).
          map.addSource(SATELLITE_SOURCE, {
            type: 'geojson',
            data: satelliteFeatures([]),
          });
          for (const layer of satelliteLayers()) map.addLayer(layer);

          // The three spacecraft in orbit around the Moon. Added here with
          // everything else rather than on arrival, because adding layers
          // during a body swap is what D120 went to some trouble to avoid;
          // they simply stay hidden until the Moon is the world below (D134).
          map.addSource(MOON_SOURCE, moonSource());
          map.addSource(MOON_LEADER_SOURCE, moonLeaderSource());
          map.addLayer(moonLeaderLayer());
          for (const layer of moonSatelliteLayers()) map.addLayer(layer);
          // Drawn at their real altitude, which on the Moon needs no
          // compression at all - everything up there is below 1.13 radii
          // (D136). Added after the flat markers so the tethers sit over them.
          moonShell = createMoonShellLayer();
          map.addLayer(moonShell);
          map.on('move', refreshLeader);

          // The globe hands over to the solar system as the camera pulls back.
          let inSolarView = map.getZoom() <= SOLAR_HANDOVER_ZOOM;
          map.on('zoom', () => {
            if (!map) return;
            const next = map.getZoom() <= SOLAR_HANDOVER_ZOOM;
            if (next === inSolarView) return;
            inSolarView = next;
            applySolarView(map, next);
          });
          // Once at startup: the map may already be zoomed out, and `applyBody`
          // has just run without any knowledge of the handover.
          syncGlobeVisibility(map);

          /*
           * **The planet view and the solar system are two states, and the band
           * between them is not a place to be left** (D158).
           *
           * Measured on a 1990-pixel viewport: at the handover the globe is 80
           * pixels wide, and 85 just above it - four per cent of the screen -
           * while just below it the solar system is still mostly transparent.
           * Either way the reader gets an almost empty screen, which is how it
           * was reported: "all gone black".
           *
           * So a move that comes to rest in that band is finished for them, in
           * the direction they were already going. `viewSettle.ts` holds the
           * rule; this only carries it out.
           *
           * **On `moveend`, never during the move.** Snapping while a wheel is
           * still turning or two fingers are still moving fights the gesture,
           * and an interface that pulls against an input in progress feels
           * broken in a way that is hard to name. Passing through the band
           * still looks exactly as it did.
           */
          /*
           * **Dragging the solar system around** (D159).
           *
           * MapLibre's own drag-pan works by grabbing the point of the globe
           * under the cursor and moving it. In the solar view there is no globe
           * under the cursor - it is 57 pixels wide at this zoom and the rest of
           * the screen is sky - so a drag anywhere but on that speck does
           * nothing at all. Measured: a 220-pixel drag left the centre and every
           * label exactly where they were.
           *
           * So the drag is handled here while the system is drawing, as a camera
           * move rather than a grab. `panBy` is the right tool and `setCenter`
           * is not: at this zoom setting a centre makes MapLibre re-constrain
           * the camera and it takes the *zoom* with it - measured jumping from
           * -1.5 to -0.03, which drops out of the solar view entirely.
           */
          let dragFrom: { x: number; y: number } | null = null;
          const canvas = map.getCanvas();
          const draggingSystem = () => (map ? map.getZoom() <= SOLAR_HANDOVER_ZOOM : false);
          canvas.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!draggingSystem() || event.button !== 0) return;
            dragFrom = { x: event.clientX, y: event.clientY };
            canvas.setPointerCapture(event.pointerId);
          });
          canvas.addEventListener('pointermove', (event: PointerEvent) => {
            if (!dragFrom || !map) return;
            const dx = event.clientX - dragFrom.x;
            const dy = event.clientY - dragFrom.y;
            dragFrom = { x: event.clientX, y: event.clientY };
            // Opposite to the pointer, so the sky follows the hand rather than
            // running away from it, and damped hard.
            //
            // **This is a turn, not a slide, and no single factor can make it
            // one.** MapLibre's camera always looks at the centre of the world
            // it is standing on, so panning rotates the viewpoint rather than
            // translating it - and measured at z-1.5, 100 pixels of pan moved
            // Mercury 375 pixels, Jupiter 432, Neptune **-435** the other way,
            // and the Earth underfoot not at all. Bodies in different directions
            // sweep differently because that is what turning your head does.
            //
            // So the damping is chosen to put the *fastest* body near the
            // pointer's own speed rather than to make them agree, which they
            // cannot. Undamped, the outer planets crossed the screen four times
            // faster than the hand.
            map.panBy([-dx * PAN_DAMPING, -dy * PAN_DAMPING], { duration: 0 });
          });
          const endDrag = (event: PointerEvent) => {
            if (!dragFrom) return;
            dragFrom = null;
            if (canvas.hasPointerCapture(event.pointerId)) {
              canvas.releasePointerCapture(event.pointerId);
            }
          };
          canvas.addEventListener('pointerup', endDrag);
          canvas.addEventListener('pointercancel', endDrag);

          let restingZoom = map.getZoom();
          let idleTimer = 0;
          const settleIfIdle = () => {
            if (!map) return;
            // Not while a trip between worlds is running: it crosses this band
            // deliberately, twice, and has its own plan for where to stop
            // (D126). A settle here would fight it mid-flight.
            if (useOrbitalStore.getState().flyingTo) return;
            const zoom = map.getZoom();
            const target = settleTarget(zoom, restingZoom);
            // **Where the camera actually is, never where it was sent.**
            // Recording the target here instead is a lie whenever the settle is
            // interrupted - a wheel notch arriving mid-animation leaves the
            // camera short of it, and the next evaluation then measures the
            // direction against a zoom the camera never reached and reads it
            // backwards. Measured: scrolling inward from the solar system was
            // pulled straight back out to it, which is the stuck view reported.
            //
            // It is the D154 lesson again, in a third place: a record of what
            // was asked for is not a record of what is true.
            restingZoom = zoom;
            if (target === null) return;
            // **The two views are two pages, and this is the page turn** (D161).
            // The screen goes up first so the camera move happens behind it,
            // which is what makes it a transition rather than a glide.
            const store = useOrbitalStore.getState();
            store.setJourney(target === SYSTEM_HOME ? 'system' : 'planet');
            window.setTimeout(
              () => useOrbitalStore.getState().setJourney(null),
              journeyMs(prefersReducedMotion()),
            );
            map.easeTo({
              zoom: target,
              duration: settleMs(prefersReducedMotion()),
              easing: (t: number) => 1 - (1 - t) * (1 - t),
            });
          };
          map.on('move', () => {
            window.clearTimeout(idleTimer);
            idleTimer = window.setTimeout(settleIfIdle, SETTLE_IDLE_MS);
          });

          // The selected aircraft, as a mesh in MapLibre's own context (D67).
          // It reads the store itself, once per frame, rather than being told:
          // the aircraft is moving between polls and the symbol it replaces is
          // redrawn on the same schedule, so anything slower would leave the
          // model lagging behind the callsign attached to it.
          // Satellites at height, standing off the planet (D105). A custom
          // layer, because MapLibre's symbols have no z - the same mechanism
          // the aircraft model uses, with a much larger lift.
          shell = createShellLayer(() => {
            const state = useOrbitalStore.getState();
            return state.activeLayer.id === 'satellite'
              ? { objects: Array.from(state.objects.values()), selectedId: state.selectedId }
              : { objects: [], selectedId: null };
          });
          map.addLayer(shell);

          // The rest of the solar system, outside the satellite shell. Same
          // mechanism, larger radius, no second renderer (D123, D125).
          solar = createSolarSystemLayer(
            () => {
              const instant = useOrbitalStore.getState().viewInstant;
              return instant ? new Date(instant) : new Date();
            },
            () => useOrbitalStore.getState().flyingTo,
            solarOrigin,
            // The *actual* world underfoot, which the origin above flattens to
            // Earth for the Moon. Sizes are anchored on this one, because it is
            // the globe MapLibre draws at radius 1 (D137).
            () => useOrbitalStore.getState().activeBody,
          );
          map.addLayer(solar);
          // The chrome reads the drawn positions from here (D159).
          publishMarkerSource(() => solar?.markers() ?? []);
          publishZoomSource(() => map?.getZoom() ?? 99);


          model = createModelLayer(() => {
            const state = useOrbitalStore.getState();
            return state.selectedId ? modelTarget(state.objects.get(state.selectedId)) : null;
          });
          map.addLayer(model);

          // Clicking an aircraft selects it, which is all the globe's pointer
          // module did once its pick tolerance stopped being the hard part
          // (D34): MapLibre hit-tests its own symbols, at their drawn size.
          //
          // **One handler, deliberately.** This was two - a layer-scoped one
          // that selected and a general one that deselected when it found
          // nothing - and they agreed only because both queries happened to
          // answer identically. Nothing enforced that, and the failure mode was
          // a select immediately undone by a deselect in the same click. One
          // query, one decision, no ordering to get right (D69).
          map.on('click', (event) => {
            if (!map) return;
            // The Moon first, and **inside this handler rather than beside
            // it**. A second click handler scoped to the lunar layers is the
            // obvious way to write this and is exactly the defect D69 removed:
            // two queries that agree only by coincidence, with a select undone
            // by a deselect in the same click. One query, one decision (D135).
            if (useOrbitalStore.getState().activeBody === 'moon') {
              const hit = hitsAt(map, event.point, [MOON_LAYER, MOON_LABEL_LAYER])[0];
              useOrbitalStore
                .getState()
                .selectMoonCraft((hit?.properties?.id as string) ?? null);
              return;
            }
            // The shell is a custom layer, so MapLibre does not hit-test it.
            // Ask it first: when it is drawing, it *is* the satellite view.
            if (map && shell && shell.drawnCount() > 0) {
              const hit = shell.pick(event.point.x, event.point.y);
              if (hit) {
                useOrbitalStore.getState().select(hit);
                return;
              }
            }
            const active = useOrbitalStore.getState().activeLayer.id;
            // One handler for both modes, querying only the layer that is
            // actually drawn. Two handlers could disagree about what was
            // clicked, which is the defect D69 removed.
            const layers =
              active === 'satellite'
                ? [SATELLITE_LAYER, SATELLITE_LABEL_LAYER]
                : undefined;
            useOrbitalStore
              .getState()
              .select(selectionFromHits(hitsAt(map, event.point, layers)));
          });
          for (const layer of [AIRCRAFT_LAYER, AIRCRAFT_LABEL_LAYER, MOON_LAYER, MOON_LABEL_LAYER]) {
            map.on('mouseenter', layer, () => {
              if (map) map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', layer, () => {
              if (map) map.getCanvas().style.cursor = '';
            });
          }

          // Positions are interpolated between polls, so the source is rewritten
          // on a frame loop rather than only when a poll lands -- the same
          // reason the globe rebuilt its marker buffers every frame.
          // **No memo of what was last set here, deliberately.** There used to
          // be two, and they caused the defect D154 fixes: `applyBody` turns
          // every Earth layer back on when the camera returns from the solar
          // system, and a memo of what *this* loop last asked for cannot see
          // that, so it reported no change and left the satellite ground
          // symbols up underneath a shell that was still drawing - the same
          // objects twice, on the surface and in orbit. `setVisibility` reads
          // the style instead, so a write by anybody else is noticed on the
          // next frame rather than never.

          const tick = () => {
            frame = requestAnimationFrame(tick);
            const source = map?.getSource(AIRCRAFT_SOURCE);
            if (!source || !('setData' in source)) return;
            const state = useOrbitalStore.getState();
            const satelliteMode = state.activeLayer.id === 'satellite';
            const objects = Array.from(state.objects.values());

            // Only the active layer is fed. The other is emptied rather than
            // left holding its last frame: a stale aircraft under a satellite
            // view is a claim that the aircraft is still there.
            (source as { setData: (data: unknown) => void }).setData(
              aircraftFeatures(satelliteMode ? [] : objects, Date.now(), state.selectedId),
            );
            const satelliteSource = map?.getSource(SATELLITE_SOURCE);
            if (satelliteSource && 'setData' in satelliteSource) {
              (satelliteSource as { setData: (data: unknown) => void }).setData(
                satelliteFeatures(satelliteMode ? objects : [], state.selectedId),
              );
            }

            // Satellite mode is a different subject, not the same map with
            // extra dots (D96). Airport markers and the receiver-coverage
            // annotation are both aircraft furniture, and leaving them up
            // while the user is looking at orbits mixes two unrelated things.
            // The 3D spacecraft stands in for the selected satellite's
            // sprite, so the shell leaves that one out (D107). Told each frame
            // rather than on selection, because whether the model is drawing
            // depends on the zoom and the horizon as well as the selection.
            shell?.setHideSelected(satelliteMode && (model?.drewLastFrame() ?? false));

            // The shell and the ground symbols are two drawings of the same
            // objects, so exactly one is on at a time (D105). The shell owns
            // the view while the whole planet is in frame; past that the
            // sub-satellite points do.
            const shellShowing = satelliteMode && (map?.getZoom() ?? 99) <= SHELL_MAX_ZOOM;
            // **Only while the globe is the thing being shown.** Below the
            // handover the solar system owns the view and `applySolarView` has
            // hidden every one of these; a loop that goes on writing `visible`
            // to them there is the D154 fault pointing the other way - two
            // writers disagreeing every frame, and the reason a satellite
            // ground layer was measured switched on inside the solar view.
            //
            // Reading the zoom rather than tracking a flag, so the two cannot
            // disagree about which of them is in charge (D141).
            const globeOwnsTheView = (map?.getZoom() ?? 99) > SOLAR_HANDOVER_ZOOM;
            // **And only on Earth.** Every layer below is a statement about
            // Earth - aircraft furniture, receiver coverage, the satellite
            // ground symbols - and off it they are not stale but meaningless
            // (D120). `applyBody` hides them when the camera leaves, and this
            // loop was turning them straight back on: measured on Mars, all
            // four coverage layers and all three airport layers reported
            // `visible`, which is receiver coverage drawn over a planet that
            // has no receivers.
            //
            // Third time this loop has fought another writer, and the third
            // time the same answer works: read what is true - the zoom, and now
            // the world underfoot - so the two cannot disagree about which of
            // them is in charge (D141, D154).
            const onEarthNow = state.activeBody === 'earth';
            if (map && globeOwnsTheView && onEarthNow) {
              setVisibility(
                map,
                [SATELLITE_LAYER, SATELLITE_LABEL_LAYER],
                shellShowing ? 'none' : 'visible',
              );
              setVisibility(map, AIRCRAFT_FURNITURE, satelliteMode ? 'none' : 'visible');
            }

            // The leader is redrawn on the same frame as the marker it joins,
            // from the same interpolated position, so the two cannot disagree
            // about where the aircraft is - which is the whole defect this
            // fixes (D72).
            const leader = map?.getSource(LEADER_SOURCE);
            if (leader && 'setData' in leader) {
              const selected = state.selectedId ? state.objects.get(state.selectedId) : null;
              (leader as { setData: (data: unknown) => void }).setData(
                leaderFeature(
                  state.selectedDetail?.track,
                  selected ? { lat: selected.renderLat, lon: selected.renderLon } : null,
                ),
              );
            }
          };
          frame = requestAnimationFrame(tick);
        });

        // Telling the backend where the user is looking is what drives the fast
        // tier 2 poll (D21), and it is the map's bounds rather than a camera
        // frustum here -- the same information, already computed.
        let lastViewport = 0;
        const publishViewport = () => {
          if (!map) return;
          lastViewport = performance.now();
          const bounds = map.getBounds();
          // A viewport that is the entire planet is worse than none: it spends a
          // tier 2 credit on the widest box there is, which is what the cost
          // band exists to prevent (D21, D27).
          useOrbitalStore
            .getState()
            .setViewport(coversWholeWorld(bounds) ? null : boundsToBBox(bounds));
        };

        // Throttled while the map is moving, so a drag does not publish a
        // viewport per frame.
        map.on('move', () => {
          if (performance.now() - lastViewport < VIEWPORT_UPDATE_MS) return;
          publishViewport();
        });

        // **And once more when it stops, unthrottled.** Without this the final
        // resting position waits out whatever is left of the throttle before it
        // is published at all, and the refetch debounce then starts from there -
        // so letting go of a drag could cost most of a second before the request
        // was even sent. That is what Phone reported as objects being slow to
        // appear when turning the globe (D110). `moveend` fires once, so it
        // costs one publish rather than a stream of them.
        map.on('moveend', publishViewport);

        unsubscribe = useOrbitalStore.subscribe((state, previous) => {
          // Changing world is rare and changes almost everything, so it is
          // handled first and the rest of this subscriber is skipped: the
          // layers it would touch have just been hidden (D120).
          // A trip was asked for. Pull out, swap at the apex, zoom back in -
          // the swap is hidden there because at zoom -2 the globe is twenty
          // pixels across and there is nothing to see change (D126).
          if (state.flyingTo && state.flyingTo !== previous.flyingTo && map) {
            const destination = state.flyingTo;
            const plan = flightPlan(state.activeBody, destination);
            const runner = map;
            void (async () => {
              try {
              for (const step of plan) {
                if (swapsWorld(step)) {
                  useOrbitalStore.getState().setActiveBody(destination);
                  continue;
                }
                if (step.zoom !== null) {
                  // Where the destination actually is, from the same
                  // placements the scene is drawn from - so the camera turns
                  // toward the real planet rather than toward a nice arc
                  // invented for the animation (D136).
                  // **`solarOrigin`, not `activeBody`.** The Moon is not a
                  // planet and has no elements, so passing it here threw
                  // `ELEMENTS['moon'].a` on the first step - and because the
                  // throw skipped the `setFlyingTo(null)` at the end, the app
                  // was left believing a trip was still in progress and refused
                  // every later one. Leaving the Moon was a one-way door
                  // (D140).
                  const aim = step.aimAtDestination
                    ? scenePlacements(new Date(), solarOrigin()).find(
                        (p) => p.id === destination,
                      )
                    : undefined;
                  runner.easeTo({
                    zoom: step.zoom,
                    duration: step.durationMs,
                    ...(aim ? { center: lonLatCenter(aim.at) } : {}),
                    // Accelerating away and decelerating in, from the plan
                    // rather than from a constant here: one ease-out across
                    // both halves reads as a single continuous zoom, which is
                    // the thing this was asked to stop being (D155).
                    easing: easingFor(step.easing),
                  });
                }
                await new Promise((resolve) => setTimeout(resolve, step.durationMs));
              }
              } finally {
                // **Always.** Whatever goes wrong mid-flight, the app must not
                // be left thinking it is still travelling: that state is what
                // blocks the next trip, so an error here costs the reader the
                // whole picker rather than one animation.
                useOrbitalStore.getState().setFlyingTo(null);
              }
            })();
            return;
          }

          // Selecting a lunar spacecraft is a move, not a jump: the camera
          // travels to it, the callout is drawn, and only then does the panel
          // open - so the reader watches one thing happen rather than three
          // at once (D136).
          if (state.selectedMoonId !== previous.selectedMoonId && map) {
            const runner = map;
            const chosen = state.moonCraft.find((c) => c.id === state.selectedMoonId);
            if (chosen) {
              runner.easeTo({
                center: [chosen.lon, chosen.lat],
                zoom: Math.max(runner.getZoom(), MOON_CLOSE_ZOOM),
                duration: MOON_EASE_MS,
                easing: (t: number) => 1 - (1 - t) ** 3,
              });
            }
            drawMoonLeader(runner, chosen);
          }

          if (state.activeBody !== previous.activeBody && map) {
            applyBody(map, state.activeBody);
            // `applyBody` decides from the body alone; this puts the handover
            // back if the camera is already out in the solar view (D141).
            syncGlobeVisibility(map);
            // Lunar spacecraft are polled only while the Moon is underneath.
            // Three objects and a six-hour window behind them, so a slow
            // cadence is not a compromise - the backend is reading from memory
            // and the positions move about half a degree a minute (D134).
            moonPoll?.stop();
            moonPoll =
              state.activeBody === 'moon'
                ? startMoonPoll(map, (craft) => {
                    moonShell?.setCraft(craft);
                    // The callout has to follow the spacecraft, not just the
                    // camera. These move about half a degree of ground track a
                    // minute, so between polls the line was left pointing at
                    // where the craft had been - 77 px adrift when measured.
                    refreshLeader();
                  })
                : null;
            if (state.activeBody !== 'moon') useOrbitalStore.getState().setMoonCraft([]);
            // The terminator is a custom layer outside the style, so its
            // visibility is not in the plan `applyBody` applies. Night is an
            // Earth fact here - the texture is Earth's city lights.
            terminator?.setEnabled(state.activeBody === 'earth' && config.terminator);
            return;
          }

          // The route is redrawn only when the selected object's detail changes,
          // not every frame: the track only grows once per poll, and rebuilding
          // a densified polyline is the expensive part of this layer (D6).
          if (state.selectedDetail !== previous.selectedDetail && map) {
            const source = map.getSource(ROUTE_SOURCE);
            if (source && 'setData' in source) {
              (source as { setData: (data: unknown) => void }).setData(
                routeFeatures(state.selectedDetail?.track),
              );
            }
          }

          // A search hit flies the camera, as it does on the globe.
          if (state.focusedAirport !== previous.focusedAirport && map) {
            const source = map.getSource(AIRPORT_SOURCE);
            if (source && 'setData' in source) {
              (source as { setData: (data: unknown) => void }).setData(
                airportFeature(state.focusedAirport),
              );
            }
          }

          if (state.flyTo !== previous.flyTo && state.flyTo && map) {
            // An aircraft keeps the old z9: it is a moving thing and its
            // surroundings are not the point. An airport is a place, and the
            // request carries a closer zoom so the runways are visible - the
            // whole complaint about searching one was arriving somewhere
            // indistinguishable from anywhere else.
            map.flyTo({
              center: [state.flyTo.lon, state.flyTo.lat],
              zoom: state.flyTo.zoom ?? 9,
              duration: 1600,
            });
          }
        });

        if (import.meta.env.DEV) {
          (window as unknown as Record<string, unknown>).__orbitalPlanet = {
            map,
            maplibre,
            // The store, so a session driving this view from the console can see
            // what the frame loop sees rather than inferring it from pixels.
            store: useOrbitalStore,
            // The glint's tuning loop, applied to the other lighting constant
            // that is taste rather than arithmetic (D49): look, adjust, look.
            terminator: (enabled: boolean) => {
              terminator?.setEnabled(enabled);
              map?.triggerRepaint();
            },
          };
        }
      } catch (error) {
        // Every way this can fail used to produce the same thing: a black
        // rectangle and no explanation (defect #20). The reader gets a
        // sentence naming which of them happened, and a way to try again.
        if (disposed) return;
        // eslint-disable-next-line no-console
        console.error('[planet] the map failed to start', error);
        setFailure(classifyFailure(error));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe?.();
      cleanUpResize?.();
      window.clearTimeout(stallTimer);
      diagnostics?.dispose();
      model?.dispose();
      shell?.dispose();
      terminator?.dispose();
      map?.remove();
    };
  }, [attempt]);

  return (
    <div className="planet-view">
      {/*
        The map gets a container of its own with nothing else in it. MapLibre
        expects the element it is handed to be its own, and the one time this
        view put something inside it before construction it cost a session
        (D62) - so the notices are siblings of the map, not children.
      */}
      <div ref={containerRef} className="planet-map" />

      {failure && (
        <div className="planet-notice" role="alert">
          <h2>{failure.title}</h2>
          <p>{failure.detail}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
          {/* The thrown text, small and last: useful in a bug report, and not
              the first thing a reader has to get past. */}
          <p className="planet-notice-cause">{failure.cause}</p>
        </div>
      )}

      {stalled && !failure && (
        <div className="planet-notice planet-notice-stalled" role="status">
          <h2>{STALL_TITLE}</h2>
          <p>{STALL_DETAIL}</p>
          <button type="button" onClick={retry}>
            Reload the map
          </button>
        </div>
      )}
    </div>
  );
}
