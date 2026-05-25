"""AI extension service: builds Zvec SDK extension instances on demand and
exposes a thin facade for ``:embed`` / ``:rerank`` HTTP endpoints.

The persistence side (``ai_functions.json``) lives in
:mod:`zvec_studio.ai_store`. This module is concerned with:

- Translating a persisted :class:`EmbeddingFunctionRecord` /
  :class:`RerankerFunctionRecord` into a live SDK object
  (:class:`zvec.DefaultLocalDenseEmbedding`, :class:`zvec.RrfReRanker`, …).
- Catching ``ImportError`` from missing packages (sentence-transformers,
  dashtext, dashscope, openai) and surfacing them as
  :class:`AIDependencyMissingError` (HTTP 503) instead of crashing.
- Catching SDK-level invocation errors and surfacing them as
  :class:`AIFunctionInvocationError` (HTTP 500).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.exceptions import (
    AIDependencyMissingError,
    AIFunctionInvocationError,
)
from zvec_studio.schemas import (
    BM25Config,
    DefaultLocalDenseConfig,
    DefaultLocalRerankerConfig,
    DefaultLocalSparseConfig,
    EmbeddingConfig,
    EmbedRequest,
    EmbedResponse,
    EmbedResponseDense,
    EmbedResponseSparse,
    OpenAIDenseConfig,
    QwenDenseConfig,
    QwenRerankerConfig,
    QwenSparseConfig,
    RerankCandidate,
    RerankerConfig,
    RerankerMetric,
    RrfRerankerConfig,
    WeightedRerankerConfig,
    is_dense_embedding,
)

if TYPE_CHECKING:  # pragma: no cover
    pass


# Mapping from config type → known required pip package.
_KNOWN_DEPS: dict[type, str] = {
    DefaultLocalDenseConfig: "sentence-transformers",
    DefaultLocalSparseConfig: "sentence-transformers",
    BM25Config: "dashtext",
    QwenDenseConfig: "dashscope",
    QwenSparseConfig: "dashscope",
    OpenAIDenseConfig: "openai",
    DefaultLocalRerankerConfig: "sentence-transformers",
    QwenRerankerConfig: "dashscope",
}


def _wrap_import_error(exc: ImportError, *, feature: str, cfg: Any = None) -> AIDependencyMissingError:
    # Try exc.name first; fall back to known mapping; last resort is "unknown".
    pkg = getattr(exc, "name", None)
    if not pkg and cfg is not None:
        pkg = _KNOWN_DEPS.get(type(cfg))
    if not pkg:
        pkg = "zvec-studio[ai]"
    msg = (
        f"AI feature '{feature}' requires package '{pkg}' which is not"
        f" installed. Run ``pip install {pkg}`` and restart the server."
    )
    return AIDependencyMissingError(
        msg,
        extra={"feature": feature, "missingPackage": pkg},
        sdk_exception=type(exc).__name__,
    )


class AIService:
    """Facade over :class:`AIFunctionRegistry` + Zvec extension classes."""

    def __init__(self, registry: AIFunctionRegistry) -> None:
        self._registry = registry

    # ------------------------------------------------------------- factories

    def _build_embedding(self, cfg: EmbeddingConfig) -> Any:
        """Instantiate the Zvec extension class for ``cfg``.

        Re-raises any ``ImportError`` from optional extras as a 503-mapped
        :class:`AIDependencyMissingError`.
        """
        try:
            if isinstance(cfg, DefaultLocalDenseConfig):
                from zvec import DefaultLocalDenseEmbedding  # type: ignore[attr-defined]

                return DefaultLocalDenseEmbedding(
                    model_source=cfg.modelSource.value,
                    device=cfg.device,
                    normalize_embeddings=cfg.normalizeEmbeddings,
                    batch_size=cfg.batchSize,
                )
            if isinstance(cfg, DefaultLocalSparseConfig):
                from zvec import DefaultLocalSparseEmbedding  # type: ignore[attr-defined]

                return DefaultLocalSparseEmbedding(
                    model_source=cfg.modelSource.value,
                    device=cfg.device,
                    encoding_type=cfg.encodingType.value,
                )
            if isinstance(cfg, BM25Config):
                from zvec import BM25EmbeddingFunction  # type: ignore[attr-defined]

                return BM25EmbeddingFunction(
                    encoding_type=cfg.encodingType.value,
                    language=cfg.language.value,
                    b=cfg.b,
                    k1=cfg.k1,
                )
            if isinstance(cfg, QwenDenseConfig):
                from zvec import QwenDenseEmbedding  # type: ignore[attr-defined]

                return QwenDenseEmbedding(
                    dimension=cfg.dimension,
                    model=cfg.model,
                    api_key=cfg.apiKey,
                )
            if isinstance(cfg, QwenSparseConfig):
                from zvec import QwenSparseEmbedding  # type: ignore[attr-defined]

                return QwenSparseEmbedding(
                    dimension=cfg.dimension,
                    model=cfg.model,
                    api_key=cfg.apiKey,
                )
            if isinstance(cfg, OpenAIDenseConfig):
                from zvec import OpenAIDenseEmbedding  # type: ignore[attr-defined]

                kwargs: dict[str, Any] = {
                    "model": cfg.model,
                    "api_key": cfg.apiKey,
                    "base_url": cfg.baseUrl,
                }
                if cfg.dimension is not None:
                    kwargs["dimension"] = cfg.dimension
                return OpenAIDenseEmbedding(**kwargs)
        except ImportError as exc:
            raise _wrap_import_error(exc, feature=cfg.type.value, cfg=cfg) from exc
        raise AIFunctionInvocationError(
            f"Unsupported embedding config type: {type(cfg).__name__}",
            extra={"type": getattr(cfg, "type", None)},
        )

    def _build_reranker(
        self,
        cfg: RerankerConfig,
        *,
        query: str | None = None,
        topn: int = 10,
        rerank_field: str | None = None,
        weights: dict[str, float] | None = None,
    ) -> Any:
        """Instantiate a Zvec ``ReRanker`` from ``cfg``.

        Per-call overrides (``query``, ``topn``, ``rerank_field``, ``weights``)
        win over the persisted defaults — this lets ``/searches`` reuse a
        named reranker but vary the query and weights every call.
        """
        try:
            if isinstance(cfg, DefaultLocalRerankerConfig):
                from zvec import DefaultLocalReRanker  # type: ignore[attr-defined]

                return DefaultLocalReRanker(
                    query=query,
                    topn=topn,
                    rerank_field=rerank_field,
                    model_name=cfg.modelName,
                    model_source=cfg.modelSource.value,
                    device=cfg.device,
                    batch_size=cfg.batchSize,
                )
            if isinstance(cfg, QwenRerankerConfig):
                from zvec import QwenReRanker  # type: ignore[attr-defined]

                return QwenReRanker(
                    query=query,
                    topn=topn,
                    rerank_field=rerank_field,
                    model=cfg.model,
                    api_key=cfg.apiKey,
                )
            if isinstance(cfg, RrfRerankerConfig):
                from zvec import RrfReRanker

                return RrfReRanker(
                    topn=topn,
                    rerank_field=rerank_field,
                    rank_constant=cfg.rankConstant,
                )
            if isinstance(cfg, WeightedRerankerConfig):
                from zvec import MetricType as SdkMetricType
                from zvec import WeightedReRanker

                # Per-call weights override persisted defaults.
                effective_weights = weights if weights is not None else cfg.weights
                metric = {
                    RerankerMetric.L2: SdkMetricType.L2,
                    RerankerMetric.IP: SdkMetricType.IP,
                    RerankerMetric.COSINE: SdkMetricType.COSINE,
                }[cfg.metric]
                return WeightedReRanker(
                    topn=topn,
                    rerank_field=rerank_field,
                    metric=metric,
                    weights=effective_weights,
                )
        except ImportError as exc:
            raise _wrap_import_error(exc, feature=cfg.type.value, cfg=cfg) from exc
        raise AIFunctionInvocationError(
            f"Unsupported reranker config type: {type(cfg).__name__}",
            extra={"type": getattr(cfg, "type", None)},
        )

    # ------------------------------------------------------ public methods

    def get_reranker_instance(
        self,
        name: str,
        *,
        query: str | None = None,
        topn: int = 10,
        rerank_field: str | None = None,
        weights: dict[str, float] | None = None,
    ) -> Any:
        """Build a live ``ReRanker`` for the named registry entry."""
        rec = self._registry.get_reranker(name)
        return self._build_reranker(
            rec.config,
            query=query,
            topn=topn,
            rerank_field=rerank_field,
            weights=weights,
        )

    def embed(self, name: str, body: EmbedRequest) -> EmbedResponse:
        """Run ``:embed`` against the named embedding function."""
        rec = self._registry.get_embedding(name)
        instance = self._build_embedding(rec.config)
        try:
            if body.isQuery:
                vectors = instance.encode_queries(body.texts)
            else:
                vectors = instance.encode_documents(body.texts)
        except ImportError as exc:
            raise _wrap_import_error(exc, feature=rec.config.type.value) from exc
        except Exception as exc:
            raise AIFunctionInvocationError(
                f"Embedding '{name}' failed: {exc}",
                extra={"name": name, "type": rec.config.type.value},
                sdk_exception=type(exc).__name__,
            ) from exc

        if is_dense_embedding(rec.config):
            rows = [_as_float_list(v) for v in vectors]
            dim = len(rows[0]) if rows else 0
            return EmbedResponseDense(dimension=dim, vectors=rows)
        rows_sparse = [_as_sparse_dict(v) for v in vectors]
        return EmbedResponseSparse(vectors=rows_sparse)

    def rerank(
        self,
        name: str,
        query: str,
        candidates: list[RerankCandidate],
        top_n: int,
    ) -> list[tuple[str, float, str]]:
        """Run ``:rerank`` and return [(id, score, text), ...] sorted desc.

        Note: cross-encoder rerankers (Default/Qwen) consume ``(query, text)``
        pairs; fusion rerankers (RRF / Weighted) consume per-vector ranked
        lists and are therefore *not* exposed via this single-list endpoint —
        they only make sense inside :class:`Collection.query`. We surface a
        clear 400 to nudge the caller to use ``/searches`` instead.
        """
        rec = self._registry.get_reranker(name)
        if isinstance(rec.config, RrfRerankerConfig | WeightedRerankerConfig):
            raise AIFunctionInvocationError(
                "Fusion rerankers (rrf / weighted) operate on multi-vector"
                " ranked lists and must be invoked via the search endpoint"
                " (set ``rerankerName`` on POST /collections/{name}/searches).",
                status_code=400,
                extra={"name": name, "type": rec.config.type.value},
            )
        instance = self._build_reranker(
            rec.config,
            query=query,
            topn=top_n,
        )
        try:
            # Cross-encoder rerankers expose a list-rerank helper.
            scored = instance.compute_score(
                [(query, c.text) for c in candidates]
            )
        except AttributeError:
            # Fallback path for variants exposing ``__call__``.
            try:
                scored = [instance(query, c.text) for c in candidates]
            except Exception as exc:
                raise AIFunctionInvocationError(
                    f"Reranker '{name}' failed: {exc}",
                    extra={"name": name},
                    sdk_exception=type(exc).__name__,
                ) from exc
        except ImportError as exc:
            raise _wrap_import_error(exc, feature=rec.config.type.value) from exc
        except Exception as exc:
            raise AIFunctionInvocationError(
                f"Reranker '{name}' failed: {exc}",
                extra={"name": name},
                sdk_exception=type(exc).__name__,
            ) from exc

        scores = [float(s) for s in scored]
        ranked = sorted(
            zip(candidates, scores, strict=False), key=lambda kv: kv[1], reverse=True
        )[: top_n]
        return [(c.id, score, c.text) for c, score in ranked]


# ---------------------------------------------------------------------------
# Coerce SDK return types to JSON-serialisable forms.
# ---------------------------------------------------------------------------


def _as_float_list(vec: Any) -> list[float]:
    if hasattr(vec, "tolist"):
        return [float(x) for x in vec.tolist()]
    return [float(x) for x in vec]


def _as_sparse_dict(vec: Any) -> dict[str, float]:
    """Best-effort coercion of an SDK sparse vector to ``{key: weight}``.

    Handles three common shapes:

    1. ``dict[Any, Any]`` — keys cast to ``str``, values to ``float``.
    2. ``scipy.sparse`` row — iterate the non-zero indices.
    3. Iterable of ``(key, weight)`` pairs.
    """
    if isinstance(vec, dict):
        return {str(k): float(v) for k, v in vec.items()}
    # scipy.sparse row
    if hasattr(vec, "tocoo"):
        coo = vec.tocoo()
        return {str(int(c)): float(v) for c, v in zip(coo.col, coo.data, strict=False)}
    # iterable of pairs
    out: dict[str, float] = {}
    for item in vec:
        try:
            k, v = item
        except (TypeError, ValueError):
            continue
        out[str(k)] = float(v)
    return out
