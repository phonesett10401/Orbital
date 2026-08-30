"""Where a callsign is scheduled to fly, from adsbdb.

**This is the only source of a destination anywhere in Orbital.** No position
feed carries one, because an aircraft does not transmit where it is going: a
state vector says where something is, not what it intends. Every "DXB - HAN"
you see on a flight tracker comes from a schedule database, and this is ours.

adsbdb is free, needs no key, and answered **14 of 20** live callsigns taken
straight from the store (D88). It also gives the operator's name outright,
where our own airline decode is an inference from the callsign prefix (D46).

## What it is not

**Scheduled, not observed.** It is keyed by callsign, so it describes what that
callsign is published as flying rather than what this aircraft is provably
doing today. A diversion, a callsign reused for a different sector, or a stale
community entry all produce a confident wrong answer, which is why it is a
separate field from the `origin` inferred from the aircraft's own track (D78)
rather than replacing it. Where both exist and agree, that is corroboration;
where they disagree, the client shows the observed one and says so.

## Bought like the flight track

One request per aircraft *selected*, never on a poll, cached for hours because
a schedule does not change during a flight - and **cached when it fails too**,
since 30% of callsigns have no published route and asking again every few
seconds would be rude to a free service for no possible gain.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

from app.models import Airport, FlightRoute, TrackedObjectDetail

logger = logging.getLogger(__name__)

#: How long a looked-up route stays good.
#:
#: Six hours: a schedule does not change while an aircraft is in the air, and
#: the same callsign flies the same sector day after day. The cache exists to
#: keep us from asking a free service the same question repeatedly, not to
#: track anything that moves.
ROUTE_TTL_SECONDS = 6 * 60 * 60


@dataclass(frozen=True)
class _Entry:
    route: FlightRoute | None
    fetched_at: float


class FlightRoutes:
    """Looks up and caches scheduled routes by callsign."""

    def __init__(
        self,
        *,
        base_url: str = "https://api.adsbdb.com/v0",
        timeout_seconds: float = 10.0,
        user_agent: str = "Orbital/0.1 (CSC480 student project)",
        ttl_seconds: float = ROUTE_TTL_SECONDS,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._ttl = ttl_seconds
        self._client = client or httpx.AsyncClient(
            timeout=timeout_seconds, headers={"User-Agent": user_agent}
        )
        self._cache: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def enrich(self, detail: TrackedObjectDetail) -> TrackedObjectDetail:
        """Attach the scheduled route, if this callsign has one.

        Returns the detail untouched when there is no callsign, no published
        route, or the service cannot be reached. **A lookup failure must never
        fail the request**: the route is the least important thing in the panel
        and the aircraft is already fully described without it.
        """
        callsign = (detail.label or "").strip().upper()
        if not callsign:
            return detail
        route = await self._route(callsign)
        if route is None:
            return detail
        return detail.model_copy(update={"route": route})

    async def _route(self, callsign: str) -> FlightRoute | None:
        cached = self._cache.get(callsign)
        if cached is not None and time.monotonic() - cached.fetched_at < self._ttl:
            return cached.route

        lock = self._locks.setdefault(callsign, asyncio.Lock())
        async with lock:
            cached = self._cache.get(callsign)
            if cached is not None and time.monotonic() - cached.fetched_at < self._ttl:
                return cached.route

            route: FlightRoute | None = None
            try:
                response = await self._client.get(f"{self.base_url}/callsign/{callsign}")
                if response.status_code == 200:
                    route = _parse(response.json())
                elif response.status_code != 404:
                    logger.info("adsbdb answered %s for %s", response.status_code, callsign)
            except (httpx.HTTPError, ValueError) as exc:
                logger.info("adsbdb lookup failed for %s: %s", callsign, exc)

            # Cached either way. A 404 means "no published route", which is the
            # answer for roughly three callsigns in ten and will not change in
            # the next six hours.
            self._cache[callsign] = _Entry(route=route, fetched_at=time.monotonic())
            return route

    async def aclose(self) -> None:
        await self._client.aclose()


def _parse(payload: object) -> FlightRoute | None:
    """Read adsbdb's answer, or None if it is not one.

    Every field is optional on the way in. The service is a community database
    and its rows are uneven: a route with an airline and no destination is
    common, and half an answer is still worth showing.
    """
    if not isinstance(payload, dict):
        return None
    # `response` is a *string* on the unknown-callsign path -- literally
    # {"response": "unknown callsign"} -- so it cannot be assumed to be a dict
    # just because the body parsed.
    response = payload.get("response")
    if not isinstance(response, dict):
        return None
    flightroute = response.get("flightroute")
    if not isinstance(flightroute, dict):
        return None

    airline = flightroute.get("airline")
    name = airline.get("name") if isinstance(airline, dict) else None
    origin = _airport(flightroute.get("origin"))
    destination = _airport(flightroute.get("destination"))
    if name is None and origin is None and destination is None:
        return None
    return FlightRoute(airline=name, origin=origin, destination=destination)


def _airport(raw: object) -> Airport | None:
    """One end of a route.

    `distance_km` is deliberately left unset: it means "how far the track's
    first point was from here" (D78), and a scheduled airport has nothing to be
    near. Filling it with zero would claim a measurement nobody made.
    """
    if not isinstance(raw, dict):
        return None
    icao = raw.get("icao_code")
    name = raw.get("name")
    lat = raw.get("latitude")
    lon = raw.get("longitude")
    if not isinstance(icao, str) or not isinstance(name, str):
        return None
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return None
    return Airport(
        icao=icao,
        name=name,
        lat=float(lat),
        lon=float(lon),
        country=raw.get("country_iso_name") or None,
        municipality=raw.get("municipality") or None,
        iata=raw.get("iata_code") or None,
    )
