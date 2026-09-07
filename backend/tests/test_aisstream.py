"""Tests for the aisstream provider.

Offline, but not by faking the provider: a stand-in socket is handed real
messages captured off the live stream, and everything above the transport is
the code that runs in production - the reader loop, the reconnection, the
accumulation, the pruning and the mapping.

The interesting thing about this provider is that it **pushes**, and the two
consequences of that are what most of these cover:

- ``fetch`` performs no I/O and can be asked before anything has arrived.
- The world is held in memory for as long as the process runs, so a vessel that
  goes quiet has to be *removed* rather than merely filtered. A polled source
  is re-read from scratch each time and cannot leak; this one can.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from app.providers.ais import SHIP_TTL_SECONDS
from app.providers.aisstream import STATIC_TTL_SECONDS, AisStreamProvider
from app.providers.base import ProviderUnavailable

# Real messages, captured off the live stream.
POSITION = {
    "MessageType": "PositionReport",
    "MetaData": {
        "MMSI": 538010726,
        "ShipName": "PRINCESS SEAWAYS",
        "latitude": 37.28853166666667,
        "longitude": -25.534336666666665,
    },
    "Message": {
        "PositionReport": {
            "MessageID": 1,
            "Valid": True,
            "NavigationalStatus": 0,
            "Sog": 12.2,
            "Cog": 266.3,
            "TrueHeading": 264,
            "Latitude": 37.28853166666667,
            "Longitude": -25.534336666666665,
        }
    },
}

STATIC = {
    "MessageType": "ShipStaticData",
    "MetaData": {"MMSI": 538010726, "ShipName": "PRINCESS SEAWAYS"},
    "Message": {
        "ShipStaticData": {
            "CallSign": "9HB5714",
            "Destination": "PALMA",
            "Dimension": {"A": 22, "B": 22, "C": 5, "D": 4},
            "Eta": {"Day": 0, "Hour": 24, "Minute": 60, "Month": 0},
            "ImoNumber": 9721592,
            "MaximumStaticDraught": 1.9,
            "Name": "SILVER WIND",
            "Type": 37,
            "Valid": True,
        }
    },
}

CLASS_B = {
    "MessageType": "StandardClassBPositionReport",
    "MetaData": {"MMSI": 368111130, "ShipName": "LITTLE ONE"},
    "Message": {
        "StandardClassBPositionReport": {
            "MessageID": 18,
            "Valid": True,
            "Sog": 0.1,
            "Cog": 175,
            "TrueHeading": 269,
            "Latitude": 11.23922,
            "Longitude": -74.21956333333333,
        }
    },
}


class FakeSocket:
    """A stand-in for the WebSocket, replaying messages then behaving as asked.

    ``after`` decides what happens once the script runs out: ``"hang"`` blocks
    for ever (a healthy connection with nothing new), ``"drop"`` raises (the
    thing that really happens about once every four minutes).
    """

    def __init__(self, messages, after="hang"):
        self.messages = [json.dumps(m) if isinstance(m, dict) else m for m in messages]
        self.after = after
        self.sent: list[str] = []
        self.index = 0

    def __call__(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def send(self, payload):
        self.sent.append(payload)

    async def recv(self):
        if self.index < len(self.messages):
            self.index += 1
            return self.messages[self.index - 1]
        if self.after == "drop":
            raise ConnectionError("no close frame received or sent")
        await asyncio.Event().wait()  # never returns


async def provider_with(messages, after="hang", **kwargs) -> AisStreamProvider:
    """A started provider that has already absorbed ``messages``."""
    socket = FakeSocket(messages, after=after)
    provider = AisStreamProvider(api_key="test-key", connect=socket, **kwargs)
    provider._socket = socket  # type: ignore[attr-defined]
    await provider.start()
    for _ in range(50):
        await asyncio.sleep(0)
        if socket.index >= len(socket.messages):
            break
    await asyncio.sleep(0.02)
    return provider


class TestSubscribing:
    @pytest.mark.anyio
    async def test_it_asks_for_the_whole_world_with_the_key(self) -> None:
        provider = await provider_with([POSITION])
        sent = json.loads(provider._socket.sent[0])  # type: ignore[attr-defined]
        assert sent["APIKey"] == "test-key"
        assert sent["BoundingBoxes"] == [[[-90.0, -180.0], [90.0, 180.0]]]
        await provider.aclose()

    @pytest.mark.anyio
    async def test_a_blank_key_is_refused_where_the_cause_is_legible(self) -> None:
        # A blank key subscribes successfully and then receives nothing, which
        # on a map is indistinguishable from a quiet ocean.
        with pytest.raises(ValueError):
            AisStreamProvider(api_key="")


class TestAccumulating:
    @pytest.mark.anyio
    async def test_a_position_becomes_a_vessel(self) -> None:
        provider = await provider_with([POSITION])
        records = await provider.fetch()
        assert len(records) == 1
        assert records[0].id == "538010726"
        assert records[0].lat == pytest.approx(37.2885, abs=0.001)
        assert records[0].lon == pytest.approx(-25.5343, abs=0.001)
        await provider.aclose()

    @pytest.mark.anyio
    async def test_the_name_arrives_without_a_static_message(self) -> None:
        # **The largest difference from Digitraffic.** There the name needs a
        # separate 260 KB endpoint and a join; here it is in the metadata of
        # every message, so 95% of vessels are named within seconds (D166).
        provider = await provider_with([POSITION])
        assert (await provider.fetch())[0].label == "PRINCESS SEAWAYS"
        await provider.aclose()

    @pytest.mark.anyio
    async def test_class_b_vessels_are_kept_too(self) -> None:
        # Class B is the smaller transponder on leisure and fishing craft -
        # 1,478 of 7,028 position reports in one live sample. Dropping it would
        # quietly lose the smaller half of a harbour.
        provider = await provider_with([CLASS_B])
        assert [r.id for r in await provider.fetch()] == ["368111130"]
        await provider.aclose()

    @pytest.mark.anyio
    async def test_static_data_fills_in_the_type_and_the_voyage(self) -> None:
        provider = await provider_with([POSITION, STATIC])
        record = (await provider.fetch())[0]
        assert record.model == "Pleasure craft"
        assert record.meta["destination"] == "PALMA"
        assert record.meta["imo"] == "9721592"
        assert record.meta["length"] == "44 m"
        assert record.meta["beam"] == "9 m"
        await provider.aclose()

    @pytest.mark.anyio
    async def test_the_draught_is_metres_here(self) -> None:
        # **The conversion that must not be shared.** aisstream sends 1.9 for
        # 1.9 m; Digitraffic sends 82 for 8.2 m. Dividing here would report a
        # 1.9 m draught as 0.19 m, and on a small craft that looks plausible.
        provider = await provider_with([POSITION, STATIC])
        assert (await provider.fetch())[0].meta["draught"] == "1.9 m"
        await provider.aclose()

    @pytest.mark.anyio
    async def test_an_unset_eta_is_not_reported(self) -> None:
        # The live sample's first static message had Month 0, Day 0, Hour 24,
        # Minute 60 - the all-sentinels case, which is the common one.
        provider = await provider_with([POSITION, STATIC])
        assert "eta" not in (await provider.fetch())[0].meta
        await provider.aclose()

    @pytest.mark.anyio
    async def test_sea_level_is_zero_not_unknown(self) -> None:
        provider = await provider_with([POSITION])
        assert (await provider.fetch())[0].altitude == 0.0
        await provider.aclose()


class TestRubbishOnTheWire:
    """A reader that dies on one message is an outage of the whole layer."""

    @pytest.mark.anyio
    async def test_malformed_json_is_one_vessel_of_nothing(self) -> None:
        provider = await provider_with(["{not json", POSITION])
        assert len(await provider.fetch()) == 1
        await provider.aclose()

    @pytest.mark.anyio
    async def test_a_message_with_no_position_is_skipped(self) -> None:
        broken = json.loads(json.dumps(POSITION))
        broken["Message"]["PositionReport"]["Latitude"] = 91.0
        broken["MetaData"]["latitude"] = 91.0
        provider = await provider_with([broken])
        # Empty rather than an error: we are connected and heard something, it
        # simply had no fix in it. The refusal is reserved for a stream that
        # has *never* connected, which is a configuration problem rather than
        # a quiet ocean - see TestBeforeAnythingArrives.
        assert await provider.fetch() == []
        await provider.aclose()

    @pytest.mark.anyio
    async def test_a_message_the_decoder_flagged_invalid_is_skipped(self) -> None:
        invalid = json.loads(json.dumps(POSITION))
        invalid["Message"]["PositionReport"]["Valid"] = False
        provider = await provider_with([invalid, CLASS_B])
        assert [r.id for r in await provider.fetch()] == ["368111130"]
        await provider.aclose()


class TestTheWorldStaysBounded:
    """A stream accumulates; a poll does not. Only one of them can leak."""

    @pytest.mark.anyio
    async def test_a_vessel_that_goes_quiet_is_dropped(self) -> None:
        provider = await provider_with([POSITION])
        # Age the accumulated position past the TTL.
        for position in provider._positions.values():
            position["at"] = datetime.now(timezone.utc) - timedelta(
                seconds=SHIP_TTL_SECONDS + 60
            )
        assert await provider.fetch() == []
        await provider.aclose()

    @pytest.mark.anyio
    async def test_the_position_is_removed_rather_than_merely_hidden(self) -> None:
        # Filtering on the way out would leave the dictionary growing for the
        # life of the process - every vessel ever heard, for ever. A polled
        # source cannot make this mistake because it is re-read from scratch.
        provider = await provider_with([POSITION, STATIC])
        for position in provider._positions.values():
            position["at"] = datetime.now(timezone.utc) - timedelta(
                seconds=SHIP_TTL_SECONDS + 60
            )
        await provider.fetch()
        assert provider._positions == {}
        await provider.aclose()

    @pytest.mark.anyio
    async def test_the_vessel_keeps_its_identity_when_its_position_expires(self) -> None:
        # **This test asserted the opposite, and the opposite was wrong.** A
        # position expires because a ship moves; a name and a hull type do not
        # expire at all. Dropping both together meant a vessel that went quiet
        # for sixteen minutes came back anonymous and had to re-earn its type
        # over the following six - and static data is a *six-minute* message
        # against a position every few seconds, so that is expensive. Live
        # type coverage was climbing through 3%, 7%, 11%, 15% and every
        # eviction gave part of it back (D166).
        provider = await provider_with([POSITION, STATIC])
        for position in provider._positions.values():
            position["at"] = datetime.now(timezone.utc) - timedelta(
                seconds=SHIP_TTL_SECONDS + 60
            )
        await provider.fetch()
        assert provider._static[538010726]["name"] == "SILVER WIND"
        assert provider._static[538010726]["shipType"] == 37
        await provider.aclose()

    @pytest.mark.anyio
    async def test_an_identity_nobody_has_heard_in_hours_is_forgotten(self) -> None:
        # Kept for hours rather than for ever: the memory has to stay bounded,
        # it is just bounded on the clock the fact actually lives on.
        provider = await provider_with([POSITION, STATIC])
        for mmsi in list(provider._static_at):
            provider._static_at[mmsi] -= STATIC_TTL_SECONDS + 60
        await provider.fetch()
        assert provider._static == {}
        await provider.aclose()

    @pytest.mark.anyio
    async def test_a_vessel_heard_from_recently_is_kept(self) -> None:
        provider = await provider_with([POSITION])
        for position in provider._positions.values():
            position["at"] = datetime.now(timezone.utc) - timedelta(seconds=60)
        assert len(await provider.fetch()) == 1
        await provider.aclose()


class TestBeforeAnythingArrives:
    @pytest.mark.anyio
    async def test_fetching_before_the_first_connection_says_so(self) -> None:
        # Distinct from "the ocean is empty", which is what returning [] would
        # claim. The poller treats this as a failure and keeps its last good
        # snapshot (D10).
        provider = AisStreamProvider(api_key="k", connect=FakeSocket([]))
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_fetch_never_waits_on_the_network(self) -> None:
        # The reader task has already done the waiting. This is the property
        # that lets the API layer promise no route performs I/O (D95).
        provider = await provider_with([POSITION])
        await asyncio.wait_for(provider.fetch(), timeout=0.5)
        await provider.aclose()


class TestReconnection:
    @pytest.mark.anyio
    async def test_a_dropped_connection_is_reconnected(self) -> None:
        # Measured live: about one disconnect every four minutes, and the first
        # cause was our own keepalive deadline (D166). It is part of the design
        # rather than error handling.
        provider = await provider_with([POSITION], after="drop")
        await asyncio.sleep(0.05)
        assert provider.status["reconnects"] >= 1
        await provider.aclose()

    @pytest.mark.anyio
    async def test_the_accumulated_world_survives_the_drop(self) -> None:
        # Nothing is lost to a reconnection, because the world is held here
        # rather than on the wire - and the service does not replay anyway.
        provider = await provider_with([POSITION], after="drop")
        await asyncio.sleep(0.05)
        assert len(await provider.fetch()) == 1
        await provider.aclose()


class TestStatus:
    @pytest.mark.anyio
    async def test_it_reports_what_the_stream_is_doing(self) -> None:
        provider = await provider_with([POSITION, STATIC])
        status = provider.status
        assert status["connected"] is True
        assert status["vessels"] == 1
        assert status["messages"] >= 2
        await provider.aclose()


# AIS message 19: a position report that *also* carries a name, a ship type and
# hull dimensions. Real, off the live stream.
EXTENDED_CLASS_B = {
    "MessageType": "ExtendedClassBPositionReport",
    "MetaData": {"MMSI": 477996378, "ShipName": "NEW LEGEND 18"},
    "Message": {
        "ExtendedClassBPositionReport": {
            "MessageID": 19,
            "Valid": True,
            "Cog": 261.7,
            "Sog": 0,
            "TrueHeading": 511,
            "Latitude": 22.29879833333333,
            "Longitude": 113.94418999999999,
            "Name": "NEW LEGEND 18",
            "Type": 60,
            "Dimension": {"A": 10, "B": 5, "C": 2, "D": 2},
        }
    },
}


class TestMessageNineteenIsBothThings:
    """A position report that is also a static report.

    The first version listed it as a position type and used `elif`, so every
    vessel that identifies itself this way stayed grey for ever. Found by
    asking which message types carry a `Type` field rather than by re-reading
    the list: 17 in 160 seconds, every one carrying it, every one ignored
    (D166).
    """

    @pytest.mark.anyio
    async def test_its_position_is_taken(self) -> None:
        provider = await provider_with([EXTENDED_CLASS_B])
        record = (await provider.fetch())[0]
        assert record.lat == pytest.approx(22.2988, abs=0.001)
        await provider.aclose()

    @pytest.mark.anyio
    async def test_its_type_is_taken_too(self) -> None:
        # The whole defect. A vessel reporting only this way was drawn grey.
        provider = await provider_with([EXTENDED_CLASS_B])
        assert (await provider.fetch())[0].model == "Passenger"
        await provider.aclose()

    @pytest.mark.anyio
    async def test_its_dimensions_are_taken_too(self) -> None:
        provider = await provider_with([EXTENDED_CLASS_B])
        assert (await provider.fetch())[0].meta["length"] == "15 m"
        await provider.aclose()
