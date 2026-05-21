"""Collection-related Pydantic schemas.

Aligned with the Zvec Python SDK 0.4.x surface:
- ``Doc`` owns the primary key (``id: str``); the application schema does NOT
  declare a primary scalar field.
- Each ``VectorSchema`` optionally carries its own ``indexParam``; there is no
  collection-level ``indexParams`` in the SDK.
- Scalar types mirror ``zvec.schema.ScalarDataType`` (no JSON).
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

# Field names colliding with Zvec's built-in ``Doc.id``. The SDK injects ``id``
# automatically; user-defined columns must not shadow it.
_RESERVED_FIELD_NAMES: frozenset[str] = frozenset({"id", "_id"})

# Collection names that collide with REST sub-resources of ``/collections``.
# These literals would otherwise be ambiguous against ``GET /collections/{name}``
# style URLs (e.g. ``GET /collections/recent`` is a workspace helper, not a
# real collection).
_RESERVED_COLLECTION_NAMES: frozenset[str] = frozenset({"recent", "open"})


class VectorDataType(str, Enum):
    """Vector dtypes supported by the Zvec SDK."""

    VECTOR_FP32 = "VECTOR_FP32"
    VECTOR_FP16 = "VECTOR_FP16"
    VECTOR_INT8 = "VECTOR_INT8"


class ScalarDataType(str, Enum):
    """Scalar field types supported in a Collection schema."""

    INT64 = "INT64"
    FLOAT = "FLOAT"
    DOUBLE = "DOUBLE"
    BOOL = "BOOL"
    STRING = "STRING"


class IndexType(str, Enum):
    """Index families exposed by the Zvec SDK."""

    HNSW = "HNSW"
    FLAT = "FLAT"
    IVF = "IVF"
    HNSW_RABITQ = "HNSW_RABITQ"
    INVERT = "INVERT"


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
        if v in _RESERVED_FIELD_NAMES:
            raise ValueError(f"field name '{v}' is reserved by the SDK and cannot be used")
        return v


class VectorIndexParam(BaseModel):
    """Index build parameters attached to a single vector field."""

    model_config = ConfigDict(extra="forbid")

    indexType: IndexType = Field(default=IndexType.HNSW)
    metric: MetricType = Field(default=MetricType.COSINE)
    params: dict[str, Any] = Field(default_factory=dict)


class ScalarIndexParam(BaseModel):
    """Inverted index parameters attached to a scalar field."""

    model_config = ConfigDict(extra="forbid")

    indexType: IndexType = Field(default=IndexType.INVERT)
    enableRangeOptimization: bool = False
    enableExtendedWildcard: bool = False


class VectorSchema(BaseModel):
    """Definition of a vector field."""

    model_config = ConfigDict(extra="forbid")

    name: str
    dataType: VectorDataType
    dimension: Annotated[int, Field(ge=1, le=32_768)]
    indexParam: VectorIndexParam | None = Field(
        default=None,
        description="Optional index params; if omitted the index is created lazily.",
    )

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        if not _NAME_RE.match(v):
            raise ValueError("vector name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$")
        if v in _RESERVED_FIELD_NAMES:
            raise ValueError(f"vector name '{v}' is reserved by the SDK and cannot be used")
        return v


class CollectionSchema(BaseModel):
    """Top-level Collection schema (name + vectors + scalar fields)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    vectors: list[VectorSchema] = Field(default_factory=list, min_length=1)
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
        if v in _RESERVED_FIELD_NAMES:
            raise ValueError(f"field name '{v}' is reserved by the SDK and cannot be used")
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

    enableRangeOptimization: bool = False
    enableExtendedWildcard: bool = False


# ---------------------------------------------------------------------------
# Maintenance response payloads.
# ---------------------------------------------------------------------------


class MaintenanceResponse(BaseModel):
    """Generic response for ``flush`` / ``optimize`` operations."""

    operation: str = Field(..., description="Operation performed (``flush``, ``optimize``).")
    timestamp: str = Field(..., description="ISO-8601 timestamp when the operation finished.")
