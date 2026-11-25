# Chapter 6: Implementation and Testing

## 6.1 Testing Plan

Orbital is tested at four levels, each answering a different question:

| Level | Question it answers | How | When |
|---|---|---|---|
| Unit (§6.1.2) | Does each piece of code do what it says? | 2,087 automated tests, run offline | On every change, before it is pushed |
| Functional (§6.1.3) | Can a visitor do each thing the requirements promise? | Test cases run on the live site | At each phase boundary, and before this report |
| Integration (§6.1.4) | Do the pieces, and the outside services, work together? | API tests through the full server, plus checks against every real feed | On every change, and against live feeds before release |
| System (§6.1.5) | Does the whole system meet its performance, reliability and usability targets? | Measurement in the browser, benchmarks, observed outages | Per phase, and whenever a target could be affected |

**No automated test touches the network or spends an API credit.** Every
provider is tested against recorded responses, so both suites run anywhere, in
seconds to minutes, and give the same answer every time. The price is that a
change in a real feed is invisible to them, which is why the integration and
system levels run against the live services.

**A test only counts if it can fail.** When a test is written for a bug, the
fix is removed again to confirm the test fails without it. Two kinds of test
that passed while proving nothing were found this way and are now checked for.

| Item | Detail |
|---|---|
| Backend test tool | pytest, with FastAPI's TestClient for the API |
| Frontend test tool | Vitest |
| Test data | Recorded answers from each real feed, stored as fixtures |
| Browsers checked | Google Chrome on Windows, desktop and 375 px phone width |
| Pass criterion | All automated tests pass; every functional test case passes on the live site; no open defect above low severity |

### 6.1.1 Traceability Matrix

Every functional requirement (§3.2.1) is traced to the code that implements it
and the tests that verify it. All the tests listed passed at the time of
writing.

| Requirements | Implemented in | Verified by | Result |
|---|---|---|---|
| FR-01 Retrieve live aircraft | `providers/opensky.py`, `adsblol.py`, `adsbfi.py`, relay | `test_opensky.py` (49), `test_adsblol.py` (58), `test_adsbfi.py` (14), `test_relay.py` (6) | Pass |
| FR-02 Merge two aircraft sources | Union provider | `test_union.py` (30) | Pass |
| FR-03, FR-04 Compute satellites; refuse old elements | Orbit propagation, element loader | `test_orbits.py` (23), `test_satellites.py` (27), `test_satellite_names.py` (43) | Pass |
| FR-05, FR-06 Ships from two sources, merged without blanks | Digitraffic, aisstream, ship union | `test_digitraffic.py` (22), `test_aisstream.py` (30), `test_ais.py` (33), `test_shipunion.py` (16) | Pass |
| FR-07 Poll within each rate limit | Poller, quota | `test_poller.py` (53), `test_quota.py` (51) | Pass |
| FR-08 Keep the last snapshot on failure | Poller, store | `test_poller.py`, outage tests in `test_api.py` (43) | Pass |
| FR-09 Evict objects not re-observed | Store | `test_store.py` (36) | Pass |
| FR-10 Run offline from fixtures | Fixture provider | `test_providers.py` (34) | Pass |
| FR-11 List by bounding box | API routes | `test_api.py`, `test_satellite_api.py` (37), `test_ship_api.py` (25) | Pass |
| FR-12 One object with its track | Flight history, relay tracks | `test_flights.py` (61), `test_flightroutes.py` (12), `test_relay.py` | Pass |
| FR-13, FR-14 Search one layer; search all | Search | `test_search.py` (11), `recentSearches.test.ts` (19) | Pass |
| FR-15 Thin to the cap | Thinning | `test_thinning.py` (26) | Pass |
| FR-16 Answer 304 when unchanged | ETag | `test_etag.py` (26) | Pass |
| FR-17 to FR-20 Health, no outside call per request, input checks, clamping | API, data contract | `test_api.py`, `test_detail_budget.py` (4), `test_models.py` (39) | Pass |
| FR-21 to FR-25 Map, headings, fading, interpolation | `src/planet`, interpolation | `planet.test.ts` (88), `interpolate.test.ts` (34), `trackFix.test.ts` (14), `status.test.ts` (13) | Pass |
| FR-26, FR-27, FR-33 Layers, their text and colours | Layer chrome, layers | `layerChrome.test.ts` (23), `satelliteLayer.test.ts` (24), `shipLayer.test.ts` (14), `altitudeColor.test.ts` (5) | Pass |
| FR-28, FR-29 Details and observed track | Detail panel, route | `route.test.ts` (37), `panelFields.test.ts` (4), `satelliteFacts.test.ts` (22), `shipFacts.test.ts` (17) | Pass |
| FR-30 3D airframe | Model layer | `model.test.ts` (54), `airframeShape.test.ts` (20) | Pass |
| FR-31 Receiver coverage | Coverage layer | `coverage.test.ts` (17) | Pass |
| FR-32 Solar system | Solar system page | `planets.test.ts` (57), `solarFocus.test.ts` (34), `solarScale.test.ts` (29) and 13 more files | Pass |
| FR-34 to FR-36 Register, sign in, hashed passwords | Accounts | `test_accounts.py` (14), `test_auth_api.py` (22), `test_passwords.py` (11), `auth.test.ts` (18) | Pass |
| FR-37 to FR-39 Past instant within the tier's window | Entitlements, time control | `test_entitlements.py` (20), `entitlements.test.ts` (15), `timeTravel.test.ts` (11) | Pass |
| FR-40, FR-41 Change own tier; no administrator from outside | Accounts, account tool | `test_entitlements.py`, `test_accounts_cli.py` (16) | Pass |
| FR-42 Advertisements unless premium | Ad slots | `ads.test.ts` (14), `premium.test.ts` (8) | Pass |

### 6.1.2 Unit Testing

Unit tests check one piece of code at a time against recorded data. They run
with one command on each side:

```
cd backend  && python -m pytest
cd frontend && npm test
```

**Backend: 934 tests in 33 files**

| Area | Tests | What they check |
|---|---|---|
| Providers | 358 | Each feed's answer converted to the shared shape: units, "not available" values, missing fields, malformed answers, rate-limit replies |
| Ingestion | 285 | Merging two feeds, polling schedules, retry and backoff, quota accounting, the store, thinning, flight tracks and routes |
| Data contract | 39 | The shared shape: units, nullability, immutability, the antimeridian |
| API | 169 | Every endpoint, error responses, compression, ETags, the relay routes, the time budget of a detail request |
| Accounts | 83 | Registration, sign-in, sessions, password hashing, tiers and their time windows, the administrator tool |

**Frontend: 1,153 tests in 67 files**

| Area | Tests | What they check |
|---|---|---|
| Map rendering | 375 | The MapLibre style, every object layer, routes, the 3D model, night shading, coverage, the status line |
| Motion and geometry | 124 | Dead reckoning between updates, track correction, airframe shape, colours, label stacking |
| Solar system and other worlds | 352 | Planet positions and scale, the camera journeys between worlds, the Moon and its spacecraft |
| Panels and interface logic | 224 | Detail panel fields, search history, airline decoding, page routing, the application state |
| Accounts, tiers and ads | 78 | Sign-in flows, entitlements, the time control's window, advertising and premium |

**What the unit tests do not cover.** No unit test runs the graphics card, so
what is drawn on screen is checked by looking at the running application
(§6.1.3, §6.1.5). React components are tested through their logic, not by
rendering them. Both gaps are why the functional and system tests exist.

### 6.1.3 Functional Testing

Each test case follows one use case (§5.2.2.1) on the live site,
orbital-liveview.vercel.app, in Chrome at 1600 × 950. They were last run on
25 November 2026; the screenshots in Chapter 7 were captured during this run.

| ID | Use case | Steps | Expected result | Result |
|---|---|---|---|---|
| TC-01 | UC-01 View the map | Open the site | Globe with live aircraft; status bar shows count, sample size, data age and source | Pass (Figure 7.2) |
| TC-02 | UC-01 View the map | Scroll to zoom into Southeast Asia | Every aircraft in view drawn with callsign and heading; no sample notice | Pass (Figure 7.3) |
| TC-03 | UC-04 Search | Type "THA" in the search box | Suggestions grouped under Aircraft with altitudes | Pass (Figure 7.4) |
| TC-04 | UC-03 Select an object | Choose THA923 from the suggestions | Camera flies to it; panel shows photo, airline, type, altitude, speed, route; flown track drawn | Pass (Figure 7.5) |
| TC-05 | UC-02 Switch layer | Press Satellites | Satellites drawn by orbit class; key, search text and subtitle change | Pass (Figure 7.6) |
| TC-06 | UC-03 Select an object | Search "ISS" and choose it | Panel shows catalogue number, orbit and period; full orbit drawn | Pass (Figure 7.7) |
| TC-07 | UC-06 View a past instant | Move the time control back one hour | Panel turns amber, shows the UTC time and "Return to live"; positions recomputed | Pass (Figure 7.8) |
| TC-08 | UC-02 Switch layer | Press Ships, search "SILJA SERENADE" | Ships coloured by type; panel shows status, destination, size, IMO and MMSI | Pass (Figures 7.9, 7.10) |
| TC-09 | UC-01 View the map | Open the world picker, choose the Moon | Camera flies to the Moon; three lunar spacecraft listed and drawn | Failed, then passed after defect 4 was fixed (Figure 7.11) |
| TC-10 | UC-01 View the map | Open the solar system page | Planets drawn on their orbits for today; Earth marked | Pass (Figure 7.12) |
| TC-11 | UC-05 Register and sign in | Press Sign in | Sign-in form with a link to create an account | Pass (Figure 7.13); submitting the form is covered by `test_auth_api.py` |
| TC-12 | UC-06 tier window | Open the premium page | Free and premium compared; switching requires signing in first | Pass (Figure 7.14) |
| TC-13 | UC-03 Select an object | Open an aircraft's panel on a 1600 px wide screen | Panel title fully visible | Failed, then passed after defect 3 was fixed |

### 6.1.4 Integration Testing

**Inside the system.** The API tests start the whole server in memory —
providers, poller, store and routes together — and talk to it over HTTP the way
the browser does. The most complete one follows the relay end to end: the
relay posts the worldwide answer, a visitor opens an aircraft, the server puts
it on the relay's list, the relay posts the flown track, and the visitor's
detail request returns it (`test_relay.py`).

**With the outside services.** The automated tests use recorded answers, so
each real service was also checked live:

| Integration | Check | Result, 23–25 November 2026 |
|---|---|---|
| OpenSky through the relay | Relay fetches the world and posts it; server stores it | 5,500 to 9,400 aircraft applied per post, about 300 KB gzipped |
| OpenSky flown tracks | Select an aircraft; relay posts its track | Track drawn within seconds, 30 to 100 points |
| adsb.lol and adsb.fi | Zoom into a region | Status bar source reads "union"; aircraft drawn inside the 250 nm limit |
| Digitraffic and aisstream | Open the ship layer | 14,000 ships held; source reads "digitraffic+aisstream" |
| SatNOGS orbital elements | Open the satellite layer | 1,522 satellites computed; source reads "satnogs" |
| NASA JPL Horizons | Fly to the Moon | Three spacecraft with altitudes |
| Planespotters | Open an aircraft panel | Photograph shown with photographer credit |
| Frontend (Vercel) to backend (Northflank) | Every test case in §6.1.3 | All requests answered; no cross-origin errors |
| Relay route protection | Call a relay route without the token | Refused (401); off entirely without a token (404), both automated in `test_relay.py` |

### 6.1.5 System Testing

**Performance.** Measured against the targets in §3.2.3.1:

| Requirement | Target | Measured | Result |
|---|---|---|---|
| NFR-01 Marker drawing at the 2,000 cap | Under 16.7 ms | 0.80 ms | Pass |
| NFR-02 Frame time under load | 60 fps | 4.2 ms median, 5.9 ms at the 99th percentile | Pass |
| NFR-03 List endpoint | Under 100 ms | 23 ms | Pass |
| NFR-04 Combined search | Under 100 ms | 47 ms | Pass |
| NFR-05 Detail lookup | Under 10 ms | 0.01 ms | Pass |
| NFR-06 Compression | Responses compressed | 366 KB down to 24.5 KB | Pass |

**Reliability.** Two real outages tested the failure path without being
staged. When adsb.lol began refusing worldwide queries, the aircraft layer
degraded to the area in view rather than failing, until the relay restored the
worldwide view (R1, §4.2). On
25 November, with the relay PC switched off overnight, the status bar read
"upstream is not responding — showing last known positions" and the map stayed
up; when the PC came back, the relay restarted itself and fresh data arrived
within two minutes.

**Usability.** Every layer was used signed out (NFR-30) and at 375 px phone
width (NFR-33).

**Defects found in system testing.** Each was fixed and re-tested.

| # | Defect | Found | Cause | Fix |
|---|---|---|---|---|
| 1 | Worldwide aircraft disappeared; only the area in view remained | 23 Nov | The relay had been started from a development session and stopped with it | A Windows scheduled task restarts it every five minutes; one copy at a time; one failed cycle no longer stops it |
| 2 | The same, again, on battery power | 23 Nov | Windows stops scheduled tasks when a laptop unplugs | The task is allowed to start and keep running on battery |
| 3 | The detail panel's title was hidden on wide screens | 25 Nov | At 1530 px and wider, the 90 px advertising banner covered the panel's top | The panel starts below the banner whenever the banner is shown |
| 4 | The world picker closed as soon as it was clicked, and on phones on every tap | 25 Nov | Hover and focus opened it, then the click toggled it shut | A click now only opens it; checked at desktop and 375 px width |

Earlier in the project, eighteen defects were recorded that no unit test could
have caught: in each, the code was correct but was never connected to
anything. That is why the system is always run and looked at before a change
is accepted.

## 6.2 Implementation Plan

### Environments

| Environment | Frontend | Backend | Data |
|---|---|---|---|
| Development | Vite dev server on the developer's PC | uvicorn on the developer's PC | Recorded fixtures, or the live feeds |
| Production | Vercel, orbital-liveview.vercel.app | Northflank, one container, one worker | Live feeds; accounts on a persistent volume |
| Relay | — | Python script on a team member's PC, kept running by Windows Task Scheduler | OpenSky, posted to production |

### Deployment process

1. A change is made on a developer's PC and both test suites are run.
2. The change is checked in the browser against the local or live backend.
3. It is committed and pushed to the main branch on GitHub.
4. Vercel and Northflank build and deploy it automatically.
5. The live site is checked again: the affected screens, the status bar and the
   health endpoint.

Secrets — the OpenSky client credentials, the aisstream key and the relay's
shared token — are set as environment variables on Northflank and in a
git-ignored file on the relay PC. They are never committed or printed.

### Phased implementation

The system was built in six phases. Each phase's working prototype became the
next phase's foundation:

| Phase | Delivered | The risk it retired |
|---|---|---|
| 1 | Aircraft, end to end | That a free feed could sustain a live map at all |
| 2 | Satellites; migration to MapLibre | That a second object type costs one module |
| 3 | Moon and solar system | That the renderer is not Earth-specific |
| 4 | Accounts, tiers, advertisements | That a revenue model fits without a payment integration |
| 5 | Ships, regional then global | That the shape holds for a streaming source, not just a polled one |
| 6 | Performance and defect sweep; the OpenSky relay | That the whole thing holds at full object count, and survives losing a feed |

**One prototype was discarded.** The original renderer was a three.js globe,
replaced by MapLibre in phase 2. The globe could draw a sphere but not a map:
no vector basemap, no zoom to street level. Replacing it cost a phase and was
correct.

### Operation and maintenance

| Task | How often | Owner |
|---|---|---|
| Check the relay's log and the status bar's data age | Weekly, and when the map looks thin | Technical Engineer |
| Rotate API keys and the relay token | Each semester, or at once if exposed | Technical Engineer |
| Add the adsb.lol key, and its credit on the map, once issued | Once | Developer |
| Review OpenSky credit use in the relay log | Monthly | Project Manager |
| Run both test suites before any change is pushed | Every change | Whoever makes the change |
