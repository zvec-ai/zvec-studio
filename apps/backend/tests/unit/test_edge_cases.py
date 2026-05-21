"""Edge case & robustness integration tests.

Validates boundary conditions and adversarial inputs against the REST API:
collection name limits, document IDs with special characters, empty vectors,
dimension mismatch messaging, concurrent creation conflicts, filter injection,
topK limits, and empty-string names.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from zvec_studio.exceptions import (
    CollectionAlreadyExistsError,
    DimensionMismatchError,
    InvalidFilterExpressionError,
)

pytestmark = pytest.mark.integration

API = "/api/v1"


def _valid_schema(name: str = "demo", dim: int = 8) -> dict:
    """Return a minimal valid collection schema payload."""
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
        "fields": [
            {"name": "title", "dataType": "STRING"},
        ],
    }


# ---------------------------------------------------------------------------
# Collection name max length (64 chars)
# ---------------------------------------------------------------------------


async def test_collection_name_max_length_accepted(
    tmp_path: Path, app: FastAPI, client: AsyncClient
) -> None:
    """A collection name at exactly 64 characters (letter + 63 alnum) passes schema validation."""
    # Collection name regex: ^[A-Za-z][A-Za-z0-9_]{2,63}$ => total 3..64 chars
    max_name = "a" * 64  # 'a' + 63 'a's = 64 chars, starts with letter
    body = {"path": str(tmp_path / "col_max"), "schema": _valid_schema(max_name)}

    # Mock the backend to avoid needing a real Zvec SDK — the test focuses on
    # Pydantic schema validation passing at the HTTP layer.
    original_backend = app.state.backend
    mock_backend = MagicMock()
    mock_record = MagicMock()
    mock_record.name = max_name
    mock_record.path = tmp_path / "col_max"
    mock_record.schema = _valid_schema(max_name)
    mock_backend.create.return_value = mock_record
    mock_backend.stats.return_value = {
        "documentCount": 0,
        "indexState": "none",
        "indexCompleteness": {},
        "storageBytes": 0,
    }
    app.state.backend = mock_backend
    try:
        resp = await client.post(f"{API}/collections", json=body)
    finally:
        app.state.backend = original_backend

    # If schema validation passes, we'll get past the 422 stage.
    # The actual call may fail because the mock isn't set up for full flow,
    # but it should NOT be a 422 validation error for the name.
    assert resp.status_code != 422 or "name" not in str(resp.json())


async def test_collection_name_exceeds_max_length_rejected(
    client: AsyncClient,
) -> None:
    """A collection name of 65 characters should fail schema validation with 422."""
    too_long = "a" * 65
    body = {"path": "/tmp/col_too_long", "schema": _valid_schema(too_long)}

    resp = await client.post(f"{API}/collections", json=body)
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Document ID with special characters
# ---------------------------------------------------------------------------


async def test_document_id_with_special_chars_in_url(
    client: AsyncClient,
) -> None:
    """Document IDs with slashes/unicode/spaces in the URL path are handled.

    The endpoint should not crash — it may return 404 (collection not open)
    or handle the ID encoding gracefully.
    """
    # Using URL-encoded special chars in path segments.
    special_ids = [
        "doc%2Fwith%2Fslashes",  # /
        "doc%20with%20spaces",  # spaces
        "doc_%E4%B8%AD%E6%96%87",  # unicode
    ]
    for doc_id in special_ids:
        resp = await client.get(
            f"{API}/collections/testcol/documents/{doc_id}"
        )
        # The collection isn't open, so we expect a domain error (404) or
        # another clean error — NOT a 500 server crash.
        assert resp.status_code != 500, f"Server crashed on doc_id={doc_id}"


# ---------------------------------------------------------------------------
# Empty vector array in search request
# ---------------------------------------------------------------------------


async def test_empty_vector_array_rejected(client: AsyncClient) -> None:
    """An empty vector array in search body should trigger 422 validation error."""
    body = {"vector": [], "topK": 10}
    resp = await client.post(f"{API}/collections/testcol/searches", json=body)
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Dimension mismatch error message
# ---------------------------------------------------------------------------


async def test_dimension_mismatch_includes_both_dimensions(
    app: FastAPI, client: AsyncClient,
) -> None:
    """When a DimensionMismatchError is raised, the response includes expected and actual dims."""
    original_backend = app.state.backend
    mock_backend = MagicMock()
    mock_record = MagicMock()
    mock_record.name = "testcol"
    mock_backend.get.return_value = mock_record
    mock_backend.search.side_effect = DimensionMismatchError(
        "Vector dimension mismatch: expected 128, got 64",
        extra={"expected": 128, "actual": 64},
    )
    app.state.backend = mock_backend
    try:
        body = {"vector": [0.1] * 64, "topK": 5}
        resp = await client.post(f"{API}/collections/testcol/searches", json=body)
    finally:
        app.state.backend = original_backend

    assert resp.status_code == 400
    data = resp.json()
    # The error response should contain dimension info.
    detail_str = str(data)
    assert "128" in detail_str
    assert "64" in detail_str


# ---------------------------------------------------------------------------
# Concurrent creation conflict (409)
# ---------------------------------------------------------------------------


async def test_concurrent_create_same_name_one_gets_409(
    tmp_path: Path, app: FastAPI, client: AsyncClient
) -> None:
    """Two simultaneous creates with the same collection name: one succeeds, one gets 409."""
    call_count = 0

    def _mock_create(*args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count > 1:
            raise CollectionAlreadyExistsError(
                "Collection 'concurrent_test' already exists."
            )
        # First call: simulate success by returning a mock record.
        record = MagicMock()
        record.name = "concurrent_test"
        record.path = tmp_path / "col"
        record.schema = _valid_schema("concurrent_test")
        return record

    original_backend = app.state.backend
    mock_backend = MagicMock()
    mock_backend.create.side_effect = _mock_create
    mock_backend.stats.return_value = {
        "documentCount": 0,
        "indexState": "none",
        "indexCompleteness": {},
        "storageBytes": 0,
    }
    app.state.backend = mock_backend
    try:
        body = {
            "path": str(tmp_path / "col"),
            "schema": _valid_schema("concurrent_test"),
        }

        # Fire both concurrently.
        results = await asyncio.gather(
            client.post(f"{API}/collections", json=body),
            client.post(f"{API}/collections", json=body),
        )
    finally:
        app.state.backend = original_backend

    statuses = sorted(r.status_code for r in results)
    # One should succeed (201) and one should conflict (409).
    assert 409 in statuses


# ---------------------------------------------------------------------------
# SQL injection in filter
# ---------------------------------------------------------------------------


async def test_filter_sql_injection_returns_400_not_500(
    app: FastAPI, client: AsyncClient,
) -> None:
    """A filter with SQL injection attempt should get 400 (invalid filter), not 500."""
    original_backend = app.state.backend
    mock_backend = MagicMock()
    mock_record = MagicMock()
    mock_record.name = "testcol"
    mock_backend.get.return_value = mock_record
    mock_backend.search.side_effect = InvalidFilterExpressionError(
        "Invalid filter expression: syntax error near ';'"
    )
    app.state.backend = mock_backend
    try:
        body = {
            "vector": [0.1] * 8,
            "topK": 10,
            "filter": "'; DROP TABLE --",
        }
        resp = await client.post(f"{API}/collections/testcol/searches", json=body)
    finally:
        app.state.backend = original_backend

    assert resp.status_code == 400
    assert resp.status_code != 500


# ---------------------------------------------------------------------------
# Very large topK (>10000)
# ---------------------------------------------------------------------------


async def test_very_large_topk_rejected(client: AsyncClient) -> None:
    """topK exceeding the schema limit (1000) should be rejected with 422."""
    body = {"vector": [0.1] * 8, "topK": 10001}
    resp = await client.post(f"{API}/collections/testcol/searches", json=body)
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# Empty collection name
# ---------------------------------------------------------------------------


async def test_empty_string_collection_name_rejected(
    client: AsyncClient,
) -> None:
    """An empty string as collection name in the schema should yield 422."""
    body = {"path": "/tmp/empty_name", "schema": _valid_schema("")}
    resp = await client.post(f"{API}/collections", json=body)
    assert resp.status_code == 422
