"""Conditional requests for the list endpoint.

The client polls every 10 seconds. Tier 1 refreshes every 300 (D21), so
roughly twenty-nine polls in thirty ask for a snapshot the store has not
changed since the last answer, and every one of them serializes two thousand
objects, gzips the result and writes it to a socket -- on the single event loop
the poller also runs on.

An ETag turns those into a header comparison. What makes it cheap is *where*
the comparison happens: the tag is computed from the store's version counter
and the query alone, before the store is read, so a 304 never builds the
response at all.

**The validator is weak, and deliberately so.** Two responses for the same
store version are not byte-identical: `ageSeconds` counts up between polls. A
weak validator is exactly the tool for that -- it asserts the two
representations are semantically equivalent, not that they are the same bytes
(RFC 9110 8.8.1). The client is unaffected either way, because it already ticks
the age from its own clock between polls rather than trusting the number to
stay current.

Three things go into the tag that are easy to leave out, and each one is a way
of serving a client something wrong:

- **The query.** Two viewports are two different representations. Without the
  bbox and the cap in the tag, panning would return 304 and the map would never
  fill in.
- **Staleness.** `stale` flips on a clock, not on a write. Left out, a store
  whose upstream has died keeps answering 304 with its unchanging version, and
  the client is never told the data went cold -- the one moment the envelope
  has something new to say.
- **A per-process token.** The version counter starts at zero on every boot, so
  without it a restarted backend serves version 3 of a different dataset under
  the tag the client already holds. Restarts are not rare: they are how the
  provider gets switched.
"""

from __future__ import annotations

import secrets
from hashlib import blake2b

from app.models import BBox

# Regenerated on import, so two processes -- or the same process before and
# after a restart -- never mint the same tag for different data.
_PROCESS_TOKEN = secrets.token_hex(8)


def process_token() -> str:
    """The per-process component of every tag. Exposed for tests."""
    return _PROCESS_TOKEN


def compute_etag(
    *,
    version: int,
    object_type: str,
    bbox: BBox | None,
    limit: int,
    stale: bool,
    source: str | None,
) -> str:
    """The weak entity tag for one list response.

    Deliberately does not take the response, or the store's contents. It is a
    function of what *determines* the response, which is what lets the caller
    answer 304 without assembling one.
    """
    box = (
        "-"
        if bbox is None
        else f"{bbox.lat_min:.4f},{bbox.lon_min:.4f},{bbox.lat_max:.4f},{bbox.lon_max:.4f}"
    )
    material = "|".join(
        (
            _PROCESS_TOKEN,
            object_type,
            str(version),
            box,
            str(limit),
            "stale" if stale else "fresh",
            source or "-",
        )
    )
    digest = blake2b(material.encode("utf-8"), digest_size=12).hexdigest()
    return f'W/"{digest}"'


def if_none_match_matches(header: str | None, etag: str) -> bool:
    """Whether an `If-None-Match` header covers `etag`.

    The comparison is the weak one, which is the only kind permitted for
    `If-None-Match` (RFC 9110 13.1.2), so the `W/` prefix is stripped from both
    sides before comparing. A header may carry several tags, and `*` matches
    anything the server holds.
    """
    if not header:
        return False

    wanted = _strip_weak(etag)
    for candidate in header.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        if _strip_weak(candidate) == wanted:
            return True
    return False


def _strip_weak(tag: str) -> str:
    tag = tag.strip()
    if tag.startswith("W/"):
        tag = tag[2:]
    return tag.strip()
