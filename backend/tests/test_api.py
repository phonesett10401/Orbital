"""End-to-end tests for the API layer.

These run the real application through its real lifespan, against an injected
provider. That matters for the outage tests at the bottom: they exercise the
actual request path, not a stand-in for it.

The outage tests here complete a phase 1 exit criterion begun in
test_poller.py -- the ingestion tests proved the cache survives; these prove the
survival is visible over HTTP as a 200 with `stale: true`.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.conftest import offline_routes
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.providers.base import Provider, ProviderUnavailable

NOW = utcnow()


def record(object_id="a1", lat=40.0, lon=-74.0, altitude=10000.0, label=None, last_seen=None):
    return TrackedObjectRecord(
        id=object_id, lat=lat, lon=lon, altitude=altitude, velocity=240.0,
        heading=90.0, label=label or object_id.upper(),
        last_seen=last_seen or NOW, type=ObjectType.AIRCRAFT,
        meta={"originCountry": "United States"},
    )


class ControllableProvider(Provider):
    """A provider each test drives directly, so upstream can be made to fail."""

    name = "controllable"
    object_type = ObjectType.AIRCRAFT

    def __init__(self, records=None):
        self.records = records if records is not None else [
            record("a1", 40.7, -74.0, 10668.0, "UAL1234"),
            record("b2", 50.0, 8.5, 11200.0, "DLH441"),
            record("c3", -33.9, 151.2, 0.0, "QFA401"),
            record("d4", 60.0, 175.0, 10000.0, "AFL2201"),
            record("e5", 60.0, -175.0, 10000.0, "JAL61"),
        ]
        self.error: Exception | None = None
        self.remaining_credits: int | None = None
        self.calls = 0

    async def fetch(self, bbox: BBox | None = None):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return list(self.records)


def run_tick(poller, job, status) -> float:
    """Drive one poll cycle synchronously from a test.

    TestClient runs the app's lifespan (and the poller's sleeping tasks) on a
    portal thread. Those tasks are parked on a 300-second sleep, so stepping the
    poller here does not race them -- it just advances the same shared state the
    running app reads.
    """
    return asyncio.run(poller._tick(job, status))


@pytest.fixture
def provider() -> ControllableProvider:
    return ControllableProvider()


@pytest.fixture
def settings() -> Settings:
    return Settings(quota_preset="authenticated", provider="fixture")


@pytest.fixture
def client(provider, settings):
    """A live app. Entering the context manager runs the lifespan, which starts
    the poller -- so by the first request the store is already populated."""
    app = create_app(settings=settings, provider=provider, routes=offline_routes())
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# GET /api/aircraft
# ---------------------------------------------------------------------------


class TestListAircraft:
    def test_returns_the_stored_aircraft(self, client):
        body = client.get("/api/aircraft").json()
        assert body["returned"] == 5
        assert body["total"] == 5
        assert {o["id"] for o in body["objects"]} == {"a1", "b2", "c3", "d4", "e5"}

    def test_objects_use_the_camel_case_contract(self, client):
        obj = client.get("/api/aircraft").json()["objects"][0]
        assert set(obj) == {
            "id", "lat", "lon", "altitude", "velocity",
            "heading", "label", "model", "lastSeen", "type",
        }

    def test_meta_is_projected_away_from_list_responses(self, client):
        # The mechanism that keeps a 2000-object payload small (D4).
        for obj in client.get("/api/aircraft").json()["objects"]:
            assert "meta" not in obj

    def test_envelope_reports_freshness(self, client):
        body = client.get("/api/aircraft").json()
        assert body["stale"] is False
        assert body["source"] == "controllable"
        assert body["ageSeconds"] >= 0
        assert body["fetchedAt"] is not None

    def test_filters_by_bounding_box(self, client):
        body = client.get("/api/aircraft", params={"bbox": "30,-80,50,-60"}).json()
        assert {o["id"] for o in body["objects"]} == {"a1"}
        assert body["total"] == 1

    def test_a_bounding_box_crossing_the_antimeridian_finds_both_sides(self, client):
        body = client.get("/api/aircraft", params={"bbox": "50,170,70,-170"}).json()
        assert {o["id"] for o in body["objects"]} == {"d4", "e5"}

    def test_an_empty_box_returns_an_empty_result_not_an_error(self, client):
        body = client.get("/api/aircraft", params={"bbox": "0,0,1,1"}).json()
        assert body["objects"] == []
        assert body["total"] == 0
        assert body["stale"] is False

    @pytest.mark.parametrize(
        "bad", ["nonsense", "1,2,3", "1,2,3,4,5", "10,20,five,40", "50,-100,30,-80", "95,0,99,10"]
    )
    def test_a_malformed_bounding_box_is_a_client_error(self, client, bad):
        # 422 rather than silently serving the globe, which would look like a bug.
        assert client.get("/api/aircraft", params={"bbox": bad}).status_code == 422

    def test_limit_caps_the_result(self, client):
        body = client.get("/api/aircraft", params={"limit": 2}).json()
        assert body["returned"] == 2
        assert body["total"] == 5

    def test_total_and_returned_differ_when_thinned(self, client):
        # This is how the frontend knows it is showing a sample.
        body = client.get("/api/aircraft", params={"limit": 2}).json()
        assert body["returned"] < body["total"]

    def test_a_zero_limit_is_rejected(self, client):
        assert client.get("/api/aircraft", params={"limit": 0}).status_code == 422

    def test_requesting_a_box_reports_the_viewport_to_the_poller(self, client):
        # This is what drives tier 2 polling (D21).
        poller = client.app.state.poller
        client.get("/api/aircraft", params={"bbox": "40,-75,42,-73"})
        assert poller.focus_bbox() is not None

    def test_a_zoomed_out_request_does_not_trigger_the_focus_tier(self, client):
        poller = client.app.state.poller
        client.get("/api/aircraft", params={"bbox": "-60,-170,60,170"})
        assert poller.focus_bbox() is None


# ---------------------------------------------------------------------------
# GET /api/aircraft/{id}
# ---------------------------------------------------------------------------


class TestAircraftDetail:
    def test_returns_the_full_record(self, client):
        body = client.get("/api/aircraft/a1").json()
        assert body["label"] == "UAL1234"
        assert body["altitude"] == 10668.0
        assert body["meta"]["originCountry"] == "United States"

    def test_detail_includes_the_observed_track(self, client):
        body = client.get("/api/aircraft/a1").json()
        assert len(body["track"]) >= 1
        assert set(body["track"][0]) == {"lat", "lon", "altitude", "timestamp"}

    def test_identifiers_are_matched_case_insensitively(self, client):
        assert client.get("/api/aircraft/A1").json()["id"] == "a1"

    def test_an_unknown_identifier_is_a_404(self, client):
        response = client.get("/api/aircraft/zzzzzz")
        assert response.status_code == 404
        assert "not tracked" in response.json()["detail"]

    def test_the_search_route_is_not_swallowed_as_an_identifier(self, client):
        # Route ordering: /search is declared before /{object_id}.
        assert client.get("/api/aircraft/search", params={"q": "UAL"}).status_code == 200


# ---------------------------------------------------------------------------
# GET /api/aircraft/search
# ---------------------------------------------------------------------------


class TestSearch:
    def test_finds_by_full_callsign(self, client):
        body = client.get("/api/aircraft/search", params={"q": "UAL1234"}).json()
        assert [o["id"] for o in body["objects"]] == ["a1"]

    def test_search_is_case_insensitive(self, client):
        body = client.get("/api/aircraft/search", params={"q": "ual1234"}).json()
        assert [o["id"] for o in body["objects"]] == ["a1"]

    def test_finds_by_partial_callsign(self, client):
        body = client.get("/api/aircraft/search", params={"q": "DLH"}).json()
        assert [o["id"] for o in body["objects"]] == ["b2"]

    def test_finds_by_identifier(self, client):
        body = client.get("/api/aircraft/search", params={"q": "c3"}).json()
        assert [o["id"] for o in body["objects"]] == ["c3"]

    def test_searches_outside_the_current_viewport(self, client):
        # The whole reason search is server-side.
        client.get("/api/aircraft", params={"bbox": "40,-75,42,-73"})
        body = client.get("/api/aircraft/search", params={"q": "QFA401"}).json()
        assert [o["id"] for o in body["objects"]] == ["c3"]

    def test_no_match_is_an_empty_result_not_a_404(self, client):
        response = client.get("/api/aircraft/search", params={"q": "NOSUCH"})
        assert response.status_code == 200
        assert response.json()["objects"] == []

    def test_an_empty_query_is_rejected(self, client):
        assert client.get("/api/aircraft/search", params={"q": ""}).status_code == 422

    def test_results_are_bounded(self, client):
        assert client.get(
            "/api/aircraft/search", params={"q": "A", "limit": 2}
        ).json()["returned"] <= 2


# ---------------------------------------------------------------------------
# GET /api/health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_reports_ok_when_polling_succeeds(self, client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["provider"] == "controllable"
        assert body["polling"] is True
        assert body["objectCount"] == 5
        assert body["stale"] is False

    def test_reports_the_quota_position(self, client):
        quota = client.get("/api/health").json()["quota"]
        assert quota["preset"] == "authenticated"
        assert quota["dailyAllowance"] == 4000
        assert quota["projectedDailyCredits"] == 3072
        assert quota["throttle"] == "normal"

    def test_reports_the_observed_credit_balance(self, client, provider):
        provider.remaining_credits = 3820
        assert client.get("/api/health").json()["quota"]["remainingCredits"] == 3820

    def test_reports_each_job(self, client):
        jobs = client.get("/api/health").json()["jobs"]
        assert {j["name"] for j in jobs} == {"global", "viewport"}
        assert {j["tier"] for j in jobs} == {1, 2}

    def test_health_answers_200_even_when_degraded(self, client, provider):
        # This endpoint describes the system; it is not itself a failure signal.
        provider.error = ProviderUnavailable("down")
        assert client.get("/api/health").status_code == 200


# ---------------------------------------------------------------------------
# The outage case, end to end -- a phase 1 exit criterion
# ---------------------------------------------------------------------------


class TestOutageOverHttp:
    def test_a_failing_provider_leaves_the_response_intact_and_flags_it(
        self, provider, settings
    ):
        app = create_app(settings=settings, provider=provider, routes=offline_routes())
        with TestClient(app) as client:
            assert client.get("/api/aircraft").json()["returned"] == 5

            store = client.app.state.store
            poller = client.app.state.poller
            provider.error = ProviderUnavailable("OpenSky is down")

            # Age the successful poll past the TTL and run failing ticks.
            job = next(j for j in poller.settings.jobs if j.name == "global")
            status = poller._statuses["global"]
            for _ in range(3):
                run_tick(poller, job, status)

            response = client.get("/api/aircraft")
            body = response.json()

            assert response.status_code == 200          # never a 5xx
            assert body["returned"] == 5                # data preserved
            assert status.consecutive_failures == 3     # upstream really failed

            # Now push the clock past the TTL by rewriting the last success.
            store._last_success_at = store.last_success_at - timedelta(
                seconds=settings.snapshot_ttl + 60
            )
            stale_body = client.get("/api/aircraft").json()
            assert stale_body["stale"] is True
            assert stale_body["ageSeconds"] > settings.snapshot_ttl
            assert stale_body["returned"] == 5          # still served

    def test_detail_and_search_also_survive_an_outage(self, provider, settings):
        app = create_app(settings=settings, provider=provider, routes=offline_routes())
        with TestClient(app) as client:
            provider.error = ProviderUnavailable("down")
            assert client.get("/api/aircraft/a1").status_code == 200
            assert client.get(
                "/api/aircraft/search", params={"q": "UAL"}
            ).status_code == 200

    def test_health_reports_degraded_during_an_outage(self, provider, settings):
        app = create_app(settings=settings, provider=provider, routes=offline_routes())
        with TestClient(app) as client:
            poller = client.app.state.poller
            provider.error = ProviderUnavailable("down")

            job = next(j for j in poller.settings.jobs if j.name == "global")
            run_tick(poller, job, poller._statuses["global"])

            body = client.get("/api/health").json()
            assert body["status"] == "degraded"
            global_job = next(j for j in body["jobs"] if j["name"] == "global")
            assert global_job["healthy"] is False
            assert "ProviderUnavailable" in global_job["lastError"]

    def test_an_empty_store_reports_stale_rather_than_fresh(self, settings):
        # Telling the frontend an empty globe is current would be worse than
        # telling it we have nothing.
        provider = ControllableProvider(records=[])
        provider.error = ProviderUnavailable("down from the start")
        app = create_app(settings=settings, provider=provider, routes=offline_routes())
        with TestClient(app) as client:
            body = client.get("/api/aircraft").json()
            assert body["stale"] is True
            assert body["objects"] == []
            assert body["ageSeconds"] is None
            assert client.get("/api/health").json()["status"] == "starting"


# ---------------------------------------------------------------------------
# Documentation and CORS
# ---------------------------------------------------------------------------


class TestApplicationSurface:
    def test_openapi_schema_is_served(self, client):
        # A graded artifact we get for free from FastAPI (D2).
        schema = client.get("/openapi.json").json()
        assert "/api/aircraft" in schema["paths"]
        assert "/api/aircraft/{object_id}" in schema["paths"]
        assert "/api/health" in schema["paths"]

    def test_cors_allows_the_vite_dev_server(self, client):
        response = client.get(
            "/api/aircraft", headers={"Origin": "http://localhost:5173"}
        )
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"

    def test_no_satellite_endpoint_exists_yet(self, client):
        # Permanent tripwire against undeclared scope growth (D37).
        paths = client.get("/openapi.json").json()["paths"]
        assert not any("satellite" in p for p in paths)
