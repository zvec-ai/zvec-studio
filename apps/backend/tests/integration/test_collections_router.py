"""Integration tests for the Collection management HTTP endpoints.

These tests run against the real Zvec SDK via :class:`SdkBackend`, which is
the only backend. The previous in-memory test double was removed
once the SDK became mandatory.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"


def _payload(name: str = "demo", dim: int = 4) -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": dim,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "COSINE",
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [{"name": "title", "dataType": "STRING"}],
    }


async def _create(client: AsyncClient, path: Path, name: str) -> dict:
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(path), "schema": _payload(name)},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


class TestCreate:
    async def test_create_returns_201_with_summary(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        body = await _create(client, tmp_path / "c1", "col1")
        assert body["name"] == "col1"
        assert body["path"] == str(tmp_path / "c1")
        assert body["schema"]["vectors"][0]["dataType"] == "VECTOR_FP32"
        # No isPrimary/description/top-level indexParams in v0.2.0.
        assert all("isPrimary" not in f for f in body["schema"]["fields"])
        assert "indexParams" not in body["schema"]
        assert body["schema"]["vectors"][0]["indexParam"]["metric"] == "COSINE"
        assert body["stats"]["documentCount"] == 0

    async def test_duplicate_name_different_path_both_open(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "a", "same")
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "b"), "schema": _payload("same")},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "same"
        assert body["path"] == str(tmp_path / "b")
        # Both should be listed as open
        list_resp = await client.get(f"{API}/collections")
        items = list_resp.json()["items"]
        paths = {i["path"] for i in items}
        assert str(tmp_path / "a") in paths
        assert str(tmp_path / "b") in paths

    async def test_duplicate_path_returns_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        path = tmp_path / "a"
        await _create(client, path, "same")
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(path), "schema": _payload("same")},
        )
        assert resp.status_code == 409
        assert resp.headers["content-type"].startswith("application/problem+json")
        problem = resp.json()
        assert problem["code"] == "COLLECTION_ALREADY_EXISTS"
        assert "traceId" in problem

    async def test_existing_path_rejected(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        target = tmp_path / "exists"
        target.mkdir()
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(target), "schema": _payload("col1")},
        )
        assert resp.status_code == 409
        assert resp.json()["code"] == "COLLECTION_ALREADY_EXISTS"

    async def test_invalid_schema_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        bad = _payload("bad")
        # Zvec 0.6 allows vectorless scalar collections, but not a completely
        # empty schema.
        bad["vectors"] = []
        bad["fields"] = []
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "bad"), "schema": bad},
        )
        assert resp.status_code == 422

    async def test_vectorless_fts_schema_returns_201(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        schema = {
            "name": "ftscol",
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
                }
            ],
        }
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "ftscol"), "schema": schema},
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["schema"]["vectors"] == []
        assert body["schema"]["fields"][0]["indexParam"]["indexType"] == "FTS"

    async def test_validation_error_detail_contains_specific_message(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Validation errors expose specific Pydantic messages in 'detail'."""
        bad = _payload("testcol")
        bad["fields"] = [{"name": "", "dataType": "STRING"}]
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "bad2"), "schema": bad},
        )
        assert resp.status_code == 422
        body = resp.json()
        assert body["code"] == "VALIDATION_ERROR"
        # detail should contain the actual validation message, not a generic one.
        assert "field name must match" in body["detail"]

    async def test_rejects_unknown_top_level_key_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        resp = await client.post(
            f"{API}/collections",
            json={
                "path": str(tmp_path / "x"),
                "schema": _payload("col1"),
                "rogue": True,
            },
        )
        assert resp.status_code == 422


class TestList:
    async def test_list_starts_empty(self, client: AsyncClient) -> None:
        resp = await client.get(f"{API}/collections")
        assert resp.status_code == 200
        assert resp.json() == {"items": []}

    async def test_list_after_creates(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "a", "aaa")
        await _create(client, tmp_path / "b", "bbb")
        resp = await client.get(f"{API}/collections")
        assert resp.status_code == 200
        names = sorted(item["name"] for item in resp.json()["items"])
        assert names == ["aaa", "bbb"]


class TestOpen:
    async def test_open_round_trip_after_restart(
        self, app: FastAPI, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "col1")
        from zvec_studio.storage import SdkBackend

        # Simulate a process restart by swapping in a fresh backend.
        app.state.backend = SdkBackend()

        resp = await client.post(
            f"{API}/collections/open", json={"path": str(tmp_path / "c")}
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "col1"

    async def test_open_quantized_collection_returns_json_safe_schema(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        schema = _payload("qcol")
        schema["vectors"][0]["indexParam"]["params"]["quantizeType"] = "INT8"
        schema["vectors"][0]["indexParam"]["params"]["quantizerParam"] = {
            "enableRotate": True
        }
        path = tmp_path / "quantized"

        create = await client.post(
            f"{API}/collections",
            json={"path": str(path), "schema": schema},
        )
        assert create.status_code == 201, create.text

        close = await client.delete(f"{API}/collections/qcol")
        assert close.status_code == 204

        resp = await client.post(f"{API}/collections/open", json={"path": str(path)})
        assert resp.status_code == 200, resp.text
        params = resp.json()["schema"]["vectors"][0]["indexParam"]["params"]
        assert params["quantize_type"] == "INT8"
        assert params["quantizer_param"] == {"enable_rotate": True}
        assert "QuantizeType" not in resp.text

    async def test_open_missing_path_returns_404(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        resp = await client.post(
            f"{API}/collections/open", json={"path": str(tmp_path / "missing")}
        )
        assert resp.status_code == 404
        body = resp.json()
        assert body["code"] == "COLLECTION_NOT_FOUND"


class TestGetAndClose:
    async def test_get_schema_and_stats(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "col1")

        detail = await client.get(f"{API}/collections/col1")
        assert detail.status_code == 200
        assert detail.json()["name"] == "col1"

        schema = await client.get(f"{API}/collections/col1/schema")
        assert schema.status_code == 200
        assert schema.json()["vectors"][0]["dataType"] == "VECTOR_FP32"

        stats = await client.get(f"{API}/collections/col1/stats")
        assert stats.status_code == 200
        assert stats.json()["documentCount"] == 0

    async def test_get_missing_returns_404(self, client: AsyncClient) -> None:
        resp = await client.get(f"{API}/collections/missing")
        assert resp.status_code == 404
        assert resp.json()["code"] == "COLLECTION_NOT_FOUND"

    async def test_close_returns_204_and_removes(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "col1")
        delete = await client.delete(f"{API}/collections/col1")
        assert delete.status_code == 204

        after = await client.get(f"{API}/collections/col1")
        assert after.status_code == 404


class TestConfigStoreSideEffect:
    async def test_create_updates_recent_paths(
        self, app: FastAPI, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "col1")
        from zvec_studio.config_store import ConfigStore

        store: ConfigStore = app.state.config_store
        cfg = store.load()
        assert cfg.recent
        assert cfg.recent[0].path.endswith("c")
        # Each entry now carries its own timestamp (v2 schema).
        assert cfg.recent[0].lastOpenedAt


class TestRecentEndpoints:
    async def test_get_recent_returns_created_paths(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "r1", "reccol1")
        await _create(client, tmp_path / "r2", "reccol2")

        resp = await client.get(f"{API}/collections/recent")
        assert resp.status_code == 200
        items = resp.json()["items"]
        # Most recent first; both entries carry an ISO timestamp.
        paths = [it["path"] for it in items]
        assert paths[0].endswith("r2")
        assert paths[1].endswith("r1")
        assert all(it["lastOpenedAt"] for it in items)

    async def test_forget_drops_single_entry(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "r1", "forget1")
        await _create(client, tmp_path / "r2", "forget2")

        resp = await client.post(
            f"{API}/collections/recent:forget",
            json={"path": str(tmp_path / "r1")},
        )
        assert resp.status_code == 204

        listing = await client.get(f"{API}/collections/recent")
        paths = [it["path"] for it in listing.json()["items"]]
        assert all(not p.endswith("r1") for p in paths)
        assert any(p.endswith("r2") for p in paths)

    async def test_forget_unknown_path_is_204(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        # Idempotent contract: forgetting a never-seen path still succeeds.
        resp = await client.post(
            f"{API}/collections/recent:forget",
            json={"path": str(tmp_path / "never-existed")},
        )
        assert resp.status_code == 204

    async def test_clear_empties_recent(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "r1", "clearcol1")
        await _create(client, tmp_path / "r2", "clearcol2")

        resp = await client.delete(f"{API}/collections/recent")
        assert resp.status_code == 204

        listing = await client.get(f"{API}/collections/recent")
        assert listing.json()["items"] == []

    async def test_recent_does_not_clash_with_collection_named_recent(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        # ``recent`` is reserved at the schema layer to keep the URL
        # ``GET /collections/recent`` unambiguous.
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "r"), "schema": _payload("recent")},
        )
        assert resp.status_code == 422


class TestMaintenance:
    async def test_flush_returns_timestamp(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "flushcol")
        resp = await client.post(f"{API}/collections/flushcol:flush")
        assert resp.status_code == 200
        body = resp.json()
        assert body["operation"] == "flush"
        assert body["timestamp"]

    async def test_optimize_marks_index_ready(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "opt1")
        resp = await client.post(f"{API}/collections/opt1:optimize")
        assert resp.status_code == 200
        assert resp.json()["operation"] == "optimize"
        stats = await client.get(f"{API}/collections/opt1/stats")
        assert stats.json()["indexState"] == "ready"

    async def test_destroy_removes_collection_and_path(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "dest1")
        resp = await client.post(f"{API}/collections/dest1:destroy")
        assert resp.status_code == 204
        missing = await client.get(f"{API}/collections/dest1")
        assert missing.status_code == 404

    async def test_destroy_clears_recent_entry(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Destroying a collection also removes it from the recent list."""
        await _create(client, tmp_path / "c", "destrec")
        # Confirm it appears in recent.
        recent_before = await client.get(f"{API}/collections/recent")
        paths_before = [it["path"] for it in recent_before.json()["items"]]
        assert any(p.endswith("c") for p in paths_before)
        # Destroy.
        resp = await client.post(f"{API}/collections/destrec:destroy")
        assert resp.status_code == 204
        # Recent no longer contains the destroyed path.
        recent_after = await client.get(f"{API}/collections/recent")
        paths_after = [it["path"] for it in recent_after.json()["items"]]
        assert all(not p.endswith("c") for p in paths_after)

    async def test_destroy_unknown_returns_404(
        self, client: AsyncClient
    ) -> None:
        resp = await client.post(f"{API}/collections/ghost:destroy")
        assert resp.status_code == 404


class TestFieldDDL:
    async def test_add_drop_rename_field_round_trip(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "ddl1")
        # Add — note Zvec only allows numeric (int/float/double) columns to be
        # added after creation, so we exercise the round-trip with INT64.
        add = await client.post(
            f"{API}/collections/ddl1/fields",
            json={"field": {"name": "score2", "dataType": "INT64"}, "expression": ""},
        )
        assert add.status_code == 201
        names = {f["name"] for f in add.json()["schema"]["fields"]}
        assert {"title", "score2"} <= names
        # Rename
        ren = await client.patch(
            f"{API}/collections/ddl1/fields/score2",
            json={"newName": "rank"},
        )
        assert ren.status_code == 200
        names = {f["name"] for f in ren.json()["schema"]["fields"]}
        assert "rank" in names and "score2" not in names
        # Drop
        drop = await client.delete(f"{API}/collections/ddl1/fields/rank")
        assert drop.status_code == 200
        names = {f["name"] for f in drop.json()["schema"]["fields"]}
        assert "rank" not in names

    async def test_add_duplicate_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "dup1")
        resp = await client.post(
            f"{API}/collections/dup1/fields",
            json={"field": {"name": "title", "dataType": "STRING"}},
        )
        assert resp.status_code == 400
        assert resp.json()["code"] == "INVALID_SCHEMA"

    async def test_drop_unknown_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "missfld")
        resp = await client.delete(f"{API}/collections/missfld/fields/ghost")
        assert resp.status_code == 400

    async def test_rename_to_existing_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "col_ren")
        resp = await client.patch(
            f"{API}/collections/col_ren/fields/title",
            json={"newName": "embedding"},
        )
        assert resp.status_code == 400

    async def test_rename_invalid_name_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "vname1")
        resp = await client.patch(
            f"{API}/collections/vname1/fields/title",
            json={"newName": "123-bad"},
        )
        assert resp.status_code == 422


class TestIndexDDL:
    async def test_create_and_drop_index(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "idx1")
        create = await client.post(
            f"{API}/collections/idx1/indexes",
            json={
                "vectorField": "embedding",
                "indexType": "FLAT",
                "metric": "L2",
                "params": {},
            },
        )
        assert create.status_code == 201
        body = create.json()
        vec = next(v for v in body["schema"]["vectors"] if v["name"] == "embedding")
        assert vec["indexParam"]["indexType"] == "FLAT"
        assert vec["indexParam"]["metric"] == "L2"
        # Drop — Zvec doesn't truly remove the index struct; it falls back to
        # the default FLAT/IP placeholder, so we just assert that the prior
        # FLAT/L2 configuration is no longer in effect.
        drop = await client.delete(
            f"{API}/collections/idx1/indexes/embedding"
        )
        assert drop.status_code == 200
        vec = next(v for v in drop.json()["schema"]["vectors"] if v["name"] == "embedding")
        assert vec["indexParam"]["metric"] == "IP"

    async def test_create_index_unknown_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "idx2")
        resp = await client.post(
            f"{API}/collections/idx2/indexes",
            json={"vectorField": "ghost", "indexType": "HNSW", "metric": "COSINE"},
        )
        assert resp.status_code == 400


class TestScalarIndexDDL:
    async def test_create_and_drop_scalar_index(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "sidx1")
        create = await client.post(
            f"{API}/collections/sidx1/fields/title/index",
            json={},
        )
        assert create.status_code == 201
        # The scalar field should now have an indexParam
        field = next(
            f for f in create.json()["schema"]["fields"] if f["name"] == "title"
        )
        assert field.get("indexParam") is not None

        drop = await client.delete(f"{API}/collections/sidx1/fields/title/index")
        assert drop.status_code == 200

    async def test_create_scalar_index_unknown_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "sidx2")
        resp = await client.post(
            f"{API}/collections/sidx2/fields/ghost/index",
            json={},
        )
        assert resp.status_code == 400

    async def test_create_fts_scalar_index_after_collection_creation(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "sidx_fts")

        create = await client.post(
            f"{API}/collections/sidx_fts/fields/title/index",
            json={
                "indexType": "FTS",
                "tokenizerName": "standard",
                "filters": ["lowercase"],
            },
        )

        assert create.status_code == 201, create.text
        field = next(f for f in create.json()["schema"]["fields"] if f["name"] == "title")
        assert field["indexParam"]["indexType"] == "FTS"
        assert field["indexParam"]["tokenizerName"] == "standard"
        assert field["indexParam"]["filters"] == ["lowercase"]

        insert = await client.post(
            f"{API}/collections/sidx_fts/documents",
            json={"documents": [{"id": "doc1", "embedding": [0.1, 0.2, 0.3, 0.4], "title": "hello world"}]},
        )
        assert insert.status_code == 201, insert.text

        search = await client.post(
            f"{API}/collections/sidx_fts/searches",
            json={
                "queries": [
                    {
                        "field": "title",
                        "fts": {"matchString": "hello"},
                        "param": {"type": "FTS", "defaultOperator": "OR"},
                    }
                ],
                "topK": 10,
            },
        )
        assert search.status_code == 200, search.text
        assert [r["id"] for r in search.json()["results"]] == ["doc1"]

    async def test_drop_scalar_index_unknown_field_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "sidx3")
        resp = await client.delete(f"{API}/collections/sidx3/fields/ghost/index")
        assert resp.status_code == 400

    async def test_edit_scalar_index_updates_params(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """POST on a field that already has an index should drop+recreate (edit)."""
        await _create(client, tmp_path / "c", "sidx_edit")
        # Create initial index with defaults
        create = await client.post(
            f"{API}/collections/sidx_edit/fields/title/index",
            json={"enableRangeOptimization": False, "enableExtendedWildcard": False},
        )
        assert create.status_code == 201
        field = next(f for f in create.json()["schema"]["fields"] if f["name"] == "title")
        assert field["indexParam"]["enableRangeOptimization"] is False
        assert field["indexParam"]["enableExtendedWildcard"] is False

        # Edit: POST again with different params
        edit = await client.post(
            f"{API}/collections/sidx_edit/fields/title/index",
            json={"enableRangeOptimization": True, "enableExtendedWildcard": True},
        )
        assert edit.status_code == 201
        field2 = next(f for f in edit.json()["schema"]["fields"] if f["name"] == "title")
        assert field2["indexParam"]["enableRangeOptimization"] is True
        assert field2["indexParam"]["enableExtendedWildcard"] is True

    async def test_create_fts_scalar_index_on_non_string_returns_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        schema = _payload("sidx_fts_bad")
        schema["fields"] = [{"name": "score", "dataType": "INT64"}]
        create_collection = await client.post(
            f"{API}/collections",
            json={"path": str(tmp_path / "c"), "schema": schema},
        )
        assert create_collection.status_code == 201, create_collection.text

        resp = await client.post(
            f"{API}/collections/sidx_fts_bad/fields/score/index",
            json={
                "indexType": "FTS",
                "tokenizerName": "standard",
                "filters": ["lowercase"],
            },
        )

        assert resp.status_code == 400
        body = resp.json()
        assert body["code"] == "INVALID_SCHEMA"
        assert "FTS index can only be created on STRING fields" in body["detail"]


class TestCloseEdgeCases:
    async def test_close_missing_returns_404(self, client: AsyncClient) -> None:
        resp = await client.delete(f"{API}/collections/nonexistent")
        assert resp.status_code == 404
        assert resp.json()["code"] == "COLLECTION_NOT_FOUND"

    async def test_close_twice_returns_404_on_second(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        await _create(client, tmp_path / "c", "closeme")
        first = await client.delete(f"{API}/collections/closeme")
        assert first.status_code == 204
        second = await client.delete(f"{API}/collections/closeme")
        assert second.status_code == 404
