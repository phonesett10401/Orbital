# Orbital — Design Decisions

A running record of every significant architectural choice and why it was made.
Newest entries are appended at the bottom. Each entry states the decision, the
alternatives considered, and the reasoning — so any team member can defend it.

Entries are a historical log. Where a later decision changes an earlier one, the
earlier entry carries a note rather than being rewritten: the reasoning at the
time is part of the record.

Format: **decision**, *alternatives*, reasoning, and where relevant, what would
make us revisit it.

---

## D1 — Globe.gl for rendering, not CesiumJS

**Decision:** render the globe with Globe.gl, a declarative wrapper over three.js.

*Alternatives:* CesiumJS; raw three.js; raw WebGL.

Raw WebGL was excluded by the project constraints. The real choice was between
Globe.gl and CesiumJS.

CesiumJS is a genuine geospatial engine: true WGS84 ellipsoid, terrain,
imagery tiling, and time-dynamic entities that interpolate positions for you.
Those are real advantages and we do not dismiss them. We rejected it anyway:

- **Its accuracy is invisible at our zoom level.** An aircraft at 12 km on a
  6371 km globe is a 0.2% radial offset. The difference between a sphere and
  the WGS84 ellipsoid is around 0.3%. Neither is a visible pixel.
- **Its API surface is weeks of learning** for a three-person team with one
  semester, and that time comes directly out of the features being graded.
- **Its built-in interpolation is the one thing we would actually want**, and
  it is roughly thirty lines of dead reckoning to write ourselves — which we
  need to understand anyway in order to explain it.
- Imagery requires either an Ion token or a fiddly offline configuration.

**Revisit if:** true altitude accuracy ever becomes a requirement, or if we
need terrain, real imagery tiling, or objects at radically different altitudes
where Globe.gl's radial model gets awkward. Because the renderer only consumes
the normalized shape, swapping it is a frontend-local change.

---

## D2 — FastAPI for the backend, not Node

**Decision:** Python + FastAPI.

*Alternatives:* Node with Express or Fastify.

The team knows both languages, so "one language across the stack" — Node's main
argument — carries little weight here: the backend is under a thousand lines and
the frontend is React regardless.

FastAPI wins on three specific points:

- **Pydantic makes the cross-layer contract executable.** The normalized shape
  stops being a comment and becomes a validated model. A provider that drifts
  from the contract fails at the boundary, in the provider's own tests.
- **OpenAPI documentation is free** at `/docs`, which is a graded artifact we
  get for nothing.
- **The Provider interface is cleaner as an ABC**, and the poller is an asyncio
  task started in FastAPI's `lifespan` — a natural fit rather than a bolt-on.

---

## D3 — React + Vite + TypeScript on the frontend

**Decision:** TypeScript, accepting the learning curve.

*Alternative:* plain JavaScript, which is faster to start.

The normalized shape is the contract between layers. TypeScript makes the
compiler enforce it on the frontend side: when a field changes meaning or
nullability, every consumer that needs updating is enumerated rather than
found by hand. Nullability is the decisive case here — `altitude`, `velocity`
and `heading` are all nullable, and the difference between unknown and zero is
load-bearing throughout the UI.

**Cost accepted:** roughly a week of friction if nobody has shipped TypeScript
before. Falling back to plain JS is survivable but forfeits the main benefit.

---

## D4 — Nine-field universal shape with a `meta` escape hatch

**Decision:** `TrackedObject` contains no source-specific field. Anything
specific to one kind of object goes in `TrackedObjectRecord.meta`.

*Alternative:* put `originCountry` directly in the shape, since the detail
panel needs it.

Origin country is meaningless for a satellite. Putting it in the universal
shape would force a future satellite provider to emit a fake value or change
the schema — at which point the claim that data sources are pluggable would be
false. `meta` is the pressure valve that keeps the claim true.

**Consequence:** three model types instead of one — `TrackedObject` (the wire
shape), `TrackedObjectRecord` (+ `meta`, internal), `TrackedObjectDetail`
(+ `track`). The list endpoint declares `TrackedObject` as its response model,
so FastAPI projects `meta` away automatically and a 2000-object payload stays
small without anyone remembering to strip fields.

---

## D5 — camelCase on the wire, snake_case in Python

**Decision:** Pydantic serializes with a camelCase alias generator.

Python code stays idiomatic; the frontend receives idiomatic JSON. The
alternative — snake_case JSON — would put `last_seen` into TypeScript, where it
reads as a foreign body. `populate_by_name` means fixtures and tests may use
either spelling, so this costs nothing at the boundary.

---

## D6 — "Route" means the observed track, not the filed flight plan

**Decision:** the route is the path we have watched the aircraft fly since it
entered our polling window. We accumulate polled positions into a bounded ring
buffer per object.

*Alternative:* fetch real origin/destination via OpenSky's `/flights/aircraft`
endpoint.

Rejected because it costs additional quota we do not have (see D7), frequently
returns nothing for an aircraft that is currently airborne, and is historical
rather than live.

**This is a product limitation, not a defect**, and it must be stated plainly
in the demo and in [data-contract.md](data-contract.md). Its consequences: the
route begins when we first saw the object, it is lost on backend restart, it is
truncated by the ring buffer, and it is a sampled polyline rather than a smooth
path.

**This decision shaped the store's design from the first commit** — it is why
the store keeps per-object history at all, rather than only the latest snapshot.

---

## D7 — One poller per server, on a slow interval, with interpolation

> **Partly superseded by [D21](#d21--quota-arithmetic-and-why-the-global-sweep-survives).**
> The single-poller principle and the interpolation argument stand. The 60-second
> interval and the per-request quota model in this entry were wrong: `/states/all`
> is billed by requested area, and a 60-second global poll costs 144% of the daily
> budget.

**Decision:** a single background task polls upstream regardless of how many
browsers are connected. Base interval 60 s, config-driven.

OpenSky's free tier is credit-metered per day, and an authenticated account
gets meaningfully more than an anonymous one. The arithmetic is unforgiving: a
30-second interval is 2,880 requests per day, which exhausts a free allowance
long before a demo. *(Verify current published limits before committing to an
interval — do not trust a number remembered from elsewhere.)*

Three consequences follow:

- **The browser never calls OpenSky.** A hundred tabs cost the same quota as
  one. This is the primary justification for having a backend at all.
- **Client-side interpolation is load-bearing, not polish.** A 60-second poll
  with smooth dead reckoning looks better than a 15-second poll that teleports
  markers. Interpolation is what makes the quota budget survivable.
- **Development runs against the fixture provider** (D8) so only one machine
  ever touches the live API.

---

## D8 — A fixture provider is infrastructure, not a convenience

**Decision:** `FixtureProvider` replays committed synthetic data from disk and
animates it by dead reckoning. It is the default provider in development.

Three developers sharing one rate-limited credential would either exhaust the
daily quota by mid-morning or serialise their work behind whoever holds it.
With the fixture provider, the API layer, the thinning logic and the entire
frontend are built and tested with no credentials and no network.

The fixture holds **already-normalized** objects rather than raw OpenSky rows.
That keeps it independent of any one upstream format, at the cost of not
exercising the OpenSky parser — which is covered instead by unit tests against
a recorded raw sample in M2. This tradeoff is the reason both test files exist.

The fixture deliberately includes edge cases real data contains: null velocity,
unknown altitude, an aircraft on the antimeridian, a polar route, and a missing
callsign. We meet them in week two rather than in the demo.

The data is generated by a committed, fixed-seed script
(`backend/tests/fixtures/generate_sample.py`) so it is reproducible and
reviewable rather than a 157-object blob of unknown origin.

---

## D9 — Retry and backoff belong to the poller, not to providers

**Decision:** a `Provider` performs one attempt and raises a typed
`ProviderError`. The poller owns all scheduling, retry and backoff policy.

Written once, tested once, and identical for every data source. If each
provider implemented its own retry, the policy would drift between sources and
each would need its own tests.

`ProviderRateLimited` carries an optional `retry_after`, which the poller
honours in place of its own backoff. Since quota exhaustion is the failure we
most expect, continuing to hammer a source that has already refused would make
the situation worse rather than better.

The poller catches `ProviderError` and **only** `ProviderError`. Anything else
escaping a provider is a bug, and we want it loud rather than silently retried.

---

## D10 — Upstream failure never reaches the browser

**Decision:** a failed poll does not mutate the cache. The API always returns
200 with the last good snapshot, flagged `stale` with an `ageSeconds` value.

Surviving an OpenSky outage is a phase 1 exit criterion, so it is designed
rather than discovered. The frontend keeps showing last-known positions with
timestamps instead of removing markers, because an aircraft that stopped
reporting has not stopped existing.

The test that kills the provider and asserts the API still returns 200 with
stale data **is** the exit criterion, not merely evidence for it.

---

## D11 — In-process cache, no Redis; linear bbox scan, no spatial index

**Decision:** the snapshot lives in a plain dictionary in the FastAPI process.
Bounding-box filtering is a linear scan.

Redis would add an operational dependency, a serialization step, and a failure
mode, in exchange for nothing: there is one process and one poller, and
horizontal scaling is explicitly out of scope.

Similarly, filtering ~10,000 aircraft by bounding box is 10,000 float
comparisons — well under a millisecond. An R-tree here would be complexity we
would have to justify without a measurement supporting it.

**Revisit if:** the backend is ever deployed with more than one worker process,
at which point each worker would poll independently and multiply quota use.

---

## D12 — Sphere, not ellipsoid

**Decision:** all geometry treats the Earth as a sphere of mean radius
6,371,008.8 m.

The WGS84 ellipsoid differs by roughly 0.3%. Over the distance an aircraft
covers between two polls, that is a few metres — far below one screen pixel at
globe zoom. The ellipsoid would buy accuracy we cannot see at a complexity we
would have to defend.

---

## D13 — Antimeridian handling lives in `BBox`, not in callers

**Decision:** `BBox.contains()` handles the wrap case, and every caller
inherits it.

A bounding box crossing ±180 is two longitude ranges, not one. The naive test
`lonMin <= lon <= lonMax` returns *nothing* for such a box, so the Pacific
silently empties out — a bug that produces no error, no log line, and no
crash. Solving it once inside the model means no future caller can reintroduce
it. The fixture includes aircraft near the antimeridian specifically so this
path is exercised.

---

## D14 — Two-tier polling: coarse globally, fast where the user is looking

**Decision:** poll `/states/all` globally on the slow interval to keep the whole
globe populated, and additionally poll the current camera bounding box on a
faster interval so the region under inspection stays live.

*Alternative:* a single global interval, treating focused polling as a later
optimization.

Recorded as a design decision rather than an optimization because it changes
the poller's structure — it needs to manage more than one polling job with
different intervals and merge their results into one store — and retrofitting
that later would mean rewriting the poller.

The tradeoff it resolves: a globally slow interval alone makes the area the
user is actually watching feel dead, while a globally fast interval is
unaffordable (D7). Scoping the fast poll to the visible box keeps the cost
proportional to attention rather than to the size of the Earth.

> **Superseded by [D21](#d21--quota-arithmetic-and-why-the-global-sweep-survives).**
> Two-tier polling is now the primary mechanism and is implemented in M2, not M5.
> D21 also reassigns the tiers by purpose rather than geography: tier 1 buys
> coverage, tier 2 buys latency.

---

## D15 — Server-side thinning, not client-side clustering

**Decision:** reduce marker count in the API layer so the client never receives
more than ~2,000 objects.

*Alternative:* send everything and cluster in the browser.

Three reasons for the server:

- **Naive rendering is the real risk.** Globe.gl's convenient `pointsData()`
  API creates one mesh per point; at 10,000 aircraft that is 10,000 draw calls
  and an unusable frame rate. Capping what the client receives removes the
  worst case rather than mitigating it.
- **It is cheap where the data already lives** — the snapshot is in memory and
  already being scanned for the bounding box.
- **It is easy to unit test**, which matters directly for the test plan.

Paired with a single `THREE.Points` layer rather than per-point meshes, so the
2,000 remaining markers are one draw call.

The response reports `total` and `returned` separately so the frontend can tell
the user they are seeing a sample rather than everything.

---

## D16 — Earth visual treatment is part of the frontend milestone

**Decision:** textured Earth (colour, bump/normal, specular, night lights with a
sun-angle-driven terminator), fresnel atmospheric glow, and a star field are
built as part of M4, not deferred as a stretch goal.

All of it is texture and shader work on geometry that already exists — a
handful of extra samples per fragment on one sphere, plus one transparent
sphere and a skybox. The per-frame cost is close to constant and does not scale
with marker count. Treating it as a stretch goal would have implied it was
expensive, which would have been wrong.

The Earth texture path is config-driven, starting at 4096×2048 NASA Blue Marble
imagery, so texture resolution can be traded against load time without a code
change.

**The visual layer is kept separate from the marker layer** so that rendering
cost stays attributable: when frame rate drops we need to know whether it is
the Earth or the markers, and that is only answerable if they are separable.

---

## D17 — No 3D buildings, terrain meshes, or tiled geometry streaming

**Decision:** explicitly out of scope, permanently.

At globe zoom a building is smaller than one pixel — the entire cost would
purchase something literally invisible. Worse, it is not a rendering feature
but a data pipeline: tiled geometry streaming, level-of-detail management, and
a tile source, which together would cost more than the rest of the project
combined and would displace the features actually being graded.

This exclusion is recorded because "why doesn't it have buildings like Google
Earth" is a predictable question, and the answer is a deliberate engineering
judgement rather than an omission.

---

## D18 — The TypeScript contract is mirrored by hand, not generated

**Decision:** `frontend/src/types.ts` is written by hand and updated in the same
commit as `models.py`.

*Alternative:* generate it from FastAPI's OpenAPI schema.

The contract is nine fields and changes rarely. A codegen step is another tool
to install, another build stage to run, and another thing that can break for a
three-person team on a deadline. The discipline required instead — change both
files together — is enforced by review.

**Revisit if:** the shape starts changing often, or drift between the two
actually causes a bug.

---

## D19 — No speculative layer system

> **Amended by [D37](#d37--satellite-tracking-is-out-of-scope).** This entry was
> originally written about "phase 2 footholds". Satellite tracking is no longer
> planned, and the two pieces below stand on their own reasoning rather than as
> groundwork for anything.

**Decision:** the `type` field and the provider registry stay exactly as small
as they are. No layer abstraction built "for later".

Speculative generality is the failure mode: building a layer system before
there is a second layer produces an abstraction fitted to an imagined use case,
which turns out to be the wrong shape if a real one ever arrives.

Both pieces earn their place independently. A discriminator carried from the
start costs one enum with one value; retrofitting one into a contract spanning
three layers is a migration. The registry *is* the pluggability requirement —
swapping data sources by config — and it is what makes the offline fixture
provider possible (D8).

`test_providers.py` and `test_api.py` each contain a tripwire asserting no
satellite provider or endpoint exists. They are **permanent**, not markers
awaiting deletion.

---

## D20 — Localhost only; CORS is permissive and flagged

**Decision:** no Docker, no hosting, no deployment configuration. CORS allows
the Vite dev server origin.

Deployment is out of scope, and configuration for a deployment that will never
happen is waste. The permissive CORS setting is recorded here as the single
change point if the project is ever hosted, so it is not overlooked in a
security review.

---

## D21 — Quota arithmetic, and why the global sweep survives

**Supersedes the interval reasoning in D7 and the "later enhancement" framing in D14.**

Verified quota (2026-08-25): **400** credits/day anonymous, **4000**
authenticated, **8000** for ADS-B contributors. Auth is OAuth2 client
credentials; HTTP basic auth has been removed.

The correction that forced this entry: `/states/all` is **not** billed per
request. It is billed by the **geographic area requested**, in square degrees,
under a banded schedule:

| Requested area (sq deg) | Credits |
|---|---|
| 0 – 25 | 1 |
| 25 – 100 | 2 |
| 100 – 400 | 3 |
| over 400, including the whole globe | 4 |

### The arithmetic

Daily cost of one polling job is `86400 / interval_seconds × credits_per_call`.
Against the 4000-credit authenticated budget:

| Scenario | Area | Credits/call | Credits/day | % of 4000 |
|---|---|---|---|---|
| Globe @ 60 s | 64800 | 4 | 5760 | **144%** |
| Globe @ 90 s | 64800 | 4 | 3840 | 96% |
| Globe @ 120 s | 64800 | 4 | 2880 | 72% |
| Globe @ 180 s | 64800 | 4 | 1920 | 48% |
| Globe @ 300 s | 64800 | 4 | 1152 | 29% |
| One 20°×20° region @ 60 s | 400 | 3 | 4320 | 108% |
| One 10°×10° region @ 60 s | 100 | 2 | 2880 | 72% |
| One 5°×5° region @ 45 s | 25 | 1 | 1920 | 48% |
| Six 10°×10° regions @ 300 s | 100 each | 2 each | 3456 | 86% |

The 60-second global poll assumed in D7 costs **144% of the entire daily
budget**. That assumption was wrong and is now dead.

### The finding that changes the plan

Because the band is **capped at 4**, area efficiency runs the opposite way to
intuition:

| Request | Area purchased per credit |
|---|---|
| 5°×5° box | 25 sq deg |
| 10°×10° box | 50 sq deg |
| 20°×20° box | 133 sq deg |
| **Full globe** | **16,200 sq deg** |

A full-globe call buys **324× more area per credit** than a 5°×5° box. Six
10°×10° regions cover 600 square degrees — 0.93% of the Earth — for 3456
credits/day, while a global sweep covers all 64,800 square degrees for 1152.

**Therefore: replacing the global sweep with a region set is strictly worse.**
It costs three times as much for one hundredth of the coverage. A bounded
region is only worth its credits when we need that area *faster* than the
global sweep provides — never for coverage.

The instinct behind the redesign was still correct, just aimed at the wrong
target: the fix for the quota problem is **slowing the global sweep** and
spending the savings on a small, fast box where the user is actually looking.
That is two-tier polling with the tiers assigned by *purpose* — tier 1 buys
coverage, tier 2 buys latency — rather than by geography.

### The recommended budget (authenticated, 4000/day)

| Tier | Request | Interval | Credits/day | Share |
|---|---|---|---|---|
| 1 — coverage | Full globe | 300 s | 1152 | 29% |
| 2 — latency | Viewport, clamped to ≤100 sq deg | 90 s | 1920 | 48% |
| | | **Total** | **3072** | **77%** |

That leaves 928 credits (23%) of headroom for restarts, debugging and demo-day
retries. It is also the **worst case**: tier 2 only runs while a client is
connected and zoomed in far enough for the box to be smaller than the globe, so
real consumption is well below this.

Presets for the other quota levels:

| Account | Tier 1 | Tier 2 | Credits/day | Share |
|---|---|---|---|---|
| Anonymous (400) | Globe @ 1200 s | *disabled* | 288 | 72% |
| Authenticated (4000) | Globe @ 300 s | Viewport @ 90 s | 3072 | 77% |
| Contributor (8000) | Globe @ 180 s | Viewport @ 60 s | 4800 | 60% |

Anonymous is a demo-only mode: a 20-minute global refresh with no live tier.
It exists so the project runs at all for a marker without credentials.

### Consequences for the implementation

- **The region set and both intervals are config-driven**, so switching to a
  pure-region strategy is configuration, not code. The arithmetic above argues
  against it, but the architecture does not forbid it.
- **Tier 2 is skipped when the viewport is large.** A zoomed-out camera is
  already covered by tier 1, so paying for it twice is waste.
- **The viewport box is snapped to a grid** before polling, so nudging the
  camera by a few pixels does not spend a credit.
- **Interpolation is now more load-bearing than ever.** Tier 1 data can be five
  minutes old. At 250 m/s that is 75 km of dead reckoning — roughly 6 pixels at
  globe zoom, acceptable for context, and the reason tier 2 exists for anything
  the user is actually examining.

---

## D22 — Credit accounting is a first-class module, not a comment

**Decision:** the band table, the per-job cost calculation and the daily budget
projection live in `app/quota.py` with their own tests, rather than as constants
scattered through the poller.

The arithmetic in D21 is the single most important constraint on the project —
getting it wrong takes the live demo offline for a day with no way to buy the
credits back. Making it executable means the budget can be asserted in a test
(`the configured preset must not exceed the daily budget`) rather than
recalculated by hand whenever an interval changes.

It also means that if OpenSky changes the band boundaries, one table changes.

---

## D23 — Throttle on observed balance, not only on the projected budget

**Decision:** read `X-Rate-Limit-Remaining` from every response, expose it on
`/api/health`, and lengthen intervals automatically as the balance falls.

The projected budget in D21 assumes a single process polling on schedule from a
clean start. Reality includes restarts during development, a teammate running a
second backend against the same credentials, and manual testing — all of which
spend from the same daily pool without the poller knowing.

The remaining-credit header is ground truth where the projection is only an
estimate, so the poller trusts the header and degrades in stages:

| Balance remaining | Behaviour |
|---|---|
| above 40% | configured intervals |
| 20–40% | intervals ×2 |
| 10–20% | intervals ×4, tier 2 disabled |
| below 10% | tier 1 only, at the anonymous interval |
| exhausted, or HTTP 429 | stop polling, serve cache, recover at the time upstream specifies |

A 429 carries `X-Rate-Limit-Retry-After-Seconds`; the poller honours it instead
of applying its own backoff, per D9. Hammering a source that has already
refused is how a temporary limit becomes a longer one.

**Simplification accepted:** thresholds are fractions of the daily allowance
rather than a true burn-rate model measured against the quota reset time. The
reset semantics are not clearly enough documented to model reliably, and a
staged fraction ladder fails safe in the same direction.

---

## D24 — OAuth2 tokens are refreshed by the provider, transparently

**Decision:** `OpenSkyProvider` obtains a token via the client-credentials
grant, caches it, and refreshes it before expiry. Nothing above the provider
knows tokens exist.

Basic auth has been removed upstream, so this is mandatory rather than
preferred. Tokens last roughly 30 minutes, which is shorter than a demo, so
"it worked when we tested it" is not evidence it will survive presentation day.

The provider refreshes on a **safety margin before nominal expiry** rather than
waiting for a 401, so a refresh never lands in the middle of a scheduled poll.
A 401 despite a valid-looking token still forces one refresh-and-retry, because
a clock skew between our host and theirs would otherwise be unrecoverable.

Credentials come from the environment and are never committed. `.env` is
ignored by git; `.env.example` documents the variable names with empty values.

---

## D25 — A viewport crossing the antimeridian is skipped, not split

**Decision:** `OpenSkyProvider.fetch()` rejects a bounding box that wraps ±180,
and the tier 2 scheduler skips that cycle rather than issuing a request.

*Alternatives:* split the wrapping box into two requests; or clamp it to one
side and accept missing data.

OpenSky's `lamin/lomin/lamax/lomax` parameters cannot express a wrapping box.
Splitting into two requests is the only *correct* way to cover one, but it
**doubles the credit cost of an unpredictable subset of polls**, which breaks
the guarantee that startup validation makes about the daily projection (D21). A
budget that silently doubles under a camera position is not a budget.

Clamping to one side was rejected outright: it returns half the requested area
while reporting success, which is a data bug rather than a limitation.

Skipping is safe because **tier 1 already covers that airspace**. The user
looking across the Pacific dateline sees globally-polled data at tier 1
freshness instead of tier 2 freshness. That is a graceful degradation in one
narrow case, not missing data.

The refusal is a `ValueError`, not a `ProviderError`, because submitting a
wrapping box is a caller bug rather than an upstream failure — and the poller
catches `ProviderError` only, so a `ValueError` here would be loud rather than
silently retried (D9).

---

## D26 — The store merges by object, and never replaces wholesale

**Decision:** `ObjectStore` upserts records by id and expires them individually
on an object TTL, rather than swapping in a fresh snapshot per poll.

This follows directly from two-tier polling (D21). Two jobs return results at
different times covering different areas: a wholesale replace on the 45-second
viewport poll would erase every aircraft outside the viewport, and the globe
would flash empty twice a minute.

**Consequences accepted:**

- The store needs its own eviction pass, because "not present in the latest
  response" no longer implies "gone". Objects are dropped when not re-observed
  within `object_ttl_seconds`, which is deliberately longer than the staleness
  TTL so a briefly-missing aircraft keeps its track history.
- Freshness becomes per-object rather than per-snapshot. `lastSeen` on each
  object is the authority; the envelope's `stale` flag describes the store as a
  whole.

Every store method is **synchronous and contains no `await`**, which under
asyncio makes each one atomic with respect to the event loop — the poller
cannot interleave with a request handler mid-update. This is load-bearing:
introducing an `await` inside any store method would create a race that would
be extremely hard to reproduce.

---

## D27 — The viewport box is trimmed into the 1-credit band, not skipped

**Decision:** after snapping the viewport to the grid, trim it in whole grid
steps until it fits 25 square degrees. Skip only when the camera is genuinely
zoomed out (above `focus_skip_area_sq_deg`, default 400).

This was found by a smoke test rather than by reasoning, which is worth
recording. The original rule was "skip the focus poll if the viewport exceeds
25 sq deg". But snapping *expands* a box by up to one grid step per edge, so a
5°×5° viewport — exactly 25 sq deg, exactly affordable — became 7.5°×7.5° after
snapping and was then rejected as too large. The feature silently did nothing
for precisely the zoom level it was designed for.

Three consequences of the fix:

- **Tier 2 never exceeds its credit band.** That is what makes the daily
  projection in D21 an exact figure rather than an estimate, and it is asserted
  by a test that walks several viewport sizes. (The band was later widened from
  one credit to two, with the interval doubled to match — see D36.)
- **Trimming is in whole grid steps**, so the result stays grid-aligned and
  keeps the stability that snapping bought.
- **The trimmed edges are not lost**, they are covered by tier 1 at tier 1
  freshness. The degradation is graceful and confined to the margins of the
  screen.

The grid also dropped from 2.5° to 1.0°, so snapping costs little area.

**Correction to the stated rationale for snapping.** It was originally
justified as "so nudging the camera does not spend a credit". That reasoning
was wrong: polls are time-driven, so a camera nudge never triggers a request by
itself. What snapping actually buys is *stability* — consecutive polls cover
the same area, so aircraft do not flicker in and out at the edges as the camera
drifts. The mechanism was right; the explanation was not, and an explanation
nobody can defend is worse than none.

---

## D28 — Thinning is a spatial grid, not a proximity cluster

**Decision:** divide the requested box into roughly `limit` cells, bucket
objects into cells, then take each cell's best object, then each cell's second
best, until the budget is spent.

*Alternatives:* take the first N (trivial); true proximity clustering with
merged "12 aircraft here" markers.

Taking the first N is what a naive implementation does, and it fails visibly:
the response fills with a solid blob over Europe and the rest of the globe
comes back empty. A grid spreads survivors across the visible area, which is
the actual requirement.

True clustering was rejected as more machinery than phase 1 needs. It requires
a cluster marker type, a click-to-expand interaction, and a distance metric
that behaves near the poles — none of which is in scope, and all of which would
displace graded features.

**Stability is weighted above optimality.** If a cell's chosen representative
flipped between polls, markers would blink on and off every few seconds. The
ranking key is therefore altitude *bucketed to 1000 m*, then id — so a cruising
aircraft outranks a taxiing one, but normal climb and descent do not reshuffle
the display. Determinism is asserted directly by a test, as is independence
from input ordering.

Preferring altitude also means a zoomed-out view shows en-route traffic rather
than a selection dominated by ground vehicles at busy airports.

---

## D29 — Every read endpoint answers 200, including during an outage

**Decision:** `/api/aircraft` and `/api/aircraft/{id}` never return 5xx because
upstream failed. They serve whatever the store holds, with `stale` and
`ageSeconds` in the envelope.

No route in the API layer performs I/O or calls a provider. That is not a
convention to be maintained by discipline — it is structural, and it is why
there is nothing in the request path that *can* fail from an outage.

The exceptions are genuine client errors: a malformed `bbox` is a 422, and an
unknown id is a 404. Serving the whole globe for an unparseable bbox would hide
a frontend bug behind plausible-looking data.

`/api/health` also answers 200 when degraded. It *describes* the system rather
than being a liveness signal; returning 503 would make a monitoring tool report
"health check down" when the truth is "OpenSky is down and we are coping".

**A reporting bug found by running the server rather than the tests:** a tier 2
job that has correctly skipped every cycle was being reported `healthy: false`,
because "healthy" was defined as *has succeeded at least once*. Tier 2 skips
legitimately until a client reports a small enough viewport, so that definition
sends whoever reads `/api/health` chasing a bug that is not there. Health now
means *not currently failing*; a tier 1 job that has never polled surfaces as
the overall status `starting` instead.

---

## D30 — Earth textures are copied from node_modules, not committed or fetched

**Decision:** `scripts/copy-textures.mjs` copies NASA Blue Marble imagery out of
`three-globe/example/img` into `public/textures/` before dev and build. The
paths are then config-driven via `VITE_EARTH_*_TEXTURE`.

*Alternatives:* commit the images (~4 MB); reference a CDN; generate procedural
textures at runtime.

`three-globe` is already a dependency of globe.gl and ships the imagery we
need, so the assets arrive with `npm install`. That gives a globe that looks
like Earth out of the box with **no CDN dependency and no network beyond the
install**, which matters because the fixture provider (D8) otherwise makes the
whole application runnable offline and a CDN would quietly undo that.

They are copied rather than imported because `three-globe`'s package `exports`
map does not expose the example directory — a deep import fails at build time.
They are copied rather than committed so ~4 MB of binaries stay out of git
history.

Procedural generation was rejected outright: a canvas-drawn planet does not
look like Earth, and "looks like Earth" was the requirement.

Higher-resolution imagery drops into the same directory with one environment
variable, so texture resolution can be traded against load time without a code
change.

---

## D31 — The three.js version is pinned to what globe.gl needs

**Decision:** depend on the same major of `three` that globe.gl's transitive
dependencies require, and add `resolve.dedupe: ['three']` to the Vite config.

Found by running the app rather than by testing it. The console reported
*"Multiple instances of Three.js being imported"* — a warning easy to dismiss,
but a real defect: our material and the globe's renderer would come from
different module instances, so `instanceof` checks fail and custom materials
and raycasting silently stop working.

Deduping alone then broke the build, because `three-render-objects` imports
`Timer`, which does not exist in the older `three` we had pinned. The two
constraints together mean the version is not free: it is whatever globe.gl's
dependency tree requires.

**Worth knowing for the report:** neither the unit tests nor the type checker
could have caught this. Both passed throughout. It took starting the server and
reading the console.

---

## D32 — Marker positions are verified against globe.gl's own conversion

**Decision:** `latLonToVector3` duplicates three-globe's coordinate convention
rather than calling `globe.getCoords()`, because the material and marker layers
are constructed before the globe is laid out.

Duplicating a convention is a risk — an inverted axis puts every marker in the
wrong place and the display still looks entirely plausible, just wrong. So the
duplication is checked directly against `world.getCoords()` for the same
lat/lon, and the two agree to zero floating-point difference.

The same check disproved an assumption in the first draft: markers were being
attached to a "globe group" on the theory that they had to rotate with the
planet. There is no such group, and every object in globe.gl's scene has zero
rotation — it orbits the camera rather than turning the Earth. The comment
explaining the wrong reason has been replaced with one stating the verified
fact.

---

## D33 — The client stops extrapolating after ten minutes

**Decision:** dead reckoning is capped. Past ten minutes without an update a
marker holds its last known position instead of continuing to fly.

An aircraft unheard-of for ten minutes has not necessarily flown 150 km in a
straight line — it may have turned, landed, or dropped out of coverage.
Continuing to move the marker confidently would be **inventing data**, and the
invention would be invisible: a smoothly moving marker looks more trustworthy
than a stationary one, not less.

Held position plus a visible age is honest. The marker is also muted after two
minutes and the detail panel states when the position was last reported, so a
stale object cannot be mistaken for live traffic.

This is the client-side counterpart of the backend's decision to keep serving
last-known positions rather than deleting them (D10). Both follow the same
rule: an empty or invented display is worse than an old one that says so.

---

## D34 — Click tolerance is measured in screen pixels, not world units

**The bug.** Clicking a marker did nothing. Search worked, so selection and the
detail panel were fine; only pointer input on the globe failed.

**The cause.** `pick()` set the raycaster's Points threshold to a fixed
fraction of the globe radius — 1.2 world units. A world-space constant is a
*shrinking* screen-space tolerance as the camera pulls back:

| Camera distance | Effective click tolerance |
|---|---|
| 320 (default zoom) | ~4 px, on a ~4 px marker |
| 750 (zoomed out) | ~1 px |

So the user had to click within four pixels of the centre of a four-pixel dot
that was also moving. At wider zoom it was unhittable. Not "sometimes fiddly" —
effectively dead.

**The fix.** Derive the threshold from a pixel radius using the camera distance
and field of view, so the target is the same physical size on screen at every
zoom. `PICK_RADIUS_PX = 12`, measured hit radius ~15 px at default zoom.

Two things had to come with it:

- **A horizon test.** The raycaster does not know the planet is there, so a
  generous tolerance would happily select an aircraft over Australia while the
  user clicked one over Spain. Markers on the far side are rejected with
  `P · C >= r²`.
- **Nearest to the cursor, not nearest along the ray.** With a 12-pixel
  tolerance several markers can qualify; the one the user aimed at is the one
  closest to where they clicked.

An explicit `boundingSphere` was also set on the geometry. Three computes one
lazily otherwise, from a buffer whose unused capacity is still `(0, 0, 0)`, and
never recomputes it as markers move — a latent bug that had not bitten yet.

### Why every test passed

This is the part worth remembering. The M4 verification computed a marker's
projected screen position and called `pick()` at exactly that point. That
proved the raycast maths and **nothing else** — not the listener wiring, not
event bubbling, not the coordinate conversion, and critically not the tolerance,
because a pixel-perfect click needs no tolerance at all.

A test that only ever hits dead centre cannot discover that the target is too
small. The shortcut that made the test easy to write is exactly what made it
blind.

**The regression tests now go through the real DOM event path**
(`pointer.test.ts`): constructed pointer events dispatched on a canvas nested
inside the container, relying on real bubbling and a real bounding rect, with
`pick` injected so no WebGL context is needed. Tolerance is pinned separately
in `markers.test.ts`, including an assertion that reproduces the old
world-unit behaviour and shows it collapsing.

**Ruled out along the way**, since each was a plausible cause: no overlay
swallows pointer events (`elementFromPoint` at the canvas centre returns the
canvas; the header is `pointer-events: none` with `auto` only on its controls);
events do reach the handler through two levels of bubbling; coordinates were
already converted against the element rect rather than the window; and the
three.js dedupe from D31 holds at runtime, with no duplicate-instance warning
and a raycaster that successfully intersects the points geometry.

---

## D35 — Optimize only what was measured, and record what was left alone

**Decision:** two backend hot paths were rewritten after profiling; two
plausible-looking candidates were measured and deliberately left alone.

The benchmark (`benchmarks/bench_backend.py`) is committed so these numbers are
reproducible rather than anecdotal. At 10,000 objects — roughly what OpenSky
reports globally:

| Operation | Before | After |
|---|---|---|
| Poll apply (steady state) | 31.7 ms | 7.4 ms |
| Thin to 2,000 | 19.8 ms | 9.1 ms |

Both matter for the same reason: the backend is a **single-threaded event
loop**, so a slow synchronous call delays every other request *and* the poller.

**Track samples are tuples, not models.** History is written for every object
on every poll — ten thousand at a time — and read only for the one object whose
detail panel is open, at most fifty points. Building a validated Pydantic
`TrackPoint` on the write path spent ~30 ms per poll validating data that came
from an already-validated record. Samples are now plain `NamedTuple`s converted
lazily in `get_detail`.

**Eviction runs on a schedule, not every poll.** A full scan with a datetime
subtraction per object cost ~10 ms of every apply. The object TTL is half an
hour, so sweeping once a minute is invisible in behaviour and removes the cost
from the poll path.

**The thinning loop is flat.** `cell_of` and `rank_key` still exist and are
still tested, but calling them per record made Python's function-call overhead
the dominant cost. The loop now computes the same values inline with the
per-record constants hoisted out.

### Left alone on purpose

- **Per-frame array allocation in the render loop.** `Array.from(map.values())`
  looked like an obvious target. Measured: 0.005 ms, **1% of the tick**.
  Rewriting it would have been change without benefit.
- **The linear bounding-box scan.** 3.2 ms at 10,000 objects. A spatial index
  would be real complexity to justify against a measurement that does not
  demand it (D11).

Recording the rejections matters as much as the changes: it is the difference
between a performance pass and a round of speculative rewriting.

---

## D36 — Tier 2 was unreachable, and the fix was at both ends

**The bug.** The viewport polling tier could never fire at any zoom level the
user could reach. On a server that had been running for an hour, `/api/health`
reported the viewport job as **64 skipped polls and 0 successful ones**.

**The cause was a mismatch between two numbers set independently**, in
different layers, months apart in reasoning:

- The backend skipped the focus poll when the viewport exceeded 400 sq deg,
  on the argument that tier 1 already covers a zoomed-out view (D27).
- The frontend camera's `minDistance` was `globeRadius * 1.05`, chosen as a
  cautious "do not fly into the planet" guard.

At that closest approach the visible cap is 17.8° and the bounding box spans
**1,261 sq deg** — three times the engage threshold. The two constraints made
the feature dead code, and nothing detected it because each number is defensible
on its own.

| Camera altitude | Cap radius | Viewport area | Tier 2? |
|---|---|---|---|
| 2.2 (default) | 71.8° | 20,615 | no |
| 0.05 (old minimum) | 17.8° | 1,261 | no |
| 0.02 | 11.4° | 517 | no |
| 0.01 | 8.1° | 260 | **yes** |

**The fix, at both ends:**

- `minDistance` lowered to `globeRadius * 1.005`. The old guard was arbitrary,
  and being able to zoom to a regional view is what a flight tracker is for.
- The focus box now trims to **100 sq deg (2 credits) polled every 90 s**,
  rather than 25 sq deg (1 credit) every 45 s. **Identical daily cost — 1,920
  credits — for four times the area.** At the shallowest engaging zoom that is
  the difference between refreshing a quarter of the screen and a twentieth of
  it. The budget projection is unchanged at 3,072 credits/day, and a test
  asserts the two configurations cost the same.

**Verified end to end**, not just in unit tests: on the old build the viewport
job skipped every cycle; on the new build, with a zoomed-in bounding box being
sent, it completed a real poll within 90 seconds.

### The lesson worth defending

Every individual test passed, because each number was correct in isolation. The
defect lived in the *relationship* between a backend threshold and a frontend
camera limit — the kind of thing unit tests structurally cannot see. It was
found by asking "does this feature actually run?" and checking the counter,
which is now step 14 of the manual test script.

---

## D37 — Satellite tracking is out of scope

**Decision:** satellites are **not being built**. Not deferred, not scheduled —
removed from the plan. Nothing in this repository is groundwork for them, and
no document should describe them as upcoming work.

This reverses the original two-phase plan. It is recorded rather than quietly
applied because the earlier phasing shaped real decisions, and anyone reading
D4, D6, D8 or D19 will find them arguing partly from a future that is no longer
coming.

**What stays, and why it stands on its own:**

- **The `type` field.** A discriminator carried from the start costs one enum
  with one value. Retrofitting one into a contract spanning three layers, a
  serialized wire format and a TypeScript mirror is a migration. It exists
  because the shape is deliberately source-agnostic (D4).
- **The provider registry.** This *is* the pluggability requirement: swapping
  OpenSky for adsb.fi or airplanes.live by config. It is also what makes the
  fixture provider possible, and the fixture provider is what lets the whole
  project run offline with no credentials (D8).

Neither is scaffolding. Both would be in the design if satellites had never
been mentioned.

**What changes:** the tripwire tests
(`test_no_satellite_provider_exists_yet`, `test_no_satellite_endpoint_exists_yet`,
and the frontend's single-layer assertion) were written to be deleted at a
phase 2 sign-off. They are now **permanent guards against undeclared scope
growth**. Adding satellite tracking requires an explicit decision to change
direction, and these tests are what force that decision to be made
deliberately rather than drifted into.

Work from here deepens the aircraft globe: robustness, accuracy, and
documentation of what already exists.

---

## D38 — Compression and logging: two features that existed but did nothing

**Decision:** enable `GZipMiddleware`, and configure a handler for the `app.*`
loggers.

Both were found by the live verification run, not by any test.

**Compression.** Responses were uncompressed. A thinned 2,000-object payload is
328 KB of extremely repetitive JSON — the same nine keys two thousand times —
which gzips to 67 KB, **20% of the original**. At a ten-second client poll that
is 1.9 MB/min against 0.39 MB/min. One line of middleware, measured before and
after.

**Logging.** Every `logger.info` in the poller and the provider was being
created and discarded. Python attaches no handler to the root logger by
default, and uvicorn configures only its own `uvicorn.*` loggers, so records
from `app.*` went nowhere. The calls were all correct; nothing was listening.

That made **D23 true only on paper**. It requires the remaining credit balance
to be *logged*; the balance was read from the header and surfaced on
`/api/health`, but the log line did not exist in practice. The same applied to
poll results, token acquisition, and backoff warnings — the entire diagnostic
story for the failure modes hardest to reproduce.

### Why the test suite could not have caught either

Nothing asserted on response encoding, and nothing asserted on log output. Both
gaps are now closed by `test_app_surface.py`: compression is asserted at the
header level and by measured ratio, and each log line D23 depends on is
asserted by content — including a test that **no log line ever carries the
client secret or the access token**.

This is the fourth defect in this project that every test passed while the
feature did nothing (see the test plan's defect table). The pattern is
consistent: they are all cases where the code was correct and the *wiring* was
absent. Unit tests verify code. Only running the system verifies wiring.

---

## D39 — What can and cannot be verified against a live quota-metered API

**Decision:** verify token refresh and the throttle ladder against the live
OpenSky API. **Do not** verify 429 handling by exhausting the daily allowance.

The three failure paths were mock-tested only, which is the weakest place for a
test to be: failure paths are exactly where a mock's assumptions are least
likely to match reality. So each was pushed as far as it could honestly go.

**Token refresh — fully verified.** Three checks of increasing strength: a
forced refresh proving the real endpoint issues a second token that works; a
manipulated-deadline check proving the *decision* logic reuses inside the
window and refreshes past it, against the live provider; and a natural run past
the real 29-minute deadline proving the two work together unattended.

**The throttle ladder — verified honestly, without waste.** The credit balance
is real, read from the live `X-Rate-Limit-Remaining` header. Only the
*allowance* it is measured against is varied, which walks the genuine balance
through every band — normal, reduced, minimal, critical, exhausted — without
spending a single extra credit to get there. The poller was then observed
*acting* on each level: lengthening its tier 1 interval from 300 s to 1303 s at
minimal, skipping the latency tier, and finally refusing to poll at all.

**HTTP 429 — deliberately not verified.** A bounded burst test established that
**OpenSky does not rate-limit short bursts**: 25 requests in 6 seconds
(4.2 req/s) drew no 429 at all. The 429 path is therefore reachable only by
exhausting the daily credit allowance — which costs the entire day's quota and
locks the account out until reset, blocking every other task and any demo that
day.

That is a bad trade for observing one code path, so it stays mock-tested. This
is a limitation to state plainly rather than paper over: **the one failure path
we cannot afford to trigger is the one most likely to occur in practice**, since
quota exhaustion is the expected failure mode (D7). What mitigates it is that
the handler is small and its inputs are simple — a status code and one header —
and both are asserted in `test_opensky.py`.

The burst result is itself worth recording: it means a runaway poll loop would
not be stopped by upstream rate limiting. It would simply spend the day's
credits. The budget validation at startup (D22) and the throttle ladder (D23)
are the only things standing between a bad interval and a lost day.

---

## D40 — Aircraft silhouettes in one draw call, and world-anchored sizing

**Decision:** markers are plan-view airliner silhouettes rotated to their
direction of travel, still drawn as a single `THREE.Points` — and their size is
anchored to the ground rather than to the screen.

### Rotation without extra draw calls

Point sprites are always screen-aligned, so the sprite itself cannot be
rotated. Instead the **texture lookup** is rotated inside the fragment shader,
which keeps the whole layer in one draw call (D15). Per-aircraft rotation rides
along as a vertex attribute.

The genuinely hard part is not the rotation but working out *what angle to
rotate to*. `heading` is a compass bearing on the globe surface; the sprite
lives in screen space. The vertex shader therefore builds the heading as a
world vector from the local north/east tangent frame, projects both the
aircraft and a point slightly along that vector into clip space, and takes the
angle between them on screen.

Clip space spans [-1, 1] on both axes regardless of viewport shape, so the
x component must be scaled by the aspect ratio. Without that correction every
aircraft flies slightly sideways on a non-square canvas — cardinal headings
stay correct and only diagonals are wrong, which is exactly the kind of error
that survives a casual look.

### Sizing: world-anchored, clamped in pixels

`gl_PointSize` is in device pixels, so a constant value is a constant *screen*
size — a dot map that looks identical at every zoom. Dividing a world size by
the view distance gives the opposite: a marker pinned to the ground that grows
as the camera descends, so close zoom reads as terrain with aircraft over it.

Calibrated rather than guessed. At 0.04 R, across the camera range the orbit
controls allow:

| camera distance | sprite |
|---|---|
| 800 (fully out) | 4 px, raised to the 5 px floor |
| 320 (default) | 10 px — the silhouette becomes readable |
| 200 | 15 px |
| 100.5 (closest) | 31 px |

An earlier 0.02 R was wrong: it fell below the floor almost immediately past
the default zoom, so most of the range was fixed-size and the scaling did
nothing. The 44 px ceiling is a guard the camera never reaches — it exists so a
future change to `minDistance` cannot silently produce sprites that swamp the
terrain.

Both clamps are in CSS pixels and scale by device pixel ratio, since
`gl_PointSize` is in device pixels. The GPU's own `ALIASED_POINT_SIZE_RANGE`
was checked before committing to this: 1–1024 here, so the ceiling has ample
headroom, but it is low enough on some hardware to be worth knowing.

### Unknown heading draws a disc

Roughly one aircraft in a thousand reports no heading. A silhouette must not be
drawn for those: a shape pointing somewhere is a claim, and we do not have the
data to make it. They get a solid disc instead — a shape with no direction,
which is precisely the message. Both shapes and the altitude ramp are declared
in an on-screen legend, because a colour encoding nobody can decode reads as
decoration rather than data.

### Two bugs found by measuring rather than looking

**The sprite was drawn backwards.** `THREE.CanvasTexture` inherits
`flipY = true`, which flips the canvas on upload and put texture v=0 at the
canvas *bottom* — so every aircraft flew tail-first. This is invisible to
inspection: the markers rotate correctly, respond to heading correctly, and are
simply all reversed. It was caught by rendering to an offscreen target,
reading the pixels back, and comparing the silhouette's alpha centroid against
the expected nose direction. Fifteen cases now check that, from the equator to
85°N and across every heading quadrant.

**The first frame drew the whole buffer.** A `BufferGeometry`'s default draw
range is everything allocated, so any render occurring before the first
`update()` painted four thousand markers stacked at the globe's centre. The
animation loop and globe.gl's render loop are independent, so that ordering was
never guaranteed. The geometry now starts with an empty draw range.

### Performance

Adding rotation, sprite selection and per-marker sizing meant writing six
attributes per marker per frame instead of three, which measured **1.05 ms at
2,000 markers against the 0.82 ms dot baseline — a 28% regression**.

Only *position* actually changes every frame. Colour, heading, sprite cell,
size and the stale flag change once per poll, on selection, or when an object
crosses the staleness threshold. Splitting the attributes by how often they
genuinely change brings the steady state to **0.79 ms — 4% faster than the
plain dots** while drawing considerably more. The worst case, where every frame
forces a full style rewrite, is 1.07 ms and does not occur in practice.

### Hit tolerance re-verified across the full zoom range

D34 was exactly this class of bug, so the pick tolerance was re-measured after
the change. It is now the larger of the fixed 12 px radius and half the drawn
sprite, so a sprite bigger than the tolerance can never have an unclickable
margin:

| camera distance | sprite | measured hit radius |
|---|---|---|
| 800 | 5 px | 13 px |
| 500 | 6 px | 15 px |
| 320 | 10 px | 17 px |
| 200 | 15 px | 24 px |
| 140 | 22 px | 43 px |
| 100 | 31 px | ≥60 px |

Never below 13 px, never smaller than the sprite, no dead zones.

---

## D41 — The globe was lit in the wrong coordinate frame

**The defect.** The globe rendered as night at every rotation. There was no lit
hemisphere at all, and both poles were dark simultaneously — physically
impossible, since one pole is always tilted toward the sun. The only bright
area was a soft patch that stayed fixed relative to the camera however the
globe was turned.

**The cause**, one line in `frontend/src/globe/earth.ts`:

| Where | What it was |
|---|---|
| Globe vertex shader | `vNormal = normalize(normalMatrix * normal)` — a **view-space** normal |
| `setSunFromDate` | `sunDirection` from lat/lon — a **world-space** vector |
| Globe fragment shader | `lambert = dot(perturbed, sunDirection)` — one of each |

`normalMatrix` is three.js's *view*-space normal matrix. Dotting its output
against a world-space sun direction produces a lit region that tracks the
camera, which is exactly what was observed: not a terminator in the wrong
place, but a terminator that was not on the planet at all.

**The fix** is to derive the normal in world space, as the atmosphere shader in
the same file always did:

```glsl
vWorldNormal = normalize(mat3(modelMatrix) * normal);
```

The atmosphere is the reason this is a correction rather than a redesign: it
computes its sun term correctly a few dozen lines below, so the right answer
was already in the file. `modelMatrix` rather than the raw `normal` matters
more than it looks — three-globe's globe mesh carries a −90° rotation about Y,
so using the local normal would have been correct in *form* and wrong by a
quarter turn in longitude.

Two further consequences of the same mismatch came with it:

- **The bump map's tangent frame.** It derives east and north from
  `up = (0, 1, 0)`, which is the polar axis in world space and an arbitrary
  direction in view space. Terrain relief was being lit from a direction that
  swung with the camera.
- **The specular highlight.** Blinn-Phong halves the sun direction with the
  view direction, so the view direction had to move to world space too:
  `normalize(cameraPosition - vWorldPosition)`.

### It was never right

This is not a regression from the directional-marker work. It has been wrong
since M4, and it looked plausible then for a specific reason: at the default
camera position the camera-locked lit patch happens to face the viewer, so the
globe appeared lit from the front. M4 verified that `sunDirection` was a unit
vector and that all four textures loaded. It never verified that the
terminator was in the *right place*, and a wrongly-lit planet is still a lit
planet.

That is the same shape as D34 and D40: a check that confirms the ingredients
and never confirms the result.

### What the regression tests can and cannot do

There is no GL context under vitest, so the terminator cannot be checked by
rendering there. The suite covers the two halves that are checkable:

- **Where the light should fall**, on the CPU. For a sphere the outward
  world-space normal at a surface point is the unit vector to that point, so
  the shader's `lambert` term is computable without a renderer. Half the
  planet is lit at every sampled instant, the poles are opposed, the terminator
  passes a quarter turn from the subsolar point, and the summer pole is lit for
  a full rotation at the solstice.
- **That the shader consumes that frame**, by reading the shader source:
  `normalMatrix` may not appear in the globe shaders at all, the sun must be
  dotted against `vWorldNormal`, no view-space varying may reach the lighting,
  and the globe must derive its sun-facing normal exactly as the atmosphere
  does.

**Worth being honest about which half caught it.** Run against the old shader,
the nineteen geometry tests all pass — they describe the astronomy, which was
never wrong — and only the five source-level assertions fail. The geometry
tests are not what would have caught this defect; they are what stops the
terminator drifting later. The source assertions are the regression.

The assembled pipeline is covered instead by a committed pixel probe (§12 of
the test plan), which renders the real scene through a real GL context and
measures the light. That division is deliberate and is the same one D40 used.

### Three ways the measurement lied first

The probe is more code than the fix, and nearly all of it is defence against
confounds that each produced a confident wrong answer:

- **The atmosphere shell.** Measured with the halo visible, every reading is a
  reading of the halo, which covers the planet completely — and it reads
  *inverted*, because the back face of a back-side shell faces away from the
  sun. The first probe run reported the sunward hemisphere as dark, which was
  true of the atmosphere and false of the Earth.
- **The build-in animation.** three-globe scales the globe from 1e-6 up to 1
  over 600 ms, driven by `requestAnimationFrame`. In a hidden or background tab
  rAF never fires, so the planet stays microscopic and the frame contains no
  Earth at all — while every object in the scene still reports
  `visible: true`. The probe now refuses to measure until the globe is really
  there and really in frame.
- **Texture mistaken for light.** Sunlit deep ocean is *darker* in linear light
  than the night texture's dim blue over the same water, so a per-texel
  day-against-night comparison reports the night side as brighter over any
  ocean. Real, reproducible, and nothing to do with the terminator. The
  measurements that survive are aggregates over hundreds of samples, where the
  light dominates.

Keeping the visual layers separable (D16) is what made the first of those
fixable in one line, which is a second use for that decision beyond attributing
frame cost.

---

## D42 — The selected aircraft becomes a real mesh; everything else stays a sprite

**Decision:** when an object is selected, hide its sprite in the marker layer
and draw one low-poly 3D airframe in its place, oriented by heading, built
procedurally in code rather than loaded from a model file.

*Alternatives:* meshes for every aircraft; a glTF model loaded at startup;
per-type models chosen by aircraft category; leaving the selected marker as an
enlarged sprite.

**Meshes for everything is the thing D15 exists to prevent.** Two thousand
markers are one draw call precisely because they are points in a single
buffer; two thousand meshes are two thousand draw calls, and the frame rate
that was measured and defended goes away. The mesh is affordable only because
there is exactly one of it — the budget for this feature is one extra draw
call, which is why it is one `THREE.Mesh` with one merged geometry and one
material rather than a `Group` of eight parts.

**The model is generated, not loaded.** A glTF pipeline for a single generic
airframe buys nothing and costs an async load to sequence, a binary asset in
the repository, a licence to track, and a new failure mode where the user
clicks before the model has arrived. The sprite atlas was generated for exactly
these reasons (D30) and the same reasoning applies unchanged. Around 200
triangles from cylinders and boxes: fuselage, nose, tail cone, wings,
tailplane, fin, two engines. A loader earns its place the day per-type models
do, and not before.

**An aircraft with no heading keeps its disc.** A mesh is an oriented object,
so drawing one commits to a direction on screen, and for a null heading there
is no direction to commit to. Pointing it north would be a confident wrong
answer of the kind the contract's `null`-is-not-zero rule exists to prevent
(D18), and the atlas already carries a directionless disc for this case (D40).
So no model appears and the sprite stands.

### Two places it deliberately departs from the sprite

**Altitude.** The task described the model as sitting above the surface at its
altitude. Taken literally that is wrong here: 12 km is 0.19 world units on a
100-unit globe, six times *smaller* than the 1.2-unit legibility shell the
markers already float on (MARKER_ALTITUDE), so a literal altitude would drop
the model below the sprite it replaces, into the surface texture, and make it
visibly jump at the instant of selection. The model therefore sits on the same
shell as the sprite, and altitude stays encoded as colour exactly as D28 chose.
Height above a sphere at this scale is not a channel that can carry altitude,
which is what MARKER_ALTITUDE said in the first place.

**Lighting.** The mesh is lit by a fixed key light in **view space** — a
headlight that follows the camera. That is precisely the coordinate-frame
mistake D41 spent a session removing from the globe shader, so the difference
is worth stating: the globe is a world object whose lighting *is* the
information, because it shows where the sun is, while this is a selection
indicator whose job is to remain legible. Lit by the real sun, an aircraft
selected over the night side would be a black mesh on a black ocean and the
click would look like it had failed.

### What is tested, and what a test cannot reach

Thirty-eight tests, and the load-bearing one asserts that the mesh's tangent
frame agrees with the marker vertex shader's, by transcribing the GLSL into
TypeScript rather than importing a shared helper — a shared helper would make
the test pass by construction. If the two frames ever drift, a selected
aircraft snaps to a different heading the moment it is clicked, and inspecting
either one alone would show nothing wrong. That failure mode is this project's
most frequent (D34, D40, D41): two pieces of code each correct in isolation and
meaningless together.

Also pinned: a heading of exactly zero still draws (the falsy-check bug that
would silently refuse every aircraft flying due north), the basis is a rotation
rather than a reflection (a mirrored airframe is entirely plausible and
entirely wrong — the same trap as the atlas's `flipY` in D40), the tallest
vertex lies aft of centre so the model cannot be authored nose-backwards, and
the model is placed exactly where the sprite would have been.

> **Corrected by [D43](#d43--the-model-was-sized-against-the-wrong-distance).**
> The paragraph below concluded the ceiling was dead code. It was dead, but not
> for the reason given: the sizing measured to the globe's centre rather than to
> the model, so the clamp evaluated against a distance an order of magnitude too
> large and could never bind. The model grew without limit on approach.

**The sizing ceiling is dead code, deliberately.** Across the camera range the
orbit controls permit, the model runs from 16 px fully zoomed out — where the
floor engages — to about 55 px on the closest approach, so `MODEL_MAX_PX` never
binds. It is kept as a rail and the tests say both things: that it does not
engage anywhere reachable, and that it does clamp if the camera is ever allowed
closer. This is also where the model and sprite part company on purpose: a
selected *sprite* is clamped to 44 px because a flat silhouette that large
swamps the terrain, while a mesh at 55 px reads as an aircraft above it.

**Not yet verified by eye.** The unit tests and a console check against the
running bundle confirm placement, orientation, scale and the sprite handoff,
but nobody has looked at the model on the globe. By this project's own record
that is the check that finds the defect (D34, D40, D41 were all invisible to a
green suite), so it remains outstanding rather than assumed.

---

## D43 — The model was sized against the wrong distance

**Two defects, one root cause**, both found by rendering the selected model
offscreen and measuring its wingspan in pixels — neither was visible to the 38
tests that shipped with D42, all of which passed throughout.

### The model grew without limit on approach

`modelSpanWorld` clamps the model to between 16 and 96 screen pixels. The clamp
never engaged, because the call site passed `camera.position.length()` — the
distance from the camera to the **globe's centre** — where the function needed
the distance from the camera to the **model**.

Those two are interchangeable while the camera is far away and wildly different
as it approaches: the model sits on a shell at 1.012 R, so a camera at 1.05 R is
3.8 units from the model and 105 units from the centre. The clamp, evaluating
against the larger number, concluded the model was small and left it alone.

Measured at a 300 px viewport, before and after:

| Camera distance | Before | After |
|---|---|---|
| 320 (default) | 24 px | 16 px |
| 180 | 36 px | 30 px |
| 140 | 60 px | 60 px |
| 120 | **124 px** | **96 px** |
| 105 | **300 px, clipping the viewport** | — |
| 101.4 (closest reachable) | **0 px** | **96 px** |

The sprite layer never had this bug: `gl_PointSize` divides by
`-viewPosition.z`, which *is* the true view depth. The mesh reimplemented the
same idea in TypeScript and reached for the wrong quantity.

### The camera could fly inside the marker shell

The second column explains the `0 px` above. Markers and the model sit on a
shell at `1 + MARKER_ALTITUDE` = 1.012 R, while the orbit controls allowed the
camera down to 1.005 R (D36). Between those two figures the camera is **inside
the shell**, so anything directly beneath it is behind the near plane and is
not drawn — at exactly the moment the user has zoomed all the way in.

**This one is not task 3's fault.** It affects sprites identically and has been
latent since D36 lowered `minDistance`; the model merely made it obvious,
because one missing aircraft is invisible and one missing *selection* is not.

`minDistance` is now derived from the shell itself —
`globeRadius * (1 + MARKER_ALTITUDE) * 1.002` — rather than being an
independent constant that happened to sit below it. Two numbers with a required
relationship should not be written down twice, which is the same lesson as D36,
where a backend threshold and a frontend camera limit were each correct alone
and jointly made a feature unreachable.

The tier 2 constraint that motivated D36 still holds: at 1.014 R the visible cap
is about 9.5°, some 363 square degrees, comfortably under the 400 the backend
requires before it will spend a credit on a viewport poll. A test asserts that,
so the two constraints cannot silently drift apart again.

### Why the existing tests missed it

D42's suite tested `modelSpanWorld` with the distance the test itself chose, and
tested that `update()` scaled the mesh *smaller* when the camera moved closer —
which it did, because the shrinking world span still grew on screen. Nothing
converted the result back into pixels, and nothing exercised the call site with
a camera positioned relative to the model.

Twelve tests now do. They pin the ceiling and floor in **screen pixels** across
the reachable camera range, drive `update()` with a camera placed on the ray
through the aircraft, and include one test that reproduces the defect by
deliberately passing the centre distance — so the distinction cannot be quietly
undone.

This is the project's recurring shape once more, and worth naming precisely: not
a wrong formula, but a **correct formula fed the wrong argument**, where every
individual function was right and the composition was not.

---

## D44 — Geography data is reduced at build time, and borders are drawn as arcs

**Decision:** country boundaries, city names and airports come from datasets
that arrive with `npm install`, are reduced to two small static files by
`scripts/build-geography.mjs`, and are served from `public/geo/`. Borders are
drawn as one `THREE.LineSegments` built from TopoJSON *arcs*, densified in
lon/lat and lifted onto a shell just above the surface.

*Alternatives:* fetching Natural Earth or OurAirports from a CDN at runtime;
committing the reduced files; using globe.gl's built-in `polygonsData` layer;
drawing per-country rings; interpolating borders along great circles.

**Where the data comes from, and why not over the network.** A CDN fetch is a
third-party dependency at runtime for data that has not changed since it was
published: it breaks the offline guarantee the textures already earn (D30), and
it adds a failure mode on every page load. So the same bargain as the textures
applies — `world-atlas` (Natural Earth), `all-the-cities` (GeoNames) and
`@nwpr/airport-codes` (OurAirports) are dev dependencies, the reduction runs
before dev and build, and `public/geo/` is gitignored. 117 KB of borders and
141 KB of labels, generated in about 5 seconds, and no API credit anywhere.

**Arcs, not rings.** TopoJSON stores a boundary shared by two countries exactly
once and has each country's rings reference it by index. Expanding to rings
would draw the France/Germany border twice and every coastline once per country
touching it. Emitting the 595 arcs directly is both fewer vertices and, because
the line is translucent, the difference between a uniform hairline and one that
doubles in brightness along every internal border.

**Densified in lon/lat, not along great circles.** This is the one place where
copying the route layer would have been wrong. `route.ts` interpolates along
great circles because an aircraft between two observed points flew one. A
border did not: the Canada/United States boundary west of the Lake of the Woods
is the 49th parallel, stored as two points about 2,000 km apart, and a
great-circle interpolation between them bows off the parallel by more than 0.1
degrees — over 12 km inside Canada. Linear interpolation in lon/lat holds the
parallel, which is what the boundary is. The test asserts both halves: that
every subdivided vertex stays at latitude 49, and that a transcribed great
circle would not.

**Lifted onto a shell.** A chord between two points one degree apart sinks
3.8e-5 radii below the sphere, and a line drawn at exactly the globe radius
z-fights with the texture regardless. `BORDER_ALTITUDE` is 0.0008 radii —
twenty times the worst sag, a fifteenth of `MARKER_ALTITUDE` — so borders clear
the planet and aircraft still draw over them. The step size and the shell
height are a pair, and a test ties them together: no segment midpoint may fall
inside the globe.

**110m, not 50m or 10m.** 8,246 source points become 20,082 vertices after
densification, 235 KB of positions in one draw call. 50m is ten times that and
10m fifty-eight times, for detail that sits under a fixed-resolution colour
texture — a sharper border over a soft coast reads worse, not better. The
resolution is one constant in the build script, and a test caps the vertex
count so a change cannot pass unnoticed.

**Not globe.gl's polygon layer.** `polygonsData` builds extruded meshes per
feature with its own materials and its own update path; we want a hairline, one
buffer, and a cost we can attribute (D16). One `LineSegments` is that.

### The airport ranking, and what it cannot do

Airports come with no traffic figure and no size class in any offline dataset
we could find, so they are ranked by the population of the largest city within
60 km — a real number measuring something related, rather than an invented one
(D6 is the same rule). Within one metropolitan area that measure is flat:
Heathrow, Gatwick, Biggin Hill and Farnborough all serve London and all score
7.5 million. A second real signal breaks that tie — OpenFlights records the
city each airport is filed under, and Heathrow, Gatwick and Biggin Hill are
filed as London while Farnborough is filed as Farnborough — which lifts the
London airports above the airfields around them but cannot separate Heathrow
from Biggin Hill. Nothing in this data can. The label layer answers that by
capping how many airports it will draw at once (D45) rather than pretending to
a ranking it does not have.

### Country label anchors

`geoCentroid` of a whole country is wrong often enough to matter: the United
States' lands in the Pacific, pulled there by Alaska and Hawaii. The anchor is
therefore the centroid of the country's largest polygon, and where that still
falls outside it — the crescent problem, Croatia and Indonesia both — a grid
search picks the interior point furthest from the boundary. This runs 177 times
at build time, so a crude search costs nothing, and a test pins the United
States case specifically.

---

## D45 — Labels are DOM, and density is the feature

**Decision:** geography labels are pooled absolutely positioned elements in an
overlay above the canvas, written directly from the animation loop, with what
is shown decided by camera altitude, a hard cap of 40 labels, greedy collision
rejection, and a separate cap of 8 on airports.

*Alternatives:* one canvas texture per label; a signed distance field font
atlas; globe.gl's `htmlElementsData` layer; React components; showing every
candidate in view.

**Text is the one thing the one-draw-call rule does not fit.** Every other
layer in this project is a single buffer because that is what keeps two
thousand aircraft affordable (D15). Glyphs in WebGL are either a texture per
string — one draw call each, the exact trap D15 exists to avoid — or an SDF
atlas, which is a font pipeline, a packer and a shader for something the
browser already does better at any device pixel ratio. Forty pooled spans cost
one transform write each per frame, restyle from CSS, and stay crisp on a
high-DPI display. The cost is bounded by the cap, not by how many labels happen
to be in view.

**React is kept out, exactly as it is for the markers (D3).** The elements are
created once, hidden and rewritten in place; nothing here goes through the
reconciler.

**Density is the whole design problem.** 1,569 labels exist and 1,422 are
candidates at the closest tier; a layer that drew what was in view would be
unreadable. What is allowed to appear is a function of camera altitude in globe
radii, and the thresholds are a judgement written down rather than buried:
nothing above 3.0, the twelve largest countries from 1.0 to 3.0, thirty
countries and cities above 5 million from 0.35, cities above 1 million from
0.12, and airports only below that. Measured against the real dataset over
central Europe at a 1600x900 viewport: 0, 7, 17, 8, 25, 12, 4 and 0 labels
drawn as the camera comes in from 4.0 radii to 0.014. The count falls at the
end because the view itself is only about 80 km across by then — over a city
rather than over farmland the same altitude draws nine.

**Airports are capped at eight** because their ranking cannot order its own
members (D44). Without it, a London view at 0.1 radii drew 40 labels of which
36 were three-letter codes, pushing out the city and country names above them.
A cap is the honest answer to a ranking we do not have.

**Two clocks, not one.** Positions are rewritten every frame — a label lagging
the globe by a fifth of a second while dragging looks broken — but the decision
about *which* labels to show walks every candidate and runs collision tests,
and that answer does not change meaningfully at 60 Hz. It is recomputed every
200 ms, and the candidate list is cached against the budget that produced it,
since the budget only changes when the camera crosses a tier. That cache took
the selection pass from 0.599 ms to 0.061 ms; a reprojection-only frame costs
0.033 ms.

**Three sphere problems a flat map does not have**, all three tested: a label
can be on the far side, and is hidden by the same `P . C >= r^2` horizon
condition the marker picking uses — written out rather than shared, so the two
cannot drift into false agreement (the D42 rule); it can be behind the camera,
which projection reports as plausible coordinates in the opposite corner unless
the depth sign is checked; and it can be off screen entirely.

**And a fourth, found by running it.** A camera built while its container
reports zero width has an aspect of `0/0`, and every projection through it is
NaN. Every comparison against NaN is false, so NaN satisfied neither bounds
test and passed both, producing a transform of `translate(NaNpx, NaNpx)` —
which browsers reject outright, leaving all forty labels stacked in the
top-left corner. The guard is one line; the lesson is an old one, that a range
test is not a validity test.

### Verified against the running app

The label layer's own projection was checked against globe.gl's
`getScreenCoords` for six country labels in the live page: agreement within one
pixel on both axes, which is the same independent cross-check D32 used for
marker positions. The border layer was verified by offscreen pixel readback —
rendering the real scene with and without the layer — since neither browser
surface composites. Evidence in test plan §14.

---

## D46 — The airline is decoded in the browser, and labelled as decoded

**Decision:** turn a callsign's first three letters into an airline name in the
frontend, using an ICAO designator table generated at build time and fetched on
the first selection of a session. The contract does not change, `meta` does not
change, and the detail panel says the value was decoded.

*Alternatives:* adding `airline` to `TrackedObject`; having the OpenSky
provider put it in `meta`; bundling the table into the JavaScript; shipping
only the airlines OpenFlights marks active; showing the name with no
qualification.

**An airline is not observed, and the contract only carries what is.** OpenSky
reports a callsign. That the first three letters of a callsign are an ICAO
airline designator is a convention — one that airlines follow and that general
aviation, military and government flights do not. `THA932` becoming "Thai
Airways International" is a lookup against a published table, which makes it an
inference about the data rather than data, and this project has spent D6 and
D18 keeping those apart. Destination is refused outright because inferring it
would produce confident wrong answers; the airline decode is admitted because
it is well-defined and checkable — but it is admitted *as* an inference,
labelled in the UI and kept out of the shape every layer speaks.

**Not `meta` either**, which is the closest thing to a loophole. `meta` means
fields the provider actually reported, and it is rendered generically as
key/value rows. Put a derived value in there and no reader of a row can tell
which kind they are looking at, including a future maintainer deciding whether
a field can be trusted.

**And the arithmetic agrees.** A list response carries up to 2,000 objects
every 10 seconds. Airline names average 21 bytes, so a top-level field would
add about 42 KB to every response for something the UI shows one at a time, on
click. The whole table is 148 KB, fetched once, and only if the user selects an
aircraft at all — click nothing and it is never downloaded. That is a better
trade after a single poll.

### The decode rule, and what it refuses

Three letters followed **immediately by a digit**. The digit is the whole rule,
because a flight number always starts with one and a registration's fourth
character does not:

| Callsign | Result | Why |
|---|---|---|
| `THA932`, `UAL1`, `BAW22F` | decoded | designator then flight number |
| `N466WN`, `ZSABC`, `VHXYZ` | refused | no digit in the fourth place — these are registrations |
| `D-ABCD`, `OY-JJU` | refused | a hyphen is never part of a designator, and feeds differ on stripping it |
| `THA`, blank, padding | refused | nothing to decode; OpenSky pads callsigns to eight characters, so trimming comes first |

**The id guard is the subtle one.** `label` falls back to the object's id when
upstream sent no callsign, and an ICAO24 address is six hex characters — so
`abc123` matches the decode rule perfectly and would put an airline's name on
an aircraft whose callsign we never received. The decode takes the id as well
and refuses when the two are equal. This is not hypothetical: a third of the
address space begins with three hex letters.

### Every designator, not only the active ones

OpenFlights flags airlines active or not, and filtering to active takes the
table from 5,774 designators and 148 KB to 996 and 23 KB. It is also wrong in a
way that matters: FedEx and UPS are both flagged inactive, and between them
they are a large share of the cargo traffic in any real feed. Saving 125 KB of
a file fetched once and cached by the browser is not worth deleting them. The
flag is still used as a tie-break where one designator has several rows — only
three designators have more than one active row, and two of those are
duplicates of the same airline.

**The table can be stale in the other direction too**, which is why the panel
carries a sentence rather than only a name: designators are occasionally
reassigned, and `TGW` resolves to a defunct Australian carrier where the code
is now flown by another airline. A name shown bare would be a claim; a name
shown with the designator it came from and a note that it was decoded is
evidence the reader can judge. That is the same reasoning as the route caveat
(D6) and the staleness line, and it is why the panel's docstring now lists
three honesty requirements rather than two.

### What this does not do

It does not make airlines searchable — search still matches callsigns, as it
always has. Searching "Lufthansa" and getting every DLH flight would be a
genuinely useful feature and a different one: it needs a reverse index over the
table, a decision about ranking a name match against a callsign match, and a
say in what the result rows show. Not smuggled in under a task about a detail
panel field.

---

## D47 — The list endpoint answers 304, with a weak validator

**Decision:** `GET /api/aircraft` computes a weak ETag from the store's version
counter and the query, answers `304 Not Modified` when the client already holds
that representation, and sends `Cache-Control: no-cache` so browsers
revalidate. The tag is computed **before the store is read**, so a 304 never
builds a response at all. No client code was added; the fix that *was* needed
in the client is at the bottom of this entry, and it is not the one anybody
expected.

*Alternatives:* a strong ETag; `Last-Modified`; caching the serialized body and
re-sending it; a shorter client poll interval negotiated some other way;
leaving it alone.

**The waste is real and it is on the event loop.** The client polls every 10
seconds; tier 1 refreshes every 300 (D21). So twenty-nine polls in thirty ask
for a snapshot that has not changed, and each one filters, thins, validates two
thousand Pydantic models into JSON, gzips the result and writes it — on the
single thread the poller also runs on, which is the same argument D35 used for
thinning. Measured through the real stack at 2,000 objects: **14.01 ms per full
response against 0.60 ms for a 304**, a 95.7% saving, and 29.4 KB of gzipped
body against nothing. Over a thirty-poll cycle that is about 389 ms of event
loop returned to the poller, per client.

**Weak, not strong, and the distinction is the whole design.** Two responses
for one store version are not byte-identical: `ageSeconds` counts up between
them. A strong validator would be a lie, and the honest strong alternative —
hashing the serialized body — costs exactly the serialization the ETag exists
to avoid. A weak validator says the two representations are *semantically
equivalent* (RFC 9110 8.8.1), which is precisely the claim being made, and
`If-None-Match` is defined to use weak comparison anyway (RFC 9110 13.1.2).

**Not `Last-Modified`.** It has one-second resolution, and the store's version
changes on a poll boundary that can fall anywhere. A counter is exact and
already exists.

**Three inputs that are easy to leave out**, each a way of returning 304 when
the answer really has changed:

- **The query.** Two viewports are two representations. Without the bbox and
  the cap in the tag, panning returns 304 and the new region never arrives.
- **Staleness.** `stale` flips on a clock, not on a write. Left out, a backend
  whose upstream has died keeps answering 304 from its frozen version, and the
  client is never told the data went cold — the one moment the envelope has
  something new to say.
- **A per-process token.** The version counter starts at zero on every boot, so
  without it a restarted backend serves version 3 of a *different* dataset
  under a tag the client already holds. Restarts are how the provider gets
  switched, so this is a normal event, not a disaster case.

**The viewport hint is sent before the conditional check**, deliberately. A
client holding still gets 304s and is still looking somewhere; dropping its
viewport hint would let tier 2 go idle over exactly the region under
inspection (D21, D27). A test pins it.

**`no-cache`, not `no-store`.** They read like synonyms and are opposites:
`no-store` forbids keeping the body, so there would be nothing to revalidate
and no 304s at all. `no-cache` means keep it and ask every time — which is what
makes this work through `fetch()` with no client code, because the browser
attaches `If-None-Match` and turns the 304 back into a resolved response before
JavaScript ever sees it. Verified in the running app through the Vite proxy:
15 of 17 polls in one session were 304 at the backend. In devtools they appear
as 200s, because what devtools reports is the cache-resolved response; the
server's access log is where the 304s are visible.

**Search is left alone.** It is user-driven and debounced, its result changes
with the query, and the repetition the ETag exists to remove is not there to
remove. The detail endpoint likewise: it is fetched once per selection, not
polled.

### What running it found: the frozen age

Transparent caching is transparent to the *code* and not to the *meaning*. The
status bar computed the data's age as the backend's `ageSeconds` plus the time
since the response arrived. Both halves were right until the endpoint became
conditional; then a 304 handed the client back its own cached body — whose
`ageSeconds` was measured when it was first fetched — while the arrival time
reset on every poll. **The age froze at a few seconds while the data quietly
went minutes old.** Caught in the running app: the server reported 107.6
seconds and the status bar read "data age 1s".

The fix is to state the same fact in a form that does not go out of date. The
envelope already carries `fetchedAt`, an absolute instant, which is identical
however many times the same body is reused, so the client now measures from
that and no longer reads `ageSeconds` at all. The trade is a dependence on the
two clocks agreeing — wrong by the skew, rather than wrong without bound.

This is worth naming because it is a category, not an incident: **a cache does
not only change performance, it changes what "now" means to every field
computed at send time.** The audit that matters after adding one is not "is the
data right", it is "which fields were true only at the moment they were
written".
