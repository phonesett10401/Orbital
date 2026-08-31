"""The one search box: aircraft now, airports always.

Three things are worth pinning, and the merge itself is not one of them.

**A code beats a description.** Someone typing LHR means Heathrow. An airport
whose name merely contains those letters must not outrank it.

**A commercial airport beats a farm strip.** The table holds 28,291 airports
and most have no scheduled service. Searching "London" and being answered with
two private airfields is the failure this guards.

**The two kinds stay apart.** An aircraft is an observation with an age; an
airport is a fixed place. Ranking one against the other would invent a
comparison that does not exist.
"""

from __future__ import annotations

from datetime import timezone, datetime

import pytest

from fastapi.testclient import TestClient

from app.airports import search_airports
from app.config import Settings
from app.main import create_app
from app.models import ObjectType, TrackedObjectRecord
from tests.conftest import offline_routes

NOW = datetime(2026, 8, 31, 12, 0, tzinfo=timezone.utc)


class TestAirportSearch:
    def test_a_code_finds_exactly_one_airport(self) -> None:
        found = search_airports("LHR")
        assert found[0].iata == "LHR"
        assert found[0].municipality == "London"

    def test_an_icao_code_works_as_well_as_an_iata_one(self) -> None:
        # Both are printed in the panel, so both must be searchable.
        assert search_airports("VYYY")[0].iata == "RGN"

    def test_a_city_returns_its_airports_not_its_airstrips(self) -> None:
        # Without the IATA-first rule this answered with two private fields.
        found = search_airports("London", limit=5)
        assert all(a.iata for a in found)

    def test_a_distinctive_word_beats_a_literal_name(self) -> None:
        # "Heathrow" is not the start of "London Heathrow Airport", so matching
        # only whole-string prefixes ranked an unrelated field above it.
        assert search_airports("heathro")[0].iata == "LHR"

    def test_a_search_result_claims_no_distance(self) -> None:
        # There is no point to measure from, the same as a scheduled airport.
        assert search_airports("BKK")[0].distance_km is None

    def test_nothing_matches_nothing(self) -> None:
        assert search_airports("zzzzzznotanairport") == []

    def test_blank_is_not_a_search(self) -> None:
        assert search_airports("   ") == []

    def test_the_limit_is_honoured(self) -> None:
        assert len(search_airports("a", limit=3)) == 3


@pytest.fixture
def client():
    """A live app on the fixture provider, so the store has aircraft in it."""
    app = create_app(
        settings=Settings(quota_preset="authenticated", provider="fixture"),
        routes=offline_routes(),
    )
    with TestClient(app) as test_client:
        yield test_client


class TestTheEndpoint:
    def test_it_returns_both_kinds(self, client) -> None:
        body = client.get("/api/search", params={"q": "LHR"}).json()
        assert "aircraft" in body and "airports" in body
        assert body["airports"][0]["iata"] == "LHR"

    def test_an_aircraft_and_an_airport_can_both_match(self, client) -> None:
        client.app.state.store.apply(
            [
                TrackedObjectRecord(
                    id="abc123",
                    lat=1.0,
                    lon=2.0,
                    altitude=10000.0,
                    velocity=200.0,
                    heading=90.0,
                    label="BKK123",
                    last_seen=NOW,
                    type=ObjectType.AIRCRAFT,
                )
            ],
            source="test",
            fetched_at=NOW,
        )
        body = client.get("/api/search", params={"q": "BKK"}).json()
        assert [a["label"] for a in body["aircraft"]] == ["BKK123"]
        assert any(a["iata"] == "BKK" for a in body["airports"])

    def test_an_empty_query_is_refused(self, client) -> None:
        assert client.get("/api/search", params={"q": ""}).status_code == 422
