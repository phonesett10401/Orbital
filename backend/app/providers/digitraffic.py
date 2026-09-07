"""Digitraffic: ships, from the one open feed that asked for nothing.

Fintraffic (the Finnish transport agency) publishes live AIS for the northern
Baltic under **CC BY 4.0**, with no key, no account and no quota. That is the
whole reason it is first: of the free maritime sources surveyed in D165 it was
the only one that could be called, measured and built on inside a single
session. Everything else wanted a receiver of our own, a registered
application, or an answer to a licensing question its maintainers had not given.

## What it costs and what it returns

One request, measured live:

| | |
|---|---|
| vessels | **916** |
| payload | **37 KB** gzipped |
| ``Cache-Control`` | ``max-age=60`` - the upstream states its own cadence |
| conditional GET | ``If-Modified-Since`` -> **304, zero bytes** |

A second endpoint carries the names. 806 metadata records covering **797 of the
916 positions**, so 87% of ships draw with a name rather than a nine-digit
number. It is fetched on its own slow schedule because a vessel's name, IMO
number and dimensions do not change between polls; its destination and draught
change per voyage, which is hours, not seconds.

## Coverage is regional, and the map should not pretend otherwise

Measured from the returned positions: **lon 17.0 to 32.5, lat 57.7 to 65.8** -
the Gulf of Finland, the Aland Sea and the Bothnian Bay. There are no ships in
the Pacific here because this source cannot see the Pacific, which is a fact
about the source and belongs in front of the reader rather than buried.

## Two things about AIS that will bite anyone who skips them

**Sentinel values are not missing values.** AIS encodes "not available" as a
number in range, and this feed passes them straight through: ``sog`` 102.3
knots, ``cog`` 360 degrees, ``heading`` 511. In one live sample that was 11, 88
and 142 vessels respectively. Passed through unconverted they draw as a ship
making **102 knots due north** - not a gap in the map but a confident lie on
it, which is the same class of error as a marker at (0, 0) in the Gulf of
Guinea (D18).

**Most ships are not moving.** Of 636 vessels with a position under fifteen
minutes old, **127 had a speed over half a knot**. Four fifths of a ship map is
moored or at anchor, where an aircraft map is entirely things in motion. That
is not a defect to correct; it is what the layer looks like, and ``navStat`` is
carried into ``meta`` so the panel can say *moored* rather than leaving the
reader to infer it from a speed of zero.

## The stale tail, and where the TTL came from

The endpoint retains a vessel for about **24 hours** after it was last heard.
The age distribution has a cliff and then a long tail:

| age | cumulative |
|---|---|
| < 3 min | 56% |
| < 6 min | 67% |
| < 15 min | **69%** |
| 1-24 h | the remaining **28%** |

So nearly a third of what this endpoint returns has not been heard from in over
an hour. Serving it would repeat D86 exactly - a map of ghosts, where 39% of
what was drawn was already past the fade. ``SHIP_TTL_SECONDS`` is 15 minutes:
it sits on the cliff, it is five missed reports for a moored Class A vessel
(which transmits every three minutes), and it drops the tail.

**And it is applied here, on the way in, not only by the store's eviction.**
That was the first attempt and it does not work - which is a property of this
source rather than a bug in the store, and worth understanding before anyone
tries it again.

Eviction assumes **the source forgets**. When an aircraft lands, adsb.lol stops
reporting it: the record is never refreshed, ages past the TTL, is swept, and
stays swept. Digitraffic never forgets. It re-serves the same day-old record on
every single poll, so the store deletes it and the next poll puts it straight
back. The two then race - eviction runs at most once a minute, the poll lands
every 60 s give or take jitter - and whenever the poll gets there first the
whole stale tail is served.

Measured live, before this filter existed: **920 vessels served, 281 of them
past the TTL, the oldest 86,359 seconds** - not quite twenty-four hours.
Eviction was running correctly the entire time and losing.

So the age is judged where it is known. Eviction still runs and still matters:
it is what removes a vessel that leaves the coverage area altogether, which is
the one case this source really does forget about.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.ais import (
    SHIP_TTL_SECONDS,
    eta_text,
    heading,
    is_position,
    nav_status,
    number,
    ship_type,
    speed_ms,
    text,
)
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

#: How often the names are refetched, against every poll for the positions.
#:
#: A vessel's name, IMO number and hull dimensions are fixed; its destination
#: and draught change once a voyage. Ten minutes is far more often than either
#: needs and still turns 916 metadata rows into one request in ten rather than
#: one per poll.
METADATA_REFRESH_SECONDS = 600.0


class DigitrafficProvider(Provider):
    """Ship positions from Fintraffic's open AIS feed."""

    name = "digitraffic"
    object_type = ObjectType.SHIP

    def __init__(
        self,
        *,
        base_url: str = "https://meri.digitraffic.fi/api/ais/v1",
        timeout_seconds: float = 30.0,
        user_agent: str = "Orbital/0.1 (CSC480 student project)",
        metadata_refresh_seconds: float = METADATA_REFRESH_SECONDS,
        max_age_seconds: float = SHIP_TTL_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._metadata_refresh = metadata_refresh_seconds
        #: Positions older than this are not emitted at all. See the module
        #: docstring for why this cannot be left to the store's eviction.
        self._max_age = max_age_seconds
        #: MMSI -> the vessel's static and voyage data, refreshed slowly.
        self._metadata: dict[int, dict[str, Any]] = {}
        self._metadata_fetched_at: float | None = None
        #: One refresh at a time. Two poll jobs share this provider, and both
        #: arriving at an expired cache together would send two requests for
        #: the same 260 KB - the mistake defect #35 taught about rate limits,
        #: made again one layer up.
        self._metadata_lock = asyncio.Lock()
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds,
            headers={
                "User-Agent": user_agent,
                # Their instructions ask for this by name so they can see who
                # is calling; it also lifts the anonymous 60-per-minute cap.
                "Digitraffic-User": user_agent,
            },
        )

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Every vessel the feed has actually heard from lately.

        ``bbox`` is ignored, as the contract permits: the endpoint takes no
        bounding box and the whole feed is 37 KB, so filtering here would spend
        work to serve less. The API layer filters again on the way out.

        The **age** filter is not optional in that way. See the module
        docstring: this source re-serves its own day-old records on every poll,
        so eviction downstream cannot win against it.
        """
        await self._refresh_metadata_if_due()
        payload = await self._get("/locations")

        features = payload.get("features") if isinstance(payload, dict) else None
        if not isinstance(features, list):
            raise ProviderBadResponse("'features' was not a list")

        now = datetime.now(timezone.utc)
        records = []
        dropped = 0
        for feature in features:
            record = self._to_record(feature)
            if record is None:
                continue
            if (now - record.last_seen).total_seconds() > self._max_age:
                dropped += 1
                continue
            records.append(record)
        if dropped:
            logger.debug(
                "digitraffic: dropped %d of %d vessels older than %.0fs",
                dropped,
                len(features),
                self._max_age,
            )
        return records

    async def _refresh_metadata_if_due(self) -> None:
        """Refetch the names, if they are old enough to be worth refetching.

        A failure here is deliberately swallowed. Metadata is what makes a ship
        read as *FU XIANG* instead of *477165600*; losing it degrades the map,
        while raising would lose the positions as well - and stale names are
        worth more than no ships.
        """
        if not self._metadata_due():
            return
        async with self._metadata_lock:
            # Checked again inside the lock: whoever was waiting on it was
            # waiting for exactly this fetch to finish.
            if not self._metadata_due():
                return
            try:
                rows = await self._get("/vessels")
            except Exception as exc:  # noqa: BLE001 - see docstring
                logger.warning("digitraffic: vessel metadata unavailable: %s", exc)
                return
            if not isinstance(rows, list):
                logger.warning("digitraffic: vessel metadata was not a list")
                return
            self._metadata = {
                row["mmsi"]: row
                for row in rows
                if isinstance(row, dict) and isinstance(row.get("mmsi"), int)
            }
            self._metadata_fetched_at = time.monotonic()
            logger.info("digitraffic: %d vessel metadata records", len(self._metadata))

    def _metadata_due(self) -> bool:
        if self._metadata_fetched_at is None:
            return True
        return time.monotonic() - self._metadata_fetched_at >= self._metadata_refresh

    async def _get(self, path: str) -> Any:
        try:
            response = await self._client.get(f"{self.base_url}{path}")
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"digitraffic request failed: {exc}") from exc
        if response.status_code == 429:
            # Their documented anonymous limit is 60 a minute and we send two
            # requests a minute at most, so this should never fire. It is here
            # because a limit we are nowhere near is exactly the one that gets
            # lowered without telling anybody.
            raise ProviderRateLimited("digitraffic rate-limited us with 429")
        if response.status_code >= 400:
            raise ProviderUnavailable(f"digitraffic returned {response.status_code}")
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderBadResponse(f"digitraffic sent unparsable JSON: {exc}") from exc

    def _to_record(self, feature: Any) -> TrackedObjectRecord | None:
        """One vessel, in the contract's units, or None if it has no position."""
        if not isinstance(feature, dict):
            return None
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        if not isinstance(properties, dict) or not isinstance(geometry, dict):
            return None
        coordinates = geometry.get("coordinates")
        if not isinstance(coordinates, list) or len(coordinates) < 2:
            return None
        lon = number(coordinates[0])
        lat = number(coordinates[1])
        mmsi = properties.get("mmsi")
        if lon is None or lat is None or not isinstance(mmsi, int):
            return None
        if not is_position(lat, lon):
            # AIS transmits 91 and 181 for "position not available", and the
            # contract's own validators would raise on them - which would take
            # the whole poll down over one bad vessel.
            return None

        observed_ms = number(properties.get("timestampExternal"))
        if observed_ms is None:
            return None

        static = self._metadata.get(mmsi, {})
        name = text(static.get("name"))

        return TrackedObjectRecord(
            id=str(mmsi),
            lat=lat,
            lon=lon,
            # Zero rather than None, and for the same reason ``alt_baro:
            # "ground"`` becomes zero for an aircraft: a ship's height above
            # mean sea level is not unknown, it is nil. None would mean the
            # source did not say, and would leave anything that reasons about
            # altitude with a hole where a fact belongs.
            altitude=0.0,
            velocity=speed_ms(properties.get("sog")),
            heading=heading(properties.get("heading"), properties.get("cog")),
            # The name when the feed knows it, the MMSI when it does not.
            # Never an empty string: this is what the map draws and what search
            # matches, and 13% of these vessels have no metadata row.
            label=name or str(mmsi),
            model=ship_type(static.get("shipType")),
            last_seen=datetime.fromtimestamp(observed_ms / 1000.0, tz=timezone.utc),
            type=self.object_type,
            meta=_meta(properties, static),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _meta(properties: dict, static: dict) -> dict[str, str]:
    """The facts a panel can show, none of them invented.

    Everything here is either passed through or converted with its unit named.
    Nothing is derived from a second source and nothing is guessed.
    """
    meta: dict[str, str] = {"mmsi": str(properties.get("mmsi"))}

    status = nav_status(properties.get("navStat"))
    if status:
        meta["navigationStatus"] = status

    for key, name in (
        ("name", "vesselName"),
        ("callSign", "callSign"),
        ("destination", "destination"),
    ):
        value = text(static.get(key))
        if value:
            meta[name] = value

    imo = static.get("imo")
    if isinstance(imo, int) and imo > 0:
        meta["imo"] = str(imo)

    kind = ship_type(static.get("shipType"))
    if kind:
        meta["shipType"] = kind

    # **Decimetres here**, which is a unit nobody thinks in - and the reason
    # this conversion is not shared: aisstream sends the same fact in metres
    # already, so a common helper would have to ask which source it was
    # talking to, and a helper that asks that is not shared (D166).
    draught = number(static.get("draught"))
    if draught is not None and draught > 0:
        meta["draught"] = f"{draught / 10:.1f} m"

    # The four reference points are distances from the transmitting antenna to
    # bow, stern, port and starboard - so the hull is A+B long and C+D wide.
    # Reported that way because a length is a fact about the ship and an
    # antenna offset is a fact about its wiring.
    bow = number(static.get("referencePointA"))
    stern = number(static.get("referencePointB"))
    port = number(static.get("referencePointC"))
    starboard = number(static.get("referencePointD"))
    if bow is not None and stern is not None and bow + stern > 0:
        meta["length"] = f"{bow + stern:.0f} m"
    if port is not None and starboard is not None and port + starboard > 0:
        meta["beam"] = f"{port + starboard:.0f} m"

    eta = _packed_eta(static.get("eta"))
    if eta:
        meta["eta"] = eta
    return meta


def _packed_eta(value: Any) -> str | None:
    """Digitraffic's ETA, out of the bitfield AIS packs it into.

    Twenty bits: four of month, five of day, five of hour, six of minute. The
    *unpacking* is this source's business - aisstream sends the same four
    fields as a struct - and what the numbers mean is `ais.eta_text`'s (D166).
    """
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return None
    return eta_text(
        month=(value >> 16) & 0b1111,
        day=(value >> 11) & 0b11111,
        hour=(value >> 6) & 0b11111,
        minute=value & 0b111111,
    )
