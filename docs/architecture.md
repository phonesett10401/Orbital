# Orbital — Architecture

**CSC480 team project. Live aircraft tracking on the Earth in a browser.**

This document describes how Orbital is built and why. It is written to be read
start to finish by someone who has not seen the code.

---

## 1. What Orbital does

Orbital renders the Earth in the browser and plots live aircraft positions on
it. A user can rotate and zoom, search for a flight by callsign or an airport
by name or code, click an aircraft to see its details, and view the path that
aircraft has been observed to fly.

**There are two renderers over the same data**, and `VITE_VIEW` picks one: a
three.js globe (`src/globe/`) and a MapLibre map on satellite imagery
(`src/planet/`). They are not two products. The globe was built first and is
still the default in code; the map was built to go past the zoom the globe can
hold (D53, D54) and is where the newer work has landed. Everything below the
render layer is shared, and neither renderer knows the other exists.

**Out of scope:** user accounts, native mobile apps, historical playback, and
delay and disruption data — see §8, which also covers where the satellite layer
stops. *Schedules* are a
qualified exception: the scheduled origin and destination for a callsign are
looked up per selection (D88), because an aircraft does not transmit where it
is going and the panel would otherwise have nothing to say. Nothing else about
a schedule is used.

---

## 2. The shape of the system

Orbital is three layers with one rule between them: **data flows in one
direction, and each layer knows only the layer directly beneath it.**

```
   adsb.lol            OpenSky Network      (external, unreliable, both limited
   (free, rate         (metered, billed      in different ways -- see below)
    limited)            by area)
          \                  /
           \                /  HTTP, once per interval, once per server
            v              v
  +-------------------------------------------------------------+
  |  1. INGESTION            backend/app/providers, ingestion    |
  |                                                              |
  |  Provider  -- speaks HTTP to one upstream, returns the        |
  |               normalized shape and nothing else               |
  |  Union     -- a Provider that is two providers (D83): the     |
  |               free one answers every poll, the metered one    |
  |               fills its gaps every 120 s                      |
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
  |  src/globe (three.js)  |  src/planet (MapLibre)  |  shared UI  |
  |  Interpolates positions between polls; both renderers read    |
  |  the same store and the same wingspan/airframe tables         |
  +-------------------------------------------------------------+
```

Three properties follow from this, and they are the design:

1. **The browser never talks to a data source.** Every external call goes
   through the backend, so rate limiting and caching are enforced in exactly one
   place. A hundred open browser tabs cost the same upstream quota as one. This
   is what made adding a second feed a backend-only change: the frontend was
   never told, because there was nothing to tell it.
2. **The ingestion layer does not know a browser exists**, and the frontend does
   not know where the data came from. Either can be replaced without touching
   the other, and both have been: the backend gained a second upstream, and the
   frontend gained a second renderer, neither requiring a change on the other
   side of the wire.
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
| Map rendering | **MapLibre GL** | The globe turns to mush past about z9 (D53); MapLibre goes from orbit to sub-metre on real imagery, and its custom-layer hook lets the same three.js airframe be drawn inside it (D54, D67) |
| Backend | **FastAPI** (Python) | Pydantic makes the cross-layer contract executable and self-documenting |
| Frontend | **React + Vite + TypeScript** | The contract is enforced at compile time on both sides of the wire |
| Cache | **In-process dictionary** | One process, one poller; Redis would be operational cost for no benefit |
| HTTP client | **httpx** | Async, so polling never blocks the API |
| Tests | **pytest** (backend), **Vitest** (frontend) | Conventional, and the fixture provider makes both runnable offline |

---

## 4. The normalized shape

Every moving object in Orbital — today an aircraft, and only an aircraft — is
represented by the same ten fields:

```
{ id, lat, lon, altitude, velocity, heading, label, model, lastSeen, type }
```

`model` is the tenth and the newest: what the source says the object *is*, in
its own vocabulary — for an aircraft the ICAO type designator, `B789`. It is
source-agnostic in the same way the rest is, which is why it is in the shape
rather than in `meta`; the frontend reads it to size and shape what it draws
(§5.8), but this contract promises only the designator.

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
| `TrackedObject` | The ten fields | The browser, in list responses |
| `TrackedObjectRecord` | + `meta` | Providers and the store, internally |
| `TrackedObjectDetail` | + `track`, `trackSource`, `origin`, `route`, `meta` | The browser, from the by-id endpoint only |

The list endpoint declares `TrackedObject` as its response model, so FastAPI
projects `meta` away automatically. This is what keeps a 2000-object response
small without anyone having to remember to strip fields.

---

## 5. Data flow: from a feed to a pixel

1. **Schedule.** On startup, FastAPI's `lifespan` handler starts the poller,
   which runs one asyncio task per configured job. One poller per server, not
   per connected browser. There are always two jobs: **tier 1** fetches the
   whole world to buy *coverage*, and **tier 2** fetches the client's viewport
   to buy *latency*. The split exists because OpenSky bills by requested area,
   and a full-globe call buys 324x more area per credit than a small box — so
   the world is the cheap way to stay populated, and a small box is the cheap
   way to stay fresh. See [decisions.md](decisions.md) D21 for the arithmetic.

   **What sets the intervals changed when the second feed arrived.** Under the
   OpenSky-only presets they are set by the credit ladder: 5 minutes and 45
   seconds on the authenticated tier. Under `union` they are 120 s and 30 s,
   which the credit ladder could never afford — they are paid for by adsb.lol
   answering every poll for nothing, and priced instead by *its* rate limit,
   measured at a burst of 4 then roughly one request per 12 s (D83, D85, and
   defect #35 in the test plan).
2. **Fetch.** The task calls `provider.fetch(bbox)`, and which provider that is
   depends on configuration:
   - `OpenSkyProvider` obtains an OAuth2 token if it does not hold a valid one,
     then issues one request. It records `X-Rate-Limit-Remaining` so the poller
     can throttle against the real balance.
   - `AdsbLolProvider` needs no credentials at all. It covers a bbox by
     sweeping overlapping circles, and paces itself through an internal gate so
     it never asks faster than the service will serve.
   - `UnionProvider` is both. adsb.lol answers every poll; OpenSky is called at
     most every 120 s and its results are merged in to fill the gaps. Its
     `remaining_credits` delegates to the metered half — declared on the
     `Provider` interface, because a missing attribute once let a union feed
     look free and the whole throttle ladder went dead (defect #34).

   On failure a provider raises a typed `ProviderError`; all retry and backoff
   policy lives in the poller.
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
8. **Render.** The globe writes positions into a single buffer geometry and
   draws them in one GPU call; the map writes them into a GeoJSON source and
   MapLibre draws them from an SDF sprite atlas. Both size each aircraft by its
   own wingspan, read from `model` through a shared table (`wingspan.ts`), and
   both draw objects that have stopped updating muted with their `lastSeen`
   shown, rather than vanishing.
9. **Select.** Click → hit test → id → the detail panel, the observed track,
   and the selection redrawn as a 3D airframe whose proportions come from its
   type (`airframeShape.ts`). An aircraft with **no heading gets no model** in
   either renderer: a mesh commits to a direction on screen and there is none
   to commit to (D18, D40, D42, D67).

---

## 6. Deliberate limitations

These are constraints we chose, not bugs. Each is defensible; each is recorded
with its reasoning in [decisions.md](decisions.md).

- **"Route" means the observed path, not the filed flight plan.** A state
  vector contains no route information. We draw the path we have actually
  watched the aircraft fly since it entered our polling window. An aircraft
  seen thirty seconds ago has a thirty-second route.
- **Where a flight is going is looked up; where it came from is inferred.**
  Neither is observed, and the panel keeps them apart on purpose (D88). The
  destination comes from what the *callsign* is published as flying, which can
  be confidently wrong. The origin is the nearest airport to the first point of
  *this aircraft's* track, with the distance carried alongside so the wording
  can differ between an aircraft on a runway and one already climbing.
- **Neither feed sees the whole planet.** Both depend on volunteer ground
  receivers, and there are regions — western China most visibly — with none, so
  aircraft genuinely disappear there and reappear on the far side. This is
  upstream reality, not a defect, and no free source covers it (test plan
  19.42). The map draws the measured gaps rather than letting them read as
  empty sky.
- **The Earth is a sphere, not the WGS84 ellipsoid.** The error is about 0.3%,
  which over the distance an aircraft covers between polls is a few metres —
  far below one screen pixel at globe zoom.
- **The globe draws no buildings or terrain; the map does.** At globe zoom a
  building is smaller than a pixel. The map exists precisely to go past that
  zoom, and gets its buildings and imagery from a tile service rather than from
  a pipeline of ours — which is also the one place the app is not offline.
- **Localhost only.** No Docker, no hosting. CORS is configured permissively
  for local development and is flagged as the change point if that ever changes.
- **The two renderers are not at parity.** The map has airport markers and the
  coverage overlay; the globe does not. This is drift rather than a decision,
  and the intended resolution is to adopt the map as the default and delete the
  globe, not to port each feature twice.

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

**Satellites are in scope as of September 2026 (D93).** They were dropped in
D37 — removed rather than deferred — and that reversal was made deliberately
rather than drifted into, which is exactly what D37's tripwire tests existed to
force. Their positions are **computed** from published orbital elements rather
than fetched from a feed, so that layer spends no quota and keeps working
offline once the elements are cached.

Two pieces of the design look like they were built as groundwork for this. They
were not, and D37's argument for why still holds:

1. **The `type` field on the shape.** A discriminator carried from the start
   costs one enum with one value. Retrofitting one into a contract spanning
   three layers is a migration. It exists because the shape is deliberately
   source-agnostic (D4), and it is about to gain its second value having earned
   its place without one.
2. **The provider registry.** This is the pluggability requirement itself, and
   it stopped being a claim: adsb.lol was added as a second live source, and
   then a third entry that is *both at once*, without the API or the frontend
   changing. The fixture provider that makes the whole project runnable offline
   (D8) is a registry entry too.

**Where the satellite layer stops**, each line guarded by a test:

- **Debris and rocket bodies.** The catalogue holds around 100,000 objects and
  the overwhelming majority are neither satellites nor interesting to look at.
- **Conjunction, collision and re-entry prediction.** SGP4 is accurate to
  kilometres and degrades with age from epoch. It must never be the basis of a
  claim that two objects will meet — a viewer has no way to detect that such an
  answer is wrong.
- **Ground station passes and look angles.** A reasonable feature; a different
  one.

Three tests enforce those boundaries. They are **permanent guards against
undeclared scope growth**, not markers awaiting deletion — when D93 reversed
D37, the guards were re-aimed at the new boundary rather than removed. A guard
deleted the moment it fires was never a guard.

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
│   │   ├── airports.py      28,291 airports; nearest, and search (D78, D89)
│   │   ├── providers/
│   │   │   ├── base.py      the Provider interface           (M1)
│   │   │   ├── fixture.py   offline replay provider          (M1)
│   │   │   ├── registry.py  name -> provider                 (M1)
│   │   │   ├── opensky.py   the metered source               (M2)
│   │   │   ├── adsblol.py   the free source, and its own rate gate (D83)
│   │   │   └── union.py     both at once, free feed pacing   (D83)
│   │   ├── ingestion/
│   │   │   ├── store.py     object cache + track history     (M2)
│   │   │   ├── poller.py    two-tier scheduling, backoff     (M2)
│   │   │   ├── flights.py   the detail view's assembly
│   │   │   └── flightroutes.py  scheduled route by callsign, cached (D88)
│   │   ├── api/             REST endpoints                   (M3)
│   │   │   ├── search.py    one box, two lists: aircraft and airports (D89)
│   │   │   └── etag.py      weak validators, so the polled endpoint can 304 (D47)
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
    └── src/
        ├── airlines.ts          callsign -> airline, in the client (D46)
        ├── wingspan.ts          ICAO type -> wingspan and draw scale (D90)
        ├── airframeShape.ts     ICAO type -> proportions, by size class (D91)
        ├── airframe.ts          the 3D airframe geometry, shared by both
        ├── globe/               renderer 1: three.js               (M4)
        │   ├── earth.ts             the lit planet, atmosphere, stars
        │   ├── borders.ts           country boundaries, one line layer (D44)
        │   ├── labels.ts            country/city/airport names, DOM    (D45)
        │   ├── markers.ts           every tracked object, one Points
        │   ├── route.ts             the observed track of the selection
        │   └── selectedAircraft.ts  the selection as a 3D airframe     (D42)
        └── planet/              renderer 2: MapLibre                (D54)
            ├── basemap.ts           the style: imagery, roads, buildings (D56-D59)
            ├── aircraftLayer.ts     every tracked object, one SDF sprite atlas
            ├── routeLayer.ts        the observed track, and what is guessed (D82)
            ├── modelLayer.ts        the selection as a 3D airframe, in MapLibre's
            │                        own GL context via a custom layer (D67)
            ├── modelFrame.ts        the tangent-frame arithmetic that puts it there
            ├── airportLayer.ts      the searched-for airport, ringed and named (D89)
            ├── coverageLayer.ts     where nobody is listening, drawn on (D92)
            ├── terminatorLayer.ts   day and night, behind a toggle (D68, D73, D74)
            └── diagnostics.ts       what the map says about itself (D57)
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
