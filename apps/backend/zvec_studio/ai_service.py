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

import importlib
import os
import tempfile
import time
import urllib.request
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, Any

# Default the HuggingFace download endpoint to the community mirror unless the
# user has explicitly set ``HF_ENDPOINT``. The official ``huggingface.co`` host
# is unreachable from many networks (notably mainland China), and without this
# fallback ``DefaultLocalDense`` / ``DefaultLocalSparse`` block on a long retry
# storm before failing. Set ``HF_ENDPOINT=https://huggingface.co`` to opt out.
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

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

_EMBEDDING_CACHE_MAX_SIZE = 16
_EMBEDDING_FAILURE_CACHE_TTL_SECONDS = 60.0
_BM25_DEFAULT_LOAD_TIMEOUT_SECONDS = float(
    os.environ.get("ZVEC_STUDIO_BM25_LOAD_TIMEOUT_SECONDS", "5")
)
_BM25_DEFAULT_MODEL_URLS = {
    "zh": "http://dashvector-data.oss-cn-beijing.aliyuncs.com/public/sparsevector/bm25_zh_default.json",
    "en": "http://dashvector-data.oss-cn-beijing.aliyuncs.com/public/sparsevector/bm25_en_default.json",
}
EmbeddingCacheKey = tuple[str, str, str]
EmbeddingFailureCacheValue = tuple[float, Exception]
Bm25EncoderCacheKey = tuple[str, float, float]
Bm25EncoderCacheValue = tuple[Any, Any]


@contextmanager
def _short_urlopen_timeout(seconds: float) -> Iterator[None]:
    """Temporarily cap urllib URL open timeout while dashtext loads BM25 data."""
    if seconds <= 0:
        yield
        return

    original: Any = urllib.request.urlopen

    def _urlopen_with_short_timeout(
        url: Any,
        data: Any = None,
        timeout: Any = None,
        **kwargs: Any,
    ) -> Any:
        effective_timeout = (
            min(float(timeout), seconds)
            if isinstance(timeout, int | float)
            else seconds
        )
        return original(url, data, effective_timeout, **kwargs)

    urllib.request.urlopen = _urlopen_with_short_timeout
    try:
        yield
    finally:
        urllib.request.urlopen = original


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

    def __init__(
        self, registry: AIFunctionRegistry, *, cache_dir: Path | None = None
    ) -> None:
        self._registry = registry
        self._cache_dir = cache_dir
        self._embedding_cache: OrderedDict[EmbeddingCacheKey, Any] = OrderedDict()
        self._embedding_failure_cache: OrderedDict[
            EmbeddingCacheKey, EmbeddingFailureCacheValue
        ] = OrderedDict()
        self._bm25_encoder_cache: OrderedDict[
            Bm25EncoderCacheKey, Bm25EncoderCacheValue
        ] = OrderedDict()
        self._embedding_cache_lock = RLock()

    # ------------------------------------------------------------- factories

    def _embedding_cache_mode(
        self, cfg: EmbeddingConfig, *, is_query: bool | None = None
    ) -> str:
        if isinstance(cfg, DefaultLocalSparseConfig | BM25Config):
            if is_query is None:
                return cfg.encodingType.value
            return "query" if is_query else "document"
        return "default"

    def _embedding_cache_key(
        self, name: str, cfg: EmbeddingConfig, *, is_query: bool | None = None
    ) -> EmbeddingCacheKey:
        return (
            name,
            cfg.model_dump_json(),
            self._embedding_cache_mode(cfg, is_query=is_query),
        )

    def _get_embedding_instance(
        self, name: str, cfg: EmbeddingConfig, *, is_query: bool | None = None
    ) -> Any:
        key = self._embedding_cache_key(name, cfg, is_query=is_query)
        with self._embedding_cache_lock:
            cached = self._embedding_cache.get(key)
            if cached is not None:
                self._embedding_cache.move_to_end(key)
                return cached

            failed = self._embedding_failure_cache.get(key)
            if failed is not None:
                failed_at, exc = failed
                if time.monotonic() - failed_at < _EMBEDDING_FAILURE_CACHE_TTL_SECONDS:
                    self._embedding_failure_cache.move_to_end(key)
                    raise exc
                self._embedding_failure_cache.pop(key, None)

            try:
                instance = self._build_embedding(cfg, is_query=is_query)
            except Exception as exc:
                self._embedding_failure_cache[key] = (time.monotonic(), exc)
                if len(self._embedding_failure_cache) > _EMBEDDING_CACHE_MAX_SIZE:
                    self._embedding_failure_cache.popitem(last=False)
                raise
            self._embedding_cache[key] = instance
            self._embedding_failure_cache.pop(key, None)
            if len(self._embedding_cache) > _EMBEDDING_CACHE_MAX_SIZE:
                self._embedding_cache.popitem(last=False)
            return instance

    def _build_bm25_embedding(
        self, cfg: BM25Config, *, encoding_type: str
    ) -> Any:
        from zvec import BM25EmbeddingFunction  # type: ignore[attr-defined]

        key: Bm25EncoderCacheKey = (cfg.language.value, cfg.b, cfg.k1)
        cached = self._bm25_encoder_cache.get(key)
        if cached is not None:
            self._bm25_encoder_cache.move_to_end(key)
            dashtext_module, encoder = cached
            return self._clone_bm25_embedding(
                BM25EmbeddingFunction,
                cfg,
                encoding_type=encoding_type,
                dashtext_module=dashtext_module,
                encoder=encoder,
            )

        if self._cache_dir is not None:
            dashtext = importlib.import_module("dashtext")

            encoder = self._load_cached_bm25_encoder(dashtext, cfg)
            self._bm25_encoder_cache[key] = (dashtext, encoder)
            if len(self._bm25_encoder_cache) > _EMBEDDING_CACHE_MAX_SIZE:
                self._bm25_encoder_cache.popitem(last=False)
            return self._clone_bm25_embedding(
                BM25EmbeddingFunction,
                cfg,
                encoding_type=encoding_type,
                dashtext_module=dashtext,
                encoder=encoder,
            )

        with _short_urlopen_timeout(_BM25_DEFAULT_LOAD_TIMEOUT_SECONDS):
            instance = BM25EmbeddingFunction(
                encoding_type=encoding_type,
                language=cfg.language.value,
                b=cfg.b,
                k1=cfg.k1,
            )
        dashtext_module = getattr(instance, "_dashtext", None)
        encoder = getattr(instance, "_encoder", None)
        if dashtext_module is not None and encoder is not None:
            self._bm25_encoder_cache[key] = (dashtext_module, encoder)
            if len(self._bm25_encoder_cache) > _EMBEDDING_CACHE_MAX_SIZE:
                self._bm25_encoder_cache.popitem(last=False)
        return instance

    def _load_cached_bm25_encoder(self, dashtext_module: Any, cfg: BM25Config) -> Any:
        model_path = self._bm25_model_cache_path(cfg.language.value)
        if not model_path.exists() or model_path.stat().st_size <= 0:
            self._download_bm25_model(cfg.language.value, model_path)

        try:
            return self._load_bm25_encoder_file(dashtext_module, model_path)
        except Exception:
            with suppress(FileNotFoundError):
                model_path.unlink()
            self._download_bm25_model(cfg.language.value, model_path)
            return self._load_bm25_encoder_file(dashtext_module, model_path)

    def _bm25_model_cache_path(self, language: str) -> Path:
        if self._cache_dir is None:  # pragma: no cover - guarded by caller
            raise RuntimeError("BM25 cache directory is not configured.")
        return self._cache_dir / "bm25" / f"bm25_{language}_default.json"

    def _download_bm25_model(self, language: str, target: Path) -> None:
        url = _BM25_DEFAULT_MODEL_URLS[language]
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
        )
        try:
            with os.fdopen(fd, "wb") as out, urllib.request.urlopen(
                url, timeout=_BM25_DEFAULT_LOAD_TIMEOUT_SECONDS
            ) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            os.replace(tmp, target)
        except Exception:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    def _load_bm25_encoder_file(self, dashtext_module: Any, path: Path) -> Any:
        encoder = dashtext_module.SparseVectorEncoder()
        encoder.load(str(path))
        return encoder

    def _clone_bm25_embedding(
        self,
        bm25_cls: type[Any],
        cfg: BM25Config,
        *,
        encoding_type: str,
        dashtext_module: Any,
        encoder: Any,
    ) -> Any:
        instance = object.__new__(bm25_cls)
        instance._dashtext = dashtext_module
        instance._corpus = None
        instance._encoding_type = encoding_type
        instance._language = cfg.language.value
        instance._b = cfg.b
        instance._k1 = cfg.k1
        instance._extra_params = {}
        instance._encoder = encoder
        return instance

    def _build_embedding(
        self, cfg: EmbeddingConfig, *, is_query: bool | None = None
    ) -> Any:
        """Instantiate the Zvec extension class for ``cfg``.

        Re-raises any ``ImportError`` from optional extras as a 503-mapped
        :class:`AIDependencyMissingError`.

        ``is_query`` lets the caller flip the construction-time
        ``encoding_type`` of sparse encoders (``DefaultLocalSparse`` /
        ``BM25``) between ``"query"`` and ``"document"``. The Zvec 0.4 SDK
        binds ``encoding_type`` at instantiation (it's a read-only property
        with a single ``embed(input: str)`` method), so callers cache separate
        query/document instances. Dense encoders do not distinguish q/d and
        ignore this argument.
        """

        def _encoding_type_for(default: str) -> str:
            if is_query is None:
                return default
            return "query" if is_query else "document"

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
                    encoding_type=_encoding_type_for(cfg.encodingType.value),
                )
            if isinstance(cfg, BM25Config):
                return self._build_bm25_embedding(
                    cfg, encoding_type=_encoding_type_for(cfg.encodingType.value)
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
        """Run ``:embed`` against the named embedding function.

        Zvec 0.4's ``EmbeddingFunction.embed`` accepts a single ``str`` only
        (passing a list raises ``TypeError: unhashable type: 'list'``), so we
        iterate the input batch ourselves. The ``encoding_type`` (query vs.
        document) is bound at construction; we propagate ``body.isQuery`` to
        :meth:`_build_embedding` so the right value is baked in.
        """
        rec = self._registry.get_embedding(name)
        try:
            instance = self._get_embedding_instance(
                name, rec.config, is_query=body.isQuery
            )
        except (AIDependencyMissingError, AIFunctionInvocationError):
            raise
        except Exception as exc:
            raise AIFunctionInvocationError(
                f"Embedding '{name}' failed to initialize: {exc}",
                extra={"name": name, "type": rec.config.type.value},
                sdk_exception=type(exc).__name__,
            ) from exc
        try:
            vectors = [instance.embed(text) for text in body.texts]
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
