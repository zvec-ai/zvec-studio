"""Unit tests for Pydantic Settings."""

from __future__ import annotations

import pytest

from zvec_studio.settings import Settings, get_settings


def test_defaults() -> None:
    s = Settings()
    assert s.host == "127.0.0.1"
    assert s.port == 7860
    assert s.log_level == "info"
    assert s.api_prefix == "/api/v1"
    assert "http://127.0.0.1:5173" in s.cors_origins


def test_env_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZVEC_STUDIO_HOST", "0.0.0.0")
    monkeypatch.setenv("ZVEC_STUDIO_PORT", "9999")
    monkeypatch.setenv("ZVEC_STUDIO_LOG_LEVEL", "debug")
    s = get_settings()
    assert s.host == "0.0.0.0"
    assert s.port == 9999
    assert s.log_level == "debug"


def test_port_bounds_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZVEC_STUDIO_PORT", "70000")  # out of range
    with pytest.raises(ValueError):
        get_settings()
