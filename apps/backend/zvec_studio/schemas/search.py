"""Vector search request / response schemas.

Aligned with the Zvec Python SDK 0.4.x ``Collection.query`` surface:

- ``query`` accepts a list of ``VectorQuery`` (multi-vector ANN) and an
  optional ``ReRanker`` (multi-vector fusion or cross-encoder rescoring).
- Each ``VectorQuery`` may target a different vector field, may be specified
  by either an explicit ``vector`` payload or an existing document ``id``,
  and may carry its own per-query index parameters
  (``HnswQueryParam`` / ``IVFQueryParam`` / ``HnswRabitqQueryParam`` /
  ``VamanaQueryParam``).

The legacy single-vector form (``vector`` + ``vectorField`` at the top level)
is still accepted and is folded into a one-element ``queries`` list by a
``model_validator``.
"""

from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class QueryParamKind(str, Enum):
    """Per-query index parameter family.

    Mirrors the four ``*QueryParam`` classes exposed by the Zvec SDK. ``FLAT``
    indexes do not take a query-time parameter and therefore have no entry.
    """

    HNSW = "HNSW"
    IVF = "IVF"
    HNSW_RABITQ = "HNSW_RABITQ"
    VAMANA = "VAMANA"


class HnswQueryParamSpec(BaseModel):
    """Maps to ``zvec.HnswQueryParam(ef, radius, is_linear, is_using_refiner)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.HNSW] = QueryParamKind.HNSW
    ef: Annotated[int, Field(ge=1, le=10_000)] = 300
    radius: Annotated[float, Field(ge=0.0)] = 0.0
    isLinear: bool = False
    isUsingRefiner: bool = False


class IvfQueryParamSpec(BaseModel):
    """Maps to ``zvec.IVFQueryParam(nprobe)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.IVF] = QueryParamKind.IVF
    nprobe: Annotated[int, Field(ge=1, le=10_000)] = 10


class HnswRabitqQueryParamSpec(BaseModel):
    """Maps to ``zvec.HnswRabitqQueryParam(ef, radius, is_linear, is_using_refiner)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.HNSW_RABITQ] = QueryParamKind.HNSW_RABITQ
    ef: Annotated[int, Field(ge=1, le=10_000)] = 300
    radius: Annotated[float, Field(ge=0.0)] = 0.0
    isLinear: bool = False
    isUsingRefiner: bool = False


class VamanaQueryParamSpec(BaseModel):
    """Maps to ``zvec.VamanaQueryParam(ef_search, radius, is_linear, is_using_refiner)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.VAMANA] = QueryParamKind.VAMANA
    efSearch: Annotated[int, Field(ge=1, le=10_000)] = 200
    radius: Annotated[float, Field(ge=0.0)] = 0.0
    isLinear: bool = False
    isUsingRefiner: bool = False


QueryParamSpec = Annotated[
    HnswQueryParamSpec
    | IvfQueryParamSpec
    | HnswRabitqQueryParamSpec
    | VamanaQueryParamSpec,
    Field(discriminator="type"),
]


class VectorQuerySpec(BaseModel):
    """One ANN query targeting a single vector field.

    Exactly one of ``id`` or ``vector`` must be supplied:

    - ``id`` performs a "by-id" lookup — the SDK loads the stored vector for
      that document and uses it as the query vector.
    - ``vector`` supplies an explicit query vector.
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(..., description="Target vector field name.")
    id: str | None = Field(
        default=None,
        description="Existing document id; the stored vector is used as query.",
    )
    vector: Annotated[list[float], Field(min_length=1, max_length=32_768)] | None = (
        Field(default=None, description="Explicit query vector.")
    )
    param: QueryParamSpec | None = Field(
        default=None,
        description="Optional per-query index parameter (HNSW/IVF/HNSW_RABITQ/VAMANA).",
    )

    @model_validator(mode="after")
    def _validate_one_of(self) -> VectorQuerySpec:
        if (self.id is None) == (self.vector is None):
            raise ValueError(
                "VectorQuerySpec: exactly one of 'id' or 'vector' must be provided"
            )
        return self


class SearchRequest(BaseModel):
    """Body for ``POST /collections/{name}/searches``.

    The canonical form sets ``queries`` (1..8 ``VectorQuerySpec``). The legacy
    single-vector form (top-level ``vector`` + ``vectorField``) is still
    accepted for backward compatibility and is folded into ``queries[0]``.
    """

    model_config = ConfigDict(extra="forbid")

    # Canonical multi-vector form.
    queries: (
        Annotated[list[VectorQuerySpec], Field(min_length=1, max_length=8)] | None
    ) = None

    # Legacy single-vector form (still accepted; folded into ``queries[0]``).
    vector: Annotated[list[float], Field(min_length=1, max_length=32_768)] | None = (
        None
    )
    vectorField: str | None = None

    # Common params.
    topK: Annotated[int, Field(ge=1, le=1_000)] = 10
    filter: str | None = None
    outputFields: list[str] | None = None
    includeVector: bool = False
    rerankerName: str | None = Field(
        default=None,
        description=(
            "Name of a registered reranker (see ``GET /ai/rerankers``). "
            "When set, the SDK applies the reranker after ANN."
        ),
    )

    @model_validator(mode="after")
    def _normalize(self) -> SearchRequest:
        if self.queries is not None:
            if self.vector is not None or self.vectorField is not None:
                raise ValueError(
                    "'queries' and legacy 'vector'/'vectorField' are mutually exclusive"
                )
            return self
        # Legacy form: ``vector`` is required; ``vectorField`` is optional and
        # falls back to the first vector field on the collection. The legacy
        # form is folded into ``queries[0]`` lazily by the backend so that
        # callers that pass only ``vector`` keep working unchanged.
        if self.vector is None:
            raise ValueError(
                "either 'queries' or 'vector' (with optional 'vectorField') must be provided"
            )
        return self


class SearchResult(BaseModel):
    id: str
    score: float
    fields: dict[str, Any]


class SearchResponse(BaseModel):
    results: list[SearchResult]
    took_ms: float
    traceId: str | None = None
