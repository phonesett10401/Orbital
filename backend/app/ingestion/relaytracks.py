"""Flight tracks fetched by the home relay on request (D217).

The server cannot reach OpenSky, and adsb.lol's traces now need a key, so a
clicked aircraft's track is asked of the relay instead: ``fetch_track`` puts the
id on a list, the relay picks it up on its next few-second check, fetches
``/tracks/all`` from home and posts the path back, and the waiting call returns
it. ``FlightHistory`` caches the answer exactly as it caches a provider's.

With no relay checking in, every call goes straight to the provider, so a server
without a relay behaves as it did before.
"""

from __future__ import annotations

import asyncio
import time

from app.models import TrackPoint
from app.providers.base import Provider

#: How long a request waits for the relay. The API stops waiting after its own
#: budget and the client re-polls, so this only bounds how long the id stays on
#: the list: the relay checks every few seconds and a track takes one or two.
WAIT_SECONDS = 15.0

#: The relay counts as present this long after its last check.
ACTIVE_SECONDS = 15.0


class RelayTracks:
    def __init__(self, provider: Provider) -> None:
        self._provider = provider
        self._pending: dict[str, asyncio.Future[tuple[TrackPoint, ...] | None]] = {}
        self._last_seen: float | None = None

    def heartbeat(self) -> None:
        self._last_seen = time.monotonic()

    @property
    def active(self) -> bool:
        return self._last_seen is not None and time.monotonic() - self._last_seen < ACTIVE_SECONDS

    def requested(self) -> list[str]:
        return [i for i, f in self._pending.items() if not f.done()]

    def supply(self, object_id: str, track: tuple[TrackPoint, ...] | None) -> bool:
        """Hand a fetched track to whoever is waiting. False if nobody asked."""
        future = self._pending.pop(object_id, None)
        if future is None or future.done():
            return False
        future.set_result(track)
        return True

    async def fetch_track(self, object_id: str) -> tuple[TrackPoint, ...] | None:
        if not self.active:
            return await self._provider.fetch_track(object_id)
        future = self._pending.get(object_id)
        if future is None or future.done():
            future = asyncio.get_running_loop().create_future()
            self._pending[object_id] = future
        try:
            return await asyncio.wait_for(asyncio.shield(future), WAIT_SECONDS)
        except TimeoutError:
            self._pending.pop(object_id, None)
            return None
