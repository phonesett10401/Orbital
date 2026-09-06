"""What a tier buys (D149).

Phases 1-3 built accounts that worked and did nothing: you could register, sign
in, and be told you were on the free tier, and every feature behaved the same
either way. This is the first place ``tier`` changes an answer.

## The first gate is the time-travel window

Chosen because it is the one capability Orbital has that is genuinely
**expensive to want and cheap to serve**. A satellite position is computed, so
an instant a week out costs the same arithmetic as the present one - which is
exactly why it makes an honest paid feature rather than an artificial
restriction on something that was free to give. Nothing is being throttled here
that we could afford to hand out; what is being sold is the *reach* of a
capability, and the free tier keeps a full day of it either way, which is more
than enough to answer "when does this pass over me tonight".

## Two bounds of different kinds, and they must not be confused

- ``ACCURACY_WINDOW`` - seven days - is **physics**. SGP4 drifts roughly a
  kilometre a day from an element set's epoch, so past a week the answer stops
  being one. No tier can buy past it, and no tier ever will.
- The tier windows are **policy**. They are a commercial decision and can
  change with a pricing page.

Keeping them apart in the code matters more than it looks. The moment a
physical limit is spelled the same way as a purchasable one, somebody
eventually raises the premium window to thirty days because the constant was
right there, and Orbital starts serving confident nonsense. So every tier
window is passed through ``min`` against the accuracy bound, and the premium
window is *already* the accuracy bound: **premium buys all the reach that
exists, not a larger slice of a bigger one.**

That is also the honest thing to be able to say on a pricing page. There is no
hidden tier above this one, because there is nothing left to sell.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from app.accounts.store import TIER_PREMIUM

#: Past this, propagated positions are not answers. Physics, not pricing.
ACCURACY_WINDOW = timedelta(days=7)

#: How far either way each tier may ask. Signed out is read as free.
FREE_WINDOW = timedelta(hours=24)
PREMIUM_WINDOW = ACCURACY_WINDOW

#: Slack on the server's side of the comparison.
#:
#: The client clamps to exactly ``now ± window``, and then the request spends a
#: moment in flight, so by the time the server reads its own clock a perfectly
#: legitimate edge request is a few seconds outside. Without this the slider's
#: own end stop would intermittently 403 - a failure that appears only at the
#: extreme, only sometimes, and only for real users, because a test computes
#: both instants from the same frozen clock.
GRACE = timedelta(minutes=5)


def travel_window(tier: str | None) -> timedelta:
    """How far either way this tier may move the sky.

    ``None`` - nobody signed in - is the free window rather than an error. The
    free tier is the product, not a degraded state, and a reader who has never
    made an account gets exactly what a free account gets.
    """
    window = PREMIUM_WINDOW if tier == TIER_PREMIUM else FREE_WINDOW
    return min(window, ACCURACY_WINDOW)


def within_travel_window(at: datetime, now: datetime, tier: str | None) -> bool:
    """Whether this tier may be shown that instant."""
    return abs(at - now) <= travel_window(tier) + GRACE


def describe_window(window: timedelta) -> str:
    """The window in the unit a reader thinks in."""
    hours = window.total_seconds() / 3600
    if hours < 48:
        value = round(hours)
        return f"{value} hour" if value == 1 else f"{value} hours"
    value = round(hours / 24)
    return f"{value} day" if value == 1 else f"{value} days"


def travel_refusal(tier: str | None) -> str:
    """Why that instant was refused, and what would lift it.

    Names the limit and the tier that raises it. A refusal that says only "not
    allowed" leaves the reader unable to tell a restriction from a bug, and
    this one is a restriction we chose and should be willing to state.
    """
    allowed = describe_window(travel_window(tier))
    if tier == TIER_PREMIUM:
        return (
            f"positions can only be computed within {allowed} of now; "
            "past that the elements are no longer accurate"
        )
    return (
        f"a free account can move the sky {allowed} either way; "
        f"a premium account can move it {describe_window(PREMIUM_WINDOW)}"
    )
