"""Flight history for one selected aircraft, bought sparingly.

The store keeps what the poller has seen, which begins when we started
watching. For an aircraft selected mid-flight that is an arbitrary point in the
sky, and the detail panel has always had to say so. OpenSky will sell us the
real thing -- the flight's path from the runway -- for **4 credits a call**
(D78).

Four credits is nothing next to the 128 an hour the poller already spends, and
it is ruinous if it happens on every detail request: the client polls the
selected aircraft while it is selected, so an uncached fetch would turn one
user watching one flight into a request every few seconds and empty a day's
allowance in under an hour.

So the whole of this module is about *not* making that call:

- one flight in flight at a time per aircraft, so a burst of detail requests
  waits on a single upstream call rather than starting several;
- a positive result cached for two minutes, which is longer than a track grows
  in any way that matters;
- **a negative result cached for the same two minutes**, which is the part that
  is easy to leave out. A 404 is the common answer for an aircraft that has
  just appeared, and an uncached negative means paying repeatedly to be told
  nothing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

from app.airports import origin_of
from app.models import Airport, TrackedObjectDetail, TrackPoint, TrackSource
from app.providers.base import Provider, ProviderError

logger = logging.getLogger(__name__)

#: How long a fetched flight stays good.
#:
#: A track grows by one waypoint every few seconds, and the part of it that
#: matters -- where the flight began -- does not change at all. Two minutes
#: keeps a selected aircraft's line fresh enough to be honest while costing at
#: most 30 calls an hour for a user who never looks away.
FLIGHT_TTL_SECONDS = 120.0


@dataclass(frozen=True)
class Flight:
    """What the provider knows about one aircraft's current flight."""

    track: tuple[TrackPoint, ...]
    origin: Airport | None
    fetched_at: float


class FlightHistory:
    """Fetches and caches provider flight tracks, one aircraft at a time."""

    def __init__(self, provider: Provider, *, ttl_seconds: float = FLIGHT_TTL_SECONDS) -> None:
        self._provider = provider
        self._ttl = ttl_seconds
        self._cache: dict[str, Flight | None] = {}
        self._fetched_at: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def enrich(self, detail: TrackedObjectDetail) -> TrackedObjectDetail:
        """Return ``detail`` with the provider's track and origin, if there is one.

        Falls back to the detail exactly as given -- our own observed track,
        no origin -- whenever the provider has nothing, cannot say, or fails.
        **A provider failure must not fail the detail request**: the panel's
        other five fields are already in hand, and losing them because a
        secondary enrichment timed out would be a worse answer than a shorter
        line.
        """
        flight = await self._flight(detail.id)
        if flight is None or not flight.track:
            return detail
        return detail.model_copy(
            update={
                "track": flight.track,
                "track_source": TrackSource.PROVIDER,
                "origin": flight.origin,
            }
        )

    async def _flight(self, object_id: str) -> Flight | None:
        cached = self._cached(object_id)
        if cached is not _MISS:
            return cached  # type: ignore[return-value]

        lock = self._locks.setdefault(object_id, asyncio.Lock())
        async with lock:
            # Re-check under the lock: several detail requests can arrive while
            # the first is in flight, and every one of them would otherwise buy
            # its own copy of the same answer.
            cached = self._cached(object_id)
            if cached is not _MISS:
                return cached  # type: ignore[return-value]

            flight: Flight | None = None
            try:
                track = await self._provider.fetch_track(object_id)
            except ProviderError as exc:
                # Cached as a negative, deliberately. An upstream that is
                # refusing or rate-limiting will refuse the next request too,
                # and retrying immediately is how a quota is spent on failures.
                logger.info("flight track unavailable for %s: %s", object_id, exc)
                track = None
            if track:
                flight = Flight(track=track, origin=origin_of(track), fetched_at=time.monotonic())

            self._cache[object_id] = flight
            self._fetched_at[object_id] = time.monotonic()
            return flight

    def _cached(self, object_id: str) -> Flight | None | object:
        fetched = self._fetched_at.get(object_id)
        if fetched is None or time.monotonic() - fetched > self._ttl:
            return _MISS
        return self._cache.get(object_id)

    def forget(self, object_id: str) -> None:
        """Drop one aircraft's cached flight. Used by tests and by nothing else."""
        self._cache.pop(object_id, None)
        self._fetched_at.pop(object_id, None)
        self._locks.pop(object_id, None)


#: Distinguishes "cached as nothing" from "not cached", which a plain None cannot.
_MISS = object()
