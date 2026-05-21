"""Business-level exceptions.

All Studio exceptions inherit :class:`ZvecStudioError` so the middleware layer
can render a consistent RFC 7807 Problem Details response. The ``code`` field
mirrors the error-code catalog defined in the PRD §8.x and the Python SDK.
"""

from __future__ import annotations

from typing import Any


class ZvecStudioError(Exception):
    """Base class for all Studio-originated errors.

    Attributes
    ----------
    code:
        Stable machine-readable error code (e.g. ``COLLECTION_NOT_FOUND``).
    status_code:
        HTTP status code used when this exception bubbles up through FastAPI.
    title:
        Short human-readable title (defaults to ``code`` in Title Case).
    sdk_exception:
        Optional SDK exception class name preserved for debugging.
    extra:
        Additional context merged into the Problem Details document.
    """

    code: str = "INTERNAL_ERROR"
    status_code: int = 500
    title: str = "Internal Server Error"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status_code: int | None = None,
        title: str | None = None,
        sdk_exception: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        if status_code is not None:
            self.status_code = status_code
        if title is not None:
            self.title = title
        self.sdk_exception = sdk_exception
        self.extra: dict[str, Any] = dict(extra or {})

    @property
    def message(self) -> str:
        return str(self)


class CollectionNotFoundError(ZvecStudioError):
    code = "COLLECTION_NOT_FOUND"
    status_code = 404
    title = "Collection Not Found"


class CollectionAlreadyExistsError(ZvecStudioError):
    code = "COLLECTION_ALREADY_EXISTS"
    status_code = 409
    title = "Collection Already Exists"


class InvalidSchemaError(ZvecStudioError):
    code = "INVALID_SCHEMA"
    status_code = 400
    title = "Invalid Collection Schema"


class InvalidFilterExpressionError(ZvecStudioError):
    code = "INVALID_FILTER_EXPRESSION"
    status_code = 400
    title = "Invalid Filter Expression"


class DocumentNotFoundError(ZvecStudioError):
    code = "DOCUMENT_NOT_FOUND"
    status_code = 404
    title = "Document Not Found"


class DimensionMismatchError(ZvecStudioError):
    code = "DIMENSION_MISMATCH"
    status_code = 400
    title = "Vector Dimension Mismatch"


class AIDependencyMissingError(ZvecStudioError):
    """Raised when the optional ``[ai]`` extras (sentence-transformers, etc.)
    are not installed but the user invokes an AI extension feature."""

    code = "AI_DEPENDENCY_MISSING"
    status_code = 503
    title = "AI Dependency Missing"


class AIFunctionNotFoundError(ZvecStudioError):
    code = "AI_FUNCTION_NOT_FOUND"
    status_code = 404
    title = "AI Function Not Found"


class AIFunctionAlreadyExistsError(ZvecStudioError):
    code = "AI_FUNCTION_ALREADY_EXISTS"
    status_code = 409
    title = "AI Function Already Exists"


class AIFunctionInvocationError(ZvecStudioError):
    """Raised when an AI extension call (embed / rerank / build instance)
    fails — e.g. invalid API key, model download failure, dimension mismatch."""

    code = "AI_FUNCTION_INVOCATION_FAILED"
    status_code = 500
    title = "AI Function Invocation Failed"
