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
from pathlib import Path

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


#: What one unbounded /states/all call costs OpenSky.
GLOBAL_CALL_CREDITS = 4

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
    # The viewport job polls a 100 sq deg box (2 credits) every 90 s rather than
    # a 25 sq deg box (1 credit) every 45 s: identical cost, four times the
    # area, and the difference between a tier that covers a quarter of the
    # screen and one that covers a twentieth of it (D36).
    "authenticated": (
        PollJob(name="global", bbox=None, interval_seconds=300.0, tier=1),
        PollJob(name="viewport", bbox=None, interval_seconds=90.0, tier=2),
    ),
    # For the union provider, where the cadence is set by the free feed and the
    # metered one answers once every supplement interval regardless (D83, D87).
    #
    # **These two intervals are a budget, and the budget was measured.**
    # adsb.lol costs no credits, so the first version of this preset treated
    # the intervals as a question of what is decent to ask of a free service -
    # 60 s and 15 s, four requests a minute each, eight in total. That was
    # wrong, and it cost a circle of the planet on 38% of polls for the life of
    # the union provider.
    #
    # Measured directly, with nothing else running, by sending at a steady 4 s
    # and watching where refusals begin: **four requests go through, then about
    # one every twelve seconds.** A burst of four over roughly five a minute -
    # the signature of `limit_req rate=5r/m burst=4 nodelay`. Asking for eight
    # against a budget of five refuses three, which is 37.5% against the 38%
    # observed (defect #35, 19.43).
    #
    # So: 4 sweep requests per 120 s plus 4 viewport requests per 120 s is
    # **4 a minute**, a fifth under the cap.
    #
    # **What each interval buys, and what it cost to fit.** The sweep is four
    # requests, not one, and it exists to keep the parts of the map nobody is
    # watching from going stale rather than to animate them - so it is the half
    # that can afford to slow down. 120 s also matches the OpenSky supplement
    # interval it already runs alongside (D84) and sits well inside the 300 s
    # object TTL. The viewport is the half a user actually sees, and doubling
    # it to 30 s is the real price paid here: D87 measured a 2 s median
    # position age at 15 s, and that roughly doubles. Nothing freezes, because
    # the client dead-reckons to 120 s (D71).
    "union": (
        PollJob(name="global", bbox=None, interval_seconds=120.0, tier=1),
        PollJob(name="viewport", bbox=None, interval_seconds=30.0, tier=2),
    ),
    # 8000 credits/day. 1920 + 2880 = 4800/day, 60% of budget.
    "contributor": (
        PollJob(name="global", bbox=None, interval_seconds=180.0, tier=1),
        PollJob(name="viewport", bbox=None, interval_seconds=60.0, tier=2),
    ),
}

#: What the ships layer polls, and why it is one job rather than two.
#:
#: Not a member of ``PRESETS`` because the presets are a **credit ladder** -
#: each one exists because OpenSky meters us and a different account tier buys
#: a different interval (D21). Digitraffic meters nothing, so there is no
#: ladder to climb and no preset to choose between.
#:
#: **One job, not two.** The two-tier arrangement buys latency in the viewport
#: at the cost of a second call, and it is worth it when the global sweep is
#: expensive or slow. Here the entire feed is 916 vessels in **37 KB**, the
#: endpoint takes no bounding box at all, and a viewport job would therefore
#: fetch exactly the same bytes twice and throw half of them away.
#:
#: **60 seconds because the upstream said so.** The response carries
#: ``Cache-Control: max-age=60``, so polling faster returns the same body: the
#: source has stated its own cadence and the polite thing is to match it. That
#: is two requests a minute at most against a documented anonymous limit of
#: sixty, comfortably inside it even before the ``Digitraffic-User`` header
#: lifts the cap.
SHIP_JOBS: tuple[PollJob, ...] = (
    PollJob(name="ships", bbox=None, interval_seconds=60.0, tier=1),
)

DAILY_ALLOWANCES: dict[str, int] = {
    "anonymous": ANONYMOUS_DAILY_CREDITS,
    "authenticated": AUTHENTICATED_DAILY_CREDITS,
    "contributor": CONTRIBUTOR_DAILY_CREDITS,
    # 'union' is not a fourth account tier: it is an authenticated OpenSky
    # account used sparingly alongside a free feed (D83), so it is budgeted
    # against the same 4000. Listed explicitly because it was previously
    # reaching this number by falling through daily_allowance's default, which
    # is the same answer arrived at by accident. Running union WITHOUT OpenSky
    # credentials leaves the supplement anonymous at 400/day, and the 2,880 the
    # preset projects would overspend it -- set ORBITAL_DAILY_CREDIT_BUDGET=400
    # and the startup check will say so.
    "union": AUTHENTICATED_DAILY_CREDITS,
}


#: Where the backend's settings file lives, as an absolute path.
#:
#: Named and absolute rather than the bare ``".env"`` pydantic defaults to,
#: because that is resolved against the *working directory*: started from
#: ``backend/`` it is found, and started from the repository root - which
#: ``uvicorn --app-dir backend`` does - it is not. A missing env file is not an
#: error in pydantic, so the backend simply came up on every default, on the
#: fixture provider, while this file said ``opensky`` (D114).
#:
#: A constant rather than an expression inside ``model_config`` so that the
#: test suite can assert this without reading a value the suite itself
#: overrides: ``conftest`` sets ``model_config["env_file"] = None`` to keep the
#: developer's own file out of the tests.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    """Application settings, all overridable by ``ORBITAL_``-prefixed env vars."""

    #: Resolved from this file, not from the working directory.
    #:
    #: ``env_file=".env"`` is relative to wherever the process was started, so
    #: the backend read its settings only when launched from ``backend/``. Run
    #: from the repository root - which is what ``uvicorn --app-dir backend``
    #: does, and what ``.claude/launch.json`` does - it found no file, silently
    #: fell back to every default, and came up on the **fixture** provider while
    #: ``.env`` plainly said ``opensky``. No error, no warning: just the wrong
    #: data source and a log line nobody reads twice (D114).
    #:
    #: An absolute path makes the answer the same from any directory.
    model_config = SettingsConfigDict(
        env_prefix="ORBITAL_",
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---- data source -------------------------------------------------------
    provider: str = Field(
        default="union",
        description=(
            "Which provider to run. 'union' is the real one: adsb.lol on every "
            "poll, OpenSky as a 120 s supplement (D83). 'fixture' is offline "
            "sample data and needs no credentials (D8)."
        ),
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

    #: adsb.lol needs no credentials at all, which is most of its appeal (D83).
    adsblol_base_url: str = "https://api.adsb.lol/v2"
    #: adsb.fi, a second community aggregator on the same software.
    #:
    #: Measured against adsb.lol over seven circles on 2026-09-14: three per
    #: cent more aircraft overall, and seven against one over Myanmar (D208).
    #: The overall figure is low because the aggregators largely share feeders;
    #: the Myanmar figure is why it is here at all.
    adsbfi_base_url: str = "https://opendata.adsb.fi/api/v2"

    #: airplanes.live, which answers a stranger with a 403 telling them to
    #: write in. Registered so the switch exists the day access is granted;
    #: until then it is a provider nobody can select usefully.
    airplaneslive_base_url: str = "https://api.airplanes.live/v2"

    #: Which feed fills the gaps the primary cannot see, when the provider is
    #: `union`.
    #:
    #: **This was OpenSky until it stopped taking connections from data
    #: centres** (D207). It is unreachable from Northflank and from Render
    #: alike, while answering a home connection in 0.23 s, so the default that
    #: works in the place this actually runs is adsb.fi. `opensky` still works
    #: from a laptop and is one variable away.
    union_supplement: str = Field(
        default="adsbfi",
        description="Which provider supplements the primary feed: adsbfi, opensky or airplaneslive.",
    )

    adsblol_trace_base_url: str = Field(
        default="https://globe.adsb.lol/data/traces",
        description=(
            "Where adsb.lol's flight traces live. **A different host from the "
            "API above**, which is why it is a separate setting and why D78 "
            "concluded this feed had no flight history: it does, on the map "
            "server rather than the API, in readsb's own file format. Emptying "
            "this turns the trace lookup off and leaves OpenSky as the only "
            "source of a path from takeoff (D200)."
        ),
    )
    adsblol_timeout_seconds: float = Field(default=30.0, gt=0)
    adsblol_user_agent: str = Field(
        default="Orbital/0.1 (CSC480 student project)",
        description="Sent on every request; a free service deserves to know who is calling.",
    )

    #: Satellites need no credentials at all -- there is no metered upstream
    #: anywhere in that path (D93), so these are the only two knobs it has.
    satellite_layer_enabled: bool = Field(
        default=True,
        description=(
            "Whether the satellite layer runs beside the aircraft one. On by "
            "default because it costs nothing to run: no credentials, no quota, "
            "no store and no poll interval. Turn it off for a deployment that "
            "should make no outbound calls at all (D95)."
        ),
    )
    satellite_timeout_seconds: float = Field(default=60.0, gt=0)
    accounts_db_path: Path = Field(
        default=Path(".cache") / "orbital-accounts.sqlite",
        description=(
            "Where accounts and sessions live. The first state in Orbital that "
            "must survive a restart and cannot be refetched from anywhere "
            "(D146). Beside the element cache, so one directory holds "
            "everything the process keeps."
        ),
    )
    cookies_secure: bool = Field(
        default=False,
        description=(
            "Whether the session cookie is marked Secure. Off by default "
            "because local development is plain http and a Secure cookie is "
            "simply never sent - which looks like a broken sign-in. **Turn it "
            "on for any deployment that is not localhost**: without it the "
            "cookie travels in the clear (D147)."
        ),
    )
    self_serve_premium: bool = Field(
        default=True,
        description=(
            "Whether a signed-in account may change its own tier between free "
            "and premium. **There is no payment processor**, so this is the "
            "stand-in for one: it is what makes premium reachable from inside "
            "the app at all, and it gives premium away. On by default because "
            "this is a project nobody is billing, and it is the switch to "
            "throw the moment anything here is charged for (D157). It can "
            "never grant `admin` whatever it is set to."
        ),
    )
    # ---- ships -------------------------------------------------------------
    ship_layer_enabled: bool = Field(
        default=True,
        description=(
            "Whether the ships layer runs beside the aircraft and satellite "
            "ones. On by default because Digitraffic needs no credentials and "
            "meters nothing: the whole cost is one request a minute for 37 KB "
            "(D165). Turn it off for a deployment that should make no outbound "
            "calls at all."
        ),
    )
    digitraffic_base_url: str = "https://meri.digitraffic.fi/api/ais/v1"
    digitraffic_timeout_seconds: float = Field(default=30.0, gt=0)
    ship_object_ttl_seconds: float = Field(
        default=900.0,
        gt=0,
        description=(
            "Drop a vessel not re-observed within this window. Longer than the "
            "aircraft layer's 300 s and for the opposite reason: a moored ship "
            "transmits every three minutes rather than every few seconds, so a "
            "short TTL would evict most of a harbour. Shorter than it looks, "
            "though, against a source that retains 24 hours - 28% of what "
            "Digitraffic returns has not been heard from in over an hour, and "
            "serving that is D86's map of ghosts (D165)."
        ),
    )
    ship_max_vessels: int = Field(
        default=14000,
        ge=0,
        description=(
            "The most vessels the global AIS stream will hold, or 0 for no "
            "limit. **A ceiling on memory that does not depend on how busy the "
            "sea is.** `ship_object_ttl_seconds` bounds how *old* a vessel may "
            "be, which is a different question: the same TTL holds 643 vessels "
            "on Digitraffic alone and 27,000 with the global stream, and the "
            "second number was measured at about 480 MiB against a 512 MiB "
            "container, which killed it (D192). 14,000 is the measured 27,000 "
            "roughly halved - still twenty times the Baltic-only feed, and "
            "chosen from two data points rather than a model, so it is a dial "
            "to turn if the container is a different size."
        ),
    )
    aisstream_api_key: str = Field(
        default="",
        description=(
            "Key for aisstream.io, the only free source with **global** coverage "
            "(D165, D166). Empty means the ships layer runs on Digitraffic alone "
            "- the northern Baltic and nothing else, which is a smaller map "
            "rather than a broken one. Created by signing in to aisstream.io "
            "with GitHub. Measured with a real key: **17,848 vessels in four "
            "minutes against Digitraffic's 643**, 95% of them named."
        ),
    )
    ship_global_enabled: bool = Field(
        default=True,
        description=(
            "Whether the global AIS stream runs alongside the regional feed. On "
            "by default, but it does nothing without `aisstream_api_key` - so "
            "the switch that actually turns it on is the key. **This is the one "
            "to throw the day anything here is charged for**: aisstream's "
            "commercial-use terms were asked about publicly in April 2026 and "
            "have not been answered, so it is used on the footing of a free "
            "public service and credited as one (D166)."
        ),
    )

    lunar_layer_enabled: bool = Field(
        default=True,
        description=(
            "Whether the three spacecraft in orbit around the Moon are tracked "
            "from JPL Horizons. On by default because it costs one background "
            "task and three requests every six hours, against a free service "
            "with no quota and no credentials (D134)."
        ),
    )
    satellite_element_cache_path: Path = Field(
        default=Path(".cache") / "orbital-elements.json",
        description=(
            "Where fetched orbital elements are kept between runs. On disk "
            "rather than only in memory so that a restart during an upstream "
            "outage still has something to propagate -- day-old elements are "
            "accurate to a kilometre or two, and both free sources were down "
            "simultaneously on the day this was written."
        ),
    )
    satellite_element_refresh_seconds: float = Field(
        default=6 * 3600.0,
        gt=0,
        description=(
            "How often orbital elements are refetched. Hours, not seconds: "
            "elements describe an orbit rather than a position and stay usable "
            "for days, and CelesTrak's usage policy asks callers not to check "
            "more than every two hours. Positions are computed fresh on every "
            "poll regardless of this (D94)."
        ),
    )

    union_supplement_interval_seconds: float = Field(
        default=120.0,
        gt=0,
        description=(
            "How often the metered feed is actually called when running 'union'. "
            "The free feed answers every poll; this one answers at most this often, "
            "so the poll cadence is no longer set by the credit ladder (D83). "
            "120 s because that is the freeze threshold (D71): a longer interval "
            "leaves aircraft only OpenSky can see sitting motionless for the "
            "difference, which is what 'the planes are not moving' looked like "
            "(defect #30). At 4 credits a call it is 2,880 a day, still below "
            "the 3,072 the OpenSky-only preset spent."
        ),
    )

    # ---- quota -------------------------------------------------------------
    quota_preset: str = Field(
        default="union",
        description=(
            "Which polling preset to run: anonymous, authenticated, contributor, "
            "or union. The first three are OpenSky account tiers and their "
            "intervals follow from the credits each one allows (D21). 'union' is "
            "paced by adsb.lol's rate limit instead, and is the one to use with "
            "ORBITAL_PROVIDER=union (D83)."
        ),
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
        default=100.0,
        gt=0.0,
        description=(
            "Trim the snapped viewport box down to this area before polling. "
            "100 sq deg is the top of the 2-credit band, so tier 2 always costs "
            "exactly two credits and the daily projection stays exact."
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
        default=300.0,
        gt=0,
        description=(
            "Drop an object not re-observed within this window. Comfortably longer "
            "than the longest poll interval, so a missed poll never drops an "
            "aircraft, and short enough that what is drawn is something a feed has "
            "actually seen recently. It was 1800 s, chosen when one feed polled "
            "every 300 s; with two feeds sweeping every 60 s an aircraft absent for "
            "five minutes has landed or left coverage, and keeping it for half an "
            "hour meant 39% of everything served was past the two-minute fade - "
            "a map of ghosts (D86)."
        ),
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
    gzip_min_bytes: int = Field(
        default=1024,
        ge=0,
        description=(
            "Compress responses at or above this size. A thinned 2000-object "
            "response is ~328 KB of highly repetitive JSON and gzips to ~21% of "
            "that; below a kilobyte the compression costs more than it saves."
        ),
    )

    # ---- logging -----------------------------------------------------------
    log_level: str = Field(
        default="INFO",
        description=(
            "Level for the app.* loggers. INFO shows every poll result and the "
            "remaining credit balance, which D23 requires to be logged."
        ),
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
        if self.provider == "union":
            # The union polls the free feed on every job and the metered one
            # once per supplement interval, on the global poll only (D83). Its
            # cost is therefore fixed by that interval rather than by how fast
            # the poller runs, which is the whole point of the arrangement.
            return daily_credits(self.union_supplement_interval_seconds, GLOBAL_CALL_CREDITS)

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
