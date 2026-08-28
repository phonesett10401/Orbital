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

> **Reopened by [D52](#d52--city-mode-a-spike-against-d17-and-what-the-tile-research-found).**
> Phone asked for buildings on zoom, which is exactly what this entry excluded.
> The exclusion stands for *this renderer* — the numbers are in D52 and they
> are not close — so the spike answers the question with a second renderer
> rather than by pretending globe.gl can stream tiles. Whether that becomes a
> migration is still open.

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

---

## D48 — The specular glint, retuned against a measurement rather than by taste

**Decision:** the water highlight's strength drops from 0.6 to **0.35** and its
Blinn-Phong exponent rises from 60 to **400**. Both become uniforms fed from
`config`, alongside `bumpScale`, rather than literals in the GLSL.

*Alternatives:* leaving it; dropping the strength alone; removing the highlight
entirely; a physically-based sun glint model with a wave slope distribution.

**What was wrong, in a number.** The complaint was that the highlight read as a
bug rather than as sun glint — a white blob over whichever ocean faced the sun.
Rendering the real scene offscreen with the specular term on and then off, and
differencing the two frames, says how big and how bright it actually was: **14.8
degrees of arc across, 6.5% of the visible disc, peaking 151/255 above the
unlit-by-specular ocean beneath it.** Fifteen degrees of arc is about 1,600 km.
That is not a glint, it is a weather system.

**The mask was never the problem**, and this is the part worth recording,
because it cost a session before. `earth-water.png` was sampled at ten known
points: ocean reads 255, land reads 0, and the shader multiplies
`specular * water`, so the highlight could not have been on land at all. What
looked like a highlight over Indonesia was the Java, Timor and Arafura seas
around it. The mask is fine; the lobe was enormous.

### The sweep

Camera placed at the subsolar point — the worst case, where the highlight is
largest — at three distances, measuring the difference between a frame with the
term and a frame without it:

| strength | exponent | across | % of disc | peak above ocean |
|---|---|---|---|---|
| **0.60** | **60** | **14.8°** | **6.52%** | **151** |
| 0.28 | 120 | 8.6° | 2.23% | 70 |
| 0.28 | 240 | 5.9° | 1.07% | 69 |
| 0.28 | 320 | 5.0° | 0.76% | 68 |
| **0.35** | **400** | **4.8°** | **0.69%** | **84** |
| 0.45 | 480 | 4.6° | 0.64% | 107 |
| 0.28 | 800 | 3.0° | 0.27% | 64 |

Stable across zoom: at 320, 180 and 140 units the chosen pair measures 4.8°,
4.7° and 4.2°, and nothing clips to white at any distance.

**Why 0.35 and 400 rather than the dimmest option.** The failure was not
"bright", it was "broad and formless". A glint on water is small and *has a
bright core*; a wide dim wash reads as a smudge on the texture, which is the
same complaint in a quieter voice. So the exponent does the work — a tenth of
the old area — and the strength comes down by less than half, keeping a core
that reads as reflected sun. Around 5° of arc is roughly 550 km, which is the
scale sunglint appears at in real full-disc photographs of Earth.

**Not a physical glint model.** A Cox-Munk wave slope distribution is the
correct answer to a question nobody here is asking: it needs surface wind to
mean anything, wind is not in the data, and inventing it would be the same
mistake as inferring a destination from a heading (D6). Blinn-Phong with a
tuned lobe is an admitted approximation.

**Uniforms, not literals**, for the same reason `bumpScale` is config-driven: a
number tuned by eye that can only be changed by editing GLSL is a number nobody
tunes. As uniforms both can be swept from the console against real frames,
which is how the table above was produced, and `VITE_SPECULAR_STRENGTH` and
`VITE_SPECULAR_SHININESS` let the values be changed for a screenshot without a
rebuild.

### Confirmed by the committed probe, not only by the ad-hoc one

`__orbital.probeLighting()` already measures how much each sample point's
brightness changes as the camera moves around it. Diffuse lighting is
view-independent, so any spread there *is* the specular term. Same date, same
points, only the two numbers changed:

| Sample point | Before (0.6 / 60) | After (0.35 / 400) |
|---|---|---|
| 0°N, subsolar meridian | **0.3835** | **0.0675** |
| 0°N, 60° east of it | 0.0797 | **0.0000** |
| 40°N, 40° west of it | 0.2809 | **0.0090** |
| 30°S, 120° east | 0.0036 | 0.0036 |
| 55°N, 170° east | 0 | 0 |
| 0°N, antimeridian | 0 | 0 |

Two points that had no business being view-dependent — 60° and 40° away from
the sun — were carrying 0.08 and 0.28 of spread, which is the blob reaching
them. They now sit at or below the 0.009 floor of the points the highlight
never touched. The subsolar point still moves with the camera, by a fifth of
what it did, and it *should*: that is what a glint is.

**Still not signed off by eye.** The measurement settles size, brightness and
view dependence, and it cannot settle whether the result looks right — the
same limitation recorded for the aircraft model (D42) and the geography layers
(D45). What has changed is that the next person to judge it by eye has two
numbers to turn and a probe that says what turning them did.

> **Amended by [D49](#d49--the-glint-was-still-a-lamp-contrast-was-the-quantity-that-mattered).**
> That sign-off then failed. The values above were rejected on sight, and the
> reason is recorded in D49: every number in this entry improved, and none of
> them measured the highlight against the ocean it sits on, which at 89 against
> 9 was still ten to one. The sweep below remains a correct record of how the
> lobe width behaves; the conclusion that the defect was fixed was not.

---

## D49 — The glint was still a lamp: contrast was the quantity that mattered

**Decision:** the water glint drops again, to strength **0.08** and exponent
**900**, chosen by Phone from a measured shortlist after looking at the globe.
`EarthVisuals.setGlint(strength, shininess)` is added so both terms can be
changed from the console without a rebuild.

*Alternatives:* keeping D48's 0.35 and 400; 0.12 and 1200; removing the
highlight entirely; a textured or two-lobe glint.

**D48 measured the wrong quantity, and passed.** It reported the highlight
shrinking from 18° of arc to 6°, and from 9.6% of the visible disc to 1.2% —
every number better, the camera-invariance spread down by a factor of five, the
suite green. Phone then looked at the globe and it was still a glowing ball.
Two screenshots settled it in a way no number had: a soft white sphere sitting
on an almost black ocean, in two different views, at two different places on
the planet.

**What the numbers had missed is what the light sits on.** Measuring the
highlight in isolation says how big and how bright it is. It never says how
bright it is *relative to the water it is supposed to be reflecting off*. The
Blue Marble ocean at this scale reads about **9/255**. D48's peak was **89** —
ten times the sea beneath it. Nothing that outshines its own surface by an
order of magnitude reads as a reflection; it reads as a light source behind the
planet, which is exactly the phrase the original report used.

Adding the underlying brightness to the probe turns the choice into one line:

| strength | exponent | across | % of disc | peak | peak ÷ ocean under it |
|---|---|---|---|---|---|
| 0.60 | 60 | 18.0° | 9.56% | 153 | **17.5×** |
| 0.35 | 400 | 6.2° | 1.17% | 89 | **9.5×** |
| 0.12 | 1200 | 2.8° | 0.23% | 30 | 3.4× |
| **0.08** | **900** | **2.8°** | **0.24%** | **20** | **2.4×** |

Stable across the zoom range — 2.8°, 2.9°, 2.8° at 320, 180 and 140 units — and
clipping nowhere.

**The verdict was Phone's, from a shortlist.** Three candidates were measured
and offered — subtle, barely-there, and off entirely — and 0.08 with 900 was
chosen after seeing them. That is the right shape for this kind of decision:
the measurement narrows a continuum to a few defensible points, and the person
who can see the screen picks between them.

**`setGlint` exists because of the loop, not the values.** Tuning by eye
against a rebuild is a minute per attempt; against a console call it is
instant, and the person doing the judging does not need the repository open.
This is the same reasoning that made the pair uniforms in D48, carried one step
further.

**Not removed.** Off was a real option and was offered. A sheen that appears
when the sun angle is right is a cue that the surface is water, and at 2.4×
the sea beneath it that is what it now is.

> **Amends [D48](#d48--the-specular-glint-retuned-against-a-measurement-rather-than-by-taste).**
> D48's reasoning about lobe width stands and its sweep is still the record of
> how the exponent behaves. What it got wrong was believing the job was done
> because the numbers improved: it measured the highlight, never the contrast,
> and closed a visual defect without anyone having looked at the result.

### The lesson, stated plainly

**A measurement can be correct, improve, and still be measuring the wrong
thing.** This project already knew that a probe can be wrong (§12.3 records
three ways). D48 is the other failure: a probe that was right about what it
measured and silent about what mattered. Two guards come out of it —

- **Measure the thing against its context, not in isolation.** A highlight has
  a surface under it; a label has terrain behind it; a marker has a globe
  around it. The ratio is usually the perceptual quantity, and the absolute
  number usually is not.
- **A defect reported by an eye is closed by an eye.** D48 marked #12 fixed on
  the strength of a probe. Only running it in front of the person who filed it
  actually closed it.

---

## D50 — Both cones were inside out, and every test was looking somewhere else

**Decision:** the nose and tail cones are rotated the same way as the fuselage,
every cylinder in the airframe is authored as `(forwardRadius, aftRadius,
length)`, and the flying surfaces become swept, tapered panels instead of
rectangular slabs.

*Alternatives:* leaving the shape as it was; swapping the radii instead of the
rotation; loading a glTF airliner after all.

**The defect.** `CylinderGeometry` is built along +Y with `radiusTop` at the
+Y end. The fuselage was laid along Z with a +90° rotation about X, which maps
+Y to +Z — the nose direction. The two cones were rotated the *other* way, −90°
for the nose and +90° for a tail authored as if it were −90°, which silently
swapped each cone's ends. Measured on the merged geometry:

| | at the fuselage join | at the tip |
|---|---|---|
| Nose, before | r = 0.004 — a needle | r = 0.042 — full width |
| Nose, after | 0.042 | 0.004 |
| Tail, before | 0.012 | 0.036 |
| Tail, after | 0.036 | 0.012 |

So the body ran out to full width, pinched to a point where the nose cone
began, and then flared open again at the very front. On screen that is a
trumpet, and it is what Phone photographed and called messed up.

**Why every test passed.** D42 pinned the things that make an aeroplane point
the right way: the heading basis is a rotation and not a reflection, a heading
of exactly zero still draws, the tallest vertex lies aft of centre so the model
cannot be authored nose-backwards, the mesh sits where the sprite would have.
All true. All still true *with both cones inverted*, because the model was
never backwards — the layout was right the whole time, nose forward, wings
mid-body, tailplane and fin aft. The bug was inside two primitives, in an axis
none of those assertions looked along. D43's pixel probe then measured heading
to 1.3° and size in pixels, neither of which changes when a cone is flipped.

**The shape of it, again.** Not a wrong formula: a correct primitive fed a
rotation that meant the opposite of what the author intended. That is the same
sentence as D34, D36, D40, D41 and D43, and the reason `at()` no longer takes a
raw angle. It takes `lieAlongZ`, and the rule it establishes — after that
rotation `radiusTop` is the *forward* radius — is written above it, because the
absence of that sentence is what the defect was made of.

### Tests that would have caught it

Three, and they measure the hull rather than its orientation:

- The body's radius at the nose tip is under a third of its radius where the
  cone meets the fuselage, **and that join is asserted wide**. Checking only
  that the two differ would have passed on the broken model, where the needle
  and the full width were simply swapped.
- The same for the tail cone, aft.
- The wing's tip leading edge is aft of the root's, and the tip chord is under
  60% of the root's — the sweep and taper below.

Sampling is by window along Z, chosen so only the body is inside it. Note the
windows must land on the cylinders' rings: these are eight-sided cones with one
height segment, so there are no vertices between the ends, and a window in
between measures nothing at all.

### The flying surfaces

Rectangular slabs with square tips are most of what made this read as a dart
rather than an airliner, so wings, tailplane and fin are now four-cornered
panels: root chord 0.24 tapering to 0.09 at the tip, the tip's leading edge
0.16 aft of the root's, and the fin raked back on the same rule. A
`BoxGeometry` cannot express any of that; a panel of four plan corners and a
thickness costs the same twelve triangles.

220 triangles, one mesh, one material, **one draw call** — the budget D42 set,
unchanged.

**Signed off by eye.** Phone looked at the result and accepted it, which makes
this the first of the three unlooked-at features to actually clear that bar.
The glint took two attempts to get there (D49); this one took a photograph from
somebody looking at the running app to even start.

---

## D51 — The label thresholds were hiding most of the world

**Decision:** cities enter the generated table at 100,000 people rather than a
million, airports at any settlement of 25,000 rather than 500,000, and two
finer altitude tiers are added so the extra data appears only as the camera
comes in. At the closest tier an airport is labelled with its name instead of
its three-letter code.

*Alternatives:* leaving the thresholds; lowering them without adding tiers;
lowering them only for one country; a runtime request for detail as the camera
moves.

**The report was that Thailand looked empty, and it was.** The whole country
had exactly one city label — Bangkok — and two airports. Not Chiang Mai, Hat
Yai, Udon Thani, Nakhon Ratchasima or the sixteen other Thai cities above a
hundred thousand; not Phuket, Krabi, Samui, Chiang Rai or U-Tapao. Nothing was
broken. The filters were simply set where most of the world falls off:

| | Old floor | Thailand's reality |
|---|---|---|
| Cities | 1,000,000 | one city qualifies; 20 are above 100,000 |
| Airports | a city of 500,000 within 60 km | Phuket serves a city of 89,000, Samui 50,000, Krabi 31,000 |

**An airport's importance has very little to do with the size of the town it is
named after**, and that is the assumption the old floor encoded. Phuket and
Samui are among the busiest airports in the region and both serve settlements
under a hundred thousand people. The floor now exists only to exclude airfields
with no settlement near them at all.

**Lowering the floors is not the same as showing more labels.** The table grew
from 363 cities and 1,029 airports to 4,442 and 4,072, and what appears on
screen did not change at any altitude that existed before — the tiers and the
caps decide that (D45), and the file only decides what is *available* to them.
Two tiers were added below the old bottom step so the new data has somewhere to
appear:

| Altitude, radii | Reads as | Shown |
|---|---|---|
| 0.12 to 0.35 | a large country | cities above 1 million |
| 0.06 to 0.12 | a region | cities above 300,000, airports as codes |
| below 0.06 | a province | cities above 100,000, **airports by name** |

**The code gives way to the name at the last step.** `HKT` is right for a
regional view and useless when you are looking at one island; "Phuket
International Airport" is what somebody at that zoom is asking for. It is also
three times as wide, which is why it waits for a tier where few labels compete.
Both strings come from the same row, so the switch costs a branch.

### What it costs

| | Before | After |
|---|---|---|
| `labels.json` | 141 KB raw, 45 KB gzipped | 629 KB raw, **187 KB gzipped** |
| Selection pass, closest tier | 0.061 ms | **0.080 ms** |
| Reprojection, per frame | 0.033 ms | 0.036 ms |
| Candidates at the closest tier | 1,422 | 8,544 |

187 KB gzipped, fetched once and cached, against an aircraft payload of 29 KB
every ten seconds: it pays for itself before the fourth poll. The per-frame
cost barely moves because the candidate list is cached against the tier that
produced it and the caps bound the work that follows.

**The build step got 140 times faster on the way.** Ranking every airport
against every city was 7,698 x 9,062 great-circle distances and took a minute
of every `npm run dev`. Cities now go into one-degree buckets and each airport
looks at the nine around it — the search radius is 60 km, comfortably inside
one degree of latitude. 62 s to 0.43 s, same output.

### What this does not do

It does not add detail the globe cannot show. The camera stops at 89 km, where
the view is 83 km tall and the colour texture is 9.8 km per pixel; more labels
is the only kind of "more detail" available at that scale without the tiled
imagery and building geometry D17 rules out. See D52 if that decision is ever
revisited.

---

## D52 — City mode: a spike against D17, and what the tile research found

**Decision:** build a throwaway-able spike, not a feature. Below 0.05 globe
radii the globe hands the view to a MapLibre map centred on the same point,
with OpenStreetMap vector tiles and 3D buildings; zooming back out hands it
back. Everything is behind `config.cityMode`, and `VITE_CITY_MODE=off` restores
the previous behaviour exactly.

*Alternatives:* leaving D17 alone; migrating the globe to MapLibre outright;
CesiumJS; a paid tile provider.

**Why the question came up.** The request was for Thailand to look real and for
detail to appear on the way in, "like Google Maps", including buildings. D51
did the part that was a data problem. This entry is about the part that is not:

| | |
|---|---|
| Closest the camera can go | 89 km altitude, a view 83 km tall |
| Altitude buildings need | 1–2 km |
| Colour texture | 4096x2048 = 9.8 km per pixel, about **8 texels across the screen** at closest zoom |
| Zoom levels between the globe's floor and where buildings exist | **six** |

Six zoom levels is not a tuning problem. **D17 excluded tiled imagery, terrain
meshes and streamed geometry permanently, and no amount of work inside this
renderer gets around it** — globe.gl draws one textured sphere and has no tile
pipeline, no level of detail, and no Mercator. Phone asked to reopen it, which
is the only way it could be reopened.

### The tile research, since "free with no limits" was the constraint

| Service | Key | Limits | Buildings |
|---|---|---|---|
| **OpenFreeMap** | none | none published: "no limits on map views or requests, no registration, no API keys" | yes, `building` layer from z14 |
| **Protomaps, self-hosted** | none | **none by construction** — you serve the file | yes |
| Protomaps hosted | yes | 1M tiles/month soft cap | yes |
| Mapbox / MapTiler / Stadia | yes | monthly caps | yes |
| EOX Sentinel-2 cloudless (imagery) | none | fair use — explicitly not for production traffic | n/a |
| NASA GIBS (imagery) | none | unmetered, but 250 m per pixel | n/a |

Two conclusions, and the second one is the useful one:

- **Vector tiles solve this and satellite imagery does not.** Every free
  imagery service is either metered, key-gated, or too coarse to show a
  street. The "Google Maps look" being asked for is the *vector* map anyway —
  roads, buildings, labels — and that is available without a key or a cap.
- **The end state is a Protomaps extract served by our own backend.** One
  `.pmtiles` file for the region, HTTP range requests, no third party at
  runtime and no limits of any kind. That is the same shape as every other
  asset here (D30, D44) and it satisfies D7, which the spike currently does
  not: OpenFreeMap is a request from the browser to somebody else, and it is
  the only one in the app.

### Why a spike, and what it deliberately does not do

City mode is a second renderer. That means no aircraft in it, no terminator, no
markers, no route, no selection — everything the globe layers draw stops at the
boundary. **That is not a defect to fix here.** It is the cost of the cheap
version, and the spike exists to answer two questions before anyone pays the
expensive one:

1. Does the OpenStreetMap building data over Thailand look like anything?
   Heights are sparsely tagged outside central Bangkok, and untagged buildings
   extrude to a default — so this may read as a uniform slab city.
2. Is the hand-off between two renderers tolerable, or does it feel like the
   app changed its mind?

If both answers are good, the real version is a migration: MapLibre now has a
globe projection, 3D building extrusion on that globe, and three.js scenes as
custom layers, so one renderer could cover the whole zoom range. That would
also delete the border and label layers, which the basemap provides — and it
would cost the day/night terminator, which has no MapLibre equivalent and was
D41's entire session.

### The hand-off, since it is the part with real engineering in it

**Matched scale.** The ground distance across the viewport is computed on both
sides of the boundary and made equal, rather than picking a zoom that looks
about right. Two ways to get this wrong both look plausible: MapLibre defines
zoom against 512-pixel tiles, so the widely-quoted 256-pixel constant is a
factor of two — the world doubling in size at the boundary; and Web Mercator's
scale depends on latitude, so a fixed mapping jumps everywhere except the
tropics. Both are pinned by tests, including a round trip through the inverse
used to hand back.

**Hysteresis.** Entering at 0.05 radii and leaving at 0.09. One threshold for
both directions sits exactly where the user is scrolling and flickers between
two renderers on every notch of the wheel.

**A dive on entry.** At matched scale the first frame of city mode looks like
the globe with the planet switched off — same scale, different renderer,
nothing to see. Entering therefore eases from the matched zoom (7.8 over
Bangkok) down to 13.5 and tilts to 55 degrees, because a footprint viewed flat
is a polygon and it is the tilt that makes it a building.

**MapLibre and its stylesheet are dynamic imports**, so a session that never
zooms in never downloads 800 KB of map library. The stylesheet is not optional:
without it the attribution control renders unstyled, and attribution is a
licence condition of the tiles rather than a decoration.

---

## D53 — The hand-off was in the wrong place, and city mode had no aircraft

**Decision:** city mode takes over at **0.35 globe radii** rather than 0.05,
the threshold becomes configurable, aircraft are drawn on the map, and a failed
hand-off hands back instead of stranding the view.

*Alternatives:* keeping 0.05 and fixing the imagery instead; a higher
resolution Earth texture; leaving aircraft out of city mode.

**The report was that Thailand looked like gibberish, with two screenshots.**
Neither showed city mode: they showed the globe magnified past the point where
its texture means anything. The colour map is 4096x2048, or 9.8 km per texel,
so against a 1080-pixel viewport:

| Altitude | View | Texels per screen pixel |
|---|---|---|
| 0.60 | 3,565 km | 3.0 |
| 0.35 | 2,080 km | 5.1 |
| 0.20 | 1,188 km | 8.9 |
| 0.12 | 713 km | 14.8 |
| **0.05** — the old hand-off | 297 km | **35.6** |
| 0.014 — the camera's floor | 83 km | **127** |

At thirty-six texels per pixel there is no image, only a smear of night lights.
**The globe was handing over long after it had stopped being worth looking
at**, so the entire approach was spent staring at magnified texture. D52 picked
0.05 by asking how close the camera could get; the question it should have
asked is how close the *imagery* holds up.

0.35 is where the label tiers already start showing cities (D45), so the rule
is legible: when city names appear, the city map takes over. It is still 5.1
texels per pixel — soft, not gibberish — and everything below it is now vector,
which is sharp at every zoom by construction.

**Aircraft had to follow.** Drawing none was defensible when city mode occupied
the last sliver of zoom nobody used; at 0.35 radii it is most of the range
somebody watching aeroplanes actually uses, and an aircraft tracker that hides
the aircraft when you look closely is not one. They are a GeoJSON source
updated from the same store the globe reads, drawn with the same silhouette:
`aircraftSprite.ts` now exports the airframe as a standalone canvas, so there
is one outline in the project rather than two that must be kept in agreement.
A null heading gets no rotation, as everywhere else (D40, D42).

**And a real defect, found by looking for why the screenshots showed no map at
all.** `enter()` set `active = true` before awaiting the dynamic import. Any
failure in there — an offline machine, a blocked request — left the layer
permanently active: a transparent div over the globe, no map, and
`shouldEnterCity` returning false forever because it thought city mode was
already up. It now catches, hands back, and logs. A test drives a loader that
throws and asserts the layer is inactive and hidden afterwards.

### What this does not fix

The globe is soft at any close zoom, hand-off or no hand-off — 3 texels per
pixel at 0.6 radii is the best it does. A 21600x10800 Blue Marble would be
1.85 km per texel and hold up five times closer, at the cost of a large local
asset. That remains available through `VITE_EARTH_DAY_TEXTURE` and is not part
of this change.

---

## D54 — The planet view: one renderer, orbit to street

**Decision:** migrate the world view from globe.gl to MapLibre's globe
projection, with NASA GIBS satellite imagery at low zoom fading into
OpenStreetMap vector tiles at high zoom. Built beside the existing globe behind
`VITE_VIEW=planet`, not in place of it.

*Alternatives:* keeping the globe and the city-mode hand-off (D52, D53);
CesiumJS; a higher-resolution Earth texture; doing nothing.

**What forced it.** The globe draws one baked 4096x2048 JPEG over the whole
planet — 9.8 km per texel. D53 measured what that means on approach: five
texels per screen pixel at 0.35 radii, thirty-six at 0.05, a hundred and
twenty-seven at the camera's floor. There is no tuning of a single texture that
survives that, and the hand-off to a second renderer left a seam, no aircraft
across it, and two of everything to maintain. D17 excluded tiled imagery on the
grounds that the pipeline would cost more than the rest of the project; what
changed is not the cost of the pipeline but the discovery that two services now
provide it for nothing.

### The two sources, and why neither is asked to do the other's job

| | Source | Resolution | Key | Limits |
|---|---|---|---|---|
| Imagery, z0–8 | NASA GIBS `BlueMarble_NextGeneration` | 500 m | none | none published; NASA open data |
| Vector, z0–14+ | OpenFreeMap (OpenMapTiles schema) | geometry | none | none published |

500 m per pixel is **forty times sharper** than what the globe stretched over
the planet, and it is real imagery rather than one JPEG magnified. It runs out
at zoom 8. Vector tiles are sharp at every zoom by construction and carry
almost nothing above zoom 8 worth seeing. So the raster fades out over zooms
5.5 to 7.5 — before its own tiles run out, so the last imagery seen still has
pixels of its own — and the vector map is already beneath it when it goes.

**The fade is a `raster-opacity` interpolation and the layer sits immediately
above `background`.** Everything else in the style — water, landcover, roads,
labels — draws on top of imagery and is what remains after it. One layer
inserted into someone else's 111-layer style, rather than a style written here:
that cartography is tuned, and rewriting it would be a hobby.

### What the migration deletes, and what it costs

**Deleted outright:** the border layer and the label layer, and their build
pipeline. D44 and D45 exist because the globe had no basemap; MapLibre has one,
with better typography, real collision handling and every zoom covered. Around
sixty tests retire by being made unnecessary rather than by being wrong.

**Handed over:** the marker layer. Two thousand aircraft in one `THREE.Points`
with a custom shader was the only way to hold one draw call (D15, D40); a
symbol layer is the same idea written by people who do it for a living, with
collision and rotation included. Picking goes with it — `queryRenderedFeatures`
against the drawn symbol, which is what D34's pixel-space tolerance was
approximating.

**Carried across unchanged, because none of it was ever about rendering:** the
store, all three polling hooks, the contract, search, the detail panel, the
legend, the status bar, interpolation and dead reckoning, and the entire
backend. What survives from the marker layer is everything that was about
meaning rather than drawing — the altitude ramp (D28), read from the same
function so two copies cannot drift; a null heading drawn as a disc rather than
as north (D18, D40); stale aircraft faded rather than removed (D33).

**Still to do, and not pretended otherwise:** the route line, the selected
aircraft's 3D model as a custom three.js layer, and the terminator. The first
two are ports. The terminator is the one thing with no equivalent — D41's
per-pixel day/night shading has no MapLibre counterpart, and the closest
approach is a computed night polygon with the GIBS `VIIRS_CityLights_2012`
raster under it, which is the same information by a coarser mechanism.

### Built beside, not in place of

`VITE_VIEW=planet` selects it; the default is still the globe. Two entry points
in `App.tsx` and nothing else shared but the store. This is deliberate: the
globe works, is verified, and is what the project has to show if this direction
stalls. Abandoning it costs deleting `src/planet/`; adopting it costs deleting
`src/globe/` and one line in the shell.

### Three conventions that disagree, all of them pinned

The recurring shape of every defect in this project is two correct things that
mean different things, and the migration meets three at once:

- **GeoJSON is lon/lat; the contract is lat/lon.** Swapping them puts every
  aircraft in the wrong hemisphere and nothing fails.
- **GIBS is WMTS, so its path is `{z}/{row}/{col}` — that is `{z}/{y}/{x}`**,
  not the `{z}/{x}/{y}` of an XYZ service. Swapped, it returns tiles of the
  wrong place rather than an error: a plausible, mirrored Earth.
- **MapLibre's longitudes run past 180 as the user keeps panning; the contract
  stops at 180.** Wrapping is what produces `lonMin > lonMax` across the
  antimeridian, which D25 already defines and the backend already implements.

---

## D55 — A stylesheet loaded later collapsed the map to nothing

**Decision:** scope the map containers' layout rules to `.app` so they outrank
MapLibre's own, and check the container's size before handing it to MapLibre.

**The symptom was a blank screen with everything else working.** The header,
the legend and the status bar all rendered, the store held 157 aircraft, no
console error, no failed request, no MapLibre error event. The map simply drew
nothing.

**The cause was the cascade.** MapLibre adds `maplibregl-map` to whatever
container it is given, and its stylesheet sets `position: relative` on that
class. That stylesheet is a dynamic import — the whole point of which is that
it arrives only when the map does — so it lands *after* the application's
styles. `.planet-view` and `.maplibregl-map` are both a single class, so they
are equally specific, and at equal specificity **the later rule wins**. The
container turned relative, `inset: 0` stopped applying to anything, the box
collapsed to zero height, and MapLibre fell back to its default 400x300 canvas
inside a box with no dimensions.

Measured on the running page: `position: relative`, container 1280x0, canvas
400x300. Afterwards: `position: absolute`, container 1280x720, canvas 1600x900.

**This is the project's oldest shape in new clothes.** Two correct rules that
disagree, and nothing to report because neither is wrong on its own — the same
sentence as D34's pick tolerance, D36's two thresholds, D41's two coordinate
frames, D47's cached age and D50's rotated cones. What is different is that
there was no wrong number anywhere to find: the defect lived in the order two
files were loaded in.

**`.city-map` had it too**, and that matters beyond tidiness: city mode was
judged and set aside on 2026-08-28, and it would have rendered exactly as
blank. That verdict was probably formed on a broken layout rather than on the
idea. It is superseded by the planet view either way, but the record should not
say the spike was rejected on its merits when it may never have been visible.

### The guard, and why a comment would not have done

`container.ts` measures the container and warns before the map is built,
naming the cascade as the likely cause. Two reasons it is code rather than a
note:

- **The failure is silent by construction.** There is nothing to catch and
  nothing to log; a zero-height box is a legal box. The only way to find out is
  to ask.
- **The message is the fix.** "Container has no size" sends the reader to their
  own layout, which is exactly where the answer is not. Naming
  `.maplibregl-map` and `position: relative` turns an evening into a minute.

The threshold is 32 pixels rather than zero, because a box of a few pixels is
the same mistake with the same symptom and would otherwise pass.

---

## D56 — Imagery is the ground, not a layer that fades away

**Decision:** imagery covers every zoom, in two tiers, and the vector basemap
contributes only lines, labels and buildings. Every area fill and the
background are dropped from the style.

**What was wrong.** D54 layered imagery *under* the vector basemap and faded it
out at zoom 7.5, on the reasoning that vector detail takes over where imagery
runs out. Looked at, it does something else entirely: the basemap's background
is `#f8f4f0`, so past the fade the ground is cream. Zoom into anywhere without
roads — a desert, a coastline, most of the planet — and the screen turns white.
Fading a photograph out into a blank fill is precisely backwards.

**Two tiers, because their terms differ.**

| | Source | Resolution | Reaches | Terms |
|---|---|---|---|---|
| Far | NASA GIBS `BlueMarble_NextGeneration` | 500 m | z8 | open data, unmetered |
| Near | EOX Sentinel-2 cloudless | **10 m** | z15 | no key, **fair use** |

Fifty times finer, and the difference between "a continent from space" and "the
field beside the runway". One source would have been simpler; two is honest.
GIBS is NASA's public service and carries every ordinary view of the planet.
Sentinel-2 is a courtesy from a company that asks not to be pointed at
production traffic, and is only reached by zooming past a continent — so the
service that publishes no limits absorbs the load, and the one that asks for
restraint gets it. The near tier crossfades in over the far one across zooms
5 to 7: a dissolve between two photographs of the same ground rather than a
cut between a photograph and a colour.

**The vector tiles keep their job, which was never to be the ground.** Only
`line`, `symbol` and `fill-extrusion` layers survive the filter — roads,
boundaries, rivers, labels, buildings. Every `fill` and the `background` are
dropped, because a fill's entire purpose is to colour an area that imagery is
already showing, better. A hundred layers of tuned cartography still decide
where roads go, what earns a label and how buildings extrude; they simply no
longer paint the dirt.

**What this is, stated plainly:** the satellite-with-labels hybrid every mapping
product offers, assembled from two free sources and one free vector basemap,
with no key anywhere.

### The lesson, which is not a new one here

D54 chose the fade by asking "where does imagery stop having tiles?" The
question that mattered was "what is underneath it when it goes?" — and the
answer was a colour nobody had looked at. It is the same shape as D53, where
the hand-off altitude was chosen by asking how close the camera could get
rather than how close the imagery held up, and D48, where the glint was
measured in isolation rather than against the ocean beneath it. **Three times
now: the quantity that mattered was a relationship, and it was measured as a
property.**

---

## D57 — The map reports on itself, because it is looked at on another machine

**Decision:** a development-only readout drawn into the planet view, showing
whether the style loaded, how many tiles of each kind have been requested, and
the last few errors MapLibre raised.

**The problem it solves is not technical, it is a communication one.** The map
is looked at on one machine and debugged on another, and neither can see the
other. The browser surfaces available here do not composite, so MapLibre never
gets the `requestAnimationFrame` it needs to load a style or fetch a tile —
every probe reports "not loaded" whether the code is right or wrong, and
`map._render()` by hand does not advance it either. From the other side, a
screenshot shows exactly what is drawn and nothing whatever about why. Two
defects in this view (D55, D56) each cost a full round trip to identify from a
picture.

So the map says what it is doing, on screen, where a screenshot carries it.

**The line that matters most is the one that names a diagnosis rather than a
number**: "NO VECTOR TILES — roads and labels cannot draw", shown only when the
style has loaded and the vector count is still zero. Every road, label and
building comes from that one source; if it is silent, the imagery underneath
looks like the whole map, and the symptom — a beautiful satellite view with no
cartography on it — points nowhere near the cause.

**A detail worth pinning, and a test does:** glyphs are also `.pbf`, so a naive
pattern counts font requests as vector tiles and hides precisely the failure
the panel exists to surface.

Stripped from production by the `DEV` guard, like the globe's `__orbital`
console handle. It is deliberately plain — it is there to be photographed, not
admired.

---

## D58 — Sub-metre imagery, and the terms that come with it

**Decision:** the close imagery tier becomes Esri World Imagery, reaching zoom
19, with Sentinel-2 cloudless kept as a one-variable alternative.

**The previous answer was wrong, and worth recording as wrong.** Asked whether
zoom 15 was the limit, D56's setup said yes: Sentinel-2 is 10 m per pixel and
stops having tiles of its own at 15. What that answered was "how far does *this
source* go", not "how far can the map go" — the same substitution as D53 and
D56, three entries in a row. Measured over Bangkok:

| Zoom | Sentinel-2 | Esri World Imagery |
|---|---|---|
| 12 | 33 KB | 21 KB |
| 15 | 17 KB | 26 KB |
| 17 | 8 KB — upscaled | 24 KB |
| 18 | 5 KB — upscaled | 21 KB |
| 19 | **404** | 16 KB |

Esri has real tiles four zoom levels further, at sub-metre resolution: the
level where individual buildings, road markings and vehicles are visible.

**And the terms are worse, which is the whole reason this is a decision.**
Esri serves the endpoint without a key and it is what most open-source mapping
uses, but its terms expect attribution and an account for production traffic,
and it may rate-limit. That is a weaker guarantee than NASA's open data, and it
is why the split into tiers stays: **GIBS carries every ordinary view of the
planet and is unmetered; the commercial tier is only reached by zooming past a
continent.** Sentinel-2 remains a cleaner licence at a third of the reach, one
environment variable away.

Neither is a promise. Self-hosting is the only real answer to "no limits", and
for imagery that means gigabytes — which is why the recommendation for the
end state is still a Protomaps extract for vector and a mirror for imagery,
both behind our own backend (D52).

### What this does not fix

Street names and building outlines are not imagery, and they are still not
drawing. That is a vector-tile problem, unrelated to how sharp the photograph
underneath is, and D57's readout exists to find it.

---

## D59 — Cartography styled for imagery, and a readout that names which failure it is

**Decision:** recolour the vector layers for a photographic background — bright
labels with dark halos, dark road casings under light roads, translucent
buildings — and add a rendered-feature count to the diagnostics readout.

**The report:** imagery reaches zoom 19 and looks right; street names, roads and
buildings are still not visible at any zoom.

**What was ruled out first**, because guessing at rendering is how the last
three defects each cost a round trip:

- The vector tiles serve. Fetched from the page: 200, 450 KB of MVT at zoom 14
  over Bangkok, with CORS.
- The filter keeps them. 93 of the basemap's 111 layers survive it, including
  30 road layers and 25 label layers.
- The composed style is valid. Checked against MapLibre's own spec with
  `validateStyleMin`: **zero errors**, and no layer references a source that
  the filter removed.

So the style is right and the data is there. That leaves two explanations, and
**they are indistinguishable in a screenshot**: the tiles are not being drawn,
or they are being drawn invisibly.

**The second is entirely plausible and had not been considered.** The basemap is
a *light* style. Its roads are white with pale casings and its labels are dark
grey with a white halo — every one of those correct against its own cream
background, and close to invisible over a satellite photograph of a city, which
is itself grey and white and busy. Fading white roads onto a white-grey city is
the same mistake as D56's cream background, one layer up.

So the cartography is recoloured for what is actually underneath it: labels
white with a dark halo, casings dark under bright roads, buildings translucent
so they read as volumes over their own footprints. This is what Google's
satellite mode does, and for the same reason. **Geometry, zoom rules, filters
and label placement are untouched** — those are the hundred layers of tuned
cartography worth keeping; only colour was wrong.

**And the readout now says which failure it is.** `queryRenderedFeatures()`
reports how many features MapLibre is currently drawing, which separates the
two cases at a glance:

| Readout | Meaning |
|---|---|
| `NO VECTOR TILES` | the source never loaded — nothing can draw |
| `TILES BUT NO FEATURES` | the source loaded and drew nothing |
| features in the thousands, nothing visible | it is drawing, and the colour is the problem |

That third row is the one this entry exists for. If the recolour is the fix,
the map will simply be right; if it is not, the readout now distinguishes the
remaining two causes without another round trip.

---

## D60 — The one request the map could not make

**Decision:** resolve vector TileJSON documents ourselves at style-build time
and hand MapLibre a source that already lists its tiles.

**The readout found it in one screenshot**, which is what it was built for
(D57):

```
style LOADING · z12.1 · 95 layers
tiles: gibs 131 · sentinel 0 · vector 0
glyphs 0 · sprite 2 · features drawn 0
```

Every number in that is informative. The style is applied — 95 layers, two of
imagery and 93 of cartography. Imagery is streaming — 131 tiles. The sprite
loaded, so MapLibre is reading the style. And **not one vector tile, not one
glyph, and the style still reporting itself as loading**, with no error event
at all.

**A vector source can be declared two ways**, and the difference turned out to
matter: `tiles`, a list of URL templates, or `url`, a TileJSON document that
MapLibre must fetch and read the templates out of. The basemap uses the second.
That fetch never completed, silently — no error, no retry, and a style
permanently short of one source, so the 93 layers hanging off it had nothing to
draw. The imagery sources were unaffected because they are declared the first
way.

The same TileJSON fetches perfectly from the page, which had been verified more
than once — and that measurement was misleading in a way worth naming: *we*
could fetch it, so the URL and CORS were fine, and the conclusion drawn was
"the tiles are fine". What was never checked is whether **MapLibre** had
fetched it. `vector 0` is the check that mattered, and it took building a
readout to see it.

So the document is fetched where the result can be seen, and the source is
handed over already resolved. A failure is now an exception at load, not a map
that renders beautifully with no roads on it.

**The indirection was worth losing anyway.** The tile path carries a dated
build — `/planet/20260823_080002_pt/` — that changes weekly, so resolving it at
load time is also what keeps the templates current.

### And a bug in the instrument itself

The same screenshot reported `sentinel 0` while Esri tiles were streaming: the
readout's pattern still named the provider that D58 had replaced. A diagnostic
that names a vendor goes stale the moment the vendor changes, so it now matches
whichever close tier is configured and prints `close`. **The measurement
harness is code too** — this project's oldest lesson, now paid for by the tool
built to stop paying for it.

---

## D61 — The readout was reading a number that could not move

**Decision:** the diagnostics panel reports MapLibre's own source-cache state —
is the source present, is it loaded, how many tiles are cached, how many
features are being drawn — instead of counting vector tile requests.

**The instrument was wrong, and it sent two rounds of work in the wrong
direction.** `vector 0` was read as "MapLibre never requested a vector tile",
and D60 was built on that reading: the TileJSON indirection was removed so the
source would arrive pre-resolved. The next screenshot said `vector 0` again, at
zoom 17, with imagery streaming.

**MapLibre fetches vector tiles inside a Web Worker.** Raster tiles are loaded
on the main thread as images; vector tiles are requested and parsed off it. And
`performance.getEntriesByType('resource')` reports the *calling thread's*
requests — so a main-thread readout cannot see a worker's fetches at all. That
counter could only ever have read zero. It was not measuring a failure; it was
measuring nothing, in a way that looked exactly like a failure.

This is the third time the harness has been the problem — the rotation probe's
aspect ratio, the lighting probe's three confounds, and now this — and the
first time one of those was the tool built specifically to stop it happening.
**A diagnostic must be checked against a known-good state before it is
trusted**, and this one never was: it had only ever been run against a broken
map, where zero is exactly what a correct instrument would also print.

### What it reports now

`map.getSource`, `map.isSourceLoaded` and the source cache's tile count: all
main-thread state, and the state MapLibre actually decides what to draw from,
regardless of which thread fetched the bytes. Three distinguishable failures
instead of one ambiguous number:

| Line | Meaning |
|---|---|
| `NO VECTOR SOURCE` | the style has nothing to draw roads from |
| `SOURCE HAS NO TILES` | nothing was fetched for this view |
| `TILES BUT NO FEATURES` | fetched, and drew nothing |

The request counter survives, renamed `vectorMainThread` and documented as
untrustworthy, because deleting it would invite somebody to add it back.

**D60 stands on its own merits**: resolving the TileJSON ourselves removes a
request that can fail silently and keeps the weekly-dated tile path current. It
simply was not the fix for this, and the entry should be read as a change made
for a reason that turned out not to be the reason.
