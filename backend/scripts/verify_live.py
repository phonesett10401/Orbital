"""Live OpenSky verification: the run docs/test-plan.md section 7 requires.

Everything else in this project is tested against the fixture provider, which
means OAuth2 against the real endpoint, real credit accounting, and real
response shapes have never been exercised. This script exercises them, and
prints evidence rather than a pass/fail verdict -- the sign-off decision is a
human one.

    cd backend && .venv/Scripts/python scripts/verify_live.py

Cost: about 5 credits of the 4000/day authenticated allowance. One bounded
request (1 credit) and one global request (4 credits).

Credentials come from backend/.env. **This script never prints the secret**, and
neither should anything you add to it.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.models import BBox  # noqa: E402
from app.providers.opensky import OpenSkyProvider  # noqa: E402
from app.quota import credits_for_bbox  # noqa: E402
from app.thinning import thin  # noqa: E402

#: A small box over the Benelux/Rhine corridor: dense traffic, 1 credit.
DENSE_BOX = "50,3,54,8"


def rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


def describe_nulls(records) -> None:
    """Null rates per field. The contract says null means unknown, never zero,
    so anything unexpectedly null is a normalizer question."""
    total = len(records)
    if total == 0:
        print("  (no records)")
        return
    fields = ("altitude", "velocity", "heading")
    for field in fields:
        missing = sum(1 for r in records if getattr(r, field) is None)
        print(f"  {field:<10} null in {missing:>6} / {total} ({missing / total:>5.1%})")

    unlabelled = sum(1 for r in records if r.label == r.id)
    print(f"  {'callsign':<10} absent (label fell back to id) in {unlabelled} / {total}")

    on_ground = sum(1 for r in records if r.meta.get("onGround") == "true")
    print(f"  {'onGround':<10} true in {on_ground} / {total}")

    countries = Counter(r.meta.get("originCountry", "(none)") for r in records)
    top = ", ".join(f"{c}={n}" for c, n in countries.most_common(5))
    print(f"  origin countries: {len(countries)} distinct; top: {top}")


def describe_clustering(records, limit: int) -> None:
    """How real traffic distributes, and what thinning does with it.

    Every performance measurement so far used synthetic data spread evenly over
    the globe. Real traffic clusters hard over Europe and North America, which
    is the case the thinning grid has never faced.
    """
    if not records:
        print("  (no records)")
        return

    buckets: Counter[tuple[int, int]] = Counter()
    for r in records:
        buckets[(int(r.lat // 10) * 10, int(r.lon // 10) * 10)] += 1

    occupied = len(buckets)
    print(f"  occupied 10x10 cells: {occupied} of 648 possible ({occupied / 648:.1%})")
    print(f"  busiest cells (lat, lon -> count):")
    for (lat, lon), n in buckets.most_common(6):
        print(f"    {lat:>4},{lon:>5} -> {n:>5}  ({n / len(records):.1%} of all traffic)")

    counts = sorted(buckets.values(), reverse=True)
    top10 = sum(counts[:10])
    print(f"  top 10 cells hold {top10} of {len(records)} objects ({top10 / len(records):.1%})")

    selected = thin(records, limit)
    if len(records) <= limit:
        print(f"  thinning: not triggered ({len(records)} <= {limit})")
        return

    after: Counter[tuple[int, int]] = Counter()
    for r in selected:
        after[(int(r.lat // 10) * 10, int(r.lon // 10) * 10)] += 1

    busiest = buckets.most_common(1)[0][0]
    print(f"  thinned {len(records)} -> {len(selected)}")
    print(f"  occupied cells after thinning: {len(after)} (was {occupied})")
    print(
        f"  busiest cell {busiest}: {buckets[busiest]} -> {after[busiest]} "
        f"(share {buckets[busiest] / len(records):.1%} -> {after[busiest] / len(selected):.1%})"
    )
    quiet_kept = sum(1 for cell in buckets if buckets[cell] <= 5 and after.get(cell, 0) > 0)
    quiet_total = sum(1 for cell in buckets if buckets[cell] <= 5)
    print(f"  sparse cells (<=5 objects) retained: {quiet_kept} / {quiet_total}")


async def main(skip_global: bool) -> None:
    settings = Settings()

    rule("CONFIGURATION")
    print(f"  provider     : {settings.provider}")
    print(f"  preset       : {settings.quota_preset}")
    print(f"  client id    : {settings.opensky_client_id or '(none)'}")
    print(
        f"  client secret: {'set (' + str(len(settings.opensky_client_secret)) + ' chars)' if settings.opensky_client_secret else 'MISSING'}"
    )
    print(f"  projection   : {settings.projected_daily_credits():.0f} credits/day "
          f"of {settings.daily_allowance}")

    provider = OpenSkyProvider(
        client_id=settings.opensky_client_id,
        client_secret=settings.opensky_client_secret,
        base_url=settings.opensky_base_url,
        token_url=settings.opensky_token_url,
        timeout_seconds=settings.opensky_timeout_seconds,
    )

    try:
        rule("1. OAUTH2 TOKEN")
        print(f"  authenticated mode: {provider.authenticated}")
        loop = asyncio.get_running_loop()
        token = await provider._get_token()
        if token is None:
            print("  NO TOKEN -- running anonymously (400/day)")
        else:
            lifetime = provider._token_expires_at - loop.time()
            print(f"  token acquired : yes ({len(token)} chars, value not printed)")
            print(f"  refresh due in : {lifetime:.0f}s "
                  f"(nominal lifetime minus the {60}s safety margin)")

        cached = await provider._get_token()
        print(f"  second call reused the cached token: {cached == token}")

        rule("2. BOUNDED REQUEST (1 credit expected)")
        box = BBox.parse(DENSE_BOX)
        print(f"  bbox      : {DENSE_BOX}  ({box.width_deg:.0f} x {box.height_deg:.0f} deg, "
              f"{box.width_deg * box.height_deg:.0f} sq deg)")
        print(f"  predicted : {credits_for_bbox(box)} credit(s)")
        before = provider.remaining_credits
        regional = await provider.fetch(box)
        print(f"  returned  : {len(regional)} aircraft")
        print(f"  remaining : {provider.remaining_credits}")
        if before is not None and provider.remaining_credits is not None:
            print(f"  observed cost: {before - provider.remaining_credits}")
        print("  field completeness:")
        describe_nulls(regional)

        if skip_global:
            rule("3. GLOBAL REQUEST -- SKIPPED (--no-global)")
            return

        rule("3. GLOBAL REQUEST (4 credits expected)")
        before = provider.remaining_credits
        world = await provider.fetch(None)
        after = provider.remaining_credits
        print(f"  returned  : {len(world)} aircraft")
        print(f"  remaining : {after}")
        if before is not None and after is not None:
            print(f"  observed cost: {before - after} (predicted {credits_for_bbox(None)})")
        print(f"  provider's own inference: {provider.last_request_credits}")
        print("\n  field completeness:")
        describe_nulls(world)

        rule("4. REAL TRAFFIC DISTRIBUTION vs THE THINNING GRID")
        describe_clustering(world, settings.max_objects_per_response)

        rule("5. BUDGET CHECK AGAINST OBSERVATION")
        if after is not None:
            spent = settings.daily_allowance - after
            print(f"  allowance          : {settings.daily_allowance}")
            print(f"  remaining now      : {after}")
            print(f"  spent so far today : {spent}")
            print(f"  projected daily use: {settings.projected_daily_credits():.0f}")
            print(f"  headroom           : {settings.daily_allowance - settings.projected_daily_credits():.0f}")
    finally:
        await provider.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--no-global",
        action="store_true",
        help="skip the 4-credit global request",
    )
    asyncio.run(main(parser.parse_args().no_global))
