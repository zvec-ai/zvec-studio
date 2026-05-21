"""Unit tests for ``ConfigStore`` persistent user config (v2 schema).

The store keeps ``<data_dir>/config.json`` whose schema went through one
breaking change: v1 used a bare ``recentPaths: list[str]`` while v2 stores
``recent: list[{path, lastOpenedAt}]``. Old files are auto-migrated on load.
"""

from __future__ import annotations

import json
from pathlib import Path

from zvec_studio.config_store import (
    CONFIG_FILE_NAME,
    MAX_RECENT,
    ConfigStore,
    RecentEntry,
    UserConfig,
)


class TestLoad:
    def test_returns_empty_when_file_missing(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        cfg = store.load()
        assert cfg.recent == []

    def test_tolerates_corrupt_json(self, tmp_path: Path) -> None:
        tmp_path.mkdir(parents=True, exist_ok=True)
        (tmp_path / CONFIG_FILE_NAME).write_text("{{not json", encoding="utf-8")
        store = ConfigStore(tmp_path)
        cfg = store.load()
        assert cfg.recent == []

    def test_migrates_legacy_recent_paths(self, tmp_path: Path) -> None:
        """v1 ``recentPaths`` (str list) is upgraded to v2 ``recent`` on load."""
        tmp_path.mkdir(parents=True, exist_ok=True)
        (tmp_path / CONFIG_FILE_NAME).write_text(
            json.dumps({"recentPaths": ["/p/a", "/p/b"]}),
            encoding="utf-8",
        )
        store = ConfigStore(tmp_path)
        cfg = store.load()
        assert [e.path for e in cfg.recent] == ["/p/a", "/p/b"]
        # Migration synthesises a ``lastOpenedAt`` so UI sorting stays sane.
        assert all(e.lastOpenedAt for e in cfg.recent)


class TestSave:
    def test_save_creates_data_dir_atomically(self, tmp_path: Path) -> None:
        target = tmp_path / "nested"  # does not exist yet
        store = ConfigStore(target)
        store.save(
            UserConfig(
                recent=[
                    RecentEntry(path="/a", lastOpenedAt="2025-01-01T00:00:00+00:00"),
                    RecentEntry(path="/b", lastOpenedAt="2025-01-02T00:00:00+00:00"),
                ]
            )
        )
        file = target / CONFIG_FILE_NAME
        assert file.exists()
        raw = json.loads(file.read_text(encoding="utf-8"))
        assert [e["path"] for e in raw["recent"]] == ["/a", "/b"]
        # No legacy ``recentPaths`` key written by the v2 store.
        assert "recentPaths" not in raw
        # No stale .tmp files must remain.
        assert list(target.glob(".config.*.tmp")) == []

    def test_save_then_load_roundtrip(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.save(
            UserConfig(
                recent=[RecentEntry(path="/x", lastOpenedAt="2025-01-01T00:00:00+00:00")]
            )
        )
        cfg = store.load()
        assert [e.path for e in cfg.recent] == ["/x"]


class TestTouchRecent:
    def test_adds_to_front(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        cfg = store.touch_recent(tmp_path / "a")
        assert [e.path for e in cfg.recent] == [str((tmp_path / "a").resolve())]
        # Each new entry stamps its own ``lastOpenedAt``.
        assert cfg.recent[0].lastOpenedAt

    def test_dedupes_and_moves_to_front(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.touch_recent(tmp_path / "a")
        store.touch_recent(tmp_path / "b")
        cfg = store.touch_recent(tmp_path / "a")
        assert [e.path for e in cfg.recent] == [
            str((tmp_path / "a").resolve()),
            str((tmp_path / "b").resolve()),
        ]

    def test_caps_at_max_recent(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        for i in range(MAX_RECENT + 5):
            store.touch_recent(tmp_path / f"c{i}")
        cfg = store.load()
        assert len(cfg.recent) == MAX_RECENT
        # Most recently touched is at the front.
        assert cfg.recent[0].path == str((tmp_path / f"c{MAX_RECENT + 4}").resolve())


class TestForgetRecent:
    def test_removes_matching_entry(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.touch_recent(tmp_path / "a")
        store.touch_recent(tmp_path / "b")
        assert store.forget_recent(tmp_path / "a") is True
        cfg = store.load()
        assert [e.path for e in cfg.recent] == [str((tmp_path / "b").resolve())]

    def test_unknown_path_is_noop(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.touch_recent(tmp_path / "a")
        assert store.forget_recent(tmp_path / "never-touched") is False
        # Still has the original entry.
        assert len(store.load().recent) == 1

    def test_resolves_relative_input(self, tmp_path: Path, monkeypatch) -> None:
        store = ConfigStore(tmp_path)
        target = tmp_path / "rel"
        target.mkdir()
        store.touch_recent(target)
        # Pass the relative path; the store should canonicalise before matching.
        monkeypatch.chdir(tmp_path)
        assert store.forget_recent("rel") is True
        assert store.load().recent == []


class TestClearRecent:
    def test_clear_empties_list(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.touch_recent(tmp_path / "a")
        store.touch_recent(tmp_path / "b")
        store.clear_recent()
        assert store.load().recent == []

    def test_clear_when_already_empty_is_noop(self, tmp_path: Path) -> None:
        store = ConfigStore(tmp_path)
        store.clear_recent()  # must not raise
        assert store.load().recent == []
