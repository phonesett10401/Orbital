"""Two feeds, one picture.

Neither free feed sees everything, and the parts they miss are not the same
parts. Measured on identical 250 nm circles (D83):

| | OpenSky | adsb.lol |
|---|---|---|
| Myanmar | **22** | 4 |
| inland China | 0 | **33** |
| western Europe | 1,001 | 996 |
| worldwide | 11,651 | 10,009 |

Taking either alone throws away a region the other covers. Taking both and
merging on ICAO24 gives strictly more than either, for one extra request.

## The metered one is used sparingly

OpenSky costs 4,000 credits a day and adsb.lol costs nothing, so they are not
polled at the same rate. adsb.lol answers **every** poll; OpenSky answers at
most once per ``supplement_interval_seconds`` and its previous answer is reused
in between. That is what lets the poller run far faster than the credit ladder
(D21) would otherwise allow: the cadence is set by the free source, and the
metered one contributes what only it can see, at its own pace.

**Reused records are not refreshed records**, and nothing pretends otherwise:
they keep the `last_seen` they arrived with, so they age, fade at two minutes
(D71) and are evicted normally. An aircraft only OpenSky can see is shown as
what it is — a position from up to five minutes ago — rather than as current.

## A failure in one is not a failure in both

The whole point of two sources is that they fail independently. If OpenSky is
rate-limited or down, the map is still drawn from adsb.lol; if adsb.lol is
unreachable, OpenSky still answers. Only both failing is an outage, and only
then does the poller see an error and keep the last good snapshot (D10).
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import Provider, ProviderError, ProviderUnavailable

logger = logging.getLogger(__name__)

#: How often the metered source is actually called.
#:
#: Five minutes is the global cadence the credit ladder already budgets for
#: (D21's "authenticated" preset), so supplementing at this rate costs exactly
#: what the previous design cost while the free source polls as often as it
#: likes.
DEFAULT_SUPPLEMENT_INTERVAL = 300.0


class UnionProvider(Provider):
    """Merges a free primary feed with a metered supplementary one."""

    name = "union"
    object_type = ObjectType.AIRCRAFT

    def __init__(
        self,
        primary: Provider,
        supplement: Provider,
        *,
        supplement_interval_seconds: float = DEFAULT_SUPPLEMENT_INTERVAL,
    ) -> None:
        self.primary = primary
        self.supplement = supplement
        self._interval = supplement_interval_seconds
        self._supplement_cache: list[TrackedObjectRecord] = []
        self._supplement_at: float | None = None

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        primary_task = asyncio.create_task(self.primary.fetch(bbox))
        supplement_task = asyncio.create_task(self._supplement_records(bbox))
        primary, supplement = await asyncio.gather(
            primary_task, supplement_task, return_exceptions=True
        )

        primary_records = _records_or_none(primary, self.primary.name)
        supplement_records = _records_or_none(supplement, self.supplement.name)

        if primary_records is None and supplement_records is None:
            raise ProviderUnavailable(
                f"both {self.primary.name} and {self.supplement.name} failed"
            )

        merged: dict[str, TrackedObjectRecord] = {}
        # The supplement goes in first so the primary overwrites it: where both
        # see an aircraft, the fresher of the two wins, and the primary is
        # always the fresher one because it is polled every time.
        for record in supplement_records or ():
            merged[record.id] = record
        for record in primary_records or ():
            merged[record.id] = record
        return list(merged.values())

    async def _supplement_records(self, bbox: BBox | None) -> list[TrackedObjectRecord]:
        """The metered feed's contribution, refreshed at most once an interval.

        **Only the global poll pays for it.** The supplement is here for the
        places the free feed cannot see - 22 aircraft over Myanmar against 4 -
        and that is a question about the whole world, asked once every few
        minutes. A viewport poll is asked far more often and exists for
        freshness, which the free feed already provides; buying a second answer
        for it would multiply the credit cost by the poll rate, which is
        precisely what this design exists to avoid.

        The cache is returned for viewport polls regardless, so an aircraft
        only OpenSky can see does not blink out of a zoomed-in view.
        """
        now = time.monotonic()
        due = self._supplement_at is None or now - self._supplement_at >= self._interval
        if bbox is not None or not due:
            return self._supplement_cache

        records = await self.supplement.fetch(None)
        self._supplement_cache = records
        self._supplement_at = now
        return records

    async def fetch_track(self, object_id: str):
        """The flight track, from whichever source has one.

        Only OpenSky offers flight history (D78); adsb.lol has no equivalent
        endpoint. So this asks the primary first for the day that changes, and
        falls back to the supplement, which is where the answer comes from
        today.
        """
        for provider in (self.primary, self.supplement):
            try:
                track = await provider.fetch_track(object_id)
            except ProviderError as exc:
                logger.info("%s could not supply a track: %s", provider.name, exc)
                continue
            if track:
                return track
        return None

    async def aclose(self) -> None:
        for provider in (self.primary, self.supplement):
            closer = getattr(provider, "aclose", None)
            if closer is not None:
                await closer()


def _records_or_none(
    result: list[TrackedObjectRecord] | BaseException,
    name: str,
) -> list[TrackedObjectRecord] | None:
    if isinstance(result, BaseException):
        logger.warning("%s failed this poll: %s", name, result)
        return None
    return result
