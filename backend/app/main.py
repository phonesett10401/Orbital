"""FastAPI application assembly.

The composition root: this is the one place that knows which provider is
configured, creates the store and poller, and wires them to the routes. Every
other module depends only on interfaces.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api import aircraft, health
from app.config import Settings, get_settings
from app.ingestion.poller import Poller
from app.ingestion.store import ObjectStore
from app.logging_config import configure_logging
from app.providers import registry
from app.providers.base import Provider

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    provider: Provider | None = None,
) -> FastAPI:
    """Build the application.

    Args:
        settings: overrides the environment-derived settings. Tests pass their
            own rather than mutating the process environment.
        provider: overrides the configured provider. Tests inject a fake so
            they can make upstream fail on demand.
    """
    settings = settings or get_settings()
    # Before anything else, so provider and poller startup logging is visible.
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        active_provider = provider or registry.build(settings.provider, settings)
        store = ObjectStore(
            object_ttl_seconds=settings.object_ttl_seconds,
            track_history_points=settings.track_history_points,
            snapshot_ttl_seconds=settings.snapshot_ttl,
            object_type=settings.object_type,
        )
        poller = Poller(active_provider, store, settings)

        app.state.settings = settings
        app.state.store = store
        app.state.poller = poller

        await poller.start()
        logger.info(
            "Orbital ready: provider=%s preset=%s", active_provider.name, settings.quota_preset
        )
        try:
            yield
        finally:
            await poller.stop()

    app = FastAPI(
        title="Orbital API",
        version="0.1.0",
        summary="Live aircraft positions for a 3D globe.",
        description=(
            "Serves normalized position data from an in-memory cache. No endpoint "
            "calls an upstream source in the request path, so an upstream outage "
            "degrades freshness rather than producing errors -- responses carry a "
            "`stale` flag and an `ageSeconds` value instead.\n\n"
            "See `docs/data-contract.md` for field units and meaning."
        ),
        lifespan=lifespan,
    )

    # Permissive for local development only. This is the single change point if
    # the project is ever hosted (D20).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    # A thinned 2000-object response is ~328 KB of extremely repetitive JSON --
    # the same nine keys two thousand times -- which gzips to about a fifth of
    # that. At a ten-second client poll that is the difference between 1.9 MB
    # and 0.4 MB per minute (D38).
    app.add_middleware(GZipMiddleware, minimum_size=settings.gzip_min_bytes)

    app.include_router(aircraft.router)
    app.include_router(health.router)
    return app


app = create_app()
