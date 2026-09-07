---
title: "Orbital"
subtitle: "Live Aircraft, Ship and Satellite Tracking --- Project Report"
author:
  - "Phone Sett Paing Kyaw (6708369)"
  - "Bhone Pyae Hein (6708381)"
  - "Han Phyo Htet (6708463)"
  - "Nyan Lin Htet (6708397)"
  - "Pyae Phyo Maung (6708170)"
date: "CSC480 --- 7 September 2026"
lang: en-GB
---
# Chapter 1: Introduction

## 1.1 Background and Problem Statement

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

## 1.2 Project Objectives

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

## 1.3 Project Scope

### In scope

| Area | Included |
|---|---|
| Aircraft | Live positions from two sources, merged; flight track; airline and type; airport search; receiver coverage |
| Satellites | ~1,400 satellites computed from orbital elements; orbit class |
| Ships | ~23,000 vessels from two sources, merged; type, dimensions, destination, status |
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

## 1.4 Expected Benefits

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

## 1.5 Tools and Technologies Used

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

### Data sources

| Source | Provides | Access |
|---|---|---|
| adsb.lol | Aircraft | Open Database Licence, no key |
| OpenSky Network | Aircraft | Free, non-commercial, OAuth2, metered |
| Digitraffic (Fintraffic) | Ships, Baltic | CC BY 4.0, commercial permitted, no key |
| aisstream.io | Ships, global | Free, key required |
| CelesTrak / SatNOGS | Orbital elements | Free |
| NASA GIBS, OpenFreeMap | Imagery and map tiles | Open |

## 1.6 Scale of the System

| Measure | Value |
|---|---|
| Backend | ~19,100 lines, 85 files |
| Frontend | ~28,500 lines, 159 files |
| Automated tests | 1,842 (823 backend, 1,019 frontend) |
| HTTP endpoints | 16 |
| Recorded decisions | 166 |
| Objects served | 13,829 aircraft, 23,297 ships, 1,431 satellites |


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 2: Feasibility Study and Related Work

## 2.1 Technical Feasibility

Every claim below was tested against the live services before the design
depended on it.

| Question | Result |
|---|---|
| Are live aircraft positions obtainable without payment? | Yes. OpenSky returned 11,651 worldwide; adsb.lol 10,009 |
| Can the whole world be fetched economically? | Yes. 10,013 aircraft in 1.9 seconds |
| Can satellite positions be computed rather than fetched? | Yes. ~1,400 satellites, no network in the request path |
| Are live ship positions obtainable without payment? | Yes. 916 vessels in 37 KB from one request; 17,848 in four minutes from the stream |

### Two measurements that changed the design

**One global query is not enough.** A single 6,000 nautical-mile circle returned
10,013 aircraft and four circles returned 10,009, which appeared to prove one
was sufficient. The other three sample points were inside the area the first
already covered. Over Australia the single circle returned 0 and a direct query
returned 27. The global sweep uses four circles.

**A rate limit cannot be characterised with a burst.** adsb.lol appeared to
tolerate any rate when tested with occasional bursts. Under continuous load it
refused 38% of requests. The real limit is four requests, then approximately one
every twelve seconds.

### Performance

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

## 2.2 Economic Feasibility

### Direct cost

| Category | Cost |
|---|---|
| Data sources | 0 |
| Map imagery and tiles | 0 |
| Libraries and tooling | 0 |
| Hosting during development | 0 |
| Total | 0 |

The real cost is labour: five students over one semester.

### The quota is the budget

No money changes hands, but OpenSky's daily credit allowance is finite and was
budgeted like money. The polling intervals are derived from it rather than
chosen by feel: the configured jobs project 3,072 credits per day against a
4,000 allowance, 77%, leaving headroom for the lookups a user triggers by
clicking. The system refuses to start if a configuration would exceed 85%.

Using the free adsb.lol feed as the primary source, with OpenSky supplementing
it every 120 seconds, decouples the refresh rate from the allowance entirely.
Ships and satellites cost nothing.

### Licensing constrains the revenue model

| Source | Commercial use |
|---|---|
| Digitraffic | Permitted (CC BY 4.0) |
| adsb.lol | Permitted (ODbL) |
| OpenSky Network | Forbidden, non-commercial only |
| aisstream.io | Not stated |

A commercial version is possible but not with the current source mix: the
aircraft layer would have to drop OpenSky and accept its coverage gaps.

### The implemented model

A free tier supported by advertising and a paid tier are both implemented.
Advertisements are the project's own messages in real advertisement dimensions,
because a third-party network would introduce tracking into a project that
collects no analytics. There is no payment processor, so the button reads
"Switch premium on" rather than "Buy", and a test enforces that wording.

## 2.3 Operational Feasibility

### Operation

Orbital runs as two processes with no database server, no message queue and no
external cache. State lives in process memory; only accounts must survive a
restart, in one SQLite file.

### Failure behaviour

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

### Readability

The interface must not make claims the data cannot support. Markers older than
two minutes fade; an object with no transmitted heading is drawn as a disc
rather than an arrow pointing north; the ship layer names its actual coverage;
and the satellite layer reports no data age, because a computed position does
not have one.

## 2.4 Schedule Feasibility

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

## 2.5 Related Systems

| System | Covers | Model | Relationship |
|---|---|---|---|
| Flightradar24 | Aircraft | Commercial | The reference for a mature tracker; larger network, closed data |
| MarineTraffic | Ships | Commercial | The shipping equivalent; acquired during this project |
| OpenSky Network | Aircraft | Research | Used as a source; its non-commercial clause constrains §2.2 |
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

## 2.6 Relevant Theories and Technologies

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


```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

# Chapter 3: Requirements Analysis

## 3.1 Stakeholder Analysis

Orbital's stakeholder map has an unusual shape: most of its stakeholders are
upstream. The parties with the greatest power over whether the system works are
the data providers, none of whom have any relationship with the project.

### Upstream — the data providers

| Stakeholder | Interest | Power | How the design responds |
|---|---|---|---|
| adsb.lol | That clients do not abuse a donated service | High | One backend, fixed request count regardless of viewers; a gate enforces the measured rate limit |
| OpenSky Network | Non-commercial use; quota respected | High | Used as a supplement; spending held at 77% of allowance; startup refuses an overspending configuration |
| Fintraffic | Attribution under CC BY 4.0 | Medium | Attributed; polled at the rate its own cache headers ask for |
| aisstream.io | Not stated | Medium | Used as a free public service and credited; behind a switch that disables it if the project is monetised |
| CelesTrak / SatNOGS | Not to be polled excessively | Medium | Refreshed every six hours, cached to disk, with a fallback |
| Volunteer receiver operators | Recognition that coverage is theirs | Low | The map draws where no network reaches |

Because the upstream stakeholders hold the power and grant no guarantees, the
system is designed so any of them failing degrades the display rather than
breaking it. That is a requirement derived from stakeholder analysis rather than
a technical preference.

### Downstream — the users

| Stakeholder | Needs | Power |
|---|---|---|
| Anonymous viewer | To look without registering; not to be misled | High, the default user |
| Registered free user | An identity; recent history | Medium |
| Premium user | A wider historical window | Medium |
| Administrator | Account management | Low, one role |

The administrator tier exists in the data but has no interface. An account can
only be promoted from a terminal on the server, and the public endpoint refuses
that tier under all configurations.

### The team

| Member | ID | Roles |
|---|---|---|
| Phone Sett Paing Kyaw | 6708369 | Project Manager, Developer |
| Bhone Pyae Hein | 6708381 | System Analysis, Co-Developer |
| Han Phyo Htet | 6708463 | Quality Assurance, Business Analysis, Co-Tester |
| Nyan Lin Htet | 6708397 | Technical Engineer, Tester |
| Pyae Phyo Maung | 6708170 | To be confirmed |

## 3.2 Functional Requirements

Priority is M (must), S (should) or C (could). All are implemented.

### Data acquisition

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

### API

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

### Presentation

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

### Accounts and entitlements

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

## 3.3 Non-Functional Requirements

### Performance

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-01 | Marker rendering at the cap | < 16.7 ms | 0.80 ms at 2,000 markers |
| NFR-02 | Sustained frame time under load | 60 fps | 4.2 ms p50, 5.9 ms p99 |
| NFR-03 | List endpoint response | < 100 ms | 23 ms |
| NFR-04 | Combined search response | < 100 ms | 47 ms |
| NFR-05 | Detail lookup | < 10 ms | 0.01 ms |
| NFR-06 | Responses compressed | — | 366 KB to 24.5 KB |
| NFR-07 | No request may block the event loop indefinitely | — | Result count clamped |

### Reliability

| ID | Requirement |
|---|---|
| NFR-08 | An upstream failure must not produce an error response |
| NFR-09 | Data past its threshold must be flagged, not hidden |
| NFR-10 | One source failing must not disable a multi-source layer |
| NFR-11 | A dropped stream must reconnect without losing accumulated state |
| NFR-12 | The system must start without credentials |

### Accuracy

| ID | Requirement |
|---|---|
| NFR-13 | A protocol's "not available" encoding must never be shown as a value |
| NFR-14 | An object without a position is not drawn |
| NFR-15 | An unknown heading must not be drawn as north |
| NFR-16 | Values shown in the unit their readers use |
| NFR-17 | Text around the map must describe the layer shown, including its limits |
| NFR-18 | A computed position must not report an observation age |
| NFR-19 | A physically impossible speed must be rejected |

### Security

| ID | Requirement |
|---|---|
| NFR-20 | Passwords hashed with scrypt; never logged or returned |
| NFR-21 | Session cookies HttpOnly and SameSite |
| NFR-22 | Credentials read from environment or a git-ignored file |
| NFR-23 | A configuration object must never be printed whole |
| NFR-24 | Administrator privilege not obtainable through any public endpoint |

### Maintainability

| ID | Requirement | Evidence |
|---|---|---|
| NFR-25 | One shared data shape across all layers and both languages | Kept in step by type checks |
| NFR-26 | A new data source must not require frontend changes | Demonstrated twice |
| NFR-27 | A new object class requires a written decision | Enforced by a test on each side |
| NFR-28 | Every significant decision recorded | 166 entries |
| NFR-29 | Both suites runnable offline | No test makes an external call |

### Usability

| ID | Requirement |
|---|---|
| NFR-30 | Usable without an account |
| NFR-31 | Reduced-motion preference respected |
| NFR-32 | Controls reachable and labelled for assistive technology |
| NFR-33 | Layout usable at a 375 px viewport |



```{=openxml}
<w:p><w:r><w:br w:type="page"/></w:r></w:p>
```

## 3.4 Use Case Diagram

```
                       ORBITAL - SYSTEM BOUNDARY
  +-----------------------------------------------------------------+
  |                                                                 |
  |   +----------------------+     +---------------------------+    |
  |   | UC-01 View the map   |     | UC-07 Poll a data source  |    |
  |   +----------------------+     +---------------------------+    |
  |   +----------------------+     +---------------------------+    |
  |   | UC-02 Switch layer   |     | UC-08 Refresh elements    |    |
  |   +----------------------+     +---------------------------+    |
  |   +----------------------+     +---------------------------+    |
  |   | UC-03 Select object  |     | UC-09 Maintain AIS stream |    |
  |   +----------------------+     +---------------------------+    |
  |   +----------------------+     +---------------------------+    |
  |   | UC-04 Search         |     | UC-10 Evict stale objects |    |
  |   +----------------------+     +---------------------------+    |
  |   +----------------------+     +---------------------------+    |
  |   | UC-05 Register       |     | UC-11 Promote to admin    |    |
  |   +----------------------+     +---------------------------+    |
  |   +----------------------+                                      |
  |   | UC-06 Past instant   |                                      |
  |   +----------------------+                                      |
  +-----------------------------------------------------------------+
        |            |             |               |            |
   +---------+  +----------+  +---------+   +------------+ +---------+
   |Anonymous|  |Registered|  | Premium |   |  External  | | System  |
   | Viewer  |  |   User   |  |  User   |   |   Feeds    | |  Admin  |
   +---------+  +----------+  +---------+   +------------+ +---------+
        ^____________|             |         secondary actor
             |____________________|

   Registered User is an Anonymous Viewer with an identity.
   Premium User is a Registered User with a wider entitlement.
```

UC-03 includes UC-01. UC-06 extends UC-01 when an instant is chosen, if that
instant lies within the actor's entitlement window. UC-07 to UC-10 are started
by a scheduler rather than a person, and are shown because every external
dependency and failure mode lives there.

## 3.5 Use Case Descriptions

### UC-01 View the map

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

### UC-02 Switch layer

**Actor** Anonymous Viewer.

1. The viewer selects Aircraft, Satellites or Ships.
2. The system clears the current selection and objects.
3. All surrounding text changes with the layer — subtitle, search placeholder,
   count noun and colour key.
4. Layer-specific furniture is hidden; airports and receiver coverage belong to
   the aircraft layer.
5. The client polls the new layer's endpoint.

### UC-03 Select an object

**Actor** Anonymous Viewer. **Includes** UC-01.

1. The viewer clicks a marker.
2. The client requests that object's full record.
3. A panel opens with fields appropriate to the layer.
4. The object's observed track is drawn.

**A1** Empty map clicked: the selection clears. **A2** No longer tracked: a 404
is returned and the panel says so rather than showing an empty record.

### UC-04 Search

**Actor** Anonymous Viewer.

1. The viewer types into the search box.
2. After a debounce, the client requests results.
3. Matches are returned in separate groups, ranked within each but not across
   them, because they are not comparable.
4. Only the groups the active layer can act on are shown.
5. Choosing a result moves the camera to it and selects it.

### UC-05 Register and sign in

**Actor** Anonymous Viewer becoming Registered User.

1. The viewer supplies an email and password.
2. A password shorter than ten characters is rejected.
3. The password is hashed with scrypt.
4. A session cookie is issued, HttpOnly and SameSite.

**A1** Email already registered: reported without revealing the password.
**A2** Wrong credentials: one message for both cases, so the response does not
disclose which accounts exist.

### UC-06 View a past instant

**Actor** Registered or Premium User. **Extends** UC-01. **Precondition** Signed
in, satellite layer active.

1. The user moves the time control to a past instant.
2. The system checks it against the account's window: 24 hours free, 7 days
   premium.
3. Positions are propagated to that instant and returned.

**A1** Outside the window: refused with the window that does apply.
**A2** Beyond seven days: refused for every tier, because propagation accuracy
degrades about a kilometre per day.

### UC-07 Poll a data source

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

### UC-08 Refresh orbital elements

1. Every six hours elements are fetched from CelesTrak.
2. Sets older than seven days from epoch are refused.
3. Accepted elements are cached to disk.

**A1** CelesTrak unavailable: SatNOGS is used. If both fail, cached elements
continue to serve.

### UC-09 Maintain the global AIS stream

1. A WebSocket is opened and subscribed to the whole world.
2. Positions and identities are accumulated in memory.
3. Positions older than fifteen minutes are removed; identities are kept for six
   hours, because a vessel's name does not expire when its position does.

**A1** Connection dropped: reconnection with backoff, losing nothing, because
the accumulated world is held locally.

### UC-11 Promote an account to administrator

**Actor** System Administrator at a terminal on the server.

1. The administrator runs the account tool on the host.
2. The tool sets the account's tier.

There is no interface for this and no endpoint that can perform it.

## 3.6 Software Requirements Specification

### Purpose

This specification covers Orbital, a web application presenting live aircraft,
ship and satellite positions on an interactive Earth. It defines the external
interfaces, the shared data contract and the operating constraints.

### System context

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

### User classes

| Class | Access |
|---|---|
| Anonymous Viewer | Full read access, no account |
| Registered User | Identity, 24-hour history |
| Premium User | 7-day history, no advertisements |
| Administrator | Terminal only |

### Constraints

| Constraint | Source |
|---|---|
| OpenSky may not be used commercially | Provider terms |
| OpenSky spending within a daily allowance | Provider terms |
| adsb.lol allows 4 requests then ~1 per 12 s | Measured |
| Digitraffic states a 60-second cache | Provider headers |
| Satellite accuracy untrustworthy beyond 7 days | SGP4 |
| The backend is a single-threaded event loop | Runtime |
| AIS identity arrives on a 6-minute cycle | Protocol |

### API

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

### The shared data shape

Every moving object, whatever its source, is represented identically.

| Field | Type | Meaning |
|---|---|---|
| id | string | Stable identifier within a provider |
| lat, lon | number | Degrees, WGS84 |
| altitude | number or null | Metres above mean sea level; zero means zero, null means the source did not say |
| velocity | number or null | Metres per second |
| heading | number or null | Degrees clockwise from true north; null is never drawn as north |
| label | string | Short human-readable name |
| model | string or null | What the source says the object is |
| lastSeen | string | When the position was current, never when we polled |
| type | enum | aircraft, satellite or ship |

Anything meaningful to only one kind of object lives in a generic meta map, so a
provider can add a field without a frontend change. This is what made the second
and third layers cost one module each.

### Verification

| Class | Method |
|---|---|
| Functional | 1,842 automated tests; live runs against every real source |
| Performance | Instrumented measurement in the browser and a backend benchmark |
| Reliability | Injected outages, plus real ones that occurred unprompted |
| Accuracy | Unit tests on each conversion, plus inspection of the running system |
| Security | Tests on hashing, session handling and tier refusal |

Eighteen defects are recorded as having been invisible to the tests at the time
they existed, each found by running the application and looking at it. In every
case the code was correct and the wiring was absent or mismatched. Unit tests
verify code; only running the system verifies wiring.
