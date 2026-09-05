/**
 * Tests for application state.
 *
 * The behaviours here are the ones that would produce confusing, hard-to-trace
 * UI bugs: a detail panel showing one aircraft's track under another's
 * callsign, or the globe emptying because our own backend blipped.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ObjectListResponse, TrackedObject, TrackedObjectDetail } from '../types';
import { LAYERS, useOrbitalStore } from './store';

const NOW = 1_800_000_000_000;

function object(id: string, overrides: Partial<TrackedObject> = {}): TrackedObject {
  return {
    id,
    lat: 10,
    lon: 20,
    altitude: 10000,
    velocity: 240,
    heading: 90,
    label: id.toUpperCase(),
    model: null,
    lastSeen: new Date(NOW).toISOString(),
    type: 'aircraft',
    ...overrides,
  };
}

function response(
  objects: TrackedObject[],
  overrides: Partial<ObjectListResponse> = {},
): ObjectListResponse {
  return {
    objects,
    type: 'aircraft',
    source: 'fixture',
    fetchedAt: new Date(NOW).toISOString(),
    ageSeconds: 3,
    stale: false,
    total: objects.length,
    returned: objects.length,
    ...overrides,
  };
}

function detail(id: string): TrackedObjectDetail {
  return {
    ...object(id),
    track: [],
    trackSource: 'observed' as const,
    route: null,
    origin: null,
    meta: { originCountry: 'Testland' },
  };
}

beforeEach(() => {
  useOrbitalStore.setState({
    objects: new Map(),
    objectsVersion: 0,
    activeLayer: LAYERS[0],
    selectedId: null,
    selectedDetail: null,
    searchQuery: '',
    searchResults: [],
    searching: false,
    viewport: null,
    flyTo: null,
    feed: {
      stale: false,
      fetchedAtMs: null,
      source: null,
      total: 0,
      returned: 0,
      error: null,
      lastUpdatedMs: null,
    },
  });
});

describe('applySnapshot', () => {
  it('stores objects by id', () => {
    useOrbitalStore.getState().applySnapshot(response([object('a1'), object('b2')]), NOW);
    expect(useOrbitalStore.getState().objects.size).toBe(2);
    expect(useOrbitalStore.getState().objects.get('a1')?.label).toBe('A1');
  });

  it('bumps the version once per snapshot, not once per object', () => {
    const before = useOrbitalStore.getState().objectsVersion;
    useOrbitalStore
      .getState()
      .applySnapshot(response([object('a1'), object('b2'), object('c3')]), NOW);
    expect(useOrbitalStore.getState().objectsVersion).toBe(before + 1);
  });

  it('replaces the set so objects absent from the response disappear', () => {
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([object('a1'), object('b2')]), NOW);
    store.applySnapshot(response([object('a1')]), NOW + 10_000);
    expect([...useOrbitalStore.getState().objects.keys()]).toEqual(['a1']);
  });

  it('carries freshness metadata into the feed status', () => {
    useOrbitalStore
      .getState()
      .applySnapshot(response([], { stale: true, ageSeconds: 720, total: 4000, returned: 2000 }), NOW);
    const feed = useOrbitalStore.getState().feed;
    expect(feed.stale).toBe(true);
    expect(feed.total).toBe(4000);
    expect(feed.returned).toBe(2000);
  });

  it('keeps the absolute fetch instant, not the age at arrival', () => {
    // The age at arrival is measured once and then reused for as long as the
    // client keeps the body -- which, since the list endpoint became
    // conditional, can be every poll for five minutes (D47). The instant is
    // the same fact stated in a form that does not go out of date.
    const fetchedAt = new Date(NOW - 90_000).toISOString();
    useOrbitalStore.getState().applySnapshot(response([], { fetchedAt, ageSeconds: 3 }), NOW);
    expect(useOrbitalStore.getState().feed.fetchedAtMs).toBe(NOW - 90_000);
  });

  it('tolerates an envelope with no successful poll behind it', () => {
    useOrbitalStore.getState().applySnapshot(response([], { fetchedAt: null }), NOW);
    expect(useOrbitalStore.getState().feed.fetchedAtMs).toBeNull();
  });

  it('clears a previous error on a successful poll', () => {
    useOrbitalStore.getState().setFeedError('backend down');
    useOrbitalStore.getState().applySnapshot(response([object('a1')]), NOW);
    expect(useOrbitalStore.getState().feed.error).toBeNull();
  });

  it('preserves drawn position across an update so markers do not jump back', () => {
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([object('a1', { lon: 0 })]), NOW);
    store.applySnapshot(response([object('a1', { lon: 5 })]), NOW + 30_000);
    const updated = useOrbitalStore.getState().objects.get('a1')!;
    // Easing starts from where we had extrapolated to, not from lon 0.
    expect(updated.fromLon).toBeGreaterThan(0);
  });
});

describe('setFeedError', () => {
  it('records the message', () => {
    useOrbitalStore.getState().setFeedError('cannot reach backend');
    expect(useOrbitalStore.getState().feed.error).toBe('cannot reach backend');
  });

  it('does not discard the objects we already have', () => {
    // An empty globe is a worse lie than an old one — the same principle the
    // backend applies to its own cache.
    useOrbitalStore.getState().applySnapshot(response([object('a1')]), NOW);
    useOrbitalStore.getState().setFeedError('backend down');
    expect(useOrbitalStore.getState().objects.size).toBe(1);
  });
});

describe('selection', () => {
  it('clears the previous detail immediately on a new selection', () => {
    // Otherwise the panel briefly shows one aircraft's track under another's
    // callsign while the fetch is in flight.
    useOrbitalStore.getState().setSelectedDetail(null);
    useOrbitalStore.setState({ selectedId: 'a1', selectedDetail: detail('a1') });
    useOrbitalStore.getState().select('b2');
    expect(useOrbitalStore.getState().selectedDetail).toBeNull();
  });

  it('ignores a detail response for an object no longer selected', () => {
    // A slow fetch must not overwrite a newer selection when it lands.
    useOrbitalStore.getState().select('a1');
    useOrbitalStore.getState().select('b2');
    useOrbitalStore.getState().setSelectedDetail(detail('a1'));
    expect(useOrbitalStore.getState().selectedDetail).toBeNull();
  });

  it('accepts a detail response for the current selection', () => {
    useOrbitalStore.getState().select('a1');
    useOrbitalStore.getState().setSelectedDetail(detail('a1'));
    expect(useOrbitalStore.getState().selectedDetail?.id).toBe('a1');
  });

  it('selecting null dismisses the panel', () => {
    useOrbitalStore.getState().select('a1');
    useOrbitalStore.getState().select(null);
    expect(useOrbitalStore.getState().selectedId).toBeNull();
  });

  it('re-selecting the same id is a no-op', () => {
    useOrbitalStore.getState().select('a1');
    useOrbitalStore.getState().setSelectedDetail(detail('a1'));
    useOrbitalStore.getState().select('a1');
    expect(useOrbitalStore.getState().selectedDetail?.id).toBe('a1');
  });
});

describe('search', () => {
  it('clearing the query clears the results', () => {
    useOrbitalStore.getState().setSearchResults([object('a1')]);
    useOrbitalStore.getState().setSearchQuery('');
    expect(useOrbitalStore.getState().searchResults).toEqual([]);
  });

  it('setting results ends the searching state', () => {
    useOrbitalStore.getState().setSearching(true);
    useOrbitalStore.getState().setSearchResults([]);
    expect(useOrbitalStore.getState().searching).toBe(false);
  });
});

describe('layers', () => {
  it('exposes exactly the declared layers, and no others', () => {
    // Permanent guard against undeclared scope growth, re-aimed by D93. The
    // question is no longer "is there more than one kind?" but "is every kind
    // on screen one somebody decided to add?" - so this asserts the exact set,
    // which fails on an addition as loudly as the length check it replaces.
    expect(LAYERS.map((layer) => layer.id).sort()).toEqual(['aircraft', 'satellite']);
  });

  it('the satellite layer points at its own endpoint', () => {
    // The polling hook builds its URL from `resource` alone, so this string is
    // the entire wiring between the toggle and the backend (D95).
    const satellites = LAYERS.find((layer) => layer.id === 'satellite');
    expect(satellites?.resource).toBe('satellites');
  });

  it('every layer has a distinct resource, or one would shadow the other', () => {
    const resources = LAYERS.map((layer) => layer.resource);
    expect(new Set(resources).size).toBe(resources.length);
  });

  it('offers both declared layers, since one renderer draws both', () => {
    // The per-renderer filter is gone with the renderer that needed it (D104).
    expect(LAYERS.map((layer) => layer.id).sort()).toEqual(['aircraft', 'satellite']);
  });


  it('switching layers clears objects and selection', () => {
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([object('a1')]), NOW);
    store.select('a1');
    store.setActiveLayer({ id: 'aircraft', label: 'Other', resource: 'other', viewportScoped: true });
    const next = useOrbitalStore.getState();
    expect(next.objects.size).toBe(0);
    expect(next.selectedId).toBeNull();
  });
});

describe('flyTo', () => {
  it('produces a distinct request for the same coordinates', () => {
    // Without a nonce, re-picking the same search hit would not move the camera.
    useOrbitalStore.getState().requestFlyTo(10, 20);
    const first = useOrbitalStore.getState().flyTo;
    useOrbitalStore.getState().requestFlyTo(10, 20);
    expect(useOrbitalStore.getState().flyTo).not.toBe(first);
  });
});

describe('lunar spacecraft', () => {
  const craft = {
    id: '-85',
    name: 'LRO',
    operator: 'NASA',
    purpose: 'Mapping the Moon.',
    lat: 38.4,
    lon: -68.4,
    altitudeKm: 70.9,
  };

  it('keeps the craft themselves, so an open panel keeps up with them', () => {
    // A count would serve the status bar and leave the panel showing a
    // position from whenever it was clicked - visibly wrong within a minute,
    // because these go round in about two hours (D135).
    useOrbitalStore.getState().setMoonCraft([craft]);
    expect(useOrbitalStore.getState().moonCraft[0].altitudeKm).toBe(70.9);
    useOrbitalStore.getState().setMoonCraft([{ ...craft, altitudeKm: 88.2 }]);
    expect(useOrbitalStore.getState().moonCraft[0].altitudeKm).toBe(88.2);
  });

  it('leaving the Moon closes the panel and drops the craft', () => {
    // Otherwise a Moon panel hangs over Mars, which is the same class of fault
    // as drawing Earth's satellites there (D133, D135).
    useOrbitalStore.getState().setMoonCraft([craft]);
    useOrbitalStore.getState().selectMoonCraft('-85');
    useOrbitalStore.getState().setActiveBody('mars');
    const next = useOrbitalStore.getState();
    expect(next.selectedMoonId).toBeNull();
    expect(next.moonCraft).toEqual([]);
  });

  it('selecting a lunar craft does not disturb the Earth selection', () => {
    // Two separate selections deliberately: one names an object with a detail
    // endpoint behind it, the other names something already fully in hand.
    useOrbitalStore.getState().select('a1');
    useOrbitalStore.getState().selectMoonCraft('-85');
    expect(useOrbitalStore.getState().selectedId).toBe('a1');
    expect(useOrbitalStore.getState().selectedMoonId).toBe('-85');
  });
});

describe('a track fresher than the feed', () => {
  // Against the wall clock, not the fixture's `NOW` - which sits in 2027, so
  // an object built with it is "from the future" and nothing can improve on
  // it. Written that way first, these tests failed for that reason alone.
  const REAL = Date.now();
  const stale = (id: string) =>
    object(id, { lastSeen: new Date(REAL - 300_000).toISOString() });
  const track = (secondsAgo: number, lat: number, lon: number) => [
    {
      lat,
      lon,
      altitude: 10_000,
      timestamp: new Date(REAL - secondsAgo * 1000).toISOString(),
    },
  ];

  it('moves the marker to the head of its own line', () => {
    // The measured bug: the feed frozen minutes back while the track kept
    // going, leaving the aeroplane behind the end of its own track (D138).
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([stale('a1')]), REAL);
    store.select('a1');
    store.setSelectedDetail({ id: 'a1', track: track(30, 51.5, -0.2) } as never);
    const moved = useOrbitalStore.getState().objects.get('a1');
    expect(moved?.lat).toBe(51.5);
    expect(moved?.lon).toBe(-0.2);
  });

  it('survives the next poll, which rebuilds the whole map', () => {
    // A fix adopted once was overwritten ten seconds later and the marker fell
    // back behind its track. This is the line that keeps it.
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([stale('a1')]), REAL);
    store.select('a1');
    store.setSelectedDetail({ id: 'a1', track: track(30, 51.5, -0.2) } as never);
    store.applySnapshot(response([stale('a1')]), REAL + 10_000);
    expect(useOrbitalStore.getState().objects.get('a1')?.lat).toBe(51.5);
  });

  it('leaves an unselected aircraft alone', () => {
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([stale('a1'), stale('a2')]), REAL);
    store.select('a1');
    store.setSelectedDetail({ id: 'a1', track: track(30, 51.5, -0.2) } as never);
    expect(useOrbitalStore.getState().objects.get('a2')?.lat).toBe(10);
  });

  it('does nothing when the feed is already ahead of the track', () => {
    // The common case. If this ever starts moving markers, every aircraft on
    // screen acquires a wobble once per detail poll.
    const store = useOrbitalStore.getState();
    store.applySnapshot(response([object('a1')]), NOW);
    store.select('a1');
    store.setSelectedDetail({ id: 'a1', track: track(30, 51.5, -0.2) } as never);
    expect(useOrbitalStore.getState().objects.get('a1')?.lat).toBe(10);
  });
});
