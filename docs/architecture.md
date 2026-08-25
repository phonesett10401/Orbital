# Orbital — Architecture

**CSC480 team project. Phase 1: live aircraft tracking on a 3D globe.**

This document describes how Orbital is built and why. It is written to be read
start to finish by someone who has not seen the code.

---

## 1. What Orbital does

Orbital renders an interactive 3D Earth in the browser and plots live aircraft
positions on it. A user can rotate and zoom the globe, search for a flight by
callsign, click an aircraft to see its details, and view the path that aircraft
has been observed to fly.

A second phase, not yet started, adds satellites as a second layer on the same
globe. Phase 1 is designed so that phase 2 requires no changes to the rendering
or API layers — but contains no satellite code. See §8.

**Out of scope for the whole project:** user accounts, native mobile apps,
historical playback, flight schedules or delay data, offline use.

---

## 2. The shape of the system

Orbital is three layers with one rule between them: **data flows in one
direction, and each layer knows only the layer directly beneath it.**

```
   OpenSky Network                     (external, unreliable, rate-limited)
          |
          |  HTTP, once per interval, once per server
          v
  +-------------------------------------------------------------+
  |  1. INGESTION            backend/app/providers, ingestion    |
  |                                                              |
  |  Provider  -- speaks HTTP to one upstream, returns the        |
  |               normalized shape and nothing else               |
  |  Poller    -- schedules fetches, owns retry and backoff        |
  |  Store     -- holds the latest snapshot + per-object history  |
  +-------------------------------------------------------------+
          |
          |  in-process function calls; never a network hop
          v
  +-------------------------------------------------------------+
  |  2. API                  backend/app/api                     |
  |                                                              |
  |  Reads the store. Filters by bounding box. Thins.             |
  |  Never calls upstream. Never fails because upstream failed.   |
  +-------------------------------------------------------------+
          |
          |  REST over HTTP, polled by the browser
          v
  +-------------------------------------------------------------+
  |  3. FRONTEND             frontend/src                        |
  |                                                              |
  |  Globe + visual layer  |  Marker layer  |  UI components      |
  |  Interpolates positions between polls                        |
  +-------------------------------------------------------------+
```

Three properties follow from this, and they are the design:

1. **The browser never talks to OpenSky.** Every external call goes through the
   backend, so rate limiting and caching are enforced in exactly one place. A
   hundred open browser tabs cost the same upstream quota as one.
2. **The ingestion layer does not know a browser exists**, and the frontend does
   not know OpenSky exists. Either can be replaced without touching the other.
3. **Upstream failure is contained at layer 1.** The API serves the last good
   snapshot with an explicit staleness flag. An OpenSky outage degrades the
   display; it does not break it.

---

## 3. Technology choices

Full reasoning for each of these is recorded in [decisions.md](decisions.md).
Summary:

| Layer | Choice | One-line reason |
|---|---|---|
| Globe rendering | **Globe.gl** (over three.js) | Days to learn instead of weeks; CesiumJS's accuracy is invisible at this scale |
| Backend | **FastAPI** (Python) | Pydantic makes the cross-layer contract executable and self-documenting |
| Frontend | **React + Vite + TypeScript** | The contract is enforced at compile time on both sides of the wire |
| Cache | **In-process dictionary** | One process, one poller; Redis would be operational cost for no benefit |
| HTTP client | **httpx** | Async, so polling never blocks the API |
| Tests | **pytest** (backend), **Vitest** (frontend) | Conventional, and the fixture provider makes both runnable offline |

---

## 4. The normalized shape

Every moving object in Orbital — today an aircraft, later a satellite — is
represented by the same nine fields:

```
{ id, lat, lon, altitude, velocity, heading, label, lastSeen, type }
```

This is the contract between all three layers. It is defined once in
`backend/app/models.py` as a Pydantic model, mirrored in
`frontend/src/types.ts`, and documented in
[data-contract.md](data-contract.md), which is the authority on units and
meaning.

The shape contains **no aircraft-specific field**. Callsign is `label`.
Origin country — which the detail panel requires — is not in the shape at all;
it lives in a `meta` map on the internal record type. That is deliberate: the
moment an aircraft-only field enters the universal shape, the satellite
provider has to either fake it or change the schema, and the pluggability claim
becomes false.

Three model types, each with a job:

| Type | Contains | Who sees it |
|---|---|---|
| `TrackedObject` | The nine fields | The browser, in list responses |
| `TrackedObjectRecord` | + `meta` | Providers and the store, internally |
| `TrackedObjectDetail` | + `track` | The browser, from the by-id endpoint only |

The list endpoint declares `TrackedObject` as its response model, so FastAPI
projects `meta` away automatically. This is what keeps a 2000-object response
small without anyone having to remember to strip fields.

---

## 5. Data flow: from OpenSky to a pixel

1. **Schedule.** On startup, FastAPI's `lifespan` handler starts a single
   asyncio task. One poller per server, not per connected browser.
2. **Fetch.** The task calls `provider.fetch()`. `OpenSkyProvider` issues one
   HTTP request with a timeout. On failure it raises a `ProviderError`.
3. **Normalize.** OpenSky returns positional arrays — `state[0]` is the ICAO24
   address, `state[5]` is longitude, and so on — which are unreadable at the
   call site and would leak upstream's quirks into our code. The provider maps
   each row to a `TrackedObjectRecord`, converts units once, and **drops rows
   with no usable position** rather than emitting a placeholder. A marker at
   (0, 0) is worse than no marker: it looks like a real aircraft in the Gulf of
   Guinea.
4. **Store.** The store atomically replaces the current snapshot. It also
   appends each object's position to a bounded ring buffer — this is the route
   history, and it is why "route" means the observed path (see §6).
5. **Serve.** `GET /api/aircraft?bbox=…` reads the snapshot, filters by
   bounding box, thins if the box is large, and returns objects plus `stale`
   and `ageSeconds`. It performs no I/O and cannot fail because OpenSky failed.
6. **Poll.** The browser requests the current camera's bounding box on an
   interval. The response becomes the new truth; the previous one is retained
   as the interpolation origin.
7. **Interpolate.** A `requestAnimationFrame` loop dead-reckons each marker
   forward along its heading at its velocity. When a real update arrives, the
   marker eases toward the true position over roughly a second rather than
   snapping. **This is not a polish feature** — it is what makes a 60-second
   poll interval acceptable, and therefore what makes the quota budget work.
8. **Render.** Positions are written into a single buffer geometry and drawn in
   one GPU call. Objects that have stopped updating are drawn muted, with their
   `lastSeen` timestamp shown, rather than vanishing.
9. **Select.** Click → raycast → id → the detail panel and the route polyline
   render from that object's track history.

---

## 6. Deliberate limitations

These are constraints we chose, not bugs. Each is defensible; each is recorded
with its reasoning in [decisions.md](decisions.md).

- **"Route" means the observed path, not the filed flight plan.** OpenSky state
  vectors contain no route information. We draw the path we have actually
  watched the aircraft fly since it entered our polling window. An aircraft
  seen thirty seconds ago has a thirty-second route.
- **The Earth is a sphere, not the WGS84 ellipsoid.** The error is about 0.3%,
  which over the distance an aircraft covers between polls is a few metres —
  far below one screen pixel at globe zoom.
- **No 3D buildings, terrain meshes, or tiled geometry.** At globe zoom a
  building is smaller than a pixel, and the streaming pipeline would cost more
  than the rest of the project combined.
- **Localhost only.** No Docker, no hosting. CORS is configured permissively
  for local development and is flagged as the change point if that ever changes.

---

## 7. Failure behaviour

Surviving an OpenSky outage is a phase 1 exit criterion, so it is designed
rather than discovered:

- A failed poll **never mutates the cache**. The previous snapshot stays.
- The poller backs off on repeated failure, and honours `retry_after` when
  upstream supplies one — the expected failure is quota exhaustion, and
  hammering a source that has already said no makes it worse.
- The API **always returns 200** with the last good data, marked `stale: true`
  once past the TTL, with `ageSeconds` so the frontend can say how old it is.
- `/api/health` reports the provider name, the last successful poll, and the
  consecutive failure count.
- The frontend **keeps showing the last known position** with a timestamp
  rather than removing markers.

The test that kills the provider and asserts the API still returns 200 with
stale data is not a nice-to-have — that test *is* the exit criterion.

---

## 8. How phase 2 fits without being built

Phase 2 adds satellites. Phase 1 contains exactly two concessions to it:

1. The `type` field on the shape, whose only value today is `"aircraft"`.
2. The provider registry, which maps a config name to a provider class.

Adding satellites should then be: write `providers/celestrak.py` returning the
same nine fields, add one line to the registry, add `"satellite"` to the enum,
add an endpoint that reuses the existing store and thinning code. **No change
to the shape, the API layer, or the renderer.**

There is no satellite code in this repository, no `satellite.js` dependency,
and no satellite type. `test_providers.py` contains a test asserting that no
satellite provider is registered; it is deleted when phase 1 is signed off.

---

## 9. Repository layout

```
orbital/
├── docs/
│   ├── architecture.md      this document
│   ├── data-contract.md     the normalized shape: units, meaning, limits
│   ├── decisions.md         every significant choice, with reasoning
│   └── test-plan.md         phase 1 exit criteria            (M5)
├── backend/
│   ├── pyproject.toml
│   ├── app/
│   │   ├── models.py        the normalized shape             (M1)
│   │   ├── geo.py           spherical geometry helpers       (M1)
│   │   ├── config.py        env-driven settings              (M2)
│   │   ├── providers/
│   │   │   ├── base.py      the Provider interface           (M1)
│   │   │   ├── fixture.py   offline replay provider          (M1)
│   │   │   ├── registry.py  name -> provider                 (M1)
│   │   │   └── opensky.py   the live source                  (M2)
│   │   ├── ingestion/
│   │   │   ├── store.py     snapshot cache + track history   (M2)
│   │   │   └── poller.py    scheduling, retry, backoff       (M2)
│   │   ├── api/             REST endpoints                   (M3)
│   │   └── thinning.py      server-side marker reduction     (M3)
│   └── tests/
│       └── fixtures/        committed sample data + generator
└── frontend/                                                 (M4)
```

---

## 10. Development without network access

`FixtureProvider` replays 157 committed synthetic aircraft from disk and
animates them by dead reckoning, so the globe actually moves offline.

This is deliberate infrastructure, not a convenience. Three developers sharing
one rate-limited API key would either exhaust the daily quota by mid-morning or
serialise their work behind whoever holds the credentials. With the fixture
provider, the API layer, the thinning logic and the entire frontend can be
built and tested with no credentials and no network.

```bash
cd backend && .venv/Scripts/python -m pytest
```

The fixture deliberately includes edge cases that real OpenSky data contains —
null velocity, unknown altitude, an aircraft on the antimeridian, a polar
route, a missing callsign — so we meet them in week two rather than in the
demo.
