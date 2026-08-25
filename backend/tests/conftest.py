"""Shared pytest configuration.

``anyio_backend`` pins async tests to asyncio. Without it, anyio's plugin would
also try to run every async test under trio, which we do not depend on.
"""

from __future__ import annotations

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"
