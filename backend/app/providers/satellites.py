"""Satellites, from published orbital elements (D93, D94).

This provider breaks the pattern every other one follows, and the difference is
the point rather than an inconvenience.

An aircraft provider asks an upstream "where is everything right now" and
relays the answer. Positions arrive already stale by however long the round
trip took, freshness is bought with poll frequency, and poll frequency is what
costs money. That is the whole shape of the aircraft layer: D21's credit
arithmetic, D23's throttle ladder, D83's two feeds, and adsb.lol's measured
rate limit all exist to manage it.

**None of that applies here.** Orbital elements describe an orbit, not a
position, and stay usable for days. So this provider fetches rarely, keeps what
it got, and *computes* a position for the exact instant it is asked. There is
no quota to spend, no cadence to tune, and a source outage is not an outage:
with cached elements the layer keeps working, accurately, for days. It is the
most reliable data path in the project, and it is the one with no upstream
budget at all.

What it does have is a way of being quietly wrong that the aircraft layer never
had. SGP4 degrades with age from epoch and never says so, so the freshness cut
in ``orbits.py`` is load-bearing rather than defensive: on a real SatNOGS pull,
87 of 1,670 element sets were over a year old and one was from 1975.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Awaitable, Callable, Iterable, Sequence

import httpx

from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow
from app.orbits import OrbitError, parse_epoch, propagate, tle_epoch
from app.providers.base import Provider, ProviderBadResponse, ProviderUnavailable
from app.providers.satellite_names import (
    SATNOGS_DIRECTORY_URL,
    parse_directory,
    resolve_names,
)

logger = logging.getLogger("app.providers.satellites")

#: How long a set of elements is kept before refetching.
#:
#: CelesTrak's own usage policy says they publish no faster than every two
#: hours and asks callers not to check more often, so this is their number
#: rather than ours. It is also far longer than anything the aircraft layer
#: does, which is the point: elements age in days, positions are computed
#: fresh every time.
ELEMENT_REFRESH_SECONDS = 6 * 3600.0


class ElementSet:
    """One object's orbital elements, with the identity that goes with them."""

    __slots__ = ("catalog_id", "name", "line1", "line2", "epoch")

    def __init__(self, catalog_id: str, name: str, line1: str, line2: str, epoch: datetime):
        self.catalog_id = catalog_id
        self.name = name
        self.line1 = line1
        self.line2 = line2
        self.epoch = epoch


def parse_elements(payload: object) -> list[ElementSet]:
    """Read either of the two shapes the free sources publish.

    CelesTrak's GP API answers OMM JSON; SatNOGS answers its own shape with the
    raw TLE lines. They agree on the substance and disagree on every key name,
    so both are read here rather than in two providers -- the difference is
    upstream spelling, not upstream meaning.
    """
    if not isinstance(payload, list):
        raise ProviderBadResponse(f"expected a list of element sets, got {type(payload).__name__}")

    out: list[ElementSet] = []
    for row in payload:
        if not isinstance(row, dict):
            continue
        line1 = row.get("TLE_LINE1") or row.get("tle1")
        line2 = row.get("TLE_LINE2") or row.get("tle2")
        if not line1 or not line2:
            continue

        name = (row.get("OBJECT_NAME") or row.get("tle0") or "").strip()
        # SatNOGS prefixes the name line with the TLE "0 " marker.
        if name.startswith("0 "):
            name = name[2:].strip()

        catalog_id = str(row.get("NORAD_CAT_ID") or row.get("norad_cat_id") or "").strip()
        if not catalog_id:
            catalog_id = line1[2:7].strip()

        try:
            epoch = parse_epoch(row["EPOCH"]) if row.get("EPOCH") else tle_epoch(line1)
        except (OrbitError, ValueError):
            continue

        out.append(ElementSet(catalog_id, name or catalog_id, line1, line2, epoch))
    return out


#: Where elements come from, most preferred first.
#:
#: CelesTrak is the authority and needs no credentials. SatNOGS is the fallback
#: and earned the place by working: CelesTrak's GP endpoint returned HTTP 500
#: for the whole of the day this was written, while its own catalogue pages
#: served fine, so "CelesTrak is up" is not the same question as "elements are
#: available". SatNOGS covers far fewer objects, which is why it is second and
#: not first.
DEFAULT_SOURCES: tuple[tuple[str, str], ...] = (
    ("celestrak", "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json"),
    ("satnogs", "https://db.satnogs.org/api/tle/?format=json"),
)

ElementFetcher = Callable[[], Awaitable[list[ElementSet]]]
NameFetcher = Callable[[], Awaitable[dict[str, str]]]


class SatelliteProvider(Provider):
    """Positions computed from cached orbital elements."""

    name = "satellites"
    object_type = ObjectType.SATELLITE

    #: Free, and not merely free-today: there is no metered upstream anywhere
    #: in this path. Declared rather than inherited so it reads as a decision
    #: -- a provider that stays silent about credits is how defect #34 went
    #: unnoticed for weeks.
    remaining_credits: int | None = None

    def __init__(
        self,
        *,
        sources: Sequence[tuple[str, str]] = DEFAULT_SOURCES,
        timeout_seconds: float = 60.0,
        user_agent: str = "Orbital/0.1 (CSC480 student project)",
        refresh_seconds: float = ELEMENT_REFRESH_SECONDS,
        fetch_elements: ElementFetcher | None = None,
        fetch_names: NameFetcher | None = None,
        cache_path: Path | None = None,
    ) -> None:
        self._sources = tuple(sources)
        self._timeout = timeout_seconds
        self._user_agent = user_agent
        self._refresh = refresh_seconds
        self._fetch_elements = fetch_elements or self._fetch_from_sources
        self._fetch_names = fetch_names or self._fetch_directory
        self._client: httpx.AsyncClient | None = None

        self._cache_path = cache_path
        self._elements: list[ElementSet] = []
        self._elements_at: datetime | None = None
        self._source_used: str | None = None
        self._lock = asyncio.Lock()

    # ---- elements ----------------------------------------------------------

    async def _client_or_new(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self._timeout,
                headers={"User-Agent": self._user_agent},
                follow_redirects=True,
            )
        return self._client

    async def _fetch_from_sources(self) -> list[ElementSet]:
        """Try each source in order; the first that answers usefully wins."""
        client = await self._client_or_new()
        failures: list[str] = []
        for source_name, url in self._sources:
            try:
                response = await client.get(url)
                response.raise_for_status()
                elements = parse_elements(response.json())
            except Exception as exc:
                failures.append(f"{source_name}: {type(exc).__name__}")
                logger.warning("element source %s failed: %s", source_name, exc)
                continue
            if elements:
                self._source_used = source_name
                logger.info("loaded %d element sets from %s", len(elements), source_name)
                return elements
            failures.append(f"{source_name}: no usable element sets")
        raise ProviderUnavailable("no element source answered: " + "; ".join(failures))

    async def _fetch_directory(self) -> dict[str, str]:
        """Catalogue number to real name, from the SatNOGS satellite database.

        A different endpoint from the elements: ``/api/satellites/`` is the
        directory and ``/api/tle/`` is the feed. The directory knows that
        2019-093C is CAS-6; the feed still calls it ``OBJECT C`` (D117).
        """
        client = await self._client_or_new()
        response = await client.get(SATNOGS_DIRECTORY_URL)
        response.raise_for_status()
        return parse_directory(response.json())

    def _read_cache(self) -> list[ElementSet]:
        """Elements saved by a previous run, or an empty list."""
        if self._cache_path is None or not self._cache_path.exists():
            return []
        try:
            payload = json.loads(self._cache_path.read_text(encoding="utf-8"))
            elements = parse_elements(payload)
        except Exception as exc:
            logger.warning("could not read the element cache: %s", exc)
            return []
        logger.info("loaded %d element sets from %s", len(elements), self._cache_path)
        # Named so the response envelope can say where the data came from. It
        # is the honest answer while a refresh has not yet succeeded, and it
        # tells a reader looking at /api/satellites that these are a previous
        # run's elements rather than a live pull.
        self._source_used = f"cache ({self._cache_path.name})"
        return elements

    def _write_cache(self, elements: Iterable[ElementSet]) -> None:
        if self._cache_path is None:
            return
        rows = [
            {
                "OBJECT_NAME": e.name,
                "NORAD_CAT_ID": e.catalog_id,
                "EPOCH": e.epoch.isoformat(),
                "TLE_LINE1": e.line1,
                "TLE_LINE2": e.line2,
            }
            for e in elements
        ]
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            # Write beside and rename, so a crash mid-write cannot leave a
            # half-written cache that then fails to parse on every start.
            temporary = self._cache_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(rows), encoding="utf-8")
            temporary.replace(self._cache_path)
        except OSError as exc:  # pragma: no cover - disk trouble
            logger.warning("could not write the element cache: %s", exc)

    async def _elements_for(self, now: datetime) -> list[ElementSet]:
        """Cached elements, refetched only when they are due.

        A failed refresh is **not** an error while we still hold elements. That
        is the whole reliability argument for this layer: yesterday's elements
        put a satellite within a kilometre or two of where it is, so an
        upstream outage should be invisible rather than emptying the sky.

        The cache is on **disk** rather than only in memory, and that is not
        tidiness. In memory alone, the argument above holds right up until the
        process restarts, at which point an outage becomes a total failure --
        which is exactly the situation this was written in: CelesTrak and
        SatNOGS were both returning errors within the same minute. A restart
        then leaves the layer with nothing, while a day-old file on disk would
        have kept it accurate to a kilometre or two.
        """
        async with self._lock:
            if self._elements_at is None and not self._elements:
                cached = self._read_cache()
                if cached:
                    self._elements = cached
                    # Deliberately not treated as a fresh fetch: the file may be
                    # days old, so a refresh is still due immediately. It is a
                    # floor to fall back to, not a reason to skip the network.

            due = (
                self._elements_at is None
                or (now - self._elements_at).total_seconds() >= self._refresh
            )
            if not due:
                return self._elements

            try:
                elements = await self._fetch_elements()
            except Exception:
                if self._elements:
                    logger.warning("element refresh failed; keeping the set we have")
                    return self._elements
                raise

            # Names are a nicety on top of positions, so a directory that
            # will not load must not cost us the elements that did. The whole
            # reliability argument for this layer is that an upstream failure
            # is invisible; a naming failure is less than that again.
            try:
                directory = await self._fetch_names()
            except Exception as exc:
                logger.warning("satellite name directory unavailable: %s", exc)
            else:
                resolved = resolve_names(elements, directory)
                if resolved:
                    logger.info(
                        "named %d objects the element feed left as placeholders", resolved
                    )

            self._elements = elements
            self._elements_at = now
            # Written after resolution, so a restart during an outage comes back
            # with the names as well as the orbits.
            self._write_cache(elements)
            return self._elements

    # ---- the interface -----------------------------------------------------

    async def refresh(self) -> int:
        """Fetch elements if they are due. Returns how many are held.

        Split out from ``fetch`` so the API can keep its strongest property:
        **no route performs I/O**. A request that might block on CelesTrak is a
        request that can 5xx because CelesTrak is down, which is exactly what
        the aircraft layer was built to avoid. The refresh runs on its own task
        instead, and the request path only ever does arithmetic.
        """
        await self._elements_for(utcnow())
        return len(self._elements)

    def positions(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Where every satellite is *now*, from the elements already held.

        Synchronous and network-free by construction. Propagating the whole
        catalogue measured 21 ms for 1,432 objects, which is why this can be
        done per request rather than polled into a store: a stored snapshot
        would be a position that was true a moment ago, when an exact one is
        available for the cost of some arithmetic (D95).
        """
        return self._propagate(utcnow(), self._elements, bbox)

    async def fetch(self, bbox: BBox | None = None) -> list[TrackedObjectRecord]:
        """Refresh if due, then propagate. The ``Provider`` interface entry point.

        ``bbox`` is applied after propagation. It cannot be pushed upstream the
        way an aircraft bounding box can -- knowing which satellites are inside
        a box requires working out where they all are first -- so unlike the
        metered providers there is nothing to save by narrowing it.
        """
        now = utcnow()
        elements = await self._elements_for(now)
        return self._propagate(now, elements, bbox)

    def _propagate(
        self,
        now: datetime,
        elements: Sequence[ElementSet],
        bbox: BBox | None,
    ) -> list[TrackedObjectRecord]:
        records: list[TrackedObjectRecord] = []
        refused = 0
        for element in elements:
            try:
                position = propagate(element.line1, element.line2, now, epoch=element.epoch)
            except OrbitError:
                # Stale, decayed or unreadable. Dropping is the whole point:
                # SGP4 would have answered, and the answer would look fine.
                refused += 1
                continue

            if bbox is not None and not bbox.contains(position.lat, position.lon):
                continue

            records.append(
                TrackedObjectRecord(
                    id=element.catalog_id,
                    lat=position.lat,
                    lon=position.lon,
                    altitude=position.altitude_m,
                    velocity=position.speed_m_s,
                    heading=position.heading_deg,
                    label=element.name,
                    model=None,  # D94: the catalogue's answer is the same for every row
                    # D94: when this position was current, which for something
                    # computed is now -- not the epoch of the elements.
                    last_seen=now,
                    type=ObjectType.SATELLITE,
                    meta={
                        # The orbit itself, which the universal shape has no
                        # room for and which is most of what a satellite panel
                        # has to say (D98).
                        "inclinationDeg": f"{position.inclination_deg:.2f}",
                        "periodMinutes": f"{position.period_minutes:.1f}",
                        # How much to trust the position above. It is here
                        # rather than in lastSeen because that field means
                        # "when was this current", and a computed position is
                        # current now (D94).
                        "elementEpoch": element.epoch.isoformat(),
                        "elementAgeDays": f"{position.element_age_days:.2f}",
                        "elementSource": self._source_used or "unknown",
                    },
                )
            )

        if refused:
            logger.debug("refused %d element sets as too old or unusable", refused)
        return records

    def search(self, query: str, *, limit: int = 8) -> list[TrackedObjectRecord]:
        """Satellites whose name or catalogue number matches, best first.

        Matched against the **held elements** rather than against propagated
        positions, so a keystroke costs a string scan over 1,670 names instead
        of propagating the whole catalogue. Only the matches are propagated.

        Tiered the way airports are (D89): an exact catalogue number first,
        then a name that starts with the query, then a name that contains it.
        Somebody typing "ISS" wants the space station, not every satellite with
        those three letters somewhere in its name.
        """
        needle = query.strip().upper()
        if not needle:
            return []

        exact: list[ElementSet] = []
        prefix: list[ElementSet] = []
        contains: list[ElementSet] = []
        for element in self._elements:
            name = element.name.upper()
            if element.catalog_id == needle or name == needle:
                exact.append(element)
            elif name.startswith(needle) or element.catalog_id.startswith(needle):
                prefix.append(element)
            elif needle in name:
                contains.append(element)

        now = utcnow()
        found: list[TrackedObjectRecord] = []
        for element in (*exact, *prefix, *contains):
            records = self._propagate(now, [element], None)
            found.extend(records)
            if len(found) >= limit:
                break
        return found[:limit]

    @property
    def element_count(self) -> int:
        return len(self._elements)

    @property
    def element_source(self) -> str | None:
        return self._source_used

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


def elements_from_file(path: Path) -> ElementFetcher:
    """An element source that reads a committed file, for tests and offline use.

    The same bargain the fixture provider makes (D8): the whole layer has to be
    developable and testable with no network and no credentials.
    """

    async def _load() -> list[ElementSet]:
        return parse_elements(json.loads(path.read_text(encoding="utf-8")))

    return _load
