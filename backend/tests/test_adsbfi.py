"""adsb.fi and airplanes.live, the two feeds that share adsb.lol's shape (D208).

These providers exist because OpenSky stopped accepting connections from data
centres (D207), which left the union's supplement slot empty in the only place
the application actually runs.

What is worth testing here is exactly what differs from the parent, because
everything else is the parent's and is already covered by `test_adsblol.py`:
the path, the key the aircraft arrive under, and the fact that neither feed can
supply a flown path.
"""

from __future__ import annotations

import httpx
import pytest

from app.providers.adsbfi import AdsbFiProvider, AirplanesLiveProvider
from app.providers.adsblol import AdsbLolProvider

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


ROW = {
    "hex": "4cad80",
    "flight": "EIN723  ",
    "lat": 51.4,
    "lon": -0.2,
    "alt_baro": 29525,
    "gs": 420.0,
    "track": 91.0,
    "seen_pos": 1.0,
    "t": "A20N",
}


#: A viewport, not the globe: adsb.fi answers one and declines the other, so
#: every test about parsing has to ask the question it can actually answer.
def viewport():
    from app.models import BBox

    return BBox(lat_min=48.0, lon_min=6.0, lat_max=53.0, lon_max=14.0)


def capturing(payload: dict):
    """A transport that answers `payload` and records where it was asked."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        return httpx.Response(200, json=payload)

    return handler, seen


class TestTheThreeDifferences:
    async def test_adsbfi_asks_its_own_path_shape(self):
        """adsb.fi puts the same query at `/lat/../lon/../dist/..`.

        adsb.lol uses `/point/{lat}/{lon}/{nm}`. Same software underneath, and
        the services still chose different URLs.
        """
        handler, seen = capturing({"aircraft": [ROW]})
        p = AdsbFiProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        await p.fetch(viewport())

        assert "/lat/" in seen["url"] and "/dist/" in seen["url"], seen["url"]
        assert "/point/" not in seen["url"]

    async def test_adsbfi_reads_the_aircraft_key_not_ac(self):
        """The rows are identical; only the envelope key differs.

        Reading the wrong key does not raise, it returns nothing, which is the
        failure mode that would have looked like "adsb.fi sees no aircraft".
        """
        handler, _ = capturing({"aircraft": [ROW]})
        p = AdsbFiProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        records = await p.fetch(viewport())

        assert len(records) == 1
        assert records[0].id == "4cad80"
        assert records[0].label == "EIN723"

    async def test_neither_feed_claims_a_track_it_cannot_serve(self):
        """`globe.adsb.fi` answers 403, so a track from here would be a lie.

        The parent treats an empty trace base as "no track from this feed", and
        the point of the assertion is that it never reaches the network to find
        out: a provider that quietly tried some guessed URL would fail slowly
        instead of saying no.
        """

        def explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError(f"asked the network for a trace: {request.url}")

        for cls in (AdsbFiProvider, AirplanesLiveProvider):
            p = cls(
                client=httpx.AsyncClient(transport=httpx.MockTransport(explode)),
                min_request_interval_seconds=0.0,
            )
            assert p.trace_base_url == ""
            assert await p.fetch_track("4cad80") is None


    async def test_a_wide_viewport_is_clamped_to_what_the_feed_accepts(self):
        """The bug the unit tests missed and a live call found (D208).

        `_circle_for` will ask for up to 3,000 nm, which adsb.lol answers and
        adsb.fi refuses with a 400. The union swallows a failing supplement by
        design, so this shipped as "adsb.fi contributes nothing", visible only
        as one warning line. Clamping is the honest half-answer: the middle of
        the viewport instead of none of it.
        """
        from app.models import BBox

        handler, seen = capturing({"aircraft": [ROW]})
        p = AdsbFiProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        # A box far wider than 250 nm across.
        await p.fetch(BBox(lat_min=35.0, lon_min=-20.0, lat_max=60.0, lon_max=30.0))

        radius = int(seen["url"].rstrip("/").rsplit("/", 1)[-1])
        assert radius <= AdsbFiProvider.max_radius_nm == 250, seen["url"]

    async def test_adsblol_is_not_clamped_to_someone_elses_limit(self):
        """The global sweep is built from circles far wider than 250 nm, so
        borrowing adsb.fi's ceiling would quietly shrink the whole map."""
        from app.models import BBox

        handler, seen = capturing({"ac": [ROW]})
        p = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        await p.fetch(BBox(lat_min=35.0, lon_min=-20.0, lat_max=60.0, lon_max=30.0))

        radius = int(seen["url"].rstrip("/").rsplit("/", 1)[-1])
        assert radius > 250, f"adsb.lol was clamped to {radius} nm"


class TestTheCeilingDecidesTheRole:
    """250 nm is the whole story about what adsb.fi can be here (D208)."""

    async def test_a_global_poll_makes_no_request_at_all(self):
        """Inheriting the 6,000 nm sweep means four 400s and nothing gained.

        The failure this guards is not an exception, it is a supplement that
        looks wired up in the config and contributes zero on the tier that
        builds the map.
        """

        def explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError(f"asked for a global sweep it cannot serve: {request.url}")

        for cls in (AdsbFiProvider, AirplanesLiveProvider):
            p = cls(
                client=httpx.AsyncClient(transport=httpx.MockTransport(explode)),
                min_request_interval_seconds=0.0,
            )
            assert await p.fetch() == []

    async def test_declining_is_not_an_error_the_union_has_to_swallow(self):
        """An empty answer, not a raise: there is no fault to report here, and
        a raise would put a warning in the log every poll for a feed behaving
        exactly as documented."""
        def explode(request: httpx.Request) -> httpx.Response:  # pragma: no cover
            raise AssertionError("no request expected")

        p = AdsbFiProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(explode)),
            min_request_interval_seconds=0.0,
        )
        assert await p.fetch() == []          # does not raise

    async def test_adsblol_still_sweeps_the_globe(self):
        """The primary must keep doing the thing the supplement cannot."""
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            return httpx.Response(200, json={"ac": []})

        p = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        await p.fetch()
        assert len(calls) == 4, f"expected the four-circle sweep, got {len(calls)}"


class TestTheParentIsUnchanged:
    async def test_adsblol_still_asks_point_and_reads_ac(self):
        """The refactor that made those three things configurable must not have
        moved adsb.lol, which is the feed everything else depends on."""
        handler, seen = capturing({"ac": [ROW]})
        p = AdsbLolProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            min_request_interval_seconds=0.0,
        )
        records = await p.fetch()

        assert "/point/" in seen["url"], seen["url"]
        assert len(records) == 1
        assert p.trace_base_url, "adsb.lol is the one feed that does serve traces"

    async def test_a_feed_says_which_feed_it_is_when_it_fails(self):
        """An error that says "adsb.lol" while adsb.fi was the one that broke
        sends the reader to the wrong service."""
        from app.providers.base import ProviderUnavailable

        def refuse(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="no")

        p = AdsbFiProvider(
            client=httpx.AsyncClient(transport=httpx.MockTransport(refuse)),
            min_request_interval_seconds=0.0,
        )
        with pytest.raises(ProviderUnavailable) as caught:
            await p.fetch(viewport())

        assert "adsb.fi" in str(caught.value)
        assert "adsb.lol" not in str(caught.value)


class TestTheSupplementIsChosen:
    """The union's second feed is configuration now, not a hardcoded import."""

    def _settings(self, **kw):
        from app.config import Settings

        return Settings(**kw)

    def test_the_default_is_the_one_that_works_where_this_runs(self):
        from app.providers.registry import build

        union = build("union", self._settings())
        assert union.primary.label == "adsb.lol"
        assert union.supplement.label == "adsb.fi"

    def test_opensky_is_still_one_variable_away(self):
        """It works from a laptop, and the switch back must not have rusted."""
        from app.providers.registry import build

        union = build("union", self._settings(union_supplement="opensky"))
        assert union.supplement.name == "opensky"

    def test_an_unknown_supplement_is_refused_by_name(self):
        """Silently falling back would hide a typo in a deployment variable
        behind a map that looks fine until someone counts the aircraft."""
        from app.providers.registry import build

        with pytest.raises(ValueError) as caught:
            build("union", self._settings(union_supplement="adsbfi "))

        assert "adsbfi" in str(caught.value)
