"""Tests for server-side marker reduction."""

from __future__ import annotations

import pytest

from app.models import WORLD, BBox, ObjectType, TrackedObjectRecord, utcnow
from app.thinning import ALTITUDE_BUCKET_M, cell_of, grid_shape, rank_key, thin

NOW = utcnow()


def record(object_id, lat=0.0, lon=0.0, altitude=10000.0):
    return TrackedObjectRecord(
        id=object_id, lat=lat, lon=lon, altitude=altitude, velocity=240.0,
        heading=90.0, label=object_id.upper(), last_seen=NOW,
        type=ObjectType.AIRCRAFT, meta={},
    )


def spread(count, box=WORLD):
    """`count` objects spread evenly over a box, deterministically."""
    out = []
    cols = int(count**0.5) + 1
    for i in range(count):
        col, row = i % cols, i // cols
        out.append(
            record(
                f"a{i:05d}",
                lat=box.lat_min + (row + 0.5) / cols * box.height_deg % box.height_deg,
                lon=box.lon_min + (col + 0.5) / cols * box.width_deg % box.width_deg,
                altitude=1000.0 + (i % 12) * 1000.0,
            )
        )
    return out


class TestPassThrough:
    def test_a_set_within_the_limit_is_returned_whole(self):
        records = spread(50)
        assert len(thin(records, 2000)) == 50

    def test_pass_through_preserves_every_object(self):
        records = spread(50)
        assert {r.id for r in thin(records, 2000)} == {r.id for r in records}

    def test_an_empty_input_is_empty(self):
        assert thin([], 2000) == []

    def test_a_zero_limit_returns_nothing(self):
        assert thin(spread(10), 0) == []


class TestReduction:
    def test_never_returns_more_than_the_limit(self):
        assert len(thin(spread(5000), 2000)) <= 2000

    def test_returns_close_to_the_limit_when_there_is_enough_data(self):
        # A grid that returned far fewer than requested would be wasting the
        # budget the frontend can afford to render.
        selected = thin(spread(5000), 2000)
        assert len(selected) >= 1800

    def test_output_has_no_duplicates(self):
        selected = thin(spread(5000), 2000)
        assert len({r.id for r in selected}) == len(selected)

    def test_output_is_a_subset_of_the_input(self):
        records = spread(5000)
        ids = {r.id for r in records}
        assert {r.id for r in thin(records, 2000)}.issubset(ids)

    def test_is_deterministic(self):
        # Non-determinism here would make markers flicker on every poll.
        records = spread(5000)
        assert [r.id for r in thin(records, 500)] == [r.id for r in thin(records, 500)]

    def test_input_order_does_not_change_the_result(self):
        records = spread(3000)
        forward = {r.id for r in thin(records, 500)}
        backward = {r.id for r in thin(list(reversed(records)), 500)}
        assert forward == backward


class TestSpatialSpread:
    def test_survivors_are_spread_rather_than_clustered(self):
        # The failure this guards against: a naive "take the first N" leaves a
        # solid blob over one region and an empty globe elsewhere.
        dense = [record(f"d{i:04d}", lat=50.0, lon=8.0 + i * 0.001) for i in range(3000)]
        sparse = [record(f"s{i:04d}", lat=-30.0 + i, lon=140.0) for i in range(20)]

        selected = thin(dense + sparse, 100)
        kept_sparse = [r for r in selected if r.id.startswith("s")]
        assert len(kept_sparse) >= 10  # the quiet region is not erased

    def test_a_dense_region_is_reduced_but_not_removed(self):
        dense = [record(f"d{i:04d}", lat=50.0, lon=8.0 + i * 0.001) for i in range(3000)]
        sparse = [record(f"s{i:04d}", lat=-30.0 + i, lon=140.0) for i in range(20)]

        selected = thin(dense + sparse, 100)
        assert any(r.id.startswith("d") for r in selected)


class TestRanking:
    def test_higher_aircraft_outrank_lower_ones(self):
        high, low = record("b", altitude=11000.0), record("a", altitude=500.0)
        assert sorted([low, high], key=rank_key)[0].id == "b"

    def test_unknown_altitude_sorts_last(self):
        known, unknown = record("b", altitude=100.0), record("a", altitude=None)
        assert sorted([unknown, known], key=rank_key)[0].id == "b"

    def test_small_altitude_changes_do_not_reorder(self):
        # Stability: a hundred metres of climb must not reshuffle the display.
        before = [record("a", altitude=10000.0), record("b", altitude=10400.0)]
        after = [record("a", altitude=10100.0), record("b", altitude=10300.0)]
        assert [r.id for r in sorted(before, key=rank_key)] == [
            r.id for r in sorted(after, key=rank_key)
        ]

    def test_a_full_bucket_of_climb_does_reorder(self):
        low = record("a", altitude=5000.0)
        high = record("b", altitude=5000.0 + ALTITUDE_BUCKET_M * 2)
        assert sorted([low, high], key=rank_key)[0].id == "b"

    def test_ties_are_broken_by_id(self):
        pair = [record("b", altitude=10000.0), record("a", altitude=10000.0)]
        assert [r.id for r in sorted(pair, key=rank_key)] == ["a", "b"]


class TestGrid:
    def test_grid_has_roughly_the_requested_number_of_cells(self):
        cols, rows = grid_shape(WORLD, 2000)
        assert 1000 <= cols * rows <= 4000

    def test_grid_follows_the_aspect_ratio(self):
        # The world is twice as wide as it is tall.
        cols, rows = grid_shape(WORLD, 1000)
        assert cols > rows

    def test_a_tall_box_gets_more_rows_than_columns(self):
        cols, rows = grid_shape(BBox.parse("0,0,80,10"), 1000)
        assert rows > cols

    def test_grid_is_never_degenerate(self):
        cols, rows = grid_shape(BBox.parse("0,0,1,1"), 1)
        assert cols >= 1 and rows >= 1

    def test_cells_cover_the_corners_of_the_box(self):
        box = BBox.parse("30,-100,50,-80")
        cols, rows = grid_shape(box, 100)
        assert cell_of(record("a", 30.0, -100.0), box, cols, rows) == (0, 0)
        assert cell_of(record("b", 50.0, -80.0), box, cols, rows) == (cols - 1, rows - 1)

    def test_cells_bucket_correctly_across_the_antimeridian(self):
        # Naive subtraction gives a negative offset here and throws everything
        # into column zero, collapsing the spread the grid exists to provide.
        box = BBox.parse("50,170,70,-170")
        cols, rows = grid_shape(box, 100)
        west = cell_of(record("w", 60.0, 172.0), box, cols, rows)
        east = cell_of(record("e", 60.0, -172.0), box, cols, rows)
        assert west != east
        assert west[0] < east[0]

    def test_thinning_spreads_across_a_wrapping_box(self):
        box = BBox.parse("50,170,70,-170")
        records = (
            [record(f"w{i:03d}", lat=60.0, lon=171.0 + i * 0.01) for i in range(500)]
            + [record(f"e{i:03d}", lat=60.0, lon=-179.0 + i * 0.01) for i in range(500)]
        )
        selected = thin(records, 100, box)
        assert any(r.id.startswith("w") for r in selected)
        assert any(r.id.startswith("e") for r in selected)


class TestBoundingBoxDefaults:
    def test_no_bbox_thins_against_the_whole_globe(self):
        records = spread(5000)
        assert len(thin(records, 500, None)) == len(thin(records, 500, WORLD))

    def test_objects_outside_the_box_are_clamped_into_edge_cells(self):
        # thin() does not filter -- the store already did. An object outside the
        # box must still land in a valid cell rather than raising.
        box = BBox.parse("30,-100,50,-80")
        selected = thin([record("far", lat=-80.0, lon=170.0)] * 1, 2000, box)
        assert len(selected) == 1
