"""The OpenSky relay routes (D216): locked by a token, and storing what is posted."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.conftest import offline_routes
from tests.test_app_surface import BulkProvider

RAW_SAMPLE = Path(__file__).parent / "fixtures" / "opensky_raw_sample.json"
TOKEN = "test-relay-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def client(token: str = TOKEN) -> TestClient:
    settings = Settings(quota_preset="authenticated", provider="fixture", relay_token=token)
    return TestClient(create_app(settings=settings, provider=BulkProvider(0), routes=offline_routes()))


def test_routes_are_off_without_a_token():
    with client(token="") as c:
        assert c.get("/api/relay/wanted", headers=AUTH).status_code == 404


def test_a_wrong_token_is_refused_and_stores_nothing():
    with client() as c:
        r = c.post("/api/relay/opensky", content=RAW_SAMPLE.read_bytes(),
                   headers={"Authorization": "Bearer nope"})
        assert r.status_code == 401
        assert c.get("/api/health").json()["objectCount"] == 0


def test_a_gzipped_opensky_answer_lands_in_the_store():
    expected = len(json.loads(RAW_SAMPLE.read_text(encoding="utf-8"))["states"])
    with client() as c:
        r = c.post("/api/relay/opensky", content=gzip.compress(RAW_SAMPLE.read_bytes()),
                   headers={**AUTH, "Content-Encoding": "gzip"})
        assert r.status_code == 200
        assert 0 < r.json()["applied"] <= expected
        # The store started empty, so everything applied must now be held.
        assert c.get("/api/health").json()["objectCount"] == r.json()["applied"]


def test_garbage_is_a_400_not_a_crash():
    with client() as c:
        assert c.post("/api/relay/opensky", content=b"[1,2]", headers=AUTH).status_code == 400


def test_wanted_follows_viewers():
    with client() as c:
        assert c.get("/api/relay/wanted", headers=AUTH).json()["wanted"] is False
        c.get("/api/aircraft")
        assert c.get("/api/relay/wanted", headers=AUTH).json()["wanted"] is True


def test_a_clicked_aircraft_gets_the_track_the_relay_supplies():
    """D217: the detail request lists the id, the relay posts the path, the line is real."""
    path = [[1_790_000_000 + 60 * i, 13.0 + 0.1 * i, 100.0 + 0.1 * i, 11_000.0] for i in range(6)]
    with client() as c:
        c.post("/api/relay/opensky", content=RAW_SAMPLE.read_bytes(), headers=AUTH)
        object_id = c.get("/api/aircraft").json()["objects"][0]["id"]
        c.get("/api/relay/wanted", headers=AUTH)  # the relay checks in

        first = c.get(f"/api/aircraft/{object_id}").json()  # waits its budget, then answers
        assert first.get("trackSource") != "provider"
        assert c.get("/api/relay/wanted", headers=AUTH).json()["tracks"] == [object_id]

        r = c.post(f"/api/relay/track/{object_id}", json={"path": path}, headers=AUTH)
        assert r.json() == {"accepted": True}
        second = c.get(f"/api/aircraft/{object_id}").json()
        assert second["trackSource"] == "provider"
        assert c.get("/api/relay/wanted", headers=AUTH).json()["tracks"] == []
