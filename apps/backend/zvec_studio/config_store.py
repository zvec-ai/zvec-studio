"""Persistent user config stored at ``<data_dir>/config.json``.

Tracks the list of recently opened Collection paths (each with its own
``lastOpenedAt`` timestamp). The file is written atomically (temp-file +
rename) so crashes mid-write never leave a corrupt config behind.

Schema history:

* v1 — ``{"recentPaths": ["/abs/p1", "/abs/p2", ...]}`` — bare path list.
* v2 — ``{"recent": [{"path": "...", "lastOpenedAt": "..."}, ...]}`` — current.

Old v1 files are auto-migrated to v2 the first time they are loaded; the
``recentPaths`` key is dropped on the next save.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

CONFIG_FILE_NAME = "config.json"
MAX_RECENT = 10


def _now_iso() -> str:
    """ISO-8601 UTC timestamp with second precision (matches the API contract)."""
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


def _canonical(path: Path | str) -> str:
    """Resolve ``~`` and relative segments to a stable absolute path string."""
    return str(Path(path).expanduser().resolve())


class RecentEntry(BaseModel):
    """One element of :class:`UserConfig.recent`."""

    model_config = ConfigDict(extra="ignore")

    path: str
    name: str | None = None
    lastOpenedAt: str = Field(default_factory=_now_iso)


class UserConfig(BaseModel):
    """Schema for ``config.json`` (v2)."""

    model_config = ConfigDict(extra="ignore")

    recent: list[RecentEntry] = Field(default_factory=list)


class ConfigStore:
    """Load / save :class:`UserConfig` at a fixed ``data_dir``."""

    def __init__(self, data_dir: Path) -> None:
        self._data_dir = Path(data_dir)
        self._file = self._data_dir / CONFIG_FILE_NAME
        self._lock = RLock()

    # ---- io ------------------------------------------------------------------

    def load(self) -> UserConfig:
        with self._lock:
            if not self._file.exists():
                return UserConfig()
            try:
                raw = json.loads(self._file.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                # Treat a corrupt config as empty; next save will overwrite it.
                return UserConfig()
            try:
                return UserConfig.model_validate(self._migrate(raw))
            except Exception:  # pragma: no cover - defensive
                return UserConfig()

    @staticmethod
    def _migrate(raw: dict[str, Any]) -> dict[str, Any]:
        """Convert v1 ``recentPaths`` to v2 ``recent`` if needed.

        Newly-migrated entries get the current time as ``lastOpenedAt`` because
        v1 had no timestamp; the alternative would be a sentinel like the epoch
        which would cause UI clients to mis-sort the list on first launch.
        """
        if "recent" in raw and isinstance(raw["recent"], list):
            return raw
        legacy = raw.get("recentPaths")
        if isinstance(legacy, list):
            now = _now_iso()
            raw = dict(raw)
            raw["recent"] = [
                {"path": p, "lastOpenedAt": now}
                for p in legacy
                if isinstance(p, str)
            ]
            raw.pop("recentPaths", None)
        return raw

    def save(self, config: UserConfig) -> None:
        with self._lock:
            self._data_dir.mkdir(parents=True, exist_ok=True)
            payload: dict[str, Any] = config.model_dump(mode="json")
            # Atomic write: create .tmp then rename onto the real filename.
            fd, tmp = tempfile.mkstemp(
                prefix=".config.", suffix=".tmp", dir=str(self._data_dir)
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(payload, fh, indent=2)
                os.replace(tmp, self._file)
            except Exception:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise

    # ---- recent helpers ------------------------------------------------------

    def list_recent(self) -> list[RecentEntry]:
        """Return the current recent list (most-recent first)."""
        return list(self.load().recent)

    def touch_recent(self, path: Path | str, name: str | None = None) -> UserConfig:
        """Move ``path`` to the head of ``recent`` (de-duped, capped, timestamped)."""
        config = self.load()
        canonical = _canonical(path)
        rest = [e for e in config.recent if e.path != canonical]
        rest.insert(0, RecentEntry(path=canonical, name=name, lastOpenedAt=_now_iso()))
        config = config.model_copy(update={"recent": rest[:MAX_RECENT]})
        self.save(config)
        return config

    def forget_recent(self, path: Path | str) -> bool:
        """Drop a single entry. Returns ``True`` iff something was removed."""
        config = self.load()
        canonical = _canonical(path)
        kept = [e for e in config.recent if e.path != canonical]
        if len(kept) == len(config.recent):
            return False
        self.save(config.model_copy(update={"recent": kept}))
        return True

    def clear_recent(self) -> None:
        """Remove every recent entry."""
        config = self.load()
        if not config.recent:
            return
        self.save(config.model_copy(update={"recent": []}))
