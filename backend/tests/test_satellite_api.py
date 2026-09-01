"""The satellite endpoints.

Offline throughout: the app is built with a provider whose elements come from
the committed fixture, so nothing here depends on CelesTrak or SatNOGS being
up. That is not incidental caution - both were returning errors on the day this
was written.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import offline_routes

from app.config import Settings
from app.main import create_app
from app.orbits import tle_epoch
from app.providers.satellites import SatelliteProvider, elements_from_file

FIXTURE = Path(__file__).parent / "fixtures" / "satellites_sample.json"


def fixture_now():
    rows = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return max(tle_epoch(r["TLE_LINE1"]) for r in rows) + timedelta(hours=1)


@pytest.fixture
def client(monkeypatch):
    """An app whose satellite layer reads committed elements and never dials out."""
    monkeypatch.setattr("app.providers.satellites.utcnow", lambda: fixture_now())

    settings = Settings(provider="fixture", satellite_layer_enabled=True)
    app = create_app(settings, routes=offline_routes())

    original = SatelliteProvider.__init__

    def offline_init(self, **kwargs):
        kwargs["fetch_elements"] = elements_from_file(FIXTURE)
        kwargs["cache_path"] = None
        original(self, **kwargs)

    monkeypatch.setattr(SatelliteProvider, "__init__", offline_init)
    with TestClient(app) as c:
        yield c


class TestListing:
    def test_returns_every_satellite(self, client):
        body = client.get("/api/satellites").json()
        assert body["returned"] == body["total"] > 0
        assert body["type"] == "satellite"

    def test_objects_carry_the_universal_shape(self, client):
        first = client.get("/api/satellites").json()["objects"][0]
        assert set(first) >= {
            "id", "lat", "lon", "altitude", "velocity", "heading",
            "label", "model", "lastSeen", "type",
        }
        assert first["type"] == "satellite"
        assert first["model"] is None

    def test_never_reports_itself_as_stale(self, client):
        # A computed position has no age to go stale. The aircraft layer's
        # `stale` flag answers "how long since anyone told us"; nobody tells us
        # anything here (D95).
        body = client.get("/api/satellites").json()
        assert body["stale"] is False
        assert body["ageSeconds"] is None
        assert body["fetchedAt"] is None

    def test_a_bounding_box_narrows_the_result(self, client):
        everything = client.get("/api/satellites").json()["total"]
        northern = client.get("/api/satellites", params={"bbox": "0,-180,90,180"}).json()
        assert northern["total"] < everything
        assert all(o["lat"] >= 0 for o in northern["objects"])

    def test_a_malformed_box_is_the_clients_mistake(self, client):
        assert client.get("/api/satellites", params={"bbox": "nonsense"}).status_code == 422


class TestNotCached:
    def test_no_etag_is_offered(self, client):
        # Deliberate. Every request legitimately produces different positions,
        # so a 304 could only serve the client its own older body and freeze
        # the sky - which is defect #14 exactly (D95).
        assert "etag" not in {k.lower() for k in client.get("/api/satellites").headers}

    def test_a_conditional_request_still_gets_a_body(self, client):
        response = client.get("/api/satellites", headers={"If-None-Match": 'W/"anything"'})
        assert response.status_code == 200
        assert response.json()["objects"]


class TestDetail:
    def test_one_satellite_by_catalogue_number(self, client):
        listing = client.get("/api/satellites").json()["objects"]
        target = listing[0]["id"]
        body = client.get(f"/api/satellites/{target}").json()
        assert body["id"] == target
        assert body["meta"]["elementEpoch"]
        assert float(body["meta"]["elementAgeDays"]) >= 0

    def test_an_unknown_catalogue_number_is_404(self, client):
        assert client.get("/api/satellites/99999999").status_code == 404

    def test_the_track_is_empty_and_says_where_it_came_from(self, client):
        listing = client.get("/api/satellites").json()["objects"]
        body = client.get(f"/api/satellites/{listing[0]['id']}").json()
        # An orbit is computable rather than observed, so nothing is claimed
        # here until the panel that draws it exists.
        assert body["track"] == []
        assert body["trackSource"] == "provider"


class TestTheLayerCanBeSwitchedOff:
    def test_disabled_reports_404_not_503(self):
        # A permanent property of the deployment, not a transient failure.
        app = create_app(
            Settings(provider="fixture", satellite_layer_enabled=False),
            routes=offline_routes(),
        )
        with TestClient(app) as c:
            assert c.get("/api/satellites").status_code == 404

    def test_the_aircraft_layer_is_unaffected_either_way(self, client):
        assert client.get("/api/aircraft").json()["total"] > 0


class TestBothLayersAtOnce:
    def test_aircraft_and_satellites_are_served_side_by_side(self, client):
        # What the toggle needs: two populated layers, both present, so
        # switching between them is a client decision rather than a restart.
        aircraft = client.get("/api/aircraft").json()
        satellites = client.get("/api/satellites").json()
        assert aircraft["total"] > 0 and satellites["total"] > 0
        assert aircraft["type"] == "aircraft"
        assert satellites["type"] == "satellite"

    def test_the_two_layers_share_no_identifiers(self, client):
        aircraft = {o["id"] for o in client.get("/api/aircraft").json()["objects"]}
        satellites = {o["id"] for o in client.get("/api/satellites").json()["objects"]}
        assert aircraft.isdisjoint(satellites)
