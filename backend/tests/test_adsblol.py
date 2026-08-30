"""Tests for the adsb.lol provider.

The thing most worth testing here is **units**. This is a `readsb` feed:
altitudes arrive in feet and ground speed in knots, where the contract is
metres and metres per second (D18). A missed conversion would put every
aircraft at 3.3 times its real altitude and 1.9 times its real speed, and would
look entirely plausible doing it — the map would still show aeroplanes flying
sensibly, just wrong. So the conversions are asserted against a real flight
level rather than against a round number.

The second is **what "no data" looks like** in this feed, which is different
from OpenSky's: fields are omitted rather than sent as null, and an aircraft on
the ground reports the *string* `"ground"` where a number is expected.
"""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
import pytest

from app.models import BBox
from app.providers.adsblol import (
    GLOBAL_RADIUS_NM,
    VIEWPORT_MAX_RADIUS_NM,
    AdsbLolProvider,
    _circle_for,
)
from app.providers.base import ProviderBadResponse, ProviderRateLimited, ProviderUnavailable

# One real record, trimmed: a 737 at FL360 out of the live feed.
LIVE_RECORD = {
    "hex": "407183",
    "type": "adsb_icao",
    "flight": "EXS8KN  ",
    "r": "G-JZBG",
    "t": "B738",
    "alt_baro": 36000,
    "alt_geom": 37275,
    "gs": 430.2,
    "track": 322.65,
    "squawk": "5716",
    "category": "A3",
    "lat": 48.853317,
    "lon": 3.858032,
    "seen_pos": 0.557,
}


def provider(handler) -> AdsbLolProvider:
    transport = httpx.MockTransport(handler)
    return AdsbLolProvider(client=httpx.AsyncClient(transport=transport))


def responds(payload, status: int = 200):
    def handler(request: httpx.Request) -> httpx.Response:
        if status != 200:
            return httpx.Response(status, text="no")
        return httpx.Response(status, json=payload)

    return handler


class TestUnits:
    @pytest.mark.anyio
    async def test_feet_become_metres(self) -> None:
        # FL360 is 36,000 ft, which is 10,972.8 m. Left in feet it would read
        # as an aircraft in low Earth orbit, and the altitude ramp would peg.
        records = await provider(responds({"ac": [LIVE_RECORD]})).fetch()
        assert records[0].altitude == pytest.approx(10972.8, abs=0.5)

    @pytest.mark.anyio
    async def test_knots_become_metres_per_second(self) -> None:
        # 430.2 kt is 221.3 m/s. Left in knots the client's dead reckoning
        # would fly every marker at twice its real speed (D71).
        records = await provider(responds({"ac": [LIVE_RECORD]})).fetch()
        assert records[0].velocity == pytest.approx(221.3, abs=0.5)

    @pytest.mark.anyio
    async def test_the_rest_of_the_record_arrives_intact(self) -> None:
        records = await provider(responds({"ac": [LIVE_RECORD]})).fetch()
        record = records[0]
        assert record.id == "407183"
        assert record.label == "EXS8KN"
        assert record.heading == pytest.approx(322.65)
        assert record.lat == pytest.approx(48.853317)

    @pytest.mark.anyio
    async def test_registration_and_type_are_carried_as_meta(self) -> None:
        # What OpenSky never had, and what lets a panel say "Boeing 737-800,
        # G-JZBG" instead of a hex address.
        records = await provider(responds({"ac": [LIVE_RECORD]})).fetch()
        assert records[0].meta["registration"] == "G-JZBG"
        assert records[0].meta["aircraftType"] == "B738"


class TestMissingData:
    @pytest.mark.anyio
    async def test_an_aircraft_on_the_ground_reads_as_zero(self) -> None:
        # `alt_baro` is the string "ground" rather than a number, which a naive
        # float() turns into a crash and a naive `or 0` turns into a silent
        # lie for every aircraft with an altitude of zero feet.
        entry = {**LIVE_RECORD, "alt_baro": "ground"}
        records = await provider(responds({"ac": [entry]})).fetch()
        assert records[0].altitude == 0.0

    @pytest.mark.anyio
    async def test_a_missing_altitude_stays_unknown(self) -> None:
        entry = {k: v for k, v in LIVE_RECORD.items() if k not in ("alt_baro", "alt_geom")}
        records = await provider(responds({"ac": [entry]})).fetch()
        assert records[0].altitude is None

    @pytest.mark.anyio
    async def test_geometric_altitude_is_the_fallback(self) -> None:
        # Barometric first, for the same reason as OpenSky (D79).
        entry = {k: v for k, v in LIVE_RECORD.items() if k != "alt_baro"}
        records = await provider(responds({"ac": [entry]})).fetch()
        assert records[0].altitude == pytest.approx(37275 * 0.3048, abs=0.5)

    @pytest.mark.anyio
    async def test_an_aircraft_with_no_position_is_skipped(self) -> None:
        # A marker at (0, 0) looks like real data in the Gulf of Guinea (D18).
        entry = {k: v for k, v in LIVE_RECORD.items() if k not in ("lat", "lon")}
        records = await provider(responds({"ac": [entry, LIVE_RECORD]})).fetch()
        assert len(records) == 1

    @pytest.mark.anyio
    async def test_the_age_of_a_position_is_respected(self) -> None:
        # `seen_pos` is seconds ago, not a timestamp. Treated as "now" instead,
        # a stale aircraft would never fade (D71).
        entry = {**LIVE_RECORD, "seen_pos": 90.0}
        records = await provider(responds({"ac": [entry]})).fetch()
        age = (datetime.now(timezone.utc) - records[0].last_seen).total_seconds()
        assert age == pytest.approx(90, abs=5)


class TestRequestShape:
    @pytest.mark.anyio
    async def test_the_whole_world_is_one_request(self) -> None:
        # Four concurrent circles earned an HTTP 420 and a minute of
        # throttling; one large circle returns the same aircraft (D83).
        urls = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        await provider(handler).fetch(None)
        assert len(urls) == 1
        assert f"/{GLOBAL_RADIUS_NM}" in urls[0]

    @pytest.mark.anyio
    async def test_a_viewport_becomes_the_circle_that_contains_it(self) -> None:
        urls = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            return httpx.Response(200, json={"ac": []})

        await provider(handler).fetch(BBox(lat_min=10, lon_min=100, lat_max=20, lon_max=110))
        assert "/point/15.0/105.0/" in urls[0]

    def test_the_circle_covers_every_corner_of_the_box(self) -> None:
        # Asking for slightly more than the viewport is free -- the store
        # filters again on the way out -- and asking for slightly less loses
        # aircraft in the corners, silently.
        lat, lon, radius = _circle_for(BBox(lat_min=10, lon_min=100, lat_max=20, lon_max=110))
        assert (lat, lon) == (15.0, 105.0)
        # Half the diagonal of a 10x10 degree box is about 415 nm.
        assert 400 < radius < 500

    def test_a_box_across_the_antimeridian_is_not_centred_on_the_wrong_side(self) -> None:
        # 170 and -170 average to zero, which is the other side of the planet.
        lat, lon, _radius = _circle_for(BBox(lat_min=-5, lon_min=170, lat_max=5, lon_max=-170))
        assert lat == 0.0
        assert abs(lon) > 179

    def test_a_huge_viewport_is_capped(self) -> None:
        _lat, _lon, radius = _circle_for(BBox(lat_min=-80, lon_min=-170, lat_max=80, lon_max=170))
        assert radius == VIEWPORT_MAX_RADIUS_NM


class TestFailures:
    @pytest.mark.anyio
    async def test_the_services_own_rate_limit_is_recognised(self) -> None:
        # 420 "enhance your calm" is what this service sends, and it is not a
        # status any generic client handles. Mistaken for an ordinary error it
        # would be retried immediately, which is how a throttle becomes a ban.
        with pytest.raises(ProviderRateLimited):
            await provider(responds(None, status=420)).fetch()

    @pytest.mark.anyio
    async def test_a_conventional_rate_limit_too(self) -> None:
        with pytest.raises(ProviderRateLimited):
            await provider(responds(None, status=429)).fetch()

    @pytest.mark.anyio
    async def test_a_server_error_is_unavailability(self) -> None:
        with pytest.raises(ProviderUnavailable):
            await provider(responds(None, status=503)).fetch()

    @pytest.mark.anyio
    async def test_a_body_that_is_not_json_is_a_bad_response(self) -> None:
        # Seen for real: a throttled request answered 200 with an empty body.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="")

        with pytest.raises(ProviderBadResponse):
            await provider(handler).fetch()

    @pytest.mark.anyio
    async def test_an_empty_sky_is_not_an_error(self) -> None:
        assert await provider(responds({"ac": []})).fetch() == []
        assert await provider(responds({})).fetch() == []
