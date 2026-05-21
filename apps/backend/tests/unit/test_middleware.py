"""Unit tests for T1 middleware layer.

Covers traceId generation/propagation, JSON Lines formatter behaviour, and
the RFC 7807 error-handler mapping. Kept independent of the full FastAPI app
where possible so failures point to the exact component.
"""

from __future__ import annotations

import json
import logging

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from zvec_studio.exceptions import (
    CollectionNotFoundError,
    DimensionMismatchError,
    InvalidFilterExpressionError,
    ZvecStudioError,
)
from zvec_studio.middleware.logging import (
    JsonLinesFormatter,
    access_logger,
    configure_json_logging,
)
from zvec_studio.middleware.trace_id import (
    TRACE_HEADER,
    _is_valid_ulid,
    get_trace_id,
    new_trace_id,
)

# ---------- trace_id ----------

def test_new_trace_id_is_valid_ulid() -> None:
    tid = new_trace_id()
    assert _is_valid_ulid(tid)
    assert len(tid) == 26


def test_is_valid_ulid_rejects_bad_inputs() -> None:
    assert _is_valid_ulid("") is False
    assert _is_valid_ulid("too-short") is False
    assert _is_valid_ulid("01ARZ3NDEKTSV4RRFFQ69G5FAV!") is False
    # Crockford base32 excludes I, L, O, U
    assert _is_valid_ulid("I" * 26) is False


def test_get_trace_id_empty_outside_request_scope() -> None:
    # ContextVar default is an empty string when no request is active.
    assert get_trace_id() == ""


# ---------- logging ----------

def test_json_lines_formatter_emits_single_line_json() -> None:
    formatter = JsonLinesFormatter()
    record = logging.LogRecord(
        name="zvec_studio.access",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg={"method": "GET", "path": "/api/v1/healthz", "status": 200},
        args=None,
        exc_info=None,
    )
    line = formatter.format(record)
    assert "\n" not in line
    parsed = json.loads(line)
    assert parsed["method"] == "GET"
    assert parsed["status"] == 200
    assert parsed["level"] == "info"
    assert parsed["logger"] == "zvec_studio.access"
    assert "ts" in parsed


def test_json_lines_formatter_handles_string_message() -> None:
    formatter = JsonLinesFormatter()
    record = logging.LogRecord(
        name="zvec_studio.access",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="plain text message",
        args=None,
        exc_info=None,
    )
    parsed = json.loads(formatter.format(record))
    assert parsed["message"] == "plain text message"
    assert parsed["level"] == "warning"


def test_configure_json_logging_is_idempotent() -> None:
    configure_json_logging("debug")
    first = list(access_logger.handlers)
    configure_json_logging("info")
    second = list(access_logger.handlers)
    assert len(first) == 1
    assert len(second) == 1
    assert access_logger.level == logging.INFO


# ---------- exceptions ----------

def test_zvec_error_defaults_and_overrides() -> None:
    err = ZvecStudioError("boom")
    assert err.code == "INTERNAL_ERROR"
    assert err.status_code == 500
    assert err.title == "Internal Server Error"
    assert err.sdk_exception is None
    assert err.extra == {}

    custom = ZvecStudioError(
        "x",
        code="CUSTOM",
        status_code=418,
        title="Teapot",
        sdk_exception="BrewError",
        extra={"hint": "use coffee"},
    )
    assert custom.code == "CUSTOM"
    assert custom.status_code == 418
    assert custom.title == "Teapot"
    assert custom.sdk_exception == "BrewError"
    assert custom.extra == {"hint": "use coffee"}


@pytest.mark.parametrize(
    ("exc_cls", "expected_status", "expected_code"),
    [
        (CollectionNotFoundError, 404, "COLLECTION_NOT_FOUND"),
        (InvalidFilterExpressionError, 400, "INVALID_FILTER_EXPRESSION"),
        (DimensionMismatchError, 400, "DIMENSION_MISMATCH"),
    ],
)
def test_domain_exception_status_codes(
    exc_cls: type[ZvecStudioError],
    expected_status: int,
    expected_code: str,
) -> None:
    err = exc_cls("detail")
    assert err.status_code == expected_status
    assert err.code == expected_code


# ---------- end-to-end middleware through FastAPI ----------

@pytest.mark.asyncio
async def test_trace_id_generated_when_missing(app: FastAPI) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/api/v1/healthz")
    assert response.status_code == 200
    assert _is_valid_ulid(response.headers.get(TRACE_HEADER, ""))


@pytest.mark.asyncio
async def test_trace_id_echoes_valid_incoming(app: FastAPI) -> None:
    transport = ASGITransport(app=app)
    incoming = new_trace_id()
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/api/v1/healthz", headers={TRACE_HEADER: incoming})
    assert response.headers[TRACE_HEADER] == incoming


@pytest.mark.asyncio
async def test_trace_id_ignores_invalid_incoming(app: FastAPI) -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        response = await ac.get("/api/v1/healthz", headers={TRACE_HEADER: "not-a-ulid"})
    returned = response.headers[TRACE_HEADER]
    assert returned != "not-a-ulid"
    assert _is_valid_ulid(returned)
