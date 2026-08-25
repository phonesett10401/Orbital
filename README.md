# Orbital

An interactive 3D globe in the browser with live aircraft positions plotted on
it. Rotate and zoom the Earth, search for a flight by callsign, click an
aircraft for its details, and see the path it has been observed to fly.

CSC480 team project. Phase 1 (aircraft) is under construction; phase 2
(satellites) has not started.

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

## Using live data

Copy `.env.example` to `backend/.env` and fill in OpenSky OAuth2 client
credentials, then set `ORBITAL_PROVIDER=opensky`.

Read [docs/decisions.md](docs/decisions.md) D21 first. OpenSky bills by the
**geographic area requested**, not per request, and the free tier is small
enough that a careless poll interval exhausts a day's credits before lunch. The
backend refuses to start if the configured intervals project past a safety
ceiling, but the arithmetic is worth understanding before you change anything.

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

## Things worth knowing up front

- **"Route" means the path we have observed**, not a filed flight plan. It
  begins when an aircraft entered our polling window and is lost when the
  backend restarts. This is a deliberate limitation, explained in the data
  contract and stated in the UI.
- **An upstream outage does not break the display.** The backend keeps serving
  its last good snapshot with a `stale` flag; the frontend keeps drawing
  last-known positions with their age. Both refuse to show an empty globe.
- **No satellite code exists.** The `type` field and the provider registry are
  the only concessions to phase 2, and there are tests that fail if anything
  more creeps in.
