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


class DocumentConflictError(ZvecStudioError):
    """The target primary key already exists (``insert`` rejects duplicates)."""

    code = "DOCUMENT_CONFLICT"
    status_code = 409
    title = "Document Already Exists"


class MaintenanceBlockedError(ZvecStudioError):
    """Maintenance was rejected because a snapshot iterator is open.

    Zvec blocks ``flush``/``optimize``/DDL while an export iterator holds the
    collection (PR #597 contract). That is a transient conflict — retryable
    once the export finishes — not an invalid request.
    """

    code = "MAINTENANCE_BLOCKED"
    status_code = 409
    title = "Maintenance Blocked"


class UnsupportedVectorDataTypeError(ZvecStudioError):
    """The collection carries a vector dtype Studio cannot represent.

    Distinct from ``COLLECTION_NOT_FOUND``: the collection exists and opened
    fine at the SDK level — only Studio's dtype surface does not cover it
    (e.g. a legacy ``VECTOR_FP64`` collection after the enum was pruned).
    """

    code = "UNSUPPORTED_VECTOR_DATA_TYPE"
    status_code = 422
    title = "Unsupported Vector Data Type"


class ImportFileNotFoundError(ZvecStudioError):
    """The requested import source does not exist or is not a regular file."""

    code = "IMPORT_FILE_NOT_FOUND"
    status_code = 404
    title = "Import File Not Found"


class ImportFileNotReadableError(ZvecStudioError):
    """The import source exists but cannot be opened for reading."""

    code = "IMPORT_FILE_NOT_READABLE"
    status_code = 403
    title = "Import File Not Readable"


class ImportManifestInvalidError(ZvecStudioError):
    """A snapshot's manifest.json is unreadable or structurally invalid."""

    code = "IMPORT_MANIFEST_INVALID"
    status_code = 400
    title = "Invalid Import Manifest"


class ImportSchemaMismatchError(ZvecStudioError):
    """The snapshot's schema is not compatible with the target collection.

    Raised before any row is written (fail-fast); ``extra['mismatches']``
    carries human-readable reasons.
    """

    code = "IMPORT_SCHEMA_MISMATCH"
    status_code = 409
    title = "Import Schema Mismatch"


class ExportNonFiniteError(ZvecStudioError):
    """A document carries NaN/±Inf and cannot be written to JSON safely.

    Raised instead of letting orjson silently coerce non-finite floats to
    ``null`` (data loss) or emitting non-standard ``NaN`` literals that no
    conforming parser reads back. ``extra`` carries ``documentId`` and the
    value ``path`` (e.g. ``embedding[3]``).
    """

    code = "EXPORT_NON_FINITE_VALUE"
    status_code = 422
    title = "Non-Finite Value In Document"


class InvalidDocumentError(ZvecStudioError):
    """A single document fails validation at the SDK level (missing required
    field, type mismatch, ...). Distinct from ``InvalidSchemaError``, which
    covers the collection schema itself."""

    code = "INVALID_DOCUMENT"
    status_code = 422
    title = "Invalid Document"


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
