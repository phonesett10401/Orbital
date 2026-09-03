"""Turning ``OBJECT BS`` back into ``VisionCube``.

An element set carries the name the catalogue had **when the object was
correlated**, and for a launch that deployed several payloads at once that is
usually a placeholder: each object takes a letter from its international
designator - ``2019-093C`` becomes ``OBJECT C`` - until somebody works out
which payload is which.

Somebody usually has. SatNOGS's *database* knows that 2019-093C is CAS-6; its
*element feed*, which is what Orbital reads, still says ``OBJECT C``. The two
are the same project and we already call one of them.

Measured against the live catalogue on 2026-09-03: **266 of 1,429 objects were
shown as ``OBJECT xx``, and SatNOGS had a real identity for 213 of them.** So
four out of five satellites labelled unidentified were nothing of the kind -
FloripaSat-1, NanoDragon, CBERS-4A, the four SNIPE spacecraft flying in
formation. Only 53 of 1,429 are genuinely unidentified (D117).

**This is D102 arriving a second time.** There, 70% of a named catalogue was
reported as "Unidentified object" because a name missed our pattern list; the
label made a claim about the world from a fact about our code. This is the
same mistake one layer further upstream: the claim was true of the *feed we
happened to read* rather than of the object.

## What this module will not do

It replaces a placeholder with a name. It never replaces a name with another
name, and never replaces a placeholder with a different placeholder - a
directory that has since forgotten an identity must not un-name an object we
could already name. Both are asserted rather than merely intended.
"""

from __future__ import annotations

import logging
import re
from typing import Iterable

logger = logging.getLogger(__name__)

#: The satellite directory, as opposed to the element feed at ``/api/tle/``.
#:
#: About 1.5 MB and five seconds, so it is fetched on the element refresh
#: cadence and never on a request path - the same rule the elements follow.
SATNOGS_DIRECTORY_URL = "https://db.satnogs.org/api/satellites/?format=json"

#: An international designator with nothing else attached: ``2019-093C``.
_DESIGNATOR = re.compile(r"^\d{4}-\d{3}[A-Z]{1,3}$")

#: "TBA" as a word, never as the middle of one - "SATBAND" is a real name.
#: Written with a byte-level edit, because this line is exactly what a
#: shell heredoc eats: the first attempt reached the file as a literal
#: backspace (0x08) either side of TBA, a pattern matching nothing.
#: `grep` renders 0x08 invisibly; `cat -A` shows it as ^H.
_TBA = re.compile(r"\bTBA\b")


def is_placeholder(name: str | None) -> bool:
    """Whether this name identifies nothing.

    Four shapes, all seen in the live feed:

    - ``OBJECT C``, ``OBJECT BS`` - the catalogue's own placeholder
    - ``Unknown Satellite`` - SatNOGS's
    - ``Unknown Satellite - 19093L`` - SatNOGS's, with the launch appended,
      which is why this matches anywhere in the string rather than at the start
    - ``2019-093C`` - the bare international designator

    A catalogue number on its own counts too: ``parse_elements`` falls back to
    it when a feed carries no name at all.
    """
    if not name:
        return True
    upper = name.strip().upper()
    if not upper:
        return True
    # `TBA` is matched on a word boundary, not as a substring: "SATBAND"
    # contains the letters T-B-A and is a perfectly real name. `UNKNOWN` is
    # matched anywhere because SatNOGS appends the launch to it - "Unknown
    # Satellite - 19093L" - and no real satellite name contains the word.
    if upper.startswith("OBJECT") or "UNKNOWN" in upper:
        return True
    if _TBA.search(upper):
        return True
    if _DESIGNATOR.match(upper):
        return True
    # A bare catalogue number identifies the object but does not name it.
    return upper.isdigit()


def parse_directory(payload: object) -> dict[str, str]:
    """Catalogue number to real name, from a SatNOGS satellite listing.

    Placeholders are dropped here rather than at the point of use, so the
    directory contains only names worth having and a caller cannot accidentally
    overwrite one placeholder with another.
    """
    if not isinstance(payload, list):
        raise ValueError(f"expected a list of satellites, got {type(payload).__name__}")

    directory: dict[str, str] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        norad = row.get("norad_cat_id")
        name = row.get("name")
        if norad is None or not isinstance(name, str):
            continue
        if is_placeholder(name):
            continue
        directory[str(int(norad))] = name.strip()
    return directory


def resolve_names(elements: Iterable[object], directory: dict[str, str]) -> int:
    """Give every placeholder-named element its real name. Returns how many.

    Mutates in place because an ``ElementSet`` is the thing already held and
    propagated from; rebuilding the list would mean rebuilding the cache and
    the search index behind it for no gain.

    An element whose name is *not* a placeholder is left alone even when the
    directory disagrees. The element feed is the authority on what an object is
    called; this only fills a blank.
    """
    resolved = 0
    for element in elements:
        name = getattr(element, "name", None)
        if not is_placeholder(name):
            continue
        catalog_id = getattr(element, "catalog_id", None)
        better = directory.get(str(catalog_id))
        # `parse_directory` has already dropped placeholders, so `better` is
        # either a real name or absent. The check is kept anyway: it costs
        # nothing and it is the property that matters.
        if better and not is_placeholder(better):
            element.name = better
            resolved += 1
    return resolved
