"""Tests for compression and logging.

Both of these were written correctly and then silently did nothing — gzip was
never enabled, and every ``logger.info`` in the poller and provider was
discarded for want of a handler. Neither defect was catchable by the existing
suite, because nothing asserted on response encoding or on log output. These
tests close that gap (D38).
"""

from __future__ import annotations

import gzip
import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.logging_config import APP_LOGGER, configure_logging
from app.main import create_app
from app.models import ObjectType, TrackedObjectRecord, utcnow
from app.providers.base import Provider, ProviderUnavailable

NOW = utcnow()


def record(i: int) -> TrackedObjectRecord:
    return TrackedObjectRecord(
        id=f"{i:06x}",
        lat=(i % 179) - 89,
        lon=((i * 37) % 359) - 179,
        altitude=(i % 12) * 1000.0,
        velocity=200.0 + (i % 80),
        heading=(i * 7) % 360,
        label=f"TEST{i}",
        last_seen=NOW,
        type=ObjectType.AIRCRAFT,
        meta={"originCountry": "Testland"},
    )


class BulkProvider(Provider):
    """Returns enough objects for a response worth compressing."""

    name = "bulk"
    object_type = ObjectType.AIRCRAFT

    def __init__(self, count: int = 400):
        self.records = [record(i) for i in range(count)]
        self.error: Exception | None = None
        self.remaining_credits: int | None = 3820

    async def fetch(self, bbox=None):
        if self.error is not None:
            raise self.error
        return list(self.records)


@pytest.fixture
def settings() -> Settings:
    return Settings(quota_preset="authenticated", provider="fixture")


@pytest.fixture
def client(settings):
    app = create_app(settings=settings, provider=BulkProvider())
    with TestClient(app) as test_client:
        yield test_client


class TestCompression:
    def test_a_large_response_is_gzipped_when_the_client_accepts_it(self, client):
        response = client.get(
            "/api/aircraft", headers={"Accept-Encoding": "gzip"}
        )
        assert response.status_code == 200
        assert response.headers.get("content-encoding") == "gzip"

    def test_the_compressed_body_is_still_valid_json(self, client):
        # httpx decompresses transparently, so this also proves the payload
        # survives the round trip rather than merely being smaller.
        body = client.get("/api/aircraft", headers={"Accept-Encoding": "gzip"}).json()
        assert body["returned"] > 0
        assert "objects" in body

    def test_compression_is_worth_it_on_a_realistic_payload(self, client):
        # The measured saving that motivated this: object lists are the same
        # nine keys repeated, which is close to a best case for gzip.
        raw = client.get(
            "/api/aircraft", headers={"Accept-Encoding": "identity"}
        ).content
        compressed = gzip.compress(raw, 6)
        assert len(compressed) < len(raw) * 0.4

    def test_a_client_that_does_not_accept_gzip_gets_plain_json(self, client):
        response = client.get("/api/aircraft", headers={"Accept-Encoding": "identity"})
        assert response.headers.get("content-encoding") != "gzip"
        assert json.loads(response.content)["returned"] > 0

    def test_small_responses_are_not_compressed(self, client):
        # Below the threshold the framing costs more than it saves.
        response = client.get(
            "/api/aircraft", params={"bbox": "0,0,0.01,0.01"},
            headers={"Accept-Encoding": "gzip"},
        )
        assert response.headers.get("content-encoding") != "gzip"

    def test_the_threshold_is_configurable(self):
        app = create_app(
            settings=Settings(quota_preset="authenticated", gzip_min_bytes=10**9),
            provider=BulkProvider(),
        )
        with TestClient(app) as client:
            response = client.get("/api/aircraft", headers={"Accept-Encoding": "gzip"})
            assert response.headers.get("content-encoding") != "gzip"


class TestLoggingConfiguration:
    def test_configure_logging_attaches_a_handler(self):
        configure_logging("INFO")
        assert logging.getLogger().handlers

    def test_it_is_idempotent(self):
        # Creating the app more than once in a test session must not stack
        # handlers and print everything twice.
        configure_logging("INFO")
        before = len(logging.getLogger().handlers)
        configure_logging("INFO")
        configure_logging("DEBUG")
        assert len(logging.getLogger().handlers) == before

    def test_the_app_logger_level_follows_configuration(self):
        configure_logging("WARNING")
        assert logging.getLogger(APP_LOGGER).level == logging.WARNING
        configure_logging("INFO")
        assert logging.getLogger(APP_LOGGER).level == logging.INFO

    def test_an_unknown_level_falls_back_to_info(self):
        # A typo in an env var should not silence the application.
        configure_logging("chatty")
        assert logging.getLogger(APP_LOGGER).level == logging.INFO


class TestLogOutput:
    """D23 requires the credit balance to be logged, not merely exposed."""

    def test_poll_results_are_logged(self, settings, caplog):
        with caplog.at_level(logging.INFO, logger="app.ingestion.poller"):
            app = create_app(settings=settings, provider=BulkProvider())
            with TestClient(app):
                pass
        assert any("job=global" in r.getMessage() for r in caplog.records)

    def test_the_logged_poll_result_names_the_object_count(self, settings, caplog):
        with caplog.at_level(logging.INFO, logger="app.ingestion.poller"):
            app = create_app(settings=settings, provider=BulkProvider(count=400))
            with TestClient(app):
                pass
        messages = [r.getMessage() for r in caplog.records]
        assert any("applied=400" in m for m in messages)

    def test_poller_startup_is_logged_with_the_budget(self, settings, caplog):
        with caplog.at_level(logging.INFO, logger="app.ingestion.poller"):
            app = create_app(settings=settings, provider=BulkProvider())
            with TestClient(app):
                pass
        messages = [r.getMessage() for r in caplog.records]
        assert any("poller started" in m and "credits/day" in m for m in messages)

    def test_failures_are_logged_with_the_retry_delay(self, settings, caplog):
        provider = BulkProvider()
        provider.error = ProviderUnavailable("simulated outage")
        with caplog.at_level(logging.WARNING, logger="app.ingestion.poller"):
            app = create_app(settings=settings, provider=provider)
            with TestClient(app):
                pass
        messages = [r.getMessage() for r in caplog.records]
        assert any("failed" in m and "retrying in" in m for m in messages)

    def test_the_credit_balance_is_logged(self, caplog):
        # The specific D23 requirement that was violated in practice: the
        # balance was read and surfaced on /api/health, but never written to a
        # log anyone could read.
        import httpx

        from app.providers.opensky import HEADER_REMAINING, OpenSkyProvider

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"time": 1787659200, "states": []},
                headers={HEADER_REMAINING: "3820"},
            )

        provider = OpenSkyProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        )

        import asyncio

        with caplog.at_level(logging.INFO, logger="app.providers.opensky"):
            asyncio.run(provider.fetch())

        messages = [r.getMessage() for r in caplog.records]
        assert any("credits remaining: 3820" in m for m in messages)

    def test_token_acquisition_is_logged(self, caplog):
        import asyncio

        import httpx

        from app.providers.opensky import OpenSkyProvider

        def handler(request: httpx.Request) -> httpx.Response:
            if "token" in str(request.url):
                return httpx.Response(
                    200, json={"access_token": "tok", "expires_in": 1800}
                )
            return httpx.Response(200, json={"time": 1, "states": []})

        provider = OpenSkyProvider(
            client_id="id",
            client_secret="secret",
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with caplog.at_level(logging.INFO, logger="app.providers.opensky"):
            asyncio.run(provider.fetch())

        messages = [r.getMessage() for r in caplog.records]
        assert any("obtained OpenSky token" in m for m in messages)

    def test_no_log_line_carries_the_client_secret(self, caplog):
        import asyncio

        import httpx

        from app.providers.opensky import OpenSkyProvider

        secret = "super-secret-value"

        def handler(request: httpx.Request) -> httpx.Response:
            if "token" in str(request.url):
                return httpx.Response(
                    200, json={"access_token": "tok-abc", "expires_in": 1800}
                )
            return httpx.Response(200, json={"time": 1, "states": []})

        provider = OpenSkyProvider(
            client_id="id",
            client_secret=secret,
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with caplog.at_level(logging.DEBUG, logger="app.providers.opensky"):
            asyncio.run(provider.fetch())

        blob = " ".join(r.getMessage() for r in caplog.records)
        assert secret not in blob
        assert "tok-abc" not in blob
