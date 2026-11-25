# Chapter 1: Introduction

## 1.1 Background

At any moment roughly fourteen thousand aircraft are in the air, tens of
thousands of ships are at sea, and thousands of satellites are in orbit. Almost
all of them broadcast their position. Aircraft transmit ADS-B, ships transmit
AIS, and satellite orbits are published as orbital elements. The data is public
and free to collect.

It is difficult to use. Four problems stand in the way.

The raw formats cannot be displayed as received. ADS-B reports altitude in
feet and speed in knots. AIS encodes "not available" as a number inside the
valid range, so a vessel with no speed reading transmits 102.3 knots. Orbital
elements are a text format that must be run through a physics model before it
means a position.

Every free source is incomplete, in different places. Measured on identical
areas, OpenSky reported 22 aircraft over Myanmar where adsb.lol reported 4;
adsb.lol reported 33 over inland China where OpenSky reported none.

**Free access is metered.** OpenSky bills by area against a daily allowance.
adsb.lol permits four requests then roughly one every twelve seconds. Naive
polling exhausts either within hours.

**Commercial alternatives are closed.** MarineTraffic, FleetMon and Spire are
now owned by Kpler; ORBCOMM's AIS business by S&P Global.

**Problem statement.** Public position data for aircraft, ships and satellites
is abundant and free, but fragmented across sources with different formats,
different coverage gaps and different access limits. No free tool presents all
three on one map while being explicit about what it does not know.

## 1.2 Objectives

| | Objective |
|---|---|
| O1 | Present live aircraft positions on an interactive Earth in a browser |
| O2 | Isolate the browser from every external data source |
| O3 | Survive upstream failure without breaking the display |
| O4 | Normalise every source onto one shared data shape |
| O5 | Extend the same architecture to satellites and ships |
| O6 | Provide user accounts and a differentiated service tier |
| O7 | Record the reasoning behind every significant decision |

O5 exists to test whether the abstraction in O4 is real or accidental.

### Expected benefits

**For viewers.** One free view of aircraft, ships and satellites, with no
account required and no claim of completeness the data cannot support. Markers
older than two minutes fade. The ship layer is labelled "ships in coastal
waters" because both AIS feeds are received from the shore.

**For data providers.** One backend makes a fixed number of requests regardless
of how many people are watching, polling each source at the rate that source
asks for.

**For the team.** A worked example of a system with three interchangeable data
layers, where the interchangeability was tested twice by adding a layer. Each
new layer cost one provider module and one registry entry.

## 1.3 Scope

### In scope

| Area | Included |
|---|---|
| Aircraft | Live positions from two sources, merged; flight track; airline and type; airport search; receiver coverage |
| Satellites | ~1,400 satellites computed from orbital elements; orbit class; the orbit each one is on |
| Ships | ~26,000 vessels from two sources, merged; type, dimensions, destination, status |
| Solar system | Eight planets and the Moon, navigable |
| Accounts | Registration, sign-in, sessions, three tiers |
| Time travel | Historical satellite positions, limited by tier |

### Out of scope

| Excluded | Reason |
|---|---|
| Space debris and rocket bodies | The catalogue holds ~100,000 objects, most not worth drawing |
| Collision or re-entry prediction | The model is accurate to kilometres; a viewer could not detect a wrong answer |
| A fourth object class | Requires a written decision; enforced by a test on each side |
| Ground-station passes | Feasible but outside the objectives |
| Flight or voyage prediction | Orbital reports observations, it does not forecast |

### Scale of the system

| Measure | Value |
|---|---|
| Backend | ~19,400 lines, 85 files |
| Frontend | ~31,900 lines, 167 files |
| Automated tests | 2,061 (915 backend, 1,146 frontend) |
| HTTP endpoints | 17 |
| Recorded decisions | 213 |
| Objects served | 14,804 aircraft, 26,262 ships, 1,427 satellites |

Measured on 8 September 2026 against the commit this report was built from.
The three object counts move continuously; the rest move whenever the code
does, which is why this table carries a date.

## 1.4 Limitations

Scope says what Orbital chose not to do. These are the limits of what it does,
and most come from the data rather than the code.

| Limitation | Cause | What the visitor sees |
|---|---|---|
| Coverage has gaps over oceans and remote land | Aircraft and ships are heard by ground receivers, which have a range of a few hundred kilometres | Empty areas where nobody is listening; the map does not invent positions there |
| Ships are coastal only | Both AIS feeds are received from the shore, not by satellite | The layer is labelled "ships in coastal waters", and search explains when a ship is out of range |
| The worldwide aircraft view needs the relay PC to be on | OpenSky refuses requests from cloud servers, so a team member's PC fetches the world (§5.1) | With that PC off, aircraft appear only around the area in view, and the status bar says the data is stale |
| Positions are up to two minutes old | Free quotas allow the world to be fetched once every 120 seconds | Markers move smoothly by dead reckoning between updates; markers older than two minutes fade |
| At most 2,000 objects are drawn per view | The browser cannot draw more within a frame's time budget | Zoomed far out, the status bar reads "showing a sample of N in view" |
| Satellite positions are computed, not observed | Orbits are propagated from published elements with SGP4 | Accurate to about a kilometre, worse as elements age; elements older than seven days are refused |
| Only about 1,500 satellites | Debris and rocket bodies are excluded (§1.3) | Active, named satellites only |
| Scheduled routes may be wrong | The origin and destination come from a community database, not from the aircraft | The detail panel labels the route as published, not reported, and shows the observed path separately |
| Time travel covers satellites only | Only satellites can be computed for any moment; aircraft and ships would need stored history | The time control appears on the satellite layer only, 24 hours either way for free users |
| One server process holds the live data in memory | A second process would double every upstream request (§5.1) | After a restart the map refills within one polling cycle |
| Premium has no payment | The project takes no money; OpenSky's licence is also non-commercial | Premium is switched on for free from the account menu |

## 1.5 Software Development Tools

| Layer | Technology | Reason |
|---|---|---|
| Map | MapLibre GL JS | One continuous view from globe to street level on real imagery |
| 3D models | three.js | Draws the selected aircraft inside MapLibre's WebGL context |
| Frontend | React, TypeScript, Vite | Contract enforced at compile time |
| Backend | FastAPI, Python | Pydantic makes the same contract executable |
| HTTP | httpx | Async, so polling never blocks a request |
| WebSocket | websockets | The global AIS feed pushes rather than answers |
| Storage | In-process memory; SQLite for accounts | One process, one poller; accounts are the only state that must survive a restart |
| Orbits | sgp4 | The standard propagator for the published element format |
| Tests | pytest, Vitest | Both run offline against fixture data |
| Version control | Git, GitHub | Every change is a commit; pushing to main deploys |
| Hosting | Vercel (frontend), Northflank (backend) | Free tiers; both deploy automatically from main |
| OpenSky relay | Python script, Windows Task Scheduler | Runs on a team member's PC, which OpenSky accepts and cloud servers are refused |
| Report and figures | matplotlib, pandoc, Microsoft Word, Playwright | Diagrams drawn from code; screenshots captured from the live site by script |

### Data sources

| Source | Provides | Access |
|---|---|---|
| adsb.lol | Aircraft | Open Database Licence; a key for automated use since November 2026 |
| OpenSky Network | Aircraft | Free, non-commercial, OAuth2, metered |
| Digitraffic (Fintraffic) | Ships, Baltic | CC BY 4.0, commercial permitted, no key |
| aisstream.io | Ships, global | Free, key required |
| CelesTrak / SatNOGS | Orbital elements | Free |
| NASA GIBS, OpenFreeMap | Imagery and map tiles | Open |

## 1.6 Software Success Indicators

Each indicator is tied to an objective and can be checked against the running
system, not just the code.

| Indicator | Objective | Target | Result |
|---|---|---|---|
| Worldwide aircraft on the map | O1 | At least 5,000 aircraft while the relay runs | 5,500 to 9,400 in the relay's log, November 2026 |
| Freshness of aircraft data | O1 | Data age under two minutes | Shown in the status bar; the world is refreshed every 120 s |
| The browser never calls a data source | O2 | Zero requests from the browser to any feed | Every request goes to the Orbital API (§5.1) |
| Upstream failure does not break the map | O3 | An outage shows the last positions, flagged stale, never an error page | Observed on 25 November 2026 with the relay PC off: "upstream is not responding — showing last known positions" |
| API response time | O1 | List endpoint under 100 ms | 23 ms (NFR-03) |
| Smooth drawing | O1 | 60 frames per second at the 2,000-object cap | 4.2 ms per frame at the median (NFR-02) |
| One data shape for every layer | O4, O5 | Satellites and ships added without changing the shape | Both added; a test on each side enforces it (NFR-27) |
| A new source needs no frontend change | O4 | Zero frontend changes per new feed | Demonstrated twice: adsb.fi, then the OpenSky relay |
| Upstream quotas respected | O2 | OpenSky stays within 4,000 credits a day | The relay's log never showed fewer than 3,600 remaining |
| Accounts and tiers work end to end | O6 | Register, sign in, switch premium on and off | Working on the live site (Figures 7.13 and 7.14) |
| Usable without an account and on a phone | O1 | Every layer works signed out and at 375 px width | Checked on the live site (NFR-30, NFR-33) |
| Decisions are recorded | O7 | Every significant decision written down | 216 entries in the decision log, D1 to D217 |
| Automated tests pass | O3, O4 | All tests pass offline before each release | All 2,087 passing at this revision: 934 backend, 1,153 frontend |
