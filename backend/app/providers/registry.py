"""Maps a provider name from config to a live Provider instance.

This is the whole of Orbital's pluggability story. Switching data sources is an
environment variable, not a code change:

    ORBITAL_PROVIDER=fixture   # offline development, default
    ORBITAL_PROVIDER=opensky   # live data, metered
    ORBITAL_PROVIDER=adsblol   # live data, free
    ORBITAL_PROVIDER=union     # both, merged (D83)
    ORBITAL_PROVIDER=satellites  # a different layer entirely (D93)

That last one is why the interface was worth having. Adding a second live
source meant writing one module and one three-line factory; nothing in
``app.api``, the store, the poller or the frontend knows there are now two.

**Ships are not in this table, and the reason is worth stating.** This registry
answers "which source fills the *aircraft* layer", and ``ORBITAL_PROVIDER``
selects from it. The ships layer has its own provider, its own store and its
own poller, built in ``main`` (D165, D166) - so listing Digitraffic here would
not enable ships, it would fill the **aircraft** store with vessels and serve
them from ``/api/aircraft`` with ``type: ship``. It was listed here briefly,
before the layer had a lifecycle of its own, and it was dead config whose only
possible effect was that one.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Mapping

from app.providers.adsblol import AdsbLolProvider
from app.providers.base import Provider
from app.providers.fixture import FixtureProvider
from app.providers.opensky import OpenSkyProvider
from app.providers.satellites import SatelliteProvider
from app.providers.union import UnionProvider

if TYPE_CHECKING:  # pragma: no cover - import cycle guard
    from app.config import Settings


def _build_fixture(settings: "Settings") -> Provider:
    return FixtureProvider(object_type=settings.object_type)


def _build_opensky(settings: "Settings") -> Provider:
    return OpenSkyProvider(
        client_id=settings.opensky_client_id,
        client_secret=settings.opensky_client_secret,
        base_url=settings.opensky_base_url,
        token_url=settings.opensky_token_url,
        timeout_seconds=settings.opensky_timeout_seconds,
    )


def _build_adsblol(settings: "Settings") -> Provider:
    return AdsbLolProvider(
        base_url=settings.adsblol_base_url,
        trace_base_url=settings.adsblol_trace_base_url,
        timeout_seconds=settings.adsblol_timeout_seconds,
        user_agent=settings.adsblol_user_agent,
    )


def _build_satellites(settings: "Settings") -> Provider:
    """Positions computed from orbital elements, not fetched (D93).

    Takes no credentials and no quota settings because there are none to take:
    every source in this path is free and unauthenticated.
    """
    return SatelliteProvider(
        timeout_seconds=settings.satellite_timeout_seconds,
        user_agent=settings.adsblol_user_agent,
        refresh_seconds=settings.satellite_element_refresh_seconds,
        cache_path=settings.satellite_element_cache_path,
    )


def _build_union(settings: "Settings") -> Provider:
    """The free feed every poll, the metered one occasionally (D83)."""
    return UnionProvider(
        primary=_build_adsblol(settings),
        supplement=_build_opensky(settings),
        supplement_interval_seconds=settings.union_supplement_interval_seconds,
    )


#: Provider name -> factory taking settings.
#: Factories are lazy so that importing the registry never opens a socket or
#: reads a fixture from disk; nothing is constructed until it is selected.
_BUILDERS: Mapping[str, Callable[["Settings"], Provider]] = {
    "fixture": _build_fixture,
    "opensky": _build_opensky,
    "adsblol": _build_adsblol,
    "union": _build_union,
    "satellites": _build_satellites,
}


def available() -> tuple[str, ...]:
    return tuple(sorted(_BUILDERS))


def build(name: str, settings: "Settings" | None = None) -> Provider:
    """Construct the named provider.

    ``settings`` defaults to the cached application settings; tests pass their
    own rather than mutating the environment.

    Raises:
        KeyError: with the list of valid names, because a typo in an env var
            should fail at startup with a useful message rather than producing
            an empty globe.
    """
    try:
        builder = _BUILDERS[name]
    except KeyError:
        raise KeyError(f"unknown provider {name!r}; available: {', '.join(available())}") from None

    if settings is None:
        from app.config import get_settings

        settings = get_settings()
    return builder(settings)
