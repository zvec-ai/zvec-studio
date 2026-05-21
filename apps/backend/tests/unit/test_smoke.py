"""Smoke-level unit tests proving the T0 scaffolding wires up correctly.

Task 1 onwards will replace these with real middleware / router tests.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from zvec_studio import __version__
from zvec_studio.cli import build_parser, main
from zvec_studio.main import create_app


def test_package_version_is_pep440() -> None:
    assert __version__
    # PEP 440 dev segments allow .devN; basic sanity check only.
    assert "." in __version__


def test_create_app_returns_fastapi_instance() -> None:
    app = create_app()
    assert app.title == "Zvec Studio API"
    assert app.openapi_url == "/api/v1/openapi.json"


def test_healthz_and_readyz_are_registered() -> None:
    app = create_app()
    paths = {route.path for route in app.routes}  # type: ignore[attr-defined]
    assert "/api/v1/healthz" in paths
    assert "/api/v1/readyz" in paths


def test_cli_parser_defaults() -> None:
    parser = build_parser()
    args = parser.parse_args([])
    assert args.host == "127.0.0.1"
    assert args.port == 7860
    assert args.reload is False
    assert args.log_level == "info"


def test_cli_parser_custom_args() -> None:
    parser = build_parser()
    args = parser.parse_args(["--host", "0.0.0.0", "--port", "9000", "--reload", "--log-level", "debug"])
    assert args.host == "0.0.0.0"
    assert args.port == 9000
    assert args.reload is True
    assert args.log_level == "debug"


def test_cli_parser_rejects_invalid_log_level() -> None:
    parser = build_parser()
    with pytest.raises(SystemExit):
        parser.parse_args(["--log-level", "bogus"])


def test_cli_main_invokes_uvicorn_run() -> None:
    with patch("zvec_studio.cli.uvicorn.run") as mock_run:
        exit_code = main(["--port", "7861"])
    assert exit_code == 0
    mock_run.assert_called_once()
    kwargs = mock_run.call_args.kwargs
    assert kwargs["host"] == "127.0.0.1"
    assert kwargs["port"] == 7861
    assert kwargs["reload"] is False
    assert kwargs["log_level"] == "info"
