"""Document payload schemas.

Zvec ``Doc.id`` is required to be ``str``. Inserts may omit ``id`` (the SDK
generates a fresh ULID), but everything we expose downstream is normalised to
``str``.
"""

from __future__ import annotations

from typing import Any

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
