"""Integration tests for POST /api/v1/collections/{name}/searches.

The per-request ``metric`` override was removed: each vector field carries
its own ``indexParam.metric`` chosen at create time. We validate L2 / COSINE
behaviour by creating two collections with different ``indexParam.metric``
values rather than passing it on the request body.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"
VEC_DIM = 4


def _collection_payload(name: str, *, metric: str = "L2") -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": VEC_DIM,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": metric,
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [{"name": "score", "dataType": "INT64"}],
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
        "fields": [{"name": "score", "dataType": "INT64"}],
    }


def _fts_collection_payload(name: str, *, with_vector: bool = False) -> dict:
    payload: dict = {
        "name": name,
        "vectors": [],
        "fields": [
            {
                "name": "content",
                "dataType": "STRING",
                "indexParam": {
                    "indexType": "FTS",
                    "tokenizerName": "standard",
                    "filters": ["lowercase"],
                },
            },
            {"name": "category", "dataType": "STRING", "indexParam": {"indexType": "INVERT"}},
        ],
    }
    if with_vector:
        payload["vectors"] = [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": VEC_DIM,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "L2",
                    "params": {"M": 16},
                },
            }
        ]
    return payload


def _doc(i: int, *, base: float = 1.0) -> dict:
    """Vectors aligned along the x-axis so L2 distance equals ``abs(i*base)``."""
    return {
        "id": f"d-{i:03d}",
        "score": i % 7,
        "embedding": [float(i) * base, 0.0, 0.0, 0.0],
    }


def _sparse_doc(i: int) -> dict:
    return {
        "id": f"s-{i:03d}",
        "score": i,
        "embedding": {str(40 + i): 1},
    }


def _fts_doc(doc_id: str, content: str, category: str, vec: list[float] | None = None) -> dict:
    body: dict = {"id": doc_id, "content": content, "category": category}
    if vec is not None:
        body["embedding"] = vec
    return body


async def _make_collection(
    client: AsyncClient,
    tmp_path: Path,
    name: str = "searchables",
    *,
    metric: str = "L2",
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _collection_payload(name, metric=metric)},
    )
    assert resp.status_code == 201, resp.text
    return name


async def _make_sparse_collection(
    client: AsyncClient, tmp_path: Path, name: str = "sparse_searchables"
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _sparse_collection_payload(name)},
    )
    assert resp.status_code == 201, resp.text
    return name


async def _make_fts_collection(
    client: AsyncClient,
    tmp_path: Path,
    name: str = "fts_searchables",
    *,
    with_vector: bool = False,
) -> str:
    path = tmp_path / name
    resp = await client.post(
        f"{API}/collections",
        json={
            "path": str(path),
            "schema": _fts_collection_payload(name, with_vector=with_vector),
        },
    )
    assert resp.status_code == 201, resp.text
    return name


async def _seed(client: AsyncClient, name: str, docs: list[dict]) -> None:
    resp = await client.post(
        f"{API}/collections/{name}/documents", json={"documents": docs}
    )
    assert resp.status_code == 201, resp.text


class TestHappyPath:
    async def test_l2_returns_nearest_ids_in_order(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 6)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 3},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert len(body["results"]) == 3
        assert [r["id"] for r in body["results"]] == ["d-001", "d-002", "d-003"]
        assert body["took_ms"] >= 0.0

    async def test_sparse_query_coerces_json_keys_and_values(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_sparse_collection(client, tmp_path)
        await _seed(client, name, [_sparse_doc(i) for i in range(1, 4)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": {"41": 1}, "topK": 1},
        )

        assert resp.status_code == 200, resp.text
        assert len(resp.json()["results"]) == 1

    async def test_response_embeds_trace_id(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(1)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 1},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["traceId"] == resp.headers["x-trace-id"]

    async def test_output_fields_projects_subset(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 4)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 2,
                "outputFields": ["score"],
            },
        )
        assert resp.status_code == 200
        for hit in resp.json()["results"]:
            assert set(hit["fields"].keys()) == {"id", "score"}

    async def test_filter_narrows_candidates(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 11)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 10,
                "filter": "score = 0",
            },
        )
        assert resp.status_code == 200
        # Only d-007 has ``score == 0`` (7 % 7 == 0); other ids with score 0 are out of range.
        assert [r["id"] for r in resp.json()["results"]] == ["d-007"]

    async def test_cosine_metric_pinned_at_create_time(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        # Cosine metric is locked into the collection's indexParam.
        name = await _make_collection(client, tmp_path, name="cos", metric="COSINE")
        await _seed(client, name, [_doc(i) for i in range(1, 4)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [1.0, 0.0, 0.0, 0.0], "topK": 3},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["results"]) == 3
        # All documents are colinear with the query, so cosine distance ~ 0.
        for hit in body["results"]:
            assert hit["score"] == pytest.approx(0.0, abs=1e-6)

    async def test_metric_no_longer_overrideable(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 1, "metric": "L2"},
        )
        # ``extra="forbid"`` rejects the legacy field.
        assert resp.status_code == 422

    async def test_top_k_truncates_result(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 21)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 5},
        )
        assert resp.status_code == 200
        assert len(resp.json()["results"]) == 5


class TestErrors:
    async def test_dimension_mismatch_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(1)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0], "topK": 1},
        )
        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "DIMENSION_MISMATCH"
        assert body["expectedDim"] == VEC_DIM
        assert body["actualDim"] == 2

    async def test_missing_collection_returns_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        resp = await client.post(
            f"{API}/collections/ghost/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 1},
        )
        assert resp.status_code == 404
        assert resp.json()["code"] == "COLLECTION_NOT_FOUND"

    async def test_unknown_vector_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(1)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 1,
                "vectorField": "missing",
            },
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_invalid_filter_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(1)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 1,
                "filter": "NOT a valid expression",
            },
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_FILTER_EXPRESSION"

    async def test_empty_vector_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [], "topK": 1},
        )
        assert resp.status_code == 422

    async def test_top_k_out_of_range_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 0},
        )
        assert resp.status_code == 422


class TestPerformance:
    """DoD: ``topK=10`` below 500 ms wall on local SSD for the in-memory backend."""

    async def test_top_k_under_budget_for_1k_docs(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path, name="perf")
        for start in range(0, 1_000, 250):
            batch = [_doc(i) for i in range(start, start + 250)]
            await _seed(client, name, batch)
        t0 = time.perf_counter()
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 10},
        )
        wall_ms = (time.perf_counter() - t0) * 1000.0
        assert resp.status_code == 200
        body = resp.json()
        assert len(body["results"]) == 10
        assert wall_ms < 500.0, f"search wall time {wall_ms:.1f} ms exceeded budget"
        assert body["took_ms"] < 500.0


class TestQueriesForm:
    """Canonical unified ``queries`` form (Zvec SDK 0.5.x)."""

    async def test_single_query_with_explicit_vector(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 6)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {"field": "embedding", "vector": [0.0, 0.0, 0.0, 0.0]}
                ],
                "topK": 3,
            },
        )
        assert resp.status_code == 200, resp.text
        ids = [r["id"] for r in resp.json()["results"]]
        assert ids == ["d-001", "d-002", "d-003"]

    async def test_by_id_query_uses_stored_vector(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 6)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [{"field": "embedding", "id": "d-003"}],
                "topK": 3,
            },
        )
        assert resp.status_code == 200, resp.text
        ids = [r["id"] for r in resp.json()["results"]]
        # d-003 itself has zero distance; nearest neighbours are d-002 and d-004.
        assert ids[0] == "d-003"
        assert set(ids[1:3]) == {"d-002", "d-004"}

    async def test_per_query_hnsw_ef_param_accepted(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """``param.ef`` is forwarded to ``zvec.HnswQueryParam`` and search succeeds."""
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(i) for i in range(1, 6)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {
                        "field": "embedding",
                        "vector": [0.0, 0.0, 0.0, 0.0],
                        "param": {"type": "HNSW", "ef": 50},
                    }
                ],
                "topK": 3,
            },
        )
        assert resp.status_code == 200, resp.text
        assert len(resp.json()["results"]) == 3

    async def test_queries_and_legacy_vector_are_mutually_exclusive(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [{"field": "embedding", "vector": [0.0, 0.0, 0.0, 0.0]}],
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 3,
            },
        )
        assert resp.status_code == 422

    async def test_query_requires_id_xor_vector(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {
                        "field": "embedding",
                        "id": "d-001",
                        "vector": [0.0, 0.0, 0.0, 0.0],
                    }
                ],
                "topK": 3,
            },
        )
        assert resp.status_code == 422

    async def test_invalid_param_kind_rejected(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {
                        "field": "embedding",
                        "vector": [0.0, 0.0, 0.0, 0.0],
                        "param": {"type": "BOGUS"},
                    }
                ],
                "topK": 3,
            },
        )
        assert resp.status_code == 422

    async def test_fts_only_collection_searches_match_string(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_fts_collection(client, tmp_path)
        await _seed(
            client,
            name,
            [
                _fts_doc("a", "hello world search", "docs"),
                _fts_doc("b", "vector database internals", "docs"),
                _fts_doc("c", "hello product notes", "notes"),
            ],
        )

        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {
                        "field": "content",
                        "fts": {"matchString": "hello"},
                        "param": {"type": "FTS", "defaultOperator": "OR"},
                    }
                ],
                "topK": 5,
            },
        )

        assert resp.status_code == 200, resp.text
        ids = {r["id"] for r in resp.json()["results"]}
        assert ids == {"a", "c"}

    async def test_fts_query_accepts_scalar_filter(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_fts_collection(client, tmp_path)
        await _seed(
            client,
            name,
            [
                _fts_doc("a", "hello world search", "docs"),
                _fts_doc("b", "hello private notes", "notes"),
            ],
        )

        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [{"field": "content", "fts": {"queryString": "hello"}}],
                "filter": "category = 'docs'",
                "topK": 5,
            },
        )

        assert resp.status_code == 200, resp.text
        assert [r["id"] for r in resp.json()["results"]] == ["a"]

    async def test_legacy_vector_search_on_vectorless_collection_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_fts_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={"vector": [0.0, 0.0, 0.0, 0.0], "topK": 1},
        )

        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_hybrid_fts_and_vector_query_requires_reranker(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_fts_collection(client, tmp_path, name="hybrid", with_vector=True)
        await _seed(
            client,
            name,
            [
                _fts_doc("a", "hello world search", "docs", [0.0, 0.0, 0.0, 0.0]),
                _fts_doc("b", "vector database internals", "docs", [1.0, 0.0, 0.0, 0.0]),
            ],
        )

        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {"field": "content", "fts": {"matchString": "hello"}},
                    {"field": "embedding", "vector": [0.0, 0.0, 0.0, 0.0]},
                ],
                "topK": 2,
            },
        )

        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_hybrid_fts_and_vector_query_with_reranker(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_fts_collection(client, tmp_path, name="hybrid_rrf", with_vector=True)
        await _seed(
            client,
            name,
            [
                _fts_doc("a", "hello world search", "docs", [0.0, 0.0, 0.0, 0.0]),
                _fts_doc("b", "hello vector database", "docs", [1.0, 0.0, 0.0, 0.0]),
                _fts_doc("c", "unrelated notes", "notes", [5.0, 0.0, 0.0, 0.0]),
            ],
        )
        reranker = await client.post(
            f"{API}/ai/rerankers",
            json={"name": "rrf-default", "config": {"type": "rrf", "rankConstant": 60}},
        )
        assert reranker.status_code == 201, reranker.text

        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "queries": [
                    {"field": "content", "fts": {"matchString": "hello"}},
                    {"field": "embedding", "vector": [0.0, 0.0, 0.0, 0.0]},
                ],
                "rerankerName": "rrf-default",
                "topK": 2,
            },
        )

        assert resp.status_code == 200, resp.text
        assert {r["id"] for r in resp.json()["results"]} <= {"a", "b", "c"}
        assert len(resp.json()["results"]) == 2


class TestRerankerReference:
    """``rerankerName`` resolves through the AI registry; missing names 404."""

    async def test_unknown_reranker_returns_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        await _seed(client, name, [_doc(1)])
        resp = await client.post(
            f"{API}/collections/{name}/searches",
            json={
                "vector": [0.0, 0.0, 0.0, 0.0],
                "topK": 1,
                "rerankerName": "does-not-exist",
            },
        )
        assert resp.status_code == 404
        assert resp.json()["code"] == "AI_FUNCTION_NOT_FOUND"
