"""Integration tests for document CRUD + Filter Browser endpoints (v0.2.0).

Key differences from v0.1.0:
- no cursor pagination; ``POST /documents:browse`` is the filter-first browser;
- document ids are strings (ULIDs auto-generated when the client omits ``id``);
- no ``isPrimary`` field on schemas.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"
VEC_DIM = 4


def _collection_payload(name: str) -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": VEC_DIM,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "COSINE",
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [
            {"name": "title", "dataType": "STRING"},
            {"name": "score", "dataType": "INT64"},
        ],
    }


def _sparse_collection_payload(name: str) -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "SPARSE_VECTOR_FP32",
                "dimension": 768,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "IP",
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [{"name": "title", "dataType": "STRING"}],
    }


def _doc(i: int, *, with_id: bool = True) -> dict:
    body: dict = {
        "title": "tech" if i % 2 == 0 else "other",
        "score": i % 7,
        "embedding": [float(i), 0.0, 0.0, 0.0],
    }
    if with_id:
        body["id"] = f"doc-{i:03d}"
    return body


async def _make_collection(
    client: AsyncClient, tmp_path: Path, name: str = "docs"
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _collection_payload(name)},
    )
    assert resp.status_code == 201, resp.text
    return name


async def _make_sparse_collection(
    client: AsyncClient, tmp_path: Path, name: str = "sparse_docs"
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _sparse_collection_payload(name)},
    )
    assert resp.status_code == 201, resp.text
    return name


class TestInsertAndGet:
    async def test_insert_with_explicit_ids(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        batch = [_doc(i) for i in range(5)]
        resp = await client.post(
            f"{API}/collections/{name}/documents", json={"documents": batch}
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["inserted"] == 5
        assert body["ids"] == [f"doc-{i:03d}" for i in range(5)]

        got = await client.get(f"{API}/collections/{name}/documents/doc-002")
        assert got.status_code == 200
        assert got.json()["id"] == "doc-002"

    async def test_insert_sparse_vector_coerces_json_keys_and_values(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_sparse_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={
                "documents": [
                    {
                        "id": "s-001",
                        "title": "sparse",
                        "embedding": {"42": 1, "314": 0.5},
                    }
                ]
            },
        )

        assert resp.status_code == 201, resp.text
        assert resp.json()["inserted"] == 1

    async def test_insert_auto_ulid_when_id_missing(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i, with_id=False) for i in range(3)]},
        )
        assert resp.status_code == 201
        ids = resp.json()["ids"]
        assert len(ids) == 3
        # ULIDs are 26 Crockford base32 chars.
        assert all(isinstance(x, str) and len(x) == 26 for x in ids)

    async def test_insert_non_string_id_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={
                "documents": [
                    {
                        "id": 42,
                        "title": "x",
                        "score": 0,
                        "embedding": [0.0, 0.0, 0.0, 0.0],
                    }
                ]
            },
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_insert_dimension_mismatch_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={
                "documents": [
                    {"id": "x", "title": "t", "score": 0, "embedding": [0.0, 0.0]}
                ]
            },
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "DIMENSION_MISMATCH"

    async def test_get_missing_document_returns_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.get(f"{API}/collections/{name}/documents/nope")
        assert resp.status_code == 404
        assert resp.json()["code"] == "DOCUMENT_NOT_FOUND"


class TestBrowse:
    async def test_browse_returns_matching_items(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(10)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": "title = 'tech'", "limit": 100},
        )
        assert resp.status_code == 200
        body = resp.json()
        ids = sorted(d["id"] for d in body["items"])
        # Even indices have title == "tech".
        assert ids == [f"doc-{i:03d}" for i in (0, 2, 4, 6, 8)]
        assert body["truncated"] is False

    async def test_browse_truncated_when_limit_reached(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(20)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": None, "limit": 5},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["items"]) == 5
        assert body["truncated"] is True

    async def test_browse_output_fields_projects_subset(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": None, "limit": 10, "outputFields": ["title"]},
        )
        assert resp.status_code == 200
        item = resp.json()["items"][0]
        assert set(item.keys()) == {"id", "title"}

    async def test_browse_include_vector(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": None, "limit": 10, "includeVector": True},
        )
        assert resp.status_code == 200
        item = resp.json()["items"][0]
        assert "embedding" in item

    async def test_browse_invalid_filter_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        # Zvec only parses the filter when the collection has at least one
        # indexed doc, so seed one before asserting parser-error mapping.
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": "not a filter", "limit": 10},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_FILTER_EXPRESSION"


class TestDeletion:
    async def test_delete_single_then_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(1)]},
        )
        delete = await client.delete(f"{API}/collections/{name}/documents/doc-001")
        assert delete.status_code == 204
        missing = await client.get(f"{API}/collections/{name}/documents/doc-001")
        assert missing.status_code == 404

    async def test_batch_delete_returns_count(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(5)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:deleteBatch",
            json={"ids": ["doc-001", "doc-003", "doc-999"]},
        )
        assert resp.status_code == 200
        assert resp.json()["deleted"] == 2
        listing = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": None, "limit": 100},
        )
        remaining = sorted(d["id"] for d in listing.json()["items"])
        assert remaining == ["doc-000", "doc-002", "doc-004"]


class TestConcurrentInsertIdempotence:
    async def test_parallel_inserts_with_fixed_ids_converge(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        body = {"documents": [_doc(i) for i in range(50)]}
        await asyncio.gather(
            *[
                client.post(f"{API}/collections/{name}/documents", json=body)
                for _ in range(5)
            ]
        )
        stats = await client.get(f"{API}/collections/{name}/stats")
        # Same doc ids inserted N times -> one entry per id (last-write-wins).
        assert stats.json()["documentCount"] == 50


class TestUpsert:
    async def test_upsert_inserts_then_replaces(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        # First call creates two new ids.
        first = await client.post(
            f"{API}/collections/{name}/documents:upsert",
            json={"documents": [_doc(1), _doc(2)]},
        )
        assert first.status_code == 200
        assert first.json()["upserted"] == 2
        # Second call mutates an existing one and adds a third.
        second = await client.post(
            f"{API}/collections/{name}/documents:upsert",
            json={
                "documents": [
                    {
                        "id": "doc-001",
                        "title": "updated",
                        "score": 99,
                        "embedding": [9.0, 0.0, 0.0, 0.0],
                    },
                    _doc(3),
                ]
            },
        )
        assert second.status_code == 200
        assert second.json()["upserted"] == 2
        # Verify mutation took effect.
        got = await client.get(f"{API}/collections/{name}/documents/doc-001")
        assert got.json()["title"] == "updated"
        assert got.json()["score"] == 99

    async def test_upsert_auto_ulid_when_id_missing(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents:upsert",
            json={"documents": [_doc(0, with_id=False)]},
        )
        assert resp.status_code == 200
        ids = resp.json()["ids"]
        assert len(ids) == 1 and len(ids[0]) == 26


class TestUpdate:
    async def test_partial_update_preserves_omitted_columns(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        # Patch only ``score`` -- title and embedding stay as inserted.
        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": "doc-000", "score": 42}]},
        )
        assert resp.status_code == 200
        assert resp.json()["updated"] == 1
        got = await client.get(f"{API}/collections/{name}/documents/doc-000")
        body = got.json()
        assert body["score"] == 42
        assert body["title"] == "tech"  # unchanged
        assert body["embedding"] == [0.0, 0.0, 0.0, 0.0]

    async def test_update_missing_id_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"score": 1}]},  # no id
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_update_unknown_id_returns_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": "ghost", "score": 1}]},
        )
        assert resp.status_code == 404
        assert resp.json()["code"] == "DOCUMENT_NOT_FOUND"

    async def test_update_dimension_mismatch_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": "doc-000", "embedding": [1.0, 2.0]}]},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "DIMENSION_MISMATCH"


class TestDeleteByFilter:
    async def test_delete_by_filter_removes_matching(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(10)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:deleteByFilter",
            json={"filter": "title = 'tech'"},
        )
        assert resp.status_code == 200
        # Even indices have title == "tech" -> 5 docs.
        assert resp.json()["deleted"] == 5
        listing = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"filter": None, "limit": 100},
        )
        ids = sorted(d["id"] for d in listing.json()["items"])
        assert ids == [f"doc-{i:03d}" for i in (1, 3, 5, 7, 9)]

    async def test_delete_by_filter_invalid_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        # See note on browse_invalid_filter: the SDK only parses the filter
        # once there's data to scan.
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(0)]},
        )
        resp = await client.post(
            f"{API}/collections/{name}/documents:deleteByFilter",
            json={"filter": "not a filter"},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_FILTER_EXPRESSION"

    async def test_delete_by_filter_empty_filter_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents:deleteByFilter",
            json={"filter": ""},
        )
        assert resp.status_code == 422


class TestBrowseEdgeCases:
    async def test_browse_empty_collection_returns_empty_list(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents:browse",
            json={"limit": 50},
        )
        assert resp.status_code == 200
        assert resp.json()["items"] == []
        assert resp.json()["truncated"] is False

    async def test_browse_on_missing_collection_returns_404(
        self, client: AsyncClient,
    ) -> None:
        resp = await client.post(
            f"{API}/collections/nonexistent/documents:browse",
            json={"limit": 50},
        )
        assert resp.status_code == 404


class TestGetDocumentEdgeCases:
    async def test_get_document_returns_vectors(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        doc = {"id": "vec-check", "embedding": [1.0, 2.0, 3.0, 4.0], "title": "t", "score": 1}
        ins = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [doc]},
        )
        assert ins.status_code == 201, ins.text
        got = await client.get(f"{API}/collections/{name}/documents/vec-check")
        assert got.status_code == 200
        body = got.json()
        assert body["id"] == "vec-check"
        assert "embedding" in body
        assert len(body["embedding"]) == 4

    async def test_get_document_on_missing_collection_returns_404(
        self, client: AsyncClient,
    ) -> None:
        resp = await client.get(
            f"{API}/collections/nonexistent/documents/any-id",
        )
        assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Field type validation
# ---------------------------------------------------------------------------


def _typed_collection_payload(name: str) -> dict:
    """Schema with multiple scalar types for type-validation tests."""
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": VEC_DIM,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "COSINE",
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [
            {"name": "age", "dataType": "INT32", "nullable": False},
            {"name": "name", "dataType": "STRING", "nullable": False},
            {"name": "active", "dataType": "BOOL", "nullable": False},
            {"name": "rating", "dataType": "FLOAT", "nullable": True},
            {"name": "tags", "dataType": "ARRAY_STRING", "nullable": False},
        ],
    }


async def _make_typed_collection(
    client: AsyncClient, tmp_path: Path, name: str = "typed"
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _typed_collection_payload(name)},
    )
    assert resp.status_code == 201, resp.text
    return name


def _typed_doc(**overrides: object) -> dict:
    base: dict = {
        "id": "t-001",
        "age": 25,
        "name": "Alice",
        "active": True,
        "rating": 4.5,
        "tags": ["python", "rust"],
        "embedding": [1.0, 0.0, 0.0, 0.0],
    }
    base.update(overrides)
    return base


class TestFieldTypeValidation:
    """Verify that _validate_field_value rejects type mismatches with clear errors."""

    async def test_string_for_int32_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv1")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(age="not a number")]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "age" in body["detail"]
        assert "INT32" in body["detail"]
        assert "str" in body["detail"]

    async def test_null_for_non_nullable_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv2")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(age=None)]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "age" in body["detail"]
        assert "not nullable" in body["detail"]

    async def test_null_for_nullable_field_accepted(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv3")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(rating=None)]},
        )
        assert resp.status_code == 201

    async def test_int_for_string_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv4")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(name=123)]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "name" in body["detail"]
        assert "STRING" in body["detail"]

    async def test_string_for_bool_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv5")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(active="true")]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "active" in body["detail"]
        assert "BOOL" in body["detail"]

    async def test_string_for_array_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv6")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(tags="not an array")]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "tags" in body["detail"]
        assert "ARRAY_STRING" in body["detail"]

    async def test_bool_for_int_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Boolean should NOT be accepted as numeric (Python bool is int subclass)."""
        name = await _make_typed_collection(client, tmp_path, "tv7")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc(age=True)]},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "age" in body["detail"]

    async def test_valid_types_accepted(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """All fields with correct types should insert successfully."""
        name = await _make_typed_collection(client, tmp_path, "tv8")
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc()]},
        )
        assert resp.status_code == 201
        assert resp.json()["inserted"] == 1

    async def test_upsert_type_mismatch_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv9")
        resp = await client.post(
            f"{API}/collections/{name}/documents:upsert",
            json={"documents": [_typed_doc(age="old")]},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_update_type_mismatch_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_typed_collection(client, tmp_path, "tv10")
        # First insert a valid doc
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_typed_doc()]},
        )
        # Now try to update with wrong type
        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": "t-001", "age": "twenty-five"}]},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"
