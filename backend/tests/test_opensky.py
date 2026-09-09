"""Tests for the OpenSky provider: normalization, OAuth2, and quota handling.

Everything here runs against an httpx mock transport. No test in this file
touches the network or spends a credit -- which is the point of D8, applied to
the provider that does have credentials.
"""

from __future__ import annotations

import json
from datetime import timezone
from pathlib import Path

import httpx
import pytest

from app.models import BBox, ObjectType
from app.providers.base import ProviderBadResponse, ProviderRateLimited, ProviderUnavailable
from app.providers.opensky import (
    HEADER_REMAINING,
    HEADER_RETRY_AFTER,
    TOKEN_REFRESH_MARGIN_SECONDS,
    OpenSkyProvider,
)

RAW_SAMPLE = Path(__file__).parent / "fixtures" / "opensky_raw_sample.json"


def raw_payload() -> dict:
    return json.loads(RAW_SAMPLE.read_text(encoding="utf-8"))


def make_provider(handler, **kwargs) -> OpenSkyProvider:
    """Provider wired to a mock transport instead of the network."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return OpenSkyProvider(client=client, **kwargs)


def states_handler(
    payload: dict | None = None,
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
):
    def handler(request: httpx.Request) -> httpx.Response:
        if "token" in str(request.url):
            return httpx.Response(
                200, json={"access_token": "tok-1", "expires_in": 1800}
            )
        return httpx.Response(
            status, json=payload if payload is not None else raw_payload(),
            headers=headers or {},
        )

    return handler


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


class TestNormalization:
    @pytest.mark.anyio
    async def test_maps_a_state_vector_onto_the_contract(self):
        provider = make_provider(states_handler())
        records = await provider.fetch()
        first = next(r for r in records if r.id == "a1b2c3")

        assert first.label == "UAL1234"          # callsign, whitespace stripped
        assert first.lat == pytest.approx(40.7128)
        assert first.lon == pytest.approx(-74.006)
        assert first.velocity == pytest.approx(244.3)
        assert first.heading == pytest.approx(87.5)
        assert first.type is ObjectType.AIRCRAFT
        assert first.meta["originCountry"] == "United States"
        assert first.last_seen.tzinfo == timezone.utc

    @pytest.mark.anyio
    async def test_prefers_barometric_altitude_over_geometric(self):
        # This was the other way round, and it is why Orbital showed 10,317 m
        # for a flight every other tracker had at 37,000 ft (defect #27).
        # Aviation runs on barometric altitude: a flight level *is* one, ATC
        # separates on it, and geometric altitude is a GNSS height nobody is
        # flying to. Measured over 859 aircraft, the two differ by a median of
        # 290 m and up to 846 m, so the choice is visible rather than academic.
        provider = make_provider(states_handler())
        records = await provider.fetch()
        record = next(r for r in records if r.id == "a1b2c3")
        # The fixture's baro is 10500.5 and its geo is 10668.0.
        assert record.altitude == pytest.approx(10500.5)

    @pytest.mark.anyio
    async def test_falls_back_to_geometric_when_barometric_is_missing(self):
        # Baro is reported more often than geo (749 of 859 against 727), but
        # not always, and a real geometric altitude beats no altitude at all.
        provider = make_provider(states_handler())
        records = await provider.fetch()
        assert next(r for r in records if r.id == "3c4b5a").altitude == pytest.approx(11200.0)

    @pytest.mark.anyio
    async def test_on_ground_with_no_altitude_reads_as_zero(self):
        # The one place a default is more truthful than a null.
        provider = make_provider(states_handler())
        records = await provider.fetch()
        grounded = next(r for r in records if r.id == "7c6d5e")
        assert grounded.altitude == 0.0
        assert grounded.meta["onGround"] == "true"

    @pytest.mark.anyio
    async def test_null_heading_stays_null_rather_than_becoming_zero(self):
        # Zero heading means due north; unknown heading means unknown. If these
        # collapsed, every stationary aircraft would point north on the globe.
        provider = make_provider(states_handler())
        records = await provider.fetch()
        assert next(r for r in records if r.id == "7c6d5e").heading is None

    @pytest.mark.anyio
    async def test_missing_callsign_falls_back_to_the_identifier(self):
        provider = make_provider(states_handler())
        records = await provider.fetch()
        assert next(r for r in records if r.id == "4ca1f2").label == "4ca1f2"

    @pytest.mark.anyio
    async def test_drops_rows_with_no_position_rather_than_defaulting_them(self):
        # A marker at (0, 0) looks like a real aircraft in the Gulf of Guinea.
        provider = make_provider(states_handler())
        records = await provider.fetch()
        assert not any(r.id == "badpos" for r in records)
        assert not any(r.lat == 0.0 and r.lon == 0.0 for r in records)

    @pytest.mark.anyio
    async def test_drops_truncated_and_unidentified_rows(self):
        provider = make_provider(states_handler())
        records = await provider.fetch()
        ids = {r.id for r in records}
        assert "short1" not in ids
        assert "" not in ids

    @pytest.mark.anyio
    async def test_one_bad_row_does_not_lose_the_good_ones(self):
        payload = raw_payload()
        payload["states"].append(["broken", "X", "Y", "not-a-time"])
        provider = make_provider(states_handler(payload))
        assert len(await provider.fetch()) == 5

    @pytest.mark.anyio
    async def test_identifiers_are_normalized_to_lowercase(self):
        payload = {"time": 1787659200, "states": [
            ["ABCDEF", "TEST1", "Test", 1787659195, 1787659198,
             10.0, 20.0, 1000.0, False, 100.0, 90.0, 0.0, None, 1000.0, None, False, 0]
        ]}
        provider = make_provider(states_handler(payload))
        assert (await provider.fetch())[0].id == "abcdef"

    @pytest.mark.anyio
    async def test_a_null_states_list_is_an_empty_result_not_an_error(self):
        # A quiet bounding box legitimately returns null.
        provider = make_provider(states_handler({"time": 1787659200, "states": None}))
        assert await provider.fetch() == []


# ---------------------------------------------------------------------------
# Bounding boxes
# ---------------------------------------------------------------------------


class TestBoundingBox:
    @pytest.mark.anyio
    async def test_bbox_is_sent_as_opensky_query_parameters(self):
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(request.url.params)
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler)
        await provider.fetch(BBox.parse("40,-75,45,-70"))
        assert seen == {"lamin": "40.0", "lomin": "-75.0", "lamax": "45.0", "lomax": "-70.0"}

    @pytest.mark.anyio
    async def test_no_bbox_requests_the_whole_globe(self):
        seen = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["params"] = dict(request.url.params)
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler)
        await provider.fetch(None)
        assert seen["params"] == {}

    @pytest.mark.anyio
    async def test_a_wrapping_bbox_is_refused_as_a_caller_bug(self):
        # ValueError, not ProviderError: the poller catches ProviderError only,
        # so this stays loud rather than being silently retried (D25).
        provider = make_provider(states_handler())
        with pytest.raises(ValueError, match="antimeridian"):
            await provider.fetch(BBox.parse("50,170,70,-170"))


# ---------------------------------------------------------------------------
# OAuth2
# ---------------------------------------------------------------------------


class TestAuthentication:
    @pytest.mark.anyio
    async def test_runs_anonymously_without_credentials(self):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler)
        assert not provider.authenticated
        await provider.fetch()
        assert not any("token" in url for url in calls)

    @pytest.mark.anyio
    async def test_requests_a_token_and_sends_it_as_a_bearer(self):
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            if "token" in str(request.url):
                body = request.content.decode()
                assert "grant_type=client_credentials" in body
                return httpx.Response(200, json={"access_token": "tok-1", "expires_in": 1800})
            seen["auth"] = request.headers.get("Authorization", "")
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler, client_id="id", client_secret="secret")
        await provider.fetch()
        assert seen["auth"] == "Bearer tok-1"

    @pytest.mark.anyio
    async def test_reuses_a_cached_token_across_polls(self):
        token_calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal token_calls
            if "token" in str(request.url):
                token_calls += 1
                return httpx.Response(200, json={"access_token": "tok-1", "expires_in": 1800})
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler, client_id="id", client_secret="secret")
        for _ in range(3):
            await provider.fetch()
        assert token_calls == 1

    @pytest.mark.anyio
    async def test_refreshes_before_nominal_expiry(self):
        # Refreshing on a margin rather than on a 401 keeps a refresh from
        # landing in the middle of a scheduled poll (D24).
        token_calls = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal token_calls
            if "token" in str(request.url):
                token_calls += 1
                return httpx.Response(
                    200, json={"access_token": f"tok-{token_calls}", "expires_in": 1800}
                )
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler, client_id="id", client_secret="secret")
        await provider.fetch()
        # Simulate the clock passing the refresh margin.
        provider._token_expires_at = 0.0
        await provider.fetch()
        assert token_calls == 2

    @pytest.mark.anyio
    async def test_expiry_margin_is_subtracted_from_the_lifetime(self):
        provider = make_provider(
            states_handler(), client_id="id", client_secret="secret"
        )
        await provider.fetch()
        # Cannot read the loop clock directly, but the deadline must be short of
        # a full 1800 s from now.
        import asyncio

        remaining = provider._token_expires_at - asyncio.get_running_loop().time()
        assert remaining == pytest.approx(1800 - TOKEN_REFRESH_MARGIN_SECONDS, abs=2.0)

    @pytest.mark.anyio
    async def test_a_401_forces_exactly_one_refresh_and_retry(self):
        # A clock skew between our host and theirs would otherwise be
        # unrecoverable.
        attempts = {"token": 0, "states": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            if "token" in str(request.url):
                attempts["token"] += 1
                return httpx.Response(200, json={"access_token": "tok", "expires_in": 1800})
            attempts["states"] += 1
            if attempts["states"] == 1:
                return httpx.Response(401, json={"error": "expired"})
            return httpx.Response(200, json=raw_payload())

        provider = make_provider(handler, client_id="id", client_secret="secret")
        assert len(await provider.fetch()) == 5
        assert attempts["token"] == 2
        assert attempts["states"] == 2

    @pytest.mark.anyio
    async def test_a_persistent_401_gives_up_rather_than_looping(self):
        def handler(request: httpx.Request) -> httpx.Response:
            if "token" in str(request.url):
                return httpx.Response(200, json={"access_token": "tok", "expires_in": 1800})
            return httpx.Response(401, json={"error": "nope"})

        provider = make_provider(handler, client_id="id", client_secret="secret")
        with pytest.raises(ProviderBadResponse):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_a_failed_token_request_is_an_upstream_failure(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="auth down")

        provider = make_provider(handler, client_id="id", client_secret="secret")
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_a_malformed_token_response_is_a_bad_response(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"no_token_here": True})

        provider = make_provider(handler, client_id="id", client_secret="secret")
        with pytest.raises(ProviderBadResponse):
            await provider.fetch()


# ---------------------------------------------------------------------------
# Quota headers and failure mapping
# ---------------------------------------------------------------------------


class TestQuotaHeaders:
    @pytest.mark.anyio
    async def test_records_remaining_credits_from_the_response(self):
        provider = make_provider(states_handler(headers={HEADER_REMAINING: "3820"}))
        await provider.fetch()
        assert provider.remaining_credits == 3820

    @pytest.mark.anyio
    async def test_infers_what_the_last_request_cost(self):
        responses = iter(["3824", "3820"])

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json=raw_payload(), headers={HEADER_REMAINING: next(responses)}
            )

        provider = make_provider(handler)
        await provider.fetch()
        await provider.fetch()
        assert provider.last_request_credits == 4  # a global call

    @pytest.mark.anyio
    async def test_a_missing_header_leaves_the_balance_unknown(self):
        provider = make_provider(states_handler())
        await provider.fetch()
        assert provider.remaining_credits is None

    @pytest.mark.anyio
    async def test_an_unparseable_header_does_not_break_the_poll(self):
        provider = make_provider(states_handler(headers={HEADER_REMAINING: "lots"}))
        assert len(await provider.fetch()) == 5
        assert provider.remaining_credits is None


class TestFailureMapping:
    @pytest.mark.anyio
    async def test_429_becomes_rate_limited_with_the_upstream_retry_window(self):
        provider = make_provider(
            states_handler(
                {"error": "limit"},
                status=429,
                headers={HEADER_RETRY_AFTER: "600", HEADER_REMAINING: "0"},
            )
        )
        with pytest.raises(ProviderRateLimited) as caught:
            await provider.fetch()
        assert caught.value.retry_after == 600.0
        assert provider.remaining_credits == 0

    @pytest.mark.anyio
    async def test_429_without_a_retry_header_still_raises(self):
        provider = make_provider(states_handler({"error": "limit"}, status=429))
        with pytest.raises(ProviderRateLimited) as caught:
            await provider.fetch()
        assert caught.value.retry_after is None

    @pytest.mark.anyio
    async def test_server_errors_are_upstream_unavailability(self):
        provider = make_provider(states_handler({"error": "boom"}, status=503))
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_a_timeout_is_upstream_unavailability(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("too slow", request=request)

        provider = make_provider(handler)
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_a_connection_error_is_upstream_unavailability(self):
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        provider = make_provider(handler)
        with pytest.raises(ProviderUnavailable):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_non_json_is_a_bad_response(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>maintenance</html>")

        provider = make_provider(handler)
        with pytest.raises(ProviderBadResponse):
            await provider.fetch()

    @pytest.mark.anyio
    async def test_a_json_list_instead_of_an_object_is_a_bad_response(self):
        provider = make_provider(states_handler([1, 2, 3]))
        with pytest.raises(ProviderBadResponse):
            await provider.fetch()


class TestDescribe:
    """An error message that says nothing is a defect (D194).

    Production logged `token request failed:` - the whole message - for a day,
    because `str(exc)` is empty for most of httpx's connection errors and the
    format string had nothing else in it.
    """

    def test_names_the_exception_when_it_carries_no_message(self):
        import httpx

        from app.providers.opensky import describe

        # The real case: httpx raises these with no arguments at all.
        assert describe(httpx.ConnectError("")) == "ConnectError"
        assert describe(httpx.ConnectTimeout("")) == "ConnectTimeout"

    def test_keeps_the_message_when_there_is_one(self):
        from app.providers.opensky import describe

        assert describe(ValueError("no such realm")) == "ValueError: no such realm"

    def test_never_returns_something_empty(self):
        import httpx

        from app.providers.opensky import describe

        # The property that matters: whatever is thrown, the log line has
        # content. A blank one sent a day's diagnosis down the wrong path.
        for exc in [
            httpx.ConnectError(""),
            httpx.ReadTimeout(""),
            httpx.RemoteProtocolError(""),
            ValueError(""),
            RuntimeError("   "),
        ]:
            assert describe(exc).strip() != ""
