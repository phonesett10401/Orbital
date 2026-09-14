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

**Later note:** it is ten fields now, not nine - `model` was added for D90 -
and the discipline held: both files changed in the same commit, as did
data-contract.md. The prediction that the shape changes rarely has survived
one change in eighty-odd decisions.

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

> **Superseded by [D93](#d93---satellites-are-in-scope-again-and-what-that-does-and-does-not-mean) on 2026-09-01.** Phone reversed this deliberately, which is
> the mechanism the tripwire tests below were built to force. The entry stays
> as written because the reasoning at the time is part of the record - and
> because its argument that the `type` field and the provider registry were
> *not* satellite scaffolding is still correct.

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

---

## D62 — What was excluded, and the one defect it did find

**Decision:** wait for the map container to have a box before constructing
MapLibre, keep it sized with a `ResizeObserver`, and append the diagnostics
panel after construction rather than before.

**This entry is mostly a record of exclusions**, because the search cost more
than the fix and the next person deserves the map of where the fault is *not*.
Roads and labels were invisible; the readout said the vector source was present
with a resolved template and had never fetched a tile. Each of the following
was tested in the live page, in isolation, and **works**:

| Suspected | Test | Result |
|---|---|---|
| The tile URL | fetched the template the live style holds | **200, 13 MB** |
| MapLibre's worker | added a GeoJSON source, which parses in the worker | loads, fires `metadata`/`content`/`idle` |
| Vector tiles at all | minimal style, one line layer, the same source | **802 features** |
| The layer filter and recolour | the composed style, built by the app's own module | **1418 features** |
| The globe projection | same style with and without it | 1418 against 1475 |
| Worker starvation from the per-frame aircraft rewrite | 491 `setData` calls while tiles loaded | vector still loaded |
| The whole view configuration | a replica of `PlanetView`'s map and load handler | **1418 features** |

Every ingredient works. A replica of the view works. The application's own map,
in the same page, does not — which is the shape of a defect in construction
rather than in configuration, and is where the one thing found so far lives.

**The defect: MapLibre was handed a container with no size.** It measures the
container exactly once, at construction, and falls back to a 400x300 canvas
when it measures nothing. Observed on the real map: container 1280x720, canvas
**400x300**, transform never sized. D55 had already added a warning for this
and the warning was not enough — it reported the problem and then carried on
into it. Construction now waits for a box, and a `ResizeObserver` keeps the map
sized afterwards.

**Honesty about what that fixes.** It is a real defect with a measured before
and after, and it is almost certainly *not* what Phone is seeing: their map
fills the screen with imagery, so their canvas is full size. It is fixed
because it is broken, not because it is the answer.

**And a difference removed rather than diagnosed.** The diagnostics panel was
appended inside the container *before* MapLibre took it over — the one
structural difference between the application's map and every replica that
worked. It is now appended afterwards. That is a guess, labelled as one.

### What is left

The console. Every observation so far has come through the readout or a probe,
and MapLibre may be logging something that reaches neither — a worker error, a
content-security refusal, an aborted request. It is the one instrument not yet
read on the machine where the failure actually happens.

---

## D63 — Both fixes were needed, and one was nearly deleted

**Decision:** keep `optimizeDeps: { exclude: ['maplibre-gl'] }` and the
wait-for-container change. Roads and labels render. Corrects two claims in
D62 that were wrong.

**Measured, one variable at a time, on the running app at zoom 14 over
Bangkok:**

| Configuration | Vector features |
|---|---|
| Both changes | **1,418** |
| Container fix only, no Vite exclusion | **0** |
| Vite exclusion only (what Phone saw fail) | 0 |
| Container pre-filled with a child element | 1,418 — makes no difference |

So both were necessary and neither was sufficient. Vite's dev pre-bundling
breaks MapLibre's Web Worker, which is where vector tiles are fetched and
parsed — silently, while raster imagery keeps working because it loads on the
main thread. And a container measured at zero leaves MapLibre on a 400x300
canvas it never recovers from.

### The two corrections

**D62 said the container fix was "almost certainly not what Phone is
seeing".** Wrong: it was necessary. The reasoning was that their screenshots
showed full-screen imagery so their canvas must be full size — which confused
what the canvas *became* after MapLibre's own resize with what it was at
construction, when the tile-loading decisions are made.

**The worker hypothesis was right, and a test of my own construction
"disproved" it.** The sequence: suspect the worker, apply the Vite exclusion,
*then* test worker health by adding a GeoJSON source, watch it load, conclude
the worker is fine. It was fine — because the fix was already in place. The
test could only ever exonerate. On that false exoneration the exclusion was
very nearly deleted as unjustified, which would have broken a working map.

**That is a control-group error, and it is the same shape as the readout that
had only ever been run against a broken map (D61).** Both are the same
discipline failure: a measurement is only evidence if it could have come out
the other way. Testing a hypothesis *after* applying its remedy destroys the
evidence for it.

The rule this project now has, paid for twice: **before removing a change on
the grounds that it is unnecessary, remove it and measure.** That is what
finally settled this one — reverting the exclusion, restarting, and watching
1,418 features become 0.

### What the search cost, and what it was worth

Seven exclusions in D62, all correct and all irrelevant to the cause, because
each tested an ingredient while the two real faults sat in the *assembly*: how
Vite serves the library, and when the container is measured. The one instrument
that would have found it sooner is the one never read on the machine where it
failed — the browser console, where a broken worker announces itself.

---

## D64 — The observed track, ported to the map

**Decision:** the selected aircraft's track is a GeoJSON line source with two
layers — a dark casing under a bright line — densified along great circles, and
made continuous across the antimeridian by unwrapping longitudes rather than by
splitting the line.

*Alternatives:* drawing the raw sample points; splitting at the antimeridian as
the globe layer does; a single line without a casing.

**Great circles, and this is the opposite of the border rule.** The backend
samples at the poll interval, so consecutive points can be hundreds of
kilometres apart. On a Mercator map a straight segment between two of them is a
rhumb line — from London to Tokyo it runs hundreds of kilometres south of the
path actually flown. D44 densifies borders in lon/lat for precisely the
opposite reason: a boundary follows a parallel because that is what a boundary
is, and an aircraft follows a great circle because that is what an aircraft
flies. Same operation, opposite rule, and a test pins the difference by
checking the London–Tokyo midpoint bows north.

**Unwrapped, not split.** The globe layer drops a segment that crosses the
antimeridian, because a line through the scene's three-dimensional coordinates
would otherwise sweep the wrong way round the planet (D6). A map has a cheaper
answer: let the longitude run past 180. MapLibre draws that as the short way
across, so a two-degree hop is drawn as two degrees, and the gap the globe
accepts is not needed here.

**A casing under the line**, for the same reason the roads have one (D59): a
white line disappears over pale terrain, a dark one disappears over water, and
the route is the answer to "where has this aircraft been", so it has to survive
both.

**Redrawn on detail change, not per frame.** The track grows once per poll, and
densifying it is the only expensive thing this layer does — the same reasoning
the globe layer used, and the same subscription.

---

## D65 — Two faults in the reporting, one race in the route

**Decision:** the readout diagnoses only from what MapLibre will answer for
publicly, and the route source is seeded from the store rather than starting
empty.

**The readout cried wolf.** It printed `SOURCE HAS NO TILES` on a map that was
visibly drawing borders and city labels, while its own line above read
`loaded yes · features 120`. The warning was keyed on a cached-tile count read
out of MapLibre's internals, and that count was wrong — the third false zero
this panel has produced, after the request counter that could not see a
worker's fetches (D61) and the vendor pattern that named a provider that had
been replaced (D60).

So the rule for it now: **diagnose from `isSourceLoaded` and
`queryRenderedFeatures`**, which are public API and which the map answers about
itself. The tile count is still printed, because it is useful context, and is
never judged on. A number nobody trusts is worth keeping only if nothing
depends on it.

**And a race in the route.** The track is redrawn from a store subscription
that fires on change, and the source it writes to is created when the map
finishes loading. Select an aircraft while the map is still loading and the
order inverts: the detail arrives, the subscription fires, there is no source
to write to, and the update is dropped. Nothing fires again — the detail is
fetched once per selection, not polled — so that aircraft's track never
appears, for as long as it stays selected.

The source is therefore created with whatever the store already holds instead
of empty. The general form is worth stating, because this is the second time
it has come up in this view after the container measurement: **anything built
asynchronously must take its initial state from the world, not assume the world
will announce itself again.**

---

## D66 — The fixture flew one way and reported another

**Decision:** the fixture provider recomputes `heading` as it animates, so an
object reports the course it is actually flying rather than the one it set out
on.

**Two symptoms, reported as separate bugs, with one cause.** The aircraft
symbol pointed somewhere other than along its own track, and at close zoom the
marker walked away from the track it had just drawn.

**Neither was a rendering fault.** Measured on the running fixture, for
EZY6056:

| | |
|---|---|
| `heading` as reported | 323.3° |
| Bearing of the last two track points | 255.3° |
| Bearing across the whole track | 275.2° |

The provider advances each object along a great circle from its fixture origin
— which is correct — and leaves `heading` at the value in the file, which is
not. **On a great circle the course rotates as the meridians converge.** That
aircraft left China on 323° and, eleven hours later near St Petersburg, was
flying 255° without having turned anywhere. Reconstructed exactly: dead
reckoning from its origin reaches its observed position at 686 minutes, where
the instantaneous course is 255.3° — matching the measured track bearing to a
tenth of a degree.

**Why it mattered more than it looks.** The contract defines heading as the
direction of travel over the ground (D18), and three things downstream believe
it: the marker's rotation, the aircraft model's nose, and the *client's dead
reckoning*, which extrapolates position along the heading between polls. With
the heading 68° stale, the client walked each aircraft off its own path — which
is exactly the second symptom, and which no amount of work on the renderer
could have fixed.

**It also quietly undermined every visual check of orientation this project has
done.** D40 verified the sprite's rotation against `heading`, and D42 and D50
verified the model's nose the same way. Those checks were right, and they were
made against a figure that was only correct while the fixture had been running
for a short time — which, in a development session, it usually had.

The provider now derives the heading from the motion it is generating: the
position a second further along the same great circle, and the bearing to it.
Across all 157 fixture aircraft, at 1 minute, 2 hours and 11.4 hours of
animation, the worst disagreement between reported heading and actual course is
**0.000°**.

Four tests pin it, including the two cases where recomputing would be wrong: an
object that is not moving keeps its heading, and one whose heading was never
reported keeps `null` rather than acquiring a course — `null` means unknown and
never means zero (D18).

---

## D67 — The 3D model, ported to a projection that changes underneath it

**Decision:** the selected aircraft is drawn on the planet view as a three.js
**custom layer** inside MapLibre's own GL context, positioned by a local
tangent frame on the ground, and the airframe geometry moves to `src/airframe.ts`
so both views share one aeroplane.

Phone asked for the port with the standing permission to change it where the
new renderer wants something different. Three things wanted something
different, and one thing deliberately did not change.

### The projection is not one projection

A custom layer under the globe projection is handed two matrices each frame and
a number saying which is live:

| | space | what a vertex is |
|---|---|---|
| `mainMatrix` | globe | a direction from the planet's centre, on a **unit sphere**; altitude is a radial scale of `1 + metres / 6371008.8` |
| `fallbackMatrix` | mercator | **mercator units**, the whole world 0..1, with Z conformal with X and Y |

They are not variants of one convention, and a matrix used with the wrong one
puts the model in the Atlantic. Both conventions are transcribed from
MapLibre's own globe vertex shader and `globe_utils.ts` rather than inferred
from behaviour, because behaviour that is ninety degrees wrong still looks like
an aeroplane.

MapLibre blends between the two over roughly a zoom around z12. **We pick the
dominant one rather than blending**: blending a mesh means projecting it twice
and interpolating in clip space, and near the centre of the screen — where a
selected aircraft nearly always is — the two agree. The cost is a possible
small jump for a selection at the very edge of the viewport during that one
zoom step, and it is a cost, not a non-issue.

### Precision is a requirement here, not a nicety

three.js uploads matrices to the GPU as float32. In globe space the aircraft
sits at magnitude 1 from the planet's centre while its wingtip is 3.9e-6 from
its own centre, and **one float32 step at magnitude 1 is 0.36 m**: a mesh
transformed by a float32 model matrix lands on a lattice a hundred and forty
times coarser than the aircraft is long, and crawls between lattice points as
it moves. MapLibre hands custom layers full-precision float64 matrices for
exactly this reason and says so in its own source. So the model matrix is
composed with the projection matrix **in doubles** and the single product is
uploaded, which moves the small quantity into clip space where it is no longer
small next to what it is added to. Measured, not assumed, in `model.test.ts`.

### What changed from the globe's version, and why

**Size.** The globe anchored the model to the marker shell and clamped it in
pixels (D43). Here it has a true size — 50 m of wingspan — with a 30 px floor.
The floor is what does the work: at true scale a 50 m aircraft is under a pixel
across at z9, so without it the selected aircraft would be invisible at every
zoom traffic is actually watched from. Around z16 true scale overtakes the
floor and from there in the model is the size the aircraft is.

**Height.** The model is drawn **on the ground**, lifted only 0.6 of a wingspan
so it clears the extruded buildings, and that lift is a legibility offset and
explicitly not an altitude. Drawing at a literal 10 km would put it 33,000
pixels above its own ground position at z19 — off the screen — and would part
it from the symbol it replaces, its callsign and its track, all of which are
ground-projected. Altitude stays colour-coded (D28), exactly as the globe
argued for a different reason (D42).

**Light.** A fixed overhead sun rather than the globe's headlight. The
headlight existed so a selection over the night side stayed visible against
real lighting; nothing on this view is unlit, and a fixed sun turns shading
into information because the wings catch it differently as the aircraft turns.
The sun is expressed in the model's own axes, since the model matrix is folded
away before the shader sees anything. The mercator frame is mirrored relative
to the globe frame — mercator's Y axis runs south — so the sun's sideways
component flips with it; without that the aircraft would appear lit from the
other side the moment the map crossed the transition zoom.

**Hiding the symbol.** The globe had `setHidden(id)` so the sprite and the mesh
could not both draw. Here the aircraft's own GeoJSON carries a `modelled` flag
and the symbol layer takes its opacity from it — one frame of data deciding
both, which is the same argument. It is **opacity rather than a filter** on
purpose: a filtered-out symbol is not returned by `queryRenderedFeatures`, and
since the model is not a feature and cannot be clicked, filtering would make
the selected aircraft the one thing on the map that cannot be clicked. At zero
opacity it still hit-tests and its callsign still holds its place in label
collision.

### What did not change

**An aircraft with no heading gets no model** (D18, D40, D42). A mesh commits
to a direction on screen and there is none to commit to. Those keep the disc.

### Testing something that cannot be rendered here

There is no WebGL in the test environment and no browser here that composites,
so two seams carry the weight. The mercator arithmetic is checked **against
MapLibre's own `MercatorCoordinate`**, imported into the test — the technique
D32 used for marker positions, so our code and the library cannot agree on a
shared mistake. The renderer is injectable, so the render path can be driven
without a context and asked the two questions most likely to be answered
wrongly: *which matrix* was used, and *when nothing is drawn*. Both frames'
matrices are also asserted to have a positive determinant, because a reflection
flips triangle winding and inverts every normal, and that is invisible until it
is not.

What is deliberately not asserted is what it looks like. **D50 is why**: fifty
passing tests once described an airframe whose nose flared open at the tip,
because every one of them asked which way it pointed and none asked what shape
it was. The dev readout gained a `model` line for the same reason — "no model
on screen" has four causes that look identical from outside, and this view is
debugged by reading a screenshot of that panel (D57).

---

## D68 — Night on the planet view, as a shaded mesh behind a toggle

**Decision:** the day/night terminator is drawn as a **custom-layer mesh**
shaded per fragment by the sun angle and carrying the city lights as its own
colour, switched by a button in the corner of the map and **off by default**.

Phone asked for "night polygon + city lights, as a toggle" on 2026-08-28. The
toggle and the lights are as asked. The polygon is not, and the reason is worth
recording because it was checked rather than assumed.

### Why not a polygon

A GeoJSON night polygon is the obvious implementation and it cannot carry the
lights. Verified against MapLibre 6.6.0's own type definitions rather than
remembered:

| Wanted | Available in 6.6.0 |
|---|---|
| Recolour a raster so its black background becomes transparent | **No `raster-color`.** The raster paint properties are opacity, hue-rotate, brightness min/max, saturation, contrast, resampling and fade only |
| Mask a raster to a polygon | **No `clip` layer type** |

So a whole-world lights raster drawn as an ordinary layer paints its own black
background over the daylight half of the world, and there is no way to cut it
to the night side. Two layers cannot do this; one mesh can.

The mesh also gets a better terminator out of it. A polygon's edge is an edge —
a hard boundary, or a stack of nested polygons faking a gradient. Here the
alpha falls out of `dot(surface normal, sun)` per fragment, so the twilight
band is a real gradient, and the same fragment samples the lights. No polygon
to densify, no antimeridian to split, and the night side is one draw.

### The composite is the globe's, exactly

The globe's Earth shader ends with `mix(lit, lit * 0.15 + nightColor * 1.5,
nightMix)`. Alpha blending computes `src * a + dst * (1 - a)`. So with the
lights as the source colour at gain **1.5**, and alpha **0.85** at full night,
this view composites what the globe composites — 15% of the ground surviving
night in both — against satellite imagery instead of the day texture. The
terminator's softness, `smoothstep(-0.15, 0.25, ...)`, is the globe's number
too. **Two views disagreeing about where night falls would be worse than either
choice of band.**

The texture is `config.textures.night`, the one the globe already loads.
Nothing new is fetched, and nothing new leaves for a third party (D7). It is
loaded the first time night is switched on and never before — city mode's
argument (D52), applied to a texture a user may never ask for.

### Off by default, which is a change of posture

On the globe the terminator was not a feature, it was the view: a lit sphere in
space is what the sun is doing to it. On a map it is a wash over the thing the
user came to read — a night side hides the imagery, the roads and the place
names underneath it, and at 3 a.m. local time that is most of what is on
screen. So it is offered rather than imposed. `VITE_TERMINATOR=on` starts it
on, and `__orbitalPlanet.terminator(true)` switches it from the console, which
is the tuning loop D49 established.

### Two mechanical details that would be silently wrong

**One vertex set, two projections.** The mesh is a 2° lat/lon graticule, and
both the sphere positions and the mercator positions are generated from the
same lat/lon pairs, sharing one index buffer and one set of normals. Building a
mesh per projection would be two meshes that can drift apart, and the drift
would look like the night side jumping as the map crossed the transition zoom.
The normals are geographic rather than per-frame, which is why the shading
needs no separate treatment in the two spaces: `dot(normal, sun)` is the sine
of the sun's elevation at that point on Earth however the map is being drawn.

**Mercator is drawn three times.** The mesh spans one copy of the world;
MapLibre repeats the world east and west, and one copy would end at a hard edge
in the middle of an ocean. The wraps are three matrices, not three meshes.

The layer is `renderingMode: '2d'` and writes no depth: it is a wash over what
MapLibre has already drawn, and putting a whole-world mesh into the depth
buffer would hide whatever it decided was behind it. It is added **before** the
route and aircraft layers, so night dims the map and not the traffic on it.

### The button

A MapLibre `IControl`, not an element of our own, and its stylesheet rule is
deliberately *more specific* than MapLibre's `.maplibregl-ctrl button` rather
than equally specific and later in the cascade. Both are the same lesson from
D55 and D62: in this container, say which rule wins and let MapLibre place what
MapLibre owns. It sits bottom-left because the dev readout owns the top-right
corner and the attribution owns the bottom-right.

Its label says what pressing it will do, not what is currently on. A button
labelled with its own state reads as a status line and gets pressed by someone
trying to confirm what they are looking at.

---

## D69 — One click handler, because two had to agree

**Decision:** the planet view decides selection in a single click handler, from
a single query, through a pure function that returns "this aircraft, or
nothing".

It was two handlers. A layer-scoped one selected whatever aircraft the click
landed on, and a general one ran its own `queryRenderedFeatures` at the same
point and cleared the selection if it found nothing. Both fire for every click.

**They agreed only by coincidence.** Nothing made the two queries answer
identically — they were separate calls with separate geometry, and the failure
mode is a select immediately undone by a deselect within one click, which looks
exactly like "clicking aircraft does nothing sometimes". It was seen once while
driving the app from a console on 2026-08-28; that instance was probably an
artefact of a synthetic mouse event rather than a real user click, and **the
ordering dependency is a defect whether or not that particular sighting was**.

Now: one query, one answer, no ordering. `selectionFromHits` takes the features
under the pointer and returns the first usable id or null, and it is the whole
decision, so it cannot produce both.

Two smaller things came with it, both of which the old shape got wrong:

- **A click on a callsign selects its aircraft.** The label was previously only
  consulted to decide whether a click counted as a miss. It is drawn for the
  aircraft and reads as part of it, so treating it as a miss made a deliberate
  click clear the selection it was aiming at.
- **A click before the layers exist does nothing.** `queryRenderedFeatures`
  throws when asked about a layer that is not in the style yet, which is a real
  window on a slow connection. `hitsAt` answers with an empty list instead of
  taking the view down.

---

## D70 — The map now says why it is not there

**Decision:** the planet view catches its own failures, classifies them into
four kinds with a sentence each and a Retry, and separately says when a map is
merely slow rather than broken.

**It had no failure handling at all** — no `catch`, no message. Every way of
failing produced one thing: a black rectangle where the world should be
(defect #20). `whenRenderable` already rejected with a carefully written
explanation of the CSS collision that caused two earlier defects, and that
rejection was never caught by anything.

This matters here more than it would elsewhere for a specific reason: **this
view depends on three third-party hosts it does not control** (D54, D58, D60),
and it will be demonstrated on a network nobody controls either. "It is broken"
and "this network is blocking tiles.openfreemap.org" need different sentences,
because they need different actions from whoever is reading.

Four kinds, chosen by what the reader would *do* next:

| Kind | Reader's next move |
|---|---|
| **basemap** — the style or its tiles did not arrive | Check the network. Also told: the aircraft data is unaffected |
| **container** — the map had nowhere to draw | A layout problem in the page, not the data (D55, D62) |
| **webgl** — the browser cannot draw it | Use a current browser |
| **unknown** — anything else | Reload; the thrown text is on screen for the report |

Splitting further would produce messages that differ without changing anyone's
next move.

**A slow map is not a failed one, and gets its own notice.** After twenty
seconds without `load`, a panel appears at the bottom — out of the way, because
the map may still arrive underneath it — saying so, with the sentence that cost
a whole session to learn: **a browser tab in the background gets no
`requestAnimationFrame`, and MapLibre then never finishes loading any style at
all**, not even one with a single background layer and no network (§19.19).
From the outside that is indistinguishable from a network stall, and it is the
first thing to check.

**Retry re-runs the effect** by incrementing an attempt counter rather than
adding a second path for disposing of a map. The existing cleanup tears the old
one down exactly as it does on unmount, so there is one teardown, not two.

The notices are **siblings of the map container, not children of it**. MapLibre
expects the element it is handed to be its own, and the one time this view put
something inside it before construction it cost a session (D62).

---

## D71 — Extrapolate for exactly as long as we claim the position is current

**Decision:** `MAX_EXTRAPOLATION_MS` is now *defined as* the staleness
threshold, and every place that decides what "stale" means derives from one
constant.

Phone reported that the aircraft and the end of its own track drifted apart as
the map zoomed in — "like different brothers" — and that at z12 they were
kilometres apart. That is not a rendering fault. It is three parts of one
screen disagreeing about the same aircraft:

| | Said what |
|---|---|
| The observed track | Ends at the last **reported** position, because it is drawn from reported positions only (D6) |
| The detail panel | "position shown is the last one we received", from **two minutes** on |
| The marker | Dead-reckoned onward for **ten minutes** |

So for eight minutes the application confidently flew a marker along a heading
while simultaneously telling the user it had stopped trusting that position —
and the track, which never lies, sat behind it as the evidence. ANA5686, at
37 m/s and 2m 18s old, was drawn **5.1 km** from the end of its own line. At
the old cap the gap could reach 22 km, and at airliner speed rather than this
aircraft's 133 km/h it would be far worse.

**The comment above the constant already argued for the right behaviour** —
"past this point the marker holds its last known position, and the UI shows how
old it is". It was the number underneath that disagreed with the rest of the
app. That is the recurring shape of this project's defects: not a wrong idea,
a second copy of a number.

Now:

- `STALE_AFTER_MS` is declared once, in `interpolate.ts`, next to the
  extrapolation it governs.
- `MAX_EXTRAPOLATION_MS` **is** that value, by definition rather than by
  coincidence, with the reason written where the assignment is.
- `markers.ts`, `planet/aircraftLayer.ts` and `DetailPanel.tsx` all derive from
  it instead of each carrying their own `120`.

**The marker snaps rather than glides back** when it crosses the threshold, and
that is deliberate. Easing it home would draw the aircraft flying *backwards*
along its own track for several seconds, which is a worse lie than a jump — and
the jump coincides with the fade and the panel's sentence, so all three say "we
have lost it" in the same frame.

**What this does not change:** interpolation between polls, which is the reason
markers glide instead of stepping (D14). Fresh aircraft move exactly as before;
the change only bites once the app has already said, in words, that it does not
know where the aircraft is.

---

## D72 — The track reaches the aircraft, and says which part of it is a guess

**Decision:** a separate, dashed **leader** segment joins the last reported
position to the position the marker is drawn at, rewritten every frame beside
the marker itself.

Phone described the defect better than the first diagnosis did: *"when the
plane moves on, the line end is left behind."* D71 fixed how far the marker
could run ahead of the truth; it did not fix the fact that it runs ahead at
all. Two different beliefs, both correct on their own terms:

| | Drawn at |
|---|---|
| The observed track | the last **reported** position — it is what was observed, and nothing else belongs in it (D6) |
| The marker | the **interpolated** position, because a marker that moved once per poll would visibly step (D14) |

So the gap is `age x speed` and it is permanent, not a glitch: with fresh data
and an airliner it is a few kilometres, invisible at z5 and obvious by z9,
which is exactly the zoom Phone first noticed it at. The two are not out of
sync — they are answering different questions.

**Three ways to close it, and why this one.** Moving the marker back to the
last report throws away interpolation (D14). Extending the *track* to the
marker files an estimate as an observation, and the track's own panel text
promises "this is the path we have watched". Drawing the join as visibly
different says both true things at once: the line reaches the aircraft, and the
last stretch of it is dead reckoning rather than data.

**It is its own source for cost as well as honesty.** The track is a densified
great-circle polyline and rebuilding it every frame is the expensive part of
this layer (D6, D65). The leader is two points, so it can be rewritten on the
frame loop — in the same tick, from the same interpolated position as the
marker, so the two cannot disagree about where the aircraft is — while the
track behind it is still rebuilt only when a poll adds to it.

It draws nothing when there is nothing honest to draw: no selection, no track,
or a marker sitting exactly on its last report — which is what a stale aircraft
now does (D71), so as an aircraft goes stale the dashes shrink to nothing and
the solid track is all that is left. That is the right picture: the estimate
disappears when we stop making one.

---

## D73 — Night bows out where its texture stops being lights

**Decision:** the terminator fades to nothing between z4 and z7, and is skipped
entirely above z7.

Phone turned night on and reported that at z10 it "covered up in faint vision
all names and that side" — a milky fog over the whole of New Jersey. At
planetary zoom the same layer looked right.

**Measured rather than tuned.** The lights texture is 4096 x 2048 for the whole
planet: **9.8 km per texel**. Against the screen at 40 degrees north:

| zoom | screen pixels per texel |
|---|---|
| 2 | 0.7 |
| 4 | 2.6 |
| 5 | 5.2 |
| 7 | 20.9 |
| 10 | **167** |

At z10 one texel spans a sixth of the screen. What is drawn there is not city
lights, it is a single smeared blob of them at 0.85 opacity over the map — and
0.85 of a bright texel is a *pale* wash, not a dark one, which is why it read
as fog rather than as night.

**No texture fixes this.** A street-scale night side would need per-building
light data, not a bigger image. So the layer withdraws: night is a planetary
phenomenon drawn at planetary zooms, and by the time the map is showing streets
the map is what the user came for. It dissolves over three zoom levels rather
than switching, so it does not blink off mid-gesture, and above z7 the mesh is
not drawn at all rather than drawn at zero alpha — no point rasterising a
whole-world mesh to contribute nothing.

This is the same shape of argument as D53, which set the globe-to-city hand-off
by measuring texels per screen pixel rather than by taste, and the same lesson
as D49: a thing that looks right at one scale is not thereby right at another.

---

## D74 — Night falls on the ground, not on the labels

**Decision:** the terminator is inserted **below the first symbol layer** in the
style, so it darkens imagery, roads and buildings and leaves every place name
at full strength.

Phone, looking at the working terminator: *"you will see the texts not even
readable in night side unlike day side."* Correct, and it was drawn that way —
the layer went in above the whole basemap, so the 0.85 wash fell on the labels
along with the ground.

**The principle it got wrong:** a map's labels are not lit by the sun. They are
annotation, drawn on top of the world rather than existing in it. Nothing about
"it is night in Chicago" should make the word *Chicago* harder to read — if
anything the opposite, since a dark ground is exactly when a light label reads
best. The globe never had this problem because its labels were DOM elements
over the canvas; on MapLibre everything is in one stack and the position in it
is the decision.

The same rule already governed the aircraft, their tracks and their callsigns:
they are added after the terminator because they are the reason the view is
open. Labels belong on that side of the line too.

**The boundary is the first symbol layer, not a named id.** Liberty orders its
layers the way every cartographic style does — ground, then lines, then labels
— so "before the first symbol" puts night above the imagery and the roads and
below every piece of text, without depending on an id that could be renamed
upstream. The test asserts the *ordering* for that reason rather than the id:
every symbol layer after the insertion point, no raster or line after it.

A style with no labels at all returns null and the layer goes on top, which is
the previous behaviour and better than throwing on a name that is not there.

---

## D75 — Two maps in one style, switched by a state property

**Decision:** the planet view offers a **flat vector basemap** beside the
satellite one — the look every ride-hailing app uses — and switches between
them with a MapLibre global-state property rather than by swapping stylesheets.

Phone asked whether the view could look like Grab, Bolt or Uber. It is the
easier of the two directions, because the flat map was already being fetched
and thrown away: Liberty is 111 layers, and `withImagery` was keeping 93 of
them and discarding **16 fills and a background** — which are precisely the
land, water, parks and landuse that make a flat map a map.

### One style, not two

The obvious implementation is a second stylesheet and `setStyle`. That would
tear down and re-add the aircraft layer, the callsign layer, the route, the
leader, the model and the terminator — five layers, three sources, two custom
layers and a texture — at the exact moment the user is watching, and every one
of those re-additions is a chance to reintroduce a race this project has
already paid for once (D65's route seeding).

Instead every colour in the style is a two-armed `match` on a global-state
property, and the toggle is one call to `setGlobalStateProperty`. Nothing is
added, removed or re-created; the next frame is simply the other map.

It also costs **no extra network**. The fills come from the vector tiles
already being fetched for the roads and the labels. Flat mode strictly
*reduces* traffic, because the GIBS and Esri rasters stop being requested —
which makes it the faster mode to demonstrate on a bad connection.

### The palettes invert, and that is the whole point

| | Over imagery | Over the flat map |
|---|---|---|
| Labels | white on a dark halo | near-black on a light halo |
| Roads | bright white, dark casing | white, pale grey casing |
| Buildings | translucent, so the roof shows through | opaque; there is no photograph to preserve |
| Fills and background | invisible | Liberty's own palette, as authored |

Each of those is unreadable in the other mode, which is the argument D59 made
for the imagery styling in the first place — it is just that there are now two
backgrounds to be legible against rather than one.

**The fills keep Liberty's colours deliberately.** That palette *is* the flat
map and its authors are cartographers; the only thing done to them here is
switching them off when a photograph is doing their job. Their own opacities
are read back rather than overwritten, so the deliberately semi-transparent
landcover washes stay semi-transparent.

### Imagery stays the default

A flight drawn over a photograph of the ground is the picture this application
is *for*. The plain map is a button away for anyone who would rather read the
map than look at it, and `VITE_BASEMAP=flat` starts there.

**The tests assert appearance, not encoding.** A helper reads one arm of each
expression, so a test says which map it is asking about. Asserting the raw
`match` array would pin the encoding and would pass just as happily with the
two arms swapped.

---

## D76 — Validate the style against the spec, not against our own intentions

**Decision:** the assembled planet style is handed to the style spec's own
validator in a test.

**What happened.** D75 wrapped the imagery crossfade in a multiplication:
`['*', ['interpolate', ['linear'], ['zoom'], ...], whenFlat(0, 1)]`. The style
spec forbids it — a `zoom` expression may only be the input to a *top-level*
step or interpolate — and MapLibre rejects a style with an invalid paint
property **entirely**. Not the layer: the style. The result was 0 layers, no
sources, a black screen, and a working map replaced by nothing (defect #25).

**Seven new tests had just been written and the whole suite was green.** They
asserted that the style said what this file meant it to say. Not one of them
could tell whether MapLibre would accept it, because every one of them compared
our output against our own expectations — the same shape of mistake as the
readout that reported `cached tiles 0` while 120 features were drawn (D65), and
the probe that measured the glint against nothing (D49).

The fix in the assembly is small: the switch moves inside the interpolate's
outputs, so the crossfade ends at "however much photograph this mode shows"
rather than at 1. It was chosen by running four candidate expressions through
the validator rather than by reasoning about the rule.

**The test that now exists is the point.** `validateStyleMin` is the same code
MapLibre validates with, so it answers the only question that matters: will
this style load? It is asserted to fail on the broken expression before being
kept — a test that cannot fail is not evidence, which this project has already
paid to learn once (D63).

A second case pins the shape that broke it: a style whose layers *already*
carry zoom-dependent paint, which is what every real basemap looks like and
what the hand-written fixture did not.

**The general rule, now stated:** where an authority exists — the style spec's
validator, MapLibre's `MercatorCoordinate`, `globe.gl`'s own screen
projection — ask it. Asserting our own output against our own expectations
tests the transcription and nothing else.

---

## D77 — The basemap's own raster is ground, and we already have ground

**Decision:** `withImagery` drops every `raster` layer the vector style ships,
keeping only the two imagery layers this file adds.

Phone: *"this original mode water seem wrong and unlike before"* — the oceans
had turned a flat grey-lavender while the land still looked like a photograph.

Liberty's **second layer** is `natural_earth`, a Natural Earth shaded-relief
raster at `interpolate(zoom, 0 → 0.6, 6 → 0.1)` opacity. While the build kept
only lines, symbols and extrusions it was discarded silently. D75 changed the
rule to "keep everything and switch it with expressions", and that quietly
promoted a whole second basemap image to drawing **over** our satellite
imagery — 60% opacity of a pale relief map at z2, which is precisely the wash
in the screenshot. It shows on water because water is where nothing else covers
it.

**Why dropped rather than gated.** The fills and the background are switched
off by a paint expression, and that works because their opacity is a constant
we can replace. This raster's opacity is *someone else's zoom curve*, so gating
it would mean reaching inside their expression and rewriting its outputs — the
exact operation that broke the whole style one commit earlier (D76). Dropping
it costs the flat map some relief shading that ride-hailing maps do not have
anyway, and saves fetching a second raster source in **both** modes.

**The fixture had to change before the test meant anything.** The hand-written
style in `planet.test.ts` had no raster layer, so a test asserting "we drop the
basemap's raster" passed against a style that never had one. It now carries
Liberty's shape — relief raster, zoom-curve opacity, its own source — and the
assertion was checked by reverting the filter and watching it fail. Three
defects in three commits have now come from the fixture being simpler than the
real style; that is worth more attention than any of the individual fixes.

---

## D78 — Where the flight started, read off the track rather than asked for

**Decision:** the detail endpoint buys OpenSky's own flight track for the
selected aircraft, uses it in place of our observed one, and infers the
departure airport from where that track begins.

Phone, watching live traffic: *"the plane routes start showing up from when the
web starts running, not from their origin airport they left from."* Exactly
right, and the panel had been saying so in small print since D6 — the route
began when *we* started watching, which for an aircraft selected mid-flight is
an arbitrary point in the sky.

### Two endpoints, and the cheap one is also the reliable one

Measured against the live account rather than reasoned about:

| | Cost | Result |
|---|---|---|
| `/flights/aircraft` | **30 credits** | 404 for two of three aircraft tried |
| `/tracks/all` | **4 credits** | a full path from the runway, for all three |

Both spend the same 4000/day allowance. So the endpoint that returns an
authoritative ICAO departure code is seven times dearer *and* usually silent,
because OpenSky's flight assignment lags well behind its position data.

**So the origin is read off the track instead.** Its first waypoint is on the
departure runway — RXA6681's began 800 m from Sydney Kingsford Smith — and a
nearest-airport lookup over a 28,291-row public-domain dataset turns that into
a name for nothing. Checked against live traffic: **ten aircraft, ten tracks,
nine origins**, at 0.3 to 3.5 km — Brisbane, Boeing Field, Houston, Buenos
Aires, Santa Barbara, Cape Town, Al Maktoum, Athens, Zurich.

### The inference is built to refuse

A nearest-match always returns something if you let it. This one will not:

- **8 km limit.** Tighter loses departures where the first sample arrives after
  rotation; looser starts claiming a flight passing over a town began at its
  airfield.
- **Below 1500 m.** Without it, an overflight at cruise directly above an
  airport reads as a departure from it.
- **`distanceKm` is part of the answer**, so the panel can say "the nearest
  airport to where the track begins, 0.8 km away" rather than asserting a
  departure.
- **`null` when nothing qualifies**, and the panel then says the track begins
  in flight and the origin is unknown. That is the tenth aircraft, and it is
  the same rule the contract applies to a null heading (D18): unknown is a
  value, and inventing one is worse than admitting it.

### The cache is the feature

4 credits is nothing beside the 128 an hour the poller already spends, and
ruinous if it happens per request: the client re-polls the selected aircraft
while it is selected, so an uncached fetch turns one user watching one flight
into a request every few seconds and empties a day in under an hour.

So: two-minute TTL, one in-flight fetch per aircraft behind a lock so a burst
of detail requests buys one answer between them, and **negative results cached
too** — the easy one to leave out, and the expensive one, because a 404 is the
common answer for an aircraft that has just appeared. Four tests count calls;
they are the point of that file.

**A provider failure never fails the request.** The other fields of the panel
are already in hand, and losing them because a secondary enrichment was
rate-limited would be a worse answer than a shorter line.

### What it changes elsewhere

`track_source` is in the contract because the client says something different
for each: three captions, for a provider track with an origin, a provider track
without one, and our own observed track. A caption covering all three would be
true of none. The fixture provider offers no flight history at all and falls
back to `observed`, which is also what the base `Provider` returns — the
capability is optional, and `None` is the honest default.

---

## D79 — Barometric altitude, because that is the altitude aviation means

**Decision:** the OpenSky provider prefers `baro_altitude` and falls back to
`geo_altitude`. It was the other way round.

Phone put Orbital beside Flightradar24 on the same flight, UAE394. Flightradar
said **37,000 ft**; we said **10,317 m**, which is 33,850 ft. Both numbers were
real and one of them was the wrong quantity.

| | |
|---|---|
| `baro_altitude` | 11,277.6 m = **37,000 ft** — what Flightradar showed |
| `geo_altitude` | 10,317.5 m — what we showed |

Three reasons, in order of weight:

1. **Aviation runs on barometric altitude.** A flight level *is* a barometric
   altitude, ATC separates aircraft on it, and every flight tracker displays
   it. Geometric altitude is a GNSS height that nobody in the cockpit is
   flying to.
2. **It is reported more often.** Of 859 aircraft over western Europe, 749
   carried baro and 727 carried geo.
3. **The difference is visible, not academic.** In that same sample the two
   differ by a median of **290 m** and by up to **846 m**.

Geometric stays as the fallback: a real GNSS height beats no altitude at all,
and 110 aircraft in that sample had one when they had no barometric.

### What was not ours

The same comparison showed UAE394 at **12.44 m/s** on a heading of **7°** —
45 km/h, northbound, for a 777 crossing Myanmar eastbound at cruise. That is
OpenSky's own state vector, copied faithfully. Checked against the whole live
store rather than assumed: of **1,711 aircraft above 6 km, 24 (1.4%)** report
an impossible ground speed, and the median cruise speed is a perfectly sane
**238 m/s**. So it is feed noise on individual aircraft, not a systematic
error, and not something a client can correct without inventing data.

Flightradar does not have this problem because it fuses many receivers with
MLAT and smooths the result. We have one feed and show what it says, which is
the same posture the contract takes everywhere else (D18): report what the
source reported, and say where it came from.

---

## D80 — A heading that contradicts its own track loses to it

**Decision:** when the selected aircraft's provider track shows a course more
than 30 degrees away from the reported heading, the track wins, and the panel
says the value was derived.

Phone asked for this after the Flightradar comparison: a 777 crossing Myanmar
eastbound at cruise was reported at 12 m/s on a heading of 7 degrees, so our
marker pointed north while its own line ran east.

### The first attempt was wrong, and the measurement said so

The obvious place is the store: it already holds the previous position of
everything seen twice, so every object could be corrected, not just the
selected one. That was built, and then measured against 3,641 live aircraft
over western Europe with two snapshots 120 seconds apart:

| disagreement between reported heading and course flown | share |
|---|---|
| median | **0.3°** |
| more than 30° | 5.6% |
| more than 90° | 1.3% |

The median says the feed is normally excellent. **The 5.6% is the problem: most
of it is aircraft that turned, not feeds that lied.** The worst offenders were
reporting 8 to 60 m/s — light aircraft and helicopters, which over two minutes
can turn through 180 degrees while the chord between two positions says nothing
about where they are pointing now. A store-wide correction would have
"fixed" hundreds of aircraft that were already right.

So it was taken back out.

### The track removes the ambiguity

The provider's own track samples every **six seconds** (median, measured). Over
six seconds nothing turns far enough for the chord to lie, so the bearing
between two consecutive waypoints *is* the instantaneous course — the same
arithmetic that is unsafe at 120 seconds is sound at six.

The correction therefore lives with the flight history, and applies to the
selected aircraft only. That is a real limitation, stated plainly: an aircraft
you have not clicked still shows whatever the feed said. It is also where the
error is most visible — the 3D model's nose, and a panel that reads out a
compass direction.

The reader walks *backwards* through the track for the most recent pair with a
gap under 30 seconds and at least 200 m between them. Backwards because the
final gap is often the long one: a track ends at the provider's latest sample,
which can be minutes after the one before it.

**Verified live**, on the population most likely to be broken — cruising
aircraft reporting impossible ground speeds. Of six: three corrected, three
left alone.

| | reported | shown |
|---|---|---|
| DXT9686 | 0.0° | 195.6° |
| HVN63 | 70.8° | 326.9° |
| CBJ669 | 97.1° | 281.4° |

`0.0` in that first row is worth noticing: it is the classic "no data" value
dressed as due north, which is exactly the confusion D18 exists to prevent.

### What it refuses to do

- **A null heading stays null.** Unknown is a value (D18, D40), and filling it
  would quietly change what the legend's "heading unknown" disc means. That is
  a separate decision.
- **Small disagreements are left alone**, because the median is 0.3° and a
  correction firing there would be noise replacing signal.
- **It never touches speed.** The same aircraft's 12 m/s is equally wrong, and
  correcting it would mean rewriting a second reported field from the same
  chord. Not done, and worth doing only if the crawling marker becomes a real
  complaint.
- **It says so.** `meta.headingSource = "derived"` and the panel prints "from
  its track", because every other number there is the source's own.

---

## D81 — Ground speed too, on much stricter terms than the heading

**Decision:** the selected aircraft's ground speed is taken from its track when
the reported value contradicts it by more than 50 m/s *and* a factor of two,
and only when the track's own figure is physically possible.

This matters beyond the panel. **The client dead-reckons along the reported
velocity**, so an aircraft reported at 12 m/s crawls between polls while the
thing it represents covers 240 m every second. It is the same field D71 built
the extrapolation cap around.

### The evidence points the other way from the heading, and the design follows it

Measured across **2,971 live aircraft** moving faster than 100 m/s, comparing
reported velocity against the speed implied by their own positions:

| | |
|---|---|
| median difference | **1.7 m/s** |
| reporting under half their observed speed | **0.30%** (9 of 2,971) |

Where the heading is wrong often enough to be worth a broad correction, the
**velocity is nearly always right**. And the worst apparent under-reports were
the trap:

```
48b70c   reported 130.8 m/s   positions imply 1035.1 m/s
a0a54a   reported 244.8 m/s   positions imply  928.0 m/s
4bc8d5   reported 232.0 m/s   positions imply  635.6 m/s
```

Nothing in this dataset flies at Mach 3. Those are **jumped positions**, not
velocity errors, and a naive "the positions win" rule would replace a correct
244 m/s with 928. So the correction carries a plausibility ceiling of 400 m/s —
above any airliner's ground speed with a jet-stream tailwind, far below what a
bad position produces — and refuses to answer at all above it.

Three conditions, all required:

1. the track's speed is **possible** (≤ 400 m/s);
2. it differs from the reported figure by **more than 50 m/s** — the
   track-derived value carries noise of its own, measured at a median of 7.6
   m/s and up to 35.5 across aircraft with sound data;
3. and by **a factor of two**, so a fast aircraft is never corrected for a
   fraction.

### One pair of waypoints, two measurements

The course and the speed are read off the *same* two waypoints, chosen once.
Two functions picking their own pairs could describe two different moments, and
the panel would then show a heading and a speed that were never true together.

**Verified live** on cruising aircraft reporting impossible speeds. CBJ669 was
the case this exists for, and shows both corrections at once:

| | reported | shown |
|---|---|---|
| CBJ669 speed | 1.0 m/s | 211.9 m/s |
| CBJ669 heading | 180.0° | 281.4° |

Two others had their heading corrected and their speed left alone — they really
are slow — and three had neither touched, their data being self-consistent.
That is the conservative behaviour working rather than a weaker result.

`meta.velocitySource = "derived"` sits beside `headingSource`, and the panel
prints "from its track" against either, because every other number there is
the source's own.

---

## D82 — A line is a claim, and not every part of a track is the same claim

**Decision:** waypoints no aircraft could have reached *and* left are deleted,
and any remaining stretch we cannot vouch for — a silence over five minutes, or
a jump that implies over 400 m/s — is drawn as a **thin dashed line** rather
than as track.

Phone, comparing against Flightradar24: a flight crossing Myanmar drew a
V-shaped detour down to Nay Pyi Taw and back, where Flightradar drew a straight
thin line. Two different faults produced that, and they need opposite
treatments.

### Deleted: waypoints that are impossible on both sides

Measured on ten live tracks: **five contained at least one segment implying
over 400 m/s.** A lone bad waypoint is recognisable because reaching it is
impossible *and* leaving it is impossible, and that pair of impossibilities is
what separates it from an honest coverage gap — which is far apart in distance
but proportionally far apart in time, so the speed it implies is perfectly
ordinary. **Testing distance would delete every gap; testing speed keeps them.**

The first and last points are judged by their single neighbour. The first one
matters more than it looks: the departure airport is read off it (D78), so a
spike at the start would name an airport the flight never went near. That hole
existed in the first version of this code and a test found it.

### Drawn thin: everything we cannot vouch for

Cleaning cannot catch a **step change** — where the position jumps once and
everything after it is self-consistent — because only one side of it is wrong.
After cleaning, ten live tracks still carried **fourteen** such segments. And
gaps are ordinary rather than exceptional: **eight of those ten tracks had a
silence longer than five minutes**, one of them sixteen.

Both mean the same thing to a reader: *we do not know how the aircraft got from
here to there.* So both are drawn the same way — one thin dashed line, no
casing, bridging the two ends so the track stays continuous rather than
stopping and restarting.

This is the same distinction the leader already makes between the track and the
aircraft's current position (D72), and the same one the panel makes in words.
A line is a claim; these parts of it are weaker claims, and they now look it.

---

## D83 — Two feeds, and the free one sets the pace

**Decision:** a `union` provider polls **adsb.lol** on every poll and **OpenSky**
once every five minutes, merging both on ICAO24. It runs at a new `union` quota
preset that polls five times faster than the old one while spending a third of
the credits.

Phone asked why aircraft over Myanmar, Mongolia and China were missing, and
then asked whether the free alternatives were better than OpenSky. Measured
before deciding anything.

### Are they better? No. Are they useful? Yes

| | OpenSky | adsb.lol | adsb.fi | airplanes.live |
|---|---|---|---|---|
| access | OAuth2 + registration | none | none | **403, must email** |
| worldwide | 11,651 | 10,009 | — | — |
| W Europe, 250 nm | 1,001 | 996 | 1,041 | — |
| E United States | 592 | 606 | 639 | — |
| **Myanmar** | **22** | 4 | 2 | — |
| **inland China** | 0 | **33** | **36** | — |
| Mongolia | 0 | 0 | 0 | — |

**airplanes.live is closed** — it answers 403 and asks you to email for access.
**adsb.fi cannot answer a global query**: it rejects radii over ~250 nm and
rate-limits after a handful of requests, so covering the world would take
hundreds of calls.

**adsb.lol is not better than OpenSky. It is comparable, with different holes.**
And none of them has KBZ839, the flight that started this — that is an
MLAT-only track, and Flightradar has the receiver density for it while no free
network does. Switching would not have fixed the reported problem.

### So why do it anyway

**Because the holes do not overlap.** Measured on one global fetch of each:

```
adsb.lol            10,260        only adsb.lol      1,585
OpenSky             10,525        only OpenSky       1,850
UNION               12,141        seen by both       8,675
```

**+15% over either feed alone**, and each source contributes about 1,700
aircraft the other cannot see. Myanmar goes from 4 to 20; inland China from 0
to 45; Mongolia from 0 to 5.

**Because the meter is what shaped the design.** The whole polling ladder
(D21, D27) exists because OpenSky costs 4,000 credits a day. adsb.lol costs
nothing, so the union polls it on *every* poll and OpenSky **only on the global
poll, once per supplement interval**. A viewport poll never spends a credit —
it is asked far more often and exists for freshness, which the free feed
supplies.

The result is a cadence the old design could not afford:

| | old (`authenticated`) | new (`union`) |
|---|---|---|
| global refresh | 300 s | **60 s** |
| viewport refresh | 90 s | **30 s** |
| projected credits/day | 3,072 | **1,152** |

Five times faster for a third of the cost, because the fast half is free. The
startup budget guard understands this — `projected_daily_credits` returns the
supplement's cost rather than the poll rate's when the provider is `union`, so
D21's executable budget check stays honest instead of being bypassed.

**Because the free feed carries more.** Registration, aircraft type, IAS, TAS,
Mach, wind and outside air temperature ride along on every request. 9,979 of
the 12,141 union records carry a registration and type, so the panel can say
"Gulfstream G650, N889LV" where it used to say a hex address. OpenSky never had
either field.

### Details that took a measurement to get right

**One request, not four.** The first version swept four 6,000 nm circles
concurrently and earned an **HTTP 420** — adsb.lol's rate limiter — which then
throttled everything for a minute. A single circle from 60N 10E returns
**10,013 aircraft in 1.9 seconds** against 10,009 for the union of four. One
request gets everything, and does not annoy a service that costs nothing.

**Feet and knots.** It is a `readsb` feed: altitude in feet, ground speed in
knots, against a contract in metres and m/s. A missed conversion would put
every aircraft at 3.3 times its altitude and look entirely plausible doing it.

**"ground" is a string where a number belongs**, and the first version let it
fall through to the geometric altitude — putting a parked aircraft at 11,361 m.
A test caught it.

**They fail independently, which is the point.** OpenSky rate-limited leaves
adsb.lol drawing the map; adsb.lol throttled leaves OpenSky. Only both failing
raises, so the store keeps its last good snapshot (D10) rather than being wiped
by a successful-looking empty poll.

---

## D84 — The union froze the map, and a test defended the reason

**Decision:** a viewport poll contributes nothing from the supplement cache,
the metered feed is refreshed every **120 s** rather than every 300, and
adsb.lol's timestamps are measured against the feed's own clock.

Phone, minutes after the union went live: *"we got a bigger problem now, the
planes are not moving"*, and then *"planes started suddenly disappearing when I
zoomed in from z10 to z12, plus the planes' colour changed"*. All three
symptoms, one cause.

### What the log said

```
job=viewport applied=10859
```

A viewport poll — for a box a few kilometres across — was applying **ten
thousand aircraft**. The union was returning its whole cached OpenSky snapshot
for every viewport poll, and the store applies what it is given:

- those records carried **the timestamps they arrived with**, so their
  positions stopped advancing, and the client refuses to dead-reckon a position
  older than two minutes (D71) — the markers froze and faded, which is the
  colour change;
- and because a viewport poll's *primary* only covers what is on screen, every
  aircraft **outside** the viewport had its fresh position overwritten by a
  copy up to five minutes old. The map went stale everywhere except the few
  kilometres being looked at, which is why zooming in made it worse.

**The store never needed the reminder.** It merges a poll into what it holds
and evicts on age (D10); an aircraft it saw four minutes ago is still there
without being re-asserted. `applied` fell from 10,859 to **48**.

### A test defended the bug

`test_a_viewport_poll_still_includes_what_only_it_can_see` asserted exactly the
behaviour that caused this, on the reasoning that an aircraft only OpenSky sees
would otherwise vanish when the user zoomed in. That reasoning was wrong, and
the test was written the same hour as the code, by the same mistaken
assumption. It passed continuously while the map froze.

Tests written from the same misunderstanding as the code cannot catch that
misunderstanding. The measurement that found this was `applied=10859` in a log
line — a number that could have come out the other way.

### Two corrections that came out of measuring the result

**The supplement interval is now shorter than the freeze threshold.** At 300 s,
an aircraft only OpenSky could see spent 60% of every cycle past the
two-minute mark, motionless. 120 s is the largest interval that cannot itself
freeze a marker, and costs 2,880 credits a day — still less than the 3,072 the
OpenSky-only preset spent for a fifth of the refresh rate.

**adsb.lol's ages are measured against its own clock.** `seen_pos` counts back
from the `now` in the payload; subtracting it from *our* wall clock added the
round trip and the skew between machines, and measured a median age of **minus
two seconds** — positions timestamped in the future, in a system where
everything downstream reasons about age.

Measured in a live viewport, before and after:

| | before | after |
|---|---|---|
| positions older than 120 s | 30% | **10%** |
| timestamps in the future | about half | **0** |
| records applied per viewport poll | 10,859 | **48** |

The remaining 10% is honest: OpenSky's own feed carries 7% of positions older
than two minutes, and an aircraft nobody has heard from in three minutes
*should* sit still and fade.

---

## D85 — One circle does not cover a sphere, and the measurement that said it did

**Decision:** the global sweep is four circles, queried sequentially two seconds
apart, and the test asserts spherical coverage rather than a proxy for it.

Phone: *"the planes are stuck for 2-3 minutes sometimes"*, with a screenshot
whose every aircraft was between 138 and 168 seconds old.

### What was wrong

A 6,000 nm radius is about **100 degrees of arc** — a little over a hemisphere.
One circle from 60N 10E reaches Europe, Asia, Africa and North America, and
stops short of Australia, New Zealand, the south Pacific and southern South
America. Aircraft there were refreshed only when OpenSky happened to carry
them, every two minutes at best, so they sat frozen and faded (D71).

Measured directly once the question was asked:

```
SE Australia    global sweep: 0 aircraft    direct query: 27
```

### The measurement that led me wrong

D83 compared one circle (10,013 aircraft) against a union of four (10,009),
and concluded one was enough. **The other three points were inside the first
circle's own coverage**, clustered in the half of the world it already saw, so
they added nothing — and I read "they added nothing" as "one circle sees
everything" rather than "those three were badly placed".

The number was real. The inference from it was not, and nothing about the
number could have told me: a comparison between one circle and four *redundant*
circles cannot distinguish a complete sweep from an incomplete one. It is the
same shape as the control-group error in D63 — a result that could not have
come out the other way.

### The test now asserts the property

Not longitude gaps, which was the first attempt and is neither necessary nor
sufficient: it fails a sweep that covers everything and passes one that leaves
a polar hole. Instead, a grid of points every ten degrees over the whole Earth,
each of which must fall inside at least one circle — **and a control asserting
that a single circle does not**, so the test cannot pass for the wrong reason.

### Sequential, spaced, and tolerant

Four circles at once earns an HTTP 420 and a minute of throttling (D83), so
they are two seconds apart — about eight seconds of a sixty-second poll. One
circle failing is a partial view rather than none: the sweep overlaps, and
refusing the whole poll over one throttled request would throw away three
quarters of the planet. All four failing raises, so the store keeps its last
good snapshot rather than being wiped by a successful-looking empty poll (D10).

### Result

| | before | after |
|---|---|---|
| 90th percentile position age | 843 s | **101 s** |
| positions older than 120 s | 27% | **9%** |
| aircraft over SE Australia | **0** | **30** |
| aircraft over New Zealand | 0 | **19** |
| median age over Laos | ~140 s | **42 s** |

The residual 9% is the honest part: OpenSky's own feed carries 7% of positions
older than two minutes, and an aircraft nobody has heard from should sit still
and fade rather than be flown on a guess.

---

## D86 — Stop drawing aircraft nobody has seen for half an hour

**Decision:** an object is evicted after **300 seconds** without a report,
rather than 1800.

Phone sent two crops of the same aircraft, one bright and one pale, and read
the difference as a zoom effect. It is not: nothing on the aircraft layer
varies with zoom except size. `icon-color` is the altitude ramp and
`icon-opacity` has exactly three values — 0 when a 3D model is drawing instead
(D67), **0.45 when the position is over two minutes old** (D71), and 1
otherwise. The pale aircraft was a faded one, and the zoom was a coincidence of
time passing.

But the reason it kept happening *was* real: **39% of everything served was
past that fade.**

### Why so many

The 1800-second eviction window was set when one feed polled every 300 seconds
and an aircraft could plausibly be missing from a couple of polls. With two
feeds sweeping every 60 seconds, an aircraft absent for five minutes has landed
or left coverage — and we were keeping it for half an hour, drawing it faded
and frozen the whole time. Most of the "aircraft" on a quiet part of the map
were ghosts.

300 seconds is five times the global sweep and two and a half times the metered
refresh, so no aircraft is dropped for a missed poll; and it makes the faded
state mean something bounded — *last seen between two and five minutes ago* —
rather than *somewhere in the last half hour*.

Nothing was needed on the client: it rebuilds its map from each response, so an
object the backend stops sending disappears immediately.

| | before | after |
|---|---|---|
| served aircraft past the 120 s fade | **39%** | **10%** |
| oldest position served | 30 min | 357 s |
| median age | — | 67 s |

### The general point

An eviction window is an assertion about how long a position stays worth
drawing, and it was left over from a polling design that no longer exists. When
the cadence changed by a factor of five, every constant derived from the old
cadence became a guess about a system that had gone.

---

## D87 — The free feed animates the map; the metered one only fills its gaps

**Decision:** the viewport poll runs every **15 seconds** and is served entirely
by adsb.lol; OpenSky is called only by the global sweep, every 120 seconds, and
contributes only what the free feed cannot see.

Phone: *"can we depend on adsb.lol for refreshing planes live for all the
planes available with them, and only depend on OpenSky for the planes not
available with adsb.lol?"* That was already the merge policy — the primary
overwrites the supplement, so a shared aircraft always shows adsb.lol's
position — and after D84 a viewport poll never calls the metered feed at all.
What was missing was speed.

**The viewport job's interval was being chosen as though it cost something.**
It is one request to a free service. Its interval is therefore a question of
what is decent to ask, not of what the credit ladder allows, and 60 seconds of
budget reasoning had been applied to a job with no budget.

At 15 seconds it is four requests a minute. The global sweep stays at 60
seconds because it is four requests rather than one, and because its job is to
keep the parts of the map nobody is looking at from going stale rather than to
animate them.

Measured in a watched viewport over western Europe, 1,022 aircraft:

| | |
|---|---|
| median position age | **2 s** |
| aircraft whose position changed within 20 s | **86%** |
| past the two-minute fade | 7% |

**The credit bill does not move**: 2,880 a day, all of it the global sweep's
OpenSky call every 120 seconds. The dial is that one interval and nothing else:

| OpenSky refresh | credits/day | cost |
|---|---|---|
| 300 s | 1,152 | its exclusive aircraft freeze up to 3 min |
| 180 s | 1,920 | freeze up to 1 min |
| **120 s** | **2,880** | never freeze because of us |
| never (adsb.lol alone) | **0** | lose ~1,850 aircraft, and every departure airport and flight track (D78) |

That last row is the one worth reading twice: flight history is OpenSky's alone,
so dropping it would take the origin airport and the path-from-takeoff with it.

---

## D88 - Where a flight is going, from somewhere that is not a flight

**Decision:** the by-id endpoint enriches an aircraft with the route its
callsign is **scheduled** to fly, looked up in **adsbdb**: free, keyless, one
request per selection, cached six hours including the misses. It is shown as
its own "Scheduled route" section, above the observed path and clearly separate
from it.

### The gap it fills

Every field Orbital has served so far is an observation. There has never been a
destination, and not for want of trying: **no position feed carries one**. An
aircraft transmits where it is, not where it intends to be. Every "DXB -> HAN"
on a flight tracker comes from a schedule database, and until now we had none.

adsbdb also supplies the operator's name outright, where D46 decodes it from
the first three letters of the callsign against a designator table. Reported
beats inferred, so where both exist the published name wins and the caveat
under the field changes from "decoded from the callsign prefix" to "published
against this callsign".

### What it answers

Measured on 60 callsigns sampled at random from the live store:

| | resolved |
|---|---|
| airline-format callsigns (`ABC123`) | **48 / 54** |
| everything else - registrations, GA, military | 1 / 6 |
| overall | **49 / 60** |

The second row is not a failure. `N490SA` is a private aircraft, and a private
aircraft has no published route to find. The 11 that returned nothing simply
have no "Scheduled route" section.

### Scheduled is not observed, and the panel must not blur them

It is keyed by **callsign**, not by aircraft, so it describes what that
callsign is published as flying. A diversion, a callsign reused for a different
sector, or a stale community row each produce a confident wrong answer - the
same failure mode D18 forbids for a heading, arriving through a different door.

So it does not replace the origin inferred from the aircraft's own track (D78);
it sits beside it. Where both exist and agree, that is corroboration - the
first aircraft this was tried on live, AAH40, had an observed origin 1.91 km
from PHNL and a scheduled origin of PHNL. Where they disagree, the observed one
is about *this* flight and wins, and the panel says the schedule disagreed
rather than quietly picking one.

A scheduled airport therefore carries **`distanceKm: null`**. The field means
"how far the track's first point was from here", and a schedule measured
nothing; a zero would assert the aircraft took off from directly overhead.

### Bought like the flight track, and cached like it

One request per aircraft **selected**, never on a poll, on the same reasoning
as D78. Cached six hours, because a schedule does not change mid-flight - and
**cached when it fails**, because roughly one callsign in five has no published
route and re-asking a free service every few seconds for an answer that will
not change is simply rude.

### Two things the tests found

**The 404 body is `{"response": "unknown callsign"}` - `response` is a string
where the success path puts an object.** The first parser did
`(payload.get("response") or {}).get("flightroute")` and would have raised
`AttributeError` on any 200 carrying that shape.

**The suite had started calling a live third-party service.** Every detail test
enriches, so wiring this in silently added several real network calls per run -
0.6 s each, flaky offline, and unkind to a service that charges nothing.
`create_app` now takes an injectable lookup and the tests pass an offline one,
the same way they already inject a fake provider.

---

## D89 - One search box, two lists, and arriving somewhere you can recognise

**Decision:** `GET /api/search` answers a single query with **two separate
lists**, aircraft and airports, and the panel draws them as two groups.
Choosing an airport flies the camera to zoom 11 and **draws a marker on it**.

### Why the backend refuses to rank them together

An aircraft is a thing being watched right now; an airport is a place that is
always there. There is no honest ordering between "the A320 currently over
Bangkok" and "Suvarnabhumi Airport" - they are not more or less relevant to
each other, they are different kinds of answer. A single ranked list would have
to invent a comparison, and every invented comparison eventually puts the wrong
thing first. Two lists cost one extra field in the response and remove the
question entirely.

### Ordering within a list

Airports are matched in tiers - exact code, code prefix, word-prefix in the
name or city, then substring - and **within a tier, airports with an IATA code
come first**. The table holds 28,291 airports and most of them are farm strips.
Someone typing "London" wants Heathrow, Gatwick and City; they do not want
London Ontario's grass runway ahead of them because its name happens to sort
earlier. Having an IATA code is the closest available proxy for "somewhere
scheduled flights actually go".

The word-prefix tier exists because "Don Mueang" and "Mueang" should both find
DMK, but "ueang" should not. Matching on any substring makes every query return
noise; matching only on the start of the name makes half of them return
nothing.

### Arriving is a rendering problem, not a search problem

The first version flew the camera to the airport's coordinates and stopped.
That is correct and useless: the globe rolls, settles over some ground, and
nothing on screen says which patch of it is the airport. **A search result the
user cannot recognise has not been delivered.**

So the answer has two halves. Zoom 11, which is close enough that the runways
are visible on the imagery underneath. And a marker - a halo, a ring and the
airport's name - so the answer is pointed at rather than merely centred.

The label sets `text-allow-overlap: true` and `text-ignore-placement: false`,
which are not the same switch and were confused once. The first says *our*
label draws whatever else is there, which is the point: this label is the
answer to a question the user just asked, and it must never be dropped for lack
of room. The second says whether *other* labels may draw over ours. Left true,
the basemap printed its own place name through ours and produced
"Don Mueang Internatio**DMK**rport".

---

## D90 - An aircraft is drawn the size that aircraft is

**Decision:** every aircraft is drawn at a size derived from **its own
wingspan**, looked up from the `model` designator in a committed table, in all
three places something is drawn: the globe's sprites, the map's sprites, and
the 3D model in both renderers.

### What it replaces

One size for everything. A Cessna 172 and an Airbus A380 were the same number
of pixels, which is wrong by a factor of six in span and is the single most
visible thing a viewer can check against their own knowledge.

### The scale is compressed on purpose, and the table is not

The drawn scale is `sqrt(span / 35.8)`, clamped to [0.7, 1.45]. 35.8 m is the
A320's span - the most common airliner in the sky, so the most common aircraft
is drawn at exactly 1.0 and everything else is relative to a familiar thing.

The square root and the clamp are both deliberate distortions. True linear
scale would draw the A380 at 2.2x the A320 and the C172 at 0.3x, and at that
range the light aircraft is a dot too small to click and the A380 crowds its
neighbours off the map. **Compressing the ratio keeps the ordering true while
keeping every aircraft clickable**, which is the property the display is
actually for. The wingspans in the table remain the real ones; the compression
is applied at the point of drawing and nowhere else, so nothing downstream
inherits a distorted number.

### About a quarter of a live map has no type at all

OpenSky's `/states/all` carries no aircraft type, so `model` is null for
everything OpenSky contributes that adsb.lol has not also seen. Those fall back
to the reference span, which draws them as an A320 - the most likely thing an
unidentified airliner-shaped return actually is. There is no separate "unknown"
size, because a distinct size for "we don't know" would be a claim about the
aircraft, and it isn't one.

---

## D91 - A widebody has to look like a widebody, and the true ratio does not

**Decision:** the 3D airframe's proportions - fuselage girth, length, nose,
wings, tailplane, and the number of engines - come from the ICAO type. Body
girth is set by **size class**, not by the type's true fuselage ratio.

### The measurement that had to be overruled

Real fuselage ratios say the largest aircraft have the *thinnest* tubes
relative to their span: a 777 is longer and far wider-winged than a 737, and
its diameter divided by its span is smaller. Drawn faithfully, a widebody came
out looking spindly next to a narrowbody - which is exactly backwards from what
anyone who has stood next to both would expect, and Phone reported it twice in
the same session before it was believed.

The error was not in the numbers. It was in assuming the ratio was the quantity
a viewer perceives. At the size these are drawn, **what reads as "big aircraft"
is a thick body**, and the true ratio actively works against that.

So girth is interpolated across three size classes - light, narrowbody,
widebody - anchored at spans of 15, 35.8 and 60 m. A widebody's drawn body is
roughly 1.7x a narrowbody's and about 2x a light aircraft's. Length still
tracks the type's real length ratio, but tempered toward 1 so a 747 does not
become a pencil.

### The parts have to meet

Two follow-on defects came from changing girth without changing what attaches
to it. The nose tip was pinned at a constant radius while the body grew, so a
fat body ended in a 19:1 taper - a needle, and Phone described what it looked
like instead. It is now a constant 2.9:1 ratio to the body, so the nose fattens
with the fuselage. Wings, tailplane and engine nacelles are likewise placed
from the body radius rather than from fixed coordinates.

### The rule this is an instance of

**The accurate number and the legible one are often different, and the drawing
has to declare which one it is using.** The table of real dimensions is kept and
remains the truth; the size class governs only what is drawn. Anyone reading the
source finds the real figures and a comment saying why the drawing departs from
them. See D92 for the same trade made again, days apart, in a completely
different part of the view.

---

## D92 - Draw the holes in the map, and draw them as drawn-on

**Decision:** the map draws five **measured** regions where no ground receiver
reports, as hatched areas with a solid blurred edge and a label, hidden above
zoom 5.5.

### The problem is upstream and cannot be fixed here

Phone sketched a grey area over western China and asked why aircraft there are
missing and why aircraft flying into it disappear. They are missing because
**nobody is listening**. Both free feeds are volunteer receiver networks, and
that region has no volunteers.

This was measured before it was drawn, not assumed: adsb.lol returned **0 of
2,052** aircraft inside the band, OpenSky returned **1**, and adsb.fi returned
**0** while a Delhi control in the same run returned normally - so the query was
right and the sky was empty. 19.42 in the test plan covers the search for a
source that does cover it; there is no free one.

### Why it has to be drawn at all

An empty region and a region nobody is watching look identical, and the first
reading is the one a viewer reaches for: *the app is broken*. A limitation that
is invisible is indistinguishable from a defect. Drawing it converts "this is
broken" into "this is a known gap", which is the honest claim and also the more
reassuring one.

### The first version was invisible, and why

A 10% wash with a thin dashed edge, over satellite imagery of a pale desert, is
a photograph of a pale desert. **Subtle is a property of the composite, not of
the layer** - the same wash that reads clearly over ocean vanishes over sand.

The fix was to stop competing with the photograph and sit on top of it: a hatch
pattern generated in code, a solid blurred boundary, and a text label. Hatching
in particular reads as an *annotation* - a human drew this on afterwards -
rather than as something photographed, which is precisely the claim being made.
This is D91's trade in a different medium: accuracy is in the measured polygon,
legibility is in how it is painted.

### One label, not one per tile

MapLibre labels a polygon **once per tile it touches**, so the first version
printed "NO RECEIVER COVERAGE" twice across one region. The label now comes from
a separate point source with one anchor per region, which is also the only way
to control where it sits.

The overlay hides above zoom 5.5. Its claim is about a continent-scale region,
and a continent-scale claim drawn across a city is no longer about anything the
viewer can see.

---

## D93 - Satellites are in scope again, and what that does and does not mean

**Decision:** Orbital gains a **satellite layer**, selectable in place of the
aircraft layer. This reverses D37. It is Phone's decision, made explicitly on
2026-09-01, and the three tripwire tests that existed to force exactly this
moment have done their job.

### Why this is recorded before any code

D37 did not say "later". It said satellites were removed from the plan, that
nothing in the repository was groundwork for them, and that **no document
should describe them as upcoming work**. Three tests enforced it. Every one of
those statements is now false, and until this entry exists the README,
`architecture.md` and D37 itself all contradict the code we are about to write.

The order matters. Writing the guard down before writing the feature is what
separates a change of direction from scope drift.

### What the tripwires were actually for

They were written to be **permanent**, not to be deleted at a sign-off. The
distinction survives this decision: they are not being removed, they are being
**re-aimed at the new boundary**.

| Test | Was | Becomes |
|---|---|---|
| `test_no_satellite_provider_exists_yet` | No provider named "satellite" | No provider serves debris or rocket bodies |
| `test_no_satellite_endpoint_exists_yet` | No path containing "satellite" | No conjunction, collision or re-entry prediction endpoint |
| `exposes exactly one layer` | `LAYERS` has length 1 | `LAYERS` holds exactly the two declared kinds |

A guard that is deleted the moment it fires was never a guard. Re-aiming keeps
the property D37 was really buying: **scope grows only by a written decision.**

### The new boundary

**In scope:** active satellites, on-orbit, drawn on the globe, with a detail
panel describing the orbit. Position is computed from published orbital
elements.

**Out of scope, and these are the tripwires above:**

- **Debris and rocket bodies.** The catalogue holds around 100,000 objects and
  the overwhelming majority are neither satellites nor interesting to look at.
  Drawing them is a different product: a cloud, not a set of objects.
- **Conjunction, collision or re-entry prediction.** SGP4 is a general
  perturbations model. It is accurate to kilometres, degrading with age from
  epoch, and it is emphatically not what anyone should use to say two objects
  will meet. Publishing such a claim from this data would be wrong in a way a
  viewer could not detect.
- **Ground station passes, look angles, and "when can I see it from here".**
  A reasonable feature, and a different one.

### Why this is a smaller change than it looks, and where it is bigger

**Smaller:** the hardest subsystem in this project does not apply. Satellite
positions are **computed, not fetched**. Orbital elements stay valid for days,
so there is no quota, no credit ladder, no throttle, no rate limit, and no poll
cadence to tune. The layer works offline once the elements are cached, which
makes it *more* reliable than the aircraft layer, not less.

**Bigger:** altitude stops being cosmetic. An aircraft at 12 km on a 6,371 km
globe is a 0.2% radial offset (D18). The ISS is 6.6%, GPS is 3.2 Earth radii,
and geostationary is 5.6 Earth radii. Drawn true to scale, the interesting
satellites hug the surface and the far ones are off-screen. That is its own
decision and it is not made here.

### What D37 got right, and keeps

D37 argued that the `type` discriminator and the provider registry were **not**
scaffolding for satellites - that both earned their place on their own terms and
would exist had satellites never been mentioned. That argument stands, and it
is worth noting that it has now been tested twice: the registry took a second
live aircraft feed and then a third entry that is two providers at once (D83),
neither of which had anything to do with satellites.

The discriminator is about to gain its second value. It was still right to carry
it for its own reasons rather than for this one.

---

## D94 - A satellite fits the shape, and `lastSeen` is where it nearly did not

**Decision:** satellites use the same ten-field `TrackedObject` as aircraft.
`type` gains its second value. **`lastSeen` carries the instant the position is
valid for**, which for a satellite is the moment it was propagated - not the
epoch of the orbital elements it was propagated from. The element epoch is a
different fact and lives in `meta`.

### Nine fields map without argument

| Field | Aircraft | Satellite |
|---|---|---|
| `id` | ICAO24 address | NORAD catalogue number |
| `lat` / `lon` | observed | computed for the instant asked |
| `altitude` | metres, about 12 km | metres, 400 km to 35,786 km |
| `velocity` | ground speed | orbital speed, about 7,660 m/s |
| `heading` | reported course | ground-track direction from the velocity vector |
| `label` | callsign | satellite name |
| `model` | ICAO type designator | **null** - see below |
| `type` | `aircraft` | `satellite` |

`velocity` is the one small departure worth naming: the contract calls it
ground speed, and for a satellite this is speed in orbit rather than the speed
of the sub-satellite point across the ground. The orbital figure is the one a
reader expects to see and the one every other source quotes.

### `model` stays null, on purpose

`model` is "what the source says this object *is*, in its own vocabulary". The
catalogue's answer is `PAY`, `R/B` or `DEB` - and since D93 excludes the last
two, every satellite we draw would carry the identical value. A field that is
constant across every row carries no information.

The tempting move is to put the orbit class there instead, so the renderer can
size a satellite the way `model` sizes an aircraft. That would be wrong for a
reason worth stating: **orbit class is something we derive, not something the
source says.** Filling a "what the source says" field with our own arithmetic
is how a contract stops meaning what it claims. Orbit regime is computed from
altitude at the point of drawing, and the operator and object type go in `meta`.

### `lastSeen` is the field that nearly did not fit

The contract says: *when the SOURCE last observed this object, not when we
polled*. A satellite is never observed. Its position is calculated, from
elements that were measured hours or days ago. So there are two candidate
meanings, and they are not close together.

**Putting the element epoch there does not survive contact with the store.**
`store.py` evicts any object where `now - last_seen` exceeds
`object_ttl_seconds`, which is 300 s (D86). Element sets are hours to days old
by design - that is the whole point of orbital elements. Every satellite would
be evicted on the poll that created it, and the layer would render an empty
sky. The frontend would have failed the same way independently: it fades an
object toward a ghost as `lastSeen` ages (D71), so a satellite with a
six-hour-old epoch would be drawn as barely-there while sitting at a position
accurate to a kilometre.

**So `lastSeen` carries the propagation instant**, and the field's real meaning
is the one both consumers already rely on: *how current is this position?* For
an aircraft that is when somebody saw it. For a satellite the position was
computed for right now, so the answer is now - and unlike the aircraft case, it
is exact rather than an extrapolation.

### The fact that gets displaced, and why it still matters

Element age does not disappear; it moves to `meta` and is shown in the detail
panel as when the orbit was last measured. It matters more than it sounds:
SGP4 degrades by roughly a kilometre a day from epoch, and it degrades
**silently**. Given a set from 1975 it returns a confident, precisely formatted,
entirely wrong position.

That is not hypothetical. The SatNOGS feed measured on 2026-09-01 carried 1,670
element sets of which **87 were over a year old and the oldest was from 1975**.
So a freshness cut at ingestion is part of this decision rather than a later
refinement: elements older than 7 days are dropped, which on that sample keeps
1,436 of 1,670. What reaches the client is never dangerously stale, and the
panel shows the age of what did.

### Why not an eleventh field

An `elementEpoch` on the universal shape would be a satellite-specific field on
a contract whose entire discipline is that it has none (D4). `meta` is exactly
where the aircraft layer already puts `originCountry` for the same reason. The
rule holds in both directions or it is not a rule.

---

## D95 - The satellite layer has no poller, no store and no cache validator

**Decision:** satellites are **computed per request** from elements held in
memory. There is no poll interval, no `ObjectStore`, no staleness flag, no
eviction TTL and no ETag. Elements are refreshed by a background task so the
request path still performs no I/O. Both layers run at once; `ORBITAL_PROVIDER`
continues to select the *aircraft* source only.

### Why the aircraft machinery does not carry over

Every piece of the ingestion layer exists because nobody can compute where an
aircraft is. You ask an upstream, you get an answer that was true a moment ago,
and everything downstream manages the consequences: the poll interval buys
freshness, the credit ladder pays for it (D21), the store holds the last good
snapshot so an outage does not empty the map (D24), the TTL evicts what stopped
being reported (D86), and the client dead-reckons between polls so the display
does not stutter at the poll rate (D71).

**A satellite position is computable.** Propagating the entire catalogue
measured **21 ms for 1,432 objects**, against elements that stay usable for
days. So the request can simply answer where things are *now*, exactly, and
every mechanism above becomes something that would make the answer worse:

| Aircraft machinery | Why it is absent here |
|---|---|
| Poll interval | Nothing to poll. Positions are made, not received |
| `ObjectStore` snapshot | Would serve a position that *was* true, when an exact one costs arithmetic |
| `stale` / `ageSeconds` | A computed position has no age. Both are null and `stale` is always false |
| Eviction TTL | Satellites do not stop being reported |
| Client dead reckoning | Linear extrapolation of a 7.6 km/s curved path, when the exact answer is free |
| Credit ladder, throttle | No metered upstream anywhere in the path |

### No ETag, and this one is a trap worth naming

The aircraft list is conditional (D47) and it works because the response only
changes when a poll lands, so `store.updates_applied` is a genuine version.

A satellite list changes **on every request, by design**. A validator therefore
has exactly two possible outcomes: a 200 that it did not help with, or a 304
that hands the client back its own older body - which freezes the sky. That
second outcome is not a hypothetical: it is **defect #14**, where a 304 froze
the status bar's data age at a few seconds because the cached body was returned
instead of a current one. Adding an ETag here would rebuild that defect on
purpose, in a place where its symptom (satellites that stop moving) looks like
a rendering bug rather than a caching one.

### The request path still does no I/O

That property is what makes an upstream outage degrade freshness instead of
producing 5xx, and it is worth more than the small simplification of fetching
inline. So the provider is split: `refresh()` may touch the network and runs on
its own task; `positions()` is synchronous, network-free, and is what the route
calls. The invariant holds by construction rather than by timing.

This is not a theoretical concern either. CelesTrak returned 503 for the entire
day this was built, and at one point both it and the SatNOGS fallback were
failing within the same minute. The layer kept serving 1,432 satellites.

### Both layers at once

The toggle has to switch between two things that are already there, so the
satellite catalogue is created beside the aircraft provider rather than instead
of it. It can afford to be always-on precisely because of everything above: one
background task and a few hundred kilobytes of elements, no credentials and no
quota. `ORBITAL_SATELLITE_LAYER_ENABLED=false` turns it off for a deployment
that should make no outbound calls at all.

`ORBITAL_PROVIDER=satellites` still exists in the registry, and is now only
useful for running the layer standalone.

### What the frontend needed

One line. `LAYERS` gained an entry, and the polling hook builds its URL from
`resource` without knowing what is behind it - so the toggle, the viewport
query and the selection all worked unchanged. D19 kept that abstraction
deliberately thin on the grounds that a richer one built before a second layer
existed would be fitted to an imagined use case. The second layer arrived four
months later and the thin version fitted it.

---

## D96 - Satellites are drawn on a logarithmic shell, and satellite mode is a different subject

**Decision:** the globe draws satellites at a **log-compressed** height above
the surface rather than at true altitude, and satellite mode **suppresses
aircraft furniture** rather than adding satellites to the aircraft view.

### Why the aircraft answer does not transfer

`MARKER_ALTITUDE` puts every aircraft on one uniform shell 0.012 R up, and says
plainly why: a cruising airliner is 0.2% of Earth's radius above the ground, so
an honest height would put the marker inside the surface texture. Altitude is
carried by colour there instead.

Satellites cannot do that, because **height is the information**. The
difference between a Starlink and a GPS satellite is mostly how far out it is.

### True scale is not an option, measured against the live catalogue

The 1,432 satellites served on 2026-09-01 spanned **0.010 R to 16.39 R**. The
orbit controls stop the camera at 8 R from the centre, so at true scale:

- everything past geostationary is **outside the camera's reach entirely** -
  invisible at the exact moment the user asked to look at satellites;
- and 1,390 of the 1,432 are in low orbit, collapsing into a film on the
  surface where the ISS and a 2,000 km orbit are indistinguishable.

Both ends fail at once. Compressed, the same catalogue occupies 0.096 R to
1.268 R, with the furthest object 2.27 R from the centre - the whole
constellation visible at the default zoom.

### Logarithmic, not banded

`shell = 0.05 + 0.203 * ln(1 + km / 260)`, solved against two anchors: the
Starlink shell at 550 km lands at 0.28 R, geostationary at 1.05 R.

Banded shells (a LEO ring, a MEO ring, a GEO ring) were the obvious
alternative and are wrong for one reason: they are not **strictly monotonic**.
Two satellites at different altitudes inside the same band would be drawn at
the same height. The single claim this drawing makes is *higher on screen means
higher in orbit*, and it should never be false. A logarithm keeps it true
everywhere, including across the 1,390 objects crowded into low orbit.

This is D91 and D92's trade for a third time: the accurate number and the
legible one differ, the drawing chooses legibility deliberately, and the real
altitude stays in the data where the panel shows it.

### Satellite mode is a mode, not a layer of dots

Phone's instruction was that satellites should not be mixed with airports -
that this is another mode, switched like a view filter. Two things follow, and
the first is a correctness matter rather than a preference:

**The 3D airframe must not draw for a satellite.** The selection mesh is an
aeroplane: fuselage, wings, tailplane, engines, proportioned by ICAO type
(D91). Handing it a satellite would draw an airliner in orbit - a confident,
detailed claim about the shape of something we have no shape for. Satellites
keep the disc, for the same reason an aircraft with no heading does (D18, D40,
D42): a shape that commits to something unknown is worse than one that does
not.

**Airport labels are suppressed.** An airport is aircraft furniture, and a
globe covered in runway codes while the user is looking at orbits mixes two
subjects with nothing to do with each other. Country and city names stay:
"what is it passing over" is the question an orbit view is actually asking.

The suppressed set is part of the label layer's cache key, or a mode switch
would keep serving the candidate list built for the other mode until the zoom
happened to change - present, correct, and invisible until you moved.

---

## D97 - Satellites on the map show where, not how high

**Decision:** the planet view draws satellites as their **sub-satellite point**
- the spot on the ground each one is directly over - as coloured circles, with
altitude carried by colour and orbit regime by size. Aircraft furniture is
hidden while the mode is active.

### Why the globe's answer cannot be reused

D96 draws satellites at a log-compressed *height*, because on a globe height is
available and it is the information. **A map has no room above it.** MapLibre's
symbol and circle layers draw on the surface, and its camera sits roughly
10,000 km up at world zoom - a geostationary satellite at 35,786 km would be
behind the camera, not above the map.

So the map answers a different question, and should answer it well rather than
answering the globe's question badly. "What is passing over me right now" is a
real question and the sub-satellite point is exactly its answer. "How high is
it" is not available here, and the panel is where that number lives.

Phone chose the planet view over the globe for a reason worth recording: **the
globe has no imagery, roads or place names**, so a satellite over it is a dot
over an unidentifiable patch of ground. On the map you can see what it is
passing over, which is most of the value of a ground track.

### Colour by regime, not a continuous ramp

97% of the catalogue is in low orbit - 1,389 of 1,432 in the measured sample.
A continuous altitude ramp would render almost everything the same shade and
waste the only channel available. Four regime colours running cool to warm with
altitude keep the ordering readable without a legend, and give the 43 objects
above low orbit somewhere distinct to sit.

Size follows the same reasoning in reverse: the high orbits are drawn slightly
larger not because they are bigger but because there are forty of them among
fourteen hundred, and they need to stay findable.

### Circles, not silhouettes, and no airframe

A satellite is not an aeroplane. The aircraft sprite is a silhouette and the
3D selection mesh is a full airframe proportioned by ICAO type (D91); either
one applied to a satellite is a detailed, confident claim about a shape we do
not have. `modelTarget` refuses satellites outright, which matters because the
existing no-heading guard would *not* have caught it - a satellite has a
perfectly good heading.

### The toggle had to be gated before it was built

Wiring the layer switch globally while the drawing existed in one renderer only
created a real defect for a few minutes: selecting satellites on the map would
have fetched 1,432 objects and handed them to the aircraft symbol layer, filling
the screen with airliners at each sub-satellite point. `layersForView` was added
to withhold a layer a renderer cannot draw, and now returns everything because
both can.

The lesson is small and generalisable: **a control that offers a capability the
renderer lacks is not a missing feature, it is a wrong answer** - the data still
arrives and something still draws it.

### What is hidden in satellite mode

Airport markers, the receiver-coverage annotation, and the observed track with
its leader line. The first two are statements about aircraft tracking (D89,
D92). The third is subtler and matters more: a track drawn for an aircraft is
the path *we watched it fly*, and a satellite's path is computed rather than
observed - drawing the same line would claim something nothing here supports.

---

## D98 - The satellite panel answers different questions, and omits the ones that do not apply

**Decision:** selecting a satellite renders its own set of rows - catalogue
number, orbit regime, true altitude, speed, period, inclination, element age
and source - rather than the aircraft panel with blanks in it. Rows that cannot
be filled are **left out**, not shown empty.

### Why not reuse the aircraft panel

It asks for airline, aircraft type, wingspan, registration, departure airport
and scheduled route. A satellite answers none of them, and there is no version
of it that could. Rendering those labels with empty values would say *we are
missing this data*, when the truthful statement is *that question does not
apply here*. Those are different claims and the second one is made by leaving
the row out.

### This is where the true altitude lives

Both renderers distort altitude deliberately: the globe compresses it
logarithmically so geostationary fits inside the camera's reach (D96), and the
map drops it to colour because a map has no height at all (D97). Those were
defensible only on the condition that the real number stays somewhere, and this
is that somewhere. The row says so in as many words - "true altitude; the view
compresses it to fit" - because a reader comparing the number against the
picture is entitled to know which one is the measurement.

That is the third time this project has taken the legibility side of that trade
(D91, D92, D96) and the first time the accurate value has had a place to be
displayed rather than merely retained in the data.

### Numbers are converted to the form their readers use

Speed becomes km/s: 7,658 m/s is unrecognisable, 7.66 km/s is a figure anybody
can check. Altitude becomes kilometres with thousands separated, because it
runs to six digits. Period reads as minutes below two hours and hours above.

### Inclination is given with what it means

51.6 degrees tells most readers nothing. What it *tells* you is the band of
latitudes the object can ever be over, so the row carries "never passes north
of 52° or south of -52°" beside it. Retrograde orbits are handled properly: a
sun-synchronous satellite at 98 degrees reaches 82, not 98, and reporting the
raw figure would claim it passes over a latitude that does not exist.

### The most important row is the least obvious

**Element age.** SGP4 degrades by roughly a kilometre a day from epoch and does
so *silently* - the position stays precisely formatted while becoming wrong.
The ingestion layer already refuses anything past seven days (D94), so what
reaches the panel is usable; this row says how usable, in kilometres of drift
rather than in days, because the drift is the thing the reader actually cares
about.

### One list owns every key it renders

`SATELLITE_META_SHOWN` names the meta keys the rows above already display, so
the generic renderer skips them. That is defect #33 exactly: registration and
aircraft type had labelled rows *and* came back four rows later from the
generic list, and one fact read as two.

---

## D99 - The two renderers stop chasing parity, and the globe stops being a deletion candidate

**Decision:** the **map is the primary view** and the **globe is kept for what
only it can do** - altitude as a real axis. Feature parity between them is
**explicitly abandoned as a goal**. The airport marker is *not* ported to the
globe, and the globe is no longer scheduled for deletion.

### What this replaces

D54 introduced the MapLibre view beside the globe with the stated intent of
reaching parity and then deleting `src/globe/`. Every session since has
recorded the gap between them as a debt, and this entry was very nearly one
more instalment of that: "port the airport marker to the globe" sat in the
handoff's open list for two sessions as though it were obviously owed.

Phone asked why. There is no good answer, and the question exposed that the
premise had quietly stopped being true.

### Why the debt was not real

**The globe was going to be deleted**, so anything ported into it is written
once and thrown away once.

**And in satellite mode the globe hides airports on purpose** (D96) - Phone's
own instruction not to mix satellites with airport furniture. So the marker is
not a missing feature there; it is a thing that would be suppressed the moment
the view is used for its purpose.

Both arguments point the same way, and neither was noticed while "the globe is
behind" was being repeated as though it were a fact rather than a leftover.

### What changed underneath

Yesterday the globe's only distinguishing property was being the older one.
Satellites gave it a real one: **altitude is a real axis on a globe and does
not exist on a map.** Measured against the live catalogue, true orbital
altitudes span 0.010 to 16.39 Earth radii; the map answers a different question
entirely, showing the sub-satellite point with altitude reduced to colour
(D97).

Phone's reason for preferring the map is equally real and pulls the other way:
*"with globe, we cant see any info of our planet locations"* - the globe has no
imagery, roads or place names, so an object over it sits above unidentifiable
ground.

Neither view is better. They answer different questions, and each is
**worse at the other's question in a way no amount of porting fixes.**

### So parity was the wrong goal

Two renderers converging on the same feature set means every feature is built
twice and the pair is never finished. Two renderers that have *stopped* doing
the same job need no parity at all - the question "is the globe behind?"
dissolves rather than being answered.

The map is where the work goes, because it is the view being used and the one
that can say where something is. The globe stays for the orbit picture. What
each lacks of the other's furniture is now a **property of the split**, not a
backlog.

### What this does not license

It is not permission to let them drift arbitrarily. Anything in the **shared**
layer below the renderers - the data contract, `wingspan.ts`, `airframe.ts`,
`satelliteShell.ts` - stays shared and stays consistent, because that is where
correctness lives. This is about *furniture*: airport markers, coverage
overlays, basemap controls. Divergence there is now expected and does not need
recording as a defect.

**Revisit if:** the globe stops being used at all for a whole phase, at which
point deleting it becomes the honest move again.

---

## D100 - The chrome names the layer, because chrome is where a viewer finds out what they are looking at

**Decision:** the wordmark subtitle, the search placeholder, the object count,
the key, and the freshness line all follow the active layer. They are built
from one table (`layerChrome.ts`) rather than branched inside five components.

### What it looked like when they did not

Phone's screenshot of the working satellite layer, 2026-09-01. The dots were
right. Everything around them was still describing aircraft:

| On screen | Actually |
|---|---|
| "LIVE AIRCRAFT" | satellites |
| "Search callsign or airport, e.g. UAL1234 or LHR" | neither exists in orbit |
| altitude ramp: ground / 6 km / 12 km | objects at 420 km to 35,786 km |
| "Heading known - nose points along the track" | no aeroplanes present |
| "364 aircraft" | 364 satellites |
| "data age never" | a computed position has no age |

**This is not cosmetic.** Chrome is where somebody looks to find out what they
are looking at, so chrome describing the wrong subject is a false statement in
the place a viewer is most likely to believe it. "364 aircraft" over a field of
satellites is simply wrong, and "data age never" reads as a fault rather than
as a question that does not apply.

### The key had a substantive problem, not just wrong words

The altitude ramp spans ground to 12 km. A satellite is three orders of
magnitude past its top, so `altitudeColor` saturated and **every satellite on
the globe was drawn the same cyan** - a whole visual channel spent saying
nothing. Rescaling the ramp would not have helped either: 97% of the catalogue
is in low orbit, so a continuous scale still lands almost everything on one
colour.

So satellites get **discrete bands** by orbit regime, and the colours moved
into `satelliteShell.ts` where the globe, the map and the key all read the same
table. Three places show these colours; if they disagree, the key is lying
about the picture.

Each band is labelled with an altitude rather than an abbreviation. "GEO" tells
a reader nothing; "Geostationary - 35,786 km" tells them what they are seeing.

### Why one table rather than five conditionals

Five components each testing the layer is five places to forget. The table also
makes the whole set readable at once, which is how the missing pieces were
found - the count noun and the freshness line were not in the original request
and turned up only because everything was written down together.

And it is testable without rendering: this project has no component-render
harness, so presentation judgements are extracted and tested as data, the same
way `routeSummary`, `panelFields` and `satelliteFacts` are.

The strongest test is the blunt one - **no string shown in satellite mode may
contain "aircraft", "callsign", "airport" or "heading"** - which would have
caught every row of the table above in one assertion.

---

## D101 - Satellites are drawn as the machines they are, and unidentified ones are not

**Decision:** each satellite is drawn with a silhouette chosen by its
**spacecraft family**, matched from its name. Colour still carries orbit
regime, so **shape says what it is and colour says how high it is** - two
channels, two facts. An object the catalogue has not identified gets a plain
dot and no invented machine.

### What a circle was costing

The first map layer drew every satellite as a circle (D97), which says an
object is here and nothing else. But the differences are real and visible in
the names the catalogue already gives us: a Starlink has one flat panel, a
navigation satellite a symmetric pair, the ISS a truss with four arrays, and
Cluster II is a spin-stabilised drum with none at all. Those are genuinely
different machines, and the silhouette is how a viewer tells them apart without
clicking anything.

Six families, plus one for the unidentified:

| Family | Silhouette | Why that shape |
|---|---|---|
| Crewed station | truss, four arrays | the largest thing up there, and the only paired-axis layout |
| Communications constellation | body plus one array | Starlink's defining asymmetry |
| Navigation | symmetric pair plus nadir mast | built to point at a whole hemisphere |
| Earth observation | body, one array, downward instrument | nadir-pointing in low orbit |
| Geostationary comms | two arrays plus a dish | the dish is what separates it from navigation |
| Science mission | drum with booms, no arrays | spin-stabilised, body-mounted |

### Matched on the name, because that is all there is

`model` is null for every satellite by decision (D94): the catalogue's own type
field reads `PAY` for everything we draw, so it carries no information. The
name does - `STARLINK-4621`, `NOAA 19`, `ISS (ZARYA)` - and it is what the
label already shows, so the picture and the text agree by construction.

### The unidentified case is the point, not the leftover

The live catalogue is full of `OBJECT AN`, `OBJECT C`, `OBJECT W` - objects
tracked but never identified. Drawing one with panels and a dish would be
**inventing a machine**. They keep a neutral dot, which claims only that
something is there.

The explicit `OBJECT` prefix beats every family pattern, deliberately: debris
from a Starlink launch is catalogued as an `OBJECT` and is not a Starlink. An
unmatched name falls through to unidentified rather than being guessed at, so
the shapes stay informative instead of decorative.

This is the third instance of one rule in this project. An aircraft with no
heading gets a disc rather than a silhouette (D18, D40). A satellite is refused
the airframe mesh even though it has a heading (D96). And now an unidentified
object gets a marker rather than a spacecraft. **A shape that commits to
something unknown is worse than one that does not** - it is a claim the viewer
has no way to check.

### Where the classification lives

`satelliteFamily.ts` sits beside `satelliteShell.ts` in the shared layer, not
in `src/planet`, for the same reason `wingspan.ts` is shared while
`airframe.ts` is not: *which family this is* is a fact about the object, while
*how to draw it* belongs to a renderer. The detail panel reads the same
function the sprites do, so the panel and the picture cannot disagree.

---

## D102 - "We have not classified it" is not "nobody knows what it is"

**Decision:** a satellite whose family we cannot place from its name is drawn
as a **generic spacecraft** and called a **Satellite**. `unidentified` is
reserved for what the *catalogue* cannot name - `OBJECT`, `TBA`, `UNKNOWN`.

### The defect

D101 returned `unidentified` for every name that missed the pattern list. On
the live catalogue that was **1,008 of 1,432 objects - 70.4%**. Phone clicked
one and asked what it was: CUBEBUG 1, NORAD 39153, an Argentine cubesat with a
name, a catalogue number and a mission. The panel said "Unidentified object".

So did NEMO-HD, METEOR M2-2, ES'HAIL 2, DIWATA 2B and ALSAT 1N. Every one of
them is identified. What they lacked was an entry in **our** list, which is a
fact about this code and not about the spacecraft.

**The label was making a claim about the world when it could only make one
about itself.** After the split: 18.5% genuinely unidentified, 81.5% named -
which is what the catalogue actually looks like.

### The pattern list is permanently partial

There are tens of thousands of satellite names and no authority publishing a
family for them. So the generic case is the **normal** case, not a failure, and
it has to look like one: a plain body with two stubs, unmistakably a
spacecraft, committing to nothing about which kind. The dot stays for the
objects nobody has named.

This does not weaken D101's rule - it sharpens it. A shape that commits to
something unknown is still worse than one that does not. The correction is that
"a satellite of some kind" was *known* all along, and refusing to say it was
its own kind of wrong answer.

### The shapes were also unreadable, which the same screenshot showed

Six silhouettes came back as identical grey rectangles. MapLibre renders these
as SDF so `icon-color` can tint them, and an SDF shader treats alpha as a
*distance field* while what it is handed here is a plain mask: fine detail does
not survive. The first draw had a 10 px truss and 4 px slots cut into the solar
panels, which at the ~25 px they render at blurred into one blob.

Redrawn with nothing thinner than a tenth of the cell, no interior cut-outs,
and at least 10 px between parts. What has to survive the downscale is the
*arrangement* - how many panels, which side, is there a dish.

### The selection marker had the same cause

Selecting a satellite at low zoom drew a **solid white square** behind it.
Same root: `icon-halo-width` on an SDF icon needs a real distance field to fall
off through, and with a plain mask there is no gradient, so the halo floods the
whole icon cell. The smaller the icon, the more of the cell was square - which
is why it showed at z1-z5 and not close in.

Selection is now a **ring drawn underneath** the icon: a circle layer filtered
to the selected feature, hollow so the silhouette shows through, sized by zoom.
Geometry rather than a shader trick, so it behaves identically at every zoom.

The general lesson is the one the halo and the blurred silhouettes share:
**an SDF icon is not an image with a colour applied.** Anything that relies on
the alpha channel meaning *distance* - halos, thin detail, sharp corners - will
misbehave when the alpha channel actually means *inside or outside*.

### A tooling note worth keeping

The fix was briefly defeated by a **literal backspace character**. Writing
`\b` through the shell into the source produced `0x08` rather than a regex word
boundary, so `/^(OBJECT|TBA|UNKNOWN)\b/` matched "OBJECT" followed by a control
character and therefore nothing at all. `grep` renders `0x08` invisibly, so the
line looked correct; `cat -A` showed `OBJECT^H`.

The check is now plain `startsWith` comparisons with no escapes in it, and a
sweep confirmed no other source file carries stray control characters. **When a
regex looks right and behaves as though it is not there, check the bytes.**

---

## D103 - The search box searches the layer you are in

**Decision:** `/api/search` returns a third list, `satellites`, and the box
shows the results and the remembered searches that belong to the **active
layer**. Enter picks from the group that layer can act on.

### The bug that made this obvious

Phone typed in satellite mode and got airports back. Worse than untidy: **"ISS"
matched WISCASSET**, a Maine airfield whose IATA code happens to be ISS. Search
for the space station, get an aerodrome - and the recent list underneath was
still offering BKK, DMK and Yangon.

Two failures with one cause. The search box was aircraft-layer furniture that
the satellite mode inherited without anyone deciding it should.

### A third list, not a merged one

`SearchResponse` gains `satellites` beside `aircraft` and `airports` rather
than folding them together, for the same reason those two are separate (D89):
they are different kinds of thing, and a single ranking across them invents a
comparison that does not exist. Now demonstrably so - the aircraft layer's
ranking would have put an airport above the ISS.

### Searched against elements, not positions

`SatelliteProvider.search` scans the **held element sets** by name and
catalogue number, then propagates only the matches. A keystroke costs a string
scan over 1,670 names instead of propagating the whole catalogue, and the
tiering is the airports' (D89): exact catalogue number or name first, then a
name that starts with the query, then one that contains it. "ISS" now returns
`ISS (ZARYA)` and `ISS (NAUKA)` before `SWISSCUBE`.

### Remembered searches belong to a layer

Aircraft and airports are aircraft-layer entries; satellites are not. Offering
an airport under a satellite search box offers an answer the box cannot give,
and **choosing it would throw the user out of the layer they are in** - it
would fly the camera to an airport with no aircraft drawn.

They stay in one stored list, filtered at the point of display. Splitting the
storage would lose entries on a layer switch and make the "last few things you
searched for" claim false in a different way.

### Only the layer's own results are shown, and choosing one goes there

Two follow-ons, both reported by Phone after the first pass.

**The backend returns all three lists; the box shows one.** Adding satellites
was not enough while aircraft and airports were still rendered beside them -
`ISS` still offered WISCASSET, just further down. In satellite mode the box now
shows satellites only, `Enter` picks from that group, and the "no match"
wording asks for a satellite name or catalogue number rather than explaining
how aircraft tracking works. The endpoint is left returning everything: it is
cheap, and a `kinds` parameter would couple the API to which layer a client
happens to be showing.

**A chosen satellite is flown to, at a zoom that suits something moving.** The
airport fix (D89) flies to zoom 11 so the runways are visible, and reusing that
here would be wrong: an airport does not move, while a low-orbit satellite
crosses the ground at 7.6 km/s and would leave a zoom-11 viewport in under
three seconds - the search would appear to have flown somewhere empty.
`SATELLITE_ZOOM` is 4, about 5,000 km across, so it stays in view for roughly
ten minutes.

It is also **selected**, which an airport deliberately is not: an airport is
not a tracked object and a panel opened on one would have nothing honest in it,
whereas a satellite is, so the panel fills and the selection ring marks which
dot was asked for.

### The rule underneath

This is D100 again, one level deeper. That entry fixed the chrome *describing*
the wrong subject; this one fixes a control *acting on* the wrong subject.
Words that name the wrong layer mislead; a control wired to the wrong layer
takes the user somewhere they did not ask to go, which is worse.

**Everything the active layer offers should be something that layer can
answer.** The layer toggle, the key, the panel and now the search box all
follow from that.

---

## D104 - The globe is deleted

**Decision:** `src/globe/` and `src/city/` are removed. MapLibre is the only
renderer. `VITE_VIEW` is gone; there is nothing left to choose between.

This reverses D99, which was three hours old.

### D99 was wrong, and it is worth being precise about how

D99 kept the globe on the grounds that **altitude is a real axis on a globe and
does not exist on a map**. The premise was false. The planet view is not a map:
`basemap.ts` sets `projection: { type: 'globe' }`, so it is a sphere at low
zoom. And it already draws 3D geometry standing off the surface -
`modelLayer.ts` puts the selected aircraft's mesh into MapLibre's own GL
context, lifted on a tangent frame by `modelFrame.ts`.

So the geometry was never the obstacle. The remaining question was the
**camera**: MapLibre's zoom floor is 0, where the globe fills the frame, and an
orbital shell needs the sphere to shrink so there is room around it.

Phone tested it in thirty seconds by setting a negative minimum zoom. At z-2
the globe is a speck; at z0.8 it sits small in an empty frame. There is room.

**The thing I called decisive was answerable by looking, and I had written a
decision around it instead.** That is the same error as D99's other half -
keeping a feature whose value had never been observed - and it is the error
this project has a standing practice against.

### What the globe was actually offering

Nothing the map cannot do, and several things it did worse: no imagery, no
roads, no place names, mush past z9 (D53), no family silhouettes for
satellites, and a fly-to that landed on anonymous ground because the label
budget draws no airports at that altitude.

Phone's summary was the whole argument: *"with globe, we cant see any info of
our planet locations."* An object over an unidentifiable patch of ground is a
worse answer to "where is it" than the same object over Nigeria.

### What it cost to remove, and what it saved

Six things in `src/globe/` were genuinely shared and had to be lifted out
first - the deletion was never `rm -rf`:

| Moved to | What |
|---|---|
| `src/interpolate.ts` | dead reckoning, `toRenderable`, `STALE_AFTER_SECONDS` |
| `src/sun.ts` | the subsolar point, for the terminator |
| `src/altitudeColor.ts` | the altitude ramp, read by the symbols, the model and the key |
| `src/planet/aircraftSprite.ts` | the silhouette and disc canvases |

Then removed: **7,235 lines** of renderer, four of the five Earth textures, the
whole geography pipeline, and five packages (`globe.gl`, `d3-geo`,
`topojson-client`, `all-the-cities`, `@nwpr/airport-codes`, `world-atlas`).

| | Before | After |
|---|---|---|
| Generated assets | 4.5 MB | 852 KB |
| App bundle | 2.1 MB | 774 KB |

`three` **stays**: the airframe mesh and the terminator both use it, drawn
inside MapLibre. `three-globe` stays as a devDependency for one reason - it is
where the night-lights texture comes from - which looks odd and is still better
than committing a 700 KB binary against D30.

### What was really lost

**The frontend is no longer offline.** The globe drew a sphere from committed
textures and needed no network at all; the map fetches basemap tiles. The
backend is still fully offline on the fixture provider, so development without
credentials still works, but the claim in the README had to be narrowed rather
than restated. That is the one genuine cost, and self-hosting tiles (D7) is
still the answer if it ever matters.

**And the satellite altitude view does not exist right now.** Deleting before
building the shell leaves a window with no altitude picture at all. Phone chose
that deliberately after being told; git has the globe if it turns out to
matter.

### What stops being a question

The parity worry that ran through four sessions - the globe is behind, the
globe needs the airport marker, should features be built twice - is not
resolved, it is **dissolved**. There is one renderer. Nothing can be behind.

---

## D105 - The altitude shell, rebuilt on MapLibre

**Decision:** satellites are drawn at height as a custom layer in MapLibre's own
GL context, standing off the planet on the log-compressed shell from D96. The
sub-satellite symbols and the shell are two drawings of the same objects, so
exactly one is on at a time: the shell while the whole planet is in frame
(zoom <= 3.2), the ground points past that.

### Why this is possible, given D97 said it was not

D97 claimed "a map has no room above it". The planet view is not a map:
`basemap.ts` sets `projection: { type: 'globe' }`. Two facts make the shell
work, and both were already true when D97 was written:

- **The globe frame projects a unit sphere.** `modelFrame.ts` documents this
  from MapLibre's own vertex shader: a vertex is a direction from the centre,
  and altitude is a radial scale of `1 + metres / 6371008.8`. `shellFor`
  already returns globe radii above the surface, so the conversion is **one
  addition** - `up * (1 + shell)`. Nothing had to be derived.
- **The camera goes below zoom 0.** The default floor is 0, where the globe
  fills the frame and there is no room around it. Phone tested a negative
  minimum in thirty seconds: at -2 the globe is a speck. The floor is now -1.6.

Neither needed research. The first is written in a file in this repository and
the second is a slider. D99 and D104 both turned on this and I had reasoned
about it twice instead of looking.

### What it costs: picking

A symbol layer is hit-tested by MapLibre for free. A custom layer is not, and
that is the real price of drawing at height.

`pick()` answers from the positions **the last frame projected**, not from
positions re-derived at click time. Those would disagree: satellites move at
7.6 km/s and the frame loop runs between clicks, so re-deriving would hit-test
against a position that was never on screen.

The tolerance has a floor of 8 px regardless of the drawn size. Defect #5 was
exactly this failure on the globe - a pick radius so tight that clicking a
marker did nothing - and a 3 px dot at world zoom is unclickable at its own
radius.

### Occlusion is deliberately conservative

A satellite behind the planet is culled with the same clipping plane
`modelLayer` uses. That plane cuts the far hemisphere at the *surface* horizon,
so an elevated point is hidden slightly before the planet truly covers it.

Wrong in the safe direction. The alternative error - a satellite showing
through the Earth - reads as a rendering bug, while a satellite disappearing a
fraction early at the limb reads as it going round the back, which is what it
is doing.

### What is verified and what is not

Verified: the geometry, the handover zoom, the frame selection, and that all
three fail when broken. The radial ordering matches the orbits, the whole
catalogue including Cluster II at 16.4 true radii lands inside 2.4 drawn radii,
and a latitude/longitude swap fails the direction tests.

**Not verified: anybody has looked at it.** No test in this project can render
MapLibre, so the shell is pinned by arithmetic and nothing else. That is the
same position the globe's version was in when D99 defended it - and the reason
that decision was wrong. This entry should not be read as evidence the picture
is good, only that the geometry is right.

---

## D106 - The shell draws the same silhouettes the map does

**Decision:** satellites on the altitude shell are drawn as their family
silhouette rather than as plain dots, sampled from a texture atlas built by the
same code that draws the map's symbols. Point size rises from 3-7 px to
10-20 px, because a silhouette that cannot be read is not a silhouette.

### Why the shapes disappeared

D101 gave every satellite a shape by family. D105 built the shell as GL points
with a round fragment shader. Nothing connected the two: MapLibre's symbol
layer takes images through `map.addImage`, and a point sprite in a custom layer
samples a *texture*. Same shapes, two entirely different delivery mechanisms.

So the shell showed the constellation's **structure** - which is what it is
for - while throwing away what each object **is**, which the flat view had.
Phone's report was exactly that: the icons are gone in this state.

### One table, two consumers

`createSatelliteAtlasCanvas` lays the same `DRAW` functions into one strip, one
cell per family. It is not a second set of drawings: if the map's navigation
satellite changes, the shell's changes with it, because there is only ever one
definition. Two copies of a shape drift apart exactly as two copies of a colour
scale do, and the whole point of the shapes is that they mean something.

### Size is part of the decision, not tuning

The dots were 3-7 px, which is right for dots and useless for silhouettes: at
that size the one-panel constellation and the two-panel navigation shape are
the same grey smudge. Ten pixels is about where they separate.

This is the third time the same trap has been walked into on this feature: the
SDF blur (D102) and the flooded halo (D102) both came from detail too fine to
survive the size it was drawn at. **A shape has to be legible at the size it
renders, and that size is part of the design rather than something discovered
afterwards.**

### On 3D shapes, which is what was actually asked for

Phone asked for the icons back "and make 3d shape of their icons if possible".
The icons are back; the 3D is deliberately not done, and the reason is size
again. At 10-20 px a modelled spacecraft is a blob - the panels that
distinguish the families are a pixel or two, which is precisely the failure
D102 recorded. A billboarded silhouette carries more information at that size
than a mesh does.

The project already has the right pattern for this and it should be followed:
**a sprite for every object, a 3D model for the selected one.** That is how
aircraft work (D42, D67) - a silhouette in the crowd, a full airframe once you
have picked one out and it is large enough to repay the geometry. The satellite
equivalent is the obvious next step and is not built yet.

---

## D107 - The selected satellite is a spacecraft, modelled

**Decision:** selecting a satellite draws it as **3D geometry built for its
family** - a truss with four arrays for a station, one lopsided array for a
Starlink, a dish for a geostationary bus, a bare drum for a spinning probe.
`modelLayer` now forks on object type rather than refusing satellites.

Silhouette in the crowd, geometry for the selection. Exactly how aircraft work
(D42, D67), and D106 said this was the shape the answer should take.

### The airframe guard changed form, not force

D96 made `modelTarget` return null for satellites. That was right when the only
mesh available was an aeroplane: drawing one in orbit is a detailed claim about
a machine that is not there, and the no-heading rule would never have caught it
because a satellite has a perfectly good heading.

The guard is now a **fork**: a satellite selects a spacecraft, an aircraft
selects an airframe, and neither can receive the other's geometry. The property
D96 protected is unchanged; what changed is that there is finally something
correct to draw.

**The test had to change with it, and nearly became worthless.** The first
version compared `spacecraftGeometryFor(...)` against `aircraftGeometryFor(...)`
and asserted they differ - which is true of two different builders however the
layer chooses between them, so it would have passed with the fork removed. It
now reads the geometry off the mesh the layer handed the renderer. Breaking the
fork was what exposed that; the assertion looked reasonable until then.

### Built in the frame, not merely in three dimensions

`modelFrame.ts` gives the mesh a tangent frame: **+Y up, away from the Earth**,
**+Z along the direction of travel**. The shapes are built to it, and that is
what makes them read as spacecraft rather than as assorted boxes:

- arrays extend along **X**, perpendicular to travel, as they do in orbit;
- dishes and imaging instruments point along **−Y**, at the ground they are
  talking to or looking at;
- a truss runs along **X**, which is what makes a station a station.

A test asserts the third of these directly - for navigation, observation and
geostationary families the geometry must extend further below the body than
above it. Getting that backwards would aim a weather satellite's camera at
space, and nothing else in the suite would have noticed.

### Two things the tests found that reading did not

**The station was not the widest object.** It is meant to be the largest thing
in orbit and the navigation satellite's arrays out-reached its truss. Caught by
a test asserting the intent rather than the numbers.

**The geostationary bus exceeded unit span**, which would have made the model
layer's metre scaling mean something slightly different for that one family.

Both were fixed in the geometry. Neither would have been visible on screen as
anything more specific than "that looks a bit off".

### Sizes are real and mostly will not matter

`SPAN_METRES` holds true spans - the ISS is 109 m, a Starlink about 9 m. At the
zoom the shell draws at, all of them are far under a pixel and the model
layer's pixel floor decides the drawn size. They are there because they are
true, cost nothing, and become the right answer the moment somebody zooms in.

### One object, one picture

The shell leaves the selected satellite's sprite out while the model is
drawing, told per frame rather than on selection - whether the model draws
depends on zoom and the horizon as well as on what is selected. The same
arrangement `setHidden` gives the aircraft symbol layer.

---

## D108 - The flat basemap is recoloured, not inherited

Phone asked for a dark basemap on the strength of one observation: the flat map
is bright, and what sits on top of it is two thousand small bright aircraft or
fourteen hundred satellites, so nothing reads as foreground.

The first answer given was wrong, and wrong in a way worth recording: *"swap
the style URL to OpenFreeMap Dark, one line."* It is one line, and it costs:

| | Liberty | OpenFreeMap Dark |
|---|---|---|
| Layers | **111** | 47 |
| 3D buildings | **`building-3d`** | none |

Liberty was chosen in the first place *because* it carries `building-3d`
(D52). Dark, Positron and Fiord all lack it - checked, not assumed. And at
world zoom the ready-made dark styles are worse than the light one: Dark's
land is `hsl(0,2%,5%)` against water at `rgb(27,27,29)`, a difference of about
two per cent, so the globe reads as a black disc with labels floating on it.
That is a reasonable trade for a street map and the wrong one for a planet.

**So the darkness is ours and the cartography stays Liberty's.** Every fill and
the background get a colour from `DARK_FILL_COLORS`; the arrangement - which
areas exist, where they are, what gets a label - is untouched.

This reverses a decision recorded in the file itself, which passed Liberty's
fills through on the reasoning that *"nobody here can draw a basemap better
than its authors."* That reasoning was sound and its conclusion was still
wrong, because the thing being inherited was not the cartography but the
**brightness** - and brightness is the one property of a basemap that Orbital
cannot inherit, because Orbital is the only thing that knows what will be drawn
on top of it.

### Land and water is the pair that has to survive

At world zoom they are most of the picture and nothing else is. `#1b212c`
against `#080f1c` is a deliberate two-step, and it is asserted as a *luminance*
difference rather than by eye, because by eye is how the ready-made styles get
away with two per cent.

### Three things recolouring cannot reach

- **`fill-pattern` ignores `fill-color`.** A patterned layer would keep the
  light style's hatching on a dark map, so patterned fills are hidden outright.
  A pale hatch over dark ground reads as a rendering fault, which is what it
  would be.
- **`layout: undefined`.** Writing the key with nothing in it fails the style
  spec, and a rejected property drops the whole style silently (defect #25).
  Caught by the spec validator, not by reading.
- **The dim layer.** `flatBasemapDim` existed to buy contrast back from a light
  map and now defaults to **0**: dimming a dark palette takes the ground, the
  roads and the labels down together, which is the contrast the palette was
  drawn to keep.

### Country names are sized for a map, and this is a globe

Liberty asks for 17 px country names by zoom 4. At that zoom a globe shows a
hemisphere, and the names collide into a mat of text over the thing the user
came to look at. `REGION_LABEL_SIZE` replaces the ramp for country and state
labels only, rejoining the style's own sizing by zoom 7.

**It is a top-level `interpolate`, not a multiplier.** The obvious way to write
"the same but smaller" is to multiply the style's ramp by a factor, and a
`zoom` expression may only be the direct input of a top-level step or
interpolate - so a product of two of them is rejected, and a rejected paint
property drops the entire style with no error at all (D25, defect #25).

---

## D109 - A third basemap, because dark is not one look

Phone asked for the near-black map to stay as a third option rather than
replace the plain one, and that is right: they answer different questions.
`flat` is a dark map you are meant to **read**; `dark` is a dark map you are
meant to **see past**, which is what the satellite layer wants and what no
amount of tuning a single palette gives you at once.

It is a palette, not a second stylesheet. `setStyle` is what the global-state
design exists to avoid - it would tear down and re-add the aircraft, their
tracks, the leader, the model and the terminator on every press (D75).

### The trap the third mode opened

Every existing call site was written as `whenFlat(flat, imagery)`, a two-armed
`match` - and **a two-armed match sends every unlisted value to the fallback**,
which is the *imagery* arm. Left alone, switching to `dark` would have drawn
the photograph's colours on a map with no photograph in it, and turned the
imagery raster back on underneath. `whenFlat` now maps `dark` onto the flat arm
and only the properties that genuinely differ reach for `whenBasemap`.

Confirmed by breaking it: with `dark` routed to the imagery arm, two tests
fail. All four assertions new to D108 and D109 were checked the same way.

### The button is a cycle, so it is not a toggle

Three states, so `aria-pressed` came off: it has two values, and leaving it on
tells a screen reader the button is a checkbox that is currently off. The
glyph, the title and the cycle order live in one table so they cannot drift.

### Still open

A hatched lens over Xinjiang and a second over northern Russia, visible in
every vector mode and in the light palette before this change, so it predates
it. It is not a patterned fill - hiding those did not remove it. Untracked.

---

## D110 - Turning the globe should not be a network operation

Phone, 2026-09-02, rotating the planet: *"the response time of aircraft and
satellites showing up are delaying a lot."*

Three delays in series, and only one of them was doing any work.

**1. The viewport was never published when the map stopped.** `move` was
throttled to 500 ms and there was no `moveend` handler at all, so the final
resting position of a drag waited out whatever was left of the throttle before
it was published. The refetch debounce - another 250 ms - then started from
there. Up to three quarters of a second could pass after letting go before the
request was *sent*. `moveend` now publishes once, unthrottled, and the debounce
is 120 ms.

**2. The satellite layer was sending a viewport, and had no use for one.** This
is the real fault. The bounding box on an aircraft request is load-bearing: it
is how the backend learns where to spend its fast tier 2 credits (D21). On a
satellite request it aims nothing, because that layer has **no credit model at
all** - positions are computed from held elements (D95). All it did was make
the globe ask the server for objects it could already have been holding.

Measured before changing anything: the whole catalogue is **350 KB and 108 ms,
1,430 objects**. The viewport was cutting that to 592, and buying a round trip
on every rotation to do it. The client now fetches all of them and a drag
issues **zero requests** - confirmed by counting resource entries across two
drags, before and after.

### The flag says why, not just what

`LayerDescriptor.viewportScoped` rather than a check on the resource name. The
asymmetry is a fact about the two layers' data models - one is polled under a
credit budget, the other is computed for free - and a name comparison would
have recorded the conclusion while losing the reason.

### Tested as data, because there is no hook harness

There is no component-render harness in this project, so a judgement living
inside an effect is a judgement nothing can check. The decision is extracted to
`bboxFor(layer, viewport)` and tested directly, the same arrangement the
presentation modules use. Confirmed by breaking all three: re-scoping
satellites, making `bboxFor` ignore the flag, and restoring the old debounce
each fail exactly one test.

### What is still not covered

The `moveend` publish itself. It is one line inside the imperative map setup,
which has no harness - the same gap that has swallowed every MapLibre
rendering defect in this project. It was verified by driving the real map and
counting requests, which is evidence but not a regression test.

---

## D111 - The shape and its sentence are one statement

For three sessions a hatched patch over western China and central Siberia was
recorded here as an unidentified rendering fault. It was **our own coverage
layer** (D89), drawn deliberately, with regions measured against the live store.

It was diagnosed as a broken fill twice by someone who had read the file that
draws it. That is worth writing down rather than quietly fixing, because the
misreading was not carelessness - it was the layer failing at exactly the job
it exists to do.

### What was actually wrong

The four layers did not share a zoom window.

| layer | floor | opacity from |
|---|---|---|
| fill, hatch, outline | **none** | 1.5 |
| label | **2.5** | 1.5 |

So from zoom 1.5 to 2.5 the shapes faded up with **no label attached to them**.
A hatch with no sentence is not a weaker version of the claim; it is a
different claim, and the one a reader reaches for is *"the map is broken."*

That inverts the layer's whole purpose. D89 exists because an unexplained
**hole** reads as a fault in the data. An unexplained **hatch** reads as a fault
in the renderer, which is worse: it impugns the map itself, and it sent three
sessions of investigation at the basemap - Liberty's fills, patterned fills,
Esri's no-data tiles - none of which were involved.

### The fix is one window, not one floor

Giving the shapes a `minzoom` alone would have left the 1.5 stop in the fade
curve unreachable and turned the appearance into a pop at full strength. So the
curve moved with the floor: everything begins at `COVERAGE_MIN_ZOOM` and fades
in from there. A test asserts all four layers share a window, that the window is
a real number rather than four `undefined`s, and that the fade starts no earlier
than the floor.

### And D108 had broken its colours

Separately, the coverage layer's `whenFlat` arm was a mid-slate wash, a
`#3f5470` outline and `#33445c` text - all correct against Liberty's cream and
all close to invisible against the `#1b212c` ground D108 introduced. The dark
palette was checked against the basemap's own layers and not against the four
layers Orbital adds on top of it. **Recolouring a ground is not a local change**;
anything drawn over it was tuned against the old one.

### The lesson

Two of the six defects in 19.49-19.52 were chrome describing the wrong subject.
This is the same fault in a different medium: a **drawing** making a claim its
caption was not present to qualify. The rule that falls out is narrow enough to
apply: *if a mark on the map needs words to be read correctly, the mark and the
words share a visibility condition - not two conditions that agree most of the
time.*

---

## D112 - Invisible tiles are not free

Phone, on the earth being slow to appear while scrolling. The status readout in
the screenshot had the answer in it: **`imagery: gibs 72 . close 76`** at zoom
2.8, where the close tier's `raster-opacity` is zero.

**`raster-opacity: 0` does not stop a tile being fetched.** MapLibre loads the
tiles a layer covers and lets paint decide what to do with them. So half the
imagery requests at world zoom were for photography that was drawn at zero, and
against a browser budget of roughly six connections per host they were
competing directly with the tiles the user was waiting to see.

Worse in the vector modes: `flat` and `dark` take **both** imagery layers to
zero, so every pan fetched a full hemisphere of satellite photography and threw
all of it away.

Measured in the running app, per pan at zoom 6 over fresh ground:

| | before | after |
|---|---|---|
| imagery mode | 29 far + 29 close | unchanged |
| flat / dark mode | 29 far + 29 close | **0 + 0** |
| world zoom, close tier | 76 | **0** |

Close imagery still loads where it is needed: 32 tiles at zoom 7.

Two mechanisms, because the two cases are different. The close tier gets a
`minzoom` half a level below the crossfade - enough headroom that the seam stays
a dissolve rather than a pop. The mode gate has to be imperative, because
`visibility` is a layout property and takes no expression, so it cannot be
folded into `whenBasemap` with the colours.

### A note on measuring this

The first three measurements after page load were **wrong**, and consistently
so: `performance.getEntriesByType('resource')` has a default buffer of **250
entries**, and this app fills it during startup. Every count taken afterwards
read zero, which looked exactly like "the gate broke the close tier" - and
removing the gate changed nothing, which is what finally gave it away. Call
`setResourceTimingBufferSize` and `clearResourceTimings` before counting, or the
instrument reports a fixed answer regardless of the code.

### A map handle, in development only

All of this was diagnosed from outside the app, guessing at a style nobody could
interrogate. `window.__orbitalMap` now exists under `import.meta.env.DEV`, which
is how the gate was finally cleared of a fault it did not have. It is stripped
from the production bundle by constant folding.

---

## D113 - A photograph is a layer over a ground, not the ground itself

Phone, on black rectangles filling in as the earth renders: *"can you fix it
for all zoom modes?"*

D112 removed the wasted requests; this is the other half, and the more
important one. **The black was never a stall. It was an empty substrate.**

`withImagery` put the imagery first - `[far, near, ...cartography]` - on the
reasoning from D56 that imagery is the ground at every zoom. That reasoning was
right about *what should be seen* and wrong about *what should be drawn*,
because being first means there is nothing underneath, and a raster tile that
has not arrived yet is a hole onto nothing. Nothing is black.

Everything needed to fix it was already being fetched. The vector tiles
carrying land, water and the coastline between them are **a fraction of the
size of the imagery and land first**, and D108 had just given them a dark
palette that sits under a satellite photograph without arguing with it. They
were simply in the wrong place - above the imagery, and therefore forced to
zero opacity so the photograph could be seen at all.

So the layers are now `[...ground, far, near, ...overlay]`: background and
fills beneath the photograph, lines and labels above it. The ground draws in
every mode rather than being switched off under imagery. GIBS and Esri tiles
are opaque JPEG, so the moment one arrives it covers the fill beneath it
completely and imagery mode looks exactly as it did - and until it arrives, the
reader gets dark land and sea **in the right shapes** instead of a hole.

Verified by jumping the camera and screenshotting mid-load: open ocean shows as
water, Hawaii's islands are drawn before a single photograph of them exists, and
the imagery dissolves in over the top.

### Why this was worth reordering rather than tuning

The alternatives all treat the symptom. A darker background colour makes the
holes less obvious. A shorter `raster-fade-duration` makes them arrive sooner. A
low-resolution earth image as a base costs a new asset and only helps at the
zooms it covers. None of them make a missing tile *say* anything, and the
substrate does: the coastline is information, and it is information we already
have on screen a beat earlier than the photograph.

### The rule

**Anything drawn as "the ground" should have something under it.** If a layer
can be absent for even a moment - because it comes off a network, at a
resolution, on a schedule - then whatever is beneath it is not decoration, it
is the fallback, and it should be chosen on purpose.

---

## D114 - Settings are found from the code, not from the working directory

Phone asked for the live backend. The backend had been running **fixture** all
day, while `backend/.env` plainly said `ORBITAL_PROVIDER=opensky`.

`SettingsConfigDict(env_file=".env")` resolves that path against the **process
working directory**. Started from `backend/`, as every documented command in
this project does, it works. Started from the repository root - which
`uvicorn --app-dir backend` does, and which the `.claude/launch.json` committed
earlier the same day does - pydantic finds no file, falls back to every default,
and comes up on a different data source.

**Nothing reports this.** A missing `env_file` is not an error in pydantic; it
is the ordinary case of "no file, use defaults". The only evidence was one
startup line, `provider=fixture`, in a log that also says it is ready.

The fix is an absolute path built from `config.py`'s own location, so the
answer cannot depend on where anybody happened to be standing.

### This is the second one from the same cause, on the same day

The launch config moved the working directory, and two separate things resolved
relative to it broke quietly:

| | resolved against cwd | symptom |
|---|---|---|
| element cache | `.cache/` | a 450 KB blob appeared at the repo root, outside the gitignore rule that named `backend/.cache/` |
| settings | `.env` | the wrong provider, silently |

The cache was caught because git showed an untracked file. The settings were
caught only because somebody asked for live data and looked at what came back.

**The general rule:** a path that a program resolves against its working
directory is a path whose meaning belongs to whoever launched it. That is
correct for a file the user names on the command line and wrong for a file that
is part of the application. Configuration, bundled data and caches are the
application's, so they should be found from the code.

### Tested as a property, not as a launch

Starting a server from two directories inside a test is a lot of machinery for
one assertion. The test instead asserts what actually has to be true: the
configured `env_file` is a `Path`, it is **absolute**, it is named `.env`, and
its parent is the backend package - and that it still is after `chdir` to a
temporary directory. Reverting the fix fails it on the first assertion.

A note on that check: the first attempt to verify it reported "not caught",
which was the *harness* failing rather than the test - `.venv/Scripts/python`
is not a command `cmd.exe` understands, so pytest never ran and the absence of
the word "failed" was read as a pass. **A break-test that reports nothing broke
must be shown to have actually run.**

---

## D115 - The live feed is the default; the fixture stays for the suite

Phone: *"remove demo backend, we dont need anymore and make backend Union
permanent."*

Half of that is done and half of it should not be.

**Union is now the default.** `provider` defaulted to `fixture` and
`quota_preset` to `authenticated`, which meant the backend served recorded
sample data unless someone remembered to say otherwise - and after D114 it did
so even when `.env` said otherwise. Both defaults are now `union`: adsb.lol on
every poll with OpenSky as a 120 s supplement, 2,880 projected credits a day
against a 4,000 allowance.

**The fixture provider stays.** It is not a demo; it is what the suite runs on.
526 tests, the whole API layer, the thinning logic and every frontend session
without credentials. Deleting it would delete the ability to test the API at
all, and the ability to develop against a moving map with no network or an
exhausted budget. Its docstring now says it is no longer the default, so nobody
reads it as the normal path.

### The defaults were two facts that had to agree, and nothing checked that

`provider` and `quota_preset` are separate fields declared forty lines apart,
and only some pairs mean anything. `union` with the `authenticated` preset is
valid and pointless - 300 s/90 s intervals, throwing away the faster cadence
the free feed exists to buy. `union` preset on a metered-only provider projects
8,640 credits a day and is refused outright. A test now asserts the shipped
pair is coherent and under budget, because nobody reads two `Field` lines and
checks they agree.

### Changing a default exposed six tests that were reading it

`Settings(provider="fixture")` and `Settings(quota_preset="authenticated")`
appear throughout the suite, each naming *one* of the pair and inheriting the
other. They passed for as long as the inherited value happened to suit them.
Moving the default broke six at once - not because the change was wrong, but
because those tests were asserting a configuration they had not stated.

Every one now names both. **The rule that keeps falling out of this file: a
test asserts a claim about a configuration it names, so anything it does not
name must come from a default it is prepared to have change.**

### And the suite was reading the developer's own `.env`

Found the same afternoon and the sharpest of the three. D114 made the settings
file resolve from the code rather than the working directory, which is correct
- and it meant every `Settings()` in the suite began loading a real, untracked,
per-machine file. Twelve tests erred immediately, on a preset none of them had
asked for.

The fault was older than the fix. Run from `backend/`, pytest had *always* read
that file; it simply never showed, because the values in it happened to be
compatible. A suite whose result depends on an untracked local file is not a
suite. `conftest` now nulls `env_file` and strips `ORBITAL_*` from the
environment for the session, and removing that fixture reproduces the errors.

---

## D116 - A photograph of the actual airframe, fetched by the browser

Phone asked for aircraft photos at the top of the detail panel. The interesting
part is not the feature, it is that the terms of use decide the architecture -
and they decide it against D7.

### The source, and why it needs nothing looked up first

Planespotters' public photo API is free, needs no key, and is keyed on the
**ICAO24 hex** - which is already Orbital's aircraft `id`. So there is no
registration lookup in front of it and no second request.

**Coverage was measured, not assumed.** Sixty real aircraft over southern
England, pulled live from adsb.lol: **42 of 52 had a photograph of that exact
airframe - 81%**. High enough to design the panel around the picture rather
than treat it as a garnish.

An earlier reading of the same sample reported a 13% error rate. That was
wrong, and wrong in a way worth recording: it was **our own request rate**,
about eight a second. Paced properly, 59 of 60 succeeded, the single failure
was an HTTP 525 - a Cloudflare origin hiccup - and the same hex returned a
photograph a second later. In the app the rate is one request per aircraft
somebody clicks. **An instrument under load measures the instrument.**

### The browser calls it directly, and cannot do otherwise

D7 says the browser talks to our backend and nothing else. This is a deliberate
exception, and unlike the OpenFreeMap tiles it is permanent, because the terms
forbid the alternative explicitly:

> Re-exposing the API or its data through your own API, feed, bulk export, or
> dataset is prohibited.

> All URLs returned by the API - image sources, photo links, and any other URL
> fields - must be used unchanged. Proxying, rewriting, or hot-link-protection
> bypassing is not permitted.

So there is no `/api/aircraft/{id}/photo`, no backend cache and no image proxy.
The API is CORS-enabled and checks the `Origin` header a browser sends
automatically; a server would instead have to send a descriptive `User-Agent`,
which a browser cannot set and does not need. The intended client here is the
one we were going to route around.

### Attribution is a condition of display, so it is structural

The photographer must be credited in visible text and the thumbnail must lead
back to the photo's page, in a plain anchor with no `rel="nofollow"`. That is
not styling, it is the licence. Three things follow:

- The anchor **is** the thumbnail and the credit lives inside the same
  `<figure>`, so no later layout change can separate them.
- `parsePhotos` returns `null` for a record missing `link` or `photographer`.
  A photo we cannot attribute is treated as no photo rather than shown bare.
- A test asserts the URLs are passed through byte-for-byte, because a
  well-meaning CDN rewrite would look like an optimisation.

Caching is metadata only, capped at the 24 hours the terms allow. The image
binaries are fetched by the browser from the returned URLs and never stored.

### One aircraft in five has no photograph, and that is an answer

`{"photos":[]}` is the ordinary case for 19% of traffic, so it is drawn: a
dashed panel of the same 16:9 height saying *"No photograph of this airframe"*.
Same height deliberately - a panel that loses its top third reads as broken.

It is also kept **distinct from a failed request**, which says *"Could not
reach the photo archive"*. Collapsing them would report a network fault as a
fact about the aircraft, which is the D102 mistake exactly: there, 70% of a
named satellite catalogue was labelled "Unidentified object" because a fact
about our pattern list was reported as a fact about the world.

Verified in the running app against the live union feed: **G-STBO**, a British
Airways 777-300ER outbound LHR-JFK, showed its own photograph with the credit
and link intact; **N9055F**, a Cessna 208 over Kotzebue Sound, showed the
absent state.

---

## D117 - `OBJECT BS` was VisionCube all along

Phone asked what the `OBJECT xx` entries in the satellite layer were - satellites,
stations or debris. The answer was worth the question: **satellites, and most of
them have names we were not asking for.**

### What they are

When a launch deploys several payloads, each object takes a letter from its
international designator - `2019-093C` becomes `OBJECT C` - until somebody
correlates it with a spacecraft. That placeholder lives in the **element set**,
which is what Orbital reads. SatNOGS's *database* has since worked most of them
out; its *element feed* still carries the old name.

Measured on the live catalogue, 2026-09-03:

| | |
|---|---|
| Shown as `OBJECT xx` | 266 of 1,429 (19%) |
| SatNOGS has a real identity | **213** |
| Genuinely unidentified | 53 (3.7%) |

FloripaSat-1, CAS-6, NanoDragon, CBERS-4A, VisionCube, and the four SNIPE
spacecraft flying in formation were all being reported as unidentified objects.

All 266 are `in orbit` in SatNOGS, between 250 and 980 km, median 496 km.
**None of them are debris.**

### There is no debris filter, and the test that says otherwise checks nothing

`test_no_provider_serves_debris_or_rocket_bodies` asserts that no string in
`registry.available()` contains "debris", "rocket" or "junk" - that is, that no
*provider is named* after debris. It inspects `('fixture', 'opensky',
'adsblol', 'union', 'satellites')`. It would pass unchanged while serving
nothing but debris.

The feed is clean for a different reason entirely: elements come from SatNOGS,
which is a **spacecraft** database of ~2,773 objects, not the ~100,000-object
catalogue that includes debris and spent stages. That is a property of the
source, not of any check we perform - and it would stop being true the moment
CelesTrak came back and the source changed.

### After: 3.7%

`satellite_names.py` fetches the SatNOGS *directory* - a different endpoint
from the element feed - and fills in names the feed left blank. Live: **222
objects named on the first refresh**, 266 placeholders down to 53.

It only ever fills a blank. It never renames an object the feed named, and
never swaps one placeholder for another; a directory that has forgotten an
identity must not un-name something we could already name.

**Names are a nicety on top of positions**, so a directory that will not load
costs nothing: the elements are kept, the satellites still draw, and the log
says so. The reliability argument for this layer is that an upstream failure is
invisible; a *naming* failure has to be less than that again.

### Three things this cost

**`\b` became a backspace, again.** Writing the word-boundary pattern through a
shell heredoc put byte `0x08` either side of `TBA`, producing a regex that
matches nothing. `grep` renders it invisibly - the line read as `re.compile(r"TBA")`
- and `cat -A` showed `r"^HTBA^H"`. This is the second time in this project, and
it is already a written rule. **Use the edit tool for any line containing an
escape.**

**A substring check would have un-named a real satellite.** `"TBA" in name` is
true of `SATBAND`. Zero false positives on today's catalogue, which is luck
rather than correctness, so `TBA` is matched on a word boundary.

**"Never dials out" was not enforced.** `test_satellite_api.py`'s fixture
injects `fetch_elements` and documents that the layer never reaches the
network. Adding a *second* upstream silently broke that: seven tests began
calling db.satnogs.org and timing out. A test that asserts an offline property
has to switch off every source, and there is now one to switch off per source.

### And the same break-test harness failed the same way

Verifying the new assertions by breaking the code reported "did not run" for
all three, because `.venv/Scripts/python` is not a command `cmd.exe`
understands - the identical failure recorded in D114 one day earlier. Run
break-tests through the shell that actually works, and **treat "nothing broke"
as a claim needing evidence that the tests ran at all.**

---

## D118 - Two directories, and the picture comes free with the name

Phone asked what the remaining `OBJECT xx` entries were and whether satellites
could have photographs like the aircraft do. Both answers came from the same
place.

### The remaining 32

D117 took 266 placeholders down to 53 using SatNOGS. The 53 that survived are
genuinely uncorrelated - SatNOGS itself calls them `Object B`, `Unknown
Satellite`, `2019-093F`. Several share a launch: 44880/82/84/86/87/89 are all
2019-093, one rideshare where nothing was individually identified.

**CelesTrak's SATCAT knows 21 of them** - SHUNTIAN, ETRSS-1, FENGYUN 3H,
ALSAT-3B, TIANYAN 02, WEILAI 1R, five DONGPO satellites. Live after the union:
**32 unnamed, 2.2%**, from 19% this morning.

**And SATCAT answers when CelesTrak's element endpoint does not.** `gp.php` has
returned 403 for days while `satcat/records.php` serves in four seconds. That
is D95's lesson arriving a third time: *"CelesTrak is up" and "elements are
available" are different questions* - and so is "names are available". A source
written off as down was serving the whole time, on another path.

### The debris question, answered from the catalogue

Every one of the 1,114 objects we serve that SATCAT has a record for is
`OBJECT_TYPE: PAY`. **No rocket bodies, no debris.** Not because anything
filters: the elements come from SatNOGS, a 2,773-object *spacecraft* database
rather than the ~100,000-object catalogue. That is a property of the source and
would stop holding if the source changed.

`test_no_provider_serves_debris_or_rocket_bodies` does not check this. It
asserts no *provider is named* after debris, inspecting `('fixture', 'union',
'satellites')`. It would pass unchanged while serving nothing but debris - the
same shape as the vacuous test in D107, and worth its own entry only because
its name is so much stronger than its assertion.

### The merge is field by field, because the sources are good at different things

| | names | pictures |
|---|---|---|
| SatNOGS | curated, small sats | **1,040 of 2,773** |
| CelesTrak SATCAT | the official catalogue | none |

Taking whole rows would mean choosing between a name from one and a picture
from the other when both are available. Either source may fail without costing
the other; only both failing is an outage.

**The picture costs no extra request.** The SatNOGS row carrying a name carries
an `image` too, so resolving names and finding pictures are the same fetch.
The data is CC BY-SA 4.0, so the panel credits SatNOGS beside the image.

### A satellite picture is a different claim from an aircraft photograph

`SatellitePhoto` is deliberately **not** `AircraftPhoto` reused. An aircraft
photo is of *that airframe* - a spotter photographed G-STBO. A satellite
picture is frequently the mission, the class, or an engineering model; nobody
photographs a cubesat at 500 km. So the caption reads *"Pictured by SatNOGS"*
rather than implying a photograph taken in orbit. Sharing the component would
have saved thirty lines and asserted something untrue.

Two objects in three have no picture, drawn at the same height as an answer.

### And a measurement mistake worth naming

Reading `imageUrl` back from `/api/satellites` returned **0%**, which looked
exactly like the feature not working. The list endpoint strips `meta` by
design; the detail endpoint - the one the panel actually calls - had the URL
all along. **Measure the endpoint the feature uses.** That is the third
instrument error in three days, after the 250-entry resource-timing buffer
(D112) and the break-test harness that never ran (D114, D117).

---

## D119 - The rewind existed in one function and nothing could reach it

Phone, on the premium tier: *"we cant look back Satellites either right?"* and
then *"our frontend does not have any key to rewind"*. Both questions were
better than the feature list they were aimed at.

### What was actually true

`propagate` has always taken an arbitrary instant and always checked
`abs(age_days)` against the seven-day bound - so a time **before** an element
set's epoch was refused on exactly the same terms as one after it. Backwards
propagation was never missing. Demonstrated before writing anything: the ISS
over Germany 90 minutes ago, south of New Zealand 45 minutes ago, the Atlantic
now, the Indian Ocean 45 minutes ahead. One 93-minute orbit, one function.

What was missing was any way to *say so*. `positions()` hardcoded `utcnow()`,
`/api/satellites` took `bbox` and `limit` only, and the UI had no time control
at all. **The capability sat in one function at the bottom of the stack with
three layers above it unable to pass the argument.** Two tier tables were
written describing it as a product before anyone checked whether it was
reachable.

### The seven days are not a policy

SGP4 drifts about a kilometre a day from epoch, so past a week the answer stops
being one. The bound is enforced per element set against *that set's* own
epoch, which is why the API does not check it at the door: the epochs differ by
hours across the catalogue, so a single check would have to invent an epoch
that does not exist. An instant too far from a given set drops that object with
a logged reason - the same behaviour as an element set that has gone stale.

### Aircraft cannot have this, and the control does not pretend otherwise

A satellite position is **computed**; any instant costs the same arithmetic as
now. An aircraft position is **observed** - it exists because a receiver heard
it - and the store holds fifty points per object before evicting it five
minutes after its last sighting. There is no function to evaluate at another
time. So `TimeControl` returns `null` on the aircraft layer rather than
existing and refusing.

That asymmetry is the same one the revenue discussion turned on: the layer that
can be rewound is the layer whose data is computed, and it is also the only one
whose licences permit selling anything.

### The clock stops while the map is rewound

A chosen instant does not change, so re-requesting it every few seconds fetches
an identical answer - and worse, each reply replaces the object set, so a slow
response arriving after another scrub would drag the map back to a moment the
user had already left. `setInterval` is simply not created while `viewInstant`
is non-null. Measured: **zero requests in nine seconds** while two days back.

### A `+` in a query string is a space

The first live test returned 422 on a perfectly valid timestamp:
`2026-09-04T18:55:00+00:00` arrives as `...00 00:00` unless the client
percent-encoded it. Every client gets this wrong once, and refusing them
teaches nothing, so the parser repairs it - the space can only have been a plus,
because ISO 8601 has no other use for one. The frontend sends `toISOString()`,
which ends in `Z` and has no offset to mangle.

### The defect this feature exists to prevent, found in this feature

With the scrubber two days back and the map correctly showing two days back,
the status bar still read **"positions computed now"**. That is the one line a
reader checks to find out how current the screen is, and it was the last place
still claiming the present.

Everything in this app that shows a position also says how old it is - the
aircraft panel, the element age on every satellite, the coverage layer's
sentence about absence. A rewound map that looked live would have been the most
confident lie in the project, and the first version shipped one in the corner.
Found by looking at the running app, which is where the other twenty came from.

---

## D120 - Four worlds, and the six that say why not

Phase 1 of the solar system: a picker under the wordmark, and Orbital can put a
camera on somewhere other than Earth.

### Probing changed the answer twice

**NASA Trek looked like the source.** It serves Mercury, the Moon and Mars, all
keyless, and the tiles came back 200. Then the grid gave it away: Trek's `z0`
is **two tiles wide and one tall**, which is equirectangular. Web Mercator's
`z0` is a single tile. A MapLibre raster source has no plate carree support, so
Trek is unusable here whatever its coverage - and nothing about the HTTP status
would ever have said so.

**OpenPlanetaryMap serves the same three in Web Mercator.** Mercury was very
nearly written off with them: it is absent from OPM's own basemap page, and
only appeared after guessing `opm-mercury-basemap-v0-1` when `v0-2` returned
404. Venus, Ceres, Vesta, Titan, Europa, Io and Pluto were probed on the same
pattern and all 404.

So: **Earth, Mercury, Moon, Mars**. Four worlds with ground under them.

### Two different kinds of "no"

Venus has a complete Magellan radar map and no Mercator tiles here. Jupiter has
**no solid surface** - not a missing dataset that might appear later, but
nothing to map. The picker states each reason on the row rather than hiding
either, because a list of four would answer *"can I go to Jupiter"* with
silence and a reader would conclude the feature was unfinished.

### A body swap is not a `setStyle`

That would tear down the aircraft, their tracks, the leader, the model, the
terminator, the satellite shell and every source behind them - the objection
D75 raised against doing it for the imagery toggle. The style stays; tiles and
visibilities change.

**Except the attribution, which forced one exception.** `setTiles` swaps the
URLs and leaves the source's `attribution` behind, so Mars was served under
*"Imagery NASA EOSDIS GIBS"* - crediting the wrong mission for somebody else's
data. That is a licence fault, not a cosmetic one. MapLibre reads attribution
when a source is added, so the imagery source is now removed and re-added on a
body change, and Mars reads *"Basemap OpenPlanetaryMap - imagery NASA Viking
MDIM21"*.

### The chrome had to leave Earth too, and at first it did not

Layer gating was built first and worked: aircraft, satellites, airports,
coverage and the vector cartography all switched off. The screenshot showed
Mars, correctly, under a status bar reading **"2,000 aircraft - showing a
sample of 6,181 in view"**, an altitude key in kilometres, and a search box
offering airports.

**That is D100 exactly, one world further out.** Chrome describing the wrong
subject, in the place a reader looks to find out what they are looking at. The
search box, the layer toggle, the key, the time scrubber and the detail panel
are all Earth furniture; on Mars they are not empty but *about nothing*. All of
them are now gated, and the status bar says the body's name and
*"surface imagery - no live objects here"*.

That makes **three consecutive features** - satellites (D100), the rewind
(D119), and this - where the layer worked first time and the words around it
lied. The pattern is strong enough to be a checklist item rather than a lesson:
**when a view gains a mode, walk every string on screen before calling it
done.**

### Zoom stops where the mosaic does

Mercury's mosaic has five levels, Mars eight, the Moon seven. Past those
MapLibre overzooms, and a blurred rectangle is presented with exactly the
confidence of a sharp one, so `maxZoom` follows the body.

### What Phase 1 deliberately does not do

No space, no second renderer, no planet positions, nothing to scale. The Sun
and the gas giants appear only as rows in a list. Phases 2 to 6 remain as
planned, and Phase 4 - the handover spike - is still the one that decides
whether the rest is worth building.

---

## D121 - The planets need nothing from anybody

Phase 2 of the solar system: heliocentric positions for all eight planets,
computed from JPL's approximate elements.

**This is the satellite architecture one step further.** A satellite needs
element sets fetched from somewhere and refreshed every few days; a planet's
orbit is six numbers and six rates published once, which do not change. The
module makes **no request, ever** - no upstream, no quota, no cache, no
staleness, and no backend involvement of any kind. It is the only layer in
Orbital that cannot fail.

### Verified against JPL, not against itself

`fixtures/horizons.json` holds heliocentric ecliptic vectors for all eight
planets at five epochs, fetched from JPL Horizons. That distinction is the
whole point: a suite comparing this module to itself would pass with the
element table mistyped, and every digit in that table is somebody else's
measurement.

Earth is compared against Horizons body **3**, the Earth-Moon barycentre, not
`399`. They differ by 4,700 km, and comparing against the wrong one would
charge this code with an error it did not make.

### Jupiter and Saturn are the worst, and that is physics

Worst error seen, per planet, across five epochs:

    mercury 0.1'   venus 0.3'   earth 0.3'   mars 0.6'
    jupiter 5.3'   saturn 9.6'  uranus 1.2'  neptune 0.8'

The two adjacent outliers are the **great inequality** - Jupiter and Saturn's
5:2 near-resonance trading angular momentum on a 900-year cycle that linear
elements cannot represent. The signature is exactly that: the two resonant
bodies, with an error that *oscillates* with date rather than sitting at a
constant offset. A mistyped element would do the opposite, and that is how the
two were told apart rather than by hoping.

Tolerances are therefore per planet and in **arcminutes of heliocentric
angle**, not AU. One bound in AU is simultaneously far too loose for Mercury
and too tight for Neptune, and a single number wide enough for Saturn would let
Mercury be wrong by a quarter of its orbit.

### A rate error needs time, and the first fixtures gave it none

The first three reference epochs were 2000, 2026 and 2035 - all within a third
of a century of J2000. Breaking Saturn's mean-longitude rate by a transposed
digit, 1222.49 to 1222.94, **passed the entire suite**: 0.45 degrees per
century has almost nothing to accumulate over 26 years, and Saturn's honest
9.6' tolerance absorbed what little there was.

Two epochs were added at 1900 and 2049, near both ends of the table's stated
validity. The same break now fails two tests. **A rate is only observable over
time, so a fixture set clustered near the epoch cannot see one at all.**

### A check that was wrong twice before it was right

The obvious fix looked like comparing `lRate` against the period from `a` -
two columns checking each other. Set at a part in ten thousand it failed on
Neptune *for being correct*, and the failure was briefly misread as the Saturn
break being caught.

The deviations are 2-19 ppm for the inner planets and 448, 512 and 633 ppm for
Jupiter, Uranus and Neptune. Part of that is this file's own doing:
`orbitalPeriodDays` applies Kepler's third law with the **solar mass alone**,
and Jupiter is 1/1047 of a solar mass, so its period is about 478 ppm shorter
than the formula returns - very nearly Jupiter's entire deviation.

So the check stays at a part in a thousand and is documented for what it
actually is: a detector of rows pasted against the wrong planet, not of
transposed digits. Digit-level rate errors are the Horizons comparison's job,
and only became its job when the fixtures widened.

### What Phase 2 deliberately does not do

Nothing is drawn. No scale is chosen - that is Phase 3, and the spread it has
to compress is 0.39 to 30 AU in distance against 2,440 to 696,000 km in radius.
Nothing is rendered until Phase 4 answers whether a second renderer can hand
over to MapLibre at all.

---

## D122 - Two compressions, because distance and size are not one problem

Phase 3: the scale decision, made on its own before anything is drawn - the
same order the satellite shell was built in, and for the same reason. That
compression was got wrong twice on paper and right before it reached a screen.

### True scale is not awkward, it is impossible

Measured from the element table and the body radii:

| | spread |
|---|---|
| orbit radius, Mercury to Neptune | **77.7 : 1** |
| body radius, Moon to Sun | **401 : 1** |

With Neptune's orbit drawn 500 pixels across, **the Sun is 0.077 px and Earth
is 0.0007 px**. Not small - absent. There is no viewport and no zoom at which
the real numbers make a picture.

### The two axes are independent, which is the whole finding

**Earth's orbit is 23,000 times its own radius.** A single scale that fits the
orbits makes the bodies vanish; one that makes the bodies visible puts Neptune
far outside the frame. So distance and size get separate logarithmic
compressions - and that is not an approximation of an orrery, it *is* what an
orrery is.

Chosen and checked: orbits run Mercury 0.179 to Neptune 1.000 with the tightest
gap (Venus to Earth) at 26 px on a 500 px frame - still worth aiming a mouse
at. Bodies run the Moon at 3 px to the Sun at 30 px, a **401 : 1 spread drawn
as 10 : 1**, with Venus and Earth still within 5% of each other, which is the
part a reader can check against what they already know.

### Angle is true; only distance is compressed

`radiusFor` takes a distance and nothing else. The angular position from
`planets.ts` passes through untouched, so a conjunction is a real conjunction
and a planet behind the Sun is really behind it. The same bargain
`satelliteShell.ts` struck: **the arrangement is true and the distances are
not.**

### A units bug that was only ever going to be seen in a printed number

The first version had body radii in **pixels** and orbit radii in **frame
fractions** - two incompatible units - and `exaggerationOf` carried a magic
factor of a thousand to make its output look plausible. The function is only
ever displayed, never used in the maths, so nothing would have failed; the
number would simply have been wrong on screen forever.

It was found by asking what the constant was for, which is the only thing that
finds a fudge factor. Both scales are now in one unit where 1.0 is Neptune's
orbit, the factor is gone, and a test asserts the Sun is a fraction of
Neptune's orbit rather than thirty times it.

With the units fixed the honest exaggeration is **628x for Jupiter to 4,580x
for Neptune**, Earth at 989x. Those numbers went into the docstring to replace
a guessed "30,000 times" that had been written before anything was measured.

### Saying so is not optional

`SCALE_NOTE` exists because every other layer in this app states what it is
doing to the truth: the satellite key says the shell is compressed, the panel
says how old a position is, the coverage layer says where nobody is listening.
A solar system drawn a thousand times out of proportion is not allowed to be
the quiet one.

### Next

Phase 4 is the handover spike - one untextured sphere in three.js and whether
it can crossfade with MapLibre at all. It comes before the real scene precisely
so that a failure lands against a stub instead of against eight modelled
planets.

---

## D123 - The second renderer is not needed, and the spike is why

Phase 4 was planned as a handover: a three.js scene for space, crossfading with
MapLibre at a zoom boundary, because MapLibre draws one globe and a solar
system is not one globe. It was placed before the real scene precisely so that
a failure would land against a stub.

**It did not fail. The premise did.**

### The thing the plan missed was already in the repository

`satelliteShellLayer` and `modelLayer` **already run three.js inside MapLibre's
GL context**, on a unit sphere where a vertex is a direction and a radius is a
multiple of the globe's own (`modelFrame.ts`). The shell stands off at about
2.4 radii and has since D105.

So the question was never whether two renderers can hand over. It was **how far
the one already here reaches** - which nobody had asked, because the plan had
already decided the answer was "not far enough".

### Measured, not derived

A probe layer drew rings at 2.4, 5, 10, 20, 40 and 80 globe radii and reported
what fraction of each landed inside the clip volume. At MapLibre's floor:

| ring | visible at z=-2 | at z=-1.6 |
|---|---|---|
| 2.4 (the shell today) | 64% | 64% |
| 10 | 55% | 55% |
| **20** | **52%** | 30% |
| 40 | 11% | 5% |
| 80 | 2% | 0% |

52% is not half-hidden - it is the **entire near side**. The far half of every
ring sits behind the far plane at any radius, which is not a limit but the
existing behaviour: the shell already culls to the near side against the same
horizon plane.

**So the reach is about 20 globe radii, and the compressed system needs 18.**
No second renderer, no crossfade, no camera continuity problem, and Phases 5
and 6 get simpler rather than harder.

### `minZoom` was costing half the reach

MapLibre **refuses any minZoom below -2** - `setMinZoom(-6)` throws, it is a
library cap rather than a setting. The view was sitting at -1.6, where the
20-radius ring shows 30% instead of 52%. Lowered to -2, which is the difference
between the outer solar system being in frame and not.

### The probe was wrong twice before it was right

**It sampled one vertex.** A single point at `(r,0,0)` reported "off-frame" for
rings whose tops and bottoms were perfectly visible. A point on a ring's edge
says nothing about the ring.

**It printed depth to three places**, and every value came back as exactly
`1.000` - which reads as "everything is at the far plane" and is really "not
enough digits to tell". Two conclusions were nearly drawn from that noise.

Fixed by sampling the whole ring and reporting the surviving fraction, which is
the number that was wanted from the start. **A measurement that returns the
same answer for every input is not a measurement.**

### And the scale was normalised on the wrong number

Writing the reach test surfaced a real error in D122's work: `ORBIT_K` was set
so Neptune's **semi-major axis** landed on the frame edge, but Neptune spends
half its orbit beyond the mean, reaching 30.33 AU at aphelion. Those positions
drew outside the frame. Normalised on aphelion now, with a test that walks 60
years of real positions rather than trusting the axis.

Small, and exactly the kind that shows as a planet clipping the rim rather than
as a wrong number anywhere a test would look.

### The spike is deleted

`reachProbe.ts` is gone. Its answer is the table above and two constants -
`GLOBE_RADII_AT_NEPTUNE` and `MAPLIBRE_MIN_ZOOM` - both with the measurement in
their docstrings. Keeping the instrument after the reading is how a codebase
fills with tools nobody dares remove.

---

## D124 - An inertial sky inside a rotating frame

`planets.ts` answers in heliocentric **ecliptic** coordinates, which do not
turn. MapLibre's globe frame is **Earth-fixed** - a vertex is a longitude and
latitude, so the frame spins once a day. Drawing one inside the other without
accounting for that makes the planets orbit the sky every twenty-four hours:
wrong in the way that looks most nearly right, because the motion is real and
merely belongs to the Earth.

### The rotation angle came free

The usual answer is to implement GMST. There was a shorter one: **the Sun is
the one body this app already knows in both frames.** `subsolarPoint` returns
its right ascension - inertial - and its subsolar longitude - Earth-fixed - for
the same instant, so their difference *is* Earth's rotation angle. It inherits
tests against the equinoxes and solstices instead of introducing a second solar
model to disagree with the first.

### Earth is the origin, and that is where the reader is standing

MapLibre draws Earth at the centre of its world, so every body's compressed
heliocentric position has Earth's subtracted from it. The Sun ends up about one
compressed AU away in the direction it really is, and the orbits stay proper
rings about it. Not a distortion - a point of view.

### Two errors, both caught by tests written before the drawing

**A right angle out.** The first version rotated Earth's spin about the **Y**
axis, mixing the maths convention (+Z north) with the globe convention (+Y
north) inside one function. The ecliptic pole came out 90.7 degrees from the
globe's pole instead of 23.44. The reordering to globe axes now happens once,
at the end, and nothing before it may assume the destination frame.

**A ring that did not close.** `orbitRing` derived each planet's period from
its *current* distance rather than its semi-major axis, so an eccentric orbit
closed 32 degrees short of itself - Mercury at aphelion implies a period a
fifth longer than Mercury at perihelion does.

Neither would have been visible as anything worse than "the picture looks a bit
off". The decisive test is the one that compares the Sun's computed direction
against `subsolarPoint` - a different algorithm with its own tests - so the two
agreeing is not this code marking its own work.

---

## D125 - The solar system, in the renderer that was already there

Phase 5. Sun, seven planets and their orbit paths, as one MapLibre custom layer
beside the satellite shell - no second renderer, exactly as D123 measured.

Where each body goes is `solarFrame.ts`, how big it is drawn is
`solarScale.ts`, and neither imports MapLibre. The layer itself is the only
part that cannot be tested without a GPU, so it holds nothing but GL.

Orbit paths are built once a day rather than per frame: 96 propagations per
planet per frame would be the entire budget. The bodies fade in between zoom
0.5 and -1 so the system dissolves into view rather than appearing.

### A fallback that faked a working feature

The zoom is **not** in MapLibre's render arguments. Reading
`args.zoom ?? 0` supplied a constant, and the result looked like success: the
layer drew at every zoom, and its fade sat at 0.33 forever. Both the gate and
the dissolve were dead, and nothing errored - the readout said
`8 bodies, fade 0.33` at every zoom from 1 down to -2, which is the same shape
an answer would be.

It was caught by reading the same number four times in a row. **A value that
never changes when its input does is not a value, and `?? 0` on a missing field
is how one gets manufactured.** The zoom comes from `map.getZoom()` now, which
is where the shell layer was already getting it.

Verified on screen: the Sun about one compressed AU from Earth in the right
direction, the planets on elliptical paths seen at an angle because the
ecliptic is tilted and the camera is at Earth, and the aircraft still on the
globe at the origin.

---

## D126 - Going to another world without pretending to travel there

Phase 6, and the last of the solar system plan.

MapLibre draws **one** globe, at the origin. Choosing Mars does not move a
camera across the solar system - it makes Mars the globe. A literal flight is
not available, and building something that looked like one would have been the
most elaborate lie in the project.

What is available is honest, and happens to be what every space application
actually does: **pull out until the system is drawn around the globe, swap at
the apex, zoom back in.** The swap is hidden at zoom -2 not to deceive but
because that is the one instant with nothing to look at - the globe is twenty
pixels across. Anywhere else means watching Earth's oceans turn into Martian
basalt, which is the only part of this that would be a fiction.

Measured on the running app: apex at 1,657 ms with the body changing exactly
there, arrival at 2,914 ms.

### The pull-out is not a loading screen

The solar system layer draws real positions from real elements (D121, D124), so
the destination brightening at the apex is genuinely where that planet is now.
That is the honest version of "flying there": show the reader the actual sky
before changing what is under their feet.

### The bug the screenshot found, twice

`scenePlacements` hard-coded Earth as the origin. Standing on Mars, it drew the
Sun one astronomical unit from where **Earth** would have been - correct rings
around a Sun in the wrong place, which reads as a rendering glitch rather than
a wrong assumption. Caught by looking at a mid-flight screenshot and noticing
the globe was not at the centre of its own orbits.

Parameterising the origin fixed the geometry and **missed one line**: the Sun's
reported `distanceAu` still came from Earth's position, so from Mars it said
0.996 AU instead of 1.38. The same assumption twice, one of them in a field
nobody was looking at, and only the test written straight afterwards caught the
second.

**When a hard-coded assumption is parameterised, the compiler will not find the
other places it was written by hand.** Grepping for the name is the cheap step
that was skipped.

### The Moon rides with Earth

0.0026 AU apart - far below anything this compression can resolve - and it has
no heliocentric orbit of its own to draw. So standing on the Moon uses Earth as
the scene's origin, stated in one line rather than left as a coincidence.

### The plan is finished

Phases 1 to 6: four worlds with surfaces, planet positions from constants, two
compressions, a reach measurement that removed the need for a second renderer,
the system itself, and now travel between them. Nothing in it fetches anything
at runtime except the surface tiles.

---

## D127 - A hover menu is not tested until a pointer crosses a gap

Phone: *"its hard to click because the list is gone in tiny area where my mouse
moved."*

The world picker opens on hover and its panel sits **6 px below the button**.
That gap belongs to no hover region, so a pointer moving from the button toward
a planet crossed dead space, `mouseleave` fired, and the list shut before it
could be reached.

Two fixes, because there are two ways to lose the pointer:

- **A CSS bridge** - `::before` extending the panel's hit area up over the gap,
  which covers a straight downward move.
- **A 220 ms close delay** - because a diagonal move toward a lower item clips
  the panel's corner and leaves the wrapper entirely, which no bridge can
  cover. Opening stays instant; only closing waits.

Rows also grew from 5 px of vertical padding to 7, so a near miss still lands.

### Why the tests did not catch it

`BodyPicker` had passing tests. Every one of them drove the component by
calling its handlers or clicking its buttons directly - never by moving a
pointer from one element to another. The bug lives entirely in the space
*between* two elements, which is a place no `click()` ever visits.

Verified afterwards both ways: synthetic events crossing the gap, and a real
pointer path from the button down into the list, with all ten rows still
reachable.

**A menu that opens on hover is a claim about the pointer's journey, not about
its destination.** Testing the destination is testing the half that was never
in doubt.

---

## D128 - Real stars, real light, and a backdrop this projection cannot hold

Phone asked for Blender and a star background instead of the plain void. One of
those was the wrong tool and the other turned out to be two separate problems.

### Blender was declined, with a reason

Blender makes meshes. The planets draw as 8 to 30 pixel discs, where a modelled
Jupiter is indistinguishable from a sphere - megabytes shipped to render a
circle. The only genuine modelling job in the scene is Saturn's rings, which is
a flat annulus and six lines of three.js. What actually improves the picture is
lighting, textures and a sky, none of which Blender provides.

### Lighting, which was the real win

Every body used `MeshBasicMaterial` - **unlit** - which is why they read as flat
coloured discs. A point light at the Sun's own computed position, a standard
material on the planets and the Sun left emissive gives every body a day and a
night side, correctly oriented, because the light is where the Sun is. One
material swap, and it is physically true rather than decorative.

### The stars are real, and that part works

5,070 naked-eye stars from the HYG catalogue, public domain: real right
ascensions, declinations, magnitudes and B-V colour indices. So the sky is
**Orion where Orion is**, turning with the Earth. A scattering of random points
would have looked similar and been worth nothing to anyone who looked twice -
the same choice this project keeps making with SGP4 and Keplerian elements.

Three things the tests caught or would have:

- **The Sun is in the catalogue**, row zero, magnitude -26.7. Left in it draws
  a star at RA 0 Dec 0 that is not there.
- **Right ascension is in hours**, not degrees. Read as degrees the whole sky
  compresses into a 24-degree stripe.
- **Stars are equatorial, not ecliptic.** They take Earth's rotation but *not*
  the obliquity; applying it leans the sky 23 degrees against the ecliptic,
  which is a plausible-looking sky in the wrong place. `eclipticToGlobe` now
  delegates to `equatorialToGlobe`, so the two paths differ by exactly the
  tilt and cannot drift.

### The placement does not work, and the numbers say why

A backdrop has to be at infinity. This projection cannot reach it.

Measured: the camera sits **83 globe radii** from the centre at zoom -2.
Sampling the clip volume from the real projection matrix:

| sphere radius | visible |
|---|---|
| 9 | 50% |
| 20 | 52% |
| 30 | 24% |
| 50 | **1%** |
| 80 | **0%** |

A sphere large enough to contain the camera does not render at all; one small
enough to render is a sphere the camera is **outside**, so it draws as a ball
of points with a visible edge - which is exactly what the first attempt looked
like.

The fix is a screen-space backdrop: stars projected from the camera's own
orientation rather than placed as geometry. That is a different piece of work.

**So the rendering is held back behind a flag, not deleted and not shipped.**
The catalogue, the frame conversion, the sizes and the colours are all correct
and covered by sixteen tests; only the placement is wrong. Shipping the ball
would have been worse than the plain void, and deleting it would mean building
the correct half again from nothing.

## D129 - The sky is a sphere around the camera, not around the Earth

D128 ended with the star catalogue built, tested and switched off, and with a
conclusion that turned out to be half right: it said the fix was a screen-space
backdrop. It is not. It is a sphere in exactly the same geometry, moved.

### The measurement D128 was missing

D128 measured *which sphere radii survive clipping* and found the answer was
none that also contain the camera. It never measured **where the far plane
actually is**. Reading it out of the projection matrix at run time:

| zoom | camera from centre | near | far |
|---|---|---|---|
| 0 | 20r | 0.01 | 21 |
| -1 | 40r | 0.01 | 41 |
| -1.8 | 68r | 0.02 | 69 |

The far plane is **exactly one globe radius past the centre, at every zoom**.
That single fact explains the whole of D128's table: any sphere centred on the
Earth is cut at the same place regardless of how big it is, so a backdrop drawn
around the Earth cannot work at any radius. It also kills the idea of putting
the sky behind the planet - there is no space behind the planet at all.

### Why that is enough anyway

A backdrop does not have to be behind the Earth's *centre*. It has to be behind
the part of the Earth you can see. For a unit sphere with the camera `d` away,
the visible surface runs from `d - 1` at the middle of the disc to
`sqrt(d^2 - 1)` at the limb - **always less than `d`**. So the window between
`d` and the far plane is entirely occluded by the visible globe and entirely
drawn, and the measured gap of one radius is exactly that window. The sky is
hung in the middle of it.

Centring the sphere on the **camera** rather than the Earth fixes the other
half. Every star is then the same distance away whichever way the camera turns,
so there is no edge to be outside of, and moving the sphere with the camera
gives zero parallax - which is what being at infinity means. Depth testing goes
back **on**, so the Earth blocks the sky; depth writing stays off, so the sky
blocks nothing.

### The matrix knows where the camera is

A custom layer is handed a world-to-clip matrix and nothing else - no camera
position, no near, no far. All three are in the matrix. `cameraFrame.ts` takes
them out: the camera centre is the one point a projection sends to zero, so
`M . [C, 1] = 0` is three equations in three unknowns, and the depth planes come
from Gribb-Hartmann. No MapLibre import, no GPU, **nine tests** - transposing
the matrix read breaks five of them, which is the check that matters, because a
row-major read of a symmetric perspective matrix still returns a plausible
vector.

One sign error found this way: the camera is *behind* its own near plane, so
its signed distance is the near distance negated. The test asked for 0.75 and
got -0.75.

### Sizes that were being computed and thrown away

`starSize` is magnitude-correct and tested, and none of it reached the screen:
`PointsMaterial` has one size for the whole cloud. A dozen lines of shader with
a per-vertex size attribute is what makes Sirius bigger than its neighbours.

### What is still wrong, and is not this

The far plane also clips the **Sun's sphere** when it sits away from the camera
along the view axis - visible as a crescent bite out of a full disc. That is
the same one-radius far plane, hitting the bodies rather than the sky, and it
predates this work. Recorded rather than fixed.

## D130 - Clamping depth, because the far plane was eating a fifth of the scene

Phone's report was *"our star system rings went void and sometimes it looks
unrealistic"*, with a suggestion to try Blender. The measurement came first, and
it ruled Blender out in one number.

Counting orbit vertices against the far plane from the live projection matrix:
**146 of 679 - 21% - fall outside it, at every zoom.** D129 had already found
why: the far plane sits one globe radius past the centre, so everything more
than one radius *behind* the Earth is cut. For a scene 18 radii across that
removes the far side of every orbit, and takes a crescent bite out of any body
sitting away from the camera - the same crescent D129 noticed on the Sun and
recorded without fixing.

**A modelled ring would have been clipped identically.** The rings were not
badly drawn; a fifth of them was not being drawn at all.

### Clamped, not widened

The obvious fix is a farther far plane, and it is wrong. MapLibre has already
written depth values for the globe using *this* projection, so remapping depth
would break which things hide behind the Earth - the sky included, which D129
had just got right.

So the depth is clamped instead, in the vertex shader, via `onBeforeCompile` so
`MeshStandardMaterial` keeps its lighting:

```glsl
gl_Position.z = min(gl_Position.z, gl_Position.w * 0.9999);
```

A vertex past the far plane is drawn *at* the far plane rather than discarded.
That is also the honest depth for it: it is the farthest thing in the scene, so
the maximum is where it belongs, and the Earth still occludes it.

## D131 - Saturn's rings are a measured profile, not a model

The rings are the one thing in this scene with real structure at the size it is
drawn, so they are the one thing worth building properly - and building them
properly means measuring them, not modelling them.

`saturnRings.ts` holds the real radii, in Saturn radii, from the published
kilometre figures over an equatorial radius of 60,268 km: C ring from 1.239, B
ring from 1.526, **Cassini division 1.951-2.027**, A ring to 2.269, with the
Encke gap at 2.216. Ten tests, the sharpest of which asserts the Cassini
division is a *dip* - if it stops being one, the rings have become a plain hoop
and Saturn stops looking like Saturn.

The shader samples a lookup table **built from the tested function**, rather
than a second copy of the radii written in GLSL that could drift from it.

The rings are pointed along Saturn's real pole (IAU: RA 40.589 degrees, Dec
83.537), reusing `starDirection` and `equatorialToGlobe` - so they open and
close over Saturn's 29-year orbit the way the real ones do, instead of sitting
at a fixed decorative angle.

### Blender, asked for a second time and declined a second time

Phone suggested Blender for this specifically. The rings **are** a flat annulus
with a radial brightness profile - that is what they are, not a simplification
of them - so a mesh would be the same annulus with more triangles and a texture
baked at one resolution instead of sampled at the right one. And the thing that
actually looked wrong was D130's clipping, which no model fixes.

The proportions to the planet are exact even though the planet's size is
compressed: the same bargain `solarScale` struck. The arrangement is true, the
scale is not.

## D132 - Planets generated from published numbers, not downloaded as pictures

The bodies drew as flat discs of one colour, which is the single thing that
most made the scene look like a diagram. The fix is banding - it is the first
thing the eye reads on a planet - and banding is a short table of numbers.

### Why not photographic maps

They exist, most are free, and they were still wrong here: several megabytes of
binary per body, a licence to carry, a network fetch, and detail that is
invisible at 8 to 90 pixels. What is *visible* at that size is which latitudes
are dark and which are light.

So `planetSurface.ts` holds the standard nomenclature at the standard
latitudes - the North Equatorial Belt from about 7 to 17 north, the South
Equatorial Belt 7 to 21 south, the bright Equatorial Zone between them - and
generates a 1 by 256 strip, one kilobyte, from a function with fifteen tests.
The sharpest of them asserts the belts and zones **alternate** rather than
shading in one direction, because a gradient would pass a naive "it varies"
check while looking nothing like Jupiter.

**Venus is left almost uniform on purpose.** Venus is unbroken cloud; inventing
features for it would have been the one dishonest thing in the file. Uranus
gets three bands to Jupiter's eleven, for the same reason.

Longitude is not attempted, and the file says so: the Great Red Spot is two
pixels here and Syrtis Major would need a map.

### Every planet stands on its own axis

Bands run along latitude, so a banded planet built in the globe frame would
wear **Earth's** tilt. On Uranus that is close to a right angle wrong - its
pole lies almost in the ecliptic, which is the one fact everybody knows about
it. `planetPoles.ts` carries the IAU pole of rotation for each body and reuses
`starDirection` and `equatorialToGlobe` rather than introducing a second
conversion to disagree with the first. Saturn's rings now take their normal
from the same table instead of a private copy.

### The compression breaks phase, and pretending otherwise renders black discs

This was found by looking, after the textures were in and nothing changed on
screen. Jupiter sat at the exact centre of the view, was the nearest body to
the camera, and was invisible.

It was not a texture failure. **Measured phase angles from this camera run 141
to 171 degrees - every planet is a new moon.** The reason is that the camera's
distance and the system's are compressed differently: the whole solar system is
squeezed into 18 globe radii while the camera sits about 30 out, so it views
every planet from *outside* its orbit. In reality Jupiter seen from Earth never
exceeds about 12 degrees of phase, because Earth is inside its orbit.

So strict phase here is not the honest choice - it is an artefact of the
compression, and it renders the entire system as black discs. The Sun still
sets the direction and the terminator; the ambient term was raised so the night
side is legible rather than absent. The same bargain as `solarScale`, in light
instead of distance.

## D133 - Two bugs from the same habit: a written list, and a rule that ran twice

Phone reported Earth's satellites orbiting Mars, and planets vanishing at some
angles. They are unrelated in the code and identical in kind: in both cases a
rule was stated in one place and enforced in another, and the two drifted.

### Satellites on Mars: the list had gone stale, invisibly

D120 hid Earth's layers behind `EARTH_ONLY_LAYERS`, a hand-written array. A
missing entry there does not fail - it just leaves a layer on - so the list
rotted silently as the app grew. Asking the running map which of Orbital's
layers were still visible over Mars:

| still visible on Mars | why it was missed |
|---|---|
| `orbital-satellite-shell` | **custom layer - absent from `getStyle()` entirely** |
| `orbital-route-casing`, `-gap`, `-leader`, `-leader-casing` | only `orbital-route` was listed |
| `orbital-satellites-label` | added after the list |
| `orbital-origin`, `orbital-origin-label` | added after the list |

The shell is the one Phone saw: two thousand Earth satellites in orbit around
Mars, drawn by a custom layer that a style-derived rule **cannot see at all**.

So the rule is inverted. Everything with the `orbital-` prefix is a statement
about Earth unless it appears in `NOT_ABOUT_EARTH`, which holds three entries -
the two imagery tiers and the solar system, the one thing that means *more* off
Earth than on it. Custom layer ids are passed in by the caller, because
MapLibre will not list them.

Now a layer added tomorrow is hidden on Mars without anyone remembering, and
only a genuinely body-agnostic one needs a deliberate line. **The direction the
mistake points is the whole fix.** A test asserts exactly that, using a layer
name that does not exist.

The terminator is excepted for a different reason: it already has its own
control that accounts for the body *and* the reader's setting, so listing it
here as well would switch it back on for anyone who had turned it off.

### Planets vanishing: the CPU threw away what the GPU was told to keep

D130 clamped depth in the vertex shader so geometry past the far plane draws at
the far plane instead of being discarded. It worked, and planets still
disappeared - because **three.js culls on the CPU first**, against a frustum it
derives from the same projection matrix, including the same far plane. The
objects the clamp existed to save were being dropped before the shader ran.

`frustumCulled = false` on the bodies, the orbit lines and the ring. The clamp
handles the depth, this handles the culling, and neither is sufficient alone -
which is why the first fix looked correct and was half a fix.

### A "verified" finding here was wrong - see D135

This section originally recorded that the feed does not poll while the camera
is on another world, measured by watching `feed.fetchedAtMs` fail to advance on
Mars. **That conclusion was false and the measurement did not support it.**

`fetchedAtMs` is parsed from the response's `fetchedAt` - the *backend's*
upstream fetch time. It stops advancing whenever the backend's own poller has
not been round again, which is a fact about the backend's schedule and says
nothing whatever about whether the browser is making requests. Two instruments
had already lied on the way to that answer, both correctly identified at the
time; the third lied too and was believed, because by then it looked like
confirmation.

D135 measured the requests themselves and found the poll running off Earth all
along.

## D134 - Spacecraft around the Moon, which needed a third kind of data path

Phone asked for satellites on the Moon "if there are ones". There are, and
getting them required a path unlike either of the two this project already had.

### Why neither existing path works

Aircraft come from a feed that answers "where is everything now" and costs
money per question. Satellites come from orbital elements propagated locally by
SGP4, which costs nothing and works for days.

**A lunar orbiter can do neither.** There are no TLEs for these craft, and
there cannot be: the format and SGP4 itself are Earth-orbit only, and a TLE has
nowhere to name a different central body. No amount of local propagation
produces a lunar orbit. What exists instead is an ephemeris - a table of where
the spacecraft *will be*, published by the people flying it.

So this fetches a six-hour window and reads positions out of it. Between
refreshes it needs nothing, and JPL being down is not an outage until the
window runs out. That is the satellite layer's best property, arrived at from
the opposite direction.

### What is actually up there, checked rather than listed

Verified against Horizons on 2026-09-05, because this is a question with a
moving answer:

| spacecraft | Horizons id | altitude |
|---|---|---|
| LRO | -85 | 105 km |
| Danuri (KPLO) | -155 | 161 km |
| Chandrayaan-2 Orbiter | -152 | 106 km |

**Two were excluded by measurement, and that is the part worth keeping.**
CAPSTONE answers "No ephemeris for center after A.D. 2026-AUG-14" - its
published ephemeris stops three weeks before today, so drawing it would be
inventing a position for a spacecraft nobody is currently publishing one for.
ARTEMIS P1 and P2 cannot be used as an observer centre at all: Horizons wants a
station file it does not have. A list copied from an encyclopedia would have
shown five.

### Asking the question backwards, so Horizons does the frame work

The app needs **selenographic** latitude and longitude. Asking for the
spacecraft's position as a vector gives an inertial frame, and converting that
to the Moon's body-fixed one means implementing lunar rotation *and* libration
- serious work, easy to get subtly wrong, and impossible to check by eye.

Horizons will do it, if the question is inverted: ask for **the Moon as seen
from the spacecraft**, quantity 14, and the answer is the sub-observer point -
the place on the Moon directly beneath the craft, body-fixed, libration
included. Quantity 20 gives the range, and the altitude is that minus the
Moon's radius. The frame problem is solved by changing who is observing whom.

The parser is tested against a **real captured response**, not a handwritten
one: Horizons' header is long, changes between releases, and carries the
numbers in a shape nobody would invent correctly from memory.

### Breaking it to check the tests

Three deliberate breaks. Removing the shortest-arc wrap failed two tests, as
intended. Dropping the Moon's radius from the altitude appeared to fail
nothing - which was **the harness, not the tests**: the `sed` pattern did not
match the real indentation, so the code was never modified. Applied properly,
with the substitution asserted first, it failed the altitude test. That is the
third time this project has been misled by a break-test that did not run, and
the second time in this file's history that an assertion on the edit itself was
what caught it.

### The layer belongs to a body, not to Earth or to everywhere

D133 had just made every `orbital-` layer Earth's unless excepted. These are
neither Earth's nor body-agnostic, so a plain exception would have drawn lunar
spacecraft over **Mars** - D133's own bug, one body along. `homeBodyOf` gives
each layer the world it describes, and the test asserts all three cases: shown
on the Moon, hidden on Mars, hidden on Earth.

The status bar's "surface imagery - no live objects here" became false the
moment the Moon had objects, which is the D120 fault again in the one line a
reader checks to find out what they are looking at. It now counts what is
actually drawable, so a spacecraft whose window has run out is reflected in the
number rather than silently missing from it.

## D135 - A panel for the lunar craft, and a wrong answer corrected

Phone asked for a detail panel on the Moon's spacecraft. Building it turned up
a claim from the session before that was simply not true.

### The panel

A separate component from `DetailPanel` rather than a branch inside it. That
panel is built around a fetched detail record, a data age, a decoded airline,
an observed track and a scheduled route. A lunar craft has none of those, and
has one thing none of the others do.

**Its position was published in advance rather than observed.** An aircraft
reports where it was. An Earth satellite's position is computed from elements
fitted to real tracking. A lunar position is read from an ephemeris table
computed *before the fact* by the people flying the spacecraft - very accurate,
and not a measurement. Nothing about a marker on a map conveys that, so the
panel says it, and the sentence is asserted in `moonFacts.test.ts` rather than
left to whoever edits the JSX next.

Two smaller judgements, both extracted so they could be tested:

- The coordinates are labelled **"Over"**, not "Position". They are the point
  on the surface beneath the craft, not a place it is at, and one word carries
  the whole distinction.
- There are **three** panel states, not two. A spacecraft can stop being
  tracked *while its panel is open*, when its ephemeris window runs out on the
  next poll. Freezing the last position looks identical to a craft still being
  followed; closing the panel moves the reader somewhere they did not ask to
  go. It says so instead.

The store holds the craft rather than a count, so an open panel keeps up with a
spacecraft that goes round the Moon in two hours. Verified live: the panel was
opened on LRO at 71 km and read 82 km a moment later, because LRO had moved.

Clicking is handled **inside the existing click handler**, not beside it. A
second handler scoped to the lunar layers is the obvious way to write it and is
exactly the defect D69 removed - two queries that agree only by coincidence,
with a select undone by a deselect in the same click.

There is no render harness in this project, so the component stays thin and the
judgements live in `moonFacts.ts`, the way `satelliteFacts`, `routeSummary` and
`panelFields` already do.

### The correction

D133 recorded, as a verified finding, that the feed does not poll while the
camera is on another world. **It does.** Measured from the network log: three
`/api/aircraft` requests in twenty-five seconds while the camera was on the
Moon, against three in the same window on Earth.

The original measurement watched `feed.fetchedAtMs` and saw it frozen on Mars.
That field is parsed from the response's `fetchedAt` - **the backend's upstream
fetch time**. It stops advancing whenever the backend's poller has not been
round again, which is a fact about the backend and says nothing about whether
the browser is asking. Two instruments had already been caught lying in that
same investigation - the resource-timing buffer's 250-entry cap, and a patched
`window.fetch` that counted zero on Earth - and the third was believed because
by then it looked like confirmation rather than a fresh claim needing its own
control.

**No upstream credit was being spent**, which is why it survived: `/api/aircraft`
is served from the backend's in-memory store and its poller runs to its own
schedule either way. The cost was work and coherence - D120 clears the objects
on a body change, and the next tick fetched two thousand of them straight back
into the store that had just been emptied, to be drawn by nobody because D133
hides the layers.

Both polls in `usePolling` are now gated on being on Earth. Measured after:
**0 requests on the Moon against 3 on Earth**, same instrument, same session,
with the Earth reading taken as a control rather than assumed.

## D136 - Going there, standing off it, and reaching one

Three requests from Phone, and a question that deserved a number rather than a
yes.

### The question: are the planets drawn at real size?

No, and the table is worth keeping because the answer is not close:

| body | true (x Earth) | drawn (x Earth) |
|---|---|---|
| Mercury | 0.38 | 0.56 |
| Mars | 0.53 | 0.69 |
| Jupiter | **10.97** | 2.66 |
| Sun | **109.20** | 4.49 |

Distances are further from true than sizes are, and cannot be otherwise:
Neptune's orbit at true scale is **706,076 globe radii**, against a far plane
that sits one radius past the centre (D129). That is not a tuning problem.

Sizes *could* be true to each other. They are not, because the Sun is 287 times
Mercury: with the Sun at a readable 60 pixels, Mercury would be 0.2 of one. The
compression is what makes the small bodies exist on screen at all, and
`SCALE_NOTE` has always said so.

### Moving to a planet instead of zooming out and back in

The trip was a zoom to -2, a world swap, and a zoom back in, with the centre
**never moving** - which is exactly what it looked like. Nobody was going
anywhere; the picture got smaller and then bigger.

Now the outward leg steers at the destination while it pulls back, so the
planet drifts to the middle of the screen and grows. The direction is the real
one: it comes from the same `scenePlacements` the scene is drawn from, through
`lonLatOf`, the exact inverse of the sphere convention. Measured on a trip to
Mars: the centre walked 0 to -69 degrees while the zoom went 1 to -2, and -69
is where Mars actually was.

The swap still happens at the apex, now with the destination already centred,
so the new world appears under the camera rather than behind it.

### Real altitude around the Moon, which needs no compression at all

Earth's satellite shell compresses altitude logarithmically because GEO is 6.6
Earth radii (D96). Nothing in lunar orbit is like that:

| spacecraft | altitude | Moon radii |
|---|---|---|
| LRO | 71-105 km | 1.041-1.060 |
| Chandrayaan-2 | 102 km | 1.059 |
| Danuri | 213 km | 1.123 |

The whole fleet fits under 1.13 radii, so it is drawn **exactly where it is** -
the only place in Orbital where a height on screen is the height something is
at. `exaggeration()` returns 1 as an executable claim rather than a comment.

A tether runs from the sub-point up to the spacecraft, because without it a
marker a few pixels above the surface reads as a marker *on* it. And the
sub-point marker had to shrink from a 9-pixel halo over a 4-pixel dot to a 2.2
pixel dot: **at the original size the marker was wider than the height it was
marking and covered the tether completely.** Real altitude had been computed,
drawn, and made invisible by a decoration.

The result behaves like the thing it is: the height is clearest at the limb,
where it is seen edge-on, and vanishes at the centre of the disc where it
points at the viewer.

### A list, and reaching a spacecraft that is round the back

Three spacecraft, frequently on the far side where a marker cannot be clicked
because it is genuinely not visible. The list in the corner is how you reach
one anyway, and it answers what the map cannot: what else is up there.

Selecting one is a **move**: the camera eases to it, the callout is drawn, and
the panel arrives after the camera does - a delayed CSS animation with `both`,
which holds the from-state through the delay so the panel is absent rather than
sitting at full opacity waiting. Reduced-motion turns the animation off rather
than the panel.

### The callout is 45 degrees on the screen, not on the Moon

Phone asked for a line leaving the spacecraft north-east at 45 degrees. A
*bearing* of 45 degrees is a rhumb line that curves under this projection and
points somewhere different at every latitude - and these spacecraft are polar,
so it would be worst exactly where they spend their time. What a reader means
is the diagonal they can see.

So the geometry is done in screen space and unprojected: project the craft,
step equal pixels up and right, unproject. `leaderAngleDeg` exists to assert it,
because a callout that drifts to 44 degrees is not visibly wrong.

Two faults found by looking, both invisible to the type checker:

1. `setData` pulled off a source into a variable **loses its binding** and
   throws on the first camera move.
2. The line was refreshed on camera movement only, so between thirty-second
   polls it pointed at where the spacecraft had been - **measured at 77 pixels
   adrift**. It now refreshes when the positions do; measured after at 0.

## D138 - The aeroplane behind its own track: two clocks, not one bug

Phone has reported this for a long time and asked for it to be taken slowly:
the marker sits behind the end of the line it is drawing.

`interpolate.ts` already carries a note about this exact symptom - defect #21,
fixed in D71 by making the dead-reckoning cut-off and the "stale" threshold the
same number. That fix was right and this is a different cause underneath it.

### The measurement

One selected aircraft, read out of the running app:

| | age |
|---|---|
| feed's last report, which the marker uses | **128 s** |
| newest point on the same aircraft's track | **51 s** |

77 seconds apart, and at 268 m/s that is about **twenty kilometres** of line in
front of a stationary aeroplane.

### Why the two disagree

They are not the same source. The marker's position comes from Orbital's object
feed, polled on the OpenSky credit budget (D21). The track comes from the
**provider's own flight history**, fetched when the panel opens (D77), which is
not on our budget and is routinely fresher.

For most of a flight nobody notices, because the marker dead-reckons forward
from its last report and lands roughly where the track ends. Then the report
ages past `MAX_EXTRAPOLATION_MS` and dead reckoning **stops** - correctly, since
two minutes of silence is not something to keep flying a marker through (D71).
The marker parks. The track does not.

So the bug only appears once the feed falls behind, which is exactly when the
panel is saying "last reported four minutes ago" - and it was saying that above
a line whose newest point was fifty seconds old. **Two statements about one
aircraft that cannot both be true.**

### Moving the aeroplane, not trimming the line

Trimming the track back to the marker's age would make the picture agree by
**throwing away real observations**: the newest points on that line are reports
of where the aircraft actually was. The feed being behind is not a reason to
pretend better data does not exist.

A track point *is* a report, so the newest one wins. Both halves adopt it:

- **Backend** (`flights.enrich`): when the newest track point is newer than the
  reported position, the detail takes its position and `lastSeen` from it, and
  says so with `positionSource: "track"` - the same treatment the derived
  heading and speed already get (D80, D81). This is what makes the panel
  self-consistent.
- **Frontend** (`trackFix.ts`): the selected object adopts the fix, keeping
  `fromLat`/`fromLon` so the correction is a **glide rather than a jump**, and
  dead reckoning restarts from the newer fix.

### Two things found by measuring rather than reasoning

**The fix was being overwritten.** Applied only when the detail arrived, it
lasted until the next poll ten seconds later, when `applySnapshot` rebuilt the
whole map from the feed. Re-applied on every snapshot.

**The rule was reading the clock.** `betterFix` called `Date.now()` internally,
which made it untestable against a fixture whose `NOW` sits in 2027 - the store
tests failed because the object was "from the future" and nothing could improve
on it. The clock is a parameter now, which is what the rest of this file's
neighbours already do.

### After

| | before | after |
|---|---|---|
| marker's fix age | 128 s | **16 s** |
| track head age | 51 s | **16 s** |
| bearing from track head to marker | - | **129 deg, against a heading of 129** |

The two ages are now the same number, and the marker sits **exactly** along its
own heading from the end of its track - ahead of the line, which is where an
extrapolated position belongs.

## D139 - The world you are standing on takes its place in its own system

Phone: *"I want the selected planet to go smaller and not being left big when I
zoom out."* Earth, pulled back to where the solar system appears, sat there as a
full globe beside a Sun drawn at 1.08 radii - the same size as a body a hundred
and nine times larger.

### Why it could not be fixed by scaling

MapLibre draws the world under the camera at **radius 1, at every zoom**. That
is what its globe is. So the only knobs are the sizes of everything else, and
neither direction works:

- **Scale the bodies up** to match, which was tried first and made things worse:
  the Sun becomes 4.5 radii in an 18-radius scene and Saturn's rings overlap
  the Earth.
- **Spread the orbits out** to compensate. Bounded: at zoom -2 the camera is 83
  radii out with a half-angle of about 18 degrees, so only about **27 radii** of
  scene is ever on screen. Not nearly enough - the Sun's true share of Neptune's
  orbit is 0.015%, and with Earth pinned at 1 the smallest the Sun can be is
  4.5.

**With a globe fixed at radius 1 there is no consistent scale.** The globe has
to go, and the solar layer draws that body properly among its neighbours.

### The afternoon spent chasing the wrong object

The globe would not switch off. Imagery faded to zero, all 135 cartography
layers hidden, `background` made visible and bright red - which coloured nothing
- the terminator disabled, the satellite shell and the solar layer hidden. A
textured disc kept sitting at screen centre, exactly the size of the globe.

It was **the aircraft**. Two thousand icons at that zoom cluster into a
blue-green speckled disc the size of the planet they are on. Every ground layer
had been off for some time; what remained was the traffic.

Three things kept the misreading alive, all of them instrument faults rather
than reasoning faults:

- Screenshots taken before a repaint settled, showing a stale frame while the
  readout beside them had already updated.
- A probe that hid layers while an earlier version of this very handover put
  them back on the next zoom event.
- A probe asking for layer `road`, which is a **test-fixture id** and does not
  exist in the Liberty style - producing an error that looked like the
  handover throwing.

The thing that finally settled it was hiding one more group and finding a
completely empty screen.

### What it does now

`globeLayerIds` is the set that paints the world you are on: the cartography,
Orbital's own layers, and both imagery tiers - everything `visibilityFor`
already hides when the camera leaves Earth, plus the imagery, minus the solar
system, which is what the view hands over *to*. Below zoom -1 they go off and
the solar layer draws the origin body at the centre on the shared scale.
`applyBody` restores them, because it already knows what each world shows.

Earth gets a surface profile of its own for the first time - ocean blue with ice
at both ends. Latitude alone cannot draw continents so it does not try, but "a
blue planet, white at the poles" is true and is what Earth looks like at twenty
pixels. Without it the origin body drew as the default grey ball.

## D140 - Three faults in the handover, one of them a one-way door

Phone reported three things against D139's handover. They are unrelated in the
code and all three were visible in one screenshot each, which is the argument
for looking at the running app rather than the tests.

### The globe and its own body, drawn together

The planets start fading in at `SOLAR_MAX_ZOOM` (0.5) but the basemap does not
hand over until `SOLAR_FULL_ZOOM` (-1.0). For that zoom and a half **both were
drawn**: a full-size globe with a small sphere of the same world sitting inside
it.

Two thresholds for one transition, and only one of them was being asked. The
origin body is now gated on the same number the handover uses, so the one
appears in the frame the other disappears.

### The Moon inside the Earth

Earth and the Moon are **0.0026 AU apart**, which this compression cannot
resolve at all: `radiusFor` maps that separation to under a thousandth of a
globe radius, so drawn truthfully they occupy the same point and whichever is
in front hides the other.

They are not one object and are no longer drawn as one. The companion is placed
beside its partner by a **fixed, admitted offset** - 0.55 globe radii, which
leaves a clear gap of 0.2 between two bodies of radius 0.241 and 0.108.

**This is the only invented arrangement in the scene**, and it is in
`homeBodies` with its own name and its own tests rather than buried in the
layer, because everything else here is a real position and the exception should
be findable.

### Leaving the Moon was a one-way door

Phone found this after switching true size on, and that is not what caused it.

D136's travel transition aims the camera by asking `scenePlacements` where the
destination is, and it passed `activeBody` straight through. **The Moon is not
a planet.** It has no orbital elements, so the first step of any trip from the
Moon threw `ELEMENTS['moon'].a` - and because the throw skipped the
`setFlyingTo(null)` at the end of the sequence, the app was left believing a
trip was still in progress and **refused every trip afterwards**. The Moon was
somewhere you could go and not leave.

Two fixes, because the second one is the general lesson:

1. `solarOrigin()` is now the single place that maps a moon to the planet it
   rides with. The layer already had this rule; the flight had its own copy of
   `activeBody` and no rule at all.
2. The flight sequence clears `flyingTo` in a **`finally`**. Whatever fails
   mid-flight, the app must not be left believing it is still travelling -
   that state costs the reader the entire picker rather than one animation.

## D141 - A halo around nothing

D139 switched off every layer that paints the world under the camera, and a
faint dark disc stayed behind exactly where the Earth had been.

**The atmosphere is not a layer.** It belongs to MapLibre's globe projection, so
the handover - which works by layer visibility - could not touch it, and no
amount of hiding layers ever would. Confirmed by A/B in the running app:
`atmosphere-blend: 0.8`, the library's default, draws the disc;
`atmosphere-blend: 0` does not.

Close in it is worth having: it is the soft edge that makes the globe look like
a planet rather than a circle. So it fades rather than going, on a zoom
interpolate across the same two numbers the rest of the handover uses, declared
in the style rather than toggled from code.

A test asserts `basemap.ts` and `solarSystemLayer.ts` name the **same** two
zooms. They are separate constants because `basemap.ts` imports nothing that
draws, and separate constants for one transition are exactly how the overlap in
D140 happened.

### The handover was not idempotent, and that hid the fix

The first attempt appeared not to work at all: reload at solar zoom and the
globe was back, halo and all.

`applyBody` decides layer visibility from the **body** alone and knows nothing
about the handover. It runs at startup and on every body change - so it
cheerfully switched the globe back on underneath a solar view that had already
hidden it, and whichever ran last won.

`syncGlobeVisibility` reads the current zoom and applies whichever state that
calls for. It is called from the zoom handler, at startup, and after every
`applyBody`. Reading the zoom rather than tracking a flag is the point: two
pieces of state that must agree is what produced this, and now there is one.

## D142 - The true-size toggle worked; the checking did not

Carried as "wired with tests but never confirmed changing anything on screen"
for two sessions. It was correct the whole time. **Both attempts to verify it
were invalid**, and in different ways.

Measured properly, by reading the sphere geometry out of the running layer:

| | compressed | true |
|---|---|---|
| Earth | 0.2408 | **0.0099** |
| Jupiter | 0.6401 | **0.1085** |

Earth shrinks twenty-four fold, and Jupiter against Earth comes out at **10.96**
where the real ratio is 10.97.

### Why it looked broken

**The first check compared screenshots.** In true mode the inner planets are a
fraction of a pixel - Earth is 0.4 of one - so "the picture looks the same" is
what a *working* toggle produces at a glance. The visible change is that the
planets vanish, which reads as nothing having happened.

**The second check read a layer that had never rendered.** `spheres` was empty
and `builtForAnchor` was still its initial `''`, while the flag itself flipped
correctly - and the reason was that the vector style had failed to load on that
page, so nothing drew at all. The style has failed to load three times in this
session; it is intermittent and unrelated, and it silently invalidates any
measurement taken through the map.

Neither failure was in the feature. Both were in the instrument, which is now
the fourth and fifth time this project has been misled by one.

### The readout says it

`report()` now carries `compressed` or `TRUE size`. Confirming the toggle used
to need a temporary probe compiled into the layer; it now needs one glance at
the line already on screen. **A thing that is hard to check gets checked
wrongly** - twice, here - and the cheapest fix for that is to make the state
visible rather than to be more careful next time.

## D143 - The one layer that belonged to neither category

Phone, with a zoom range attached: *"we need to fix this overlapping, z-1.1 and
z-1.0 check that overlapping."* A soft disc, larger than the Earth and centred
on it, in a view where the globe was supposed to be gone.

Asking the running map at exactly those zooms: **every style layer hidden
except one**, and that one was `background`.

D139's `globeLayerIds` is built from two rules, and `background` falls outside
both:

- `cartographyLayerIds` finds layers **by source**, and the background layer has
  no source.
- `ownLayerIds` finds them **by the `orbital-` prefix**, and the background
  layer has no prefix.

A rule made of two categories will miss whatever belongs to neither, and this
style has exactly one such layer. It went on painting the globe's disc after
everything else was switched off.

Proved rather than argued: painting it red at z-1.1 turned the leftover disc
red. That test had been run before and was inconclusive, because the app was in
a state I had already broken with earlier probes - the same experiment on a
clean load answered in one frame.

It is restored explicitly on the way back in, rather than by `applyBody`, which
decides from the cartography and Orbital's own layers and has never had an
opinion about the background. In globe projection this layer paints the globe
rather than the canvas, so hiding it leaves space black rather than leaving a
hole - checked at zoom 2.5, where the Earth comes back whole.

### The pattern this is the third instance of

D141 hid every layer and the atmosphere remained, because the atmosphere is not
a layer. D139 hid every ground layer and a disc remained, because it was two
thousand aircraft. Now: hid everything the two rules name, and a disc remained,
because one layer is named by neither rule.

Each time the fix was cheap and finding it was not, and each time the thing that
found it was **asking the running map what was still visible** rather than
reasoning about what should have been.

## D144 - The overlap was the design, not a leak

Phone, with a screenshot at zoom -0.1: a full-size Earth complete with its
aircraft, sitting among planets drawn a twentieth of its size - Jupiter smaller
than the globe beside it - and the question *"cannot we just make our original
Earth that size in it?"*

**No, and the reason is worth stating once.** MapLibre draws the world under the
camera at radius 1 at every zoom; it is the projection, not an object. The
alternative is to scale the system up around it, and that does not fit either:
the camera bottoms out at zoom -2 with about **27 globe radii** on screen, and
matching a radius-1 Earth would put Neptune's orbit at 75. Neither the globe nor
the system can be resized, so the globe hands over.

### Three fixes had missed it because it was not a bug

D140 gated the origin body, D141 removed the atmosphere, D143 found the
background layer. Each removed something real, and the overlap stayed, because
the overlap was **two numbers for one transition**: the planets began fading in
at 0.5 and the globe did not leave until -1.0. A zoom and a half where both
worlds were on screen at once - by design, and correctly implemented.

One number now. `SOLAR_MAX_ZOOM` *is* the handover: above it the globe and
nothing else, below it the solar system and no globe. `PlanetView` imports that
constant rather than repeating it, and a test asserts the basemap agrees.

The imagery dissolves over the three tenths of a zoom above the handover, since
it is the one part of the swap that can be half-done and it is the part carrying
the picture. Everything else is a visibility switch, which cannot fade.

Measured after: at -0.1 the globe alone with its traffic and `not drawn - zoom
-0.1 past -1`; at -1.15 the globe gone and the planets at 0.30; at -1.7 the full
system with no globe and no halo.

## D145 - The atmosphere is off, and what was left is the photograph

Phone: *"the sun light should not apply when we zoom into our earth and left the
sun system view."*

Two things were producing light on the globe, and only one of them is ours.

**Ours:** MapLibre's globe atmosphere. D141 faded it with the globe and kept it
at close zoom, arguing that the soft edge is what makes a globe look like a
planet. That was my aesthetic judgement, Phone has now seen both, and it is
their call. It is off at every zoom - a flat 0 rather than a zoom expression,
which also deletes a pair of constants that had to stay in step with the solar
layer. The halo can no longer outlive the globe by drifting, which was the whole
of D141.

**Not ours:** a warm rim along the limb, brightest where Australia or Greenland
meets the edge of the sphere. That is **land in the NASA imagery** catching the
limb, and it is still there with the sky removed from the style entirely -
checked by rotating the globe, where it follows the land rather than the edge.
Recorded so nobody hunts it a second time.

### Three wrong candidates, each eliminated by a measurement

- **The sky.** Setting every sky property to black left the rim untouched.
- **The 3D layers.** Hiding the satellite shell, the terminator and the aircraft
  left it untouched.
- **A day/night effect.** The globe looked half-dark centred on the Pacific and
  half-lit centred on Africa, which reads as a terminator and is not one: the
  Pacific is ocean, and ocean is dark in this imagery. Rotating rather than
  staring is what separated those two explanations.

## D146 - Accounts, and the first thing Orbital has to keep

The freemium discussion needs somewhere to record who has paid, so this is the
first state in the project that must survive a restart and cannot be refetched
from anywhere. Everything else is either in memory or a cache that can be thrown
away.

### Two dependencies not added

**SQLite through the standard library**, not SQLAlchemy: one table, five
columns, and a file beside the element cache. The project earns dependencies one
at a time - every entry in `pyproject.toml` carries its reason - and an ORM for
one table would not survive that test.

**`hashlib.scrypt`**, not bcrypt or argon2. It is in the standard library, it is
memory-hard (the property that makes an offline GPU attack expensive rather than
merely slow), and it means the sensitive part of this feature adds no supply
chain at all.

### The parameters travel with the hash

A stored hash is `scrypt$N$r$p$salt$key`, so the cost can be raised later
without invalidating a single account: an old hash still verifies under its own
parameters, and is re-hashed on the next successful sign-in - the one moment the
password is in hand and a stronger hash can be made without asking anybody
anything. A scheme that hard-codes its cost must choose between staying weak
forever and locking everybody out.

### Three refusals worth naming

**The `Account` type has no password hash on it.** Not hidden, absent. A struct
carrying it is eventually logged, serialised or returned; the way to prevent
that is for the field not to exist. A test asserts it.

**An unknown address and a wrong password give the same answer**, and take the
same time - the miss path still spends a full hash. Distinguishing them tells an
attacker which addresses are registered, and a stopwatch discloses it just as
well as a message does.

**No movement profile.** An account is an email, a hash, a tier and a date.
There is no name, no location, no history of what anybody looked at. A flight
tracker is exactly the sort of application that could quietly accumulate one,
and the freemium design sells *computed* things - predictions, alerts, exports -
none of which require knowing who a person is beyond "this row paid".

### Verified by breaking it

A fixed salt fails the test that two hashes of one password differ. A
`return True` verifier fails two rejection tests. Removing the email folding
fails four. The tests are not decorative.

## D147 - Sessions, and four things not done the usual way

### Not a JWT

A signed token verifies without a lookup, which buys nothing here: the database
is already open for any request that touches an account. What it costs is a
signing secret to manage and leak, and **no way to revoke a session before it
expires** - a valid signature is valid until the clock says otherwise. A row can
be deleted, so signing out signs you out. A test copies the cookie, signs out,
puts the cookie back and asserts it is dead.

### The token is hashed fast, the password slowly

Only a SHA-256 of the session token is stored, for the same reason passwords are
not stored in the clear. But it is hashed **fast**, deliberately: a password is
low-entropy and guessable, so the slow hash is the defence; a session token is
32 bytes from `secrets` and cannot be guessed at any speed worth attempting.
scrypt here would add tens of milliseconds to every authenticated request in
exchange for nothing. Knowing which of the two needs the expensive treatment is
the whole of it.

### An HttpOnly cookie, not a token in the page

The common alternative is to return the token in the body and keep it in
`localStorage`, where anything that can run a script can read it - and a session
token's entire value is that it cannot be read. `HttpOnly` puts it where no
JavaScript can reach, ours included. The cost is that the browser sends it
automatically, which is the CSRF shape, so `SameSite=Lax` (not sent on
cross-site POSTs; Lax rather than Strict so following a link in does not look
like being signed out) and `Secure` off only for local http, where a Secure
cookie is simply never sent and the sign-in looks broken instead.

### `email-validator` not added

`EmailStr` would have brought a dependency to enforce a grammar. **The only real
validation of an address is sending a message to it**, which this does not do -
so a strict grammar proves nothing and reliably rejects valid unusual addresses.
One `@`, something either side, no spaces.

### What is deliberately not disclosed

Registering an address that already exists returns 409 with *"that address
cannot be registered"* - not "already registered", and not the address. The
endpoint is unauthenticated, so anybody could otherwise use it to ask whether a
given person has an account here. Sign-in gives one message for a wrong password
and an unknown address, matching the store, which gives one answer and spends
the same time on both (D146).

### Rate limiting, and its honest limit

Eight attempts per address in five minutes. Without it a slow hash is only a
speed bump for someone asking a thousand times a second. Per **address** rather
than globally, or one attacker locks out every user and the defence becomes the
denial of service - a test asserts that. It is in-process memory, which is
correct for one process and is the first thing to replace if this is ever run on
two.

### Verified by breaking it

`httponly=False` fails the cookie test. Removing the revoke on sign-out fails
the stolen-cookie test. Both were run.

The database lives under `.cache/`, which is already gitignored - so a file of
password hashes cannot be committed by accident.

## D148 - Signing in from the browser, and the bug only using it would find

The frontend half: one control in the header, the judgements in `auth.ts` where
they can be tested, and the component thin enough to read - the shape
`moonFacts` and `routeSummary` already have, because this project has no
render harness.

### The client's checks are a courtesy, not a control

Every rule in `auth.ts` is also enforced in `app/api/auth.py`, and that is the
only reason it is safe to have them. A check in the browser exists to say "that
password is too short" without a round trip; anybody who deletes it still
cannot register a short password. Worth stating because the opposite mistake is
invisible: validation that lives only in the client looks exactly like
validation until somebody posts to the endpoint directly.

The messages are the **server's own words** wherever it gave them, because they
are deliberately vague in the places that matter - a taken address and a wrong
password are both phrased so as not to confirm whether an account exists (D147).
Rewriting them in the client would undo that on the last step.

### It says nothing until it knows

`accountChecked` is separate from `account`, and gates the whole control.
Without it the header shows "Sign in" on every page load and corrects itself a
moment later, which reads as being signed out and then back in - alarming for
precisely the people who care.

### Proved in a real browser, not from a header

The header assertion (`httponly` in `set-cookie`) is a backend test. In the
running app, with a live session authenticating every request, **`document.cookie`
is empty**. That is the property the whole cookie decision was for, and it can
only be checked where scripts actually run.

### The bug the tests could not have caught

Register, sign out, then sign in again - and the panel reopened still in
*register* mode, so the correct password went to `/register` and came back
"that address cannot be registered". Baffling, and being deliberately vague, no
help at all. The pure logic was right and every test passed; the fault was a
piece of state the component held across a close.

Reset with the rest of the form. This is the second time this session that
using the thing found what testing it could not - the first was the aeroplane
behind its own track.

---

## D149 - The first thing a tier changes: the time-travel window

Phases 1-3 built accounts that worked and did nothing. You could register, sign
in, and be told you were on the free tier, and every feature behaved identically
either way. This is the phase where `tier` changes an answer.

**Free reaches 24 hours either way; premium reaches 7 days.**

### Why this feature and not another

Because it is the one capability Orbital has that is genuinely expensive to want
and cheap to serve. A satellite position is *computed*, so an instant a week out
costs the same arithmetic as the present one - which is precisely what makes it
an honest paid feature rather than an artificial restriction on something that
was free to give. Nothing is being throttled that we could afford to hand out.
What is sold is the **reach** of a capability, and the free tier keeps a full day
of it in both directions, which is more than enough to answer "when does this
pass over me tonight".

It also lands where the licensing already pointed. The aircraft layer is
somebody else's data under ODbL; the satellite layer is *our* arithmetic over
public elements. The thing users come for is the thing we least own, and the
thing we can sell is the thing we compute - the same line D119 found, arrived at
from the commercial side.

### Two bounds of different kinds, kept in different modules

- **Seven days is physics.** SGP4 drifts roughly a kilometre a day from an
  element set's epoch, so past a week the answer stops being one. It lives in
  `timeTravel.ts` and `propagate`.
- **The tier windows are policy.** A commercial decision that can change with a
  pricing page. They live in `entitlements.ts` / `entitlements.py`.

They are deliberately not spelled the same way, because the moment they are,
somebody raises the premium window to thirty days - the constant was right
there - and Orbital starts serving confident nonsense. Every tier window is
passed through `min` against the accuracy bound.

And **the premium window already *is* the accuracy bound**: premium buys all the
reach that exists, not a larger slice of a bigger one. There is no hidden tier
above it because there is nothing left to sell, which is a thing a pricing page
should be able to say.

### Where it is enforced, and where it merely shows

The server enforces it, in `app/api/satellites.py`. The client's copy is a
courtesy: deleting it would change only how pleasant the refusal is - the slider
would run further and the request would come back 403.

**A 403, not a silent clamp.** The client already clamps its own slider, so a
request past the window is either a bug or a request made around the interface.
Answering with a quietly different instant than the one asked for would hide
both, and this layer's one standing rule is that it never shows a position while
implying it is something else.

This is also the one bound that *can* be checked at the door, and the contrast
is worth keeping. D119 refused to check the accuracy bound in the route, because
it is measured per element set against epochs that differ by hours across the
catalogue, so there is no single instant to compare against. The entitlement
bound is measured against *now*, which every request shares.

### The grace, which exists for a failure no test can produce

The client clamps to exactly `now ± window`, and then the request spends a moment
in flight, so by the time the server reads its own clock a perfectly legitimate
edge request is a few seconds outside. Without five minutes of slack the
slider's own end stop would intermittently 403 - a failure appearing only at the
extreme, only sometimes, and only for real users, because a test computes both
instants from one frozen clock.

### The bug, which was found by signing out

Signing out has to take the reach back with it: rewind six days as premium, sign
out, and the map would otherwise be left showing an instant the server now
refuses, with nothing on screen saying why.

The obvious fix hangs the browser. Written as an effect depending on
`viewInstant` and reading `Date.now()`, it pulls the instant to exactly
`now - window`; that is a new value, so the effect runs again; and by then `now`
has moved on, so the edge it just wrote is already outside. React reaches
"Maximum update depth exceeded" in under a second and **renders an empty page**.

Every unit test passed throughout. A pure function given a frozen clock cannot
exhibit it. It was found by signing out of a rewound map and watching the page
go blank - the third time in three sessions that using the thing found what
testing it could not, after the aeroplane behind its own track (D138) and the
sign-in panel reopening in register mode (D148).

The fix re-clamps when the **entitlement** changes rather than when the instant
does, reading the instant through the store instead of a dependency. Drift
afterwards is not a problem to solve: `usePolling` stops polling entirely while
the map is rewound, so the one request that matters is made immediately, well
inside the grace.

---

## D150 - Advertising slots, and where they are not

The other side of the free tier. D149 gave premium something to buy; this is
what free costs instead: two slots, shown to everybody who is not premium and to
nobody who is. Premium buys their **absence** - not fewer, not smaller.

### They are house ads, which is a decision and not a placeholder

There is no third-party network here - no AdSense tag, no prebid, no pixel - and
adding one is not a small later change:

- Every one of them works by shipping something about the viewer to somebody
  else. Orbital's account design says the opposite in as many words: an account
  is an email, a hash, a tier and a date, and there is deliberately no record of
  what anybody looked at (D146). A network tag would undo that from the outside,
  on a page that never asked.
- It needs a live domain, a policy review and an approved account.
- It is a decision about *Phone's* users, not a detail of a component.

So the inventory is Orbital talking about Orbital, which is what a freemium
product actually shows before it has advertisers. The seam a network would fill
is one function, `inventoryFor`, returning a list; the slot component does not
care where the list came from. Every card names its sponsor and carries a
`SPONSORED` label, because an advertisement that is not marked as one is a
different thing with a different name.

### Where they go: the first attempt was wrong

The first build gave the slots their own grid rows - a leaderboard across the
top and a rail down the right - and made `.app` a grid so the map genuinely got
smaller. It worked, and it was the wrong thing: **the globe is the product, and
an advertisement is the one element on this page that is not, so it is the one
element that does not get to take the product's space.** Every other panel in
Orbital floats over the map for exactly that reason, and the ads had been given
a privilege the legend does not have.

Rewound. They now go where the chrome already has room:

- **The header pill**, in the gap the header leaves past the layer toggle. On a
  1043px viewport that gap is about 300px and was empty.
- **The rail card**, top right, the same width and corner as the detail panel -
  because it is the same kind of object, something laid over the map that can be
  ignored.

Two rules fell out of measuring rather than guessing:

- **It yields to the product.** The rail is not rendered at all while a detail
  or moon panel is open. Those panels use that corner, and an ad must never be
  the reason somebody cannot read the thing they just clicked on.
- **It yields to the chrome.** The search box is `flex: 1`, so adding anything
  to the header row makes every flexible child shrink together: the search input
  measured 18px narrower the moment the pill appeared. A high `flex-shrink` on
  the ad puts all of that loss on the ad instead, and below about 1010px the
  pill is not rendered - an ad that shrinks the search box has taken the map's
  space by another route.

### A third slot, and two more measurements

Phone pointed at two more empty runs: the header past the layer toggle, and the
status strip past the data age. Both are chrome that was already there, so both
are free by the rule above.

- **The header pill moved next to the toggle** instead of being pinned to the
  far corner with `margin-left: auto`. On a 1900px screen the corner isolates
  it; beside the toggle it is in the flow of the row that had run out of things
  to hold.
- **A third slot in the status strip**, plain text with no surface and no
  border, because that row is a gradient over the map with text on it and a
  boxed card there looks like a control that fell out of the header.

Two rules the status slot needed, neither of them obvious until the row was
looked at with something wrong in it:

- **It is last, and it is absent on a fault.** Placed after the data age it sat
  between the age and "cannot reach the Orbital backend". An advertisement must
  not come between a reader and the sentence saying the feed is down - and one
  step further, this row is the one place Orbital admits something is broken,
  which is not a moment to be selling anything. So it renders only while the
  severity is `ok`.
- **It stops well short of the attribution.** That control shares this row and
  is a licence obligation - OpenFreeMap, OpenMapTiles, OpenStreetMap and NASA
  all require it - so it is the one thing on screen an ad may never crowd. At
  1043px the attribution starts at x553 and the slot is not rendered at all;
  at 1900px the slot ends at x753 and the attribution begins at x1410.

**And a shrink factor turned out not to be enough.** The rule that the ad yields
before the search box does was already written, and the pill still took 77px
from the search input once its cap rose to 420: flex shrinkage is weighted by
base size, so a wider pill simply takes a larger share of a bigger overflow.
The fix is to cap it against the viewport - `min(420px, calc(100vw - 800px))` -
so the row cannot overflow on the ad's account at all. Measured after: the
search input holds its full 380px at both 1043 and 1900.

### Proper sizes, and what that costs

Phone asked for the two horizontal slots at real ad sizes, so they are now the
units an advertiser actually buys rather than whatever happened to fit:
**728x90 leaderboard**, **468x60 banner**, **320x50 mobile leaderboard**, with
the rail already a **300x250 medium rectangle** by width. The top slot steps
down through all three; the anchored one uses the top two and is otherwise not
rendered.

**Stepping between fixed units rather than letting one box shrink.** A slot that
shrinks continuously is not the size it claims: a 728x90 creative in a 540px box
is a squashed 728x90, and the whole point of naming a size is that the thing
delivered fits it. So the widths are fixed, the headline truncates instead of
wrapping the box taller, and the body line appears only in the units with the
height for it.

**The bottom slot moved out of the status strip to do it.** A 728x90 cannot sit
inline in a row of 12px text, so it is now anchored bottom centre - the position
an anchored ad conventionally takes, and the only genuinely empty region left
down there, with the legend holding the bottom left and the attribution the
bottom right.

Two more yielding rules came with it, and both were measured rather than
assumed:

- **It is not rendered while the time scrubber is on screen.** That control is
  centred in exactly this place, and it only exists on the satellite layer
  (D119), so on aircraft the bottom of the screen is genuinely free.
- **It is not rendered below 1400px**, where a 468 centred would reach the
  legend on one side or the attribution on the other.

Checked at 1920, 1600, 1300, 1150 and 1043 with a rect-intersection probe over
every piece of chrome: no overlap at any width, the search box holds its full
380px at every step, and the canvas still measures the whole viewport.

**And the honest cost.** These float, so nothing reflows and the map keeps every
pixel of canvas - but a 90px leaderboard covers more of the *view* than a 32px
pill did. That is a real trade, made deliberately at Phone's request, and the
thing that keeps it from being the mistake the first attempt made is that the
globe is still all there underneath: the ad can be ignored, and it never takes
space the map cannot have back.

Rotation is a slow crossfade, switched off entirely under
`prefers-reduced-motion`, in the component *and* in the stylesheet. Movement in
the corner of the eye is precisely what that preference is set to stop, and an
advertisement is precisely the thing that would ignore it.

---

## D151 - Giving the sign-in its moments

The sign-in built in D146-D148 worked and had no shape in time. A form appeared,
and then it was gone, and the only way to tell a success from a failure was that
the panel was no longer there. `busy` was the only thing the component knew
about time, and a boolean cannot distinguish those two endings - both of them
set it back to false.

A phase can. `idle → working → success | error` lives in `authAnimation.ts` with
the durations, so the timings are testable and the component only renders them.

What the phases buy:

- **A welcome that is held for 900ms before the panel closes.** The account is
  signed in well before that line; the pause is entirely so the person finds
  out. An interface that vanishes the instant it succeeds leaves somebody
  wondering whether it did. It replaces the form rather than sitting above it,
  because a filled-in form behind a "you are in" message asks the reader to work
  out which of the two is true. And it says "Welcome to Orbital" to somebody
  registering, who has not come back.
- **A shake on a refusal**, small and quick - a headshake, not a tantrum - and
  the panel returns to idle when it is done, so it is not left wearing a
  refusal it has finished expressing. The message stays; only the movement ends.
- **A moving submit button while a request is in flight**, because a slow
  network and a dead button look identical otherwise.
- **A tick drawn from two borders of a rotated box**, so the confirmation costs
  no image and no icon library.

### Reduced motion takes every duration to zero, except the one that means

`prefers-reduced-motion` is not a preference about taste. It is set by people for
whom movement causes nausea, migraine or a vestibular attack, and by people using
screen magnification, where a panel sliding across a four-times-zoomed viewport
is genuinely disorienting. An interface that keeps a *little* of the motion has
misunderstood what was asked, so `STILL` is zeroes.

The exception is `successHold`, which is shortened rather than removed: it is the
one duration carrying information rather than decoration, and a confirmation
nobody has time to read is not a kindness.

The durations reach the stylesheet as custom properties rather than being written
twice, so the CSS gets zero without needing to know why. `prefersReducedMotion`
is one function in `motion.ts` for the same reason `isPremium` is one function:
the answer must not differ between the places that ask.

---

## D152 - An admin tier, and a command that can make one

Two things Orbital did not have: a tier above premium for whoever runs the
deployment, and any supported way to create an account that is not free. The
second was recorded as an honest gap - "no way to become premium except editing
the database by hand" - and this closes it.

### Admin is a tier, and it is in a set

`TIER_ADMIN` sits alongside free and premium rather than being a separate
`is_admin` flag, because everything that reads an account already reads a tier
and a second axis would give every gate two questions to get right instead of
one.

More importantly it is a member of `PAID_TIERS`, and every entitlement asks the
**set** rather than comparing to `TIER_PREMIUM`:

```python
window = PREMIUM_WINDOW if tier in PAID_TIERS else FREE_WINDOW
```

**The failure this avoids is silent.** A gate written `tier == TIER_PREMIUM`
gives an administrator *less* than a paying customer, and nothing anywhere
reports a fault: the account works, signs in, shows a badge, and is simply short
of what it should have. The frontend keeps the same set for the same reason, and
both sides have a test that says so in as many words.

The safe direction is preserved: a tier nobody has heard of is still read as
free. `administrator` is not `admin`, and a typo in the database must not be a
free upgrade.

### The password is typed, never passed

There is deliberately no `--password` flag, and a test asserts its absence. An
argument is visible in `ps` to every other user on the machine and lands in
shell history, where it outlives the memory of having typed it. `getpass` reads
it without echoing, asks twice, and the value never leaves the process except as
a scrypt hash.

Asking twice is not ceremony. Nothing in Orbital can reset a password, so a typo
in the one that creates the administrator locks them out of their own
deployment.

That is also why this is a command and not an endpoint. An endpoint that makes
administrators is an endpoint somebody can reach; a command needs the file and
the machine, which is the access an administrator already implies.

### A vacuous test, caught by breaking the code

`test_asks_again_when_the_two_do_not_match` was written with the same password
throughout, and it **passed with the confirmation check deleted** - the
mismatched second entry was simply discarded and the right password stored
anyway. Rewritten so the first attempt differs from the final one, it fails
exactly when the check is gone. This is the third variety of vacuous test this
project has found by mutating the code under a green suite.

### And a real footgun, on the first real run

`Settings.accounts_db_path` is relative to the working directory. Running the
command from `backend/` resolved to `backend/.cache/orbital-accounts.sqlite`
while the server, started from the repository root, reads `.cache/` there. Two
databases, no error, and an administrator who cannot sign in with credentials
that are provably correct.

Hence `--db`, and hence every command printing the path it resolved *before* it
does anything.

---

## D153 - The sign-in became a page

It was a dropdown hanging off a header button. It is now a screen, which is what
signing in looks like nearly everywhere else and gives two fields, their rules,
their failure messages and a second mode the room to be read.

Nothing about the form changed - `auth.ts` still holds the rules, and
`authAnimation.ts` still holds the phases from D151. Only where it happens.

**Signing out stayed a dropdown**, which is not an inconsistency: signing in is a
form that earns a screen, and signing out is one button that would be ceremony
behind a full page.

### A page without a router

Orbital has no routing and adding a router for one screen would be a large
change to justify. But what a page actually needs from a router is smaller than
a router: **an address while it is open, and a Back button that closes it.** Both
are a hash and two calls to `history`.

A full-screen view that swallows Back is the commonest way a single-page app
breaks a browser - the reader presses it expecting to dismiss what is in front of
them, and instead the app navigates away from something else while the overlay
stays put.

`moveFor` decides what happens to the history stack, so the rule is testable
without a browser. Closing has to **go back** rather than replace: opening pushes
an entry, and closing any other way has to remove the one it pushed, or the stack
grows an entry per open-and-dismiss and Back then appears to do nothing for as
many presses as the page was opened. Measured in the running app: four
open-and-close cycles grow the history by zero.

### What a full-screen overlay owes the reader

- **Escape closes it**, and focus returns to the button that opened it, so a
  keyboard reader is not dropped at the top of the document.
- **Tab stays inside.** The map behind is still in the tab order as far as the
  browser is concerned, and tabbing into a form nobody can see is worse than no
  keyboard support at all.
- **The email field is focused on arrival**, because a page whose whole purpose
  is one form should not need a click first.
- **The form is fresh every time it opens.** Reopening onto a half-filled
  attempt is the same class of fault as the panel that reopened in register mode
  (D148): state kept across a close that should not have been.

The globe stays faintly visible behind a blur rather than being blanked. A
sign-in that hides the map entirely makes Orbital feel like it navigated
somewhere else, when the map is exactly where the reader is about to be
returned to.

---

## D154 - The satellites drawn twice, and the memo that could not see why

Reported: leave Earth for the solar system, come back, and the satellites are on
the surface **and** in orbit at the same time.

The shell and the ground symbols are two drawings of the same objects, and D105
established that exactly one is on at a time - the shell owns the view while the
whole planet is in frame, the sub-satellite points past that. The frame loop
enforced it, and it enforced it through a memo:

```js
let lastShellShowing = null;
...
if (shellShowing !== lastShellShowing) { ...set visibility... }
```

That is correct exactly as long as nothing else writes to those layers.
Something else does. `applyBody` decides visibility from the **body** and turns
every Earth layer back on when the camera returns to Earth - which is precisely
what happens on the way back from the solar view. The memo saw no change,
because the *intent* had not changed, and so nothing put the ground symbols back
down. Two thousand satellites on the surface and the same two thousand in orbit.

**This is D141 one layer along.** There the same collision was between
`applyBody` and the globe handover, and the fix was to read the zoom rather than
track a flag so the two could not disagree. Here the fix is to read the map:
`setVisibility` in `layerSync.ts` asks the style what a layer's visibility
actually is and writes only when it differs.

The lesson generalises and is worth stating plainly: **a cache of what you asked
for is not a record of what is true**, and the moment a second writer exists it
stops being either. It is not enough for the memo to be correct; it has to be
the only writer, and nothing in the code said so.

Reading first rather than writing every frame keeps the actual `setLayoutProperty`
on transitions only - the reason the memo existed - while making the read the
source of truth, so a write by anybody else is corrected on the next frame
instead of never.

The same memo existed for the aircraft furniture, with the same fault: airports
and receiver coverage would come back up over a satellite view after the same
round trip. Both are gone.

**Proved rather than argued.** With the fix in, setting `orbital-satellites` to
`visible` from the console - exactly what `applyBody` does - is corrected back
to `none` within two frames. Under the memo it would have stuck, which is the
bug as reported.

---

## D155 - Light-speed, and where the line is

Phone asked for the trip between worlds to feel like travelling at light speed
rather than a zoom out and a zoom in.

### The honesty question, answered rather than dodged

`bodyFlight.ts` says - and still says - that Orbital cannot fly you to Mars, and
that building something which *looked* like a literal flight would be the most
elaborate lie in the project. So it is worth being exact about why this is not
that.

The lie would be a **fabricated observation**: a sky drawn as though it were
measured, with stars streaming past that no catalogue puts there. That is not
what this is. The real sky is `stars.ts`, it comes from a real catalogue, and it
does not move while this plays. The streaks are a full-screen rush of light on a
2D canvas above the map - nobody could mistake it for data, and it is the same
kind of statement as a fade.

The one thing tied to reality is the **direction**: the camera turns toward the
destination's true position while pulling out (D136), so the vanishing point the
streaks radiate from is the real bearing of the world being travelled to.

### The shape

Stars run outward from the centre on fixed bearings and **accelerate** -
distance grows with the square of the phase. A field moving outward at a
constant rate reads as falling snow; the same field accelerating reads as speed.

Intensity peaks at the **apex**, not the midpoint, because the apex is where the
world is actually swapped. The brightest instant should be the one with
something to hide; anywhere else leaves the swap in a quiet frame.

The camera was re-paced to match: `accelerate` on the way out, `decelerate` on
the way in, carried in the plan as a name rather than a closure so a plan stays
comparable data. One ease-out across both halves reads as a single continuous
zoom, which is the thing this was asked to stop being.

Reduced motion gets **nothing at all** - not slower and not fainter. A
full-screen rush of accelerating light is close to the definition of what that
preference exists to prevent. The trip still happens, at the same length, with
the same camera moves.

It is a plain 2D canvas rather than a MapLibre custom layer, and that is what
makes it safe: a custom layer shares the map's WebGL context and depth buffer,
and several sessions of this project are about what happens when something is
drawn in a frame it does not own. This cannot disturb a pixel of the globe.

### Three instrument failures in one sitting

None of this could be verified by watching, and each attempt failed differently.

1. **A stale page.** Vite's HMR had failed to reload `PlanetView.tsx`, leaving a
   `ReferenceError` and a page running half-old code. Every reading taken through
   it was void, and nothing on screen said so.
2. **A duplicate store.** Probing state with
   `await import('/src/state/store.ts')` gets a **second copy** of the module -
   Vite serves the app's copy under a different URL - with its own state and its
   own subscribers. `setFlyingTo` on it did nothing the app could see, and the
   readings looked exactly like a trip that aborted after 230ms. This is the
   sharpest version yet of the probe fighting its own code.
3. **A pane that will not paint.** The preview throttles
   `requestAnimationFrame` hard enough that a three-second animation can pass in
   two frames, so an `easeTo` snaps to its target and a canvas drawn on rAF can
   be empty every time it is sampled. The same finding as the ResizeObserver one
   earlier this session, in a new place.

The response was to stop trying to watch it. `drawStreaks` takes a narrow
`StrokeContext`, so the drawing is checked with a **recorder** in a test
environment that has no canvas at all: that a full field is emitted at the apex,
that the most ink is laid down there, that the field is centred, that no
coordinate is ever NaN - which canvas renders as nothing, silently, and is the
hardest possible version of this bug to find.

Two of those tests were wrong on the first attempt, and in a way worth recording:
counting strokes saturates, because by a fifth of the way in every star is
already above the alpha floor, so the count compared nothing and read 200 = 200;
and asserting the *extremes* of two hundred random bearings are symmetric was
measuring sampling noise, which honestly reported 627 against an expected 600.
Total ink and a four-star compass field are exact. **The failures were the
tests, not the code** - which is only knowable because they were run against a
mutation.

---

## D156 - A label on the radius, and the true-size toggle removed

### The label

The body picker showed `6,371 km` beside Earth. Phone asked what the kilometres
were about, which is the answer: **a bare number in that position reads as a
distance**, because "how far away is it" is the obvious question to ask about a
list of worlds. It was a mean radius. It now says `radius 6,371 km`.

The column answers one question - *can I stand on this, and if so how big is
it* - so it is a radius for the four bodies with usable surface imagery and a
reason instead for the six that have none. That is also why the Sun's 696,000 km
never appeared: it is not landable, so the slot is spent explaining why.

One word, and the sort of defect no test can hold an opinion about. It was found
by somebody reading the screen and not understanding it, which is the only
instrument there is for this class of fault.

### The toggle, removed

D137 built a true-size mode: the Sun held fixed and every other body falling to
its real proportion of it. D142 then spent a long time establishing that it
*worked*, through two invalid checks and a permanent line in the debug readout.

It is gone, at Phone's request, and the reasoning is worth keeping because the
feature was not broken.

**It was correct and it was not worth its mode.** What true scale shows is one
disc and nine specks, most of them below a pixel - which is the honest picture
and also an unusable one; the inner planets cannot be seen, let alone clicked.
The thing the toggle existed to say is said better by `SCALE_NOTE`, which is on
screen permanently and costs nobody a mode: *distances and sizes are compressed
separately, angles are true, nothing is to scale.*

`bodyExaggeration` stays, without its parameter. It is what makes that note
executable rather than decorative: the compression is a number, and a test can
assert that Earth is drawn bigger than life and the Moon more so again.

### What removing it quietly changed, and nearly broke

The geometry rebuild anchor was `` `${trueScale()}` `` - body radii are baked
into geometry, so the toggle had to rebuild eight spheres and a ring when it
flipped. With the toggle gone the anchor had to become something, and the
obvious something was the origin.

That would have been wrong. Radii depend on neither the date nor the world
underfoot, so anchoring on the origin would dispose and rebuild the whole set
**in the middle of a flight**, for a set of sizes that had not changed. The
anchor is a constant now, the spheres are built exactly once, and the machinery
is kept as the place the next thing baked into geometry has to declare itself.

A removal is not only a deletion: it is every place the deleted thing was the
reason something else had a shape.

---

## D157 - Premium becomes reachable, and the button does not say Buy

The gap written down since D149: premium could only be granted by editing SQLite
or running the admin command. There is now a page describing it and a switch that
turns it on.

### There is no payment, and that is the honest part

A processor needs an account, live keys, a domain and a policy review, none of
which belong in this repository. What would be **wrong** is pretending. A button
labelled *Buy* that takes no money is a lie told in the interface, and it is the
one kind of dishonesty an application can commit unnoticed, because nobody
re-reads a pricing page.

So the button says `Switch premium on`, the note saying there is no payment is
set as plainly as everything else rather than as fine print, and a test asserts
that none of the page's own words are `buy`, `purchase`, `pay` or `checkout`.
That test exists to stop a future edit quietly making the page lie.

`self_serve_premium` is the switch behind it: on because nobody is being billed,
and the first thing to turn off the day anybody is - at which point the route is
where a processor's webhook goes instead.

### The one line that is not a placeholder

`admin` is refused whatever the setting says. Any signed-in reader can reach this
endpoint, so **a tier it accepts is a tier anybody can have**, and running the
deployment must not be one of them. It is refused with the same answer as a
nonsense tier, because which tiers exist beyond the two on offer is a fact about
the deployment a stranger does not need.

### The page is checked against the code it describes

Every row in the comparison comes from `premium.ts`, and the tests assert the
numbers match the modules that enforce them - the window against
`entitlements.ts`, the ad rows against `ads.ts`. **A feature list that drifts
from the code is a lie nobody notices.**

`differences()` is its own function so that padding the list is visible rather
than easy: the day it returns three rows, something was added to premium or taken
away from free. Today it returns two, and the page says so by dimming the five
rows where the tiers are identical rather than hiding them - hiding them would
make premium look like most of the product, when it is two rows of it.

### Everything that mentions premium now goes there

The ad slots' call to action said *See what premium does* and did nothing, which
is the same fault as an overstated pricing page: a claim in the interface the
application does not honour. It is a button now. So is the line on the sign-in
page, and the account menu's `What premium does` / `Manage premium`.

### One boolean became a name

`signInOpen` became `openPage: PageName | null`, because a second full-screen
page arrived and two booleans would have made *both open at once* a state the
types allow - the sort of thing that happens once and is then impossible to
reproduce. Moving between the two pages **replaces** the history entry rather
than pushing: they are siblings, not a trail, so Back from premium reached
through sign-in returns to the map.

### The bug that only appears on a pasted link

Arriving on `#premium` left the page shut and the hash cleared, and it was
intermittent before that.

Both of `usePageRoute`'s effects run in the same commit. On the very first render
the state is still `null` while the hash already says `premium`, so the
address-follows-state effect reads *a page was closed*, calls `history.back()` -
**navigating out of the application** - and the sync effect then reads the
now-empty hash and agrees nothing is open. Effect order does not fix it: the
second effect's `setPage` is not visible to the first one's closure until the
next render, and whether the browser had applied `back()` by then decided whether
it worked, which is why it worked once and failed later.

The first run is skipped outright. That is also the honest rule: **a page opened
by a link was not opened by the state, and there is nothing to push.**

### A seventh instrument failure, for the collection

A React *hooks order* error and a blank page, twice, on what looked like clean
loads. It was Fast Refresh: adding a `useRef` to a custom hook in another module
does not change `App`'s own signature, so React kept the mounted component and
the hook list shifted by one at the tail. Restarting the dev server and loading
once made it render perfectly.

The rule this keeps re-teaching: **after editing a hook, a stale page is not
evidence about the code.** The check that settles it is a server restart, not
another reload.

---

## D158 - Two states, and the band between them is not a place to stop

Phone's design, and it is the right one: the planet view and the solar system
are **states**, and the zooms between them are somewhere you pass through rather
than somewhere you are left.

### The measurement it answers

The handover is a single threshold and stays one - D139 to D145 are six attempts
at one symptom and having *two* thresholds caused the last of them. What the
single threshold does not fix is that the zooms either side are both poor views.
Measured on a 1990-pixel viewport:

| zoom | globe width | showing |
|---|---|---|
| -1.5 | 57 px | solar system, full opacity |
| -1.0 | 80 px | the handover |
| -0.9 | 85 px | globe, solar system off |
| 0 | 155 px | globe |
| 1 | 297 px | globe |

So crossing the handover swapped a full scene for a globe **four per cent of the
screen wide**, and it was reported as "all gone black". Below the handover is no
better: the planets are still fading in and mostly transparent until -1.5.

**It is viewport-dependent, which is why it was never seen here.** The same
85-pixel globe is a tenth of an 800-pixel pane and reads as a small globe; on a
1990-pixel screen it reads as nothing at all. A defect that only appears on a
wide display is one that a narrow development window structurally cannot find.

### The rule

`settleTarget` in `viewSettle.ts`. Rest anywhere strictly between
`SOLAR_FULL_ZOOM` and zoom 0 and the camera finishes the move on `moveend`.

**It follows the direction of travel, not the nearer edge.** The nearer edge was
the first version and it is wrong in a way that only shows in use: from the solar
system, one notch inward reaches about -1.4, which is nearer the system, so the
camera pushes straight back out and the view feels like it refuses to be zoomed.
Following the gesture means a nudge inward switches to the planet and a nudge
outward switches to the system - which is what having two states should feel
like. A move that changed no zoom at all, a pan ending in the band, has no
direction to follow and takes the nearer edge.

**It cannot oscillate**, and not by a constant: both targets are *outside* the
band, so the move that settles you can never land somewhere that needs settling
again. The geometry provides the hysteresis, and there is no second number to
keep in step - the sort of number D144 removed.

**On `moveend`, never during the move.** Snapping while a wheel is still turning
or two fingers are still moving fights the gesture, and an interface that pulls
against an input in progress feels broken in a way that is hard to name. Passing
through the band still looks exactly as it always did.

**Not during a trip between worlds.** That crosses the band deliberately, twice,
and has its own plan for where to stop (D126). Verified: a trip to Mars runs
1.84 → -1.63 → 1.5 with the settle registered and silent throughout.

### Where the two homes are

`SYSTEM_HOME` is `SOLAR_FULL_ZOOM`, imported rather than restated - a copy that
drifted would settle the camera where the system is still translucent, which is
half the fault being fixed.

`PLANET_HOME` is zoom 0, where the globe is about 155 pixels on a wide screen.
Deliberately not more generous: further out means a longer jump out of the band,
and this is the point at which the globe is unambiguous rather than the point at
which it is impressive. It is one constant if that turns out to be too modest.

### A test that was wrong first

`settleTarget(-0.9)` was asserted to land on the planet and it lands on the
system, because -0.9 was reached by zooming *out*. The test was wrong, and being
wrong is what produced the direction rule: writing down why the assertion failed
was the moment the nearer-edge version was seen to be a bounce-back.

---

## D159 - The solar system becomes a place

Phone's design: zooming out far enough should announce the solar system, then
show it as somewhere you can move around, with every planet named and the ones
you can stand on offering a way in.

### Names, and where they come from

The bodies are drawn by a WebGL layer, and HTML cannot be laid over something it
cannot locate. **The thing that draws them is what says where they are**: the
layer projects each body with the matrix it has just rendered with and publishes
the result.

The obvious shortcut is wrong. Taking the body's direction and calling
`map.project` on it gives a point on the globe's surface, and the bodies are at
different distances in a 3D scene - a direction says nothing about where along
that ray a sphere was actually drawn.

`solarMarkers.ts` holds the arithmetic so it can be tested without a GPU,
including the two mistakes that would otherwise be found by eye: reading the
matrix transposed, which is plausible everywhere except on the axes, and
forgetting that clip space counts up while screen coordinates count down, which
mirrors every label about the horizon.

The positions change every frame the camera moves, so they do **not** go through
the store - a write per frame would wake the whole application to report that a
planet moved four pixels. One mutable reference, polled on the component's own
animation frame, committed only when something moved a whole pixel.

### Visit

Every landable body that is not the one underfoot carries a **Visit** button,
which starts the existing trip (D126, D155). It appears on hover rather than
sitting there: ten buttons over a solar system is a toolbar, not a sky. Touch
pointers cannot hover, so under `(hover: none)` they are simply always there.

The labels clear themselves the moment the layer stops drawing, because the
layer publishes an empty list then - "no solar system on screen" and "no labels"
are one fact rather than two that can disagree.

### The approach

A cue that grows as the handover nears and is gone the instant the planets are
drawn: at that moment it has been overtaken by the thing it was announcing, and
a caption over a solar system saying one is ahead is worse than no caption.

It does not say "loading", and a test asserts that. Nothing is fetched at the
handover - the positions are already computed and the layer is already there.
"Loading" would be a lie about why the view is changing.

Measured across a zoom-out: nothing at z 0.25, the cue at 0.35 opacity by -0.34,
0.95 by -0.95, then gone at -1.25 with ten labels in its place.

### Dragging it, which needed taking over

MapLibre's drag-pan grabs the point of the globe under the cursor and moves it.
In the solar view **there is no globe under the cursor** - it is 57 pixels wide
at this zoom and the rest of the screen is sky - so a drag anywhere else does
nothing at all. Measured: a 220-pixel drag left the centre and every label
exactly where they were.

So the drag is handled directly while the system is drawing, as a camera move.
`panBy` is the right tool and **`setCenter` is emphatically not**: at this zoom
setting a centre makes MapLibre re-constrain the camera and it takes the *zoom*
with it, measured jumping from -1.5 to -0.03 - which falls out of the solar view
altogether. That is also the explanation for an oddity noticed earlier in the
session, where a programmatic pan appeared to change the zoom on its own.

### Two rough edges, stated rather than hidden

The scene moves about 1.4 times the pointer's distance rather than 1:1. It
follows the hand and reads as dragging, but it is livelier than it should be,
and the ratio is a property of the scene's projection rather than a constant to
divide out - worth measuring across zooms before fixing.

The inner planets crowd: at this compression Mercury, Venus, Earth and the Moon
sit close enough that their labels overlap near the Sun. The distances are
compressed by three orders of magnitude, so this is the compression showing
through rather than a layout bug, but it is the next thing to improve.

---

## D160 - Room for the inner planets, and a drag that is really a turn

### The compression could not do it, and neither could widening

The inner planets sat on top of each other. The first instinct is to tune the
distance compression, and it was measured across the whole family: with the
softening at 0.3 the inner four occupy 0.21 of the frame radius, at 0.05 they
occupy 0.20, at 1.0 they occupy 0.18, and raising the normalised log to a power
moves it by less than a hundredth. **Venus and Earth are 0.28 AU apart while
Neptune is 30 AU out**, and no monotone map of one axis gives the inner pairs
more than a sliver while still fitting Neptune in the frame.

The second instinct was to push each crowded body outward until it cleared its
neighbour and then renormalise so Neptune stayed on the rim. That is very nearly
a no-op and measurably so: **Venus to Earth went from 0.0518 to 0.0520**. Pushing
everything out and scaling everything back returns what it started with.

### Room has to be taken from somewhere

There is one frame, so a gap that grows is a gap that shrinks elsewhere, and
saying which is the whole decision. `allocateRadii` gives every adjacent pair
`MIN_GAP` of the frame first and shares the remainder in proportion to the
logarithm - so the curve still decides the shape and this decides the floor.

Venus to Earth is now **0.089** of the frame against 0.052, and the measured
on-screen separation went from overlapping to 46 pixels. The cost is named:
Mercury moved inward from 0.179 to 0.136, still clearing the Sun's drawn edge by
more than the floor.

It is the same bargain already struck for the Moon, drawn beside the Earth at a
fixed offset because 0.0026 AU cannot be resolved at all (D140). The distance
axis is already false and `SCALE_NOTE` says so; the angle is untouched.

### A test that had to be rewritten rather than relaxed

`keeps Mercury clear of the Sun rather than crushed onto it` asserted
`radiusFor(mercury) > 0.15` and failed at 0.136. The temptation is to lower the
number. But 0.15 was chosen against the curve of the day, and **the thing it was
named for - clearance between Mercury and the disc it might be crushed onto -
was still comfortable**. It now asserts that, against the Sun's drawn edge. A
threshold that has to be edited whenever the scale is tuned was not measuring
the claim it was named for.

### The labels needed the other half

Moving the bodies cannot fix everything: a name is sixty pixels wide whatever
the orbit does, and the Moon is drawn fifteen pixels from the Earth *on purpose*.
So `stackLabels` pushes a colliding label **down**, never sideways - down keeps
it under its own body where the eye can follow a column back up, while sideways
puts it under a neighbour and says the wrong thing. Nothing is dropped: every
planet was asked to be named, and de-cluttering by hiding answers a different
question.

Two rounds of that were spent estimating the wrong box. The body underfoot
carries a second line, "you are here", which is **taller than one line and wider
than its own name**; estimating either from the name alone left the Moon tucked
underneath it. The stack was right both times and was being handed the wrong
rectangle.

Measured at five zooms: clean at -1.05, -1.3, -1.5 and -2, with one residual
few-pixel touch between "you are here" and the Moon at -1.8.

### The drag was never a speed problem

Reported as too fast, and it is not a scalar. **MapLibre's camera always looks at
the centre of the world it is standing on, so panning turns the viewpoint rather
than sliding it.** Measured at z-1.5, per 100 pixels of pan:

| body | moves |
|---|---|
| Earth, underfoot | 0 |
| Mercury | +375 |
| Jupiter | +432 |
| Neptune | **-435** |

Bodies in different directions sweep differently, and some sweep the *other way*,
because that is what turning your head does. No constant makes them agree.

So `PAN_DAMPING` is chosen to put the **fastest** body near the pointer's own
speed rather than to make them all match. A 200-pixel drag now moves Jupiter 250
pixels where it moved 870 before. The rest still move at their own rates, which
is the honest behaviour of a rotation and not a defect to tune away.

---

## D161 - Two views, and a page turn between them

Phone, three times, and the third time exactly: **the planet view and the solar
system should be separate views, with a transition that says so** - not two ends
of a zoom.

Everything before this was a glide. The globe shrank, the planets faded up, the
camera settled, and at no point did the interface admit you had gone somewhere.
D158 stopped the reader being *left* in the band between them; this says what
crossing it is.

### What it says, and what it may not

**"Heading to the solar system"**, and "Heading to Mars" the other way. Not
"Loading", and a test enforces it: nothing is fetched at either end - the
positions are computed and the layer is already there - so a loading screen
would be a lie about why the view is changing, told in the one place the reader
has nothing else to look at.

### The hold outlasts the move on purpose

The camera settle is 420ms and the screen is held 1,100. A transition screen that
lifts while the view behind it is still moving shows the reader exactly the join
it exists to cover, which is worse than no screen at all - it draws the eye to
the seam first. A test asserts the one is longer than the other, so tuning either
cannot quietly invert them.

### Reduced motion loses the movement, not the sentence

Shortened rather than removed. The words are the answer to "what just happened",
and somebody who has asked for less movement has not asked to be told less. The
streaks and the drift go; the line and its dot stay.

### The streaks run on the right clock

`WarpField` was built for the trip between worlds, which is 3.7 seconds. Running
a 1.1-second view change on that clock would leave the field barely started when
the screen lifted, so the total and the loudest moment are read from whichever
journey is actually running.

Measured, zooming out: the settle fires at -1.14, the screen goes up, the camera
moves -1.25, -1.44, -1.5 behind it, and it lifts on arrival with the solar system
and its ten labels in place. Zooming back in: "Heading to Earth" from -1.22
through to 0, gone on arrival, labels cleared.

---

## D162 - Receiver coverage on Mars, for the third time in the same loop

Reported: receiver coverage drawn over Mars. Measured before touching anything -
on Mars, all four coverage layers, all three airport layers and both satellite
ground layers reported `visible`.

It is mine, from D154. That change replaced a stale visibility memo with a write
on every frame, and the write was gated on the zoom but **not on which world the
camera is standing on**. `applyBody` hides every Earth layer when the camera
leaves; the frame loop turned them straight back on, sixty times a second.

Receiver coverage is the sharpest possible example of why this matters. It is
not a stale annotation over Mars, it is a **false one**: it draws where volunteer
aerials can hear aircraft, and there are no aerials and no aircraft. D120 called
this out as a stronger claim than drawing something late, and D133 fixed the same
class once already by deriving the Earth-only set instead of listing it.

### The third instance, and the same answer each time

- **D141**: the handover tracked a flag while `applyBody` wrote the same layers.
  Fixed by reading the zoom.
- **D154**: the frame loop memoised what it had last set while `applyBody` wrote
  the same layers. Fixed by reading the style.
- **D162**: the frame loop wrote unconditionally while `applyBody` wrote the same
  layers on another world. Fixed by reading the active body.

Every one is two writers and no agreement about which is in charge, and every fix
is the same shape: **read what is true rather than assume what was intended.**
The loop now writes nothing unless the globe owns the view *and* that globe is
Earth.

---

## D163 - The solar system gets its own camera

Phone, after several rounds of fixing symptoms: **the planet view and the solar
system should be separate pages.** They are, and the reason it matters is that
almost every defect of the last several sessions was one problem wearing
different clothes.

The system was a MapLibre custom layer. It borrowed the map's projection matrix,
its camera, its far plane and its zoom, and each of those cost something:

| symptom | actually |
|---|---|
| the sky had to be centred on the camera to exist (D129) | the far plane sits one globe radius past centre at every zoom |
| planets vanished at some angles (D130) | three.js culls on the CPU against that same borrowed frustum |
| six attempts at the globe/solar handover (D139-D145) | one camera serving two pictures at wildly different scales |
| a band where neither view was worth looking at (D158) | the same |
| a transition screen to hide the seam (D161) | the same |
| "drag" moved bodies at different rates, some backwards (D160) | the map's camera always looks at the centre of the world underfoot |

None of those are solar-system problems. They are "this is not our camera"
problems, and one change answers all of them.

### What the new one is

`solarScene.ts` builds the same scene from the same tested data -
`scenePlacements`, `orbitRing`, `surfaceTexture`, `ringProfile`,
`poleDirection`, the star catalogue - with its own `WebGLRenderer` and a
`PerspectiveCamera`. `solarCamera.ts` is the camera model: a target, a distance
and two angles, kept as plain data with pure operations so the arithmetic is
testable without a GPU.

What that **deletes** is as interesting as what it adds. No `clampToFarPlane` and
no `onBeforeCompile`, because the far plane is ours. No `frustumCulled = false`,
because the frustum matches the scene and culling is correct again. No
`skyRadius`, because the stars sit at a radius we chose. And **panning is a
translation**: `pan` moves the target one world-unit per pixel, which is exactly
what could not be done at any damping while the map owned the camera.

D125 rejected a second renderer and was right at the time - that was for drawing
the system *inside* the globe view, where both would run at once. As separate
pages only one exists: the scene is built on mount and disposed on unmount.

### Two faults found while building it

**Star colours are 0-1, not 0-255.** Dividing by 255 made every star three
thousandths of its colour, which is black on black. The field was being drawn
perfectly and was invisible - settled by the renderer reporting **5,070 points
drawn** against a screen showing none.

**`PointsMaterial` has one size for the whole field**, so a per-star size
attribute is ignored. Magnitude is spent on brightness instead, which is the
better axis anyway: a faint star is faint, and drawing it larger to say so is
backwards.

### Where this stops, deliberately

The page renders, names every body, offers Visit, drags and zooms. What is *not*
done is the removal: `solarSystemLayer.ts` and the whole handover apparatus in
`PlanetView` - the zoom coupling, the settle, the solar drag, the marker feed -
are still there and still work. Taking them out is the next step, and doing it in
the same change would have meant a half-migrated map with no way to tell which
half was at fault.

---

## D164 - The old layer, and everything that existed to serve it

D163 built the solar system a page with its own camera and left the MapLibre
custom layer in place, deliberately, so that a half-migrated map could not hide
which half was at fault. This removes it, and what came out with it is the point.

### Deleted

| gone | what it was for |
|---|---|
| `solarSystemLayer.ts` | the custom layer, 720 lines |
| `applySolarView`, `syncGlobeVisibility` | hiding the globe so the layer had room |
| the zoom listener | toggling between the two |
| `viewSettle.ts` | stopping the camera resting in the band between them |
| the pointer handlers in `PlanetView` | turning the viewpoint, because the map's camera could not slide |
| `solarMarkerFeed.ts` | getting drawn positions out of a layer inside a WebGL callback |
| `SolarLabels`, `SolarApproach`, `solarApproach.ts` | chrome that read that feed |
| `cameraFrame.ts` | reading a camera out of a **borrowed** projection matrix |
| `skyRadius`, `SKY_GAP_FRACTION` | finding a sky radius that survived a borrowed far plane |
| the imagery's zoom fade in `basemap.ts` | dissolving the globe as the handover approached |

Three hundred and seventy six lines removed against a hundred and thirty added,
and **none of the deletions cost a feature**. Every one of them existed to
manage a camera the solar system no longer borrows.

### What replaced the handover

One threshold and one page. Zoom out past `LEAVE_FOR_SYSTEM_ZOOM` and the
journey screen goes up and the page opens; the map is not drawing a solar system
underneath, so there is nothing to hand over *to*. The return is symmetrical:
closing the page plays the same screen and brings the camera back to a zoom
where the globe is the picture, because returning to the zoom it left at would
put the reader one notch from departing again.

### Two things that had to be rescued on the way out

**`homeBodies`.** The Earth and the Moon are 0.0026 AU apart, which this
compression cannot resolve, so the companion is drawn beside its partner at a
fixed and admitted offset (D140). It lived in the deleted layer, and without it
the new page drew nine bodies and no Moon. It is in `solarBodies.ts` now, which
is where a claim like that belongs anyway - said out loud rather than buried in
a renderer.

**The Mercury clearance test, again.** Not rescued but noted: three tests in
`planet.test.ts` asserted the handover - that its two thresholds were one number,
that the globe dissolved just before it, and that the planets faded in below it.
All three were *correct* and all three are now meaningless. They were replaced
by a comment saying what they used to guard, because a reader finding no test
where the handover was should be told it was removed rather than left wondering
whether it was forgotten.

### The lesson worth keeping

Six sessions of defects - D129, D130, D139 through D145, D154, D158, D160, D161,
D162 - and the common thread was never the solar system. It was that **one camera
was serving two pictures at wildly different scales**, and every fix was a
negotiation between them. The negotiation is what got deleted here.

---

## D165 - Ships, and the survey that chose the source

The third layer. The first two arrived four months apart and each cost one line
in `ObjectType`; this one was meant to test whether that was design or luck.

### The survey, and why the obvious answer does not exist

There is no adsb.lol for ships. That is the finding, and knowing *why* saved
building against the wrong thing: an AIS receiver is a real installation rather
than a dongle on a windowsill, so the volunteer networks that exist run on
**reciprocity** - AISHub and AIS-catcher give you the global feed if you feed a
receiver into it. We have no receiver. The commercial half of the market has
also consolidated: Kpler now owns MarineTraffic, FleetMon and Spire Maritime,
S&P Global took ORBCOMM's, and what is left is resellers with credit meters.

What is genuinely open falls into three kinds, and the difference between them
is not coverage - it is **what they ask of you before you can call them**.

| source | coverage | licence | what it wants | verdict |
|---|---|---|---|---|
| **Digitraffic** (Fintraffic) | northern Baltic | **CC BY 4.0**, commercial ok | nothing | **built on** |
| **aisstream.io** | **global** | unanswered | a GitHub sign-in, and a WebSocket | queued |
| **Kystverket** (Norway) | Norwegian EEZ | NLOD, commercial ok | an NMEA decoder | unreachable |
| AISHub / AIS-catcher | global | reciprocal | **a receiver of your own** | closed to us |

Kystverket is the honest disappointment: open licence, no registration, and a
published TCP endpoint at `153.44.253.27:5631` that **timed out after fifteen
seconds** from this machine. That is either a blocked outbound port here or an
endpoint that has moved, and there was no way to tell which from outside.

aisstream is the only free global source, and it is queued rather than
dismissed for two reasons that are worth separating. The soft one: its licence
question was [asked publicly in April](https://github.com/aisstream/issues/issues/181)
and the maintainers have not answered, which after the OpenSky non-profit-only
clause is a thing to know before depending on it. The hard one: **it is a
stream, not a snapshot.** Every provider here answers "where is everything
right now?" on demand; that one pushes messages and expects the caller to
accumulate the world. `Provider.fetch()` does not fit it, and pretending it
does is how a seam gets bent.

### What was measured before anything was written

Digitraffic was called, not read about:

| | |
|---|---|
| vessels | **916** in one request |
| payload | **37 KB** gzipped |
| metadata | **806 rows**, covering **797** of the positions - 87% draw with a name |
| `Cache-Control` | `max-age=60` - the upstream states its own cadence |
| conditional GET | `If-Modified-Since` -> **304, zero bytes** |
| coverage | lon 17.0-32.5, lat 57.7-65.8 |

That last row is the price. The Pacific is empty because this source cannot see
the Pacific, and the map should say so rather than imply the sea is quiet.

### Three things AIS does that will draw a confident lie

**Sentinels are not nulls.** "Not available" is encoded as a number inside the
valid range and passed straight through: `sog` 102.3, `cog` 360, `heading` 511
- 11, 88 and 142 vessels respectively in one sample. Rendered unconverted that
is a ship crossing the Baltic at 190 km/h, pointed due north. Same class of
error as a marker at (0, 0) (D18), and harder, because it is wrong on a quarter
of the fleet while the rest looks right.

**Checking for the sentinel is not enough, and the first version proved it.**
`>= 102.3` is precise, correct, and missed three vessels sending **102.2** -
the saturation value one below it. Caught by sorting the live feed by speed and
reading the top. Reading *further* down was worse:

| knots | what it was |
|---|---|
| 102.2 | NOUNOU, a 250 m tanker, under way |
| 102.2 | RATNIK, a tug, **moored** |
| 85.0 | MYRA, a 228 m tanker, **at anchor** |
| 81.0 | VYATICH, a tug, **moored** |

None of those is a sentinel. They are broken transmitters, and no encoding
separates them from real readings - only knowing what a ship can do. The
fastest vessel ever in service does about 58 knots, so `MAX_PLAUSIBLE_KNOTS` is
60. **And it is stated what that does not fix**: under the ceiling a tug still
claims 49.5 knots and a cargo ship 44.3. They stay, because a per-type limit
would be a table of guesses dressed as a rule and the type is missing for 13%
of the feed. Consecutive positions would settle it properly and the store
already holds the track to do it with - a different piece of work from decoding
a message.

**Most ships are not moving.** Of 636 vessels seen in the last fifteen minutes,
**127 had a speed over half a knot.** Four fifths of a ship map is stationary
where an aircraft map is entirely motion. Not a defect to fix - it is what the
layer looks like - but it makes `navStat` load-bearing rather than decorative:
*moored*, *at anchor* and *aground* are three very different reasons to be
still, and a speed of zero says none of them.

### The TTL, which is D86 again

The endpoint retains a vessel for about **24 hours**. The ages have a cliff and
then a tail:

| age | cumulative |
|---|---|
| < 3 min | 56% |
| < 6 min | 67% |
| < 15 min | **69%** |
| 1-24 h | the remaining **28%** |

Nearly a third of what it returns has not been heard from in over an hour.
Serving that is exactly D86 - the map of ghosts, where 39% of everything drawn
was already past the fade. So 900 s: it sits on the cliff, it is five missed
reports for a moored Class A vessel transmitting every three minutes, and it
drops the tail. **Confirmed live**: 917 vessels in the feed, **642 held** - 70%
against the 69% the histogram predicted.

### What the layer cost, and what that says about D4

One provider module, one router, one factory line, one job tuple, one settings
block, and one argument added to `Poller`. Nothing in the aircraft path, the
satellite path, the store, the thinning or the schemas changed shape.

Two decisions inside that are worth keeping:

**It is shaped like the aircraft router, not the satellite one**, and the
question that decides which is *can the position be computed?* A satellite's
can, so that router propagates on request and holds no store (D95). A ship's
cannot - somebody has to have heard it - so this polls and serves a snapshot,
with the staleness flag and the eviction TTL that follow.

**It keeps a property the aircraft router has to work for.** Selecting an
aircraft buys a flight track and a scheduled route from two further services,
because a position feed carries neither. AIS carries both: a vessel transmits
its own destination, draught and ETA. So `get_ship` performs no I/O and is not
even `async`.

**One job rather than two.** The two-tier poll buys viewport latency at the
price of a second call, which is worth it against a metered source. Digitraffic
takes no bounding box and the whole feed is 37 KB, so a viewport job would
fetch the same bytes twice and discard half.

### The tripwire fired, for the second time

`test_exactly_the_two_declared_kinds` failed in an otherwise green suite, saying
a third `ObjectType` is a scope decision that has to be written down first. It
did the same thing when satellites arrived (D93). Twice now it has stopped a
layer being added quietly, and both times it pointed at the docs rather than at
the code - which is the whole of what it is for.

### One test was vacuous and mutation testing said so

`test_the_tag_differs_from_the_aircraft_layers` compared the two layers' ETags
and asserted they differed. They differ anyway - the stores hold different
versions and sources - so changing the router to hash `"aircraft"` did not fail
it. Replaced with one that pins the router's own argument against a tag
computed from the ship store's real state. The hashing itself was already
covered; what was uncovered was **which name gets handed to it**, which is
exactly what the mutation changed.

756 backend tests, up from 701.

### The frontend half, and the pattern that showed up three times

The layer cost one `LAYERS` entry, one module for kind-to-colour, one sprite,
one MapLibre layer pair, one panel section and one key. The polling hook was
not touched, for the third time.

But three separate defects were the *same* defect, and it is worth naming
because it will happen again the next time anything here grows a fourth of
something.

**A negation over a set of two is a coin flip that happens to be right.** Every
one of these read as "not satellites, therefore aircraft", and every one was
correct until a third value existed:

| where | what it did with ships |
|---|---|
| `recentForLayer` | offered a ship box yesterday's aircraft and airports |
| `SearchBar`'s `satelliteMode` | answered a vessel search with aeroplanes |
| `PlanetView`'s furniture visibility | drew airports and receiver coverage over open sea |
| `modelTarget` | **put a 3D aeroplane on the water off Helsinki** |

The last one is the sharp one, because that module's own comment says an
aeroplane must never appear in orbit and enforces it with `type === 'satellite'
? spacecraft : airframe`. The rule was right, the guard was a fork on two
values, and a ship took the else-branch. It was found by looking at the map -
no test failed - and the test that would have caught it exists now.

The fix in each case was to say which layer the thing is *for*, rather than
which layer it is not.

### Two more things the running app said and the tests did not

**The search box's `aria-label` was hardcoded.** Its placeholder has been
layer-aware since D103; the label a screen reader actually reads still said
"callsign, aircraft address, or airport" on every layer, including one where
none of the three exists. The right words were already in `layerChrome`.

**The key drew an aeroplane** beside the words "bow points the way it is
pointing", because the glyph type had three values and one of them was close
enough to reuse. A key is where a reader goes to decode the map, so it is the
worst place to be approximately right.

### Where the layer differs from the two beside it, deliberately

**Colour is the vessel's type.** Not altitude - every ship is at sea level, so
the ramp would paint the fleet one colour. Not speed either, which is the
tempting second answer: four fifths of them are stopped.

**Knots first in the panel.** The contract carries m/s because that is one unit
for every layer (D18), and the aircraft panel says m/s and km/h because that is
how air speed is discussed. At sea it is knots, and a panel that made a reader
convert would be missing its own point.

**Names start at zoom 8, not 5.** Aircraft spread thinly across a sky; ships
pack into harbours, and a hundred names inside a few kilometres is one
illegible mass.

**"Stopped" rather than "0.0 knots", and "Not transmitted" rather than
"Unknown".** Both are the common case here rather than the edge, and they are
different facts: one is a ship at a berth, the other is a transmitter that said
nothing.

**No photograph.** The aircraft panel has one because a registration identifies
an airframe somebody has photographed; the satellite panel has one because a
mission has a press image. There is no free image source keyed by MMSI, and a
stock photo of "a tanker" is a picture of a different ship.

1,007 frontend tests, up from 956. 762 backend, up from 701.

---

## D166 - Ships everywhere there is a receiver

D165 chose Digitraffic because it asked for nothing, and queued the global
source. Phone asked for global ships, so this connects the queued one.

### It works, and the numbers are the argument

Subscribed to the whole planet with a real key:

| after | vessels | with a name |
|---|---|---|
| 15 s | 2,876 | 95% |
| 60 s | 6,379 | 95% |
| 120 s | 12,446 | 95% |
| **240 s** | **17,848** | **95%** |

**Twenty-eight times Digitraffic's 643**, at about 158 messages a second. And
the ship's name arrives in the metadata of *every* message, so the second
endpoint, the 260 KB join and the ten-minute metadata cache that Digitraffic
needs have no equivalent here.

### "Global" means "where the receivers are", and the subtitle now says so

Terrestrial AIS - volunteer coastal stations, no satellite AIS:

| region | vessels | | region | vessels |
|---|---|---|---|---|
| N Europe / Baltic | **9,202** | | SE Asia | 310 |
| Mediterranean | 2,600 | | W Africa | 100 |
| US Pacific | 1,491 | | **Indian Ocean** | **2** |
| N Atlantic | 1,417 | | **Gulf / Red Sea** | **0** |

The Singapore Strait is the busiest waterway on earth and all of SE Asia
returns 310. Same shape as the OpenSky/adsb.lol comparison (D83): comparable,
different holes, free.

So the subtitle changed from "ships in the Baltic" to **"ships in coastal
waters"**. "live ships" would be the parallel to the aircraft layer and is the
one phrasing that would actively mislead - it claims a completeness the layer
has not got, over an ocean that is empty because nobody is listening rather
than because nothing is there.

### A stream fits `Provider.fetch()` because the shape was already here

The temptation is to bypass the provider seam and let a background task write
into the store, which would be a second ingestion path for one source.

Not needed: **the satellite layer already solved this.** It refreshes elements
on a background task and answers from memory so no request waits on an upstream
(D93, D95). This is the same arrangement with a different thing refreshed - a
task accumulates positions, `fetch()` returns the accumulation. The poller, the
store, the router and the frontend cannot tell the difference.

### Three defects, and two of them were mine before the map saw them

**The disconnections were self-inflicted.** One drop every four minutes, then a
run that died saying `sent 1011 (internal error) keepalive ping timeout`. *Sent*
1011 means the **client** closed it: the library's 20-second pong deadline is
not met while 158 messages a second are decoded on the same task, so it was
killing connections the server was happy with. `ping_timeout=None` plus a
30-second idle timeout on the data replaces a deadline measuring our own decode
loop with one measuring the network. Zero reconnects afterwards.

**Identities were being pruned with positions.** A position expires because a
ship moves; a name and a hull type do not expire at all. Static data is a
*six-minute* message against a position every few seconds, so type coverage
climbs slowly - measured at 3%, 7%, 11%, 15%, 22% over five minutes - and every
eviction gave part of it back. Positions now expire at 15 minutes and
identities at six hours.

**The union would have lost colour by adding a source.** The merge rule was
"freshest wins", per vessel, which is honest as far as it goes. But only 22% of
stream vessels have a type against **87% on Digitraffic**, and half the
stream's coverage is the Baltic - so a fully described Finnish ferry was
overwritten every minute by a bare position from a volunteer receiver that
heard it a second later. Now the fresher record supplies the *position* and
anything it does not know is filled from the other: a field loses to a value,
never to a blank. Confirmed live - **Baltic 55% typed against 7-9% elsewhere**.

### What was extracted, and why the draught proves the seam is right

`providers/ais.py` now holds what is true about the **protocol** - the
sentinels, the plausibility ceiling, the status and type tables - shared by
both sources. Field *mapping* deliberately stayed put, and two differences show
why a "shared converter" would have been worse than a duplicated one:

| | Digitraffic | aisstream |
|---|---|---|
| draught | `draught`, **decimetres** (82) | `MaximumStaticDraught`, **metres** (1.9) |
| ETA | one packed 20-bit integer | a struct of four fields |

A shared draught helper would have to ask which source it was talking to, and a
helper that asks that is not shared.

### The test suite was quietly calling three third-party services

`create_app` with default settings starts a Digitraffic poller, a CelesTrak
refresh and a JPL Horizons task, because all three layers default to on -
correctly, since each costs nothing in a deployment. So every test that built
an app to assert something about *aircraft* was calling out.

Invisible until ships arrived, because a ship poll fires immediately and then
every sixty seconds: **the suite went from 156 s to over 400 s, and three ETag
tests began failing in the full run while passing alone.** Neither symptom named
the cause, and the second is the worse - a test that fails only in company is a
test nobody trusts.

The three layers are now off in `conftest` unless a test asks, set as
environment so an explicit `ship_layer_enabled=True` still wins. **The suite is
now faster than before this session started: 116 s.** It is the same rule D114
already had for the aircraft provider, applied to the layers beside it.

### The licence, recorded rather than resolved

aisstream's commercial-use terms were asked about publicly in April 2026 and
have not been answered. Phone's decision was to build on it as a free public
service, credit it, and keep `ORBITAL_SHIP_GLOBAL_ENABLED` as the switch to
throw the day anything here is charged for - the same posture the OpenSky
non-profit clause already gets. Said here rather than left in a tracker nobody
reads.

### Verifying the vessel type, which Europe alone could not answer

The first pass measured type coverage globally and split it only into "Baltic"
and "elsewhere", which is exactly the mistake D85 records for the adsb.lol
global sweep: four sample points, all inside the covered half, reading as
"one circle is enough". Phone said so, and the second pass measured eleven
regions once a minute for twelve minutes.

**The answer is that types are not a European phenomenon.** Coverage climbs at
much the same rate everywhere - the population stabilised at ~29,000 vessels
while the percentage kept rising about a point a minute in every box:

| region | 3 min | 12 min |
|---|---|---|
| N Europe / Baltic | 37% | **47%** |
| W Africa | 35% | 46% |
| SE Asia | 28% | 42% |
| Mediterranean | 28% | 36% |
| N Atlantic | 26% | 36% |
| S America | 26% | 35% |
| US / Canada | 25% | 34% |
| Australia / NZ | 24% | 33% |
| E Asia | 18% | 27% |
| **global** | **32%** | **41%** |

Europe leads the lowest region by thirteen points, and Digitraffic's joined
metadata explains at most four of them - it covers ~640 vessels of the 14,544
in that box. The rest is receiver density, which is the same thing the vessel
*counts* already show. **It is a time effect, not a place effect.**

### Why it starts low, and why the fix was the identity TTL

A position is transmitted every few seconds and a vessel's static message every
six minutes, measured at **26.5 static against 114 positions per second**. A
receiver therefore gets dozens of chances to hear where a ship is and one
chance every six minutes to hear what it is, so type coverage cannot start high
however good the network is.

That is what makes the identity TTL load-bearing rather than a tidy-up: over
six hours a vessel gets around sixty chances instead of two, and coverage keeps
climbing long after the vessel count has settled. **It had not plateaued at
twelve minutes**, which is worth saying rather than rounding off.

### One real gap, found by asking rather than re-reading

`ExtendedClassBPositionReport` - AIS message 19 - is a position report that
**also carries a name, a ship type and hull dimensions**. It was in the position
list, matched by an `elif`, and its identity was thrown away every time. Found
by asking the live stream which message types carry a type field: 17 in 160
seconds, every one carrying `Type`, every one ignored.

It is rare enough not to be the reason coverage starts low, but a vessel that
identifies itself *only* that way would have stayed grey for ever.

819 backend tests, up from 762.

---

## D167 - Where the time actually went

Phone asked for a system review, high-end latency, and a bug hunt. Measured
first in every case, and two of the things that looked most worth optimising
turned out not to be.

### The frame loop was rebuilding a picture nobody could see

The map rewrote every layer's GeoJSON **on every frame** so interpolated
positions moved smoothly (D71). At zoom 7 with 2,000 vessels:

| | p50 | p90 | p99 |
|---|---|---|---|
| rebuilding every frame | 11.6 ms | 18.2 ms | **55.1 ms** |
| not rebuilding at all | 4.2 ms | 4.9 ms | 12.4 ms |

7.4 ms of every frame at the median and 43 ms at the tail - 86 fps against 238,
and a p99 long enough to be seen as a stutter.

**Almost all of it was invisible.** At zoom 7 a pixel is 750 m, so a ship
making 6 m/s crosses one **every two minutes**. Two thousand features were
rebuilt and re-uploaded eighty-nine times a second to animate that.

`refreshRate.ts` derives the interval from the view instead: the time in which
the fastest thing on the layer travels **half a pixel**, floored at one frame
and capped at a second. Zoomed in it still rebuilds every frame, because there
it earns it - at zoom 14 an aircraft crosses a pixel in 20 ms.

Measured after: **355 rebuilds in 4 s became 4**, and p99 went 55.1 ms to
**5.9 ms**.

**One trap, caught before it landed.** The first version put an early `return`
in the tick. That skips the visibility management below it, which is precisely
what D154 and D162 exist to keep running every frame - `applyBody` is a second
writer, and reading the style once a second instead of once a frame is how
receiver coverage ended up drawn over Mars. It is a flag now; only the source
rebuilds are rated, and the leader line is rated with them because a leader
drawn from a different position than its marker *is* the defect D72 fixed.

### The ships layer was drawing 37 vessels where there were 9,159

`viewportScoped: false` was sound in D165: the feed was 916 Baltic vessels,
which fits under the 2,000 thinning cap whole, so a second request for the part
under the camera would have fetched the same bytes twice. **The global stream
made it 29,000** (D166), and an unbounded request is then thinned across the
entire planet.

Measured over the North Sea at zoom 7 - the busiest water in the world - the
box held 9,159 vessels and the map drew **37**. Nothing failed and no test
noticed; the sea just looked empty. Scoped to the viewport: **1,984 drawn.**

A decision that was right when it was made and wrong two sessions later, with
nothing in between to say so.

### One query string was a denial of service

`limit` had no ceiling. `?limit=999999999` answered 200 and serialised the
whole store - **472 ms for 29,000 vessels**, on a single-threaded event loop,
with every other request and the poller waiting behind it. Clamped in all three
routers to the configured cap.

Clamped rather than refused with a 422: the parameter means "at most this
many", the configured cap means "and never more than this", and a client asking
for more than exists is not making a mistake worth an error.

### Search cost 132 ms per keystroke, in two layers

`/api/search?q=a` measured **311 ms**, and it fires on every keystroke behind a
250 ms debounce. Two causes, both in the airport table:

**It built a model for every match.** "A" matches **27,917 of 28,291
airports**, and the code constructed 27,917 pydantic `Airport` objects and
sorted them to return eight. Ranking now happens on the raw rows and only the
survivors become models: 132 ms -> 27 ms.

**It split every string on every keystroke.** The tier-2 check asks whether the
query begins any word in the name or city, and did it with `haystack.split()` -
28,291 word lists allocated per search, **17.9 ms of a 25 ms scan**.
`_searchable` is built once, so the whitespace is normalised and a space
prepended there; "starts a word" is then one substring test. 27 ms -> **11.7
ms**.

Together: **132 ms -> 11.7 ms**, with byte-identical results verified across
fifteen queries at two limits.

### Compression was paying milliseconds for bytes that were already gone

`GZipMiddleware` defaults to level 9. On the 366 KB ship response:

| level | size | cost |
|---|---|---|
| 1 | 35.7 KB | 0.21 ms |
| **3** | **24.5 KB** | **0.74 ms** |
| 6 | 24.1 KB | 1.59 ms |
| 9 | 23.0 KB | 5.39 ms |

Nine buys 1.5 KB over three and charges 4.6 ms for it, on a response already a
fifteenth of its original size.

### And the one that failed

`thin()` is the single most expensive thing the backend does - profiled at
**44 ms of a 62 ms request**. The waste looked obvious: 1,512 occupied cells
holding ~19 records each are sorted in full, and the round-robin reads a depth
of 2. About 28,700 records ordered to serve 3,024.

Replacing the sort with an exactly-computed depth and `heapq.nsmallest`
produced byte-identical output and was **slower in two of six measured
shapes** - ships 19.6 -> 24.8 ms, a viewport 10.3 -> 15.0 ms. `nsmallest` with
a key costs more than `list.sort` on a nineteen-element list; the cost is the
29,000-iteration bucketing loop, which is close to what a per-record loop costs
in Python at all.

Reverted, and the finding written into the function so the next person does not
spend the afternoon on it. **The way to make `thin` faster is not to call it
with 29,000 records** - which is exactly what scoping a layer to the viewport
does.

`model_construct` instead of the envelope's `model_validate(model_dump())` was
the other measured non-win: 7.18 ms against 6.89 ms. Left alone.

### What the bug hunt cleared

Every endpoint answers; malformed bboxes, zero and negative limits, path
traversal and null bytes all refuse correctly. All three layers switch cleanly,
selection and deselection work, and every page opens from its hash.

**The solar system page was confirmed on a real screen at last** - the item
that had stood in HANDOFF since D163. It renders, labels every body, drags
roughly 1:1, wheel-zooms, and holds **4.1 ms frames**.

Mobile at 375 px is 4.2 ms p50 with 915 markers, so the density there is a
legibility question rather than a latency one and was left alone. The only
thing actually wrong was the dev-only diagnostics overlay: anchored 8 px from
the right with a 380 px max-width, it started at x = -13 on a phone and covered
the layer toggle.

### Postscript: where the vessel types settle

The open question from D166 - whether type coverage plateaus low - measured
over **fifty-four minutes** against the running backend:

| | 12 min | 54 min |
|---|---|---|
| N Europe | 47% | **67%** |
| SE Asia | 42% | 62% |
| N Atlantic | 36% | 57% |
| Mediterranean | 36% | 57% |
| US / Canada | 34% | 55% |
| S America | 35% | 53% |
| Australia / NZ | 33% | 52% |
| E Asia | 27% | 47% |
| **global** | **41%** | **62%** |

Still climbing at the end - 59% to 62% over the last fifteen minutes - so it
approaches something near three quarters rather than stopping at a half. The
vessel count was flat at ~28,000 throughout, so this is identity accumulating
rather than the population changing.

**And it is not a European effect.** The spread from best to worst region is
twenty points, with SE Asia (62%) above the Mediterranean (57%): the ordering
tracks receiver density, which is the same thing the vessel counts show. The
six-hour identity TTL is what makes it work - a vessel gets sixty chances at a
six-minute message instead of two.

823 backend tests, 1,019 frontend.

## D168 - The lunar spacecraft followed the camera to Mars

Reported by Phone: visit the Moon, then go to another planet, and the yellow
spacecraft markers come with you. Reproduced on the first attempt - three
craft, drawn over Mars, above a status bar reading **"surface imagery - no
live objects here"**.

### The rule was right and could not be reached

D133 replaced a hand-written list of Earth layers with a derivation: everything
with the `orbital-` prefix belongs to Earth unless it is named as an exception.
D134 added `LAYER_HOME_BODY` so the lunar layers could belong to the Moon, and
put five entries in it, one of them `orbital-moon-shell`.

That entry was correct and **unreachable**. `visibilityFor` derives its plan
from the style, and MapLibre keeps custom layers out of `map.getStyle()` - so
the caller has to pass their ids in, and the caller passed a **literal**:

```ts
visibilityFor(body, style as never, [SHELL_LAYER, MODEL_LAYER])
```

Two ids, written when there were two. The moon shell was added later, given its
entry in the exception table, and never added here - so the plan contained no
key for it, nothing ever wrote its visibility, and it kept the `visible` it was
born with. **A rule the plan never mentions is not a rule, it is a comment.**

`MOON_SHELL_LAYER` was exported and imported by nothing, which is the shape of
the fault in one line: the constant existed, the entry existed, and the wire
between them did not.

The three MapLibre layers *are* in the style and were correctly hidden. So what
survived was the 3D half alone - the tether and the craft - with the sub-point
dot and the name gone. Yellow marks over Mars with nothing to explain them,
which is why the report described a following indicator rather than lunar
spacecraft.

This is D133 for the third time. Twice the list drifted; the fix each time
removed the list. Here the list that drifted is the argument.

### The fix

`planet/customLayers.ts` holds `CUSTOM_LAYER_IDS`, built from the layer
modules' own exported ids, and `applyBody` passes that. It is still a list -
nothing will enumerate custom layers for us - but there is one of it, it lives
next to the layers rather than at a call site, and a test fails if an entry in
`LAYER_HOME_BODY` can never reach the plan. The terminator is in it despite
being exempt in `NOT_ABOUT_EARTH`: the list means *every* custom layer, and
letting the exception table be the only thing that decides is the design. A
list that pre-filters what it believes exempt is a second rule.

Second, smaller: leaving the Moon called `setMoonCraft([])` on the store but
never `moonShell.setCraft([])`, so the shell kept three built meshes ready to
draw the moment anything showed the layer. Visibility alone would have hidden
the symptom while leaving the state. Both are fixed.

### Verified

Three tests in `planet/bodyLayers.test.ts`, all of which fail against the
shipped list - checked by putting it back. The style in that file is built from
the **real** layer factories rather than written out by hand, because a
hand-written style tests the rule against what the author remembered, which is
the failure this entry is about.

Then in the browser, which is where it was reported: Moon -> Mars is clean, and
Mars -> Moon still draws all three with their tethers and panel.

823 backend tests, 1,022 frontend.

## D169 - Earth's chrome on other worlds, and four things that were not rules

Phone asked whether anything else had D168's shape. The sweep found one defect
worse than the one reported, two latent, and four pieces of code that read as
rules and were not.

### Earth's city lights, on Mars

The night toggle wrote the terminator with no idea which world was underneath:

```ts
createTerminatorControl((enabled) => { terminator?.setEnabled(enabled); ... })
```

`applyBody` set it correctly on every body change, and then the button undid
that. Pressing it over Mars drew **Earth's night side, Earth's terminator and
the lights of southeast Asia and the Australian coast** across the Martian
surface. Screenshotted before the fix.

This is D120's fault - a layer drawn where its subject does not exist - and
D168's shape: a rule that was right, and something else writing over it.

### The plain and dark basemaps were blank off Earth

Two of the three basemap modes *are* Earth's vector cartography, which is
switched off when the camera leaves. Choosing one on the Moon replaced the
lunar mosaic with a **blank grey disc** - the basemap's `background` layer and
nothing else - and pressing again gave a darker blank disc. The control was
offered on all ten bodies and meant something on one.

Underneath it, a second writer: `visibilityFor` sets the far imagery visible
unconditionally, so a body change turned the layer back on for a reader who had
chosen the plain map, while `setImageryVisible` only ran at load and on a mode
change. Invisible, because opacity is 0 in those modes - the cost was fetching
a mosaic nobody sees.

### The cause both share

Each setting was **one variable doing double duty**: the reader's preference
and the state of the screen. Overriding one for a world meant overwriting the
other, so the night toggle did not try and the basemap was overwritten by
accident.

`planet/earthChrome.ts` separates them. The reader's settings go in,
`bodyChromeFor` says what the screen should show, and `applyBodyChrome` is the
only writer. A function rather than four lines in a callback, for the reason
`visibilityFor` is one: **a rule that exists only inside an imperative callback
is a rule nothing can check**, and this project has now twice shipped a body
rule that was right and unreachable.

Both controls are **hidden** off Earth rather than disabled. A control that is
present and does nothing is a claim that something should have happened.

It also fixed something nobody had reported: the old code restored
`config.terminator` on returning to Earth, so a reader who turned night on,
went to Mars and came back found it off again.

### "in view" was true of one layer and not the other

The footer said `showing a sample of 9,159 in view` for a whole session while
the ships layer drew **37 vessels over the North Sea** (D167). The sentence was
the disguise: it is exactly what a healthy viewport-scoped layer says.

`sampleScope` reads the layer's own `viewportScoped` flag now, so an unscoped
layer says **"from across the whole planet"** - which reads as wrong, because
it is. Satellites are the unscoped one: **1,427 against a cap of 2,000**. Sound
today, and it expires at 2,001 the way the ships reasoning expired. This is the
line that will say so.

### Four things that read as rules

| Removed | Why it was worse than nothing |
|---|---|
| `globeLayerIds` | Gathered everything painting the globe for the D164 handover. Called by **nothing** for five sessions, and covered by **four passing tests** - so the block read as coverage of a live rule |
| `BACKGROUND_LAYER`, `SOLAR_LAYER` | Only ever arguments to it |
| `orbital-solar-system` in `NOT_ABOUT_EARTH` | Exempted a layer that has not existed since D163. Read as evidence that one did |
| `SOLAR_HANDOVER_START` / `_FULL` | One had carried `@deprecated ... kept only until the style tests move on` since D164. They had moved on |
| `KEPT_LAYER_TYPES` | Named the basemap layer types surviving into imagery mode. Imported by nothing, in any file. D75 had replaced "drop the layer" with "switch it off by expression", so the set stopped being the rule and stayed on as a description of one |

What `globeLayerIds` knew is kept as a comment where the next rule over a style
will be written: **the `background` layer belongs to neither half of the rule**
- no source, so the cartography half misses it; no `orbital-` prefix, so the
other half does too (D143).

`bodies.test.ts` was also standing on its **own copy** of the custom-layer list
- the same two ids `applyBody` passed, and still two when the moon shell
arrived. It reads `CUSTOM_LAYER_IDS` now, which immediately caught a stale
assumption: "turns all of it back on for Earth" expected every `orbital-` layer
visible on Earth, which stopped being true when the lunar layers got a home of
their own (D134). It asks `homeBodyOf` now.

### Checked and clean

All four custom layers are in `CUSTOM_LAYER_IDS`. The satellite shell and the
aircraft model take a callback and pull each frame, so only the moon shell
could hold a stale copy - and it was the one that did. `setActiveBody` clears
everything held. Every three-way type split is written positively, so a fourth
kind gets nothing rather than being mistaken for aircraft. The basemap style
has a second source, `ne2_shaded`, that the cartography rule cannot see, but
`withImagery` drops raster layers before it matters (defect #26). The moon
poller does not leak: two requests in 74 s on the Moon, none in the 60 s after
leaving.

### Verified

Six tests on `bodyChromeFor`, five of which fail against the shipped behaviour;
two on the controls' availability; three on the footer's wording, two of which
fail against the old sentence. Then in the browser: night on, Earth to Mars
gives a clean Mars and no controls, and coming back restores night where it
belongs. Plain map on Earth, then the Moon, gives the **lunar mosaic** where it
gave a blank disc, and returning to Earth restores the plain map.

823 backend tests, 1,029 frontend.

## D170 - Orbit paths, and the three.js question answered by measuring

Phone asked for two things: orbit paths for satellites, and to move anything
written in another language to three.js **if three.js would make it better**.
The first is built. The second turned out to be a question with a measured
answer rather than a task, and the answer is no.

### The path the detail endpoint has been asking for since D95

`get_satellite` has returned an empty `track` for five months with a note on
it:

> for a satellite it is computable in either direction, which is a different
> thing to build and belongs with the panel that displays it rather than
> smuggled in now

`GET /api/satellites/{id}/orbit` is that thing. **Half a period back and half
forward**, so the satellite sits in the middle of its own path rather than at
one end of it, and 181 points across it.

Kept out of `track` deliberately. That field means *where this has been*, which
for an aircraft is an observation accumulated while we watched; every point
here is computed, forwards as readily as backwards. Giving the two the same
name would make a field's meaning depend on which layer you were in, which is
the D94 mistake.

**The path does not close.** These are Earth-fixed positions and the Earth
turns underneath the orbit - about 22.5 degrees of longitude per low
revolution - so one lap ends *beside* where it started, not on it. Measured on
IMAGE: 146 degrees of longitude between the ends, at the same latitude. A
closed ellipse would be the truth about a frame this view does not use.

### What is refused, and why the whole path rather than the point

Every point is propagated and **any refusal refuses the whole path.** The
seven-day freshness rule bites at the ends rather than the middle: a
geostationary period is nearly a day, so half of it is twelve hours, and
elements already six and a half days old will carry the centre and refuse an
end. A path that stops halfway round would look like an orbit that does.

So a satellite can list, draw and refuse to have an orbit, and the 404 says
which. That is the same shape as "an aircraft with no heading gets no model"
(D18, D40, D42): a principled hole rather than a plausible fabrication.

### The line has to lie the same way the shell does

The shell is **logarithmic** (D96) because the true range runs 420 km to
105,466 km. So an orbit drawn at true scale would **not pass through the
satellite it belongs to** - it would be a ring floating near it, with no way
for a reader to tell which of the two was wrong.

Every point therefore goes through `shellPosition`, the same function the
marker uses rather than a copy of it, so the line passes through the marker by
construction. A test asserts it to `Math.fround` rather than to a tolerance:
both go to the GPU as float32, so they agree *exactly* at the precision they
are drawn at, and a tolerance would also pass if they were merely near.

The cost is worth stating: **an eccentric orbit is not drawn as its true
shape.** A logarithm on a radius is not a similarity transform, so IMAGE - 1,497
km at perigee, 45,416 at apogee - is compressed far more at its high end. The
claim is the shell's and no more: *higher on screen means higher in orbit*.

### Occlusion, which decided the primitive

`LineSegments`, not `Line`, and that is an occlusion decision. The shell hides
satellites one at a time against MapLibre's clipping plane; a single line strip
cannot be hidden in pieces, so half an orbit would draw straight through the
Earth - the error this file already says would look broken. Each adjacent pair
is emitted only when **both** ends are on the near side, so the curve breaks
itself at the horizon in one draw call.

Measured on the ISS at zoom 0.6: **89 of 180 segments drawn**, which is the
half of a low orbit that faces you.

### Cost

| | |
|---|---|
| Payload | 9.1 kB, **2.6 kB gzipped** |
| Server time | 6 ms |
| Per-frame work | 181 near-side tests, one draw call, no allocation |

The vertices are rebuilt only when the path changes; only the near-side filter
runs per frame, because that depends on the camera and the vertices do not.

### The three.js question

**Nothing qualified.** three.js is already `three@0.185.1` across eight
production files and about 2,500 lines - the aircraft model, the satellite
shell, the moon shell, the terminator, the solar scene, and the procedural
geometry behind them - and it is not beside MapLibre but *inside* it, as custom
layers sharing MapLibre's own GL context and matrices. Measured share of the
bundle: **522 kB raw, 131.5 kB gzipped**, 53% of the application chunk.

What is left in another language is left there on purpose:

| | | |
|---|---|---|
| **SGP4, in Python** | Could have been `satellite.js` in the browser - this feature is exactly where that choice presented itself | **No.** Two implementations of the same physics that can disagree, in a project whose satellite layer is one long argument about not fabricating positions. The client does not hold the elements either, and the backend propagates the whole catalogue in 21 ms |
| **MapLibre's style expressions** | The markers, labels and ground symbols | **No.** MapLibre does label collision and hit-testing; the shell already paid for leaving that - a custom layer gets no picking, which is why `pick()` exists |
| **Canvas 2D sprite atlases** | `aircraftSprite`, `satelliteSprite`, `shipSprite`, the coverage hatch | **No.** These generate *textures* for the GL layers. Canvas is the right tool and three.js consumes the output |
| **The warp streaks** | `WarpField.tsx`, canvas 2D | **No, emphatically.** D155 makes them a screen-space effect precisely so nobody mistakes them for a sky. Rebuilding them in 3D would make them look like the real star field, which is the thing that file refuses |

And the version of this question that was already asked and answered: the
three.js globe **was** the renderer, and D104 deleted it. Not for performance
and not for geometry - *"the geometry was never the obstacle"* - but because it
lost the place names, the imagery and the airports. Phone's summary at the
time: *"with globe, we cant see any info of our planet locations."*

The criterion this leaves is the one the shell already follows: **3D earns its
place when it shows an axis the map cannot.** Altitude does, which is why the
orbit path is drawn in three.js and on the shell rather than as a MapLibre line
on the ground.

### Verified

Nine backend tests, seven on the geometry. Then in the browser: IMAGE's
elliptical path arcing out to apogee with the spacecraft sitting on the line,
the ISS's low orbit crossing the globe at 89 of 180 segments, the path clearing
when the layer changes, and the colour matching the regime key without either
the line or the marker being told about the other.

832 backend tests, 1,036 frontend.

## D171 - The solar system page, rebuilt around choosing a body

Phone pointed at a site and asked for this page to work like it: a dark scene
with a few lights in it, where hovering one answers, clicking it flies the
camera there and a caption names it, arrows step to the next, and an index
lists the set. The planet pages were explicitly out of scope.

### What was taken, and the one thing deliberately left

Taken: the palette (navy with real atmospheric depth rather than flat black), a
serif display line against very small letterspaced capitals, fine grain, a lot
of space, and the interaction model above.

**Left: the scattered coloured lights.** They are most of what gives that
reference its atmosphere, and on a page whose entire subject is points of light
in the dark, a decorative one is indistinguishable from a star. This project
already refused that trade once - `warp.ts` is a screen-space effect precisely
so nobody mistakes it for the real sky (D155). Depth here comes from haze and
grain, neither of which can be read as an object.

The fonts are the other substitution. That site sets its display line in a
licensed serif; this app ships **no webfonts and fetches from no CDN** (D30), so
the display face is a system serif stack. What is being borrowed is the
contrast between a serif at size and a sans at ten pixels, which survives it.

### What the page gained

It had **no notion of a body being chosen.** The only interaction was hovering
a nine-pixel label to reveal a Visit button, and there was no title.

Now: hover rings a body, a click flies the camera to it, a caption gives its
kind, its distance and its radius, and either a way to go there or **the body's
own recorded reason** there is not one - Saturn says "No solid surface - cloud
all the way down" where Mars offers a visit. Arrows and the arrow keys step
outward and back, wrapping. An index lists all ten with their distances.

Every line of that caption is a fact already in the repository. A caption that
padded itself out would be the thing this project refuses, one page along.

### Centring flew the camera into empty sky

The obvious way to centre a body is to pan by how far off centre it *looks*,
and `pan` already moves the camera in screen pixels. It ran away: two clicks
and the system was gone.

**Panning by a screen delta is not the inverse of the projection once the
camera has any pitch.** A vertical screen offset moves the target partly
through world *up*, out of the plane the planets are in, so the correction
never lands and each frame asks for a bigger one. Interpolating the camera
target toward the body's own position cannot do that - same space, fixed
proportion, converges from anywhere. `solarScene` gained `positionOf` to make
that possible, since it had the placements and exposed only screen coordinates.

A test flies from (-40, 12, 33) to (5, 0, -2) and asserts it arrives.

### The masthead announced a body it was not drawing

Phone, immediately: *"you forgot moon"*.

The subject line under the title was written as a constant - **"The sun, eight
planets and the Moon"** - and it was true standing on Earth and false
everywhere else. The Moon is drawn as Earth's *companion* (`homeBodies`), so
from Mars it is simply absent: nine bodies on screen and a caption naming ten.

The fault is not the sentence, it is that there was a sentence. `subjectOf`
derives it from the ids the scene actually rendered, so it counts what is there
rather than what is usually there - the same inversion D133 made for layer
visibility, one caption along. It also spells the number, because a numeral in
a line of prose reads as data.

Measured after: standing on Earth, ten bodies and "the sun, eight planets and
the Moon"; on Mars, nine and "the sun and eight planets"; on the Moon, ten and
the Moon named again.

A written test caught a second thing on the way: with no sun in the scene the
line began "one planet", uncapitalised, because the capital had been living
inside the word "The" at the front of a fixed string.

### Also

The corner controls broke the first time: `.system__back` kept `position:
absolute` after moving into a flex column, escaped it, and wrapped itself over
four lines. Found by looking at the page rather than at the diff.

Twenty-five tests on the pure parts - the stepper's ring and its wrapping, the
click tolerance that gives three-pixel Mercury a target bigger than itself
(defect #5's lesson), what the caption does and does not say, and the ease.

832 backend tests, 1,061 frontend.

## D172 - The Sun is the base, and the system leans with the pointer

Phone: *"I want the sun to be the base and the system move slightly around with
the mouse movement, make the system visually alive."*

### The Sun was not at the middle, and there was a reason

Measured before changing anything: opening the page put **Earth** at the exact
centre of the canvas and the Sun off to one side at (328, 482). Not a bug -
`scenePlacements` builds the scene around the world you are standing on, and
`initialCamera` targets the origin, so the origin is wherever you came from.

That is right for the scene and wrong for the page. The Sun is the one fixed
thing here; everything else is in orbit around it, and a system that opens
centred on Earth is a picture of Earth with a sun in it.

The camera's target is now the Sun's own position, taken from the scene on the
first frame that has one. **Snapped rather than eased** - an opening animation
away from a framing nobody asked for is not an entrance, it is a correction
played slowly. Deselecting returns there too, so "no particular body" has a
place to be rather than meaning "wherever the last one left the view".

This needed nothing new: `positionOf` was added in D171 for the fly-to and
answers this as well.

### The lean

The pointer moves the view about **three degrees of yaw and one and a half of
pitch**, eased at 5.5% a frame, leaning *away* from the pointer - toward would
feel like dragging the scene, away reads as moving your head around something
standing still.

**Applied at render, never stored**, and that is the whole design rather than a
detail. The lean is a response to where the mouse is, not a camera the reader
has set. Folded into `camera.current` it would compound - every frame drifting
from the drifted one - and flying to a body would fly to wherever the pointer
had quietly pushed it. `withDrift` returns a copy; the stored camera stays the
reader's, and a test asserts the input is not mutated.

The parallax comes free and is the point of doing it in the camera rather than
in CSS: measured across a full pointer sweep, **Neptune moves 18 px and Jupiter
2**, because one is further from the pivot than the other. That is depth, and
nothing had to be told about it.

Two bounds worth keeping:

- **The drift is clamped to the canvas.** Pointer capture during a drag reports
  positions outside the element, and an unclamped lean would swing further the
  further the pointer went - a drag by another name.
- **Reduced motion switches it off entirely.** It is decoration, and it is the
  kind that moves the whole screen.

Above about four degrees it stops being ambient and starts reading as a very
sloppy drag; three was chosen by looking at both.

Nine tests on the arithmetic, 1,070 frontend in total.

## D173 - "On screen" and "in the system" are different questions

Phone, with a screenshot of the page zoomed into Mercury: *"when I zoom into
one area, the right and left arrow keys only works on the planets viewable in
zoomed area"*. The masthead in the same picture read **"THE SUN AND ONE
PLANET"**.

One cause, two symptoms, and it is mine from D171.

### The mistake

`solarScene.markers()` returns what landed **inside the viewport** - it has
always ended `if (!onScreen(point, width, height)) continue;`, because its job
is placing labels and a label off screen is not a label. I built the stepper
and the subject line on that list.

So both answered the wrong question. Zoomed into the inner system, the arrows
walked between the two bodies still in frame, and the masthead described the
crop rather than the system.

The Moon fix a commit earlier (D171) was right in spirit and wrong in the same
way: the Moon genuinely is absent from the scene when the camera is not at
home, so the sentence *should* be derived - but from what the scene **placed**,
not from what the viewport happened to contain.

`placedIds()` answers the other question. The component now keeps `present`
alongside `markers`, and the two are named so the difference is visible at the
call site: `markers` for hit-testing and labels, where on-screen is exactly
right; `present` for the stepper, the index and the caption.

Measured after, zoomed hard into Mercury: seven labels on screen, all ten
bodies reachable with the arrow keys, and "the sun, eight planets and the
Moon".

### The focus ring was drawn inside the Sun

Visible in the same screenshot. `sizePx` came from projecting one edge point
offset along **x**, and that offset collapses to almost nothing whenever the
camera happens to be looking down the x axis - so the Sun reported a width far
under its own and the ring was drawn inside the disc.

The widest of three axes instead. Three projections per body per frame, ten
bodies; the cost is nothing and the answer no longer depends on which way the
camera is pointing.

### No test caught this, and none could have

Worth saying plainly rather than adding one that pretends otherwise. The
functions were right: `stepFocus` walks whatever ring it is given, and a test
proves it. The defect was **which list the component handed it**, and the two
lists are both `string[]` of body ids - indistinguishable to a type and to any
test that does not run a GPU, which this suite cannot.

What is left instead is naming and a single source: the scene now answers both
questions separately and says in its own docstring that they are different.
That is the same shape as D168, where an exception table was correct and
unreachable - and the same lesson, which is that **the thing to check is not
whether the rule is right but whether the right thing is reaching it.**

Found by Phone using the page. 832 backend tests, 1,070 frontend.

## D174 - The transition waits for the destination, not for a clock

Phone: the trip to the solar system stalls at the bottom of the zoom range for
"some mins", and then the words flash for a tenth of a second before arriving.
Both were real and both were measurable.

### The stall was `zoomend`

The trigger listened for **`zoomend`**, which fires when the wheel *stops*. A
reader spinning outwards reaches the floor of the zoom range - `minZoom` is
-2, so there is no more globe to give - and then sits there with nothing
happening until they give up and let go. Nothing was slow; nothing had been
asked to start.

Measured on a continuous wheel: the journey began at **t = 3,073 ms**, which
was the moment the wheel stopped rather than the moment the threshold was
crossed. On `zoom` it begins at **t = 1,367 ms**, mid-spin.

The threshold moved to **z-2.0** at Phone's request, which is the zoom floor:
you leave at exactly the point there is no more zooming out to do.

### The flash was two writers and a clock

`setJourney('system')` and `setOpenPage('system')` fired in the same tick, and
the screen was ended by a `setTimeout` at each of the two places that started
one. So the fixed 1,100 ms ran **while the solar page was mounting inside it**,
and on a slower machine most of it was spent on a mount the reader could not
see. Neither writer could have known when the destination was ready, because
neither was the destination.

The page says so itself now. `SolarSystemPage` sets `systemReady` after its
**first rendered frame** - not on mount, because a canvas that has not drawn is
not something to reveal - and `JourneyScreen` owns its own lifetime for both
directions, ending on a rule in `journey.ts` rather than on a clock at the call
site. Floor 750 ms so a fast machine cannot flash it; ceiling 6 s, because a
transition that can hang forever is worse than a seam.

Measured after: journey at 1,367, page mounted at 1,367, **ready at 1,467**,
screen lifts at 2,126 - held 759 ms, the floor, and it would hold longer on a
machine that needed longer.

### What the reader sees now

The streaks **sustain** instead of running a length. A trip between worlds has a
known duration and its own rise and fall; this one lasts until the page is
ready, which is a different number on every machine - so it ramps in over 420 ms
and then holds, and the screen lifting is what ends it. That needed the caller
to be able to supply the envelope, so `drawStreaks` takes an optional `power`
and the existing behaviour is its default.

Earth **fades** under it over 900 ms rather than being cut away, and the solar
page - mounted and rendering the whole time, which is the point - is held at
`opacity: 0` until the screen lifts. A half-built scene showing through the
transition is exactly the seam the screen exists to cover.

### The shape, again

This is the two-writer fault for the third time in three sessions (D154, D169,
here). The tell each time is the same: **a thing that can be ended from more
than one place is a thing whose duration nobody owns.** The fix each time has
been to give it one owner and put the rule where it can be tested.

Five tests on the hold rule. 832 backend, 1,075 frontend.

## D175 - Leaving is an edge, not a level

Phone: coming back from the solar system, the first click on "back to Earth"
does nothing and the second one works.

Mine, from D174, and one line of it.

### What broke

D174 moved the departure trigger from `zoomend` to `zoom` so that leaving
begins when the threshold is crossed rather than when the wheel stops. The test
inside it stayed a **level** test:

```ts
if (map.getZoom() > LEAVE_FOR_SYSTEM_ZOOM) return;
```

Correct on an event that fires once. Wrong on one that fires every frame, and
wrong in a way the old code could not have been - because the threshold is also
the **zoom floor**. A reader who has arrived is sitting at `-2.0`, which is
below the line, forever.

So the return did this: the page closes, `easeTo` starts lifting the camera
from the floor, and on the ease's first frames the zoom is *still* below the
line with `openPage` already null. The handler fired again and put them
straight back. By the second click the ease had carried the camera clear, so it
worked - which is exactly the symptom.

### The fix

`leaveCrossing(wasAbove, zoom, threshold)` carries the one bit of memory that
turns "is it below" into "has it just gone below". `PlanetView` keeps
`aboveLeaveZoom`, starting true because the view opens well above the line.

Sitting at the floor no longer re-triggers; the camera has to climb back above
the threshold and come down again, which is what leaving twice actually means.

Measured, from a fresh load: zoom 2 -> wheel out -> arrives at -2.01 with the
page open -> **one** click -> page null, camera eased to z1.0. Then the whole
round trip again, to prove the edge re-arms: left again at -2.0, home again at
z1.0.

### The lesson is about the event, not the comparison

The comparison was right in both versions. What changed underneath it was **how
often it would be asked**, and a predicate that is fine once a gesture is a
different predicate sixty times a second. Changing an event source is changing
the question every handler on it is answering.

Five tests, including the one that fails against the level version: a zoom of
-1.99 while below must not count as a crossing.

832 backend tests, 1,080 frontend.

## D176 - The Earth was centred; the arrival zoom was not

Phone, with a screenshot: "when i return to earth from solar map, the earth is
not center anymore".

### It was centred, to the pixel

I went looking for an offset - padding, a stale canvas, a resize the map had
missed - and found none. So I measured instead of eyeballing a lit crescent
against a black background, which cannot be done: project a five-degree lat/lng
grid, take the bounding box of the near-side points, and that is the drawn
disc whatever the terminator is doing to what you can see.

| | |
|---|---|
| Disc centre | **(435, 449)** |
| Viewport centre | **(435, 449)** |

Identical. What the grid also gave was the thing that matters: the disc was
**201 pixels across** in a 870-pixel frame. A small ball in a large black
rectangle, with its lit crescent off to one side, reads as off-centre. It is
not; it is too small to look centred.

### What was actually wrong

The arrival zoom. `RETURN_FROM_SYSTEM_ZOOM` is 1.0 and the readout in Phone's
screenshot said **z-1.1**; my own reproduction landed at **z0.41**.

`easeTo` is cancelled by any user interaction while it runs, and the 500 ms
after clicking "back to Earth" is precisely when a hand is still on the mouse.
The ease aborted partway and left the camera wherever it had got to.

**Jumped rather than eased.** There is nothing to animate: the journey screen
is over the top for the whole move, so the ease bought a smoothness nobody
could see and added a way to fail - the same reasoning D174 used for snapping
the outward camera onto the Sun.

Measured after, with the return interrupted as hard as I could manage - four
wheel events 150 ms in: arrives at 1.0, disc **424 pixels** across, centre
(435, 449) on a viewport centre of (435, 449). The z1.6 in the trace afterwards
is the interrupting wheel doing what it was asked to.

### Worth recording that I chased the wrong thing first

The report said "not centred" and I spent the first half of this looking for an
offset, because that is what the words describe and the picture supports.
Nothing was offset. **A reader reports a symptom, not a cause**, and the
picture agreed with the symptom - a small globe low in the frame looks exactly
like a centred globe that has been pushed down.

What broke the deadlock was refusing to keep reading the screenshot and
measuring the disc instead. The two numbers came out equal on the first try.

No test covers this: it is one line inside an imperative map callback, and the
suite cannot run MapLibre. What it has instead is a reason written where the
line is.

832 backend tests, 1,080 frontend.

## D177 - A page about the site, opening on the mark in three dimensions

Phone asked for an About page in the manner of a studio site, corrected the
brief once - *"I mean about the website, no need to introduce us"* - and then
asked for the logo built in 3D at the top with the content rolling in on
scroll.

### The mark is the subject, not a badge

`public/logo.svg` is a globe with an orbit wrapped round it and one satellite on
the near arc. This application spends the rest of its time drawing globes,
orbits and satellites from real geometry, so the About page builds the mark the
same way rather than showing a picture of itself.

The wrap is *real* in both, and that is the argument for doing it: in the SVG it
took two arcs and a clip path drawn in a deliberate order, because SVG has no
depth. Here the ring's radius simply exceeds the globe's and half of it passes
behind.

**Nothing is fetched.** The colour comes from `surfaceTexture`, the procedural
latitude bands the solar page already uses for bodies with no mosaic - so the
mark costs one request fewer than a logo image would and works offline like the
rest of the app (D30).

It is deliberately **dark**. The title sits over it, and a lit globe behind a
serif is a globe with an unreadable sentence on it: the ring carries the
brightness, the sphere carries the shape.

### What it says is data

`aboutFacts.ts` holds every claim and `aboutFacts.test.ts` checks them against
the rest of the repository, because a page about the project is the easiest
place in the application to write something flattering and untrue:

- the three layers are checked against **the store's own registry**, so the page
  cannot describe a layer the app does not serve;
- every layer must declare whether its position was **observed or computed**,
  which is the distinction the whole map is built on;
- OpenSky must still say *non-commercial* and aisstream *unstated*, because
  rounding either to "free" throws away the finding (D165) that constrains what
  this could ever become.

The counts are **asked of the running system** as the page loads. They move, and
the last figures copied into a document were stale within three sessions and one
of them was wrong the day it was written. `null` renders as an em dash rather
than a zero: zero is a claim - it says the sky is empty.

The most distinctive section is the one listing what the map **will not** say -
each with the reason. Not a disclaimer: every line is a decision with a defect
behind it, and a tracker's failure mode is drawing something confident where it
has nothing.

### A false alarm worth recording

Driving the finished page, the scroll appeared to move on its own - I set it to
1400 and it drifted to the bottom, oscillating. I nearly went looking for a
layout thrash in the reveal transitions.

Measured instead, from a clean load with no input: `scrollTop` stayed at 0 for
four seconds, unchanged. **The drifting was momentum from my own wheel commands
in the browser pane**, not the page.

That is twice in one session - D176 was the same shape, where "the Earth is not
centred" turned out to be a centred Earth at the wrong zoom. Both times the
instrument was the problem and both times the fix was to stop interpreting and
take a measurement. This project already has a memory about instrument error;
this is two more entries for it.

Thirteen tests on the claims. 832 backend, 1,093 frontend.

## D178 - The mobile pass, and three attempts that made it worse

Phone asked whether the site is friendly on a phone. Measured at 375x812 the
answer was: it does not break, but it is not comfortable.

### What was already right

**No horizontal overflow anywhere** - the map, the About page, all of it, with
`scrollWidth` equal to the viewport exactly. That is the commonest mobile
failure and it was absent. D167 had already measured performance there: 4.2 ms
p50 with 915 markers. And the solar page's Visit buttons already had a
`@media (hover: none)` rule, so somebody had thought about touch.

### What was wrong

| | Measured |
|---|---|
| Night toggle | **30 x 30** |
| Basemap toggle | **30 x 30** |
| Sign in | 61 x 20 |
| **About** | **84 x 12** |
| Layer buttons | 75 x 33 |

Against a 44-pixel guideline, everything interactive on the map was about half
size - and the worst of them was the About link added the day before.

**The status bar sat on the map attribution**: status y 737-812, credit y
758-802. Not cosmetic. This project already treats crediting the wrong source
as a licence fault rather than a tidiness one (D120), and burying the credit
under a counter is the same family.

**The About page's source rows collapsed** rather than stacking: three columns
measured 140 / **15** / 140, so the middle one - what each source provides -
was fifteen pixels wide.

### The fixes, and the query that matters

Touch targets are keyed on `(pointer: coarse)`, not on width. That is the
honest question: what needs 44 pixels is a finger. A phone in landscape is 812
wide and still a phone; a 500-pixel desktop window is still a mouse.

The status bar moves up 56px - clear of the credit's *measured* height, since
34px was tried first and the overlap survived it.

The About rows stop being a grid below 640px. A grid that cannot fit its
columns is not a grid.

### Three attempts made the header taller, not shorter

The header was 188px on an 812-tall screen. Making the hit areas finger-sized
pushed it to **200**, because the three controls under the wordmark stack.

- Attempt one: pad the text controls. They stayed at 38 and 36 - `box-sizing:
  border-box` puts padding *inside* the height, so adding some to an element
  that already has one buys nothing. `min-height` instead.
- Attempt two: put the controls on one row with `display: flex`. Still stacked.
- Attempt three: give the brand the full width so they fit. **234**. Worse
  again, and still stacked.

The cause of all three: `.app__brandText` is `flex-direction: column` in the
base rule, and every mobile override set `display: flex` without touching
`flex-direction`. I was overriding a property that was already what I was
setting it to, and never read the rule I was overriding.

With `flex-direction: row` the header dropped to **139** - and crushed the
search to 105px, which is not a field. A floor of 190px sends the search to its
own row: header **185**, search **351** where it was 191.

Marginally shorter than it started, with a search nearly twice as wide and
every target at 44. That is the trade, and 185 with a usable field beats 139
with an unusable one.

### The lesson

**Read the rule you are overriding.** Three rounds of a mobile layout getting
worse, each measured, none diagnosed, because I kept adding declarations
instead of looking at the four lines they were fighting.

Measured after: every target 44 or more, `tooSmall` empty; status clears the
credit; About rows stack at 335px each; no horizontal overflow anywhere.

832 backend tests, 1,093 frontend.

## D179 - The map that renders perfectly and draws nothing

Orbital went up: the backend on Northflank, the frontend on Vercel. The last
step was CORS, and once that was set the site loaded, the globe turned, the
status bar read **2,000 aircraft, showing a sample of 7,859 in view** - and
there was not a single marker on the map.

### The counts came from the store, not the map

That is the detail that makes this defect hard to see. `/api/aircraft` was
answering 200 with 2,000 objects at the same moment the map was empty, and the
status bar reports what the store holds. Everything that measures the data said
the data was fine, because it was.

### What was actually wrong

`/assets/maplibre-gl-worker.mjs` - **404**.

MapLibre spawns its tile worker as `new Worker(new URL(e, import.meta.url))`
where `e` is a *variable*: it picks between the dev and production worker at
runtime. Vite can only follow that pattern when the path is a string literal,
so it emitted nothing and left the URL to resolve against the chunk's own
folder, where nothing exists.

No worker means no tile processing, which means **`load` never fires** - and
every layer this application adds lives inside that handler. Aircraft,
satellites, ships: never created. Meanwhile the raster imagery painted
perfectly, because raster tiles are loaded on the main thread.

### This was the other half of D63

D63 recorded exactly this signature - "renders raster imagery perfectly while
never drawing a single road or label" - and fixed it with
`optimizeDeps.exclude`. **That setting has no effect on `vite build`.** The
comment describing the failure sat four lines above a fix that only ever
applied to the dev server, and the production build was never opened in a
browser until the day it was deployed. A defect can be documented and unfixed
at the same time.

### The fix

A build plugin copies `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs`
into the output beside MapLibre's chunk. Both keep their exact names: the
worker resolves its sibling by the literal specifier
`./maplibre-gl-shared.mjs`, so a hashed copy would 404 one level down in
precisely the same way.

It asserts the files are non-empty rather than trusting the copy. The entire
reason this survived is that a missing worker says nothing at all, so a build
that fails to produce one has to fail loudly at build time instead of silently
in someone's browser.

### The lesson

**A build is not exercised until something loads it.** Every test passed, the
dev server was correct, and 1,093 frontend tests had nothing to say about a
file that Rollup declined to emit. The instrument that finally answered it was
`curl -D -` against a static asset.

832 backend tests, 1,093 frontend.

## D180 - The phone stops being a narrow desktop

Phone looked at the deployment on a real screen: "mobile ui/ux is a messed up,
we need to fix a lot". Measured at 375 x 812, and the measurements agreed.

### What D178 left behind

D178 made every target finger-sized and reported success. It was measuring the
wrong things. Making the controls tappable pushed the header to **185px on an
812px screen**, and nothing checked what a header that tall was landing *on*:

| Collision | Measured |
|---|---|
| Header over the map's own controls | header `0,0 375x185` over night/basemap at `321,0 54x108` |
| Sign-in hit box across the wordmark | signin `131,25 - 192,69` over a title at `56,12 - 306,31` |
| Key over the status bar | legend `577-768`, status `692-756` |
| Key over the attribution | legend bottom 768, credit from 758 |

The night and basemap toggles could not be tapped at all. Total chrome came to
**440 of 812 pixels - 54% of the screen** - to show a map.

Two of those were caused by the D178 fix itself. `margin: -12px -10px` kept the
header from growing by the padding it had just gained, and pulled each
control's box sideways over its neighbour.

### The shape of the fix

The phone gets its own layout rather than a squeezed desktop one.

- **The header keeps only what belongs at the top.** Name and controls share
  one row; the search, which needs a keyboard, gets the next. The subtitle goes
  - it reads "live aircraft" directly above a control saying Aircraft,
  Satellites, Ships. **185 -> 119.**
- **The layer switcher moves to the bottom**, where a thumb is.
- **The key opens as a pill**, one tap from the whole thing. 232 x 191 is a
  quarter of the map covered by something read once and then known.
- The map's own controls move down clear of the header.

`.app__brandLinks` is the piece worth noting: a wrapper that is
`display: contents` in the base rule, so on the desktop its three children lay
out exactly as they did as siblings - **verified: computed `contents`, controls
still at y61/76/96 at their original sizes**. It becomes a real flex row only on
the phone. The grouping costs the existing layout nothing.

### The globe was cropped, and the fix agreed with the old constant

`zoom: 2` is a statement about how big the window is, and it was written on a
desktop. On a phone the first thing shown was a piece of Asia.

MapLibre's globe draws the sphere `512 * 2^zoom / PI` pixels across. Solving
that to fit the 800-pixel-tall window this was built in returns **2.06**, and
the zoom chosen there by eye was **2**. That agreement is the reason to trust
the formula on a screen nobody tested; it is capped at 2 so no desktop view
moves.

Six tests, and two of them fail when the constant is wrong - checked by
breaking it, per the standing rule about vacuous tests.

### Measured after

Every control 44 or more, `tooSmall` **empty**. No overlaps of any pair. No
horizontal overflow. Header **119**. Chrome **297 of 812 - 37%**, from 54%.
Desktop unchanged.

832 backend tests, 1,099 frontend.

## D181 - Twenty seconds was a timeout, not a distance

Phone wanted to move the backend from Northflank to Render, because the ping
from Bangkok to London was too long for aircraft routes to appear.

The ping is real - **TCP connect ~200 ms**, and the 405 kB aircraft list on a
ten-second poll takes 1.75 s. But it is not what was wrong.

### Six cold lookups

| Aircraft | TTFB |
|---|---|
| 00834c | 20.66 s |
| 06a120 | 20.69 s |
| 493284 | 20.65 s |
| 47a05e | **41.14 s** |
| 074037 | **42.23 s** |
| a7c08f | 20.77 s |

Multiples of ten, on a link whose round trip is a fifth of a second. A 200 ms
RTT cannot produce twenty seconds; **that is a timeout, and it is ours** -
`opensky.py` allows 20 s, which is right for a poller fetching a state vector
for the whole world and wrong for an optional enhancement to a panel.

`trackSource` came back `observed` every time, which says it plainly: the
provider's track never arrived and the fallback was used - after waiting the
full twenty seconds for it. Meanwhile the route itself worked (UAL61 returned
Brussels with a full airport record) and adsbdb answers in about 0.1 s.

### The fix is concurrency and a budget

The two enrichments ask different services about different things and neither
reads the other's answer, so awaiting them in sequence only ever cost the sum.
They now run together, each with three seconds.

**The budget is shielded, and that is the part worth keeping.** The timeout
gives up *waiting*; it does not cancel the fetch. `FlightHistory` caches what
it gets and the client re-polls an aircraft for as long as it stays selected,
so a slow track arrives on a later poll. Cancelling instead would restart the
same fetch every few seconds, spend a credit each time (D78), and never once
arrive - a slow upstream turned into a permanently slow one.

### And the measurements had been lying all day

The deployment showed **five pods in one hour** with memory sawtoothing from
zero to 400 MiB five times. Not crashes - "Container Restarts Reason" said no
data - but five *deployments*: CD is wired to `main`, and three frontend-only
pushes redeployed the backend, each one discarding the half hour of AIS
accumulation behind it. Ships read 12,642, then 709, then climbing again.

I had proposed an OOM at the 512 MB cap. The chart said otherwise. **Worth
recording as a wrong call, because the shape was right and the cause was not**
- and because for most of the day both of us were reading numbers from a
backend that kept restarting underneath us.

Four tests, checked by making the endpoint sequential again: all four fail.

836 backend tests, 1,099 frontend.

## D182 - What a real phone showed that an emulated one did not

Phone sent two screenshots from an actual handset. D180 had measured a mobile
layout at 375 x 812 in a browser pane and found every pair of elements clear of
every other. Three faults survived that, and each survived for the same reason:
**the measurement was of one screen, showing one world, at one zoom.**

### The header had no background, and never had

Over a globe seen whole the top of the frame is empty space and the wordmark
sits on black. Zoomed to a country it is daylight terrain. The screenshot over
Thailand has "Orbital", "EARTH", "SIGN IN" and "ABOUT" in pale grey on green
farmland, effectively unreadable.

Nothing overlapped. Every box was where D180 put it. The defect was contrast,
which is not a rectangle and so was not in the measurement. A scrim, not a bar:
it inherits `pointer-events: none`, so it darkens the view without capturing a
drag.

### The world list ran off the right edge

`.bodies__list` is `left: -8px; min-width: 250px`, written when the picker sat
at the left of a wide header. The phone layout puts it in the right-hand group,
so the list opened straight off the screen - "A star has no surface to st...",
"radius 2,440...", cut mid-word.

Right-anchoring it only moved the problem: the picker is the *first* of three
controls in that group, so the list then started at **x -42**. There is no edge
of that button a 300px list can hang from on a 375px screen. It hangs from the
viewport instead.

### The status bar covered the credit again - the third time

34px in D178. 44 measured, 56 set, in D180. Both were right for the screen they
were measured on and wrong on the Moon, whose imagery carries an extra
attribution that wraps the credit to three lines.

**So it stopped being a constant.** `attributionHeight.ts` measures the credit
where it is drawn and publishes `--attribution-height`; the status bar, the
layer bar, the detail panel and the Moon list are all positioned from it, plus
`env(safe-area-inset-bottom)` for the browser chrome an emulator does not have.
A wrap moves the whole stack the same frame it happens.

This is a licence obligation, not tidiness. Crediting the wrong source is
treated here as a licence fault (D120); burying the credit is the same family.

### And the Moon list was simply missed

`.moonlist` carries the same `bottom: 44px` as `.panel` on a different rule.
D181 lifted the panel and did not grep for its siblings, so the list ran under
the status bar with Chandrayaan-2 cut off the bottom of the screen.

### The lesson

**An emulated phone is a screenshot of a guess.** Six tests here, but the three
faults were found by a person holding a device - a bright basemap, a body with a
longer credit, and a browser with its own chrome at the bottom. None of those
are conditions a viewport size reproduces.

836 backend tests, 1,105 frontend.

## D183 - The gesture everyone has should do the thing the page is for

Phone: *"for solar system view, I think its better for us to have the system
fixed at Sun in middle and be able to drag around in mobile, should apply same
on window."*

Half of it was already true and measurement said so: with the page open, the Sun
sits at **(197, 350)** on a 394 x 700 canvas whose centre is **(197, 350)**.
D172 snaps the camera there on open. What was wrong is that the first drag moved
it away.

### The bindings were the wrong way round

- **Drag** panned - it moved the camera's *target*, sliding the whole system off
  centre.
- **Right-drag** turned it.

Panning is the more capable gesture and it was on the button everybody has,
which made the ordinary way to explore the system "push it off the screen". On
a touch screen, where there is no second button, panning was the **only** thing
a finger could do: the Sun could be shoved out of frame and never turned.

Turning is what this page is for. It is a set of rings seen from an angle, and
the reward for moving is seeing them from another one. So drag turns, and
right-drag pans for the reader who wants it.

Measured after, with a synthetic `pointerType: 'touch'` drag across the canvas:
**the Sun moved 0.0 px** while **Jupiter moved 103.7 px**. The system turned
around a fixed Sun, which is the sentence Phone wrote.

### Touch had no zoom at all

No wheel, no second button. A system eighteen globe radii across is not much use
at one fixed distance, so two fingers pinch. `pinchFactor` is a ratio for the
same reason `zoom` is: the same finger movement should cover the same
*proportion* of the remaining distance at Mercury and at Neptune.

A second finger ends the drag rather than fighting it, and a pinch is never a
click however little either finger travelled - the one that lifts first has
usually barely moved.

### A test bug that was worth listening to

A run threw before dispatching `pointerup`, leaving two dead pointers in the
map. `fingerGap` read the *first* two entries, so every later pinch measured a
gap between two fingers that were no longer there and never changed.

That is my test leaking state - and also a real defect. A `pointerup` that never
arrives is an ordinary event on a touch screen: a lost capture, a gesture the
system interrupts. It reads the **last** two now, so the pair being measured is
always the pair that arrived most recently, and a stranded pointer cannot freeze
the zoom.

### And an instrument that lied again

The first pinch measurement said nothing had moved. It had: I was measuring
Venus's *label*, and `stackLabels` moves labels off their bodies to stop them
colliding. Label position is not body position. Jupiter, far enough out not to
be stacked, showed the zoom plainly.

836 backend tests, 1,109 frontend.

## D184 - A card is a shape for the corner of a large window

Phone, with a screenshot of an aircraft selected on a phone: *"I think we need
to fix the layout big, I mean how am I going to view the route and the plane
like that?"*

The right question. D182 had put the detail panel above the bottom stack, which
made it **correctly placed and still unusable**: a 40vh card, most of it a 16:9
photograph, with the route somewhere below a scroll bar nobody could see.

Nothing overlapped. Every measurement in D182 passed. The panel was in exactly
the place it had been told to be, and the thing the reader opened it for was off
the bottom of it.

### Two changes, and the second is the one that matters

**A sheet, not a card.** Full width, 72vh, square where it meets the foot of the
screen. A card is a shape for a corner of a large window; on a phone the thing
being read is the only thing being read. The layer bar and the status bar hide
while it is open rather than hiding behind it - and the credit keeps its corner,
because that is a licence obligation (D120) and the sheet stops just above it.

**The route comes first.** In source order the panel reads callsign,
photograph, staleness, eight rows of identifiers and derived speeds, and only
then the route. That order is *right* in a tall window where all of it is
visible at once - the picture answers "what am I looking at" faster than any row
can (D116). On a phone it buries the answer.

The sheet is a flex column, so the order changes without the markup changing:
callsign, whether the position can be trusted, where it is going - and the
photograph directly under them, still inside the first screenful. Measured:
visual order **header, age, route, route, photo, fields**, and the route is
inside the sheet without scrolling.

### The lesson, which is not the same as D182's

D182 said an emulated phone is a screenshot of a guess. This one is smaller and
worse: **every pair of boxes can clear every other pair and the layout can still
be wrong.** "Nothing overlaps" is a test for a defect, not a definition of a
design. The panel passed every geometric check I could write and failed the only
question that mattered, which was whether the thing it exists to show could be
seen.

### An aside worth recording

The suite failed 5 tests, then 6 different ones, then passed 1109 of 1109. The
failing set moved between runs, and the tests that moved are the slow ones - the
star catalogue, the ring profile, the graticule mesh. They were timing out
against a machine running a dev server, a browser and a build at once.

Not a defect today and a real risk tomorrow: those tests are close enough to the
timeout that a loaded CI runner would fail them, and a suite that fails only
when busy is a suite nobody trusts - which is the exact objection recorded in
the conftest comment about tests that fail only in company.

836 backend tests, 1,109 frontend.

## D185 - The sheet gets two columns, and the prose goes

Two rounds in one sitting, both from Phone looking at a real phone.

### First: 72vh was a takeover, not a sheet

D184's sheet put its top edge under the search bar. The map went away, and with
it the aircraft that had just been tapped - *"now what the freak is this"*, which
is the correct response to an application that hides the thing it is describing.

**52vh.** The map keeps its upper 286 of 700 pixels, and the callsign, the
staleness line and the whole route still arrive without a scroll. A grab bar at
the top says which edge it is attached to, which is the difference between a
sheet and a panel that happens to be at the bottom.

### Then: two columns, and no prose

Phone's layout, and it is better than the one it replaced: the photograph to the
bottom right, the route and its departure airport in the space beside it, and
the explanations gone.

**The prose goes.** Every caveat in this panel is true and worth saying - what a
scheduled route is and is not (D88), where an observed origin comes from and how
far the nearest airport was (D78). Each is three lines of explanation sitting
between the reader and the next fact, on a surface that is not doing first
readings. The *claims* stay: "Scheduled route" and "Observed path" are still
separate headings, which is the distinction those caveats exist to protect.

Measured: photograph at x 244-378, route at x 16-232, side by side, no text
under the picture, both sections visible without scrolling.

### The grid rule that cost the most time

`order` alone could not pair them, and the reason is in the spec rather than in
a mistake I made: when an auto-placed item names a column to the *left* of the
placement cursor, the cursor drops to the next row. So a column-2 item can never
be joined afterwards by a column-1 item - whichever way the two were ordered, one
started a new row and they came out stacked. Naming explicit rows for the four
that lead takes the cursor out of the argument.

### The layer switcher moves up, and gets smaller

D180 put it at the foot of the screen for the thumb. Right instinct, wrong
result once the sheet existed: the sheet owns the bottom half, so the bar had to
hide whenever anything was selected - a control that vanishes exactly when you
are exploring. It sits under the header now, centred in the measured gap between
the key pill (x 12-63) and the map's controls (x 340-394).

Its buttons are **36px, under the 44px floor D178 set**. Broken on request, and
defensible rather than sloppy: the three targets sit together with nothing else
near them, so a miss lands on another layer rather than on something
destructive - and it is no longer at the bottom of the screen where a miss used
to land on the status bar or the credit.

### And the flaky suite was real

Five tests failed, then six different ones, then none. The reason, once
captured: **"Test timed out in 5000ms."** A few of these are slow because they
are exhaustive - every index in the star catalogue, the ring profile at every
radius, the graticule mesh to the edge of mercator - about 1.8 s unloaded, and
past five on a machine also running a dev server, a browser and a build.

`testTimeout: 20_000`, raised rather than the tests made shallower. They are slow
because they check everything, which is the property worth keeping.

836 backend tests, 1,109 frontend.

## D186 - Only the second screenshot was necessary

Phone, with four crops of the running site: only the second one is needed, make
it smaller, put the rest behind a "see more"; make the layer bar transparent
like the wordmark above it; move the counter to the foot and shrink it.

### The sheet opens brief

The second crop is the callsign, whether the position can be trusted, where the
flight is scheduled to go, and the picture. Four things, and every one answers
*what am I looking at*. Everything under them - identifiers, derived speeds, how
many positions the track holds - is reference. True, and not what a tap on a
marker was asking.

So it is behind a control rather than behind a scroll. **A scroll hides things
without admitting it; a button that says "See more" is a promise that there is
more.** Brief measures **244px against 364**, and needs no scrolling at all -
61% of the screen stays map.

The control is reset whenever the selection changes: a reader who opened one
aircraft in full has said nothing about the next one.

### The bar loses its furniture

Phone asked for it to look like the wordmark and the About link above it, and
those have no box at all - only text over the map. Background, backdrop filter,
border and shadow all go; the active layer keeps its fill, because that is now
the only thing distinguishing it, and the other two get a text shadow because
words over imagery need one.

### The counter went down by making something else smaller

The status bar sat above the credit, which put a counter across the middle of
the map. It is now 34px against 60, one line, 10.5px - and **nothing in its
positioning changed at all**.

`attributionControl: { compact: true }` was set when the map was built, and
MapLibre renders the compact control *expanded* on first paint, collapsing it
only when someone presses its button. On a phone that is two lines of credit
across the foot of the map before anyone asked. Removing `maplibregl-compact-show`
once, after load, gives the arrangement the code always requested: a 24px round
button in the corner that opens the full credit on a tap - verified, 24px to
374px and back.

The status bar then dropped on its own, because D182 positions it from the
*measured* credit height rather than a constant. The published value went 44 to
24 and everything above it followed. **That is the return on having stopped
guessing**: a change to the credit moved four other elements correctly without
one of them being touched.

The credit is not hidden. It is the control it was configured to be, and this
project's rule is that the source must be credited (D120) - not that it must
occupy the foot of every phone.

836 backend tests, 1,109 frontend.

## D187 - Three spacecraft should not cost the Moon

Phone's screenshot of the Moon on a phone: the "In orbit" list covering the body
it is a list *about*, from limb to limb.

The desktop card is 232px wide, and inside it two lines per craft is compact -
name and altitude on the first, operator beneath. D182 gave the card the full
width of the phone and kept that shape, so three spacecraft became **280px of
card over the middle of the Moon**.

Four columns instead of two rows. There are only ever three of these, so one
line each is the whole list in **158px - 23% of the screen against 40%** - and
the Moon stays whole. The operator truncates first if a row runs out of room,
being the least of the three things a row says; measured, the longest name we
carry ("Chandrayaan-2 Orbiter") does not truncate at all and the altitude stays
inside the card.

Desktop verified unchanged: 232px, `10px 1fr auto`, the dot still spanning two
rows, 71px rows.

**The pattern is worth naming, because this is the third time.** A component
laid out for a narrow card in the corner of a large window is given the full
width of a phone and keeps its old shape - which is not "responsive", it is the
same design with more room to be wrong in. The detail panel did it (D184), the
world list did it (D182), and this is the Moon list doing it.

836 backend tests, 1,109 frontend.

## D188 - Seven notes from a phone and a window

Phone sent four crops and a list. Taken together they are one complaint - the
chrome had accumulated - and seven separate causes.

### The accent was competing with the map

`#58b6ff` on a screen already full of blue: ocean, night wash, the basemap's own
water. An accent has one job, to be the thing that is not everything else, and
it was the same hue as the thing it sat on. **Amber `#ffd166`**, which is
already in the application - the Moon's spacecraft dots, the low end of the
altitude ramp - so it reads as lit rather than as interface. Phone's choice from
three offered.

### The wordmark now uses the solar page's serif

That page sets its title in a system serif and its standfirst in small
letterspaced capitals, and reads as a masthead. The planet view had the
sans-serif label every dashboard has. Same family, same restraint, and no
webfont is fetched for it (D30).

### Three controls on one line, at three different heights

The key pill, the layer bar and the map's own controls were 44, 36 and 44 tall,
all starting at y128 - **sharing a top edge and nothing else**. They share a
centre now. The menu button is MapLibre's own 29px, so its offset is three
different from the others' on purpose.

### Safari zooms any field under 16px

Tapping the search box magnified the page and did not undo it. There is no
property for "do not do that"; the only fix short of disabling pinch-zoom for
the whole document - an accessibility regression to fix a nuisance - is to give
the field the 16px Safari looks for. The placeholder inside it stays at 13.

### A figure and its name are one statement

The About page gave the count `minmax(120px, 1fr)`, a column that grew with the
window, so "15,687" sat at the left of 490 empty pixels with its label stranded
across the gap. Capped at 168px and right-aligned, so the three figures stack
into a column that reads down - which is the whole point of the tabular numerals
already set on them, and impossible while "1,427" started at the same left edge
as "32,254". Gap measured 490 to **32**.

### Two permanent buttons became one

The basemap cycle and the night toggle are both useful and neither is used
often, and together they were most of the chrome down the right-hand edge.
`viewMenuControl.ts` adds a third button and toggles a class; the stylesheet
does the rest. **The two controls are not moved, reparented or told anything** -
MapLibre still owns them and their order - so a fourth added later needs no
change to either file. Their labels come from their own `title` attributes,
which already say what pressing will *do* rather than what is on (D68), so the
menu row cannot drift from the tooltip.

Two mistakes on the way, both found by measuring: the class was going on
`.planet-view` when MapLibre's container is `.planet-map` inside it; and the
touch rule squaring these buttons at 44x44 (D178) has equal specificity and
comes later, so it took the width and clipped a 133px label to 44.

### And the Moon list to the corner

Full width for three spacecraft reads as a bar across the Moon rather than a
note beside it. Bottom-left, 238 x 138 - **60% of the width and 20% of the
height** - with the longest name still unclipped.

836 backend tests, 1,109 frontend.

## D189 - The popup is reverted

D188 put the basemap cycle and the night toggle behind one button. Phone looked
at it: *"rewind the popup one for them it's not cool."*

Correct call, and the screenshot says why better than the reasoning did. Open,
the panel was a wide dark slab that ran back over the layer bar - "Ships" ended
up sitting inside it - with two full-width rows whose labels, taken from
`title`, are sentences rather than menu items: *Show the plain map*, *Show
night*. Written for a tooltip that appears next to a glyph, and far too long
once they are the row.

The reasoning behind it was sound in the abstract: two controls that are useful
and rarely used, taking up most of the right-hand edge. What it did not account
for is that **two glyph buttons in a corner are already the smallest form this
can take.** Putting them behind a third button adds a control to remove two, and
the menu that results is bigger than the thing it replaced. A popup earns its
place when it holds more than fits, and two 44px squares always fit.

Reverted entirely: `viewMenuControl.ts` deleted, the control unregistered, the
stylesheet block removed. Nothing else from D188 is touched.

**The alignment came out better for it.** With the menu button gone the top-right
control is a 44px square again, so the offset is computed for that alone:
measured, the key pill, the layer bar and the basemap button now share a centre
at exactly **146** - where with the menu in the line it was 146, 146 and 143.

836 backend tests, 1,109 frontend.

## D190 - The links were hung off the subtitle

Phone noticed that Sign in and About slide sideways when the layer changes, and
asked for them in the top right like the phone has them, with a larger mark.

The cause is exact. Those three lived inside `.app__brandText`, under the name -
so their left edge was set by the widest thing in that block, which is the
**subtitle**, and the subtitle names the layer. Measured across the three:

| Layer | Subtitle | Brand block's right edge |
|---|---|---|
| Aircraft | LIVE AIRCRAFT | 162 |
| Satellites | SATELLITES ON ORBIT | 203 |
| Ships | SHIPS IN COASTAL WATERS | 234 |

Seventy-two pixels of travel, on controls that have nothing to do with the
layer. They are a child of the header now, which does not change, and `order`
puts them at its right-hand end on a desktop and beside the name on a phone -
one element, two placements, no second copy in the markup. **About measured at
x 993 in all three layers afterwards.**

The mark goes 34 to 46 now it is the whole of the brand beside the name. On the
phone it stays 28, because there it sets the header's height and 119px was hard
won (D180); the links joining that row cost 12 anyway, taken back off the
scrim's bottom padding for a final 123.

### A vacuous test, caught

The first check said "About is stable across layers" and proved nothing: it
tried to switch layers through the store and the subtitle read LIVE AIRCRAFT in
all three samples. A stable measurement of a thing that never changed. Redone by
clicking the actual buttons, the subtitles differ, the brand's right edge moves
162 -> 203 -> 234, and About holds still. The standing rule about breaking a test
before trusting it applies to measurements too.

836 backend tests, 1,109 frontend.

## D191 - The map says where it is listening

Phone asked whether the ships tab should carry an "under development" sign and
show only the Baltic, on account of what the global feed costs to hold.

**Half of that, and not the "under development" half.** Nothing here is
unfinished: the global stream works and measured 17,848 vessels against
Digitraffic's 643 (D166). What is true is that holding them costs more memory
than this box has. A sign saying "under development" invites a reader to think
it is broken or coming soon, and if the cap is never raised it becomes a claim
that quietly never expires.

So the map says which feeds it is actually using, and the subtitle follows:

| Feed | Subtitle |
|---|---|
| `digitraffic+aisstream` | ships in coastal waters |
| `digitraffic` | **ships in the northern Baltic** |

`layerChrome` deliberately refused to answer this - "coastal waters" was chosen
because it is the one phrase true of both, and that was right for a subtitle
that *cannot know* which sources are running, since that is a deployment
setting. **`shipCoverage` can know**, because the answer arrives with the data:
the backend already names the feeds it combined. Derived rather than declared,
so it corrects itself the day the global stream comes back rather than becoming
a stale sign.

Neither answer says "everywhere". Both sources are terrestrial AIS listening
from the shore, so the holes are the open ocean and every coast without a
receiver - the Indian Ocean returned 2 vessels and the Gulf returned 0. A test
asserts that neither string can claim otherwise, because that is the failure
this layer is one careless edit away from.

An unrecognised feed name gets **no** answer rather than a guessed one. Guessing
the scope of a source we cannot identify is how a map ends up confident about
sea it has never heard from.

Five tests. Verified live by forcing the feed source both ways in the running
app and back again.

**Not done, deliberately**: global ships stay on, so the backend keeps
OOM-restarting and flight tracks stay short. Phone's call - the durable fix is a
cap on the ship store rather than switching a source off, and there is time.

836 backend tests, 1,114 frontend.

## D192 - A ceiling that does not depend on the sea

The container had been OOM-killed on a cycle for most of a day. D191 recorded
the choice to keep global ships and fix it properly; this is that fix.

### The dial was not connected to the thing that accumulates

`ORBITAL_SHIP_OBJECT_TTL_SECONDS` was applied to the **store** and to nothing
else. The aisstream provider keeps its own `_positions` dictionary and was
constructed without an age at all, so it went on holding its default 900
seconds' worth and handing them straight back on the next snapshot: the store
evicted at the configured age and was refilled immediately.

That is why turning it from 900 to 400 moved the vessel count by **16%** -
32,254 to about 27,000 - when it should have roughly halved it. I recommended
that change and watched it underperform without asking why the number was
disappointing rather than merely small. **A setting that does not reach the
thing it names is worse than no setting**: it looks like a lever and answers
like one.

### An age limit is not a size limit

Even connected, the TTL bounds how *old* a vessel may be, which is a different
question from how many there are. The same limit holds 643 vessels on
Digitraffic alone and 27,000 with the global stream: the number is a fact about
how busy the sea is, and memory cannot be budgeted against that.

So `ship_max_vessels` is a hard ceiling, default **14,000** - the measured
27,000 roughly halved, still twenty times the Baltic-only feed. Two data points
and a straight line rather than a model, which is why it is a setting.

**Oldest first, and that is the whole policy.** The freshest position is the one
most likely to still be true, so when there is not room the vessels to lose are
the ones already closest to expiring. Dropping whatever the dictionary yielded
first would have made coverage a function of hash order.

The two limits are independent and both apply: a vessel too old to serve goes
even when there is room, or the cap would resurrect the ghosts the TTL exists to
bury (D86). Records are built *after* pruning, so the provider never serves a
vessel it has just decided it cannot afford to remember.

Five tests, checked by breaking it twice - disabling the cap fails two of them,
reversing the eviction order fails the one that names it.

**841 backend tests**, 1,114 frontend.

## D193 - The cap has to be on the store as well

D192 capped the aisstream provider at 14,000 vessels, deployed it, and watched
the ships count climb past 27,000 anyway.

### Why the provider's cap did not bound the store

`/api/ships` reports what the **store** holds, not what the provider holds, and
they are different numbers for a reason worth writing down.

The provider keeps the freshest 14,000 - but it *churns* through many more than
that: a vessel evicted for space sends another message a minute later and comes
straight back. The store is handed the result of every poll and keeps the union
of all of them until its own TTL expires each one. So the store's size is the
number of distinct vessels seen in a TTL window, which measured **27,000** while
the provider was correctly holding 14,000.

**A cap on a source does not bound a cache downstream of it.** That is obvious
written down and was not obvious while writing D192, where "cap the thing that
accumulates" felt like the whole of the problem. It was half.

### The fix

`ObjectStore` takes `max_objects` and enforces it in the same sweep as the TTL,
oldest-seen first, for the reason the provider uses that order: the most recent
report is the one most likely to still be true.

Two things fell out of writing the tests, both better than what I had assumed:

- **`apply` sweeps as it writes**, so the ceiling holds without anything else
  remembering to call `evict`. My first test asserted a return value from an
  explicit `evict()` and got 0 - not a bug, but the cap having already done its
  work on the write path. The test now asserts that property instead, which is
  the one that matters: a cap that only applied when asked would let the store
  grow between polls, which is exactly when it grows.
- Track history goes with the record, so a cap cannot leak the very thing it was
  added to bound.

Six tests, checked by breaking it twice: disabling the cap fails three,
reversing the eviction order fails the one that names it.

**847 backend tests**, 1,114 frontend.

## D194 - An error message that said nothing, for a day

Phone: *"I honestly dont think its northflank fault as the route error is still
same in localhost."* Right, and the way to settle it was already on the desk.

### What the comparison proved

| | Local | Northflank |
|---|---|---|
| Uptime | **408 min**, no restarts | 14 min |
| ETH609 track | 9 points | 10 points |
| Track source | **provider, 8 of 8** (62-291 pts) | **observed, 0 of 8** (6-8 pts) |
| OpenSky credits | **3,724** | **None** |

A backend up seven hours shows the same short track for that aircraft as one up
fourteen minutes, which kills the story I had been telling: the OOM restarts
were real and worth fixing, and they were **not** why routes looked wrong. I
built an explanation around uptime and never tested it against the machine
running on the same desk. Phone did.

The real fault is in the third row. Every aircraft locally gets OpenSky's own
flight track - the path from takeoff, 62 to 291 points. In production every one
falls back to our own ring buffer of 6 to 8. Same credentials, verified by
fingerprint rather than by eye.

### The log line that wasted the day

```
opensky could not supply a track: token request failed:
```

That colon is the end of the message. `str(exc)` is empty for most of httpx's
connection errors, so `f"token request failed: {exc}"` logged *the fact that
something unspecified went wrong* and nothing else - 308 times.

**The difference between `ConnectTimeout` and `ConnectError` is most of the
diagnosis**: one says the route is slow or filtered, the other says the
connection was refused or the host unreachable. Neither was recoverable from the
line as written, so the failure looked like a mystery when it was merely
unlabelled.

Every `{exc}` in this provider now goes through `describe`, which always yields
the class name and adds the message when there is one. Three tests, including
one asserting the result is never blank whatever is thrown - the property the
old format string failed to have.

The cause of the token failure itself is still open: the endpoint has no AAAA
record so it is not an IPv6 fallback, the host resolves to one Swiss address
from both machines, and it answers in 0.25 s from here. What the container sees
is the next thing to find out, and now the log will say.

**850 backend tests**, 1,114 frontend.

## D195 - The edit landed on the documentation of the bug

D194 routed every `{exc}` in the OpenSky provider through `describe`, tested it,
deployed it, and production went on logging the old message with nothing after
the colon.

**Five of six call sites had changed. The sixth was the token request** - the
only one production was failing on.

The replacement rewrote the *first* occurrence in the file, and the first
occurrence was inside `describe`'s own docstring, where the broken format string
is quoted as an example of what not to do. So the edit landed on the description
of the bug rather than the bug, and left the docstring saying the opposite of
what the code did.

Three tests passed the whole time, because they call `describe` directly. **A
test of a helper is not a test of its callers**, and the distance between those
two things is exactly where this hid: the helper was correct, its docstring was
about the right problem, and the line that mattered was untouched.

The new tests drive `_request_token` through a transport that raises
`ConnectError("")` - the real production failure, an exception whose `str()` is
empty - and assert the message does not end in a colon. Checked by putting the
original bug back: both fail.

Worth naming the shape, because it is not really about `str.replace`. **An
example in a docstring is code-shaped text that no test covers**, and any edit
matching on content can hit it first. The lesson is the same one D190 taught
about a vacuous measurement: assert on the thing you are shipping, not on the
thing you are explaining.

**852 backend tests**, 1,114 frontend.

## D196 - A real track, of a real flight, that was not this one

Phone put Orbital next to Flightradar24 for two aircraft and found the headings
pointing the wrong way.

| Flight | Actually flying | Orbital said |
|---|---|---|
| CSH832, Phuket to Shanghai | northeast | **232 deg SW** |
| CES6018, Colombo to Shanghai | northeast | **247 deg WSW** |

Both panels said *"from its track"* - the heading was derived, not reported - so
the track was the thing to look at.

### It was not reversed, it was the wrong flight

CSH832's track ran **Guangdong to the Gulf of Thailand**, ending **3.5 hours
before** the aircraft's own last report. CES6018's ended **6.7 hours** before it
and 500 km away. Those are the *outbound* legs of the same journeys: the
aircraft flew down, turned around, and is on its way back, and we were drawing
the trip it had already finished. A heading taken from the last two points of
that is the reverse of where it is going, which is exactly what showed on
screen.

**Nothing about the data was malformed, which is why it got this far.** It is a
real track, of a real flight, by this airframe. It is simply not the one being
watched. Asked for "this aircraft's track", the provider answers with the most
recent one it holds, and after a turnaround that is the previous leg.

### The measurement that set the threshold

Across nine aircraft: **eight ended within one minute** of the position, the
ninth at **134 minutes** and 518 km. Nothing in between. Two populations with a
wide gap, so the threshold only has to land in it - fifteen minutes.

Compared against the **aircraft's own last report**, not against the clock. An
aircraft nobody has heard from for an hour, with a track ending at that same
moment, is perfectly consistent; both are old together. The question is whether
the two describe the same moment, and a rule written against `now` would have
thrown away every track belonging to an aircraft that had gone quiet.

Four tests, checked by disabling the guard: the one naming the fault fails.

**856 backend tests**, 1,114 frontend.

## D197 - ConnectTimeout, and a retry that had to earn it

D195's fix worked and the log finally said what it had been hiding:

```
opensky failed this poll: token request failed: ConnectTimeout
```

**Not credentials, not quota, not our code.** London to Zurich, no TCP
connection inside twenty seconds - and intermittent: the same pod authenticated
happily from 17:50 to 17:59 and began failing at 18:02.

A single attempt turned that hiccup into the loss of every flight track, because
the token had expired, nothing else would ask for two minutes, and each poll
made one attempt and gave up. So the token request is asked three times with
half a second and two seconds between, and only for **transport** errors: a 400
from the auth server is an answer, and asking again more slowly does not improve
it.

### A false alarm in the same screenshot

The credit lines showed `last request cost 632`, `672`, `692` against a 4,000
daily allowance, which reads like the account being drained in an hour. It is a
reporting artifact. OpenSky returns a different rate-limit counter for different
endpoints and this code keeps one variable for all of them, so `remaining`
alternates between two series - about 2,970 and about 3,650 - and the "cost" is
the difference between two unrelated buckets. The real cost is the `4` on every
other line. Worth recording because the number is alarming and wrong, and
somebody will read it again.

### Two vacuous tests, one after the other

The retry test for refusals asserted that a 400 is not retried - and passed
against the mutation that retried everything, because **a 400 arrives as a
response, not an exception**, and never reaches the retry loop at all. It was
testing a path the change could not affect.

Rewritten to raise a non-transport error, it then failed against the *correct*
code, because `httpx.UnsupportedProtocol` **is** a `TransportError`. The premise
was wrong twice before the test discriminated anything.

The fix both times was to check rather than assume - the hierarchy printed, the
mutation run - and the standing rule earns its keep again: **a test that has not
been seen to fail is not yet evidence.**

**860 backend tests**, 1,114 frontend.

## D198 - A retry without a cooldown makes an outage worse

D197's retry deployed, and the log shows it doing exactly what it was told:

```
18:23:41  token request failed (ConnectTimeout), 2 attempt(s) left
18:24:01  token request failed (ConnectTimeout), 1 attempt(s) left
18:24:23  opensky failed this poll: token request failed: ConnectTimeout
```

**Three attempts across forty-two seconds, all failing.** Which settles
something the retry was built on: this is not a transient blip. The container
cannot reach OpenSky for minutes at a stretch.

And that makes the retry actively dangerous. Three attempts per caller, a poll
every two minutes, one per aircraft selected - against a host that is already
refusing. **If the reason it is refusing has anything to do with how often we
knock, knocking three times as hard is the opposite of a fix.** I added that
risk in D197 and should have added this in the same change.

So a failed round now buys five minutes of silence. Raised as a failure rather
than returned as `None`, because `None` from `_get_token` means "running without
credentials" - a supported mode - and a cooldown quietly becoming anonymous
requests is a different bug wearing the same clothes.

### A test deleted rather than fixed

`test_a_success_clears_the_cooldown` set the field to zero, called, and asserted
it was zero. It passed against a build with the clearing removed.

Thinking about why exposed something better: **clearing it has no observable
behaviour at all.** A cooldown whose deadline has passed blocks nothing, so the
assignment is tidiness and no test can catch its absence. The test was deleted
and a comment left in its place, because the alternative - contorting it until
it went red - would have produced a test that looked like evidence and was not.

Three tests remain, and the one that names the property fails when the cooldown
is ignored.

**863 backend tests**, 1,114 frontend.

## D199 - Half the aircraft have no route, and that is the answer

Phone checked forty flights: about half showed a route and about half showed
nothing. *"This is getting out of hand."*

Measured across 28 aircraft aloft:

| | Count | What they are |
|---|---|---|
| Route published | 18 | CLX245, AAL123, THY169, UAL820, SIA23, ANA203, KLM219 - airlines, every one |
| No route | 10 | **N926NA, PRPCH, N125GH, N840MA** (registrations), **BTX1A, NJE926F, QQE709** (business jets), and two transmitting no callsign at all |

**Not a bug, and not even a gap.** A community route database lists scheduled
airline services. A private aircraft has no published schedule to be listed in,
and roughly a third of what is in the sky at any moment is general aviation,
business and cargo. D88 measured adsbdb answering 14 of 20 - 70% - and this is
that number seen from the other side.

The provider tracks were checked at the same time and are healthy: 21 of 22
`provider`, 48 to 500 points, none stale. The staleness guard from D196 is not
over-firing.

### The interface was the thing at fault

The section was rendered only when a route existed, so for those ten it simply
was not there - and a reader who had just seen a route on the previous aircraft
reasonably concluded the application had broken. **Silence reads as a defect
even when it is a fact.**

It now says which of two things happened, because they are different and should
not be dressed as the same one:

- **no callsign transmitted** - nothing was ever looked up;
- **a callsign with nothing published against it** - it was looked up, by name,
  and there is no route.

Four tests, one of them asserting the wording never calls this an error or a
failure. A private aircraft without a published schedule is the world working
correctly, and describing it as a fault would make the map look broken for a
third of everything it draws.

836 backend tests, **1,118 frontend**.

## D200 - The endpoint that did not exist

Phone, on being told adsb.lol could fill OpenSky's gap: *"I thought we built our
union with adsb.lol and opensky merged already."*

Right, and the correction is smaller and more embarrassing than the answer I was
giving. `UnionProvider.fetch_track` has always looped over **both** providers.
adsb.lol is the primary and is asked *first*. It answered `None` every time,
because it inherits the base class default and never implemented the method -
and the union's own docstring explained why:

> Only OpenSky offers flight history (D78); adsb.lol has no equivalent endpoint.

**True of `api.adsb.lol`, wrong about the project.** The traces are published by
the *map server*, `globe.adsb.lol`, in readsb's own format: one gzipped file per
aircraft, sharded by the last two characters of the hex. D78 evaluated the API,
concluded correctly, and the conclusion outlived the fact by eight decisions -
including an hour today where I proposed adding "a new provider" to a slot that
had been sitting empty and waiting the whole time.

### Why it matters where it matters

| Region | OpenSky track | adsb.lol trace |
|---|---|---|
| Europe | 8 of 8 | - |
| North America | 8 of 8 | - |
| **South-east Asia** | **3 of 8** | **10 of 10** |

OpenSky is a community receiver network and its receivers are in Europe and
North America. Over Thailand - where this project is written and used - most
aircraft have no OpenSky track at all. Measured on three that failed: one with
no track, one that fell back to 12 observed points, one with a 6-point provider
track. All three have **92-point traces** here.

### Three details that would each have been silently wrong

- **Feet, not metres.** OpenSky's `baro_altitude` is already metric; this feed
  is imperial. Unconverted, a cruising airliner sits at 41,000 *metres* - above
  the Karman line, on a map that also draws satellites.
- **The last two hex characters**, not the first. Getting it backwards is a 404
  for every aircraft rather than a visible error.
- **Not behind the poll gate.** That gate spaces requests to `api.adsb.lol`
  twelve seconds apart. A trace is a static file on another host fetched when a
  reader selects an aircraft; behind the gate it would miss the three-second
  budget (D181) every time and never arrive.

Each is asserted by a test, and each test was checked by making the mistake.

### On the environment variable Phone asked about

**No key is needed.** The traces are static files and adsb.lol's API is
currently keyless - they intend to require one eventually, obtainable by feeding
data back. What was added is `ORBITAL_ADSBLOL_TRACE_BASE_URL`, because the
traces live on a different host from the API and because emptying it is the off
switch.

Licence is unchanged and already satisfied: ODbL, the same feed this project
already takes positions from and already credits in `aboutFacts.ts`.

Ten tests. Verified against the live service, not only a fixture: 92 points
each, altitudes 7,498-12,504 m.

**873 backend tests**, 1,118 frontend.

## D201 - The whole flight, not the last half hour

D200 wired adsb.lol's traces in and used `trace_recent`: 4 kB against 89 kB, and
the smaller file looked like the polite choice. Phone looked at four aircraft
and said the routes still did not work.

They did work - the four paths were correct, pointed the right way, and the one
that rendered as a dashed line was `routeFeatures` honestly marking an 86-minute
coverage hole where nobody heard SIA23 cross the Bay of Bengal. **They were just
short**: half an hour of flying where Flightradar shows the journey.

So the full trace, trimmed. Measured live afterwards:

| | Before | After |
|---|---|---|
| SIA23 (JFK-SIN) | 92 pts, 2.0 h | **1,445 pts, 14.8 h** |
| THA662 (BKK-PVG) | 92 pts, 0.4 h | 379 pts, 1.4 h |
| CCA868 (JNB-SZX) | 92 pts | 350 pts, 14.4 h |

### Trimming, because a day of trace is several flights

Drawn whole it is the D196 fault with more points: a confident line along a
journey the aircraft finished hours ago.

**The ground is the boundary.** readsb writes `"ground"` instead of an altitude
when an aircraft is on a runway or a stand, so everything after the last of
those is this flight - a definition with no threshold in it that cannot drift.

Where a trace never touches the ground - a long-haul still airborne, one that
begins mid-ocean - the fallback is the longest silence over three hours. That
number has to sit above a coverage hole and below a turnaround, and SIA23's
86-minute crossing is the measurement that says where: a gap in listening is one
flight, not two. **A guess where the ground is a fact**, which is why it is
second and not first.

An aircraft on the ground *now* keeps its whole path rather than being trimmed
to nothing - erasing the line at the moment of landing would be the worst time
to do it.

Seven tests, checked by breaking it twice: ignoring ground contact fails two,
and setting the break threshold to a minute turns SIA23's coverage hole into a
new flight and fails the two that say it must not.

An accidental confirmation worth keeping: **CCA868's trimmed path starts at
1,600 m**, because Johannesburg is 1,753 m above the sea. The ground detection
is finding real runways.

**880 backend tests**, 1,118 frontend.

## D202 - Time could not tell a coverage hole from a previous flight

Phone: *"I dont even see their route lines anymore."* SIA23's panel said **"Not
enough observations yet to draw a path"** while the provider was returning
**1,445 points** for it.

D196's guard rejected any provider track ending more than fifteen minutes before
the aircraft's own position, on the reasoning that such a track belonged to a
previous leg. That was right about CSH832 and wrong about the sea.

| | Gap | Distance | Implied speed |
|---|---|---|---|
| SIA23 - **wrongly rejected** | 99 min | 1,441 km | **874 km/h** |
| THA662 - accepted | 15 min | 202 km | 822 km/h |
| CSH832 - the real fault (D196) | 3.5 h | 45 km | **13 km/h** |

**The third column is the whole answer.** An aircraft crossing the Andaman Sea
goes unheard for an hour and a half and its track ends where the receivers did;
an aircraft that landed, sat on a stand and departed again leaves a track ending
near where it now is, hours later. Time is identical in shape between those two.
Speed is not: 874 km/h is a cruise, 13 km/h is an aircraft that stopped.

So a long gap is now a **question** rather than an answer. It is asked whether
the aircraft could have flown from the end of the track to where it is, and the
track is kept when it could. The band is 250 to 1,200 km/h - wide on purpose,
because it is not identifying an aircraft type, only separating "flew there"
from "went somewhere else and came back".

D196 was written from one example and generalised from it. Both examples were
available; I only had one, and the guard I built fit it exactly. **The
measurement that would have prevented this is the same one that fixed it** -
distance over time, which took two minutes to compute once there was a second
case to compare against.

Two tests, checked by breaking it both ways: rejecting on time alone fails the
crossing, and removing the guard fails the previous leg.

**881 backend tests**, 1,118 frontend.

## D203 - The circle was a question the track could already answer

Phone, on a screenshot of SIA23 with its full 1,445-point path from JFK drawn
behind it: *"okay path is showing up for this flight, why is it circle?"*

Because the legend is honest: a disc means the heading is unknown. That report
carried no callsign, no ground speed and no heading - a sparse position, which
happens - so the marker had no direction to point.

**And a 1,445-point track was sitting beside it saying exactly which way the
aircraft was going.** The last two points are 37 seconds apart and unambiguous.

### The decision this was waiting for

The correction blocks were guarded on `detail.heading is not None`: they only
ever *corrected* a reported value, never *supplied* a missing one. That was
deliberate, and the test said so:

> Unknown is a value (D18, D40). Filling it would change what the legend's
> "heading unknown" disc means, **which is a separate decision**.

That decision arrived tonight, in the form of a question about a circle. Taken:
where the aircraft reports nothing and the track can measure it, the track
answers, marked `derived` in meta exactly as a correction is.

**The disc keeps its meaning and gets a smaller, truer set.** It now says the
aircraft did not report a heading *and* no track could supply one - a single
waypoint, or none at all. Nothing is invented: a track that cannot measure a
direction still leaves it unknown, and that has its own test.

Both old tests were rewritten to record the reversal rather than deleted, so the
next reader finds the decision rather than its absence.

### Two of my own fixtures were nonsense

The tests I wrote first put an aircraft 55 km east in 30 seconds - **1,853 m/s**
- and `speed_from_track` rightly refused to believe it, which is the check
working. Fixed to a realistic 278 m/s. Worth noting because the tests failed for
the right reason and I nearly read it as a fault in the change.

Four tests, checked both ways: reverting to correct-only fails four, and
supplying over a good reported heading fails three.

**885 backend tests**, 1,118 frontend.

## D204/D205 - A turnaround is a gap the aircraft did not fly across

Phone put RLH5046 side by side with Flightradar. Flightradar drew one path from
Phu Quoc north into Vietnam. Orbital drew a **triangle** and said *"Departed Cat
Bi International Airport, 574 positions, spanning 16h 33m"* - four legs stitched
into one.

### First fault: the boundary was the wrong one (D204)

D201 trimmed to the last ground contact. RLH5046's trace held 19 ground points
and **all of them were at the start** - adsb.lol heard it leave Cat Bi sixteen
hours earlier and never heard it on a stand again, because it landed at airports
with no receiver nearby. Everything after that is four flights.

A flight begins at whichever came last: wheels leaving a runway, **or** the
aircraft reappearing after a silence. Not the first boundary found.

### Second fault: duration cannot recognise a turnaround (D205)

With the latest-boundary rule, RLH5046 came right and **SIA23 broke** - 1,445
points from JFK became 333 from somewhere over India, because a fourteen-hour
flight contains ocean crossings longer than the three-hour threshold.

The two are indistinguishable by duration and obvious by displacement:

| | Gap | Distance | Speed |
|---|---|---|---|
| RLH5046 turnaround | 224 min | 16 km | **4 km/h** |
| RLH5046 turnaround | 671 min | 64 km | **6 km/h** |
| SIA23 ocean crossing | 195 min | 3,533 km | **1,088 km/h** |
| SIA23 ocean crossing | 223 min | 3,529 km | **949 km/h** |
| SIA23 **at JFK** | 199 min | **0 km** | **0 km/h** |

**A turnaround is a gap the aircraft did not fly across.** The last row is the
proof of the rule: the same trace holds a three-hour gap of zero kilometres,
which is exactly where this flight began.

This is D202's insight one level down, and I did not carry it across when I
wrote D201 - three hours later, on the same night, having just used displacement
to solve the same shape of problem.

### Where it lands

| | Points | Origin |
|---|---|---|
| SIA23 | 1,445, 14.8 h | **KJFK** |
| THA662 | 535, 1.8 h | VTBS |
| RLH5046 | 90, 0.4 h | *(in flight)* - honest: adsb.lol heard no more |
| CCA868 | 426, 11.1 h | *(in flight)* |

RLH5046 keeps only what was actually heard and refuses to name a departure
airport for a track beginning at 9,449 m, which is the right answer even though
Flightradar - with more receivers - can draw more.

Two tests, checked both ways: splitting on duration alone breaks the ocean
crossing, and never splitting on a gap breaks the turnaround.

**887 backend tests**, 1,118 frontend.

## D206 - A stop is time the aircraft cannot account for

Phone, mid-audit: *"and this plane is having two tracks."* TAX231 drew Bangkok
to Delhi and back as one line, and the panel named Don Mueang as the departure
point of an aircraft that was arriving at Don Mueang.

I had finished sweeping four bounding boxes an hour earlier and found nothing.
The sweep only looked for tracks that were *wrong*; it never asked whether a
track was two.

### The ratio hid the shape of the gap

D205's rule was displacement over duration, against a 100 km/h ceiling. The
Delhi turnaround came out at 122 km/h and was read as flight.

The trace says why. adsb.lol lost TAX231 400 km short of Delhi on the way in and
did not hear it again until it was 400 km out on the way home, so the two points
either side of a 197-minute stop stood 402 km apart. Averaged over the gap that
is 122 km/h. It is not a speed the aircraft ever flew: it is thirty minutes of
flying and 167 minutes of sitting still, averaged together into a number that
resembles neither.

**Credit the aircraft a fast cruise, ask how much flying the distance could pay
for, and weigh what is left over.**

| | Silence | Distance | Flight it buys | Unexplained |
|---|---|---|---|---|
| TAX231 at Delhi | 197 min | 402 km | 30 min | **167 min** |
| AXM104 | 223 min | 467 km | 35 min | **188 min** |
| HVN430 | 401 min | 1,486 km | 111 min | **289 min** |
| SIA23 crossing the Bay | 99 min | 1,441 km | 108 min | **0 min** |

The last row is the rule's own proof: the distance alone needs longer than the
silence lasted, so there is nothing to explain and nothing to cut.

An hour is the threshold, and it is set against the one thing that imitates a
stand while still flying - a holding pattern, which circles and so covers no
ground. Holds run to twenty minutes and occasionally forty.

### Second fault: an hour is too long when the aircraft is on approach

AIC1MQ turned round at Trivandrum in fifty-six minutes. Its trace holds no
ground reading there at all - adsb.lol last heard it descending through 175 m
and next heard it climbing through 495 m. Four minutes under the threshold, and
Delhi to Trivandrum and back was drawn as one line.

A 1,000 m ceiling with a twenty-minute rule fixed AIC1MQ and missed VOE9CM,
which went quiet at Figari through 1,882 m and came back through 1,326 m, one
minute under the hour.

Raising the ceiling on its own is not safe: an aircraft can cruise at 2,500 m
and a helicopter can sit at 300 m all morning. But **no hold ends by descending
and resumes by climbing**, and that shape is in the data:

| | Descent into the silence | Climb out of it |
|---|---|---|
| AIC1MQ at Trivandrum | 434 m | 2,819 m |
| VOE9CM at Figari | 1,326 m | 1,958 m |
| VOE9CM at Lille | 533 m | 1,753 m |
| AIC1MQ at Hyderabad | 846 m | 1,745 m |

Every real turnaround measured clears 150 m several times over. So: below
3,000 m, descending in and climbing out, twenty minutes of stillness is a
landing - whatever the trace failed to say about the ground.

### Two more, found by sweeping rather than by reasoning

**Distance is now haversine.** The old function called itself great-circle and
was equirectangular. Flattening the earth under-reports distance, which credits
an aircraft with less flying than it did - the direction that turns a real
crossing into a stop.

**GFA112 had been parked at Bahrain for two hours.** Its most recent reading was
ground, so the boundary was the final point, the tail was empty, and the
fallback that protects an aircraft on short final handed back the whole
twenty-hour trace. Being on a stand is not being about to touch down: a trailing
run of ground readings ends the previous flight rather than beginning the next,
so the search now starts in front of it. GFA112 became Dammam to Bahrain, 81 km.

### Two of my own tests were vacuous, again

Mutation-testing every threshold caught both. `test_level_flight_either_side...`
passed against code with the profile check deleted - its fixture's points were
ten minutes apart, so the three-minute window saw *nothing* rather than seeing
level flight, and returned None either way. And no test pinned the 3,000 m
ceiling at all; it passed at 1,000 m, the value that had just been shown wrong.

Every threshold in the function now fails a test when moved.

### Where it lands

| | Before | After |
|---|---|---|
| TAX231 | 838 pts, both legs | 347 pts, Lucknow to Bangkok |
| AIC1MQ | 1,078 pts, Delhi and back | 90 pts, one leg |
| VOE9CM | Lille to Corsica to Paris | 360 pts, Figari to Paris |
| GFA112 | 1,803 pts, 20 h | 90 pts, Dammam to Bahrain |

**142 live traces across twelve regions: none doubles back.** The thirteen very
short ones are aircraft that took off two to nine minutes ago, where the last
ground reading is minutes old and a short track is the truth.

**895 backend tests**, 1,118 frontend.

## D207 - The retry was built for a blip, and this is an outage

Phone sent the Northflank log filtered to `opensky`: 289 lines, all failures,
`token request failed (ConnectTimeout)` over and over for the best part of an
hour.

### What is actually wrong, and where it is not

Measured rather than assumed:

| | From this machine | From the London container |
|---|---|---|
| `auth.opensky-network.org` | connects in 0.23 s, answers 401 | ConnectTimeout, every attempt, for hours |
| `opensky-network.org/api` | connects in 0.23 s, answers 200 | never reached, the token gates it |
| `api.adsb.lol` | fine | fine, 38 polls, 0 failures |

**Both OpenSky hostnames resolve to the same address, 194.209.200.34.** So this
is not an auth problem with an API-shaped workaround behind it: the whole of
OpenSky is unreachable from that egress while adsb.lol on the same egress is
not. No code change reaches a host the network cannot reach, and there is no
anonymous fallback to reach for, because anonymous requests go to the same IP.

Also worth stating plainly: **nothing is broken for a reader.** The union
degrades exactly as designed, the global job reports 38 successes and 0
failures, and 7,954 aircraft are on the map from adsb.lol alone. What is lost is
the supplementary coverage OpenSky adds where adsb.lol has no receivers.

### What was fixable, and was

The retry (D197) and the cooldown (D198) were both written for a *transient*
failure, and both are still right for one. Against a permanent one they were
costing real time and burying the log.

**A handshake gets five seconds, not twenty.** The client timeout is the budget
for a slow answer and twenty seconds is right for that. It is the wrong budget
for a connection that is never coming up: three attempts at twenty seconds is
sixty-two seconds of every two-minute cycle spent holding a socket open to a
host that is not there. The working handshake takes 0.23 s, so five seconds is
twenty times the observed cost of success.

**Each failed round waits twice as long as the last, to an hour.** A fixed five
minutes is a blip's pause; against a host down for a day it is knocking every
six minutes until midnight. A real blip still costs one round.

**A sustained failure is logged once, then every half hour.** 289 identical
lines is how a second, different fault gets missed. The union now warns on the
first failure, on any change of message, and every thirty minutes while it
persists, and says so when the provider answers again.

### Where that leaves the deployment

The noise and the waste are fixed. The unreachability is not, and cannot be
from here. Three real options, in Phone's hands:

- Leave it. The map is complete from adsb.lol; the log is quiet now.
- Set `ORBITAL_PROVIDER=adsblol` on Northflank. Identical data today, no waste
  at all, and the union is one environment variable away when it is wanted.
- The Render move Phone already intended. Different egress, and it may simply
  work; there is no way to know from here without trying it.

Four tests, each checked against the behaviour it replaced: the connect budget,
the escalation, the reset on recovery, and that the quieter log still lets a
*different* failure through.

**902 backend tests**, 1,118 frontend.

## D208 - A second aerial network, and the ceiling that decides what it is worth

With OpenSky unreachable from anywhere this deploys (D207), the union's
supplement slot was empty. Phone asked what could fill it.

### What exists, measured rather than listed

Seven circles of 250 nm, against adsb.lol, on 2026-09-14:

| | adsb.lol | adsb.fi | adsb.fi only |
|---|---|---|---|
| western Europe | 590 | 594 | 13 |
| eastern United States | 1,110 | 1,121 | 29 |
| south-east Asia | 27 | 27 | 1 |
| **Myanmar** | **1** | **7** | **7** |
| inland China | 0 | 0 | 0 |
| South America | 10 | 10 | 0 |
| Africa | 0 | 0 | 0 |
| **total** | **1,738** | | **50, about 3%** |

Three per cent, and the reason is `sdr-enthusiasts/docker-adsb-ultrafeeder`:
one container, one aerial, feeding adsb.lol, adsb.fi, airplanes.live,
ADSBExchange and four others simultaneously. **The community aggregators are
largely the same volunteers seen through different front doors.** That is the
finding, and it is why no aggregator swap replaces OpenSky, whose value came
from being a different network of receivers entirely.

The row that earns the work is Myanmar: one against seven.

The others were checked and are not available. `airplanes.live` answers a
stranger with a 403 whose body is an instruction to email them. `api.adsb.one`
is behind a Cloudflare 403. ADSBExchange answers `402 Please purchase a key`.
`theairtraffic` has no public endpoint responding.

### The ceiling, which changed the answer

All three usable feeds run the same software, so `AdsbLolProvider` was
parameterised on the three things that actually differ - the path, the key the
array arrives under, and the label in an error - and adsb.fi became a subclass
of about thirty lines.

Then a live call found what none of the unit tests could: **adsb.fi answers a
250 nm circle and 400s on 500 and everything above.** Measured, not assumed;
the 250 came originally from ADSB One's README and turned out to be right for a
different reason.

That matters more than the coverage table. The global tier sweeps with four
circles of 6,000 nm, so adsb.fi cannot participate in it at all. Covering the
planet in 250 nm circles is hundreds of requests against a feed that
rate-limits at a burst of three.

**So adsb.fi is not the thing OpenSky was.** OpenSky answered the whole world in
one call. adsb.fi supplements the viewport tier and sits the global sweep out,
returning an empty list rather than four failures - empty rather than raised,
because a feed behaving exactly as documented is not a fault to log every poll.

The union would have swallowed those four 400s by design and reported nothing
but one warning line, so this would have shipped as a supplement that looked
configured in the environment and contributed zero. That is the second time in
two decisions that a silent degradation was the real bug.

### Where it lands

`ORBITAL_UNION_SUPPLEMENT` picks the second feed: `adsbfi` by default because
it is the one that works where this deploys, `opensky` still correct on a
laptop, `airplaneslive` waiting on an email. An unknown name is refused by name
rather than falling back, because a typo in a deployment variable that silently
picks a different feed is invisible until somebody counts aircraft.

**915 backend tests**, 1,118 frontend.

## D190 - Plate carree was never the wall, it was a transformation

`bodies.ts` had said for months that Venus could not be entered: it has a
complete Magellan radar map, "just not one served as Mercator tiles here". That
was the right measurement and the wrong conclusion.

MapLibre's raster sources speak one tiling scheme, Web Mercator, where `z0` is
a single tile. NASA's Solar System Treks publish in plate carree, where `z0` is
two tiles wide and one tall. So for a year the answer to "which worlds can be
entered" was whatever OpenPlanetaryMap happened to publish in Mercator -
Mercury, the Moon and Mars - and everything else was written off (D120).

Two measurements turned it around:

- Trek serves global mosaics for **Venus, Ceres, Vesta, Io, Europa, Ganymede,
  Titan, Enceladus and Phobos**, and its tiles come back with
  `Access-Control-Allow-Origin: *`. The pixels can be fetched, redrawn and
  handed to MapLibre with no proxy and nothing on the backend.
- The two projections are **identical in longitude**. Both are linear in it.
  So this is not a general warp; it is one axis, and one axis can be done a
  destination row at a time with `drawImage`.

`planet/plateCarree.ts` is a `maplibregl.addProtocol` handler. MapLibre asks
for `pc://venus/{z}/{x}/{y}`; the handler works out which plate carree tiles
lie under that Mercator tile, stitches them, and squeezes the latitude axis 256
rows at a time. The source level is `z - 1`, which makes the horizontal pixel
sizes match exactly - any other choice either discards pixels the mosaic has or
invents pixels it does not.

Three things the arithmetic had to be told rather than allowed to assume:

- **Trek uses both longitude conventions.** Venus and Mercury run -180..180;
  Titan and Enceladus run 0..360. Reading one as the other does not fail, it
  silently serves the far side of the world.
- **A tile can straddle the grid's seam**, and when it does the right edge
  comes back to the left of the left edge. Carried round rather than clamped.
- **A mosaic need not reach its own poles.** Magellan looked left from a polar
  orbit and filled neither cap, so rows above 84 north and below 80 south are
  left transparent rather than stretching the last row of real pixels across
  them. The picker says so on the row.

Venus is the first world through, and the one that mattered: it is the last
**planet** with ground to stand on. The gas giants stay refused, and that
refusal is not a limitation of ours - there is no surface to map, and calling
physics a gap would be the dishonest half of D120. The other nine worlds are
reachable behind the same handler and are not wired up: adding a moon is a
decision about the picker, not about projections.

Deepest level probed by walking levels until the server returned 404, not
divided out of the stated resolution - the two disagree often enough that the
arithmetic is a hypothesis and the 404 is the answer. Venus stops at level 10,
so `maxZoom` is 11, three levels deeper than Mars.

## D191 - Two rules for one question, and Brazil was on Mars

Venus arrived with a mosaic eleven levels deep, and at zoom 9 it was sandy
brown with dune fields in it. Venus is grey. What was on screen was the Sahara.

`visibilityFor` had always been right: Earth has two imagery tiers that
cross-fade, every other world has one mosaic, so the near tier - which is
pointed at Earth's Esri tiles and always will be - stays off anywhere else.

The basemap toggle had a second rule. `setImageryVisible` turned **both** tiers
on whenever the reader had imagery chosen, knew nothing about which world was
underneath, and ran after the body plan, so it undid it every time. Above zoom
7, where the near tier finishes fading in, every non-Earth world was served
Earth's imagery with its own correct mosaic still loaded underneath.

**This was live, and it was not new.** Checked on Mars before it was fixed:
farmland and forest in Brazil, captioned "Mars - surface imagery". Mercury hid
it for a year by accident, because its mosaic stops at zoom 5 and the near
tier's opacity ramp has not begun there; Mars reaches 8 and nobody had looked.
It took a world with eleven levels to make it obvious.

The fix is that there is now one rule, `imageryVisibility`, and both callers
read it. The test that pins it asserts the two plans agree, which is the
disagreement itself rather than either of its symptoms - and it fails when the
near tier is let back on.

This is the same shape as D133 and D182 one more time: a layer drawn where its
subject does not exist is a stronger false claim than one drawn late, and the
way it gets there is two places deciding one thing.

**1,140 frontend tests**, 915 backend.

## D192 - The reprojection reaches nine worlds; the product wants one

D190 built the plate carree handler and wired Venus through it. The obvious
next move was the rest of what Trek serves, and it was made: **Phobos, Ceres,
Vesta, Io, Europa, Ganymede, Enceladus and Titan**, each a controlled
photomosaic rather than a shaded-relief product, each `maxLevel` walked to its
own 404. It worked. It is also reverted, on Phone's call, and the reason is
worth keeping rather than the code.

**Eighteen rows is a different product.** Orbital shows the solar system's
planets, the Sun and the Moon. A picker listing Vesta and Enceladus is a
catalogue of everything with a mosaic behind it, which is a defensible thing to
build and not this one. The nine are one `Mosaic` entry and one `BODIES` entry
each if that ever changes.

Three things the attempt is worth recording for:

**D140's one-way door reopened, and the eighteen-row list was what opened it.**
`solarOrigin()` reads `body === 'moon' ? 'earth' : body` and casts the result to
`PlanetId`. That is correct while every body is a planet, the Sun or the Moon,
and it throws on `ELEMENTS['phobos']` the moment it is not - on the *first step*
of every trip that starts at such a world, before the swap, so the picker went
quiet. The cast is a claim the type system cannot check, and the comment on it
now says so. Anything added to `BODIES` that `planets.ts` has no elements for
needs that function rewritten, not just a new entry.

**Trek publishes two longitude conventions and does not say which in the tile
path.** Venus and Mercury run -180..180; Titan and Enceladus run 0..360.
Reading one as the other does not fail, it serves the far side of the world.
`Mosaic.lonOrigin` stays a field rather than an assumption even with one mosaic
in the table, because the next one to be added will be a coin toss.

**Trek's top hits are not its photomosaics.** The first Phobos layers returned
are 2ppd HRSC *shade* and *slope* products, which look like imagery until you
notice the craters are lit from a direction no spacecraft was ever in. The
Viking photomosaic is five levels deeper and further down the list.

### The corner, which stays

The picker, Sign in and About sat at the far right of the header, sharing that
corner with the basemap and night toggles, the diagnostics panel and the promo
card - four things from four parts of the app, overlapping. They are the
wordmark's controls, so they moved under the wordmark as one left-aligned
column, and the list opens to the right rather than down into the map.

A wrapper element rather than a `top` offset on the links: their vertical
position then follows the brand's own height instead of a number written here
that goes stale the first time the mark is resized. D190's rule survives,
because the column is left-aligned and the subtitle's width no longer reaches
them.

Two consequences that were not free:

- **D127's hover bridge had to move with it.** It bridged the gap above the
  panel; the gap is now to its left, and leaving the bridge where it was would
  have reintroduced exactly the bug D127 exists for.
- **The header's `z-index: 2` was not enough.** The list's own `z-index: 20`
  only ever competed inside the header's stacking context, and at 2 the header
  lost to the legend - which is later in the document and drew over the bottom
  of the list. The header is 3 now: above the panels that share the map's
  edges, below the pages that cover it.

**1,141 frontend tests**, 915 backend.

## D193 - You were never landing on Mars either

The four outer planets were refused on the grounds that there is nothing to
stand on, which is true and was answering a question nobody asked. Choosing
Mars does not land anybody: it makes Mars the globe, and you turn it. Phone's
correction was exact - *"we are not going to land technically"* - and once the
question is "can this be the globe" rather than "can this be stood on", the
only blocker left is imagery.

### Why these four needed a different kind of source

Nobody publishes a controlled mosaic of a gas giant, and the reason is not
neglect. A mosaic ties features to fixed ground; on Jupiter the features move -
its equator rotates about five minutes faster than its mid-latitudes, which is
why there are two rotation systems for it. Any map of it is a snapshot at an
instant.

Measured, in this order:

- **Trek has nothing.** 404 for all four, where it has nine other worlds.
- **Wikimedia has Jupiter** (Cassini's December 2000 cylindrical map, public
  domain) and nothing usable for the other three.
- **Solar System Scope has all four**, CC BY 4.0, derived from NASA imagery -
  and serves them with **no `Access-Control-Allow-Origin` header at all**. So
  does NASA's own photojournal, and so does nasa3d. A canvas cannot read what
  the browser will not hand over, so the reprojection cannot use any of them
  from a remote fetch.

The answer was that we do not have to fetch them remotely.
`scripts/fetch-cloud-textures.mjs` pulls the four plates into
`public/textures/` at build time, the same shape as `copy-textures.mjs` and
under the same rule about not committing binaries (D30). Same origin, so CORS
never arises, and the app stops depending on a third party being up while
somebody is looking at Saturn.

`plateCarree.ts` grew a second source shape for it. A Trek mosaic is a pyramid
of 256px tiles; a plate is one image at one size. Both reduce to the same
thing - a rectangle of source pixels to stitch and squeeze - so `Patch` now
carries a url and a destination rect instead of a grid address, and the tile
branch is the one that computes rows and columns. `sourceLevel` returns 0 for a
plate, because there is only ever one.

### The label was the actual work

Giving Jupiter a `surface` made it enterable everywhere at once, and that was
the dangerous part rather than the useful one. `isLandable` was the same
question as "has imagery" while every world with imagery had ground under it,
and became a false claim the moment one did not. It is `canEnter` now, with
`standsOnGround` beside it for the wording, and the two are asked separately:

- the **picker** enables on `canEnter` and prints the radius only for ground,
  keeping `No solid surface — cloud all the way down` on the row for the four;
- the **solar index** says `Cloud tops` rather than `Surface imagery`;
- the **caption** offers `Visit Jupiter` and puts `cloud tops, no surface` in
  the eyebrow, because the button alone would quietly promise ground;
- the **wordmark subtitle** and the **status line** stopped being the constant
  `surface imagery` for every world that is not Earth - true of all of them
  until it was not.

`surface.shows` and `surface.epoch` carry it in the data. Viking's Mars is the
same Mars; Cassini's Jupiter is not the same Jupiter, and the Great Red Spot
has lost about a third of its width since.

### Neptune was drawn with Uranus's plate

Caught in the pixels, not by a test: Neptune rendered pale cyan, and Neptune is
deep blue. The plates were right - measured, `rgb(54,79,167)` against
`rgb(155,202,209)` - so the app was serving the wrong one.

`applyBody` decides whether to tear down and rebuild the imagery source by
comparing its **attribution**, which has been a correct proxy for "this is a
different world" for as long as every world had a distinct credit. Uranus and
Neptune are both Voyager 2 and carry the same string, so the source was left
alone and Neptune inherited the plate already in it.

The credit is now a second reason to rebuild rather than the only one; the
tiles are the thing that actually has to change. `sameImagery` exposes the rule
so it can be checked without a map, and the test that guards it asserts no two
enterable worlds share a tile url - which is the property, rather than the one
pair that happened to break.

This is the third time in three decisions that a **proxy held until the set it
was standing in grew**: `body === 'moon' ? 'earth' : body`, one rule for the
imagery tiers in two places, and now attribution standing in for identity.

### What is honest about Uranus

Almost nothing is there. Voyager 2 found it essentially featureless in visible
light, and its plate is close to a smooth cyan gradient. It is included anyway,
at 2048 wide rather than 4096: the emptiness is the fact, and a larger file
would be more megabytes of the same gradient. Jupiter gets the 4096 plate
because it is the one with structure worth the levels.

**1,145 frontend tests**, 915 backend.

## D194 - Sixty times sharper and the wrong picture

Venus went in on the Magellan left-look plate at 75 m per pixel, which is the
highest-resolution imagery of any world in this app by a factor of thirty. It
looked wrong, and Phone said so: *"it looks not professional yet"*.

Three things were true of it at once. Magellan mapped in strips from a polar
orbit, so the plate carries its own **orbit seams** as black bands across every
view. Its coverage stops at 84 north and 80 south, so both **poles are holes**.
And synthetic aperture radar is **greyscale**, so the planet everybody has seen
in gold arrived the colour of a weather chart. A striped, capless, grey Venus
reads as a broken render rather than as a planet, whatever its resolution.

It is now `Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m`: the
synthesised global mosaic, colourised, complete to both poles, no seams. That
costs six levels of depth - `maxZoom` 11 down to 5, which is Mercury's - and
buys a world that looks like the one people have seen. Maxwell Montes and
Cleopatra are still legible at the new ceiling, checked rather than assumed.

**The better answer was available and was not taken.** Earth already has two
imagery tiers that cross-fade with zoom, which is exactly the shape of this
problem: the colourised mosaic as the far tier, the 75 m left-look as the near
one, and the complete plate showing through wherever the detailed one has a
hole. It is not built because making the near tier per-body means reopening
the rule D191 had just finished repairing, and that trade was not worth making
in the same sitting. It is the obvious next move if Venus ever needs the depth.

### `gap` became `caveat`

The field said "what the mosaic does not cover", and the new Venus covers
everything - so the most important thing about its imagery had nowhere to go.
That thing is not a hole: **it is radar**. Venus's surface has never been
photographed, because the cloud is opaque in visible light, and a golden globe
with nothing said about it invites exactly that mistake. Renamed for what it is
actually used for.

### Three tests were about a product, not about geometry

They asserted that rows above 84 north come back transparent, and they did it
against `MOSAICS.venus` - so a mosaic that reaches the poles broke three tests
that have nothing to do with Venus. They test a `CAPLESS` fixture now, and a
fourth was added asserting that a mosaic which *does* reach the poles covers
every row. The rule: a test about behaviour picks its own subject, and reaching
for the real one couples it to a choice that was always going to change.

`npm run clouds` is wired into `assets`, so `predev` and `prebuild` fetch the
gas giants' plates. A fresh clone no longer needs to be told.

**1,146 frontend tests**, 915 backend.

## D195 - The landing page ships as a path, not as a second deployment

The scroll-driven landing page had been built and was on one machine only.
`/scrollcraft/` is ignored in full, so the commit that deployed every planet
contained not one byte of it: nothing to deploy, and nothing in the submission
either.

The obvious move is a second Vercel project, and it is the wrong one. It buys
a second dashboard, a second deploy to remember and a second domain, so the
page that exists to introduce the application would live at a different address
from it.

**It is a static directory, so it can simply be part of the build that already
happens.** Vite copies `public/` into `dist/` untransformed; Vercel serves what
is in `dist/`. `frontend/public/landing/index.html` therefore arrives at
`/landing` on the existing deployment with no configuration at all - no second
project, no `vercel.json`, no rewrite rule.

Two properties made that free rather than merely possible, and both were
checked rather than assumed:

- **The application routes by hash** (D153), so every page of it is at `/`.
  There is no history router to collide with and no SPA rewrite to carve an
  exemption out of. A sibling path is simply unoccupied.
- **The page has no root-absolute references.** Every `src` and `href` in it is
  relative - counted, not glanced at - so it runs at any depth unedited.

### The workspace is not the artefact

`scrollcraft/builds/orbital/` is 454 MB. The page inside it is 904 KB; the
other 453 MB is `lab/`, screenshots from the verification harness, beside a
brief, four shoot scripts and a `.env` holding a generation API key.

So `scripts/sync-landing.mjs` copies **twelve named files** rather than the
directory. A recursive copy with exclusions fails open: whatever is added to
that workspace later travels by default, and the one that would hurt is the
credential. An allowlist fails closed - a new plate has to be added to the list
deliberately, and nothing can arrive by accident.

It is deliberately **not** wired into `prebuild` beside the textures, though it
would be a harmless no-op on Vercel where the workspace does not exist. Run
locally it would overwrite `public/landing/` from the workspace on every build,
so an edit to the committed copy would vanish at the next `npm run dev` with no
message at all. The workspace is the source, the script is the publisher, and
publishing is a decision rather than a side effect of building.

### The binaries are a stated exception to D30

Eight WebP plates, 636 KB, are now committed - the first binaries in the
repository that a script cannot re-fetch. D30 keeps generated assets out of git
*because a script can fetch them again*: the Earth texture comes from
`node_modules`, the cloud tops from their publisher. These were generated once
through a paid image model and are not reproducible on demand, so the rule's
reason does not reach them. Recorded here rather than left to look like an
oversight.

**1,146 frontend tests**, 915 backend.
