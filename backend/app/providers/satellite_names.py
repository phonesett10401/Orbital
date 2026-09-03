"""What an object is called, and what it looks like.

An element set carries the name the catalogue had **when the object was
correlated**, and for a launch that deployed several payloads at once that is
usually a placeholder: each object takes a letter from its international
designator - ``2019-093C`` becomes ``OBJECT C`` - until somebody works out
which payload is which.

Somebody usually has. Two directories know things the element feed does not,
and they know different things, so both are read and merged (D118):

- **SatNOGS** ``/api/satellites/`` - curated, strong on small satellites, and
  **the only one with pictures**.
- **CelesTrak SATCAT** ``satcat/records.php`` - the official catalogue, which
  names objects SatNOGS has never curated.

Measured against the live catalogue: **266 of 1,429 objects arrived as
``OBJECT xx``.** SatNOGS named 213 of them. CelesTrak named 21 of the 53 that
remained - SHUNTIAN, ETRSS-1, FENGYUN 3H, ALSAT-3B, five DONGPO satellites -
leaving **32**, which is 2.2% of the sky rather than 19%.

**CelesTrak's SATCAT answers when its element endpoint does not.** ``gp.php``
returned 403 for days while ``satcat/records.php`` served normally, which is the
lesson D95 recorded about the 500s arriving again: *"CelesTrak is up" and
"elements are available" are different questions* - and so is "names are
available".

## Pictures come free with the names

The SatNOGS row that carries a name also carries an ``image``, and 1,040 of its
2,773 records have one, so a picture costs no extra request. The data is
**CC BY-SA 4.0** - attribution and share-alike - so the panel credits SatNOGS
beside the image.

## What this module will not do

It replaces a placeholder with a name. It never replaces a name with another
name, and never replaces a placeholder with a different placeholder - a
directory that has since forgotten an identity must not un-name an object we
could already name. Both are asserted rather than merely intended.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Iterable

logger = logging.getLogger(__name__)

#: The SatNOGS satellite directory, as opposed to its element feed at ``/api/tle/``.
#:
#: About 1.5 MB and five seconds, so it is fetched on the element refresh
#: cadence - every six hours - and never on a request path.
SATNOGS_DIRECTORY_URL = "https://db.satnogs.org/api/satellites/?format=json"

#: Where a SatNOGS ``image`` value hangs off. The field is a relative path.
SATNOGS_MEDIA_ROOT = "https://db.satnogs.org/media/"

#: CelesTrak's catalogue of active objects. About 5.6 MB and four seconds.
SATCAT_URL = "https://celestrak.org/satcat/records.php?GROUP=active&FORMAT=json"

#: An international designator with nothing else attached: ``2019-093C``.
_DESIGNATOR = re.compile(r"^\d{4}-\d{3}[A-Z]{1,3}$")

#: "TBA" as a word, never as the middle of one - "SATBAND" is a real name.
#:
#: Written with an editor rather than through a shell heredoc: the first
#: attempt at this line reached the file as a literal backspace (0x08) either
#: side of TBA, a pattern matching nothing. `grep` renders 0x08 invisibly and
#: `cat -A` shows it as ^H (D117).
_TBA = re.compile(r"\bTBA\b")


@dataclass(frozen=True)
class DirectoryEntry:
    """What a directory knows about one catalogue number."""

    name: str | None = None
    image_url: str | None = None


def is_placeholder(name: str | None) -> bool:
    """Whether this name identifies nothing.

    Four shapes, all seen in the live feed:

    - ``OBJECT C``, ``OBJECT BS`` - the catalogue's own placeholder
    - ``Unknown Satellite`` - SatNOGS's
    - ``Unknown Satellite - 19093L`` - SatNOGS's, with the launch appended,
      which is why UNKNOWN matches anywhere rather than only at the start
    - ``2019-093C`` - the bare international designator

    A catalogue number on its own counts too: ``parse_elements`` falls back to
    it when a feed carries no name at all.

    ``TRANSPORTER-11 OBJECT A`` is deliberately **not** a placeholder. It does
    not identify the spacecraft, but it identifies the launch, which is
    strictly more than ``OBJECT A`` says.
    """
    if not name:
        return True
    upper = name.strip().upper()
    if not upper:
        return True
    if upper.startswith("OBJECT") or "UNKNOWN" in upper:
        return True
    if _TBA.search(upper):
        return True
    if _DESIGNATOR.match(upper):
        return True
    return upper.isdigit()


def _clean(name: object) -> str | None:
    """A usable name, or ``None`` for anything that identifies nothing."""
    if not isinstance(name, str):
        return None
    stripped = name.strip()
    return None if is_placeholder(stripped) else stripped


def parse_satnogs_directory(payload: object) -> dict[str, DirectoryEntry]:
    """Catalogue number to name and picture, from a SatNOGS satellite listing.

    A row with only a placeholder name is still kept when it carries an image:
    the picture and the name are independent facts, and dropping the row would
    lose one to save nothing.
    """
    if not isinstance(payload, list):
        raise ValueError(f"expected a list of satellites, got {type(payload).__name__}")

    directory: dict[str, DirectoryEntry] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        norad = row.get("norad_cat_id")
        if norad is None:
            continue
        image = row.get("image")
        image_url = (
            SATNOGS_MEDIA_ROOT + image.lstrip("/")
            if isinstance(image, str) and image.strip()
            else None
        )
        entry = DirectoryEntry(name=_clean(row.get("name")), image_url=image_url)
        if entry.name or entry.image_url:
            directory[str(int(norad))] = entry
    return directory


def parse_satcat(payload: object) -> dict[str, DirectoryEntry]:
    """Catalogue number to name, from CelesTrak's SATCAT. No pictures there."""
    if not isinstance(payload, list):
        raise ValueError(f"expected a list of records, got {type(payload).__name__}")

    directory: dict[str, DirectoryEntry] = {}
    for row in payload:
        if not isinstance(row, dict):
            continue
        norad = row.get("NORAD_CAT_ID")
        name = _clean(row.get("OBJECT_NAME"))
        if norad is None or name is None:
            continue
        directory[str(int(norad))] = DirectoryEntry(name=name)
    return directory


def merge_directories(
    *directories: dict[str, DirectoryEntry],
) -> dict[str, DirectoryEntry]:
    """Combine directories, earlier ones winning on any field they fill.

    Field by field rather than row by row, because the two sources are good at
    different things: SatNOGS is the only one with pictures and CelesTrak names
    objects SatNOGS has never curated. Taking whole rows would mean choosing
    between a name and a picture that could both be had.
    """
    merged: dict[str, DirectoryEntry] = {}
    for directory in directories:
        for key, entry in directory.items():
            existing = merged.get(key)
            if existing is None:
                merged[key] = entry
                continue
            merged[key] = DirectoryEntry(
                name=existing.name or entry.name,
                image_url=existing.image_url or entry.image_url,
            )
    return merged


def resolve_names(
    elements: Iterable[object], directory: dict[str, DirectoryEntry]
) -> int:
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
        if not is_placeholder(getattr(element, "name", None)):
            continue
        entry = directory.get(str(getattr(element, "catalog_id", None)))
        # `_clean` has already reduced placeholders to None, so `entry.name` is
        # either a real name or absent. The check is kept anyway: it costs
        # nothing and it is the property that matters.
        if entry and entry.name and not is_placeholder(entry.name):
            element.name = entry.name
            resolved += 1
    return resolved


def image_index(directory: dict[str, DirectoryEntry]) -> dict[str, str]:
    """Just the pictures, keyed by catalogue number."""
    return {
        key: entry.image_url
        for key, entry in directory.items()
        if entry.image_url is not None
    }
