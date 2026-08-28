"""Small spherical-geometry helpers.

Orbital treats the Earth as a sphere, not the WGS84 ellipsoid. The error is
roughly 0.3%, which at the distance an aircraft travels between two polls is a
few metres -- far below one screen pixel at globe zoom. Using the ellipsoid
would cost accuracy we cannot see and complexity we would have to defend.
"""

from __future__ import annotations

import math

#: Mean Earth radius in metres (IUGG).
EARTH_RADIUS_M = 6_371_008.8


def destination_point(
    lat: float, lon: float, heading_deg: float, distance_m: float
) -> tuple[float, float]:
    """Project a position forward along a great circle.

    This is the dead-reckoning step: given where something was, which way it
    was pointing and how fast, work out where it is now. Used by the fixture
    provider to animate offline data, and mirrored on the frontend to move
    markers smoothly between polls.

    Returns (lat, lon) in degrees, with longitude wrapped to [-180, 180).
    """
    if distance_m == 0.0:
        return lat, lon

    angular = distance_m / EARTH_RADIUS_M
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    bearing = math.radians(heading_deg)

    sin_lat1, cos_lat1 = math.sin(lat1), math.cos(lat1)
    sin_ang, cos_ang = math.sin(angular), math.cos(angular)

    sin_lat2 = sin_lat1 * cos_ang + cos_lat1 * sin_ang * math.cos(bearing)
    # Clamp against floating-point drift just outside [-1, 1], which would make
    # asin raise for a perfectly valid input.
    sin_lat2 = max(-1.0, min(1.0, sin_lat2))
    lat2 = math.asin(sin_lat2)

    lon2 = lon1 + math.atan2(
        math.sin(bearing) * sin_ang * cos_lat1,
        cos_ang - sin_lat1 * sin_lat2,
    )

    return math.degrees(lat2), wrap_longitude(math.degrees(lon2))


def initial_bearing(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """The compass course from one point to another, in degrees from true north.

    "Initial" is the operative word: along a great circle the course changes
    continuously as the meridians converge, so this is the bearing *at the
    first point*, not for the whole path. An aircraft leaving China on 323
    degrees is flying 255 by the time it reaches Russia, having turned nowhere
    (D66).

    Returns degrees in [0, 360).
    """
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta = math.radians(lon2 - lon1)

    y = math.sin(delta) * math.cos(phi2)
    x = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(delta)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def wrap_longitude(lon: float) -> float:
    """Wrap any longitude into [-180, 180).

    Dead reckoning across the Pacific produces values like 187.4; left
    unwrapped they fail model validation and the object silently disappears.
    """
    return (lon + 180.0) % 360.0 - 180.0
