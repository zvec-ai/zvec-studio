"""Collection-related Pydantic schemas.

Aligned with the Zvec Python SDK 0.6.x surface:
- ``Doc`` owns the primary key (``id: str``); the application schema does NOT
  declare a primary scalar field.
- Each ``VectorSchema`` optionally carries its own ``indexParam``; there is no
  collection-level ``indexParams`` in the SDK.
- Scalar fields may carry ``INVERT`` or ``FTS`` indexes. Vectorless collections
  are valid when they have scalar fields, which enables FTS-only use cases.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
# Zvec is stricter on collection names: must start with a letter and be at
# least 3 characters long (verified empirically against zvec 0.4.0).
_COLLECTION_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{2,63}$")

# ``id`` and ``_id`` used to be rejected here on the assumption that Zvec
# "injects" ``id`` and a same-named column would shadow it. That assumption is
# wrong: ``Doc.id`` lives beside the columns, and Zvec accepts a schema that
# declares a scalar field or vector named ``id`` (or ``_id``) — the two coexist
# independently. Rejecting them made Studio unable to *open* collections
# created through the SDK, so the restriction is gone; the primary key gets its
# own row key (``$id``) whenever a column takes ``id``, see storage/doc_repr.py.
_FTS_TOKENIZERS: frozenset[str] = frozenset({"standard", "whitespace", "jieba"})
_FTS_FILTERS: frozenset[str] = frozenset({"lowercase", "ascii_folding", "stemmer"})

# Collection names that collide with REST sub-resources of ``/collections``.
# These literals would otherwise be ambiguous against ``GET /collections/{name}``
# style URLs (e.g. ``GET /collections/recent`` is a workspace helper, not a
# real collection).
_RESERVED_COLLECTION_NAMES: frozenset[str] = frozenset({"recent", "open"})


class VectorDataType(str, Enum):
    """Vector dtypes supported by the Zvec SDK.

    ``VECTOR_FP64`` is intentionally absent: zvec's schema validation rejects
    it ("dense_vector's data type only support FP32"), so exposing it would
    only let users build collections that fail at create time.
    """

    VECTOR_FP32 = "VECTOR_FP32"
    VECTOR_FP16 = "VECTOR_FP16"
    VECTOR_INT8 = "VECTOR_INT8"
    SPARSE_VECTOR_FP32 = "SPARSE_VECTOR_FP32"
    SPARSE_VECTOR_FP16 = "SPARSE_VECTOR_FP16"


class ScalarDataType(str, Enum):
    """Scalar field types supported in a Collection schema."""

    INT32 = "INT32"
    INT64 = "INT64"
    UINT32 = "UINT32"
    UINT64 = "UINT64"
    FLOAT = "FLOAT"
    DOUBLE = "DOUBLE"
    BOOL = "BOOL"
    STRING = "STRING"
    ARRAY_BOOL = "ARRAY_BOOL"
    ARRAY_INT32 = "ARRAY_INT32"
    ARRAY_INT64 = "ARRAY_INT64"
    ARRAY_UINT32 = "ARRAY_UINT32"
    ARRAY_UINT64 = "ARRAY_UINT64"
    ARRAY_FLOAT = "ARRAY_FLOAT"
    ARRAY_DOUBLE = "ARRAY_DOUBLE"
    ARRAY_STRING = "ARRAY_STRING"


class IndexType(str, Enum):
    """Index families exposed by the Zvec SDK."""

    HNSW = "HNSW"
    FLAT = "FLAT"
    IVF = "IVF"
    HNSW_RABITQ = "HNSW_RABITQ"
    VAMANA = "VAMANA"
    DISKANN = "DISKANN"
    INVERT = "INVERT"
    FTS = "FTS"


class MetricType(str, Enum):
    """Distance metrics accepted by the SDK."""

    L2 = "L2"
    IP = "IP"
    COSINE = "COSINE"


class FieldSchema(BaseModel):
    """Definition of a single scalar field."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="Field name (identifier-like)")
    dataType: ScalarDataType = Field(..., description="Scalar data type")
    nullable: bool = False
    indexParam: ScalarIndexParam | None = Field(
        default=None,
        description="Inverted index params; None means no index on this field.",
    )

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("field name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$")
        return v

    @model_validator(mode="after")
    def _validate_index(self) -> FieldSchema:
        if self.indexParam is None:
            return self
        if self.indexParam.indexType is IndexType.FTS and self.dataType is not ScalarDataType.STRING:
            raise ValueError("FTS indexes are only supported on STRING fields")
        if self.indexParam.indexType not in {IndexType.INVERT, IndexType.FTS}:
            raise ValueError("scalar field index type must be INVERT or FTS")
        return self


class VectorIndexParam(BaseModel):
    """Index build parameters attached to a single vector field."""

    model_config = ConfigDict(extra="forbid")

    indexType: IndexType = Field(default=IndexType.HNSW)
    metric: MetricType = Field(default=MetricType.COSINE)
    params: dict[str, Any] = Field(default_factory=dict)


class ScalarIndexParam(BaseModel):
    """Scalar index parameters attached to a field.

    ``INVERT`` accelerates scalar filtering. ``FTS`` enables BM25 full-text
    search over ``STRING`` fields and uses tokenizer settings during both
    indexing and querying.
    """

    model_config = ConfigDict(extra="forbid")

    indexType: IndexType = Field(default=IndexType.INVERT)
    enableRangeOptimization: bool = False
    enableExtendedWildcard: bool = False
    tokenizerName: str = "standard"
    filters: list[str] = Field(default_factory=lambda: ["lowercase"])
    extraParams: str = ""

    @model_validator(mode="after")
    def _validate_scalar_index(self) -> ScalarIndexParam:
        if self.indexType not in {IndexType.INVERT, IndexType.FTS}:
            raise ValueError("scalar index type must be INVERT or FTS")
        if self.indexType is IndexType.FTS:
            if self.tokenizerName not in _FTS_TOKENIZERS:
                raise ValueError("FTS tokenizerName must be standard, whitespace, or jieba")
            unsupported = set(self.filters) - _FTS_FILTERS
            if unsupported:
                raise ValueError(f"unsupported FTS token filters: {sorted(unsupported)}")
        return self


class VectorSchema(BaseModel):
    """Definition of a vector field."""

    model_config = ConfigDict(extra="forbid")

    name: str
    dataType: VectorDataType
    dimension: Annotated[int, Field(ge=1, le=20_000)]
    indexParam: VectorIndexParam | None = Field(
        default=None,
        description="Optional index params; if omitted the index is created lazily.",
    )

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("vector name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$")
        return v


class CollectionSchema(BaseModel):
    """Top-level Collection schema (name + vectors + scalar fields)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    vectors: list[VectorSchema] = Field(default_factory=list)
    fields: list[FieldSchema] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _COLLECTION_NAME_RE.match(v):
            raise ValueError(
                "collection name must match ^[A-Za-z][A-Za-z0-9_]{2,63}$ "
                "(start with a letter, 3-64 chars)"
            )
        if v.lower() in _RESERVED_COLLECTION_NAMES:
            raise ValueError(
                f"collection name '{v}' is reserved by the REST gateway"
            )
        return v

    @model_validator(mode="after")
    def _validate_fields(self) -> CollectionSchema:
        vec_names = {v.name for v in self.vectors}
        field_names = {f.name for f in self.fields}
        if len(vec_names) != len(self.vectors):
            raise ValueError("duplicate vector field names")
        if len(field_names) != len(self.fields):
            raise ValueError("duplicate scalar field names")
        overlap = vec_names & field_names
        if overlap:
            raise ValueError(
                f"name collision between vector and scalar fields: {sorted(overlap)}"
            )
        if not self.vectors and not self.fields:
            raise ValueError("collection schema must contain at least one vector or scalar field")
        return self


class CollectionCreateRequest(BaseModel):
    """Request body for ``POST /collections``."""

    model_config = ConfigDict(extra="forbid")

    path: str
    schema_: CollectionSchema = Field(..., alias="schema")


class CollectionOpenRequest(BaseModel):
    """Request body for ``POST /collections:open``."""

    model_config = ConfigDict(extra="forbid")

    path: str


class CollectionStats(BaseModel):
    """Stats returned by ``GET /collections/{name}/stats``."""

    documentCount: int = 0
    indexState: str = "none"
    indexCompleteness: dict[str, float] = Field(default_factory=dict)
    storageBytes: int = 0


class CollectionSummary(BaseModel):
    """Detail payload for ``GET /collections/{name}``."""

    name: str
    path: str
    schema_: CollectionSchema = Field(..., alias="schema")
    stats: CollectionStats


class CollectionListItem(BaseModel):
    name: str
    path: str


class CollectionListResponse(BaseModel):
    items: list[CollectionListItem]


# ---------------------------------------------------------------------------
# Recent collections (workspace helper persisted at ``<data_dir>/config.json``).
# Identified by absolute disk path; ``name`` is intentionally NOT part of the
# identity because the SDK only exposes a name once a collection is opened.
# ---------------------------------------------------------------------------


class RecentCollectionItem(BaseModel):
    """One entry in the recently-opened-collections list."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        ..., description="Absolute resolved disk path of the collection."
    )
    name: str | None = Field(
        None,
        description="Collection name as stored in schema. May be null for legacy entries.",
    )
    lastOpenedAt: str = Field(
        ...,
        description=(
            "ISO-8601 UTC timestamp of when this path was last opened or"
            " created through the REST gateway."
        ),
    )


class RecentCollectionListResponse(BaseModel):
    """Response payload of ``GET /collections/recent``."""

    items: list[RecentCollectionItem]


class RecentForgetRequest(BaseModel):
    """Body of ``POST /collections/recent:forget``."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        ...,
        description=(
            "Path to drop from recents. The gateway resolves"
            " ``~`` and relative segments before matching."
        ),
    )


# ---------------------------------------------------------------------------
# DDL request bodies (Zvec 0.4.x ``add_column`` / ``drop_column`` /
# ``alter_column`` / ``create_index`` / ``drop_index``).
# ---------------------------------------------------------------------------


class FieldAddRequest(BaseModel):
    """Body for ``POST /collections/{name}/fields`` — add a scalar field."""

    model_config = ConfigDict(extra="forbid")

    field: FieldSchema = Field(..., description="New scalar field definition.")
    expression: str = Field(
        default="",
        description=(
            "Optional Zvec expression used to backfill values for existing rows."
            " Empty string defaults to the dtype's zero value."
        ),
    )


class FieldRenameRequest(BaseModel):
    """Body for ``PATCH /collections/{name}/fields/{field}`` — rename only."""

    model_config = ConfigDict(extra="forbid")

    newName: str = Field(..., description="New scalar field name.")

    @field_validator("newName")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("new field name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$")
        return v


class IndexCreateRequest(BaseModel):
    """Body for ``POST /collections/{name}/indexes`` — (re)create a vector index."""

    model_config = ConfigDict(extra="forbid")

    vectorField: str = Field(..., description="Name of the vector field.")
    indexType: IndexType = Field(default=IndexType.HNSW)
    metric: MetricType = Field(default=MetricType.COSINE)
    params: dict[str, Any] = Field(default_factory=dict)


class ScalarIndexCreateRequest(BaseModel):
    """Body for ``POST /collections/{name}/fields/{field}/index``."""

    model_config = ConfigDict(extra="forbid")

    indexType: IndexType = IndexType.INVERT
    enableRangeOptimization: bool = False
    enableExtendedWildcard: bool = False
    tokenizerName: str = "standard"
    filters: list[str] = Field(default_factory=lambda: ["lowercase"])
    extraParams: str = ""

    @model_validator(mode="after")
    def _validate_scalar_index(self) -> ScalarIndexCreateRequest:
        if self.indexType not in {IndexType.INVERT, IndexType.FTS}:
            raise ValueError("scalar index type must be INVERT or FTS")
        if self.indexType is IndexType.FTS:
            if self.tokenizerName not in _FTS_TOKENIZERS:
                raise ValueError("FTS tokenizerName must be standard, whitespace, or jieba")
            unsupported = set(self.filters) - _FTS_FILTERS
            if unsupported:
                raise ValueError(f"unsupported FTS token filters: {sorted(unsupported)}")
        return self


# ---------------------------------------------------------------------------
# Maintenance response payloads.
# ---------------------------------------------------------------------------


class MaintenanceResponse(BaseModel):
    """Generic response for ``flush`` / ``optimize`` operations."""

    operation: str = Field(..., description="Operation performed (``flush``, ``optimize``).")
    timestamp: str = Field(..., description="ISO-8601 timestamp when the operation finished.")


# ---------------------------------------------------------------------------
# Snapshot restore (collection-level lifecycle operation).
# ---------------------------------------------------------------------------


class CollectionImportRequest(BaseModel):
    """Import a collection from a snapshot package (``.tar.gz``).

    A sibling of create/open, not a variant of document import: the manifest
    embedded in the snapshot supplies the schema, ``targetPath`` gives the new
    collection a home on disk, and the data rows are loaded in the same pass.
    """

    model_config = ConfigDict(extra="forbid")

    source: ImportSourceSpec = Field(
        ..., description="The snapshot package to import from (local path)."
    )
    targetPath: str = Field(
        ...,
        min_length=1,
        description=(
            "Directory for the imported collection. Must not exist (409 if it "
            "does, empty directories included); the collection is created there."
        ),
    )
    name: str | None = Field(
        default=None,
        description=(
            "Optional new collection name. Defaults to the name recorded in "
            "the snapshot manifest; override it to avoid clashing with an "
            "open collection."
        ),
    )

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is not None and not _COLLECTION_NAME_RE.match(v):
            raise ValueError("collection name must match ^[A-Za-z][A-Za-z0-9_]{2,63}$")
        return v


class CollectionImportResponse(BaseModel):
    """The imported collection plus the row-level load report."""

    collection: CollectionSummary
    report: DocumentImportResponse


from zvec_studio.schemas.document import (  # noqa: E402  (avoid import cycle)
    DocumentImportResponse,
    ImportSourceSpec,
)

CollectionImportRequest.model_rebuild()
CollectionImportResponse.model_rebuild()
