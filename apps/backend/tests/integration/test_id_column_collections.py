"""Integration tests for collections whose schema declares an ``id`` column.

Zvec allows a scalar field (or a vector) named ``id`` to coexist with the
built-in ``Doc.id`` primary key. Studio used to reject that name, which meant:

* ``POST /collections/open`` returned 500 for any SDK-created collection with
  such a column -- it could not be managed through Studio at all;
* the flat row representation silently dropped the real primary key.

Both are fixed by moving the primary key to the ``$id`` row key whenever a
column takes ``id`` (see ``storage/doc_repr.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import zvec
from httpx import AsyncClient

API = "/api/v1"
pytestmark = pytest.mark.integration


def _create_via_sdk(path: Path, *, id_is_vector: bool = False) -> None:
    """Create a collection with an ``id`` column using the raw SDK."""
    if id_is_vector:
        vectors = [zvec.VectorSchema("id", zvec.DataType.VECTOR_FP32, 4)]
        fields = [zvec.FieldSchema("title", zvec.DataType.STRING)]
    else:
        vectors = [zvec.VectorSchema("embedding", zvec.DataType.VECTOR_FP32, 4)]
        fields = [
            zvec.FieldSchema("id", zvec.DataType.STRING),
            zvec.FieldSchema("title", zvec.DataType.STRING),
        ]
    schema = zvec.CollectionSchema(name=path.name, vectors=vectors, fields=fields)
    collection = zvec.create_and_open(path=str(path), schema=schema)
    if id_is_vector:
        collection.insert(
            [zvec.Doc(id="PK-001", vectors={"id": [0.1, 0.2, 0.3, 0.4]}, fields={"title": "t"})]
        )
    else:
        collection.insert(
            [
                zvec.Doc(
                    id="PK-001",
                    vectors={"embedding": [0.1, 0.2, 0.3, 0.4]},
                    fields={"id": "USER-999", "title": "t"},
                )
            ]
        )
    collection.flush()


class TestOpenExternalCollection:
    async def test_open_collection_with_id_field(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Regression: this used to fail with HTTP 500."""
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)

        resp = await client.post(f"{API}/collections/open", json={"path": str(path)})

        assert resp.status_code == 200, resp.text
        names = [f["name"] for f in resp.json()["schema"]["fields"]]
        assert "id" in names

    async def test_open_collection_with_id_vector(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        path = tmp_path / "legacy_vector"
        _create_via_sdk(path, id_is_vector=True)

        resp = await client.post(f"{API}/collections/open", json={"path": str(path)})

        assert resp.status_code == 200, resp.text
        assert [v["name"] for v in resp.json()["schema"]["vectors"]] == ["id"]


class TestPrimaryKeyIsPreserved:
    async def test_get_document_keeps_both_values(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The primary key lands on ``$id``; the ``id`` field keeps its own value."""
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)
        await client.post(f"{API}/collections/open", json={"path": str(path)})

        got = await client.get(f"{API}/collections/{path.name}/documents/PK-001")

        assert got.status_code == 200, got.text
        body = got.json()
        assert body["$id"] == "PK-001"
        assert body["id"] == "USER-999"
        assert body["title"] == "t"

    async def test_browse_keeps_both_values(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)
        await client.post(f"{API}/collections/open", json={"path": str(path)})

        resp = await client.post(
            f"{API}/collections/{path.name}/documents:browse", json={"limit": 10}
        )

        assert resp.status_code == 200, resp.text
        rows = resp.json()["items"]
        assert len(rows) == 1
        assert rows[0]["$id"] == "PK-001"
        assert rows[0]["id"] == "USER-999"

    async def test_search_keeps_both_values(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The search read path goes through the same row representation."""
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)
        await client.post(f"{API}/collections/open", json={"path": str(path)})

        resp = await client.post(
            f"{API}/collections/{path.name}/searches",
            json={
                "vector": [0.1, 0.2, 0.3, 0.4],
                "vectorField": "embedding",
                "topK": 5,
            },
        )

        assert resp.status_code == 200, resp.text
        results = resp.json()["results"]
        assert len(results) == 1
        assert results[0]["id"] == "PK-001"  # dedicated hit pk
        assert results[0]["fields"]["$id"] == "PK-001"
        assert results[0]["fields"]["id"] == "USER-999"


class TestWriteWithIdColumn:
    async def test_insert_requires_reserved_key(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)
        await client.post(f"{API}/collections/open", json={"path": str(path)})

        resp = await client.post(
            f"{API}/collections/{path.name}/documents",
            json={
                "documents": [
                    {
                        "$id": "PK-002",
                        "id": "USER-2",
                        "title": "t2",
                        "embedding": [0.5, 0.5, 0.5, 0.5],
                    }
                ]
            },
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["ids"] == ["PK-002"]

        got = await client.get(f"{API}/collections/{path.name}/documents/PK-002")
        assert got.json()["$id"] == "PK-002"
        assert got.json()["id"] == "USER-2"

    async def test_ambiguous_plain_id_is_rejected(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """A bare ``id`` cannot be resolved when the schema declares one."""
        path = tmp_path / "legacy_field"
        _create_via_sdk(path)
        await client.post(f"{API}/collections/open", json={"path": str(path)})

        resp = await client.post(
            f"{API}/collections/{path.name}/documents",
            json={"documents": [{"id": "???", "title": "t", "embedding": [0.1, 0.2, 0.3, 0.4]}]},
        )

        assert resp.status_code == 400, resp.text
        assert "$id" in resp.json()["detail"]


class TestOrdinarySchemaUnchanged:
    async def test_plain_collection_still_uses_id(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Collections without an ``id`` column keep the pre-existing contract."""
        resp = await client.post(
            f"{API}/collections",
            json={
                "path": str(tmp_path / "plain"),
                "schema": {
                    "name": "plain",
                    "vectors": [
                        {
                            "name": "embedding",
                            "dataType": "VECTOR_FP32",
                            "dimension": 4,
                            "indexParam": {"indexType": "FLAT", "metric": "L2"},
                        }
                    ],
                    "fields": [{"name": "title", "dataType": "STRING"}],
                },
            },
        )
        assert resp.status_code == 201, resp.text

        await client.post(
            f"{API}/collections/plain/documents",
            json={"documents": [{"id": "doc-1", "title": "t", "embedding": [0.1, 0.2, 0.3, 0.4]}]},
        )
        got = await client.get(f"{API}/collections/plain/documents/doc-1")

        assert got.status_code == 200
        assert got.json()["id"] == "doc-1"
        assert "$id" not in got.json()
