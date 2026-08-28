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

import { useEffect, useRef } from 'react';

import { useOrbitalStore } from '../state/store';
import {
  AIRCRAFT_LABEL_LAYER,
  AIRCRAFT_LAYER,
  AIRCRAFT_SOURCE,
  ICON_AIRCRAFT,
  ICON_UNKNOWN,
  aircraftFeatures,
  aircraftLayers,
} from './aircraftLayer';
import { loadPlanetStyle } from './basemap';
import { ROUTE_SOURCE, routeFeatures, routeLayers } from './routeLayer';
import { createAircraftIconCanvas, createUnknownIconCanvas } from '../globe/aircraftSprite';
import { whenRenderable } from './container';
import { createDiagnosticsPanel } from './diagnostics';
import { boundsToBBox, coversWholeWorld } from './viewport';

/** How often to republish the viewport, matching the globe view's cadence. */
const VIEWPORT_UPDATE_MS = 500;

export function PlanetView() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    let disposed = false;
    let map: import('maplibre-gl').Map | null = null;
    let unsubscribe: (() => void) | null = null;
    let diagnostics: ReturnType<typeof createDiagnosticsPanel> | null = null;
    let cleanUpResize: (() => void) | null = null;
    let frame = 0;

    void (async () => {
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

      diagnostics?.attach(map);

      map.on('load', () => {
        if (!map) return;

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

        map.addSource(AIRCRAFT_SOURCE, {
          type: 'geojson',
          data: aircraftFeatures([], Date.now()),
        });
        for (const layer of aircraftLayers()) map.addLayer(layer);

        // Clicking an aircraft selects it, which is all the globe's pointer
        // module did once its pick tolerance stopped being the hard part
        // (D34): MapLibre hit-tests its own symbols, at their drawn size.
        map.on('click', AIRCRAFT_LAYER, (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === 'string') useOrbitalStore.getState().select(id);
        });
        map.on('click', (event) => {
          const hits = map?.queryRenderedFeatures(event.point, {
            layers: [AIRCRAFT_LAYER, AIRCRAFT_LABEL_LAYER],
          });
          if (!hits?.length) useOrbitalStore.getState().select(null);
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
            aircraftFeatures(Array.from(state.objects.values()), Date.now()),
          );
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
        (window as unknown as Record<string, unknown>).__orbitalPlanet = { map, maplibre };
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe?.();
      cleanUpResize?.();
      diagnostics?.dispose();
      map?.remove();
    };
  }, []);

  return <div ref={containerRef} className="planet-view" />;
}
