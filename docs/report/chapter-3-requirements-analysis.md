# Chapter 3: Requirements Analysis

---

## 3.1 Stakeholder Analysis

Orbital's stakeholder map has an unusual shape, and recognising it early shaped
the design: **most of the project's stakeholders are upstream, not downstream.**
The parties with the greatest power over whether the system works are the data
providers, none of whom have any relationship with the project or any obligation
to it.

### 3.1.1 Upstream stakeholders — the data providers

| Stakeholder | Interest | Influence | How the design responds |
|---|---|---|---|
| **adsb.lol** and its volunteer operators | That clients do not abuse a donated service | **High** — the primary aircraft source | One backend makes a fixed number of requests regardless of viewers; a request gate enforces the measured rate limit; every request identifies the project |
| **OpenSky Network** | Non-commercial use only; quota respected | **High** | Used as a supplement, not the primary; spending budgeted at 77% of allowance; startup refuses a configuration that would overspend |
| **Fintraffic (Digitraffic)** | Attribution under CC BY 4.0 | **Medium** | Attributed; polled at the cadence its own cache headers request |
| **aisstream.io** | Undeclared | **Medium** | Used as a free public service and credited; behind a switch that disables it if the project is ever monetised |
| **CelesTrak / SatNOGS** | Not to be polled excessively | **Medium** | Elements refreshed every six hours, cached to disk, with a fallback source |
| **Volunteer receiver operators** | Recognition that coverage is *theirs* | **Low individually** | The map draws a receiver-coverage layer showing where no network reaches — their absence made visible |

**The most important consequence.** Because the upstream stakeholders hold the
power and grant no guarantees, the system is designed so that *any* of them
failing degrades the display rather than breaking it. That is a requirement
derived from stakeholder analysis, not from a technical preference.

### 3.1.2 Downstream stakeholders — the users

| Stakeholder | Needs | Influence |
|---|---|---|
| **Anonymous viewer** | To look without registering; not to be misled about accuracy | High — the default user |
| **Registered free user** | A saved identity; recent history | Medium |
| **Premium user** | A wider historical window | Medium |
| **Administrator** | Account management | Low — one role, no interface |

**An honest finding about the administrator role.** Three tiers exist in the
data — `free`, `premium` and `admin` — but the administrator has **no interface
of its own**. An account can only be promoted to `admin` from a terminal on the
server, and the self-service endpoint refuses that tier whatever it is asked. It
is stated here plainly because it is a finding about the design rather than a
gap to conceal: a tier reachable from the public interface is a tier anybody can
have.

### 3.1.3 Project stakeholders — the team

Four members covering seven roles (CSC480):

| Member | ID | Roles |
|---|---|---|
| Phone Sett Paing Kyaw | 6708369 | Project Manager (primary), Developer (primary) |
| Bhone Pyae Hein | 6708381 | System Analysis (primary), Co-Developer |
| Han Phyo Htet | 6708463 | Quality Assurance (primary), Business Analysis (primary), Co-Tester |
| Nyan Lin Htet | 6708397 | Technical Engineer (primary), Tester (primary) |

### 3.1.4 Power–interest summary

- **High power, high interest:** adsb.lol, OpenSky — manage closely; their terms
  are hard constraints on both architecture and revenue model.
- **High power, low interest:** CelesTrak, NASA GIBS, OpenFreeMap — keep
  satisfied; assume no support and design fallbacks.
- **Low power, high interest:** end users, the project team.
- **Low power, low interest:** the wider open-data community, which benefits
  from the recorded decisions.

---

## 3.2 Functional Requirements

Requirements are grouped by capability. **Priority** is M (must), S (should) or
C (could). **Status** reflects the delivered system.

### 3.2.1 Data acquisition

| ID | Requirement | Pri | Status |
|---|---|---|---|
| FR-01 | Retrieve live aircraft positions from at least one external source | M | Done |
| FR-02 | Merge two aircraft sources into one view, preferring the fresher record | S | Done |
| FR-03 | Compute satellite positions from published orbital elements | M | Done |
| FR-04 | Refuse orbital elements older than seven days | M | Done |
| FR-05 | Retrieve live ship positions from a regional and a global source | S | Done |
| FR-06 | Merge ship sources so a field is never overwritten by a blank | M | Done |
| FR-07 | Poll each source on a configurable schedule within its rate limit | M | Done |
| FR-08 | Retain the last successful snapshot when a source fails | M | Done |
| FR-09 | Evict objects not re-observed within a per-layer time-to-live | M | Done |
| FR-10 | Run entirely offline from committed fixture data | M | Done |

### 3.2.2 API

| ID | Requirement | Pri | Status |
|---|---|---|---|
| FR-11 | List objects of a layer, filtered by bounding box | M | Done |
| FR-12 | Return one object in full, with its observed track | M | Done |
| FR-13 | Search a layer by name or identifier | M | Done |
| FR-14 | Search aircraft, airports, satellites and ships in one request | S | Done |
| FR-15 | Reduce results to a configured maximum, spread across the visible area | M | Done |
| FR-16 | Answer 304 Not Modified when the client holds the current representation | S | Done |
| FR-17 | Report ingestion health and data freshness | M | Done |
| FR-18 | Never call an external service while handling a request | M | Done |
| FR-19 | Refuse malformed input with a precise error | M | Done |
| FR-20 | Clamp a requested result count to the configured maximum | M | Done |

### 3.2.3 Presentation

| ID | Requirement | Pri | Status |
|---|---|---|---|
| FR-21 | Draw an interactive Earth, rotatable and zoomable from globe to street level | M | Done |
| FR-22 | Draw each object at its position, oriented to its heading | M | Done |
| FR-23 | Draw an object whose heading is unknown without implying one | M | Done |
| FR-24 | Fade an object whose position is more than two minutes old | M | Done |
| FR-25 | Interpolate positions between polls | M | Done |
| FR-26 | Switch between the aircraft, satellite and ship layers | M | Done |
| FR-27 | Change all surrounding text, the key and the search hint with the layer | M | Done |
| FR-28 | Select an object and show its details | M | Done |
| FR-29 | Draw the observed track of the selected object | M | Done |
| FR-30 | Draw the selected aircraft as a three-dimensional airframe | C | Done |
| FR-31 | Show receiver coverage — the regions no network reaches | S | Done |
| FR-32 | Offer a solar system view with navigable planets | C | Done |
| FR-33 | Colour each layer by the property that varies within it | M | Done |

### 3.2.4 Accounts and entitlements

| ID | Requirement | Pri | Status |
|---|---|---|---|
| FR-34 | Register with an email address and password of at least 10 characters | M | Done |
| FR-35 | Sign in and out; maintain a session across reloads | M | Done |
| FR-36 | Store passwords using a memory-hard hash, never in plain text | M | Done |
| FR-37 | View satellite positions at a past instant | S | Done |
| FR-38 | Limit the historical window by tier — 24 hours free, 7 days premium | M | Done |
| FR-39 | Refuse a request outside the tier's window with a stated reason | M | Done |
| FR-40 | Allow a signed-in account to change its own tier between free and premium | S | Done |
| FR-41 | Refuse the administrator tier from the public interface under all conditions | M | Done |
| FR-42 | Show advertisements to accounts that are not premium | S | Done |

**Note on FR-38.** The premium window is seven days because that is the point at
which SGP4 drift makes the answer untrustworthy — the limit is physics, and the
tier is sold up to it rather than beyond it. No tier can exceed that window.

---

## 3.3 Non-Functional Requirements

Each is stated with the measurement that verifies it.

### 3.3.1 Performance

| ID | Requirement | Target | Measured |
|---|---|---|---|
| NFR-01 | Marker rendering at the display cap | < 16.7 ms/frame | **0.80 ms** at 2,000 markers |
| NFR-02 | Sustained frame time under load | 60 fps | **4.2 ms p50, 5.9 ms p99** at zoom 7 with 2,000 vessels |
| NFR-03 | List endpoint response | < 100 ms | **23 ms** |
| NFR-04 | Combined search response | < 100 ms | **47 ms** |
| NFR-05 | Detail lookup | < 10 ms | **0.01 ms** |
| NFR-06 | Response payload compressed | — | 366 KB to **24.5 KB** |
| NFR-07 | No request may block the event loop indefinitely | — | Result count clamped; unbounded request removed |

**NFR-02 is the requirement that drove the largest single optimisation.** The
display initially rebuilt its entire drawing data on every frame, costing 7.4 ms
at the median and 43 ms at the tail. Because a pixel at zoom 7 covers 750 m, and
a ship crosses one every two minutes, almost all of that work was animating
motion below the resolution of the screen. Deriving the redraw interval from the
view reduced p99 frame time from **55.1 ms to 5.9 ms**.

### 3.3.2 Reliability

| ID | Requirement | Verified by |
|---|---|---|
| NFR-08 | An upstream failure must not produce an error response | Injected outages; a real day-long CelesTrak outage |
| NFR-09 | Data older than its threshold must be flagged, not hidden | `stale` flag on every list response |
| NFR-10 | One source failing must not disable a multi-source layer | Partial-failure tests on both unions |
| NFR-11 | A dropped stream must reconnect without losing accumulated state | Reconnection tests; observed live |
| NFR-12 | The system must start without credentials | Fixture provider is the default |

### 3.3.3 Accuracy and honesty

This category is treated as a first-class requirement rather than a matter of
presentation, because the failures it prevents are ones a viewer cannot detect.

| ID | Requirement |
|---|---|
| NFR-13 | A protocol's "not available" encoding must never be displayed as a value |
| NFR-14 | A position must never be shown at a default coordinate; an object without a position is not drawn |
| NFR-15 | An unknown heading must not be drawn as north |
| NFR-16 | A value must be shown in the unit its readers use — knots at sea, metres per second in the contract |
| NFR-17 | Text surrounding the map must describe the layer actually shown, including its coverage limits |
| NFR-18 | A computed position must not report an observation age |
| NFR-19 | A speed physically impossible for the object must be rejected, not displayed |

### 3.3.4 Security

| ID | Requirement |
|---|---|
| NFR-20 | Passwords hashed with scrypt; never logged or returned |
| NFR-21 | Session cookies HttpOnly and SameSite; Secure available for deployment |
| NFR-22 | Credentials read from environment or a git-ignored file, never committed |
| NFR-23 | A configuration object must never be printed whole, since it may contain a secret |
| NFR-24 | Administrator privilege must not be obtainable through any public endpoint |

### 3.3.5 Maintainability

| ID | Requirement | Evidence |
|---|---|---|
| NFR-25 | One shared data shape across all layers and both languages | `models.py` and `types.ts`, kept in step |
| NFR-26 | A new data source must not require frontend changes | Demonstrated twice |
| NFR-27 | A new object class requires a written decision | Enforced by a test on each side |
| NFR-28 | Every significant decision recorded with alternatives and measurements | 166 entries |
| NFR-29 | Both suites runnable offline | Fixture provider; no test makes an external call |

### 3.3.6 Usability and accessibility

| ID | Requirement |
|---|---|
| NFR-30 | Usable without an account |
| NFR-31 | Reduced-motion preference respected in every animation |
| NFR-32 | Interactive controls reachable and labelled for assistive technology |
| NFR-33 | Layout usable at a 375 px viewport width |

---

## 3.4 Use Case Diagram

```
                          ORBITAL — SYSTEM BOUNDARY
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   │   ┌────────────────────┐        ┌────────────────────────────┐   │
   │   │ UC-01 View the map │        │ UC-07 Poll a data source   │   │
   │   └────────────────────┘        └────────────────────────────┘   │
   │   ┌────────────────────┐        ┌────────────────────────────┐   │
   │   │ UC-02 Switch layer │        │ UC-08 Refresh orbital      │   │
   │   └────────────────────┘        │       elements             │   │
   │   ┌────────────────────┐        └────────────────────────────┘   │
   │   │ UC-03 Select an    │        ┌────────────────────────────┐   │
   │   │       object       │        │ UC-09 Maintain the global  │   │
   │   └────────────────────┘        │       AIS stream           │   │
   │   ┌────────────────────┐        └────────────────────────────┘   │
   │   │ UC-04 Search       │        ┌────────────────────────────┐   │
   │   └────────────────────┘        │ UC-10 Evict stale objects  │   │
   │   ┌────────────────────┐        └────────────────────────────┘   │
   │   │ UC-05 Register /   │                                         │
   │   │       sign in      │        ┌────────────────────────────┐   │
   │   └────────────────────┘        │ UC-11 Promote an account   │   │
   │   ┌────────────────────┐        │       to administrator     │   │
   │   │ UC-06 View a past  │        └────────────────────────────┘   │
   │   │       instant      │                                         │
   │   └────────────────────┘                                         │
   └──────────────────────────────────────────────────────────────────┘
        ▲          ▲            ▲                    ▲            ▲
        │          │            │                    │            │
   ┌────┴────┐ ┌───┴────┐ ┌─────┴─────┐      ┌───────┴──────┐ ┌───┴─────┐
   │Anonymous│ │Regis-  │ │  Premium  │      │   External   │ │  System │
   │ Viewer  │ │ tered  │ │   User    │      │   Feeds      │ │Adminis- │
   │         │ │  User  │ │           │      │ (adsb.lol,   │ │ trator  │
   └─────────┘ └────────┘ └───────────┘      │  OpenSky,    │ └─────────┘
        △           △                        │  Digitraffic,│
        └───────────┘                        │  aisstream,  │
      generalisation:                        │  CelesTrak)  │
      a Registered User                      └──────────────┘
      is an Anonymous Viewer                   «secondary actor»
      with an identity
                    △
                    │  Premium User is a
                    │  Registered User with
                    │  a wider entitlement
```

**Relationships.**
`UC-03 Select an object` **«includes»** `UC-01 View the map`.
`UC-06 View a past instant` **«extends»** `UC-01`, at the point where an instant
is chosen, under the condition that the requested instant lies within the
actor's entitlement window.
`UC-07`, `UC-08`, `UC-09` and `UC-10` are initiated by a scheduler rather than a
person, and are shown because they are where every external dependency and every
failure mode lives.

---

## 3.5 Use Case Descriptions

### UC-01 — View the map

| | |
|---|---|
| **Actor** | Anonymous Viewer |
| **Goal** | See where things are now |
| **Preconditions** | None. No account is required |
| **Trigger** | The viewer opens the application |

**Main flow**
1. The system draws the Earth on satellite imagery.
2. The client requests the active layer's objects for the visible area.
3. The API returns the cached snapshot, filtered and thinned, with its age.
4. The client draws each object oriented to its heading, coloured by the
   property that varies on that layer.
5. Between polls the client interpolates positions.
6. The status bar reports the count and the age of the data.

**Alternate flows**
- **A1 — data is stale.** The response is flagged `stale`; the status bar shows
  the age and markers past two minutes are drawn faded.
- **A2 — the backend is unreachable.** The last received state remains on
  screen; the status bar reports the failure. The map is not cleared.
- **A3 — more objects than the cap.** The API returns a spatially even sample
  and reports both figures: "2,000 ships, showing a sample of 23,297 in view".

**Postcondition** — the viewer sees current positions, or is told why not.

---

### UC-02 — Switch layer

| | |
|---|---|
| **Actor** | Anonymous Viewer |
| **Goal** | Look at a different class of object |

**Main flow**
1. The viewer selects Aircraft, Satellites or Ships.
2. The system clears the current selection and objects.
3. **All surrounding text changes with the layer** — subtitle, search
   placeholder, the count noun, the colour key and its heading.
4. Layer-specific furniture is hidden — airport markers and receiver coverage
   belong to the aircraft layer and are meaningless over open sea.
5. The client polls the new layer's endpoint.

**Postcondition** — everything on screen describes the layer now shown.

---

### UC-03 — Select an object

| | |
|---|---|
| **Actor** | Anonymous Viewer |
| **Includes** | UC-01 |

**Main flow**
1. The viewer clicks a marker.
2. The system identifies the object under the pointer.
3. The client requests that object's full record.
4. A panel opens with fields appropriate to the layer — an aircraft shows
   airline, type and route; a ship shows vessel type, navigational status, speed
   in knots, destination and dimensions; a satellite shows its orbit.
5. The object's observed track is drawn.

**Alternate flows**
- **A1 — empty map clicked.** The selection is cleared and the panel closes.
- **A2 — object no longer tracked.** A 404 is returned; the panel reports that
  it is no longer being tracked rather than showing an empty record.

---

### UC-04 — Search

| | |
|---|---|
| **Actor** | Anonymous Viewer |
| **Goal** | Find a specific object or place by name |

**Main flow**
1. The viewer types into the search box.
2. After a debounce, the client requests results.
3. The system returns matches in separate groups — aircraft, airports,
   satellites, ships — ranked within each but never ranked *across* groups,
   because they are not comparable.
4. **Only the groups the active layer can act on are shown**, since offering a
   result that would throw the viewer out of their layer answers a question
   nobody asked.
5. Choosing a result moves the camera to it and selects it.

**Alternate flow**
- **A1 — no match.** A message states why, naming the limits of that layer.

---

### UC-05 — Register and sign in

| | |
|---|---|
| **Actor** | Anonymous Viewer → Registered User |

**Main flow**
1. The viewer opens the sign-in page and supplies an email and password.
2. The system rejects a password shorter than ten characters.
3. The password is hashed with scrypt; the plain text is never stored or logged.
4. A session cookie is issued — HttpOnly and SameSite.
5. The viewer is returned to the map, now signed in.

**Alternate flows**
- **A1 — email already registered.** Reported without revealing whether the
  password was correct.
- **A2 — wrong credentials.** One message for both wrong email and wrong
  password, so the response does not disclose which accounts exist.

---

### UC-06 — View a past instant

| | |
|---|---|
| **Actor** | Registered User; Premium User |
| **Extends** | UC-01 |
| **Precondition** | Signed in; satellite layer active |

**Main flow**
1. The user moves the time control to an instant in the past.
2. The client requests satellite positions for that instant.
3. The system checks the instant against the account's entitlement window —
   **24 hours for free, 7 days for premium**, with a small grace margin.
4. Positions are propagated to the requested instant and returned.

**Alternate flows**
- **A1 — outside the window.** The request is refused with a stated reason and
  the window that does apply. The free user is shown what premium offers.
- **A2 — beyond seven days.** Refused for **every** tier, including
  administrators, because propagation accuracy degrades roughly a kilometre per
  day and beyond a week the answer would be confidently wrong.

---

### UC-07 — Poll a data source *(system)*

| | |
|---|---|
| **Actor** | Scheduler (initiating), External Feed (secondary) |
| **Goal** | Keep the cache current without exceeding any source's limits |

**Main flow**
1. The scheduler waits the configured interval for the job.
2. It checks the remaining quota and the rate gate; if either forbids, it skips
   and reports the skip.
3. The provider requests data and converts it to the shared shape, discarding
   any object without a usable position and converting every "not available"
   encoding to an explicit absence.
4. The store merges the result and records the time.

**Alternate flows**
- **A1 — source unreachable or 5xx.** The failure is recorded, the previous
  snapshot is retained, and the next attempt is delayed by an increasing backoff.
- **A2 — rate limited.** The upstream's own retry hint is used.
- **A3 — both sources of a layer fail.** Only then is the poll an outage.

---

### UC-08 — Refresh orbital elements *(system)*

**Main flow**
1. Every six hours, elements are fetched from CelesTrak.
2. Element sets older than seven days from epoch are refused.
3. Accepted elements are cached to disk so a restart during an outage still has
   something to propagate.

**Alternate flow**
- **A1 — CelesTrak unavailable.** SatNOGS is used instead. If both fail, the
  cached elements continue to serve; they remain accurate for days. *This path
  is not hypothetical — CelesTrak returned 503 for an entire working day.*

---

### UC-09 — Maintain the global AIS stream *(system)*

**Main flow**
1. A WebSocket connection is opened and subscribed to the whole world.
2. Messages are decoded continuously; positions and identities are accumulated
   in memory.
3. Positions older than fifteen minutes are removed; identities are kept for six
   hours, because a vessel's name does not expire when its position does.

**Alternate flow**
- **A1 — connection dropped.** Reconnection with backoff. Nothing is lost: the
  accumulated world is held locally, and the service does not replay.

---

### UC-11 — Promote an account to administrator *(system)*

| | |
|---|---|
| **Actor** | System Administrator, at a terminal on the server |

**Main flow**
1. The administrator runs the account command-line tool on the host.
2. The tool identifies the account and sets its tier.

**Constraint** — there is **no interface** for this and no endpoint that can
perform it. The self-service tier endpoint refuses `admin` under all
configurations, giving the same response as for a nonsensical tier.

---

## 3.6 Software Requirements Specification (SRS)

### 3.6.1 Purpose and scope

This specification covers Orbital, a web application presenting live aircraft,
ship and satellite positions on an interactive Earth. It defines the external
interfaces, the shared data contract, and the constraints under which the system
operates. It does not cover the deployment environment, which is out of scope
for this phase.

### 3.6.2 Overall description

**Product perspective.** Orbital is a three-layer system with one rule between
the layers: data flows in one direction, and each layer knows only the layer
directly beneath it.

```
  External feeds  ──►  1. INGESTION  ──►  2. API  ──►  3. FRONTEND
  (six sources)        providers,          reads the      MapLibre +
                       poller, store       store only     React client
```

Three properties follow, and they are the design:

1. **The browser never talks to a data source.** Rate limiting and caching are
   enforced in exactly one place.
2. **Ingestion does not know a browser exists, and the frontend does not know
   where the data came from.** Either can be replaced without touching the other,
   and both have been.
3. **Upstream failure is contained at layer 1.** The API serves the last good
   snapshot with an explicit staleness flag.

**User classes.** Anonymous Viewer (default, full read access); Registered User
(identity, 24-hour history); Premium User (7-day history, no advertisements);
Administrator (terminal only).

**Constraints.**

| Constraint | Source |
|---|---|
| OpenSky may not be used commercially | Provider terms |
| OpenSky spending must stay within a daily credit allowance | Provider terms |
| adsb.lol tolerates 4 requests then ~1 per 12 s | Measured |
| Digitraffic states a 60-second cache; polling faster returns the same body | Provider headers |
| Satellite accuracy is untrustworthy beyond 7 days from epoch | SGP4 |
| The backend is a single-threaded event loop | Runtime |
| AIS identity arrives on a 6-minute cycle | Protocol |

**Assumptions and dependencies.** The system assumes continuous availability of
none of its sources; every dependency has a defined degraded mode.

### 3.6.3 External interface requirements

**User interfaces.** A single-page application: a full-viewport map; a header
carrying the wordmark, search and layer toggle; a collapsible colour key; a
status bar reporting count, sample size and data age; a detail panel; and
full-screen pages for sign-in, premium and the solar system, each addressable by
a URL fragment so the browser's Back button dismisses it.

**Software interfaces — the API.**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/aircraft` | Aircraft in a bounding box |
| GET | `/api/aircraft/{id}` | One aircraft with its track and route |
| GET | `/api/aircraft/search` | Aircraft by callsign or address |
| GET | `/api/satellites` | Satellites, optionally at a past instant |
| GET | `/api/satellites/{id}` | One satellite |
| GET | `/api/ships` | Ships in a bounding box |
| GET | `/api/ships/{id}` | One ship |
| GET | `/api/ships/search` | Ships by name or MMSI |
| GET | `/api/search` | Combined search across four kinds |
| GET | `/api/moon/satellites` | Spacecraft in lunar orbit |
| GET | `/api/health` | Ingestion status and freshness |
| POST | `/api/auth/register` | Create an account |
| POST | `/api/auth/login` | Begin a session |
| POST | `/api/auth/logout` | End a session |
| GET | `/api/auth/me` | The current account |
| POST | `/api/auth/subscription` | Change own tier (never to `admin`) |

**The shared data shape.** Every moving object, whatever its source, is
represented identically:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Stable identifier within a provider |
| `lat`, `lon` | number | Degrees, WGS84 |
| `altitude` | number \| null | Metres above mean sea level. **Zero means zero** — a ship is at sea level, which is a fact and not a gap. `null` means the source did not say |
| `velocity` | number \| null | Metres per second |
| `heading` | number \| null | Degrees clockwise from true north. `null` is never rendered as north |
| `label` | string | Short human-readable name |
| `model` | string \| null | What the source says the object *is*, in its own vocabulary |
| `lastSeen` | string | When the position was current — **never when we polled** |
| `type` | enum | `aircraft` \| `satellite` \| `ship` |

Anything meaningful to only one kind of object lives in a generic `meta` map, so
that a provider can add a field without any frontend change. This single
decision is what made the second and third layers cost one module each.

### 3.6.4 Functional requirements

As specified in §3.2 (FR-01 to FR-42).

### 3.6.5 Non-functional requirements

As specified in §3.3 (NFR-01 to NFR-33).

### 3.6.6 Verification

| Requirement class | How verified |
|---|---|
| Functional | 1,842 automated tests; live runs against every real source |
| Performance | Instrumented measurement in the browser and a backend benchmark |
| Reliability | Injected outages, plus real ones that occurred unprompted |
| Honesty (NFR-13–19) | Unit tests on each conversion, plus inspection of the running application |
| Security | Tests on hashing, session handling and tier refusal |

**A note on verification method.** A recurring finding across this project is
that a passing test suite is not sufficient evidence. Eighteen defects are recorded as having been
invisible to the tests at the time they existed, each found by running the
application and looking at it, and the most recent phase added several more — including a receiver-coverage layer drawn over
Mars, a three-dimensional aeroplane rendered on the sea, and a ship layer that
drew 37 vessels where 9,159 were present. In each case the code was correct and
the wiring was absent or mismatched. Unit tests verify code; only running the
system verifies wiring.
