"""Shared pytest fixtures.

These fixtures are consumed by unit, integration and contract test suites.
They deliberately avoid any real Zvec SDK dependency so T0 scaffolding can
run the self-test loop without external resources.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from zvec_studio.main import create_app


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    """Fresh FastAPI application instance per test.

    Redirects ``data_dir`` to a tmp path so persisting ``ConfigStore`` state
    never touches the real user home. Uses the production :class:`SdkBackend`
    against the real Zvec SDK -- the in-memory test double was retired in
    v0.2.0 once the SDK became the only backend.
    """
    data_dir = tmp_path / "data"
    monkeypatch.setenv("ZVEC_STUDIO_DATA_DIR", str(data_dir))
    return create_app()


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """Async HTTP client that dispatches requests in-process via ASGITransport.

    ``raise_app_exceptions=False`` so the client surfaces the 500 response
    produced by Starlette's ServerErrorMiddleware instead of re-raising the
    original exception; that matches real HTTP client semantics.
    """
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        yield ac


@pytest.fixture
def tmp_collection_path(tmp_path: Path) -> Iterator[Path]:
    """Temporary, NOT-yet-existing directory for a Collection path.

    The Zvec SDK requires the destination not to exist when ``create`` is
    called (Zvec 0.4.x rejects pre-existing paths). The caller may freely
    create the directory itself; the fixture only guarantees the path is
    fresh and gets cleaned up by tmp_path.
    """
    path = tmp_path / "collection"
    yield path
    if path.exists():  # pragma: no cover - defensive
        shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
def artifacts_dir() -> Iterator[Path]:
    """Writable directory for diagnostic artifacts (used by failure hooks)."""
    base = Path(os.environ.get("ARTIFACTS_DIR", "artifacts"))
    base.mkdir(parents=True, exist_ok=True)
    yield base


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):  # type: ignore[no-untyped-def]
    """Dump diagnostic artifacts when a test fails.

    On failure, writes a JSON Lines-like record under ``artifacts/pytest/`` with
    the nodeid, phase and captured output. Intentionally best-effort: it must
    never mask the real failure.
    """
    outcome = yield
    report = outcome.get_result()
    if report.when != "call" or report.passed:
        return

    try:
        base = Path(os.environ.get("ARTIFACTS_DIR", "artifacts")) / "pytest"
        base.mkdir(parents=True, exist_ok=True)
        safe_id = report.nodeid.replace("/", "_").replace("::", "__")
        path = base / f"{safe_id}.log"
        captured = getattr(report, "longreprtext", "") or repr(report.longrepr)
        path.write_text(
            f"nodeid: {report.nodeid}\nphase: {report.when}\noutcome: {report.outcome}\n\n"
            f"{captured}\n",
            encoding="utf-8",
        )
    except Exception:  # pragma: no cover - diagnostic, never fail the suite
        pass


def _ignore_temp_dir() -> None:
    """Ensure tempfile uses a writable location even in sandboxed CI."""
    os.environ.setdefault("TMPDIR", tempfile.gettempdir())


_ignore_temp_dir()
