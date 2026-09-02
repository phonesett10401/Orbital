/**
 * The polling hooks: how the client keeps up with the backend.
 *
 * The browser polls our backend, never OpenSky. Our backend polls upstream on
 * a much slower schedule, so these intervals cost nothing upstream — a hundred
 * open tabs still consume one server's worth of credits (D7).
 */

import { useEffect, useRef } from 'react';

import { fetchObjectDetail, fetchObjects, search, ApiError } from '../api/client';
import { config } from '../config';
import { useOrbitalStore } from '../state/store';
import type { BoundingBox, LayerDescriptor } from '../types';

/**
 * Keep the object set current for the active layer and viewport.
 *
 * Refetches on an interval, and — for a viewport-scoped layer — immediately
 * whenever the viewport changes enough to matter. Sending the viewport is also
 * what tells the backend where to spend its fast tier 2 credits (D21).
 *
 * **A layer that is not viewport-scoped never refetches on a map move**, which
 * is the whole point of the flag: it already holds every object, so turning the
 * globe reveals objects rather than requesting them (D110).
 */
/**
 * How long to wait after the viewport settles before refetching.
 *
 * Was 250 ms, which sat on top of the view's own 500 ms publish throttle - so
 * up to three quarters of a second could pass after a drag ended before the
 * request was even sent, and Phone reported exactly that as objects being slow
 * to appear when turning the globe.
 */
export const VIEWPORT_REFETCH_DEBOUNCE_MS = 120;

/**
 * The bounding box a request for this layer should carry, if any.
 *
 * Pulled out of the hook so it can be tested as data: there is no
 * component-render harness in this project, so a judgement that only exists
 * inside an effect is a judgement nothing can check.
 *
 * The asymmetry is the point. A viewport on an aircraft request is load-bearing
 * - it aims the backend's tier 2 credits (D21). A viewport on a satellite
 * request aims nothing, because that layer computes positions and has no credit
 * model at all (D95); all it does is make the globe ask the server for objects
 * it could already have been holding.
 */
export function bboxFor(
  layer: Pick<LayerDescriptor, 'viewportScoped'>,
  viewport: BoundingBox | null,
): BoundingBox | null {
  return layer.viewportScoped ? viewport : null;
}

export function useObjectPolling(): void {
  const layer = useOrbitalStore((s) => s.activeLayer);
  const viewport = useOrbitalStore((s) => s.viewport);

  // Held in a ref so a viewport change does not tear down and restart the
  // interval; only the layer does that.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetchObjects(layer.resource, {
          bbox: bboxFor(layer, viewportRef.current),
          signal: controller.signal,
        });
        if (!cancelled) useOrbitalStore.getState().applySnapshot(response, Date.now());
      } catch (error) {
        if (cancelled || (error as Error).name === 'AbortError') return;
        // Our backend is unreachable. This is distinct from OpenSky being down,
        // which the backend absorbs and reports as `stale` on a 200.
        const message =
          error instanceof ApiError ? error.message : (error as Error).message;
        useOrbitalStore.getState().setFeedError(message);
      }
    };

    void poll();
    const timer = window.setInterval(poll, config.pollIntervalMs);

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [layer.resource]);

  // A meaningful viewport change is worth an immediate refetch rather than
  // waiting out the interval, so panning to a new region fills in promptly.
  //
  // Skipped entirely for a layer that is not viewport-scoped: its snapshot
  // already covers the globe, so a move has nothing to fetch and firing one
  // would replace the whole set with an identical one mid-drag.
  useEffect(() => {
    if (!viewport || !layer.viewportScoped) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchObjects(layer.resource, { bbox: viewport, signal: controller.signal })
        .then((response) =>
          useOrbitalStore.getState().applySnapshot(response, Date.now()),
        )
        .catch(() => {
          // The interval poll will report any persistent failure; a single
          // dropped viewport refresh is not worth an error banner.
        });
      // Long enough that a drag does not fire a request per frame, short
      // enough that letting go feels like the map filling in rather than
      // waiting. The viewport itself is already throttled upstream of this, so
      // this delay is measured from the last *published* move, not the last
      // mouse event.
    }, VIEWPORT_REFETCH_DEBOUNCE_MS);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [viewport, layer.resource, layer.viewportScoped]);
}

/** Fetch the full record, including the observed track, for the selection. */
export function useSelectedDetail(): void {
  const selectedId = useOrbitalStore((s) => s.selectedId);
  const layer = useOrbitalStore((s) => s.activeLayer);

  useEffect(() => {
    if (!selectedId) {
      useOrbitalStore.getState().setSelectedDetail(null);
      return undefined;
    }

    const controller = new AbortController();
    void fetchObjectDetail(layer.resource, selectedId, controller.signal)
      .then((detail) => useOrbitalStore.getState().setSelectedDetail(detail))
      .catch((error) => {
        if ((error as Error).name === 'AbortError') return;
        // A 404 here means the object aged out of the backend's store between
        // the click and the fetch. Clearing the selection is honest; showing an
        // error would over-dramatise a routine race.
        useOrbitalStore.getState().setSelectedDetail(null);
      });

    return () => controller.abort();
  }, [selectedId, layer.resource]);
}

/** Debounced server-side search. */
export function useSearch(): void {
  const query = useOrbitalStore((s) => s.searchQuery);
  const layer = useOrbitalStore((s) => s.activeLayer);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) return undefined;

    const controller = new AbortController();
    useOrbitalStore.getState().setSearching(true);

    const timer = window.setTimeout(() => {
      void search(trimmed, controller.signal)
        .then((response) =>
          useOrbitalStore
            .getState()
            .setSearchResults(response.aircraft, response.airports, response.satellites ?? []),
        )
        .catch((error) => {
          if ((error as Error).name === 'AbortError') return;
          useOrbitalStore.getState().setSearchResults([], [], []);
        });
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, layer.resource]);
}
