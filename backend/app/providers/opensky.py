"""The live data source: OpenSky Network state vectors.

Two things make this provider more than a thin HTTP wrapper.

**Authentication.** OpenSky removed HTTP basic auth; access is now an OAuth2
client-credentials grant. Tokens last roughly 30 minutes -- shorter than a
demo -- so the provider refreshes them transparently and nothing above it knows
tokens exist (D24).

**Quota.** ``/states/all`` is billed by requested area, not per request, and the
response carries the remaining balance. The provider records that balance so the
poller can throttle against ground truth rather than against a projection (D23).

Everything about retry timing and scheduling stays in the poller (D9). This
class performs exactly one attempt and raises a typed error.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Sequence

import httpx

from app.models import BBox, ObjectType, TrackedObjectRecord
from app.providers.base import (
    Provider,
    ProviderBadResponse,
    ProviderRateLimited,
    ProviderUnavailable,
)

logger = logging.getLogger(__name__)

# Indices into an OpenSky state vector. The API returns positional arrays, which
# are unreadable at the call site; naming them here is the whole reason this
# module exists rather than the raw indices leaking upstream into our code.
_ICAO24 = 0
_CALLSIGN = 1
_ORIGIN_COUNTRY = 2
_TIME_POSITION = 3
_LAST_CONTACT = 4
_LONGITUDE = 5
_LATITUDE = 6
_BARO_ALTITUDE = 7
_ON_GROUND = 8
_VELOCITY = 9
_TRUE_TRACK = 10
_GEO_ALTITUDE = 13

#: Refresh this many seconds before nominal expiry, so a refresh never lands in
#: the middle of a scheduled poll and a modest clock skew stays survivable.
TOKEN_REFRESH_MARGIN_SECONDS = 60.0

HEADER_REMAINING = "X-Rate-Limit-Remaining"
HEADER_RETRY_AFTER = "X-Rate-Limit-Retry-After-Seconds"


class OpenSkyProvider(Provider):
    """Fetches aircraft state vectors from OpenSky Network."""

    name = "opensky"
    object_type = ObjectType.AIRCRAFT

    def __init__(
        self,
        *,
        client_id: str = "",
        client_secret: str = "",
        base_url: str = "https://opensky-network.org/api",
        token_url: str = (
            "https://auth.opensky-network.org/auth/realms/opensky-network/"
            "protocol/openid-connect/token"
        ),
        timeout_seconds: float = 20.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.base_url = base_url.rstrip("/")
        self.token_url = token_url
        # Injectable so tests can drive a mock transport rather than the network.
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None

        self._token: str | None = None
        self._token_expires_at: float = 0.0
        self._token_lock = asyncio.Lock()

        #: Last observed X-Rate-Limit-Remaining, or None before the first poll.
        #: Read by the poller (D23) and surfaced on /api/health.
        self.remaining_credits: int | None = None
        self.last_request_credits: int | None = None

    @property
    def authenticated(self) -> bool:
        """Whether credentials are configured.

        Without them OpenSky still answers, but on the 400/day anonymous
        allowance rather than 4000.
        """
        return bool(self.client_id and self.client_secret)

    # ---- authentication ----------------------------------------------------

    async def _get_token(self, *, force: bool = False) -> str | None:
        """Return a valid access token, refreshing if needed.

        Returns None when running anonymously, which is a supported mode rather
        than an error.
        """
        if not self.authenticated:
            return None

        loop_time = asyncio.get_running_loop().time()
        if not force and self._token and loop_time < self._token_expires_at:
            return self._token

        # Serialize refreshes: without the lock, several concurrent polls would
        # each request a token and all but one would be wasted.
        async with self._token_lock:
            loop_time = asyncio.get_running_loop().time()
            if not force and self._token and loop_time < self._token_expires_at:
                return self._token
            return await self._request_token()

    async def _request_token(self) -> str:
        try:
            response = await self._client.post(
                self.token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"token request failed: {exc}") from exc

        if response.status_code != 200:
            raise ProviderUnavailable(
                f"token request returned {response.status_code}: {response.text[:200]}"
            )

        try:
            payload = response.json()
            token = payload["access_token"]
            expires_in = float(payload.get("expires_in", 1800))
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderBadResponse(f"malformed token response: {exc}") from exc

        self._token = token
        self._token_expires_at = asyncio.get_running_loop().time() + max(
            0.0, expires_in - TOKEN_REFRESH_MARGIN_SECONDS
        )
        logger.info("obtained OpenSky token, valid for %.0fs", expires_in)
        return token

    # ---- fetching ----------------------------------------------------------

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Fetch one snapshot.

        ``bbox`` of None requests the whole globe. A bbox that crosses the
        antimeridian is rejected: OpenSky cannot express a wrapping box, and
        splitting it into two requests would silently double the credit cost and
        break the budget guarantee that startup validation makes. The caller is
        expected to skip such a request -- tier 1 already covers that area.
        """
        if bbox is not None and bbox.crosses_antimeridian:
            raise ValueError(
                "OpenSky cannot express a bbox crossing the antimeridian; "
                "the caller must skip this request rather than split it (see D25)"
            )

        payload = await self._request_states(bbox, retry_on_401=True)
        states = payload.get("states")
        if states is None:
            # A quiet box legitimately returns null rather than an empty list.
            return []
        if not isinstance(states, list):
            raise ProviderBadResponse("'states' was not a list")

        fallback_time = self._parse_epoch(payload.get("time"))
        records = []
        for state in states:
            record = self._to_record(state, fallback_time)
            if record is not None:
                records.append(record)
        return records

    async def _request_states(
        self, bbox: BBox | None, *, retry_on_401: bool
    ) -> dict[str, Any]:
        token = await self._get_token()
        headers = {"Authorization": f"Bearer {token}"} if token else {}

        params: dict[str, float] = {}
        if bbox is not None:
            params = {
                "lamin": bbox.lat_min,
                "lomin": bbox.lon_min,
                "lamax": bbox.lat_max,
                "lomax": bbox.lon_max,
            }

        try:
            response = await self._client.get(
                f"{self.base_url}/states/all", params=params, headers=headers
            )
        except httpx.TimeoutException as exc:
            raise ProviderUnavailable(f"OpenSky timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise ProviderUnavailable(f"OpenSky request failed: {exc}") from exc

        self._record_credit_headers(response)

        if response.status_code == 429:
            raise ProviderRateLimited(
                "OpenSky rate limit reached",
                retry_after=self._parse_retry_after(response),
            )
        if response.status_code == 401 and retry_on_401 and self.authenticated:
            # A clock skew between our host and theirs would otherwise be
            # unrecoverable, so force exactly one refresh-and-retry.
            logger.warning("OpenSky returned 401; forcing token refresh")
            await self._get_token(force=True)
            return await self._request_states(bbox, retry_on_401=False)
        if response.status_code >= 500:
            raise ProviderUnavailable(f"OpenSky returned {response.status_code}")
        if response.status_code != 200:
            raise ProviderBadResponse(
                f"OpenSky returned {response.status_code}: {response.text[:200]}"
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise ProviderBadResponse(f"OpenSky response was not JSON: {exc}") from exc
        if not isinstance(payload, dict):
            raise ProviderBadResponse("OpenSky response was not an object")
        return payload

    def _record_credit_headers(self, response: httpx.Response) -> None:
        raw = response.headers.get(HEADER_REMAINING)
        if raw is None:
            return
        try:
            previous = self.remaining_credits
            self.remaining_credits = int(raw)
        except ValueError:
            logger.warning("unparseable %s header: %r", HEADER_REMAINING, raw)
            return
        if previous is not None and previous >= self.remaining_credits:
            self.last_request_credits = previous - self.remaining_credits
        logger.info(
            "OpenSky credits remaining: %d (last request cost %s)",
            self.remaining_credits,
            self.last_request_credits if self.last_request_credits is not None else "?",
        )

    @staticmethod
    def _parse_retry_after(response: httpx.Response) -> float | None:
        raw = response.headers.get(HEADER_RETRY_AFTER)
        if raw is None:
            return None
        try:
            return max(0.0, float(raw))
        except ValueError:
            logger.warning("unparseable %s header: %r", HEADER_RETRY_AFTER, raw)
            return None

    # ---- normalization -----------------------------------------------------

    @staticmethod
    def _parse_epoch(value: Any) -> datetime | None:
        if value is None:
            return None
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (TypeError, ValueError, OSError, OverflowError):
            return None

    def _to_record(
        self, state: Sequence[Any], fallback_time: datetime | None
    ) -> TrackedObjectRecord | None:
        """Map one state vector to the normalized shape, or None if unusable.

        Returning None rather than a placeholder is deliberate: an object with
        no position must be dropped, never emitted at (0, 0), which would look
        like a real aircraft in the Gulf of Guinea.
        """
        if not isinstance(state, (list, tuple)) or len(state) <= _TRUE_TRACK:
            logger.debug("skipping malformed state vector: %r", state)
            return None

        icao24 = state[_ICAO24]
        lat = state[_LATITUDE]
        lon = state[_LONGITUDE]
        if not icao24 or lat is None or lon is None:
            return None

        identifier = str(icao24).strip().lower()
        callsign = state[_CALLSIGN]
        label = str(callsign).strip() if callsign else ""

        on_ground = bool(state[_ON_GROUND])
        altitude = self._first_number(
            state[_GEO_ALTITUDE] if len(state) > _GEO_ALTITUDE else None,
            state[_BARO_ALTITUDE],
        )
        if altitude is None and on_ground:
            # On the ground with no reported altitude is genuinely zero, not
            # unknown -- the one place a default is more truthful than a null.
            altitude = 0.0

        last_seen = (
            self._parse_epoch(state[_LAST_CONTACT])
            or self._parse_epoch(state[_TIME_POSITION])
            or fallback_time
            or datetime.now(timezone.utc)
        )

        try:
            return TrackedObjectRecord(
                id=identifier,
                lat=float(lat),
                lon=float(lon),
                altitude=altitude,
                velocity=self._first_number(state[_VELOCITY]),
                heading=self._first_number(state[_TRUE_TRACK]),
                label=label or identifier,
                last_seen=last_seen,
                type=ObjectType.AIRCRAFT,
                meta=self._build_meta(state),
            )
        except (ValueError, TypeError) as exc:
            # One bad row must not lose the other ten thousand.
            logger.debug("skipping unusable state vector %s: %s", identifier, exc)
            return None

    @staticmethod
    def _build_meta(state: Sequence[Any]) -> dict[str, str]:
        meta: dict[str, str] = {}
        country = state[_ORIGIN_COUNTRY]
        if country:
            meta["originCountry"] = str(country).strip()
        if bool(state[_ON_GROUND]):
            meta["onGround"] = "true"
        return meta

    @staticmethod
    def _first_number(*values: Any) -> float | None:
        """First value that is a real number, else None.

        Guards the null-versus-zero distinction the contract depends on: a
        missing measurement stays None rather than collapsing to 0.
        """
        for value in values:
            if value is None or isinstance(value, bool):
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if number != number:  # NaN
                continue
            return number
        return None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()
