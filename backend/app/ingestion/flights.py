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
from app.geo import haversine_metres, initial_bearing
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


#: The widest gap between two waypoints that still gives an instantaneous course.
#:
#: The provider's track samples every six seconds, so the bearing between two
#: consecutive waypoints *is* the direction the aircraft is pointing. Our own
#: polling is 90 to 300 seconds apart, where the same arithmetic measures the
#: chord of whatever the aircraft did in between - which is why this correction
#: lives here and not in the store (D80).
COURSE_MAX_GAP_SECONDS = 30.0

#: How far apart those two waypoints must be, so the bearing is not position noise.
COURSE_MIN_MOVEMENT_M = 200.0

#: How far the reported heading must be out before the track overrules it.
#:
#: Measured across 3,641 aircraft over western Europe: the median disagreement
#: between a reported heading and the course actually flown is **0.3 degrees**,
#: so the feed is normally excellent and a correction should be rare. 5.6%
#: disagree by more than 30 degrees over a two-minute gap, but most of those
#: are aircraft that turned rather than feeds that lied - which is exactly the
#: ambiguity a six-second gap removes (D80).
COURSE_MAX_DISAGREEMENT_DEG = 30.0


@dataclass(frozen=True)
class Flight:
    """What the provider knows about one aircraft's current flight."""

    track: tuple[TrackPoint, ...]
    origin: Airport | None
    fetched_at: float


def course_from_track(track: tuple[TrackPoint, ...]) -> float | None:
    """The direction of travel at the end of a track, or None.

    Walks backwards for the most recent pair of waypoints close enough in time
    to be an instantaneous course and far enough apart in space to be a
    measurement rather than noise. Backwards because the *last* gap is often
    the long one: the track ends at the provider's most recent sample, which
    may be minutes old even when the samples before it are seconds apart.
    """
    for index in range(len(track) - 1, 0, -1):
        later, earlier = track[index], track[index - 1]
        gap = (later.timestamp - earlier.timestamp).total_seconds()
        if gap <= 0 or gap > COURSE_MAX_GAP_SECONDS:
            continue
        if haversine_metres(earlier.lat, earlier.lon, later.lat, later.lon) < COURSE_MIN_MOVEMENT_M:
            continue
        return initial_bearing(earlier.lat, earlier.lon, later.lat, later.lon)
    return None


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

        update: dict[str, object] = {
            "track": flight.track,
            "track_source": TrackSource.PROVIDER,
            "origin": flight.origin,
        }

        # A heading that contradicts the aircraft's own track loses to it. The
        # 777 that started this reported 12 m/s on a heading of 7 degrees while
        # crossing Myanmar eastbound at cruise, and the marker pointed north
        # while its own line ran east (D80).
        course = course_from_track(flight.track)
        if (
            course is not None
            and detail.heading is not None
            and abs((course - detail.heading + 540.0) % 360.0 - 180.0)
            > COURSE_MAX_DISAGREEMENT_DEG
        ):
            # Said out loud rather than corrected silently: every other number
            # in the panel is the source's own, and one that is not should be
            # identifiable.
            meta = dict(detail.meta)
            meta["headingSource"] = "derived"
            update["heading"] = course
            update["meta"] = meta

        return detail.model_copy(update=update)

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
