"""Unit tests for the in-process CollectionRegistry."""

from __future__ import annotations

from pathlib import Path

import pytest

from zvec_studio.exceptions import (
    CollectionAlreadyExistsError,
    CollectionNotFoundError,
)
from zvec_studio.registry import CollectionHandle, CollectionRegistry


def _handle(name: str, tmp_path: Path) -> CollectionHandle:
    return CollectionHandle(name=name, path=tmp_path / name)


def test_registry_starts_empty() -> None:
    registry = CollectionRegistry()
    assert len(registry) == 0
    assert registry.list() == []


def test_add_and_retrieve(tmp_path: Path) -> None:
    registry = CollectionRegistry()
    handle = registry.add(_handle("alpha", tmp_path))
    assert handle.name == "alpha"
    assert registry.get("alpha") is handle
    assert "alpha" in registry
    assert len(registry) == 1


def test_add_rejects_duplicate_name(tmp_path: Path) -> None:
    registry = CollectionRegistry()
    registry.add(_handle("alpha", tmp_path))
    with pytest.raises(CollectionAlreadyExistsError) as ei:
        registry.add(_handle("alpha", tmp_path))
    assert ei.value.code == "COLLECTION_ALREADY_EXISTS"
    assert ei.value.extra == {"name": "alpha"}


def test_get_missing_raises(tmp_path: Path) -> None:
    registry = CollectionRegistry()
    with pytest.raises(CollectionNotFoundError) as ei:
        registry.get("missing")
    assert ei.value.code == "COLLECTION_NOT_FOUND"


def test_remove_and_clear(tmp_path: Path) -> None:
    registry = CollectionRegistry()
    registry.add(_handle("alpha", tmp_path))
    registry.add(_handle("beta", tmp_path))
    removed = registry.remove("alpha")
    assert removed.name == "alpha"
    assert "alpha" not in registry
    assert len(registry) == 1

    with pytest.raises(CollectionNotFoundError):
        registry.remove("alpha")

    registry.clear()
    assert len(registry) == 0


def test_contains_rejects_non_string() -> None:
    registry = CollectionRegistry()
    assert (123 in registry) is False
