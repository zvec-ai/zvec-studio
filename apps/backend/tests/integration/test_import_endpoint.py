"""Integration tests for ``POST /collections/{name}/documents:import``.

Covers the HTTP contract from design doc §6.4: request validation, format
resolution (name / extension / default), source errors mapped to 4xx, and
row-level failures reported in the 200 body rather than as HTTP errors.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from .test_documents_router import _doc, _make_collection

API = "/api/v1"
pytestmark = pytest.mark.integration


def _jsonl(tmp_path: Path, rows: list[dict], name: str = "data.jsonl") -> Path:
    p = tmp_path / name
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


class TestImportHappyPath:
    async def test_import_jsonl_file(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(i) for i in range(3)])

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["imported"] == 3
        assert body["failed"] == 0
        assert body["totalLines"] == 3
        assert body["aborted"] is False
        assert body["errors"] == []
        assert body["errorsTruncated"] is False
        assert body["durationMs"] >= 0

        got = await client.get(f"{API}/collections/{name}/documents/doc-001")
        assert got.status_code == 200

    async def test_replace_is_the_default_mode(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents", json={"documents": [_doc(0)]}
        )
        source = _jsonl(tmp_path, [{**_doc(0), "title": "new-title"}])

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["imported"] == 1
        got = await client.get(f"{API}/collections/{name}/documents/doc-000")
        assert got.json()["title"] == "new-title"

    async def test_insert_mode_conflicts_reported_in_body(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents", json={"documents": [_doc(0)]}
        )
        source = _jsonl(tmp_path, [_doc(0), _doc(1)])

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={
                "source": {"kind": "localPath", "path": str(source)},
                "mode": "insert",
            },
        )

        # Row-level failures live in the 200 body, not the status code.
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["aborted"] is True
        assert body["failed"] == 1
        assert body["errors"][0]["code"] == "DOCUMENT_CONFLICT"
        assert body["errors"][0]["line"] == 1


class TestFormatResolution:
    async def test_format_inferred_from_extension(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)], name="payload.ndjson")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["imported"] == 1

    async def test_explicit_format_wins_over_extension(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)], name="payload.txt")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={
                "source": {"kind": "localPath", "path": str(source)},
                "format": "jsonl",
            },
        )

        assert resp.status_code == 200, resp.text

    async def test_unknown_extension_is_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)], name="data.csv")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "IMPORT_UNSUPPORTED_FORMAT"

    async def test_extensionless_file_defaults_to_jsonl(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)], name="datafile")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 200, resp.text


class TestSourceErrors:
    async def test_missing_file_is_404(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(tmp_path / "nope.jsonl")}},
        )

        assert resp.status_code == 404, resp.text
        assert resp.json()["code"] == "IMPORT_FILE_NOT_FOUND"

    async def test_directory_is_404(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(tmp_path)}},
        )

        assert resp.status_code == 404, resp.text
        assert resp.json()["code"] == "IMPORT_FILE_NOT_FOUND"

    async def test_unknown_collection_is_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        source = _jsonl(tmp_path, [_doc(0)])

        resp = await client.post(
            f"{API}/collections/ghost/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 404
        assert resp.json()["code"] == "COLLECTION_NOT_FOUND"

    async def test_corrupt_snapshot_is_400_not_500(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """A file named ``*.tar.gz`` that is not actually gzip is a user
        input error (400), not a server failure."""
        name = await _make_collection(client, tmp_path)
        source = tmp_path / "broken.tar.gz"
        source.write_bytes(b"this is definitely not a gzip stream")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "IMPORT_MANIFEST_INVALID"

    async def test_truncated_snapshot_is_400_not_500(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """A valid gzip header followed by garbage (mid-stream corruption)
        fails while reading members — still a user input error."""
        name = await _make_collection(client, tmp_path)
        source = tmp_path / "truncated.tar.gz"
        source.write_bytes(b"\x1f\x8b\x08\x00" + b"\x00" * 16 + b"garbage tail")

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "localPath", "path": str(source)}},
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "IMPORT_MANIFEST_INVALID"


class TestRequestValidation:
    async def test_batch_size_bounds(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)])

        for bad in (0, 1025):
            resp = await client.post(
                f"{API}/collections/{name}/documents:import",
                json={
                    "source": {"kind": "localPath", "path": str(source)},
                    "batchSize": bad,
                },
            )
            assert resp.status_code == 422, resp.text

    async def test_invalid_mode_is_422(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)])

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={
                "source": {"kind": "localPath", "path": str(source)},
                "mode": "merge",
            },
        )

        assert resp.status_code == 422

    async def test_unknown_source_kind_is_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        source = _jsonl(tmp_path, [_doc(0)])

        resp = await client.post(
            f"{API}/collections/{name}/documents:import",
            json={"source": {"kind": "upload", "path": str(source)}},
        )

        assert resp.status_code == 422
