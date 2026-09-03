"""Integration tests for snapshot-mode export/import (``mode=snapshot``).

A snapshot is ``manifest.json`` + ``documents.jsonl`` in a tar.gz. Covered:
* snapshot export streams a readable gzip tar with both members;
* snapshot import reads the manifest, pre-checks schema compatibility, and
  only then writes rows;
* schema mismatch fails fast (409) with zero rows written;
* export -> snapshot file -> import roundtrip is lossless.
"""

from __future__ import annotations

import io
import json
import tarfile
from pathlib import Path

import pytest
from httpx import AsyncClient

zvec = pytest.importorskip("zvec")

pytestmark = pytest.mark.integration

API = "/api/v1"


def _collection_payload(name: str, dim: int = 4) -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": dim,
                "indexParam": {"indexType": "FLAT", "metric": "L2"},
            }
        ],
        "fields": [
            {"name": "title", "dataType": "STRING"},
            {"name": "score", "dataType": "INT64"},
        ],
    }


async def _seed(client: AsyncClient, tmp_path: Path, name: str, count: int) -> None:
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(tmp_path / name), "schema": _collection_payload(name)},
    )
    assert resp.status_code == 201, resp.text
    docs = [
        {
            "id": f"doc-{i:03d}",
            "title": f"t{i}",
            "score": i,
            "embedding": [float(i), 0.0, 0.0, 0.0],
        }
        for i in range(count)
    ]
    if docs:
        resp = await client.post(
            f"{API}/collections/{name}/documents", json={"documents": docs}
        )
        assert resp.status_code == 201, resp.text


class TestSnapshotExport:
    async def test_exports_tar_gz_with_manifest_and_data(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 3)

        resp = await client.get(
            f"{API}/collections/demo/documents:export", params={"mode": "snapshot"}
        )

        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/gzip")
        assert ".tar.gz" in resp.headers["content-disposition"]

        with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
            names = tar.getnames()
            assert "manifest.json" in names
            assert "documents.jsonl" in names

            manifest = json.load(tar.extractfile("manifest.json"))
            assert manifest["format"] == "zvec-studio.export/1"
            assert manifest["collection"]["name"] == "demo"
            assert manifest["options"]["includeVector"] is True

            data = tar.extractfile("documents.jsonl").read().decode("utf-8")
        rows = [json.loads(line) for line in data.splitlines() if line]
        assert len(rows) == 3
        assert rows[0]["id"] == "doc-000"

    async def test_snapshot_honours_include_vector_false(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 1)

        resp = await client.get(
            f"{API}/collections/demo/documents:export",
            params={"mode": "snapshot", "includeVector": "false"},
        )

        with tarfile.open(fileobj=io.BytesIO(resp.content), mode="r:gz") as tar:
            manifest = json.load(tar.extractfile("manifest.json"))
            data = tar.extractfile("documents.jsonl").read().decode("utf-8")

        assert manifest["options"]["includeVector"] is False
        assert "embedding" not in json.loads(data.strip())


class TestSnapshotImport:
    async def _export_to_file(
        self, client: AsyncClient, tmp_path: Path, source: str, count: int
    ) -> Path:
        await _seed(client, tmp_path, source, count)
        resp = await client.get(
            f"{API}/collections/{source}/documents:export", params={"mode": "snapshot"}
        )
        assert resp.status_code == 200, resp.text
        path = tmp_path / "snapshot.tar.gz"
        path.write_bytes(resp.content)
        return path

    async def test_import_snapshot_roundtrip(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        path = await self._export_to_file(client, tmp_path, "source", 4)
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "target"), "schema": _collection_payload("target")},
        )
        assert resp.status_code == 201, resp.text

        imported = await client.post(
            f"{API}/collections/target/documents:import",
            json={"source": {"kind": "localPath", "path": str(path)}},
        )

        assert imported.status_code == 200, imported.text
        assert imported.json()["imported"] == 4
        assert imported.json()["failed"] == 0

        rows = (
            await client.post(
                f"{API}/collections/target/documents:browse",
                json={"limit": 100, "includeVector": True},
            )
        ).json()["items"]
        assert {r["id"] for r in rows} == {f"doc-{i:03d}" for i in range(4)}

    async def test_schema_mismatch_is_409_and_writes_nothing(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        # Snapshot was exported with dimension 4; target declares dimension 8.
        path = await self._export_to_file(client, tmp_path, "source", 3)
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "target"), "schema": _collection_payload("target", dim=8)},
        )
        assert resp.status_code == 201, resp.text

        imported = await client.post(
            f"{API}/collections/target/documents:import",
            json={"source": {"kind": "localPath", "path": str(path)}},
        )

        assert imported.status_code == 409, imported.text
        assert imported.json()["code"] == "IMPORT_SCHEMA_MISMATCH"
        assert imported.json()["mismatches"]

        # No rows may have been written.
        stats = (await client.get(f"{API}/collections/target/stats")).json()
        assert stats["documentCount"] == 0

    async def test_vectors_not_exported_but_required_is_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "source", 2)
        resp = await client.get(
            f"{API}/collections/source/documents:export",
            params={"mode": "snapshot", "includeVector": "false"},
        )
        path = tmp_path / "novectors.tar.gz"
        path.write_bytes(resp.content)

        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "target"), "schema": _collection_payload("target")},
        )
        assert resp.status_code == 201, resp.text

        imported = await client.post(
            f"{API}/collections/target/documents:import",
            json={"source": {"kind": "localPath", "path": str(path)}},
        )

        assert imported.status_code == 409, imported.text
        assert imported.json()["code"] == "IMPORT_SCHEMA_MISMATCH"

    async def test_corrupt_manifest_is_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "source", 1)
        # Build a tar.gz whose manifest.json is not valid JSON.
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            info = tarfile.TarInfo("manifest.json")
            payload = b"not json"
            info.size = len(payload)
            tar.addfile(info, io.BytesIO(payload))
        path = tmp_path / "bad.tar.gz"
        path.write_bytes(buf.getvalue())

        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "target"), "schema": _collection_payload("target")},
        )
        assert resp.status_code == 201, resp.text

        imported = await client.post(
            f"{API}/collections/target/documents:import",
            json={"source": {"kind": "localPath", "path": str(path)}},
        )

        assert imported.status_code == 400, imported.text
        assert imported.json()["code"] == "IMPORT_MANIFEST_INVALID"
