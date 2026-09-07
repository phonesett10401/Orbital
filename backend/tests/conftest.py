"""Shared pytest configuration.

``anyio_backend`` pins async tests to asyncio. Without it, anyio's plugin would
also try to run every async test under trio, which we do not depend on.

``_settings_ignore_local_env`` is the more important one: it stops the suite
reading the developer's own ``.env``.
"""

from __future__ import annotations

import os

import httpx
import pytest

from app.config import Settings
from app.ingestion.flightroutes import FlightRoutes


@pytest.fixture(autouse=True, scope="session")
def _settings_ignore_local_env():
    """Insulate every ``Settings()`` in the suite from the local ``.env``.

    A test that builds ``Settings(provider="fixture")`` is stating the whole
    configuration it means to test. It was not: pydantic fills every field the
    call omits from the environment and from ``.env``, so the suite's result
    depended on an untracked file that differs per machine.

    That was always true when pytest ran from ``backend/`` - it simply never
    showed, because the values that happened to be in the file were compatible.
    The day ``.env`` changed to ``union``/``union``, twelve tests began erroring
    on a preset none of them had asked for: ``provider="fixture"`` from the call
    and ``quota_preset="union"`` from the file, a combination that projects
    8,640 credits a day and is correctly refused (D114).

    The suite is not the place to discover that. A test asserts a claim about a
    configuration it names, so anything it does not name must come from the
    defaults in ``config.py`` and nowhere else.
    """
    original = Settings.model_config.get("env_file")
    Settings.model_config["env_file"] = None
    removed = {k: v for k, v in os.environ.items() if k.startswith("ORBITAL_")}
    for key in removed:
        del os.environ[key]
    # **The three optional layers are off unless a test asks for them.**
    #
    # They default to *on* in `config.py`, correctly: each costs nothing to run
    # and a deployment should get them without being asked. But `create_app`
    # with default settings then starts a Digitraffic poller, a CelesTrak
    # element refresh and a JPL Horizons task - so any test that builds an app
    # to assert something about aircraft was quietly calling three third-party
    # services it never mentions.
    #
    # It was invisible until ships arrived, because a ship poll fires
    # immediately and then every sixty seconds: the suite went from 156 s to
    # over 400 s, and three ETag tests began failing in the full run while
    # passing alone. Neither symptom named the cause, and the second one is the
    # worse of the two - a test that fails only in company is a test nobody
    # trusts.
    #
    # Set as environment rather than by editing the defaults, because init
    # arguments beat the environment in pydantic-settings: a test that says
    # `ship_layer_enabled=True` still gets it, and a test that says nothing
    # makes no outbound calls. That is the standing rule this suite already had
    # for the aircraft provider (D114), applied to the layers beside it.
    os.environ["ORBITAL_SHIP_LAYER_ENABLED"] = "false"
    os.environ["ORBITAL_SATELLITE_LAYER_ENABLED"] = "false"
    os.environ["ORBITAL_LUNAR_LAYER_ENABLED"] = "false"
    try:
        yield
    finally:
        Settings.model_config["env_file"] = original
        for key in (
            "ORBITAL_SHIP_LAYER_ENABLED",
            "ORBITAL_SATELLITE_LAYER_ENABLED",
            "ORBITAL_LUNAR_LAYER_ENABLED",
        ):
            os.environ.pop(key, None)
        os.environ.update(removed)


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
