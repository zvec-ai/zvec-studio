"""Document payload schemas.

Zvec ``Doc.id`` is required to be ``str``. Inserts may omit ``id`` (the SDK
generates a fresh ULID), but everything we expose downstream is normalised to
``str``.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DocumentInsertRequest(BaseModel):
    """Body for ``POST /collections/{name}/documents``."""

    model_config = ConfigDict(extra="forbid")

    documents: list[dict[str, Any]] = Field(..., min_length=1, max_length=10_000)


class DocumentInsertResponse(BaseModel):
    inserted: int
    ids: list[str]


class DocumentBatchDeleteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ids: list[str] = Field(..., min_length=1, max_length=10_000)


class DocumentBatchDeleteResponse(BaseModel):
    deleted: int


class DocumentBrowseRequest(BaseModel):
    """Body for ``POST /collections/{name}/documents:browse``.

    Zvec 0.4.x has no ``list_all`` API, so we use a filtered ``query`` (without
    a vector) as the canonical browser. ``filter`` is the raw Zvec filter
    expression (``"category == 'tech' && publish_year > 2020"``); ``limit``
    caps the page size.
    """

    model_config = ConfigDict(extra="forbid")

    filter: str | None = None
    limit: int = Field(default=50, ge=1, le=1_000)
    outputFields: list[str] | None = None
    includeVector: bool = False


class DocumentBrowseResponse(BaseModel):
    items: list[dict[str, Any]]
    truncated: bool = False


# ---------------------------------------------------------------------------
# DML variants exposed by Zvec 0.4.x: ``upsert`` / ``update`` /
# ``delete_by_filter``. They share the dict-payload shape of insert (Zvec
# coerces them into ``Doc`` server-side) but each has its own response so the
# UI can show different success copy.
# ---------------------------------------------------------------------------


class DocumentUpsertRequest(BaseModel):
    """Body for ``POST /collections/{name}/documents:upsert``."""

    model_config = ConfigDict(extra="forbid")

    documents: list[dict[str, Any]] = Field(..., min_length=1, max_length=10_000)


class DocumentUpsertResponse(BaseModel):
    upserted: int
    ids: list[str]


class DocumentUpdateRequest(BaseModel):
    """Body for ``PATCH /collections/{name}/documents``.

    Zvec ``update`` performs **partial** updates: each document must carry
    an existing ``id`` plus the subset of scalar/vector columns to modify.
    Omitted columns retain their current values.
    """

    model_config = ConfigDict(extra="forbid")

    documents: list[dict[str, Any]] = Field(..., min_length=1, max_length=10_000)


class DocumentUpdateResponse(BaseModel):
    updated: int
    ids: list[str]


class DocumentDeleteByFilterRequest(BaseModel):
    """Body for ``POST /collections/{name}/documents:deleteByFilter``."""

    model_config = ConfigDict(extra="forbid")

    filter: str = Field(
        ...,
        min_length=1,
        description="SQL-WHERE filter (e.g. ``category = 'tech' AND year > 2020``).",
    )


class DocumentDeleteByFilterResponse(BaseModel):
    deleted: int


# ---------------------------------------------------------------------------
# Bulk import from a file (JSONL). The row-level report mirrors
# ``storage/import_.py::ImportReport`` verbatim; row failures are carried in
# the 200 body (partial-success batch semantics), only request-level problems
# map to 4xx.
# ---------------------------------------------------------------------------


class ImportSourceSpec(BaseModel):
    """Where the import reads its data from.

    Only ``localPath`` exists today — Studio is local-first, the backend runs
    on the user's machine, and reading a path avoids shovelling gigabytes
    through an HTTP upload. ``upload`` is reserved for the remote deployment
    enhancement.
    """

    model_config = ConfigDict(extra="forbid")

    kind: Literal["localPath"] = "localPath"
    path: str = Field(..., min_length=1, description="Absolute path of the file to import.")


class DocumentImportRequest(BaseModel):
    """Body for ``POST /collections/{name}/documents:import``."""

    model_config = ConfigDict(extra="forbid")

    source: ImportSourceSpec
    mode: Literal["insert", "replace"] = Field(
        default="replace",
        description=(
            "insert: existing primary keys fail the row. replace: the row's "
            "content becomes the whole document for that key (idempotent "
            "re-import)."
        ),
    )
    onError: Literal["abort", "skip"] = Field(
        default="abort",
        description="abort: stop at the first failing row; skip: record it and continue.",
    )
    format: str | None = Field(
        default=None,
        description=(
            "Import format name ('jsonl'). When omitted, inferred from the "
            "file extension; extension-less files default to jsonl."
        ),
    )
    batchSize: int | None = Field(
        default=None,
        ge=1,
        le=1024,
        description=(
            "Internal write batch size. Capped at the SDK's 1024-document "
            "limit; defaults to the benchmarked sweet spot (512)."
        ),
    )


class DocumentImportErrorEntry(BaseModel):
    """One failing row."""

    line: int = Field(..., description="1-based physical line in the file.")
    code: str = Field(..., description="Studio error code for this row.")
    message: str


class DocumentImportResponse(BaseModel):
    imported: int
    failed: int
    totalLines: int = Field(..., description="Data rows read (blank lines excluded).")
    aborted: bool
    durationMs: float
    errors: list[DocumentImportErrorEntry] = Field(
        ..., description="First 100 failing rows; see errorsTruncated."
    )
    errorsTruncated: bool
