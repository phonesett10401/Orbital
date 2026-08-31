"""Tests for the normalized data contract.

These are the most valuable tests in the backend: every other layer trusts
these guarantees, so a regression here is a regression everywhere.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from app.models import (
    WORLD,
    BBox,
    ObjectType,
    Snapshot,
    TrackedObject,
    TrackedObjectDetail,
    TrackedObjectRecord,
    TrackPoint,
)

NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)


def make_object(**overrides) -> TrackedObject:
    base = dict(
        id="abc123",
        lat=40.0,
        lon=-74.0,
        altitude=10000.0,
        velocity=240.0,
        heading=90.0,
        label="UAL123",
        last_seen=NOW,
        type=ObjectType.AIRCRAFT,
    )
    base.update(overrides)
    return TrackedObject(**base)


class TestTrackedObject:
    def test_serializes_to_camel_case_for_the_frontend(self):
        payload = make_object().model_dump(by_alias=True, mode="json")
        assert "lastSeen" in payload
        assert "last_seen" not in payload
        # The contract is exactly these ten fields, nothing more. `model` was
        # the tenth, added so the renderer can size an aircraft by what it
        # actually is; everything aircraft-specific still lives in meta.
        assert set(payload) == {
            "id", "lat", "lon", "altitude", "velocity",
            "heading", "label", "model", "lastSeen", "type",
        }

    def test_accepts_either_spelling_on_input(self):
        assert TrackedObject.model_validate(
            {
                "id": "a", "lat": 1.0, "lon": 2.0, "label": "X",
                "lastSeen": NOW, "type": "aircraft",
            }
        ).last_seen == NOW

    @pytest.mark.parametrize("lat", [-91.0, 91.0])
    def test_rejects_out_of_range_latitude(self, lat):
        with pytest.raises(ValidationError):
            make_object(lat=lat)

    @pytest.mark.parametrize("lon", [-181.0, 181.0])
    def test_rejects_out_of_range_longitude(self, lon):
        with pytest.raises(ValidationError):
            make_object(lon=lon)

    def test_normalizes_positive_180_to_negative_180(self):
        # Sources disagree on the sign at the antimeridian; we pick one so that
        # equality comparisons and bbox maths behave.
        assert make_object(lon=180.0).lon == -180.0

    @pytest.mark.parametrize(
        ("given", "expected"), [(0.0, 0.0), (359.9, 359.9), (360.0, 0.0), (450.0, 90.0)]
    )
    def test_wraps_heading_into_one_turn(self, given, expected):
        assert make_object(heading=given).heading == pytest.approx(expected)

    def test_rejects_naive_last_seen(self):
        # A naive datetime silently breaks every staleness comparison downstream.
        with pytest.raises(ValidationError):
            make_object(last_seen=datetime(2026, 8, 25, 12, 0))

    def test_converts_last_seen_to_utc(self):
        eastern = timezone(timedelta(hours=-4))
        obj = make_object(last_seen=datetime(2026, 8, 25, 8, 0, tzinfo=eastern))
        assert obj.last_seen == NOW
        assert obj.last_seen.tzinfo == timezone.utc

    def test_optional_measurements_default_to_none_not_zero(self):
        # Zero velocity means stationary; unknown velocity means unknown. The
        # frontend renders them differently, so they must not collapse.
        obj = TrackedObject(
            id="a", lat=0.0, lon=0.0, label="X", last_seen=NOW, type=ObjectType.AIRCRAFT
        )
        assert obj.altitude is None and obj.velocity is None and obj.heading is None

    def test_rejects_negative_velocity(self):
        with pytest.raises(ValidationError):
            make_object(velocity=-1.0)

    def test_is_immutable(self):
        # The store hands the same object to concurrent requests; nothing may
        # mutate it in place.
        with pytest.raises(ValidationError):
            make_object().lat = 1.0


class TestRecordAndDetail:
    def test_record_carries_meta_that_the_core_shape_omits(self):
        record = TrackedObjectRecord(
            **make_object().model_dump(), meta={"originCountry": "Germany"}
        )
        assert record.meta["originCountry"] == "Germany"

    def test_list_response_projects_meta_away(self):
        # This is the mechanism that keeps a 2000-object payload small: the API
        # declares TrackedObject as its response model.
        record = TrackedObjectRecord(**make_object().model_dump(), meta={"a": "b"})
        projected = TrackedObject.model_validate(record.model_dump())
        assert "meta" not in projected.model_dump(by_alias=True)

    def test_detail_defaults_to_an_empty_track(self):
        detail = TrackedObjectDetail(**make_object().model_dump())
        assert detail.track == ()

    def test_detail_carries_track_points_oldest_first(self):
        points = [
            TrackPoint(lat=40.0, lon=-74.0, altitude=10000.0, timestamp=NOW - timedelta(minutes=2)),
            TrackPoint(lat=40.1, lon=-73.5, altitude=10000.0, timestamp=NOW),
        ]
        detail = TrackedObjectDetail(**make_object().model_dump(), track=points)
        assert [p.timestamp for p in detail.track] == sorted(p.timestamp for p in points)


class TestBBox:
    def test_parses_the_query_string_form(self):
        box = BBox.parse("30,-100,50,-80")
        assert (box.lat_min, box.lon_min, box.lat_max, box.lon_max) == (30.0, -100.0, 50.0, -80.0)

    @pytest.mark.parametrize(
        "raw",
        [
            "30,-100,50",            # too few
            "30,-100,50,-80,10",     # too many
            "30,-100,fifty,-80",     # not numbers
            "50,-100,30,-80",        # latMin above latMax
            "30,-100,95,-80",        # latitude out of range
        ],
    )
    def test_rejects_malformed_input(self, raw):
        with pytest.raises(ValueError):
            BBox.parse(raw)

    def test_contains_points_inside_a_normal_box(self):
        box = BBox.parse("30,-100,50,-80")
        assert box.contains(40.0, -90.0)
        assert box.contains(30.0, -100.0)  # edges are inclusive

    def test_excludes_points_outside_a_normal_box(self):
        box = BBox.parse("30,-100,50,-80")
        assert not box.contains(20.0, -90.0)
        assert not box.contains(40.0, -70.0)

    def test_box_crossing_the_antimeridian_wraps(self):
        # The bug this guards against: a naive lonMin <= lon <= lonMax test
        # returns nothing at all here, and the Pacific silently empties out.
        box = BBox.parse("50,170,70,-170")
        assert box.crosses_antimeridian
        assert box.contains(60.0, 175.0)
        assert box.contains(60.0, -175.0)
        assert box.contains(60.0, 180.0)
        assert not box.contains(60.0, 0.0)
        assert not box.contains(60.0, 160.0)

    def test_width_is_correct_across_the_antimeridian(self):
        assert BBox.parse("50,170,70,-170").width_deg == pytest.approx(20.0)
        assert BBox.parse("30,-100,50,-80").width_deg == pytest.approx(20.0)

    def test_world_contains_every_corner(self):
        for lat in (-90.0, 0.0, 90.0):
            for lon in (-180.0, 0.0, 179.999):
                assert WORLD.contains(lat, lon)
        assert not WORLD.crosses_antimeridian


class TestSnapshot:
    def test_age_is_measured_from_fetch_time(self):
        snap = Snapshot(objects=(), fetched_at=NOW, source="fixture", type=ObjectType.AIRCRAFT)
        assert snap.age_seconds(now=NOW + timedelta(seconds=45)) == pytest.approx(45.0)

    def test_records_which_provider_produced_it(self):
        # Needed by /api/health, and by anyone debugging "why is the globe empty".
        snap = Snapshot(objects=(), fetched_at=NOW, source="fixture", type=ObjectType.AIRCRAFT)
        assert snap.source == "fixture"
