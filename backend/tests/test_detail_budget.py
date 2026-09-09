"""What a detail request is allowed to cost.

`/api/aircraft/{id}` enriches from two independent services: OpenSky for the
observed flight track, adsbdb for the scheduled route. Neither reads the
other's answer, and both are enhancements to a panel whose other fields are
already in hand.

They used to be awaited one after the other, so a first click cost the sum.
**Measured against the deployment, that sum was 20.6 seconds** - OpenSky's own
20-second timeout, with a route lookup answering in about a tenth of a second
queued behind it (D181).
"""

from __future__ import annotations

import asyncio
import time

import pytest
from fastapi.testclient import TestClient

from app.api import aircraft as aircraft_api
from app.api.deps import get_flights, get_routes
from app.main import create_app
from app.models import TrackSource

from .conftest import offline_routes
# The two fixtures this needs, named rather than starred: `import *` pulled in
# every test class in that module and ran the whole file a second time.
from .test_api import provider, settings  # noqa: F401


class _Slow:
    """An enricher that takes a stated time and records whether it finished."""

    def __init__(self, delay: float, *, mark: str | None = None) -> None:
        self.delay = delay
        self.mark = mark
        self.started = 0
        self.finished = False

    async def enrich(self, detail):
        self.started += 1
        await asyncio.sleep(self.delay)
        self.finished = True
        if self.mark == "track":
            return detail.model_copy(update={"track_source": TrackSource.PROVIDER})
        return detail


@pytest.fixture
def budgeted(provider, settings, monkeypatch):
    """A client whose budgets are small enough to assert against."""
    monkeypatch.setattr(aircraft_api, "TRACK_BUDGET_SECONDS", 0.05)
    monkeypatch.setattr(aircraft_api, "ROUTE_BUDGET_SECONDS", 0.05)
    app = create_app(settings=settings, provider=provider, routes=offline_routes())

    def make(flights=None, routes=None):
        if flights is not None:
            app.dependency_overrides[get_flights] = lambda: flights
        if routes is not None:
            app.dependency_overrides[get_routes] = lambda: routes
        return TestClient(app)

    return make


class TestDetailBudget:
    def test_a_slow_track_does_not_hold_the_response(self, budgeted):
        slow = _Slow(2.0, mark="track")
        with budgeted(flights=slow) as client:
            started = time.monotonic()
            response = client.get("/api/aircraft/a1")
            elapsed = time.monotonic() - started

        assert response.status_code == 200
        # Well under the enricher's 2 seconds, and nothing like the 20 the
        # deployment was measured at.
        assert elapsed < 1.0, f"detail waited {elapsed:.2f}s on a slow track"

    def test_the_panel_still_gets_its_own_track_when_the_provider_is_slow(self, budgeted):
        slow = _Slow(2.0, mark="track")
        with budgeted(flights=slow) as client:
            body = client.get("/api/aircraft/a1").json()

        # The fallback is not an error page: it is the track we observed
        # ourselves, which is what the panel showed before any provider existed.
        assert body["trackSource"] == TrackSource.OBSERVED.value
        assert len(body["track"]) >= 1

    def test_the_two_enrichments_run_together(self, budgeted):
        # Both are given a delay comfortably inside the budget. Awaited in
        # sequence the request costs their sum; together it costs the larger.
        flights, routes = _Slow(0.30, mark="track"), _Slow(0.30)
        with budgeted(flights=flights, routes=routes) as client:
            started = time.monotonic()
            client.get("/api/aircraft/a1")
            elapsed = time.monotonic() - started

        assert flights.started == 1 and routes.started == 1
        assert elapsed < 0.55, f"took {elapsed:.2f}s, which is the sum, not the maximum"

    def test_giving_up_waiting_does_not_cancel_the_work(self, budgeted):
        """The shield, which is the whole reason a slow track is not a slow app.

        Cancelling on timeout would mean nothing reaches the cache, and the
        client - which re-polls an aircraft for as long as it stays selected -
        would restart the same fetch every few seconds, spending a credit each
        time (D78) and never once arriving.
        """
        slow = _Slow(0.40, mark="track")
        with budgeted(flights=slow) as client:
            client.get("/api/aircraft/a1")
            assert slow.finished is False, "the fixture did not out-wait the budget"
            # The request is answered; the fetch behind it is still running.
            time.sleep(0.8)
            assert slow.finished is True, "the timeout cancelled the fetch"
