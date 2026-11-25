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

### Two measurements that changed the design

One global query is not enough. A single 6,000 nautical-mile circle returned
10,013 aircraft and four circles returned 10,009, which appeared to prove one
was sufficient. The other three sample points were inside the area the first
already covered. Over Australia the single circle returned 0 and a direct query
returned 27. The global sweep uses four circles.

A rate limit cannot be characterised with a burst. adsb.lol appeared to
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

## A.2 Economic Feasibility

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

## A.3 Operational Feasibility

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
The cause was structural (one camera serving two pictures at very different scales), and the resolution deleted 376 lines, added 130, and cost no feature.
