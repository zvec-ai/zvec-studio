"""Unit tests for ``zvec_studio.ai_store.AIFunctionRegistry``.

Covers CRUD, persistence, file mode 0600, and the bespoke 404 / 409 errors.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.exceptions import (
    AIFunctionAlreadyExistsError,
    AIFunctionNotFoundError,
)
from zvec_studio.schemas import EmbeddingFunctionRecord, RerankerFunctionRecord


def _embedding(name: str, *, dimension: int = 1024, key: str = "sk") -> EmbeddingFunctionRecord:
    return EmbeddingFunctionRecord.model_validate(
        {
            "name": name,
            "config": {"type": "qwen_dense", "dimension": dimension, "apiKey": key},
        }
    )


def _reranker(name: str) -> RerankerFunctionRecord:
    return RerankerFunctionRecord.model_validate(
        {"name": name, "config": {"type": "rrf", "rankConstant": 60}}
    )


class TestEmbeddingsCrud:
    def test_empty_registry_loads_blank_snapshot(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        snap = reg.load()
        assert snap.embeddings == []
        assert snap.rerankers == []

    def test_create_persists_to_disk(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("qwen-1024"))
        # Reload via a brand-new instance to confirm on-disk state.
        reg2 = AIFunctionRegistry(tmp_path)
        assert [r.name for r in reg2.list_embeddings()] == ["qwen-1024"]

    def test_persisted_file_is_chmod_0600(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("qwen-1024"))
        mode = stat.S_IMODE(os.stat(tmp_path / "ai_functions.json").st_mode)
        assert mode == 0o600

    def test_persisted_file_is_well_formed_json(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("qwen-1024"))
        raw = json.loads((tmp_path / "ai_functions.json").read_text(encoding="utf-8"))
        assert raw["embeddings"][0]["name"] == "qwen-1024"
        assert raw["embeddings"][0]["config"]["type"] == "qwen_dense"

    def test_duplicate_create_raises_409(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("dup"))
        with pytest.raises(AIFunctionAlreadyExistsError) as exc:
            reg.create_embedding(_embedding("dup"))
        assert exc.value.status_code == 409

    def test_get_missing_raises_404(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        with pytest.raises(AIFunctionNotFoundError) as exc:
            reg.get_embedding("ghost")
        assert exc.value.status_code == 404

    def test_update_replaces_record_and_allows_rename(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("old", dimension=512))
        new = _embedding("new", dimension=2048, key="sk-new")
        reg.update_embedding("old", new)
        assert [r.name for r in reg.list_embeddings()] == ["new"]
        assert reg.get_embedding("new").config.dimension == 2048

    def test_update_rename_collision_raises_409(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("a"))
        reg.create_embedding(_embedding("b"))
        with pytest.raises(AIFunctionAlreadyExistsError):
            reg.update_embedding("a", _embedding("b"))

    def test_update_missing_raises_404(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        with pytest.raises(AIFunctionNotFoundError):
            reg.update_embedding("ghost", _embedding("ghost"))

    def test_delete_removes_record(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("disposable"))
        reg.delete_embedding("disposable")
        assert reg.list_embeddings() == []

    def test_delete_missing_raises_404(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        with pytest.raises(AIFunctionNotFoundError):
            reg.delete_embedding("ghost")


class TestRerankersCrud:
    def test_create_persists_to_disk(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_reranker(_reranker("rrf"))
        reg2 = AIFunctionRegistry(tmp_path)
        assert [r.name for r in reg2.list_rerankers()] == ["rrf"]

    def test_duplicate_create_raises_409(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_reranker(_reranker("rrf"))
        with pytest.raises(AIFunctionAlreadyExistsError):
            reg.create_reranker(_reranker("rrf"))

    def test_update_and_delete(self, tmp_path: Path) -> None:
        reg = AIFunctionRegistry(tmp_path)
        reg.create_reranker(_reranker("first"))
        reg.update_reranker(
            "first",
            RerankerFunctionRecord.model_validate(
                {"name": "renamed", "config": {"type": "rrf", "rankConstant": 30}}
            ),
        )
        assert reg.get_reranker("renamed").config.rankConstant == 30
        reg.delete_reranker("renamed")
        assert reg.list_rerankers() == []


class TestCorruptFile:
    def test_corrupt_json_yields_empty_snapshot(self, tmp_path: Path) -> None:
        (tmp_path / "ai_functions.json").write_text("{ broken", encoding="utf-8")
        reg = AIFunctionRegistry(tmp_path)
        snap = reg.load()
        assert snap.embeddings == []
        assert snap.rerankers == []

    def test_save_after_corrupt_overwrites(self, tmp_path: Path) -> None:
        (tmp_path / "ai_functions.json").write_text("{ broken", encoding="utf-8")
        reg = AIFunctionRegistry(tmp_path)
        reg.create_embedding(_embedding("fresh"))
        # File should now parse cleanly.
        raw = json.loads((tmp_path / "ai_functions.json").read_text(encoding="utf-8"))
        assert raw["embeddings"][0]["name"] == "fresh"
