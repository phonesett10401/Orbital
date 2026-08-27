# Orbital — Architecture

**CSC480 team project. Live aircraft tracking on a 3D globe.**

This document describes how Orbital is built and why. It is written to be read
start to finish by someone who has not seen the code.

---

## 1. What Orbital does

Orbital renders an interactive 3D Earth in the browser and plots live aircraft
positions on it. A user can rotate and zoom the globe, search for a flight by
callsign, click an aircraft to see its details, and view the path that aircraft
has been observed to fly.

**Out of scope:** user accounts, native mobile apps, historical playback,
flight schedules or delay data, offline use, and satellite tracking — see §8.

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

1. **Schedule.** On startup, FastAPI's `lifespan` handler starts the poller,
   which runs one asyncio task per configured job. One poller per server, not
   per connected browser. Under the default preset there are two jobs:
   **tier 1** fetches the whole globe every 5 minutes to buy *coverage*, and
   **tier 2** fetches the client's viewport every 45 seconds to buy *latency*.
   The split exists because OpenSky bills by requested area, and a full-globe
   call buys 324x more area per credit than a small box — so the globe is the
   cheap way to stay populated, and a small box is the cheap way to stay fresh.
   See [decisions.md](decisions.md) D21 for the arithmetic.
2. **Fetch.** The task calls `provider.fetch(bbox)`. `OpenSkyProvider` obtains
   an OAuth2 token if it does not hold a valid one, then issues one HTTP request
   with a timeout. It records `X-Rate-Limit-Remaining` from the response so the
   poller can throttle against the real balance. On failure it raises a typed
   `ProviderError`; all retry and backoff policy lives in the poller.
3. **Normalize.** OpenSky returns positional arrays — `state[0]` is the ICAO24
   address, `state[5]` is longitude, and so on — which are unreadable at the
   call site and would leak upstream's quirks into our code. The provider maps
   each row to a `TrackedObjectRecord`, converts units once, and **drops rows
   with no usable position** rather than emitting a placeholder. A marker at
   (0, 0) is worse than no marker: it looks like a real aircraft in the Gulf of
   Guinea.
4. **Store.** The store **merges** the result by object id rather than
   replacing wholesale — with two tiers returning different areas at different
   times, a wholesale replace on the 45-second viewport poll would erase every
   aircraft outside the viewport. Objects expire individually on their own TTL.
   Each poll also appends the object's position to a bounded ring buffer, which
   is the route history and why "route" means the observed path (see §6).
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

- A failed poll **never mutates the cache**. The previous data stays.
- The poller backs off exponentially on repeated failure (capped, with jitter),
  and honours `X-Rate-Limit-Retry-After-Seconds` when upstream supplies one —
  the expected failure is quota exhaustion, and hammering a source that has
  already said no makes it worse. A 429 pauses *every* job, since the quota is
  shared.
- The poller **degrades in stages as credits drain**, cutting the latency tier
  before the coverage tier: losing tier 2 makes one region less fresh, losing
  tier 1 empties the globe.
- The API **always returns 200** with the last good data, marked `stale: true`
  once past the TTL, with `ageSeconds` so the frontend can say how old it is.
- `/api/health` reports the provider name, the last successful poll, the
  consecutive failure count, the remaining credit balance and the current
  throttle level.
- The frontend **keeps showing the last known position** with a timestamp
  rather than removing markers.

The test that kills the provider and asserts the API still returns 200 with
stale data is not a nice-to-have — that test *is* the exit criterion.

---

## 8. Scope boundaries

Satellite tracking was considered and **is not being built**. It is out of
scope, not deferred, and nothing in this repository is groundwork for it (D37).

Two pieces of the design look like they were built for a second data layer.
They were not, and they earn their place on their own:

1. **The `type` field on the shape.** A discriminator carried from the start
   costs one enum with one value. Retrofitting one into a contract spanning
   three layers is a migration. It exists because the shape is deliberately
   source-agnostic (D4), not because a second type is planned.
2. **The provider registry.** This is the pluggability requirement itself:
   swapping OpenSky for adsb.fi or airplanes.live is a config change, and the
   fixture provider that makes the whole project runnable offline (D8) is a
   registry entry.

Two tests assert that no satellite provider is registered and no satellite
endpoint exists. They are **permanent guards against undeclared scope growth**,
not temporary markers awaiting deletion.

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
│   │   ├── config.py        env-driven settings, presets     (M2)
│   │   ├── quota.py         credit cost model + throttling   (M2)
│   │   ├── providers/
│   │   │   ├── base.py      the Provider interface           (M1)
│   │   │   ├── fixture.py   offline replay provider          (M1)
│   │   │   ├── registry.py  name -> provider                 (M1)
│   │   │   └── opensky.py   the live source                  (M2)
│   │   ├── ingestion/
│   │   │   ├── store.py     object cache + track history     (M2)
│   │   │   └── poller.py    two-tier scheduling, backoff     (M2)
│   │   ├── api/             REST endpoints                   (M3)
│   │   ├── thinning.py      server-side marker reduction     (M3)
│   │   └── logging_config.py  handler setup for app.* loggers
│   └── tests/
│       └── fixtures/        committed sample data + generator
└── frontend/                                                 (M4)
    ├── scripts/
    │   ├── copy-textures.mjs    Earth imagery out of node_modules  (D30)
    │   ├── build-geography.mjs  borders and label anchors          (D44)
    │   └── build-airlines.mjs   ICAO designator lookup             (D46)
    ├── public/
    │   ├── textures/            generated, gitignored
    │   ├── geo/                 generated, gitignored
    │   └── data/                generated, gitignored
    ├── src/
    │   └── airlines.ts          callsign -> airline, in the client (D46)
    └── src/globe/
        ├── earth.ts             the lit planet, atmosphere, stars
        ├── borders.ts           country boundaries, one line layer (D44)
        ├── labels.ts            country/city/airport names, DOM    (D45)
        ├── markers.ts           every tracked object, one Points
        ├── route.ts             the observed track of the selection
        └── selectedAircraft.ts  the selection as a 3D airframe     (D42)
```

Three asset directories under `public/` are generated rather than committed:
`npm install` brings the source data, `npm run assets` reduces it, and both
run before `npm run dev` and `npm run build`. Nothing in them is fetched from
a third party at runtime, so the app stays as offline as the fixture provider
makes the backend.

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
