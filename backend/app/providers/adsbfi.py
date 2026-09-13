"""adsb.fi and airplanes.live: the same aircraft, from other people's aerials.

Both run the same readsb/tar1090 software adsb.lol does, so the rows that come
back are the ADSBExchange v2 shape this module's parent already parses. What
differs is the path, the key the array arrives under, and how you are let in.

**Why bother, when they mostly see the same aircraft.** Measured on 2026-09-14
across seven circles of 250 nm, against adsb.lol:

| | adsb.lol | adsb.fi | adsb.fi only |
|---|---|---|---|
| western Europe | 590 | 594 | 13 |
| eastern United States | 1,110 | 1,121 | 29 |
| south-east Asia | 27 | 27 | 1 |
| **Myanmar** | **1** | **7** | **7** |
| inland China | 0 | 0 | 0 |
| South America | 10 | 10 | 0 |
| Africa | 0 | 0 | 0 |

Three per cent overall, and that number is the *un*interesting one. The reason
the overlap is so high is `sdr-enthusiasts/docker-adsb-ultrafeeder`: one
container, one aerial, feeding adsb.lol, adsb.fi, airplanes.live, ADSBExchange
and four others at once. Swapping between community aggregators mostly
reshuffles the same volunteers.

The row that earns this file is Myanmar: one aircraft against seven. Thin
coverage is where a second network is not redundant, and thin coverage is
exactly what OpenSky used to fill before it stopped accepting connections from
data centres (D207).

**Neither serves trace files**, so neither can supply a flown path the way
adsb.lol does (`globe.adsb.fi` answers 403). `trace_base_url` is empty and the
parent already treats that as "no track from here", so a selected aircraft
still gets its path from adsb.lol.
"""

from __future__ import annotations

from app.models import BBox, TrackedObjectRecord
from app.providers.adsblol import AdsbLolProvider


class AdsbFiProvider(AdsbLolProvider):
    """Aircraft positions from adsb.fi's open data endpoint.

    No account and no key. Measured rate limit is a burst of three, then 429,
    which the inherited `_wait_turn` pacing already stays well inside at the
    intervals this project polls on.
    """

    name = "adsbfi"
    label = "adsb.fi"

    #: adsb.fi serves the identical rows under a different key.
    aircraft_key = "aircraft"

    #: Documented and confirmed: anything wider is a 400.
    max_radius_nm = 250

    def __init__(
        self,
        *,
        base_url: str = "https://opendata.adsb.fi/api/v2",
        # Empty on purpose: adsb.fi publishes no trace files, and the parent
        # reads an empty base as "this feed cannot supply a track".
        trace_base_url: str = "",
        **kwargs: object,
    ) -> None:
        super().__init__(base_url=base_url, trace_base_url=trace_base_url, **kwargs)  # type: ignore[arg-type]

    def _point_url(self, lat: float, lon: float, radius_nm: int) -> str:
        """`/lat/{lat}/lon/{lon}/dist/{nm}`, where adsb.lol has `/point/...`."""
        return f"{self.base_url}/lat/{lat}/lon/{lon}/dist/{radius_nm}"

    async def fetch(self, bbox: "BBox | None" = None) -> list[TrackedObjectRecord]:
        """A viewport, yes. The planet, no.

        **This is the limit that decides what adsb.fi is worth here.** Measured
        against the live service: 250 nm answers, 500 nm and everything above it
        is a 400. The global sweep this class inherits is four circles of 6,000
        nm, so inheriting it means four 400s every poll and a supplement that
        contributes nothing while looking configured (D208).

        Covering the planet in 250 nm circles would take hundreds of requests
        against a feed that rate-limits at a burst of three, which is not a
        trade this project can make for the three per cent it measured.

        So the global tier gets an empty list rather than four failures, and
        adsb.fi does its work on the viewport tier, where a 250 nm circle is
        usually larger than what the reader is looking at anyway. Empty rather
        than raised: there is no fault here to report, only a feed that does
        not answer that shape of question.
        """
        if bbox is None:
            return []
        return await super().fetch(bbox)


class AirplanesLiveProvider(AdsbLolProvider):
    """Aircraft positions from airplanes.live.

    **Access is by request, not by signup.** The API answers an unapproved
    caller with a 403 whose body is the instruction rather than an error:

        Please contact us at contact@airplanes.live. Your email MUST include
        any links, a description of the project, and any information you deem
        appropriate.

    So this provider is written and registered but cannot be measured until
    that mail is answered, and the coverage table above has no column for it.
    Everything below is read from their published OpenAPI document rather than
    from a response, and is marked as such where it matters: base
    `https://api.airplanes.live`, v2, the ADSBExchange `ac` shape, and the same
    `/v2/point/{lat}/{lon}/{nm}` path adsb.lol uses.

    Their spec also carries airports, airlines, countries and cities, which is
    a different thing this project already solves from a committed dataset
    (D78, D89) and is not a reason to reach for this feed.
    """

    name = "airplaneslive"
    label = "airplanes.live"

    #: Their published spec says "radius (nautical miles) of a point" with the
    #: same 250 nm cap the ADSBExchange v2 shape carries. Unverified against a
    #: live response, so it is the conservative number rather than a guess
    #: upward.
    max_radius_nm = 250

    async def fetch(self, bbox: "BBox | None" = None) -> list[TrackedObjectRecord]:
        """Same ceiling, same consequence: viewports only. See `AdsbFiProvider`."""
        if bbox is None:
            return []
        return await super().fetch(bbox)

    def __init__(
        self,
        *,
        base_url: str = "https://api.airplanes.live/v2",
        # Unverified. Their live map is tar1090, so traces may well exist at
        # this path, but a 403 answers every probe until access is granted and
        # an unchecked URL is not something to ship as though it were known.
        trace_base_url: str = "",
        **kwargs: object,
    ) -> None:
        super().__init__(base_url=base_url, trace_base_url=trace_base_url, **kwargs)  # type: ignore[arg-type]
