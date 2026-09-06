"""The normalized data contract shared by every layer of Orbital.

Everything downstream of a Provider speaks these types and only these types.
No module outside ``app.providers`` should ever see a raw upstream payload.

See ``docs/data-contract.md`` for the prose version of this contract, including
units and the meaning of each field.
"""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel


def utcnow() -> datetime:
    """Timezone-aware UTC now.

    Defined once so tests can monkeypatch a single symbol, and so we never
    accidentally mix naive and aware datetimes when comparing timestamps.
    """
    return datetime.now(timezone.utc)


class OrbitalModel(BaseModel):
    """Base for every wire model.

    Serializes to camelCase because the frontend consumes these directly, while
    staying snake_case in Python. ``populate_by_name`` means tests and fixtures
    may use either spelling.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        frozen=True,
    )


class ObjectType(str, Enum):
    """Which layer an object belongs to.

    It was carried from the start with one value, because the shape is
    deliberately source-agnostic (D4) and retrofitting a discriminator into a
    contract three layers deep is far more painful than carrying one - and it
    was carried for that reason rather than as satellite groundwork (D37).
    Satellites arrived four months later (D93) and it cost one line.

    Ships arrived after that (D165) and cost the same one line, which is the
    second time the bet has paid and the point at which it stops being luck.
    Note what the three do *not* have in common: an aircraft is observed by a
    metered feed, a satellite is computed from elements and never observed at
    all, and a ship is observed by a free regional one. The enum does not care,
    because it names the layer rather than how the layer is filled.
    """

    AIRCRAFT = "aircraft"
    SATELLITE = "satellite"
    SHIP = "ship"


Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]


class TrackedObject(OrbitalModel):
    """One moving object at one instant. The universal shape.

    Deliberately source-agnostic: there is no aircraft-specific field here.
    Anything that only makes sense for one kind of object lives in
    ``TrackedObjectRecord.meta``. That is what makes a new data source a
    drop-in rather than a schema change.

    ``model`` is the one field that looks like an exception and is not. "What
    kind of thing is this" is a question any moving object can answer, and the
    renderer needs it for every object in the list rather than only the
    selected one - it is what makes a Cessna smaller than an A380 on the map.
    The aircraft-specific *reading* of it, that B789 means a 60 m wingspan,
    lives in the frontend; the contract here promises only a designator the
    source chose.
    """

    id: str = Field(description="Stable identifier, unique within a provider.")
    lat: Latitude = Field(description="Degrees north, WGS84.")
    lon: Longitude = Field(description="Degrees east, WGS84, normalized to [-180, 180].")
    altitude: float | None = Field(
        default=None, description="Metres above mean sea level. None if unknown."
    )
    velocity: float | None = Field(
        default=None,
        ge=0.0,
        description=(
            "Speed in metres per second. Ground speed for an aircraft; orbital "
            "speed for a satellite, which is the figure every source quotes and "
            "the one a reader expects (D94)."
        ),
    )
    heading: float | None = Field(
        default=None,
        description="Direction of travel in degrees clockwise from true north, [0, 360).",
    )
    label: str = Field(description="Short human-readable name, e.g. a callsign.")
    model: str | None = Field(
        default=None,
        description=(
            "What the source says this object *is*, in its own vocabulary - for "
            "an aircraft, the ICAO type designator such as B789. None where the "
            "source does not say, which is most of them - and always None for a "
            "satellite, where the catalogue's answer is the same for every row "
            "we draw. Orbit class would be informative but is something we "
            "derive rather than something the source says, so it is not put "
            "here (D94)."
        ),
    )
    last_seen: datetime = Field(
        description=(
            "When this position was current (UTC). For an aircraft, when the "
            "upstream source observed it - never when we polled. For a satellite "
            "there is no observation: the position is computed, so this is the "
            "instant it was propagated for, and is exact rather than an "
            "extrapolation. The age of the orbital elements behind it is a "
            "different fact and lives in ``meta`` (D94)."
        )
    )
    type: ObjectType = Field(description="Which layer this object belongs to.")

    @field_validator("lon")
    @classmethod
    def _normalize_lon(cls, v: float) -> float:
        # Guard against upstream sources reporting 180.0 vs -180.0 inconsistently.
        return -180.0 if v == 180.0 else v

    @field_validator("heading")
    @classmethod
    def _wrap_heading(cls, v: float | None) -> float | None:
        if v is None:
            return None
        return v % 360.0

    @field_validator("last_seen")
    @classmethod
    def _require_aware(cls, v: datetime) -> datetime:
        # A naive datetime here silently breaks every staleness comparison, so
        # we reject it at the boundary rather than debugging it later.
        if v.tzinfo is None:
            raise ValueError("last_seen must be timezone-aware")
        return v.astimezone(timezone.utc)


class TrackPoint(OrbitalModel):
    """A single observed position, used to build the route polyline.

    "Route" in Orbital means the path we have actually watched the object
    travel, not a filed flight plan. See docs/data-contract.md.
    """

    lat: Latitude
    lon: Longitude
    altitude: float | None = None
    timestamp: datetime


class TrackedObjectRecord(TrackedObject):
    """What a provider returns and what the store holds: core shape plus meta.

    ``meta`` is the pressure valve that keeps ``TrackedObject`` universal.
    Aircraft put originCountry here. Any other source puts its own specifics
    here too, without forcing a change to the shape the renderer knows.

    This type never reaches the browser as-is. The list endpoint declares
    ``TrackedObject`` as its response model, so FastAPI projects ``meta`` away
    and a 2000-object response stays small.
    """

    meta: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Source-specific fields the core shape deliberately omits, "
            "e.g. originCountry for aircraft. Rendered generically as key/value rows."
        ),
    )


class Airport(OrbitalModel):
    """An airport, as an origin we have inferred rather than been told.

    ``distance_km`` is carried deliberately: the origin is a nearest-match
    against the first point of a track, and how close that match was is the
    reader's only way to judge it. 0.8 km is an aircraft on a runway; 6 km is
    an aircraft that was already climbing when we first saw it, and the client
    can word itself accordingly (D78).
    """

    icao: str = Field(description="ICAO code, e.g. YSSY.")
    name: str = Field(description="Airport name as published.")
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    country: str | None = Field(default=None, description="ISO 3166-1 alpha-2, when known.")
    municipality: str | None = Field(default=None, description="The town or city it serves.")
    iata: str | None = Field(default=None, description="IATA code, e.g. DXB, when known.")
    distance_km: float | None = Field(
        default=None,
        ge=0,
        description=(
            "How far the track's first point was from this airport. Present only "
            "for an origin *inferred* from a track (D78); a scheduled route names "
            "its airports outright and has nothing to be near."
        ),
    )


class FlightRoute(OrbitalModel):
    """The route a callsign is scheduled to fly.

    **Scheduled, not observed**, and the distinction is the whole reason this
    is a separate field from `origin`. `origin` is inferred from where the
    aircraft's own track begins and is therefore a fact about this flight;
    this is what the callsign is published as flying, which is usually the same
    thing and occasionally is not - a diversion, a callsign reused for a
    different sector, or a stale entry in a community database (D88).

    It is the only source of a *destination* anywhere in this application: no
    position feed carries one, because an aircraft does not transmit where it
    is going.
    """

    airline: str | None = Field(default=None, description="Operator name, as published.")
    origin: Airport | None = Field(default=None, description="Scheduled departure airport.")
    destination: Airport | None = Field(default=None, description="Scheduled arrival airport.")


class TrackSource(str, Enum):
    """Where a detail's track came from.

    The distinction is the whole point of asking the provider for one: an
    ``observed`` track begins when *we* started watching, which for an aircraft
    selected mid-flight is an arbitrary point in the sky, while a ``provider``
    track begins where the flight did. The client says something different for
    each, so it has to be able to tell them apart (D78).
    """

    PROVIDER = "provider"
    OBSERVED = "observed"


class TrackedObjectDetail(TrackedObjectRecord):
    """A single object plus everything the detail panel needs.

    Returned only by the by-id endpoint, where one extra payload of track
    history costs nothing.
    """

    track: tuple[TrackPoint, ...] = Field(
        default=(), description="Positions oldest first, from `track_source`."
    )
    track_source: TrackSource = Field(
        default=TrackSource.OBSERVED,
        description="Whether the track came from the provider or from our own polling.",
    )
    origin: Airport | None = Field(
        default=None,
        description="Where the flight appears to have departed from, if its track begins there.",
    )
    route: FlightRoute | None = Field(
        default=None,
        description="The scheduled route for this callsign, when one is published (D88).",
    )


class BBox(OrbitalModel):
    """A geographic bounding box, inclusive on all edges.

    Handles the antimeridian: if ``lon_min > lon_max`` the box is understood to
    wrap across +/-180 (e.g. lon_min=170, lon_max=-170 is a 20-degree-wide box
    over the Pacific). Naive ``lon_min <= lon <= lon_max`` silently returns
    nothing for those boxes, which is an easy bug to ship and a hard one to see.
    """

    lat_min: Latitude
    lat_max: Latitude
    lon_min: Longitude
    lon_max: Longitude

    @classmethod
    def parse(cls, raw: str) -> BBox:
        """Parse the query-string form ``latMin,lonMin,latMax,lonMax``.

        Ordering matches OpenSky's own parameter order to avoid a translation
        step that nobody would remember to do.
        """
        parts = raw.split(",")
        if len(parts) != 4:
            raise ValueError("bbox must be 'latMin,lonMin,latMax,lonMax'")
        try:
            lat_min, lon_min, lat_max, lon_max = (float(p) for p in parts)
        except ValueError as exc:
            raise ValueError("bbox values must be numbers") from exc
        if lat_min > lat_max:
            raise ValueError("bbox latMin must not exceed latMax")
        return cls(lat_min=lat_min, lat_max=lat_max, lon_min=lon_min, lon_max=lon_max)

    @property
    def crosses_antimeridian(self) -> bool:
        return self.lon_min > self.lon_max

    def contains(self, lat: float, lon: float) -> bool:
        if not (self.lat_min <= lat <= self.lat_max):
            return False
        if self.crosses_antimeridian:
            return lon >= self.lon_min or lon <= self.lon_max
        return self.lon_min <= lon <= self.lon_max

    @property
    def width_deg(self) -> float:
        """Longitudinal span in degrees, correct across the antimeridian."""
        if self.crosses_antimeridian:
            return (180.0 - self.lon_min) + (self.lon_max + 180.0)
        return self.lon_max - self.lon_min

    @property
    def height_deg(self) -> float:
        return self.lat_max - self.lat_min


WORLD = BBox(lat_min=-90.0, lat_max=90.0, lon_min=-180.0, lon_max=180.0)


class Snapshot(OrbitalModel):
    """One complete poll result: what we got, from where, and when.

    The store holds exactly one of these per layer. The API serves views of it
    and never triggers a fetch, which is what keeps upstream failures from
    reaching the browser.
    """

    objects: tuple[TrackedObjectRecord, ...]
    fetched_at: datetime
    source: str = Field(description="Provider name that produced this snapshot.")
    type: ObjectType

    def age_seconds(self, now: datetime | None = None) -> float:
        return ((now or utcnow()) - self.fetched_at).total_seconds()
