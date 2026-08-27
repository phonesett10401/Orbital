"""What a conditional request saves.

Committed for the same reason as `bench_backend.py`: so the numbers in
docs/test-plan.md are reproducible, and so a change that quietly removes the
saving is easy to catch.

    python benchmarks/bench_conditional.py

Measures one full list response against one 304 for the same representation,
through the real application stack -- routing, dependency injection,
serialization, gzip, and the response write. That whole stack runs on the
single event loop the poller also runs on, which is why the number to watch is
milliseconds of request time rather than bytes on the wire.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models import BBox, ObjectType, TrackedObjectRecord, utcnow  # noqa: E402
from app.providers.base import Provider  # noqa: E402

NOW = utcnow()
SCALES = (2_000, 10_000)
RUNS = 15


def synthetic(count: int) -> list[TrackedObjectRecord]:
    return [
        TrackedObjectRecord(
            id=f"{i:06x}",
            lat=(i % 179) - 89,
            lon=((i * 37) % 359) - 179,
            altitude=(i % 12) * 1000.0,
            velocity=200.0 + (i % 80),
            heading=(i * 7) % 360,
            label=f"BEN{i}",
            last_seen=NOW,
            type=ObjectType.AIRCRAFT,
            meta={"originCountry": "Testland"},
        )
        for i in range(count)
    ]


class StaticProvider(Provider):
    name = "bench"
    object_type = ObjectType.AIRCRAFT

    def __init__(self, records):
        self.records = records

    async def fetch(self, bbox: BBox | None = None):
        return list(self.records)


def median_ms(fn) -> float:
    samples = []
    for _ in range(RUNS):
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000)
    return round(statistics.median(samples), 2)


def main() -> None:
    results: dict[int, dict[str, float | int | str]] = {}

    for count in SCALES:
        provider = StaticProvider(synthetic(count))
        app = create_app(
            settings=Settings(quota_preset="authenticated", provider="fixture"),
            provider=provider,
        )
        with TestClient(app) as client:
            headers = {"Accept-Encoding": "gzip"}
            primed = client.get("/api/aircraft", headers=headers)
            etag = primed.headers["etag"]
            conditional = {**headers, "If-None-Match": etag}

            full_ms = median_ms(lambda: client.get("/api/aircraft", headers=headers))
            not_modified_ms = median_ms(
                lambda: client.get("/api/aircraft", headers=conditional)
            )

            check = client.get("/api/aircraft", headers=conditional)
            assert check.status_code == 304, check.status_code

            results[count] = {
                "held": count,
                "returned": primed.json()["returned"],
                "full_200_ms": full_ms,
                "not_modified_304_ms": not_modified_ms,
                "saved_ms": round(full_ms - not_modified_ms, 2),
                "saved_percent": round(100 * (full_ms - not_modified_ms) / full_ms, 1),
                # `content` is decoded by the client, so the wire size is read
                # off the header instead -- the gzip saving (D38) is already
                # counted there and must not be double-counted here.
                "full_wire_bytes": int(primed.headers.get("content-length", 0)),
                "full_decoded_bytes": len(primed.content),
                "not_modified_wire_bytes": int(check.headers.get("content-length", 0)),
                # 29 of every 30 client polls hit the unchanged case: the client
                # polls every 10 s and tier 1 refreshes every 300 s (D21).
                "saved_ms_per_30_polls": round(29 * (full_ms - not_modified_ms), 1),
            }

    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
