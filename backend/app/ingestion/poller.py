"""Scheduling, retry, backoff and quota throttling.

All timing policy lives here rather than in providers, so it is written once
and tested once instead of drifting between data sources (D9).

The poller runs one asyncio task per configured job. Under the two-tier default
(D21) that is:

* **tier 1 -- coverage.** The whole globe on a slow interval, so the display is
  populated everywhere. 4 credits per call, but 324x more area per credit than
  any bounded box.
* **tier 2 -- latency.** The client's current viewport on a fast interval, so
  the region actually under inspection stays live. Skipped whenever tier 1
  already covers it adequately, which is most of the time.

Nothing here calls the API layer and nothing here is called by it. The only
shared object is the store.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
from dataclasses import dataclass, field
from datetime import datetime

from app.config import PollJob, Settings
from app.ingestion.store import ObjectStore
from app.models import BBox, utcnow
from app.providers.base import Provider, ProviderError, ProviderRateLimited
from app.quota import ThrottleLevel, credits_for_bbox, throttle_for

logger = logging.getLogger(__name__)

#: Never wait longer than this between attempts, however many have failed. A
#: poller that has backed off to an hour looks identical to a dead one.
MAX_BACKOFF_SECONDS = 900.0

#: Multiplicative jitter applied to every delay, so that jobs which fail
#: together do not then retry together forever.
JITTER_FRACTION = 0.1


@dataclass
class JobStatus:
    """Observable state of one polling job, surfaced on /api/health."""

    name: str
    tier: int
    interval_seconds: float
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_error: str | None = None
    consecutive_failures: int = 0
    successful_polls: int = 0
    failed_polls: int = 0
    objects_last_poll: int | None = None
    skipped_polls: int = 0

    @property
    def healthy(self) -> bool:
        """Whether this job is failing.

        Deliberately not "has succeeded at least once": tier 2 legitimately
        skips every cycle until a client reports a small enough viewport, and
        reporting that as unhealthy sends whoever reads /api/health chasing a
        bug that is not there. A tier 1 job that has never polled shows up as
        the overall status "starting" instead.
        """
        return self.consecutive_failures == 0


@dataclass
class PollerStatus:
    """Everything /api/health needs to report about ingestion."""

    provider: str
    running: bool
    throttle: ThrottleLevel
    remaining_credits: int | None
    daily_allowance: int
    projected_daily_credits: float
    jobs: list[JobStatus] = field(default_factory=list)


class Poller:
    """Owns the background fetch loops.

    Args:
        provider: the data source. One attempt per call; raises on failure.
        store: where successful results are merged.
        settings: intervals, quota preset, viewport rules.
        jobs: what to poll and how often. Defaults to the configured quota
            preset, which is the aircraft layer's answer and is derived from a
            credit ladder (D21). The ships layer has no credits to ladder, so
            it passes its own single job instead (D165) - one argument rather
            than a second poller, because retry, backoff, jitter and the
            never-raise contract are written and tested once here and a copy of
            them would drift.
        sleep: injectable for tests, so timing behaviour can be asserted
            without a test suite that takes five minutes to run.
    """

    def __init__(
        self,
        provider: Provider,
        store: ObjectStore,
        settings: Settings,
        *,
        jobs: tuple[PollJob, ...] | None = None,
        sleep=asyncio.sleep,
    ) -> None:
        self.provider = provider
        self.store = store
        self.settings = settings
        self.jobs = jobs if jobs is not None else settings.jobs
        self._sleep = sleep

        self._tasks: list[asyncio.Task[None]] = []
        self._statuses: dict[str, JobStatus] = {
            job.name: JobStatus(
                name=job.name, tier=job.tier, interval_seconds=job.interval_seconds
            )
            for job in self.jobs
        }
        self._viewport: BBox | None = None
        self._rate_limited_until: float = 0.0
        self._stopping = asyncio.Event()

    # ---- lifecycle ---------------------------------------------------------

    async def start(self) -> None:
        """Launch one task per configured job."""
        if self._tasks:
            raise RuntimeError("poller already started")
        self._stopping.clear()
        for job in self.jobs:
            self._tasks.append(asyncio.create_task(self._run(job), name=f"poll-{job.name}"))
        logger.info(
            "poller started: provider=%s preset=%s jobs=%s projected=%.0f credits/day",
            self.provider.name,
            self.settings.quota_preset,
            [j.name for j in self.jobs],
            self.settings.projected_daily_credits(),
        )

    async def stop(self) -> None:
        """Cancel every task and wait for it to unwind."""
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._tasks.clear()
        await self.provider.aclose()
        logger.info("poller stopped")

    # ---- viewport ----------------------------------------------------------

    def set_viewport(self, bbox: BBox | None) -> None:
        """Record what the client is currently looking at, for tier 2.

        Snapped to a grid first; see :meth:`snap` for what that buys.
        """
        self._viewport = self.snap(bbox) if bbox is not None else None

    def snap(self, bbox: BBox) -> BBox:
        """Expand a box outward to the configured grid.

        Outward rather than to the nearest edge, so the snapped box always
        contains the real viewport -- rounding inward would leave a sliver of
        the screen unpolled.

        The purpose is **stability, not thrift**. Polls are time-driven, so a
        camera nudge does not itself trigger a request; what snapping buys is
        that consecutive polls cover the *same* area, instead of aircraft
        flickering in and out at the edges as the camera drifts by a fraction
        of a degree. A stable box also stays inside one cost band rather than
        oscillating across a boundary.
        """
        step = self.settings.focus_grid_snap_deg
        lat_min = max(-90.0, math.floor(bbox.lat_min / step) * step)
        lat_max = min(90.0, math.ceil(bbox.lat_max / step) * step)
        lon_min = max(-180.0, math.floor(bbox.lon_min / step) * step)
        lon_max = min(180.0, math.ceil(bbox.lon_max / step) * step)
        return BBox(lat_min=lat_min, lat_max=lat_max, lon_min=lon_min, lon_max=lon_max)

    def clamp_to_band(self, bbox: BBox) -> BBox:
        """Shrink a box, in whole grid steps, until it fits the 1-credit band.

        Snapping expands a box by up to one grid step per edge, which can push
        an otherwise affordable viewport into the next cost band. Skipping in
        that case would be wrong -- the user is zoomed in and wants live data --
        so instead we trim the box symmetrically about its centre.

        Trimming in whole grid steps rather than by an exact scale factor keeps
        the result grid-aligned, preserving the stability that snapping bought.

        The trimmed edges are not left uncovered: tier 1 polls them, just less
        often.
        """
        step = self.settings.focus_grid_snap_deg
        target = self.settings.focus_max_area_sq_deg
        lat_min, lat_max = bbox.lat_min, bbox.lat_max
        lon_min, lon_max = bbox.lon_min, bbox.lon_max

        while (lat_max - lat_min) * (lon_max - lon_min) > target:
            height = lat_max - lat_min
            width = lon_max - lon_min
            # Trim the longer side first, so the box tends toward square rather
            # than degenerating into a sliver.
            if height >= width and height > 2 * step:
                lat_min += step
                lat_max -= step
            elif width > 2 * step:
                lon_min += step
                lon_max -= step
            else:
                break  # already one grid cell; do not trim to nothing

        return BBox(lat_min=lat_min, lat_max=lat_max, lon_min=lon_min, lon_max=lon_max)

    def focus_bbox(self) -> BBox | None:
        """The box tier 2 should poll, or None if it should skip this cycle.

        Skipped when:

        * no client has reported a viewport yet;
        * the viewport is *very* large, because a zoomed-out camera is already
          covered by tier 1 and paying twice buys nothing;
        * the viewport wraps the antimeridian, which OpenSky cannot express and
          which we refuse to split into two billed requests (D25);
        * the current throttle level has cut the latency tier (D23).

        Otherwise the box is snapped to the grid and, if snapping pushed it out
        of the 1-credit band, trimmed back into it.
        """
        if self._viewport is None:
            return None
        if not self.throttle.allows_focus_tier:
            return None
        if self._viewport.crosses_antimeridian:
            return None

        area = self._viewport.width_deg * self._viewport.height_deg
        if area > self.settings.focus_skip_area_sq_deg:
            return None

        return self.clamp_to_band(self.snap(self._viewport))

    # ---- quota -------------------------------------------------------------

    @property
    def remaining_credits(self) -> int | None:
        """What the source says it has left, or None when it is free.

        Read straight off the interface rather than through ``getattr``. The
        defaulting form hid defect #34 for the entire life of the union
        provider: a provider missing the attribute was indistinguishable from
        one that had not been polled yet, and both read as "no throttling
        needed".
        """
        return self.provider.remaining_credits

    @property
    def throttle(self) -> ThrottleLevel:
        return throttle_for(self.remaining_credits, self.settings.daily_allowance)

    # ---- the loop ----------------------------------------------------------

    async def _run(self, job: PollJob) -> None:
        status = self._statuses[job.name]
        while not self._stopping.is_set():
            delay = await self._tick(job, status)
            try:
                await self._sleep(delay)
            except asyncio.CancelledError:
                raise

    async def _tick(self, job: PollJob, status: JobStatus) -> float:
        """Run one cycle. Returns how long to wait before the next.

        Never raises: a poller that dies on an unexpected error takes the whole
        display down with it, which is exactly the failure mode D10 exists to
        prevent.
        """
        loop_time = asyncio.get_running_loop().time()
        if loop_time < self._rate_limited_until:
            status.skipped_polls += 1
            return self._rate_limited_until - loop_time

        if not self.throttle.allows_polling:
            status.skipped_polls += 1
            logger.warning("credits exhausted; serving cache only")
            return self._jitter(MAX_BACKOFF_SECONDS)

        bbox = self._resolve_bbox(job)
        if job.tier == 2 and bbox is None:
            status.skipped_polls += 1
            return self._jitter(job.interval_seconds)

        status.last_attempt_at = utcnow()
        try:
            records = await self.provider.fetch(bbox)
        except ProviderRateLimited as exc:
            return self._handle_rate_limit(job, status, exc)
        except ProviderError as exc:
            return self._handle_failure(job, status, exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - deliberate: see docstring
            logger.exception("unexpected error in job %s", job.name)
            return self._handle_failure(job, status, exc)

        applied = self.store.apply(records, source=self.provider.name)
        status.last_success_at = utcnow()
        status.consecutive_failures = 0
        status.last_error = None
        status.successful_polls += 1
        status.objects_last_poll = applied
        logger.info(
            "job=%s applied=%d objects=%d credits=%s",
            job.name,
            applied,
            self.store.object_count,
            self.remaining_credits,
        )
        return self._scheduled_delay(job)

    def _resolve_bbox(self, job: PollJob) -> BBox | None:
        if job.tier == 2:
            return self.focus_bbox()
        return job.bbox

    def _handle_rate_limit(
        self, job: PollJob, status: JobStatus, exc: ProviderRateLimited
    ) -> float:
        status.consecutive_failures += 1
        status.failed_polls += 1
        status.last_error = str(exc)
        # Honour upstream's own retry window rather than our backoff curve
        # (D9): continuing to hammer a source that has already refused is how a
        # temporary limit becomes a longer one. Applied across all jobs, since
        # the quota is shared.
        wait = exc.retry_after if exc.retry_after is not None else MAX_BACKOFF_SECONDS
        self._rate_limited_until = asyncio.get_running_loop().time() + wait
        logger.warning("rate limited; pausing all polling for %.0fs", wait)
        return self._jitter(wait)

    def _handle_failure(self, job: PollJob, status: JobStatus, exc: Exception) -> float:
        status.consecutive_failures += 1
        status.failed_polls += 1
        status.last_error = f"{type(exc).__name__}: {exc}"
        # The store is deliberately untouched, so the API keeps serving the
        # last good snapshot (D10).
        delay = self._backoff_delay(job, status.consecutive_failures)
        logger.warning(
            "job=%s failed (%d consecutive): %s; retrying in %.0fs",
            job.name,
            status.consecutive_failures,
            status.last_error,
            delay,
        )
        return delay

    def _scheduled_delay(self, job: PollJob) -> float:
        return self._jitter(job.interval_seconds * self.throttle.interval_multiplier)

    def _backoff_delay(self, job: PollJob, failures: int) -> float:
        base = job.interval_seconds * self.throttle.interval_multiplier
        delay = min(base * (2 ** (failures - 1)), MAX_BACKOFF_SECONDS)
        return self._jitter(delay)

    @staticmethod
    def _jitter(delay: float) -> float:
        if not math.isfinite(delay):
            return MAX_BACKOFF_SECONDS
        spread = delay * JITTER_FRACTION
        return max(0.0, delay + random.uniform(-spread, spread))

    # ---- status ------------------------------------------------------------

    def status(self) -> PollerStatus:
        return PollerStatus(
            provider=self.provider.name,
            running=bool(self._tasks),
            throttle=self.throttle,
            remaining_credits=self.remaining_credits,
            daily_allowance=self.settings.daily_allowance,
            projected_daily_credits=self.settings.projected_daily_credits(),
            jobs=list(self._statuses.values()),
        )

    def credits_per_call(self, job: PollJob) -> int:
        """What one call of this job costs, for reporting and for tests."""
        if job.tier == 2:
            focus = self.focus_bbox()
            return credits_for_bbox(focus) if focus is not None else 0
        return credits_for_bbox(job.bbox)
