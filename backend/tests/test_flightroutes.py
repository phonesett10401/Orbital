"""The scheduled-route lookup (D88).

Every response here is a recorded shape from the live service, including the
404 body, because the thing most likely to break this is adsbdb changing its
envelope rather than our logic changing its mind.
"""

from __future__ import annotations

import httpx
import pytest

from app.ingestion.flightroutes import FlightRoutes, _parse
from app.models import ObjectType, TrackedObjectDetail, utcnow

pytestmark = pytest.mark.anyio


# Trimmed from the live answer for UAE394 -- the flight Phone compared against
# Flightradar24 -- keeping every field the parser reads.
UAE394 = {
    "response": {
        "flightroute": {
            "callsign": "UAE394",
            "callsign_icao": "UAE394",
            "callsign_iata": "EK394",
            "airline": {
                "name": "Emirates",
                "icao": "UAE",
                "iata": "EK",
                "country": "United Arab Emirates",
                "country_iso": "AE",
                "callsign": "EMIRATES",
            },
            "origin": {
                "country_iso_name": "AE",
                "country_name": "United Arab Emirates",
                "elevation": 62,
                "iata_code": "DXB",
                "icao_code": "OMDB",
                "latitude": 25.2527999878,
                "longitude": 55.3643989563,
                "municipality": "Dubai",
                "name": "Dubai International Airport",
            },
            "destination": {
                "country_iso_name": "VN",
                "country_name": "Vietnam",
                "elevation": 39,
                "iata_code": "HAN",
                "icao_code": "VVNB",
                "latitude": 21.221200943,
                "longitude": 105.806999207,
                "municipality": "Hanoi",
                "name": "Noi Bai International Airport",
            },
        }
    }
}

UNKNOWN = {"response": "unknown callsign"}


def detail(label: str = "UAE394") -> TrackedObjectDetail:
    return TrackedObjectDetail(
        id="896471",
        lat=25.0,
        lon=55.0,
        altitude=11000.0,
        velocity=240.0,
        heading=90.0,
        label=label,
        last_seen=utcnow(),
        type=ObjectType.AIRCRAFT,
        track=[],
    )


def routes_answering(handler, **kwargs) -> FlightRoutes:
    return FlightRoutes(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)), **kwargs)


def always(status: int, body: object):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(status, json=body)

    handler.calls = calls  # type: ignore[attr-defined]
    return handler


class TestReadingTheAnswer:
    async def test_names_both_ends_of_the_route(self):
        enriched = await routes_answering(always(200, UAE394)).enrich(detail())
        route = enriched.route
        assert route is not None
        assert route.airline == "Emirates"
        assert route.origin is not None and route.origin.icao == "OMDB"
        assert route.origin.iata == "DXB"
        assert route.origin.municipality == "Dubai"
        assert route.destination is not None and route.destination.icao == "VVNB"
        assert route.destination.municipality == "Hanoi"

    async def test_the_airports_carry_coordinates_so_they_can_be_drawn(self):
        route = _parse(UAE394)
        assert route is not None and route.origin is not None
        assert route.origin.lat == pytest.approx(25.2528)
        assert route.origin.lon == pytest.approx(55.3644)

    async def test_a_scheduled_airport_claims_no_distance(self):
        """`distance_km` means "how far the track began from here" (D78).

        A scheduled route measured nothing, and filling the field with zero
        would assert the aircraft took off from directly overhead.
        """
        route = _parse(UAE394)
        assert route is not None and route.origin is not None
        assert route.origin.distance_km is None

    async def test_half_an_answer_is_still_shown(self):
        """adsbdb's rows are uneven; an airline with no route is common."""
        partial = {"response": {"flightroute": {"airline": {"name": "Emirates"}}}}
        route = _parse(partial)
        assert route is not None
        assert route.airline == "Emirates"
        assert route.origin is None and route.destination is None

    async def test_an_answer_with_nothing_in_it_is_not_a_route(self):
        assert _parse({"response": {"flightroute": {"callsign": "ZZZ1"}}}) is None
        assert _parse({"response": "unknown callsign"}) is None
        assert _parse("not json at all") is None


class TestWhenThereIsNoAnswer:
    async def test_an_unknown_callsign_leaves_the_aircraft_untouched(self):
        """About three callsigns in ten have no published route."""
        enriched = await routes_answering(always(404, UNKNOWN)).enrich(detail("ZZZZ999"))
        assert enriched.route is None
        assert enriched.id == "896471"

    async def test_the_service_being_down_does_not_fail_the_request(self):
        def explode(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("adsbdb is unreachable")

        enriched = await routes_answering(explode).enrich(detail())
        assert enriched.route is None

    async def test_an_aircraft_with_no_callsign_is_never_looked_up(self):
        """A blank label is how the contract spells "no callsign" -- plenty of
        aircraft transmit a position and nothing else."""
        handler = always(200, UAE394)
        enriched = await routes_answering(handler).enrich(detail(label="  "))
        assert enriched.route is None
        assert handler.calls == []


class TestAskingOnce:
    async def test_a_second_selection_is_served_from_the_cache(self):
        handler = always(200, UAE394)
        lookup = routes_answering(handler)
        for _ in range(3):
            assert (await lookup.enrich(detail())).route is not None
        assert len(handler.calls) == 1

    async def test_an_unknown_callsign_is_cached_too(self):
        """The negative case is the one that matters.

        Without it, the 30% of aircraft with no published route would send a
        request on every selection, forever, for an answer that will not
        change -- to a service that charges nothing and deserves better.
        """
        handler = always(404, UNKNOWN)
        lookup = routes_answering(handler)
        for _ in range(3):
            await lookup.enrich(detail("ZZZZ999"))
        assert len(handler.calls) == 1

    async def test_the_cache_expires(self):
        handler = always(200, UAE394)
        lookup = routes_answering(handler, ttl_seconds=0.0)
        await lookup.enrich(detail())
        await lookup.enrich(detail())
        assert len(handler.calls) == 2

    async def test_the_callsign_is_asked_for_as_published(self):
        handler = always(200, UAE394)
        await routes_answering(handler).enrich(detail(" uae394 "))
        assert handler.calls[0].url.path.endswith("/callsign/UAE394")
