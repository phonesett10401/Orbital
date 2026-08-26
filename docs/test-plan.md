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

### 9.9 Still unverified after this run

At the time of §9 these were all open. **§10 closes the first and third.**

- ~~Token refresh across the 30-minute boundary~~ — verified, §10.1 and §10.4.
- ~~The throttle ladder under real depletion~~ — verified, §10.2 and §10.3.
- **HTTP 429 handling.** Still mock-tested only, and deliberately so: reaching
  it requires exhausting the daily allowance. See §10.5 and D39.
- **A real upstream outage.** The outage tests inject failures; OpenSky has not
  gone down while we were watching. Not something we can schedule.

---

## 10. Live failure-path verification

The three paths that only run when something goes wrong, and were therefore the
weakest-covered in the project. Reproduce with:

```bash
cd backend && .venv/Scripts/python scripts/verify_token_refresh.py
cd backend && .venv/Scripts/python scripts/verify_failure_paths.py
```

Reasoning behind what was and was not attempted is in D39.

### 10.1 OAuth2 token refresh — verified against the live endpoint

The highest-risk unknown: tokens last 30 minutes and a demo can run longer.

| Check | Result |
|---|---|
| Forced refresh issues a **different** token | Yes — `b5ed9e50…` → `1c2b63ce…`, both 1,445 chars |
| A request authenticated with the new token succeeds | Yes |
| Inside the refresh window, the cached token is reused | Yes |
| Past the deadline, a new token is issued by the real endpoint | Yes — `2921ca60…` |
| Refresh deadline is lifetime minus the safety margin | 1,740 s of a nominal 1,800 s |
| Natural refresh, unattended, past the real deadline | Yes — at 30.1 min (§10.4) |

Tokens are never printed. The script compares truncated SHA-256 fingerprints,
so two tokens can be shown to differ without either being disclosed.

### 10.2 Throttle ladder — verified against a real credit balance

The balance is genuine, read from the live `X-Rate-Limit-Remaining` header;
only the allowance it is compared against is varied. That walks a real balance
through every band without spending a credit to get there (D39).

Live balance at time of test: **3,814 credits.**

| Allowance | Fraction remaining | Level | Interval × | Tier 2 | Polling |
|---|---|---|---|---|---|
| 7,628 | 50.0% | `normal` | 1 | yes | yes |
| 15,256 | 25.0% | `reduced` | 2 | yes | yes |
| 30,512 | 12.5% | `minimal` | 4 | **skipped** | yes |
| 152,560 | 2.5% | `critical` | 8 | **skipped** | yes |
| 762,800 | 0.5% | `exhausted` | ∞ | **skipped** | **stopped** |

Degrades in the documented order (D23): the latency tier is cut before the
coverage tier, and polling stops last.

### 10.3 The poller acts on the throttle, it does not merely report it

Tier 1's base interval is 300 s.

| Level | Tier 2 | Tier 1 | Next tier 1 delay |
|---|---|---|---|
| `normal` | polled | polled | 316 s |
| `minimal` | skipped | polled | **1,303 s** |
| `exhausted` | skipped | **stopped** | 871 s |

A skipped tier 2 job returns its *base* interval rather than a multiplied one,
which is correct — it is not polling, so the delay only governs how often it
re-checks whether it should.

### 10.4 Natural refresh over a full token lifetime — verified

A 33-minute unattended run, polling every 150 s, watching for the provider to
refresh on its own.

| | |
|---|---|
| Refresh deadline | 1,740 s (**29.0 min**) — 1,800 s lifetime minus the 60 s margin |
| Refresh observed at | **30.1 min**, poll 12 — the first poll after the deadline |
| Token fingerprint | `57f03bdc2654` → `63c4303346fe` |
| That poll still returned data | Yes, 9 aircraft |
| Polls after refresh | Continued on the new token, no interruption |
| Total | 13 polls over 32.6 min, **zero failures**, 32 credits |

```
01:11:56  poll  11 (27.6 min)   8 aircraft  credits=3742  token=57f03bdc2654
01:14:28  poll  12 (30.1 min)   9 aircraft  credits=3741  token=63c4303346fe  <-- TOKEN REFRESHED
01:16:58  poll  13 (32.6 min)  11 aircraft  credits=3740  token=63c4303346fe
```

**This closes the highest-risk unknown in the project.** A demo running past 30
minutes will refresh its token without anyone noticing, which is exactly the
behaviour D24 specified and the only behaviour that had never been observed.

Worth noting *why* the refresh landed at 30.1 rather than 29.0 minutes: the
provider refreshes lazily, on the next request after the deadline, not on a
timer. With a 150 s poll interval the worst-case lag is one interval. Under the
real tier 1 cadence of 300 s that lag could be up to five minutes — still
harmless, because the margin exists precisely to absorb it, but it means the
refresh is triggered by traffic rather than scheduled.

### 10.5 HTTP 429 — deliberately not verified

A bounded burst test established that **OpenSky does not rate-limit short
bursts**: 25 requests in 6.0 s (4.2 req/s) drew no 429. The 429 path is
therefore reachable only by exhausting the daily allowance, which costs the
whole day's quota and locks the account out until reset.

That trade is not worth one code path, so 429 handling remains mock-tested
(`test_opensky.py`). The limitation is stated plainly in D39, along with its
uncomfortable corollary: **the failure most likely to happen in practice is the
one we cannot afford to rehearse.**

The burst result matters on its own. Upstream will not stop a runaway poll
loop — it will simply let it spend the day. The startup budget validation
(D22) and the throttle ladder (D23) are the only guards.
