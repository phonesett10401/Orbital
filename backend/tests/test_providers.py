"""Tests for the Provider interface and the fixture provider.

The fixture provider is load-bearing infrastructure, not a toy: the API tests,
the thinning tests and all of frontend development run against it. If it is
wrong, everything downstream is being tested against a lie.
"""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from app.geo import EARTH_RADIUS_M, destination_point, wrap_longitude
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.providers import registry
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderError,
    ProviderRateLimited,
    ProviderUnavailable,
)
from app.providers.fixture import DEFAULT_FIXTURE, FixtureProvider


@pytest.fixture
def provider() -> FixtureProvider:
    return FixtureProvider(animate=False)


class TestFixtureProviderLoading:
    @pytest.mark.anyio
    async def test_loads_every_record_from_the_committed_fixture(self, provider):
        objects = await provider.fetch()
        assert len(objects) == len(json.loads(DEFAULT_FIXTURE.read_text(encoding="utf-8")))
        assert all(isinstance(o, TrackedObjectRecord) for o in objects)

    @pytest.mark.anyio
    async def test_every_object_is_an_aircraft(self, provider):
        assert {o.type for o in await provider.fetch()} == {ObjectType.AIRCRAFT}

    @pytest.mark.anyio
    async def test_ids_are_unique(self, provider):
        objects = await provider.fetch()
        assert len({o.id for o in objects}) == len(objects)

    @pytest.mark.anyio
    async def test_carries_origin_country_in_meta(self, provider):
        # Detail panel requirement. It lives in meta, not the core shape,
        # because it is aircraft-specific.
        objects = await provider.fetch()
        assert any(o.meta.get("originCountry") for o in objects)

    @pytest.mark.anyio
    async def test_fixture_includes_null_measurement_edge_cases(self, provider):
        # Real OpenSky data has these; if the fixture did not, we would only
        # discover our null handling was broken against the live feed.
        objects = await provider.fetch()
        assert any(o.velocity is None for o in objects)
        assert any(o.altitude is None for o in objects)

    def test_missing_file_raises_a_provider_error(self, tmp_path):
        with pytest.raises(ProviderBadResponse):
            FixtureProvider(tmp_path / "nope.json")

    def test_malformed_json_raises_a_provider_error(self, tmp_path):
        bad = tmp_path / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        with pytest.raises(ProviderBadResponse):
            FixtureProvider(bad)

    def test_non_list_fixture_raises_a_provider_error(self, tmp_path):
        bad = tmp_path / "obj.json"
        bad.write_text('{"id": "a"}', encoding="utf-8")
        with pytest.raises(ProviderBadResponse):
            FixtureProvider(bad)


class TestFixtureProviderBehaviour:
    @pytest.mark.anyio
    async def test_restamps_last_seen_so_data_never_reads_as_stale(self, provider):
        before = utcnow()
        objects = await provider.fetch()
        assert all(o.last_seen >= before for o in objects)

    @pytest.mark.anyio
    async def test_animation_moves_objects_along_their_heading(self, tmp_path):
        # Due east at 100 m/s from the equator.
        path = tmp_path / "one.json"
        path.write_text(
            json.dumps(
                [{
                    "id": "a", "lat": 0.0, "lon": 0.0, "altitude": 10000.0,
                    "velocity": 100.0, "heading": 90.0, "label": "TEST1",
                    "lastSeen": "2026-08-25T12:00:00Z", "type": "aircraft", "meta": {},
                }]
            ),
            encoding="utf-8",
        )
        p = FixtureProvider(path, animate=True)
        p._started_at = utcnow() - timedelta(seconds=100)  # 100 s at 100 m/s = 10 km east

        (obj,) = await p.fetch()
        assert obj.lon > 0.0
        assert obj.lat == pytest.approx(0.0, abs=1e-6)
        expected_lon = 10_000.0 / EARTH_RADIUS_M * 180.0 / 3.141592653589793
        assert obj.lon == pytest.approx(expected_lon, rel=1e-3)

    @pytest.mark.anyio
    async def test_animation_leaves_objects_with_unknown_velocity_in_place(self, tmp_path):
        path = tmp_path / "still.json"
        path.write_text(
            json.dumps(
                [{
                    "id": "a", "lat": 51.0, "lon": -0.4, "altitude": 0.0,
                    "velocity": None, "heading": None, "label": "TEST2",
                    "lastSeen": "2026-08-25T12:00:00Z", "type": "aircraft", "meta": {},
                }]
            ),
            encoding="utf-8",
        )
        p = FixtureProvider(path, animate=True)
        p._started_at = utcnow() - timedelta(seconds=600)

        (obj,) = await p.fetch()
        assert (obj.lat, obj.lon) == (51.0, -0.4)

    @pytest.mark.anyio
    async def test_animated_positions_stay_valid_over_a_long_run(self):
        # Ten minutes of dead reckoning must not push anything past a pole or
        # off the end of the longitude range; either would fail validation and
        # silently drop the object.
        p = FixtureProvider(animate=True)
        p._started_at = utcnow() - timedelta(minutes=10)
        objects = await p.fetch()
        assert len(objects) > 0
        assert all(-90.0 <= o.lat <= 90.0 for o in objects)
        assert all(-180.0 <= o.lon <= 180.0 for o in objects)

    @pytest.mark.anyio
    async def test_bbox_is_a_hint_and_may_be_ignored(self, provider):
        # Documented contract: callers must not assume the result is confined
        # to the bbox. The API layer filters again.
        tiny = BBox.parse("0,0,0.001,0.001")
        assert len(await provider.fetch(tiny)) == len(await provider.fetch())


class TestFixtureProviderFailureInjection:
    @pytest.mark.anyio
    async def test_can_be_made_to_fail_on_demand(self, provider):
        provider.set_failure(ProviderUnavailable("simulated outage"))
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_failure_can_be_cleared(self, provider):
        provider.set_failure(ProviderUnavailable("down"))
        provider.set_failure(None)
        assert len(await provider.fetch()) > 0


class TestProviderErrorContract:
    def test_every_provider_error_shares_one_base(self):
        # The poller catches ProviderError and only ProviderError; anything
        # outside this hierarchy is a bug we want loud.
        for exc in (ProviderUnavailable, ProviderRateLimited, ProviderBadResponse):
            assert issubclass(exc, ProviderError)

    def test_rate_limit_carries_retry_after_when_upstream_supplies_it(self):
        assert ProviderRateLimited("slow down", retry_after=120.0).retry_after == 120.0

    def test_rate_limit_retry_after_is_optional(self):
        assert ProviderRateLimited("slow down").retry_after is None

    def test_provider_cannot_be_instantiated_without_fetch(self):
        class Incomplete(Provider):
            name = "incomplete"
            object_type = ObjectType.AIRCRAFT

        with pytest.raises(TypeError):
            Incomplete()

    @pytest.mark.anyio
    async def test_aclose_defaults_to_a_no_op(self, provider):
        assert await provider.aclose() is None


class TestRegistry:
    def test_fixture_provider_is_registered(self):
        assert "fixture" in registry.available()

    def test_builds_a_working_provider_by_name(self):
        assert isinstance(registry.build("fixture"), FixtureProvider)

    def test_unknown_name_fails_loudly_and_lists_the_valid_ones(self):
        # A typo in an env var should stop startup, not produce an empty globe.
        with pytest.raises(KeyError, match="fixture"):
            registry.build("opensky-typo")

    def test_no_satellite_provider_exists_yet(self):
        # A permanent guard, not a temporary one. Satellite tracking was
        # considered and is not being built; this fails loudly if it reappears
        # without a deliberate decision to take the project there (D37).
        assert not any("satellite" in name for name in registry.available())


class TestGeo:
    def test_wraps_longitude_past_the_antimeridian(self):
        assert wrap_longitude(187.4) == pytest.approx(-172.6)
        assert wrap_longitude(-187.4) == pytest.approx(172.6)
        assert wrap_longitude(0.0) == 0.0

    def test_zero_distance_is_a_no_op(self):
        assert destination_point(45.0, -70.0, 90.0, 0.0) == (45.0, -70.0)

    def test_travelling_north_increases_latitude(self):
        lat, _ = destination_point(0.0, 0.0, 0.0, 111_195.0)  # ~1 degree
        assert lat == pytest.approx(1.0, rel=1e-3)

    def test_crossing_the_antimeridian_produces_a_valid_longitude(self):
        # Starting just west of the line, heading east: the naive result is
        # 180.5, which fails model validation and drops the aircraft.
        _, lon = destination_point(60.0, 179.5, 90.0, 200_000.0)
        assert -180.0 <= lon <= 180.0
        assert lon < 0.0  # wrapped into the eastern hemisphere's negative side

    def test_does_not_blow_up_at_the_pole(self):
        lat, lon = destination_point(89.9, 0.0, 0.0, 50_000.0)
        assert -90.0 <= lat <= 90.0
        assert -180.0 <= lon <= 180.0
