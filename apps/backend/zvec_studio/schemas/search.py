"""Search request / response schemas.

Aligned with the Zvec Python SDK 0.6.x ``Collection.query`` surface:

- ``query`` accepts one or more ``Query`` routes. Each route targets either a
  vector field (explicit vector or existing document ``id``) or an FTS-indexed
  ``STRING`` field.
- Multiple routes are executed as a SDK ``MultiQuery`` and require a reranker
  for result fusion.
- Vector routes may carry per-index query parameters
  (``HnswQueryParam`` / ``IVFQueryParam`` / ``HnswRabitqQueryParam`` /
  ``VamanaQueryParam`` / ``DiskAnnQueryParam``); FTS routes may carry
  ``FtsQueryParam``.

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
    DISKANN = "DISKANN"
    FTS = "FTS"


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


class DiskAnnQueryParamSpec(BaseModel):
    """Maps to ``zvec.DiskAnnQueryParam(list_size)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.DISKANN] = QueryParamKind.DISKANN
    listSize: Annotated[int, Field(ge=1, le=10_000)] = 300


class FtsQueryParamSpec(BaseModel):
    """Maps to ``zvec.FtsQueryParam(default_operator)``."""

    model_config = ConfigDict(extra="forbid")

    type: Literal[QueryParamKind.FTS] = QueryParamKind.FTS
    defaultOperator: Literal["OR", "AND"] | None = None


QueryParamSpec = Annotated[
    HnswQueryParamSpec
    | IvfQueryParamSpec
    | HnswRabitqQueryParamSpec
    | VamanaQueryParamSpec
    | DiskAnnQueryParamSpec
    | FtsQueryParamSpec,
    Field(discriminator="type"),
]

SparseVector = Annotated[dict[str, float], Field(min_length=1)]
DenseVector = Annotated[list[float], Field(min_length=1, max_length=32_768)]
VectorPayload = DenseVector | SparseVector


class FtsSpec(BaseModel):
    """Full-text query source for one FTS route.

    ``matchString`` is natural-language input. ``queryString`` is the advanced
    boolean/phrase expression syntax exposed by Zvec. Exactly one must be set.
    """

    model_config = ConfigDict(extra="forbid")

    matchString: str | None = None
    queryString: str | None = None

    @model_validator(mode="after")
    def _validate_one_text_source(self) -> FtsSpec:
        has_match = bool(self.matchString and self.matchString.strip())
        has_query = bool(self.queryString and self.queryString.strip())
        if has_match == has_query:
            raise ValueError("FtsSpec: exactly one of 'matchString' or 'queryString' must be provided")
        return self


class VectorQuerySpec(BaseModel):
    """One SDK ``Query`` route.

    Exactly one of ``id``, ``vector`` or ``fts`` must be supplied:

    - ``id`` performs a "by-id" lookup — the SDK loads the stored vector for
      that document and uses it as the query vector.
    - ``vector`` supplies an explicit query vector.
    - ``fts`` performs full-text search against an FTS-indexed string field.
    """

    model_config = ConfigDict(extra="forbid")

    field: str = Field(..., description="Target vector field name.")
    id: str | None = Field(
        default=None,
        description="Existing document id; the stored vector is used as query.",
    )
    vector: VectorPayload | None = (
        Field(default=None, description="Explicit query vector.")
    )
    fts: FtsSpec | None = Field(default=None, description="Full-text query source.")
    param: QueryParamSpec | None = Field(
        default=None,
        description=(
            "Optional per-query parameter "
            "(HNSW/IVF/HNSW_RABITQ/VAMANA/DISKANN/FTS)."
        ),
    )

    @model_validator(mode="after")
    def _validate_one_of(self) -> VectorQuerySpec:
        sources = [
            self.id is not None,
            self.vector is not None,
            self.fts is not None,
        ]
        if sum(sources) != 1:
            raise ValueError(
                "VectorQuerySpec: exactly one of 'id', 'vector' or 'fts' must be provided"
            )
        if self.fts is not None and self.param is not None and not isinstance(self.param, FtsQueryParamSpec):
            raise ValueError("FTS queries may only use FTS query params")
        if self.fts is None and isinstance(self.param, FtsQueryParamSpec):
            raise ValueError("FTS query params require an FTS query")
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
    vector: VectorPayload | None = None
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
    groupByField: str | None = Field(
        default=None,
        description="Scalar field used to group a single vector query.",
    )
    groupCount: Annotated[int, Field(ge=1, le=1_000)] = 2
    topKPerGroup: Annotated[int, Field(ge=1, le=1_000)] = 3

    @model_validator(mode="after")
    def _normalize(self) -> SearchRequest:
        if self.queries is not None:
            if self.vector is not None or self.vectorField is not None:
                raise ValueError(
                    "'queries' and legacy 'vector'/'vectorField' are mutually exclusive"
                )
        elif self.vector is None:
            # Legacy form: ``vector`` is required; ``vectorField`` is optional
            # and falls back to the first vector field on the collection.
            raise ValueError(
                "either 'queries' or 'vector' (with optional 'vectorField') must be provided"
            )

        if self.groupByField is not None:
            if self.rerankerName is not None:
                raise ValueError("group-by search cannot use a reranker")
            if self.queries is not None:
                if len(self.queries) != 1 or self.queries[0].fts is not None:
                    raise ValueError("group-by search requires exactly one vector query")
                param = self.queries[0].param
                if (
                    isinstance(param, HnswQueryParamSpec | HnswRabitqQueryParamSpec)
                    and param.isUsingRefiner
                ):
                    raise ValueError("group-by search cannot use refiner search")
        return self


class SearchResult(BaseModel):
    id: str
    score: float
    fields: dict[str, Any]
    groupByValue: str | None = None


class SearchResponse(BaseModel):
    results: list[SearchResult]
    took_ms: float
    traceId: str | None = None
