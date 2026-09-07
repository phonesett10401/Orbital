"""The ship union: two feeds, one picture.

What is worth testing here is the **merge rule**, because it differs from the
aircraft union's on purpose. There the primary always overwrites the supplement,
which is sound because the primary is polled every time and is therefore always
fresher (D83). Neither ship source has that property - Digitraffic is a
minute-old snapshot of Finnish waters, aisstream is a live stream that may not
have heard a given vessel recently - so which is fresher varies **per vessel**,
and the rule is the honest one.

The second is partial failure. Two sources exist so that one going down is not
an outage, and a union that raises when either fails would have thrown that
away.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import Provider, ProviderUnavailable
from app.providers.shipunion import ShipUnionProvider

NOW = datetime(2026, 9, 7, 6, 0, tzinfo=timezone.utc)


def vessel(mmsi="230982000", lat=60.1, lon=24.9, seen=NOW, label="VIKING GRACE"):
    return TrackedObjectRecord(
        id=mmsi, lat=lat, lon=lon, altitude=0.0, velocity=6.4, heading=61,
        label=label, model="Passenger", last_seen=seen, type=ObjectType.SHIP,
        meta={"mmsi": mmsi},
    )


class Fake(Provider):
    object_type = ObjectType.SHIP

    def __init__(self, name, records=None, error=None):
        self.name = name
        self.records = records or []
        self.error = error
        self.closed = False

    async def fetch(self, bbox: BBox | None = None):
        if self.error:
            raise self.error
        return list(self.records)

    async def aclose(self):
        self.closed = True


class TestMerging:
    @pytest.mark.anyio
    async def test_both_sources_contribute(self) -> None:
        union = ShipUnionProvider([
            Fake("local", [vessel("1", label="A")]),
            Fake("global", [vessel("2", label="B")]),
        ])
        assert {r.id for r in await union.fetch()} == {"1", "2"}

    @pytest.mark.anyio
    async def test_the_freshest_position_wins_whichever_source_it_came_from(self) -> None:
        # **Not a priority order.** Neither source is systematically ahead of
        # the other, so "the primary always wins" - which is right for the
        # aircraft union (D83) - would here be a guess dressed as a rule.
        older = vessel(seen=NOW - timedelta(minutes=5), lat=60.0)
        newer = vessel(seen=NOW, lat=61.0)
        first = await ShipUnionProvider([Fake("a", [older]), Fake("b", [newer])]).fetch()
        second = await ShipUnionProvider([Fake("a", [newer]), Fake("b", [older])]).fetch()
        assert first[0].lat == 61.0
        assert second[0].lat == 61.0

    @pytest.mark.anyio
    async def test_the_same_vessel_from_both_appears_once(self) -> None:
        # Half of aisstream's coverage is the Baltic, so the overlap with
        # Digitraffic is large rather than incidental - a vessel counted twice
        # would be a vessel drawn twice.
        union = ShipUnionProvider([Fake("a", [vessel()]), Fake("b", [vessel()])])
        assert len(await union.fetch()) == 1


class TestPartialFailure:
    @pytest.mark.anyio
    async def test_one_source_down_still_draws_the_map(self) -> None:
        # The whole reason for two sources. One is an HTTP endpoint behind a
        # CDN, the other a WebSocket with no SLA; they fail independently.
        union = ShipUnionProvider([
            Fake("local", [vessel("1")]),
            Fake("global", error=ProviderUnavailable("stream down")),
        ])
        assert [r.id for r in await union.fetch()] == ["1"]

    @pytest.mark.anyio
    async def test_both_down_is_an_outage(self) -> None:
        # Only then does the poller see an error and keep the last good
        # snapshot rather than overwriting it with nothing (D10).
        union = ShipUnionProvider([
            Fake("local", error=ProviderUnavailable("http down")),
            Fake("global", error=ProviderUnavailable("stream down")),
        ])
        with pytest.raises(ProviderUnavailable):
            await union.fetch()

    @pytest.mark.anyio
    async def test_an_unexpected_error_is_not_swallowed(self) -> None:
        # A provider raising something that is not a ProviderError is a bug in
        # that provider, and the interface says it should be loud rather than
        # folded into a partial result.
        union = ShipUnionProvider([
            Fake("local", [vessel("1")]),
            Fake("global", error=ZeroDivisionError("bug")),
        ])
        with pytest.raises(ZeroDivisionError):
            await union.fetch()


class TestLifecycle:
    @pytest.mark.anyio
    async def test_closing_the_union_closes_every_source(self) -> None:
        # One of them holds a WebSocket and a background task; leaking it means
        # a reader still running after the app has shut down.
        sources = [Fake("a"), Fake("b")]
        await ShipUnionProvider(sources).aclose()
        assert all(source.closed for source in sources)

    def test_a_union_of_nothing_is_refused(self) -> None:
        with pytest.raises(ValueError):
            ShipUnionProvider([])

    @pytest.mark.anyio
    async def test_one_source_is_a_perfectly_good_union(self) -> None:
        # Without a key the layer is Digitraffic alone, and `main` builds a
        # union of one rather than switching type - so adding or removing the
        # stream changes a list, not a shape.
        union = ShipUnionProvider([Fake("local", [vessel("1")])])
        assert [r.id for r in await union.fetch()] == ["1"]


class TestTheIdentityIsMergedNotReplaced:
    """The defect the measurements found before the map did.

    A vessel's type does not arrive with its position - it is a separate AIS
    message sent every six minutes, so on the stream only 22% of vessels had
    one after five minutes against 87% on Digitraffic. The two overlap most in
    the Baltic, so taking the fresher record *whole* meant a fully described
    Finnish ferry being overwritten every minute by a bare position from a
    volunteer receiver that heard it a second later. **The map would have lost
    colour by adding a source** (D166).
    """

    @pytest.mark.anyio
    async def test_a_type_is_not_lost_to_a_fresher_record_without_one(self) -> None:
        described = vessel(seen=NOW - timedelta(seconds=30))
        bare = vessel(seen=NOW).model_copy(update={"model": None, "meta": {}})
        union = ShipUnionProvider([Fake("local", [described]), Fake("global", [bare])])
        merged = (await union.fetch())[0]
        assert merged.model == "Passenger"

    @pytest.mark.anyio
    async def test_the_fresher_position_still_wins(self) -> None:
        # Filling blanks must not quietly become "the described record wins",
        # which would serve a minute-old position for a moving ship.
        described = vessel(seen=NOW - timedelta(seconds=30), lat=60.0)
        bare = vessel(seen=NOW, lat=61.0).model_copy(update={"model": None, "meta": {}})
        union = ShipUnionProvider([Fake("local", [described]), Fake("global", [bare])])
        merged = (await union.fetch())[0]
        assert merged.lat == 61.0
        assert merged.last_seen == NOW

    @pytest.mark.anyio
    async def test_a_value_never_loses_to_another_value(self) -> None:
        # Only blanks are filled. If both records know the type, the fresher
        # one's answer stands - otherwise this would prefer a stale fact to a
        # current one, which is the opposite of the point.
        old = vessel(seen=NOW - timedelta(seconds=30)).model_copy(update={"model": "Cargo"})
        new = vessel(seen=NOW).model_copy(update={"model": "Tanker"})
        union = ShipUnionProvider([Fake("a", [old]), Fake("b", [new])])
        assert (await union.fetch())[0].model == "Tanker"

    @pytest.mark.anyio
    async def test_meta_is_merged_key_by_key(self) -> None:
        # The destination, IMO and hull dimensions ride on that same
        # six-minute message. Replacing the dict wholesale drops them.
        described = vessel(seen=NOW - timedelta(seconds=30)).model_copy(
            update={"meta": {"mmsi": "230982000", "imo": "9606900", "destination": "TURKU"}}
        )
        bare = vessel(seen=NOW).model_copy(update={"meta": {"mmsi": "230982000"}})
        union = ShipUnionProvider([Fake("a", [described]), Fake("b", [bare])])
        merged = (await union.fetch())[0]
        assert merged.meta["imo"] == "9606900"
        assert merged.meta["destination"] == "TURKU"

    @pytest.mark.anyio
    async def test_a_name_is_not_lost_to_a_bare_mmsi(self) -> None:
        # A vessel with no name is served as its own MMSI, so "unknown" here
        # looks like a label equal to the id rather than an empty string - and
        # a naive `newer.label or older.label` would never notice.
        named = vessel(seen=NOW - timedelta(seconds=30), label="VIKING GRACE")
        anonymous = vessel(seen=NOW, label="230982000")
        union = ShipUnionProvider([Fake("a", [named]), Fake("b", [anonymous])])
        assert (await union.fetch())[0].label == "VIKING GRACE"


class TestWhatItCallsItself:
    def test_it_is_named_after_the_sources_it_actually_has(self) -> None:
        # The status bar shows this under "data age", and it is the only place
        # the interface says where the vessels came from. "ships" would tell a
        # reader the layer they are already looking at.
        assert ShipUnionProvider([Fake("digitraffic"), Fake("aisstream")]).name == (
            "digitraffic+aisstream"
        )

    def test_it_says_so_when_the_global_stream_is_missing(self) -> None:
        # Which is exactly when a reader most wants to know why the map is
        # smaller than they expected.
        assert ShipUnionProvider([Fake("digitraffic")]).name == "digitraffic"
