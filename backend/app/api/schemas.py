"""Response envelopes for the API layer.

The list endpoint wraps its objects in freshness metadata rather than returning
a bare array. The frontend has to be able to tell live data from stale data --
an aircraft's position means something quite different if it was observed nine
minutes ago -- and a bare array leaves nowhere to say so.

See docs/data-contract.md section 5.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from app.models import Airport, ObjectType, OrbitalModel, TrackedObject
from app.quota import ThrottleLevel


class ObjectListResponse(OrbitalModel):
    """A filtered, thinned set of objects plus how fresh they are."""

    objects: tuple[TrackedObject, ...] = Field(
        description="The result. Declared as TrackedObject, so meta is projected away."
    )
    type: ObjectType
    source: str | None = Field(
        default=None, description="Provider that produced the data."
    )
    fetched_at: datetime | None = Field(
        default=None, description="When the data was last retrieved from upstream."
    )
    age_seconds: float | None = Field(
        default=None, description="How old the data is now. None if never fetched."
    )
    stale: bool = Field(
        description="True once age exceeds the configured TTL, or if we never fetched."
    )
    total: int = Field(description="Objects matching the query BEFORE thinning.")
    returned: int = Field(description="Objects actually present in `objects`.")

    @property
    def thinned(self) -> bool:
        return self.returned < self.total


class JobHealth(OrbitalModel):
    """Per-job ingestion status."""

    name: str
    tier: int
    interval_seconds: float
    healthy: bool
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    consecutive_failures: int
    successful_polls: int
    failed_polls: int
    skipped_polls: int
    objects_last_poll: int | None = None


class QuotaHealth(OrbitalModel):
    """Credit balance and what we are doing about it.

    Surfaced because quota is the constraint most likely to break a live demo,
    and "the globe stopped updating" is otherwise indistinguishable from a bug.
    """

    preset: str
    daily_allowance: int
    projected_daily_credits: float
    remaining_credits: int | None = Field(
        default=None, description="Last observed X-Rate-Limit-Remaining. None before the first poll."
    )
    throttle: ThrottleLevel


class HealthResponse(OrbitalModel):
    """Everything an operator needs to answer "why does the globe look wrong?"."""

    status: str = Field(description="ok, degraded, or starting.")
    provider: str
    polling: bool
    object_count: int
    stale: bool
    age_seconds: float | None = None
    last_success_at: datetime | None = None
    quota: QuotaHealth
    jobs: tuple[JobHealth, ...]


class SearchResponse(OrbitalModel):
    """What one search box returns: aircraft now, and airports always.

    Kept as two lists rather than one merged and ranked list. They are not
    comparable - an aircraft is an observation with an age, an airport is a
    fixed place - and the client draws them as separate groups anyway.
    """

    aircraft: list[TrackedObject] = Field(
        default_factory=list,
        description="Aircraft currently held whose callsign or address matches.",
    )
    airports: list[Airport] = Field(
        default_factory=list,
        description="Airports whose code, city or name matches. No distance: there is no point to measure from.",
    )
