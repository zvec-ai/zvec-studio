"""Security-focused integration tests for the filesystem router (/api/v1/fs).

Validates that the /fs/list and /fs/reveal endpoints correctly handle
adversarial inputs: path traversal, null bytes, symlinks, very long paths,
unicode names, and default parameter behaviour.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"


# ---------------------------------------------------------------------------
# Path traversal
# ---------------------------------------------------------------------------


async def test_path_traversal_not_a_directory(client: AsyncClient) -> None:
    """../../etc/passwd resolves to a file, not a directory -> 400."""
    resp = await client.get(f"{API}/fs/list", params={"path": "../../etc/passwd"})
    # /etc/passwd is a file; the endpoint requires a directory.
    # Depending on whether the path exists, we get 400 (not a dir) or 404.
    assert resp.status_code in (400, 404)


async def test_path_traversal_absolute(client: AsyncClient) -> None:
    """Absolute traversal /etc/passwd should fail (not a directory)."""
    resp = await client.get(f"{API}/fs/list", params={"path": "/etc/passwd"})
    assert resp.status_code in (400, 404)


# ---------------------------------------------------------------------------
# Null bytes
# ---------------------------------------------------------------------------


async def test_null_byte_in_path(client: AsyncClient) -> None:
    """Null bytes in path must not bypass checks — expect an error response."""
    resp = await client.get(f"{API}/fs/list", params={"path": "/tmp/\x00/etc/passwd"})
    # FastAPI/Pydantic or the OS layer should reject this.
    assert resp.status_code in (400, 404, 422, 500)
    # Crucially, we must NOT get a 200 with file contents.
    assert resp.status_code != 200


# ---------------------------------------------------------------------------
# Symlinks
# ---------------------------------------------------------------------------


async def test_symlink_to_directory_resolves(
    tmp_path: Path, client: AsyncClient
) -> None:
    """A symlink pointing to a directory is followed; only subdirs are listed."""
    real_dir = tmp_path / "real"
    real_dir.mkdir()
    (real_dir / "subdir").mkdir()
    (real_dir / "file.txt").write_text("secret")

    link = tmp_path / "link_to_real"
    link.symlink_to(real_dir)

    resp = await client.get(f"{API}/fs/list", params={"path": str(link)})
    assert resp.status_code == 200
    body = resp.json()
    # The resolved path should be the real directory.
    assert body["path"] == str(real_dir)
    # Only directories are listed (file.txt excluded).
    names = [e["name"] for e in body["entries"]]
    assert "subdir" in names
    assert "file.txt" not in names


async def test_symlink_to_sensitive_dir_only_lists_dirs(
    tmp_path: Path, client: AsyncClient
) -> None:
    """Symlink to /etc resolves; endpoint only lists subdirectories, never files."""
    if not Path("/etc").exists():
        pytest.skip("/etc not available on this platform")

    link = tmp_path / "link_to_etc"
    link.symlink_to(Path("/etc"))

    resp = await client.get(f"{API}/fs/list", params={"path": str(link)})
    assert resp.status_code == 200
    body = resp.json()
    # It resolves to /etc.
    assert body["path"] == str(Path("/etc").resolve())
    # All entries must be directories — no file contents exposed.
    for entry in body["entries"]:
        entry_path = Path(entry["path"])
        # The entry exists and is reported as such; the router filters non-dirs.
        assert entry_path.is_dir()


# ---------------------------------------------------------------------------
# Very long path
# ---------------------------------------------------------------------------


async def test_very_long_path_does_not_crash(client: AsyncClient) -> None:
    """Path string exceeding 4096 chars should yield an error, not crash."""
    long_path = "/" + "a" * 5000
    resp = await client.get(f"{API}/fs/list", params={"path": long_path})
    # Should be a clean HTTP error response, not a connection reset / unhandled crash.
    # The OS may raise ENAMETOOLONG which the error handler catches as 500,
    # or the path simply doesn't exist (404). Either way, no crash.
    assert resp.status_code in (400, 404, 422, 500)
    # The critical assertion: the server returned a well-formed JSON response.
    assert resp.headers.get("content-type", "").startswith("application/")


# ---------------------------------------------------------------------------
# Unicode / non-ASCII directory names
# ---------------------------------------------------------------------------


async def test_unicode_directory_name(
    tmp_path: Path, client: AsyncClient
) -> None:
    """Non-ASCII directory names are handled correctly."""
    unicode_dir = tmp_path / "datos_élève"
    unicode_dir.mkdir()
    child = unicode_dir / "中文目录"
    child.mkdir()

    resp = await client.get(f"{API}/fs/list", params={"path": str(unicode_dir)})
    assert resp.status_code == 200
    body = resp.json()
    names = [e["name"] for e in body["entries"]]
    assert "中文目录" in names


# ---------------------------------------------------------------------------
# Path with spaces
# ---------------------------------------------------------------------------


async def test_path_with_spaces(
    tmp_path: Path, client: AsyncClient
) -> None:
    """Paths containing spaces are handled correctly."""
    spaced_dir = tmp_path / "my directory with spaces"
    spaced_dir.mkdir()
    (spaced_dir / "inner dir").mkdir()

    resp = await client.get(f"{API}/fs/list", params={"path": str(spaced_dir)})
    assert resp.status_code == 200
    body = resp.json()
    names = [e["name"] for e in body["entries"]]
    assert "inner dir" in names


# ---------------------------------------------------------------------------
# show_hidden default
# ---------------------------------------------------------------------------


async def test_show_hidden_defaults_to_false(
    tmp_path: Path, client: AsyncClient
) -> None:
    """When show_hidden is not provided, dotfile directories are excluded."""
    sandbox = tmp_path / "hidden_default_test"
    sandbox.mkdir()
    (sandbox / ".secret").mkdir()
    (sandbox / "public").mkdir()

    # No show_hidden parameter at all.
    resp = await client.get(f"{API}/fs/list", params={"path": str(sandbox)})
    assert resp.status_code == 200
    names = [e["name"] for e in resp.json()["entries"]]
    assert "public" in names
    assert ".secret" not in names
