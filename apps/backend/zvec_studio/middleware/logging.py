"""JSON Lines access-log middleware.

Emits one structured log record per HTTP request. Fields:

    {
      "ts":        ISO-8601 UTC timestamp,
      "level":     "info" | "warning" | "error",
      "traceId":   ULID from TraceIdMiddleware,
      "method":    "GET" / "POST" / ...,
      "path":      "/api/v1/...",
      "status":    200,
      "duration_ms": 12.34,
      "clientIp":  "127.0.0.1"
    }

Design notes
------------
* Uses the stdlib ``logging`` module so it co-operates with uvicorn's handlers.
* Emits a single JSON object per line (safe for ``jq``, ``grep``, log shippers).
* The record is intentionally flat; richer structured fields should be passed
  via ``logger.info("...", extra={"event": {...}})`` if needed later.
"""

from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from zvec_studio.middleware.trace_id import get_trace_id

access_logger = logging.getLogger("zvec_studio.access")


class JsonLinesFormatter(logging.Formatter):
    """Render LogRecord.msg (already a dict) as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any]
        if isinstance(record.msg, dict):
            payload = dict(record.msg)
        else:
            payload = {"message": record.getMessage()}
        payload.setdefault("level", record.levelname.lower())
        payload.setdefault("logger", record.name)
        payload.setdefault(
            "ts", datetime.now(tz=timezone.utc).isoformat(timespec="milliseconds")
        )
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def configure_json_logging(level: str = "info") -> None:
    """Attach a JSON Lines handler to the access logger (idempotent)."""
    numeric_level = getattr(logging, level.upper(), logging.INFO)
    access_logger.setLevel(numeric_level)

    # Clear previous handlers so repeated calls (tests) don't duplicate output.
    for handler in list(access_logger.handlers):
        access_logger.removeHandler(handler)

    handler = logging.StreamHandler()
    handler.setFormatter(JsonLinesFormatter())
    handler.setLevel(numeric_level)
    access_logger.addHandler(handler)
    access_logger.propagate = False


class JsonLinesAccessLogMiddleware(BaseHTTPMiddleware):
    """Emit one JSON log line per request."""

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        started = time.perf_counter()
        status_code = 500
        try:
            response = await call_next(request)
            status_code = response.status_code
            return response
        finally:
            duration_ms = (time.perf_counter() - started) * 1000.0
            client = request.client.host if request.client else None
            record: dict[str, Any] = {
                "traceId": get_trace_id(),
                "method": request.method,
                "path": request.url.path,
                "status": status_code,
                "duration_ms": round(duration_ms, 2),
                "clientIp": client,
            }
            if status_code >= 500:
                access_logger.error(record)
            elif status_code >= 400:
                access_logger.warning(record)
            else:
                access_logger.info(record)
