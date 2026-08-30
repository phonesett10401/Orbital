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
import { firstLabelLayerId, loadPlanetStyle } from './basemap';
import { createModelLayer, modelTarget } from './modelLayer';
import { createTerminatorControl } from './terminatorControl';
import { createTerminatorLayer } from './terminatorLayer';
import {
  LEADER_SOURCE,
  ROUTE_SOURCE,
  leaderFeature,
  leaderLayers,
  routeFeatures,
  routeLayers,
} from './routeLayer';
import { createAircraftIconCanvas, createUnknownIconCanvas } from '../globe/aircraftSprite';
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

/** How often to republish the viewport, matching the globe view's cadence. */
const VIEWPORT_UPDATE_MS = 500;

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

          // SDF, so one silhouette can be tinted per aircraft by altitude rather
          // than baking an image per colour (D28).
          for (const [id, canvas] of [
            [ICON_AIRCRAFT, createAircraftIconCanvas()],
            [ICON_UNKNOWN, createUnknownIconCanvas()],
          ] as const) {
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

          map.addSource(AIRCRAFT_SOURCE, {
            type: 'geojson',
            data: aircraftFeatures([], Date.now()),
          });
          for (const layer of aircraftLayers()) map.addLayer(layer);

          // The selected aircraft, as a mesh in MapLibre's own context (D67).
          // It reads the store itself, once per frame, rather than being told:
          // the aircraft is moving between polls and the symbol it replaces is
          // redrawn on the same schedule, so anything slower would leave the
          // model lagging behind the callsign attached to it.
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
            useOrbitalStore.getState().select(selectionFromHits(hitsAt(map, event.point)));
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
          const tick = () => {
            frame = requestAnimationFrame(tick);
            const source = map?.getSource(AIRCRAFT_SOURCE);
            if (!source || !('setData' in source)) return;
            const state = useOrbitalStore.getState();
            (source as { setData: (data: unknown) => void }).setData(
              aircraftFeatures(Array.from(state.objects.values()), Date.now(), state.selectedId),
            );

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
        map.on('move', () => {
          const now = performance.now();
          if (now - lastViewport < VIEWPORT_UPDATE_MS || !map) return;
          lastViewport = now;
          const bounds = map.getBounds();
          // A viewport that is the entire planet is worse than none: it spends a
          // tier 2 credit on the widest box there is, which is what the cost
          // band exists to prevent (D21, D27).
          useOrbitalStore
            .getState()
            .setViewport(coversWholeWorld(bounds) ? null : boundsToBBox(bounds));
        });

        unsubscribe = useOrbitalStore.subscribe((state, previous) => {
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
          if (state.flyTo !== previous.flyTo && state.flyTo && map) {
            map.flyTo({ center: [state.flyTo.lon, state.flyTo.lat], zoom: 9, duration: 1600 });
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
