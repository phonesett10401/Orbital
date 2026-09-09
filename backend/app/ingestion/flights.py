"""Flight history for one selected aircraft, bought sparingly.

The store keeps what the poller has seen, which begins when we started
watching. For an aircraft selected mid-flight that is an arbitrary point in the
sky, and the detail panel has always had to say so. OpenSky will sell us the
real thing -- the flight's path from the runway -- for **4 credits a call**
(D78).

Four credits is nothing next to the 128 an hour the poller already spends, and
it is ruinous if it happens on every detail request: the client polls the
selected aircraft while it is selected, so an uncached fetch would turn one
user watching one flight into a request every few seconds and empty a day's
allowance in under an hour.

So the whole of this module is about *not* making that call:

- one flight in flight at a time per aircraft, so a burst of detail requests
  waits on a single upstream call rather than starting several;
- a positive result cached for two minutes, which is longer than a track grows
  in any way that matters;
- **a negative result cached for the same two minutes**, which is the part that
  is easy to leave out. A 404 is the common answer for an aircraft that has
  just appeared, and an uncached negative means paying repeatedly to be told
  nothing.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
import time
from dataclasses import dataclass

from app.airports import origin_of
from app.geo import haversine_metres, initial_bearing
from app.models import Airport, TrackedObjectDetail, TrackPoint, TrackSource
from app.providers.base import Provider, ProviderError

logger = logging.getLogger(__name__)

#: How long a fetched flight stays good.
#:
#: The speeds at which a gap between a track's end and the aircraft's position
#: is explained by the aircraft simply having flown there, unheard.
#:
#: **Time alone cannot tell a coverage hole from a previous flight, and speed
#: can.** SIA23's track ended 99 minutes and 1,441 km before its position -
#: 874 km/h, a cruise. CSH832's ended 3.5 hours and 45 km away - 13 km/h, which
#: no airliner does, because it had landed, sat on a stand and departed again
#: (D202).
#:
#: The band is wide on purpose. It is not trying to identify the aircraft type;
#: it is separating "flew there" from "went somewhere else and came back".
TRACK_CONTINUITY_MIN_KMH = 250.0
TRACK_CONTINUITY_MAX_KMH = 1200.0

#: How far behind the aircraft's own position a provider track may end.
#:
#: **Not a freshness rule, an identity one.** A track that stops hours before
#: the aircraft last reported is not a stale view of this flight; it is a
#: complete view of a different one, and drawing it puts the aircraft at the end
#: of a journey it is not on (D196).
#:
#: Fifteen minutes is generous against what a healthy answer looks like -
#: measured across nine aircraft, eight ended within one minute of the position
#: and the ninth was 134 minutes out. There is nothing between those two
#: populations, so the threshold only has to fall in the gap.
PROVIDER_TRACK_MAX_LAG_SECONDS = 15 * 60.0

#: A track grows by one waypoint every few seconds, and the part of it that
#: matters -- where the flight began -- does not change at all. Two minutes
#: keeps a selected aircraft's line fresh enough to be honest while costing at
#: most 30 calls an hour for a user who never looks away.
FLIGHT_TTL_SECONDS = 120.0


#: The widest gap between two waypoints that still gives an instantaneous course.
#:
#: The provider's track samples every six seconds, so the bearing between two
#: consecutive waypoints *is* the direction the aircraft is pointing. Our own
#: polling is 90 to 300 seconds apart, where the same arithmetic measures the
#: chord of whatever the aircraft did in between - which is why this correction
#: lives here and not in the store (D80).
COURSE_MAX_GAP_SECONDS = 30.0

#: How far apart those two waypoints must be, so the bearing is not position noise.
COURSE_MIN_MOVEMENT_M = 200.0

#: How far the reported heading must be out before the track overrules it.
#:
#: Measured across 3,641 aircraft over western Europe: the median disagreement
#: between a reported heading and the course actually flown is **0.3 degrees**,
#: so the feed is normally excellent and a correction should be rare. 5.6%
#: disagree by more than 30 degrees over a two-minute gap, but most of those
#: are aircraft that turned rather than feeds that lied - which is exactly the
#: ambiguity a six-second gap removes (D80).
COURSE_MAX_DISAGREEMENT_DEG = 30.0

#: The fastest an aircraft's own positions may claim it is going.
#:
#: **This limit is the whole reason the speed correction is safe.** Measured
#: over 2,971 live aircraft moving faster than 100 m/s: the median difference
#: between reported velocity and the speed implied by their positions is
#: **1.7 m/s**, so the reported figure is excellent. Only 0.30% report under
#: half their observed speed - and the extremes of that group implied 1035,
#: 928 and 635 m/s, which nothing in this dataset flies. Those are position
#: glitches, not velocity errors, and trusting them would replace a correct
#: 244 m/s with a nonsense 928 (D81).
#:
#: 400 m/s is above any airliner's ground speed including a strong jet-stream
#: tailwind, and far below what a jumped position produces.
SPEED_MAX_PLAUSIBLE_MS = 400.0

#: How far out the reported speed must be, in m/s, before its track overrules it.
#:
#: The track-derived speed carries its own noise: across eight aircraft with
#: sound data it differed from the reported value by a median of 7.6 m/s and by
#: as much as 35.5. 50 m/s is clear of that, and the case this exists for -
#: 12 m/s reported at cruise - is out by more than 200.
SPEED_MIN_DIFFERENCE_MS = 50.0

#: And by this factor, so a fast aircraft is not corrected for a small fraction.
SPEED_MIN_RATIO = 2.0


@dataclass(frozen=True)
class Flight:
    """What the provider knows about one aircraft's current flight."""

    track: tuple[TrackPoint, ...]
    origin: Airport | None
    fetched_at: float


def clean_track(track: tuple[TrackPoint, ...]) -> tuple[TrackPoint, ...]:
    """Drop waypoints no aircraft could have reached and left.

    Live tracks contain them: of ten checked against the live feed, **five had
    at least one segment implying over 400 m/s**, and one of those drew a flight
    across Myanmar as a V-shaped detour to an airport it never went near
    (defect #29). The waypoint is wrong, not the flight.

    **A lone bad point is recognised by both its sides.** Reaching it is
    impossible and so is leaving it, and that pair of impossibilities is what
    separates it from an honest coverage gap - which is far apart in *distance*
    but proportionally far apart in *time*, so the speed it implies is
    perfectly ordinary. Testing distance alone would delete every gap; testing
    speed keeps them.

    The first and last points are judged on their one neighbour, since a spike
    at either end has only one side to be wrong about.
    """
    if len(track) < 3:
        return track

    def implied_speed(a: TrackPoint, b: TrackPoint) -> float:
        gap = (b.timestamp - a.timestamp).total_seconds()
        if gap <= 0:
            return float("inf")
        return haversine_metres(a.lat, a.lon, b.lat, b.lon) / gap

    kept: list[TrackPoint] = []
    for index, point in enumerate(track):
        before = kept[-1] if kept else None
        after = track[index + 1] if index + 1 < len(track) else None

        if before is None:
            # **The first point is judged by what comes after it**, because it
            # has no segment arriving to be wrong. Left unjudged, a spike at
            # the start survives - and the origin airport is read off exactly
            # this point, so it would name somewhere the flight never was.
            if (
                after is not None
                and implied_speed(point, after) > SPEED_MAX_PLAUSIBLE_MS
                and (
                    index + 2 >= len(track)
                    or implied_speed(after, track[index + 2]) <= SPEED_MAX_PLAUSIBLE_MS
                )
            ):
                continue
            kept.append(point)
            continue

        into = implied_speed(before, point)
        out_of = implied_speed(point, after) if after is not None else 0.0
        if into > SPEED_MAX_PLAUSIBLE_MS and (
            after is None or out_of > SPEED_MAX_PLAUSIBLE_MS
        ):
            continue
        kept.append(point)
    return tuple(kept)


def _last_usable_pair(
    track: tuple[TrackPoint, ...],
) -> tuple[TrackPoint, TrackPoint, float, float] | None:
    """The most recent pair of waypoints worth measuring anything from.

    Walks backwards for a pair close enough in time to describe the aircraft
    *now* and far enough apart in space to be a measurement rather than noise.
    Backwards because the last gap is often the long one: a track ends at the
    provider's most recent sample, which can be minutes after the one before it
    even when the rest are six seconds apart.

    Returns the pair, the gap in seconds and the distance in metres, because
    both the course and the speed are read off the same two points -- two
    functions choosing their own pairs could describe two different moments.
    """
    for index in range(len(track) - 1, 0, -1):
        later, earlier = track[index], track[index - 1]
        gap = (later.timestamp - earlier.timestamp).total_seconds()
        if gap <= 0 or gap > COURSE_MAX_GAP_SECONDS:
            continue
        distance = haversine_metres(earlier.lat, earlier.lon, later.lat, later.lon)
        if distance < COURSE_MIN_MOVEMENT_M:
            continue
        return earlier, later, gap, distance
    return None


def _newest_point(track: tuple[TrackPoint, ...]) -> TrackPoint | None:
    """The latest point on a track, without trusting the ordering.

    Ordered oldest to newest by contract. Taking the last element on trust
    would, for a provider that ever returned the other order, move the aircraft
    back to where it departed from - which looks like bad data rather than an
    assumption (D138).
    """
    newest: TrackPoint | None = None
    for point in track:
        if point.timestamp is None:
            continue
        if newest is None or point.timestamp > newest.timestamp:
            newest = point
    return newest


def _is_newer(candidate: datetime, current: datetime | None) -> bool:
    """Whether one instant beats another, tolerating a missing one."""
    if current is None:
        return True
    return candidate > current


def course_from_track(track: tuple[TrackPoint, ...]) -> float | None:
    """The direction of travel at the end of a track, or None."""
    pair = _last_usable_pair(track)
    if pair is None:
        return None
    earlier, later, _gap, _distance = pair
    return initial_bearing(earlier.lat, earlier.lon, later.lat, later.lon)


def speed_from_track(track: tuple[TrackPoint, ...]) -> float | None:
    """Ground speed in m/s at the end of a track, or None.

    Only returned when it is physically possible. A track whose last two
    waypoints imply 900 m/s is describing a jumped position rather than an
    aircraft, and that is the failure mode this must not import: reported
    velocity is right to a median of 1.7 m/s, so a correction based on a bad
    position would be strictly worse than doing nothing (D81).
    """
    pair = _last_usable_pair(track)
    if pair is None:
        return None
    _earlier, _later, gap, distance = pair
    speed = distance / gap
    return speed if speed <= SPEED_MAX_PLAUSIBLE_MS else None


class FlightHistory:
    """Fetches and caches provider flight tracks, one aircraft at a time."""

    def __init__(self, provider: Provider, *, ttl_seconds: float = FLIGHT_TTL_SECONDS) -> None:
        self._provider = provider
        self._ttl = ttl_seconds
        self._cache: dict[str, Flight | None] = {}
        self._fetched_at: dict[str, float] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def enrich(self, detail: TrackedObjectDetail) -> TrackedObjectDetail:
        """Return ``detail`` with the provider's track and origin, if there is one.

        Falls back to the detail exactly as given -- our own observed track,
        no origin -- whenever the provider has nothing, cannot say, or fails.
        **A provider failure must not fail the detail request**: the panel's
        other five fields are already in hand, and losing them because a
        secondary enrichment timed out would be a worse answer than a shorter
        line.
        """
        flight = await self._flight(detail.id)
        if flight is None or not flight.track:
            return detail

        # **The track has to belong to the flight the aircraft is on now.**
        #
        # The provider is asked for "this aircraft's track" and answers with the
        # last one it has, which after a turnaround is the *previous leg*. Two
        # were caught on screen: CSH832, flying Phuket to Shanghai, drawn along
        # a path from Guangdong to the Gulf of Thailand that ended 3.5 hours
        # earlier - and CES6018 with one 6.7 hours old, 500 km from the
        # aircraft. Both are outbound legs of the return journey, so the heading
        # derived from their last two points pointed **the opposite way to the
        # flight** (D196).
        #
        # Nothing about that answer is malformed, which is why it got this far:
        # it is a real track, of a real flight, by this airframe. It is simply
        # not the one being watched. Compared against the aircraft's own last
        # report rather than against the clock, because the question is whether
        # the two describe the same moment.
        newest = _newest_point(flight.track)
        if newest is None:
            return detail
        behind = (detail.last_seen - newest.timestamp).total_seconds()
        if behind > PROVIDER_TRACK_MAX_LAG_SECONDS:
            # **A long gap is a question, not an answer (D202).** D196 rejected
            # every one of them and threw away good paths: an aircraft crossing
            # an ocean goes unheard for an hour and more, and its track ends
            # where the receivers did. What separates that from the previous leg
            # is whether the aircraft could have *flown* from the end of the
            # track to where it is now.
            kilometres = (
                haversine_metres(newest.lat, newest.lon, detail.lat, detail.lon) / 1000.0
            )
            implied_kmh = kilometres / (behind / 3600.0)
            if not (TRACK_CONTINUITY_MIN_KMH <= implied_kmh <= TRACK_CONTINUITY_MAX_KMH):
                logger.info(
                    "provider track for %s ends %.0f min and %.0f km from the "
                    "aircraft - %.0f km/h, which is not a flight; keeping the "
                    "observed track",
                    detail.id,
                    behind / 60,
                    kilometres,
                    implied_kmh,
                )
                return detail

        update: dict[str, object] = {
            "track": flight.track,
            "track_source": TrackSource.PROVIDER,
            "origin": flight.origin,
        }

        # **The track can be newer than the position we are reporting.** It
        # comes from the provider's own flight history; the position comes from
        # our poll, which runs on the OpenSky credit budget and can be minutes
        # behind. Left alone, the panel says "last reported four minutes ago"
        # above a line whose newest point is fifty seconds old - two statements
        # about the same aircraft that cannot both be true, and the client
        # freezes the marker on the older one while drawing the newer line
        # (D138).
        #
        # A track point *is* a report, so the newest one wins.
        # `newest` was found above, when the track was checked for being this
        # flight's at all.
        if _is_newer(newest.timestamp, detail.last_seen):
            update["lat"] = newest.lat
            update["lon"] = newest.lon
            update["last_seen"] = newest.timestamp
            meta = dict(detail.meta)
            # Said out loud, like the derived heading and speed below: this is
            # not the field the feed gave us.
            meta["positionSource"] = "track"
            update["meta"] = meta

        # A heading that contradicts the aircraft's own track loses to it. The
        # 777 that started this reported 12 m/s on a heading of 7 degrees while
        # crossing Myanmar eastbound at cruise, and the marker pointed north
        # while its own line ran east (D80).
        #
        # **And a heading the aircraft never sent is supplied rather than left
        # blank.** These two blocks only ever *corrected* a reported value, so a
        # position that arrived without one - which happens on a sparse report,
        # and did to SIA23 crossing the Bay of Bengal with no callsign, no speed
        # and no heading - was drawn as a featureless disc while a 1,445-point
        # track sat beside it saying exactly which way the aircraft was going
        # (D203).
        course = course_from_track(flight.track)
        disagrees = (
            detail.heading is not None
            and course is not None
            and abs((course - detail.heading + 540.0) % 360.0 - 180.0)
            > COURSE_MAX_DISAGREEMENT_DEG
        )
        if course is not None and (detail.heading is None or disagrees):
            # Said out loud rather than corrected silently: every other number
            # in the panel is the source's own, and one that is not should be
            # identifiable.
            meta = dict(detail.meta)
            meta["headingSource"] = "derived"
            update["heading"] = course
            update["meta"] = meta

        # And the same for ground speed, on much stricter terms. The aircraft
        # that prompted this reported 12 m/s at cruise, which is not merely
        # wrong on the panel: the client dead-reckons along it, so the marker
        # crawls while the aircraft it represents does 240 m/s (D81).
        speed = speed_from_track(flight.track)
        implausible = (
            detail.velocity is not None
            and speed is not None
            and abs(speed - detail.velocity) > SPEED_MIN_DIFFERENCE_MS
            and (
                speed > SPEED_MIN_RATIO * detail.velocity
                or detail.velocity > SPEED_MIN_RATIO * speed
            )
        )
        if speed is not None and (detail.velocity is None or implausible):
            meta = dict(update.get("meta", detail.meta))  # type: ignore[arg-type]
            meta["velocitySource"] = "derived"
            update["velocity"] = speed
            update["meta"] = meta

        return detail.model_copy(update=update)

    async def _flight(self, object_id: str) -> Flight | None:
        cached = self._cached(object_id)
        if cached is not _MISS:
            return cached  # type: ignore[return-value]

        lock = self._locks.setdefault(object_id, asyncio.Lock())
        async with lock:
            # Re-check under the lock: several detail requests can arrive while
            # the first is in flight, and every one of them would otherwise buy
            # its own copy of the same answer.
            cached = self._cached(object_id)
            if cached is not _MISS:
                return cached  # type: ignore[return-value]

            flight: Flight | None = None
            try:
                track = await self._provider.fetch_track(object_id)
            except ProviderError as exc:
                # Cached as a negative, deliberately. An upstream that is
                # refusing or rate-limiting will refuse the next request too,
                # and retrying immediately is how a quota is spent on failures.
                logger.info("flight track unavailable for %s: %s", object_id, exc)
                track = None
            if track:
                # Cleaned before anything reads it: the origin comes off the
                # first waypoint and the course off the last two, so a spike at
                # either end would corrupt both (D82).
                track = clean_track(track)
            if track:
                flight = Flight(track=track, origin=origin_of(track), fetched_at=time.monotonic())

            self._cache[object_id] = flight
            self._fetched_at[object_id] = time.monotonic()
            return flight

    def _cached(self, object_id: str) -> Flight | None | object:
        fetched = self._fetched_at.get(object_id)
        if fetched is None or time.monotonic() - fetched > self._ttl:
            return _MISS
        return self._cache.get(object_id)

    def forget(self, object_id: str) -> None:
        """Drop one aircraft's cached flight. Used by tests and by nothing else."""
        self._cache.pop(object_id, None)
        self._fetched_at.pop(object_id, None)
        self._locks.pop(object_id, None)


#: Distinguishes "cached as nothing" from "not cached", which a plain None cannot.
_MISS = object()
