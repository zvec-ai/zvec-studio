"""Application settings (Pydantic Settings v2).

Environment variables follow the ``ZVEC_STUDIO_`` prefix. They can also be
sourced from a ``.env`` file placed next to the backend package. All defaults
target a safe local-only footprint (127.0.0.1 bind, info-level logging).
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

LogLevel = Literal["critical", "error", "warning", "info", "debug"]


class Settings(BaseSettings):
    """Runtime configuration surface for Zvec Studio."""

    model_config = SettingsConfigDict(
        env_prefix="ZVEC_STUDIO_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    host: str = Field(default="127.0.0.1", description="HTTP bind address")
    port: int = Field(default=7860, ge=1, le=65535, description="HTTP bind port")
    log_level: LogLevel = Field(default="info", description="Root log level")
    data_dir: Path = Field(
        default=Path.home() / ".zvec-studio",
        description="Directory where Studio persists config/state",
    )
    api_prefix: str = Field(default="/api/v1", description="API route prefix")
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ],
        description="Allowed CORS origins (dev server + Tauri desktop)",
    )


def get_settings() -> Settings:
    """Return a fresh Settings instance.

    Not cached on purpose: tests override env vars per-case and expect to read
    the latest values. Production code should bind Settings once via FastAPI
    dependency injection in :mod:`zvec_studio.deps`.
    """
    return Settings()
