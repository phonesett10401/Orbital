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
#: **Shorter than the freeze threshold, deliberately.** The client refuses to
#: dead-reckon a position older than two minutes and fades the marker instead
#: (D71), so a supplement interval longer than that leaves every aircraft only
#: OpenSky can see sitting motionless for the difference. At five minutes that
#: was 60% of their cycle, and it is exactly what "the planes are not moving"
#: looked like (defect #30).
#:
#: 120 s costs 2,880 credits a day, which is still less than the 3,072 the
#: OpenSky-only preset spent for a fifth of the refresh rate.
DEFAULT_SUPPLEMENT_INTERVAL = 120.0


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

    @property
    def remaining_credits(self) -> int | None:
        """The metered feed's balance, which is the union's balance.

        The primary is free by construction -- that is the whole point of the
        pairing -- so whatever the supplement has left is what we have left.

        Without this the poller sees no balance at all and its throttle ladder
        can never step down, in the one configuration where stepping down
        matters (defect #34). The projected 2,880/day fits inside 4,000, so the
        ladder is a safety net rather than a brake; but a net that is not
        attached to anything is worse than no net, because it reads as
        protection on the health endpoint.
        """
        return self.supplement.remaining_credits

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

        **A viewport poll contributes nothing from it**, and returning the
        cache there was a real defect rather than a nicety (defect #30). The
        store *merges* a poll into what it already holds and evicts on age
        (D10), so an aircraft it saw four minutes ago is still there without
        being re-asserted. Handing back ten thousand cached records on every
        viewport poll instead did two bad things: it re-applied them with the
        timestamps they arrived with, so their positions stopped advancing and
        the client - which refuses to dead-reckon a position older than two
        minutes (D71) - froze them on screen; and because a viewport poll's
        primary only covers what is on screen, every aircraft *outside* the
        viewport had its fresh position overwritten by a five-minute-old copy.
        The map went stale everywhere except the few kilometres being looked at.
        """
        now = time.monotonic()
        due = self._supplement_at is None or now - self._supplement_at >= self._interval
        if bbox is not None:
            return []
        if not due:
            return self._supplement_cache

        records = await self.supplement.fetch(None)
        self._supplement_cache = records
        self._supplement_at = now
        return records

    async def fetch_track(self, object_id: str):
        """The flight track, from whichever source has one.

        **Both offer one now, and the order matters.** This said "only OpenSky
        offers flight history; adsb.lol has no equivalent endpoint" for eight
        decisions, and it was true of `api.adsb.lol` and wrong about the
        project - the traces are published by the map server, and D200 wired
        them up.

        The primary is asked first, which is now the right order rather than a
        hopeful one: adsb.lol is free and unmetered where OpenSky costs four
        credits a call, and over south-east Asia it is the only one of the two
        that answers - three aircraft in ten had an OpenSky track there against
        ten in ten here.
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


#: How often to repeat a warning about a failure that has not changed.
#:
#: **A sustained outage should be one line and then quiet, not a line per
#: poll.** OpenSky was unreachable from the London container for hours, and at
#: a poll every two minutes that filled the log with the same sentence 289
#: times, which is how a real second fault would get missed (D207). Half an
#: hour is often enough to prove the outage is still running and rare enough
#: to read.
REPEAT_WARNING_SECONDS = 1800.0

#: The last failure logged per provider: the message, and when it was warned
#: about. Module level because the union is constructed per process and this
#: is about the log rather than about a poll.
_last_failure: dict[str, tuple[str, float]] = {}


def _records_or_none(
    result: list[TrackedObjectRecord] | BaseException,
    name: str,
) -> list[TrackedObjectRecord] | None:
    if isinstance(result, BaseException):
        message = str(result)
        now = time.monotonic()
        previous = _last_failure.get(name)
        # Loud when it starts, when it changes, and every half hour it persists.
        # Quiet in between, so a *different* failure arriving is still visible.
        if (
            previous is None
            or previous[0] != message
            or now - previous[1] >= REPEAT_WARNING_SECONDS
        ):
            logger.warning("%s failed this poll: %s", name, message)
            _last_failure[name] = (message, now)
        else:
            logger.debug("%s failed this poll: %s", name, message)
        return None
    if _last_failure.pop(name, None) is not None:
        logger.info("%s is answering again", name)
    return result
