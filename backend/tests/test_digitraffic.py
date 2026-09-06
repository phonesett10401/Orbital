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
from app.providers.digitraffic import (
    MAX_PLAUSIBLE_KNOTS,
    SHIP_TTL_SECONDS,
    SHIP_TYPE_BY_TENS,
    SPECIAL_CRAFT,
    DigitrafficProvider,
    _eta,
    _heading,
    _ship_type,
    _speed_ms,
)


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


class TestSentinels:
    """AIS says "I do not know" with a number that looks like an answer."""

    @pytest.mark.parametrize("knots", [102.3, 102.2, 85.0, 81.0, 79.6])
    def test_an_impossible_speed_is_no_speed(self, knots: float) -> None:
        # Every one of these was on the live feed, attached to a real vessel:
        # 102.3 is the AIS sentinel, 102.2 is the saturation value one below it
        # that the first version of this let through, and the rest are simply
        # broken transmitters - one of them on a *moored* tug.
        assert _speed_ms(knots) is None

    def test_the_fastest_believable_ship_is_still_believed(self) -> None:
        # The ceiling has to refuse the impossible without refusing fast craft;
        # a limit that clipped a 50-knot patrol boat would be trading one wrong
        # answer for another.
        assert _speed_ms(MAX_PLAUSIBLE_KNOTS) == pytest.approx(30.87, abs=0.01)

    def test_knots_become_metres_per_second(self) -> None:
        # 12.4 kt is 6.4 m/s. Left in knots the client would dead-reckon every
        # vessel at twice its real speed (D71).
        assert _speed_ms(12.4) == pytest.approx(6.38, abs=0.02)

    def test_a_stopped_ship_is_stopped_not_unknown(self) -> None:
        # Four fifths of this feed is moored or at anchor. Treating zero as
        # falsy here would erase the speed of most of the layer.
        assert _speed_ms(0.0) == 0.0

    def test_heading_511_falls_through_to_course(self) -> None:
        assert _heading({"heading": 511, "cog": 88.0}) == pytest.approx(88.0)

    def test_course_360_is_not_due_north(self) -> None:
        # 88 vessels were sending it. Read as a bearing it points every one of
        # them at the North Pole.
        assert _heading({"heading": 511, "cog": 360.0}) is None

    def test_neither_available_means_no_heading(self) -> None:
        assert _heading({"heading": 511, "cog": 360.0}) is None

    def test_true_heading_wins_over_course(self) -> None:
        # The opposite of the aircraft layer's choice, and deliberate: a ship
        # at anchor swings on its cable and has a heading but no course.
        assert _heading({"heading": 12, "cog": 200.0}) == pytest.approx(12.0)

    def test_a_position_of_91_degrees_is_skipped_not_raised(self) -> None:
        # AIS sends lat 91 / lon 181 for "position not available". The
        # contract's validators would reject them, which would take down the
        # whole poll over one vessel.
        bad = feature()
        bad["geometry"]["coordinates"] = [181.0, 91.0]
        assert provider([bad])._to_record(bad) is None


class TestTheRecord:
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


class TestShipType:
    def test_the_tens_digit_carries_the_meaning(self) -> None:
        assert _ship_type(70) == "Cargo"
        assert _ship_type(79) == "Cargo"
        assert _ship_type(80) == "Tanker"
        assert _ship_type(69) == "Passenger"

    def test_the_thirties_and_fifties_are_spelled_out(self) -> None:
        # Flattening these to "special craft" would put a tug, a dredger and a
        # warship in one bucket.
        assert _ship_type(52) == "Tug"
        assert _ship_type(33) == "Dredger"
        assert _ship_type(51) == "Search and rescue"

    def test_no_type_is_none_rather_than_a_guess(self) -> None:
        assert _ship_type(0) is None
        assert _ship_type(None) is None
        assert _ship_type(150) is None


class TestEta:
    def test_the_bitfield_decodes(self) -> None:
        # 602432 was on the live feed: month 9, day 6, hour 5, minute 0.
        assert _eta(602432) == "06/09 05:00 UTC"

    def test_an_unset_eta_is_no_eta(self) -> None:
        # A vessel that has not stated one sends zeroes, which decode to month
        # zero and day zero - a date that does not exist.
        assert _eta(0) is None

    def test_the_not_available_hour_is_refused(self) -> None:
        # Hour 24 and minute 60 are the field's own "unknown", and both are
        # out of range for a clock.
        assert _eta((9 << 16) | (6 << 11) | (24 << 6) | 60) is None


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


class TestTheVocabularyIsAContract:
    """The words this provider emits are read by a file in another language.

    ``frontend/src/shipKind.ts`` maps each of them to a colour, and a word it
    does not know falls through to grey rather than raising - so a vessel type
    added here would silently lose its colour on the map, and nothing would
    report it. There is nothing to import across that boundary, so the set is
    written out on both sides and each side asserts it.
    """

    def test_the_emitted_words_are_exactly_the_ones_the_map_expects(self) -> None:
        # Mirrored in frontend/src/shipKind.test.ts as BACKEND_VOCABULARY.
        # Change one, and this test and its twin both fail - which is the
        # point: the failure names the other file.
        assert sorted(set(SHIP_TYPE_BY_TENS.values()) | set(SPECIAL_CRAFT.values())) == [
            "Anti-pollution",
            "Cargo",
            "Diving support",
            "Dredger",
            "Fishing",
            "High speed craft",
            "Law enforcement",
            "Medical transport",
            "Military",
            "Other",
            "Passenger",
            "Pilot vessel",
            "Pleasure craft",
            "Port tender",
            "Sailing",
            "Search and rescue",
            "Special craft",
            "Tanker",
            "Towing",
            "Towing (long)",
            "Tug",
            "Wing in ground",
        ]

    def test_every_code_the_feed_can_send_resolves_to_one_of_them(self) -> None:
        # The tens-digit table covers 20-99 and the named table punches through
        # it. Anything outside is None, not a word - so this also pins that
        # codes 0-19 stay unnamed rather than acquiring a guess.
        vocabulary = set(SHIP_TYPE_BY_TENS.values()) | set(SPECIAL_CRAFT.values())
        for code in range(0, 100):
            word = _ship_type(code)
            assert word is None or word in vocabulary, code


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
