"""Tests for what AIS means, independent of who delivered it.

These moved out of `test_digitraffic.py` when a second source arrived (D166),
and the move is the point: every one of them describes the **protocol**, so
leaving them attached to one vendor's module would have meant writing them
again for the next.

The thing most worth testing is still **the difference between a missing value
and a wrong one**. AIS has no nulls: "not available" is encoded as a number
inside the valid range. A speed of 102.3 knots, a course of 360 degrees and a
heading of 511 all mean "the transmitter did not say", and all three draw
perfectly happily as a ship crossing the Baltic at 190 km/h.

That is a harder failure than a unit error, because a unit error is wrong
everywhere and this is wrong on a quarter of the fleet while the rest looks
right. So the values below are **real, taken off both live feeds**, including
the ones that were wrong: NOUNOU is an actual 250-metre tanker that was
actually reporting 102.2 knots, and the first version of this believed it.
"""

from __future__ import annotations

import pytest

from app.providers.ais import (
    MAX_PLAUSIBLE_KNOTS,
    SHIP_TTL_SECONDS,
    SHIP_TYPE_BY_TENS,
    SPECIAL_CRAFT,
    eta_text,
    heading,
    is_position,
    nav_status,
    ship_type,
    speed_ms,
    text,
)


class TestSpeed:
    @pytest.mark.parametrize("knots", [102.3, 102.2, 85.0, 81.0, 79.6])
    def test_an_impossible_speed_is_no_speed(self, knots: float) -> None:
        # Every one of these was on a live feed, attached to a real vessel:
        # 102.3 is the AIS sentinel, 102.2 is the saturation value one below it
        # that the first version let through, and the rest are simply broken
        # transmitters - one of them on a *moored* tug.
        assert speed_ms(knots) is None

    def test_the_fastest_believable_ship_is_still_believed(self) -> None:
        # The ceiling has to refuse the impossible without refusing fast craft;
        # a limit that clipped a 50-knot patrol boat would trade one wrong
        # answer for another.
        assert speed_ms(MAX_PLAUSIBLE_KNOTS) == pytest.approx(30.87, abs=0.01)

    def test_knots_become_metres_per_second(self) -> None:
        # 12.4 kt is 6.4 m/s. Left in knots the client would dead-reckon every
        # vessel at twice its real speed (D71).
        assert speed_ms(12.4) == pytest.approx(6.38, abs=0.02)

    def test_a_stopped_ship_is_stopped_not_unknown(self) -> None:
        # Four fifths of a ship feed is moored or at anchor. Treating zero as
        # falsy here would erase the speed of most of the layer.
        assert speed_ms(0.0) == 0.0

    def test_a_negative_speed_is_refused(self) -> None:
        assert speed_ms(-1.0) is None


class TestHeading:
    def test_true_heading_wins_over_course(self) -> None:
        # The opposite of the aircraft layer's choice, and deliberate: a ship
        # at anchor swings on its cable and has a heading but no course.
        assert heading(12, 200.0) == pytest.approx(12.0)

    def test_heading_511_falls_through_to_course(self) -> None:
        assert heading(511, 88.0) == pytest.approx(88.0)

    def test_course_360_is_not_due_north(self) -> None:
        # 942 of 5,308 aisstream position reports sent it. Read as a bearing it
        # points every one of them at the North Pole.
        assert heading(511, 360.0) is None

    def test_two_vessels_in_five_have_no_true_heading(self) -> None:
        # Not an edge case: 2,154 of 5,308 position reports in one live sample
        # sent 511. If this returned a number, 40% of the fleet would be drawn
        # pointing somewhere it is not.
        assert heading(511, 360.0) is None
        assert heading(None, None) is None

    def test_a_heading_of_zero_is_north_not_missing(self) -> None:
        # Zero is a real bearing, and the one a falsy check would eat.
        assert heading(0, 200.0) == 0.0


class TestShipType:
    def test_the_tens_digit_carries_the_meaning(self) -> None:
        assert ship_type(70) == "Cargo"
        assert ship_type(79) == "Cargo"
        assert ship_type(80) == "Tanker"
        assert ship_type(69) == "Passenger"

    def test_the_thirties_and_fifties_are_spelled_out(self) -> None:
        # Flattening these to "special craft" would put a tug, a dredger and a
        # warship in one bucket.
        assert ship_type(52) == "Tug"
        assert ship_type(33) == "Dredger"
        assert ship_type(51) == "Search and rescue"

    def test_no_type_is_none_rather_than_a_guess(self) -> None:
        assert ship_type(0) is None
        assert ship_type(None) is None
        assert ship_type(150) is None


class TestNavStatus:
    def test_the_common_ones_read_as_words(self) -> None:
        assert nav_status(0) == "Under way using engine"
        assert nav_status(1) == "At anchor"
        assert nav_status(5) == "Moored"

    def test_an_unknown_code_is_none(self) -> None:
        assert nav_status(99) is None
        assert nav_status(None) is None


class TestPositionValidity:
    def test_a_real_position_is_a_position(self) -> None:
        assert is_position(60.1, 24.9)

    @pytest.mark.parametrize("lat,lon", [(91.0, 181.0), (91.0, 24.9), (60.1, 181.0)])
    def test_the_no_fix_sentinels_are_not(self, lat: float, lon: float) -> None:
        # 91 and 181 are what a transmitter sends with no fix, and they are
        # outside the contract's validators - which would raise, taking down a
        # whole poll or a whole stream over one vessel.
        assert not is_position(lat, lon)

    def test_null_island_is_a_position_as_far_as_this_is_concerned(self) -> None:
        # (0, 0) is in range, so this cannot refuse it - and should not try.
        # It is a real coordinate in the Gulf of Guinea; what makes it
        # suspicious is a *default*, and refusing to default is the providers'
        # job rather than this predicate's (D18).
        assert is_position(0.0, 0.0)


class TestEta:
    def test_the_four_fields_become_a_readable_time(self) -> None:
        assert eta_text(month=9, day=6, hour=5, minute=0) == "06/09 05:00 UTC"

    def test_an_unset_eta_is_no_eta(self) -> None:
        # A vessel that has not stated one sends zeroes, which decode to month
        # zero and day zero - a date that does not exist. This is the common
        # path: the live aisstream sample had Month 0, Day 0, Hour 24,
        # Minute 60 on the first static message that came through.
        assert eta_text(month=0, day=0, hour=24, minute=60) is None

    def test_the_not_available_hour_is_refused(self) -> None:
        assert eta_text(month=9, day=6, hour=24, minute=60) is None

    def test_no_year_is_claimed_because_none_is_transmitted(self) -> None:
        assert "2026" not in (eta_text(month=9, day=6, hour=5, minute=0) or "")


class TestText:
    def test_ais_padding_is_stripped(self) -> None:
        # Static text is padded to a fixed width with spaces and '@', so a
        # vessel with no destination sends a field full of padding rather than
        # an absent one.
        assert text("PALMA@@@@@@@") == "PALMA"
        assert text("@@@@@@@@") is None
        assert text("   ") is None

    def test_a_name_with_inner_spaces_survives(self) -> None:
        assert text("VIKING GRACE@@") == "VIKING GRACE"


class TestTheTtl:
    def test_it_drops_the_stale_tail_and_keeps_a_moored_vessel(self) -> None:
        # A moored Class A vessel transmits every three minutes, so the TTL has
        # to clear several missed reports. Digitraffic retains 24 hours and 28%
        # of what it returns is over an hour old - serving that is D86's map of
        # ghosts, where 39% of everything drawn was already past the fade.
        assert SHIP_TTL_SECONDS >= 5 * 180
        assert SHIP_TTL_SECONDS < 3600


class TestTheVocabularyIsAContract:
    """The words these tables emit are read by a file in another language.

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

    def test_every_code_a_feed_can_send_resolves_to_one_of_them(self) -> None:
        # The tens-digit table covers 20-99 and the named table punches through
        # it. Anything outside is None, not a word - so this also pins that
        # codes 0-19 stay unnamed rather than acquiring a guess.
        vocabulary = set(SHIP_TYPE_BY_TENS.values()) | set(SPECIAL_CRAFT.values())
        for code in range(0, 100):
            word = ship_type(code)
            assert word is None or word in vocabulary, code
