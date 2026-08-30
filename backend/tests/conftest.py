"""Shared pytest configuration.

``anyio_backend`` pins async tests to asyncio. Without it, anyio's plugin would
also try to run every async test under trio, which we do not depend on.
"""

from __future__ import annotations

import httpx
import pytest

from app.ingestion.flightroutes import FlightRoutes


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def offline_routes(handler=None) -> FlightRoutes:
    """A route lookup that never touches the network.

    Every detail request enriches with a scheduled route (D88), so without this
    the test suite would call a live third-party service several times per run:
    slow, flaky offline, and rude to a service that charges nothing. The
    default handler answers adsbdb's real "unknown callsign" 404.
    """

    def unknown(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"response": "unknown callsign"})

    transport = httpx.MockTransport(handler or unknown)
    return FlightRoutes(client=httpx.AsyncClient(transport=transport))
