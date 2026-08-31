"""One search box, two kinds of answer.

The search bar used to look up callsigns only, which meant it could answer
"where is UAL1234" and not "what is flying at Heathrow" - and the second is how
people actually think about air traffic. Both live here rather than under
`/api/aircraft` because an airport is not an aircraft, and hanging it off that
router would have been a lie of filing.

**One request, not two.** The client asks on every keystroke, so the two
lookups are merged into a single response rather than left as two endpoints for
the browser to fan out to and reassemble. It also means the ranking of one kind
against the other stays a server decision, where the data is.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.airports import search_airports
from app.api.deps import get_store
from app.api.schemas import SearchResponse
from app.ingestion.store import ObjectStore

router = APIRouter(prefix="/api/search", tags=["search"])


@router.get(
    "",
    response_model=SearchResponse,
    summary="Find aircraft and airports by one query",
)
def search(
    q: str = Query(min_length=1, description="Callsign, ICAO24 address, airport code or place."),
    limit: int = Query(default=8, gt=0, le=50, description="Maximum of each kind."),
    store: ObjectStore = Depends(get_store),
) -> SearchResponse:
    """Aircraft currently held, and airports from the static table.

    The two are searched independently and returned separately rather than
    interleaved: they are different kinds of thing, the client draws them as
    separate groups, and any single ranking across them would be inventing a
    comparison that does not exist. An aircraft is something we are watching
    now; an airport is a place that is always there.
    """
    return SearchResponse(
        aircraft=store.search(q, limit=limit),
        airports=search_airports(q, limit=limit),
    )
