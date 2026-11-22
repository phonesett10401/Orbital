"""Fetch the world from OpenSky on this PC and post it to the Orbital server (D216).

OpenSky refuses cloud hosts but answers a home connection, so this runs at
Windows sign-in (pythonw, no window) and, every two minutes:

1. asks the server whether anyone is watching (free), and skips if not;
2. fetches /states/all with the OpenSky account in backend/.env (4 credits);
3. posts the raw answer, gzipped, to /api/relay/opensky.

Reads ORBITAL_OPENSKY_CLIENT_ID/SECRET and ORBITAL_RELAY_TOKEN from backend/.env.
ORBITAL_RELAY_TARGET overrides the server URL. Logs to backend/.cache/relay.log.

Run once by hand with ``--once`` to test.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)  # so Settings finds backend/.env

import httpx  # noqa: E402

from app.config import Settings  # noqa: E402
from app.providers.base import ProviderError, ProviderRateLimited  # noqa: E402
from app.providers.registry import _build_opensky  # noqa: E402

DEFAULT_TARGET = "https://p01--orbital-backend--94zyc488v6xh.code.run"
INTERVAL_SECONDS = 120.0

log = logging.getLogger("relay")


async def cycle(opensky, server: httpx.AsyncClient) -> float:
    """One round. Returns seconds to wait before the next."""
    try:
        wanted = (await server.get("/api/relay/wanted")).raise_for_status().json()["wanted"]
    except (httpx.HTTPError, KeyError, ValueError) as exc:
        log.warning("server unreachable or refused: %s", exc)
        return INTERVAL_SECONDS
    if not wanted:
        return INTERVAL_SECONDS

    try:
        payload = await opensky._request_states(None, retry_on_401=True)
    except ProviderRateLimited as exc:
        log.warning("OpenSky rate limit: %s", exc)
        return max(exc.retry_after or 0, INTERVAL_SECONDS)
    except ProviderError as exc:
        log.warning("OpenSky failed: %s", exc)
        return INTERVAL_SECONDS

    body = gzip.compress(json.dumps(payload).encode())
    try:
        result = (
            await server.post(
                "/api/relay/opensky",
                content=body,
                headers={"Content-Encoding": "gzip", "Content-Type": "application/json"},
            )
        ).raise_for_status().json()
    except httpx.HTTPError as exc:
        log.warning("post failed: %s", exc)
        return INTERVAL_SECONDS
    log.info(
        "posted %d KB: applied=%s held=%s credits_left=%s",
        len(body) // 1024, result.get("applied"), result.get("objects"),
        opensky.remaining_credits,
    )
    return INTERVAL_SECONDS


async def main(once: bool) -> None:
    settings = Settings()
    if not settings.relay_token:
        sys.exit("ORBITAL_RELAY_TOKEN is not set in backend/.env")
    target = os.environ.get("ORBITAL_RELAY_TARGET", DEFAULT_TARGET)
    opensky = _build_opensky(settings)
    async with httpx.AsyncClient(
        base_url=target,
        headers={"Authorization": f"Bearer {settings.relay_token}"},
        timeout=60.0,
    ) as server:
        try:
            while True:
                delay = await cycle(opensky, server)
                if once:
                    return
                await asyncio.sleep(delay)
        finally:
            await opensky.aclose()


if __name__ == "__main__":
    once = "--once" in sys.argv
    (BACKEND / ".cache").mkdir(exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(BACKEND / ".cache" / "relay.log", maxBytes=1_000_000, backupCount=1)
    ]
    if once:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)
    asyncio.run(main(once))
