"""Integration tests for the filesystem browse router (`/fs/list`)."""

from __future__ import annotations

import platform
from pathlib import Path

import pytest
from httpx import AsyncClient


@pytest.mark.integration
async def test_list_defaults_to_home(client: AsyncClient) -> None:
    response = await client.get("/api/v1/fs/list")
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == str(Path.home())
    assert body["home"] == str(Path.home())
    assert isinstance(body["entries"], list)
    for entry in body["entries"]:
        assert "name" in entry and "path" in entry
        # All entries are absolute paths.
        assert entry["path"].startswith("/") or entry["path"][1:3] == ":\\"


@pytest.mark.integration
async def test_list_specific_dir(tmp_path: Path, client: AsyncClient) -> None:
    sandbox = tmp_path / "fs_sandbox"
    sandbox.mkdir()
    (sandbox / "alpha").mkdir()
    (sandbox / "beta").mkdir()
    (sandbox / "ignored.txt").write_text("hi")

    response = await client.get("/api/v1/fs/list", params={"path": str(sandbox)})
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == str(sandbox.resolve())
    assert body["parent"] == str(sandbox.parent)
    names = [entry["name"] for entry in body["entries"]]
    assert names == ["alpha", "beta"]  # sorted, files excluded


@pytest.mark.integration
async def test_list_hidden_excluded_by_default(
    tmp_path: Path, client: AsyncClient
) -> None:
    sandbox = tmp_path / "fs_sandbox"
    sandbox.mkdir()
    (sandbox / ".hidden").mkdir()
    (sandbox / "visible").mkdir()

    response = await client.get("/api/v1/fs/list", params={"path": str(sandbox)})
    names = [e["name"] for e in response.json()["entries"]]
    assert names == ["visible"]


@pytest.mark.integration
async def test_list_hidden_included_when_requested(
    tmp_path: Path, client: AsyncClient
) -> None:
    sandbox = tmp_path / "fs_sandbox"
    sandbox.mkdir()
    (sandbox / ".hidden").mkdir()
    (sandbox / "visible").mkdir()

    response = await client.get(
        "/api/v1/fs/list",
        params={"path": str(sandbox), "show_hidden": "true"},
    )
    names = [e["name"] for e in response.json()["entries"]]
    assert names == [".hidden", "visible"]


@pytest.mark.integration
async def test_list_expands_tilde(client: AsyncClient) -> None:
    response = await client.get("/api/v1/fs/list", params={"path": "~"})
    assert response.status_code == 200
    assert response.json()["path"] == str(Path.home())


@pytest.mark.integration
async def test_list_404_when_missing(client: AsyncClient) -> None:
    response = await client.get(
        "/api/v1/fs/list",
        params={"path": "/this/path/should/not/exist/zvec_studio_test"},
    )
    assert response.status_code == 404


@pytest.mark.integration
async def test_list_400_when_not_dir(tmp_path: Path, client: AsyncClient) -> None:
    file = tmp_path / "afile.txt"
    file.write_text("x")

    response = await client.get("/api/v1/fs/list", params={"path": str(file)})
    assert response.status_code == 400


@pytest.mark.integration
@pytest.mark.skipif(platform.system() == "Windows", reason="POSIX root semantics")
async def test_root_has_no_parent(client: AsyncClient) -> None:
    response = await client.get("/api/v1/fs/list", params={"path": "/"})
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "/"
    assert body["parent"] is None
