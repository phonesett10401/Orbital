"""Turning orbital elements into positions.

The counterpart to ``geo.py``, which does spherical geometry for aircraft. This
module does the one thing the aircraft layer never needed: it *computes* where
something is, rather than being told.

That inversion is the whole character of the satellite layer (D93). An aircraft
position is an observation with a timestamp, and its accuracy is a property of
the observer. A satellite position is the output of a model -- SGP4 -- run on
element sets that were measured hours or days ago, and its accuracy is a
property of *how old those elements are*. SGP4 degrades by roughly a kilometre
a day from epoch and it degrades **silently**: handed a set from 1975 it
returns a confidently formatted, entirely wrong answer. Nothing in the output
says so, which is why ``MAX_ELEMENT_AGE_DAYS`` exists and is enforced at
ingestion rather than left to the caller.

The conversion out of SGP4's frame is the other place this goes quietly wrong.
The propagator answers in TEME -- an inertial frame, fixed against the stars --
and a latitude/longitude is in a frame fixed to the ground. Between them sits
the Earth's rotation angle. Omitting it produces coordinates that look entirely
plausible: right altitude, right speed, a ground track of the right shape, and
a longitude wrong by up to 180 degrees. See ``test_orbits.py`` for the check
that catches it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sgp4.api import SGP4_ERRORS, Satrec, jday
from sgp4.propagation import gstime

#: WGS84, the same ellipsoid the aircraft layer's coordinates are on.
WGS84_A_KM = 6378.137
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)

#: Drop element sets older than this before propagating anything.
#:
#: Seven days is a compromise between the two ways of being wrong. Too tight
#: and a source that updates a quiet satellite weekly loses it entirely; too
#: loose and we draw confident nonsense. Measured against a real SatNOGS pull
#: on 2026-09-01: of 1,670 sets, 1,436 were within seven days, 87 were over a
#: *year* old, and the oldest was from 1975 (D94).
MAX_ELEMENT_AGE_DAYS = 7.0


class OrbitError(Exception):
    """An element set that cannot be used, with a reason worth logging."""


@dataclass(frozen=True)
class Position:
    """Where an object is, and how much to trust it.

    ``element_age_days`` travels with the position because it is the only
    honest measure of accuracy available, and because the panel shows it. It is
    deliberately not folded into ``lastSeen``: that field means "when was this
    position current", and the answer for a computed position is *now* (D94).
    """

    lat: float
    lon: float
    altitude_m: float
    speed_m_s: float
    heading_deg: float
    element_age_days: float


def parse_epoch(epoch: str) -> datetime:
    """Read an OMM ``EPOCH`` string, which is ISO 8601 without a zone.

    CelesTrak and SatNOGS both emit UTC here and neither marks it. A naive
    datetime reaching the model layer breaks every staleness comparison
    silently, so the zone is attached at the boundary.
    """
    text = epoch.strip().replace("Z", "")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:  # pragma: no cover - malformed upstream
        raise OrbitError(f"unparseable epoch {epoch!r}") from exc
    return parsed.replace(tzinfo=timezone.utc)


def tle_epoch(line1: str) -> datetime:
    """Read the epoch out of TLE line 1, columns 19-32.

    The two-digit year uses the TLE convention rather than the obvious one:
    57-99 mean 1957-1999 and 00-56 mean 2000-2056. Reading it as "always
    20xx" turns a 1975 element set into a 2075 one, which is not merely wrong
    but wrong in the direction that makes a stale set look fresh.
    """
    try:
        raw = line1[18:32]
        yy = int(raw[:2])
        day_of_year = float(raw[2:])
    except (ValueError, IndexError) as exc:
        raise OrbitError(f"unreadable TLE epoch in {line1[:34]!r}") from exc
    year = 2000 + yy if yy < 57 else 1900 + yy
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1.0)


def teme_to_geodetic(
    position_km: tuple[float, float, float], julian_day: float, fraction: float
) -> tuple[float, float, float]:
    """TEME position -> (latitude, longitude, altitude in metres) on WGS84.

    The rotation into an Earth-fixed frame is the Greenwich mean sidereal time.
    Latitude then comes from the standard iteration; it converges to well under
    a metre in a handful of passes for anything outside the planet.
    """
    x, y, z = position_km
    theta = gstime(julian_day + fraction)
    lon = math.atan2(y, x) - theta
    lon = (lon + math.pi) % (2.0 * math.pi) - math.pi

    p = math.hypot(x, y)
    lat = math.atan2(z, p)
    for _ in range(8):
        sin_lat = math.sin(lat)
        c = WGS84_A_KM / math.sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat)
        lat = math.atan2(z + c * WGS84_E2 * sin_lat, p)

    sin_lat = math.sin(lat)
    c = WGS84_A_KM / math.sqrt(1.0 - WGS84_E2 * sin_lat * sin_lat)
    altitude_km = p / math.cos(lat) - c

    return math.degrees(lat), math.degrees(lon), altitude_km * 1000.0


def _ground_heading(
    position_km: tuple[float, float, float],
    velocity_km_s: tuple[float, float, float],
    lat_deg: float,
    lon_deg: float,
    theta: float,
) -> float:
    """Direction of travel over the ground, degrees clockwise from true north.

    The renderer refuses to draw an oriented model for an object with no
    heading (D18, D40, D42), so this is what earns a satellite a shape rather
    than a disc. Both vectors are rotated into the Earth-fixed frame first --
    using the inertial velocity directly would point every object slightly east
    of where it is really going, by the speed of the ground beneath it.
    """
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)

    # Earth-fixed velocity = inertial velocity minus the frame's own rotation.
    omega = 7.2921159e-5  # rad/s
    vx, vy, vz = velocity_km_s
    x, y, _z = position_km
    vx_ecef = vx + omega * y
    vy_ecef = vy - omega * x

    # Rotate into the same frame the latitude and longitude are in.
    vx_f = vx_ecef * math.cos(theta) + vy_ecef * math.sin(theta)
    vy_f = -vx_ecef * math.sin(theta) + vy_ecef * math.cos(theta)

    east = -math.sin(lon) * vx_f + math.cos(lon) * vy_f
    north = (
        -math.sin(lat) * math.cos(lon) * vx_f
        - math.sin(lat) * math.sin(lon) * vy_f
        + math.cos(lat) * vz
    )
    return math.degrees(math.atan2(east, north)) % 360.0


def propagate(
    line1: str, line2: str, when: datetime, *, epoch: datetime | None = None
) -> Position:
    """Where this element set says the object is at ``when``.

    ``epoch`` may be supplied when the source gave it separately (OMM does);
    otherwise it is read out of the TLE.

    Raises:
        OrbitError: if the elements are unusable, too old to trust, or the
            propagator itself reports a failure. Refusing is deliberate --
            SGP4 returns a plausible-looking answer for a decayed or absurd
            orbit, and a caller cannot tell the difference from the numbers.
    """
    when = when.astimezone(timezone.utc)
    element_epoch = epoch or tle_epoch(line1)
    age_days = (when - element_epoch).total_seconds() / 86400.0

    if abs(age_days) > MAX_ELEMENT_AGE_DAYS:
        raise OrbitError(
            f"element set is {age_days:.1f} days from epoch, beyond the "
            f"{MAX_ELEMENT_AGE_DAYS:.0f}-day limit"
        )

    try:
        satellite = Satrec.twoline2rv(line1, line2)
    except Exception as exc:  # pragma: no cover - malformed upstream
        raise OrbitError(f"unreadable element set: {exc}") from exc

    julian_day, fraction = jday(
        when.year, when.month, when.day,
        when.hour, when.minute, when.second + when.microsecond / 1e6,
    )
    code, position_km, velocity_km_s = satellite.sgp4(julian_day, fraction)
    if code != 0:
        raise OrbitError(SGP4_ERRORS.get(code, f"propagator error {code}"))

    lat, lon, altitude_m = teme_to_geodetic(position_km, julian_day, fraction)
    if altitude_m <= 0.0:
        # Below the ellipsoid means the object has re-entered or the elements
        # are nonsense. Either way there is nothing to draw.
        raise OrbitError(f"propagated below the surface ({altitude_m / 1000:.0f} km)")

    theta = gstime(julian_day + fraction)
    return Position(
        lat=lat,
        lon=lon,
        altitude_m=altitude_m,
        speed_m_s=math.sqrt(sum(c * c for c in velocity_km_s)) * 1000.0,
        heading_deg=_ground_heading(position_km, velocity_km_s, lat, lon, theta),
        element_age_days=age_days,
    )
