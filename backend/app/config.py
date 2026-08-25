"""Environment-driven configuration.

Everything that might reasonably differ between a developer's machine, a
teammate's machine and demo day lives here. In particular the polling strategy
is configuration, not code: switching from the two-tier default to a pure
region-set strategy is an env var, even though the arithmetic in D21 argues
against it.

Credentials are read from the environment or a local ``.env`` file, which is
git-ignored. ``.env.example`` documents the names with empty values.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.models import BBox, ObjectType
from app.quota import (
    ANONYMOUS_DAILY_CREDITS,
    AUTHENTICATED_DAILY_CREDITS,
    CONTRIBUTOR_DAILY_CREDITS,
    credits_for_area,
    credits_for_bbox,
    daily_credits,
)


class PollJob(BaseModel):
    """One scheduled fetch: what area, how often, and why.

    ``bbox`` of ``None`` means the whole globe. ``tier`` records the job's
    purpose, which is what D21 assigns the budget by:

    * tier 1 buys **coverage** -- the globe stays populated
    * tier 2 buys **latency** -- the region under inspection stays live
    """

    name: str
    bbox: BBox | None = None
    interval_seconds: float = Field(gt=0)
    tier: int = Field(ge=1, le=2)

    @property
    def cost_per_call(self) -> int:
        return credits_for_bbox(self.bbox)

    @property
    def projected_daily_credits(self) -> float:
        return daily_credits(self.interval_seconds, self.cost_per_call)


#: Named polling presets, one per quota level. See D21 for the arithmetic.
#:
#: Tier 2's bbox is None here because it is supplied at runtime from the
#: client's viewport; only its interval is configured.
PRESETS: dict[str, tuple[PollJob, ...]] = {
    # 400 credits/day. A 20-minute global refresh and no live tier: this is a
    # demo-only mode so the project runs at all without credentials.
    "anonymous": (
        PollJob(name="global", bbox=None, interval_seconds=1200.0, tier=1),
    ),
    # 4000 credits/day. 1152 + 1920 = 3072/day, 77% of budget, 23% headroom.
    "authenticated": (
        PollJob(name="global", bbox=None, interval_seconds=300.0, tier=1),
        PollJob(name="viewport", bbox=None, interval_seconds=45.0, tier=2),
    ),
    # 8000 credits/day. 1920 + 2880 = 4800/day, 60% of budget.
    "contributor": (
        PollJob(name="global", bbox=None, interval_seconds=180.0, tier=1),
        PollJob(name="viewport", bbox=None, interval_seconds=30.0, tier=2),
    ),
}

DAILY_ALLOWANCES: dict[str, int] = {
    "anonymous": ANONYMOUS_DAILY_CREDITS,
    "authenticated": AUTHENTICATED_DAILY_CREDITS,
    "contributor": CONTRIBUTOR_DAILY_CREDITS,
}


class Settings(BaseSettings):
    """Application settings, all overridable by ``ORBITAL_``-prefixed env vars."""

    model_config = SettingsConfigDict(
        env_prefix="ORBITAL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- data source -------------------------------------------------------
    provider: str = Field(
        default="fixture",
        description="Which provider to run. 'fixture' needs no credentials (D8).",
    )
    object_type: ObjectType = ObjectType.AIRCRAFT

    # ---- OpenSky credentials ----------------------------------------------
    # Basic auth was removed upstream; these feed the OAuth2 client-credentials
    # grant. Empty means anonymous access, which still works but at 400/day.
    opensky_client_id: str = ""
    opensky_client_secret: str = ""
    opensky_base_url: str = "https://opensky-network.org/api"
    opensky_token_url: str = (
        "https://auth.opensky-network.org/auth/realms/opensky-network/"
        "protocol/openid-connect/token"
    )
    opensky_timeout_seconds: float = Field(default=20.0, gt=0)

    # ---- quota -------------------------------------------------------------
    quota_preset: str = Field(
        default="authenticated",
        description="Which polling preset to run: anonymous, authenticated, contributor.",
    )
    daily_credit_budget: int | None = Field(
        default=None,
        description="Override the preset's daily allowance. None uses the published value.",
    )
    budget_safety_fraction: float = Field(
        default=0.85,
        gt=0.0,
        le=1.0,
        description=(
            "Fraction of the daily allowance the configured jobs may project to "
            "consume. Startup fails above this, so a bad interval is caught before "
            "it spends a day's credits."
        ),
    )

    # ---- tier 2 (viewport) behaviour ---------------------------------------
    focus_max_area_sq_deg: float = Field(
        default=25.0,
        gt=0.0,
        description=(
            "Trim the snapped viewport box down to this area before polling. "
            "25 sq deg is the top of the 1-credit band, so tier 2 always costs "
            "exactly one credit and the daily projection stays exact."
        ),
    )
    focus_skip_area_sq_deg: float = Field(
        default=400.0,
        gt=0.0,
        description=(
            "Skip the viewport poll entirely when the camera box is larger than "
            "this. A zoomed-out view is already covered by tier 1, so paying "
            "twice buys nothing."
        ),
    )
    focus_grid_snap_deg: float = Field(
        default=1.0,
        gt=0.0,
        description=(
            "Snap the viewport box to this grid before polling, so consecutive "
            "polls cover the same area instead of aircraft flickering in and out "
            "at the edges as the camera drifts. Finer than the trim threshold so "
            "snapping never costs much area."
        ),
    )

    # ---- store -------------------------------------------------------------
    snapshot_ttl_seconds: float | None = Field(
        default=None,
        gt=0,
        description=(
            "Age past which the API marks its data stale. None derives it as twice "
            "the longest poll interval, which is the only value that cannot be stale "
            "by construction. Set it explicitly only with that in mind."
        ),
    )
    object_ttl_seconds: float = Field(
        default=1800.0,
        gt=0,
        description="Drop an object not re-observed within this window. Longer than "
        "snapshot TTL so a briefly missing aircraft keeps its track history.",
    )
    track_history_points: int = Field(
        default=50,
        ge=2,
        description="Ring buffer length per object. This is the route (D6).",
    )

    # ---- API ---------------------------------------------------------------
    max_objects_per_response: int = Field(
        default=2000,
        gt=0,
        description="Thinning cap. See D15.",
    )
    cors_origins: tuple[str, ...] = (
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    )

    @property
    def longest_interval(self) -> float:
        return max(job.interval_seconds for job in self.jobs)

    @property
    def snapshot_ttl(self) -> float:
        """Effective staleness threshold.

        Derived rather than fixed because the anonymous preset polls every 20
        minutes; a hardcoded 10-minute TTL would mark every one of its responses
        stale, which is technically true and practically useless.
        """
        if self.snapshot_ttl_seconds is not None:
            return self.snapshot_ttl_seconds
        return self.longest_interval * 2.0

    @property
    def daily_allowance(self) -> int:
        if self.daily_credit_budget is not None:
            return self.daily_credit_budget
        return DAILY_ALLOWANCES.get(self.quota_preset, AUTHENTICATED_DAILY_CREDITS)

    @property
    def jobs(self) -> tuple[PollJob, ...]:
        try:
            return PRESETS[self.quota_preset]
        except KeyError:
            raise KeyError(
                f"unknown quota preset {self.quota_preset!r}; "
                f"available: {', '.join(sorted(PRESETS))}"
            ) from None

    def projected_daily_credits(self) -> float:
        """Worst-case projected consumption for the configured preset.

        Worst case because tier 2 only runs while a client is connected and
        zoomed in far enough; real consumption is lower.
        """
        total = 0.0
        for job in self.jobs:
            if job.tier == 2:
                # Tier 2's bbox comes from the viewport at runtime, clamped to
                # focus_max_area_sq_deg -- so its cost is that band's cost.
                total += daily_credits(
                    job.interval_seconds, credits_for_area(self.focus_max_area_sq_deg)
                )
            else:
                total += job.projected_daily_credits
        return total

    @model_validator(mode="after")
    def _budget_must_fit(self) -> Settings:
        """Refuse to start if the configured intervals overspend.

        This is the executable form of D21. Catching it here means a bad
        interval fails at startup rather than silently exhausting the day's
        credits by mid-afternoon.
        """
        if self.quota_preset not in PRESETS:
            raise ValueError(
                f"unknown quota preset {self.quota_preset!r}; "
                f"available: {', '.join(sorted(PRESETS))}"
            )
        projected = self.projected_daily_credits()
        ceiling = self.daily_allowance * self.budget_safety_fraction
        if projected > ceiling:
            raise ValueError(
                f"polling preset {self.quota_preset!r} projects {projected:.0f} "
                f"credits/day, above the {ceiling:.0f} ceiling "
                f"({self.budget_safety_fraction:.0%} of {self.daily_allowance}). "
                "Lengthen an interval or raise ORBITAL_DAILY_CREDIT_BUDGET."
            )
        if (
            self.snapshot_ttl_seconds is not None
            and self.snapshot_ttl_seconds <= self.longest_interval
        ):
            raise ValueError(
                f"snapshot_ttl_seconds ({self.snapshot_ttl_seconds}) must exceed the "
                f"longest poll interval ({self.longest_interval}), otherwise every "
                "response is stale by construction"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    """Cached settings instance, used as a FastAPI dependency.

    Cached so the ``.env`` file is read once. Tests call
    ``get_settings.cache_clear()`` after changing the environment.
    """
    return Settings()
