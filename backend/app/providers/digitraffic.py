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
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

KNOTS_TO_MS = 0.514444

#: Drop a vessel not re-observed within this window. See the module docstring:
#: the endpoint retains 24 hours and 28% of it is over an hour old.
SHIP_TTL_SECONDS = 900.0

#: How often the names are refetched, against every poll for the positions.
#:
#: A vessel's name, IMO number and hull dimensions are fixed; its destination
#: and draught change once a voyage. Ten minutes is far more often than either
#: needs and still turns 916 metadata rows into one request in ten rather than
#: one per poll.
METADATA_REFRESH_SECONDS = 600.0

#: AIS "not available" encodings, which arrive as ordinary numbers (D165).
COG_UNAVAILABLE = 360.0
HEADING_UNAVAILABLE = 511

#: The fastest a vessel is believed, in knots.
#:
#: **The sentinel is not the whole problem, and checking only for it let a
#: 250-metre tanker sail at 102 knots.** Speed over ground is transmitted in
#: tenths of a knot, where 1023 means "not available" and 1022 means "102.2 or
#: higher" - so the first version of this refused anything at or above 102.3,
#: which is precise, correct, and missed three vessels sending 102.2. Caught by
#: sorting the live feed by speed and reading the top of the list.
#:
#: Reading further down it was worse than an off-by-one. The next eleven, in
#: one sample:
#:
#: | knots | what it was |
#: |---|---|
#: | 102.2 | NOUNOU, a 250 m tanker, under way |
#: | 102.2 | RATNIK, a tug, **moored** |
#: | 85.0 | MYRA, a 228 m tanker, **at anchor** |
#: | 81.0 | VYATICH, a tug, **moored** |
#: | 79.6 | CORE AXIS, a 274 m tanker |
#:
#: None of those is a sentinel. They are broken transmitters, and there is no
#: encoding that separates them from real readings - so the only thing that
#: can is knowing what a ship can do. The fastest vessel ever in commercial
#: service, the HSC Francisco, does about 58 knots; military hydrofoils reach
#: roughly 60. Above that is not a fast ship, it is a wrong number.
#:
#: 60 knots drops all fourteen readings above it in that sample.
#:
#: **What it does not fix, stated rather than left to be discovered.** Under
#: the ceiling the fastest survivors were a tug at 49.5 knots, a tanker at 47.5
#: and a cargo ship at 44.3 - implausible for those hulls by a factor of three.
#: They stay because nothing in the message distinguishes them from a real
#: reading: a 45-knot patrol boat is an ordinary thing and the ship type is
#: missing for 13% of the feed, so a per-type limit would be a table of guesses
#: dressed as a rule. This constant claims only what it can defend - that no
#: vessel does 80 knots - and the residue is left visible rather than filtered
#: by something that cannot be checked. Cross-referencing consecutive positions
#: would settle it properly, and the store already holds the track to do it
#: with; that is a different piece of work from decoding a message.
MAX_PLAUSIBLE_KNOTS = 60.0

#: Navigational status, message 1/2/3 field 2. Carried into ``meta`` because on
#: this layer it is the field that says what a vessel is *doing* - four fifths
#: of them are stationary, and "moored" and "at anchor" and "aground" are three
#: very different reasons to be.
NAV_STATUS: dict[int, str] = {
    0: "Under way using engine",
    1: "At anchor",
    2: "Not under command",
    3: "Restricted manoeuvrability",
    4: "Constrained by draught",
    5: "Moored",
    6: "Aground",
    7: "Engaged in fishing",
    8: "Under way sailing",
    9: "Reserved (high speed craft)",
    10: "Reserved (wing in ground)",
    11: "Under tow astern",
    12: "Under tow alongside",
    13: "Reserved",
    14: "AIS-SART, MOB or EPIRB",
    15: "Undefined",
}

#: Ship type, from the tens digit of the AIS type code.
#:
#: The full table is a hundred entries of which most are "reserved"; the tens
#: digit is the part that carries meaning and the part a reader wants. 70-79 is
#: cargo, 80-89 tanker, 60-69 passenger, and so on.
SHIP_TYPE_BY_TENS: dict[int, str] = {
    2: "Wing in ground",
    3: "Special craft",
    4: "High speed craft",
    5: "Special craft",
    6: "Passenger",
    7: "Cargo",
    8: "Tanker",
    9: "Other",
}

#: The 30s and 50s are not one kind of thing, so they are spelled out.
SPECIAL_CRAFT: dict[int, str] = {
    30: "Fishing",
    31: "Towing",
    32: "Towing (long)",
    33: "Dredger",
    34: "Diving support",
    35: "Military",
    36: "Sailing",
    37: "Pleasure craft",
    50: "Pilot vessel",
    51: "Search and rescue",
    52: "Tug",
    53: "Port tender",
    54: "Anti-pollution",
    55: "Law enforcement",
    58: "Medical transport",
}


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
        lon = _number(coordinates[0])
        lat = _number(coordinates[1])
        mmsi = properties.get("mmsi")
        if lon is None or lat is None or not isinstance(mmsi, int):
            return None
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            # AIS transmits 91 and 181 for "position not available", and the
            # contract's own validators would raise on them - which would take
            # the whole poll down over one bad vessel.
            return None

        observed_ms = _number(properties.get("timestampExternal"))
        if observed_ms is None:
            return None

        static = self._metadata.get(mmsi, {})
        name = _text(static.get("name"))

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
            velocity=_speed_ms(properties.get("sog")),
            heading=_heading(properties),
            # The name when the feed knows it, the MMSI when it does not.
            # Never an empty string: this is what the map draws and what search
            # matches, and 13% of these vessels have no metadata row.
            label=name or str(mmsi),
            model=_ship_type(static.get("shipType")),
            last_seen=datetime.fromtimestamp(observed_ms / 1000.0, tz=timezone.utc),
            type=self.object_type,
            meta=_meta(properties, static),
        )

    async def aclose(self) -> None:
        await self._client.aclose()


def _speed_ms(value: Any) -> float | None:
    """Speed over ground in metres per second, or None.

    Refused above ``MAX_PLAUSIBLE_KNOTS`` rather than converted. See that
    constant: the AIS sentinel is only the loudest of the wrong answers here,
    and eleven vessels in one sample were faster than any ship has ever been
    without using it.
    """
    knots = _number(value)
    if knots is None or knots < 0 or knots > MAX_PLAUSIBLE_KNOTS:
        return None
    return knots * KNOTS_TO_MS


def _heading(properties: dict) -> float | None:
    """Which way the vessel is pointing, or moving, or None.

    **True heading first, course over ground second**, which is the opposite of
    the aircraft layer's preference and right for the same underlying reason:
    the field should describe the picture. A ship at anchor swings on its cable
    and has a heading but no course, and a ferry crossing a current points
    somewhere other than where it is going. Both are worth drawing accurately;
    an aircraft's track is the honest answer because an aeroplane does not hold
    station.

    511 and 360 are the two "not available" encodings, and between them they
    covered 230 of 916 vessels in one sample.
    """
    heading = _number(properties.get("heading"))
    if heading is not None and 0 <= heading < HEADING_UNAVAILABLE:
        return heading % 360.0
    course = _number(properties.get("cog"))
    if course is not None and 0 <= course < COG_UNAVAILABLE:
        return course
    return None


def _ship_type(code: Any) -> str | None:
    """What the source says this vessel is, in words.

    ``model`` promises "a designator the source chose", and the source chose a
    number from a hundred-entry table. The tens digit is the part that carries
    meaning - 70-79 cargo, 80-89 tanker - so it is read that way, except in the
    30s and 50s where the ones digit distinguishes a tug from a dredger from a
    warship, which nobody would thank us for flattening to "special craft".
    """
    if not isinstance(code, int) or isinstance(code, bool) or code <= 0 or code > 99:
        return None
    named = SPECIAL_CRAFT.get(code)
    if named is not None:
        return named
    return SHIP_TYPE_BY_TENS.get(code // 10)


def _meta(properties: dict, static: dict) -> dict[str, str]:
    """The facts a panel can show, none of them invented.

    Everything here is either passed through or converted with its unit named.
    Nothing is derived from a second source and nothing is guessed.
    """
    meta: dict[str, str] = {"mmsi": str(properties.get("mmsi"))}

    status = properties.get("navStat")
    if isinstance(status, int) and status in NAV_STATUS:
        meta["navigationStatus"] = NAV_STATUS[status]

    for key, name in (
        ("name", "vesselName"),
        ("callSign", "callSign"),
        ("destination", "destination"),
    ):
        value = _text(static.get(key))
        if value:
            meta[name] = value

    imo = static.get("imo")
    if isinstance(imo, int) and imo > 0:
        meta["imo"] = str(imo)

    ship_type = _ship_type(static.get("shipType"))
    if ship_type:
        meta["shipType"] = ship_type

    # Decimetres in the AIS message, which is a unit nobody thinks in.
    draught = _number(static.get("draught"))
    if draught is not None and draught > 0:
        meta["draught"] = f"{draught / 10:.1f} m"

    # The four reference points are distances from the transmitting antenna to
    # bow, stern, port and starboard - so the hull is A+B long and C+D wide.
    # Reported that way because a length is a fact about the ship and an
    # antenna offset is a fact about its wiring.
    bow = _number(static.get("referencePointA"))
    stern = _number(static.get("referencePointB"))
    port = _number(static.get("referencePointC"))
    starboard = _number(static.get("referencePointD"))
    if bow is not None and stern is not None and bow + stern > 0:
        meta["length"] = f"{bow + stern:.0f} m"
    if port is not None and starboard is not None and port + starboard > 0:
        meta["beam"] = f"{port + starboard:.0f} m"

    eta = _eta(static.get("eta"))
    if eta:
        meta["eta"] = eta
    return meta


def _eta(value: Any) -> str | None:
    """Estimated arrival, out of the bitfield AIS packs it into.

    Twenty bits: four of month, five of day, five of hour, six of minute, all
    UTC. Zero month or day means not stated, hour 24 and minute 60 likewise -
    and a vessel that has not set an ETA sends all of them, so the guards here
    are the common path rather than the edge.

    No year is transmitted, so none is claimed: the string says a day and a
    time and stops there.
    """
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        return None
    month = (value >> 16) & 0b1111
    day = (value >> 11) & 0b11111
    hour = (value >> 6) & 0b11111
    minute = value & 0b111111
    if not (1 <= month <= 12) or not (1 <= day <= 31):
        return None
    if hour > 23 or minute > 59:
        return None
    return f"{day:02d}/{month:02d} {hour:02d}:{minute:02d} UTC"


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _text(value: Any) -> str | None:
    """A non-empty trimmed string, or None.

    AIS pads static text to a fixed width with spaces and '@', so a vessel with
    no destination sends a field full of padding rather than an absent one.
    """
    if not isinstance(value, str):
        return None
    trimmed = value.replace("@", " ").strip()
    return trimmed or None
