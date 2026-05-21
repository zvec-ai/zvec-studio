"""RFC 7807 Problem Details error handlers.

The Problem Details document we emit includes the standard fields plus two
extensions:

* ``code``         - stable machine-readable error code (e.g. ``COLLECTION_NOT_FOUND``)
* ``sdkException`` - original Zvec SDK exception class name (optional)
* ``traceId``      - ULID for log correlation

See PRD §5.4.9 and §8.5.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import ORJSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from zvec_studio.exceptions import ZvecStudioError
from zvec_studio.middleware.trace_id import get_trace_id

PROBLEM_MEDIA_TYPE = "application/problem+json"


def _problem_response(
    *,
    status: int,
    title: str,
    code: str,
    detail: str,
    trace_id: str | None = None,
    sdk_exception: str | None = None,
    extra: dict[str, Any] | None = None,
    type_uri: str = "about:blank",
) -> ORJSONResponse:
    """Build an ORJSONResponse matching the RFC 7807 Problem Details shape."""
    body: dict[str, Any] = {
        "type": type_uri,
        "title": title,
        "status": status,
        "code": code,
        "detail": detail,
        "traceId": trace_id or get_trace_id(),
    }
    if sdk_exception:
        body["sdkException"] = sdk_exception
    if extra:
        body.update(extra)
    return ORJSONResponse(content=body, status_code=status, media_type=PROBLEM_MEDIA_TYPE)


def _handle_zvec_error(request: Request, exc: ZvecStudioError) -> ORJSONResponse:
    return _problem_response(
        status=exc.status_code,
        title=exc.title,
        code=exc.code,
        detail=exc.message or exc.title,
        trace_id=getattr(request.state, "trace_id", None),
        sdk_exception=exc.sdk_exception,
        extra=exc.extra,
    )


def _handle_http_exception(
    request: Request, exc: StarletteHTTPException
) -> ORJSONResponse:
    return _problem_response(
        status=exc.status_code,
        title=_http_status_title(exc.status_code),
        code=f"HTTP_{exc.status_code}",
        detail=str(exc.detail) if exc.detail else _http_status_title(exc.status_code),
        trace_id=getattr(request.state, "trace_id", None),
    )


def _handle_validation_error(
    request: Request, exc: RequestValidationError
) -> ORJSONResponse:
    return _problem_response(
        status=422,
        title="Unprocessable Entity",
        code="VALIDATION_ERROR",
        detail="Request body failed schema validation.",
        trace_id=getattr(request.state, "trace_id", None),
        extra={"errors": jsonable_encoder(exc.errors())},
    )


def _handle_unexpected_error(request: Request, exc: Exception) -> ORJSONResponse:
    # We never leak stack traces over the wire; the access log still records
    # the incident via the logging middleware.
    return _problem_response(
        status=500,
        title="Internal Server Error",
        code="INTERNAL_ERROR",
        detail=str(exc) or "Unexpected server error.",
        trace_id=getattr(request.state, "trace_id", None),
        sdk_exception=exc.__class__.__name__,
    )


def _http_status_title(status: int) -> str:
    mapping = {
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        409: "Conflict",
        410: "Gone",
        422: "Unprocessable Entity",
        500: "Internal Server Error",
    }
    return mapping.get(status, "Error")


def register_error_handlers(app: FastAPI) -> None:
    """Install all Problem Details handlers on the given FastAPI app."""
    app.add_exception_handler(ZvecStudioError, _handle_zvec_error)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, _handle_http_exception)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _handle_validation_error)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, _handle_unexpected_error)
