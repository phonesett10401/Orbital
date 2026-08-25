"""Maps a provider name from config to a live Provider instance.

This is the whole of Orbital's pluggability story. Switching data sources is an
environment variable, not a code change:

    ORBITAL_PROVIDER=fixture   # offline development, default
    ORBITAL_PROVIDER=opensky   # live data (added in M2)

Adding adsb.fi or airplanes.live later means writing one module and adding one
entry to ``_BUILDERS``. Adding the phase 2 satellite provider works the same
way -- which is the point -- but no such provider exists yet.
"""

from __future__ import annotations

from typing import Callable, Mapping

from app.providers.base import Provider
from app.providers.fixture import FixtureProvider

#: Provider name -> zero-argument factory.
#: Factories are lazy so that importing the registry never opens a socket or
#: reads a fixture from disk; nothing is constructed until it is selected.
_BUILDERS: Mapping[str, Callable[[], Provider]] = {
    "fixture": FixtureProvider,
}


def available() -> tuple[str, ...]:
    return tuple(sorted(_BUILDERS))


def build(name: str) -> Provider:
    """Construct the named provider.

    Raises:
        KeyError: with the list of valid names, because a typo in an env var
            should fail at startup with a useful message rather than producing
            an empty globe.
    """
    try:
        builder = _BUILDERS[name]
    except KeyError:
        raise KeyError(f"unknown provider {name!r}; available: {', '.join(available())}") from None
    return builder()
