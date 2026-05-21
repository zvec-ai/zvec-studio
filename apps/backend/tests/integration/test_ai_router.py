"""Integration tests for ``/api/v1/ai/embeddings`` and ``/api/v1/ai/rerankers``.

Covers persistent CRUD + the ``:embed`` / ``:rerank`` custom verbs. The verb
endpoints are validated for argument routing only (lazy-import fallback to
503 for embeddings, 400 fusion-rejection for rerankers); we deliberately do
not depend on optional ML packages here.
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"


def _qwen_dense_body(name: str = "qwen-1024") -> dict:
    return {
        "name": name,
        "description": "Qwen dense @ 1024",
        "config": {
            "type": "qwen_dense",
            "dimension": 1024,
            "model": "text-embedding-v4",
            "apiKey": "sk-xxx",
        },
    }


def _rrf_body(name: str = "rrf-default") -> dict:
    return {"name": name, "config": {"type": "rrf", "rankConstant": 60}}


BUILTIN_EMBEDDING_NAMES = {"local-dense", "local-sparse", "bm25"}
BUILTIN_RERANKER_NAMES = {"rrf", "weighted"}


class TestEmbeddingFunctionsCrud:
    async def test_list_starts_with_builtins(self, client: AsyncClient) -> None:
        resp = await client.get(f"{API}/ai/embeddings")
        assert resp.status_code == 200
        names = {r["name"] for r in resp.json()["items"]}
        assert names >= BUILTIN_EMBEDDING_NAMES

    async def test_create_then_get_then_list(self, client: AsyncClient) -> None:
        resp = await client.post(f"{API}/ai/embeddings", json=_qwen_dense_body())
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["name"] == "qwen-1024"
        assert body["config"]["type"] == "qwen_dense"

        got = await client.get(f"{API}/ai/embeddings/qwen-1024")
        assert got.status_code == 200
        assert got.json()["config"]["dimension"] == 1024

        lst = await client.get(f"{API}/ai/embeddings")
        names = [r["name"] for r in lst.json()["items"]]
        assert "qwen-1024" in names

    async def test_create_duplicate_returns_409(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/embeddings", json=_qwen_dense_body())
        dup = await client.post(f"{API}/ai/embeddings", json=_qwen_dense_body())
        assert dup.status_code == 409
        problem = dup.json()
        assert problem["code"] == "AI_FUNCTION_ALREADY_EXISTS"

    async def test_get_missing_returns_404(self, client: AsyncClient) -> None:
        resp = await client.get(f"{API}/ai/embeddings/ghost")
        assert resp.status_code == 404
        assert resp.json()["code"] == "AI_FUNCTION_NOT_FOUND"

    async def test_put_replaces_recipe_and_renames(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/embeddings", json=_qwen_dense_body("a"))
        new = _qwen_dense_body("b")
        new["config"]["dimension"] = 2048
        resp = await client.put(f"{API}/ai/embeddings/a", json=new)
        assert resp.status_code == 200
        assert resp.json()["name"] == "b"

        # Old name gone, new name present.
        miss = await client.get(f"{API}/ai/embeddings/a")
        assert miss.status_code == 404
        hit = await client.get(f"{API}/ai/embeddings/b")
        assert hit.status_code == 200
        assert hit.json()["config"]["dimension"] == 2048

    async def test_delete_removes_record(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/embeddings", json=_qwen_dense_body())
        resp = await client.delete(f"{API}/ai/embeddings/qwen-1024")
        assert resp.status_code == 204
        miss = await client.get(f"{API}/ai/embeddings/qwen-1024")
        assert miss.status_code == 404

    async def test_post_rejects_unknown_field(self, client: AsyncClient) -> None:
        bad = _qwen_dense_body()
        bad["config"]["unexpected"] = True
        resp = await client.post(f"{API}/ai/embeddings", json=bad)
        assert resp.status_code == 422


class TestRerankerFunctionsCrud:
    async def test_create_then_list(self, client: AsyncClient) -> None:
        resp = await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        assert resp.status_code == 201, resp.text
        lst = await client.get(f"{API}/ai/rerankers")
        names = [r["name"] for r in lst.json()["items"]]
        assert "rrf-default" in names

    async def test_duplicate_create_returns_409(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        dup = await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        assert dup.status_code == 409

    async def test_delete_then_get_404(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        await client.delete(f"{API}/ai/rerankers/rrf-default")
        miss = await client.get(f"{API}/ai/rerankers/rrf-default")
        assert miss.status_code == 404

    async def test_put_updates_reranker_config(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        updated = {
            "name": "rrf-default",
            "config": {"type": "rrf", "rankConstant": 120},
        }
        resp = await client.put(f"{API}/ai/rerankers/rrf-default", json=updated)
        assert resp.status_code == 200
        assert resp.json()["config"]["rankConstant"] == 120

    async def test_put_renames_reranker(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/rerankers", json=_rrf_body("old-rrf"))
        renamed = {"name": "new-rrf", "config": {"type": "rrf", "rankConstant": 60}}
        resp = await client.put(f"{API}/ai/rerankers/old-rrf", json=renamed)
        assert resp.status_code == 200
        assert resp.json()["name"] == "new-rrf"
        miss = await client.get(f"{API}/ai/rerankers/old-rrf")
        assert miss.status_code == 404
        hit = await client.get(f"{API}/ai/rerankers/new-rrf")
        assert hit.status_code == 200


class TestEmbedVerb:
    async def test_embed_unknown_function_404(self, client: AsyncClient) -> None:
        resp = await client.post(
            f"{API}/ai/embeddings/ghost:embed", json={"texts": ["hi"]}
        )
        assert resp.status_code == 404
        assert resp.json()["code"] == "AI_FUNCTION_NOT_FOUND"

    async def test_embed_default_local_returns_503_when_extras_missing(
        self, client: AsyncClient
    ) -> None:
        try:
            import sentence_transformers  # noqa: F401
            pytest.skip("sentence_transformers installed; 503 path not testable here")
        except ImportError:
            pass
        await client.post(
            f"{API}/ai/embeddings",
            json={
                "name": "local",
                "config": {"type": "default_local_dense"},
            },
        )
        resp = await client.post(
            f"{API}/ai/embeddings/local:embed", json={"texts": ["hi"]}
        )
        assert resp.status_code == 503
        assert resp.json()["code"] == "AI_DEPENDENCY_MISSING"


class TestRerankVerb:
    async def test_rrf_reranker_rejects_400(self, client: AsyncClient) -> None:
        await client.post(f"{API}/ai/rerankers", json=_rrf_body())
        resp = await client.post(
            f"{API}/ai/rerankers/rrf-default:rerank",
            json={
                "query": "hello",
                "candidates": [{"id": "d1", "text": "world"}],
                "topN": 5,
            },
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "AI_FUNCTION_INVOCATION_FAILED"

    async def test_rerank_unknown_function_404(self, client: AsyncClient) -> None:
        resp = await client.post(
            f"{API}/ai/rerankers/ghost:rerank",
            json={"query": "q", "candidates": [{"id": "1", "text": "a"}], "topN": 1},
        )
        assert resp.status_code == 404
