"""Persistent registry for AI extension functions.

Stores user-defined embedding and reranker function configurations at
``<data_dir>/ai_functions.json``. The file is:

- Written atomically (mkstemp + ``os.replace``) so a crash mid-write never
  corrupts the registry.
- Set to ``chmod 0600`` (owner read/write only) so credentials embedded in
  the JSON (``apiKey``) are not world-readable.

This module deliberately does NOT instantiate any SDK extension class — that
job belongs to :mod:`zvec_studio.services.ai`. The registry is concerned
purely with persistence and CRUD bookkeeping.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from pathlib import Path
from threading import RLock

from zvec_studio.exceptions import (
    AIFunctionAlreadyExistsError,
    AIFunctionNotFoundError,
)
from zvec_studio.schemas import (
    AIFunctionRegistrySnapshot,
    EmbeddingFunctionRecord,
    RerankerFunctionRecord,
)

REGISTRY_FILE_NAME = "ai_functions.json"
_FILE_MODE = 0o600


class AIFunctionRegistry:
    """CRUD store for embedding and reranker function records.

    All public methods are thread-safe (guarded by an ``RLock``).
    """

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = Path(data_dir)
        self._file = self._data_dir / REGISTRY_FILE_NAME
        self._lock = RLock()

    # ------------------------------------------------------------------ io

    def load(self) -> AIFunctionRegistrySnapshot:
        with self._lock:
            if not self._file.exists():
                return AIFunctionRegistrySnapshot()
            try:
                raw = json.loads(self._file.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                # Treat corrupt file as empty; next save overwrites it.
                return AIFunctionRegistrySnapshot()
            try:
                return AIFunctionRegistrySnapshot.model_validate(raw)
            except Exception:  # pragma: no cover - defensive
                return AIFunctionRegistrySnapshot()

    def _save(self, snapshot: AIFunctionRegistrySnapshot) -> None:
        with self._lock:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            payload = snapshot.model_dump(mode="json")
            fd, tmp = tempfile.mkstemp(
                prefix=".ai_functions.", suffix=".tmp", dir=str(self._data_dir)
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh, indent=2)
                # chmod the *temp* file before rename so the final inode is
                # never visible with the default permissive mode.
                os.chmod(tmp, _FILE_MODE)
                os.replace(tmp, self._file)
            except Exception:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
            # Re-apply permissions in case the file pre-existed with a
            # different mode (e.g. created by an older build).
            try:
                current = stat.S_IMODE(os.stat(self._file).st_mode)
                if current != _FILE_MODE:
                    os.chmod(self._file, _FILE_MODE)
            except OSError:  # pragma: no cover - best effort
                pass

    # ----------------------------------------------------------- embeddings

    def list_embeddings(self) -> list[EmbeddingFunctionRecord]:
        return list(self.load().embeddings)

    def get_embedding(self, name: str) -> EmbeddingFunctionRecord:
        for rec in self.load().embeddings:
            if rec.name == name:
                return rec
        raise AIFunctionNotFoundError(
            f"Embedding function '{name}' not found.",
            extra={"name": name, "kind": "embedding"},
        )

    def create_embedding(
        self, record: EmbeddingFunctionRecord
    ) -> EmbeddingFunctionRecord:
        with self._lock:
            snap = self.load()
            if any(r.name == record.name for r in snap.embeddings):
                raise AIFunctionAlreadyExistsError(
                    f"Embedding function '{record.name}' already exists.",
                    extra={"name": record.name, "kind": "embedding"},
                )
            snap.embeddings.append(record)
            self._save(snap)
            return record

    def update_embedding(
        self, name: str, record: EmbeddingFunctionRecord
    ) -> EmbeddingFunctionRecord:
        with self._lock:
            snap = self.load()
            for i, r in enumerate(snap.embeddings):
                if r.name == name:
                    # Renames are allowed but must not collide.
                    if record.name != name and any(
                        x.name == record.name for x in snap.embeddings
                    ):
                        raise AIFunctionAlreadyExistsError(
                            f"Embedding function '{record.name}' already exists.",
                            extra={"name": record.name, "kind": "embedding"},
                        )
                    snap.embeddings[i] = record
                    self._save(snap)
                    return record
            raise AIFunctionNotFoundError(
                f"Embedding function '{name}' not found.",
                extra={"name": name, "kind": "embedding"},
            )

    def delete_embedding(self, name: str) -> None:
        with self._lock:
            snap = self.load()
            new = [r for r in snap.embeddings if r.name != name]
            if len(new) == len(snap.embeddings):
                raise AIFunctionNotFoundError(
                    f"Embedding function '{name}' not found.",
                    extra={"name": name, "kind": "embedding"},
                )
            snap.embeddings = new
            self._save(snap)

    # ------------------------------------------------------------ rerankers

    def list_rerankers(self) -> list[RerankerFunctionRecord]:
        return list(self.load().rerankers)

    def get_reranker(self, name: str) -> RerankerFunctionRecord:
        for rec in self.load().rerankers:
            if rec.name == name:
                return rec
        raise AIFunctionNotFoundError(
            f"Reranker function '{name}' not found.",
            extra={"name": name, "kind": "reranker"},
        )

    def create_reranker(
        self, record: RerankerFunctionRecord
    ) -> RerankerFunctionRecord:
        with self._lock:
            snap = self.load()
            if any(r.name == record.name for r in snap.rerankers):
                raise AIFunctionAlreadyExistsError(
                    f"Reranker function '{record.name}' already exists.",
                    extra={"name": record.name, "kind": "reranker"},
                )
            snap.rerankers.append(record)
            self._save(snap)
            return record

    def update_reranker(
        self, name: str, record: RerankerFunctionRecord
    ) -> RerankerFunctionRecord:
        with self._lock:
            snap = self.load()
            for i, r in enumerate(snap.rerankers):
                if r.name == name:
                    if record.name != name and any(
                        x.name == record.name for x in snap.rerankers
                    ):
                        raise AIFunctionAlreadyExistsError(
                            f"Reranker function '{record.name}' already exists.",
                            extra={"name": record.name, "kind": "reranker"},
                        )
                    snap.rerankers[i] = record
                    self._save(snap)
                    return record
            raise AIFunctionNotFoundError(
                f"Reranker function '{name}' not found.",
                extra={"name": name, "kind": "reranker"},
            )

    def delete_reranker(self, name: str) -> None:
        with self._lock:
            snap = self.load()
            new = [r for r in snap.rerankers if r.name != name]
            if len(new) == len(snap.rerankers):
                raise AIFunctionNotFoundError(
                    f"Reranker function '{name}' not found.",
                    extra={"name": name, "kind": "reranker"},
                )
            snap.rerankers = new
            self._save(snap)
