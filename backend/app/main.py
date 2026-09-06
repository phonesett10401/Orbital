"""FastAPI application assembly.

The composition root: this is the one place that knows which provider is
configured, creates the store and poller, and wires them to the routes. Every
other module depends only on interfaces.
"""

from __future__ import annotations

import logging
import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from app.api import aircraft, auth, health, moon, search
from app.api import satellites as satellites_api
from app.config import Settings, get_settings
from app.ingestion.poller import Poller
from app.ingestion.flights import FlightHistory
from app.ingestion.flightroutes import FlightRoutes
from app.ingestion.store import ObjectStore
from app.logging_config import configure_logging
from app.providers import registry
from app.accounts.sessions import SessionStore
from app.accounts.store import AccountStore
from app.providers.lunar import LunarTracker
from app.providers.satellites import SatelliteProvider
from app.providers.base import Provider

logger = logging.getLogger(__name__)


async def _refresh_lunar(tracker: LunarTracker) -> None:
    """Keep the lunar ephemeris windows ahead of the clock.

    Hourly, which is far more often than a six-hour window strictly needs -
    cheap insurance, because a refresh that finds nothing to do makes no
    request at all. Failures are logged and retried: a window already held
    stays usable for hours, so losing one refresh is not losing the layer.
    """
    while True:
        try:
            refreshed = await tracker.refresh()
            if refreshed:
                logger.info(
                    "lunar ephemeris refreshed: %d of %d spacecraft",
                    refreshed,
                    len(tracker.craft),
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "lunar ephemeris refresh failed, keeping what we have: %s", exc
            )
        await asyncio.sleep(3600)


async def _refresh_elements(provider: "SatelliteProvider", interval: float) -> None:
    """Keep the orbital elements current, off the request path.

    Failures are logged and retried rather than raised. Losing a refresh is not
    losing the layer: elements stay usable for days, so the correct response to
    an outage is to carry on with what we have and try again later. That is the
    opposite of the aircraft poller, where a failed poll means the data really
    is getting older.
    """
    while True:
        try:
            held = await provider.refresh()
            logger.info("orbital elements refreshed: %d sets held", held)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("orbital element refresh failed, keeping what we have: %s", exc)
        await asyncio.sleep(interval)


def create_app(
    settings: Settings | None = None,
    provider: Provider | None = None,
    routes: FlightRoutes | None = None,
) -> FastAPI:
    """Build the application.

    Args:
        settings: overrides the environment-derived settings. Tests pass their
            own rather than mutating the process environment.
        provider: overrides the configured provider. Tests inject a fake so
            they can make upstream fail on demand.
        routes: overrides the scheduled-route lookup. Tests inject an offline
            one; without it every detail request in the suite would call a
            live third-party service.
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
        # Bought per selection rather than polled, so it hangs off the app
        # beside the poller rather than inside it (D78).
        flights = FlightHistory(active_provider)
        # Free, keyless, and unrelated to the position provider: adsbdb answers
        # what a callsign is scheduled to fly, which no position feed carries
        # (D88).
        route_lookup = routes or FlightRoutes()

        # The satellite layer runs *beside* the aircraft one rather than
        # instead of it, because the toggle in the UI has to switch between two
        # things that are both already there. It can afford to: it spends no
        # quota, holds no store, and needs no poll interval, so "always on"
        # costs one background task and a few hundred kilobytes of elements
        # (D93, D95). ORBITAL_PROVIDER still selects the aircraft source only.
        satellites: SatelliteProvider | None = None
        satellite_task: asyncio.Task | None = None
        if settings.satellite_layer_enabled:
            satellites = SatelliteProvider(
                timeout_seconds=settings.satellite_timeout_seconds,
                user_agent=settings.adsblol_user_agent,
                refresh_seconds=settings.satellite_element_refresh_seconds,
                cache_path=settings.satellite_element_cache_path,
            )

        # Three spacecraft around the Moon, from JPL Horizons. A background
        # refresh for the same reason the elements have one: no route may wait
        # on an upstream (D134).
        lunar = LunarTracker() if settings.lunar_layer_enabled else None
        lunar_task: asyncio.Task | None = None

        # Accounts and sessions share one SQLite file. Opened here so a
        # missing directory or an unwritable path fails at startup rather than
        # at the first sign-in attempt (D147).
        app.state.accounts = AccountStore(settings.accounts_db_path)
        app.state.sessions = SessionStore(settings.accounts_db_path)

        app.state.lunar = lunar
        app.state.satellites = satellites
        app.state.settings = settings
        app.state.store = store
        app.state.flights = flights
        app.state.routes = route_lookup
        app.state.poller = poller

        await poller.start()
        if satellites is not None:
            satellite_task = asyncio.create_task(
                _refresh_elements(satellites, settings.satellite_element_refresh_seconds)
            )
        if lunar is not None:
            lunar_task = asyncio.create_task(_refresh_lunar(lunar))
        logger.info(
            "Orbital ready: provider=%s preset=%s satellites=%s",
            active_provider.name,
            settings.quota_preset,
            "on" if satellites else "off",
        )
        try:
            yield
        finally:
            await poller.stop()
            if satellite_task is not None:
                satellite_task.cancel()
                with suppress(asyncio.CancelledError):
                    await satellite_task
            if lunar_task is not None:
                lunar_task.cancel()
                with suppress(asyncio.CancelledError):
                    await lunar_task
            if lunar is not None:
                await lunar.aclose()
            if satellites is not None:
                await satellites.aclose()
            await route_lookup.aclose()

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

    app.include_router(auth.router)
    app.include_router(moon.router)
    app.include_router(aircraft.router)
    app.include_router(satellites_api.router)
    app.include_router(health.router)
    app.include_router(search.router)
    return app


app = create_app()
