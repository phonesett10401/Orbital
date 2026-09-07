"""Server-side marker reduction.

Globe.gl's convenient ``pointsData()`` API creates one mesh per point. At
10,000 aircraft that is 10,000 draw calls and an unusable frame rate. Capping
what the client receives removes the worst case rather than mitigating it, and
doing it here is cheap -- the objects are already in memory and already being
scanned for the bounding box (D15).

The algorithm is a spatial grid, not a proximity cluster:

1. Divide the requested box into roughly ``limit`` cells.
2. Bucket every object into a cell.
3. Take the best object from each cell, then the second best from each, and so
   on until the budget is spent.

This spreads the survivors evenly across the visible area, so a zoomed-out
globe shows traffic everywhere rather than a solid blob over Europe and nothing
elsewhere.

**Stability matters more than optimality here.** If the chosen representative
of a cell flipped between polls, markers would flicker on and off every few
seconds. The ranking key is therefore altitude *bucketed to 1000 m* and then id
-- so a cruising aircraft outranks a taxiing one, but a hundred metres of climb
does not reshuffle the display.
"""

from __future__ import annotations

import math
from collections import defaultdict
from operator import itemgetter

from app.models import WORLD, BBox, TrackedObjectRecord

#: Altitude bucket in metres. Coarse on purpose: fine buckets would let normal
#: climb and descent reorder cell representatives between polls.
ALTITUDE_BUCKET_M = 1000.0


def rank_key(record: TrackedObjectRecord) -> tuple[float, str]:
    """Sort key: higher-flying first, ties broken by id.

    Preferring altitude means a zoomed-out view shows en-route traffic rather
    than a random selection dominated by ground vehicles at busy airports.
    Unknown altitude sorts last -- we know least about those objects.
    """
    altitude = record.altitude if record.altitude is not None else -1.0
    return (-math.floor(altitude / ALTITUDE_BUCKET_M), record.id)


def grid_shape(bbox: BBox, limit: int) -> tuple[int, int]:
    """Choose (cols, rows) so the grid has roughly ``limit`` cells.

    Proportional to the box's aspect ratio, so cells stay near-square and the
    survivors are spread evenly in both directions.
    """
    width = max(bbox.width_deg, 1e-9)
    height = max(bbox.height_deg, 1e-9)
    aspect = width / height

    cols = max(1, round(math.sqrt(limit * aspect)))
    rows = max(1, math.ceil(limit / cols))
    return cols, rows


def cell_of(record: TrackedObjectRecord, bbox: BBox, cols: int, rows: int) -> tuple[int, int]:
    """Which grid cell an object falls in.

    Longitude offset is computed modulo 360 so a box crossing the antimeridian
    buckets correctly instead of throwing everything into column zero.
    """
    width = max(bbox.width_deg, 1e-9)
    height = max(bbox.height_deg, 1e-9)

    dx = (record.lon - bbox.lon_min) % 360.0
    dy = record.lat - bbox.lat_min

    col = min(cols - 1, max(0, int(dx / width * cols)))
    row = min(rows - 1, max(0, int(dy / height * rows)))
    return col, row


def thin(
    records: list[TrackedObjectRecord],
    limit: int,
    bbox: BBox | None = None,
) -> list[TrackedObjectRecord]:
    """Reduce ``records`` to at most ``limit``, spread across ``bbox``.

    Returns the input unchanged when it already fits, so the common zoomed-in
    case costs nothing. The result is deterministic: the same input always
    produces the same output, which is what keeps markers from flickering.

    The bucketing loop is written flat rather than calling :func:`cell_of` and
    :func:`rank_key` per record. Those helpers exist and are tested, but at ten
    thousand objects the per-call overhead dominated: profiling showed this
    function costing ~20 ms, which on a single-threaded event loop delays every
    other request and the poller with it. The flat version computes the same
    values (D35).

    **It is still the most expensive thing the backend does, and an attempt to
    fix that failed.** Profiled at 29,000 objects it is 44 ms of a 62 ms
    request. The obvious waste is visible in the code below: 1,512 occupied
    cells holding ~19 records each are sorted in full, and the round-robin then
    reads a depth of 2 - about 28,700 records ordered to serve 3,024.

    Replacing the sort with an exactly-computed depth and ``heapq.nsmallest``
    produced byte-identical output and was **slower** in two of six measured
    shapes (ships 19.6 -> 24.8 ms, a viewport 10.3 -> 15.0 ms): ``nsmallest``
    with a key function costs more than ``list.sort`` on a nineteen-element
    list. The cost is the 29,000-iteration bucketing loop itself, which is
    close to what a per-record loop costs in Python at all.

    So the way to make this faster is **not to call it with 29,000 records**,
    which is what scoping a layer to the viewport does (D167). Left simple on
    purpose; do not re-attempt the partial sort without measuring these shapes
    first.
    """
    if limit <= 0:
        return []
    if len(records) <= limit:
        return sorted(records, key=rank_key)

    box = bbox or WORLD
    cols, rows = grid_shape(box, limit)

    # Hoisted out of the loop; recomputing these per record was most of the cost.
    width = max(box.width_deg, 1e-9)
    height = max(box.height_deg, 1e-9)
    lon_min = box.lon_min
    lat_min = box.lat_min
    col_scale = cols / width
    row_scale = rows / height
    inv_bucket = 1.0 / ALTITUDE_BUCKET_M
    floor = math.floor

    # Cell key is packed into one int so ordering matches the (col, row) tuple
    # ordering it replaces: column-major, exactly as before.
    buckets: dict[int, list[tuple[tuple[float, str], TrackedObjectRecord]]] = defaultdict(list)

    for record in records:
        dx = (record.lon - lon_min) % 360.0
        dy = record.lat - lat_min

        col = int(dx * col_scale)
        if col < 0:
            col = 0
        elif col >= cols:
            col = cols - 1

        row = int(dy * row_scale)
        if row < 0:
            row = 0
        elif row >= rows:
            row = rows - 1

        altitude = record.altitude if record.altitude is not None else -1.0
        buckets[col * rows + row].append(
            ((-floor(altitude * inv_bucket), record.id), record)
        )

    first = itemgetter(0)
    for bucket in buckets.values():
        bucket.sort(key=first)

    # Deterministic cell order, then round-robin by rank: every cell contributes
    # its best before any cell contributes its second best.
    ordered_cells = sorted(buckets)
    selected: list[TrackedObjectRecord] = []
    depth = 0
    deepest = max(len(b) for b in buckets.values())

    while depth < deepest and len(selected) < limit:
        for cell in ordered_cells:
            bucket = buckets[cell]
            if depth < len(bucket):
                selected.append(bucket[depth][1])
                if len(selected) >= limit:
                    break
        depth += 1

    return selected
