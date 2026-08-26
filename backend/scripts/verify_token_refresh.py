"""Live verification of OAuth2 token refresh.

The highest-risk unverified path: tokens last 30 minutes, a demo can run longer,
and the refresh logic had only ever been exercised against a mock transport. If
refresh is broken, the globe freezes mid-presentation.

    cd backend && .venv/Scripts/python scripts/verify_token_refresh.py

Three checks, in increasing strength:

1. **Forced refresh.** Ask the real endpoint for a second token immediately and
   confirm it issues one, that it differs from the first, and that a request
   authenticated with it succeeds. This proves the endpoint and our request
   shape, without waiting.
2. **Refresh decision.** Wind the cached deadline back and confirm the provider
   chooses to refresh, then wind it forward and confirm it does not. This proves
   the timing logic against the live provider rather than a mock.
3. **Natural refresh.** Poll on a slow cadence until the real deadline passes
   and a refresh happens by itself. This is the only check that proves all of it
   together, and the only one that takes half an hour.

Cost: roughly 1 credit per poll (small bounded box), plus token requests, which
are not credit-metered. A full natural run is about 30 credits.

Never prints a token or the client secret -- only lengths and prefixed hashes.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.models import BBox  # noqa: E402
from app.providers.opensky import TOKEN_REFRESH_MARGIN_SECONDS, OpenSkyProvider  # noqa: E402

SMALL_BOX = "50,3,52,6"


def fingerprint(token: str | None) -> str:
    """A short, non-reversible identifier so two tokens can be compared in logs."""
    if token is None:
        return "(none)"
    return hashlib.sha256(token.encode()).hexdigest()[:12]


def stamp() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def rule(title: str) -> None:
    print(f"\n{'=' * 72}\n{title}\n{'=' * 72}")


async def forced_refresh(provider: OpenSkyProvider) -> None:
    rule("1. FORCED REFRESH AGAINST THE REAL ENDPOINT")

    first = await provider._get_token()
    print(f"  {stamp()}  initial token   {fingerprint(first)} ({len(first or '')} chars)")

    objects = await provider.fetch(BBox.parse(SMALL_BOX))
    print(f"  {stamp()}  request with it succeeded: {len(objects)} aircraft")

    second = await provider._get_token(force=True)
    print(f"  {stamp()}  forced refresh  {fingerprint(second)} ({len(second or '')} chars)")
    print(f"  tokens differ: {first != second}")

    objects = await provider.fetch(BBox.parse(SMALL_BOX))
    print(f"  {stamp()}  request with the NEW token succeeded: {len(objects)} aircraft")


async def refresh_decision(provider: OpenSkyProvider) -> None:
    rule("2. REFRESH DECISION LOGIC (live provider, manipulated clock)")

    loop = asyncio.get_running_loop()
    current = await provider._get_token()
    remaining = provider._token_expires_at - loop.time()
    print(f"  cached token {fingerprint(current)}, refresh due in {remaining:.0f}s")
    print(f"  (nominal lifetime minus a {TOKEN_REFRESH_MARGIN_SECONDS:.0f}s safety margin)")

    # Still inside the window: must reuse.
    reused = await provider._get_token()
    print(f"  inside the window -> reused the same token: {reused == current}")

    # Past the deadline: must fetch a new one from the real endpoint.
    provider._token_expires_at = loop.time() - 1
    refreshed = await provider._get_token()
    print(f"  past the deadline -> issued a new token:    {refreshed != current}")
    print(f"  new token {fingerprint(refreshed)}")

    objects = await provider.fetch(BBox.parse(SMALL_BOX))
    print(f"  request with the refreshed token succeeded: {len(objects)} aircraft")


async def natural_refresh(provider: OpenSkyProvider, minutes: float, interval: float) -> None:
    rule(f"3. NATURAL REFRESH ({minutes:.0f} minute run, polling every {interval:.0f}s)")

    loop = asyncio.get_running_loop()
    token = await provider._get_token()
    baseline = fingerprint(token)
    deadline = provider._token_expires_at
    print(f"  {stamp()}  token {baseline}, natural refresh due in "
          f"{deadline - loop.time():.0f}s")
    print(f"  watching for the provider to refresh without being told to.\n")

    started = time.monotonic()
    limit = minutes * 60
    polls = 0
    refreshed_at = None

    while time.monotonic() - started < limit:
        await asyncio.sleep(interval)
        polls += 1
        try:
            objects = await provider.fetch(BBox.parse(SMALL_BOX))
        except Exception as exc:  # noqa: BLE001 - the point is to see any failure
            print(f"  {stamp()}  poll {polls:>3} FAILED: {type(exc).__name__}: {exc}")
            continue

        current = fingerprint(await provider._get_token())
        elapsed = time.monotonic() - started
        note = ""
        if current != baseline and refreshed_at is None:
            refreshed_at = elapsed
            note = "  <-- TOKEN REFRESHED"
            baseline = current
        print(f"  {stamp()}  poll {polls:>3} ({elapsed / 60:>4.1f} min)  "
              f"{len(objects):>4} aircraft  credits={provider.remaining_credits}  "
              f"token={current}{note}")

    print()
    if refreshed_at is None:
        print(f"  no natural refresh within {minutes:.0f} minutes -- the token had "
              f"{deadline - loop.time():.0f}s left.")
        print("  Extend --minutes past the refresh deadline to observe it.")
    else:
        print(f"  RESULT: the provider refreshed on its own at {refreshed_at / 60:.1f} "
              f"minutes, with no intervention, and polling continued uninterrupted.")


async def main(minutes: float, interval: float, skip_natural: bool) -> None:
    settings = Settings()
    provider = OpenSkyProvider(
        client_id=settings.opensky_client_id,
        client_secret=settings.opensky_client_secret,
        base_url=settings.opensky_base_url,
        token_url=settings.opensky_token_url,
        timeout_seconds=settings.opensky_timeout_seconds,
    )
    print(f"client_id={settings.opensky_client_id or '(none)'} "
          f"authenticated={provider.authenticated}")

    try:
        await forced_refresh(provider)
        await refresh_decision(provider)
        if not skip_natural:
            await natural_refresh(provider, minutes, interval)
    finally:
        await provider.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=33.0)
    parser.add_argument("--interval", type=float, default=120.0)
    parser.add_argument("--skip-natural", action="store_true")
    args = parser.parse_args()
    asyncio.run(main(args.minutes, args.interval, args.skip_natural))
