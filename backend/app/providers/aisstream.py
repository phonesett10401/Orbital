"""aisstream.io: ships everywhere there is a receiver.

The first source in Orbital that **pushes** rather than answers. Everything
else here is asked "where is everything right now?" and replies; this one opens
a WebSocket and talks until you stop it.

## It fits the interface anyway, and the shape was already here

``Provider.fetch()`` describes a question, and a stream is not one - so the
temptation is to bypass the provider seam and let a background task write
straight into the store. That would be a second ingestion path to keep in
agreement with the first, for one source.

It is not needed, because **the satellite layer already solved this**. That one
refreshes orbital elements on a background task and answers from memory, so no
request ever waits on an upstream (D93, D95). This is the same arrangement with
a different thing being refreshed: a task accumulates positions, ``fetch()``
returns what has accumulated. The poller, the store, the router and the
frontend cannot tell the difference, which is the whole point of the seam.

## What it actually delivers, measured

Subscribed to the whole planet with a real key:

| after | vessels | with a name |
|---|---|---|
| 15 s | 2,876 | 95% |
| 60 s | 6,379 | 95% |
| 120 s | 12,446 | 95% |
| **240 s** | **17,848** | **95%** |

Twenty-eight times what Digitraffic returns, at about 158 messages a second.
And the name arrives in the **metadata of every message**, so unlike
Digitraffic there is no second endpoint to poll and join - the 260 KB metadata
fetch and its ten-minute cache have no equivalent here.

## "Global" means "where the receivers are", and the map should not pretend

This is terrestrial AIS - volunteer coastal stations, no satellite AIS. Of
those 17,848:

| region | vessels |
|---|---|
| N Europe / Baltic | **9,202** |
| Mediterranean | 2,600 |
| US Pacific | 1,491 |
| N Atlantic | 1,417 |
| SE Asia | 310 |
| **Indian Ocean** | **2** |
| **Gulf / Red Sea** | **0** |

The Singapore Strait is the busiest waterway on earth and all of SE Asia
returns 310. That is the same shape as the OpenSky/adsb.lol comparison (D83):
comparable, different holes, free. Half of it is the Baltic, which Digitraffic
already covers - the real *gain* is the Mediterranean, the Atlantic and the US
coasts.

## The connection drops, and the first cause was us

Measured over four minutes: one disconnect, with no close frame. Then a second
run died with ``sent 1011 (internal error) keepalive ping timeout`` - which
names the culprit, because **1011 sent means the client closed it**. The
library's default 20-second pong deadline is not met while 158 messages a
second are being decoded on the same task, so it kills a connection the server
was perfectly happy with.

``ping_timeout=None`` fixes that and is not the dangerous setting it looks
like: the read loop has its own idle timeout, so a genuinely dead connection is
still noticed. What is switched off is a deadline that was measuring our own
decode loop rather than the network.

Reconnection is therefore part of the design rather than error handling.
Nothing is lost to it: the accumulated world is held here, not on the wire, and
the service does not replay anyway - its own documentation says so.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import websockets

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers import ais
from app.providers.base import Provider, ProviderUnavailable

logger = logging.getLogger(__name__)

STREAM_URL = "wss://stream.aisstream.io/v0/stream"

#: The whole planet, which is what the subscription asks for.
WORLD_BOX = [[[-90.0, -180.0], [90.0, 180.0]]]

#: Message types carrying a position we can draw.
#:
#: Class A (`PositionReport`) is commercial shipping; Class B is the smaller
#: transponder fitted to leisure and fishing craft. Both were in the live
#: sample - 5,550 and 1,478 in 45 seconds - and leaving Class B out would
#: quietly drop the smaller half of a harbour.
POSITION_TYPES = ("PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport")

#: Message types carrying a vessel's static description.
#:
#: `ShipStaticData` is Class A and carries everything - name, IMO, destination,
#: draught, dimensions. `StaticDataReport` is the Class B equivalent and is
#: split into two parts, of which part B holds the type and dimensions.
STATIC_TYPES = ("ShipStaticData", "StaticDataReport")

#: Seconds without a single message before the connection is assumed dead.
#:
#: The whole planet delivers ~158 a second, so half a minute of silence is not
#: a quiet patch - it is a socket that is open and finished. This is what makes
#: ``ping_timeout=None`` safe: the deadline that remains measures the *data*
#: rather than our own decode loop.
IDLE_TIMEOUT_SECONDS = 30.0

#: Backoff between reconnection attempts, in seconds.
RECONNECT_DELAYS = (1.0, 2.0, 5.0, 10.0, 30.0)

#: How long a vessel's *identity* is kept, against 15 minutes for its position.
#:
#: **These are different facts and pruning them together was a mistake.** A
#: position expires because a ship moves; a name and a hull type do not expire
#: at all. The first version dropped both when the position aged out, so a
#: vessel that went quiet for sixteen minutes came back anonymous and had to
#: re-earn its type over the following six.
#:
#: Six minutes is why that hurts: **static data is a separate, much rarer
#: message**. Positions arrive every few seconds, and Class A transmits its
#: name, type and dimensions every six minutes - measured at ~37 static
#: messages a second against ~158 total. Type coverage was climbing through 3%,
#: 7%, 11%, 15% over the first three minutes and each eviction reset part of
#: it.
#:
#: Six hours bounds the memory - a few hundred bytes per vessel, tens of
#: thousands of vessels - without throwing away something that is still true.
STATIC_TTL_SECONDS = 6 * 3600.0


class AisStreamProvider(Provider):
    """Ship positions accumulated from aisstream.io's global WebSocket."""

    name = "aisstream"
    object_type = ObjectType.SHIP

    def __init__(
        self,
        *,
        api_key: str,
        url: str = STREAM_URL,
        max_age_seconds: float = ais.SHIP_TTL_SECONDS,
        connect=None,
    ) -> None:
        if not api_key:
            # A blank key subscribes successfully and then receives nothing,
            # which is indistinguishable from a quiet ocean. Refused where the
            # cause is still legible.
            raise ValueError("aisstream needs an API key")
        self._api_key = api_key
        self._url = url
        self._max_age = max_age_seconds
        #: Injectable so the tests can drive a fake socket. Everything above
        #: the transport is then the real code path.
        self._connect = connect or self._default_connect
        #: MMSI -> the last position we saw. The accumulated world.
        self._positions: dict[int, dict[str, Any]] = {}
        #: MMSI -> name, type, dimensions. Arrives separately and far less
        #: often, and outlives the position by design - see
        #: ``STATIC_TTL_SECONDS``.
        self._static: dict[int, dict[str, Any]] = {}
        #: When each identity was last confirmed, for pruning it on its own
        #: much longer clock.
        self._static_at: dict[int, float] = {}
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._connected_at: float | None = None
        self._messages = 0
        self._reconnects = 0

    # ---- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Open the connection and begin accumulating, in the background.

        Started from the application's lifespan rather than lazily on the first
        ``fetch``, so that a stream which cannot connect says so in the startup
        log rather than on somebody's first request.
        """
        if self._task is not None:
            raise RuntimeError("aisstream reader already started")
        self._stopping.clear()
        self._task = asyncio.create_task(self._run(), name="aisstream-reader")

    async def aclose(self) -> None:
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    def _default_connect(self):
        return websockets.connect(
            self._url,
            # Unbounded, because the library's default queue drops messages
            # when a consumer falls behind and drops them silently.
            max_queue=None,
            # See the module docstring: the default deadline measures our own
            # decode loop, not the network, and kills a healthy connection at
            # 158 messages a second. `IDLE_TIMEOUT_SECONDS` is the deadline
            # that replaces it.
            ping_timeout=None,
        )

    # ---- the reader --------------------------------------------------------

    async def _run(self) -> None:
        """Connect, read, and reconnect for as long as the layer is up."""
        attempt = 0
        while not self._stopping.is_set():
            try:
                await self._read_until_closed()
                attempt = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - a reader that dies is an outage
                self._reconnects += 1
                delay = RECONNECT_DELAYS[min(attempt, len(RECONNECT_DELAYS) - 1)]
                attempt += 1
                logger.warning(
                    "aisstream disconnected (%s: %s); reconnecting in %.0fs",
                    type(exc).__name__,
                    exc,
                    delay,
                )
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._stopping.wait(), timeout=delay)

    async def _read_until_closed(self) -> None:
        async with self._connect() as socket:
            await socket.send(
                json.dumps({"APIKey": self._api_key, "BoundingBoxes": WORLD_BOX})
            )
            self._connected_at = time.monotonic()
            logger.info("aisstream connected, subscribed to the whole world")
            while not self._stopping.is_set():
                raw = await asyncio.wait_for(socket.recv(), timeout=IDLE_TIMEOUT_SECONDS)
                self._absorb(raw)

    def _absorb(self, raw: str | bytes) -> None:
        """Fold one message into the accumulated world.

        Never raises. A malformed message is one vessel's worth of nothing; a
        reader that died on one would be an outage of the whole layer, and this
        is a feed we do not control the shape of.
        """
        self._messages += 1
        try:
            message = json.loads(raw)
        except (ValueError, TypeError):
            return
        if not isinstance(message, dict):
            return

        kind = message.get("MessageType")
        body = (message.get("Message") or {}).get(kind) if kind else None
        metadata = message.get("MetaData") or {}
        mmsi = metadata.get("MMSI")
        if not isinstance(mmsi, int) or not isinstance(body, dict):
            return

        # **The name arrives on every message, not only the static ones.** This
        # is the single largest difference from Digitraffic, which needs a
        # separate 260 KB endpoint and a join to say what a ship is called.
        name = ais.text(metadata.get("ShipName"))
        if name:
            self._static.setdefault(mmsi, {})["name"] = name
            self._static_at[mmsi] = time.monotonic()

        if kind in POSITION_TYPES:
            self._absorb_position(mmsi, body, metadata)
        elif kind in STATIC_TYPES:
            self._absorb_static(mmsi, body)

    def _absorb_position(self, mmsi: int, body: dict, metadata: dict) -> None:
        # `Valid` is the decoder telling us it could not trust the message.
        if body.get("Valid") is False:
            return
        lat = body.get("Latitude", metadata.get("latitude"))
        lon = body.get("Longitude", metadata.get("longitude"))
        if not ais.is_position(lat, lon):
            return
        self._positions[mmsi] = {
            "lat": float(lat),
            "lon": float(lon),
            "sog": body.get("Sog"),
            "cog": body.get("Cog"),
            "heading": body.get("TrueHeading"),
            "navStat": body.get("NavigationalStatus"),
            # Our own clock. The message carries `Timestamp`, but that is the
            # *second of the minute* the position was taken - 0-59, with 60-63
            # reserved for "not available" - so it says nothing about which
            # minute, and a receiver just delivered this one.
            "at": datetime.now(timezone.utc),
        }

    def _absorb_static(self, mmsi: int, body: dict) -> None:
        static = self._static.setdefault(mmsi, {})
        self._static_at[mmsi] = time.monotonic()
        # Class B splits its static data in two, and part B is the half with
        # the type and dimensions in it.
        report_b = body.get("ReportB")
        source = report_b if isinstance(report_b, dict) and report_b.get("Valid") else body

        for key, field in (("Name", "name"), ("CallSign", "callSign"), ("Destination", "destination")):
            value = ais.text(source.get(key) or body.get(key))
            if value:
                static[field] = value

        for key, field in (("Type", "shipType"), ("ShipType", "shipType")):
            code = source.get(key, body.get(key))
            if isinstance(code, int) and not isinstance(code, bool) and code > 0:
                static[field] = code

        imo = body.get("ImoNumber")
        if isinstance(imo, int) and not isinstance(imo, bool) and imo > 0:
            static["imo"] = imo

        # **Metres already**, where Digitraffic sends decimetres. Converting
        # here would report a 1.9 m draught as 0.19 m, and it would look
        # entirely plausible on a small craft (D166).
        draught = ais.number(body.get("MaximumStaticDraught"))
        if draught is not None and draught > 0:
            static["draught"] = draught

        dimension = body.get("Dimension")
        if isinstance(dimension, dict):
            static["dimension"] = dimension

        eta = body.get("Eta")
        if isinstance(eta, dict):
            # A struct here, where Digitraffic packs the same four fields into
            # twenty bits. What they *mean* is shared.
            static["eta"] = ais.eta_text(
                month=eta.get("Month"),
                day=eta.get("Day"),
                hour=eta.get("Hour"),
                minute=eta.get("Minute"),
            )

    # ---- the interface -----------------------------------------------------

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Every vessel heard from recently, out of the accumulated world.

        Performs no I/O and never waits on the network - the reader task has
        already done that. ``bbox`` is ignored, as the contract permits: the
        whole world is in memory and the API layer filters again on the way
        out.

        Raises only when the stream has **never** connected, which is a
        configuration problem worth surfacing. Once it has, a dropped
        connection is not an outage: the accumulated world is still here and
        ages out normally, exactly as a reused OpenSky record does (D83).
        """
        if self._connected_at is None and not self._positions:
            raise ProviderUnavailable("aisstream has not connected yet")

        now = datetime.now(timezone.utc)
        records = []
        stale = []
        for mmsi, position in self._positions.items():
            age = (now - position["at"]).total_seconds()
            if age > self._max_age:
                stale.append(mmsi)
                continue
            records.append(self._to_record(mmsi, position))

        # **Pruned here, not merely filtered.** A polled source is re-read from
        # scratch every time; this one accumulates in memory for as long as the
        # process runs, so a vessel that goes quiet would otherwise be carried
        # for ever. Dropping it from the dictionary is what keeps the world
        # bounded.
        #
        # **Identities are not dropped with it.** A position expires because a
        # ship moves; a name and a hull type do not expire at all, and static
        # data arrives once every six minutes against a position every few
        # seconds. Dropping both together meant a vessel that went quiet for
        # sixteen minutes came back anonymous - see ``STATIC_TTL_SECONDS``.
        for mmsi in stale:
            self._positions.pop(mmsi, None)
        self._prune_identities()
        return records

    def _prune_identities(self) -> None:
        """Forget vessels not heard from in hours, so memory stays bounded."""
        cutoff = time.monotonic() - STATIC_TTL_SECONDS
        expired = [mmsi for mmsi, at in self._static_at.items() if at < cutoff]
        for mmsi in expired:
            self._static.pop(mmsi, None)
            self._static_at.pop(mmsi, None)

    def _to_record(self, mmsi: int, position: dict) -> TrackedObjectRecord:
        static = self._static.get(mmsi, {})
        name = static.get("name")
        return TrackedObjectRecord(
            id=str(mmsi),
            lat=position["lat"],
            lon=position["lon"],
            # Zero rather than None, for the reason an aircraft on a runway is
            # zero: a ship's height above mean sea level is not unknown, it is
            # nil (D165).
            altitude=0.0,
            velocity=ais.speed_ms(position["sog"]),
            heading=ais.heading(position["heading"], position["cog"]),
            label=name or str(mmsi),
            model=ais.ship_type(static.get("shipType")),
            last_seen=position["at"],
            type=self.object_type,
            meta=_meta(mmsi, position, static),
        )

    # ---- for the health endpoint ------------------------------------------

    @property
    def status(self) -> dict[str, Any]:
        """What the stream is doing, for logs and diagnostics."""
        return {
            "connected": self._connected_at is not None,
            "vessels": len(self._positions),
            "identities": len(self._static),
            "messages": self._messages,
            "reconnects": self._reconnects,
        }


def _meta(mmsi: int, position: dict, static: dict) -> dict[str, str]:
    """The facts a panel can show, none of them invented."""
    meta: dict[str, str] = {"mmsi": str(mmsi)}

    status = ais.nav_status(position.get("navStat"))
    if status:
        meta["navigationStatus"] = status

    if static.get("name"):
        meta["vesselName"] = static["name"]
    if static.get("callSign"):
        meta["callSign"] = static["callSign"]
    if static.get("destination"):
        meta["destination"] = static["destination"]
    if static.get("imo"):
        meta["imo"] = str(static["imo"])

    kind = ais.ship_type(static.get("shipType"))
    if kind:
        meta["shipType"] = kind

    draught = static.get("draught")
    if draught:
        meta["draught"] = f"{draught:.1f} m"

    dimension = static.get("dimension")
    if isinstance(dimension, dict):
        # A, B, C, D are distances from the transmitting antenna to bow,
        # stern, port and starboard - so the hull is A+B long and C+D wide.
        # Reported that way because a length is a fact about the ship and an
        # antenna offset is a fact about its wiring.
        bow, stern = ais.number(dimension.get("A")), ais.number(dimension.get("B"))
        port, starboard = ais.number(dimension.get("C")), ais.number(dimension.get("D"))
        if bow is not None and stern is not None and bow + stern > 0:
            meta["length"] = f"{bow + stern:.0f} m"
        if port is not None and starboard is not None and port + starboard > 0:
            meta["beam"] = f"{port + starboard:.0f} m"

    if static.get("eta"):
        meta["eta"] = static["eta"]
    return meta
