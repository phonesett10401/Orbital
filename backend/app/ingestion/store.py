"""The in-memory cache: latest position per object, plus observed track history.

This is the only mutable state in the backend, and the reason an OpenSky outage
cannot reach the browser. A failed poll never calls into here, so the last good
data simply stays.

Two design points worth understanding:

**It merges, it does not replace.** With two-tier polling (D21) results arrive
from different jobs at different times covering different areas. Replacing the
whole snapshot on each poll would mean the 45-second viewport poll erased every
aircraft outside the viewport. So objects are upserted by id and expire on
their own schedule.

**It keeps per-object history.** That history *is* the route (D6). It is a
bounded ring buffer, so a long-lived aircraft's route is truncated to the most
recent points rather than growing without limit.

Concurrency: every method here is synchronous and contains no ``await``, so
under asyncio each one is atomic with respect to the event loop. The poller
cannot interleave with a request handler mid-update. This is load-bearing --
adding an ``await`` inside any of these methods would introduce a race.
"""

from __future__ import annotations

import logging
from collections import deque
from datetime import datetime

from app.models import (
    BBox,
    ObjectType,
    TrackedObjectDetail,
    TrackedObjectRecord,
    TrackPoint,
    utcnow,
)

logger = logging.getLogger(__name__)


class ObjectStore:
    """Latest known state of every tracked object, with observed track history.

    Args:
        object_ttl_seconds: drop an object not re-observed within this window.
        track_history_points: ring buffer length per object.
        snapshot_ttl_seconds: age past which the store reports itself stale.
        object_type: which layer this store holds. One store per layer, so the
            phase 2 satellite layer gets its own instance rather than a shared
            one with a type filter threaded through every method.
    """

    def __init__(
        self,
        *,
        object_ttl_seconds: float,
        track_history_points: int,
        snapshot_ttl_seconds: float,
        object_type: ObjectType = ObjectType.AIRCRAFT,
    ) -> None:
        self.object_ttl_seconds = object_ttl_seconds
        self.track_history_points = track_history_points
        self.snapshot_ttl_seconds = snapshot_ttl_seconds
        self.object_type = object_type

        self._objects: dict[str, TrackedObjectRecord] = {}
        self._tracks: dict[str, deque[TrackPoint]] = {}
        self._last_success_at: datetime | None = None
        self._source: str | None = None
        self._updates_applied = 0

    # ---- writing -----------------------------------------------------------

    def apply(
        self,
        records: list[TrackedObjectRecord],
        *,
        source: str,
        fetched_at: datetime | None = None,
    ) -> int:
        """Merge one poll result into the store.

        Returns the number of records applied. Called only on a *successful*
        poll -- a failure must never reach here, which is what preserves the
        last good snapshot (D10).
        """
        now = fetched_at or utcnow()
        for record in records:
            self._objects[record.id] = record
            self._append_track_point(record)

        self._last_success_at = now
        self._source = source
        self._updates_applied += 1
        self.evict(now)
        return len(records)

    def _append_track_point(self, record: TrackedObjectRecord) -> None:
        history = self._tracks.get(record.id)
        if history is None:
            history = deque(maxlen=self.track_history_points)
            self._tracks[record.id] = history

        # Upstream often reports the same last_contact across consecutive polls
        # for an aircraft that has not sent a new position. Appending those
        # would fill the ring buffer with duplicates and truncate the real
        # route, so the timestamp is the dedupe key.
        if history and history[-1].timestamp >= record.last_seen:
            return

        history.append(
            TrackPoint(
                lat=record.lat,
                lon=record.lon,
                altitude=record.altitude,
                timestamp=record.last_seen,
            )
        )

    def evict(self, now: datetime | None = None) -> int:
        """Drop objects not re-observed within the object TTL.

        Without this the store grows without bound: aircraft land, satellites
        set, and ids never return. Track history is dropped with the object,
        since a route for something no longer displayed serves no purpose.
        """
        now = now or utcnow()
        cutoff = self.object_ttl_seconds
        expired = [
            key
            for key, record in self._objects.items()
            if (now - record.last_seen).total_seconds() > cutoff
        ]
        for key in expired:
            del self._objects[key]
            self._tracks.pop(key, None)
        if expired:
            logger.debug("evicted %d objects past TTL", len(expired))
        return len(expired)

    # ---- reading -----------------------------------------------------------

    def get(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Every object, optionally filtered to a bounding box.

        A linear scan. At ~10,000 objects that is 10,000 float comparisons,
        well under a millisecond -- a spatial index would be complexity without
        a measurement to justify it (D11).
        """
        if bbox is None:
            return list(self._objects.values())
        return [r for r in self._objects.values() if bbox.contains(r.lat, r.lon)]

    def get_detail(self, object_id: str) -> TrackedObjectDetail | None:
        """One object with its observed track, or None if not held."""
        record = self._objects.get(object_id)
        if record is None:
            return None
        history = self._tracks.get(object_id, ())
        return TrackedObjectDetail(**record.model_dump(), track=tuple(history))

    def search(self, query: str, *, limit: int = 20) -> list[TrackedObjectRecord]:
        """Find objects whose label or id matches ``query``, case-insensitively.

        Server-side because the client only holds what is in its viewport, and
        "search for a flight by callsign" has to work for a flight the user is
        not currently looking at.

        Exact matches rank first, then prefix matches, then substring -- so
        typing a full callsign puts it at the top rather than behind an
        alphabetically earlier partial match.
        """
        needle = query.strip().upper()
        if not needle:
            return []

        exact: list[TrackedObjectRecord] = []
        prefix: list[TrackedObjectRecord] = []
        substring: list[TrackedObjectRecord] = []
        for record in self._objects.values():
            haystacks = (record.label.upper(), record.id.upper())
            if needle in haystacks:
                exact.append(record)
            elif any(h.startswith(needle) for h in haystacks):
                prefix.append(record)
            elif any(needle in h for h in haystacks):
                substring.append(record)

        ranked = exact + prefix + substring
        return ranked[:limit]

    # ---- status ------------------------------------------------------------

    @property
    def object_count(self) -> int:
        return len(self._objects)

    @property
    def last_success_at(self) -> datetime | None:
        return self._last_success_at

    @property
    def source(self) -> str | None:
        return self._source

    @property
    def updates_applied(self) -> int:
        return self._updates_applied

    def age_seconds(self, now: datetime | None = None) -> float | None:
        """Seconds since the last successful poll, or None if we never had one."""
        if self._last_success_at is None:
            return None
        return ((now or utcnow()) - self._last_success_at).total_seconds()

    def is_stale(self, now: datetime | None = None) -> bool:
        """Whether the data is older than the configured TTL.

        A store that has never been populated counts as stale: it has no fresh
        data, and reporting otherwise would tell the frontend an empty globe is
        current.
        """
        age = self.age_seconds(now)
        return age is None or age > self.snapshot_ttl_seconds

    def track_length(self, object_id: str) -> int:
        return len(self._tracks.get(object_id, ()))

    def clear(self) -> None:
        """Drop everything. Tests only; there is no runtime reason to do this."""
        self._objects.clear()
        self._tracks.clear()
        self._last_success_at = None
        self._source = None
        self._updates_applied = 0
