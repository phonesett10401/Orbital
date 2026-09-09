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
from app.api import ships as ships_api
from app.config import SHIP_JOBS, Settings, get_settings
from app.ingestion.poller import Poller
from app.ingestion.flights import FlightHistory
from app.ingestion.flightroutes import FlightRoutes
from app.ingestion.store import ObjectStore
from app.logging_config import configure_logging
from app.providers import registry
from app.accounts.sessions import SessionStore
from app.accounts.store import AccountStore
from app.providers.lunar import LunarTracker
from app.providers.aisstream import AisStreamProvider
from app.providers.digitraffic import DigitrafficProvider
from app.providers.shipunion import ShipUnionProvider
from app.providers.satellites import SatelliteProvider
from app.providers.base import Provider
from app.models import ObjectType

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

        # Ships, from Fintraffic's open AIS feed. A third layer beside the
        # other two, and the first one to need its *own* poller and store
        # rather than sharing or computing: a ship's position cannot be
        # calculated, so it has to be polled, and a store holding two layers
        # would need a type filter threaded through every method (D165).
        #
        # Its own jobs, too. The quota presets are a credit ladder built for a
        # metered source; Digitraffic meters nothing, so SHIP_JOBS is one job
        # at the cadence the upstream's own Cache-Control asks for.
        ships: Provider | None = None
        ship_stream: AisStreamProvider | None = None
        ship_store: ObjectStore | None = None
        ship_poller: Poller | None = None
        if settings.ship_layer_enabled:
            sources: list[Provider] = [
                DigitrafficProvider(
                    base_url=settings.digitraffic_base_url,
                    timeout_seconds=settings.digitraffic_timeout_seconds,
                    user_agent=settings.adsblol_user_agent,
                )
            ]
            # The global stream, when there is a key for it. **The key is the
            # switch**: without one the layer is the northern Baltic and
            # nothing else, which is a smaller map rather than a broken one
            # (D166).
            if settings.ship_global_enabled and settings.aisstream_api_key:
                # **Both limits, and the first one is a fix.**
                #
                # `ship_object_ttl_seconds` was reaching the store below and
                # nothing else, so the stream went on holding its own default
                # 900 seconds of vessels and handing them straight back on the
                # next snapshot: the store evicted at the configured age and was
                # refilled immediately, which is why turning that dial down
                # moved the count by 16% instead of halving it (D192).
                ship_stream = AisStreamProvider(
                    api_key=settings.aisstream_api_key,
                    max_age_seconds=settings.ship_object_ttl_seconds,
                    max_vessels=settings.ship_max_vessels,
                )
                sources.append(ship_stream)
            elif settings.ship_global_enabled:
                logger.info(
                    "ships: no ORBITAL_AISSTREAM_API_KEY, so coverage is the "
                    "Baltic only - see D166"
                )
            # A union even with one source, so that adding or removing the
            # stream changes a list rather than a type.
            ships = ShipUnionProvider(sources)
            ship_store = ObjectStore(
                object_ttl_seconds=settings.ship_object_ttl_seconds,
                track_history_points=settings.track_history_points,
                # Twice the poll interval, which is the only value that cannot
                # be stale by construction - the same rule the aircraft store
                # derives, applied to a different interval.
                snapshot_ttl_seconds=SHIP_JOBS[0].interval_seconds * 2.0,
                object_type=ObjectType.SHIP,
            )
            ship_poller = Poller(ships, ship_store, settings, jobs=SHIP_JOBS)

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
        app.state.ship_store = ship_store
        app.state.ship_poller = ship_poller
        app.state.ship_stream = ship_stream
        app.state.flights = flights
        app.state.routes = route_lookup
        app.state.poller = poller

        await poller.start()
        if ship_stream is not None:
            # Before the poller, so the first ship poll has something to read.
            # It will still be nearly empty - the stream needs a minute or two
            # to accumulate a world - and that is fine: the store fills in as
            # the polls land, exactly as it does for any other source.
            await ship_stream.start()
        if ship_poller is not None:
            await ship_poller.start()
        if satellites is not None:
            satellite_task = asyncio.create_task(
                _refresh_elements(satellites, settings.satellite_element_refresh_seconds)
            )
        if lunar is not None:
            lunar_task = asyncio.create_task(_refresh_lunar(lunar))
        logger.info(
            "Orbital ready: provider=%s preset=%s satellites=%s ships=%s",
            active_provider.name,
            settings.quota_preset,
            "on" if satellites else "off",
            (
                "digitraffic+aisstream" if ship_stream else "digitraffic"
            ) if ships else "off",
        )
        try:
            yield
        finally:
            await poller.stop()
            if ship_poller is not None:
                await ship_poller.stop()
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
            if ships is not None:
                await ships.aclose()
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

    # A thinned 2000-object response is ~366 KB of extremely repetitive JSON --
    # the same nine keys two thousand times -- which gzips to about a
    # fifteenth of that. At a ten-second client poll that is the difference
    # between 2.1 MB and 0.14 MB per minute (D38).
    #
    # **Level 3, not the library's default of 9.** Measured on exactly that
    # response:
    #
    # | level | size | cost |
    # |---|---|---|
    # | 1 | 35.7 KB | 0.21 ms |
    # | **3** | **24.5 KB** | **0.74 ms** |
    # | 6 | 24.1 KB | 1.59 ms |
    # | 9 | 23.0 KB | 5.39 ms |
    #
    # Nine buys 1.5 KB over three and charges 4.6 ms for it - on a response
    # that is already a fifteenth of its original size, against a backend whose
    # whole request is 62 ms. Three is where the curve flattens: everything
    # after it is paying milliseconds for bytes that were already gone (D167).
    app.add_middleware(
        GZipMiddleware, minimum_size=settings.gzip_min_bytes, compresslevel=3
    )

    app.include_router(auth.router)
    app.include_router(moon.router)
    app.include_router(aircraft.router)
    app.include_router(satellites_api.router)
    app.include_router(ships_api.router)
    app.include_router(health.router)
    app.include_router(search.router)
    return app


app = create_app()
