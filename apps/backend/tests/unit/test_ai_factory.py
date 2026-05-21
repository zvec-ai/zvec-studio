"""Unit tests for ``zvec_studio.ai_service.AIService`` factories.

We deliberately do NOT exercise the real Sentence-Transformers / DashScope /
OpenAI calls here — the suite must stay fast and offline. Instead we verify:

- the discriminated-union dispatch picks the right SDK class;
- ``ImportError`` from missing optional extras is mapped to
  :class:`AIDependencyMissingError` (HTTP 503);
- fusion rerankers (rrf / weighted) reject the single-list ``:rerank`` verb
  with a 400 because they only make sense inside ``Collection.query``.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zvec_studio.ai_service import AIService
from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.exceptions import (
    AIDependencyMissingError,
    AIFunctionInvocationError,
)
from zvec_studio.schemas import (
    EmbeddingFunctionRecord,
    EmbedRequest,
    RerankCandidate,
    RerankerFunctionRecord,
)


def _svc(tmp_path: Path) -> tuple[AIFunctionRegistry, AIService]:
    reg = AIFunctionRegistry(tmp_path)
    return reg, AIService(reg)


class TestRerankerFactory:
    def test_rrf_builds_without_optional_extras(self, tmp_path: Path) -> None:
        reg, svc = _svc(tmp_path)
        reg.create_reranker(
            RerankerFunctionRecord.model_validate(
                {"name": "rrf", "config": {"type": "rrf", "rankConstant": 60}}
            )
        )
        inst = svc.get_reranker_instance("rrf", topn=5)
        assert type(inst).__name__ == "RrfReRanker"

    def test_weighted_builds_with_metric_and_weights(self, tmp_path: Path) -> None:
        reg, svc = _svc(tmp_path)
        reg.create_reranker(
            RerankerFunctionRecord.model_validate(
                {
                    "name": "w",
                    "config": {
                        "type": "weighted",
                        "metric": "COSINE",
                        "weights": {"a": 0.7, "b": 0.3},
                    },
                }
            )
        )
        inst = svc.get_reranker_instance("w", topn=10, weights={"a": 1.0, "b": 0.0})
        assert type(inst).__name__ == "WeightedReRanker"


class TestLazyImportFallback:
    """Embedding/reranker classes that need optional extras must surface 503.

    Rather than rely on the dev machine actually missing
    ``sentence_transformers`` (fragile and slow when it *is* installed because
    the SDK eagerly downloads model files), we use ``monkeypatch`` to swap the
    SDK class with a stub that raises :class:`ImportError`. This deterministically
    exercises the ``_wrap_import_error`` -> 503 path on every machine.
    """

    def test_default_local_dense_embed_maps_import_error_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'sentence_transformers'", name="sentence_transformers")

        monkeypatch.setattr(zvec, "DefaultLocalDenseEmbedding", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local_dense"}}
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("local", EmbedRequest(texts=["hi"]))
        assert exc.value.status_code == 503
        assert exc.value.code == "AI_DEPENDENCY_MISSING"
        assert exc.value.extra["missingPackage"] == "sentence_transformers"

    def test_default_local_reranker_get_instance_maps_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'sentence_transformers'", name="sentence_transformers")

        monkeypatch.setattr(zvec, "DefaultLocalReRanker", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_reranker(
            RerankerFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local"}}
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.get_reranker_instance("local", topn=5, query="q")
        assert exc.value.status_code == 503
        assert exc.value.extra["feature"] == "default_local"

    def test_bm25_embed_maps_import_error_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'dashtext'", name="dashtext")

        monkeypatch.setattr(zvec, "BM25EmbeddingFunction", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "bm25", "config": {"type": "bm25"}}
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("bm25", EmbedRequest(texts=["hi"]))
        assert exc.value.status_code == 503
        assert exc.value.extra["missingPackage"] == "dashtext"


class TestRerankVerbRejection:
    def test_rrf_rejects_single_list_rerank(self, tmp_path: Path) -> None:
        reg, svc = _svc(tmp_path)
        reg.create_reranker(
            RerankerFunctionRecord.model_validate(
                {"name": "rrf", "config": {"type": "rrf", "rankConstant": 60}}
            )
        )
        with pytest.raises(AIFunctionInvocationError) as exc:
            svc.rerank("rrf", "q", [RerankCandidate(id="1", text="a")], 10)
        assert exc.value.status_code == 400

    def test_weighted_rejects_single_list_rerank(self, tmp_path: Path) -> None:
        reg, svc = _svc(tmp_path)
        reg.create_reranker(
            RerankerFunctionRecord.model_validate(
                {"name": "w", "config": {"type": "weighted", "metric": "L2"}}
            )
        )
        with pytest.raises(AIFunctionInvocationError) as exc:
            svc.rerank("w", "q", [RerankCandidate(id="1", text="a")], 10)
        assert exc.value.status_code == 400
