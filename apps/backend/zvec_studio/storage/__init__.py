"""Storage backend for Zvec Collections.

Single backend in v0.2.0: :class:`SdkBackend` proxies to the real Zvec 0.4.x
Python SDK (``zvec.create_and_open`` / ``zvec.open``). The HTTP layer wires
``app.state.backend = SdkBackend()`` once at startup; routers depend on it
through FastAPI's request injection so swapping it out in tests is a
one-liner.
"""

from __future__ import annotations

from zvec_studio.storage.sdk import CollectionRecord, SdkBackend

__all__ = [
    "CollectionRecord",
    "SdkBackend",
]
