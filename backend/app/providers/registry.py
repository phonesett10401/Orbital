"""Maps a provider name from config to a live Provider instance.

This is the whole of Orbital's pluggability story. Switching data sources is an
environment variable, not a code change:

    ORBITAL_PROVIDER=fixture   # offline development, default
    ORBITAL_PROVIDER=opensky   # live data

Adding adsb.fi or airplanes.live later means writing one module and adding one
entry to ``_BUILDERS``. Nothing in ``app.api`` or the frontend changes.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Mapping

from app.providers.base import Provider
from app.providers.fixture import FixtureProvider
from app.providers.opensky import OpenSkyProvider

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


#: Provider name -> factory taking settings.
#: Factories are lazy so that importing the registry never opens a socket or
#: reads a fixture from disk; nothing is constructed until it is selected.
_BUILDERS: Mapping[str, Callable[["Settings"], Provider]] = {
    "fixture": _build_fixture,
    "opensky": _build_opensky,
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
