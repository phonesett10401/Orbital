"""Satellite endpoints.

A parallel router to ``aircraft.py``, as that module's docstring anticipated -
same thinning, same envelope, same bounding box. One thing differs, and it is
the interesting part: **there is no store behind this one.**

The aircraft layer polls an upstream on a schedule and serves the last snapshot
it received, because that is the only option: nobody can compute where an
aircraft is. A satellite position *is* computable, from elements that stay
usable for days. Storing a snapshot would mean serving a position that was true
a moment ago when an exact one costs 21 ms of arithmetic for the whole
catalogue. So this router propagates on request (D95).

What that removes is worth naming: no poll interval, no staleness flag that can
go true, no eviction TTL, no dead reckoning on the client, and no quota. What
it keeps is the property the aircraft router was built around - **no route here
performs I/O**. Element refreshes run on their own task, so a request cannot
block on, or fail because of, an upstream that is down. That is not theoretical
comfort: CelesTrak returned 503 for the entire day this was written.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from app.api.deps import get_settings_dep
from app.api.schemas import ObjectListResponse
from app.config import Settings
from app.models import BBox, ObjectType, TrackedObject, TrackedObjectDetail, TrackSource
from app.providers.satellites import SatelliteProvider
from app.thinning import thin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/satellites", tags=["satellites"])


def get_satellites(request: Request) -> SatelliteProvider | None:
    """The satellite catalogue, or None when the layer is switched off."""
    return getattr(request.app.state, "satellites", None)


def _catalogue(provider: SatelliteProvider | None) -> SatelliteProvider:
    if provider is None:
        # 404 rather than 503: the layer is not configured, which is a
        # permanent property of this deployment, not a transient failure.
        raise HTTPException(status_code=404, detail="the satellite layer is not enabled")
    return provider


def _parse_instant(raw: str | None) -> datetime | None:
    """An ISO 8601 instant, or ``None`` for now.

    A naive timestamp is read as UTC rather than rejected: the client sends
    what its clock says and a satellite position is meaningless in local time
    anyway, so guessing UTC is both the only useful reading and the one the
    rest of this layer already assumes.

    **The seven-day bound is not enforced here.** It belongs to ``propagate``,
    which measures it per element set against that set's own epoch - and those
    epochs differ by hours across the catalogue, so one check at the door would
    have to invent a single epoch that does not exist. An instant too far from
    a given set makes *that* object drop out with a logged reason, which is the
    same behaviour as an element set that has gone stale (D119).
    """
    if raw is None:
        return None
    # A `+` in a query string decodes to a space, so an offset written
    # `+00:00` arrives as ` 00:00` unless the client percent-encoded it. Every
    # client gets this wrong once; refusing them teaches nothing. The space can
    # only have been a plus here, because ISO 8601 has no other use for one.
    candidate = raw.strip()
    if " " in candidate and "T" in candidate:
        head, _, tail = candidate.rpartition(" ")
        if tail and (tail[0].isdigit() or tail[0] == ":"):
            candidate = head + "+" + tail
    try:
        parsed = datetime.fromisoformat(candidate.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(
            status_code=422, detail=f"could not read {raw!r} as an ISO 8601 instant"
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _parse_bbox(raw: str | None) -> BBox | None:
    if raw is None:
        return None
    try:
        return BBox.parse(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get(
    "",
    response_model=ObjectListResponse,
    summary="Every satellite currently on orbit",
)
async def list_satellites(
    request: Request,
    bbox: str | None = Query(default=None, description="latMin,lonMin,latMax,lonMax"),
    limit: int | None = Query(default=None, ge=1, description="Cap after thinning."),
    at: str | None = Query(
        default=None,
        description=(
            "ISO 8601 instant to compute positions for. Past or future, within "
            "seven days of each element set's epoch. Omit for now."
        ),
    ),
    settings: Settings = Depends(get_settings_dep),
    provider: SatelliteProvider | None = Depends(get_satellites),
) -> ObjectListResponse:
    catalogue = _catalogue(provider)
    box = _parse_bbox(bbox)
    when = _parse_instant(at)

    records = catalogue.positions(box, at=when)
    total = len(records)
    cap = limit or settings.max_objects_per_response
    if total > cap:
        records = thin(records, cap, box)

    # **No ETag here, deliberately.** The aircraft list is cacheable because it
    # only changes when a poll lands, so `store.updates_applied` is a real
    # version number. A satellite list changes on every request by design -
    # that is what computing rather than polling means - so a conditional
    # request could only ever be answered one of two ways: a 200 that the
    # validator did not help with, or a 304 that serves the client its own
    # older body and freezes the sky. The second is defect #14 exactly, where a
    # 304 froze the data age at a few seconds because the cached body was
    # returned instead of a current one (D47, D95).
    payload = ObjectListResponse(
        objects=tuple(TrackedObject.model_validate(r.model_dump()) for r in records),
        type=ObjectType.SATELLITE,
        source=catalogue.element_source,
        # Deliberately null: these fields answer "how old is this data", and a
        # computed position has no age. The element age that *does* vary is
        # per-object and travels in each record's meta (D94), because one
        # number for the whole catalogue would be a fiction - the sets were
        # measured at different times.
        fetched_at=None,
        age_seconds=None,
        stale=False,
        total=total,
        returned=len(records),
    )

    return payload


@router.get(
    "/{object_id}",
    response_model=TrackedObjectDetail,
    summary="One satellite, with the orbit it is on",
)
async def get_satellite(
    object_id: str,
    provider: SatelliteProvider | None = Depends(get_satellites),
) -> TrackedObjectDetail:
    catalogue = _catalogue(provider)
    for record in catalogue.positions():
        if record.id == object_id:
            return TrackedObjectDetail(
                **record.model_dump(),
                # The path is left empty here on purpose. For an aircraft a
                # track is *observed* and accumulates as we watch; for a
                # satellite it is computable in either direction, which is a
                # different thing to build and belongs with the panel that
                # displays it rather than smuggled in now.
                track=(),
                track_source=TrackSource.PROVIDER,
                origin=None,
                route=None,
            )
    raise HTTPException(status_code=404, detail=f"no satellite with id {object_id!r}")
