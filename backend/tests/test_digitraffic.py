"""Tests for the Digitraffic ship provider.

The thing most worth testing here is **the difference between a missing value
and a wrong one**. AIS has no nulls: "not available" is encoded as a number
inside the valid range, and this feed passes those through unaltered. A speed
of 102.3 knots, a course of 360 degrees and a heading of 511 are all "the
transmitter did not say", and all three draw perfectly happily as a ship
crossing the Gulf of Finland at 190 km/h.

That is a harder failure than a unit error, because a unit error is wrong
everywhere and this is wrong on 25% of the fleet while the other 75% looks
right. So the records below are **real, taken from the live feed**, including
the ones that were wrong: NOUNOU is an actual 250-metre tanker that was
actually reporting 102.2 knots, and the first version of this provider believed
it.

The second is **units**: speed over ground arrives in knots and draught in
decimetres, where the contract is metres per second and the panel says metres.
"""

from __future__ import annotations

import time

import httpx
import pytest

from app.models import ObjectType
from app.providers.base import ProviderBadResponse, ProviderRateLimited, ProviderUnavailable
from app.providers.ais import SHIP_TTL_SECONDS
from app.providers.digitraffic import DigitrafficProvider, _packed_eta


def just_now() -> int:
    """The feed's timestamp for a vessel heard from a moment ago.

    Relative to the clock rather than a captured constant, because the provider
    now drops anything older than fifteen minutes (D165) - so a fixed
    timestamp is a fixture that quietly expires, and every test using it starts
    failing some time after it was written for a reason that has nothing to do
    with what it asserts.
    """
    return int(time.time() * 1000)


def feature(**properties) -> dict:
    """One GeoJSON feature in the feed's shape, with sane defaults."""
    base = {
        "mmsi": 230123456,
        "sog": 12.4,
        "cog": 59.9,
        "navStat": 0,
        "heading": 61,
        "timestampExternal": just_now(),
    }
    base.update(properties)
    return {
        "mmsi": base["mmsi"],
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [24.9, 60.1]},
        "properties": base,
    }


# A real metadata row: the 250-metre tanker that was reporting 102.2 knots.
NOUNOU = {
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
}


def provider(locations, vessels=None) -> DigitrafficProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/vessels"):
            return httpx.Response(200, json=vessels if vessels is not None else [])
        return httpx.Response(200, json={"type": "FeatureCollection", "features": locations})

    return DigitrafficProvider(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


def failing(status: int) -> DigitrafficProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, text="no")

    return DigitrafficProvider(client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


class TestDigitrafficsOwnShape:
    """The parts that are this source's, not the protocol's."""

    def test_a_position_of_91_degrees_is_skipped_not_raised(self) -> None:
        # AIS sends lat 91 / lon 181 for "position not available". The
        # contract's validators would reject them, which would take down the
        # whole poll over one vessel.
        bad = feature()
        bad["geometry"]["coordinates"] = [181.0, 91.0]
        assert provider([bad])._to_record(bad) is None

    def test_the_packed_eta_bitfield_decodes(self) -> None:
        # This source packs the four ETA fields into twenty bits; aisstream
        # sends them as a struct. The unpacking is Digitraffic's business, and
        # what the numbers mean is shared (D166). 602432 was on the live feed.
        assert _packed_eta(602432) == "06/09 05:00 UTC"

    def test_an_unset_eta_is_no_eta(self) -> None:
        assert _packed_eta(0) is None


class TestTheRecord:
    @pytest.mark.anyio
    async def test_the_draught_is_decimetres_here(self) -> None:
        # **The conversion that must not be shared.** Digitraffic sends 82 for
        # 8.2 m; aisstream sends 1.9 for 1.9 m. A common helper would have to
        # ask which source it was talking to (D166).
        records = await provider([feature(mmsi=256371000)], [NOUNOU]).fetch()
        assert records[0].meta["draught"] == "8.2 m"

    @pytest.mark.anyio
    async def test_a_vessel_arrives_with_its_name(self) -> None:
        records = await provider([feature(mmsi=256371000)], [NOUNOU]).fetch()
        assert records[0].label == "NOUNOU"
        assert records[0].id == "256371000"
        assert records[0].type is ObjectType.SHIP

    @pytest.mark.anyio
    async def test_a_vessel_with_no_metadata_falls_back_to_its_mmsi(self) -> None:
        # 13% of the feed has no metadata row, and an empty label is what the
        # map draws and what search matches.
        records = await provider([feature(mmsi=999888777)], []).fetch()
        assert records[0].label == "999888777"

    @pytest.mark.anyio
    async def test_sea_level_is_zero_not_unknown(self) -> None:
        # None would mean "the source did not say". It said.
        records = await provider([feature()]).fetch()
        assert records[0].altitude == 0.0

    @pytest.mark.anyio
    async def test_the_observation_time_is_the_feeds_not_ours(self) -> None:
        stamp = just_now()
        records = await provider([feature(timestampExternal=stamp)]).fetch()
        assert records[0].last_seen.timestamp() == pytest.approx(stamp / 1000, abs=0.01)

    @pytest.mark.anyio
    async def test_draught_becomes_metres(self) -> None:
        # 82 decimetres is 8.2 m. Decimetres is a unit nobody thinks in.
        records = await provider([feature(mmsi=256371000)], [NOUNOU]).fetch()
        assert records[0].meta["draught"] == "8.2 m"

    @pytest.mark.anyio
    async def test_hull_size_comes_from_the_antenna_offsets(self) -> None:
        # A + B is the length, C + D the beam. Reporting the raw reference
        # points would be reporting where the aerial is bolted.
        records = await provider([feature(mmsi=256371000)], [NOUNOU]).fetch()
        assert records[0].meta["length"] == "250 m"
        assert records[0].meta["beam"] == "44 m"

    @pytest.mark.anyio
    async def test_navigation_status_is_words(self) -> None:
        # The field that says what a stationary vessel is doing - and four
        # fifths of them are stationary.
        records = await provider([feature(navStat=5)]).fetch()
        assert records[0].meta["navigationStatus"] == "Moored"


class TestFailure:
    @pytest.mark.anyio
    async def test_a_429_is_a_rate_limit_the_poller_understands(self) -> None:
        with pytest.raises(ProviderRateLimited):
            await failing(429).fetch()

    @pytest.mark.anyio
    async def test_a_500_is_unavailable(self) -> None:
        with pytest.raises(ProviderUnavailable):
            await failing(500).fetch()

    @pytest.mark.anyio
    async def test_a_response_that_is_not_a_feature_collection_is_refused(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/vessels"):
                return httpx.Response(200, json=[])
            return httpx.Response(200, json={"features": "nope"})

        bad = DigitrafficProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        with pytest.raises(ProviderBadResponse):
            await bad.fetch()

    @pytest.mark.anyio
    async def test_losing_the_names_does_not_lose_the_ships(self) -> None:
        # Metadata is what makes a vessel read as NOUNOU rather than
        # 256371000. Losing it degrades the map; raising would empty it.
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/vessels"):
                return httpx.Response(503, text="down")
            return httpx.Response(
                200, json={"type": "FeatureCollection", "features": [feature(mmsi=256371000)]}
            )

        degraded = DigitrafficProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )
        records = await degraded.fetch()
        assert len(records) == 1
        assert records[0].label == "256371000"


class TestMetadataCache:
    @pytest.mark.anyio
    async def test_the_names_are_not_refetched_on_every_poll(self) -> None:
        # 916 positions are 37 KB; 806 metadata rows are 260 KB. Fetching both
        # every minute would spend seven times the bandwidth on the half that
        # does not change.
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path.endswith("/vessels"):
                return httpx.Response(200, json=[NOUNOU])
            return httpx.Response(200, json={"type": "FeatureCollection", "features": []})

        cached = DigitrafficProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            metadata_refresh_seconds=600.0,
        )
        await cached.fetch()
        await cached.fetch()
        await cached.fetch()
        assert sum(1 for path in calls if path.endswith("/vessels")) == 1
        assert sum(1 for path in calls if path.endswith("/locations")) == 3

    @pytest.mark.anyio
    async def test_an_expired_cache_is_refetched(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if request.url.path.endswith("/vessels"):
                return httpx.Response(200, json=[NOUNOU])
            return httpx.Response(200, json={"type": "FeatureCollection", "features": []})

        expiring = DigitrafficProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            metadata_refresh_seconds=0.0,
        )
        await expiring.fetch()
        await expiring.fetch()
        assert sum(1 for path in calls if path.endswith("/vessels")) == 2


class TestTheTtl:
    def test_it_drops_the_stale_tail_and_keeps_a_moored_vessel(self) -> None:
        # A moored Class A vessel transmits every three minutes, so the TTL has
        # to clear several missed reports. The endpoint retains 24 hours and
        # 28% of what it returns is over an hour old - serving that is D86's
        # map of ghosts, where 39% of everything drawn was past the fade.
        assert SHIP_TTL_SECONDS >= 5 * 180
        assert SHIP_TTL_SECONDS < 3600


class TestTheStaleTailIsDroppedOnTheWayIn:
    """The store's eviction cannot win against a source that never forgets.

    Eviction assumes the source stops reporting what has gone. This one
    re-serves its own day-old records on every poll, so the store deletes them
    and the next poll puts them straight back - measured live as 920 vessels
    served with 281 past the TTL, the oldest very nearly twenty-four hours
    (D165).
    """

    @pytest.mark.anyio
    async def test_a_vessel_not_heard_from_in_hours_is_not_emitted(self) -> None:
        hours_ago = just_now() - 6 * 3600 * 1000
        records = await provider([feature(timestampExternal=hours_ago)]).fetch()
        assert records == []

    @pytest.mark.anyio
    async def test_a_vessel_heard_from_minutes_ago_is_kept(self) -> None:
        # A moored Class A vessel transmits every three minutes, so the filter
        # has to clear several missed reports without dropping a ship that is
        # simply sitting at a berth.
        recent = just_now() - 8 * 60 * 1000
        records = await provider([feature(timestampExternal=recent)]).fetch()
        assert len(records) == 1

    @pytest.mark.anyio
    async def test_the_boundary_is_the_ttl_and_nothing_else(self) -> None:
        # Pinned against SHIP_TTL_SECONDS rather than a literal, so the two
        # cannot drift apart - a filter looser than the store's TTL would let
        # ghosts back in, and a tighter one would drop vessels the store is
        # still holding.
        inside = just_now() - int((SHIP_TTL_SECONDS - 60) * 1000)
        outside = just_now() - int((SHIP_TTL_SECONDS + 60) * 1000)
        kept = await provider([feature(mmsi=1, timestampExternal=inside)]).fetch()
        dropped = await provider([feature(mmsi=2, timestampExternal=outside)]).fetch()
        assert len(kept) == 1
        assert dropped == []

    @pytest.mark.anyio
    async def test_the_cutoff_can_be_lifted_for_a_caller_that_wants_everything(self) -> None:
        # Not a knob for its own sake: the end-to-end tests replay captured
        # records, and a fixture with a real timestamp in it would otherwise
        # expire quietly some time after it was written.
        hours_ago = just_now() - 6 * 3600 * 1000

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/vessels"):
                return httpx.Response(200, json=[])
            return httpx.Response(
                200,
                json={
                    "type": "FeatureCollection",
                    "features": [feature(timestampExternal=hours_ago)],
                },
            )

        keeps_everything = DigitrafficProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            max_age_seconds=float("inf"),
        )
        assert len(await keeps_everything.fetch()) == 1
