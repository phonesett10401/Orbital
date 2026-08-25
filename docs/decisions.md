# Orbital — Design Decisions

A running record of every significant architectural choice and why it was made.
Newest entries are appended at the bottom. Each entry states the decision, the
alternatives considered, and the reasoning — so any team member can defend it.

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

**Revisit if:** phase 2 satellites at GEO altitude (≈5.6 Earth radii) prove
awkward under Globe.gl's radial altitude model, or if true altitude accuracy
becomes a requirement. Because the renderer only consumes the normalized shape,
swapping it is a frontend-local change.

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
compiler enforce it on the frontend side, and — the decisive point — when
phase 2 adds a satellite type, the compiler enumerates every place that needs
to handle it. In plain JavaScript that becomes a manual search.

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

**Implemented in M5**, after the single-tier path is proven. The poller is
designed in M2 to accommodate it.

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

## D19 — Phase 2 has exactly two footholds in phase 1

**Decision:** the `type` field and the provider registry are the only
concessions to satellites. No satellite provider, no `satellite.js` dependency,
no satellite type, no layer abstraction built "for later".

Speculative generality is the failure mode here: building a layer system before
there is a second layer produces an abstraction fitted to an imagined use case,
which then turns out to be the wrong shape when the real one arrives. The two
footholds are cheap and concrete; anything more is a guess.

`test_providers.py` contains a test asserting that no satellite provider is
registered. It is a tripwire against accidental scope creep, and it is deleted
when phase 1 is signed off.

---

## D20 — Localhost only; CORS is permissive and flagged

**Decision:** no Docker, no hosting, no deployment configuration. CORS allows
the Vite dev server origin.

Deployment is out of scope, and configuration for a deployment that will never
happen is waste. The permissive CORS setting is recorded here as the single
change point if the project is ever hosted, so it is not overlooked in a
security review.
