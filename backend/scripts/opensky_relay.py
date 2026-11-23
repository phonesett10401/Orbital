"""Fetch the world from OpenSky on this PC and post it to the Orbital server (D216).

OpenSky refuses cloud hosts but answers a home connection, so this runs at
Windows sign-in (pythonw, no window) and every few seconds asks the server
what it wants (free):

* any aircraft a visitor has clicked: fetch its /tracks/all (4 credits each)
  and post it to /api/relay/track/{id} (D217);
* if anyone is watching and two minutes have passed: fetch /states/all
  (4 credits) and post it, gzipped, to /api/relay/opensky.

Reads ORBITAL_OPENSKY_CLIENT_ID/SECRET and ORBITAL_RELAY_TOKEN from backend/.env.
ORBITAL_RELAY_TARGET overrides the server URL. Logs to backend/.cache/relay.log.

Kept alive by the Windows task "Orbital OpenSky relay", which starts it every
five minutes; a running copy makes the new one exit. Run once by hand with
``--once`` to test (stop the running copy first).
"""

from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import socket
import sys
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)  # so Settings finds backend/.env

import httpx  # noqa: E402

from app.config import Settings  # noqa: E402
from app.providers.base import ProviderError  # noqa: E402
from app.providers.registry import _build_opensky  # noqa: E402

DEFAULT_TARGET = "https://p01--orbital-backend--94zyc488v6xh.code.run"
WORLD_INTERVAL_SECONDS = 120.0
#: How often the server is asked what it wants. Free, and what a click waits on.
CHECK_SECONDS = 3.0
#: Held while a relay runs, so a second one exits at once.
INSTANCE_PORT = 47816

log = logging.getLogger("relay")


async def post_world(opensky, server: httpx.AsyncClient) -> None:
    try:
        payload = await opensky._request_states(None, retry_on_401=True)
    except ProviderError as exc:
        log.warning("OpenSky world fetch failed: %s", exc)
        return
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
        log.warning("world post failed: %s", exc)
        return
    log.info(
        "world: posted %d KB, applied=%s held=%s credits_left=%s",
        len(body) // 1024, result.get("applied"), result.get("objects"),
        opensky.remaining_credits,
    )


async def post_track(opensky, server: httpx.AsyncClient, object_id: str) -> None:
    try:
        track = await opensky.fetch_track(object_id)
    except ProviderError as exc:
        log.warning("OpenSky track %s failed: %s", object_id, exc)
        track = None
    # Posted even when empty, so the waiting request is answered now rather
    # than at its timeout.
    path = [[p.timestamp.timestamp(), p.lat, p.lon, p.altitude] for p in track or ()]
    try:
        (await server.post(f"/api/relay/track/{object_id}", json={"path": path})).raise_for_status()
    except httpx.HTTPError as exc:
        log.warning("track post failed: %s", exc)
        return
    log.info("track %s: %d points, credits_left=%s", object_id, len(path), opensky.remaining_credits)


async def cycle(opensky, server: httpx.AsyncClient, world_due: bool) -> bool:
    """One check. Returns whether the world was posted."""
    try:
        asked = (await server.get("/api/relay/wanted")).raise_for_status().json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("server unreachable or refused: %s", exc)
        return False
    for object_id in asked.get("tracks", []):
        await post_track(opensky, server, object_id)
    if world_due and asked.get("wanted"):
        await post_world(opensky, server)
        return True
    return False


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
        last_world = -WORLD_INTERVAL_SECONDS
        try:
            while True:
                now = time.monotonic()
                try:
                    if await cycle(opensky, server, now - last_world >= WORLD_INTERVAL_SECONDS):
                        last_world = now
                except Exception:  # noqa: BLE001 - one bad cycle must not end the relay
                    log.exception("cycle failed")
                if once:
                    return
                await asyncio.sleep(CHECK_SECONDS)
        finally:
            await opensky.aclose()


if __name__ == "__main__":
    once = "--once" in sys.argv
    # One relay at a time: a scheduled task restarts it every few minutes, and
    # a second copy would double every OpenSky fetch.
    _instance = socket.socket()
    try:
        _instance.bind(("127.0.0.1", INSTANCE_PORT))
    except OSError:
        sys.exit(0 if not once else "a relay is already running")
    (BACKEND / ".cache").mkdir(exist_ok=True)
    handlers: list[logging.Handler] = [
        RotatingFileHandler(BACKEND / ".cache" / "relay.log", maxBytes=1_000_000, backupCount=1)
    ]
    if once:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", handlers=handlers)
    # httpx logs every request at INFO, which at one check every three seconds
    # is the whole log.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    asyncio.run(main(once))
