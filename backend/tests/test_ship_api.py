"""The ship endpoints, end to end through the real application.

Offline, but not by substituting the provider: the real ``DigitrafficProvider``
runs, against a mock transport carrying real records off the live feed. So the
decoding, the sentinel guards, the metadata join, the store, the poller and the
router are all in the path - which is the point of an end-to-end test and the
reason it is not simply a second unit test of the provider.

What these are really guarding is the claim D165 makes: that a third layer
touches nothing already there. Two of them check that directly, by asking the
aircraft and satellite endpoints for their own data while ships are running.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api.etag import compute_etag
from app.config import SHIP_JOBS, Settings
from app.main import create_app
from app.providers.digitraffic import DigitrafficProvider
from tests.conftest import offline_routes

# Real records, off the live feed on the day this was written.
VESSELS = [
    {
        "mmsi": 256371000,
        "name": "NOUNOU",
        "callSign": "9HA5814",
        "imo": 9960980,
        "shipType": 80,
        "draught": 82,
        "destination": "RUVYS",
        "eta": 602432,
        "referencePointA": 200,
        "referencePointB": 50,
        "referencePointC": 22,
        "referencePointD": 22,
    },
    {
        "mmsi": 230982000,
        "name": "VIKING GRACE",
        "callSign": "OJPT",
        "imo": 9606900,
        "shipType": 60,
        "draught": 68,
        "destination": "TURKU",
        "referencePointA": 150,
        "referencePointB": 68,
        "referencePointC": 15,
        "referencePointD": 16,
    },
]


def location(mmsi, lat, lon, sog=12.4, cog=59.9, heading=61, nav=0):
    return {
        "mmsi": mmsi,
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {
            "mmsi": mmsi,
            "sog": sog,
            "cog": cog,
            "navStat": nav,
            "heading": heading,
            "timestampExternal": 1788713524127,
        },
    }


LOCATIONS = [
    # A tanker in the Gulf of Finland, under way.
    location(256371000, 60.1, 24.9),
    # A ferry off Turku, moored - and reporting the AIS "not available"
    # sentinels for both speed and heading, which is what a berthed ship
    # usually sends.
    location(230982000, 60.45, 22.2, sog=102.3, cog=360.0, heading=511, nav=5),
    # A vessel with no metadata row at all: 13% of the feed is like this.
    location(999888777, 63.0, 20.5),
]


@pytest.fixture
def client(monkeypatch):
    """A live app whose ships layer answers from records rather than the sea."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/vessels"):
            return httpx.Response(200, json=VESSELS)
        return httpx.Response(
            200, json={"type": "FeatureCollection", "features": LOCATIONS}
        )

    original = DigitrafficProvider.__init__

    def offline_init(self, **kwargs):
        kwargs["client"] = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        original(self, **kwargs)

    monkeypatch.setattr(DigitrafficProvider, "__init__", offline_init)

    settings = Settings(
        provider="fixture",
        quota_preset="authenticated",
        ship_layer_enabled=True,
        satellite_layer_enabled=False,
        lunar_layer_enabled=False,
    )
    app = create_app(settings=settings, routes=offline_routes())
    with TestClient(app) as test_client:
        # The poller's first tick races the first request, so it is stepped
        # here rather than slept on: the same trick test_api.py uses, and for
        # the same reason - a sleeping test is a slow test that still flakes.
        poller = app.state.ship_poller
        job = SHIP_JOBS[0]
        asyncio.run(poller._tick(job, poller._statuses[job.name]))
        yield test_client


class TestListing:
    def test_returns_the_stored_vessels(self, client):
        body = client.get("/api/ships").json()
        assert body["returned"] == body["total"] == 3

    def test_the_envelope_says_ship_and_not_aircraft(self, client):
        # The aircraft router reads this off settings.object_type, which names
        # the aircraft source. Copied unthinkingly it labels every ship an
        # aeroplane, and nothing else in the response would contradict it.
        body = client.get("/api/ships").json()
        assert body["type"] == "ship"
        assert all(o["type"] == "ship" for o in body["objects"])

    def test_objects_use_the_camel_case_contract(self, client):
        obj = client.get("/api/ships").json()["objects"][0]
        assert set(obj) == {
            "id", "lat", "lon", "altitude", "velocity",
            "heading", "label", "model", "lastSeen", "type",
        }

    def test_a_bounding_box_filters(self, client):
        # The Gulf of Finland, which holds one of the three.
        body = client.get("/api/ships", params={"bbox": "59.5,24,60.5,25.5"}).json()
        assert [o["label"] for o in body["objects"]] == ["NOUNOU"]

    def test_a_malformed_box_is_the_clients_mistake(self, client):
        assert client.get("/api/ships", params={"bbox": "nonsense"}).status_code == 422


class TestDecodingSurvivesTheWholePath:
    def test_a_named_vessel_arrives_named(self, client):
        objects = {o["id"]: o for o in client.get("/api/ships").json()["objects"]}
        assert objects["256371000"]["label"] == "NOUNOU"
        assert objects["256371000"]["model"] == "Tanker"

    def test_a_vessel_with_no_metadata_still_arrives(self, client):
        objects = {o["id"]: o for o in client.get("/api/ships").json()["objects"]}
        assert objects["999888777"]["label"] == "999888777"
        assert objects["999888777"]["model"] is None

    def test_the_sentinels_never_reach_the_client(self, client):
        # The berthed ferry sends sog 102.3 and heading 511. Served as numbers
        # they draw a moored ship crossing the Baltic at 190 km/h.
        ferry = {o["id"]: o for o in client.get("/api/ships").json()["objects"]}["230982000"]
        assert ferry["velocity"] is None
        assert ferry["heading"] is None

    def test_sea_level_is_served_as_zero(self, client):
        objects = client.get("/api/ships").json()["objects"]
        assert all(o["altitude"] == 0.0 for o in objects)


class TestDetail:
    def test_one_vessel_carries_its_meta(self, client):
        body = client.get("/api/ships/256371000").json()
        assert body["label"] == "NOUNOU"
        assert body["meta"]["destination"] == "RUVYS"
        assert body["meta"]["draught"] == "8.2 m"
        assert body["meta"]["length"] == "250 m"
        assert body["meta"]["imo"] == "9960980"

    def test_a_berthed_ship_says_so_in_words(self, client):
        # Its speed is null, so without this the panel has nothing to explain
        # why - and "moored" is a different fact from "not moving".
        body = client.get("/api/ships/230982000").json()
        assert body["meta"]["navigationStatus"] == "Moored"

    def test_an_unknown_mmsi_is_404(self, client):
        assert client.get("/api/ships/111111111").status_code == 404

    def test_the_detail_needs_no_upstream(self, client):
        # The aircraft equivalent buys a track and a route on the click. AIS
        # carries its own destination, so this route performs no I/O - which is
        # why it is not async, and why nothing here is mocked to make it pass.
        assert client.get("/api/ships/256371000").status_code == 200


class TestSearch:
    def test_finds_a_vessel_by_name(self, client):
        body = client.get("/api/ships/search", params={"q": "nounou"}).json()
        assert [o["id"] for o in body["objects"]] == ["256371000"]

    def test_finds_a_vessel_by_mmsi(self, client):
        body = client.get("/api/ships/search", params={"q": "230982"}).json()
        assert [o["label"] for o in body["objects"]] == ["VIKING GRACE"]

    def test_search_is_not_swallowed_as_an_mmsi(self, client):
        # Declared before /{object_id}. Without that ordering this is a lookup
        # for a ship called "search" and returns 404.
        assert client.get("/api/ships/search", params={"q": "a"}).status_code == 200


class TestConditionalRequests:
    def test_an_unchanged_store_answers_304(self, client):
        first = client.get("/api/ships")
        again = client.get("/api/ships", headers={"If-None-Match": first.headers["etag"]})
        assert again.status_code == 304

    def test_the_tag_names_this_layer_and_not_the_configured_one(self, client):
        # **This test was vacuous when first written**, and mutation testing
        # said so: it compared the ship tag against the aircraft tag and
        # asserted they differed, which they do anyway - the two stores hold
        # different versions and different sources, so the tags separate
        # whether or not the layer name is in them. Changing the router to hash
        # "aircraft" did not fail it.
        #
        # What actually needs guarding is the router's own argument, so it is
        # pinned against a tag computed from the ship store's real state. The
        # hashing itself is already covered by test_etag's
        # test_distinguishes_object_types; this is about which name is handed
        # to it.
        store = client.app.state.ship_store
        response = client.get("/api/ships")
        expected = compute_etag(
            version=store.updates_applied,
            object_type="ship",
            bbox=None,
            limit=Settings().max_objects_per_response,
            stale=store.is_stale(),
            source=store.source,
        )
        assert response.headers["etag"] == expected


class TestTheLayerIsOptional:
    def test_it_404s_when_switched_off(self, monkeypatch):
        # 404 rather than 503: not configured is permanent, not transient.
        settings = Settings(
            provider="fixture",
            quota_preset="authenticated",
            ship_layer_enabled=False,
            satellite_layer_enabled=False,
            lunar_layer_enabled=False,
        )
        with TestClient(create_app(settings=settings, routes=offline_routes())) as c:
            assert c.get("/api/ships").status_code == 404
            assert c.get("/api/ships/256371000").status_code == 404


class TestItTouchesNothingElse:
    """D165's actual claim, asked of the other two layers directly."""

    def test_the_aircraft_layer_still_answers_for_itself(self, client):
        body = client.get("/api/aircraft").json()
        assert body["type"] == "aircraft"
        # And holds none of the ships, which share no store with it.
        assert all(o["type"] == "aircraft" for o in body["objects"])

    def test_the_ship_store_is_not_the_aircraft_store(self, client):
        ships = {o["id"] for o in client.get("/api/ships").json()["objects"]}
        aircraft = {o["id"] for o in client.get("/api/aircraft").json()["objects"]}
        assert not (ships & aircraft)
