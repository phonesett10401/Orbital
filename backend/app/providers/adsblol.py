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

import logging
import math
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

FEET_TO_METRES = 0.3048
KNOTS_TO_MS = 0.514444
NAUTICAL_MILE_KM = 1.852
EARTH_RADIUS_KM = 6371.0088

#: Where to stand to see the whole world, and how far to look.
#:
#: **One request, not a sweep.** The first version fired four 6,000 nm circles
#: concurrently and adsb.lol answered one of them with **HTTP 420** - its rate
#: limiter - and then throttled the rest for a minute afterwards. Measured
#: instead: a single circle of this radius from 60N 10E returns **10,013**
#: aircraft in 1.9 seconds, against 10,009 for the union of all four. One
#: request gets everything the four did.
#:
#: 6,000 nm is 11,112 km, which is an angular radius of about 100 degrees -
#: slightly more than a hemisphere. Centred here it reaches every part of the
#: world that carries traffic; the sliver it misses is empty ocean south-east
#: of New Zealand, and it is named rather than pretended away.
GLOBAL_POINT = (60.0, 10.0)
GLOBAL_RADIUS_NM = 6000

#: The largest radius asked for a viewport, in nautical miles.
#:
#: A bounding box becomes the circle that contains it, and a viewport zoomed
#: out to most of a hemisphere would otherwise ask for more than the global
#: query itself.
VIEWPORT_MAX_RADIUS_NM = 3000


class AdsbLolProvider(Provider):
    """Aircraft positions from adsb.lol's public API."""

    name = "adsblol"
    object_type = ObjectType.AIRCRAFT

    def __init__(
        self,
        *,
        base_url: str = "https://api.adsb.lol/v2",
        timeout_seconds: float = 30.0,
        user_agent: str = "Orbital/0.1 (CSC480 student project)",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        # Sent on every request because the service asks for one, and because a
        # free service run on donations deserves to know who is calling it.
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds, headers={"User-Agent": user_agent}
        )

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Every aircraft in ``bbox``, or the whole world when it is None.

        One HTTP request either way. That is not an optimisation but a
        requirement: this service rate-limits concurrent callers with HTTP 420
        and stays cross for a while afterwards, and one large circle returns
        what four smaller ones do.
        """
        if bbox is None:
            lat, lon, radius = GLOBAL_POINT[0], GLOBAL_POINT[1], GLOBAL_RADIUS_NM
        else:
            lat, lon, radius = _circle_for(bbox)
        return await self._fetch_circle(lat, lon, radius)

    async def _fetch_circle(
        self, lat: float, lon: float, radius_nm: int
    ) -> list[TrackedObjectRecord]:
        url = f"{self.base_url}/point/{lat}/{lon}/{radius_nm}"
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
