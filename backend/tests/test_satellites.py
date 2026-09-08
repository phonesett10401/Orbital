"""Tests for the satellite provider.

Entirely offline, against a committed element fixture. The elements in it are
real and therefore have real epochs, so every test pins "now" near those
epochs rather than using the wall clock -- otherwise the whole file would start
failing a week after it was written, which is exactly the freshness rule the
provider is enforcing.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.models import BBox, ObjectType
from app.orbits import tle_epoch
from app.providers.base import ProviderBadResponse, ProviderUnavailable
from app.providers.satellite_names import DirectoryEntry
from app.providers.satellites import (
    SatelliteProvider,
    elements_from_file,
    parse_elements,
)

FIXTURE = Path(__file__).parent / "fixtures" / "satellites_sample.json"


def fixture_rows() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def fixture_now() -> datetime:
    """A moment shortly after the newest element set in the fixture."""
    newest = max(tle_epoch(row["TLE_LINE1"]) for row in fixture_rows())
    return newest + timedelta(hours=1)


@pytest.fixture(autouse=True)
def frozen_now(monkeypatch):
    """Pin the clock the provider reads, so committed elements stay fresh.

    **Autouse, because opting in was not enough.** The module docstring above
    has always said every test pins "now" near the fixture's epochs - but four
    tests in `TestNamesAreASecondUpstream` never asked for this fixture, and on
    2026-09-08 they began failing: the newest element set in the fixture was
    7.10 days old against the provider's seven-day freshness rule, so `fetch`
    correctly returned nothing and `assert len(records) > 0` failed.

    Nothing had changed in the code. The fixture simply expired, exactly as the
    docstring predicted it would, and the rule that would have prevented it was
    written down but not enforced. A test that requires a fixture to opt in is
    a rule the next test can forget.

    A test that wants a different clock still overrides this: its own
    `monkeypatch.setattr` runs after the autouse fixture.
    """
    moment = fixture_now()
    monkeypatch.setattr("app.providers.satellites.utcnow", lambda: moment)
    return moment


async def _no_directory() -> dict:
    """The name directory, switched off.

    Injected by default because a test that supplies its own elements has said
    it controls the network, and the name lookup is a *second* upstream that
    would otherwise still be dialled. Adding it without this default made seven
    tests reach db.satnogs.org and time out (D117).
    """
    return {}


def provider(**kwargs) -> SatelliteProvider:
    kwargs.setdefault("fetch_elements", elements_from_file(FIXTURE))
    kwargs.setdefault("fetch_names", _no_directory)
    return SatelliteProvider(**kwargs)


class TestParsingBothUpstreamShapes:
    """CelesTrak and SatNOGS agree on substance and on nothing else."""

    def test_reads_the_celestrak_omm_shape(self):
        rows = [{
            "OBJECT_NAME": "ISS (ZARYA)",
            "NORAD_CAT_ID": 25544,
            "EPOCH": "2026-08-31T20:28:48.859000",
            "TLE_LINE1": fixture_rows()[0]["TLE_LINE1"],
            "TLE_LINE2": fixture_rows()[0]["TLE_LINE2"],
        }]
        parsed = parse_elements(rows)
        assert len(parsed) == 1
        assert parsed[0].catalog_id == "25544"
        assert parsed[0].epoch.tzinfo is timezone.utc

    def test_reads_the_satnogs_shape_and_strips_its_name_marker(self):
        row = fixture_rows()[0]
        parsed = parse_elements([{
            "tle0": "0 ISS (ZARYA)",
            "tle1": row["TLE_LINE1"],
            "tle2": row["TLE_LINE2"],
        }])
        # The leading "0 " is the TLE name-line marker, not part of the name.
        assert parsed[0].name == "ISS (ZARYA)"
        # No NORAD field in this shape, so it falls back to the element line.
        assert parsed[0].catalog_id == "25544"

    def test_rows_without_element_lines_are_skipped_not_fatal(self):
        row = fixture_rows()[0]
        parsed = parse_elements([
            {"OBJECT_NAME": "no elements here"},
            {"tle1": row["TLE_LINE1"], "tle2": row["TLE_LINE2"]},
        ])
        assert len(parsed) == 1

    def test_a_non_list_payload_is_a_bad_response(self):
        with pytest.raises(ProviderBadResponse):
            parse_elements({"error": "nope"})


class TestFetching:
    @pytest.mark.anyio
    async def test_returns_a_record_for_every_usable_element_set(self, frozen_now):
        records = await provider().fetch()
        assert len(records) == len(fixture_rows())
        assert {r.type for r in records} == {ObjectType.SATELLITE}

    @pytest.mark.anyio
    async def test_positions_are_orbital(self, frozen_now):
        for record in await provider().fetch():
            assert record.altitude is not None and record.altitude > 200_000
            assert record.velocity is not None and 6_000 < record.velocity < 9_000
            assert record.heading is not None

    @pytest.mark.anyio
    async def test_last_seen_is_the_propagation_instant_not_the_epoch(self, frozen_now):
        # The decision in D94, asserted where it is actually implemented. Using
        # the epoch here would have every satellite evicted by the store on the
        # poll that created it.
        records = await provider().fetch()
        for record in records:
            assert record.last_seen == frozen_now
            epoch = datetime.fromisoformat(record.meta["elementEpoch"])
            assert epoch < record.last_seen

    @pytest.mark.anyio
    async def test_element_age_is_carried_in_meta_where_the_panel_can_show_it(
        self, frozen_now
    ):
        record = (await provider().fetch())[0]
        assert 0.0 <= float(record.meta["elementAgeDays"]) <= 7.0

    @pytest.mark.anyio
    async def test_model_is_always_none(self, frozen_now):
        # D94: the catalogue's answer is identical for every row we draw, and
        # orbit class is derived by us rather than said by the source.
        assert all(r.model is None for r in await provider().fetch())

    @pytest.mark.anyio
    async def test_reports_no_credits_because_nothing_here_is_metered(self):
        assert provider().remaining_credits is None


class TestRefusingStaleElements:
    @pytest.mark.anyio
    async def test_elements_beyond_the_age_limit_are_dropped_not_drawn(
        self, monkeypatch
    ):
        # Same fixture, asked about a moment a year later. SGP4 would answer
        # for every one of them; the provider refuses instead.
        far_future = fixture_now() + timedelta(days=365)
        monkeypatch.setattr("app.providers.satellites.utcnow", lambda: far_future)
        assert await provider().fetch() == []

    @pytest.mark.anyio
    async def test_a_stale_set_does_not_take_the_fresh_ones_with_it(self, frozen_now):
        rows = fixture_rows()
        rows.append({
            "OBJECT_NAME": "ANCIENT",
            "NORAD_CAT_ID": "00005",
            "TLE_LINE1": "1 00005U 58002B   75179.78495062  .00000023  00000-0  28098-4 0  4753",
            "TLE_LINE2": "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667",
        })

        async def mixed():
            return parse_elements(rows)

        records = await provider(fetch_elements=mixed).fetch()
        assert len(records) == len(fixture_rows())
        assert "ANCIENT" not in {r.label for r in records}


class TestElementCaching:
    @pytest.mark.anyio
    async def test_elements_are_fetched_once_and_reused(self, frozen_now):
        calls = 0

        async def counting():
            nonlocal calls
            calls += 1
            return parse_elements(fixture_rows())

        p = provider(fetch_elements=counting)
        await p.fetch()
        await p.fetch()
        await p.fetch()
        # Positions are recomputed every time; elements are not refetched.
        assert calls == 1

    @pytest.mark.anyio
    async def test_a_failed_refresh_keeps_the_elements_we_already_have(
        self, frozen_now, monkeypatch
    ):
        # The reliability claim for this layer, made executable: an upstream
        # outage must be invisible, because day-old elements still put a
        # satellite within a kilometre or two of where it is.
        calls = 0

        async def flaky():
            nonlocal calls
            calls += 1
            if calls > 1:
                raise ProviderUnavailable("celestrak is returning 500 again")
            return parse_elements(fixture_rows())

        p = provider(fetch_elements=flaky, refresh_seconds=0.0)
        first = await p.fetch()
        second = await p.fetch()
        assert calls == 2                      # it did try again
        assert len(second) == len(first)       # and lost nothing when it failed

    @pytest.mark.anyio
    async def test_a_failure_with_nothing_cached_is_an_error(self):
        async def broken():
            raise ProviderUnavailable("cold start, no elements anywhere")

        with pytest.raises(ProviderUnavailable):
            await provider(fetch_elements=broken).fetch()


class TestSurvivingAnOutageAcrossARestart:
    """In-memory caching stops working the moment the process restarts.

    That is not hypothetical: CelesTrak and SatNOGS were both returning errors
    within the same minute on the day this provider was written. A restart in
    that window leaves the layer with nothing to draw, unless the elements were
    written somewhere that outlives the process.
    """

    @pytest.mark.anyio
    async def test_elements_are_written_to_disk_after_a_successful_fetch(
        self, frozen_now, tmp_path
    ):
        cache = tmp_path / "elements.json"
        await provider(cache_path=cache).fetch()
        assert cache.exists()
        assert len(json.loads(cache.read_text(encoding="utf-8"))) == len(fixture_rows())

    @pytest.mark.anyio
    async def test_a_fresh_process_uses_the_file_when_every_source_is_down(
        self, frozen_now, tmp_path
    ):
        cache = tmp_path / "elements.json"
        await provider(cache_path=cache).fetch()          # a healthy earlier run

        async def everything_is_down():
            raise ProviderUnavailable("celestrak 503, satnogs 502")

        restarted = provider(fetch_elements=everything_is_down, cache_path=cache)
        records = await restarted.fetch()
        assert len(records) == len(fixture_rows())

    @pytest.mark.anyio
    async def test_no_cache_and_no_network_still_fails_honestly(
        self, frozen_now, tmp_path
    ):
        async def everything_is_down():
            raise ProviderUnavailable("celestrak 503, satnogs 502")

        with pytest.raises(ProviderUnavailable):
            await provider(
                fetch_elements=everything_is_down, cache_path=tmp_path / "absent.json"
            ).fetch()

    @pytest.mark.anyio
    async def test_a_corrupt_cache_is_ignored_rather_than_fatal(
        self, frozen_now, tmp_path
    ):
        cache = tmp_path / "elements.json"
        cache.write_text("{ this is not json", encoding="utf-8")
        records = await provider(cache_path=cache).fetch()
        assert len(records) == len(fixture_rows())


class TestBoundingBox:
    @pytest.mark.anyio
    async def test_a_box_filters_the_result(self, frozen_now):
        everything = await provider().fetch()
        northern = await provider().fetch(BBox(lat_min=0, lon_min=-180, lat_max=90, lon_max=180))
        assert all(r.lat >= 0 for r in northern)
        assert len(northern) < len(everything)

    @pytest.mark.anyio
    async def test_an_empty_box_returns_nothing_rather_than_everything(self, frozen_now):
        tiny = BBox(lat_min=-0.001, lon_min=-0.001, lat_max=0.001, lon_max=0.001)
        assert await provider().fetch(tiny) == []


class TestRegistry:
    def test_it_is_reachable_by_name(self):
        from app.config import Settings
        from app.providers import registry

        built = registry.build(
            "satellites", Settings(provider="satellites", quota_preset="authenticated")
        )
        assert built.object_type is ObjectType.SATELLITE
        assert built.remaining_credits is None


class TestNamesAreASecondUpstream:
    """The name directory is a different service from the element feed."""

    @pytest.mark.anyio
    async def test_a_failed_directory_costs_nothing(self):
        """Positions survive a naming outage, because names are the nicety.

        The reliability argument for this layer is that an upstream failure is
        invisible. A *naming* failure has to be less than that again: the
        satellites still have orbits, and drawing them under placeholder names
        is enormously better than not drawing them (D117).
        """

        async def directory_is_down() -> dict:
            raise RuntimeError("db.satnogs.org unreachable")

        records = await provider(fetch_names=directory_is_down).fetch()
        assert len(records) > 0

    @pytest.mark.anyio
    async def test_the_name_reaches_the_record_the_api_returns(self):
        """Not merely resolved - actually carried through to what we serve.

        The vacuous version asserts `resolve_names` works, which is covered
        elsewhere and would stay green with the call deleted from the provider
        entirely. This reads the label off a record the provider handed back.
        """

        async def elements_with_a_placeholder():
            sets = await elements_from_file(FIXTURE)()
            for element in sets:
                if element.catalog_id == "25544":
                    element.name = "OBJECT A"
            return sets

        async def directory() -> dict:
            return {"25544": DirectoryEntry(name="ISS (ZARYA)")}

        records = await provider(
            fetch_elements=elements_with_a_placeholder, fetch_names=directory
        ).fetch()
        iss = next(r for r in records if r.id == "25544")
        assert iss.label == "ISS (ZARYA)"

    @pytest.mark.anyio
    async def test_a_real_name_is_never_replaced_by_the_directory(self):
        """The element feed is the authority; the directory only fills blanks."""

        async def directory() -> dict:
            return {"25544": DirectoryEntry(name="SOMETHING ELSE ENTIRELY")}

        records = await provider(fetch_names=directory).fetch()
        iss = next(r for r in records if r.id == "25544")
        assert iss.label == "ISS (ZARYA)"

    @pytest.mark.anyio
    async def test_a_picture_reaches_the_record_when_the_directory_has_one(self):
        """The image URL is carried into meta, where the panel can find it."""

        async def directory() -> dict:
            return {"25544": DirectoryEntry(image_url="https://db.satnogs.org/media/x.jpg")}

        records = await provider(fetch_names=directory).fetch()
        iss = next(r for r in records if r.id == "25544")
        assert iss.meta["imageUrl"] == "https://db.satnogs.org/media/x.jpg"

    @pytest.mark.anyio
    async def test_no_picture_means_no_key_rather_than_an_empty_one(self):
        """Two objects in three have no picture, and absence is not a value.

        An empty string in `imageUrl` would reach the frontend as a broken
        image; the key simply not being there is the honest shape, and it is
        what the panel branches on.
        """

        async def directory() -> dict:
            return {}

        records = await provider(fetch_names=directory).fetch()
        assert all("imageUrl" not in r.meta for r in records)
