"""Conditional requests on the list endpoint.

Two halves. The unit tests pin what goes into a tag, and every one of them is
about a way of answering 304 when the answer has in fact changed -- the failure
mode of a cache is not a crash, it is a client quietly holding data that is
wrong. The end-to-end tests then drive the real app and check the parts a unit
test cannot reach: that the 304 carries no body, that it happens before the
store is read, and that the viewport hint still arrives.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.api import etag as etag_module
from app.api.etag import compute_etag, if_none_match_matches, process_token
from app.config import Settings
from app.main import create_app
from tests.conftest import offline_routes
from tests.conftest import offline_routes
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.providers.base import Provider

NOW = utcnow()


def base(**overrides):
    kwargs = dict(
        version=3,
        object_type="aircraft",
        bbox=None,
        limit=2000,
        stale=False,
        source="opensky",
    )
    kwargs.update(overrides)
    return compute_etag(**kwargs)


class TestComputeEtag:
    def test_is_weak(self):
        # Two responses at one store version differ in ageSeconds, so the
        # validator cannot claim they are byte-identical (RFC 9110 8.8.1).
        assert base().startswith('W/"')

    def test_is_stable_for_the_same_inputs(self):
        assert base() == base()

    def test_changes_when_the_store_changes(self):
        assert base(version=3) != base(version=4)

    def test_changes_with_the_bounding_box(self):
        # Without this, panning returns 304 and the new region never arrives.
        box_a = BBox(lat_min=30, lon_min=-100, lat_max=50, lon_max=-80)
        box_b = BBox(lat_min=31, lon_min=-100, lat_max=50, lon_max=-80)
        assert base(bbox=box_a) != base(bbox=box_b)
        assert base(bbox=box_a) != base(bbox=None)

    def test_changes_with_the_cap(self):
        # A smaller cap is a smaller response, at the same store version.
        assert base(limit=2000) != base(limit=100)

    def test_changes_when_the_data_goes_stale(self):
        # `stale` flips on a clock rather than on a write, so the version alone
        # would never notice. A backend whose upstream has died would keep
        # answering 304 and the client would never be told.
        assert base(stale=False) != base(stale=True)

    def test_changes_with_the_source(self):
        assert base(source="opensky") != base(source="fixture")

    def test_includes_a_per_process_token(self, monkeypatch):
        # The version counter restarts at zero on every boot. Without a token
        # in the tag, a restarted backend serves a different dataset under a
        # tag the client already holds -- and restarts are how the provider
        # gets switched. Standing in for a restart by replacing the token is
        # the only way to observe this without starting a second process.
        assert len(process_token()) >= 8
        before = base()

        monkeypatch.setattr(etag_module, "_PROCESS_TOKEN", "a-different-process")
        assert base() != before

    def test_distinguishes_object_types(self):
        assert base(object_type="aircraft") != base(object_type="something-else")


class TestIfNoneMatch:
    def test_matches_the_same_tag(self):
        tag = base()
        assert if_none_match_matches(tag, tag) is True

    def test_ignores_the_weak_prefix_on_either_side(self):
        # Comparison for If-None-Match is the weak one (RFC 9110 13.1.2).
        assert if_none_match_matches('"abc"', 'W/"abc"') is True
        assert if_none_match_matches('W/"abc"', '"abc"') is True

    def test_matches_one_tag_in_a_list(self):
        assert if_none_match_matches('W/"old", W/"abc"', 'W/"abc"') is True

    def test_matches_a_star(self):
        assert if_none_match_matches("*", 'W/"abc"') is True

    def test_does_not_match_a_different_tag(self):
        assert if_none_match_matches('W/"other"', 'W/"abc"') is False

    def test_absent_header_never_matches(self):
        assert if_none_match_matches(None, 'W/"abc"') is False
        assert if_none_match_matches("", 'W/"abc"') is False


# ---------------------------------------------------------------------------
# Through the real application
# ---------------------------------------------------------------------------


def record(object_id, lat, lon, label):
    return TrackedObjectRecord(
        id=object_id, lat=lat, lon=lon, altitude=10000.0, velocity=240.0,
        heading=90.0, label=label, last_seen=NOW, type=ObjectType.AIRCRAFT,
        meta={"originCountry": "United States"},
    )


class CountingProvider(Provider):
    """Records how often the app asks it for data."""

    name = "counting"
    object_type = ObjectType.AIRCRAFT

    def __init__(self):
        self.records = [
            record("a1", 40.7, -74.0, "UAL1234"),
            record("b2", 50.0, 8.5, "DLH441"),
        ]
        self.calls = 0

    async def fetch(self, bbox: BBox | None = None):
        self.calls += 1
        return list(self.records)


@pytest.fixture
def provider() -> CountingProvider:
    return CountingProvider()


@pytest.fixture
def client(provider):
    app = create_app(settings=Settings(quota_preset="authenticated", provider="fixture"),
                     provider=provider, routes=offline_routes())
    with TestClient(app) as test_client:
        yield test_client


class TestConditionalRequests:
    def test_a_plain_request_carries_an_etag(self, client):
        response = client.get("/api/aircraft")
        assert response.status_code == 200
        assert response.headers["etag"].startswith('W/"')

    def test_the_body_is_still_cacheable_but_must_be_revalidated(self, client):
        # `no-cache` means "keep it, ask every time", which is what makes the
        # 304 path happen in a browser with no client code at all. `no-store`
        # would forbid keeping the body and there would be nothing to revalidate.
        assert client.get("/api/aircraft").headers["cache-control"] == "no-cache"

    def test_repeating_a_request_with_the_tag_gets_304(self, client):
        first = client.get("/api/aircraft")
        second = client.get("/api/aircraft", headers={"If-None-Match": first.headers["etag"]})
        assert second.status_code == 304

    def test_a_304_carries_no_body(self, client):
        first = client.get("/api/aircraft")
        second = client.get("/api/aircraft", headers={"If-None-Match": first.headers["etag"]})
        assert second.content == b""

    def test_a_304_repeats_the_tag(self, client):
        # So a client that revalidates repeatedly keeps a tag to send next time.
        first = client.get("/api/aircraft")
        second = client.get("/api/aircraft", headers={"If-None-Match": first.headers["etag"]})
        assert second.headers["etag"] == first.headers["etag"]

    def test_a_stale_tag_gets_the_whole_body(self, client):
        response = client.get("/api/aircraft", headers={"If-None-Match": 'W/"nonsense"'})
        assert response.status_code == 200
        assert response.json()["returned"] == 2

    def test_a_new_poll_invalidates_the_tag(self, client):
        first = client.get("/api/aircraft")

        # A poll that changes nothing still bumps the store's version, which is
        # the honest thing for a validator built on it to do: the store cannot
        # know the new snapshot happens to equal the old one.
        store = client.app.state.store
        before = store.updates_applied
        run_tick(client.app.state.poller)
        assert store.updates_applied == before + 1

        second = client.get("/api/aircraft", headers={"If-None-Match": first.headers["etag"]})
        assert second.status_code == 200
        assert second.headers["etag"] != first.headers["etag"]

    def test_a_different_viewport_is_a_different_representation(self, client):
        whole = client.get("/api/aircraft")
        box = client.get(
            "/api/aircraft",
            params={"bbox": "30,-80,50,-60"},
            headers={"If-None-Match": whole.headers["etag"]},
        )
        assert box.status_code == 200
        assert {o["id"] for o in box.json()["objects"]} == {"a1"}

    def test_a_different_cap_is_a_different_representation(self, client):
        full = client.get("/api/aircraft")
        capped = client.get(
            "/api/aircraft",
            params={"limit": 1},
            headers={"If-None-Match": full.headers["etag"]},
        )
        assert capped.status_code == 200
        assert capped.json()["returned"] == 1

    def test_the_viewport_hint_still_reaches_the_poller_on_a_304(self, client):
        # The failure this prevents: a user holding still gets 304s, the poller
        # stops being told where they are looking, and tier 2 goes idle over
        # precisely the region under inspection (D21, D27).
        params = {"bbox": "30,-80,50,-60"}
        first = client.get("/api/aircraft", params=params)

        poller = client.app.state.poller
        poller.set_viewport(None)
        assert poller._viewport is None

        second = client.get(
            "/api/aircraft", params=params, headers={"If-None-Match": first.headers["etag"]}
        )
        assert second.status_code == 304
        assert poller._viewport is not None

    def test_search_is_not_conditional(self, client):
        # Search is user-driven and its result changes with the query, so the
        # repetition the ETag exists to remove is not there to remove (D47).
        response = client.get("/api/aircraft/search", params={"q": "UAL"})
        assert response.status_code == 200
        assert "etag" not in {k.lower() for k in response.headers}


def run_tick(poller) -> None:
    """Drive one global poll from the test, the way test_api.py does."""
    job = next(j for j in poller.settings.jobs if j.name == "global")
    asyncio.run(poller._tick(job, poller._statuses["global"]))
