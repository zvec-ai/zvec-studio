"""Process-local registry of opened Zvec Collections.

Task 1 provides the skeleton; Task 2 wires real ``zvec.Collection`` objects.
The registry exists on the FastAPI app state and is reset per-app instance so
that tests get isolation for free via ``create_app()`` in fixtures.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any

from zvec_studio.exceptions import (
    CollectionAlreadyExistsError,
    CollectionNotFoundError,
)


@dataclass
class CollectionHandle:
    """Lightweight placeholder for an opened SDK Collection.

    Task 2 replaces ``sdk_obj`` with a real ``zvec.Collection``. Keeping the
    structure generic here lets us unit-test the registry semantics without
    pulling the SDK as a hard dependency.
    """

    name: str
    path: Path
    sdk_obj: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)


class CollectionRegistry:
    """Thread-safe registry indexed by Collection name."""

    def __init__(self) -> None:
        self._by_name: dict[str, CollectionHandle] = {}
        self._lock = RLock()

    def list(self) -> list[CollectionHandle]:
        with self._lock:
            return list(self._by_name.values())

    def get(self, name: str) -> CollectionHandle:
        with self._lock:
            try:
                return self._by_name[name]
            except KeyError as exc:
                raise CollectionNotFoundError(
                    f"Collection '{name}' is not open.", extra={"name": name}
                ) from exc

    def add(self, handle: CollectionHandle) -> CollectionHandle:
        with self._lock:
            if handle.name in self._by_name:
                raise CollectionAlreadyExistsError(
                    f"Collection '{handle.name}' is already open.",
                    extra={"name": handle.name},
                )
            self._by_name[handle.name] = handle
            return handle

    def remove(self, name: str) -> CollectionHandle:
        with self._lock:
            if name not in self._by_name:
                raise CollectionNotFoundError(
                    f"Collection '{name}' is not open.", extra={"name": name}
                )
            return self._by_name.pop(name)

    def clear(self) -> None:
        with self._lock:
            self._by_name.clear()

    def __contains__(self, name: object) -> bool:
        with self._lock:
            return isinstance(name, str) and name in self._by_name

    def __len__(self) -> int:
        with self._lock:
            return len(self._by_name)
