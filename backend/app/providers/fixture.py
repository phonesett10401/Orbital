"""A Provider that replays recorded data from disk instead of calling the network.

This exists so three people can build the API layer, the thinning logic and the
entire frontend without any of them holding OpenSky credentials or spending
from a shared daily quota. It is the default provider in development.

The fixture file holds *already normalized* objects rather than raw OpenSky
rows. That keeps this module independent of any one upstream format, at the
cost of not exercising the OpenSky parser -- which is covered instead by unit
tests against a recorded raw sample in M2.

Positions are advanced by dead reckoning from the moment the provider starts,
so the offline globe actually moves. Without this the frontend's interpolation
and staleness handling could not be developed or demonstrated offline.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from app.geo import destination_point
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.providers.base import Provider, ProviderBadResponse, ProviderError

DEFAULT_FIXTURE = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "aircraft_sample.json"


class FixtureProvider(Provider):
    """Replays a fixture file, optionally animating it.

    Args:
        path: fixture JSON, a list of TrackedObjectRecord records.
        animate: when True, project each object forward from its recorded
            position using its own heading and velocity.
        object_type: which layer the fixture represents.
    """

    name = "fixture"

    def __init__(
        self,
        path: Path | str = DEFAULT_FIXTURE,
        *,
        animate: bool = True,
        object_type: ObjectType = ObjectType.AIRCRAFT,
    ) -> None:
        self.path = Path(path)
        self.animate = animate
        self.object_type = object_type
        self._failure: ProviderError | None = None
        self._objects = self._load()
        self._started_at = utcnow()

    def _load(self) -> list[TrackedObjectRecord]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise ProviderBadResponse(f"fixture not found: {self.path}") from exc
        except json.JSONDecodeError as exc:
            raise ProviderBadResponse(f"fixture is not valid JSON: {self.path}") from exc
        if not isinstance(raw, list):
            raise ProviderBadResponse("fixture must be a JSON list of objects")
        return [TrackedObjectRecord.model_validate(item) for item in raw]

    def set_failure(self, error: ProviderError | None) -> None:
        """Make the next fetch raise, or clear a previously set failure.

        Lets us exercise the outage path -- both in tests and by hand during a
        demo -- without unplugging anything.
        """
        self._failure = error

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        if self._failure is not None:
            raise self._failure

        now = utcnow()
        if not self.animate:
            # Still restamp last_seen, otherwise every object reads as stale the
            # moment the fixture file ages.
            return [obj.model_copy(update={"last_seen": now}) for obj in self._objects]

        elapsed = (now - self._started_at).total_seconds()
        return [self._advance(obj, elapsed, now) for obj in self._objects]

    def _advance(self, obj: TrackedObjectRecord, elapsed: float, now: datetime) -> TrackedObjectRecord:
        if obj.velocity is None or obj.heading is None or obj.velocity == 0.0:
            return obj.model_copy(update={"last_seen": now})
        lat, lon = destination_point(obj.lat, obj.lon, obj.heading, obj.velocity * elapsed)
        return obj.model_copy(update={"lat": lat, "lon": lon, "last_seen": now})
