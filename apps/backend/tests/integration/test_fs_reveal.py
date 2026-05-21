"""Integration tests for POST /api/v1/fs/reveal."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"


async def test_reveal_returns_204_on_valid_path(
    tmp_path: Path, client: AsyncClient
) -> None:
    target = tmp_path / "reveal_test"
    target.mkdir()

    with patch("zvec_studio.routers.fs.subprocess.Popen") as mock_popen:
        resp = await client.post(f"{API}/fs/reveal", json={"path": str(target)})

    assert resp.status_code == 204
    mock_popen.assert_called_once()
    args = mock_popen.call_args[0][0]
    assert str(target) in args


async def test_reveal_returns_404_on_missing_path(client: AsyncClient) -> None:
    resp = await client.post(
        f"{API}/fs/reveal",
        json={"path": "/this/path/does/not/exist/zvec_test_reveal"},
    )
    assert resp.status_code == 404


async def test_reveal_returns_500_on_missing_file_manager(
    tmp_path: Path, client: AsyncClient
) -> None:
    target = tmp_path / "reveal_test"
    target.mkdir()

    with patch(
        "zvec_studio.routers.fs.subprocess.Popen",
        side_effect=FileNotFoundError("open: not found"),
    ):
        resp = await client.post(f"{API}/fs/reveal", json={"path": str(target)})

    assert resp.status_code == 500
    assert "not found" in resp.json()["detail"].lower()
