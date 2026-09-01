/**
 * Application state.
 *
 * The load-bearing decision here: **markers do not re-render through React.**
 *
 * At two thousand objects updating sixty times a second, routing positions
 * through React's reconciler would be hopeless. So the store holds objects in
 * a plain `Map`, the animation loop reads that map directly every frame and
 * writes into GPU buffers, and React only subscribes to the small pieces of
 * state that actually drive UI — the selection, the search results, the
 * freshness banner (D3).
 *
 * `objectsVersion` is how a React component asks "has the set changed?"
 * without subscribing to the map itself: it increments once per poll, not once
 * per object.
 */

import { create } from 'zustand';

import type {
  Airport,
  BoundingBox,
  LayerDescriptor,
  ObjectListResponse,
  RenderableObject,
  TrackedObject,
  TrackedObjectDetail,
} from '../types';
import { toRenderable } from '../globe/interpolate';

/**
 * The available layers.
 *
 * Two entries. The abstraction was kept deliberately thin while there was only
 * one, on the grounds that a richer layer system built before a second layer
 * existed would be fitted to an imagined use case rather than a real one (D19).
 * The second arrived four months later (D93) and it cost one line here, one in
 * `ObjectType`, and nothing at all in the polling hook — which reads
 * `resource` and does not know or care what is behind it.
 *
 * Order is the order the toggle draws them. Aircraft first because it is the
 * layer the app opens on.
 */
export const LAYERS: LayerDescriptor[] = [
  { id: 'aircraft', label: 'Aircraft', resource: 'aircraft' },
  { id: 'satellite', label: 'Satellites', resource: 'satellites' },
];

export interface FeedStatus {
  stale: boolean;
  /**
   * Epoch ms of the backend's last successful upstream poll, parsed from
   * `fetchedAt`.
   *
   * The envelope also carries `ageSeconds`, and the status bar used to add the
   * time since the response arrived to it. That broke the moment the list
   * endpoint became conditional (D47): a 304 hands the client its own cached
   * body, whose `ageSeconds` was measured when it was first fetched, while the
   * arrival time keeps resetting on every poll -- so the age froze at a few
   * seconds while the data quietly went minutes old. `fetchedAt` is an
   * absolute instant and therefore says the same thing however many times the
   * same body is reused.
   */
  fetchedAtMs: number | null;
  source: string | null;
  /** Objects matching the query before thinning. */
  total: number;
  /** Objects actually received. */
  returned: number;
  /** Set when our own backend is unreachable — distinct from upstream failing. */
  error: string | null;
  lastUpdatedMs: number | null;
}

export interface OrbitalState {
  objects: Map<string, RenderableObject>;
  objectsVersion: number;

  activeLayer: LayerDescriptor;
  setActiveLayer(layer: LayerDescriptor): void;

  selectedId: string | null;
  selectedDetail: TrackedObjectDetail | null;
  select(id: string | null): void;
  setSelectedDetail(detail: TrackedObjectDetail | null): void;

  searchQuery: string;
  searchResults: TrackedObject[];
  /** Airports matching the same query. Kept apart from aircraft (D89). */
  searchAirports: Airport[];
  searching: boolean;
  setSearchQuery(query: string): void;
  setSearchResults(results: TrackedObject[], airports?: Airport[]): void;
  setSearching(searching: boolean): void;

  feed: FeedStatus;
  applySnapshot(response: ObjectListResponse, nowMs: number): void;
  setFeedError(message: string | null): void;

  /**
   * What the camera can currently see.
   *
   * Published by the globe and consumed by the polling hook. Sending it to the
   * backend both filters the response and tells the poller where to spend its
   * fast tier 2 credits, so this is not merely an optimization (D21).
   */
  viewport: BoundingBox | null;
  setViewport(bbox: BoundingBox | null): void;

  /** Camera target requested by a search hit, consumed by the globe. */
  flyTo: { lat: number; lon: number; nonce: number; zoom?: number } | null;
  requestFlyTo(lat: number, lon: number, zoom?: number): void;

  /**
   * The airport a search just flew to, drawn and named until it is dismissed.
   *
   * Flying the camera somewhere is not an answer on its own: the motion ends
   * over a patch of ground and nothing says which patch was asked for. This is
   * what gets marked.
   */
  focusedAirport: Airport | null;
  focusAirport(airport: Airport | null): void;
}

const initialFeed: FeedStatus = {
  stale: false,
  fetchedAtMs: null,
  source: null,
  total: 0,
  returned: 0,
  error: null,
  lastUpdatedMs: null,
};

export const useOrbitalStore = create<OrbitalState>((set, get) => ({
  objects: new Map(),
  objectsVersion: 0,

  activeLayer: LAYERS[0],
  setActiveLayer(layer) {
    // Switching layers clears everything: the object ids belong to the old
    // layer, and carrying them over would draw stale markers of the wrong kind.
    set({
      activeLayer: layer,
      objects: new Map(),
      objectsVersion: get().objectsVersion + 1,
      selectedId: null,
      selectedDetail: null,
      searchResults: [],
      searchAirports: [],
      focusedAirport: null,
    });
  },

  selectedId: null,
  selectedDetail: null,
  select(id) {
    if (id === get().selectedId) return;
    // Clear the old detail immediately so the panel never shows one aircraft's
    // track under another's callsign while the fetch is in flight.
    //
    // The focused airport goes with it. An aircraft and an airport are two
    // answers to two different questions, and leaving both marked would say
    // the map is showing you both when the camera can only be at one.
    set({ selectedId: id, selectedDetail: null, focusedAirport: null });
  },
  setSelectedDetail(detail) {
    // Ignore a response that arrived after the user moved on.
    if (detail && detail.id !== get().selectedId) return;
    set({ selectedDetail: detail });
  },

  searchQuery: '',
  searchResults: [],
  searchAirports: [],
  searching: false,
  setSearchQuery(query) {
    set({ searchQuery: query });
    if (query.trim() === '')
      set({ searchResults: [], searchAirports: [], searching: false });
  },
  setSearchResults(results, airports = []) {
    set({ searchResults: results, searchAirports: airports, searching: false });
  },
  setSearching(searching) {
    set({ searching });
  },

  feed: initialFeed,

  applySnapshot(response, nowMs) {
    const previous = get().objects;
    const next = new Map<string, RenderableObject>();

    for (const object of response.objects) {
      next.set(object.id, toRenderable(object, previous.get(object.id), nowMs));
    }

    set({
      objects: next,
      objectsVersion: get().objectsVersion + 1,
      feed: {
        stale: response.stale,
        fetchedAtMs: response.fetchedAt ? Date.parse(response.fetchedAt) : null,
        source: response.source,
        total: response.total,
        returned: response.returned,
        error: null,
        lastUpdatedMs: nowMs,
      },
    });
  },

  setFeedError(message) {
    // Deliberately does NOT clear the objects. If our backend goes away we keep
    // drawing the last positions we had, for the same reason the backend keeps
    // serving its last snapshot: an empty globe is a worse lie than an old one.
    set({ feed: { ...get().feed, error: message } });
  },

  viewport: null,
  setViewport(bbox) {
    set({ viewport: bbox });
  },

  flyTo: null,
  requestFlyTo(lat, lon, zoom) {
    // The nonce makes two consecutive requests to the same coordinates distinct,
    // so re-selecting the same search hit still moves the camera.
    set({ flyTo: { lat, lon, nonce: Date.now(), zoom } });
  },

  focusedAirport: null,
  focusAirport(airport) {
    set({ focusedAirport: airport });
  },
}));

/** Snapshot of the objects map for the render loop. Not reactive by design. */
export function currentObjects(): RenderableObject[] {
  return Array.from(useOrbitalStore.getState().objects.values());
}
