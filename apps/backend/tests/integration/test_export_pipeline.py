"""Integration tests for the export pipeline.

Two layers under test:

* ``SdkBackend.iter_documents`` — the read path. The critical contract from
  PR #597: while an iterator is open, maintenance ops (create_index,
  optimize, ...) are rejected. Studio therefore MUST release the iterator on
  every exit path — normal completion, early break (client disconnect), and
  exceptions — or the user's collection stays "locked".
* ``GET /collections/{name}/documents:export`` — the HTTP surface: streaming
  JSONL, headers, format resolution, and the export->import roundtrip.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

zvec = pytest.importorskip("zvec")

from zvec_studio.schemas.collection import (  # noqa: E402
    CollectionSchema,
    IndexType,
    MetricType,
    VectorIndexParam,
)
from zvec_studio.storage.sdk import SdkBackend  # noqa: E402

pytestmark = pytest.mark.integration

API = "/api/v1"


def _schema(name: str = "export_source", *, with_id_field: bool = False) -> CollectionSchema:
    fields = [{"name": "title", "dataType": "STRING"}]
    if with_id_field:
        fields.insert(0, {"name": "id", "dataType": "STRING"})
    return CollectionSchema.model_validate(
        {
            "name": name,
            "vectors": [
                {
                    "name": "embedding",
                    "dataType": "VECTOR_FP32",
                    "dimension": 4,
                    "indexParam": {"indexType": "FLAT", "metric": "L2"},
                }
            ],
            "fields": fields,
        }
    )


def _make_collection(
    tmp_path: Path, *, count: int = 5, name: str = "export_source", with_id_field: bool = False
) -> SdkBackend:
    backend = SdkBackend()
    backend.create(path=tmp_path / name, schema=_schema(name, with_id_field=with_id_field))
    docs = []
    for i in range(count):
        doc = {
            "id": f"doc-{i:03d}",
            "title": f"t{i}",
            "embedding": [float(i), 0.0, 0.0, 0.0],
        }
        if with_id_field:
            doc["id"] = f"USER-{i}"
            doc["$id"] = f"doc-{i:03d}"
        docs.append(doc)
    backend.insert_documents(name, docs)
    return backend


class TestIterDocuments:
    def test_streams_all_rows_with_fields(self, tmp_path: Path) -> None:
        backend = _make_collection(tmp_path, count=5)

        rows = list(backend.iter_documents("export_source", include_vector=False))

        assert len(rows) == 5
        assert rows[0] == {"id": "doc-000", "title": "t0"}
        assert "embedding" not in rows[0]

    def test_include_vector_adds_vectors(self, tmp_path: Path) -> None:
        backend = _make_collection(tmp_path, count=2)

        rows = list(backend.iter_documents("export_source", include_vector=True))

        assert rows[1]["embedding"] == [1.0, 0.0, 0.0, 0.0]

    def test_output_fields_filters_columns(self, tmp_path: Path) -> None:
        backend = _make_collection(tmp_path, count=2)

        rows = list(
            backend.iter_documents(
                "export_source", include_vector=False, output_fields=["title"]
            )
        )

        assert rows[0] == {"id": "doc-000", "title": "t0"}

    def test_id_column_schema_uses_reserved_pk_key(self, tmp_path: Path) -> None:
        backend = _make_collection(tmp_path, count=1, with_id_field=True)

        rows = list(backend.iter_documents("export_source", include_vector=False))

        assert rows[0] == {"$id": "doc-000", "id": "USER-0", "title": "t0"}


class TestIteratorLifecycle:
    def test_maintenance_allowed_after_full_iteration(self, tmp_path: Path) -> None:
        backend = _make_collection(tmp_path, count=3)

        list(backend.iter_documents("export_source", include_vector=False))
        # Would raise if the iterator had leaked.
        backend.create_index(
            "export_source",
            vector_field="embedding",
            index_param=VectorIndexParam(indexType=IndexType.FLAT, metric=MetricType.L2),
        )

    def test_maintenance_allowed_after_early_close(self, tmp_path: Path) -> None:
        """Simulates a client disconnect: the generator is closed mid-stream."""
        backend = _make_collection(tmp_path, count=10)

        gen = backend.iter_documents("export_source", include_vector=False)
        next(gen)  # read a single row, then abandon the iterator
        gen.close()

        backend.create_index(
            "export_source",
            vector_field="embedding",
            index_param=VectorIndexParam(indexType=IndexType.FLAT, metric=MetricType.L2),
        )

    def test_maintenance_allowed_after_iteration_error(self, tmp_path: Path) -> None:
        """An exception while consuming must still release the iterator."""
        backend = _make_collection(tmp_path, count=5)

        with pytest.raises(RuntimeError, match="test abort"):
            for _ in backend.iter_documents("export_source", include_vector=False):
                raise RuntimeError("test abort")

        backend.create_index(
            "export_source",
            vector_field="embedding",
            index_param=VectorIndexParam(indexType=IndexType.FLAT, metric=MetricType.L2),
        )

    def test_maintenance_blocked_while_iterator_open_is_409(self, tmp_path: Path) -> None:
        """While an export iterator is open, maintenance is a transient
        conflict (409 MAINTENANCE_BLOCKED), not an opaque 5xx / 400."""
        from zvec_studio.exceptions import MaintenanceBlockedError

        backend = _make_collection(tmp_path, count=3)
        gen = backend.iter_documents("export_source", include_vector=False)
        next(gen)
        try:
            with pytest.raises(MaintenanceBlockedError) as exc:
                backend.optimize("export_source")
            assert exc.value.status_code == 409
            with pytest.raises(MaintenanceBlockedError):
                backend.create_index(
                    "export_source",
                    vector_field="embedding",
                    index_param=VectorIndexParam(
                        indexType=IndexType.FLAT, metric=MetricType.L2
                    ),
                )
        finally:
            gen.close()

        # Released: maintenance succeeds again.
        backend.optimize("export_source")


class TestMaintenanceBlockedHttp:
    async def test_optimize_during_export_is_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 3)
        app = client._transport.app  # type: ignore[attr-defined]
        gen = app.state.backend.iter_documents("demo", include_vector=False)
        next(gen)
        try:
            resp = await client.post(f"{API}/collections/demo:optimize")
            assert resp.status_code == 409, resp.text
            assert resp.json()["code"] == "MAINTENANCE_BLOCKED"
        finally:
            gen.close()

        resp = await client.post(f"{API}/collections/demo:optimize")
        assert resp.status_code == 200, resp.text


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------


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
    if not docs:
        return
    resp = await client.post(f"{API}/collections/{name}/documents", json={"documents": docs})
    assert resp.status_code == 201, resp.text


class TestExportEndpoint:
    async def test_exports_jsonl_with_headers(self, client: AsyncClient, tmp_path: Path) -> None:
        await _seed(client, tmp_path, "demo", 3)

        resp = await client.get(f"{API}/collections/demo/documents:export")

        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("application/x-ndjson")
        disposition = resp.headers["content-disposition"]
        assert "attachment" in disposition
        assert ".jsonl" in disposition

        rows = [json.loads(line) for line in resp.text.splitlines() if line]
        assert len(rows) == 3
        assert rows[0]["id"] == "doc-000"
        # Default export includes vectors.
        assert rows[0]["embedding"] == [0.0, 0.0, 0.0, 0.0]

    async def test_include_vector_false_omits_vectors(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 1)

        resp = await client.get(
            f"{API}/collections/demo/documents:export",
            params={"includeVector": "false"},
        )

        row = json.loads(resp.text.strip())
        assert "embedding" not in row

    async def test_output_fields_filters_columns(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 1)

        resp = await client.get(
            f"{API}/collections/demo/documents:export",
            params={"outputFields": "title", "includeVector": "false"},
        )

        row = json.loads(resp.text.strip())
        assert row == {"id": "doc-000", "title": "t0"}

    async def test_empty_collection_yields_empty_body(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _seed(client, tmp_path, "demo", 0)

        resp = await client.get(f"{API}/collections/demo/documents:export")

        assert resp.status_code == 200
        assert resp.text == ""

    async def test_unknown_format_is_400(self, client: AsyncClient, tmp_path: Path) -> None:
        await _seed(client, tmp_path, "demo", 1)

        resp = await client.get(
            f"{API}/collections/demo/documents:export", params={"format": "csv"}
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "EXPORT_UNSUPPORTED_FORMAT"

    async def test_unknown_collection_is_404(self, client: AsyncClient) -> None:
        resp = await client.get(f"{API}/collections/ghost/documents:export")

        assert resp.status_code == 404
        assert resp.json()["code"] == "COLLECTION_NOT_FOUND"


class TestExportImportRoundtrip:
    async def test_export_then_import_is_lossless(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The core promise: export -> file -> import reproduces every row."""
        await _seed(client, tmp_path, "source", 5)

        exported = await client.get(
            f"{API}/collections/source/documents:export",
            params={"includeVector": "true"},
        )
        assert exported.status_code == 200

        # Write the exported bytes to a file and import into a fresh collection.
        file_path = tmp_path / "roundtrip.jsonl"
        file_path.write_bytes(exported.content)
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "target"), "schema": _collection_payload("target")},
        )
        assert resp.status_code == 201, resp.text
        imported = await client.post(
            f"{API}/collections/target/documents:import",
            json={"source": {"kind": "localPath", "path": str(file_path)}},
        )
        assert imported.status_code == 200, imported.text
        assert imported.json()["imported"] == 5
        assert imported.json()["failed"] == 0

        # Compare row by row through the browse API.
        source_rows = (
            await client.post(
                f"{API}/collections/source/documents:browse",
                json={"limit": 100, "includeVector": True},
            )
        ).json()["items"]
        target_rows = (
            await client.post(
                f"{API}/collections/target/documents:browse",
                json={"limit": 100, "includeVector": True},
            )
        ).json()["items"]

        assert sorted(source_rows, key=lambda r: r["id"]) == sorted(
            target_rows, key=lambda r: r["id"]
        )
