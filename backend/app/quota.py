"""OpenSky credit accounting.

The single most important constraint on this project. `/states/all` is billed
by the **geographic area requested**, in square degrees, under a banded
schedule -- not per request. Getting this wrong takes the live demo offline for
a day with no way to buy the credits back.

The full arithmetic and the reasoning behind the chosen intervals are in
docs/decisions.md, D21. This module makes that arithmetic executable so a test
can assert the configured preset fits the budget, rather than someone
recalculating it by hand every time an interval changes.

If OpenSky changes the band boundaries, `COST_BANDS` is the only thing to edit.
"""

from __future__ import annotations

from enum import Enum

from app.models import BBox

#: (inclusive upper bound in square degrees, credits). Ordered, last is the
#: catch-all covering "over 400 sq deg, including the whole globe".
COST_BANDS: tuple[tuple[float, int], ...] = (
    (25.0, 1),
    (100.0, 2),
    (400.0, 3),
    (float("inf"), 4),
)

#: Area of the entire globe in square degrees (360 lon x 180 lat).
GLOBE_AREA_SQ_DEG = 360.0 * 180.0

#: Published daily allowances, verified 2026-08-25.
ANONYMOUS_DAILY_CREDITS = 400
AUTHENTICATED_DAILY_CREDITS = 4000
CONTRIBUTOR_DAILY_CREDITS = 8000

SECONDS_PER_DAY = 86_400


def area_sq_deg(bbox: BBox | None) -> float:
    """Area of a bounding box in square degrees.

    ``None`` means an unbounded request -- the whole globe.
    """
    if bbox is None:
        return GLOBE_AREA_SQ_DEG
    return bbox.width_deg * bbox.height_deg


def credits_for_area(area: float) -> int:
    """Credits charged for a request covering ``area`` square degrees."""
    for upper, cost in COST_BANDS:
        if area <= upper:
            return cost
    # Unreachable while the last band is infinite, but a wrong band table
    # should fail loudly rather than silently undercharging.
    raise ValueError(f"no cost band covers {area} square degrees")


def credits_for_bbox(bbox: BBox | None) -> int:
    return credits_for_area(area_sq_deg(bbox))


def daily_credits(interval_seconds: float, cost_per_call: int) -> float:
    """Projected credits per day for one job polling at a fixed interval."""
    if interval_seconds <= 0:
        raise ValueError("interval must be positive")
    return SECONDS_PER_DAY / interval_seconds * cost_per_call


def min_interval_for_budget(cost_per_call: int, budget: float) -> float:
    """Shortest interval whose daily cost stays within ``budget``.

    The inverse of :func:`daily_credits`, useful when choosing an interval for
    a new region rather than checking one that was guessed.
    """
    if budget <= 0:
        raise ValueError("budget must be positive")
    return SECONDS_PER_DAY * cost_per_call / budget


class ThrottleLevel(str, Enum):
    """How aggressively the poller should slow down.

    Driven by the observed ``X-Rate-Limit-Remaining`` header rather than by our
    own projection, because restarts, a teammate running a second backend, and
    manual testing all spend from the same pool without the poller knowing.
    See D23.
    """

    NORMAL = "normal"
    REDUCED = "reduced"
    MINIMAL = "minimal"
    CRITICAL = "critical"
    EXHAUSTED = "exhausted"

    @property
    def interval_multiplier(self) -> float:
        return _THROTTLE_MULTIPLIERS[self]

    @property
    def allows_focus_tier(self) -> bool:
        """Whether the latency tier (tier 2) may still poll.

        Tier 2 is the first thing cut: tier 1 keeps the globe populated, so
        losing tier 2 degrades freshness in one region rather than emptying
        the display.
        """
        return self in (ThrottleLevel.NORMAL, ThrottleLevel.REDUCED)

    @property
    def allows_polling(self) -> bool:
        return self is not ThrottleLevel.EXHAUSTED


_THROTTLE_MULTIPLIERS: dict[ThrottleLevel, float] = {
    ThrottleLevel.NORMAL: 1.0,
    ThrottleLevel.REDUCED: 2.0,
    ThrottleLevel.MINIMAL: 4.0,
    ThrottleLevel.CRITICAL: 8.0,
    ThrottleLevel.EXHAUSTED: float("inf"),
}

#: Fraction of the daily allowance remaining -> throttle level. Ordered from
#: most remaining to least; the first threshold the balance is at or above wins.
#:
#: Simplification accepted (D23): these are fractions of the daily allowance
#: rather than a burn rate measured against the quota reset time, whose
#: semantics are not documented clearly enough to model reliably. A fraction
#: ladder fails safe in the same direction.
THROTTLE_THRESHOLDS: tuple[tuple[float, ThrottleLevel], ...] = (
    (0.40, ThrottleLevel.NORMAL),
    (0.20, ThrottleLevel.REDUCED),
    (0.10, ThrottleLevel.MINIMAL),
    (0.01, ThrottleLevel.CRITICAL),
    (0.00, ThrottleLevel.EXHAUSTED),
)


def throttle_for(remaining: int | None, daily_allowance: int) -> ThrottleLevel:
    """Choose a throttle level from the observed remaining balance.

    ``remaining`` of ``None`` means upstream did not tell us -- typically
    because we have not polled yet. We assume normal rather than degrading, on
    the grounds that the projected budget (D21) already fits, and refusing to
    poll because we lack information would never recover.
    """
    if remaining is None:
        return ThrottleLevel.NORMAL
    if daily_allowance <= 0:
        raise ValueError("daily_allowance must be positive")
    if remaining <= 0:
        return ThrottleLevel.EXHAUSTED

    fraction = remaining / daily_allowance
    for threshold, level in THROTTLE_THRESHOLDS:
        if fraction >= threshold:
            return level
    return ThrottleLevel.EXHAUSTED
