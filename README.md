# Orbital

Live aircraft, satellite and ship positions plotted on the Earth in the
browser. Rotate and zoom, search for a flight by callsign, an airport by name or
code, or a satellite by name or catalogue number, click one for its details, and
see the path it has been observed to fly.

**It is deployed:** <https://orbital-liveview.vercel.app>

The world is drawn with **MapLibre** on satellite imagery, as a globe when you
are far out and a street map when you are close in. A second renderer — a
three.js globe — existed alongside it during the migration and was deleted once
the map could do everything it did (D104).

**Three layers, one toggle**, and they are not the same kind of thing.
*Aircraft* and *ships* are **observed**: a feed reports where they are, and the
display is only ever as current as the last report. *Satellites* and the moon
are **computed**: published orbital elements and an ephemeris are propagated to
the instant you are looking, so those layers spend no quota, need no
credentials, and keep working for days if every upstream goes down.

There is also a solar-system view, reached from the globe, and **every planet
in it can be entered** — the globe becomes that world and you turn it. Mercury,
Venus, Earth, the Moon and Mars carry a controlled surface mosaic; Jupiter,
Saturn, Uranus and Neptune have no surface to map, so they carry their cloud
tops and the interface says so rather than calling weather a surface. Only the
Sun cannot be entered.

CSC480 team project.

---

## Where it runs

| | Host | Notes |
|---|---|---|
| Frontend | Vercel | Static Vite build. `VITE_API_BASE` points at the backend. |
| Backend | Northflank | `backend/Dockerfile`, one worker. Redeploys on a push to `main`. |

**One worker, deliberately.** The backend holds a websocket open to aisstream,
polls on a schedule and answers every request from memory, so a second worker
would open a second AIS socket, run its own poller and keep its own store — the
OpenSky bill would double and two requests could disagree about where an
aircraft is. Scale it by making the box bigger. The reasoning is in the
Dockerfile, next to the `--workers 1` it explains.

**A deployed backend needs two settings beyond the local ones:**
`ORBITAL_CORS_ORIGINS` must name the frontend's origin or every browser request
fails CORS, and `ORBITAL_ACCOUNTS_DB_PATH` should point at a mounted volume —
accounts are the one piece of state that does not rebuild itself after a
restart.

## The other worlds

MapLibre's raster sources speak one tiling scheme, Web Mercator, where `z0` is
a single tile. NASA's Solar System Treks publish in **plate carrée**, where
`z0` is two tiles wide and one tall, and for a long time that mismatch was
recorded as the reason only three worlds could be entered — the three
OpenPlanetaryMap happens to serve in Mercator.

It was a transformation, not a wall. `frontend/src/planet/plateCarree.ts`
registers a `pc://` protocol with MapLibre: asked for a Mercator tile, it
fetches the plate carrée tiles underneath, stitches them and squeezes the
latitude axis, one destination row at a time. Longitude needs no warping at
all — both projections are linear in it — so the whole job is one axis.

Two shapes of source go through it:

- **Trek tile pyramids**, fetched at runtime. Trek sends
  `Access-Control-Allow-Origin: *`, so the pixels can be redrawn in a canvas
  with no proxy and nothing on the backend. Venus arrives this way.
- **Single equirectangular plates**, for the four worlds with no surface.
  Every host of those refuses CORS, so they are downloaded into
  `frontend/public/textures/` at build time instead and served from our own
  origin. `npm run clouds` does it, and `prebuild` runs it for you.

Ceres, Vesta, Io, Europa, Ganymede, Titan, Enceladus and Phobos are reachable
through the same protocol and are deliberately not wired up: this is a list of
the solar system's planets, not a catalogue of everything with a mosaic behind
it.

## Running it locally

Two processes: a FastAPI backend and a Vite dev server.

**Backend**

```bash
cd backend && python -m venv .venv && .venv/Scripts/python -m pip install -e ".[dev]"
```

```bash
cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000
```

It starts with the **fixture provider** by default, which replays 157 committed
synthetic aircraft and animates them. No credentials, no network, no API quota
spent. Interactive API docs are at http://127.0.0.1:8000/docs.

**Frontend**

```bash
cd frontend && npm install && npm run dev
```

Then open http://localhost:5173. The dev server proxies `/api` to the backend,
so the browser sees a single origin.

`npm run dev` first runs `npm run assets`, which copies the night-lights
texture and reduces the airline dataset out of `node_modules` into `public/`.
Those directories are generated rather than committed.

**The map fetches basemap tiles**, so the frontend is not offline — the backend
still is, on the fixture provider. Four more textures and a geography pipeline
were dropped along with the globe renderer (D104), taking the generated assets
from 4.5 MB to 852 KB and the app bundle from 2.1 MB to 774 KB.

## Using live data

Copy `.env.example` to `backend/.env` and set `ORBITAL_PROVIDER`. There are
three live sources:

| Provider | Credentials | Cost | Catch |
|---|---|---|---|
| `opensky` | OAuth2 client pair | Metered, 4000 credits/day free | Bills by **area requested**, not per request |
| `adsblol` | None | Free | Rate limited: a burst of 4, then ~1 request per 12 s |
| `union` | OpenSky pair, optional | Free feed every poll, metered one occasionally | The one we run |

`union` polls adsb.lol on every cycle and calls OpenSky only every 120 s, to
fill in the aircraft adsb.lol's receiver network cannot see. The reasoning is
D83; the pacing is D71.

**Ships are a separate pair, merged the same way** (D165, D171). Digitraffic is
the Finnish transport agency's operational feed — no key, no meter, about 37 KB
a minute — and it covers the northern Baltic only. aisstream is a global
websocket that needs a key; half of what it sees is the Baltic anyway, so
Digitraffic stays the authority where they overlap. Set
`ORBITAL_SHIP_GLOBAL_ENABLED=false` the day aisstream starts charging.

**Satellites and the moon need nothing at all.** No key, no feed, no quota.

Read [docs/decisions.md](docs/decisions.md) D21 before touching poll intervals.
OpenSky's free tier is small enough that a careless interval exhausts a day's
credits before lunch. The backend refuses to start if the configured intervals
project past a safety ceiling, but the arithmetic is worth understanding first.

**Neither free feed sees the whole planet.** Both depend on volunteer ground
receivers, and there are regions — western China most visibly — where there are
none, so aircraft genuinely vanish there. That is upstream, not a bug here, and
the map draws the gaps rather than letting them look like empty sky.

## Tests

```bash
cd backend && .venv/Scripts/python -m pytest
```

```bash
cd frontend && npm test
```

**915 backend, 1,146 frontend.** Everything runs offline: no test in either
suite touches the network or spends an API credit.

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The three-layer design and data flow, written to be read start to finish |
| [docs/data-contract.md](docs/data-contract.md) | Field units and meaning; the authority on the normalized shape |
| [docs/decisions.md](docs/decisions.md) | Every significant choice, with its alternatives and reasoning |
| [docs/test-plan.md](docs/test-plan.md) | Test coverage, performance measurements, and the phase 1 exit criteria |

## Status

All the phase 1 completion criteria in
[docs/test-plan.md](docs/test-plan.md) §1 are met, including a verification run
against the live OpenSky API (§9).

**Phase 2 — satellites — is built** (D93–D107). It was out of scope for most of
the project's life and deliberately so; the reversal is recorded rather than
quietly applied, and the tests that guarded the old boundary were re-aimed at
the new one rather than deleted. What stays out: debris and rocket bodies, and
any prediction of conjunctions, collisions or re-entry.

**Ships are built** (D160–D171), and the moon and a solar-system view with
them. Ships are the one layer with a coverage caveat the UI states plainly:
without an aisstream key it is the northern Baltic only.

**Every planet can be entered** (D190–D194). The blocker had been recorded
since D120 as a projection MapLibre could not read; it was a transformation
that had not been written. Venus came first and the four gas giants followed,
labelled as cloud tops rather than as surfaces, because there is nothing under
them to stand on.

**It is deployed and has been used from a phone**, which is where a run of
layout decisions came from (D178–D195). Sign-in works same-origin; across
origins it does not yet.

**Aircraft tracks took five decisions to get right** (D196, D200–D202, D204–D206)
and are the part of this project most worth reading about. The short version is
in the next section; the long version is the best worked example in
[decisions.md](docs/decisions.md) of a defect that survived four fixes.

## Performance

The backend handles 10,000 objects with a **7.4 ms poll** and **9.1 ms** of
thinning, and propagates the whole satellite catalogue — 1,432 objects — in
**21 ms**, which is why satellite positions are computed per request rather
than polled into a store.

The frontend figures previously quoted here (0.8 ms per frame, 5 draw calls)
were measured on the three.js globe and are **not** carried over: that renderer
was deleted in D104 and MapLibre's own draw path has not been measured the same
way. Removing it took the app bundle from 2.1 MB to 774 KB and the generated
assets from 4.5 MB to 852 KB.

Numbers and method are in [docs/test-plan.md](docs/test-plan.md) §4, and the
benchmark is committed:

```bash
cd backend && .venv/Scripts/python benchmarks/bench_backend.py
```

## Things worth knowing up front

- **"Route" means the path the aircraft has flown**, not a filed flight plan.
  It no longer begins when the aircraft entered *our* polling window: adsb.lol
  publishes per-aircraft trace files covering the last 24 hours, so a track
  survives a restart and can begin hours before we first saw it (D200). What it
  cannot do is show what no receiver heard, and the panel says so when a track
  begins mid-air rather than at an airport.
- **A 24-hour trace holds several flights, and only one of them is now.** The
  backend trims it to the leg in progress. Telling a turnaround from a gap in
  coverage is harder than it sounds — the two look identical in duration, and
  an aircraft that sat at Delhi for three hours can leave its two ends 400 km
  apart. The rule that works is *time the aircraft cannot account for*: credit
  it a cruise, subtract the flying the distance could pay for, and see what is
  left (D206).
- **Where a flight is going is looked up, not observed.** An aircraft does not
  transmit its destination, so that comes from what its callsign is *scheduled*
  to fly, which is occasionally wrong. Where it came *from* is inferred instead:
  the nearest airport to the first point of its track. The panel words the two
  differently on purpose (D88).
- **An upstream outage does not break the display.** The backend keeps serving
  its last good snapshot with a `stale` flag; the frontend keeps drawing
  last-known positions with their age. Both refuse to show an empty globe.
- **Satellites are in scope as of September 2026** (D93), reversing an earlier
  decision to drop them (D37). Their positions are *computed* from published
  orbital elements rather than fetched, so that layer costs no quota and works
  offline once the elements are cached. What stays out: debris and rocket
  bodies, and any prediction of conjunctions, collisions or re-entry — SGP4 is
  not accurate enough to make those claims, and three tests fail if either
  appears.
