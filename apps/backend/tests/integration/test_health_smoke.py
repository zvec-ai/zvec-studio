"""Integration smoke test: the ASGI transport can reach the live FastAPI app."""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.integration
async def test_healthz_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/api/v1/healthz")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "version" in body


@pytest.mark.integration
async def test_readyz_returns_ready(client: AsyncClient) -> None:
    response = await client.get("/api/v1/readyz")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


@pytest.mark.integration
async def test_openapi_schema_is_served(client: AsyncClient) -> None:
    response = await client.get("/api/v1/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    assert schema["openapi"].startswith("3.")
    assert schema["info"]["title"] == "Zvec Studio API"
