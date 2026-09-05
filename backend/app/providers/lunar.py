"""Holding a window of lunar ephemeris, so a request never waits on JPL.

The same discipline ``satellites.py`` follows and for the same reason: **no
route performs I/O**. A Horizons query takes one to three seconds and the
service is a shared public good with no quota to buy, so putting one in a
request path would be both slow and rude.

So a window of the near future is fetched on a background task and read from
memory. Between refreshes this needs nothing at all, and Horizons being down is
not an outage here until the window runs out - which is hours away, because the
window is hours long.

## Why the window is short and the step is fine

A lunar orbiter goes round in about two hours, so the ground track is not
slow-moving the way an orbital element set is. The window is six hours at one
sample a minute, which is 360 rows per spacecraft - a few kilobytes - and is
refreshed when a third of it has been used.

Between samples the position is interpolated. One minute of LRO is a little
under half a degree of ground track, so straight-line interpolation is well
inside the width of the marker that draws it. What it is *not* safe for is the
antimeridian, which ``shortest_arc`` handles, and the poles, where longitude
genuinely swings a long way in a short time - that swing is real motion and is
drawn as it comes (D134).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx

from app.providers.horizons import (
    LUNAR_CRAFT,
    EphemerisRow,
    HorizonsError,
    LunarCraft,
    fetch_ephemeris,
    interpolate,
)

logger = logging.getLogger(__name__)

#: How much future to hold. Six hours is three orbits of a low lunar orbiter.
WINDOW_HOURS = 6

#: One sample a minute. See the module docstring for why that is enough.
STEP_MINUTES = 1

#: Refresh once this much of the window is behind us.
REFRESH_AFTER_HOURS = 2


class LunarTracker:
    """Windows of ephemeris for every spacecraft, kept warm.

    The client is injected so tests can drive this with a transport that never
    touches the network, and ``now`` so they can drive it with a clock.
    """

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        craft: tuple[LunarCraft, ...] = LUNAR_CRAFT,
        now=lambda: datetime.now(timezone.utc),
    ) -> None:
        self._client = client or httpx.AsyncClient(timeout=30.0)
        self._craft = craft
        self._now = now
        self._windows: dict[str, list[EphemerisRow]] = {}
        self._lock = asyncio.Lock()

    @property
    def craft(self) -> tuple[LunarCraft, ...]:
        return self._craft

    def held(self) -> int:
        """How many spacecraft have a usable window. For the health readout."""
        return sum(1 for rows in self._windows.values() if rows)

    def _needs_refresh(self, rows: list[EphemerisRow] | None) -> bool:
        if not rows:
            return True
        remaining = rows[-1].when - self._now()
        return remaining < timedelta(hours=WINDOW_HOURS - REFRESH_AFTER_HOURS)

    async def refresh(self) -> int:
        """Fetch a fresh window for any spacecraft that needs one.

        One spacecraft failing does not lose the others: Horizons drops
        individual objects when their ephemeris expires, which is exactly what
        CAPSTONE was doing when this was written, and that must not take the
        working two down with it.
        """
        async with self._lock:
            start = self._now()
            stop = start + timedelta(hours=WINDOW_HOURS)
            refreshed = 0
            for craft in self._craft:
                if not self._needs_refresh(self._windows.get(craft.horizons_id)):
                    continue
                try:
                    rows = await fetch_ephemeris(
                        self._client, craft, start, stop, STEP_MINUTES
                    )
                except (HorizonsError, httpx.HTTPError) as exc:
                    logger.warning(
                        "lunar ephemeris unavailable for %s (%s): %s",
                        craft.name,
                        craft.horizons_id,
                        exc,
                    )
                    continue
                self._windows[craft.horizons_id] = rows
                refreshed += 1
            return refreshed

    def positions(self, when: datetime | None = None) -> list[dict]:
        """Every spacecraft with a position for this instant.

        A spacecraft whose window does not cover the instant is **left out**
        rather than drawn at the edge of what is known. See ``interpolate``.
        """
        at = when or self._now()
        out: list[dict] = []
        for craft in self._craft:
            row = interpolate(self._windows.get(craft.horizons_id, []), at)
            if row is None:
                continue
            out.append(
                {
                    "id": craft.horizons_id,
                    "name": craft.name,
                    "operator": craft.operator,
                    "purpose": craft.purpose,
                    "lat": round(row.lat, 6),
                    "lon": round(row.lon, 6),
                    "altitudeKm": round(row.altitude_km, 2),
                }
            )
        return out

    async def aclose(self) -> None:
        await self._client.aclose()
