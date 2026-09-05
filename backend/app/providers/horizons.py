"""Spacecraft in orbit around the Moon, from JPL Horizons (D134).

This is the third data path in Orbital and it resembles neither of the others.

Aircraft come from a feed that answers "where is everything now" and costs
money per question. Satellites come from orbital elements propagated locally by
SGP4, which costs nothing. **Lunar spacecraft can do neither.** There are no
TLEs for them - the format and SGP4 itself are Earth-orbit only, and a TLE
cannot express an orbit around another body - so no amount of local propagation
will produce one. What exists instead is an ephemeris: a table of where the
spacecraft *will be*, computed by the people who fly it.

So this provider fetches a window of the future, keeps it, and reads positions
out of it. Between refreshes it needs nothing, and an outage upstream is not an
outage here until the window runs out - the same property the satellite layer
has, arrived at from the opposite direction.

## What is actually up there

Checked against Horizons on 2026-09-05 rather than taken from a list, because
this is a question with a moving answer and a wrong entry would draw a
spacecraft that is not there:

| spacecraft | Horizons id | altitude then |
|---|---|---|
| LRO | -85 | 105 km |
| Danuri (KPLO) | -155 | 161 km |
| Chandrayaan-2 Orbiter | -152 | 106 km |

Two candidates were **excluded by measurement**, which is the part worth
keeping. CAPSTONE returns "No ephemeris after 2026-AUG-14" - its published
ephemeris stops three weeks before today, so drawing it would be inventing a
position. ARTEMIS P1 and P2 (-192, -193) cannot be used as an observer centre
at all: Horizons wants a station file it does not have.

## Why the query is shaped this way

The app needs a **selenographic** latitude and longitude - where on the Moon's
surface the spacecraft is - and an altitude. Asking for the spacecraft's
position as a vector gives neither without doing the Moon's rotation and
libration, which is a serious piece of work and easy to get subtly wrong.

Horizons will do it. Asking for the **Moon as seen from the spacecraft** and
requesting quantity 14, the sub-observer point, returns exactly the point on
the Moon directly beneath the craft, in the Moon's own body-fixed frame, with
libration already accounted for. Quantity 20 adds the range, and the altitude
is that minus the Moon's radius. The frame problem is solved by asking the
question the other way round.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

logger = logging.getLogger(__name__)

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"

#: The Moon's IAU radius, which is what Horizons' range is measured from.
MOON_RADIUS_KM = 1737.4

#: Kilometres in an astronomical unit. Horizons reports range in AU.
AU_KM = 149_597_870.7


@dataclass(frozen=True)
class LunarCraft:
    """One spacecraft, with the id Horizons knows it by."""

    horizons_id: str
    name: str
    operator: str
    #: What it is for, in one line, for the panel.
    purpose: str


#: Verified against Horizons on 2026-09-05. See the module docstring for the
#: two that were excluded and why.
LUNAR_CRAFT: tuple[LunarCraft, ...] = (
    LunarCraft(
        "-85",
        "LRO",
        "NASA",
        "Mapping the Moon since 2009 - the longest-lived lunar orbiter.",
    ),
    LunarCraft(
        "-155",
        "Danuri",
        "KARI",
        "Korea's first Moon mission, carrying NASA's ShadowCam.",
    ),
    LunarCraft(
        "-152",
        "Chandrayaan-2 Orbiter",
        "ISRO",
        "Still working after its lander was lost in 2019.",
    ),
)


class HorizonsError(RuntimeError):
    """Horizons answered, but not with an ephemeris."""


@dataclass(frozen=True)
class EphemerisRow:
    """One instant of one spacecraft's track over the Moon."""

    when: datetime
    #: Selenographic east longitude, normalised to -180..180 for the frontend.
    lon: float
    lat: float
    altitude_km: float


def ephemeris_params(
    horizons_id: str,
    start: datetime,
    stop: datetime,
    step_minutes: int,
) -> dict[str, str]:
    """The query for one spacecraft's sub-surface track.

    ``COMMAND`` is the Moon and ``CENTER`` is the spacecraft, which is the
    inversion the module docstring explains: it makes Horizons return the
    sub-observer point in the Moon's body-fixed frame instead of leaving us to
    rotate an inertial vector ourselves.
    """
    start_text = start.strftime("%Y-%m-%d %H:%M")
    stop_text = stop.strftime("%Y-%m-%d %H:%M")
    return {
        "format": "text",
        "COMMAND": "'301'",
        "CENTER": "'@" + horizons_id + "'",
        "EPHEM_TYPE": "OBSERVER",
        # 14 is the sub-observer point, 20 is range and range-rate.
        "QUANTITIES": "'14,20'",
        "START_TIME": "'" + start_text + "'",
        "STOP_TIME": "'" + stop_text + "'",
        "STEP_SIZE": "'" + str(step_minutes) + " m'",
    }


def normalise_longitude(degrees: float) -> float:
    """Horizons reports east longitude 0..360; the map wants -180..180."""
    wrapped = (degrees + 180.0) % 360.0 - 180.0
    # -180 and 180 are the same meridian; prefer the positive form so a track
    # crossing it does not flicker between the two.
    return 180.0 if wrapped == -180.0 else wrapped


def parse_ephemeris(text: str) -> list[EphemerisRow]:
    """Rows between Horizons' ``$$SOE`` and ``$$EOE`` markers.

    Horizons wraps its data in a long header that changes between releases, so
    the markers are the contract rather than a line count. A response with no
    markers is an error message - "No ephemeris for target" arrives as a 200 -
    and is raised rather than returned as an empty track, because an empty
    track would render as a spacecraft that quietly vanished.
    """
    if "$$SOE" not in text or "$$EOE" not in text:
        raise HorizonsError(_explain(text))

    body = text.split("$$SOE", 1)[1].split("$$EOE", 1)[0]
    rows: list[EphemerisRow] = []
    for line in body.splitlines():
        fields = line.split()
        # date, time, sub-observer longitude, latitude, range, range-rate
        if len(fields) < 5:
            continue
        try:
            stamp = datetime.strptime(
                fields[0] + " " + fields[1], "%Y-%b-%d %H:%M"
            ).replace(tzinfo=timezone.utc)
            lon = float(fields[2])
            lat = float(fields[3])
            delta_au = float(fields[4])
        except ValueError:
            # Horizons marks some rows with solar-presence letters and other
            # annotations; a row that will not parse is skipped rather than
            # failing the whole window.
            continue
        rows.append(
            EphemerisRow(
                when=stamp,
                lon=normalise_longitude(lon),
                lat=lat,
                altitude_km=delta_au * AU_KM - MOON_RADIUS_KM,
            )
        )
    if not rows:
        raise HorizonsError("Horizons returned an ephemeris with no readable rows")
    return rows


def _explain(text: str) -> str:
    """The upstream's own words, so a failure says what Horizons said."""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(("No ephemeris", "No matches", "Cannot", "getbody()")):
            return stripped[:200]
    return "Horizons returned no ephemeris block"


def shortest_arc(from_deg: float, to_deg: float) -> float:
    """The signed step from one longitude to another, the short way round.

    Without this a track crossing the antimeridian interpolates backwards
    across the entire Moon: 179 to -179 is two degrees, not -358.
    """
    return (to_deg - from_deg + 180.0) % 360.0 - 180.0


def interpolate(rows: list[EphemerisRow], when: datetime) -> EphemerisRow | None:
    """The position between two rows, or None if the window does not cover it.

    None rather than the nearest row: past the end of a window the honest
    answer is that we do not know yet, and a spacecraft frozen at its last
    sample looks exactly like one that is still being tracked.
    """
    if not rows:
        return None
    if when < rows[0].when or when > rows[-1].when:
        return None

    for earlier, later in zip(rows, rows[1:]):
        if earlier.when <= when <= later.when:
            span = (later.when - earlier.when).total_seconds()
            if span <= 0:
                return earlier
            t = (when - earlier.when).total_seconds() / span
            return EphemerisRow(
                when=when,
                lon=normalise_longitude(
                    earlier.lon + shortest_arc(earlier.lon, later.lon) * t
                ),
                lat=earlier.lat + (later.lat - earlier.lat) * t,
                altitude_km=earlier.altitude_km
                + (later.altitude_km - earlier.altitude_km) * t,
            )
    return rows[-1]


async def fetch_ephemeris(
    client: httpx.AsyncClient,
    craft: LunarCraft,
    start: datetime,
    stop: datetime,
    step_minutes: int,
) -> list[EphemerisRow]:
    """One spacecraft's window, from Horizons."""
    response = await client.get(
        HORIZONS_URL,
        params=ephemeris_params(craft.horizons_id, start, stop, step_minutes),
    )
    response.raise_for_status()
    return parse_ephemeris(response.text)
