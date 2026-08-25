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
