# Orbital — Test Plan and Phase 1 Exit Criteria

Phase 2 (satellites) begins only when every criterion in §1 is met. This
document is the record of whether they are.

**Status as of the current commit: 4 of 5 criteria met.** See §1.

---

## 1. Phase 1 exit criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | All phase 1 requirements implemented | **Met** | §2 |
| 2 | Test plan executed, no open critical or high defects | **Met** | §3, §6 |
| 3 | Stable rendering performance at the target marker count | **Met** | §4 |
| 4 | Backend survives an OpenSky outage without breaking the frontend | **Met** | §5 |
| 5 | Phase 1 documentation complete | **Outstanding** | §7 |

Criterion 5 is the only one open. It is outstanding because the system has
never been run against the live OpenSky API — every measurement in this
document was taken against the fixture provider. See §7 for what that leaves
unverified.

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
| `interpolate.test.ts` | 29 | Dead reckoning, easing, extrapolation limit |
| `sun.test.ts` | 11 | Solar declination and subsolar longitude |
| `viewport.test.ts` | 14 | Camera-to-bbox conversion |
| `pointer.test.ts` | 17 | **Click-to-select through real DOM events** |
| `markers.test.ts` | 12 | Pick tolerance in pixels, horizon test |
| `route.test.ts` | 13 | Great-circle geometry, antimeridian, colour |
| `store.test.ts` | 18 | Snapshot application, selection races, layers |
| **Total** | **388** | 278 backend, 114 frontend (some counts overlap suites) |

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

**No open critical or high defects.**

Defects 3, 4, 5 and 6 all passed every automated test at the time they existed.
Defect 5 is the sharpest lesson: the verification computed a marker's projected
screen position and clicked exactly there, which cannot discover that a target
is too small. The regression tests now drive real DOM events.

---

## 7. What is outstanding

**Criterion 5 — documentation complete — is not met, for one reason: the system
has never run against the live OpenSky API.**

Everything in this document was measured against the fixture provider. What
that leaves unverified:

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

Before sign-off, run the backend with `ORBITAL_PROVIDER=opensky` and real
credentials for at least one full polling cycle, and confirm: a token is
obtained, `/api/health` shows a real `remainingCredits`, the observed credit
burn matches the projection, and the normalizer drops nothing unexpectedly.

Until that has happened, phase 1 is not signed off and phase 2 must not begin.

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
