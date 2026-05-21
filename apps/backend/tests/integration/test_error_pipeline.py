"""Integration tests for T1: RFC 7807 error pipeline end-to-end.

Exercises the diagnostics router (``/__diag__/boom/*``) through the full
middleware stack: traceId injection + error handler + JSON Lines log emission.
"""

from __future__ import annotations

from httpx import AsyncClient

from zvec_studio.middleware.error_handler import PROBLEM_MEDIA_TYPE
from zvec_studio.middleware.trace_id import TRACE_HEADER, _is_valid_ulid


async def test_domain_error_is_rfc7807_with_trace_id(client: AsyncClient) -> None:
    response = await client.get("/api/v1/__diag__/boom/collection-not-found")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith(PROBLEM_MEDIA_TYPE)
    body = response.json()
    assert body["status"] == 404
    assert body["code"] == "COLLECTION_NOT_FOUND"
    assert body["title"] == "Collection Not Found"
    assert body["sdkException"] == "CollectionNotFoundError"
    assert body["name"] == "demo"
    assert _is_valid_ulid(body["traceId"])
    assert response.headers[TRACE_HEADER] == body["traceId"]


async def test_schema_error_returns_400(client: AsyncClient) -> None:
    response = await client.get("/api/v1/__diag__/boom/schema")
    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "INVALID_SCHEMA"
    assert body["detail"] == "Vector dimension must be >= 1."


async def test_generic_domain_error_uses_default_status(client: AsyncClient) -> None:
    response = await client.get("/api/v1/__diag__/boom/generic")
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "GENERIC_FAILURE"


async def test_unexpected_error_is_masked_as_500(client: AsyncClient) -> None:
    response = await client.get("/api/v1/__diag__/boom/internal")
    assert response.status_code == 500
    body = response.json()
    assert body["code"] == "INTERNAL_ERROR"
    assert body["sdkException"] == "RuntimeError"
    # No stack trace leaks to the wire; only the message is surfaced.
    assert body["detail"] == "unexpected failure"


async def test_404_for_unknown_route_is_rfc7807(client: AsyncClient) -> None:
    response = await client.get("/api/v1/this-route-does-not-exist")
    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "HTTP_404"
    assert body["title"] == "Not Found"
    assert _is_valid_ulid(body["traceId"])


async def test_openapi_is_served_at_configured_prefix(client: AsyncClient) -> None:
    response = await client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    payload = response.json()
    assert payload["info"]["title"] == "Zvec Studio API"
    # Diagnostic router is excluded from the public schema.
    paths = payload["paths"]
    assert "/api/v1/healthz" in paths
    assert "/api/v1/__diag__/boom/schema" not in paths


async def test_healthz_and_readyz_payload(client: AsyncClient) -> None:
    for suffix, status in (("healthz", "ok"), ("readyz", "ready")):
        response = await client.get(f"/api/v1/{suffix}")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == status
        assert body["version"]
