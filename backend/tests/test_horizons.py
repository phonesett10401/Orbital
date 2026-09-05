"""Lunar spacecraft: parsing, interpolation, and what happens when JPL says no.

The fixture is a real Horizons response, captured on 2026-09-05, rather than a
handwritten approximation of one. Horizons' header is long, changes between
releases, and carries the same numbers in a different shape than you would
invent - a fixture written from memory would test the parser against the
author's idea of the format (D134).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from app.providers.horizons import (
    AU_KM,
    LUNAR_CRAFT,
    MOON_RADIUS_KM,
    HorizonsError,
    ephemeris_params,
    interpolate,
    normalise_longitude,
    parse_ephemeris,
    shortest_arc,
)
from app.providers.lunar import LunarTracker

FIXTURE = (Path(__file__).parent / "fixtures" / "horizons_lro.txt").read_text()

UTC = timezone.utc


def at(hour: int, minute: int) -> datetime:
    return datetime(2026, 9, 5, hour, minute, tzinfo=UTC)


class TestParsing:
    def test_reads_every_row_between_the_markers(self) -> None:
        rows = parse_ephemeris(FIXTURE)
        assert len(rows) == 13
        assert rows[0].when == at(0, 0)
        assert rows[-1].when == at(1, 0)

    def test_turns_range_into_an_altitude_above_the_surface(self) -> None:
        # Horizons reports the distance from the spacecraft to the Moon's
        # centre, in AU. Forgetting either the unit or the radius gives a
        # number that still looks like a number.
        rows = parse_ephemeris(FIXTURE)
        assert 60 < min(r.altitude_km for r in rows) < 120
        assert 60 < max(r.altitude_km for r in rows) < 120

    def test_matches_the_orbit_LRO_actually_has(self) -> None:
        # A low polar orbit: the latitude must sweep most of the way from one
        # pole to the other inside a single hour.
        rows = parse_ephemeris(FIXTURE)
        assert max(r.lat for r in rows) > 75
        assert min(r.lat for r in rows) < -5

    def test_normalises_longitude_for_the_map(self) -> None:
        # Horizons gives 0..360 east; MapLibre wants -180..180. Passing the raw
        # value through puts half of every orbit off the right edge of the map.
        rows = parse_ephemeris(FIXTURE)
        assert all(-180 <= r.lon <= 180 for r in rows)
        # The fixture contains longitudes above 180, so this is not vacuous.
        assert any(r.lon < 0 for r in rows)

    def test_raises_rather_than_returning_an_empty_track(self) -> None:
        # "No ephemeris" arrives as a 200 with prose in the body. Returned as
        # an empty list it would render as a spacecraft that quietly vanished.
        with pytest.raises(HorizonsError) as caught:
            parse_ephemeris("No ephemeris for target after A.D. 2026-AUG-14")
        assert "2026-AUG-14" in str(caught.value)

    def test_repeats_what_horizons_said_about_a_bad_centre(self) -> None:
        with pytest.raises(HorizonsError) as caught:
            parse_ephemeris('getbody() cannot find station file "OBSCODE.-192"')
        assert "OBSCODE" in str(caught.value)

    def test_skips_an_unreadable_row_without_losing_the_window(self) -> None:
        broken = FIXTURE.replace(
            " 2026-Sep-05 00:05     124.705447",
            " 2026-Sep-05 00:05     bananas   ",
        )
        assert len(parse_ephemeris(broken)) == 12


class TestLongitude:
    def test_wraps_into_the_range_the_map_uses(self) -> None:
        assert normalise_longitude(0) == 0
        assert normalise_longitude(90) == 90
        assert normalise_longitude(270) == -90
        assert normalise_longitude(359) == pytest.approx(-1)

    def test_keeps_the_antimeridian_on_one_side(self) -> None:
        # 180 and -180 are the same line; flipping between them makes a track
        # jitter across the whole map.
        assert normalise_longitude(180) == 180
        assert normalise_longitude(-180) == 180

    def test_crosses_the_antimeridian_the_short_way(self) -> None:
        # The bug this prevents: interpolating 179 to -179 as -358 sends the
        # spacecraft backwards across the entire Moon in one step.
        assert shortest_arc(179, -179) == pytest.approx(2)
        assert shortest_arc(-179, 179) == pytest.approx(-2)
        assert shortest_arc(10, 20) == pytest.approx(10)


class TestInterpolation:
    def test_lands_exactly_on_a_sample(self) -> None:
        rows = parse_ephemeris(FIXTURE)
        got = interpolate(rows, at(0, 5))
        assert got is not None
        assert got.lat == pytest.approx(rows[1].lat, abs=1e-6)

    def test_sits_between_two_samples(self) -> None:
        rows = parse_ephemeris(FIXTURE)
        got = interpolate(rows, at(0, 2))
        assert got is not None
        assert min(rows[0].lat, rows[1].lat) < got.lat < max(rows[0].lat, rows[1].lat)

    def test_returns_nothing_outside_the_window(self) -> None:
        # Not the nearest sample: past the end the honest answer is that we do
        # not know yet, and a frozen spacecraft looks like a tracked one.
        rows = parse_ephemeris(FIXTURE)
        assert interpolate(rows, at(5, 0)) is None
        assert interpolate(rows, at(0, 0) - timedelta(minutes=1)) is None

    def test_returns_nothing_for_an_empty_window(self) -> None:
        assert interpolate([], at(0, 30)) is None

    def test_does_not_jump_the_long_way_round_the_moon(self) -> None:
        # Built rather than taken from the fixture, so the antimeridian case is
        # covered whether or not a real pass happens to cross it.
        rows = parse_ephemeris(FIXTURE)
        near_edge = [
            rows[0].__class__(when=at(0, 0), lon=179.0, lat=0.0, altitude_km=100.0),
            rows[0].__class__(when=at(0, 10), lon=-179.0, lat=0.0, altitude_km=100.0),
        ]
        middle = interpolate(near_edge, at(0, 5))
        assert middle is not None
        assert abs(middle.lon) > 179.0


class TestTheQuery:
    def test_asks_for_the_moon_as_seen_from_the_spacecraft(self) -> None:
        # The inversion that makes Horizons do the frame work: the target is
        # the Moon and the centre is the craft, so quantity 14 comes back as
        # the sub-spacecraft point in selenographic coordinates.
        params = ephemeris_params("-85", at(0, 0), at(6, 0), 1)
        assert params["COMMAND"] == "'301'"
        assert params["CENTER"] == "'@-85'"
        assert "14" in params["QUANTITIES"]

    def test_carries_the_window_and_the_step(self) -> None:
        params = ephemeris_params("-155", at(0, 0), at(6, 0), 2)
        assert params["START_TIME"] == "'2026-09-05 00:00'"
        assert params["STOP_TIME"] == "'2026-09-05 06:00'"
        assert params["STEP_SIZE"] == "'2 m'"


class TestTheFleet:
    def test_holds_only_spacecraft_with_a_live_ephemeris(self) -> None:
        # CAPSTONE's ephemeris ends 2026-AUG-14 and ARTEMIS P1/P2 cannot be
        # used as an observer centre at all. Both were checked against Horizons
        # and left out; drawing them would be inventing a position.
        ids = {c.horizons_id for c in LUNAR_CRAFT}
        assert ids == {"-85", "-155", "-152"}

    def test_every_craft_says_who_flies_it_and_what_it_is_for(self) -> None:
        for craft in LUNAR_CRAFT:
            assert craft.name and craft.operator and craft.purpose

    def test_the_moon_radius_is_the_one_horizons_measures_from(self) -> None:
        assert MOON_RADIUS_KM == pytest.approx(1737.4)
        assert AU_KM == pytest.approx(149_597_870.7)


def _transport(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class TestTheTracker:
    @pytest.mark.anyio
    async def test_holds_a_window_and_serves_positions_from_it(self) -> None:
        client = _transport(lambda request: httpx.Response(200, text=FIXTURE))
        tracker = LunarTracker(client=client, now=lambda: at(0, 0))
        assert await tracker.refresh() == 3
        positions = tracker.positions(at(0, 30))
        assert len(positions) == 3
        assert {p["name"] for p in positions} == {
            "LRO",
            "Danuri",
            "Chandrayaan-2 Orbiter",
        }
        await tracker.aclose()

    @pytest.mark.anyio
    async def test_one_spacecraft_failing_does_not_lose_the_others(self) -> None:
        # Horizons drops individual objects when their ephemeris expires -
        # exactly what CAPSTONE was doing - and that must not take the working
        # ones down with it.
        def handler(request: httpx.Request) -> httpx.Response:
            if "-155" in str(request.url):
                return httpx.Response(200, text="No ephemeris for target")
            return httpx.Response(200, text=FIXTURE)

        tracker = LunarTracker(client=_transport(handler), now=lambda: at(0, 0))
        assert await tracker.refresh() == 2
        assert {p["name"] for p in tracker.positions(at(0, 30))} == {
            "LRO",
            "Chandrayaan-2 Orbiter",
        }
        await tracker.aclose()

    @pytest.mark.anyio
    async def test_an_upstream_outage_is_not_an_outage_here(self) -> None:
        # The property that makes a window worth holding: once fetched, JPL can
        # go away and the layer keeps working until the window runs out.
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] > 3:
                raise httpx.ConnectError("JPL is down")
            return httpx.Response(200, text=FIXTURE)

        tracker = LunarTracker(client=_transport(handler), now=lambda: at(0, 0))
        await tracker.refresh()
        assert tracker.held() == 3
        assert len(tracker.positions(at(0, 30))) == 3

    @pytest.mark.anyio
    async def test_does_not_refetch_a_window_that_is_still_good(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, text=FIXTURE)

        # The fixture covers one hour, so a clock inside it needs no refresh
        # only if the window is long enough - here it is not, which is the
        # point: a short window *should* be refetched.
        tracker = LunarTracker(client=_transport(handler), now=lambda: at(0, 0))
        await tracker.refresh()
        first = calls["n"]
        await tracker.refresh()
        assert calls["n"] > first

    @pytest.mark.anyio
    async def test_leaves_out_a_spacecraft_whose_window_has_run_out(self) -> None:
        tracker = LunarTracker(
            client=_transport(lambda request: httpx.Response(200, text=FIXTURE)),
            now=lambda: at(0, 0),
        )
        await tracker.refresh()
        # Long past the end of the fixture's hour.
        assert tracker.positions(at(23, 0)) == []
