"""What a tier buys (D149).

Pure arithmetic over two timedeltas, which is exactly why it is worth its own
file: this is the module that decides whether somebody gets what they paid for,
and it should be readable without a database, a session or an HTTP client
anywhere near it.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.accounts.entitlements import (
    ACCURACY_WINDOW,
    FREE_WINDOW,
    GRACE,
    PREMIUM_WINDOW,
    describe_window,
    travel_refusal,
    travel_window,
    within_travel_window,
)
from app.accounts.store import TIER_ADMIN, TIER_FREE, TIER_PREMIUM

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=timezone.utc)


class TestTheWindows:
    def test_premium_reaches_further_than_free(self) -> None:
        assert travel_window(TIER_PREMIUM) > travel_window(TIER_FREE)

    def test_signed_out_gets_exactly_the_free_window(self) -> None:
        # Not an error and not zero. The free tier is the product, so somebody
        # who has never made an account is not in a degraded state.
        assert travel_window(None) == travel_window(TIER_FREE) == FREE_WINDOW

    def test_an_administrator_is_not_given_less_than_a_paying_customer(self) -> None:
        # The failure this guards is silent: a gate written `tier == "premium"`
        # leaves an admin account working perfectly and simply short of what it
        # should have, with nothing anywhere reporting a fault.
        assert travel_window(TIER_ADMIN) == travel_window(TIER_PREMIUM)

    def test_an_unknown_tier_is_treated_as_free(self) -> None:
        # A tier added to the database by hand, or one this deployment has not
        # been taught about, must not fall through to the largest window.
        assert travel_window("enterprise-trial") == FREE_WINDOW

    def test_no_tier_can_buy_past_the_accuracy_bound(self) -> None:
        # The property the module exists to keep. Past seven days SGP4 is not
        # answering the question any more, so a purchasable window that
        # exceeded it would be selling confident nonsense.
        for tier in [None, TIER_FREE, TIER_PREMIUM, TIER_ADMIN, "whatever-comes-next"]:
            assert travel_window(tier) <= ACCURACY_WINDOW, tier

    def test_premium_is_the_whole_of_the_reach_that_exists(self) -> None:
        # Deliberate, and worth failing loudly if someone changes it: there is
        # no tier above premium for this feature, because there is nothing left
        # to sell.
        assert PREMIUM_WINDOW == ACCURACY_WINDOW


class TestWhoMaySeeWhat:
    def test_free_may_ask_within_its_day(self) -> None:
        assert within_travel_window(NOW - timedelta(hours=20), NOW, TIER_FREE)
        assert within_travel_window(NOW + timedelta(hours=20), NOW, TIER_FREE)

    def test_free_may_not_ask_three_days_back(self) -> None:
        assert not within_travel_window(NOW - timedelta(days=3), NOW, TIER_FREE)

    def test_premium_may(self) -> None:
        assert within_travel_window(NOW - timedelta(days=3), NOW, TIER_PREMIUM)
        assert within_travel_window(NOW + timedelta(days=6), NOW, TIER_PREMIUM)

    def test_the_window_reaches_both_ways_equally(self) -> None:
        # A past instant and a future one cost the same arithmetic and carry
        # the same error, so an asymmetric window would be arbitrary.
        for tier in [TIER_FREE, TIER_PREMIUM]:
            back = within_travel_window(NOW - travel_window(tier), NOW, tier)
            ahead = within_travel_window(NOW + travel_window(tier), NOW, tier)
            assert back is ahead is True, tier

    def test_neither_tier_may_ask_past_seven_days(self) -> None:
        for tier in [None, TIER_FREE, TIER_PREMIUM]:
            assert not within_travel_window(NOW + timedelta(days=8), NOW, tier), tier

    def test_a_request_that_spent_a_moment_in_flight_still_lands(self) -> None:
        # The failure this prevents appears only at the slider's end stop, only
        # sometimes, and only for real users: the client clamps to exactly
        # `now ± window` and the server reads its clock a moment later, so the
        # edge is a few seconds outside by the time it is measured.
        edge = NOW + FREE_WINDOW
        later = NOW + timedelta(seconds=30)
        assert within_travel_window(edge, later, TIER_FREE)

    def test_the_grace_is_not_a_second_window(self) -> None:
        # It absorbs flight time, not another hour of travel.
        assert GRACE < timedelta(hours=1)
        assert not within_travel_window(NOW + FREE_WINDOW + timedelta(hours=1), NOW, TIER_FREE)


class TestWhatTheReaderIsTold:
    def test_a_free_refusal_names_the_limit_and_what_lifts_it(self) -> None:
        # A refusal that says only "not allowed" leaves a reader unable to tell
        # a price from a bug.
        message = travel_refusal(TIER_FREE)
        assert "24 hours" in message
        assert "premium" in message.lower()
        assert "7 days" in message

    def test_a_paid_refusal_blames_physics_rather_than_offering_an_upsell(
        self,
    ) -> None:
        # There is nothing above premium here, so a refusal that hinted at one
        # would be a lie told for money. An admin must not be sold to either.
        for tier in [TIER_PREMIUM, TIER_ADMIN]:
            message = travel_refusal(tier)
            assert "premium" not in message.lower(), tier
            assert "accurate" in message, tier

    @pytest.mark.parametrize(
        "window,expected",
        [
            (timedelta(hours=1), "1 hour"),
            (timedelta(hours=24), "24 hours"),
            (timedelta(days=1), "24 hours"),
            (timedelta(days=7), "7 days"),
            (timedelta(days=2), "2 days"),
        ],
    )
    def test_windows_are_written_in_the_unit_a_reader_thinks_in(
        self, window: timedelta, expected: str
    ) -> None:
        assert describe_window(window) == expected
