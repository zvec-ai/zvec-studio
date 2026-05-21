"""Trace ID middleware.

Every request gets a ULID ``traceId`` that flows through:

* Response header ``X-Trace-Id``
* ContextVar accessible via :func:`get_trace_id`
* The JSON Lines access log record
* RFC 7807 Problem Details responses

If the caller already supplied ``X-Trace-Id``, it is honored when the value is
a valid 26-char ULID; otherwise a fresh ULID is generated.
"""

from __future__ import annotations

import re
from contextvars import ContextVar

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from ulid import ULID

_TRACE_ID: ContextVar[str] = ContextVar("trace_id", default="")
TRACE_HEADER = "X-Trace-Id"

# ULIDs are 26 characters from Crockford's Base32 alphabet.
_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


def _is_valid_ulid(value: str) -> bool:
    return bool(value) and bool(_ULID_RE.match(value))


def new_trace_id() -> str:
    """Generate a fresh ULID-formatted trace id."""
    return str(ULID())


def get_trace_id() -> str:
    """Return the current request's trace id or empty string outside a request."""
    return _TRACE_ID.get()


class TraceIdMiddleware(BaseHTTPMiddleware):
    """Populate :class:`contextvars.ContextVar` and response header."""

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        incoming = request.headers.get(TRACE_HEADER, "").strip()
        trace_id = incoming if _is_valid_ulid(incoming) else new_trace_id()
        token = _TRACE_ID.set(trace_id)
        request.state.trace_id = trace_id
        try:
            response = await call_next(request)
        finally:
            _TRACE_ID.reset(token)
        response.headers[TRACE_HEADER] = trace_id
        return response
