"""Two ship feeds, one picture.

The same argument as the aircraft union (D83) reaching a different answer,
which is why it is a separate class rather than a reuse of ``UnionProvider``.

## Why not just use the global one

aisstream sees 17,848 vessels to Digitraffic's 643, so the obvious move is to
drop the smaller source. Measured, that is wrong twice over.

**Half of aisstream's coverage is the Baltic anyway** - 9,202 of its 17,848
were in northern Europe - so the two overlap in exactly the water Digitraffic
covers. What is not the same is the quality of that overlap: Digitraffic is the
Finnish transport agency's own operational feed, and aisstream is whichever
volunteer receivers happen to be listening.

**And they fail independently**, which is the whole reason for a union. One is
an HTTP endpoint behind a CDN with a stated cache policy; the other is a
WebSocket with no SLA, no replay, and a documented habit of dropping slow
consumers. A layer that survives either going down is worth one extra source.

## Merged on the freshest position, not on a priority order

The aircraft union lets its primary overwrite its supplement, because there the
primary is polled every time and is therefore always the fresher of the two
(D83). Neither of these has that property: Digitraffic is a minute-old snapshot
of Finnish waters, aisstream is a live stream that may or may not have heard a
given vessel recently. Which one is fresher varies **per vessel**.

So the position comes from whichever record was observed later, and there is no
priority to argue about.

## But the identity is merged, not replaced, and that was a defect

Taking the fresher record *whole* loses things, and the measurement said so
before the map did. A vessel's **type** does not arrive with its position: it
is a separate AIS message sent every six minutes, so on the stream only
**22% of vessels had one after five minutes** (climbing from 3%), against
**87% on Digitraffic**, which serves a joined metadata table.

The two overlap most in the Baltic - half of the stream's coverage is northern
Europe - so "freshest wins" meant a fully described Finnish ferry being
overwritten, every minute, by a bare position from a volunteer receiver that
happened to hear it a few seconds later. The map would have *lost* colour by
adding a source.

So a field only ever loses to a value, never to a blank: the fresher record
supplies the position, and anything it does not know is taken from the other.
The name behaves the same way, though it matters less - 95% of stream vessels
carry one, because unlike the type it rides in the metadata of every message.

## Failure is not an outage until both fail

If either source answers, the layer is drawn. Only both failing raises, and
only then does the poller see an error and keep the last good snapshot (D10).
"""

from __future__ import annotations

import asyncio
import logging

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import Provider, ProviderError, ProviderUnavailable

logger = logging.getLogger(__name__)


class ShipUnionProvider(Provider):
    """Merges the regional feed and the global stream, keeping the fresher."""

    object_type = ObjectType.SHIP

    def __init__(self, sources: list[Provider]) -> None:
        if not sources:
            raise ValueError("a ship union needs at least one source")
        self.sources = sources
        # **Named after what it actually contains**, not "ships". This string
        # is what the status bar shows the reader under "data age", and it is
        # the only place the interface says where the vessels came from - so
        # "digitraffic+aisstream" tells them something and "ships" tells them
        # the layer they are already looking at. It also changes when the key
        # is absent, which is exactly when a reader most wants to know why the
        # map is smaller.
        self.name = "+".join(source.name for source in sources)

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        results = await asyncio.gather(
            *(source.fetch(bbox) for source in self.sources), return_exceptions=True
        )

        merged: dict[str, TrackedObjectRecord] = {}
        failures: list[str] = []
        last_error: BaseException | None = None

        for source, result in zip(self.sources, results):
            if isinstance(result, BaseException):
                if not isinstance(result, ProviderError):
                    # A provider raising something else is a bug in that
                    # provider, and we want it loud rather than folded into a
                    # partial result (the `Provider` contract says so).
                    raise result
                failures.append(source.name)
                last_error = result
                continue
            for record in result:
                existing = merged.get(record.id)
                if existing is None:
                    merged[record.id] = record
                    continue
                # The freshest supplies the position, per vessel - neither
                # source is systematically ahead of the other, so a priority
                # order would be a guess dressed as a rule. But what it does
                # not know is taken from the other rather than lost with it.
                newer, older = (
                    (record, existing)
                    if record.last_seen > existing.last_seen
                    else (existing, record)
                )
                merged[record.id] = _completed(newer, older)

        if len(failures) == len(self.sources):
            raise ProviderUnavailable(
                f"every ship source failed ({', '.join(failures)}): {last_error}"
            )
        if failures:
            # Partial rather than silent: a source that fails on every poll and
            # says nothing is how a continent went missing for the life of the
            # adsb.lol provider (defect #35).
            logger.warning(
                "ship sources unavailable: %s; serving %d vessels from the rest",
                ", ".join(failures),
                len(merged),
            )
        return list(merged.values())

    async def aclose(self) -> None:
        for source in self.sources:
            await source.aclose()


def _completed(newer: TrackedObjectRecord, older: TrackedObjectRecord) -> TrackedObjectRecord:
    """The newer record, with anything it does not know filled in from the older.

    Only ever fills blanks. A value is never overwritten by another value, so
    this cannot silently prefer a stale fact to a current one - the newer
    record wins every field it actually has.

    ``meta`` is merged key by key for the same reason: the destination, IMO
    number and hull dimensions a vessel transmits once every six minutes should
    not disappear because the position that arrived a moment ago came from a
    receiver that has not heard the static message yet.
    """
    meta = dict(older.meta or {})
    meta.update(newer.meta or {})
    return newer.model_copy(
        update={
            "model": newer.model or older.model,
            # A vessel with no name is served as its own MMSI, so "the label is
            # the id" is what an unknown name looks like here rather than an
            # empty string.
            "label": newer.label if newer.label != newer.id else (older.label or newer.label),
            "meta": meta,
        }
    )
