"""The satellite endpoints.

Offline throughout: the app is built with a provider whose elements come from
the committed fixture, so nothing here depends on CelesTrak or SatNOGS being
up. That is not incidental caution - both were returning errors on the day this
was written.
"""

from __future__ import annotations

import json
from datetime import timedelta
from urllib.parse import quote
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import offline_routes

from app.config import Settings
from app.main import create_app
from app.orbits import tle_epoch
from app.providers.satellites import ORBIT_POINTS, SatelliteProvider, elements_from_file

FIXTURE = Path(__file__).parent / "fixtures" / "satellites_sample.json"


def fixture_now():
    rows = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return max(tle_epoch(r["TLE_LINE1"]) for r in rows) + timedelta(hours=1)


@pytest.fixture
def client(monkeypatch):
    """An app whose satellite layer reads committed elements and never dials out."""
    monkeypatch.setattr("app.providers.satellites.utcnow", lambda: fixture_now())
    # The route now reads the clock too, to measure the entitlement window
    # (D149). Left unpatched it would compare a fixture instant from whenever
    # the committed elements were captured against the real present, and every
    # test here would fail for a reason that has nothing to do with what it
    # asserts.
    monkeypatch.setattr("app.api.satellites.utcnow", lambda: fixture_now())

    settings = Settings(
        provider="fixture", quota_preset="authenticated", satellite_layer_enabled=True
    )
    app = create_app(settings, routes=offline_routes())

    original = SatelliteProvider.__init__

    async def no_directory() -> dict:
        return {}

    def offline_init(self, **kwargs):
        kwargs["fetch_elements"] = elements_from_file(FIXTURE)
        # The names come from a second upstream, so "never dials out" has to
        # switch off both. It did not, and these tests went to the network
        # (D117).
        kwargs["fetch_names"] = no_directory
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
            Settings(
                provider="fixture",
                quota_preset="authenticated",
                satellite_layer_enabled=False,
            ),
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


class TestLookingBack:
    """Positions for an instant other than now.

    The capability was always in `propagate` - it checks `abs(age_days)`, so a
    time before the epoch is refused on the same terms as one after it. What
    was missing was any way to say so: the provider hardcoded `utcnow()` and
    the route took no time parameter, so the argument existed at the bottom of
    the stack and nothing above it could reach it (D119).
    """

    def test_a_past_instant_gives_different_positions(self, client):
        now = client.get("/api/satellites").json()["objects"]
        past_at = quote((fixture_now() - timedelta(hours=1)).isoformat())
        past = client.get(f"/api/satellites?at={past_at}").json()["objects"]

        assert len(past) == len(now) > 0
        by_id = {o["id"]: o for o in now}
        moved = [
            o for o in past
            if abs(o["lat"] - by_id[o["id"]]["lat"]) > 0.01
            or abs(o["lon"] - by_id[o["id"]]["lon"]) > 0.01
        ]
        # An hour is over half an orbit; nothing should be where it was.
        assert len(moved) == len(past)

    def test_a_future_instant_works_the_same_way(self, client):
        ahead = quote((fixture_now() + timedelta(hours=2)).isoformat())
        assert client.get(f"/api/satellites?at={ahead}").json()["total"] > 0

    def test_omitting_it_means_now(self, client):
        assert client.get("/api/satellites").json()["total"] > 0

    def test_an_unencoded_plus_offset_is_understood(self, client):
        # A `+` in a query string decodes to a space, so an ISO offset arrives
        # as ` 00:00`. Sent raw, exactly as a careless client would.
        raw = (fixture_now()).isoformat()
        assert "+" in raw
        assert client.get(f"/api/satellites?at={raw}").json()["total"] > 0

    def test_a_naive_timestamp_is_read_as_utc(self, client):
        # The client sends what its clock says, and a satellite position is
        # meaningless in local time. Guessing UTC is the only useful reading.
        naive = fixture_now().replace(tzinfo=None).isoformat()
        assert client.get(f"/api/satellites?at={naive}").json()["total"] > 0

    def test_a_z_suffix_is_accepted(self, client):
        stamp = fixture_now().replace(microsecond=0, tzinfo=None).isoformat() + "Z"
        assert client.get(f"/api/satellites?at={stamp}").json()["total"] > 0

    def test_something_that_is_not_a_timestamp_is_refused_clearly(self, client):
        response = client.get("/api/satellites?at=last%20tuesday")
        assert response.status_code == 422
        assert "ISO 8601" in response.json()["detail"]

    def test_beyond_every_window_the_entitlement_answers_first(self, client):
        # This used to assert a 200 with nothing in it: the seven-day accuracy
        # bound is measured per element set against its own epoch, so a far
        # instant made every object drop out rather than making the request
        # bad. That property still holds and is still tested, one layer down,
        # in `test_satellites.py` - where it can be seen without an account in
        # the way.
        #
        # What changed is that a *second* bound now sits in front of it (D149),
        # measured against now rather than against epochs, so it can be checked
        # at the door and is. Thirty days is outside every tier's window, so
        # the entitlement refuses before propagation is ever asked.
        far = quote((fixture_now() + timedelta(days=30)).isoformat())
        response = client.get(f"/api/satellites?at={far}")
        assert response.status_code == 403


class TestTheWindowATierBuys:
    """The first place an account changes an answer (D149).

    Through the real route with a real cookie jar, because the thing being
    tested is not the arithmetic - `test_entitlements.py` covers that with no
    HTTP anywhere near it - but the wiring: that the route reads the session,
    that a signed-out reader is treated as free rather than as an error, and
    that a tier written into the database moves the limit.
    """

    @staticmethod
    def _accounts(client, tmp_path):
        """Point the app at a database of its own, and hand it back."""
        from app.accounts.sessions import SessionStore
        from app.accounts.store import AccountStore

        path = tmp_path / "accounts.sqlite"
        client.app.state.accounts = AccountStore(path)
        client.app.state.sessions = SessionStore(path)
        return client.app.state.accounts

    @staticmethod
    def _at(hours=0, days=0):
        return quote((fixture_now() + timedelta(hours=hours, days=days)).isoformat())

    def test_a_signed_out_reader_gets_the_free_window(self, client, tmp_path):
        self._accounts(client, tmp_path)
        assert client.get(f"/api/satellites?at={self._at(hours=-20)}").status_code == 200

    def test_a_signed_out_reader_is_refused_beyond_it(self, client, tmp_path):
        self._accounts(client, tmp_path)
        response = client.get(f"/api/satellites?at={self._at(days=-3)}")
        assert response.status_code == 403
        # The refusal has to be readable, or it is indistinguishable from a bug.
        assert "premium" in response.json()["detail"].lower()

    def test_a_free_account_gets_no_more_than_being_signed_out(self, client, tmp_path):
        # Registering is not itself the product. If it were, "free account"
        # would mean something different from "free", and the pricing page
        # would have three tiers in it without saying so.
        self._accounts(client, tmp_path)
        client.post(
            "/api/auth/register",
            json={"email": "free@example.com", "password": "a good long password"},
        )
        assert client.get(f"/api/satellites?at={self._at(days=-3)}").status_code == 403

    def test_a_premium_account_may_go_the_whole_week(self, client, tmp_path):
        from app.accounts.store import TIER_PREMIUM

        accounts = self._accounts(client, tmp_path)
        client.post(
            "/api/auth/register",
            json={"email": "paid@example.com", "password": "a good long password"},
        )
        signed_in = accounts.authenticate("paid@example.com", "a good long password")
        assert signed_in is not None
        accounts.set_tier(signed_in.id, TIER_PREMIUM)

        assert client.get(f"/api/satellites?at={self._at(days=-6)}").status_code == 200

    def test_signing_out_takes_the_window_back(self, client, tmp_path):
        # The cookie is what carries the tier, so a shared machine must not
        # leave the previous reader's entitlement behind.
        from app.accounts.store import TIER_PREMIUM

        accounts = self._accounts(client, tmp_path)
        client.post(
            "/api/auth/register",
            json={"email": "paid@example.com", "password": "a good long password"},
        )
        signed_in = accounts.authenticate("paid@example.com", "a good long password")
        assert signed_in is not None
        accounts.set_tier(signed_in.id, TIER_PREMIUM)
        far = f"/api/satellites?at={self._at(days=-6)}"
        assert client.get(far).status_code == 200

        client.post("/api/auth/logout")
        assert client.get(far).status_code == 403

    def test_asking_for_now_never_needs_an_account(self, client, tmp_path):
        # The gate is on the *reach* of a capability, not on the capability.
        # Live satellites are the free product and must not acquire a session
        # requirement by accident.
        self._accounts(client, tmp_path)
        assert client.get("/api/satellites").status_code == 200


class TestTheOrbitPath:
    """One revolution, drawn (D170).

    The detail endpoint has returned an empty ``track`` since D95, with a note
    saying a satellite's path is computable in both directions and belongs in
    its own shape. This is that shape, and these are its terms.
    """

    def _first(self, client):
        return client.get("/api/satellites").json()["objects"][0]["id"]

    def test_a_selected_satellite_has_a_path(self, client):
        body = client.get(f"/api/satellites/{self._first(client)}/orbit").json()
        assert len(body["points"]) == ORBIT_POINTS + 1
        assert body["periodMinutes"] > 0
        assert set(body["points"][0]) == {"lat", "lon", "altitude"}

    def test_the_satellite_sits_in_the_middle_of_its_own_path(self, client):
        # Half a period back and half forward. Drawn from *now* forwards the
        # marker would sit at one end of the line, which reads as the start of
        # the orbit rather than as a position on it.
        satellite = client.get("/api/satellites").json()["objects"][0]
        body = client.get(f"/api/satellites/{satellite['id']}/orbit").json()

        middle = body["points"][len(body["points"]) // 2]
        assert middle["lat"] == pytest.approx(satellite["lat"], abs=0.05)
        assert middle["lon"] == pytest.approx(satellite["lon"], abs=0.05)

    def test_the_path_comes_back_beside_where_it_started_not_onto_it(self, client):
        # The Earth turns under the orbit - about 22.5 degrees of longitude per
        # low revolution - so in the Earth-fixed frame the map draws, one
        # revolution ends *beside* its start. A closed ellipse would be the
        # truth about a frame this view does not use.
        body = client.get(f"/api/satellites/{self._first(client)}/orbit").json()
        start, end = body["points"][0], body["points"][-1]
        drift = abs(end["lon"] - start["lon"])
        drift = min(drift, 360 - drift)
        assert drift > 1.0, "a closed path would mean the Earth had not turned"
        assert abs(end["lat"] - start["lat"]) < 5.0, "same point in the orbit, though"

    def test_altitude_varies_the_way_an_orbit_does(self, client):
        # Not a constant. Even a near-circular orbit is an ellipse, and the
        # shell the frontend draws this on is altitude-driven - a path of
        # identical altitudes would be a ring at one height rather than an
        # orbit.
        body = client.get(f"/api/satellites/{self._first(client)}/orbit").json()
        altitudes = [p["altitude"] for p in body["points"]]
        assert min(altitudes) > 0
        assert max(altitudes) != min(altitudes)

    def test_every_point_is_somewhere_real(self, client):
        body = client.get(f"/api/satellites/{self._first(client)}/orbit").json()
        for point in body["points"]:
            assert -90 <= point["lat"] <= 90
            assert -180 <= point["lon"] <= 180

    def test_an_unknown_satellite_is_a_404(self, client):
        assert client.get("/api/satellites/not-a-catalogue-number/orbit").status_code == 404

    def test_the_path_is_centred_on_the_instant_asked_for(self, client):
        satellite = client.get("/api/satellites").json()["objects"][0]
        earlier = (fixture_now() - timedelta(minutes=30)).isoformat()
        body = client.get(
            f"/api/satellites/{satellite['id']}/orbit", params={"at": earlier}
        ).json()
        assert body["computedAt"].startswith(earlier[:16])

        # And it is a different path, because the satellite has moved.
        now_body = client.get(f"/api/satellites/{satellite['id']}/orbit").json()
        middles = (
            body["points"][len(body["points"]) // 2],
            now_body["points"][len(now_body["points"]) // 2],
        )
        assert middles[0] != middles[1]

    def test_time_travel_is_gated_the_way_the_listing_is(self, client):
        # The same capability, so the same rule. A path of 181 positions in the
        # past is time travel exactly as one position is, and the entitlement
        # check living on only one of the two endpoints is how a limit becomes
        # a suggestion (D149).
        satellite = client.get("/api/satellites").json()["objects"][0]
        long_ago = (fixture_now() - timedelta(days=30)).isoformat()
        response = client.get(
            f"/api/satellites/{satellite['id']}/orbit", params={"at": long_ago}
        )
        assert response.status_code == 403

    def test_the_payload_stays_small_enough_to_fetch_on_a_click(self, client):
        # Measured rather than assumed: this is fetched every time a satellite
        # is selected, so it sits in the interaction path.
        response = client.get(f"/api/satellites/{self._first(client)}/orbit")
        assert len(response.content) < 20_000, len(response.content)
