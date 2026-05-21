"""Middleware package.

The three middlewares applied to every request are:

* :mod:`trace_id` - injects an incoming or generated ULID ``traceId``
* :mod:`logging`  - emits a JSON Lines access log record per request
* :mod:`error_handler` - converts exceptions to RFC 7807 Problem Details
"""

from __future__ import annotations

from zvec_studio.middleware.error_handler import register_error_handlers
from zvec_studio.middleware.logging import JsonLinesAccessLogMiddleware
from zvec_studio.middleware.trace_id import TraceIdMiddleware, get_trace_id

__all__ = [
    "JsonLinesAccessLogMiddleware",
    "TraceIdMiddleware",
    "get_trace_id",
    "register_error_handlers",
]
