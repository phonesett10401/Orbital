# Orbital — Data Contract

The normalized shape every layer speaks. This document is the authority on
units and meaning; `backend/app/models.py` is the authority on validation.

Changing anything here is a team-wide decision, because all three layers are
built against it.

---

## 1. `TrackedObject` — the universal shape

Returned by `GET /api/aircraft`. Serialized as camelCase JSON.

| Field | JSON type | Unit / range | Nullable | Meaning |
|---|---|---|---|---|
| `id` | string | — | no | Stable identifier, unique within a provider. For aircraft this is the ICAO24 address (6 lowercase hex chars). |
| `lat` | number | degrees, `[-90, 90]` | no | Latitude north, WGS84. |
| `lon` | number | degrees, `[-180, 180)` | no | Longitude east, WGS84. `+180` is normalized to `-180`. |
| `altitude` | number | **metres** above mean sea level | **yes** | `null` means unknown, not zero. |
| `velocity` | number | **metres per second**, `>= 0` | **yes** | Ground speed, not airspeed. `null` means unknown. |
| `heading` | number | degrees, `[0, 360)` | **yes** | Clockwise from **true** north, not magnetic. Direction of travel over the ground. |
| `label` | string | — | no | Short display name. For aircraft, the callsign, trimmed. Falls back to `id` when upstream has no callsign. |
| `lastSeen` | string | RFC 3339, UTC, `Z` suffix | no | When the **upstream source** last observed the object — not when we polled. |
| `type` | string | `"aircraft"` | no | Which layer the object belongs to. |

### Rules that hold for every object

- **Units are SI and are converted exactly once**, inside the provider. No
  layer above ingestion ever sees knots, feet, or feet-per-minute.
- **`null` means unknown; it never means zero.** A stationary aircraft has
  `velocity: 0`. An aircraft whose speed upstream did not report has
  `velocity: null`. The frontend renders these differently, so they must not
  collapse into each other.
- **Objects with no usable position are dropped, not defaulted.** A provider
  must never emit `lat: 0, lon: 0` as a stand-in for missing coordinates. That
  produces a marker that looks like a real aircraft in the Gulf of Guinea.
- **`lastSeen` is always timezone-aware UTC.** A naive datetime is rejected at
  the model boundary, because it silently corrupts every staleness comparison
  downstream.
- **Objects are immutable.** The store hands the same instance to concurrent
  requests.

---

## 2. `TrackedObjectRecord` — internal only

`TrackedObject` plus:

| Field | JSON type | Meaning |
|---|---|---|
| `meta` | object (string → string) | Source-specific fields the universal shape deliberately omits. |

This is what providers return and what the store holds. It **never reaches the
browser in a list response**: the list endpoint declares `TrackedObject` as its
response model, so FastAPI projects `meta` away.

### Why `originCountry` is not a top-level field

The detail panel needs origin country. It is not in the universal shape,
because it is meaningless for a satellite. Putting it in the shape would force
a future satellite provider to either emit a fake value or change the schema —
and the claim that data sources are pluggable would stop being true.

Keys currently used by the aircraft provider:

| Key | Meaning |
|---|---|
| `originCountry` | Country of the aircraft's registration, as reported upstream. |

The frontend renders `meta` generically as key/value rows, so a provider can
add a key without a frontend change.

### `ageSeconds` is true at send time; `fetchedAt` is true always

Both describe the same instant, and a client should read `fetchedAt`.

`ageSeconds` is computed when the response is written. That was harmless while
every poll produced a fresh response, and stopped being harmless when the list
endpoint began answering `304 Not Modified` (D47): a client then keeps and
reuses a body for up to a full tier 1 cycle, and the age inside it is as old as
the body. `fetchedAt` is an absolute instant, so it says the same thing however
many times the same body is reused.

`ageSeconds` stays in the envelope. It is the right form for a human reading a
response by hand or a health check comparing one number against a threshold,
and removing it would be a breaking change to buy nothing. But anything
rendering a live age must derive it from `fetchedAt`.

### Why `airline` is not a field anywhere

The detail panel shows an airline. Nothing in this contract carries one, and
that is deliberate (D46).

An airline is not observed. What is observed is a callsign, and the first three
letters of a callsign are an ICAO airline designator **by convention** — a
convention that general aviation, military and government flights do not
follow at all. Turning `THA932` into "Thai Airways International" is a lookup
against a published table, and a lookup is an inference about the data, not
data.

That distinction is the reason it is not in `meta` either. `meta` means fields
the provider actually reported; if a derived value could live there, no reader
of a `meta` row could tell which kind they were looking at. So the decode runs
in the frontend, where presentation belongs, and the panel labels it as
decoded.

There is a second reason, and it is arithmetic. A `TrackedObject` reaches the
browser up to 2,000 at a time, every 10 seconds. An airline name averages 21
bytes, so carrying it in the universal shape would add roughly 42 KB to every
list response for a value the UI shows one at a time, on click.

---

## 3. `TrackedObjectDetail` — the by-id response

`TrackedObjectRecord` plus:

| Field | JSON type | Meaning |
|---|---|---|
| `track` | array of `TrackPoint` | Positions, **oldest first**, from `trackSource`. |
| `trackSource` | `"provider"` \| `"observed"` | Where the track came from. See below. |
| `origin` | `Airport` \| `null` | Where the flight appears to have departed from. `null` is common and meaningful. |

### `Airport`

| Field | JSON type | Meaning |
|---|---|---|
| `icao` | string | ICAO code, e.g. `YSSY`. |
| `name` | string | Airport name as published. |
| `lat` / `lon` | number | Degrees. |
| `country` | string \| null | ISO 3166-1 alpha-2. |
| `distanceKm` | number | How far the track's first point was from this airport. |

### `TrackPoint`

| Field | JSON type | Unit | Nullable |
|---|---|---|---|
| `lat` | number | degrees | no |
| `lon` | number | degrees | no |
| `altitude` | number | metres | yes |
| `timestamp` | string | RFC 3339 UTC | no |

### What "route" means in Orbital — read this

> **`track` is a path actually flown, and never a filed flight plan.**
> `trackSource` says whose observation it is.

**`provider`** — the source's own flight history, which begins at take-off.
For OpenSky this is `/tracks/all`, bought once per selection at 4 credits and
cached (D78). `origin` is then usually present.

**`observed`** — what our own polling saw, which **begins when the object
entered our polling window**, not at takeoff. An aircraft first seen thirty
seconds ago has a thirty-second route. This is the fallback whenever the
provider has no track for the aircraft, cannot be reached, or does not offer
flight history at all — the fixture provider does not.

**`origin` is inferred, not reported.** It is the nearest airport to the first
point of the track, within 8 km, and only when that point is below 1500 m.
`distanceKm` is how near, so a client can distinguish "on the runway" from
"already climbing". It is `null` whenever the track begins in mid-air, which is
an ordinary answer for a flight the network picked up over an ocean — and a
`null` here means *unknown*, never "no airport", exactly as it does for
`heading` (D18).

An earlier version of this document said obtaining a route "would require
separate `/flights/aircraft` calls, which cost additional quota we do not
have". That is still true of `/flights/aircraft` — **30 credits a call, and
404 for two of the three aircraft it was tried on** — and it is why the origin
is read off the track instead (D78).

Consequences a reader must understand:
- The route is **lost when the backend restarts.** History lives in memory.
- Track history is a **bounded ring buffer**, so a long-lived object's route is
  truncated to the most recent N points.
- The route is a **sampled** path at the poll interval, so it is a polyline of
  observed points, not a smooth curve. Between two points we know nothing.

This is a documented product limitation, agreed deliberately. It is not a
defect, and it should be stated plainly in the demo.

---

## 4. `BBox` — bounding boxes

Query-string form, matching OpenSky's own parameter order:

```
?bbox=latMin,lonMin,latMax,lonMax
```

All edges are **inclusive**. `latMin` must not exceed `latMax`.

**Antimeridian:** if `lonMin > lonMax`, the box is understood to wrap across
±180. `bbox=50,170,70,-170` is a 20°-wide box over the Pacific, not an empty
one. A naive `lonMin <= lon <= lonMax` test returns nothing for these boxes —
an easy bug to ship and a hard one to notice, so it is handled in `BBox` itself
and every caller inherits the fix.

---

## 5. List response envelope

`GET /api/aircraft` returns objects wrapped with freshness metadata, because
the frontend must be able to tell live data from stale data:

| Field | Type | Meaning |
|---|---|---|
| `objects` | array of `TrackedObject` | The filtered, thinned result. |
| `fetchedAt` | string | When the snapshot was retrieved from upstream. |
| `ageSeconds` | number | How old the snapshot is now. |
| `stale` | boolean | True once age exceeds the configured TTL. |
| `source` | string | Provider name that produced the snapshot. |
| `total` | number | Objects matching the bbox **before** thinning. |
| `returned` | number | Objects actually in `objects`. |

`total` and `returned` differing is how the frontend knows thinning occurred
and can tell the user they are seeing a sample.

---

## 6. Mirroring this contract on the frontend

`frontend/src/types.ts` mirrors these types by hand. It must be updated in the
same commit as `models.py`.

We considered generating the TypeScript from FastAPI's OpenAPI schema. We chose
not to, for now: the contract is nine fields and changes rarely, and a codegen
step is one more thing that can break for a three-person team on a deadline.
This is recorded in [decisions.md](decisions.md) and is worth revisiting if the
shape starts changing often.

---

## 7. Example

```json
{
  "objects": [
    {
      "id": "a1b2c3",
      "lat": 40.7128,
      "lon": -74.006,
      "altitude": 10668.0,
      "velocity": 244.3,
      "heading": 87.5,
      "label": "UAL1234",
      "lastSeen": "2026-08-25T12:00:00Z",
      "type": "aircraft"
    }
  ],
  "fetchedAt": "2026-08-25T12:00:02Z",
  "ageSeconds": 3.4,
  "stale": false,
  "source": "opensky",
  "total": 4821,
  "returned": 1
}
```
