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
| Backend | ~19,400 lines, 85 files |
| Frontend | ~31,900 lines, 167 files |
| Automated tests | 1,868 (832 backend, 1,036 frontend) |
| HTTP endpoints | 17 |
| Recorded decisions | 169 |
| Objects served | 14,804 aircraft, 26,262 ships, 1,427 satellites |

Measured on 8 September 2026 against the commit this report was built from.
The three object counts move continuously; the rest move whenever the code
does, which is why this table carries a date.
