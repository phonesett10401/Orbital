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
import { createAircraftIconCanvas, createUnknownIconCanvas } from '../globe/aircraftSprite';
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
    let frame = 0;

    void (async () => {
      // Dynamic, so the 800 KB of MapLibre is fetched by the view that uses
      // it rather than by the bundle every visitor loads.
      await import('maplibre-gl/dist/maplibre-gl.css');
      const maplibre = await import('maplibre-gl');
      const style = await loadPlanetStyle();
      if (disposed) return;

      map = new maplibre.Map({
        container,
        style,
        center: [100.5, 13.75],
        zoom: 2,
        attributionControl: { compact: true },
      });

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

      // A search hit flies the camera, as it does on the globe.
      unsubscribe = useOrbitalStore.subscribe((state, previous) => {
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
      map?.remove();
    };
  }, []);

  return <div ref={containerRef} className="planet-view" />;
}
