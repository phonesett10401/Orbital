# Orbital — Test Plan and Completion Criteria

The record of what has been tested, what was measured, and what is known not to
be covered.

**Status: all five criteria met.** A live verification run against the real
OpenSky API was carried out (§9); it found two defects, both since fixed and
re-verified (§9.7).

Satellite tracking is out of scope and is not a future phase (D37). Work from
here deepens the aircraft globe.

---

## 1. Completion criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | All phase 1 requirements implemented | **Met** | §2 |
| 2 | Test plan executed, no open critical or high defects | **Met** | §3, §6 |
| 3 | Stable rendering performance at the target marker count | **Met** | §4, §9.6 |
| 4 | Backend survives an OpenSky outage without breaking the frontend | **Met** | §5 |
| 5 | Documentation complete | **Met** | §7, §9 |

Criterion 5 was open because the system had never run against the live OpenSky
API. That run has happened (§9): OAuth2, credit accounting, real response
shapes and real traffic clustering are all now verified against the live
service. §9.9 lists what remains unexercised — all of it failure paths that
cannot be triggered on demand.

---

## 2. Requirements coverage

| Requirement | Where | Verified by |
|---|---|---|
| 3D globe with rotate and zoom | `globe/GlobeView.tsx` | Manual: confirmed in a browser |
| Aircraft markers on the globe | `globe/markers.ts` | Manual + `markers.test.ts`; 157 markers rendered |
| Live positions from OpenSky | `providers/opensky.py` | `test_opensky.py` (34 tests, mock transport) |
| Browser never calls OpenSky directly | `api/client.ts` | Only `/api/*` URLs exist in the frontend |
| In-memory cache with TTL | `ingestion/store.py` | `test_store.py` |
| Normalized shape across layers | `models.py`, `types.ts` | `test_models.py` (33 tests) |
| Provider interface, swappable by config | `providers/registry.py` | `test_providers.py` |
| `GET /api/aircraft?bbox=` | `api/aircraft.py` | `test_api.py` |
| `GET /api/aircraft/{id}` | `api/aircraft.py` | `test_api.py` |
| Search by callsign | `store.search`, `SearchBar.tsx` | `test_store.py`, `test_api.py`, manual |
| Detail panel | `DetailPanel.tsx` | Manual: callsign, altitude, speed, heading, origin country |
| Route display | `globe/route.ts` | Manual: 49-point track drawn; `route.test.ts` |
| Interpolation between polls | `globe/interpolate.ts` | `interpolate.test.ts` (29 tests) |
| Last-known position with timestamp | `markers.ts`, `DetailPanel.tsx` | `interpolate.test.ts`, manual |
| Marker thinning when zoomed out | `thinning.py` | `test_thinning.py` (26 tests) |
| Layer toggle as a separate component | `LayerToggle.tsx` | Renders with one layer, by design (D19) |

---

## 3. Automated test suites

Both run offline. No test touches the network or spends an API credit.

```bash
cd backend && .venv/Scripts/python -m pytest
```

```bash
cd frontend && npm test
```

| Suite | Tests | Covers |
|---|---|---|
| `test_models.py` | 33 | The contract: units, nullability, immutability, antimeridian |
| `test_providers.py` | 29 | Provider interface, fixture provider, registry, geometry |
| `test_opensky.py` | 34 | Normalization, OAuth2 refresh, quota headers, failure mapping |
| `test_quota.py` | 40 | Credit bands, daily projection, throttle ladder |
| `test_store.py` | 29 | Merging, track history, TTL, eviction, search |
| `test_poller.py` | 40 | Scheduling, retry, backoff, throttling, **outage** |
| `test_thinning.py` | 26 | Grid, ranking, stability, determinism |
| `test_api.py` | 43 | Endpoints, envelopes, errors, **outage over HTTP** |
| `test_app_surface.py` | 17 | **Response compression and log output** |
| `interpolate.test.ts` | 29 | Dead reckoning, easing, extrapolation limit |
| `sun.test.ts` | 11 | Solar declination and subsolar longitude |
| `viewport.test.ts` | 14 | Camera-to-bbox conversion |
| `pointer.test.ts` | 17 | **Click-to-select through real DOM events** |
| `markers.test.ts` | 12 | Pick tolerance in pixels, horizon test |
| `route.test.ts` | 13 | Great-circle geometry, antimeridian, colour |
| `store.test.ts` | 18 | Snapshot application, selection races, layers |
| **Total** | **409** | 295 backend, 114 frontend |

### What the automated suites do not cover

Stated plainly, because a test plan that implies total coverage is worse than
one that admits its gaps:

- **Rendering output.** No test asserts what appears on screen. The shaders,
  terminator, and texture loading are verified by looking at the running
  application.
- **Live OpenSky behaviour.** All provider tests run against a mock transport
  built from one recorded response. Real API quirks are unverified (§7).
- **React component rendering.** Components are exercised manually and through
  the store; there are no DOM-rendering tests for them. The pointer path is the
  exception, because that is where a bug hid (§6).
- **Wiring, in general.** Six of the eight defects in §6 were cases where
  correct code was never connected to anything. Tests assert on behaviour that
  runs; they cannot assert on behaviour that was never reached. Running the
  system remains a required step, not a nicety.

---

## 4. Performance

Target: 2,000 markers, the backend's thinning cap (D15).

### Frontend, measured in the browser

| Markers | Marker update | % of a 60 fps frame |
|---|---|---|
| 500 | 0.22 ms | 1.3% |
| 1,000 | 0.36 ms | 2.2% |
| **2,000** | **0.80 ms** | **4.8%** |
| 5,000 | 1.99 ms | 11.9% |
| 10,000 | 3.92 ms | 23.5% |

Linear at ~400 ns per marker. At the 2,000 target the hot path uses under 5% of
the frame budget, and the design holds to 10,000 — more aircraft than OpenSky
reports globally.

Allocation churn: ~4.4 KB per update, about 0.25 MB/s at 60 fps. Negligible.

**Draw calls for the entire scene: 5** — globe, atmosphere, star field,
markers, route. All 2,000 markers are one draw call, which is the whole point
of the custom `THREE.Points` layer (D15). Globe.gl's `pointsData()` API would
have issued one per aircraft.

### Backend, `python benchmarks/bench_backend.py`

Median of 15 runs. 10,000 objects is roughly what OpenSky reports globally.

| Objects | Poll apply | Bbox filter | Thin to 2,000 | Search | Detail |
|---|---|---|---|---|---|
| 2,000 | 0.7 ms | 0.57 ms | 0.82 ms | 1.6 ms | 0.01 ms |
| **10,000** | **7.4 ms** | **3.2 ms** | **9.1 ms** | **8.3 ms** | **0.01 ms** |
| 30,000 | 14.4 ms | 9.2 ms | 43.5 ms | 24.2 ms | 0.01 ms |

These matter because the backend is a **single-threaded event loop**: a slow
synchronous call delays every other request and the poller with it.

Two optimizations were made after measuring (D35):

| Operation at 10,000 | Before | After | Change |
|---|---|---|---|
| Poll apply (steady state) | 31.7 ms | 7.4 ms | **4.3× faster** |
| Thin to 2,000 | 19.8 ms | 9.1 ms | **2.2× faster** |

Nothing was optimized without a measurement first, and two candidates were
measured and then deliberately left alone: per-frame array allocation in the
render loop (1% of the tick) and the linear bounding-box scan (3.2 ms, and a
spatial index would be unjustified complexity — D11).

---

## 5. Outage behaviour

Criterion 4. Tested at two levels.

**Ingestion** (`test_poller.py::TestOutageBehaviour`) — the provider is made to
fail and the poller is driven through repeated failing cycles:

- Cached data survives a total outage; a failed poll never touches the store.
- The freshness clock does not advance on failure.
- Data is flagged stale once the outage outlasts the TTL.
- Nothing raises out of the poller — a dead task is indistinguishable from a
  hung backend.
- Recovery repopulates and clears the error.

**Over HTTP** (`test_api.py::TestOutageOverHttp`) — the real application, real
lifespan, injected failing provider:

- `GET /api/aircraft` answers **200 with all objects and `stale: true`**.
- Detail and search also answer 200.
- `/api/health` reports `degraded` with the real exception text.
- A store that never populated reports `stale: true` rather than implying an
  empty globe is current.

**Frontend.** The client distinguishes three states the globe cannot show on
its own: live, stale (upstream down, backend coping), and our own backend
unreachable. Losing the backend does not clear the markers.

---

## 6. Defects found and fixed

Recorded because three of the five were invisible to the test suites, which is
itself a finding.

| # | Defect | Severity | Found by | Status |
|---|---|---|---|---|
| 1 | 60 s global poll cost 144% of the daily credit budget | Critical | Arithmetic (D21) | Fixed |
| 2 | Grid snapping pushed valid viewports over the cost band, disabling the focus poll | High | Smoke test (D27) | Fixed |
| 3 | Tier 2 job reported `healthy: false` while correctly idle | Low | Running the server (D29) | Fixed |
| 4 | Duplicate three.js instances would break raycasting and materials | High | Browser console (D31) | Fixed |
| 5 | **Clicking a marker did nothing** — pick tolerance in world units, ~4 px at default zoom and ~1 px zoomed out | Critical | User testing (D34) | Fixed |
| 6 | **Tier 2 polling was unreachable at any zoom the camera could reach** | High | Verification (D36) | Fixed |
| 7 | Responses were not compressed — 328 KB per poll where gzip gives 67 KB | Medium | Live run (D38) | Fixed |
| 8 | Application logging was never configured, so every diagnostic line was discarded — D23 was true only on paper | Medium | Live run (D38) | Fixed |

**No open defects at any severity.**

Defects 3 through 8 all passed every automated test at the time they existed.
The pattern is consistent: in each case the *code* was correct and the *wiring*
was absent or mismatched — a threshold that no reachable zoom satisfied, a
raycast tolerance in the wrong unit, a middleware never registered, a logger
with no handler. Unit tests verify code. Only running the system verifies
wiring.

Defect 5 is the sharpest lesson: the verification computed a marker's projected
screen position and clicked exactly there, which cannot discover that a target
is too small. The regression tests now drive real DOM events.

---

## 7. What is outstanding

**Historical note.** Criterion 5 was held open because the system had never run
against the live OpenSky API, and everything in §2 to §6 was measured against
the fixture provider. That gap is what §9 closes. The list below is what was
unverified at that point:

- **OAuth2 against the real endpoint.** Token acquisition and refresh are
  tested against a mock. The real token URL, credential format and expiry
  behaviour have not been exercised once.
- **Real credit consumption.** The 3,072 credits/day projection (D21) is
  arithmetic, not observation. `X-Rate-Limit-Remaining` parsing has never seen a
  real header.
- **Real response quirks.** The normalizer is tested against one hand-written
  sample. Live data will contain shapes we have not seen.
- **Real object counts.** All performance figures use synthetic data spread
  evenly over the globe. Real traffic is clustered, which changes how thinning
  behaves.

All four were addressed by the run in §9. To repeat that verification — after
any change to the provider, the quota model, or the polling schedule:

```bash
cd backend && .venv/Scripts/python scripts/verify_live.py
```

---

## 8. Manual test script

For a demo or a fresh checkout. Start both servers, open the frontend.

| # | Step | Expected |
|---|---|---|
| 1 | Open the app | Textured Earth, night side lit, star field, atmospheric halo |
| 2 | Drag the globe | Rotates smoothly; no marker is selected on release |
| 3 | Scroll to zoom | Zooms in and out; markers scale with distance |
| 4 | Read the status bar | Aircraft count, data age, source name |
| 5 | Click a marker | Detail panel opens with callsign, altitude, speed, heading, origin country |
| 6 | Check the route | Polyline follows the observed track; caveat text is visible |
| 7 | Click empty space | Panel closes |
| 8 | Search a callsign | Ranked results; Enter picks the top hit |
| 9 | Pick a search result | Camera flies to it and it is selected |
| 10 | Search nonsense | "No match", not an error |
| 11 | Stop the backend | Markers stay; status bar reports the backend unreachable |
| 12 | Restart the backend | Recovers without a page reload |
| 13 | Open `/api/health` | `status: ok`, both jobs listed, quota projection shown |
| 14 | Zoom in tight, wait ~90 s, recheck health | Viewport job shows a successful poll |


---

## 9. Live OpenSky verification run

Run against the real API with authenticated client credentials. Reproduce with:

```bash
cd backend && .venv/Scripts/python scripts/verify_live.py
```

Cost: 5 credits for the script, 22 credits total across the whole session.

### 9.1 OAuth2 — works

| Check | Result |
|---|---|
| Token obtained from the real endpoint | Yes, a 1,445-character JWT |
| Nominal lifetime | 1,800 s |
| Refresh scheduled at | 1,740 s (lifetime minus the 60 s safety margin, D24) |
| Second call reuses the cached token | Yes |

**Not observed:** an actual token refresh. That needs a 29-minute run, and the
session did not last that long. The refresh path is unit-tested against a mock
but has still never run against the real endpoint — the one auth risk left.

### 9.2 Credit costs — the model is exactly right

Observed against the real `X-Rate-Limit-Remaining` header:

| Request | Area | Predicted | Observed |
|---|---|---|---|
| Bounded box (Benelux) | 20 sq deg | 1 credit | **1** |
| Viewport poll (tier 2) | 100 sq deg | 2 credits | **2** |
| Global `/states/all` | whole globe | 4 credits | **4** |

The band table in `quota.py` needs no correction.

### 9.3 Both polling tiers — verified end to end

Over a 310-second run, with credit balance read from the live header:

| Time | Event | Credits |
|---|---|---|
| 0 s | tier 1 global poll, 13,537 aircraft | 3,994 → 3,990 |
| 80 s | tier 2 viewport poll | 3,990 → 3,988 |
| 160 s | tier 2 viewport poll | 3,988 → 3,986 |
| 240 s | tier 2 viewport poll | 3,986 → 3,984 |
| 310 s | tier 1 global poll, 13,573 aircraft | 3,984 → 3,980 |

Extrapolated burn: **roughly 3,150 credits/day against a 3,072 projection** —
within a few percent, and the difference is the ±10% jitter on a small sample
of intervals. The budget model holds.

### 9.4 Real data shape — close to what we assumed

13,541 aircraft in one global response.

| Field | Null rate |
|---|---|
| `altitude` | 1 of 13,541 (0.007%) |
| `velocity` | 1 of 13,541 (0.007%) |
| `heading` | 0 of 13,541 |
| callsign (label fell back to id) | 200 of 13,541 (1.5%) |
| `onGround` true | 1,101 of 13,541 (8.1%) |

108 distinct origin countries, including long forms like "Kingdom of the
Netherlands" that the fixture never contained. All handled without incident.

Nulls are **far rarer than the fixture implies** — the fixture deliberately
over-represents them (D8), which is the right bias for a test fixture.

### 9.5 Real traffic clustering vs the thinning grid — holds up

This was the untested case: synthetic data was spread evenly, real traffic
clusters hard.

| Measure | Value |
|---|---|
| Occupied 10°×10° cells | 148 of 648 (22.8%) |
| Busiest cell (30°N, 90°W) | 1,295 aircraft, 9.6% of all traffic |
| Top 10 cells | 7,504 of 13,541 — **55.4% of world traffic** |
| CONUS bounding box alone | 7,489 of 13,537 |

After thinning 13,541 → 2,000:

| Measure | Result |
|---|---|
| Occupied cells retained | **148 of 148 — none erased** |
| Sparse cells (≤5 aircraft) retained | **54 of 54** |
| Busiest cell's share | 9.6% → **2.1%** |

The grid does exactly what D28 claimed: dense regions are reduced rather than
allowed to dominate, and quiet regions survive intact. This is the single most
valuable result of the live run, because it is the case no earlier test covered.

### 9.6 Performance on live data — matches the synthetic benchmark

| Measure | Synthetic | Live |
|---|---|---|
| Marker update, 2,000 markers | 0.80 ms | **0.82 ms** (4.9% of a frame) |
| Draw calls | 5 | **4** (no route selected) |
| `GET /api/aircraft` (globe, thinned) | — | **35 ms**, 328 KB |
| `GET /api/aircraft?bbox=` (Europe) | — | **7 ms**, 52 KB |

The frontend correctly reported *"2,000 aircraft — showing a sample of 13,537
in view"*, and detail and search both worked against live records (BAW667,
ICAO24 `4079f7`, 11,933 m, 219 m/s, 313° NW, origin United Kingdom).

### 9.7 Defects found by the live run — both fixed

Both were left unfixed during the run itself, so that §9.1 to §9.6 describe one
consistent build. They were fixed immediately afterwards and re-verified
against the live API.

**Defect 7 — responses were not compressed.** Fixed with `GZipMiddleware`.
Re-measured against live data:

| | Before | After |
|---|---|---|
| 2,000-object response | 328 KB | **67 KB** (20.4%) |
| At a 10 s client poll | 1.9 MB/min | **0.39 MB/min** |

**Defect 8 — application logging was never configured.** Every `logger.info` in
the poller and provider was created and discarded: Python attaches no handler
to the root logger by default, and uvicorn configures only its own loggers.
D23 requires the credit balance to be *logged*, and the log line did not exist.
Fixed by `app/logging_config.py`. Verified live — this is real output from the
fixed build:

```
INFO  app.ingestion.poller   poller started: provider=opensky preset=authenticated
                             jobs=['global', 'viewport'] projected=3072 credits/day
INFO  app.providers.opensky  obtained OpenSky token, valid for 1800s
INFO  app.providers.opensky  OpenSky credits remaining: 3888 (last request cost ?)
INFO  app.ingestion.poller   job=global applied=13121 objects=13121 credits=3888
```

(`last request cost ?` on the first poll is correct — there is no earlier
balance to difference against.)

**Both are now covered by tests** (`test_app_surface.py`), because neither was
catchable before: nothing asserted on response encoding, and nothing asserted
on log output. That includes a test that no log line ever carries the client
secret or the access token.

### 9.8 Observations, not defects

- **`objectCount` exceeds the per-poll count.** Health reported 14,863 objects
  while the last poll returned 13,573. That is the merge design working as
  intended (D26): objects persist for their TTL after dropping out of a
  response, so the store holds a superset. Worth knowing before someone reports
  it as a bug.
- **Thinning systematically drops unknown-altitude aircraft.** `rank_key` sorts
  them last, so at 13,541 → 2,000 the single null-altitude object never
  survives. Defensible — we know least about those — but it means the frontend's
  "unknown altitude" marker colour will rarely be seen on a global view.

### 9.9 Still unverified

- **Token refresh across the 30-minute boundary** (§9.1).
- **HTTP 429 handling and `X-Rate-Limit-Retry-After-Seconds`.** Never triggered;
  the run stayed far inside quota. Unit-tested against a mock only.
- **The throttle ladder under real depletion** (D23). Never exercised, since the
  balance never fell below 99% of the allowance.
- **A real upstream outage.** The outage tests inject failures; OpenSky did not
  actually go down during the run.

These are all failure paths, which is exactly the category hardest to verify
without waiting for a failure. The team should decide whether unit-level
coverage of them is sufficient for sign-off.
