"""What is in orbit around the Moon.

A separate router rather than a third value on ``ObjectType``, and the reason
is the one ``models.py`` states: the object contract is deliberately
source-agnostic, and adding a value to it is a scope decision. These are not
another kind of thing in Earth's sky - they are somewhere else entirely, with
their own coordinate frame, their own body, and no bounding box worth applying
because there are three of them.

Like ``satellites.py``, **this route performs no I/O**. The window is refreshed
on a background task, so a request cannot block on JPL or fail because JPL is
having a bad afternoon (D134).
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request

from app.models import utcnow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/moon", tags=["moon"])


@router.get(
    "/satellites",
    summary="Spacecraft currently in orbit around the Moon",
)
async def moon_satellites(request: Request) -> dict:
    """Sub-spacecraft positions on the Moon, for right now.

    Selenographic latitude and longitude with an altitude in kilometres. A
    spacecraft with no usable window is absent rather than stale: there are
    three of these and a frozen one would be indistinguishable from a tracked
    one.
    """
    tracker = getattr(request.app.state, "lunar", None)
    if tracker is None:
        return {"objects": [], "generatedAt": utcnow(), "source": "unavailable"}
    return {
        "objects": tracker.positions(),
        "generatedAt": utcnow(),
        "source": "jpl-horizons",
    }
