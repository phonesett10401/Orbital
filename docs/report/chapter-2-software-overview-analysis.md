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

**AIS.** Vessels broadcast position every few seconds and identity (name, type, dimensions and destination) every six minutes. Two consequences follow. "Not
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
latitude: about 750 m at zoom 7, about 6 m at zoom 14. This arithmetic
determines how often the display needs redrawing, and it is why drawing every
object at every zoom is neither useful nor affordable.

**Signed distance field icons.** Marker symbols are stored as distance fields so
one silhouette can be tinted per object rather than needing an image per colour.
The alpha channel encodes distance rather than coverage, so thin detail
dissolves when scaled down; marker artwork is therefore deliberately chunky.

**HTTP conditional requests.** The polled endpoints use ETags. When the data has
not changed the server returns 304 Not Modified before reading its store, so there is no
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
different acquisition models (observed and metered, observed and free, and computed) are presented on one map through one shared data shape.

A deliberate search found no free, global, key-less ship feed equivalent to
adsb.lol. An AIS receiver is a real installation rather than a cheap dongle, so
volunteer networks operate on reciprocity, and the commercial half of the market
has consolidated under two owners.

## 2.4 Stakeholders

Orbital's stakeholder map has an unusual shape: most of its stakeholders are
upstream. The parties with the greatest power over whether the system works are
the data providers, none of whom have any relationship with the project.

### Upstream: the data providers

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

### Downstream: the users

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

The five team members and their roles are set out in §4.3.

