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

import time
from datetime import datetime, timedelta, timezone

import anyio
import httpx
import pytest

from app.models import BBox, TrackPoint
from app.providers.adsblol import (
    GLOBAL_RADIUS_NM,
    GLOBAL_SWEEP,
    _haversine_km,
    VIEWPORT_MAX_RADIUS_NM,
    AdsbLolProvider,
    _circle_for,
    current_flight,
)
from app.providers.base import ProviderBadResponse, ProviderRateLimited, ProviderUnavailable

# One real record, trimmed: a 737 at FL360 out of the live feed.
VIEWPORT = BBox(lat_min=48, lon_min=3, lat_max=49, lon_max=5)

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
    # No spacing between requests: the real gate exists to stay under a rate
    # limiter that a mock transport does not have.
    return AdsbLolProvider(
        client=httpx.AsyncClient(transport=transport), min_request_interval_seconds=0.0
    )


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

    @pytest.mark.anyio
    async def test_age_is_measured_from_the_feed_s_clock(self) -> None:
        # `seen_pos` counts back from the `now` in the payload, so measuring it
        # against our own wall clock adds the round trip and any skew between
        # the machines. Live, that produced a median age of *minus two
        # seconds* - positions timestamped in the future, in a system where
        # everything downstream reasons about age (D83).
        served_at = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)
        payload = {"now": served_at.timestamp() * 1000, "ac": [{**LIVE_RECORD, "seen_pos": 30.0}]}
        records = await provider(responds(payload)).fetch()
        assert records[0].last_seen == served_at - timedelta(seconds=30)

    @pytest.mark.anyio
    async def test_our_clock_is_the_fallback(self) -> None:
        # A payload without `now` is still usable; it is only less precise.
        records = await provider(responds({"ac": [LIVE_RECORD]})).fetch()
        assert (datetime.now(timezone.utc) - records[0].last_seen).total_seconds() < 5


class TestRequestShape:
    @pytest.mark.anyio
    async def test_the_whole_world_is_swept_from_several_points(self) -> None:
        # One circle covers a little over a hemisphere and leaves Australia,
        # New Zealand and the south Pacific out - measured as 0 aircraft over
        # south-east Australia where a direct query found 27 (defect #31).
        urls = []

        def handler(request: httpx.Request) -> httpx.Response:
            urls.append(str(request.url))
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        await provider(handler).fetch(None)
        assert len(urls) == len(GLOBAL_SWEEP)
        for (lat, lon), url in zip(GLOBAL_SWEEP, urls):
            assert f"/point/{lat}/{lon}/{GLOBAL_RADIUS_NM}" in url

    def test_the_sweep_actually_covers_the_sphere(self) -> None:
        # **The property, not a proxy for it.** The first attempt at this test
        # compared longitude gaps, which is neither necessary nor sufficient -
        # it fails a sweep that covers everything and passes one that leaves a
        # polar hole. So: take a grid of points over the whole Earth and check
        # each falls inside at least one circle.
        #
        # This is the test that would have caught defect #31 before Phone did:
        # the single-circle sweep leaves everything south-east of about 20S
        # 150E outside, which is Australia, New Zealand and the south Pacific.
        radius_km = GLOBAL_RADIUS_NM * 1.852
        uncovered = []
        for lat in range(-80, 81, 10):
            for lon in range(-180, 180, 10):
                if not any(
                    _haversine_km(lat, lon, sweep_lat, sweep_lon) <= radius_km
                    for sweep_lat, sweep_lon in GLOBAL_SWEEP
                ):
                    uncovered.append((lat, lon))
        assert uncovered == []

    def test_one_circle_would_not_have_covered_it(self) -> None:
        # The control: without this, the test above passes for a sweep of one
        # point and proves nothing about why there are four.
        radius_km = GLOBAL_RADIUS_NM * 1.852
        first = GLOBAL_SWEEP[0]
        missed = [
            (lat, lon)
            for lat in range(-80, 81, 10)
            for lon in range(-180, 180, 10)
            if _haversine_km(lat, lon, *first) > radius_km
        ]
        assert missed, "a single circle should not cover the planet"

    @pytest.mark.anyio
    async def test_one_failed_circle_does_not_lose_the_other_three(self) -> None:
        # Refusing the whole poll over one throttled request would throw away
        # three quarters of the planet.
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 2:
                return httpx.Response(420, text="calm")
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        records = await provider(handler).fetch(None)
        assert len(records) == 1

    @pytest.mark.anyio
    async def test_a_refused_circle_is_asked_again(self) -> None:
        # Defect #35: the fourth circle was refused on every poll, the partial
        # sweep was tolerated by design, and a continent went missing quietly.
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] == 4:  # the last circle, as in production
                return httpx.Response(429, text="no")
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        records = await provider(handler).fetch(None)
        assert calls["n"] == 5  # four circles, then the refused one again
        assert len(records) == 1

    @pytest.mark.anyio
    async def test_a_circle_that_fails_twice_is_given_up_on(self) -> None:
        # The retry is one attempt, not a loop: a source that is genuinely down
        # must not hold the poll open indefinitely.
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            if calls["n"] in (2, 5):
                return httpx.Response(429, text="no")
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        records = await provider(handler).fetch(None)
        assert calls["n"] == 5
        assert len(records) == 1  # the other three circles still counted

    @pytest.mark.anyio
    async def test_nothing_is_retried_when_the_sweep_is_clean(self) -> None:
        # The retry must cost nothing on the common path.
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"ac": [LIVE_RECORD]})

        await provider(handler).fetch(None)
        assert calls["n"] == len(GLOBAL_SWEEP)

    @pytest.mark.anyio
    async def test_every_circle_failing_is_an_outage(self) -> None:
        # And must raise: an empty list would be applied to the store as a
        # successful poll (D10).
        with pytest.raises(ProviderUnavailable):
            await provider(responds(None, status=503)).fetch(None)

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
            await provider(responds(None, status=420)).fetch(VIEWPORT)

    @pytest.mark.anyio
    async def test_a_conventional_rate_limit_too(self) -> None:
        with pytest.raises(ProviderRateLimited):
            await provider(responds(None, status=429)).fetch(VIEWPORT)

    @pytest.mark.anyio
    async def test_a_server_error_is_unavailability(self) -> None:
        with pytest.raises(ProviderUnavailable):
            await provider(responds(None, status=503)).fetch(VIEWPORT)

    @pytest.mark.anyio
    async def test_a_body_that_is_not_json_is_a_bad_response(self) -> None:
        # Seen for real: a throttled request answered 200 with an empty body.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="")

        with pytest.raises(ProviderBadResponse):
            await provider(handler).fetch(VIEWPORT)

    @pytest.mark.anyio
    async def test_an_empty_sky_is_not_an_error(self) -> None:
        assert await provider(responds({"ac": []})).fetch(VIEWPORT) == []
        assert await provider(responds({})).fetch(VIEWPORT) == []


#: A test interval, and the gap a test is willing to call "spaced".
#:
#: Windows' timer granularity is about 15 ms, so `asyncio.sleep(0.05)` can
#: return in 40 ms and an exact assertion fails for reasons that have nothing
#: to do with the gate. The tolerance is granularity, not slack in the rule.
INTERVAL = 0.2
SPACED_ENOUGH = 0.15


class TestTheRequestGate:
    """Defect #35, second half.

    Spacing the sweep's own circles fixed the sweep in isolation and left it
    sharing a rate limit with the viewport job, which polls on its own 15 s
    schedule through the same provider. One circle was still refused twice
    under viewport traffic. The limit belongs to the address, so the gate does
    too - it spaces *every* request this provider makes, whoever asked.
    """

    @pytest.mark.anyio
    async def test_requests_are_spaced_by_the_interval(self) -> None:
        sent: list[float] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(time.monotonic())
            return httpx.Response(200, json={"ac": []})

        provider = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=INTERVAL,
        )
        await provider.fetch(VIEWPORT)
        await provider.fetch(VIEWPORT)
        assert len(sent) == 2
        assert sent[1] - sent[0] >= SPACED_ENOUGH

    @pytest.mark.anyio
    async def test_two_callers_at_once_get_two_slots_not_one(self) -> None:
        # The failure this rules out: both read the clock, both see a free
        # slot, both send. That is exactly the sweep-and-viewport collision.
        sent: list[float] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(time.monotonic())
            return httpx.Response(200, json={"ac": []})

        provider = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=INTERVAL,
        )
        async with anyio.create_task_group() as group:
            group.start_soon(provider.fetch, VIEWPORT)
            group.start_soon(provider.fetch, VIEWPORT)
        assert len(sent) == 2
        assert abs(sent[1] - sent[0]) >= SPACED_ENOUGH

    @pytest.mark.anyio
    async def test_the_first_request_waits_too(self) -> None:
        # Deliberate, and the opposite of what this test first asserted. A
        # fresh process cannot know the address was quiet, and after a restart
        # it usually was not: across two restarts the first sweep of each was
        # the only one to lose a circle. One interval of startup latency, once
        # per process, buys that back.
        provider = AdsbLolProvider(
            client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, json={"ac": []})
                )
            ),
            min_request_interval_seconds=INTERVAL,
        )
        started = time.monotonic()
        await provider.fetch(VIEWPORT)
        assert time.monotonic() - started >= SPACED_ENOUGH


#: A trace shaped exactly like the one adsb.lol served for 9V-SGB, an A359 over
#: the Bay of Bengal, trimmed to the rows that matter. Captured from the live
#: service rather than invented, because the whole value of this parser is that
#: it agrees with what the service actually sends (D200).
REAL_TRACE = {
    "icao": "76cce2",
    "r": "9V-SGB",
    "t": "A359",
    "timestamp": 1788973515.29,
    "trace": [
        [19.54, 23.000809, 85.946554, 41000, 480.9, 131.7],
        [79.12, 22.900000, 86.100000, 41000, 481.0, 131.5],
        [139.00, 22.800000, 86.250000, "ground", 0.0, 0.0],
    ],
}


class TestFlightTrace:
    """The method D78 concluded did not exist (D200).

    It was right about `api.adsb.lol` and wrong about the project: the traces
    are published by the map server in readsb's format. Over Thailand, three
    aircraft in ten had an OpenSky track and ten in ten had one here.
    """

    @pytest.mark.anyio
    async def test_reads_a_real_trace_oldest_first(self):
        track = await provider(responds(REAL_TRACE)).fetch_track("76cce2")

        assert track is not None and len(track) == 3
        assert [p.timestamp for p in track] == sorted(p.timestamp for p in track)
        # Base timestamp plus the row's own offset, not the offset alone.
        assert track[0].timestamp == datetime.fromtimestamp(
            1788973515.29 + 19.54, tz=timezone.utc
        )

    @pytest.mark.anyio
    async def test_altitudes_arrive_in_feet_and_are_stored_in_metres(self):
        # **The unit that would otherwise be silently wrong.** OpenSky's
        # altitudes are already metric, so an unconverted 41,000 would put a
        # cruising airliner above the Karman line on a map that draws
        # satellites.
        track = await provider(responds(REAL_TRACE)).fetch_track("76cce2")
        assert track is not None
        assert track[0].altitude == pytest.approx(12496.8, abs=1.0)

    @pytest.mark.anyio
    async def test_ground_is_nil_rather_than_unknown(self):
        # readsb writes the string "ground" instead of a number. An aircraft on
        # a runway is at zero, which is a fact, not a missing reading (D165).
        track = await provider(responds(REAL_TRACE)).fetch_track("76cce2")
        assert track is not None
        assert track[-1].altitude == 0.0

    @pytest.mark.anyio
    async def test_a_row_without_a_position_is_dropped(self):
        # A point at (0, 0) draws a line through the Gulf of Guinea (D18).
        payload = {**REAL_TRACE, "trace": [[1.0, None, None, 1000], *REAL_TRACE["trace"]]}
        track = await provider(responds(payload)).fetch_track("76cce2")
        assert track is not None and len(track) == 3

    @pytest.mark.anyio
    async def test_an_untraced_aircraft_is_an_answer_not_a_fault(self):
        # Most of the sky has never been traced. A 404 means "no path", and the
        # caller keeps the track it observed itself rather than seeing an error.
        assert await provider(responds(None, status=404)).fetch_track("76cce2") is None

    @pytest.mark.anyio
    async def test_rate_limiting_is_reported_as_rate_limiting(self):
        # 420 is this service's own "enhance your calm"; the poller's backoff
        # understands that and a generic failure would not (D26).
        for status in (420, 429):
            with pytest.raises(ProviderRateLimited):
                await provider(responds(None, status=status)).fetch_track("76cce2")

    @pytest.mark.anyio
    async def test_an_empty_trace_is_no_track_rather_than_an_empty_one(self):
        payload = {**REAL_TRACE, "trace": []}
        assert await provider(responds(payload)).fetch_track("76cce2") is None

    @pytest.mark.anyio
    async def test_the_file_is_addressed_by_the_last_two_hex_characters(self):
        # readsb shards the directory that way, and getting it wrong is a 404
        # for every aircraft rather than a visible error.
        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(200, json=REAL_TRACE)

        await provider(handler).fetch_track("76CCE2")
        assert seen[0].endswith("/e2/trace_full_76cce2.json"), seen[0]

    @pytest.mark.anyio
    async def test_the_trace_does_not_queue_behind_the_poll_gate(self):
        # **The gate must not apply here.** It spaces *polls* twelve seconds
        # apart to stay under a rate limiter; a trace is a static file on a
        # different host, fetched when a reader selects an aircraft. Behind the
        # gate it would miss the three-second budget a detail request allows
        # (D181) and never arrive.
        p = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(responds(REAL_TRACE))),
            min_request_interval_seconds=12.0,
        )
        before = p._next_allowed_at
        assert await p.fetch_track("76cce2") is not None
        assert p._next_allowed_at == before, "the trace claimed a poll slot"

    @pytest.mark.anyio
    async def test_an_empty_base_url_turns_it_off(self):
        # The off switch, for a deployment that wants OpenSky to be the only
        # source of a path from takeoff.
        p = AdsbLolProvider(
            trace_base_url="",
            client=httpx.AsyncClient(transport=httpx.MockTransport(responds(REAL_TRACE))),
            min_request_interval_seconds=0.0,
        )
        assert await p.fetch_track("76cce2") is None


def _pt(minutes: float, alt: float | None) -> TrackPoint:
    return TrackPoint(
        lat=1.0 + minutes / 1000,
        lon=2.0,
        altitude=alt,
        timestamp=datetime(2026, 9, 10, tzinfo=timezone.utc) + timedelta(minutes=minutes),
    )


class TestCurrentFlight:
    """Trimming a day-long trace to the leg in progress (D201).

    A full trace covers 24 hours and several flights. Drawn whole it is the
    D196 fault with more points: a confident line along a journey the aircraft
    finished hours ago.
    """

    def test_the_ground_is_the_boundary(self):
        # Taxi, take off, climb, cruise. Everything after the last wheels-down
        # reading is this flight, and that needs no threshold at all.
        track = (
            _pt(0, 0.0), _pt(5, 0.0),          # yesterday, on a stand
            _pt(600, 10000.0),                 # yesterday's leg
            _pt(1200, 0.0),                    # landed, on the ground
            _pt(1260, 3000.0), _pt(1290, 11000.0),  # today's leg
        )
        assert current_flight(track) == track[4:]

    def test_the_last_ground_contact_wins_not_the_first(self):
        track = (_pt(0, 0.0), _pt(60, 9000.0), _pt(120, 0.0), _pt(180, 9000.0), _pt(200, 9500.0))
        assert current_flight(track) == track[3:]

    def test_an_aircraft_on_the_ground_now_keeps_its_path(self):
        # On final approach or taxiing in, the last ground reading is the most
        # recent point and the tail is empty. Erasing the path at the moment of
        # landing would be the worst time to do it.
        track = (_pt(0, 9000.0), _pt(30, 3000.0), _pt(60, 0.0))
        assert current_flight(track) == track

    def test_a_long_silence_is_the_fallback_when_nothing_touched_the_ground(self):
        # A trace that begins mid-ocean, or a long-haul still airborne. Four
        # hours of silence is a turnaround, not a coverage hole.
        track = (_pt(0, 11000.0), _pt(30, 11000.0), _pt(300, 11000.0), _pt(330, 11000.0))
        assert current_flight(track) == track[2:]

    def test_a_coverage_hole_is_not_a_new_flight(self):
        # **The distinction that matters.** SIA23 crossed the Bay of Bengal for
        # 86 minutes unheard; that is one flight with a gap in it, and cutting
        # there would throw away most of a real path.
        track = (_pt(0, 11000.0), _pt(20, 11000.0), _pt(106, 11000.0), _pt(126, 11000.0))
        assert current_flight(track) == track

    def test_a_trace_with_no_break_is_kept_whole(self):
        track = tuple(_pt(i * 5, 11000.0) for i in range(10))
        assert current_flight(track) == track

    def test_too_short_to_trim_is_returned_as_is(self):
        for track in ((), (_pt(0, 0.0),)):
            assert current_flight(track) == track
