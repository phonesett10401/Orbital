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
import { withBestFix } from '../trackFix';
import type { MoonSatellite } from '../moonSatellites';
import type { Destination } from '../journey';
import type { PageName } from '../pageRoute';
import type { Account } from '../auth';

import type {
  Airport,
  BoundingBox,
  LayerDescriptor,
  ObjectListResponse,
  OrbitPath,
  RenderableObject,
  TrackedObject,
  TrackedObjectDetail,
} from '../types';
import type { BodyId } from '../bodies';
import { toRenderable } from '../interpolate';

/**
 * The available layers.
 *
 * Three entries. The abstraction was kept deliberately thin while there was
 * only one, on the grounds that a richer layer system built before a second
 * layer existed would be fitted to an imagined use case rather than a real one
 * (D19). The second arrived four months later (D93) and cost one line here,
 * one in `ObjectType`, and nothing at all in the polling hook — which reads
 * `resource` and does not know or care what is behind it. The third cost the
 * same (D165), and the polling hook has still never been touched for either.
 *
 * Order is the order the toggle draws them. Aircraft first because it is the
 * layer the app opens on.
 */
export const LAYERS: LayerDescriptor[] = [
  { id: 'aircraft', label: 'Aircraft', resource: 'aircraft', viewportScoped: true },
  { id: 'satellite', label: 'Satellites', resource: 'satellites', viewportScoped: false },
  // **Viewport-scoped, and it was not, and that was a real defect.**
  //
  // D165 set this false on sound reasoning that expired: the feed was 916
  // Baltic vessels in 37 KB, which fits under the 2,000 thinning cap whole, so
  // a second request for the part under the camera would have fetched the same
  // bytes twice. Adding the global stream made it 29,000 (D166), and an
  // unbounded request is then thinned to 2,000 spread across the *entire
  // planet*.
  //
  // Measured over the North Sea at zoom 7 - the busiest water in the world -
  // the box holds **9,159 vessels and the map drew 37**. Scoped to the
  // viewport the same request returns the full 2,000. Nothing failed and no
  // test noticed; the sea simply looked empty (D167).
  { id: 'ship', label: 'Ships', resource: 'ships', viewportScoped: true },
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

  /**
   * The orbit the selected satellite is on, once fetched (D170).
   *
   * Separate from `selectedDetail` even though both arrive on selection, for
   * the reason the backend keeps them separate too: a `track` is where
   * something **has been**, an orbit is where something **goes**, and only one
   * of the two is an observation. Folding a computed path into a field meaning
   * "observed" is the D94 mistake - a field whose meaning depends on which
   * layer you are in.
   *
   * `null` for every layer but satellites, and for a satellite whose elements
   * cannot carry a whole revolution.
   */
  selectedOrbit: OrbitPath | null;
  setSelectedOrbit(orbit: OrbitPath | null): void;

  searchQuery: string;
  searchResults: TrackedObject[];
  /** Airports matching the same query. Kept apart from aircraft (D89). */
  searchAirports: Airport[];
  searchSatellites: TrackedObject[];
  searchShips: TrackedObject[];
  searching: boolean;
  setSearchQuery(query: string): void;
  setSearchResults(
    results: TrackedObject[],
    airports?: Airport[],
    satellites?: TrackedObject[],
    ships?: TrackedObject[],
  ): void;
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

  /**
   * The instant being shown, as epoch ms, or `null` for live.
   *
   * Non-null means the map is **not live**, which the chrome has to say
   * loudly: everything else in this app that shows a position also says how
   * old it is, and a rewound map that claimed to be current would be the most
   * confident lie in the project (D119).
   */
  viewInstant: number | null;
  setViewInstant(instant: number | null): void;

  /**
   * Which world the camera is on.
   *
   * Leaving Earth switches off aircraft, satellites, airports, coverage and
   * the terminator - they are statements about Earth, and over Mars they are
   * not stale but meaningless (D120).
   */
  activeBody: BodyId;
  setActiveBody(body: BodyId): void;

  /**
   * The spacecraft currently tracked around the Moon.
   *
   * The craft themselves rather than a count, because two things need them:
   * the status bar, whose "no live objects here" became false the moment the
   * Moon had objects (the D120 fault, one body along), and the detail panel,
   * which must show a position that **keeps moving** - these go round in about
   * two hours, so a snapshot taken at click time would be visibly wrong within
   * a minute of reading it (D135).
   */
  moonCraft: MoonSatellite[];
  setMoonCraft(craft: MoonSatellite[]): void;

  /**
   * Which lunar spacecraft the panel is open for.
   *
   * Separate from `selectedId`, which names an object in Earth's sky and is
   * fetched from a detail endpoint. There is no endpoint here and nothing to
   * fetch: everything the panel shows already arrived with the position.
   */
  selectedMoonId: string | null;
  selectMoonCraft(id: string | null): void;

  /**
   * Where the lunar panel should float, in screen pixels, or null.
   *
   * The panel is tethered to the spacecraft rather than parked in a corner, so
   * its position is a property of the camera and belongs where both the map
   * and the panel can see it. Published by the map on every move (D137).
   */
  moonPanelAt: { x: number; y: number } | null;
  setMoonPanelAt(at: { x: number; y: number } | null): void;


  /**
   * Who is signed in, or null for nobody.
   *
   * `null` is the ordinary state, not an error: the free tier is the product
   * and every feature works signed out except the ones deliberately reserved.
   * `accountChecked` says whether the question has been *asked* yet, which is
   * different from being signed out and is what stops the chrome flashing
   * "Sign in" for a moment on every page load (D148).
   */
  account: Account | null;
  accountChecked: boolean;
  setAccount(account: Account | null): void;

  /**
   * Which full-screen page is open, or null for the map (D153, D157).
   *
   * In the store rather than inside the component that opens it, because a page
   * covers the whole app and is rendered at the top of the tree while the
   * control that opens it lives in the header. It is also the one piece of
   * chrome the browser's Back button can close, which needs a single place to
   * say so.
   *
   * **One name rather than a flag per page.** Two booleans would make "both
   * open at once" a state the types allow, and that is the sort of thing that
   * happens once and is then impossible to reproduce.
   */
  openPage: PageName | null;
  setOpenPage(page: PageName | null): void;

  /**
   * The journey between the planet view and the solar system, while one is
   * running (D161).
   *
   * They are two views rather than two ends of a zoom, and this is what says
   * so: a screen that names where you are going, held over the camera move
   * underneath it. `null` almost always.
   */
  journey: Destination | null;
  /**
   * Whether the solar system page has drawn a frame and can be looked at.
   *
   * The journey screen waits on this rather than on a clock (D174). It was a
   * fixed 1,100 ms while the page opened in the same tick, so the words showed
   * for a moment and the stall happened in the open behind them.
   *
   * Set by the page itself after its first render, cleared when it unmounts -
   * so "ready" always means the thing that is about to be revealed, not the
   * thing that was revealed last time.
   */
  systemReady: boolean;
  setSystemReady(ready: boolean): void;
  setJourney(to: Destination | null): void;

  /**
   * Where the camera is heading, while a trip is in progress.
   *
   * Held so the solar system layer can brighten the destination on the way
   * out: the pull-out shows real positions, so the planet growing brighter is
   * genuinely where it is (D126).
   */
  flyingTo: BodyId | null;
  setFlyingTo(body: BodyId | null): void;

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
      selectedOrbit: null,
      searchResults: [],
      searchAirports: [],
      searchSatellites: [],
      searchShips: [],
      focusedAirport: null,
    });
  },

  selectedId: null,
  selectedDetail: null,
  selectedOrbit: null,
  setSelectedOrbit(orbit) {
    // The same guard `setSelectedDetail` uses: a response arriving after the
    // reader has moved on would draw the previous satellite's orbit around the
    // new one, which is a picture of neither.
    if (orbit && orbit.id !== get().selectedId) return;
    set({ selectedOrbit: orbit });
  },
  select(id) {
    if (id === get().selectedId) return;
    // Clear the old detail immediately so the panel never shows one aircraft's
    // track under another's callsign while the fetch is in flight.
    //
    // The focused airport goes with it. An aircraft and an airport are two
    // answers to two different questions, and leaving both marked would say
    // the map is showing you both when the camera can only be at one.
    set({ selectedId: id, selectedDetail: null, selectedOrbit: null, focusedAirport: null });
  },
  setSelectedDetail(detail) {
    // Ignore a response that arrived after the user moved on.
    if (detail && detail.id !== get().selectedId) return;

    // **The track can know more than the feed does.** It comes from the
    // provider's own flight history rather than our budgeted poll, so it is
    // routinely fresher - and once the feed's report ages past two minutes the
    // marker stops dead-reckoning while the line keeps growing, leaving the
    // aeroplane behind the end of its own track. Measured at 77 seconds and
    // about twenty kilometres. The freshest observation wins (D138).
    const objects = get().objects;
    const current = detail ? objects.get(detail.id) : undefined;
    const improved = current ? withBestFix(current, detail?.track, Date.now()) : current;
    if (current && improved && improved !== current) {
      const next = new Map(objects);
      next.set(detail!.id, improved);
      set({
        selectedDetail: detail,
        objects: next,
        objectsVersion: get().objectsVersion + 1,
      });
      return;
    }
    set({ selectedDetail: detail });
  },

  searchQuery: '',
  searchResults: [],
  searchAirports: [],
  searchSatellites: [],
  searchShips: [],
  searching: false,
  setSearchQuery(query) {
    set({ searchQuery: query });
    if (query.trim() === '')
      set({
        searchResults: [],
        searchAirports: [],
        searchSatellites: [],
        searchShips: [],
        searching: false,
      });
  },
  setSearchResults(results, airports = [], satellites = [], ships = []) {
    set({
      searchResults: results,
      searchAirports: airports,
      searchSatellites: satellites,
      searchShips: ships,
      searching: false,
    });
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

    // **Re-applied on every snapshot, not just when the detail lands.** The
    // feed rebuilds this map every poll, so a fix adopted once was overwritten
    // ten seconds later and the marker fell back behind its own track -
    // measured doing exactly that before this line existed (D138).
    const selected = get().selectedId;
    const track = get().selectedDetail?.track;
    if (selected && track) {
      const current = next.get(selected);
      if (current) {
        const improved = withBestFix(current, track, nowMs);
        if (improved !== current) next.set(selected, improved);
      }
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

  flyingTo: null,
  setFlyingTo(body) {
    set({ flyingTo: body });
  },

  activeBody: 'earth',
  account: null,
  accountChecked: false,
  setAccount(account) {
    set({ account, accountChecked: true });
  },
  journey: null,
  systemReady: false,
  setSystemReady(ready) {
    if (useOrbitalStore.getState().systemReady !== ready) set({ systemReady: ready });
  },
  setJourney(to) {
    if (useOrbitalStore.getState().journey !== to) set({ journey: to });
  },
  openPage: null,
  setOpenPage(page) {
    if (useOrbitalStore.getState().openPage !== page) set({ openPage: page });
  },
  moonPanelAt: null,
  setMoonPanelAt(at) {
    const current = useOrbitalStore.getState().moonPanelAt;
    // Compared rather than set blindly: this runs on every camera frame, and a
    // new object each time would re-render the panel sixty times a second.
    if (current?.x === at?.x && current?.y === at?.y) return;
    set({ moonPanelAt: at });
  },
  moonCraft: [],
  setMoonCraft(craft) {
    set({ moonCraft: craft });
  },
  selectedMoonId: null,
  selectMoonCraft(id) {
    if (useOrbitalStore.getState().selectedMoonId !== id) set({ selectedMoonId: id });
  },
  setActiveBody(body) {
    // Changing world clears everything held, for the same reason changing
    // layer does: the objects describe Earth and nothing about them survives
    // the trip. Selection goes too - it names something not on this world.
    set({
      activeBody: body,
      objects: new Map(),
      objectsVersion: get().objectsVersion + 1,
      selectedId: null,
      selectedDetail: null,
      selectedOrbit: null,
      viewInstant: null,
      // The lunar craft and any panel open on one go the same way, and for the
      // same reason: they name something that is not on the world being
      // travelled to. Leaving them would show a Moon panel over Mars (D135).
      moonCraft: [],
      selectedMoonId: null,
      moonPanelAt: null,
    });
  },

  viewInstant: null,
  setViewInstant(instant) {
    // Changing the instant clears the objects for the same reason changing
    // layer does: what is held describes a different moment, and drawing it
    // beside positions from another one would be a picture of no time at all.
    set({
      viewInstant: instant,
      objects: new Map(),
      objectsVersion: get().objectsVersion + 1,
    });
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
