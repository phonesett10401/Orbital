"""Tests for scheduling, retry, backoff, quota throttling -- and the outage case.

The outage tests at the bottom of this file encode a phase 1 exit criterion:
the ingestion layer must absorb an OpenSky failure without the served data
disappearing. They assert at the store boundary; the end-to-end HTTP assertion
(the API still answers 200 with `stale: true`) lands in M3, once the endpoints
exist.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.config import PollJob, Settings
from app.ingestion.poller import MAX_BACKOFF_SECONDS, Poller
from app.ingestion.store import ObjectStore
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.providers.base import Provider, ProviderRateLimited, ProviderUnavailable
from app.providers.union import UnionProvider
from app.quota import ThrottleLevel, credits_for_area, credits_for_bbox

# Anchored to the real clock rather than a literal date: eviction compares
# record timestamps against "now", so a hardcoded date would quietly start
# failing these tests once it aged past the object TTL.
NOW = utcnow()


def record(object_id="a1", lat=40.0, lon=-74.0, last_seen=None):
    return TrackedObjectRecord(
        id=object_id, lat=lat, lon=lon, altitude=10000.0, velocity=240.0,
        heading=90.0, label=object_id.upper(),
        last_seen=last_seen or NOW, type=ObjectType.AIRCRAFT, meta={},
    )


class FakeProvider(Provider):
    """A provider whose behaviour each test dictates directly."""

    name = "fake"
    object_type = ObjectType.AIRCRAFT

    def __init__(self, records=None):
        self.records = records if records is not None else [record()]
        self.error: Exception | None = None
        self.calls: list[BBox | None] = []
        self.remaining_credits: int | None = None
        self.closed = False

    async def fetch(self, bbox: BBox | None = None):
        self.calls.append(bbox)
        if self.error is not None:
            raise self.error
        return list(self.records)

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def store() -> ObjectStore:
    return ObjectStore(
        object_ttl_seconds=1800.0, track_history_points=50, snapshot_ttl_seconds=600.0
    )


@pytest.fixture
def provider() -> FakeProvider:
    return FakeProvider()


@pytest.fixture
def settings() -> Settings:
    return Settings(quota_preset="authenticated", provider="opensky")


@pytest.fixture
def poller(provider, store, settings) -> Poller:
    return Poller(provider, store, settings)


def job_of(poller: Poller, name: str) -> PollJob:
    return next(j for j in poller.settings.jobs if j.name == name)


def status_of(poller: Poller, name: str):
    return poller._statuses[name]


async def tick(poller: Poller, name: str) -> float:
    return await poller._tick(job_of(poller, name), status_of(poller, name))


# ---------------------------------------------------------------------------
# Normal operation
# ---------------------------------------------------------------------------


class TestSuccessfulPolling:
    @pytest.mark.anyio
    async def test_a_successful_tick_applies_records_to_the_store(self, poller, store):
        await tick(poller, "global")
        assert store.object_count == 1
        assert store.source == "fake"

    @pytest.mark.anyio
    async def test_tier_one_requests_the_whole_globe(self, poller, provider):
        await tick(poller, "global")
        assert provider.calls == [None]

    @pytest.mark.anyio
    async def test_success_records_status(self, poller):
        await tick(poller, "global")
        status = status_of(poller, "global")
        assert status.successful_polls == 1
        assert status.consecutive_failures == 0
        assert status.last_error is None
        assert status.healthy

    @pytest.mark.anyio
    async def test_the_next_delay_is_the_configured_interval(self, poller):
        delay = await tick(poller, "global")
        assert delay == pytest.approx(300.0, rel=0.15)  # interval plus jitter


# ---------------------------------------------------------------------------
# Tier 2: the viewport
# ---------------------------------------------------------------------------


class TestFocusTier:
    def test_no_viewport_means_no_focus_poll(self, poller):
        assert poller.focus_bbox() is None

    def test_a_small_viewport_is_polled(self, poller):
        poller.set_viewport(BBox.parse("40,-75,42,-73"))
        assert poller.focus_bbox() is not None

    def test_a_zoomed_out_viewport_is_skipped(self, poller):
        # Tier 1 already covers a zoomed-out view; paying twice buys nothing.
        poller.set_viewport(BBox.parse("-40,-100,40,20"))
        assert poller.focus_bbox() is None

    def test_a_moderately_large_viewport_is_trimmed_rather_than_skipped(self, poller):
        # The bug this guards against: snapping expands a box by up to a grid
        # step per edge, which pushed an affordable viewport over the band and
        # skipped it. The user is zoomed in and wants live data, so trim instead.
        poller.set_viewport(BBox.parse("36,-100,41,-95"))
        focus = poller.focus_bbox()
        assert focus is not None
        assert focus.width_deg * focus.height_deg <= poller.settings.focus_max_area_sq_deg

    def test_no_focus_poll_exceeds_its_credit_band(self, poller):
        # This is what keeps the daily projection in D21 exact rather than
        # approximate: tier 2 can never wander into a higher band, whatever the
        # camera is doing.
        budget = credits_for_area(poller.settings.focus_max_area_sq_deg)
        for raw in (
            "40,-75,42,-73", "36,-100,41,-95", "0,0,4.5,4.5",
            "-50,20,-46,26", "20,10,32,22", "-5,-15,7,-3",
        ):
            poller.set_viewport(BBox.parse(raw))
            focus = poller.focus_bbox()
            assert focus is not None
            assert credits_for_bbox(focus) <= budget, raw

    def test_trimming_keeps_the_box_grid_aligned(self, poller):
        # Trimming in whole grid steps preserves the stability snapping bought.
        poller.set_viewport(BBox.parse("36,-100,41,-95"))
        focus = poller.focus_bbox()
        step = poller.settings.focus_grid_snap_deg
        for edge in (focus.lat_min, focus.lat_max, focus.lon_min, focus.lon_max):
            assert edge % step == pytest.approx(0.0)

    def test_trimming_never_reduces_the_box_to_nothing(self, poller):
        poller.set_viewport(BBox.parse("40,-75,60,-45"))
        focus = poller.focus_bbox()
        if focus is not None:
            assert focus.width_deg > 0 and focus.height_deg > 0

    def test_a_wrapping_viewport_is_skipped_rather_than_split(self, poller):
        # Splitting would double the credit cost of an unpredictable subset of
        # polls and break the budget guarantee (D25).
        poller.set_viewport(BBox.parse("58,178,62,-178"))
        assert poller.focus_bbox() is None

    def test_the_viewport_is_snapped_outward_to_the_grid(self, poller):
        # Outward, so the snapped box always contains the real viewport --
        # rounding inward would leave a sliver of the screen unpolled.
        poller.set_viewport(BBox.parse("40.1,-74.9,41.2,-73.1"))
        snapped = poller.focus_bbox()
        assert snapped.lat_min <= 40.1 and snapped.lat_max >= 41.2
        assert snapped.lon_min <= -74.9 and snapped.lon_max >= -73.1
        assert snapped.lat_min % poller.settings.focus_grid_snap_deg == pytest.approx(0.0)

    def test_snapping_makes_a_nudged_camera_reuse_the_same_box(self, poller):
        # Otherwise every mouse drag spends a credit.
        poller.set_viewport(BBox.parse("40.1,-74.9,41.2,-73.1"))
        first = poller.focus_bbox()
        poller.set_viewport(BBox.parse("40.2,-74.8,41.3,-73.0"))
        assert poller.focus_bbox() == first

    def test_snapping_never_leaves_valid_coordinate_range(self, poller):
        poller.set_viewport(BBox.parse("-90,-180,-88,-178"))
        snapped = poller.focus_bbox()
        assert snapped.lat_min >= -90.0 and snapped.lon_min >= -180.0

    @pytest.mark.anyio
    async def test_a_skipped_focus_poll_costs_nothing_and_waits(self, poller, provider):
        delay = await tick(poller, "viewport")
        assert provider.calls == []
        assert status_of(poller, "viewport").skipped_polls == 1
        assert delay > 0

    @pytest.mark.anyio
    async def test_the_focus_poll_sends_the_snapped_box(self, poller, provider):
        poller.set_viewport(BBox.parse("40,-75,42,-73"))
        await tick(poller, "viewport")
        assert provider.calls == [poller.focus_bbox()]

    def test_a_small_focus_box_costs_a_single_credit(self, poller):
        poller.set_viewport(BBox.parse("40,-75,42,-73"))
        assert poller.credits_per_call(job_of(poller, "viewport")) == 1

    def test_tier_two_engages_at_a_zoom_the_camera_can_actually_reach(self, poller):
        # The bug this guards: with the engage threshold at 400 sq deg and the
        # camera unable to get closer than a ~1260 sq deg view, tier 2 was dead
        # code that could never fire at any zoom level (D36).
        # A camera 0.005 globe radii up sees a cap of ~5.7 degrees.
        poller.set_viewport(BBox.parse("-5.7,-5.7,5.7,5.7"))
        assert poller.focus_bbox() is not None

    def test_a_skipped_focus_poll_is_billed_as_zero(self, poller):
        assert poller.credits_per_call(job_of(poller, "viewport")) == 0


# ---------------------------------------------------------------------------
# Retry and backoff
# ---------------------------------------------------------------------------


class TestRetryAndBackoff:
    @pytest.mark.anyio
    async def test_a_failure_is_recorded_without_raising(self, poller, provider):
        # A poller that dies on error takes the whole display down with it.
        provider.error = ProviderUnavailable("upstream down")
        await tick(poller, "global")
        status = status_of(poller, "global")
        assert status.consecutive_failures == 1
        assert "ProviderUnavailable" in status.last_error
        assert not status.healthy

    @pytest.mark.anyio
    async def test_backoff_grows_with_consecutive_failures(self, poller, provider):
        provider.error = ProviderUnavailable("down")
        delays = [await tick(poller, "global") for _ in range(3)]
        assert delays[0] < delays[1] < delays[2]

    @pytest.mark.anyio
    async def test_backoff_is_capped(self, poller, provider):
        provider.error = ProviderUnavailable("down")
        for _ in range(20):
            delay = await tick(poller, "global")
        assert delay <= MAX_BACKOFF_SECONDS * 1.15  # cap plus jitter

    @pytest.mark.anyio
    async def test_recovery_resets_the_failure_count(self, poller, provider):
        provider.error = ProviderUnavailable("down")
        await tick(poller, "global")
        await tick(poller, "global")
        provider.error = None
        await tick(poller, "global")
        status = status_of(poller, "global")
        assert status.consecutive_failures == 0
        assert status.failed_polls == 2
        assert status.successful_polls == 1

    @pytest.mark.anyio
    async def test_an_unexpected_exception_is_contained(self, poller, provider):
        # Anything outside ProviderError is a bug, but it still must not kill
        # the loop -- it is logged and treated as a failure.
        provider.error = RuntimeError("programming error")
        delay = await tick(poller, "global")
        assert status_of(poller, "global").consecutive_failures == 1
        assert delay > 0


class TestRateLimiting:
    @pytest.mark.anyio
    async def test_a_429_pauses_polling_for_the_window_upstream_gave(self, poller, provider):
        provider.error = ProviderRateLimited("slow down", retry_after=600.0)
        delay = await tick(poller, "global")
        assert delay == pytest.approx(600.0, rel=0.15)

    @pytest.mark.anyio
    async def test_the_pause_applies_to_every_job_because_quota_is_shared(
        self, poller, provider
    ):
        poller.set_viewport(BBox.parse("40,-75,42,-73"))
        provider.error = ProviderRateLimited("slow down", retry_after=600.0)
        await tick(poller, "global")

        provider.error = None
        provider.calls.clear()
        await tick(poller, "viewport")
        assert provider.calls == []  # still paused
        assert status_of(poller, "viewport").skipped_polls == 1

    @pytest.mark.anyio
    async def test_a_429_without_a_window_falls_back_to_the_cap(self, poller, provider):
        provider.error = ProviderRateLimited("slow down")
        delay = await tick(poller, "global")
        assert delay == pytest.approx(MAX_BACKOFF_SECONDS, rel=0.15)


# ---------------------------------------------------------------------------
# Quota throttling
# ---------------------------------------------------------------------------


class TestThrottling:
    @pytest.mark.anyio
    async def test_a_healthy_balance_polls_at_the_configured_interval(
        self, poller, provider
    ):
        provider.remaining_credits = 3000
        assert poller.throttle is ThrottleLevel.NORMAL
        assert await tick(poller, "global") == pytest.approx(300.0, rel=0.15)

    @pytest.mark.anyio
    async def test_a_draining_balance_lengthens_the_interval(self, poller, provider):
        provider.remaining_credits = 1000  # 25% -> REDUCED, x2
        assert await tick(poller, "global") == pytest.approx(600.0, rel=0.15)

    @pytest.mark.anyio
    async def test_a_low_balance_cuts_the_latency_tier_first(self, poller, provider):
        # Losing tier 2 degrades freshness in one region; losing tier 1 empties
        # the globe.
        provider.remaining_credits = 500  # 12.5% -> MINIMAL
        poller.set_viewport(BBox.parse("40,-75,42,-73"))
        assert poller.focus_bbox() is None
        provider.calls.clear()
        await tick(poller, "global")
        assert provider.calls == [None]  # coverage tier still runs

    @pytest.mark.anyio
    async def test_an_exhausted_balance_stops_polling_entirely(self, poller, provider):
        provider.remaining_credits = 0
        await tick(poller, "global")
        assert provider.calls == []
        assert status_of(poller, "global").skipped_polls == 1

    @pytest.mark.anyio
    async def test_an_exhausted_balance_leaves_existing_data_intact(
        self, poller, provider, store
    ):
        await tick(poller, "global")
        provider.remaining_credits = 0
        await tick(poller, "global")
        assert store.object_count == 1  # still served from cache

    def test_status_reports_the_balance_and_the_projection(self, poller, provider):
        provider.remaining_credits = 3820
        status = poller.status()
        assert status.remaining_credits == 3820
        assert status.daily_allowance == 4000
        assert status.projected_daily_credits == 3072
        assert status.throttle is ThrottleLevel.NORMAL
        assert {j.name for j in status.jobs} == {"global", "viewport"}


# ---------------------------------------------------------------------------
# The outage case -- a phase 1 exit criterion
# ---------------------------------------------------------------------------


class TestOutageBehaviour:
    @pytest.mark.anyio
    async def test_data_survives_a_total_upstream_outage(self, poller, provider, store):
        await tick(poller, "global")
        assert store.object_count == 1

        provider.error = ProviderUnavailable("OpenSky is down")
        for _ in range(5):
            await tick(poller, "global")

        # The cache is untouched: a failed poll never calls into the store.
        assert store.object_count == 1
        assert store.get()[0].id == "a1"

    @pytest.mark.anyio
    async def test_an_outage_does_not_advance_the_freshness_clock(
        self, poller, provider, store
    ):
        await tick(poller, "global")
        first_success = store.last_success_at

        provider.error = ProviderUnavailable("down")
        await tick(poller, "global")

        assert store.last_success_at == first_success

    @pytest.mark.anyio
    async def test_data_is_flagged_stale_once_the_outage_outlasts_the_ttl(
        self, poller, provider, store
    ):
        await tick(poller, "global")
        fetched = store.last_success_at

        provider.error = ProviderUnavailable("down")
        await tick(poller, "global")

        assert not store.is_stale(now=fetched + timedelta(seconds=300))
        assert store.is_stale(now=fetched + timedelta(seconds=601))
        assert store.age_seconds(now=fetched + timedelta(seconds=601)) == pytest.approx(601.0)

    @pytest.mark.anyio
    async def test_an_outage_never_raises_out_of_the_poller(self, poller, provider):
        # If it did, the asyncio task would die and polling would never resume,
        # which looks identical to a hung backend.
        for error in (
            ProviderUnavailable("down"),
            ProviderRateLimited("limited", retry_after=1.0),
            RuntimeError("unexpected"),
        ):
            provider.error = error
            delay = await tick(poller, "global")
            assert delay > 0

    @pytest.mark.anyio
    async def test_recovery_repopulates_and_clears_the_error(
        self, poller, provider, store
    ):
        await tick(poller, "global")
        provider.error = ProviderUnavailable("down")
        await tick(poller, "global")

        provider.error = None
        provider.records = [record("a1"), record("a2", lat=41.0)]
        await tick(poller, "global")

        assert store.object_count == 2
        assert not store.is_stale()
        assert status_of(poller, "global").last_error is None

    @pytest.mark.anyio
    async def test_objects_still_expire_during_a_long_outage(
        self, poller, provider, store
    ):
        # Data is preserved, but not forever: an aircraft last seen an hour ago
        # is not "current, briefly unavailable". Eviction happens on the next
        # successful poll rather than during the outage, so the display keeps
        # last-known positions while upstream is unreachable.
        await tick(poller, "global")
        provider.error = ProviderUnavailable("down")
        await tick(poller, "global")
        assert store.object_count == 1

        # The next successful poll carries a timestamp past a1's TTL, so a1 is
        # evicted then -- not during the outage.
        provider.error = None
        provider.records = [record("a2", last_seen=NOW + timedelta(hours=2))]
        await tick(poller, "global")
        store.evict(now=NOW + timedelta(hours=2))
        assert {r.id for r in store.get()} == {"a2"}


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------


class TestLifecycle:
    @pytest.mark.anyio
    async def test_start_launches_one_task_per_job(self, poller):
        async def never(_delay):
            import asyncio

            await asyncio.Event().wait()

        poller._sleep = never
        await poller.start()
        try:
            assert len(poller._tasks) == len(poller.settings.jobs)
            assert poller.status().running
        finally:
            await poller.stop()

    @pytest.mark.anyio
    async def test_starting_twice_is_an_error(self, poller):
        async def never(_delay):
            import asyncio

            await asyncio.Event().wait()

        poller._sleep = never
        await poller.start()
        try:
            with pytest.raises(RuntimeError, match="already started"):
                await poller.start()
        finally:
            await poller.stop()

    @pytest.mark.anyio
    async def test_stop_cancels_tasks_and_closes_the_provider(self, poller, provider):
        async def never(_delay):
            import asyncio

            await asyncio.Event().wait()

        poller._sleep = never
        await poller.start()
        await poller.stop()
        assert poller._tasks == []
        assert provider.closed
        assert not poller.status().running

    @pytest.mark.anyio
    async def test_the_loop_keeps_running_across_failures(self, poller, provider, store):
        # Drive the real loop with an instant sleep, and stop it after a few
        # cycles, to prove failure handling does not terminate the task.
        ticks = 0

        async def counting_sleep(_delay):
            nonlocal ticks
            ticks += 1
            if ticks == 2:
                provider.error = ProviderUnavailable("transient")
            if ticks == 4:
                provider.error = None
            if ticks >= 6:
                poller._stopping.set()

        poller._sleep = counting_sleep
        await poller._run(job_of(poller, "global"))

        status = status_of(poller, "global")
        assert status.successful_polls >= 2
        assert status.failed_polls >= 1
        assert store.object_count == 1


class TestTheUnionsBalanceReachesTheLadder:
    """Defect #34, and why every test above missed it.

    ``FakeProvider`` sets ``remaining_credits`` on itself, so the throttling
    tests exercise a provider that is *more* capable than the real union one,
    which had no such attribute at all. The poller read it through a
    ``getattr`` default, so the union reported no balance, and
    ``throttle_for(None, ...)`` is NORMAL by design. The ladder was therefore
    dead in the only configuration that spends credits, and every test passed.

    These go through ``UnionProvider`` for that reason. A fake standing in for
    it would reintroduce exactly the gap that hid the defect.
    """

    @pytest.fixture
    def metered(self) -> FakeProvider:
        return FakeProvider()

    @pytest.fixture
    def union_poller(self, metered, store, settings) -> Poller:
        return Poller(UnionProvider(FakeProvider(), metered), store, settings)

    def test_the_metered_feed_s_balance_is_the_union_s(self, union_poller, metered):
        metered.remaining_credits = 3350
        assert union_poller.remaining_credits == 3350
        assert union_poller.status().remaining_credits == 3350

    def test_a_draining_balance_now_steps_the_ladder_down(self, union_poller, metered):
        metered.remaining_credits = 1000  # 25% of 4000
        assert union_poller.throttle is ThrottleLevel.REDUCED

    @pytest.mark.anyio
    async def test_an_exhausted_supplement_stops_the_union_polling(
        self, union_poller, metered
    ):
        # The free primary is still willing, but the poll is a single call to
        # the union and there is no way to buy half of it.
        metered.remaining_credits = 0
        await tick(union_poller, "global")
        assert status_of(union_poller, "global").skipped_polls == 1

    def test_a_free_pairing_reports_no_balance_rather_than_zero(
        self, union_poller
    ):
        # Nothing has been polled yet. None means "we do not know", which the
        # ladder reads as normal; zero would mean exhausted and refuse to start.
        assert union_poller.remaining_credits is None
        assert union_poller.throttle is ThrottleLevel.NORMAL
