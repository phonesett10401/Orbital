---
title: "Orbital"
subtitle: "Live Aircraft, Ship and Satellite Tracking --- Project Report"
author:
  - "Phone Sett Paing Kyaw (6708369)"
  - "Bhone Pyae Hein (6708381)"
  - "Han Phyo Htet (6708463)"
  - "Nyan Lin Htet (6708397)"
  - "Pyae Phyo Maung (6708170)"
date: "CSC480 --- November 2026"
lang: en-GB
---
# Chapter 1: Introduction

## 1.1 Background

At any moment roughly fourteen thousand aircraft are in the air, tens of
thousands of ships are at sea, and thousands of satellites are in orbit. Almost
all of them broadcast their position. Aircraft transmit ADS-B, ships transmit
AIS, and satellite orbits are published as orbital elements. The data is public
and free to collect.

It is difficult to use. Four problems stand in the way.

**The raw formats cannot be displayed as received.** ADS-B reports altitude in
feet and speed in knots. AIS encodes "not available" as a number inside the
valid range, so a vessel with no speed reading transmits 102.3 knots. Orbital
elements are a text format that must be run through a physics model before it
means a position.

**Every free source is incomplete, in different places.** Measured on identical
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

**Expected benefits**

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

**In scope**

| Area | Included |
|---|---|
| Aircraft | Live positions from two sources, merged; flight track; airline and type; airport search; receiver coverage |
| Satellites | ~1,400 satellites computed from orbital elements; orbit class; the orbit each one is on |
| Ships | ~26,000 vessels from two sources, merged; type, dimensions, destination, status |
| Solar system | Eight planets and the Moon, navigable |
| Accounts | Registration, sign-in, sessions, three tiers |
| Time travel | Historical satellite positions, limited by tier |

**Out of scope**

| Excluded | Reason |
|---|---|
| Space debris and rocket bodies | The catalogue holds ~100,000 objects, most not worth drawing |
| Collision or re-entry prediction | The model is accurate to kilometres; a viewer could not detect a wrong answer |
| A fourth object class | Requires a written decision; enforced by a test on each side |
| Ground-station passes | Feasible but outside the objectives |
| Flight or voyage prediction | Orbital reports observations, it does not forecast |

**Scale of the system**

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

**Data sources**

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


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 2: Software Overview Analysis

## 2.1 Definitions of Terms

| Term | Meaning in this report |
|---|---|
| ADS-B | Automatic Dependent Surveillance–Broadcast. Aircraft broadcast their identity, position, altitude and speed about once a second; ground receivers pick it up |
| AIS | Automatic Identification System. The ship equivalent of ADS-B: position every few seconds, name, type and destination every six minutes |
| ICAO address | The unique 24-bit hexadecimal code of an aircraft's transponder, for example 885179. Orbital's identifier for an aircraft |
| Callsign | The flight's radio name, for example THA923. What visitors search for |
| Squawk | The four-digit transponder code assigned by air traffic control |
| MMSI | Maritime Mobile Service Identity, the nine-digit number of a ship's radio. Orbital's identifier for a ship |
| IMO number | A ship's permanent seven-digit hull number, which survives renaming |
| TLE (orbital elements) | Two-line element set: the published description of a satellite's orbit, from which a position is computed |
| SGP4 | The standard model that turns orbital elements into a position for a given moment |
| NORAD number | A satellite's catalogue number, for example 49044 for the ISS's Nauka module |
| LEO, MEO, GEO | Low Earth orbit (under 2,000 km), medium Earth orbit (to 34,000 km) and geostationary orbit (35,786 km) |
| Provider | The backend module that speaks to one data source and returns the shared data shape |
| Union provider | Two providers combined into one layer, each filling the other's gaps |
| Poller | The backend component that fetches from each source on a schedule, with retry and backoff |
| Store | The in-memory table of the latest position of every object |
| Relay | A script on a team member's PC that fetches from OpenSky, which refuses cloud servers, and posts the result to the Orbital server |
| Credit | OpenSky's unit of quota. A worldwide fetch costs 4; a free account has 4,000 a day |
| Bounding box | The rectangle of latitude and longitude currently on screen. The API returns only objects inside it |
| Thinning | Returning a sample of at most 2,000 objects when more are in view, so the browser can draw them in time |
| Stale | Data older than its source's threshold. Shown faded and flagged, never hidden |
| Dead reckoning | Moving a marker between updates along its last known heading and speed, so motion looks continuous |
| Detail panel | The card that opens when an object is selected, showing everything known about it |
| Tier | A level of account: free or premium (and administrator, with no interface) |
| ETag / 304 | An HTTP mechanism that lets the server answer "unchanged" without sending the data again |
| WebGL | The browser's interface to the graphics card, which MapLibre uses to draw the map |
| ODbL, CC BY 4.0 | Open data licences of the aircraft and Finnish ship data, both requiring attribution |

## 2.2 Related Theories

**ADS-B.** Aircraft broadcast identity, position, altitude and velocity about
once a second. Coverage depends on a receiver being in range, which is why
oceanic regions are sparse in every terrestrial network.

**AIS.** Vessels broadcast position every few seconds and identity — name, type,
dimensions, destination — every six minutes. Two consequences follow. "Not
available" is a number rather than a blank: a speed of 102.3 knots, a course of
360° and a heading of 511 all mean the transmitter did not say. And identity
accumulates far more slowly than position: measured at 26.5 static messages per
second against 114 position reports, vessel type coverage rose from 3% at thirty
seconds to 62% after fifty-four minutes.

**SGP4 and orbital elements.** Satellite positions are computed from published
two-line element sets. Elements describe an orbit rather than a position and
stay usable for days, so the layer survives an upstream outage. Accuracy
degrades roughly a kilometre per day from epoch, silently: of 1,670 element sets
in one live feed, 87 were over a year old and the oldest was from 1975. Anything
past seven days is refused.

**Map projection.** A pixel covers a different ground distance at every zoom and
latitude — about 750 m at zoom 7, about 6 m at zoom 14. This arithmetic
determines how often the display needs redrawing, and it is why drawing every
object at every zoom is neither useful nor affordable.

**Signed distance field icons.** Marker symbols are stored as distance fields so
one silhouette can be tinted per object rather than needing an image per colour.
The alpha channel encodes distance rather than coverage, so thin detail
dissolves when scaled down; marker artwork is therefore deliberately chunky.

**HTTP conditional requests.** The polled endpoints use ETags. When the data has
not changed the server returns 304 Not Modified before reading its store — no
filtering, thinning, serialisation or compression.

## 2.3 Related Information Systems

| System | Covers | Model | Relationship |
|---|---|---|---|
| Flightradar24 | Aircraft | Commercial | The reference for a mature tracker; larger network, closed data |
| MarineTraffic | Ships | Commercial | The shipping equivalent; acquired during this project |
| OpenSky Network | Aircraft | Research | Used as a source; its non-commercial clause constrains Appendix A.2 |
| adsb.lol | Aircraft | Community | Used as the primary aircraft source |
| AISHub | Ships | Reciprocal | Rejected: access requires contributing a receiver |
| N2YO, Heavens-Above | Satellites | Free | Comparable satellite tracking; neither combines classes |

Each individual layer is done better elsewhere by organisations with larger
networks. What distinguishes Orbital is that three classes of object with three
different acquisition models — observed and metered, observed and free, and
computed — are presented on one map through one shared data shape.

A deliberate search found no free, global, key-less ship feed equivalent to
adsb.lol. An AIS receiver is a real installation rather than a cheap dongle, so
volunteer networks operate on reciprocity, and the commercial half of the market
has consolidated under two owners.

## 2.4 Stakeholders

Orbital's stakeholder map has an unusual shape: most of its stakeholders are
upstream. The parties with the greatest power over whether the system works are
the data providers, none of whom have any relationship with the project.

**Upstream — the data providers**

| Stakeholder | Interest | Power | How the design responds |
|---|---|---|---|
| adsb.lol | That clients do not abuse a donated service; automated clients use a key | High | One backend, fixed request count regardless of viewers; queries kept within its 250 nm limit; a key has been requested |
| OpenSky Network | Non-commercial use; quota respected; no requests from cloud servers | High | Fetched from a team member's PC by the relay, only while someone is watching; at most one worldwide fetch every two minutes, inside the daily allowance |
| Fintraffic | Attribution under CC BY 4.0 | Medium | Attributed; polled at the rate its own cache headers ask for |
| aisstream.io | Not stated | Medium | Used as a free public service and credited; behind a switch that disables it if the project is monetised |
| CelesTrak / SatNOGS | Not to be polled excessively | Medium | Refreshed every six hours, cached to disk, with a fallback |
| Volunteer receiver operators | Recognition that coverage is theirs | Low | The map draws where no network reaches |

Because the upstream stakeholders hold the power and grant no guarantees, the
system is designed so any of them failing degrades the display rather than
breaking it. That is a requirement derived from stakeholder analysis rather than
a technical preference.

**Downstream — the users**

| Stakeholder | Needs | Power |
|---|---|---|
| Anonymous viewer | To look without registering; not to be misled | High, the default user |
| Registered free user | An identity; recent history | Medium |
| Premium user | A wider historical window | Medium |
| Administrator | Account management | Low, one role |

The administrator tier exists in the data but has no interface. An account can
only be promoted from a terminal on the server, and the public endpoint refuses
that tier under all configurations.

**The team**

The five team members and their roles are set out in §4.3.



```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 3: Software Requirements Specification

## 3.1 System Overview

**Purpose**

This specification covers Orbital, a web application presenting live aircraft,
ship and satellite positions on an interactive Earth. It defines the external
interfaces, the shared data contract and the operating constraints.

**System context**

```
  External feeds  ->  1. INGESTION  ->  2. API  ->  3. FRONTEND
  (six sources)       providers,        reads the    MapLibre and
                      poller, store     store only   React client
```

Data flows in one direction, and each layer knows only the layer beneath it.
Three properties follow:

1. The browser never talks to a data source, so rate limiting and caching are
   enforced in one place.
2. Ingestion does not know a browser exists, and the frontend does not know
   where the data came from.
3. Upstream failure is contained at layer 1.

**User classes**

| Class | Access |
|---|---|
| Anonymous Viewer | Full read access, no account |
| Registered User | Identity, 24-hour history |
| Premium User | 7-day history, no advertisements |
| Administrator | Terminal only |

**Constraints**

| Constraint | Source |
|---|---|
| OpenSky may not be used commercially | Provider terms |
| OpenSky spending within a daily allowance | Provider terms |
| adsb.lol allows 4 requests then ~1 per 12 s | Measured |
| Digitraffic states a 60-second cache | Provider headers |
| Satellite accuracy untrustworthy beyond 7 days | SGP4 |
| The backend is a single-threaded event loop | Runtime |
| AIS identity arrives on a 6-minute cycle | Protocol |

## 3.2 Core Functional Requirements

The core requirements are what the system must do (3.2.1), the data it must
hold and exchange (3.2.2), and the technical, integration and usability
conditions it must meet while doing so (3.2.3). Every requirement has an
identifier, so it can be traced to the code and tests that satisfy it
(§6.1.1).

### 3.2.1 Functional Requirements

Priority is M (must), S (should) or C (could). All are implemented.

**Data acquisition**

| ID | Requirement | Pri |
|---|---|---|
| FR-01 | Retrieve live aircraft positions from an external source | M |
| FR-02 | Merge two aircraft sources, preferring the fresher record | S |
| FR-03 | Compute satellite positions from orbital elements | M |
| FR-04 | Refuse orbital elements older than seven days | M |
| FR-05 | Retrieve ship positions from a regional and a global source | S |
| FR-06 | Merge ship sources so a field is never overwritten by a blank | M |
| FR-07 | Poll each source on a schedule within its rate limit | M |
| FR-08 | Retain the last successful snapshot when a source fails | M |
| FR-09 | Evict objects not re-observed within a per-layer TTL | M |
| FR-10 | Run entirely offline from fixture data | M |

**API**

| ID | Requirement | Pri |
|---|---|---|
| FR-11 | List objects of a layer, filtered by bounding box | M |
| FR-12 | Return one object in full, with its observed track | M |
| FR-13 | Search a layer by name or identifier | M |
| FR-14 | Search all four kinds in one request | S |
| FR-15 | Reduce results to a maximum, spread across the visible area | M |
| FR-16 | Answer 304 when the client holds the current representation | S |
| FR-17 | Report ingestion health and data freshness | M |
| FR-18 | Never call an external service while handling a request | M |
| FR-19 | Refuse malformed input with a precise error | M |
| FR-20 | Clamp a requested result count to the configured maximum | M |

**Presentation**

| ID | Requirement | Pri |
|---|---|---|
| FR-21 | Draw an interactive Earth, globe to street level | M |
| FR-22 | Draw each object oriented to its heading | M |
| FR-23 | Draw an unknown heading without implying one | M |
| FR-24 | Fade an object older than two minutes | M |
| FR-25 | Interpolate positions between polls | M |
| FR-26 | Switch between the three layers | M |
| FR-27 | Change all surrounding text and the key with the layer | M |
| FR-28 | Select an object and show its details | M |
| FR-29 | Draw the observed track of the selected object | M |
| FR-30 | Draw the selected aircraft as a 3D airframe | C |
| FR-31 | Show receiver coverage | S |
| FR-32 | Offer a solar system view with navigable planets | C |
| FR-33 | Colour each layer by the property that varies within it | M |

**Accounts and entitlements**

| ID | Requirement | Pri |
|---|---|---|
| FR-34 | Register with an email and a password of at least 10 characters | M |
| FR-35 | Sign in and out; maintain a session across reloads | M |
| FR-36 | Hash passwords; never store them in plain text | M |
| FR-37 | View satellite positions at a past instant | S |
| FR-38 | Limit the window by tier: 24 hours free, 7 days premium | M |
| FR-39 | Refuse a request outside the window with a stated reason | M |
| FR-40 | Allow an account to change its own tier between free and premium | S |
| FR-41 | Refuse the administrator tier from the public interface | M |
| FR-42 | Show advertisements to accounts that are not premium | S |

The premium window is seven days because that is where propagation accuracy
becomes untrustworthy. No tier can exceed it.

### 3.2.2 Data Requirements

**Data the system takes in**

| Data | Source | Format | Refreshed |
|---|---|---|---|
| Aircraft positions, worldwide | OpenSky Network, through the home relay | JSON over HTTPS, gzipped by the relay | Every 120 s while someone is watching |
| Aircraft positions, area in view | adsb.lol and adsb.fi | JSON over HTTPS | On each viewport request, within each source's limit |
| Flown track of a selected aircraft | OpenSky, through the home relay | JSON over HTTPS | On request, when an aircraft is selected |
| Scheduled route of a flight | Community route database | JSON over HTTPS | On request, cached |
| Satellite orbital elements and names | CelesTrak, SatNOGS | Two-line element sets, JSON | Every six hours, cached to disk |
| Lunar spacecraft positions | NASA JPL Horizons | Text over HTTPS | Published ephemerides, cached |
| Ship positions and identity, Baltic | Digitraffic (Fintraffic) | JSON over HTTPS | Every 60 s, as its cache headers ask |
| Ship positions and identity, global | aisstream.io | WebSocket stream | Continuous |
| Aircraft photographs | Planespotters | Image URL, fetched by the browser | On selection |
| Map imagery and tiles | NASA GIBS, OpenFreeMap | Raster and vector tiles | Fetched by the browser |

**The shared data shape**

Every moving object, whatever its source, is represented identically.

| Field | Type | Meaning |
|---|---|---|
| id | string | Stable identifier within a provider: ICAO address, NORAD number or MMSI |
| lat, lon | number | Degrees, WGS84 |
| altitude | number or null | Metres above mean sea level; zero means zero, null means the source did not say |
| velocity | number or null | Metres per second |
| heading | number or null | Degrees clockwise from true north; null is never drawn as north |
| label | string | Short human-readable name: callsign, satellite name or ship name |
| model | string or null | What the source says the object is |
| lastSeen | string | When the position was current, never when we polled |
| type | enum | aircraft, satellite or ship |

Anything meaningful to only one kind of object lives in a generic meta map, so a
provider can add a field without a frontend change. This is what made the second
and third layers cost one module each.

**Data the system keeps**

| Store | Contents | Where | Kept for |
|---|---|---|---|
| Live objects | The newest record of every aircraft, ship and satellite | Server memory | Until not re-observed within the layer's retention window (300 s for aircraft) |
| Track history | Up to 120 recent positions per aircraft | Server memory | As long as the aircraft is held |
| Fetched tracks and routes | The relay's flown track and the scheduled route of recently selected flights | Server memory | 120 s for tracks; routes cached |
| Ship identity | Name, type, size and destination per MMSI | Server memory | Six hours, longer than its position |
| Orbital elements | The latest element set per satellite | Disk cache on the server | Until replaced; refused once older than seven days |
| Accounts | Email, scrypt password hash, tier, sessions | SQLite file on a persistent volume | Until the account is deleted |

Only the accounts must survive a restart. Everything else is rebuilt from the
feeds within one polling cycle, which is why it is held in memory (§5.2.1).

### 3.2.3 Other Requirements

Requirements that are not functions of the system but conditions on how it delivers them.

#### 3.2.3.1 Technical Requirements

Measurable conditions on speed, failure behaviour, security and how the code is kept changeable.

**Performance**

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-01 | Marker rendering at the cap | < 16.7 ms | 0.80 ms at 2,000 markers |
| NFR-02 | Sustained frame time under load | 60 fps | 4.2 ms p50, 5.9 ms p99 |
| NFR-03 | List endpoint response | < 100 ms | 23 ms |
| NFR-04 | Combined search response | < 100 ms | 47 ms |
| NFR-05 | Detail lookup | < 10 ms | 0.01 ms |
| NFR-06 | Responses compressed | — | 366 KB to 24.5 KB |
| NFR-07 | No request may block the event loop indefinitely | — | Result count clamped |

**Reliability**

| ID | Requirement |
|---|---|
| NFR-08 | An upstream failure must not produce an error response |
| NFR-09 | Data past its threshold must be flagged, not hidden |
| NFR-10 | One source failing must not disable a multi-source layer |
| NFR-11 | A dropped stream must reconnect without losing accumulated state |
| NFR-12 | The system must start without credentials |

**Security**

| ID | Requirement |
|---|---|
| NFR-20 | Passwords hashed with scrypt; never logged or returned |
| NFR-21 | Session cookies HttpOnly and SameSite |
| NFR-22 | Credentials read from environment or a git-ignored file |
| NFR-23 | A configuration object must never be printed whole |
| NFR-24 | Administrator privilege not obtainable through any public endpoint |

**Maintainability**

| ID | Requirement | Evidence |
|---|---|---|
| NFR-25 | One shared data shape across all layers and both languages | Kept in step by type checks |
| NFR-26 | A new data source must not require frontend changes | Demonstrated twice |
| NFR-27 | A new object class requires a written decision | Enforced by a test on each side |
| NFR-28 | Every significant decision recorded | 216 entries |
| NFR-29 | Both suites runnable offline | No test makes an external call |

#### 3.2.3.2 Integration Requirements

Orbital integrates with seven outside services and exposes one interface of its
own. Each outside service is reached by exactly one provider module, so its
quirks stay in one file and its failure stays in one layer.

| ID | Integration | Requirement |
|---|---|---|
| IR-01 | OpenSky Network | Reached only from the home relay, because OpenSky refuses cloud servers. The relay authenticates with OAuth2, fetches only while someone is watching, and posts to the server with a shared secret |
| IR-02 | adsb.lol | Queries kept within its 250 nm radius; one shared backend so viewer count does not raise request count; a key to be used once issued |
| IR-03 | adsb.fi | Used for the area in view; failures of either aircraft feed must not disable the layer (NFR-10) |
| IR-04 | Digitraffic | Polled no faster than its stated 60-second cache; attributed under CC BY 4.0 |
| IR-05 | aisstream.io | One WebSocket for the whole world, reconnecting with backoff without losing accumulated ships (NFR-11) |
| IR-06 | CelesTrak, SatNOGS | Refreshed every six hours with a disk cache, and each the fallback of the other |
| IR-07 | NASA JPL Horizons | Lunar spacecraft ephemerides fetched and cached, never on a visitor's request path |
| IR-08 | Relay routes | `/api/relay/*` refuse every request without the shared token, and are switched off entirely when no token is configured |
| IR-09 | Browser to API | The browser talks only to the Orbital API below; it never calls a data source (O2) |

**The Orbital API**

| Method | Path | Purpose |
|---|---|---|
| GET | /api/aircraft | Aircraft in a bounding box |
| GET | /api/aircraft/{id} | One aircraft with track and route |
| GET | /api/aircraft/search | Aircraft by callsign or address |
| GET | /api/satellites | Satellites, optionally at a past instant |
| GET | /api/satellites/{id} | One satellite |
| GET | /api/ships | Ships in a bounding box |
| GET | /api/ships/{id} | One ship |
| GET | /api/ships/search | Ships by name or MMSI |
| GET | /api/search | Combined search across four kinds |
| GET | /api/moon/satellites | Spacecraft in lunar orbit |
| GET | /api/health | Ingestion status and freshness |
| POST | /api/auth/register | Create an account |
| POST | /api/auth/login | Begin a session |
| POST | /api/auth/logout | End a session |
| GET | /api/auth/me | The current account |
| POST | /api/auth/subscription | Change own tier |
| GET | /api/relay/wanted | Relay only: is anyone watching, and which tracks are wanted |
| POST | /api/relay/opensky | Relay only: store one worldwide OpenSky answer |
| POST | /api/relay/track/{id} | Relay only: supply one aircraft's flown track |

#### 3.2.3.3 Usability Requirements

Usability here has two halves: that anyone can use the map, and that nothing on
it misleads them. The second matters as much as the first, because a map of
four-minute-old positions looks exactly like a map of live ones.

**Usability**

| ID | Requirement |
|---|---|
| NFR-30 | Usable without an account |
| NFR-31 | Reduced-motion preference respected |
| NFR-32 | Controls reachable and labelled for assistive technology |
| NFR-33 | Layout usable at a 375 px viewport |

**Accuracy**

| ID | Requirement |
|---|---|
| NFR-13 | A protocol's "not available" encoding must never be shown as a value |
| NFR-14 | An object without a position is not drawn |
| NFR-15 | An unknown heading must not be drawn as north |
| NFR-16 | Values shown in the unit their readers use |
| NFR-17 | Text around the map must describe the layer shown, including its limits |
| NFR-18 | A computed position must not report an observation age |
| NFR-19 | A physically impossible speed must be rejected |


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 4: Project Methodology

The project was run as a sequence of **incremental phases, each delivering a
working vertical slice**: one kind of object taken all the way from its data
feed to a marker on the deployed map before the next was started. Each phase
ended with a team review that accepted the phase or listed what was
outstanding. The phases are listed in §6.2.

Three practices held the method together:

| Practice | What it means in this project |
|---|---|
| A shared data shape fixed first | The contract every layer speaks was agreed before any provider was written, so later layers could be built in parallel (§3.2.2) |
| A written decision record | Every significant choice is recorded with its alternatives and reasons: 216 entries by the end |
| A handover every session | What was done, what is blocked, and who is waiting on whom, written at the end of every working session (Appendix B.2) |

## 4.1 Project Implementation Plan (Gantt Chart)

**Work breakdown structure**

The work is broken down to the level at which one person owns one deliverable.
Decomposing further produces a task list that is stale within a week;
decomposing less leaves nobody accountable for anything.

![Figure 4.1 — Work breakdown structure. Six work packages, each decomposed to a deliverable with a named owner.](figures/4-1-work-breakdown.png){width=6.4in}

| WBS | Work package | Primary owner | Key deliverable |
|---|---|---|---|
| 1 | Project Management | Phone Sett Paing Kyaw | Decision record, phase boundaries, handover |
| 2 | Requirements and Analysis | Han Phyo Htet, Bhone Pyae Hein | Requirements, data contract, API specification |
| 3 | Backend Development | Phone Sett Paing Kyaw, Bhone Pyae Hein | Providers, poller, store, REST API, accounts |
| 4 | Frontend Development | Phone Sett Paing Kyaw | Map renderer, object layers, search, detail |
| 5 | Quality and Testing | Han Phyo Htet, Nyan Lin Htet, Pyae Phyo Maung | Test plan, suites, defect log, UAT |
| 6 | Environment and Delivery | Nyan Lin Htet | Build, feeds and keys, deployment, report |

**Package 3 is decomposed by phase rather than by component**, which is not the
conventional choice. A component breakdown — "the ingestion layer", "the API" —
would describe the architecture rather than the work, and would hide the fact
that most later packages touch the ingestion layer only by adding one file to
it. Breaking it down by delivered phase makes the actual shape of the effort
visible: each new object type is one provider module and one registry entry.

**Schedule**

![Figure 4.2 — Planned schedule. Twelve weeks, six work packages, three milestones.](figures/4-2-gantt-chart.png){width=6.6in}

**This is the plan, not the log.** The bars are what the team undertook to do
and the order the dependencies allow. What was actually delivered, phase by
phase, is listed in §6.2 and Appendix A.4. Keeping
them apart matters: a Gantt chart redrawn after the fact to match what happened
is not a plan and cannot be used to judge whether planning worked.

**Milestones**

| Milestone | Week | Condition for passing |
|---|---|---|
| M1 Requirements signed off | 3 | Data contract and API specification agreed by all three layers |
| M2 Feature complete | 8 | All three object layers render live; accounts and entitlements work |
| M3 Report and demonstration | 11 | Deployed system, report, test results, demonstration rehearsed |

**The critical path**

Requirements → data contract → the first provider → the poller and store → the
API → the map renderer → the first layer on screen. Everything after that first
vertical slice is parallel: the satellite layer, the ship layer and the accounts
work each touch a different provider or a different route, and none of them
blocks another.

**That is a designed property, not a fortunate one.** The shared data shape was
specified before any provider was written precisely so that the second and third
object types would not sit behind the first. The measured evidence that it
worked is in Appendix A.4: the ship layer cost the same as the satellite layer four
months later, and the polling logic was not modified for either.

**Scheduling assumption**

The window is twelve weeks from **25 August 2026**, the date of the first
commit. If the module's submission date differs, the plan shifts with it — the
dependencies and durations do not change, only the calendar they are laid
against.

## 4.2 Risk Management Plan (Traceability Matrix)

Probability and impact are graded **H/M/L**. The response column says what was
actually built or done, not what would ideally be done — a risk register of
intentions is a document nobody checks against the system.

| # | Risk | P | I | Response |
|---|---|---|---|---|
| R1 | An upstream feed becomes unavailable | H | H | Last good snapshot served with a visible staleness flag; aircraft and ships each have two independent feeds |
| R2 | An upstream rate-limits or bans the client | M | H | One backend for all viewers; measured limits enforced by a gate; exponential backoff honouring `Retry-After` |
| R3 | The browser cannot draw the object count | M | H | Responses thinned to a 2,000 cap; one layer at a time; positions interpolated between polls |
| R4 | Traffic outgrows the single backend | M | H | Viewer count is decoupled from upstream cost; conditional requests answer roughly twenty-nine polls in thirty without building a response; per-request work is bounded by the 2,000 cap |
| R5 | The map shows something false and nothing says so | M | H | Every response carries its age and a staleness flag; a marker fades after two minutes unreported; the status bar states how many of how many are drawn |
| R6 | Secrets committed to the repository | L | H | Credentials in environment variables only; configuration never printed as an object, only field by field |
| R7 | Work serialises behind one member | M | M | The shared data shape fixed before any provider was written, so the layers proceed in parallel; handover written every session |
| R8 | A feed's licence forbids the intended use | M | M | Licences recorded per source; the commercial constraint is stated in Appendix A.2 rather than assumed away |
| R9 | A defect resists diagnosis and consumes the schedule | M | H | Every defect written down with how it was found; a fix counts as fixed when demonstrated, not when written |
| R10 | A decision correct when made becomes wrong later | M | M | Decision record carries alternatives and reasoning, so a reversal is cheap and evidenced |

**Ordered by how much each one shaped the system, rather than by probability
times impact.** R1 to R5 are the ones with a *structural* mitigation — something
in the architecture exists because of them, and would not exist otherwise:

- **R1** is why a provider can be two providers. The union hides the pair
  behind one interface, so a feed disappearing costs one module.
- **R2** is why there is exactly one backend. A hundred open tabs cost the same
  upstream quota as one, because the browser never calls a source.
- **R3** is why responses are capped at 2,000, why one object layer is drawn at
  a time, and why positions are interpolated between polls rather than fetched.
- **R4** is why the list endpoint answers conditional requests, and why the
  ETag is computed from the store's version counter *before* the store is read.
- **R5** is why the status bar exists in the form it does, why a marker fades
  rather than simply staying put, and why a provider raises instead of
  returning what it managed to get.

The remaining five are managed by practice rather than by structure — a
credential kept out of a file, a defect written down, a decision recorded. That
is a weaker kind of mitigation, because it depends on somebody continuing to do
it, and that is why they come second.

**Risk traceability matrix**

Each risk is traced to the requirements that mitigate it and to the evidence
that the mitigation works, so a risk cannot be marked as handled without a
requirement and a test behind it.

| Risk | Mitigating requirements | Implemented in | Verified by |
|---|---|---|---|
| R1 Feed unavailable | FR-02, FR-05, FR-08, NFR-08, NFR-10 | Union providers, poller, store | `test_union.py`, `test_shipunion.py`, `test_poller.py`, outage tests in `test_api.py`; realised twice in production (below) |
| R2 Rate-limited or banned | FR-07, FR-18, IR-01, IR-02 | Poller, quota, relay | `test_quota.py`, `test_poller.py`, `test_relay.py` |
| R3 Too many objects to draw | FR-15, FR-25, NFR-01, NFR-02 | Thinning, interpolation | `test_thinning.py`, `interpolate.test.ts`, browser measurement (§6.1.5) |
| R4 Traffic outgrows the backend | FR-16, NFR-03, NFR-06 | ETag, compression | `test_etag.py`, `test_app_surface.py` |
| R5 False map, unannounced | FR-24, NFR-09, NFR-17, NFR-18 | Status bar, marker fading | `status.test.ts`, `layerChrome.test.ts`; observed live (§6.1.5) |
| R6 Secrets committed | NFR-22, NFR-23 | Settings read from the environment | Configuration tests; code review |
| R7 Work serialises | NFR-25, NFR-26 | The shared data shape | `test_models.py`; two feeds added with no frontend change |
| R8 Licence forbids use | Constraints in §3.1 | Licence recorded per source | Review of each source's terms |
| R9 Defect consumes the schedule | NFR-29 | Offline test suites, defect log | 2,087 tests run on every change |
| R10 Decision becomes wrong | NFR-28 | Decision record | 216 recorded decisions |

**R4 in detail, because it is the one with a ceiling**

The client polls every 10 seconds and tier 1 refreshes every 300, so roughly
**twenty-nine polls in thirty ask for a snapshot that has not changed**. Each
of those would otherwise serialise two thousand objects, gzip them and write
them to a socket — on the single event loop the poller runs on. The ETag turns
them into a header comparison, and because the tag is computed from the store's
version counter and the query before the store is read, a 304 never builds the
response at all.

The one poll in thirty that does change costs the measured work in Appendix A.1: a
bounding-box filter and a thinning pass, together under one and a half
milliseconds at the 2,000 cap. **Upstream cost does not move at all** with
viewer count, because the browser never calls a source.

**Where the ceiling is, honestly.** Scaling is vertical only. A second worker
would open a second AIS websocket, run its own poller and keep its own store —
doubling the upstream cost and letting two requests disagree about where an
aircraft is. So the answer to sustained growth is a bigger box until a bigger
box runs out, and past that the design has to change: a shared store the
workers read, which is a different system from the one described in Chapter 5.
That is a known limit rather than an oversight, and it is stated here because a
risk register that records only the risks with comfortable answers is not one.

**R5 is the one a tracker has to take seriously**

Every other risk here is visible when it happens: a blank layer, a slow page, a
failed deploy. **This one is invisible by construction.** A map showing
positions from four minutes ago looks exactly like a map showing positions from
four seconds ago, and a sample of two thousand aircraft looks exactly like all
of them. The user cannot detect the failure, so the system has to declare it.

That is why Objective O5 — honest reporting of what is shown — is an objective
rather than a nicety, and why the status bar reports sampling, age and source
rather than leaving them to be assumed.

**R1 was realised, and the plan is judged on that**

OpenSky became unreachable from every cloud host during the project. The
mitigation was not theoretical: a second aircraft feed was added, the union
provider kept the interface identical, and **nothing above the ingestion layer
changed**. The cost was one provider module and one registry entry — the same
cost the architecture had been designed to make it.

It was realised a second time in November 2026. adsb.lol began refusing any
query wider than 250 nautical miles and closed its flight traces to automated
clients, so the world view and the flown route were both lost. OpenSky still
answers a home connection, so a small relay now runs on a team member's PC,
fetches from OpenSky and posts to the server (§5.1). Again nothing above the
ingestion layer changed: the server parses the relayed answer with the same
OpenSky code and stores it like any poll.

**R9 was also realised, and cost more**

Six working sessions went to a single defect that was misdiagnosed five times.
The cause was structural — one camera serving two pictures at very different
scales — and the resolution deleted 376 lines, added 130, and cost no feature.
It is recorded here because a risk register that lists only the risks that were
survived cheaply is not a risk register.

## 4.3 Organizational Structure

The team is five students led by a Project Manager. Each member owns one area
and backs up another, so no area depends on one person alone.

```
                    Project Manager
                 Phone Sett Paing Kyaw
                           |
     +----------------+----+-----------+------------------+
     |                |                |                  |
 System Analysis   Development    Quality Assurance   Technical
 Bhone Pyae Hein   Phone Sett     Han Phyo Htet       Engineering
                   Paing Kyaw,    Pyae Phyo Maung     Nyan Lin Htet
                   Bhone Pyae
                   Hein
```

| Member | Student ID | Roles | Responsibilities | Work packages |
|---|---|---|---|---|
| Phone Sett Paing Kyaw | 6708369 | Project Manager, Developer | Scope and phase boundaries, decision record, backend and frontend development | 1, 3, 4 |
| Bhone Pyae Hein | 6708381 | System Analysis, Co-Developer | Requirements, data contract and API specification, backend development | 2, 3 |
| Han Phyo Htet | 6708463 | Quality Assurance, Business Analysis, Co-Tester | Test plan, acceptance of each phase, business analysis | 2, 5, 6 |
| Nyan Lin Htet | 6708397 | Technical Engineer, Tester | Build, feeds and keys, deployment, testing | 5, 6 |
| Pyae Phyo Maung | 6708170 | Co-Tester, Co-Quality Assurance and Analysis | Test execution, defect log, analysis | 5, 6 |

Seven roles across five people, so most members hold two. That is a
consequence of team size rather than a design: with five people, a role per
person would leave two roles unfilled, and the two that would go are quality
assurance and technical environment — the two whose absence is invisible until
late.

## 4.4 Communication and Coordination Channels

| Channel | Participants | Frequency | Purpose |
|---|---|---|---|
| Written handover | Whole team | End of every working session | What was done, what is blocked, who is waiting on whom |
| Decision record | Author, reviewed by PM | On every significant choice | The choice, its alternatives, and the reasoning |
| Defect log | QA, Testers, Developer | On every defect found | Severity, how it was found, whether it is fixed |
| Repository history | Whole team | Continuous | The change, and the reason for it, in the commit message |
| Team review | Whole team | Per phase boundary | Accept the phase, or state what is outstanding |
| Report and demonstration | Whole team, assessor | Milestone M3 | The deliverable |

**Why handover is a deliverable rather than a courtesy**

The single largest risk to a part-time team is not technical: it is that context
is lost between sessions and re-derived at full cost. Every session therefore
ends with a written handover, and it is package 1.4 in the WBS with an owner
against it — because a practice that is only a good intention is a practice that
stops the first week somebody is busy.

**Escalation**

A blocked item is raised in the handover. If it remains blocked at the next
session it goes to the Project Manager, who decides whether it is in the current
phase at all. **A blocker that is out of the phase is closed rather than
carried**, which is how the phase boundary does its job: the alternative is a
list that grows all semester and is resolved by the deadline rather than by
anyone.


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 5: System Design

## 5.1 System Architecture

Orbital is three layers with one rule between them: **data flows in one
direction, and each layer knows only the layer directly beneath it.**

![Figure 5.1 — System architecture. Six external feeds, one reached through a home relay, three internal layers, and one direction of flow.](figures/5-1-system-architecture.png){width=6.5in}

**The three layers**

| Layer | Owns | Never does |
|---|---|---|
| 1 Ingestion | Speaking to upstreams, normalising, scheduling, holding the current state | Know that a browser exists |
| 2 API | Reading the store, filtering by bounding box, thinning, accounts | Call an upstream |
| 3 Frontend | Rendering, interpolation, interaction | Know where the data came from |

**Three properties follow, and they are the design**

**The browser never talks to a data source.** Every external call goes through
the backend, so rate limiting and caching are enforced in exactly one place. A
hundred open browser tabs cost the same upstream quota as one. This is what made
adding a second aircraft feed a backend-only change: the frontend was never
told, because there was nothing to tell it.

**Either end can be replaced without touching the other**, and both have been.
The backend gained a second upstream and the frontend gained an entirely
different renderer, neither requiring a change on the other side of the wire.

**Upstream failure is contained at layer 1.** The API serves the last good
snapshot with an explicit staleness flag. A feed outage degrades the display; it
does not break it.

**Deployment**

| Component | Host | Shape |
|---|---|---|
| Frontend | Vercel | Static build, no server |
| Landing page | Vercel | `/landing`, the same deployment, static files |
| Backend | Northflank | One container, **one worker** |
| Accounts database | Northflank volume | SQLite file |
| OpenSky relay | A team member's PC | Script kept running by a Windows task, on mains or battery |

**One worker, deliberately.** The backend holds a websocket open to the AIS
stream, polls on a schedule, and answers every request from memory. A second
worker would open a second AIS socket, run its own poller and keep its own
store: the upstream cost would double and two requests could disagree about
where an aircraft is. It is scaled by making the box bigger, not by adding
boxes.

**The relay exists because OpenSky refuses cloud hosts.** It answers a home
connection, so a small script on a team member's PC does the fetching. Every
three seconds it asks the server what it wants, and the server answers with two
things:

| Request | Relay does | Cost |
|---|---|---|
| Someone is watching, and two minutes have passed | Fetches the world (about 5,500 aircraft) and posts it, gzipped, about 220 KB | 4 credits |
| A visitor clicked an aircraft | Fetches that aircraft's flown track and posts it | 4 credits |

Both addresses on the server need a shared secret, and are switched off without
one. With the PC off, the map falls back to adsb.fi for the area in view and to
the trail the server observed itself, which is now kept for four hours.

**The numbers that shape it**

| Parameter | Value | Why that value |
|---|---|---|
| Objects per response | 2,000 | The cap above which the browser cannot draw a frame in budget |
| Object retention | 300 s | Longer than the longest poll interval, so a missed poll never drops an aircraft |
| Union supplement interval | 120 s | The metered feed answers once per interval regardless of the free feed's cadence |
| Aircraft request rate | 4 per minute | A fifth under the measured limit of burst-4 then ~5 per minute |
| Vessel ceiling | 14,000 | Bounds memory for a feed that accumulates rather than answers |

**Data flow diagram, Level 1**

![Figure 5.2 — Data flow diagram, Level 1. From live feeds to the visitor's screen.](figures/5-1c-data-flow-level-1.png){width=6.5in}

| Process | Takes in | Gives out |
|---|---|---|
| 1.0 Collect and normalise | Raw positions from the live feeds | Common records |
| 2.0 Merge, keep newest | Common records | The newest position of each object, written to D1 |
| 3.0 Serve map data | The visitor's view area or search, and objects from D1 | Map data for that area only |
| 4.0 Sign in | Email and password | A session, checked against D2 |

D1, the live objects, is held in memory and rebuilt from the feeds after a
restart. D2, the accounts, is the one store saved to disk. Process 3.0 only
reads D1 and never calls a feed, so the map never waits for an outside service.

## 5.2 Software Design

### 5.2.1 Database Design

![Figure 5.3 — Entity relationship diagram. Two persisted tables, and the domain entities that have no table.](figures/5-2-er-diagram.png){width=6.5in}

**Two tables, and that is the design**

The persisted schema is `accounts` and `sessions`. Nothing else in Orbital is
written down.

```sql
CREATE TABLE accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    tier          TEXT    NOT NULL DEFAULT 'free',
    created_at    TEXT    NOT NULL
);

CREATE TABLE sessions (
    token_hash TEXT    PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    expires_at TEXT    NOT NULL
);
CREATE INDEX sessions_account ON sessions (account_id);
```

An account holds many sessions: one per signed-in device, each expiring on its
own schedule.

**The raw session token is returned once, at creation, and never stored.** Only
its hash is in the table, so the token exists in the user's cookie and nowhere
else. A copy of the database does not let anyone sign in as anybody.

**Why almost nothing is persisted**

A tracker looks like a system that should have a large database, and Orbital
deliberately does not. A poll replaces the previous snapshot; positions are held
in memory and served from there; an object not re-observed within the retention
window is evicted. Nothing about an aircraft is written to disk at all.

Three consequences, and all three are wanted:

- **The API cannot be slow because a database is slow**, because there is no
  database on the request path for tracked objects.
- **There is no schema migration** for the thing that changes most often — the
  shape of a feed — because a feed's shape is normalised at the boundary and
  never stored in its own form.
- **Restarting is cheap and safe.** The only state worth keeping is an account,
  and that is the only state kept.

The cost is equally plain: Orbital cannot answer a question about last Tuesday.
Entitlement windows of twenty-four hours and seven days are bounded by what is
still in memory, not by a query.

**The entities that have no table**

`TrackedObject` is the shared shape all three object types normalise to, with
`TrackPoint`, `Airport` and `FlightRoute` hanging off it. They have real
structure, real relationships and real cardinality — they simply have no rows.
They are drawn dashed in Figure 5.3 because omitting them would make the data
model look like two tables about sign-in, which is the least interesting part of
this system.

**One shape holds all three object types, and the absent fields are `None`.** An
aircraft has a route and a track; a satellite and a ship have neither. This is
what makes a new object type cost one ingestion module: there is no per-type
schema to add.

### 5.2.2 UML Modeling



```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

#### 5.2.2.1 Use Case Diagram

![Figure 5.4 — Use case diagram. Eleven use cases, five actors, one system boundary.](figures/3-1-use-case-diagram.png){width=6.5in}

UC-03 includes UC-01. UC-06 extends UC-01 when an instant is chosen, if that
instant lies within the actor's entitlement window. UC-07 to UC-10 are started
by a scheduler rather than a person, and are shown because every external
dependency and failure mode lives there.

**Use case descriptions**

**UC-01 View the map**

**Actor** Anonymous Viewer. **Preconditions** None; no account required.

1. The system draws the Earth on satellite imagery.
2. The client requests the active layer's objects for the visible area.
3. The API returns the cached snapshot, filtered and thinned, with its age.
4. The client draws each object oriented to its heading, coloured by the
   property that varies on that layer.
5. Between polls the client interpolates positions.

**A1** Data is stale: the response is flagged, markers past two minutes fade.
**A2** Backend unreachable: the last state remains; the map is not cleared.
**A3** More objects than the cap: a spatially even sample is returned and both
figures are reported.

**UC-02 Switch layer**

**Actor** Anonymous Viewer.

1. The viewer selects Aircraft, Satellites or Ships.
2. The system clears the current selection and objects.
3. All surrounding text changes with the layer — subtitle, search placeholder,
   count noun and colour key.
4. Layer-specific furniture is hidden; airports and receiver coverage belong to
   the aircraft layer.
5. The client polls the new layer's endpoint.

**UC-03 Select an object**

**Actor** Anonymous Viewer. **Includes** UC-01.

1. The viewer clicks a marker.
2. The client requests that object's full record.
3. A panel opens with fields appropriate to the layer.
4. The object's observed track is drawn.

**A1** Empty map clicked: the selection clears. **A2** No longer tracked: a 404
is returned and the panel says so rather than showing an empty record.

**UC-04 Search**

**Actor** Anonymous Viewer.

1. The viewer types into the search box.
2. After a debounce, the client requests results.
3. Matches are returned in separate groups, ranked within each but not across
   them, because they are not comparable.
4. Only the groups the active layer can act on are shown.
5. Choosing a result moves the camera to it and selects it.

**UC-05 Register and sign in**

**Actor** Anonymous Viewer becoming Registered User.

1. The viewer supplies an email and password.
2. A password shorter than ten characters is rejected.
3. The password is hashed with scrypt.
4. A session cookie is issued, HttpOnly and SameSite.

**A1** Email already registered: reported without revealing the password.
**A2** Wrong credentials: one message for both cases, so the response does not
disclose which accounts exist.

**UC-06 View a past instant**

**Actor** Registered or Premium User. **Extends** UC-01. **Precondition** Signed
in, satellite layer active.

1. The user moves the time control to a past instant.
2. The system checks it against the account's window: 24 hours free, 7 days
   premium.
3. Positions are propagated to that instant and returned.

**A1** Outside the window: refused with the window that does apply.
**A2** Beyond seven days: refused for every tier, because propagation accuracy
degrades about a kilometre per day.

**UC-07 Poll a data source**

**Actor** Scheduler, with an external feed as secondary actor.

1. The scheduler waits the configured interval.
2. It checks the remaining quota and the rate gate; if either forbids, it skips.
3. The provider fetches and converts to the shared shape, discarding objects
   without a usable position and converting every "not available" encoding to an
   explicit absence.
4. The store merges the result.

**A1** Unreachable: the previous snapshot is retained and the next attempt is
delayed by an increasing backoff. **A2** Rate limited: the upstream's own retry
hint is used. **A3** Both sources of a layer fail: only then is it an outage.

**UC-08 Refresh orbital elements**

1. Every six hours elements are fetched from CelesTrak.
2. Sets older than seven days from epoch are refused.
3. Accepted elements are cached to disk.

**A1** CelesTrak unavailable: SatNOGS is used. If both fail, cached elements
continue to serve.

**UC-09 Maintain the global AIS stream**

1. A WebSocket is opened and subscribed to the whole world.
2. Positions and identities are accumulated in memory.
3. Positions older than fifteen minutes are removed; identities are kept for six
   hours, because a vessel's name does not expire when its position does.

**A1** Connection dropped: reconnection with backoff, losing nothing, because
the accumulated world is held locally.

**UC-11 Promote an account to administrator**

**Actor** System Administrator at a terminal on the server.

1. The administrator runs the account tool on the host.
2. The tool sets the account's tier.

There is no interface for this and no endpoint that can perform it.

#### 5.2.2.2 Class Diagram

![Figure 5.5 — Class diagram of the ingestion layer.](figures/5-3-class-diagram.png){width=6.5in}

The ingestion layer is the part of Orbital with real class structure, so it is
the part worth drawing. `Provider` is abstract and declares one required
operation: fetch, given an optional bounding box, and return the normalised
shape. Seven concrete providers implement it — one per upstream, plus an offline
fixture that needs no credentials.

**`UnionProvider` is the design point.** It inherits `Provider` *and holds two
of them*: the primary answers every poll, the supplement answers every 120
seconds, and the results are merged. A caller cannot tell a pair of feeds from a
single feed.

That is why the second aircraft source cost what it cost. When the primary
became unreachable from every cloud host, the change was one provider module and
one registry entry; the poller, the store, the API and the entire frontend were
untouched, because none of them can observe the difference.

`Provider` also raises rather than returning partial results —
`ProviderUnavailable`, `ProviderRateLimited`, `ProviderBadResponse`. A provider
that returned nine hundred aircraft instead of two thousand would be reporting
that the sky had emptied. Raising makes a failure a failure.

**The API never holds a `Provider`.** There is no call path from an HTTP request
to a socket, which is the structural reason §5.1's third property is true rather
than merely intended.

**Class relationships**

| Relationship | In Orbital |
|---|---|
| Inheritance | Every feed is a `Provider` (AdsbLol, AdsbFi, OpenSky, Satellites), so the poller treats them all the same way |
| Composition | `UnionProvider` owns its feeds: they are created with it and closed with it |
| Aggregation | A `Poller` has an `ObjectStore`, but the store outlives it and the API shares it |
| Association | The API uses the `ObjectStore` to answer requests and never touches a feed |

#### 5.2.2.3 Sequence Diagram

![Figure 5.6 — Sequence diagram. The poll loop, and a request that does not wait for it.](figures/5-4-sequence-diagram.png){width=6.5in}

Two interactions are drawn on one page deliberately. Separately they look like
an ordinary background job and an ordinary request; together, the actual design
is visible — **they never touch.**

**A.** The poller wakes on its interval, asks the provider to fetch, normalises
what comes back, and applies it to the store. This runs whether or not anyone is
looking.

**B.** The browser pans the map and asks for a bounding box. The API reads the
store, filters, thins to the response cap, adds the staleness flag, and answers.
The frontend interpolates positions between polls so that motion is smooth at a
far lower request rate than smooth motion would otherwise need.

The browser's request does not trigger a fetch, does not wait for one, and
cannot fail because one failed. It reads whatever the store last had. That single
property is why an upstream outage degrades Orbital rather than breaking it, and
why viewer count is decoupled from upstream cost entirely.

## 5.3 Structure Chart

![Figure 5.7 — Structure chart. Orbital as four modules, each with the parts it is made of.](figures/5-1b-structure-chart.png){width=6.5in}

The structure chart breaks Orbital into four modules, matching the layers
above with the store drawn as its own module. Each module calls only the one
beside it, so a change inside one leaves the others untouched.

| Module | Made of |
|---|---|
| 1 Data ingestion | The poller, which asks on a timer; one provider per feed; the union provider, which merges feeds |
| 2 Data store | Live objects held in memory; track history; the accounts database |
| 3 API service | Live map data; search; sign-in and health |
| 4 Map frontend | Map layers; details and search; time control |


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

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

**Environments**

| Environment | Frontend | Backend | Data |
|---|---|---|---|
| Development | Vite dev server on the developer's PC | uvicorn on the developer's PC | Recorded fixtures, or the live feeds |
| Production | Vercel, orbital-liveview.vercel.app | Northflank, one container, one worker | Live feeds; accounts on a persistent volume |
| Relay | — | Python script on a team member's PC, kept running by Windows Task Scheduler | OpenSky, posted to production |

**Deployment process**

1. A change is made on a developer's PC and both test suites are run.
2. The change is checked in the browser against the local or live backend.
3. It is committed and pushed to the main branch on GitHub.
4. Vercel and Northflank build and deploy it automatically.
5. The live site is checked again: the affected screens, the status bar and the
   health endpoint.

Secrets — the OpenSky client credentials, the aisstream key and the relay's
shared token — are set as environment variables on Northflank and in a
git-ignored file on the relay PC. They are never committed or printed.

**Phased implementation**

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

**Operation and maintenance**

| Task | How often | Owner |
|---|---|---|
| Check the relay's log and the status bar's data age | Weekly, and when the map looks thin | Technical Engineer |
| Rotate API keys and the relay token | Each semester, or at once if exposed | Technical Engineer |
| Add the adsb.lol key, and its credit on the map, once issued | Once | Developer |
| Review OpenSky credit use in the relay log | Monthly | Project Manager |
| Run both test suites before any change is pushed | Every change | Whoever makes the change |


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 7: GUI and Description

These are the key screens of Orbital, captured from the live site
(orbital-liveview.vercel.app) on 25 November 2026. The aircraft, ships and
satellites in them are real and were in those positions when captured. Each
screenshot is followed by what the screen is for and how it works. The
"Sponsored" cards are the free tier's advertising; premium removes them.

## 7.1 Interface Layout

![Figure 7.1 — The deployed interface, annotated. Captured headlessly at 1600 × 950 while the deployment was live.](figures/5-6-ui-design.png){width=6.5in}

This is a screenshot of the running system rather than a wireframe. The counts
in the status bar — objects drawn, objects in view, data age, and which feed
answered — are the real ones at the moment of capture.

**The principles the layout follows**

**The map is the product; everything else is chrome at the edges.** Controls
occupy the corners and the top strip. Nothing floats over the centre, because
the centre is the thing the user came for.

**One layer at a time.** Aircraft, satellites and ships are a switch rather than
three checkboxes. All three at once is roughly forty thousand markers and no
legible map; the switch makes that impossible rather than merely discouraged.

**The corner is one column, not four floating controls.** Brand, world chooser,
sign-in and about stack under one another, and the world chooser opens to the
right rather than downward so it does not cover the items beneath it.

**The status bar is the honesty line.** It states that 2,000 of 13,607 objects
in view are drawn, how old the data is, and which feed answered. A tracker that
quietly showed a sample as though it were everything would be easier to build
and would be lying.

**Colour carries meaning, and only meaning.** Altitude is a ramp; marker shape
distinguishes a known heading from an unknown one; a faded marker has not been
reported for over two minutes. The key states all three rather than expecting
the reader to infer them.

**The revenue model is visible in the product.** Advertisement slots are shown to
anonymous and free accounts and removed by the premium tier, and the upgrade
prompt says what premium changes in concrete terms — a full week of history
instead of twenty-four hours — rather than in adjectives.

## 7.2 Live Aircraft

![Figure 7.2 — The worldwide aircraft view.](figures/6-01-world-aircraft.png){width=6.5in}

**Purpose.** The opening screen. It shows every aircraft the system currently
knows about, worldwide, on a 3D globe, so a visitor sees air traffic at a
glance without signing in.

**How it works.** The browser asks the Orbital API for the aircraft inside the
part of the globe on screen. The API reads them from the server's in-memory
store, which the OpenSky relay refreshes every two minutes and adsb.lol and
adsb.fi supplement. When more than 2,000 are in view, the API returns a sample,
and the status bar at the bottom says so ("showing a sample of 5,842 in view")
along with the data's age and source. Colour is altitude, explained in the key.

![Figure 7.3 — Aircraft over mainland Southeast Asia, zoomed in.](figures/6-02-regional-aircraft.png){width=6.5in}

**Purpose.** Following traffic in one region with callsigns readable.

**How it works.** Scrolling zooms the map from the globe to street level in one
continuous view. As the visible area shrinks, the browser asks again for just
that area, so every aircraft in it is drawn instead of a sample. Each icon
points along its heading, is labelled with its callsign, and moves smoothly
between updates by dead reckoning along its last known heading and speed.

## 7.3 Search

![Figure 7.4 — Search suggestions while typing a callsign.](figures/6-03-search.png){width=6.5in}

**Purpose.** Finding a particular flight, airport, satellite or ship without
looking for it on the map.

**How it works.** As the visitor types, the browser sends the text to the
search endpoint, which matches it against the objects held in memory and
returns up to eight suggestions with their altitude. Choosing one, or pressing
Enter, selects that object, flies the camera to it and opens its detail panel.
The search box searches whichever layer is active, and its placeholder text
changes to say what it accepts.

## 7.4 Aircraft Details and Flown Route

![Figure 7.5 — The detail panel of Thai Airways flight THA923, with the route it has flown.](figures/6-04-aircraft-detail.png){width=6.5in}

**Purpose.** Everything known about one aircraft: its photo, airline, aircraft
type, registration, altitude, speed and heading, its scheduled route, and the
path it has actually flown.

**How it works.** Selecting an aircraft asks the API for its details. The
server looks up the airline and aircraft type from shared tables and the
scheduled route from a community route database. It asks the home relay for
the aircraft's flown track from OpenSky, which arrives within a few seconds
and is drawn as the white line. The photo comes from Planespotters and is
credited to its photographer. The panel labels the scheduled route as
published rather than reported, because aircraft do not transmit their
destination.

## 7.5 Satellites

![Figure 7.6 — The satellite layer: about 1,500 satellites, coloured by orbit.](figures/6-05-satellites.png){width=6.5in}

**Purpose.** Showing where active satellites are right now, and what kind of
orbit each is on.

**How it works.** Satellite positions are not downloaded; they are computed.
The server holds the published orbital elements for each satellite, refreshed
every six hours, and calculates each position with the SGP4 model when the
browser asks. Colour shows the orbit class (low, medium, geostationary or
elliptical), and the icon's shape shows what kind of spacecraft it is, as the
key explains.

![Figure 7.7 — The International Space Station selected, with its orbit drawn.](figures/6-06-satellite-detail.png){width=6.5in}

**Purpose.** Details of one satellite: its catalogue number, type, altitude,
speed, orbital period and inclination, and the orbit it follows.

**How it works.** Selecting a satellite computes its path for one full orbit
and draws it as a line around the globe. The panel says the position is
"computed for now", not observed, and how old the orbital elements are,
because accuracy falls as they age. Plain-language notes explain each value,
for example that an inclination of 51.6° means the station never passes north
of 52° or south of −52°.

## 7.6 Time Control

![Figure 7.8 — The sky as it was one hour ago.](figures/6-07-time-control.png){width=6.5in}

**Purpose.** Seeing where the satellites were, or will be, at another moment.

**How it works.** Because satellite positions are computed, they can be
computed for any time. Dragging the slider, or using the arrow keys, sends the
chosen time with each request, and every satellite is recalculated for that
moment. The panel turns amber, shows the exact time in UTC, and offers "Return
to live". Free users can move 24 hours either way and premium users 7 days.

## 7.7 Ships

![Figure 7.9 — Ships in the Gulf of Finland, coloured by vessel type.](figures/6-08-ships.png){width=6.5in}

**Purpose.** Showing vessels near the coast, by type: cargo, passenger, tanker,
tug, fishing and others.

**How it works.** Ship positions come from AIS, merged from two sources: the
Finnish Digitraffic service and the global aisstream.io feed, which pushes
updates to the server over a WebSocket. Both are received by stations on the
shore, which is why the layer is labelled "ships in coastal waters" and is
densest around Finland.

![Figure 7.10 — The detail panel of the passenger ship Silja Serenade.](figures/6-09-ship-detail.png){width=6.5in}

**Purpose.** Details of one vessel: its type, navigational status, speed,
heading, destination and arrival time, size, and identifying numbers.

**How it works.** Name, type, size and destination are broadcast separately
from position, and less often, so the server keeps adding them to a vessel's
record as they arrive. Values a transmitter marks as "not available" are never
shown as numbers, and the status is labelled "as set by the crew" because it
is entered by hand on board.

## 7.8 The Moon

![Figure 7.11 — The Moon, with the three spacecraft in lunar orbit.](figures/6-10-moon.png){width=6.5in}

**Purpose.** Visiting other worlds under the same camera, and following the
spacecraft that orbit the Moon.

**How it works.** The world picker under the logo lists the Sun, the planets
and the Moon. Choosing one flies the camera out and back in, and swaps the
surface imagery. On the Moon, the "In orbit" panel lists LRO, Danuri and
Chandrayaan-2, whose positions come from NASA JPL's Horizons service and are
drawn over the surface.

## 7.9 The Solar System

![Figure 7.12 — The solar system page, with the planets where they are today.](figures/6-11-solar-system.png){width=6.5in}

**Purpose.** An overview of the Sun, the eight planets and the Moon, as a way
to choose a world and to see where Earth is.

**How it works.** The planets' positions are computed for the current date
from their orbits and drawn on their orbital paths. Earth is marked "you are
here". The arrows and the index move between bodies, and "Back to Earth"
returns to the map.

## 7.10 Accounts and Premium

![Figure 7.13 — The sign-in page.](figures/6-12-sign-in.png){width=6.5in}

**Purpose.** Signing in to an existing account or creating a new one. The map
works without an account; an account is needed only for premium.

**How it works.** The email and password are sent to the API over HTTPS. The
server checks the password against a scrypt hash stored in its SQLite
database, and on success sets a session cookie that scripts on the page cannot
read. Passwords are never stored, logged or returned.

![Figure 7.14 — The premium page, comparing the free and premium tiers.](figures/6-13-premium.png){width=6.5in}

**Purpose.** Explaining what premium adds: time travel 7 days either way
instead of 24 hours, and no advertising. Everything else is free.

**How it works.** The page reads the visitor's tier from their session. Orbital
has no payment system, so a signed-in user switches premium on or off with one
click, and the server records the tier on their account. The time control and
the advertising read that tier and change at once.


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 8: Conclusion and Recommendations

## 8.1 Conclusion

Orbital set out to put live aircraft, ships and satellites on one free map in a
browser, without hiding what the data does not know. It does: the deployed
system shows between 5,500 and 9,400 aircraft worldwide, about 14,000 ships
and 1,522 satellites, with the Moon's spacecraft and the solar system beside
them, to anyone who opens the page and without an account.

| Objective | Achieved | Evidence |
|---|---|---|
| O1 Live aircraft on an interactive Earth | Yes | Figures 7.2 to 7.5; aircraft data under two minutes old |
| O2 The browser never calls a data source | Yes | Every request goes to the Orbital API (IR-09) |
| O3 Survive upstream failure | Yes | Two real outages; the map stayed up and said the data was stale (§6.1.5) |
| O4 One shared data shape | Yes | Three object types and seven feeds speak it (§3.2.2) |
| O5 The same architecture for satellites and ships | Yes | Each cost one provider module and one registry entry |
| O6 Accounts and a differentiated tier | Yes | Free and premium time windows and advertising (Figures 7.13, 7.14) |
| O7 Record the reasoning behind decisions | Yes | 216 decisions recorded with their alternatives |

All 2,087 automated tests pass, every functional test case passes on the live
site, and the four defects found in final system testing are fixed (§6.1.5).

The project's main lesson is that **the data sources, not the code, set the
limits.** The architecture's most valuable property turned out to be the one
designed for failure: when a feed was lost, twice, the fix each time was one
new module at the edge of the system, and nothing above the ingestion layer
changed.

## 8.2 Problems Encountered

| Problem | Effect | How it was handled |
|---|---|---|
| OpenSky refuses every cloud server | The backend could not fetch aircraft worldwide | A second aircraft feed was added; later, a relay on a team member's PC fetches from OpenSky and posts to the server |
| adsb.lol limited queries to 250 nm and closed flown tracks to automated clients | The worldwide view and flown routes were lost in November 2026 | The relay took over both; an adsb.lol key has been requested |
| The relay depends on one PC | When the PC sleeps, unplugs or shuts down, only the area in view is shown | Restarts itself every five minutes and on battery; the map falls back and labels the data stale |
| The first renderer could not draw a map | No street-level zoom or vector basemap | Replaced with MapLibre in phase 2, at the cost of one phase |
| One defect was misdiagnosed five times | Six working sessions lost | Resolved by removing the structural cause; recorded as a realised risk (§4.2) |
| Correct code that was never connected | Eighteen defects invisible to unit tests | Every change is now run and looked at before it is accepted |

## 8.3 Recommendations

1. **Move the relay to an always-on device.** A small single-board computer
   such as a Raspberry Pi on a home connection would keep the worldwide view
   available around the clock, instead of only while a team member's laptop is
   on.
2. **Add the adsb.lol key as soon as it is issued**, together with adsb.lol's
   credit on the map. That restores a second worldwide aircraft source that
   does not depend on the relay.
3. **Add a shared store before adding servers.** The single worker is the
   scaling limit (§4.2, R4). Moving the live objects into a shared store such as
   Redis would let several workers serve visitors while one poller fetches.
4. **Store aircraft and ship history.** Time travel currently covers satellites
   only, because they can be computed for any moment. Keeping observed
   positions in a database would extend it to aircraft and ships.
5. **Widen the testing.** Add rendering tests for the main React components
   and test in Safari and Firefox as well as Chrome, so that the gaps listed in
   §6.1.2 shrink.
6. **Decide what premium is for.** Premium is free to switch on because
   Orbital takes no money and OpenSky's licence is non-commercial. A paid tier
   would need a payment provider and a feed licensed for commercial use.


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Appendix A: Feasibility Study

The four feasibility questions were settled before the design depended on them.

## A.1 Technical Feasibility

Every claim below was tested against the live services before the design
depended on it.

| Question | Result |
|---|---|
| Are live aircraft positions obtainable without payment? | Yes. OpenSky returned 11,651 worldwide; adsb.lol 10,009 |
| Can the whole world be fetched economically? | Yes. 10,013 aircraft in 1.9 seconds |
| Can satellite positions be computed rather than fetched? | Yes. ~1,400 satellites, no network in the request path |
| Are live ship positions obtainable without payment? | Yes. 916 vessels in 37 KB from one request; 17,848 in four minutes from the stream |

**Two measurements that changed the design**

**One global query is not enough.** A single 6,000 nautical-mile circle returned
10,013 aircraft and four circles returned 10,009, which appeared to prove one
was sufficient. The other three sample points were inside the area the first
already covered. Over Australia the single circle returned 0 and a direct query
returned 27. The global sweep uses four circles.

**A rate limit cannot be characterised with a burst.** adsb.lol appeared to
tolerate any rate when tested with occasional bursts. Under continuous load it
refused 38% of requests. The real limit is four requests, then approximately one
every twelve seconds.

**Performance**

The backend runs a single-threaded event loop, so a slow operation delays every
other request.

| Objects held | Poll apply | Bbox filter | Thin to 2,000 | Search |
|---|---|---|---|---|
| 2,000 | 0.7 ms | 0.57 ms | 0.82 ms | 1.6 ms |
| 10,000 | 7.4 ms | 3.2 ms | 9.1 ms | 8.3 ms |
| 30,000 | 14.4 ms | 9.2 ms | 43.5 ms | 24.2 ms |

Rendering at the 2,000-marker cap costs 0.80 ms per update, 4.8% of a 60 fps
frame budget, scaling linearly to 10,000.

**Conclusion: technically feasible.** Every required capability was demonstrated
on live services before being designed around.

## A.2 Economic Feasibility

**Direct cost**

| Category | Cost |
|---|---|
| Data sources | 0 |
| Map imagery and tiles | 0 |
| Libraries and tooling | 0 |
| Hosting during development | 0 |
| Total | 0 |

The real cost is labour: five students over one semester.

**The quota is the budget**

No money changes hands, but OpenSky's daily credit allowance is finite and was
budgeted like money. The polling intervals are derived from it rather than
chosen by feel: the configured jobs project 3,072 credits per day against a
4,000 allowance, 77%, leaving headroom for the lookups a user triggers by
clicking. The system refuses to start if a configuration would exceed 85%.

Using the free adsb.lol feed as the primary source, with OpenSky supplementing
it every 120 seconds, decouples the refresh rate from the allowance entirely.
Ships and satellites cost nothing.

**Licensing constrains the revenue model**

| Source | Commercial use |
|---|---|
| Digitraffic | Permitted (CC BY 4.0) |
| adsb.lol | Permitted (ODbL) |
| OpenSky Network | Forbidden, non-commercial only |
| aisstream.io | Not stated |

A commercial version is possible but not with the current source mix: the
aircraft layer would have to drop OpenSky and accept its coverage gaps.

**The implemented model**

A free tier supported by advertising and a paid tier are both implemented.
Advertisements are the project's own messages in real advertisement dimensions,
because a third-party network would introduce tracking into a project that
collects no analytics. There is no payment processor, so the button reads
"Switch premium on" rather than "Buy", and a test enforces that wording.

## A.3 Operational Feasibility

**Operation**

Orbital runs as two processes with no database server, no message queue and no
external cache. State lives in process memory; only accounts must survive a
restart, in one SQLite file.

**Failure behaviour**

The API layer never calls an upstream service. It reads a cache the ingestion
layer fills on a schedule, so there is no upstream call in the request path that
can fail.

| Failure | Behaviour |
|---|---|
| Upstream 5xx | Last good snapshot served, flagged stale; poller backs off |
| Rate limited | Same, using the upstream's own retry hint |
| One of two feeds down | The other continues; the map is drawn |
| CelesTrak returned 503 for a full day | The SatNOGS fallback served; cached elements remain usable for days |
| Network absent | The fixture provider replays committed data |

**Readability**

The interface must not make claims the data cannot support. Markers older than
two minutes fade; an object with no transmitted heading is drawn as a disc
rather than an arrow pointing north; the ship layer names its actual coverage;
and the satellite layer reports no data age, because a computed position does
not have one.

## A.4 Schedule Feasibility

Work proceeded in phases, each with an explicit boundary, and each session ended
with a written handover.

| Phase | Delivered |
|---|---|
| 1 | Aircraft layer end to end |
| 2 | Satellite layer; migration to MapLibre |
| 3 | Moon and solar system views |
| 4 | Accounts, tiers, advertisements |
| 5 | Ship layer, regional then global |
| 6 | Performance and defect sweep |

The strongest evidence that the schedule held is the cost of the later phases.
The satellite layer cost one provider module and one registry entry; the ship
layer cost the same four months later; and the polling logic was not modified
for either.

Where time was lost: six sessions went to one defect misdiagnosed five times.
The cause was structural — one camera serving two pictures at very different
scales — and the resolution deleted 376 lines, added 130, and cost no feature.


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Appendix B: Project Charter, Cost and Resources

## B.1 Project Charter

**Purpose**

Orbital exists to put aircraft, ships and satellites on one map, in a browser,
for free, with no account required. The three kinds of object are already
tracked publicly and separately; nothing assembles them into a single view a
person can simply open.

**Objectives**

| # | Objective | How it will be judged |
|---|---|---|
| O1 | One map showing all three object types | All three layers render live data from the deployed system |
| O2 | No account and no cost to look | The default view requires no sign-in and no payment |
| O3 | Upstream failure degrades, never breaks | With a feed disabled, the map still draws, labelled stale |
| O4 | A new object type costs one module | Adding a type requires no change to the API or the frontend |
| O5 | Honest reporting of what is shown | Sampling, staleness and source are stated in the interface |

**Scope**

**In scope.** Ingestion from free public feeds; normalisation to one shared
shape; a read-only REST API; a browser client rendering the three layers on a
map; object selection and detail; search; accounts with a free and a premium
entitlement window; the Moon, the eight planets and the solar system view.

**Out of scope.** Writing to any upstream; historical archiving beyond the
retention window; native mobile applications; flight booking, ticketing or any
transaction; real-time alerting or push notification; an administrator
interface.

**Deliverables**

The deployed application, the source repository with its test suites, this
report, a decision record, a test plan, and a demonstration.

**Constraints**

| Constraint | Consequence for the plan |
|---|---|
| Free data sources only | Rate limits, not money, are the budget (Appendix B.2) |
| No commercial licence on one feed | The revenue model cannot use OpenSky (Appendix A.2) |
| One backend worker | Vertical scaling only; a second worker would double upstream cost |
| Five part-time students | Parallel work must be separable, or it serialises |
| One semester | Scope is fixed by phase boundaries rather than by deadline pressure |

**Assumptions**

That the public feeds remain available and free; that their terms do not change
mid-project; that free hosting tiers remain sufficient for a demonstration
workload. **The first of these did not hold** — OpenSky became unreachable from
every cloud host partway through — and §4.2 treats it as the realised risk it
turned out to be rather than as an assumption that was merely unlucky.

**Authority**

The Project Manager owns scope and phase boundaries and decides what is in the
current phase and what is explicitly out. Every significant decision is written
to the decision record with its alternatives and its reasoning, so that a choice
can be defended, or reversed, on the evidence that produced it.

## B.2 Cost Estimation

**Direct cost**

| Category | Cost |
|---|---|
| Data sources | 0 |
| Map imagery and tiles | 0 |
| Libraries and tooling | 0 |
| Hosting, development and demonstration | 0 |
| **Total cash cost** | **0** |

Every input is a free public service or an open-source library, and both hosts
run on free tiers. This is not an accident of a student budget: Appendix A.2 records
that free sources were a requirement, because a tracker that costs money per
viewer cannot be free to look at.

**The real budget is quota, not currency**

No money changes hands, so the constraint that behaves like money is the
upstream request allowance. It was budgeted like money:

| Resource | Allowance | Planned use | Headroom |
|---|---|---|---|
| OpenSky daily credits | 4,000 | 3,072 (77%) | 928, for user-triggered lookups |
| adsb.lol request rate | Burst 4, then ~5/min | Within the measured limit | Enforced by a gate, not by convention |
| Celestrak / SatNOGS | Courtesy limits | Refreshed every six hours, cached to disk | Falls back to cache on failure |
| Ships (Digitraffic, aisstream) | No metered limit | Continuous websocket | — |

The startup refuses a configuration projected to exceed 85% of the OpenSky
allowance. A budget that is only written down is a budget nobody keeps; one the
program will not start without is a budget that holds.

**Labour, as a notional replacement cost**

The project's only real cost is effort. Stated as what it would cost to buy,
under assumptions that are stated rather than implied:

| Item | Assumption |
|---|---|
| Team | 5 members |
| Duration | 12 weeks |
| Effort per member per week | 8 hours |
| **Total effort** | **480 person-hours** |

At a notional junior developer rate of **£25 per hour**, that is **£12,000** of
labour delivered at zero cash cost. The rate is an assumption for comparison
only; the hours are the figure worth arguing about, and they are an estimate,
not a measurement. The project did not keep timesheets, and inventing precise
ones here would be exactly the kind of invented number this report declines to
produce elsewhere.

## B.3 Resources

**Technology**

| Resource | Purpose | Cost |
|---|---|---|
| Python, FastAPI, httpx, SGP4 | Ingestion and API | Free, open source |
| React, TypeScript, MapLibre GL, Vite | Browser client | Free, open source |
| SQLite | Accounts and sessions | Free, bundled |
| Vercel | Frontend and landing page hosting | Free tier |
| Northflank | Backend container hosting | Free tier |
| GitHub | Source control, history, issues | Free |

**Data**

Six upstream feeds, all free: OpenSky, adsb.fi and adsb.lol for aircraft,
Celestrak and SatNOGS for orbital elements and satellite identity, Digitraffic
and aisstream for vessels. OpenSky refuses cloud hosts, so its world view and
flight tracks are fetched from a team member's PC and relayed to the server
(§5.1). adsb.lol now limits a query to 250 nautical miles and asks automated
clients to use a key, which has been requested.

**Environment**

A member must be able to set the project up from a clean machine. That is the
Technical Engineer's deliverable rather than a shared assumption, and it is the
reason generated assets are fetched by a script rather than committed: a clone
plus one command produces a running system, and a build with no network works
as long as a previous one has run.


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Appendix C: Activity Diagram

![Figure C.1 — Activity diagram. One poll cycle, including the ways it fails.](figures/5-5-activity-diagram.png){width=4.9in}

An activity diagram of the happy path would be a straight line and would say
nothing. The branches are the content: **three of the four outcomes of a fetch
are failures**, and what happens to each is the reason the map does not go blank
when a feed does.

| Outcome | Response |
|---|---|
| Records returned | Normalise, apply to the store, reset the backoff |
| `ProviderRateLimited` | Honour `Retry-After`, double the backoff, keep the snapshot |
| `ProviderUnavailable` | Keep the previous snapshot, mark the store stale |
| `ProviderBadResponse` | As above — a malformed answer is treated as no answer |

**None of the three failures empties the store.** A feed that goes dark costs
freshness, which is visible and labelled in the status bar, rather than costing
the map, which would not be. The retention window is what finally removes an
object that nobody is reporting — a decision made by elapsed time, not by one
failed request.
