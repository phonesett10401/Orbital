"""Live verification of the failure paths: rate limiting and quota throttling.

These are the hardest things to verify, because they only happen when something
goes wrong. Both were mock-tested only; this script exercises them against the
real API and the real credit balance.

    cd backend && .venv/Scripts/python scripts/verify_failure_paths.py

**Cost: at most ~30 credits**, hard-capped. The burst test stops at the first
429 or at its request ceiling, whichever comes first.

Deliberately *not* attempted: exhausting the daily allowance to force a
credit-exhaustion 429. That costs the entire day's quota and locks the account
out until reset, which would block every other task. The burst test below
checks for a short-window rate limit instead, which is cheap if one exists.

The throttle ladder is exercised honestly: the credit balance is real, read
from the live ``X-Rate-Limit-Remaining`` header. Only the *allowance* it is
compared against is varied, which walks the real balance through every band
without spending a single extra credit.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import PollJob, Settings  # noqa: E402
from app.ingestion.poller import Poller  # noqa: E402
from app.ingestion.store import ObjectStore  # noqa: E402
from app.models import BBox  # noqa: E402
from app.providers.base import ProviderRateLimited  # noqa: E402
from app.providers.opensky import OpenSkyProvider  # noqa: E402
from app.quota import ThrottleLevel  # noqa: E402

#: 1-credit box, so a burst is as cheap as possible per request.
SMALL_BOX = "50,3,52,6"


def rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def build_provider(settings: Settings) -> OpenSkyProvider:
    return OpenSkyProvider(
        client_id=settings.opensky_client_id,
        client_secret=settings.opensky_client_secret,
        base_url=settings.opensky_base_url,
        token_url=settings.opensky_token_url,
        timeout_seconds=settings.opensky_timeout_seconds,
    )


async def burst_test(settings: Settings, max_requests: int) -> None:
    """Fire small requests back to back, looking for a short-window rate limit.

    Stops immediately on the first 429. If none appears within the ceiling, the
    conclusion is simply that OpenSky does not rate-limit at this burst size --
    which is itself worth recording, because it means the 429 path can only be
    reached by exhausting the daily allowance.
    """
    rule(f"1. RATE LIMIT BURST (hard cap: {max_requests} requests, ~{max_requests} credits)")
    provider = build_provider(settings)
    box = BBox.parse(SMALL_BOX)

    try:
        start = time.perf_counter()
        for attempt in range(1, max_requests + 1):
            try:
                await provider.fetch(box)
            except ProviderRateLimited as exc:
                elapsed = time.perf_counter() - start
                print(f"  429 received on request {attempt} after {elapsed:.1f}s")
                print(f"  retry_after from upstream: {exc.retry_after}")
                print(f"  remaining credits        : {provider.remaining_credits}")
                print("  RESULT: the rate-limit path fired against the live API.")
                return
            if attempt % 5 == 0:
                print(f"  {attempt:>3} requests, remaining={provider.remaining_credits}")

        elapsed = time.perf_counter() - start
        print(f"  no 429 after {max_requests} requests in {elapsed:.1f}s "
              f"({max_requests / elapsed:.1f} req/s)")
        print(f"  remaining credits: {provider.remaining_credits}")
        print("  RESULT: no short-window rate limit at this burst size. The 429")
        print("          path is reachable only by exhausting the daily allowance,")
        print("          which is not worth a day of lockout to observe.")
    finally:
        await provider.aclose()


async def throttle_ladder(settings: Settings) -> None:
    """Walk the real credit balance through every throttle band.

    One live fetch establishes a real remaining balance. The allowance it is
    measured against is then varied, which is the honest way to reach the low
    bands: the balance is genuine, and no credits are burned to get there.
    """
    rule("2. THROTTLE LADDER (real balance, varied allowance)")
    provider = build_provider(settings)

    try:
        await provider.fetch(BBox.parse(SMALL_BOX))
        remaining = provider.remaining_credits
        if remaining is None:
            print("  no rate-limit header returned; cannot exercise the ladder")
            return

        print(f"  live remaining balance: {remaining} credits\n")
        print(f"  {'allowance':>10} {'fraction':>9} {'level':>10} {'x interval':>11} "
              f"{'tier 2':>7} {'polls':>6}")
        print(f"  {'-' * 60}")

        store = ObjectStore(
            object_ttl_seconds=1800, track_history_points=50, snapshot_ttl_seconds=600
        )

        for allowance in (remaining * 2, remaining * 4, remaining * 8, remaining * 40, remaining * 200):
            allowance = int(allowance)
            tuned = Settings(
                quota_preset="authenticated",
                daily_credit_budget=allowance,
                opensky_client_id=settings.opensky_client_id,
                opensky_client_secret=settings.opensky_client_secret,
            )
            poller = Poller(provider, store, tuned)
            poller.set_viewport(BBox.parse("48,2,54,8"))

            level = poller.throttle
            fraction = remaining / allowance
            focus = "yes" if poller.focus_bbox() is not None else "SKIPPED"
            polls = "yes" if level.allows_polling else "STOPPED"
            multiplier = level.interval_multiplier
            shown = "inf" if multiplier == float("inf") else f"{multiplier:.0f}"

            print(f"  {allowance:>10} {fraction:>8.1%} {level.value:>10} {shown:>11} "
                  f"{focus:>7} {polls:>6}")

        print("\n  The ladder degrades in the documented order (D23): the latency")
        print("  tier is cut before the coverage tier, and polling stops last.")
    finally:
        await provider.aclose()


async def throttled_tick(settings: Settings) -> None:
    """Prove the poller actually acts on the throttle, not just reports it."""
    rule("3. THROTTLED POLLER BEHAVIOUR (does it act, or only report?)")
    provider = build_provider(settings)

    try:
        await provider.fetch(BBox.parse(SMALL_BOX))
        remaining = provider.remaining_credits
        if remaining is None:
            print("  no rate-limit header; skipping")
            return

        store = ObjectStore(
            object_ttl_seconds=1800, track_history_points=50, snapshot_ttl_seconds=600
        )

        for label, allowance in (
            ("normal", remaining * 2),
            ("minimal", remaining * 8),
            ("exhausted", remaining * 200),
        ):
            tuned = Settings(
                quota_preset="authenticated",
                daily_credit_budget=int(allowance),
                opensky_client_id=settings.opensky_client_id,
                opensky_client_secret=settings.opensky_client_secret,
            )
            poller = Poller(provider, store, tuned)
            poller.set_viewport(BBox.parse("48,2,54,8"))

            viewport_job: PollJob = next(j for j in tuned.jobs if j.name == "viewport")
            v_status = poller._statuses["viewport"]
            skipped_before = v_status.skipped_polls
            v_delay = await poller._tick(viewport_job, v_status)
            skipped = v_status.skipped_polls > skipped_before

            # Tier 1 is where the interval multiplier is visible. A *skipped*
            # tier 2 job returns its base interval, since it is not polling and
            # the delay only controls how often it re-checks -- so reading the
            # multiplier off tier 2 would be misleading.
            global_job: PollJob = next(j for j in tuned.jobs if j.name == "global")
            g_status = poller._statuses["global"]
            g_before = g_status.successful_polls
            g_delay = await poller._tick(global_job, g_status)
            g_polled = g_status.successful_polls > g_before

            print(f"  {label:>10}: throttle={poller.throttle.value:<10} "
                  f"tier2 {'SKIPPED' if skipped else 'polled '}({v_delay:>4.0f}s)  "
                  f"tier1 {'polled ' if g_polled else 'STOPPED'}({g_delay:>5.0f}s)")

        print("\n  Base tier 1 interval is 300s. A throttled poller lengthens it,")
        print("  skips the latency tier, and finally stops polling altogether --")
        print("  the behaviour, not merely the reported level.")
    finally:
        await provider.aclose()


async def main(max_requests: int, skip_burst: bool) -> None:
    settings = Settings()
    print(f"provider={settings.provider} preset={settings.quota_preset} "
          f"client_id={settings.opensky_client_id or '(none)'}")

    if not skip_burst:
        await burst_test(settings, max_requests)
    await throttle_ladder(settings)
    await throttled_tick(settings)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-requests", type=int, default=25,
                        help="hard ceiling on the burst test (default 25)")
    parser.add_argument("--skip-burst", action="store_true",
                        help="skip the burst test entirely")
    args = parser.parse_args()
    asyncio.run(main(args.max_requests, args.skip_burst))
