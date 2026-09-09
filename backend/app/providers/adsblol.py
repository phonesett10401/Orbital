"""adsb.lol: the same aircraft, without a meter running.

A community ADS-B aggregator with no account, no key and no credit budget.
Measured against OpenSky on the same circles (D83):

| | OpenSky | adsb.lol |
|---|---|---|
| worldwide | 11,651 | 10,009 |
| western Europe, 250 nm | 1,001 | 996 |
| eastern United States | 592 | 606 |
| Myanmar | **22** | 4 |
| inland China | 0 | **33** |

So it is not *better* — it is comparable, with different holes, and free. The
second of those is what changes the design: OpenSky meters us at 4,000 credits
a day, which is the reason the whole polling ladder exists (D21, D27), and a
source with no meter can be polled as often as is decent.

## Two differences from OpenSky that matter

**Units.** This is a `readsb` feed, so altitudes are in **feet** and ground
speed is in **knots**. The contract is metres and metres per second (D18), and
a missed conversion here would put every aircraft at three times its real
altitude and look entirely plausible while doing it. Converted in one place,
asserted in the tests against a known flight level.

**No global endpoint, but one circle is enough.** Queries are point-and-radius,
and the radius goes far past what the documentation suggests: a single 6,000 nm
circle returns **10,013 aircraft in 1.9 seconds** - the whole world in one
request. Asking for four concurrently instead earns an HTTP 420, which is this
service's way of saying enhance your calm.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.models import BBox, ObjectType, TrackedObjectRecord, TrackPoint
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderError,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

FEET_TO_METRES = 0.3048

#: A silence at least this long is worth asking about.
#:
#: Only a floor: what decides is whether the aircraft *moved* across it (D205).
FLIGHT_BREAK_SECONDS = 30 * 60.0

#: Below this, the aircraft did not fly across the silence - so it ended a
#: flight rather than interrupting one.
#:
#: **Duration cannot separate the two and displacement can.** Measured on two
#: real traces: RLH5046's turnarounds were 224 and 671 minutes covering 16 and
#: 64 km - 4 and 6 km/h, an aircraft on a stand. SIA23's ocean crossings were
#: 195 and 223 minutes covering 3,533 and 3,529 km - 1,088 and 949 km/h, an
#: aircraft in the cruise. The same trace also holds a 199-minute gap covering
#: **0 km**, which is where it sat at JFK before this flight began (D205).
#:
#: 100 km/h leaves room for taxiing and repositioning without coming close to
#: any speed an airliner crosses an ocean at.
FLIGHT_BREAK_MAX_KMH = 100.0
KNOTS_TO_MS = 0.514444
NAUTICAL_MILE_KM = 1.852
EARTH_RADIUS_KM = 6371.0088

#: Points that between them cover the planet, and how far each looks.
#:
#: **One circle is not enough, and measuring it badly said it was.** A 6,000 nm
#: radius is about 100 degrees of arc - a little over a hemisphere - so a single
#: circle from 60N 10E reaches Europe, Asia, Africa and North America and stops
#: short of Australia, New Zealand, the Pacific and southern South America. The
#: first version used one, on the strength of a comparison against four other
#: points that were themselves clustered in the covered half: one circle
#: returned 10,013 aircraft and the four returned 10,009, which read as "one is
#: enough" and was really "the other three were badly placed". Caught by asking
#: the obvious question afterwards: the sweep found **0** aircraft over
#: south-east Australia where a direct query found **27** (defect #31).
#:
#: Four points, each roughly 90 degrees of longitude apart and straddling the
#: equator, with overlap everywhere. Queried **sequentially with a pause**:
#: firing them at once earns an HTTP 420 and a minute of throttling.
GLOBAL_SWEEP: tuple[tuple[float, float], ...] = (
    (50.0, 10.0),    # Europe, Africa, western Asia
    (35.0, 115.0),   # eastern Asia
    (-25.0, 140.0),  # Australia, New Zealand, the south-west Pacific
    (0.0, -80.0),    # the Americas and the eastern Pacific
)
GLOBAL_RADIUS_NM = 6000

#: Minimum seconds between *any* two requests this provider makes.
#:
#: **One gate for the whole provider, not a pause inside the sweep.** The first
#: version of this spaced the four global-sweep circles apart and nothing else,
#: which fixed the sweep in isolation and left it sharing a rate limit with the
#: viewport job - a second caller, on its own 15 s schedule, through the same
#: provider and the same address. Measured over eight polls afterwards, one
#: circle was still refused twice, during a burst of viewport traffic. Spacing
#: requests that do not know about each other cannot work; the limit is a
#: property of the address, so the gate has to be too (defect #35).
#:
#: **The interval is the measured limit, not a guess at one.** The first value
#: here was 4 s, chosen by sending bursts of four with long gaps between them,
#: which never refused. Production sends continuously, and still lost a circle
#: on 38% of polls.
#:
#: Measured properly - steady sending, nothing else running - the limit is not
#: a gap between requests at all. **Four requests go through, then about one
#: every twelve seconds:** a burst of four over roughly five a minute, which is
#: what `limit_req rate=5r/m burst=4 nodelay` looks like from outside. A
#: spacing rule would have refused the first four or none of them.
#:
#: 12 s is that rate. It cannot on its own make demand fit - no spacing makes
#: eight requests fit a budget of five - so the poll intervals were cut to suit
#: as well (see PRESETS["union"]). The gate's job is to keep the *shape* of the
#: traffic inside the bucket; the presets keep the *volume* there.
#:
#: **What it costs.** A four-circle sweep takes about 36 s, inside a 120 s
#: poll, and a viewport request can wait up to one interval for a slot.
MIN_REQUEST_INTERVAL_SECONDS = 12.0

#: Trace altitudes arrive in feet; everything in Orbital is metres.
#:
#: OpenSky's ``baro_altitude`` is already metric, so a track built from this
#: feed without the conversion would put a cruising airliner at 41,000 *metres* -
#: five times the height of Everest and well above the Kármán line, on a map
#: that also draws satellites (D200).
FEET_TO_METRES = 0.3048

#: The largest radius asked for a viewport, in nautical miles.
#:
#: A bounding box becomes the circle that contains it, and a viewport zoomed
#: out to most of a hemisphere would otherwise ask for more than the global
#: query itself.
VIEWPORT_MAX_RADIUS_NM = 3000


def _distance_km(a: "TrackPoint", b: "TrackPoint") -> float:
    """Great-circle distance, near enough for telling a stand from a cruise."""
    mean = math.radians((a.lat + b.lat) / 2.0)
    dy = (b.lat - a.lat) * 111.0
    dx = (b.lon - a.lon) * 111.0 * math.cos(mean)
    return math.hypot(dx, dy)


def current_flight(points: "tuple[TrackPoint, ...]") -> "tuple[TrackPoint, ...]":
    """The tail of a day-long trace that belongs to the flight now in progress.

    A full trace covers 24 hours and several legs. Drawing it whole is the D196
    fault with more points: a confident line along a journey the aircraft
    finished hours ago.

    **The ground is the boundary, when there is one.** An altitude of zero is
    readsb saying the aircraft was on a runway or a stand, and everything after
    the last of those is this flight - a definition that needs no threshold and
    cannot drift.

    Where the trace never touches the ground - a long-haul still airborne, or a
    trace that begins mid-ocean - the fallback is the longest silence over
    `FLIGHT_BREAK_SECONDS`. That is a guess where the ground is a fact, which is
    why it is second.

    Falls back to everything rather than to nothing: a short honest path beats
    an empty one, and the panel already says a track may begin in flight.
    """
    if len(points) < 2:
        return points

    # **The latest boundary of either kind, not the first one found (D204).**
    #
    # Taking ground contact alone was wrong for an aircraft whose only ground
    # points are at the start of the file. RLH5046's trace held 19 of them - all
    # from Cat Bi, sixteen hours and several flights earlier - because adsb.lol
    # heard it depart there and never heard it on a stand again. Everything
    # after that is four legs drawn as one, which is what put a triangle over
    # Vietnam.
    #
    # A flight begins at whichever happened last: the wheels leaving a runway,
    # or the aircraft reappearing after a silence too long to be a gap in
    # listening.
    boundary = -1

    for index in range(len(points) - 1, -1, -1):
        if points[index].altitude == 0.0:
            boundary = index
            break

    for index in range(len(points) - 2, boundary, -1):
        silence = (points[index + 1].timestamp - points[index].timestamp).total_seconds()
        if silence <= FLIGHT_BREAK_SECONDS:
            continue
        # **Did the aircraft fly across it?** A long silence over an ocean is
        # one flight nobody could hear; the same silence spent on a stand is
        # two. Duration is identical between them and displacement is not.
        travelled = _distance_km(points[index], points[index + 1])
        if travelled / (silence / 3600.0) < FLIGHT_BREAK_MAX_KMH:
            boundary = index
            break

    if boundary < 0:
        return points

    tail = points[boundary + 1 :]
    # An aircraft on the ground *now* leaves no tail at all; keep what there is
    # rather than erasing the path on final approach.
    return tail if len(tail) >= 2 else points


class AdsbLolProvider(Provider):
    """Aircraft positions from adsb.lol's public API."""

    name = "adsblol"
    object_type = ObjectType.AIRCRAFT

    def __init__(
        self,
        *,
        base_url: str = "https://api.adsb.lol/v2",
        trace_base_url: str = "https://globe.adsb.lol/data/traces",
        timeout_seconds: float = 30.0,
        user_agent: str = "Orbital/0.1 (CSC480 student project)",
        min_request_interval_seconds: float = MIN_REQUEST_INTERVAL_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        #: Empty turns the trace lookup off entirely.
        self.trace_base_url = trace_base_url.rstrip("/")
        self._min_interval = min_request_interval_seconds
        #: Serialises the wait itself, so two callers cannot both look at the
        #: clock, both see a free slot, and both take it.
        self._gate = asyncio.Lock()
        #: Monotonic time before which no request may be sent.
        #:
        #: **Starts one interval in the future, not at zero.** A fresh process
        #: has no idea whether the address it is calling from was busy a moment
        #: ago, and after a restart it usually was - the previous process was
        #: polling this same API until seconds earlier. Measured across two
        #: restarts, the *first* sweep of each was the only one that lost a
        #: circle, both times about 20 s after boot; every later poll was
        #: clean. Beginning at zero means sprinting into a window somebody else
        #: just filled.
        #:
        #: The cost is one interval of startup latency, once per process.
        self._next_allowed_at = time.monotonic() + min_request_interval_seconds
        # Sent on every request because the service asks for one, and because a
        # free service run on donations deserves to know who is calling it.
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds, headers={"User-Agent": user_agent}
        )

    async def fetch_track(self, object_id: str) -> tuple[TrackPoint, ...] | None:
        """The path this aircraft has flown, from adsb.lol's trace files.

        **This is the method D78 concluded did not exist**, and the union's own
        docstring said so for eight decisions. It was right about
        `api.adsb.lol`, which has no track endpoint, and wrong about the
        project: the traces are published by the map server in readsb's format,
        one gzipped file per aircraft, keyed by the last two characters of the
        hex.

        It matters most where OpenSky is thinnest. Measured over Thailand, three
        aircraft in ten had an OpenSky track; **ten in ten had one here**, and
        where both existed this one was five to thirty times denser (D200).

        `trace_full` and then trimmed, rather than `trace_recent`. The recent
        file is a twentieth of the size and holds half an hour, which drew a
        stub of a path where Flightradar shows the whole flight. The full one
        holds a day - which must not be drawn whole, or it puts yesterday's leg
        on today's map (D196) - so `current_flight` cuts it back to this leg,
        leaving 333 to 2,038 points against the recent file's 92 (D201).

        **Not behind `_wait_turn`.** That gate exists to keep our *polling* off
        api.adsb.lol at twelve-second intervals; these are static files on a
        different host, fetched once per aircraft a reader selects and cached
        upstream for two minutes. Queueing them behind the poll would guarantee
        they miss the three-second budget a detail request allows (D181) and so
        never arrive at all.
        """
        hex_id = (object_id or "").strip().lower()
        if not self.trace_base_url or len(hex_id) < 2:
            return None

        # readsb shards the files by the last two characters of the hex.
        url = f"{self.trace_base_url}/{hex_id[-2:]}/trace_full_{hex_id}.json"
        try:
            response = await self._client.get(url, follow_redirects=True)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"adsb.lol trace request failed: {exc}") from exc

        # An aircraft nobody has traced is a 404, and that is an answer rather
        # than a fault: the caller keeps the track it observed itself.
        if response.status_code == 404:
            return None
        if response.status_code in (420, 429):
            raise ProviderRateLimited(
                f"adsb.lol rate-limited the trace with {response.status_code}"
            )
        if response.status_code >= 400:
            raise ProviderUnavailable(f"adsb.lol trace returned {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderBadResponse(f"adsb.lol sent unparsable trace: {exc}") from exc

        base = payload.get("timestamp")
        rows = payload.get("trace")
        if not isinstance(base, (int, float)) or not isinstance(rows, list):
            return None

        points = [self._trace_point(float(base), row) for row in rows]
        kept = tuple(p for p in points if p is not None)
        return current_flight(kept) or None

    @staticmethod
    def _trace_point(base: float, row: Any) -> TrackPoint | None:
        """One ``[seconds_after_base, lat, lon, alt_ft, ...]`` row.

        A row without a position is dropped rather than defaulted, for the
        reason a state vector without one is (D18): a point at (0, 0) draws a
        line through the Gulf of Guinea.
        """
        if not isinstance(row, (list, tuple)) or len(row) < 3:
            return None
        offset, lat, lon = row[0], row[1], row[2]
        if not all(isinstance(v, (int, float)) for v in (offset, lat, lon)):
            return None

        altitude: float | None = None
        if len(row) > 3:
            raw = row[3]
            if isinstance(raw, (int, float)):
                altitude = float(raw) * FEET_TO_METRES
            elif raw == "ground":
                # readsb says "ground" rather than a number, and nil is a fact
                # about an aircraft on a runway rather than a missing reading.
                altitude = 0.0

        return TrackPoint(
            lat=float(lat),
            lon=float(lon),
            altitude=altitude,
            timestamp=datetime.fromtimestamp(base + float(offset), tz=timezone.utc),
        )

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Every aircraft in ``bbox``, or the whole world when it is None.

        A viewport is one request. The whole world is four, **sequential and
        spaced**: no single circle covers the planet, and firing them at once
        earns an HTTP 420 (D85).
        """
        if bbox is not None:
            lat, lon, radius = _circle_for(bbox)
            return await self._fetch_circle(lat, lon, radius)

        merged: dict[str, TrackedObjectRecord] = {}
        failed: list[tuple[float, float]] = []
        last_error: BaseException | None = None

        for point in GLOBAL_SWEEP:
            # No pause here: `_wait_turn` spaces every request this provider
            # makes, including the viewport job's, which a pause local to this
            # loop could not see.
            error = await self._sweep_circle(point, merged)
            if error is not None:
                # One circle failing is a partial view, not no view: the sweep
                # overlaps, and refusing the whole poll would throw away three
                # quarters of the planet over one throttled request.
                failed.append(point)
                last_error = error

        # **Ask again for whatever was refused.** Tolerating a partial sweep is
        # right, but on its own it is also silent, and defect #35 lived in that
        # silence for the life of the provider: the same circle failed on every
        # poll and the map was simply missing a continent. A retry costs one
        # pause and only when something actually failed, and it turns a
        # permanent hole into at worst a delayed one.
        for point in list(failed):
            error = await self._sweep_circle(point, merged)
            if error is None:
                failed.remove(point)
            else:
                last_error = error

        if failed and not merged:
            raise ProviderUnavailable(f"adsb.lol unreachable: {last_error}")
        if failed:
            logger.warning(
                "adsb.lol: %d of %d circles failed twice: %s",
                len(failed),
                len(GLOBAL_SWEEP),
                ", ".join(f"{lat},{lon}" for lat, lon in failed),
            )
        return list(merged.values())

    async def _sweep_circle(
        self,
        point: tuple[float, float],
        merged: dict[str, TrackedObjectRecord],
    ) -> BaseException | None:
        """Fetch one sweep circle into ``merged``; return the error, if any.

        Returning the failure rather than raising keeps the sweep's control
        flow in one place, so the retry below cannot drift from the first pass.
        """
        lat, lon = point
        try:
            for record in await self._fetch_circle(lat, lon, GLOBAL_RADIUS_NM):
                merged[record.id] = record
        except ProviderError as exc:
            return exc
        return None

    async def _wait_turn(self) -> None:
        """Block until this provider is allowed to send another request.

        Holding the lock across the sleep is what makes it a queue rather than
        a race: waiters are admitted one at a time and each claims the next
        slot before releasing, so two concurrent callers get two slots an
        interval apart instead of both reading the same clock and both going.
        """
        if self._min_interval <= 0:
            return
        async with self._gate:
            now = time.monotonic()
            wait = self._next_allowed_at - now
            if wait > 0:
                await asyncio.sleep(wait)
            self._next_allowed_at = max(now, self._next_allowed_at) + self._min_interval

    async def _fetch_circle(
        self, lat: float, lon: float, radius_nm: int
    ) -> list[TrackedObjectRecord]:
        url = f"{self.base_url}/point/{lat}/{lon}/{radius_nm}"
        await self._wait_turn()
        try:
            response = await self._client.get(url)
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"adsb.lol request failed: {exc}") from exc
        # 420 is this service's rate limit -- "enhance your calm" -- and 429 is
        # the conventional one. Both mean stop asking, and the poller has a
        # backoff that understands that (D26).
        if response.status_code in (420, 429):
            raise ProviderRateLimited(
                f"adsb.lol rate-limited us with {response.status_code}"
            )
        if response.status_code >= 400:
            raise ProviderUnavailable(f"adsb.lol returned {response.status_code}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderBadResponse(f"adsb.lol sent unparsable JSON: {exc}") from exc
        aircraft = payload.get("ac")
        if aircraft is None:
            return []
        if not isinstance(aircraft, list):
            raise ProviderBadResponse("'ac' was not a list")

        # **The feed's own clock, not ours.** `seen_pos` counts seconds back
        # from the `now` in the payload, so subtracting it from our wall clock
        # adds the network round trip and any skew between the two machines -
        # which measured as a median age of *minus two seconds*, timestamps in
        # the future. Everything downstream reasons about age (D71 freezes a
        # position older than two minutes, the marker fades at the same point),
        # and a negative age is a small lie in the middle of all of it.
        served_at = _number(payload.get("now"))
        now = (
            datetime.fromtimestamp(served_at / 1000.0, tz=timezone.utc)
            if served_at and served_at > 1e11  # milliseconds, as this feed sends
            else datetime.now(timezone.utc)
        )
        records = []
        for entry in aircraft:
            record = self._to_record(entry, now)
            if record is not None:
                records.append(record)
        return records

    def _to_record(self, entry: Any, now: datetime) -> TrackedObjectRecord | None:
        """One aircraft, in the contract's units.

        Skips anything without a position rather than defaulting it: a marker
        at (0, 0) looks like real data in the Gulf of Guinea (D18).
        """
        if not isinstance(entry, dict):
            return None
        identifier = entry.get("hex")
        lat = _number(entry.get("lat"))
        lon = _number(entry.get("lon"))
        if not isinstance(identifier, str) or lat is None or lon is None:
            return None

        # `alt_baro` is feet, or the string "ground". Barometric first for the
        # same reason as OpenSky: a flight level is a barometric altitude and
        # every tracker shows it (D79).
        raw_altitude = entry.get("alt_baro")
        if raw_altitude == "ground":
            # On the ground is genuinely zero, and it returns here rather than
            # falling through: the geometric altitude of a parked aircraft is
            # its airfield's elevation plus GNSS error, and letting it through
            # put an aeroplane on a runway at 11,361 m in the first version of
            # this code. The one place a default is more truthful than a null,
            # exactly as it is for OpenSky.
            altitude_m: float | None = 0.0
        else:
            altitude = _number(raw_altitude)
            if altitude is None:
                altitude = _number(entry.get("alt_geom"))
            altitude_m = altitude * FEET_TO_METRES if altitude is not None else None

        speed_knots = _number(entry.get("gs"))
        callsign = entry.get("flight")

        # `seen_pos` is how many seconds ago the position was received.
        age = _number(entry.get("seen_pos"))
        if age is None:
            age = _number(entry.get("seen")) or 0.0

        return TrackedObjectRecord(
            id=identifier.strip().lower(),
            lat=lat,
            lon=lon,
            altitude=altitude_m,
            velocity=speed_knots * KNOTS_TO_MS if speed_knots is not None else None,
            heading=_number(entry.get("track")),
            label=str(callsign).strip() if callsign else "",
            last_seen=now - timedelta(seconds=max(0.0, age)),
            type=self.object_type,
            # Also in `meta` as aircraftType, and deliberately so: the panel
            # reads meta generically (D4), while the list projects meta away to
            # keep a 2000-object response small. The renderer needs the type
            # for *every* aircraft, not just the selected one, so it has to be
            # on the core shape.
            model=_text(entry.get("t")),
            meta=_meta(entry),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _meta(entry: dict) -> dict[str, str]:
    """The fields OpenSky never had.

    Registration and type are what let a panel say "Boeing 737-800, G-JZBG"
    instead of a six-character hex address, and they cost nothing extra -- this
    feed carries them on every aircraft that has them.
    """
    meta: dict[str, str] = {}
    for key, name in (
        ("r", "registration"),
        ("t", "aircraftType"),
        ("desc", "aircraftDescription"),
        ("squawk", "squawk"),
        ("category", "category"),
    ):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            meta[name] = value.strip()
    return meta


def _number(value: Any) -> float | None:
    """A float, or None for anything that is not one.

    `readsb` uses the string "ground" for altitude and omits fields entirely
    rather than sending null, so this is where both become None.
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _circle_for(bbox: BBox) -> tuple[float, float, int]:
    """The smallest circle containing a bounding box, as (lat, lon, radius nm).

    The API takes a point and a radius, and the store filters again on the way
    out (the `fetch` contract calls bbox a hint, not a filter), so asking for
    slightly more than the viewport is free and asking for slightly less would
    silently lose aircraft at the corners.
    """
    lat = (bbox.lat_min + bbox.lat_max) / 2
    if bbox.crosses_antimeridian:
        # The centre of a box spanning the antimeridian is not the mean of its
        # edges: 170 and -170 average to zero, which is the wrong side of the
        # planet.
        span = (bbox.lon_max + 360 - bbox.lon_min) % 360
        lon = ((bbox.lon_min + span / 2 + 180) % 360) - 180
    else:
        lon = (bbox.lon_min + bbox.lon_max) / 2

    corners = (
        (bbox.lat_min, bbox.lon_min),
        (bbox.lat_min, bbox.lon_max),
        (bbox.lat_max, bbox.lon_min),
        (bbox.lat_max, bbox.lon_max),
    )
    radius_km = max(_haversine_km(lat, lon, corner_lat, corner_lon) for corner_lat, corner_lon in corners)
    radius_nm = math.ceil(radius_km / NAUTICAL_MILE_KM) + 1
    return lat, lon, min(max(radius_nm, 1), VIEWPORT_MAX_RADIUS_NM)


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = phi2 - phi1
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def _text(value: object) -> str | None:
    """A non-empty trimmed string, or None.

    The feed omits fields rather than sending null, but it does send empty
    strings, and an empty type designator is not a type.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None
