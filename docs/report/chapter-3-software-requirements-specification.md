# Chapter 3: Software Requirements Specification

## 3.1 System Overview

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

## 3.2 Core Functional Requirements

The core requirements are what the system must do (3.2.1), the data it must
hold and exchange (3.2.2), and the technical, integration and usability
conditions it must meet while doing so (3.2.3). Every requirement has an
identifier, so it can be traced to the code and tests that satisfy it
(§6.1.1).

### 3.2.1 Functional Requirements

Priority is M (must), S (should) or C (could). All are implemented.

#### Data acquisition

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

#### API

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

#### Presentation

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

#### Accounts and entitlements

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

#### Data the system takes in

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

#### The shared data shape

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

#### Data the system keeps

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

##### Performance

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-01 | Marker rendering at the cap | < 16.7 ms | 0.80 ms at 2,000 markers |
| NFR-02 | Sustained frame time under load | 60 fps | 4.2 ms p50, 5.9 ms p99 |
| NFR-03 | List endpoint response | < 100 ms | 23 ms |
| NFR-04 | Combined search response | < 100 ms | 47 ms |
| NFR-05 | Detail lookup | < 10 ms | 0.01 ms |
| NFR-06 | Responses compressed | Required | 366 KB to 24.5 KB |
| NFR-07 | No request may block the event loop indefinitely | Required | Result count clamped |

##### Reliability

| ID | Requirement |
|---|---|
| NFR-08 | An upstream failure must not produce an error response |
| NFR-09 | Data past its threshold must be flagged, not hidden |
| NFR-10 | One source failing must not disable a multi-source layer |
| NFR-11 | A dropped stream must reconnect without losing accumulated state |
| NFR-12 | The system must start without credentials |

##### Security

| ID | Requirement |
|---|---|
| NFR-20 | Passwords hashed with scrypt; never logged or returned |
| NFR-21 | Session cookies HttpOnly and SameSite |
| NFR-22 | Credentials read from environment or a git-ignored file |
| NFR-23 | A configuration object must never be printed whole |
| NFR-24 | Administrator privilege not obtainable through any public endpoint |

##### Maintainability

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

#### The Orbital API

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

##### Usability

| ID | Requirement |
|---|---|
| NFR-30 | Usable without an account |
| NFR-31 | Reduced-motion preference respected |
| NFR-32 | Controls reachable and labelled for assistive technology |
| NFR-33 | Layout usable at a 375 px viewport |

##### Accuracy

| ID | Requirement |
|---|---|
| NFR-13 | A protocol's "not available" encoding must never be shown as a value |
| NFR-14 | An object without a position is not drawn |
| NFR-15 | An unknown heading must not be drawn as north |
| NFR-16 | Values shown in the unit their readers use |
| NFR-17 | Text around the map must describe the layer shown, including its limits |
| NFR-18 | A computed position must not report an observation age |
| NFR-19 | A physically impossible speed must be rejected |
