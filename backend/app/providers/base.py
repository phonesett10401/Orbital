"""The Provider interface: the seam between Orbital and the outside world.

A Provider's entire job is to answer "where is everything right now?" in the
normalized shape. It owns HTTP, authentication, upstream quirks and unit
conversion. It owns no caching, no scheduling and no retry policy -- those
belong to the poller, so that retry behaviour is written once and tested once
instead of being reimplemented per source.

Adding a data source means adding a module here and a line in ``registry.py``.
Nothing in ``app.api`` or the frontend changes.
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from app.models import BBox, ObjectType, TrackedObjectRecord, TrackPoint


class ProviderError(Exception):
    """Base for every failure a provider is allowed to raise.

    The poller catches this and only this. Anything else escaping a provider is
    a bug in the provider, and we want it loud rather than silently retried.
    """


class ProviderUnavailable(ProviderError):
    """Upstream is unreachable, timed out, or returned a 5xx."""


class ProviderRateLimited(ProviderError):
    """Upstream refused because we have spent our quota.

    ``retry_after`` is seconds, when the upstream tells us; the poller uses it
    in place of its own backoff so we stop hammering a source that has already
    said no. OpenSky's daily credit limit makes this the failure mode we most
    expect to hit in practice.
    """

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class ProviderBadResponse(ProviderError):
    """Upstream answered, but not with something we can parse."""


class Provider(ABC):
    """Fetches the current position of every object in one layer."""

    #: Stable identifier used in config, logs and ``Snapshot.source``.
    name: str
    #: Which layer this provider populates.
    object_type: ObjectType

    async def fetch_track(self, object_id: str) -> tuple[TrackPoint, ...] | None:
        """The path of the object's current flight, oldest first, or None.

        **Optional, and None is the honest default.** Our own observed track
        begins when we started watching, which for an aircraft selected
        mid-flight is an arbitrary point in the sky; a provider that keeps
        flight history can do better and begin at the runway. A provider that
        cannot simply says so, and the caller keeps what it observed itself
        (D78).

        This is a per-object call made on selection rather than on a poll, so
        implementations must treat it as something a user triggers: cache it,
        and never let it run on a schedule.
        """
        return None

    @abstractmethod
    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Return every object the source currently knows about.

        ``bbox`` is a hint, not a filter. A provider whose upstream supports
        server-side bounding boxes should pass it along to reduce quota cost;
        one whose upstream does not may ignore it entirely, because the API
        layer filters again before serving. Callers must not assume the result
        is confined to ``bbox``.

        Implementations must skip objects with no usable position rather than
        emitting placeholder coordinates -- a marker at (0, 0) is worse than no
        marker, because it looks like real data in the Gulf of Guinea.

        Raises:
            ProviderError: for any expected upstream failure.
        """

    async def aclose(self) -> None:
        """Release long-lived resources such as HTTP clients.

        Default is a no-op so simple providers need not implement it.
        """
        return None
