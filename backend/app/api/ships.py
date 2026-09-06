"""Ship endpoints.

A third router beside ``aircraft.py`` and ``satellites.py``, and the one that
finally tests what those two only claimed: that adding a layer touches nothing
already here. It does not import from either of them, share a store with
either, or add a branch to either.

It is shaped like the **aircraft** router rather than the satellite one, and
which of the two a new layer resembles is decided by a single question: *can
the position be computed?* A satellite's can, from elements that stay usable
for days, so that router propagates on request and holds no store (D95). A
ship's cannot, any more than an aircraft's - somebody has to have heard it - so
this one polls on a schedule and serves the last snapshot, with everything that
follows from it: a staleness flag, an eviction TTL, and dead reckoning on the
client.

What it does *not* inherit from the aircraft router is worth naming, because
both are absences rather than omissions:

**No viewport hint.** Tier 2 exists to spend a credit on the region a reader is
watching. Digitraffic charges nothing and accepts no bounding box, so there is
no second tier to feed and telling the poller where the camera is would inform
nobody (D165).

**No enrichment on selection.** ``flights.enrich`` and ``routes.enrich`` buy an
aircraft's origin and destination from two further services, because a position
feed does not carry them. AIS does: a vessel transmits its own destination,
draught and ETA, and they are already in ``meta`` by the time this router sees
them. So selecting a ship performs no I/O at all - this router keeps the
property the aircraft one has to work for.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.api.deps import get_settings_dep
from app.api.etag import compute_etag, if_none_match_matches
from app.api.schemas import ObjectListResponse
from app.config import Settings
from app.ingestion.store import ObjectStore
from app.models import BBox, ObjectType, TrackedObject, TrackedObjectDetail
from app.thinning import thin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/ships", tags=["ships"])


def get_ship_store(request: Request) -> ObjectStore | None:
    """The ships store, or None when the layer is switched off."""
    return getattr(request.app.state, "ship_store", None)


def _store(store: ObjectStore | None) -> ObjectStore:
    if store is None:
        # 404 rather than 503, exactly as the satellite router does: the layer
        # is not configured, which is a permanent property of this deployment
        # and not a transient failure to retry.
        raise HTTPException(status_code=404, detail="the ships layer is not enabled")
    return store


def _parse_bbox(raw: str | None) -> BBox | None:
    if raw is None:
        return None
    try:
        return BBox.parse(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _envelope(records, *, store: ObjectStore, total: int) -> ObjectListResponse:
    return ObjectListResponse(
        objects=tuple(TrackedObject.model_validate(r.model_dump()) for r in records),
        # ``ObjectType.SHIP`` rather than ``settings.object_type``, which names
        # the *aircraft* source and would label every ship an aeroplane. The
        # aircraft router can read it from settings because there it happens to
        # be right; here it happens to be wrong, and the difference is not
        # something a reader of that line would notice.
        type=ObjectType.SHIP,
        source=store.source,
        fetched_at=store.last_success_at,
        age_seconds=store.age_seconds(),
        stale=store.is_stale(),
        total=total,
        returned=len(records),
    )


@router.get("", response_model=ObjectListResponse, summary="Ships in a bounding box")
def list_ships(
    request: Request,
    response: Response,
    bbox: str | None = Query(
        default=None,
        description="latMin,lonMin,latMax,lonMax. Omit for the whole feed. "
        "A box with lonMin > lonMax wraps the antimeridian.",
        examples=["59,20,61,26"],
    ),
    limit: int | None = Query(
        default=None,
        gt=0,
        description="Maximum objects to return. Defaults to the configured thinning cap.",
    ),
    store: ObjectStore | None = Depends(get_ship_store),
    settings: Settings = Depends(get_settings_dep),
) -> ObjectListResponse:
    """Return the vessels currently held, filtered and thinned.

    Always 200 with whatever the store holds, marked ``stale`` past the TTL -
    the same contract as the aircraft router, for the same reason (D10).

    The thinning cap is shared with that layer and will not be reached here:
    the whole feed is about 900 vessels against a cap of 2,000. It is applied
    anyway rather than skipped, because "the source is small today" is not a
    property worth encoding in a route.
    """
    held = _store(store)
    box = _parse_bbox(bbox)
    cap = limit or settings.max_objects_per_response

    etag = compute_etag(
        version=held.updates_applied,
        object_type=ObjectType.SHIP.value,
        bbox=box,
        limit=cap,
        stale=held.is_stale(),
        source=held.source,
    )
    headers = {"ETag": etag, "Cache-Control": "no-cache"}
    if if_none_match_matches(request.headers.get("if-none-match"), etag):
        return Response(status_code=304, headers=headers)
    response.headers.update(headers)

    matching = held.get(box)
    selected = thin(matching, cap, box)
    return _envelope(selected, store=held, total=len(matching))


@router.get(
    "/search",
    response_model=ObjectListResponse,
    summary="Find ships by name or MMSI",
)
def search_ships(
    q: str = Query(min_length=1, description="Vessel name or MMSI, full or partial."),
    limit: int = Query(default=20, gt=0, le=100),
    store: ObjectStore | None = Depends(get_ship_store),
) -> ObjectListResponse:
    """Search every held vessel, not only those in view.

    Declared before ``/{object_id}`` so that ``/api/ships/search`` is not
    swallowed as an id lookup. Here that ordering is doing real work rather
    than being a precaution: a ship's id is its MMSI, which is digits, and the
    route would otherwise match and then 404 on a vessel called "search".

    Name and MMSI only. A vessel's call sign is in ``meta`` and is not
    searched, because the store matches ``label`` and ``id`` and nothing else -
    widening that is a change to the store, shared with two other layers, and
    not something to do quietly from here.
    """
    held = _store(store)
    results = held.search(q, limit=limit)
    return _envelope(results, store=held, total=len(results))


@router.get(
    "/{object_id}",
    response_model=TrackedObjectDetail,
    summary="One ship with its observed track",
    responses={404: {"description": "Not currently tracked"}},
)
def get_ship(
    object_id: str,
    store: ObjectStore | None = Depends(get_ship_store),
) -> TrackedObjectDetail:
    """Return one vessel in full, including ``meta`` and its observed track.

    Synchronous, and that is the interesting part: the aircraft equivalent is
    ``async`` because it buys a flight track and a route from two further
    services on the user's click. A ship transmits its own destination and ETA,
    so there is nothing left to buy and no await to make.

    The 404 covers both an MMSI that never existed and one that has aged out.
    We cannot tell those apart - there is no history beyond the ring buffer -
    so it does not claim to.
    """
    detail = _store(store).get_detail(object_id.strip())
    if detail is None:
        raise HTTPException(status_code=404, detail=f"ship {object_id!r} is not tracked")
    if detail.type is not ObjectType.SHIP:  # pragma: no cover - type guard
        raise HTTPException(status_code=404, detail="not a ship")
    return detail
