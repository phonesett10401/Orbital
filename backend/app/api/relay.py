"""The OpenSky relay (D216): a home connection fetches, this stores.

OpenSky refuses cloud hosts, Northflank included, and answers a home
connection. So a small script on a home PC asks ``/wanted`` whether anyone is
watching, fetches the world from OpenSky if so, and posts the raw answer to
``/opensky``. ``/wanted`` also lists aircraft whose track a visitor has just
asked for, and the relay posts each to ``/track/{id}`` (D217). Every route
needs the shared token and is off without one.
"""

from __future__ import annotations

import json
import secrets
import zlib

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.deps import get_poller, get_relay_tracks, get_settings_dep, get_store
from app.config import Settings
from app.ingestion.poller import Poller
from app.ingestion.relaytracks import RelayTracks
from app.ingestion.store import ObjectStore
from app.providers.base import ProviderBadResponse
from app.providers.opensky import OpenSkyProvider

router = APIRouter(prefix="/api/relay", tags=["relay"])

#: A world answer is about 3 MB of JSON; this is room to grow, and a ceiling on
#: what a gzip body may inflate to.
MAX_BODY_BYTES = 32 * 1024 * 1024


def _authorise(request: Request, settings: Settings) -> None:
    if not settings.relay_token:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    sent = request.headers.get("authorization", "").encode()
    if not secrets.compare_digest(sent, f"Bearer {settings.relay_token}".encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad relay token")


@router.get("/wanted", summary="Is anyone watching, and which tracks are wanted?")
def wanted(
    request: Request,
    poller: Poller = Depends(get_poller),
    tracks: RelayTracks = Depends(get_relay_tracks),
    settings: Settings = Depends(get_settings_dep),
) -> dict[str, bool | list[str]]:
    _authorise(request, settings)
    tracks.heartbeat()
    return {"wanted": poller.wanted(), "tracks": tracks.requested()}


@router.post("/track/{object_id}", summary="Supply one OpenSky /tracks/all answer")
async def track(
    object_id: str,
    request: Request,
    tracks: RelayTracks = Depends(get_relay_tracks),
    settings: Settings = Depends(get_settings_dep),
) -> dict[str, bool]:
    _authorise(request, settings)
    try:
        payload = json.loads(await request.body())
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unreadable track: {exc}")
    return {"accepted": tracks.supply(object_id.lower(), OpenSkyProvider.parse_track(payload))}


@router.post("/opensky", summary="Store one OpenSky /states/all answer")
async def opensky(
    request: Request,
    store: ObjectStore = Depends(get_store),
    settings: Settings = Depends(get_settings_dep),
) -> dict[str, int]:
    _authorise(request, settings)
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
    try:
        if request.headers.get("content-encoding") == "gzip":
            inflater = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
            body = inflater.decompress(body, MAX_BODY_BYTES)
            if inflater.unconsumed_tail:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        payload = json.loads(body)
        if not isinstance(payload, dict):
            raise ValueError("not an object")
        records = OpenSkyProvider.parse_states(payload)
    except (zlib.error, ValueError, ProviderBadResponse) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unreadable relay body: {exc}")
    applied = store.apply(records, source="opensky")
    return {"applied": applied, "objects": store.object_count}
