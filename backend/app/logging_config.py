"""Application logging.

Without this module every ``logger.info`` in the poller and the provider went
nowhere. The calls were all written — credit balance, job results, token
acquisition, backoff — but Python's default configuration has no handler on the
root logger, so records from ``app.*`` were created and silently discarded.

That made D23 true only on paper: it requires the remaining credit balance to
be **logged**, and it was being read and surfaced on ``/api/health`` but never
written anywhere. Found by the live verification run, not by any test — no test
asserts on log output (D38).

Uvicorn configures its own ``uvicorn.*`` loggers and leaves the root logger
alone, so attaching a handler here is additive rather than conflicting.
"""

from __future__ import annotations

import logging
import sys

LOG_FORMAT = "%(asctime)s %(levelname)-7s %(name)-24s %(message)s"
DATE_FORMAT = "%H:%M:%S"

#: Our own package logger. Setting the level here rather than on the root
#: keeps third-party libraries at their own defaults instead of flooding the
#: console with httpx and asyncio internals.
APP_LOGGER = "app"


def configure_logging(level: str = "INFO") -> None:
    """Attach a stdout handler so ``app.*`` records are actually emitted.

    Idempotent: creating the application more than once in a test session must
    not stack duplicate handlers and print everything twice.
    """
    root = logging.getLogger()

    if not any(getattr(h, "_orbital", False) for h in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(LOG_FORMAT, datefmt=DATE_FORMAT))
        # Handler level stays permissive; filtering happens on the app logger,
        # so raising or lowering ORBITAL_LOG_LEVEL is the only control needed.
        handler.setLevel(logging.NOTSET)
        handler._orbital = True  # type: ignore[attr-defined]
        root.addHandler(handler)

    resolved = getattr(logging, level.upper(), logging.INFO)
    logging.getLogger(APP_LOGGER).setLevel(resolved)
