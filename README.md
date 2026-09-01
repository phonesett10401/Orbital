# Orbital

Live aircraft positions plotted on the Earth in the browser. Rotate and zoom,
search for a flight by callsign or for an airport by name or code, click an
aircraft for its details, and see the path it has been observed to fly.

The world is drawn with **MapLibre** on satellite imagery, as a globe when you
are far out and a street map when you are close in. A second renderer — a
three.js globe — existed alongside it during the migration and was deleted once
the map could do everything it did (D104).

CSC480 team project.

---

## Running it

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

Everything runs offline. No test in either suite touches the network or spends
an API credit.

## Documentation

| Document | What it covers |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The three-layer design and data flow, written to be read start to finish |
| [docs/data-contract.md](docs/data-contract.md) | Field units and meaning; the authority on the normalized shape |
| [docs/decisions.md](docs/decisions.md) | Every significant choice, with its alternatives and reasoning |
| [docs/test-plan.md](docs/test-plan.md) | Test coverage, performance measurements, and the phase 1 exit criteria |

## Status

All the completion criteria in [docs/test-plan.md](docs/test-plan.md) §1 are
met, including a verification run against the live OpenSky API (§9). Ongoing
work deepens the aircraft globe rather than adding new scope.

## Performance

At the 2,000-marker target the browser spends 0.8 ms per frame updating markers
— under 5% of a 60 fps budget — and draws the entire scene, all 2,000 markers
included, in **5 draw calls**. The backend handles 10,000 objects with a 7.4 ms
poll and 9.1 ms of thinning.

Numbers and method are in [docs/test-plan.md](docs/test-plan.md) §4, and the
benchmark is committed:

```bash
cd backend && .venv/Scripts/python benchmarks/bench_backend.py
```

## Things worth knowing up front

- **"Route" means the path we have observed**, not a filed flight plan. It
  begins when an aircraft entered our polling window and is lost when the
  backend restarts. This is a deliberate limitation, explained in the data
  contract and stated in the UI.
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
