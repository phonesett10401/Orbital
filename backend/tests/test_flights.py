"""Tests for the departure airport and the provider's flight track.

Two things are worth testing here and they are not the parsing.

**The inference must refuse to guess.** The origin is the nearest airport to
the first point of a track, and a nearest-match will always return something if
you let it. The tests below check that it returns *nothing* for a flight
picked up over the ocean, for one cruising above an airfield, and for a track
that starts anywhere no airport is -- because naming an airport there is
exactly the confident wrong answer the contract forbids for a null heading
(D18, D78).

**The cache must not spend credits.** `/tracks/all` costs 4 credits a call, the
client polls the selected aircraft while it is selected, and an uncached fetch
would empty a day's allowance in under an hour. The counting tests are the
point of this file, not decoration.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.airports import ORIGIN_MAX_KM, haversine_km, nearest_airport, origin_of
from app.ingestion.flights import (
    COURSE_MAX_DISAGREEMENT_DEG,
    SPEED_MAX_PLAUSIBLE_MS,
    FlightHistory,
    clean_track,
    course_from_track,
    speed_from_track,
)
from app.models import ObjectType, TrackedObjectDetail, TrackPoint, TrackSource
from app.providers.base import Provider, ProviderRateLimited

NOW = datetime(2026, 8, 30, 12, 0, tzinfo=timezone.utc)

# Sydney Kingsford Smith, and the point RXA6681's real track began at: 800 m
# from the airport, which is what a track that starts on a runway looks like.
SYDNEY = (-33.9461, 151.1772)
SYDNEY_TRACK_START = (-33.9533, 151.1776)


def point(lat: float, lon: float, altitude: float | None = 0.0, offset: int = 0) -> TrackPoint:
    return TrackPoint(
        lat=lat, lon=lon, altitude=altitude, timestamp=NOW + timedelta(seconds=offset)
    )


class StubProvider(Provider):
    """A provider that counts how often its track is bought."""

    name = "stub"
    object_type = ObjectType.AIRCRAFT

    def __init__(self, track: tuple[TrackPoint, ...] | None, *, error: Exception | None = None):
        self.track = track
        self.error = error
        self.calls = 0

    async def fetch(self, bbox=None):  # pragma: no cover - not exercised here
        return []

    async def fetch_track(self, object_id: str):
        self.calls += 1
        if self.error is not None:
            raise self.error
        return self.track


def detail_with(**fields: object) -> TrackedObjectDetail:
    """A detail with specific reported values, everything else as the fixture."""
    return detail().model_copy(update=fields)


def detail(object_id: str = "abc123") -> TrackedObjectDetail:
    return TrackedObjectDetail(
        id=object_id,
        lat=1.0,
        lon=2.0,
        altitude=10000.0,
        velocity=200.0,
        heading=90.0,
        label="TEST123",
        last_seen=NOW,
        type=ObjectType.AIRCRAFT,
        # Carries source meta, so the corrections below are shown not to
        # clobber what the provider itself reported.
        meta={"originCountry": "Testland"},
        track=(point(1.0, 2.0), point(1.1, 2.1)),
    )


class TestHaversine:
    def test_measures_a_known_distance(self) -> None:
        # Sydney to Melbourne is about 705 km, which is the kind of number that
        # catches a radians/degrees mistake instantly.
        assert haversine_km(-33.9461, 151.1772, -37.6690, 144.8410) == pytest.approx(705, abs=15)

    def test_is_zero_for_a_point_against_itself(self) -> None:
        assert haversine_km(13.75, 100.5, 13.75, 100.5) == 0.0


class TestNearestAirport:
    def test_finds_the_airport_a_real_track_began_on(self) -> None:
        found = nearest_airport(*SYDNEY_TRACK_START)
        assert found is not None
        assert found.icao == "YSSY"
        assert found.name.startswith("Sydney")
        assert found.distance_km < 1.5

    def test_the_inferred_origin_is_named_the_way_a_scheduled_one_is(self) -> None:
        """The panel puts the two side by side (D88).

        Both come from the same table, so an observed origin showing "YSSY"
        beside a scheduled "SYD Sydney" would be our omission rather than a
        difference in what is known.
        """
        found = nearest_airport(*SYDNEY_TRACK_START)
        assert found is not None
        assert found.iata == "SYD"
        assert found.municipality == "Sydney"

    def test_finds_nothing_in_the_middle_of_an_ocean(self) -> None:
        # The South Pacific, thousands of kilometres from anywhere. A
        # nearest-match with no limit would still answer.
        assert nearest_airport(-40.0, -140.0) is None

    def test_respects_the_distance_limit(self) -> None:
        # Two degrees north of Sydney is 222 km: an airport exists, and it is
        # not this flight's origin.
        assert nearest_airport(SYDNEY[0] + 2, SYDNEY[1]) is None
        assert nearest_airport(SYDNEY[0] + 2, SYDNEY[1], max_km=400) is not None

    def test_searches_across_a_cell_boundary(self) -> None:
        # The index buckets by whole degrees, so an airport just over a
        # boundary from the query is the case a single-bucket lookup misses -
        # silently, and only for some airports.
        just_south = nearest_airport(-34.0001, 151.1772)
        assert just_south is not None and just_south.icao == "YSSY"

    def test_carries_how_far_away_it_was(self) -> None:
        # The client says "0.8 km away" rather than asserting a departure, so
        # the distance is part of the answer rather than an implementation
        # detail.
        found = nearest_airport(*SYDNEY_TRACK_START)
        assert found is not None
        assert 0 < found.distance_km <= ORIGIN_MAX_KM


class TestOriginOf:
    def test_reads_the_origin_off_the_first_waypoint(self) -> None:
        track = (point(*SYDNEY_TRACK_START, altitude=-92.0), point(-33.8, 151.0, 1200.0, 60))
        origin = origin_of(track)
        assert origin is not None and origin.icao == "YSSY"

    def test_uses_the_first_point_and_not_the_last(self) -> None:
        # A flight that lands somewhere is not a flight that departed there.
        track = (point(-40.0, -140.0, 10000.0), point(*SYDNEY_TRACK_START, altitude=0.0, offset=60))
        assert origin_of(track) is None

    def test_refuses_a_flight_merely_passing_over_an_airport(self) -> None:
        # Cruising above Sydney at 11 km is not departing from it, and without
        # the altitude test every overflight of a city claims its airport.
        assert origin_of((point(*SYDNEY_TRACK_START, altitude=11000.0),)) is None

    def test_accepts_an_unknown_altitude(self) -> None:
        # Altitude is nullable in the contract (D18). A track that begins on a
        # runway with no altitude reported is still a departure.
        assert origin_of((point(*SYDNEY_TRACK_START, altitude=None),)) is not None

    def test_says_nothing_about_an_empty_track(self) -> None:
        assert origin_of(()) is None


class TestFlightHistory:
    @pytest.mark.anyio
    async def test_replaces_the_observed_track_and_names_the_origin(self) -> None:
        provider = StubProvider((point(*SYDNEY_TRACK_START), point(-33.8, 151.0, 1200.0, 60)))
        enriched = await FlightHistory(provider).enrich(detail())
        assert enriched.track_source is TrackSource.PROVIDER
        assert enriched.origin is not None and enriched.origin.icao == "YSSY"
        assert len(enriched.track) == 2

    @pytest.mark.anyio
    async def test_keeps_what_we_observed_when_the_provider_has_nothing(self) -> None:
        # The common case for an aircraft that has just appeared, and it must
        # not cost the panel its line.
        original = detail()
        enriched = await FlightHistory(StubProvider(None)).enrich(original)
        assert enriched.track == original.track
        assert enriched.track_source is TrackSource.OBSERVED
        assert enriched.origin is None

    @pytest.mark.anyio
    async def test_a_provider_failure_does_not_fail_the_request(self) -> None:
        # Everything else in the panel is already in hand; losing it because a
        # secondary enrichment was rate-limited would be the worse answer.
        history = FlightHistory(StubProvider(None, error=ProviderRateLimited("no", 30.0)))
        enriched = await history.enrich(detail())
        assert enriched.track_source is TrackSource.OBSERVED

    @pytest.mark.anyio
    async def test_buys_the_track_once_and_serves_it_from_cache(self) -> None:
        # 4 credits a call, and the client re-polls the selected aircraft every
        # few seconds while it is selected.
        provider = StubProvider((point(*SYDNEY_TRACK_START),))
        history = FlightHistory(provider)
        for _ in range(10):
            await history.enrich(detail())
        assert provider.calls == 1

    @pytest.mark.anyio
    async def test_caches_the_absence_of_a_track_too(self) -> None:
        # The easy one to leave out: a 404 is the common answer, and an
        # uncached negative pays repeatedly to be told nothing.
        provider = StubProvider(None)
        history = FlightHistory(provider)
        for _ in range(10):
            await history.enrich(detail())
        assert provider.calls == 1

    @pytest.mark.anyio
    async def test_caches_a_failure_rather_than_retrying_into_it(self) -> None:
        provider = StubProvider(None, error=ProviderRateLimited("no", 30.0))
        history = FlightHistory(provider)
        for _ in range(5):
            await history.enrich(detail())
        assert provider.calls == 1

    @pytest.mark.anyio
    async def test_buys_once_for_a_burst_of_simultaneous_requests(self) -> None:
        # Several detail requests can arrive while the first is still in
        # flight; without the lock each buys its own copy of the same answer.
        provider = StubProvider((point(*SYDNEY_TRACK_START),))
        history = FlightHistory(provider)
        await asyncio.gather(*(history.enrich(detail()) for _ in range(8)))
        assert provider.calls == 1

    @pytest.mark.anyio
    async def test_refetches_once_the_entry_is_stale(self) -> None:
        # A track grows, so the cache is a rate limit rather than a permanent
        # answer.
        provider = StubProvider((point(*SYDNEY_TRACK_START),))
        history = FlightHistory(provider, ttl_seconds=0.0)
        await history.enrich(detail())
        await history.enrich(detail())
        assert provider.calls == 2

    @pytest.mark.anyio
    async def test_caches_per_aircraft(self) -> None:
        provider = StubProvider((point(*SYDNEY_TRACK_START),))
        history = FlightHistory(provider)
        await history.enrich(detail("aaa111"))
        await history.enrich(detail("bbb222"))
        await history.enrich(detail("aaa111"))
        assert provider.calls == 2


class TestCourseFromTrack:
    """The direction of travel at the end of a track (D80).

    The point of taking it from the *track* rather than from consecutive polls:
    the provider samples every six seconds, so the bearing between two
    waypoints is the instantaneous course. Our own polling is 90 to 300 seconds
    apart, and over that gap the same arithmetic measures the chord of whatever
    the aircraft did in between. Measured across 3,641 aircraft, 5.6% disagree
    with their reported heading by over 30 degrees on a two-minute gap - and
    most of those turned rather than lied.
    """

    def test_reads_the_course_off_the_last_short_gap(self) -> None:
        track = (point(20.0, 95.0, offset=0), point(20.0, 95.05, offset=6))
        assert course_from_track(track) == pytest.approx(90.0, abs=0.5)

    def test_skips_a_long_final_gap_for_the_pair_before_it(self) -> None:
        # Real tracks end this way: six-second samples and then a jump to the
        # provider's latest position, minutes later.
        track = (
            point(20.0, 95.0, offset=0),
            point(20.0, 95.05, offset=6),
            point(21.0, 96.0, offset=300),
        )
        assert course_from_track(track) == pytest.approx(90.0, abs=0.5)

    def test_ignores_a_pair_too_close_together_to_measure(self) -> None:
        # A few metres apart is position noise, not a direction.
        track = (point(20.0, 95.0, offset=0), point(20.00001, 95.00001, offset=6))
        assert course_from_track(track) is None

    def test_has_no_answer_for_a_track_of_one_point(self) -> None:
        assert course_from_track((point(20.0, 95.0),)) is None
        assert course_from_track(()) is None


class TestHeadingFromTheTrack:
    @pytest.mark.anyio
    async def test_a_contradicted_heading_loses_to_the_track(self) -> None:
        # The aircraft that started this: reported 7 degrees while its own
        # track ran due east.
        provider = StubProvider((point(20.0, 95.0, offset=0), point(20.0, 95.05, offset=6)))
        enriched = await FlightHistory(provider).enrich(detail_with(heading=7.0))
        assert enriched.heading == pytest.approx(90.0, abs=0.5)
        assert enriched.meta["headingSource"] == "derived"

    @pytest.mark.anyio
    async def test_an_agreeing_heading_is_left_alone(self) -> None:
        # The normal case by far: the median disagreement across the live feed
        # is 0.3 degrees, and a correction that fires here would be noise.
        provider = StubProvider((point(20.0, 95.0, offset=0), point(20.0, 95.05, offset=6)))
        enriched = await FlightHistory(provider).enrich(detail_with(heading=88.0))
        assert enriched.heading == 88.0
        assert "headingSource" not in enriched.meta

    @pytest.mark.anyio
    async def test_a_disagreement_inside_the_threshold_is_left_alone(self) -> None:
        provider = StubProvider((point(20.0, 95.0, offset=0), point(20.0, 95.05, offset=6)))
        inside = 90.0 - (COURSE_MAX_DISAGREEMENT_DEG - 5.0)
        enriched = await FlightHistory(provider).enrich(detail_with(heading=inside))
        assert enriched.heading == inside

    @pytest.mark.anyio
    async def test_a_null_heading_stays_null(self) -> None:
        # Unknown is a value (D18, D40). Filling it would change what the
        # legend's "heading unknown" disc means, which is a separate decision.
        provider = StubProvider((point(20.0, 95.0, offset=0), point(20.0, 95.05, offset=6)))
        enriched = await FlightHistory(provider).enrich(detail_with(heading=None))
        assert enriched.heading is None
        assert "headingSource" not in enriched.meta

    @pytest.mark.anyio
    async def test_an_unmeasurable_track_leaves_the_heading_reported(self) -> None:
        # One waypoint is a position, not a direction.
        provider = StubProvider((point(20.0, 95.0, offset=0),))
        enriched = await FlightHistory(provider).enrich(detail_with(heading=7.0))
        assert enriched.heading == 7.0


class TestSpeedFromTrack:
    """Ground speed measured off the same two waypoints as the course (D81).

    The rules here are far stricter than the heading's, because the evidence
    is the other way round. Across 2,971 live aircraft moving faster than
    100 m/s, reported velocity differs from the speed their positions imply by
    a median of **1.7 m/s** - it is nearly always right. Only 0.30% report
    under half their observed speed, and the extremes of that group implied
    1035, 928 and 635 m/s, which nothing flies. Those are jumped positions, and
    importing them would replace a correct 244 m/s with nonsense.
    """

    def test_measures_the_speed_over_the_last_short_gap(self) -> None:
        # 0.05 degrees of longitude at the equator is about 5.6 km; over 20
        # seconds that is roughly 280 m/s.
        track = (point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20))
        speed = speed_from_track(track)
        assert speed is not None and speed == pytest.approx(278, abs=5)

    def test_refuses_a_speed_nothing_can_fly(self) -> None:
        # The failure mode that matters: a jumped position implying 900 m/s.
        # Answering None here is what keeps a correct reported velocity.
        track = (point(0.0, 0.0, offset=0), point(0.0, 0.2, offset=20))
        assert speed_from_track(track) is None

    def test_shares_its_waypoints_with_the_course(self) -> None:
        # Two functions choosing their own pairs could describe two different
        # moments, and the panel would then show a heading and a speed that
        # were never true together.
        track = (
            point(0.0, 0.0, offset=0),
            point(0.0, 0.05, offset=20),
            point(1.0, 1.0, offset=400),
        )
        assert course_from_track(track) == pytest.approx(90.0, abs=0.5)
        assert speed_from_track(track) == pytest.approx(278, abs=5)

    def test_has_no_answer_without_a_usable_pair(self) -> None:
        assert speed_from_track((point(0.0, 0.0),)) is None
        assert speed_from_track(()) is None


class TestSpeedCorrection:
    @pytest.mark.anyio
    async def test_a_contradicted_speed_loses_to_the_track(self) -> None:
        # The aircraft that prompted it: 12 m/s reported at cruise, while its
        # own track shows 278.
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20)))
        enriched = await FlightHistory(provider).enrich(detail_with(velocity=12.44))
        assert enriched.velocity == pytest.approx(278, abs=5)
        assert enriched.meta["velocitySource"] == "derived"

    @pytest.mark.anyio
    async def test_an_ordinary_disagreement_is_left_alone(self) -> None:
        # The track-derived figure carries noise of its own - a median of 7.6
        # m/s and up to 35 across aircraft with sound data - so a correction
        # firing here would be noise replacing signal.
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20)))
        enriched = await FlightHistory(provider).enrich(detail_with(velocity=250.0))
        assert enriched.velocity == 250.0
        assert "velocitySource" not in enriched.meta

    @pytest.mark.anyio
    async def test_a_large_difference_still_needs_a_large_ratio(self) -> None:
        # 180 against 278 is 98 m/s apart, which is over the absolute floor -
        # and well inside the factor of two, so the reported figure stands.
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20)))
        enriched = await FlightHistory(provider).enrich(detail_with(velocity=180.0))
        assert enriched.velocity == 180.0

    @pytest.mark.anyio
    async def test_an_impossible_track_speed_never_overrules_anything(self) -> None:
        # 0.2 degrees in 20 seconds is 1100 m/s: a jumped position. The
        # reported 244 is correct and must survive.
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.2, offset=20)))
        enriched = await FlightHistory(provider).enrich(detail_with(velocity=244.0))
        assert enriched.velocity == 244.0
        assert "velocitySource" not in enriched.meta
        assert SPEED_MAX_PLAUSIBLE_MS < 1100

    @pytest.mark.anyio
    async def test_a_null_velocity_stays_null(self) -> None:
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20)))
        enriched = await FlightHistory(provider).enrich(detail_with(velocity=None))
        assert enriched.velocity is None

    @pytest.mark.anyio
    async def test_both_corrections_can_apply_to_one_aircraft(self) -> None:
        # They share a pair of waypoints and both write to meta; the second
        # must not drop what the first wrote.
        provider = StubProvider((point(0.0, 0.0, offset=0), point(0.0, 0.05, offset=20)))
        enriched = await FlightHistory(provider).enrich(
            detail_with(heading=7.0, velocity=12.44)
        )
        assert enriched.meta["headingSource"] == "derived"
        assert enriched.meta["velocitySource"] == "derived"
        assert enriched.meta["originCountry"] == "Testland"


class TestCleanTrack:
    """Waypoints no aircraft could have reached and left (D82).

    Of ten live tracks checked, five contained at least one segment implying
    over 400 m/s, and one of those drew a flight across Myanmar as a V-shaped
    detour to an airport it never went near. The waypoint is wrong, not the
    flight.

    The fixtures below space their points at **0.013 degrees of longitude per
    six seconds**, which is about 240 m/s at the equator - a cruising airliner.
    The first draft used 0.05, which is 927 m/s, and the cleaner correctly
    deleted the lot.
    """

    def test_drops_a_lone_impossible_waypoint(self) -> None:
        # A spike: twenty degrees of longitude away and back, in twelve seconds.
        track = (
            point(0.0, 0.0, offset=0),
            point(0.0, 20.0, offset=6),
            point(0.0, 0.026, offset=12),
        )
        cleaned = clean_track(track)
        assert len(cleaned) == 2
        assert [p.lon for p in cleaned] == [0.0, 0.026]

    def test_keeps_a_coverage_gap_untouched(self) -> None:
        # Far apart in distance and proportionally far apart in time, so the
        # speed it implies is ordinary. Testing distance alone would delete
        # every gap in every track; testing speed keeps them.
        track = (
            point(0.0, 0.0, offset=0),
            point(0.0, 2.0, offset=1200),
            point(0.0, 2.013, offset=1206),
        )
        assert clean_track(track) == track

    def test_keeps_an_ordinary_track_exactly_as_it_came(self) -> None:
        track = tuple(point(0.0, i * 0.013, offset=i * 6) for i in range(6))
        assert clean_track(track) == track

    def test_drops_a_spike_at_the_end(self) -> None:
        # Only one side to be wrong about, so the incoming segment decides.
        track = (
            point(0.0, 0.0, offset=0),
            point(0.0, 0.013, offset=6),
            point(0.0, 30.0, offset=12),
        )
        cleaned = clean_track(track)
        assert len(cleaned) == 2

    def test_leaves_a_track_too_short_to_judge(self) -> None:
        # Two points have no middle, and calling one of them an outlier would
        # be a coin toss.
        pair = (point(0.0, 0.0, offset=0), point(0.0, 30.0, offset=6))
        assert clean_track(pair) == pair

    @pytest.mark.anyio
    async def test_the_origin_is_read_from_the_cleaned_track(self) -> None:
        # The origin comes off the first waypoint, so a spike at the start
        # would name an airport thousands of kilometres from the departure.
        provider = StubProvider(
            (
                point(0.0, 0.0, offset=0),
                point(*SYDNEY_TRACK_START, offset=6),
                point(SYDNEY_TRACK_START[0] + 0.01, SYDNEY_TRACK_START[1] + 0.01, 300.0, 12),
            )
        )
        enriched = await FlightHistory(provider).enrich(detail_with(heading=90.0))
        assert enriched.origin is not None and enriched.origin.icao == "YSSY"
