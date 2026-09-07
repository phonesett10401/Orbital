# Chapter 2: Feasibility Study and Related Work

---

## 2.1 Technical Feasibility

Technical feasibility was not assessed by argument. Every claim below was tested
against the live services before the design depended on it, and two of the
findings changed the design.

### 2.1.1 Can the data be obtained at all?

| Question | Method | Result |
|---|---|---|
| Are live aircraft positions obtainable without payment? | Called both APIs directly | **Yes.** OpenSky returned 11,651 aircraft worldwide; adsb.lol returned 10,009 |
| Can the whole world be fetched economically? | Measured a single 6,000 nautical-mile query | **Yes** — 10,013 aircraft in 1.9 seconds |
| Can satellite positions be computed rather than fetched? | Propagated published elements offline | **Yes.** ~1,400 satellites, no network in the request path |
| Are live ship positions obtainable without payment? | Called Digitraffic and aisstream | **Yes.** 916 vessels in 37 KB from one request; 17,848 in four minutes from the stream |

### 2.1.2 Two findings that changed the design

**One global query is not enough, and a careless measurement said it was.** A
single 6,000 nm circle returned 10,013 aircraft and four circles returned
10,009, which reads as proof that one suffices. It was not: the other three
sample points were inside the area the first already covered. Asking the obvious
follow-up question — what is over Australia? — returned **zero** from the single
circle and **27** from a direct query. The global sweep is four circles.

This is the most important methodological finding in the project and it recurs
in Chapter 7: *a benchmark that samples only where the system already works
proves nothing.*

**A rate limit cannot be characterised with a burst.** adsb.lol appeared to
tolerate any request rate when tested with occasional bursts of four. Under
continuous load it refused 38% of requests. Measured properly — steady sending,
nothing else running — the limit is **four requests, then approximately one
every twelve seconds**. Allowing a burst is precisely what a token bucket is
for, and mistaking the burst for the limit cost three separate "fixed" claims.

### 2.1.3 Performance feasibility

The backend runs a single-threaded event loop, so any slow synchronous
operation delays every other request and the poller with it. Measured medians:

| Objects held | Poll apply | Bounding-box filter | Thin to 2,000 | Search |
|---|---|---|---|---|
| 2,000 | 0.7 ms | 0.57 ms | 0.82 ms | 1.6 ms |
| 10,000 | 7.4 ms | 3.2 ms | 9.1 ms | 8.3 ms |
| 30,000 | 14.4 ms | 9.2 ms | 43.5 ms | 24.2 ms |

Rendering was measured in the browser at the 2,000-marker cap: **0.80 ms per
update, 4.8% of a 60 fps frame budget**, scaling linearly to 10,000 markers —
more aircraft than are reported globally.

**Technical feasibility: confirmed.** Every capability the objectives require
was demonstrated on live services before being designed around.

---

## 2.2 Economic Feasibility

### 2.2.1 Direct cost

**The direct monetary cost of building and running Orbital is zero.** Every
component is free at the point of use:

| Cost category | Amount | Note |
|---|---|---|
| Data sources | **0** | All six are free; two require a key, neither charges |
| Map imagery and tiles | **0** | NASA GIBS and OpenFreeMap are open |
| Libraries and tooling | **0** | All open source |
| Hosting during development | **0** | Runs locally |
| **Total** | **0** | |

The genuine cost is labour: four students over one semester.

### 2.2.2 The quota is the real budget

Although no money changes hands, one resource is finite and had to be budgeted
like money. The OpenSky Network allocates a daily credit allowance, spending
credits by the geographic area of each query.

The polling strategy is derived arithmetically from that allowance rather than
chosen by feel. In the configuration used, the two scheduled jobs project
**3,072 credits per day against a 4,000 allowance — 77%, leaving 23% headroom**
for the per-selection lookups a user triggers by clicking. The system refuses to
start if the configured intervals would exceed 85% of the allowance, so a
mistaken interval fails immediately rather than exhausting the day's credits by
mid-afternoon.

Adding the free adsb.lol feed as the primary source, with OpenSky supplementing
it every 120 seconds, decoupled the refresh rate from the credit ladder
entirely. Ships and satellites cost nothing at all: Digitraffic and aisstream
are unmetered, and satellite positions are computed rather than fetched.

### 2.2.3 Licensing constrains the revenue model, and unevenly

This is the finding with the clearest commercial consequence, and the three
sources sit at three different points:

| Source | Commercial use | Consequence |
|---|---|---|
| **Digitraffic** (Fintraffic) | **Explicitly permitted** (CC BY 4.0) | Usable under any model, with attribution |
| **OpenSky Network** | **Explicitly forbidden** — non-commercial only | Any paid tier must not depend on it |
| **aisstream.io** | **Unanswered** | Asked publicly on their issue tracker in April 2026; no reply. Used on the footing of a free public service, credited, and behind a configuration switch that disables it the day anything is charged for |
| **adsb.lol** | ODbL — permits commercial use | A produced work may be licensed freely; a derivative *database* must be shared alike |

The practical conclusion: **a commercial version of Orbital is possible but not
with its current source mix.** The aircraft layer would need to drop OpenSky and
rely on adsb.lol alone, accepting the coverage gaps that Chapter 2.1 measured.
This is recorded as a finding rather than resolved, because resolving it is a
business decision and not a technical one.

### 2.2.4 The implemented model

A free tier supported by advertising and a paid tier are both implemented. The
advertisements are **house advertisements only** — the project's own messages in
real advertisement dimensions — because a third-party advertising network would
introduce tracking into a project that collects no analytics.

The paid tier is honest about not being paid: the button reads **"Switch premium
on", never "Buy"**, and an automated test enforces that wording. There is no
payment processor, and a Buy button that takes no money is a lie told in the
interface.

---

## 2.3 Operational Feasibility

### 2.3.1 Can it be operated?

Orbital runs as two processes — an API server and a static frontend — with no
database server, no message queue and no external cache. Application state lives
in process memory; the only state that must survive a restart is accounts, held
in a single SQLite file.

**Deliberate simplicity.** An external cache was considered and rejected: there
is one process and one poller, so a shared cache would add an operational
component without removing any problem.

### 2.3.2 Does it survive its dependencies failing?

This was the objective most at risk, because the project depends on six external
services it does not control. The failure behaviour is structural: **the API
layer never calls an upstream service.** It reads a cache the ingestion layer
fills on a schedule. There is therefore no upstream call in the request path
that *can* fail.

Verified rather than assumed, including on a day when it was not a drill:

| Failure | Behaviour |
|---|---|
| Upstream returns 5xx | Last good snapshot served, flagged `stale`; poller backs off |
| Upstream rate-limits | Same, using the upstream's own retry hint |
| One of two aircraft feeds down | The other continues; the map is drawn |
| One of two ship feeds down | The other continues |
| **CelesTrak returned 503 for a full day** | The SatNOGS fallback served; cached elements remain usable for days |
| Network entirely absent | The fixture provider replays committed data |

### 2.3.3 Can a viewer understand it?

Operational feasibility includes whether the output is *readable*, and this
drove a class of requirement that a purely technical analysis would miss.

The interface must not make claims the data cannot support. Concretely: markers
older than two minutes fade rather than persisting silently; an object whose
heading was never transmitted is drawn as a disc rather than an arrow pointed
north; the ship layer's subtitle names its actual coverage; and the satellite
layer reports no data age at all, because a computed position does not have one
and displaying "never" reads as a fault.

---

## 2.4 Schedule Feasibility

### 2.4.1 Approach

The project was delivered in phases, each with an explicit boundary. Work
proceeded in sessions, and every session ended with a written handover so that
no context depended on memory.

| Phase | Delivered |
|---|---|
| 1 | Aircraft layer end to end: ingestion, API, globe, selection, detail panel |
| 2 | Satellite layer; migration from a 3D globe to MapLibre; deletion of the old renderer |
| 3 | Moon and solar system views |
| 4 | Accounts, tiers, advertisements, entitlements |
| 5 | Ship layer, regional then global |
| 6 | Performance and defect sweep |

### 2.4.2 Evidence that the schedule held

The strongest evidence is the cost of the later phases. If the phase 1
architecture had been wrong, adding a class of object would have required
rework across all three layers. Measured:

- **The satellite layer** cost one provider module and one registry entry.
- **The ship layer** cost the same, four months later.
- **The polling logic was not modified for either**, because it reads a
  configuration value and does not know what it is fetching.

### 2.4.3 Where the schedule was lost, and to what

Reported honestly, because it is the more useful half.

**Six sessions were spent on one defect that was misdiagnosed five times.** The
symptom was a rendering fault in the solar system view. Each of the five
attempted fixes removed something genuinely wrong and left the symptom standing.
The cause was structural: one camera was serving two pictures at wildly
different scales, and every fix was a negotiation between them. The eventual
resolution deleted 376 lines and added 130, and cost no feature at all.

**Tooling consumed real time.** The single largest recurring cost was stale
development state — a hot-reloading server silently serving old code, producing
measurements that described code no longer on disk. The lesson is recorded as
working practice: *verify the instrument is attached to the thing before
believing it about the thing.*

---

## 2.5 Related Systems and Research

### 2.5.1 Comparable systems

| System | Covers | Model | Relationship to Orbital |
|---|---|---|---|
| **Flightradar24** | Aircraft | Commercial, freemium | The reference for what a mature aircraft tracker looks like. Far larger receiver network; closed data |
| **MarineTraffic** (Kpler) | Ships | Commercial | The equivalent for shipping. Acquired during this project |
| **OpenSky Network** | Aircraft | Research, non-commercial | Used as a *source*. Its non-commercial clause directly constrains Chapter 2.2 |
| **adsb.lol** | Aircraft | Community, open | Used as the primary aircraft source |
| **AISHub** | Ships | Reciprocal | **Evaluated and rejected**: access requires contributing a receiver, which the team does not have |
| **N2YO / Heavens-Above** | Satellites | Free, ad-supported | Comparable satellite tracking; neither combines classes on one map |

**The distinguishing feature of Orbital** is not any single layer, each of which
is done better elsewhere by organisations with larger networks. It is that
**three classes of object with three different acquisition models — observed and
metered, observed and free, and computed — are presented on one map through one
shared data shape**, and that the interface is explicit about the limits of each.

### 2.5.2 A market finding

A deliberate search was made for a free, global, key-less ship feed equivalent
to adsb.lol's role for aircraft. **No such thing exists**, and the reason is
structural rather than accidental: an AIS receiver is a real installation rather
than a low-cost dongle, so volunteer networks operate on reciprocity — the
aggregated feed in exchange for contributing one. The commercial half of the
market has consolidated under two owners.

This is recorded so that the search is not repeated. The nearest equivalent,
aisstream.io, is free and global but carries the unresolved licence question
noted above.

---

## 2.6 Relevant Theories and Technologies

### 2.6.1 ADS-B — Automatic Dependent Surveillance–Broadcast

Aircraft broadcast identity, position, altitude and velocity roughly once a
second. Coverage depends entirely on a receiver being in range, which is why
oceanic and remote regions are sparse in every terrestrial network.

### 2.6.2 AIS — Automatic Identification System

Vessels broadcast position every few seconds and their *identity* — name, type,
dimensions, destination — on a separate message every six minutes. Two
consequences shape the ship layer:

**"Not available" is a number, not a blank.** A speed of 102.3 knots, a course
of 360° and a heading of 511 all mean "the transmitter did not say". In one live
sample these covered 11, 88 and 142 vessels of 916. Rendered without
interpretation they produce a moored ship travelling at 190 km/h.

**Identity accumulates far more slowly than position.** Measured on the live
stream at 26.5 static messages per second against 114 position reports, vessel
type coverage climbed from 3% at thirty seconds to **62% after fifty-four
minutes**, and was still rising. This is a property of the protocol, not of the
implementation.

### 2.6.3 SGP4 and orbital elements

Satellite positions are computed from published two-line element sets using the
SGP4 propagator, the standard model for the format. Two properties matter:

- Elements describe an *orbit*, not a position, and remain usable for days — so
  the satellite layer keeps working through an upstream outage.
- **Accuracy degrades roughly a kilometre per day from epoch, silently.** Handed
  a 1975 element set, SGP4 returns a confidently formatted and entirely wrong
  answer. Of 1,670 sets in one live feed, **87 were over a year old and the
  oldest was from 1975**. Elements older than seven days are refused at
  ingestion.

### 2.6.4 Map projection and level of detail

The Web Mercator projection underlies both the globe and the street-level view.
Two consequences were measured and are used directly:

- A pixel covers a different ground distance at every zoom and latitude. At zoom
  7 a pixel is about 750 m; at zoom 14 about 6 m. This arithmetic determines how
  often the display needs redrawing at all — a ship crossing a pixel every two
  minutes does not need redrawing sixty times a second.
- Drawing every object at every zoom is neither useful nor affordable, which
  motivates the spatial thinning described in Chapter 3.

### 2.6.5 Signed distance field icons

Marker symbols are rendered as signed distance fields so that one silhouette can
be tinted per object rather than requiring an image per colour. The trade-off is
specific: the alpha channel encodes *distance*, not coverage, so thin detail
does not merely shrink when scaled down — it dissolves, and the halo floods the
cell. Marker artwork is therefore deliberately chunky.

### 2.6.6 HTTP conditional requests

The polled endpoints implement ETag-based conditional requests. When the
underlying data has not changed, the server returns **304 Not Modified** before
reading its store — no filtering, no thinning, no serialisation, no compression.
The tag is *weak*, because two responses generated from one store version differ
only in a reported age.
