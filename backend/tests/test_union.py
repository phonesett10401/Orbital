"""Tests for the two-feed union.

Three things are worth pinning, and none of them is the merge itself.

**Both feeds appear.** The whole reason for this provider is that OpenSky sees
22 aircraft over Myanmar where adsb.lol sees 4, and adsb.lol sees 33 over
inland China where OpenSky sees none (D83). If the merge quietly dropped one
side, the map would look fine and be poorer than either source alone.

**The metered one is not called every poll.** OpenSky costs credits and
adsb.lol does not, so the cadence is set by the free feed and the metered one
answers at most once an interval. A regression here would empty a day's quota
in an afternoon, silently, and only show up as a 429 hours later.

**They fail independently.** Two sources are only worth having if one being
down leaves the other working.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import Provider, ProviderRateLimited, ProviderUnavailable
from app.providers.union import UnionProvider

NOW = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)


def record(object_id: str, *, lat: float = 1.0, label: str = "", age: float = 0.0):
    return TrackedObjectRecord(
        id=object_id,
        lat=lat,
        lon=2.0,
        altitude=10000.0,
        velocity=240.0,
        heading=90.0,
        label=label or object_id.upper(),
        last_seen=NOW - timedelta(seconds=age),
        type=ObjectType.AIRCRAFT,
    )


class Fake(Provider):
    object_type = ObjectType.AIRCRAFT

    def __init__(self, name: str, records, *, error: Exception | None = None, track=None):
        self.name = name
        self._records = records
        self.error = error
        self.calls = 0
        self.track_calls = 0
        self._track = track

    async def fetch(self, bbox: BBox | None = None):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return list(self._records)

    async def fetch_track(self, object_id: str):
        self.track_calls += 1
        if self.error is not None:
            raise self.error
        return self._track


class TestMerging:
    @pytest.mark.anyio
    async def test_an_aircraft_only_one_feed_can_see_still_appears(self) -> None:
        # Myanmar and inland China, in miniature: each source has something the
        # other does not, and the union is the point.
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        merged = await UnionProvider(primary, supplement).fetch()
        assert {r.id for r in merged} == {"aaa111", "bbb222"}

    @pytest.mark.anyio
    async def test_the_freshly_polled_feed_wins_a_tie(self) -> None:
        # Both feeds see most aircraft. The primary is polled every time and
        # the supplement's answer may be minutes old, so the primary's position
        # is the current one.
        primary = Fake("adsblol", [record("shared", lat=10.0)])
        supplement = Fake("opensky", [record("shared", lat=20.0)])
        merged = await UnionProvider(primary, supplement).fetch()
        assert len(merged) == 1
        assert merged[0].lat == 10.0

    @pytest.mark.anyio
    async def test_a_viewport_poll_never_buys_from_the_metered_feed(self) -> None:
        # The supplement exists for coverage, which is a question about the
        # whole world asked every few minutes. A viewport poll is asked far
        # more often and exists for freshness, which the free feed provides.
        # Buying for it would multiply the credit cost by the poll rate.
        primary = Fake("adsblol", [])
        supplement = Fake("opensky", [])
        union = UnionProvider(primary, supplement)
        for _ in range(4):
            await union.fetch(BBox(lat_min=0, lon_min=0, lat_max=1, lon_max=1))
        assert primary.calls == 4
        assert supplement.calls == 0

    @pytest.mark.anyio
    async def test_a_viewport_poll_still_includes_what_only_it_can_see(self) -> None:
        # Otherwise an aircraft only OpenSky sees would vanish the moment the
        # user zoomed in on it.
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        union = UnionProvider(primary, supplement)
        await union.fetch(None)
        merged = await union.fetch(BBox(lat_min=0, lon_min=0, lat_max=1, lon_max=1))
        assert {r.id for r in merged} == {"aaa111", "bbb222"}

    @pytest.mark.anyio
    async def test_the_metered_feed_is_always_asked_about_the_whole_world(self) -> None:
        # Even when the poll that triggered it had a bbox: its answer is cached
        # and reused for viewport polls, so a viewport-shaped answer would
        # shrink the cache to whatever was on screen at the time.
        boxes = []

        class Recording(Fake):
            async def fetch(self, bbox=None):
                boxes.append(bbox)
                return await super().fetch(bbox)

        supplement = Recording("opensky", [record("bbb222")])
        await UnionProvider(Fake("adsblol", []), supplement).fetch(None)
        assert boxes == [None]


class TestSpendingTheMeteredFeedSparingly:
    @pytest.mark.anyio
    async def test_the_free_feed_answers_every_poll(self) -> None:
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        union = UnionProvider(primary, supplement, supplement_interval_seconds=600)
        for _ in range(5):
            await union.fetch()
        assert primary.calls == 5

    @pytest.mark.anyio
    async def test_the_metered_feed_answers_once_an_interval(self) -> None:
        # Five polls, one purchase. Without this the union would multiply the
        # credit cost by however much faster the free feed lets us poll.
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        union = UnionProvider(primary, supplement, supplement_interval_seconds=600)
        for _ in range(5):
            await union.fetch()
        assert supplement.calls == 1

    @pytest.mark.anyio
    async def test_its_aircraft_are_still_included_between_calls(self) -> None:
        # The cached half is what covers Myanmar. Dropping it between refreshes
        # would make those aircraft blink in and out once an interval.
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        union = UnionProvider(primary, supplement, supplement_interval_seconds=600)
        await union.fetch()
        merged = await union.fetch()
        assert {r.id for r in merged} == {"aaa111", "bbb222"}

    @pytest.mark.anyio
    async def test_cached_records_keep_the_age_they_arrived_with(self) -> None:
        # They are not refreshed, and nothing pretends they are: they age,
        # fade at two minutes and are evicted normally (D71).
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222", age=45.0)])
        union = UnionProvider(primary, supplement, supplement_interval_seconds=600)
        await union.fetch()
        merged = await union.fetch()
        stale = next(r for r in merged if r.id == "bbb222")
        assert stale.last_seen == NOW - timedelta(seconds=45)

    @pytest.mark.anyio
    async def test_it_is_asked_again_once_the_interval_passes(self) -> None:
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [record("bbb222")])
        union = UnionProvider(primary, supplement, supplement_interval_seconds=0.0)
        await union.fetch()
        await union.fetch()
        assert supplement.calls == 2


class TestFailingIndependently:
    @pytest.mark.anyio
    async def test_the_map_survives_the_metered_feed_being_down(self) -> None:
        primary = Fake("adsblol", [record("aaa111")])
        supplement = Fake("opensky", [], error=ProviderRateLimited("no credits"))
        merged = await UnionProvider(primary, supplement).fetch()
        assert {r.id for r in merged} == {"aaa111"}

    @pytest.mark.anyio
    async def test_and_the_free_one_being_down(self) -> None:
        primary = Fake("adsblol", [], error=ProviderUnavailable("420"))
        supplement = Fake("opensky", [record("bbb222")])
        merged = await UnionProvider(primary, supplement).fetch()
        assert {r.id for r in merged} == {"bbb222"}

    @pytest.mark.anyio
    async def test_only_both_failing_is_an_outage(self) -> None:
        # And it must raise rather than return nothing: an empty list would be
        # applied to the store as a successful poll and wipe the last good
        # snapshot (D10).
        primary = Fake("adsblol", [], error=ProviderUnavailable("420"))
        supplement = Fake("opensky", [], error=ProviderUnavailable("500"))
        with pytest.raises(ProviderUnavailable):
            await UnionProvider(primary, supplement).fetch()

    @pytest.mark.anyio
    async def test_an_empty_sky_from_both_is_not_an_outage(self) -> None:
        # Nothing in view is a real answer, and distinguishable from a failure
        # only because neither raised.
        merged = await UnionProvider(Fake("a", []), Fake("b", [])).fetch()
        assert merged == []


class TestTracks:
    @pytest.mark.anyio
    async def test_the_track_comes_from_whichever_feed_has_one(self) -> None:
        # Only OpenSky offers flight history (D78); adsb.lol has no equivalent.
        primary = Fake("adsblol", [], track=None)
        supplement = Fake("opensky", [], track=("a track",))
        assert await UnionProvider(primary, supplement).fetch_track("aaa111") == ("a track",)

    @pytest.mark.anyio
    async def test_a_failing_feed_does_not_stop_the_other_being_asked(self) -> None:
        primary = Fake("adsblol", [], error=ProviderUnavailable("420"))
        supplement = Fake("opensky", [], track=("a track",))
        assert await UnionProvider(primary, supplement).fetch_track("aaa111") == ("a track",)

    @pytest.mark.anyio
    async def test_no_track_anywhere_is_None_rather_than_an_error(self) -> None:
        union = UnionProvider(Fake("a", [], track=None), Fake("b", [], track=None))
        assert await union.fetch_track("aaa111") is None
