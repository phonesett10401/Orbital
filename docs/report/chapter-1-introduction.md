# Chapter 1: Introduction

---

## 1.1 Background and Problem Statement

At any moment there are roughly fourteen thousand aircraft in the air, tens of
thousands of ships at sea, and several thousand satellites in orbit, and almost
all of them are broadcasting where they are. Aircraft transmit ADS-B, ships
transmit AIS, and satellite orbits are published as orbital elements by
government catalogues. The data is public, continuous, and free at the point of
collection.

It is not, however, easy to *use*. The problem this project addresses is not
that the information is unavailable but that it arrives in a form no ordinary
viewer can read, and that the services which package it usefully are commercial.

Four specific difficulties motivate Orbital.

**The raw formats are unreadable without domain knowledge.** ADS-B reports
altitude in feet and speed in knots; AIS encodes "not available" as a number
inside the valid range, so a vessel that has not reported its speed transmits
102.3 knots rather than a blank; orbital elements are a two-line text format
that has to be propagated through a physics model before it means a position.
None of these can be displayed as received.

**Every free source is incomplete, and they are incomplete in different
places.** Measured directly during this project on identical search areas,
OpenSky reported 22 aircraft over Myanmar where adsb.lol reported 4, while
adsb.lol reported 33 over inland China where OpenSky reported none. For ships
the gap is starker still: the global AIS stream used here returns 9,202 vessels
in northern Europe and **two** in the Indian Ocean, because coverage follows
volunteer receivers rather than shipping.

**Free access is metered, and the meter is easy to exhaust.** The OpenSky
Network bills by geographic area against a daily credit allowance; adsb.lol
permits a burst of four requests and then roughly one every twelve seconds.
Naive polling exhausts either within hours. A design that puts the browser in
direct contact with these services fails as soon as more than one person opens
it.

**The commercial alternatives are closed.** The vessel-tracking market
consolidated during this project's lifetime — MarineTraffic, FleetMon and Spire
Maritime are now owned by Kpler, and ORBCOMM's AIS business by S&P Global — and
the surviving free tiers are credit-metered previews.

**The problem statement, stated plainly.** Public position data for aircraft,
ships and satellites is abundant and free, but it is fragmented across sources
with different formats, different coverage gaps and different access limits, and
no single free tool presents all three honestly on one map. Orbital is an
attempt to build that tool, and to be explicit at every point about what it
does *not* know.

That last clause is the part this project treats as a requirement rather than a
courtesy. A map that draws a marker where an aircraft was five minutes ago, with
no indication that the position is old, is not merely incomplete — it is making
a false statement that a viewer has no way to detect.

---

## 1.2 Project Objectives

The project's objectives are stated below in the order they were undertaken.
Each is measurable, and the evidence for each is recorded in
`docs/test-plan.md` and `docs/decisions.md`.

**O1 — Present live aircraft positions on an interactive Earth in a browser.**
The viewer can rotate and zoom from a whole-globe view down to street level,
select an aircraft, and read its details.

**O2 — Isolate the browser from every external data source.** All upstream
communication passes through the project's own backend, so that quota and rate
limiting are enforced in exactly one place and a hundred open tabs cost the same
as one.

**O3 — Survive upstream failure without breaking the display.** When a data
source is unreachable, the system continues to serve the last known state,
marked explicitly as stale, rather than returning an error or an empty map.

**O4 — Normalise every source onto one shared data shape.** A single object
definition, enforced by types on both sides of the network boundary, so that
adding a data source is a backend change that the frontend never learns about.

**O5 — Extend the same architecture to a second and third class of object.**
Satellites, whose positions are *computed* rather than observed, and ships,
which are observed by a different protocol with different failure modes. This
objective exists to test whether the abstraction in O4 was real or accidental.

**O6 — Establish user accounts and a differentiated service tier.** A free tier
supported by advertising and a premium tier with a wider capability, so the
system has an economic model rather than only a technical one.

**O7 — Keep the reasoning behind every significant decision on the record.**
Each choice recorded with its alternatives, its measurements and its cost, so
that the design can be defended and so that a decision made on a measurement can
be revisited when the measurement changes.

---

## 1.3 Project Scope

### 1.3.1 In scope

| Area | What is included |
|---|---|
| **Aircraft layer** | Live positions from adsb.lol and the OpenSky Network, merged; observed flight track; airline and aircraft type; airport search; receiver-coverage annotation |
| **Satellite layer** | ~1,400 satellites propagated from published orbital elements; orbit classification; ground track |
| **Ship layer** | ~23,000 vessels from Fintraffic's Digitraffic feed and aisstream.io, merged; vessel type, dimensions, destination and navigational status |
| **Solar system view** | The eight planets and the Moon, to scale in distance, navigable and visitable |
| **Accounts** | Registration, sign-in, session management, three tiers (`free`, `premium`, `admin`) |
| **Time travel** | Historical satellite positions within an entitlement-limited window |

### 1.3.2 Explicitly out of scope

The following were considered and deliberately excluded. Each exclusion is
recorded with its reasoning, and three of them are enforced by automated tests
that fail if the boundary is crossed without a written decision.

| Excluded | Why |
|---|---|
| **Space debris and rocket bodies** | The satellite catalogue holds roughly 100,000 objects, most of which are neither satellites nor meaningful to draw. Enforced by `test_no_provider_serves_debris_or_rocket_bodies` |
| **Conjunction, collision or re-entry prediction** | The propagation model used is accurate to kilometres, and a viewer could not detect a wrong answer. Enforced by `test_no_prediction_endpoint_exists` |
| **A fourth object class** | Any new layer requires an explicit written decision. Enforced by a test on each side of the network boundary, which has now fired twice — once when satellites were added and once when ships were |
| **Ground-station passes and look angles** | Feasible, but outside the stated objectives |
| **Flight or voyage prediction** | Orbital reports observations; it does not forecast them |

### 1.3.3 A scope boundary that moved, and how

Satellites were removed from the plan early in the project and reinstated later.
The mechanism matters more than the outcome: three tests existed whose only
purpose was to fail if a satellite ever appeared, so the boundary could not be
crossed quietly. When the scope was reinstated, those tests failed, and they
were re-aimed at the new boundary rather than deleted — a guard removed the
moment it fires was never a guard.

---

## 1.4 Expected Benefits

**For the general viewer.** A single free view of aircraft, ships and
satellites, with no account required to look and no advertisement of
completeness the data cannot support. The interface states its own limits: the
ship layer is subtitled "ships in coastal waters" because both AIS feeds are
received from the shore, and a marker whose position is more than two minutes
old visibly fades rather than silently persisting.

**For the upstream data providers.** A client that behaves well. All external
traffic is consolidated into one backend making a fixed number of requests
regardless of how many people are watching, polling each source at the cadence
that source asks for. This is a direct benefit to the volunteer receiver
networks the project depends on.

**For the project team.** A worked example of a system with three
interchangeable data layers, in which the interchangeability was tested twice by
actually adding a layer. The second and third layers each cost approximately one
provider module and one line in a registry, and the polling logic was not
modified for either.

**For future maintainers.** 166 recorded decisions, each with its alternatives
and its measurements, and a documented instance in which a decision correct at
the time became wrong when the data it was based on changed — with the cost of
that made visible.

---

## 1.5 Tools and Technologies Used

### 1.5.1 Core stack

| Layer | Technology | Reason |
|---|---|---|
| **Map rendering** | MapLibre GL JS | Renders a globe when zoomed out and a street map when zoomed in, on real satellite imagery, in one continuous view |
| **3D models** | three.js | The selected aircraft is drawn as a real airframe inside MapLibre's own WebGL context via its custom-layer hook |
| **Frontend** | React, TypeScript, Vite | The shared data contract is enforced at compile time on the client side |
| **Backend** | FastAPI, Python | Pydantic makes the same contract executable and self-documenting on the server side |
| **HTTP client** | httpx | Asynchronous, so polling never blocks an API request |
| **WebSocket client** | websockets | Required for the global AIS stream, which pushes rather than answers |
| **State** | Zustand | Small enough not to need explaining; sufficient for one store |
| **Storage** | In-process dictionaries; SQLite for accounts | One process and one poller — an external cache would be operational cost for no benefit. Accounts are the only state that must survive a restart |
| **Orbital mechanics** | sgp4 | The standard propagator for the element format the catalogues publish |
| **Testing** | pytest, Vitest | Both suites run offline against committed fixture data |

### 1.5.2 External data sources

| Source | Provides | Licence and access |
|---|---|---|
| **adsb.lol** | Aircraft positions | Open Database Licence; no key, community-operated |
| **OpenSky Network** | Aircraft positions | Free for non-commercial use; OAuth2; metered by area |
| **Digitraffic** (Fintraffic) | Ship positions, northern Baltic | **CC BY 4.0, commercial use permitted**; no key |
| **aisstream.io** | Ship positions, global | Free, key required; commercial terms unanswered |
| **CelesTrak / SatNOGS** | Orbital elements | Free; SatNOGS is the fallback when CelesTrak is unavailable |
| **JPL Horizons** | Lunar spacecraft ephemerides | Free, no key |
| **NASA GIBS, OpenFreeMap** | Satellite imagery and vector map tiles | Open |

### 1.5.3 Development environment

Python 3.14 and Node.js, with the backend served by uvicorn and the frontend by
Vite. Version control is Git. The system runs entirely offline against a
committed fixture provider replaying 157 synthetic aircraft, so that neither
development nor the test suite consumes a third-party quota.

---

## 1.6 Scale of the Delivered System

For reference in the chapters that follow:

| Measure | Value |
|---|---|
| Backend source | ~19,100 lines across 85 Python files |
| Frontend source | ~28,500 lines across 159 TypeScript files |
| Automated tests | **1,842** — 823 backend, 1,019 frontend |
| HTTP endpoints | 16 |
| Recorded decisions | 166 |
| Objects served, measured live | 13,829 aircraft · 23,297 ships · 1,431 satellites |
