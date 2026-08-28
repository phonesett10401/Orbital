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
| 2 | Test plan executed, no open critical or high defects | **Met** — one open defect, low and visual | §3, §6 |
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
| Aircraft markers on the globe | `globe/markers.ts` | `markers.test.ts` + offscreen pixel readback (§11) |
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
| Selected aircraft as a 3D model | `globe/selectedAircraft.ts` | `selectedAircraft.test.ts` (50 tests) + offscreen pixel readback (§13) |
| Country borders and geography labels | `globe/borders.ts`, `globe/labels.ts` | `borders.test.ts`, `labels.test.ts` + offscreen pixel readback (§14) |
| Airline decoded from the callsign | `airlines.ts`, `DetailPanel.tsx` | `airlines.test.ts` (21 tests) + a real selection in the running app (§15) |
| Conditional requests on the polled endpoint | `api/etag.py`, `api/aircraft.py` | `test_etag.py` (26 tests) + `benchmarks/bench_conditional.py` (§16) |
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
| `test_poller.py` | 44 | Scheduling, retry, backoff, throttling, **outage** |
| `test_thinning.py` | 26 | Grid, ranking, stability, determinism |
| `test_api.py` | 43 | Endpoints, envelopes, errors, **outage over HTTP** |
| `test_app_surface.py` | 17 | **Response compression and log output** |
| `interpolate.test.ts` | 29 | Dead reckoning, easing, extrapolation limit |
| `sun.test.ts` | 11 | Solar declination and subsolar longitude |
| `viewport.test.ts` | 14 | Camera-to-bbox conversion |
| `pointer.test.ts` | 17 | **Click-to-select through real DOM events** |
| `markers.test.ts` | 28 | Pick tolerance, horizon test, **sizing model, sprite selection** |
| `route.test.ts` | 13 | Great-circle geometry, antimeridian, colour |
| `store.test.ts` | 18 | Snapshot application, selection races, layers |
| `lighting.test.ts` | 29 | **Terminator geometry, the shader's coordinate frame, the glint's tuning** |
| `selectedAircraft.test.ts` | 54 | **Airframe shape and heading basis, sprite handoff, sizing in screen pixels** |
| `borders.test.ts` | 17 | **Lon/lat densification, the border shell, the vertex budget** |
| `labels.test.ts` | 42 | **Altitude tiers, the horizon and frustum tests, collision and caps** |
| `airlines.test.ts` | 21 | **The callsign decode rule, the id guard, one-shot table loading** |
| `cityMode.test.ts` | 19 | **Scale matching across the renderer hand-off, hysteresis, lazy loading, aircraft** |
| `planet.test.ts` | 53 | **The MapLibre style and source resolution, cartography over imagery, aircraft as GeoJSON, bounds, diagnostics, container sizing** |
| `test_etag.py` | 26 | **What goes into a validator, and the 304 path end to end** |
| **Total** | **688** | 321 backend, 367 frontend |

### What the automated suites do not cover

Stated plainly, because a test plan that implies total coverage is worse than
one that admits its gaps:

- **Rendering output.** No test in either suite runs a shader — there is no GL
  context under vitest. What appears on screen is verified by pixel readback
  from the running application (§11.1, §12.2) and by reading the shader source
  for properties, such as its coordinate frame, that a source can carry (§12.1).
- **Live OpenSky behaviour.** All provider tests run against a mock transport
  built from one recorded response. Real API quirks are unverified (§7).
- **React component rendering.** Components are exercised manually and through
  the store; there are no DOM-rendering tests for them. The pointer path is the
  exception, because that is where a bug hid (§6).
- **Wiring, in general.** Eight of the eighteen defects in §6 were cases where
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

Recorded because most of them were invisible to the test suites, which is
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
| 9 | **The globe was lit in view space, so the terminator followed the camera and the planet rendered as night at every rotation** — wrong since M4 | Critical | Looking at the running app (D41) | Fixed |
| 10 | **The selected aircraft model grew without limit on approach** — its pixel ceiling was evaluated against the distance to the globe's centre instead of to the model, so the clamp could never bind | High | Offscreen pixel readback (D43, §13.2) | Fixed |
| 11 | **The camera could fly inside the marker shell**, so anything directly beneath it vanished at closest zoom — sprites included; latent since D36 | High | Offscreen pixel readback (D43, §13.2) | Fixed |
| 12 | Specular highlight is far too strong — reads as a white blob rather than sun glint: 18° of arc across, 9.6% of the visible disc, 17× the brightness of the ocean under it | Low, visual | Looking at the running app (D48, D49, §17) | Fixed on the **second** attempt. The first retune improved every measured number and was still rejected on sight — see §17.5 |
| 13 | **Every geography label stacked in the top-left corner** through a camera whose container reported zero width: aspect `0/0` made each projection NaN, and NaN passed both bounds tests because every comparison against it is false | Medium | Running the app (D45, §14.5) | Fixed |
| 14 | **The status bar's data age froze at a few seconds** once the list endpoint became conditional: a 304 returns the client's own cached body, whose `ageSeconds` was measured on first fetch, while the arrival time reset every poll. Backend said 107.6 s, the bar said 1 s | Medium | Running the app (D47, §16.4) | Fixed |
| 18 | **The map turned white on the way in** — imagery faded out at zoom 7.5 and the vector basemap's `#f8f4f0` background became the ground | High, visual | Four screenshots from Phone (D56, §19.6) | Fixed |
| 17 | **The MapLibre map rendered into a container collapsed to zero height** by MapLibre's own stylesheet winning the cascade — no error, no failed request, a blank screen | High | A screenshot from Phone (D55, §19.5) | Fixed |
| 16 | **City mode handed over at 0.05 radii, where the globe texture is 36 texels per screen pixel** — so the whole approach was spent looking at a magnified smear, and a failed hand-off left the layer permanently active with no map and no retry | Medium, visual | Two screenshots from Phone (D53, §18.6) | Fixed |
| 15 | **The selected aircraft's nose and tail cones were built inside out** — each pinched to a needle where it met the fuselage and flared open at the tip, so the model read as a dart with a fork on the front | Medium, visual | A screenshot from Phone (D50, §13.4) | Fixed |

**Defect #12 took two retunes**, and the second one is the interesting half:
the first improved every number the probe reported and was rejected on sight
anyway, because no number measured the highlight against the ocean beneath it
(§17.5).

**Defect #12 was a retune, not a repair.** The maths was always right — the
highlight moved correctly with the camera — so it was a problem of strength and
falloff rather than of coordinate frames, and not a recurrence of #9. The water
mask was ruled out early by sampling `earth-water.png` at ten known points, and
that ruling held: the fix was two numbers, an exponent from 60 to 400 and a
strength from 0.6 to 0.35, chosen against a measured sweep (§17). The
camera-invariance spread §12.2 recorded as "specular doing its job" was both
that and the defect: it has fallen from 0.38 to 0.07 at the subsolar point and
to zero at points the highlight should never have reached.

**No open defects at any severity.** Two features are measured but have not
been looked at by a human — the selected aircraft model (§13.3) and the
geography layers (§14.6), and now the retuned glint (§17.4). That is a gap in
verification, not a known defect.

Defects 3 through 11 and 13 through 15 all passed every automated test at the
time they existed, and #12 was invisible to one for a different reason: nothing in
either suite can render, so a highlight's size was not a quantity any test
held an opinion about until the offscreen probe made it one.
The pattern is consistent: in each case the *code* was correct and the *wiring*
was absent or mismatched — a threshold that no reachable zoom satisfied, a
raycast tolerance in the wrong unit, a middleware never registered, a logger
with no handler. Unit tests verify code. Only running the system verifies
wiring.

Defects 10 and 11 are the same shape one level down: not a wrong formula but a
**correct formula fed the wrong argument**, and two numbers with a required
relationship written down independently. Both were invisible to the 38 tests
that shipped with the feature, all of which passed throughout.

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
| 1a | Rotate the globe a full turn | The lit hemisphere stays put over the same countries; it does **not** follow the camera, and the two poles are never dark at once (D41) |
| 2 | Drag the globe | Rotates smoothly; no marker is selected on release |
| 3 | Scroll to zoom | Zooms in and out; markers scale with distance |
| 4 | Read the status bar | Aircraft count, data age, source name |
| 5 | Click a marker | Detail panel opens with callsign, altitude, speed, heading, origin country |
| 5a | Look at the selected aircraft, zoomed out and on a close approach | Its disc is replaced by a 3D airframe pointing along its track, legible at both ends of the zoom range and over the night side, sitting above the terrain rather than in it; the swap does not jump. **Checked 2026-08-28** (§13.4) |
| 6 | Check the route | Polyline follows the observed track; caveat text is visible |
| 7 | Click empty space | Panel closes |
| 8 | Search a callsign | Ranked results; Enter picks the top hit |
| 9 | Pick a search result | Camera flies to it and it is selected |
| 10 | Search nonsense | "No match", not an error |
| 11 | Stop the backend | Markers stay; status bar reports the backend unreachable |
| 12 | Restart the backend | Recovers without a page reload |
| 13 | Open `/api/health` | `status: ok`, both jobs listed, quota projection shown |
| 14 | Zoom in tight, wait ~90 s, recheck health | Viewport job shows a successful poll |
| 15 | Run `__orbital.probeLighting()` in the console | Camera-invariance spreads at or below ~0.02, ignoring the specular outlier (§12.2) |
| 16 | Look at the borders at default zoom | A faint hairline, one weight everywhere, no brighter along internal borders; none visible on the far side of the globe |
| 17 | Zoom from the whole planet to the closest view | Names resolve progressively: a few countries, then more countries and large cities, then smaller cities, then airport codes. Nothing pops in at the limb and nothing overlaps |
| 18 | Drag the globe quickly | Labels track the planet without lagging behind it, and disappear as they cross the limb rather than sliding over the edge |
| 19 | Watch a label over ice, over ocean, and over the night side | Legible in all three; the halo carries it |
| 20 | Click an aircraft with an airline callsign | The panel shows an Airline row naming the carrier and the designator it came from, and a line saying the value was decoded rather than reported |
| 21 | Click an aircraft whose label is its ICAO24 address | No Airline row and no caveat — nothing is guessed from an address |
| 22 | Watch the backend's access log while the app polls | Most polls answer `304 Not Modified`; a 200 appears when the poller refreshes the store. Devtools shows 200s throughout, which is the cache resolving the 304 (§16.3) |
| 23 | Leave the app open for two minutes without touching it | The status bar's data age counts up past the poll interval and keeps climbing, rather than resetting to a few seconds every ten seconds (§16.4) |
| 24 | Rotate the sunlit ocean under the camera | A faint sheen travels with the camera over water — around 3° of arc, a little brighter than the sea it sits on, never a glowing ball — and never spills onto land or into the night side (§17.5). `__orbital.earth.setGlint(strength, shininess)` retunes it live |


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


---

## 11. Directional markers

Markers are plan-view airliner silhouettes rotated to their direction of
travel, drawn as one `THREE.Points` in a single draw call. Design and reasoning
in D40.

### 11.1 Rotation correctness — verified by pixel readback

Rotation cannot be checked by eye: markers that are uniformly reversed still
rotate correctly with heading and look entirely plausible. So it is measured.
A single aircraft is rendered to an offscreen target, the pixels are read back,
and the silhouette's alpha-weighted centroid — which sits toward the tail — is
compared against the expected nose direction.

| Location | Headings checked | Worst error |
|---|---|---|
| 0°N 0°E | 0, 90, 180, 270 | 0.0° |
| 50°N 8°E | 0, 45, 90, 135, 225, 315 | 0.0° |
| 33°S 151°E | 0, 270 | 0.0° |
| 70°N 40°W | 45 | 0.0° |
| 60°S 70°W | 315 | 0.0° |
| 85°N 20°E | 120 | 0.0° |

**This found a real defect.** `THREE.CanvasTexture` inherits `flipY = true`, so
the atlas was uploaded vertically mirrored and every aircraft flew tail-first.

It also produced a **false positive worth recording**: an early run showed
cardinal headings exact and every diagonal off by 15.6°. That was the *probe*,
not the shader — it rendered into a square target while the camera's projection
matrix was still 16:9. The signature gave it away: `atan2(1.778, 1) = 60.6°`,
exactly the value measured for a true 45°. A measurement harness is code too,
and an aspect-ratio mismatch in the harness looks identical to one in the
shader.

### 11.2 Sizing model

World-anchored, not screen-anchored: the sprite is pinned to a size on the
ground, so it grows as the camera descends (D40).

| camera distance | sprite |
|---|---|
| 800 (fully out) | 5 px (floor) |
| 500 | 6 px |
| 320 (default) | 10 px |
| 200 | 15 px |
| 100.5 (closest) | 31 px |

Floor 5 px, ceiling 44 px, both in CSS pixels and scaled by device pixel ratio.
GPU `ALIASED_POINT_SIZE_RANGE` checked before committing: 1–1024 on this
machine.

### 11.3 Hit tolerance across the full zoom range

Re-measured after the change, because D34 was exactly this class of bug. The
tolerance is the larger of the fixed 12 px radius and half the drawn sprite.

| camera distance | sprite | hit radius |
|---|---|---|
| 800 | 5 px | 13 px |
| 500 | 6 px | 15 px |
| 320 | 10 px | 17 px |
| 200 | 15 px | 24 px |
| 140 | 22 px | 43 px |
| 100 | 31 px | ≥60 px |

Never below 13 px, never smaller than the sprite drawn, no dead zones at any
reachable zoom.

### 11.4 Performance against the 0.82 ms baseline

| Configuration | 2,000 markers |
|---|---|
| Plain dots (previous baseline) | 0.82 ms |
| Silhouettes, all attributes rewritten each frame | **1.05 ms (+28%)** |
| Silhouettes, attributes split by update frequency | **0.79 ms (−4%)** |

The regression was real and was fixed rather than accepted: only position
changes every frame, so colour, heading, sprite cell, size and the stale flag
are rewritten only when the object set, selection or staleness bucket changes.
Steady state is now faster than the dots it replaced, drawing considerably
more. Draw calls unchanged at 4 (5 with a route shown).

### 11.5 Unknown heading

Aircraft reporting no heading draw a **solid disc** rather than a silhouette —
a shape with no direction, because a silhouette pointing somewhere would be a
claim the data does not support. About one aircraft in a thousand in live data
(§9.4).

Both shapes and the altitude colour ramp are declared in an on-screen legend.

---

## 12. Globe lighting

The day/night terminator, after the defect recorded in D41: the globe was lit
by dotting a view-space normal against a world-space sun, so the lit region
followed the camera and the planet read as night at every rotation.

### 12.1 What the automated suite covers

`lighting.test.ts`, 24 tests, no GL context required.

| Group | Tests | What it pins |
|---|---|---|
| The sun direction | 4 | Points at the subsolar point, unit length, depends only on the date |
| Terminator position | 4 | Sun overhead at the subsolar point, underfoot at the antipode, a quarter turn to the terminator |
| Always half lit | 2 | A lit point and a dark point at every sampled instant; 48–52% of the surface lit, area-weighted |
| Poles at the solstices | 5 | Midnight sun in June, reversed in December, never both poles dark at once |
| Shader coordinate frame | 7 | No `normalMatrix` in the globe shaders, sun dotted against `vWorldNormal`, no view-space varying in the lighting, world-space specular |
| Material uniforms | 2 | The uniform follows the date; surface and halo share one sun vector |

Sampled across 24 dates spread over a year and around the clock.

**Which half is the regression.** Run against the pre-fix shader, the five
source-level assertions fail and the nineteen geometry tests pass. The geometry
tests describe the astronomy, which was never wrong; they guard against future
drift. The source assertions are what would have caught this defect.

### 12.2 Rendered output — verified by pixel readback

`lightingProbe.ts`, committed and run from the console against a dev server:

```
__orbital.probeLighting()
```

It renders the real scene with the real material through a real GL context into
a 512×512 offscreen target, reads the pixels back, and measures the light. The
atmosphere, star field, markers and route are hidden while measuring, so only
the Earth is in frame.

Measured 2026-08-26, sun pinned to 2026-08-26T09:30Z, subsolar point
10.34°N 37.96°E.

**Camera invariance — the headline.** The same surface texel, the same instant,
viewed from up to nine camera orientations. Under the defect this is exactly
what varied.

| Point | Expected lambert | Views | Luminance spread |
|---|---|---|---|
| 0°N 38°E | +0.98 | 7 | 0.017 |
| 0°N 98°E | +0.49 | 7 | 0.082 |
| 40°N 2°W | +0.69 | 9 | 0.022 |
| 30°S 158°E | −0.52 | 9 | 0.000 |
| 55°N 152°W | −0.41 | 9 | 0.000 |
| 0°N 142°W | −0.98 | 7 | 0.001 |

Every point holds its brightness to within 0.022 across every view that can see
it. The one outlier, 0.082 at 0°N 98°E, is the specular highlight on water,
which is *supposed* to depend on the view direction — it is Blinn-Phong doing
its job, over the Bay of Bengal.

**The light comes from the sun's side.** Mean disc luminance from a fixed
camera, with the sun in front of the planet and then twelve hours later with it
behind. Same camera, same texels, so the texture cancels in the ratio.

| Camera over | Sun in front | Sun behind | Ratio |
|---|---|---|---|
| 0°N 0°E | 0.056 | 0.012 | 4.53 |
| 0°N 90°E | 0.044 | 0.013 | 3.51 |
| 0°N 180°E | 0.007 | 0.016 | 0.46 |
| 0°N 90°W | 0.009 | 0.020 | 0.43 |
| 45°N 30°E | 0.086 | 0.024 | 3.53 |

The ratio's direction matches which side the sun is on in every case. The two
polar orientations come out near 1.0 and are excluded above: a view down a pole
sees day and night together whichever way the sun points, so the measurement
has nothing to say there.

**The polar caps at the solstices.** The same cap at both solstices — identical
texels, opposite illumination. Comparing the two *caps* instead would compare
Arctic sea ice against the Antarctic ice sheet, which differ by more than the
sun does; that mistake is what produced the first, inverted-looking run.

| Cap | June | December | Polar day / polar night |
|---|---|---|---|
| North (72–88°N) | 0.079 | 0.038 | 2.08 |
| South (72–88°S) | 0.054 | 0.327 | 6.09 |

**The terminator, by eye on the pixels.** With the camera fixed over 0°N 180°E
and only the sun moved, the disc is uniformly dark with the sun on the far side
and carries a bright region with it on the near side. Under the defect the
bright patch stayed at the centre of the frame in both.

### 12.3 What the probe defends against

Three confounds, each of which produced a confident wrong answer before it was
found. They are the reason the harness is longer than the fix.

| Confound | Wrong answer it produced |
|---|---|
| The atmosphere shell left visible | The sunward hemisphere measured as dark — true of a back-side additive halo, false of the Earth |
| three-globe's build-in tween never running, because `requestAnimationFrame` does not fire in a hidden tab | Numbers reported about a frame containing no planet, while every object still reported `visible: true` |
| Absolute brightness read as illumination | Sunlit deep ocean is darker in linear light than the night texture over the same water, so night measured brighter than day |

The probe now asserts its own preconditions — the globe must be at its full
world radius and every precondition sample must land on the planet — and every
comparison is either of one texel against itself or an aggregate over hundreds
of samples.

This is the third time in this project that a measurement harness has been the
thing that was wrong, after the aspect-ratio error in §11.1 and the health
semantics in D29. **A measurement that disagrees with the code is evidence
about both.**

---

## 13. The selected aircraft model

Task 3 draws the selected aircraft as a low-poly 3D airframe and hides its
sprite for as long as it is selected (D42). Everything below was measured on
2026-08-27 against commit `7a96a3e`.

### 13.1 What the automated suite covers

`selectedAircraft.test.ts`, 50 tests. The load-bearing ones are the ones that
cross a boundary, because that is where this project's defects live:

| What is pinned | Why it matters |
|---|---|
| The mesh's tangent frame agrees with the marker vertex shader's, the GLSL transcribed into TypeScript rather than imported from a shared helper | A shared helper would make the test pass by construction. If the frames drift, a selected aircraft snaps to a different heading the instant it is clicked, and either one inspected alone looks correct |
| A heading of exactly `0` still draws | The falsy check that would silently refuse every aircraft flying due north |
| The basis is a rotation, not a reflection | A mirrored airframe is entirely plausible and entirely wrong — the same trap as the atlas's `flipY` (D40) |
| The tallest vertex lies aft of centre | The model cannot be authored nose-backwards |
| The mesh is placed exactly where the sprite would have been | No jump at the moment of selection |
| A null heading yields no model and keeps the disc | A mesh commits to a direction on screen; a null heading has none to commit to (D18) |
| The ceiling and floor hold **in screen pixels** across the reachable camera range, driven through `update()` with the camera on the ray through the aircraft | This is the check D42's suite did not have, and defect #10 is what lived in the gap |
| One test reproduces defect #10 by deliberately passing the centre distance | The distinction cannot be quietly undone |
| `minDistance` keeps the camera outside the marker shell, and the visible cap at that distance stays under the backend's 400 square-degree viewport threshold (D36) | Two numbers with a required relationship, asserted rather than written down twice |

### 13.2 Rendered output — verified by offscreen pixel readback

Neither browser surface rendered this session: the in-app pane does not
composite, so `requestAnimationFrame` never fires and the build-in tween never
completes, and the Chrome extension reported "not connected". The scene was
therefore rendered into a `WebGLRenderTarget` and the pixels read back, which
needs no rAF. Unlike `lightingProbe.ts` this harness was ad hoc and is not
committed; §12.2's probe remains the committed one.

| Property | Result |
|---|---|
| Sprite handoff | Sprite counts run 157 → 156 → 157 across select and deselect, with no frame drawing both |
| Heading | Nose points along the ground track to within **1.3°** across nine positions and headings, equator to 85°N — matching the sprite's `90 − heading` exactly, so there is no snap on selection |
| Occlusion | Drawn on the near side, hidden at the limb and on the far side |
| Silhouette | Reads as a plan-view airliner: fuselage, full-span wings mid-body, tailplane aft, nose forward |
| Null heading | No model; the disc stands |

**Sizing, before and after the D43 fix**, measured as wingspan in pixels at a
300 px viewport. `MODEL_MIN_PX` is 16 and `MODEL_MAX_PX` is 96:

| Camera distance | Before | After |
|---|---|---|
| 320 (default) | 24 px | 16 px |
| 180 | 36 px | 30 px |
| 140 | 60 px | 60 px |
| 120 | **124 px** | 96 px |
| 105 | **300 px, clipping the viewport** | — |
| 101.4 (closest reachable) | **0 px** | 96 px |

The two failures in that column are defects #10 and #11. The `0 px` row is #11:
the camera had been allowed to 1.005 R while the marker shell sits at 1.012 R,
so at closest zoom the camera was inside the shell and anything beneath it fell
behind the near plane. That affected sprites identically and had been latent
since D36; the model only made it visible, because one missing aircraft is
invisible and one missing *selection* is not.

### 13.3 What was still outstanding, and what it found

**Nobody had looked at it.** The probe settles placement, orientation,
occlusion and size in pixels, and cannot settle appearance. That was recorded
here as outstanding rather than assumed, on the grounds that by this project's
own record — defects 5, 6 and 9 were all invisible to a green suite — it is the
check that finds the defect.

It found the defect. §13.4.

---

## 14. Geography: borders and labels

Task 4 adds two layers, one GL and one DOM: country boundaries as a single
`THREE.LineSegments`, and country, city and airport names as pooled DOM
elements above the canvas. Reasoning in D44 and D45. Measured on 2026-08-27.

### 14.1 The data, and what it costs

Generated from dev dependencies by `npm run geography`, which also runs before
`npm run dev` and `npm run build`. Nothing is fetched at runtime beyond the two
generated files, and nothing here spends an API credit.

| | |
|---|---|
| Source | Natural Earth 110m (`world-atlas`), GeoNames (`all-the-cities`), OurAirports (`@nwpr/airport-codes`) |
| `borders.json` | 595 arcs, 8,246 points, 117 KB |
| `labels.json` | 177 countries, 4,442 cities, 4,072 airports, 629 KB (187 KB gzipped) — see §14.7 |
| Build time | ~5 s |
| Densified geometry | 20,082 vertices, 235 KB of positions, **one draw call** |
| Border build, in the browser | 5.6 ms, once, at load |

### 14.2 What the automated suite covers

`borders.test.ts` (17 tests) and `labels.test.ts` (39 tests). The ones that
carry weight:

| What is pinned | Why it matters |
|---|---|
| A densified border holds its parallel, and a transcribed great circle would not | Copying `route.ts` here would bow the 49th parallel 12 km into Canada. Both interpolations are correct for something; only one is correct for a boundary |
| No segment midpoint falls inside the globe | The step size and the shell height are a pair. Either alone is meaningless |
| The vertex count stays under 30,000 | A resolution change is a fiftyfold cost change and should not pass unnoticed |
| A segment jumping the antimeridian is dropped | The same stripe-across-the-map failure the route layer has (D6) |
| The horizon test cuts at the tangent, `acos(r/d)`, not at 90 degrees | A hemisphere test passes with a wrong constant and lets a quarter of the far side through |
| A point behind the camera projects to null | Projection reports it as plausible coordinates in the opposite corner |
| **A NaN projection returns null** | Defect #13 below |
| Airports never exceed eight, other classes are not capped | The ranking cannot order airports within one city (D44) |
| Labels are re-tested against the horizon every frame, not only at selection | Between selections the camera keeps moving; a label that has crossed the limb must go now |
| The generated files are sorted by rank, and the United States anchor is on land | `candidatesFor` relies on the sort; the anchor is the case that forced the largest-polygon rule |

The two suites that read `public/geo/` skip themselves when it is absent: a
fresh checkout has not run the build step yet, and a red suite there would be
reporting on the build, not on this code.

### 14.3 Label density, measured

Real dataset, camera over central Europe, 1600x900 viewport. "Candidates" is
what the altitude tier admits; "drawn" is what survives the horizon test, the
frustum, collision rejection and the caps.

| Altitude, radii | Candidates | Drawn |
|---|---|---|
| 4.0 | 0 | 0 |
| 2.0 | 12 | 7 |
| 0.9 | 76 | 17 |
| 0.5 | 76 | 8 |
| 0.3 | 393 | 25 |
| 0.1 | 1,422 | 12 |
| 0.05 | 1,422 | 4 |
| 0.014 (closest) | 1,422 | 0 |

The fall at the bottom is geometry, not a bug: at 0.014 radii the camera is
1.4 units above a 100-unit globe and the view is about 80 km across. Over a
city rather than over farmland the same altitude draws nine — London at 0.014
gives `London, LCY, LHR, BQH, FAB, BBS, SEN, NHT, HYC`.

Per-frame cost, same dataset:

| | Before the candidate cache | After |
|---|---|---|
| Selection pass (every 200 ms) | 0.599 ms | **0.061 ms** |
| Reprojection only (every frame) | 0.110 ms | **0.033 ms** |

### 14.4 Rendered output — verified in the running application

The in-app browser pane still does not composite, so `requestAnimationFrame`
never fires and screenshots time out. Two techniques worked around it, and both
found something.

**Labels, against globe.gl's own projection.** The layer computes screen
positions itself rather than asking globe.gl, so the check is the one D32 used
for markers: compare against `world.getScreenCoords()` for the same lat/lon.
Six country labels in the live page, agreement within one pixel on both axes:

| Label | Ours | `getScreenCoords` |
|---|---|---|
| Russia | 728.5, 160.7 | 729, 161 |
| Brazil | 431.1, 409.1 | 431, 409 |
| India | 850.2, 270.1 | 850, 270 |
| Kazakhstan | 785.9, 181.8 | 786, 182 |
| Dem. Rep. Congo | 759.5, 374.8 | 759, 375 |
| Algeria | 651.9, 221.0 | 652, 221 |

**Borders, by offscreen pixel readback.** The real scene rendered into a
512x512 `WebGLRenderTarget` from a camera over 48N 10E at 200 units, with the
layer visible and then hidden. The globe's build-in tween had not run — the
globe group was still at scale 1e-6, exactly the confound §12.3 records — so
the probe sets it to 1 before measuring.

| Measurement | Result |
|---|---|
| Pixels changed by the layer | 9,398 of 262,144 |
| Of those, brighter | 9,383 |
| Of those, bluer | 9,398 — the layer's colour is `#8fb3d9` at 0.28 opacity |
| Two identical renders | **0 pixels differ** — no z-fighting stipple against the surface |
| Same render with `depthTest` disabled | 13,628 pixels, **45% more** — the extra are the far-side borders, so occlusion by the planet is working |

### 14.5 Defect found, and fixed

Defect #13 in §6. Every label projected to NaN and the layer wrote
`translate(NaNpx, NaNpx)` into forty elements, which browsers reject outright,
leaving the whole set stacked in the top-left corner rather than positioned.

The cause was upstream of the layer: a camera built while its container reports
zero width — which is what the non-compositing pane does — has an aspect of
`0/0`. The reason it survived two bounds tests is the part worth keeping:
**every comparison against NaN is false**, so `x < -1 || x > 1` rejects
nothing, and a range test silently became no test at all. The fix is an
explicit finiteness check ahead of both, and two tests build a camera with a
NaN aspect and assert that nothing is drawn through it.

### 14.6 What is still outstanding

**Nobody has looked at either layer.** The probe settles that borders are
drawn, sit above the surface without z-fighting, and are hidden by the planet;
the cross-check settles that labels land where they should. Neither settles
appearance: whether the border hairline is too faint or too strong over bright
terrain and over the night side, whether the label halo stays legible over ice
and over ocean, whether the tier thresholds feel right while zooming rather
than in a table, and whether uppercase country names read as a map or as
shouting. §8 steps 16 to 19 are the check.

---

## 15. Airline from callsign

Task 5 decodes the ICAO airline designator at the front of a callsign and shows
the airline in the detail panel. Reasoning in D46; the contract's own note on
why no layer carries an `airline` field is in `docs/data-contract.md` §2.
Measured on 2026-08-27.

### 15.1 The table

| | |
|---|---|
| Source | OpenFlights via `airline-codes`, a dev dependency |
| Generated by | `npm run airlines`, part of `npm run assets` |
| Output | `public/data/airlines.json`, gitignored like the other generated assets |
| Size | 5,774 ICAO designators, 148 KB |
| Fetched | once, on the **first selection of a session** — never, if the user selects nothing |

### 15.2 What the automated suite covers

`airlines.test.ts`, 21 tests. Almost all of them are about refusal, because
every failure mode here is a confident wrong answer nothing downstream can
detect:

| What is pinned | Why it matters |
|---|---|
| `THA932`, `UAL1`, `BAW22F` decode | The ordinary case, including a flight number with a trailing letter |
| `N466WN`, `ZSABC`, `VHXYZ`, `CGABC` do not | Registrations. Decoding one puts an airline's name on somebody's private aeroplane |
| `D-ABCD`, `OY-JJU` do not | A hyphen is never part of a designator, and feeds differ on whether they strip it |
| Eight-character padding is trimmed first | OpenSky pads every callsign |
| **A label equal to the object's id does not decode** | `label` falls back to the ICAO24 address, and `abc123` matches the decode rule exactly. A third of the address space starts with three hex letters |
| ...but the same characters as a real callsign on another aircraft still do | The guard is about identity, not about the characters |
| The table is fetched once and shared between concurrent callers | Two selections in the same second must not be two downloads |
| A failed fetch resolves to null and can be retried | An aircraft without its airline is an aircraft; a panel that throws is a broken app (D29) |
| `FDX` and `UPS` are present in the generated table | They are flagged inactive upstream, and are the reason the build step does not filter on that flag |

### 15.3 Coverage against the fixture set

Of the 157 committed fixture aircraft: **156 decode to a known airline, 1 has
no callsign at all**, and no callsign produced a designator the table does not
carry. The one without a callsign is deliberate fixture content — it exists so
the null path is exercised (D8), and it is the object the panel must show no
airline row for.

### 15.4 End to end, in the running application

Fixture backend, real frontend, a real click. Selecting `AFR9477`:

| | |
|---|---|
| Panel rows | Identifier, **Airline — "Air France from AFR"**, Altitude, Ground speed, Heading, Position, Origin Country |
| Caveat shown | "The airline is decoded from the callsign prefix, not reported by the aircraft..." |
| `GET /data/airlines.json` | fired **once**, after the first selection — not on page load |

Selecting the fixture aircraft with no callsign (`e0ge05`, whose label falls
back to its id) renders the panel with **no Airline row and no caveat**, which
is the id guard working through the whole stack rather than only in the unit
test.

### 15.5 What it deliberately does not do

**Airlines are not searchable.** Search still matches callsigns. Searching
"Lufthansa" for every DLH flight is a real feature and a different one — a
reverse index, a ranking decision between name and callsign matches, and a say
in what the result rows show. It is not smuggled in under a detail-panel task.

---

## 16. Conditional requests on the list endpoint

Task 6 gives `GET /api/aircraft` a weak ETag and a 304 path. Reasoning in D47.
Measured on 2026-08-27.

### 16.1 What it saves

`python benchmarks/bench_conditional.py`, through the real application stack —
routing, dependency injection, serialization, gzip and the response write, all
of which run on the same event loop as the poller.

| Objects held | Full 200 | 304 | Saved | Wire bytes, 200 | Wire bytes, 304 |
|---|---|---|---|---|---|
| 2,000 | 14.01 ms | **0.60 ms** | 13.41 ms (95.7%) | 29,430 (gzipped) | 0 |
| 10,000 | 18.61 ms | **0.68 ms** | 17.93 ms (96.3%) | 31,132 (gzipped) | 0 |

The client polls every 10 s while tier 1 refreshes every 300 (D21), so
twenty-nine polls in thirty hit the unchanged case: **about 389 ms of event
loop returned to the poller per thirty-poll cycle, per client**, at the 2,000
object scale the frontend actually requests.

The saving is this large because the tag is computed from the store's version
counter and the query alone, before the store is read. A 304 does no filtering,
no thinning, no model validation, no JSON encoding and no gzip.

### 16.2 What the automated suite covers

`tests/test_etag.py`, 26 tests, in two halves.

**What goes into a tag** — every one of these is a way of answering 304 when
the answer has in fact changed, which is a cache's characteristic failure: not
a crash, but a client quietly holding something wrong.

| What is pinned | The failure it prevents |
|---|---|
| The tag is weak (`W/`) | Two responses at one store version differ in `ageSeconds`; a strong tag would be a false claim |
| It changes with the store version | The obvious case |
| It changes with the bbox and with the cap | Otherwise panning returns 304 and the new region never arrives |
| **It changes when `stale` flips** | `stale` moves on a clock, not on a write. Without it, a backend whose upstream has died answers 304 forever and never reports going cold |
| **It includes a per-process token** | The version counter restarts at zero, so a restarted backend would serve a different dataset under a tag the client holds. Restarts are how the provider gets switched |
| Weak comparison, tag lists, and `*` are all handled | RFC 9110 13.1.2 — `If-None-Match` permits only weak comparison |

**Through the real app**: the 200 carries an ETag and `Cache-Control:
no-cache`; a repeat with the tag is a 304; the 304 has an empty body and
repeats the tag; a nonsense tag gets the whole body; a poll invalidates the
tag; a different viewport and a different cap are different representations;
**the viewport hint still reaches the poller on a 304** (otherwise tier 2 goes
idle over the region the user is watching); and search is deliberately not
conditional.

### 16.3 In the running application

Fixture backend, the real frontend through the Vite dev proxy, no client code
for the conditional path. Over one session: **15 of 17 list polls were answered
304**, the two 200s being the first load and the poll after tier 1 refreshed.

Worth writing down, because it looks like a failure: in browser devtools every
one of those polls appears as `200 OK`. What devtools reports is the
cache-resolved response, not the network exchange. The backend's access log is
where the 304s are visible.

### 16.4 Defect found by running it, and fixed

Defect #14 in §6, and it is a category rather than an incident: a cache changes
what "now" means to every field computed at send time.

The status bar showed the data's age as the backend's `ageSeconds` plus the
time since the response arrived. Both halves were correct until the endpoint
became conditional; then a 304 handed the client back its own cached body —
whose `ageSeconds` was measured when it was first fetched — while the arrival
time reset on every poll. Measured in the running app: the backend reported
**107.6 seconds** and the status bar read **"data age 1s"**, and it would have
stayed there for the whole five-minute tier 1 cycle.

The client now measures from `fetchedAt`, an absolute instant that says the
same thing however many times the same body is reused, and no longer reads
`ageSeconds` at all. Re-checked in the running app: client 227.6 s against the
backend's 235.7 s, measured a few seconds apart, while 304s continued.

The trade is a dependence on the client and server clocks agreeing — wrong by
the skew rather than wrong without bound.

---

## 17. The specular glint

Defect #12, open since 2026-08-27 and deferred as visual-only, is closed here.
Reasoning and the full sweep in D48. Measured on 2026-08-27.

### 17.1 What was wrong, measured

The highlight was described as "a white blob rather than sun glint". Rendering
the real scene offscreen with the specular term and then without it, and
differencing the frames, turns that description into numbers:

| | Before (0.6 / 60) | After (0.35 / 400) |
|---|---|---|
| Width across the globe | **14.8° of arc** (~1,600 km) | **4.8°** (~550 km) |
| Share of the visible disc | **6.52%** | **0.69%** |
| Peak brightness above the ocean under it | **151 / 255** | **84 / 255** |
| Pixels clipped to white | 0 | 0 |

Stable across the zoom range: 4.8°, 4.7° and 4.2° at camera distances of 320,
180 and 140 units, with nothing clipping at any of them.

**The water mask was never at fault**, and this is recorded so nobody spends
another session on it: `earth-water.png` reads 255 over ocean and 0 over land
at ten sampled points, and the shader multiplies `specular * water`, so the
highlight could not appear on land. What looked like a highlight over Indonesia
was the seas around it.

### 17.2 Confirmed by the committed probe

`__orbital.probeLighting()` measures how much a sample point's brightness
changes as the camera moves around it. Diffuse lighting is view-independent, so
whatever spread it reports *is* the specular term. Same date, same points, only
the two numbers changed:

| Sample point | Before | After |
|---|---|---|
| 0°N, subsolar meridian | 0.3835 | 0.0675 |
| 0°N, 60° east of it | 0.0797 | 0.0000 |
| 40°N, 40° west of it | 0.2809 | 0.0090 |
| 30°S, 120° east | 0.0036 | 0.0036 |
| 55°N, 170° east | 0 | 0 |
| 0°N, antimeridian | 0 | 0 |

The two points that had no business being view-dependent — 60° and 40° away
from the sun — were carrying the blob's edge. They now sit at or below the
0.009 floor of the points the highlight never reached. The subsolar point still
moves with the camera, by a fifth of what it did, which is what a glint is.

This also settles a question §12.2 left open. That run recorded one point
spreading four times as much as the rest and called it "specular doing its
job". It was both: the term working *and* the term far too wide. The spread was
the number the defect was visible in all along.

### 17.3 What the automated suite covers

Four tests added to `lighting.test.ts` (24 → 28). They cannot render, so they
pin the things a source can carry:

| What is pinned | Why |
|---|---|
| Both terms are uniforms, and the literal `60.0` exponent is gone | A number tuned by eye that can only be changed by editing GLSL is a number nobody tunes |
| The material receives the config values | The tuning is only real if it reaches the shader |
| `specular * water * daylight * specularStrength` survives intact | Retuning two numbers must not quietly drop the mask or the daylight factor — the highlight would return to land, or to the night side |
| The exponent stays ≥ 240 and the strength ≤ 0.45 | A direction rather than a magic number: a much lower exponent or a much higher strength is the old blob coming back |

### 17.4 What is still outstanding

**Nobody has looked at it.** Size, brightness and view dependence are measured;
whether it *looks* like sun on water is not, and cannot be by this method. §8
step 24 is the check. What has changed is that the person doing that check now
has two numbers to turn — `VITE_SPECULAR_STRENGTH` and
`VITE_SPECULAR_SHININESS`, no rebuild — and a probe that reports what turning
them did.

### 17.5 The first retune was rejected on sight, and why the probe let it through

Everything in §17.1 to §17.4 was measured, correct, and insufficient. Shown the
globe, Phone reported the same white glow blob — twice, in two screenshots of
two different views, on 2026-08-28.

**The probe measured the highlight and never measured what it sits on.** The
Blue Marble ocean at this scale reads about **9/255**. §17.1's "peak 84" is
therefore roughly **ten times brighter than the water the highlight is
reflecting off**, which is why it read as a lamp behind the planet rather than
as sun on the sea. Size was never the complaint; contrast was, and no number in
this section was measuring it.

Adding the underlying brightness to the same difference-the-frames probe makes
the choice legible:

| strength | exponent | across | % of disc | peak | peak ÷ ocean beneath |
|---|---|---|---|---|---|
| 0.60 | 60 | 18.0° | 9.56% | 153 | 17.5× |
| 0.35 | 400 (§17.1) | 6.2° | 1.17% | 89 | 9.5× |
| 0.12 | 1200 | 2.8° | 0.23% | 30 | 3.4× |
| **0.08** | **900** — shipped | **2.8°** | **0.24%** | **20** | **2.4×** |

Stable across the zoom range: 2.8°, 2.9° and 2.8° at camera distances of 320,
180 and 140, clipping nowhere.

**Three candidates were measured and put to Phone**, who chose 0.08 and 900
after looking at them: subtle, barely-there, and removing the highlight
altogether. `EarthVisuals.setGlint(strength, shininess)` was added so the
person judging can change both terms from the console rather than through a
rebuild — `__orbital.earth.setGlint(0.08, 900)`.

Before checking anything else, the probe confirmed what the blob was made of.
Rendering the frame and hiding one layer at a time: atmosphere peak 12, star
field 52 (background stars, off the disc), borders 159 (the lines themselves),
markers 0. Only the specular term moved with the blob. It was never the
atmosphere shell, and the water mask remained blameless.

**What this costs the record.** §6's defect #12 was marked fixed on the
strength of §17.1 to §17.4 and was not. The lesson is in D49 and is worth
repeating here, because it is about this document: **a measurement can be
correct, improving, and still measuring the wrong quantity.** §12.3 already
lists three ways a probe can be wrong; this is the fourth, and the quietest —
a probe that is right about what it measures and silent about what matters. A
defect reported by an eye is closed by an eye.

### 13.4 The airframe was the wrong shape, and the tests were looking elsewhere

Reported on 2026-08-28 by Phone, with a screenshot: the model read as a dart
with a fork at one end. Measuring the merged geometry found both cones built
inside out — the nose pinched to a needle where it met the fuselage and flared
open at the very front, the tail the same in reverse. Defect #15 in §6, full
reasoning in D50.

| | at the fuselage join | at the tip |
|---|---|---|
| Nose, before | r = 0.004 | r = 0.042 |
| Nose, after | 0.042 | 0.004 |
| Tail, before | 0.012 | 0.036 |
| Tail, after | 0.036 | 0.012 |

**Every test in §13.1 passed throughout, and none of them was wrong.** They pin
orientation — the heading basis, a zero heading, the tallest vertex aft of
centre, the sprite handoff — and the model's orientation was correct the whole
time. The defect lived inside two primitives, along an axis no assertion
looked down. §13.2's pixel probe measured the nose direction to 1.3° and the
wingspan in pixels; neither changes when a cone is flipped end for end.

Four tests now measure the hull itself: the nose tapers forward and the tail
aft, **with the join asserted wide as well as the tip narrow** — checking only
that they differ would have passed on the broken model, where the two were
simply swapped — plus wing sweep and wing taper for the new panels.

The flying surfaces are now four-cornered panels rather than boxes, so they
sweep and taper. 220 triangles, one mesh, one material, one draw call: D42's
budget, unchanged.

**Accepted by eye** by Phone on 2026-08-28, which makes the aircraft model the
first of the three measured-but-unseen features to clear that bar.

### 14.7 Label coverage, after the thresholds were lowered

Reported on 2026-08-28: Thailand looked empty. It was — one city label and two
airports for the whole country. Reasoning in D51; this is what the change does,
measured against the real generated table.

**Thailand, zooming in** (1600x900 viewport, camera centred on each place):

| Camera altitude | Over Bangkok | Over Phuket | Over Chiang Mai |
|---|---|---|---|
| 0.20 | Bangkok, Ho Chi Minh City, Phnom Penh… | regional cities only | Bangkok, Yangon, Mandalay… |
| 0.10 | + Samut Prakan, DMK, UTP, NAK | HDY, URT, AOR, SGZ | CNX, LPT, KKC, UTH |
| 0.04 | + Nonthaburi, Pak Kret, Si Racha, Nakhon Pathom | Nakhon Si Thammarat, **Phuket International Airport**, Krabi Airport, Trang Airport | Chiang Mai, Lampang, Phrae Airport |
| 0.014 (closest) | **Don Mueang International**, **Suvarnabhumi**, and the metro cities | Phuket International Airport | Chiang Mai, Chiang Mai International Airport |

Before the change every one of those cells except the first row was empty.

**Cost**, same probe as §14.3:

| | Before | After |
|---|---|---|
| `labels.json` | 141 KB raw / 45 KB gzipped | 629 KB / **187 KB gzipped** |
| Candidates at the closest tier | 1,422 | 8,544 |
| Selection pass (every 200 ms) | 0.061 ms | **0.080 ms** |
| Reprojection (every frame) | 0.033 ms | 0.036 ms |
| `npm run geography` | 62 s | **0.43 s** |

The build speed-up is a spatial bucket in the airport ranking: one-degree cells,
nine cells searched per airport, same output. The per-frame cost barely moves
because candidates are cached against the tier and the caps bound what follows.

**What it does not do.** It adds labels, not detail the globe can render. The
camera stops at 89 km altitude, where the view is 83 km tall and the colour
texture is 9.8 km per pixel — about eight texels across the screen. Anything
finer needs tiled imagery and building geometry, which D17 excludes.

---

## 18. City mode — the zoom-in spike

Not a feature. A second renderer behind `config.cityMode`, built to answer two
questions before anyone pays for a migration: does OpenStreetMap building data
over Thailand look like anything, and is a hand-off between two renderers
tolerable. Reasoning and the tile research in D52. Built 2026-08-28.

### 18.1 What it does

Below **0.05 globe radii** the globe hands the view to a MapLibre map on the
same point, with OpenFreeMap vector tiles — no API key, no registration, no
usage cap — whose Liberty style carries a `building-3d` fill-extrusion layer
from zoom 14. Zooming back out past **0.09 radii** hands the view back to the
globe at the position and scale the map ended on.

`VITE_CITY_MODE=off` restores the previous behaviour exactly, which is also
what restores D7: OpenFreeMap is the only request in this application that
leaves for a third party.

### 18.2 Why a second renderer at all

| | |
|---|---|
| Closest the globe camera can go | 89 km altitude — a view 83 km tall |
| Where buildings start | zoom 14 |
| Zoom at the hand-off, over Bangkok | **7.8** |
| Gap | **six zoom levels**, which no tuning of this renderer closes |

### 18.3 What the automated suite covers

`cityMode.test.ts`, 14 tests. MapLibre needs a WebGL context and there is none
under vitest, so the map itself is stubbed and everything around it is pinned:

| What is pinned | Why it matters |
|---|---|
| `mapZoomFor` round-trips through `altitudeForZoom` | The inverse is what hands the view back; a mismatch means the globe resumes at the wrong scale |
| Zoom uses the **512-pixel** tile convention | MapLibre defines zoom against 512 px tiles. The widely-quoted 256 px constant is a factor of two — the world visibly doubling in size at the boundary |
| Scale falls with latitude | Web Mercator's metres-per-pixel depends on latitude; a fixed mapping jumps everywhere except the tropics |
| The entry and exit altitudes differ | One threshold for both directions flickers between two renderers on every notch of the wheel |
| MapLibre is not loaded until the first hand-off | 800 KB for a globe nobody zooms into |
| Entry eases toward zoom 13.5 and pitch 55 | At matched scale the first frame looks like the globe with the planet off; flat, a footprint is a polygon |
| Handing back reports where the map ended up | The globe resumes there, not where it left |

### 18.4 What it deliberately does not do

No aircraft, no terminator, no markers, no route, no selection: everything the
globe layers draw stops at the boundary. That is the cost of the cheap version
and the reason this is a spike. The real version is a migration — MapLibre has
a globe projection, 3D buildings on it, and three.js custom layers — which
would delete the border and label layers and cost the day/night terminator.

### 18.5 Outstanding

**Nobody has looked at it**, and it exists only to be looked at. Two questions,
neither answerable from a test: whether Thai building heights are tagged well
enough to read as a city rather than a field of identical slabs, and whether
the hand-off feels like zooming or like the app changing its mind.

### 18.6 The hand-off moved, after somebody looked

Reported 2026-08-28 with two screenshots: Thailand looked like gibberish.
Neither screenshot showed city mode — both showed the globe magnified past the
point where its texture carries information. Defect #16 in §6, reasoning in
D53.

| Altitude | View | Texels per screen pixel |
|---|---|---|
| 0.60 | 3,565 km | 3.0 |
| **0.35** — the hand-off now | 2,080 km | **5.1** |
| 0.20 | 1,188 km | 8.9 |
| **0.05** — the hand-off before | 297 km | **35.6** |
| 0.014 — the camera's floor | 83 km | **127** |

The threshold was chosen in D52 by asking how close the camera could get. The
question that mattered was how close the imagery holds up, and the answer is
"not this close": the whole approach was spent looking at magnified texture.

Three changes followed, all covered by `cityMode.test.ts` (14 tests to 19):

- The hand-off is at 0.35 radii, configurable through `VITE_CITY_ALTITUDE`, and
  a test asserts the texels-per-pixel figure at that altitude stays under eight
  — the measurement, not the number, is what is pinned.
- **Aircraft are drawn in city mode**, from the same store the globe reads and
  with the same silhouette, which `aircraftSprite.ts` now exports as a
  standalone canvas so there is one outline rather than two. Tests pin the
  lon/lat order GeoJSON wants — swapping it moves every aircraft to the wrong
  hemisphere while nothing fails — and that a null heading is not drawn as
  north.
- **A failed hand-off hands back.** `enter()` set `active` before awaiting the
  dynamic import, so any failure inside left the layer permanently active: a
  transparent div over the globe, no map, and no retry, because the guard
  believed city mode was already up. A test drives a loader that throws.

---

## 19. The planet view — phase 1

The MapLibre replacement for the globe, built beside it behind `VITE_VIEW=planet`
(D54). This section covers what phase 1 does and, as importantly, what it does
not yet do.

### 19.1 What is in it

| | |
|---|---|
| Renderer | MapLibre GL JS 6, globe projection, one continuous zoom |
| Imagery | NASA GIBS `BlueMarble_NextGeneration`, 500 m/px, z0–8, no key |
| Vector | OpenFreeMap, no key, no cap |
| Fade | raster opacity 1 → 0 across zoom 5.5 → 7.5, before its own tiles run out |
| Aircraft | one GeoJSON source, two symbol layers, rebuilt each frame from the store |
| Selection | `queryRenderedFeatures` against the drawn symbol |
| Viewport | `map.getBounds()` → the contract's bbox, feeding tier 2 as before |

Sharpness, against what the globe.gl view could manage: **500 m per pixel
against 9,800 m**, and the imagery is real rather than one JPEG magnified.

### 19.2 What is not in it yet

The route line, the selected aircraft's 3D model, and the terminator. The first
two are ports of working code. The terminator has no MapLibre equivalent —
D41's per-pixel day/night shading would become a computed night polygon over
the GIBS night-lights raster, which is the same information by a coarser
mechanism. None of it is claimed to be done.

### 19.3 What the automated suite covers

`planet.test.ts`, 28 tests. MapLibre needs a WebGL context and vitest has none,
so what is tested is everything that would be wrong before a pixel is drawn —
and all three of the load-bearing cases are conventions that disagree:

| What is pinned | The failure it prevents |
|---|---|
| Features are written **lon/lat** | GeoJSON's order is the reverse of the contract's. Swapped, every aircraft is in the wrong hemisphere and nothing fails |
| The imagery URL is **`{z}/{y}/{x}`** | GIBS is WMTS — row then column. An XYZ template returns tiles of the wrong place rather than an error: a plausible, mirrored Earth |
| Longitudes are wrapped into [-180, 180) | MapLibre keeps counting as the user pans; the backend parses the contract's range. Wrapping is also what produces `lonMin > lonMax` across the antimeridian, which D25 defines |
| Latitude is clamped at the poles | A globe view can put the pole mid-screen, where bounds come back past 90 |
| The imagery layer sits directly above `background` | Any higher and it covers the cartography that is supposed to outlive it |
| The fade ends before the imagery's max zoom | Otherwise the last thing seen is one tile stretched over four zoom levels |
| Icons overlap freely; labels may drop out | Hiding an icon loses an aircraft; hiding a callsign loses a callsign |
| Rotation is aligned to the map | Aligned to the viewport, every aircraft turns as the user turns the map — D41's mistake in another frame |
| Colour comes from `altitudeColor`, not a second ramp | Two copies of a colour scale drift, and then the legend lies |
| A whole-world view publishes no viewport | Asking for a bbox that is the planet spends a tier 2 credit on the widest box there is (D21, D27) |

### 19.4 Verified against the live services

Both endpoints answer, from the browser, with CORS: the OpenFreeMap style at
200, and a GIBS tile at 200 `image/jpeg`. A CORS failure on the imagery would
have been silent in tests and fatal in the app.

**Not verified: that it renders.** The agent-driven browser surfaces still do
not composite, so MapLibre never gets the `requestAnimationFrame` it needs to
process a style or draw a tile. Phase 1 is finished when somebody looks at it.

### 19.5 Defect: the map rendered into a collapsed container

Reported 2026-08-28 as "complete blank" with a screenshot: chrome, legend and
status bar all correct, 157 aircraft in the store, and no map. Defect #17 in
§6, reasoning in D55.

MapLibre adds `maplibregl-map` to its container and its stylesheet sets
`position: relative` on that class. The stylesheet is a dynamic import, so it
loads *after* the application's own; both selectors are one class, so they are
equally specific; and at equal specificity the later rule wins. The container
turned relative, `inset: 0` stopped applying, and the box collapsed.

| | Before | After |
|---|---|---|
| `position` | `relative` | `absolute` |
| Container | 1280x**0** | 1280x720 |
| Canvas | 400x300 (MapLibre's fallback) | 1600x900 |

**Nothing reported it.** No exception, no console error, no MapLibre `error`
event, no failed request — a zero-height box is a legal box. The only signal
was the 400x300 canvas, which is what MapLibre falls back to when it is handed
a container with no dimensions.

Fixed by scoping the rules to `.app`, and guarded by `container.ts`, which
measures the container before the map is built and names the cascade collision
in the warning. Four tests cover the guard, including that the message names
`.maplibregl-map` and `position: relative` rather than only reporting the size
— the cause is in somebody else's stylesheet, which is the last place the
reader would look.

**`.city-map` had the same bug**, which means the city-mode spike (§18) was
very likely blank when it was looked at and set aside. It is superseded either
way, but the record should not claim it was rejected on its merits.

### 19.6 Defect: the map turned white on the way in

Reported 2026-08-28 with four screenshots: the globe correct from space, tiles
arriving progressively, then washing out on approach, then a wholly white
screen. Defect #18 in §6, reasoning in D56.

The imagery faded out at zoom 7.5 and the vector basemap became the ground —
and its background is `#f8f4f0`. Anywhere without roads to draw, that cream
fill *is* the map.

| | Before | After |
|---|---|---|
| Imagery coverage | z0–8, faded out by 7.5 | z0–15, no fade-out |
| Close-range source | none | EOX Sentinel-2 cloudless, **10 m/px** |
| Vector's role | the ground below zoom 7.5 | lines, labels, buildings only |
| Background and area fills | drawn | dropped from the style |

Five new tests in `planet.test.ts` (28 → 32 → 36 with the container guard):
the layer list is imagery-then-cartography with no `background` and no `fill`
anywhere; the crossfade completes before the far tier runs out of its own
tiles; the near tier reaches closer than the far one; both tiers request
`{z}/{y}/{x}`; and both carry the attribution their licences require.

**Verified from the browser:** Sentinel-2 answers `200 image/jpeg` at zooms 2,
8, 12, 14 and 15, with CORS. **Not verified: how it looks.** No agent-driven
browser here composites, so tile loading never begins.

### 19.7 The in-app diagnostics readout

Development-only, drawn into the planet view (D57): style state, layer count,
per-source tile counts, and the last three MapLibre errors.

It exists because the map is looked at on one machine and debugged on another.
No browser surface available to the agent composites, so MapLibre never loads a
style there and every probe reports the same "not loaded" whether the code is
right or wrong; from the other side a screenshot shows what is drawn and
nothing about why. Both defects in this view so far (#17, #18) cost a full
round trip to identify from a picture.

Four tests, on the pure parts:

| What is pinned | Why |
|---|---|
| Requests are counted by kind | The readout is only useful if the counts are right |
| **Glyph requests are not counted as vector tiles** | Both are `.pbf`; conflating them hides the exact failure the panel exists to show |
| "NO VECTOR TILES" appears only once the style has loaded | Before that it is normal and the warning would be noise |
| The most recent errors are shown, not the first | The first error is usually a consequence of an earlier state; the last is what is true now |

### 19.8 The imagery ceiling, measured

"Is this the most I can zoom in?" — asked on 2026-08-28, answered wrongly the
first time. Reasoning in D58; the measurement, over Bangkok:

| Zoom | Sentinel-2 (10 m) | Esri World Imagery |
|---|---|---|
| 12 | 33 KB | 21 KB |
| 15 | 17 KB | 26 KB |
| 17 | 8 KB — upscaled | 24 KB |
| 18 | 5 KB — upscaled | 21 KB |
| 19 | **404** | 16 KB |

The close tier is now Esri, to zoom 19 — sub-metre, where individual buildings
are visible. Verified from the browser with CORS. Sentinel-2 stays available
through `VITE_IMAGERY_CLOSE_TILE_URL` and has the cleaner licence.

A test pins that the close tier reaches at least zoom 18, since below that the
map stops being a map on approach. Another was corrected in the process: it
asserted `/{z}/{y}/{x}.` with a trailing dot, which Esri's extensionless path
fails — and which would have passed a wrongly ordered URL that happened to end
in `.jpg`.

### 19.9 Cartography over imagery

Street names, roads and buildings were invisible at every zoom while imagery
was correct. Reasoning in D59.

**Ruled out by measurement before changing anything:** the vector tiles serve
(200, 450 KB of MVT at zoom 14 over Bangkok, with CORS); the layer filter keeps
93 of 111 layers including 30 road and 25 label layers; and the composed style
validates against MapLibre's own spec with **zero errors** and no layer
referencing a removed source.

That leaves two causes which look identical in a screenshot — not drawn, or
drawn invisibly — and the second had not been considered. The basemap is a
*light* style: white roads, dark labels with white halos, all correct on cream
and nearly invisible on a photograph of a grey-and-white city.

Nine tests cover the recolour and the readout:

| What is pinned | Why |
|---|---|
| Labels become white with a dark halo | The inversion is the fix |
| Road casings go dark, roads stay bright | The casing is what makes a road legible over imagery |
| Buildings become translucent | So they read as volumes over their own footprints |
| **Geometry, filters, zoom rules and layout are untouched** | Only colour was wrong; the cartography is worth keeping |
| `TILES BUT NO FEATURES` appears only with tiles and no features | It separates a source that never loaded from one that drew nothing |
| A working map prints neither warning | A diagnostic that cries wolf gets ignored |

### 19.10 The vector source never loaded

The readout (§19.7) answered this in one screenshot, which is what it was for:

```
style LOADING · z12.1 · 95 layers
tiles: gibs 131 · sentinel 0 · vector 0
glyphs 0 · sprite 2 · features drawn 0
```

Style applied, imagery streaming, sprite loaded, and **zero vector tiles, zero
glyphs, style still loading, no errors**. Reasoning in D60.

The basemap declares its vector source as a TileJSON `url` rather than a
`tiles` list, so MapLibre has to fetch that document itself — and that request
never completed, silently. The 93 cartographic layers had nothing to draw. The
imagery sources were unaffected because they are declared with `tiles`.

**What made this hard to see** is worth recording: the TileJSON had been
fetched successfully from the page several times, and that was read as "the
tiles are fine". It proved the URL and CORS were fine and said nothing about
whether *MapLibre* had fetched it. `vector 0` is the check that mattered.

`resolveVectorSources` now fetches those documents at load and inlines the
templates. Four tests: a `url` source becomes a `tiles` source; the document
requested is the one the source pointed at; sources that already list tiles are
untouched; and a TileJSON with no tiles throws rather than resolving to a
source that draws nothing — which is exactly how the original defect stayed
invisible.

**A defect in the instrument, too.** The same screenshot read `sentinel 0`
while Esri tiles were streaming: the readout still named the provider D58 had
replaced. It now matches whichever close tier is configured.

### 19.11 The readout was measuring nothing

`vector 0` was believed twice and sent one commit in the wrong direction.
MapLibre fetches vector tiles **inside a Web Worker**, and
`performance.getEntriesByType('resource')` only reports the calling thread's
requests — so that counter could never have read anything but zero. Reasoning
in D61.

The panel now reports MapLibre's own source-cache state, which is main-thread
and authoritative: source present, source loaded, tiles cached, features drawn.
Three distinguishable failures instead of one ambiguous number — no source, no
tiles, or tiles that draw nothing.

Seven tests, including two that would have caught the original fault: one
drives `vectorSourceState` against a stub map and asserts it reads the cache
rather than the network, and one asserts a working map prints none of the three
warnings — the check that was never run, because the instrument had only ever
been pointed at a broken map, where zero is what a correct instrument prints
too.

### 19.12 The vector search: what was excluded

Roads and labels invisible; source present, template resolved, no tiles ever
fetched. Every one of these was tested live and works (D62): the tile URL (200,
13 MB), MapLibre's worker (GeoJSON sources load), vector tiles in a minimal
style (802 features), the composed style built by the app's own module (1418
features), the globe projection (1418 against 1475 without), worker starvation
from the per-frame aircraft rewrite (491 `setData` calls, vector still loaded),
and a full replica of the view's map and load handler (1418 features).

**One defect was found on the way**: MapLibre measures its container once, at
construction, and falls back to a 400x300 canvas if it measures nothing.
Observed on the real map — container 1280x720, canvas 400x300, transform never
sized. D55's warning had reported exactly this and then carried on into it.
Construction now waits for a box and a `ResizeObserver` keeps it sized.

Two tests: a container that already has a box resolves immediately, and one
that starts at zero resolves only once the observer reports a real size.

That fix is real and measured, and it is probably not the reported failure —
the screenshots show full-screen imagery, so that canvas is full size. It is
fixed because it was broken.
