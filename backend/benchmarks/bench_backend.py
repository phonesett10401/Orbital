"""Backend performance benchmark.

Committed so the numbers in docs/test-plan.md are reproducible rather than
anecdotal, and so a future change that regresses them is easy to catch.

    python benchmarks/bench_backend.py

Measures the three operations that sit on the request path or the poll path at
full scale. The number that matters most is thinning: the backend is a
single-threaded event loop, so a slow synchronous call there delays every other
request *and* the poller.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.ingestion.store import ObjectStore  # noqa: E402
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow  # noqa: E402
from app.thinning import thin  # noqa: E402

NOW = utcnow()
#: Roughly what OpenSky reports globally at a busy hour, plus headroom.
SCALES = (2_000, 10_000, 30_000)
CONUS = "25,-125,50,-65"


def synthetic(count: int) -> list[TrackedObjectRecord]:
    """Objects spread deterministically over the whole globe."""
    return [
        TrackedObjectRecord(
            id=f"{i:06x}",
            lat=(i % 179) - 89,
            lon=((i * 37) % 359) - 179,
            altitude=(i % 12) * 1000.0,
            velocity=200.0 + (i % 80),
            heading=(i * 7) % 360,
            label=f"T{i}",
            last_seen=NOW,
            type=ObjectType.AIRCRAFT,
            meta={"originCountry": "Testland"},
        )
        for i in range(count)
    ]


def median_ms(fn, runs: int = 15) -> float:
    samples = []
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000)
    return round(statistics.median(samples), 3)


def main() -> None:
    results: dict[int, dict[str, float | int]] = {}

    for count in SCALES:
        records = synthetic(count)
        store = ObjectStore(
            object_ttl_seconds=1800, track_history_points=50, snapshot_ttl_seconds=600
        )

        # First apply always runs the eviction sweep; subsequent ones inside
        # the eviction interval do not. Both are reported, because the first is
        # what a cold start costs and the second is what every poll costs.
        start = time.perf_counter()
        store.apply(records, source="bench")
        first_apply_ms = round((time.perf_counter() - start) * 1000, 1)

        steady = []
        for _ in range(5):
            start = time.perf_counter()
            store.apply(records, source="bench")
            steady.append((time.perf_counter() - start) * 1000)
        apply_ms = round(statistics.median(steady), 1)

        everything = store.get(None)
        box = BBox.parse(CONUS)

        results[count] = {
            "poll_apply_ms": apply_ms,
            "first_apply_ms": first_apply_ms,
            "bbox_filter_ms": median_ms(lambda: store.get(box)),
            "thin_to_2000_ms": median_ms(lambda: thin(everything, 2000, None)),
            "search_ms": median_ms(lambda: store.search("T1", limit=20)),
            "detail_ms": median_ms(lambda: store.get_detail(records[0].id)),
            "bbox_matches": len(store.get(box)),
        }

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
