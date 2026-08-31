"""Tests for credit accounting and the configured polling budget.

The arithmetic these assert is the most important constraint on the project:
overspending takes the live demo offline for a day with no way to buy the
credits back. Making it executable means an interval change that breaks the
budget fails a test rather than being discovered the following afternoon.

See docs/decisions.md, D21.
"""

from __future__ import annotations

import pytest

from app.config import DAILY_ALLOWANCES, PRESETS, Settings
from app.models import BBox
from app.quota import (
    AUTHENTICATED_DAILY_CREDITS,
    GLOBE_AREA_SQ_DEG,
    ThrottleLevel,
    credits_for_area,
    credits_for_bbox,
    daily_credits,
    min_interval_for_budget,
    throttle_for,
)


class TestCostBands:
    @pytest.mark.parametrize(
        ("area", "expected"),
        [
            (1.0, 1), (25.0, 1),          # top of the 1-credit band
            (25.1, 2), (100.0, 2),
            (100.1, 3), (400.0, 3),
            (400.1, 4), (GLOBE_AREA_SQ_DEG, 4),
        ],
    )
    def test_bands_charge_by_requested_area(self, area, expected):
        assert credits_for_area(area) == expected

    def test_a_bbox_of_none_is_billed_as_the_whole_globe(self):
        assert credits_for_bbox(None) == 4

    def test_a_five_by_five_box_costs_one_credit(self):
        assert credits_for_bbox(BBox.parse("40,-75,45,-70")) == 1

    def test_area_is_computed_correctly_across_the_antimeridian(self):
        # 20 x 20 = 400 sq deg, the top of the 3-credit band. Computing the
        # width naively would give -340 and bill it as 1 credit.
        assert credits_for_bbox(BBox.parse("50,170,70,-170")) == 3


class TestAreaEfficiency:
    """The finding that reversed the polling design (D21)."""

    def test_the_globe_buys_far_more_area_per_credit_than_any_box(self):
        globe = GLOBE_AREA_SQ_DEG / credits_for_area(GLOBE_AREA_SQ_DEG)
        small_box = 25.0 / credits_for_area(25.0)
        assert globe / small_box > 300  # 324x, in fact

    def test_replacing_the_global_sweep_with_regions_costs_more_for_less(self):
        # Six 10x10 regions at 300 s versus one global sweep at 300 s.
        regions = 6 * daily_credits(300.0, credits_for_area(100.0))
        globe = daily_credits(300.0, credits_for_area(GLOBE_AREA_SQ_DEG))
        assert regions > globe                      # three times the cost
        assert 6 * 100.0 < GLOBE_AREA_SQ_DEG / 100  # for under 1% of the area


class TestDailyProjection:
    def test_a_sixty_second_global_poll_busts_the_authenticated_budget(self):
        # The assumption D7 was built on, now dead.
        projected = daily_credits(60.0, credits_for_bbox(None))
        assert projected == 5760
        assert projected > AUTHENTICATED_DAILY_CREDITS

    def test_the_recommended_pair_fits_with_headroom(self):
        tier1 = daily_credits(300.0, 4)   # globe every 5 minutes
        tier2 = daily_credits(90.0, 2)    # 10x10 viewport every 90 seconds
        assert tier1 + tier2 == 3072
        assert tier1 + tier2 < AUTHENTICATED_DAILY_CREDITS

    def test_trading_viewport_area_against_rate_costs_the_same(self):
        # Why the viewport tier polls a 100 sq deg box every 90 s rather than a
        # 25 sq deg box every 45 s: identical daily cost, four times the area
        # (D36).
        small_and_fast = daily_credits(45.0, credits_for_area(25.0))
        large_and_slow = daily_credits(90.0, credits_for_area(100.0))
        assert small_and_fast == large_and_slow

    def test_min_interval_inverts_the_projection(self):
        interval = min_interval_for_budget(4, AUTHENTICATED_DAILY_CREDITS)
        assert daily_credits(interval, 4) == pytest.approx(AUTHENTICATED_DAILY_CREDITS)

    def test_zero_interval_is_rejected(self):
        with pytest.raises(ValueError):
            daily_credits(0.0, 4)


class TestConfiguredPresetsFitTheirBudget:
    """The executable form of D21. If an interval changes, this fails."""

    @pytest.mark.parametrize("preset", sorted(PRESETS))
    def test_preset_stays_within_its_safety_ceiling(self, preset):
        # The `union` preset is the one preset that is affordable only with the
        # provider it was written for: its intervals are five times faster than
        # the credit ladder allows, and it fits because adsb.lol answers every
        # poll for nothing while OpenSky answers once every five minutes (D83).
        provider = "union" if preset == "union" else "opensky"
        settings = Settings(quota_preset=preset, provider=provider)
        ceiling = settings.daily_allowance * settings.budget_safety_fraction
        assert settings.projected_daily_credits() <= ceiling

    def test_the_fast_preset_is_refused_on_a_metered_provider(self):
        # And the guard says so rather than letting it through: on OpenSky
        # alone those intervals project 11,520 credits against an allowance of
        # 4,000, which would be spent by mid-morning.
        with pytest.raises(ValueError, match="credits/day"):
            Settings(quota_preset="union", provider="opensky")

    def test_the_union_preset_costs_less_than_the_one_it_replaces(self):
        # Five times the refresh rate for a third of the credits, because the
        # fast half of the union is free (D83).
        union = Settings(quota_preset="union", provider="union")
        authenticated = Settings(quota_preset="authenticated", provider="opensky")
        # 2,880: one global OpenSky call every 120 s, which is the freeze
        # threshold (D71, defect #30). Still under the 3,072 the OpenSky-only
        # preset spent for a fifth of the refresh rate.
        assert union.projected_daily_credits() == 2880
        assert union.projected_daily_credits() < authenticated.projected_daily_credits()

    @pytest.mark.parametrize("preset", sorted(PRESETS))
    def test_every_preset_names_its_own_allowance(self, preset):
        # daily_allowance falls back to the authenticated 4,000 for a preset it
        # does not recognise, so a preset missing from DAILY_ALLOWANCES is
        # budgeted against a number nobody chose for it - and the ceiling check
        # above still passes, because 4,000 happens to be generous. 'union' sat
        # in exactly that position. This asserts the table, not the fallback.
        assert preset in DAILY_ALLOWANCES

    def test_the_union_preset_is_budgeted_as_an_authenticated_account(self):
        # Not a fourth account tier: the same OpenSky account, called rarely.
        assert Settings(quota_preset="union", provider="union").daily_allowance == 4000

    def test_authenticated_preset_projects_the_documented_figure(self):
        assert Settings(quota_preset="authenticated").projected_daily_credits() == 3072

    def test_startup_fails_when_an_interval_overspends(self):
        with pytest.raises(ValueError, match="credits/day"):
            Settings(quota_preset="authenticated", daily_credit_budget=1000)

    def test_unknown_preset_fails_loudly(self):
        with pytest.raises(ValueError, match="unknown quota preset"):
            Settings(quota_preset="generous")

    def test_objects_outlive_a_missed_poll_but_not_a_lost_aircraft(self):
        # The rule this encodes is "one missed poll must not empty the map,
        # and an aircraft nobody has reported for minutes must not stay on it".
        # It was written as 4x the longest interval when that interval was
        # 60 s, which made 4x free. The union sweep is 120 s now, measured
        # against adsb.lol's real rate limit (19.43), and 4x would mean an
        # 480 s TTL - back toward the 1800 s that made 39% of everything served
        # a ghost past the client's two-minute fade (D86).
        #
        # So the multiplier is 2x, which is the rule itself rather than the
        # comfortable margin it used to have: at 300 s against a 120 s sweep an
        # aircraft survives a missed poll with a minute to spare and is dropped
        # after two. Tightening the TTL and lengthening the poll both make this
        # fail, which is what it is for.
        settings = Settings(quota_preset="union", provider="union")
        longest = max(job.interval_seconds for job in settings.jobs)
        assert settings.object_ttl_seconds >= 2 * longest
        assert settings.object_ttl_seconds <= 600

    def test_ttl_must_exceed_the_longest_interval(self):
        # Otherwise every response is stale the moment it is served.
        with pytest.raises(ValueError, match="stale by construction"):
            Settings(quota_preset="authenticated", snapshot_ttl_seconds=10.0)

    def test_derived_ttl_outlives_the_slowest_preset(self):
        settings = Settings(quota_preset="anonymous")
        assert settings.snapshot_ttl > settings.longest_interval


class TestThrottle:
    @pytest.mark.parametrize(
        ("remaining", "expected"),
        [
            (4000, ThrottleLevel.NORMAL),
            (1600, ThrottleLevel.NORMAL),     # exactly 40%
            (1200, ThrottleLevel.REDUCED),
            (800, ThrottleLevel.REDUCED),     # exactly 20%
            (600, ThrottleLevel.MINIMAL),
            (400, ThrottleLevel.MINIMAL),     # exactly 10%
            (200, ThrottleLevel.CRITICAL),
            (40, ThrottleLevel.CRITICAL),     # exactly 1%
            (10, ThrottleLevel.EXHAUSTED),
            (0, ThrottleLevel.EXHAUSTED),
        ],
    )
    def test_level_falls_as_the_balance_drains(self, remaining, expected):
        assert throttle_for(remaining, AUTHENTICATED_DAILY_CREDITS) == expected

    def test_unknown_balance_assumes_normal(self):
        # We have not polled yet. Refusing to poll for lack of information
        # would never recover, and the projected budget already fits.
        assert throttle_for(None, AUTHENTICATED_DAILY_CREDITS) == ThrottleLevel.NORMAL

    def test_negative_balance_is_treated_as_exhausted(self):
        assert throttle_for(-5, AUTHENTICATED_DAILY_CREDITS) == ThrottleLevel.EXHAUSTED

    def test_intervals_lengthen_as_the_level_falls(self):
        levels = [
            ThrottleLevel.NORMAL,
            ThrottleLevel.REDUCED,
            ThrottleLevel.MINIMAL,
            ThrottleLevel.CRITICAL,
        ]
        multipliers = [level.interval_multiplier for level in levels]
        assert multipliers == sorted(multipliers)
        assert multipliers[0] == 1.0

    def test_the_latency_tier_is_cut_before_the_coverage_tier(self):
        # Losing tier 2 degrades freshness in one region; losing tier 1 empties
        # the globe. So tier 2 goes first.
        assert ThrottleLevel.REDUCED.allows_focus_tier
        assert not ThrottleLevel.MINIMAL.allows_focus_tier
        assert ThrottleLevel.MINIMAL.allows_polling
        assert not ThrottleLevel.EXHAUSTED.allows_polling
