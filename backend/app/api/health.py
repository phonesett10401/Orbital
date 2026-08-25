"""Health and diagnostics.

Exists to answer one question quickly: *why does the globe look wrong?* An
empty or frozen display can mean upstream is down, credits are exhausted, the
provider is misconfigured, or nothing has been polled yet -- and from the
frontend those are indistinguishable.

Reports 200 even when degraded. This endpoint describes the system; it is not
itself a failure signal, and returning 503 would make a monitoring tool report
"health check down" when the answer is "OpenSky is down and we are coping".
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_poller, get_settings_dep, get_store
from app.api.schemas import HealthResponse, JobHealth, QuotaHealth
from app.config import Settings
from app.ingestion.poller import Poller
from app.ingestion.store import ObjectStore

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Ingestion status")
def health(
    store: ObjectStore = Depends(get_store),
    poller: Poller = Depends(get_poller),
    settings: Settings = Depends(get_settings_dep),
) -> HealthResponse:
    status = poller.status()

    if store.last_success_at is None:
        # Not an error: the first poll may simply not have landed yet.
        overall = "starting"
    elif store.is_stale() or any(j.consecutive_failures for j in status.jobs):
        overall = "degraded"
    else:
        overall = "ok"

    return HealthResponse(
        status=overall,
        provider=status.provider,
        polling=status.running,
        object_count=store.object_count,
        stale=store.is_stale(),
        age_seconds=store.age_seconds(),
        last_success_at=store.last_success_at,
        quota=QuotaHealth(
            preset=settings.quota_preset,
            daily_allowance=status.daily_allowance,
            projected_daily_credits=status.projected_daily_credits,
            remaining_credits=status.remaining_credits,
            throttle=status.throttle,
        ),
        jobs=tuple(
            JobHealth(
                name=job.name,
                tier=job.tier,
                interval_seconds=job.interval_seconds,
                healthy=job.healthy,
                last_attempt_at=job.last_attempt_at,
                last_success_at=job.last_success_at,
                last_error=job.last_error,
                consecutive_failures=job.consecutive_failures,
                successful_polls=job.successful_polls,
                failed_polls=job.failed_polls,
                skipped_polls=job.skipped_polls,
                objects_last_poll=job.objects_last_poll,
            )
            for job in status.jobs
        ),
    )
