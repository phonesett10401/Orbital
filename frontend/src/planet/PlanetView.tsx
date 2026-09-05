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
import { SHELL_MAX_ZOOM, createShellLayer, type ShellLayer } from './satelliteShellLayer';
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
import { createModelLayer, modelTarget } from './modelLayer';
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
import { GIBS_ATTRIBUTION, IMAGERY_FAR_MAX_ZOOM } from './basemap';
import {
  IMAGERY_FAR,
  maxZoomFor,
  surfaceTilesFor,
  visibilityFor,
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

  for (const [id, visibility] of Object.entries(
    visibilityFor(body, style as never),
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
    let terminator: ReturnType<typeof createTerminatorLayer> | null = null;
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
          for (const layer of [AIRCRAFT_LAYER, AIRCRAFT_LABEL_LAYER]) {
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
          // Tracks the last mode the layers were switched to, so visibility is
          // set on the transition rather than on every frame.
          let lastSatelliteMode: boolean | null = null;
          let lastShellShowing: boolean | null = null;

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
            if (shellShowing !== lastShellShowing) {
              lastShellShowing = shellShowing;
              for (const layer of [SATELLITE_LAYER, SATELLITE_LABEL_LAYER]) {
                if (map?.getLayer(layer)) {
                  map.setLayoutProperty(layer, 'visibility', shellShowing ? 'none' : 'visible');
                }
              }
            }

            if (satelliteMode !== lastSatelliteMode) {
              lastSatelliteMode = satelliteMode;
              for (const layer of AIRCRAFT_FURNITURE) {
                if (map?.getLayer(layer)) {
                  map.setLayoutProperty(layer, 'visibility', satelliteMode ? 'none' : 'visible');
                }
              }
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
          if (state.activeBody !== previous.activeBody && map) {
            applyBody(map, state.activeBody);
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
