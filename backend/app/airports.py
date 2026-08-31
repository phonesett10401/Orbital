"""Where a flight started, from where its track begins.

OpenSky's ``/tracks/all`` hands back a flight's path, and its first waypoint is
usually sitting on a runway: for RXA6681 the track began at -33.9533, 151.1776,
which is 800 m from Sydney Kingsford Smith. So the departure airport does not
need asking for separately -- it can be read off the track.

**That matters because asking is expensive.** ``/flights/aircraft`` returns an
authoritative ICAO code and costs **30 credits** against the same 4000/day
allowance, and it answered 404 for two of the three aircraft it was tried on,
because OpenSky's flight assignment lags well behind its position data.
``/tracks/all`` costs **4** and answered for all three. Measured, not assumed
(D78).

The trade is that a nearest-airport match is an *inference*. This module is
built so that inference is conservative and legible: a hard distance limit, no
answer at all when nothing is close enough, and the distance kept so the client
can say how sure we are.
"""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Iterable

import airportsdata

from app.geo import haversine_metres
from app.models import Airport

#: How close a track's first point must be to an airport to be called its origin.
#:
#: 8 km sounds generous for an aeroplane sitting on a runway, and it is chosen
#: for the case where it is not: OpenSky's first sample can arrive seconds after
#: rotation, by which time a departing airliner is a few kilometres out and
#: climbing. Tighter than this loses real departures; looser starts claiming
#: that a flight passing over a town began at its airfield.
ORIGIN_MAX_KM = 8.0

#: Above this, the aircraft is flying rather than departing.
#:
#: Without it, an overflight at cruise directly above an airport reads as a
#: departure from it. 1500 m is above a normal circuit and far below cruise.
ORIGIN_MAX_ALTITUDE_M = 1500.0


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres, which is how airports read."""
    return haversine_metres(lat1, lon1, lat2, lon2) / 1000.0


@lru_cache(maxsize=1)
def _index() -> dict[tuple[int, int], tuple[tuple[str, dict], ...]]:
    """Airports bucketed into one-degree cells.

    28,291 airports is small enough to scan linearly, and a linear scan per
    selected aircraft is still 28,291 haversines for an answer that is always
    within one cell of the query. The buckets turn it into a few dozen.

    Built once, lazily: a module that is imported and never used should not
    cost anything.
    """
    buckets: dict[tuple[int, int], list[tuple[str, dict]]] = {}
    for code, row in airportsdata.load("ICAO").items():
        key = (int(math.floor(row["lat"])), int(math.floor(row["lon"])))
        buckets.setdefault(key, []).append((code, row))
    return {key: tuple(value) for key, value in buckets.items()}


def _candidates(lat: float, lon: float) -> Iterable[tuple[str, dict]]:
    """Every airport in the query's cell and the eight around it.

    One degree of latitude is 111 km and the search radius is 8, so the
    neighbours only matter when the query sits near a cell edge -- which is
    precisely the case a naive single-cell lookup gets wrong, and it gets it
    wrong silently.
    """
    index = _index()
    base_lat = int(math.floor(lat))
    base_lon = int(math.floor(lon))
    for d_lat in (-1, 0, 1):
        for d_lon in (-1, 0, 1):
            # Longitude wraps: a query at 179.9 must see the cell at -180.
            key = (base_lat + d_lat, ((base_lon + d_lon + 180) % 360) - 180)
            yield from index.get(key, ())


def nearest_airport(lat: float, lon: float, *, max_km: float = ORIGIN_MAX_KM) -> Airport | None:
    """The closest airport within ``max_km``, or None.

    None is a real answer and the common one for a track that begins in mid-air
    -- OpenSky picking a flight up over the ocean, or an aircraft already
    airborne when its transponder was first heard. Naming the nearest airport
    anyway would turn "we do not know where this started" into a confident and
    wrong claim, which is the same rule the contract applies to a null heading
    (D18).
    """
    best: Airport | None = None
    best_km = max_km
    for code, row in _candidates(lat, lon):
        distance = haversine_km(lat, lon, row["lat"], row["lon"])
        if distance <= best_km:
            best_km = distance
            best = Airport(
                icao=code,
                name=row["name"],
                lat=row["lat"],
                lon=row["lon"],
                country=row["country"] or None,
                # The same two fields a scheduled airport carries (D88), from
                # the same table, so the two origins are directly comparable
                # rather than one being conspicuously thinner than the other.
                municipality=row["city"] or None,
                iata=row["iata"] or None,
                distance_km=round(distance, 2),
            )
    return best


def origin_of(track: "Iterable[object]") -> Airport | None:
    """The airport a track departed from, if it plainly departed from one.

    Takes the first waypoint only. A flight's track is ordered oldest first, so
    the first sample is the earliest position anyone has of it -- on the runway
    if OpenSky saw the take-off, and somewhere over the sea if it did not.
    """
    first = next(iter(track), None)
    if first is None:
        return None
    altitude = getattr(first, "altitude", None)
    if altitude is not None and altitude > ORIGIN_MAX_ALTITUDE_M:
        return None
    return nearest_airport(getattr(first, "lat"), getattr(first, "lon"))


@lru_cache(maxsize=1)
def _searchable() -> tuple[tuple[str, str, str, str, dict], ...]:
    """Every airport with its match keys pre-upper-cased.

    Built once. Upper-casing 28,291 rows on each keystroke is the kind of work
    that is invisible at a desk and obvious on a phone, and the table never
    changes, so there is no reason to do it more than once.

    Airports with neither an ICAO nor an IATA code are dropped: a result the
    user cannot identify is not a result.
    """
    rows = []
    for code, row in airportsdata.load("ICAO").items():
        iata = (row["iata"] or "").upper()
        rows.append((code.upper(), iata, (row["name"] or "").upper(), (row["city"] or "").upper(), row))
    return tuple(rows)


def search_airports(query: str, *, limit: int = 8) -> list[Airport]:
    """Airports whose code, name or city matches ``query``.

    **Codes before names.** Someone typing "LHR" wants Heathrow, not the first
    airport whose description happens to contain those three letters; someone
    typing "London" wants a list of London's airports. So an exact code match
    ranks first, then a code prefix, then a city or name prefix, then anything
    containing the string.

    ``distance_km`` is left unset, as it is for a scheduled airport (D88):
    there is no point to measure from. A search result is a place, not an
    observation.
    """
    needle = query.strip().upper()
    if not needle:
        return []

    tiers: tuple[list[tuple[int, Airport]], ...] = ([], [], [], [])
    for icao, iata, name, city, row in _searchable():
        if needle in (icao, iata):
            tier = 0
        elif icao.startswith(needle) or iata.startswith(needle):
            tier = 1
        elif _starts_a_word(city, needle) or _starts_a_word(name, needle):
            tier = 2
        elif needle in name or needle in city:
            tier = 3
        else:
            continue
        tiers[tier].append(
            (
                # Within a tier, airports with an IATA code first. The table
                # holds 28,291 airports and most of them are farm strips; "the
                # one with a scheduled service" is the only proxy for "the one
                # you meant" available here, and without it a search for London
                # answers with two private airfields before Heathrow.
                0 if iata else 1,
                Airport(
                    icao=icao,
                    name=row["name"],
                    lat=row["lat"],
                    lon=row["lon"],
                    country=row["country"] or None,
                    municipality=row["city"] or None,
                    iata=row["iata"] or None,
                ),
            )
        )

    ranked = [
        airport
        for tier in tiers
        for _, airport in sorted(tier, key=lambda pair: (pair[0], pair[1].icao))
    ]
    return ranked[:limit]


def _starts_a_word(haystack: str, needle: str) -> bool:
    """Whether ``needle`` begins ``haystack`` or any word inside it.

    Matching only the whole string would rank an airfield literally named
    "Heathrow" above London Heathrow, whose name begins with "London". People
    search for the distinctive word, wherever it sits in the name.
    """
    return any(word.startswith(needle) for word in haystack.split())
