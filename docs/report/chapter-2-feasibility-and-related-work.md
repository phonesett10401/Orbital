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
| OpenSky Network | Aircraft | Research | Used as a source; its non-commercial clause constrains §2.5.2 |
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

### Upstream — the data providers

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
| Pyae Phyo Maung | 6708170 | Co-Tester, Co-Quality Assurance and Analysis |

## 2.5 Feasibility Study

The four feasibility questions were settled before the design depended on them.

### 2.5.1 Technical Feasibility

Every claim below was tested against the live services before the design
depended on it.

| Question | Result |
|---|---|
| Are live aircraft positions obtainable without payment? | Yes. OpenSky returned 11,651 worldwide; adsb.lol 10,009 |
| Can the whole world be fetched economically? | Yes. 10,013 aircraft in 1.9 seconds |
| Can satellite positions be computed rather than fetched? | Yes. ~1,400 satellites, no network in the request path |
| Are live ship positions obtainable without payment? | Yes. 916 vessels in 37 KB from one request; 17,848 in four minutes from the stream |

#### Two measurements that changed the design

**One global query is not enough.** A single 6,000 nautical-mile circle returned
10,013 aircraft and four circles returned 10,009, which appeared to prove one
was sufficient. The other three sample points were inside the area the first
already covered. Over Australia the single circle returned 0 and a direct query
returned 27. The global sweep uses four circles.

**A rate limit cannot be characterised with a burst.** adsb.lol appeared to
tolerate any rate when tested with occasional bursts. Under continuous load it
refused 38% of requests. The real limit is four requests, then approximately one
every twelve seconds.

#### Performance

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

### 2.5.2 Economic Feasibility

#### Direct cost

| Category | Cost |
|---|---|
| Data sources | 0 |
| Map imagery and tiles | 0 |
| Libraries and tooling | 0 |
| Hosting during development | 0 |
| Total | 0 |

The real cost is labour: five students over one semester.

#### The quota is the budget

No money changes hands, but OpenSky's daily credit allowance is finite and was
budgeted like money. The polling intervals are derived from it rather than
chosen by feel: the configured jobs project 3,072 credits per day against a
4,000 allowance, 77%, leaving headroom for the lookups a user triggers by
clicking. The system refuses to start if a configuration would exceed 85%.

Using the free adsb.lol feed as the primary source, with OpenSky supplementing
it every 120 seconds, decouples the refresh rate from the allowance entirely.
Ships and satellites cost nothing.

#### Licensing constrains the revenue model

| Source | Commercial use |
|---|---|
| Digitraffic | Permitted (CC BY 4.0) |
| adsb.lol | Permitted (ODbL) |
| OpenSky Network | Forbidden, non-commercial only |
| aisstream.io | Not stated |

A commercial version is possible but not with the current source mix: the
aircraft layer would have to drop OpenSky and accept its coverage gaps.

#### The implemented model

A free tier supported by advertising and a paid tier are both implemented.
Advertisements are the project's own messages in real advertisement dimensions,
because a third-party network would introduce tracking into a project that
collects no analytics. There is no payment processor, so the button reads
"Switch premium on" rather than "Buy", and a test enforces that wording.

### 2.5.3 Operational Feasibility

#### Operation

Orbital runs as two processes with no database server, no message queue and no
external cache. State lives in process memory; only accounts must survive a
restart, in one SQLite file.

#### Failure behaviour

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

#### Readability

The interface must not make claims the data cannot support. Markers older than
two minutes fade; an object with no transmitted heading is drawn as a disc
rather than an arrow pointing north; the ship layer names its actual coverage;
and the satellite layer reports no data age, because a computed position does
not have one.

### 2.5.4 Schedule Feasibility

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
