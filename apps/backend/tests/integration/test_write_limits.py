"""Boundary regressions for the document write surface.

Two shipped defects are pinned here:

1. ``insert`` / ``upsert`` / ``update`` accepted up to 10,000 documents by
   contract but passed them straight to the SDK, whose (undocumented) write
   batch limit is 1024 -- anything larger answered HTTP 500.
2. SDK-level document validation errors and duplicate-id writes fell through
   the generic handler as HTTP 500 instead of 4xx.

The service layer absorbs the SDK batch constraint internally (see
``_write_in_batches``) and classifies errors per the RFC 7807 catalog.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from httpx import AsyncClient

from .test_documents_router import _doc, _make_collection

API = "/api/v1"
pytestmark = pytest.mark.integration


class TestBatchBoundary:
    async def test_insert_1025_docs_succeeds_via_internal_batching(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Regression: this used to return HTTP 500 (INTERNAL_ERROR)."""
        name = await _make_collection(client, tmp_path)

        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(1025)]},
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["inserted"] == 1025
        assert len(body["ids"]) == 1025

        # The documents really landed: fetch one from the second internal batch.
        got = await client.get(f"{API}/collections/{name}/documents/doc-1024")
        assert got.status_code == 200

    async def test_insert_1024_docs_control(self, client: AsyncClient, tmp_path: Path) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(1024)]},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["inserted"] == 1024

    async def test_update_1025_docs_succeeds_via_internal_batching(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Regression: PATCH with >1024 documents used to return HTTP 500."""
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [_doc(i) for i in range(1025)]},
        )

        resp = await client.patch(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": f"doc-{i:03d}", "title": "updated"} for i in range(1025)]},
        )

        assert resp.status_code == 200, resp.text
        assert resp.json()["updated"] == 1025

    async def test_upsert_1025_docs_succeeds_via_internal_batching(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        name = await _make_collection(client, tmp_path)
        resp = await client.post(
            f"{API}/collections/{name}/documents:upsert",
            json={"documents": [_doc(i) for i in range(1025)]},
        )
        assert resp.status_code == 200, resp.text


class TestWriteErrorClassification:
    async def test_insert_duplicate_id_returns_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The SDK reports the duplicate through a per-doc Status, not an exception."""
        name = await _make_collection(client, tmp_path)
        await client.post(
            f"{API}/collections/{name}/documents", json={"documents": [_doc(1)]}
        )

        resp = await client.post(
            f"{API}/collections/{name}/documents", json={"documents": [_doc(1)]}
        )

        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "DOCUMENT_CONFLICT"

    async def test_insert_missing_required_field_returns_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Regression: SDK ValueError used to fall through to HTTP 500."""
        name = await _make_collection(client, tmp_path)

        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={"documents": [{"id": "x", "title": "t", "embedding": [0.1, 0.2, 0.3, 0.4]}]},
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "INVALID_DOCUMENT"


class TestPrimaryKeyContract:
    async def test_explicit_null_id_auto_generates(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Historical write contract: ``"id": null`` behaves like omitting
        the key — a fresh ULID is minted, not a 422."""
        name = await _make_collection(client, tmp_path)

        resp = await client.post(
            f"{API}/collections/{name}/documents",
            json={
                "documents": [
                    {"id": None, "title": "t", "score": 1, "embedding": [0.1, 0.2, 0.3, 0.4]}
                ]
            },
        )

        assert resp.status_code == 201, resp.text
        ids = resp.json()["ids"]
        assert len(ids) == 1 and ids[0]  # a non-empty generated key
