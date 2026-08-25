"""Aircraft endpoints.

Every route here reads the store and returns. **Nothing in this module performs
I/O or calls a provider**, which is precisely why an OpenSky outage cannot
produce a 5xx: there is no upstream call in the request path to fail.

The endpoints are named for aircraft because that is what they serve. Another
layer would add a parallel router over the same store, thinning and envelope
code -- no change here.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.schemas import ObjectListResponse
from app.api.deps import get_poller, get_settings_dep, get_store
from app.config import Settings
from app.ingestion.poller import Poller
from app.ingestion.store import ObjectStore
from app.models import BBox, ObjectType, TrackedObject, TrackedObjectDetail
from app.thinning import thin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/aircraft", tags=["aircraft"])


def _parse_bbox(raw: str | None) -> BBox | None:
    if raw is None:
        return None
    try:
        return BBox.parse(raw)
    except ValueError as exc:
        # A malformed bbox is the client's mistake, so say so precisely rather
        # than silently serving the whole globe and looking like a bug.
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _envelope(
    records,
    *,
    store: ObjectStore,
    settings: Settings,
    total: int,
) -> ObjectListResponse:
    return ObjectListResponse(
        objects=tuple(TrackedObject.model_validate(r.model_dump()) for r in records),
        type=settings.object_type,
        source=store.source,
        fetched_at=store.last_success_at,
        age_seconds=store.age_seconds(),
        stale=store.is_stale(),
        total=total,
        returned=len(records),
    )


@router.get(
    "",
    response_model=ObjectListResponse,
    summary="Aircraft in a bounding box",
)
def list_aircraft(
    request: Request,
    bbox: str | None = Query(
        default=None,
        description="latMin,lonMin,latMax,lonMax. Omit for the whole globe. "
        "A box with lonMin > lonMax wraps the antimeridian.",
        examples=["30,-100,50,-80"],
    ),
    limit: int | None = Query(
        default=None,
        gt=0,
        description="Maximum objects to return. Defaults to the configured thinning cap.",
    ),
    store: ObjectStore = Depends(get_store),
    settings: Settings = Depends(get_settings_dep),
    poller: Poller = Depends(get_poller),
) -> ObjectListResponse:
    """Return the aircraft currently held, filtered and thinned.

    Always answers 200 with whatever the store holds, marking the data `stale`
    when it is older than the TTL. Returning an error because upstream is down
    would push a backend problem into the rendering layer, which is exactly
    what the three-layer split exists to prevent (D10).
    """
    box = _parse_bbox(bbox)

    # Telling the poller what the client is looking at is what drives tier 2.
    # It is a hint, not a command: the poller decides whether the box is worth
    # a credit (D21, D27).
    if box is not None:
        poller.set_viewport(box)

    matching = store.get(box)
    cap = limit or settings.max_objects_per_response
    selected = thin(matching, cap, box)

    return _envelope(selected, store=store, settings=settings, total=len(matching))


@router.get(
    "/search",
    response_model=ObjectListResponse,
    summary="Find aircraft by callsign or identifier",
)
def search_aircraft(
    q: str = Query(min_length=1, description="Callsign or ICAO24 address, full or partial."),
    limit: int = Query(default=20, gt=0, le=100),
    store: ObjectStore = Depends(get_store),
    settings: Settings = Depends(get_settings_dep),
) -> ObjectListResponse:
    """Search every held aircraft, not just those in the current view.

    Server-side because the client only holds what it is looking at, and
    "search for a flight by callsign" has to work for a flight on the other
    side of the world.

    Route ordering note: this is declared before ``/{object_id}`` so that
    ``/api/aircraft/search`` is not swallowed as an id lookup. It could not
    collide in practice -- an ICAO24 address is six hex digits, and "search"
    is not hex -- but relying on that would be fragile.
    """
    results = store.search(q, limit=limit)
    return _envelope(results, store=store, settings=settings, total=len(results))


@router.get(
    "/{object_id}",
    response_model=TrackedObjectDetail,
    summary="One aircraft with its observed track",
    responses={404: {"description": "Not currently tracked"}},
)
def get_aircraft(
    object_id: str,
    store: ObjectStore = Depends(get_store),
) -> TrackedObjectDetail:
    """Return one aircraft in full, including `meta` and its observed route.

    The 404 here means "not currently in the store", which covers both an id
    that never existed and one that has aged out. The distinction is not
    something we can make -- we have no history beyond the ring buffer -- so
    claiming otherwise would be a lie.
    """
    detail = store.get_detail(object_id.strip().lower())
    if detail is None:
        raise HTTPException(status_code=404, detail=f"aircraft {object_id!r} is not tracked")
    if detail.type is not ObjectType.AIRCRAFT:  # pragma: no cover - type guard
        raise HTTPException(status_code=404, detail="not an aircraft")
    return detail
