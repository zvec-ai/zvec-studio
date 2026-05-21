"""AI extension schemas (embeddings + rerankers).

Mirrors the Zvec SDK extension surface. Each registered "AI function" is a
named, persisted recipe over one of the SDK extension classes:

Embedding families:

- ``default_local_dense`` → :class:`zvec.DefaultLocalDenseEmbedding`
  (Sentence-Transformers ``all-MiniLM-L6-v2``, dense FP32, 384-d).
- ``default_local_sparse`` → :class:`zvec.DefaultLocalSparseEmbedding`
  (SPLADE-family local sparse encoder).
- ``bm25`` → :class:`zvec.BM25EmbeddingFunction` (DashText, fully local).
- ``qwen_dense`` → :class:`zvec.QwenDenseEmbedding` (DashScope API).
- ``qwen_sparse`` → :class:`zvec.QwenSparseEmbedding` (DashScope API).
- ``openai_dense`` → :class:`zvec.OpenAIDenseEmbedding` (OpenAI-compatible API).

Reranker families:

- ``default_local`` → :class:`zvec.DefaultLocalReRanker`
  (cross-encoder ``cross-encoder/ms-marco-MiniLM-L6-v2``).
- ``qwen`` → :class:`zvec.QwenReRanker` (DashScope ``gte-rerank-v2``).
- ``rrf`` → :class:`zvec.RrfReRanker` (Reciprocal Rank Fusion, deterministic).
- ``weighted`` → :class:`zvec.WeightedReRanker` (linear blend of vectors).

Persisted ``Config`` payloads carry only the *recipe* fields (model id,
credentials, device, model_source, …). Per-call fields (``query``, ``topn``,
``rerank_field``, ``weights``, ``corpus``, ``texts``) are passed at invocation
time via the ``:embed`` / ``:rerank`` endpoints and the search request.
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ``ai-fn-name``: identifier-like, optionally with hyphens.
_AI_FN_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


class EmbeddingType(str, Enum):
    """Embedding extension family."""

    DEFAULT_LOCAL_DENSE = "default_local_dense"
    DEFAULT_LOCAL_SPARSE = "default_local_sparse"
    BM25 = "bm25"
    QWEN_DENSE = "qwen_dense"
    QWEN_SPARSE = "qwen_sparse"
    OPENAI_DENSE = "openai_dense"


class RerankerType(str, Enum):
    """Reranker extension family."""

    DEFAULT_LOCAL = "default_local"
    QWEN = "qwen"
    RRF = "rrf"
    WEIGHTED = "weighted"


class ModelSource(str, Enum):
    """Where the local model weights are downloaded from."""

    HUGGINGFACE = "huggingface"
    MODELSCOPE = "modelscope"


class EncodingType(str, Enum):
    """Encoding mode for sparse / BM25 encoders."""

    QUERY = "query"
    DOCUMENT = "document"


class BM25Language(str, Enum):
    ZH = "zh"
    EN = "en"


class RerankerMetric(str, Enum):
    """Metric used by :class:`zvec.WeightedReRanker` to fuse multi-vector scores."""

    L2 = "L2"
    IP = "IP"
    COSINE = "COSINE"


# ---------------------------------------------------------------------------
# Per-family ``Config`` payloads (discriminated unions).
# ---------------------------------------------------------------------------


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- Embeddings ---


class DefaultLocalDenseConfig(_Base):
    type: Literal[EmbeddingType.DEFAULT_LOCAL_DENSE] = (
        EmbeddingType.DEFAULT_LOCAL_DENSE
    )
    dimension: Annotated[int, Field(ge=1, le=32_768)] = 384
    modelSource: ModelSource = ModelSource.HUGGINGFACE
    device: str | None = None
    normalizeEmbeddings: bool = True
    batchSize: Annotated[int, Field(ge=1, le=1024)] = 32


class DefaultLocalSparseConfig(_Base):
    type: Literal[EmbeddingType.DEFAULT_LOCAL_SPARSE] = (
        EmbeddingType.DEFAULT_LOCAL_SPARSE
    )
    modelSource: ModelSource = ModelSource.HUGGINGFACE
    device: str | None = None
    encodingType: EncodingType = EncodingType.QUERY


class BM25Config(_Base):
    type: Literal[EmbeddingType.BM25] = EmbeddingType.BM25
    encodingType: EncodingType = EncodingType.QUERY
    language: BM25Language = BM25Language.ZH
    b: Annotated[float, Field(ge=0.0, le=2.0)] = 0.75
    k1: Annotated[float, Field(ge=0.0, le=10.0)] = 1.2


class QwenDenseConfig(_Base):
    type: Literal[EmbeddingType.QWEN_DENSE] = EmbeddingType.QWEN_DENSE
    dimension: Annotated[int, Field(ge=1, le=32_768)]
    model: str = "text-embedding-v4"
    apiKey: str | None = Field(
        default=None,
        description="DashScope API key. Stored in plain text; the registry file is chmod 0600.",
    )


class QwenSparseConfig(_Base):
    type: Literal[EmbeddingType.QWEN_SPARSE] = EmbeddingType.QWEN_SPARSE
    dimension: Annotated[int, Field(ge=1, le=32_768)]
    model: str = "text-embedding-v4"
    apiKey: str | None = None


class OpenAIDenseConfig(_Base):
    type: Literal[EmbeddingType.OPENAI_DENSE] = EmbeddingType.OPENAI_DENSE
    model: str = "text-embedding-3-small"
    dimension: Annotated[int, Field(ge=1, le=32_768)] | None = None
    apiKey: str | None = None
    baseUrl: str | None = None


EmbeddingConfig = Annotated[
    DefaultLocalDenseConfig
    | DefaultLocalSparseConfig
    | BM25Config
    | QwenDenseConfig
    | QwenSparseConfig
    | OpenAIDenseConfig,
    Field(discriminator="type"),
]


# --- Rerankers ---


class DefaultLocalRerankerConfig(_Base):
    type: Literal[RerankerType.DEFAULT_LOCAL] = RerankerType.DEFAULT_LOCAL
    modelName: str = "cross-encoder/ms-marco-MiniLM-L6-v2"
    modelSource: ModelSource = ModelSource.HUGGINGFACE
    device: str | None = None
    batchSize: Annotated[int, Field(ge=1, le=1024)] = 32


class QwenRerankerConfig(_Base):
    type: Literal[RerankerType.QWEN] = RerankerType.QWEN
    model: str = "gte-rerank-v2"
    apiKey: str | None = None


class RrfRerankerConfig(_Base):
    type: Literal[RerankerType.RRF] = RerankerType.RRF
    rankConstant: Annotated[int, Field(ge=1, le=10_000)] = 60


class WeightedRerankerConfig(_Base):
    type: Literal[RerankerType.WEIGHTED] = RerankerType.WEIGHTED
    metric: RerankerMetric = RerankerMetric.L2
    # ``weights`` here is a *default* weight map keyed by vector field name;
    # a request can still override it per call.
    weights: dict[str, float] | None = None


RerankerConfig = Annotated[
    DefaultLocalRerankerConfig
    | QwenRerankerConfig
    | RrfRerankerConfig
    | WeightedRerankerConfig,
    Field(discriminator="type"),
]


# ---------------------------------------------------------------------------
# Persisted records.
# ---------------------------------------------------------------------------


def _validate_fn_name(v: str) -> str:
    if not _AI_FN_NAME_RE.match(v):
        raise ValueError(
            "ai function name must match ^[A-Za-z][A-Za-z0-9_-]{0,63}$"
        )
    return v


class EmbeddingFunctionRecord(_Base):
    """Persisted embedding function (one row in ``ai_functions.json``)."""

    name: str = Field(..., description="Unique embedding function name.")
    description: str | None = None
    config: EmbeddingConfig

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        return _validate_fn_name(v)


class RerankerFunctionRecord(_Base):
    """Persisted reranker function (one row in ``ai_functions.json``)."""

    name: str = Field(..., description="Unique reranker function name.")
    description: str | None = None
    config: RerankerConfig

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        return _validate_fn_name(v)


class AIFunctionRegistrySnapshot(_Base):
    """On-disk JSON layout (file: ``<data_dir>/ai_functions.json``)."""

    embeddings: list[EmbeddingFunctionRecord] = Field(default_factory=list)
    rerankers: list[RerankerFunctionRecord] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Request / response payloads.
# ---------------------------------------------------------------------------


class EmbeddingFunctionListResponse(_Base):
    items: list[EmbeddingFunctionRecord]


class RerankerFunctionListResponse(_Base):
    items: list[RerankerFunctionRecord]


class EmbedRequest(_Base):
    """Body for ``POST /ai/embeddings/{name}:embed``."""

    texts: Annotated[list[str], Field(min_length=1, max_length=256)]
    isQuery: bool = Field(
        default=False,
        description=(
            "Whether to encode as query (vs. document); only meaningful for"
            " sparse / BM25 encoders that distinguish the two."
        ),
    )


class EmbedResponseDense(_Base):
    kind: Literal["dense"] = "dense"
    dimension: int
    vectors: list[list[float]]


class EmbedResponseSparse(_Base):
    kind: Literal["sparse"] = "sparse"
    # Each row is a {token_id_or_term: weight} map.
    vectors: list[dict[str, float]]


EmbedResponse = Annotated[
    EmbedResponseDense | EmbedResponseSparse,
    Field(discriminator="kind"),
]


class RerankCandidate(_Base):
    """One candidate fed into a cross-encoder / API reranker."""

    id: str
    text: str
    score: float | None = Field(
        default=None,
        description="Original ANN/BM25 score; ignored by cross-encoder rerankers.",
    )


class RerankRequest(_Base):
    """Body for ``POST /ai/rerankers/{name}:rerank``."""

    query: str = Field(..., description="The user query string.")
    candidates: Annotated[list[RerankCandidate], Field(min_length=1, max_length=256)]
    topN: Annotated[int, Field(ge=1, le=1_000)] = 10


class RerankHit(_Base):
    id: str
    score: float
    text: str


class RerankResponse(_Base):
    results: list[RerankHit]


# Re-exported helper aliases for routers.
EmbeddingTypeStr = Literal[
    "default_local_dense",
    "default_local_sparse",
    "bm25",
    "qwen_dense",
    "qwen_sparse",
    "openai_dense",
]
RerankerTypeStr = Literal["default_local", "qwen", "rrf", "weighted"]


# ---------------------------------------------------------------------------
# Misc small helpers shared with the registry / service.
# ---------------------------------------------------------------------------


def is_dense_embedding(config: Any) -> bool:
    """Return True iff the embedding config produces dense vectors."""
    return isinstance(
        config, DefaultLocalDenseConfig | QwenDenseConfig | OpenAIDenseConfig
    )
