"""Tests for the object store: merging, track history, TTLs and eviction."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app.ingestion.store import ObjectStore
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow

# Anchored to the real clock rather than a literal date: eviction compares
# record timestamps against "now", so a hardcoded date would quietly start
# failing these tests once it aged past the object TTL.
NOW = utcnow()


def record(object_id="a1", lat=40.0, lon=-74.0, *, last_seen=NOW, label=None, **kw):
    return TrackedObjectRecord(
        id=object_id,
        lat=lat,
        lon=lon,
        altitude=kw.pop("altitude", 10000.0),
        velocity=kw.pop("velocity", 240.0),
        heading=kw.pop("heading", 90.0),
        label=label or object_id.upper(),
        last_seen=last_seen,
        type=ObjectType.AIRCRAFT,
        meta=kw.pop("meta", {"originCountry": "United States"}),
    )


@pytest.fixture
def store() -> ObjectStore:
    return ObjectStore(
        object_ttl_seconds=1800.0,
        track_history_points=5,
        snapshot_ttl_seconds=600.0,
    )


class TestMerging:
    def test_applies_records_and_counts_them(self, store):
        assert store.apply([record("a1"), record("a2")], source="fixture") == 2
        assert store.object_count == 2

    def test_a_later_poll_updates_an_existing_object_in_place(self, store):
        store.apply([record("a1", lat=40.0)], source="fixture")
        store.apply([record("a1", lat=41.0, last_seen=NOW + timedelta(seconds=60))], source="fixture")
        assert store.object_count == 1
        assert store.get()[0].lat == 41.0

    def test_a_regional_poll_does_not_erase_objects_outside_it(self, store):
        # The bug this guards against: with two-tier polling, a wholesale
        # snapshot replace on the 45-second viewport poll would flash the globe
        # empty twice a minute (D26).
        store.apply(
            [record("global1", lat=-30.0, lon=140.0), record("focus1", lat=40.0, lon=-74.0)],
            source="fixture",
        )
        store.apply(
            [record("focus1", lat=40.5, lon=-74.0, last_seen=NOW + timedelta(seconds=45))],
            source="fixture",
        )
        assert {r.id for r in store.get()} == {"global1", "focus1"}

    def test_records_which_provider_produced_the_data(self, store):
        store.apply([record()], source="opensky")
        assert store.source == "opensky"

    def test_applying_an_empty_result_still_counts_as_a_successful_poll(self, store):
        # A genuinely quiet bounding box returns nothing; that is not a failure,
        # and the freshness clock must still advance.
        store.apply([], source="fixture", fetched_at=NOW)
        assert store.last_success_at == NOW


class TestTrackHistory:
    def test_each_poll_appends_a_track_point(self, store):
        for i in range(3):
            store.apply(
                [record("a1", lat=40.0 + i, last_seen=NOW + timedelta(seconds=60 * i))],
                source="fixture",
            )
        assert store.track_length("a1") == 3

    def test_track_points_are_oldest_first(self, store):
        for i in range(3):
            store.apply(
                [record("a1", lat=40.0 + i, last_seen=NOW + timedelta(seconds=60 * i))],
                source="fixture",
            )
        detail = store.get_detail("a1")
        timestamps = [p.timestamp for p in detail.track]
        assert timestamps == sorted(timestamps)

    def test_the_ring_buffer_bounds_the_route(self, store):
        for i in range(20):
            store.apply(
                [record("a1", lat=40.0 + i * 0.1, last_seen=NOW + timedelta(seconds=60 * i))],
                source="fixture",
            )
        assert store.track_length("a1") == 5           # configured maxlen
        assert store.get_detail("a1").track[-1].lat == pytest.approx(41.9)  # newest kept

    def test_repeated_polls_of_an_unchanged_object_do_not_fill_the_buffer(self, store):
        # Upstream reports the same last_contact until the aircraft sends a new
        # position. Appending those would evict the real route with duplicates.
        for _ in range(10):
            store.apply([record("a1", last_seen=NOW)], source="fixture")
        assert store.track_length("a1") == 1

    def test_a_track_point_carries_altitude_for_the_vertical_profile(self, store):
        store.apply([record("a1", altitude=9500.0)], source="fixture")
        assert store.get_detail("a1").track[0].altitude == 9500.0


class TestDetail:
    def test_detail_includes_meta_and_track(self, store):
        store.apply([record("a1")], source="fixture")
        detail = store.get_detail("a1")
        assert detail.meta["originCountry"] == "United States"
        assert len(detail.track) == 1

    def test_detail_of_an_unknown_id_is_none(self, store):
        assert store.get_detail("nope") is None


class TestBoundingBoxFiltering:
    def test_filters_to_the_box(self, store):
        store.apply(
            [record("inside", lat=40.0, lon=-74.0), record("outside", lat=-30.0, lon=140.0)],
            source="fixture",
        )
        assert [r.id for r in store.get(BBox.parse("30,-80,50,-60"))] == ["inside"]

    def test_no_box_returns_everything(self, store):
        store.apply([record("a1"), record("a2", lat=-30.0, lon=140.0)], source="fixture")
        assert len(store.get()) == 2

    def test_a_wrapping_box_finds_objects_on_both_sides(self, store):
        store.apply(
            [
                record("west", lat=60.0, lon=175.0),
                record("east", lat=60.0, lon=-175.0),
                record("elsewhere", lat=60.0, lon=0.0),
            ],
            source="fixture",
        )
        found = {r.id for r in store.get(BBox.parse("50,170,70,-170"))}
        assert found == {"west", "east"}


class TestSearch:
    def test_finds_by_callsign_case_insensitively(self, store):
        store.apply([record("a1", label="UAL1234")], source="fixture")
        assert [r.id for r in store.search("ual1234")] == ["a1"]

    def test_finds_by_identifier(self, store):
        store.apply([record("abc123", label="UAL1234")], source="fixture")
        assert [r.id for r in store.search("abc123")] == ["abc123"]

    def test_matches_a_prefix(self, store):
        store.apply([record("a1", label="UAL1234"), record("a2", label="DLH441")], source="fixture")
        assert [r.id for r in store.search("UAL")] == ["a1"]

    def test_an_exact_match_outranks_a_partial_one(self, store):
        # Typing a full callsign must put it first, not behind an
        # alphabetically earlier partial match.
        store.apply(
            [record("a1", label="UAL12345"), record("a2", label="UAL1234")], source="fixture"
        )
        assert store.search("UAL1234")[0].id == "a2"

    def test_search_is_bounded(self, store):
        store.apply([record(f"a{i}", label=f"UAL{i}") for i in range(50)], source="fixture")
        assert len(store.search("UAL", limit=10)) == 10

    def test_an_empty_query_matches_nothing(self, store):
        store.apply([record("a1")], source="fixture")
        assert store.search("   ") == []

    def test_search_covers_objects_outside_the_viewport(self, store):
        # The whole reason search is server-side: the client only holds what it
        # is looking at.
        store.apply([record("far", lat=-40.0, lon=170.0, label="ANZ12")], source="fixture")
        assert [r.id for r in store.search("ANZ12")] == ["far"]


class TestEviction:
    def test_objects_past_the_object_ttl_are_dropped(self, store):
        old = NOW - timedelta(seconds=3600)
        store.apply([record("stale1", last_seen=old), record("fresh1", last_seen=NOW)],
                    source="fixture", fetched_at=NOW)
        assert {r.id for r in store.get()} == {"fresh1"}

    def test_eviction_drops_track_history_with_the_object(self, store):
        old = NOW - timedelta(seconds=3600)
        store.apply([record("gone", last_seen=old)], source="fixture", fetched_at=NOW)
        assert store.track_length("gone") == 0
        assert store.get_detail("gone") is None

    def test_an_object_missing_from_one_poll_survives_until_its_ttl(self, store):
        # Aircraft drop out of coverage briefly. Removing them on the first
        # missed poll would make markers flicker.
        store.apply([record("a1", last_seen=NOW)], source="fixture", fetched_at=NOW)
        store.apply([record("a2", last_seen=NOW + timedelta(seconds=60))],
                    source="fixture", fetched_at=NOW + timedelta(seconds=60))
        assert {r.id for r in store.get()} == {"a1", "a2"}


class TestFreshness:
    def test_an_empty_store_is_stale(self, store):
        # Reporting otherwise would tell the frontend an empty globe is current.
        assert store.is_stale()
        assert store.age_seconds() is None

    def test_a_fresh_store_is_not_stale(self, store):
        store.apply([record()], source="fixture", fetched_at=NOW)
        assert not store.is_stale(now=NOW + timedelta(seconds=30))

    def test_age_past_the_snapshot_ttl_is_stale(self, store):
        store.apply([record()], source="fixture", fetched_at=NOW)
        assert store.is_stale(now=NOW + timedelta(seconds=601))

    def test_age_is_measured_from_the_last_successful_poll(self, store):
        store.apply([record()], source="fixture", fetched_at=NOW)
        assert store.age_seconds(now=NOW + timedelta(seconds=45)) == pytest.approx(45.0)


class TestObjectCap:
    """A ceiling on the store, not only on how old its contents may be (D193).

    The TTL bounds age; the size is then the number of distinct objects seen
    inside that window, which for a stream is a fact about the world rather than
    about the configuration. Capping the provider was not enough on its own - it
    holds a fixed number at a time but churns through more, and this store keeps
    the union of everything it was handed.
    """

    def _store(self, **kwargs) -> ObjectStore:
        return ObjectStore(
            object_ttl_seconds=900.0,
            track_history_points=10,
            snapshot_ttl_seconds=60.0,
            **kwargs,
        )

    def _record(self, key: str, seconds_ago: float) -> TrackedObjectRecord:
        return TrackedObjectRecord(
            id=key,
            lat=1.0,
            lon=2.0,
            altitude=0.0,
            velocity=None,
            heading=None,
            label=key,
            model=None,
            last_seen=utcnow() - timedelta(seconds=seconds_ago),
            type=ObjectType.SHIP,
        )

    def test_holds_everything_when_no_cap_is_set(self):
        store = self._store(max_objects=0)
        store.apply([self._record(str(i), 1) for i in range(60)], source="test")
        store.evict()
        assert len(store.get()) == 60

    def test_never_holds_more_than_the_cap(self):
        store = self._store(max_objects=10)
        store.apply([self._record(str(i), 1) for i in range(60)], source="test")
        store.evict()
        assert len(store.get()) == 10

    def test_keeps_the_most_recently_seen(self):
        store = self._store(max_objects=3)
        store.apply([self._record(key, age) for key, age in
                       [("a", 500), ("b", 5), ("c", 400), ("d", 1), ("e", 50)]], source="test")
        store.evict()
        assert {r.id for r in store.get()} == {"d", "b", "e"}

    def test_the_ttl_still_applies_under_the_cap(self):
        # Two independent limits. Something too old to serve goes even when
        # there is room, or the cap would resurrect the ghosts the TTL buries.
        store = self._store(max_objects=1000)
        store.object_ttl_seconds = 100.0
        store.apply([self._record("fresh", 5), self._record("ancient", 5000)], source="test")
        store.evict()
        assert {r.id for r in store.get()} == {"fresh"}

    def test_the_cap_is_enforced_on_the_write_path(self):
        # `apply` sweeps as it writes, so the ceiling holds without anything
        # else remembering to call `evict`. This is the property that matters:
        # a cap that only applied when someone asked would let the store grow
        # between polls, which is exactly when it grows.
        store = self._store(max_objects=3)
        store.apply([self._record(str(i), 1) for i in range(6)], source="test")
        assert len(store.get()) == 3

    def test_track_history_goes_with_the_object(self):
        # A route for something no longer displayed serves no purpose, and a
        # cap that dropped records but kept their tracks would leak exactly what
        # it was added to bound.
        store = self._store(max_objects=1)
        store.apply([self._record("keep", 1), self._record("drop", 900)], source="test")
        store.apply([self._record("keep", 1), self._record("drop", 900)], source="test")
        store.evict()
        assert "drop" not in store._tracks
