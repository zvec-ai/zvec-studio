"""Unit tests for ``ai_service`` coercion helpers and additional factory branches.

Covers:
- ``_as_float_list`` with numpy arrays and plain lists
- ``_as_sparse_dict`` with dict, scipy-like, and iterable-of-pairs inputs
- ``_wrap_import_error`` produces correct message format
- Qwen dense/sparse embed factory via monkeypatch
- OpenAI dense embed factory via monkeypatch
- AIService.embed invocation error wrapping
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from zvec_studio.ai_service import AIService, _as_float_list, _as_sparse_dict, _wrap_import_error
from zvec_studio.ai_store import AIFunctionRegistry
from zvec_studio.exceptions import (
    AIDependencyMissingError,
    AIFunctionInvocationError,
)
from zvec_studio.schemas import (
    EmbeddingFunctionRecord,
    EmbedRequest,
)


def _svc(tmp_path: Path) -> tuple[AIFunctionRegistry, AIService]:
    reg = AIFunctionRegistry(tmp_path)
    return reg, AIService(reg)


class TestAsFloatList:
    def test_plain_list(self) -> None:
        result = _as_float_list([1, 2, 3])
        assert result == [1.0, 2.0, 3.0]
        assert all(isinstance(x, float) for x in result)

    def test_numpy_array(self) -> None:
        arr = np.array([0.1, 0.2, 0.3], dtype=np.float32)
        result = _as_float_list(arr)
        assert len(result) == 3
        assert all(isinstance(x, float) for x in result)
        assert abs(result[0] - 0.1) < 1e-5

    def test_numpy_int_array(self) -> None:
        arr = np.array([1, 2, 3], dtype=np.int32)
        result = _as_float_list(arr)
        assert result == [1.0, 2.0, 3.0]

    def test_empty(self) -> None:
        assert _as_float_list([]) == []
        assert _as_float_list(np.array([])) == []


class TestAsSparseDict:
    def test_dict_input(self) -> None:
        result = _as_sparse_dict({0: 1.5, 42: 2.3})
        assert result == {"0": 1.5, "42": 2.3}

    def test_scipy_like_coo(self) -> None:
        class FakeCoo:
            col = np.array([5, 10])
            data = np.array([0.7, 0.3])

        class FakeSparse:
            def tocoo(self):
                return FakeCoo()

        result = _as_sparse_dict(FakeSparse())
        assert result == {"5": 0.7, "10": 0.3}

    def test_iterable_of_pairs(self) -> None:
        result = _as_sparse_dict([(1, 0.5), (2, 0.8)])
        assert result == {"1": 0.5, "2": 0.8}

    def test_iterable_with_invalid_items_skipped(self) -> None:
        result = _as_sparse_dict([(1, 0.5), "bad", (2, 0.8)])
        assert result == {"1": 0.5, "2": 0.8}

    def test_empty_dict(self) -> None:
        assert _as_sparse_dict({}) == {}


class TestWrapImportError:
    def test_formats_message_with_package_name(self) -> None:
        exc = ImportError("No module named 'dashscope'", name="dashscope")
        wrapped = _wrap_import_error(exc, feature="qwen_dense")
        assert isinstance(wrapped, AIDependencyMissingError)
        assert wrapped.status_code == 503
        assert wrapped.extra["missingPackage"] == "dashscope"
        assert wrapped.extra["feature"] == "qwen_dense"
        assert "dashscope" in str(wrapped)

    def test_handles_missing_name_attribute(self) -> None:
        exc = ImportError("something failed")
        exc.name = None  # type: ignore[assignment]
        wrapped = _wrap_import_error(exc, feature="test")
        assert wrapped.extra["missingPackage"] == "unknown"


class TestQwenDenseFactory:
    def test_qwen_dense_maps_import_error_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'dashscope'", name="dashscope")

        monkeypatch.setattr(zvec, "QwenDenseEmbedding", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {
                    "name": "qwen",
                    "config": {
                        "type": "qwen_dense",
                        "dimension": 1024,
                        "model": "text-embedding-v4",
                        "apiKey": "sk-test",
                    },
                }
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("qwen", EmbedRequest(texts=["test"]))
        assert exc.value.extra["missingPackage"] == "dashscope"


class TestQwenSparseFactory:
    def test_qwen_sparse_maps_import_error_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'dashscope'", name="dashscope")

        monkeypatch.setattr(zvec, "QwenSparseEmbedding", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {
                    "name": "qsparse",
                    "config": {
                        "type": "qwen_sparse",
                        "dimension": 1024,
                        "model": "text-embedding-v4",
                        "apiKey": "sk-test",
                    },
                }
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("qsparse", EmbedRequest(texts=["test"]))
        assert exc.value.extra["missingPackage"] == "dashscope"


class TestOpenAIDenseFactory:
    def test_openai_dense_maps_import_error_to_503(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        def _broken(*args, **kwargs):
            raise ImportError("No module named 'openai'", name="openai")

        monkeypatch.setattr(zvec, "OpenAIDenseEmbedding", _broken, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {
                    "name": "oai",
                    "config": {
                        "type": "openai_dense",
                        "model": "text-embedding-3-small",
                        "apiKey": "sk-test",
                    },
                }
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("oai", EmbedRequest(texts=["test"]))
        assert exc.value.extra["missingPackage"] == "openai"


class TestEmbedInvocationError:
    def test_runtime_error_during_encode_wrapped_as_invocation_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        class FakeEmbedding:
            def __init__(self, **kwargs):
                pass

            def encode_documents(self, texts):
                raise RuntimeError("GPU out of memory")

        monkeypatch.setattr(zvec, "DefaultLocalDenseEmbedding", FakeEmbedding, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local_dense"}}
            )
        )
        with pytest.raises(AIFunctionInvocationError) as exc:
            svc.embed("local", EmbedRequest(texts=["test"], isQuery=False))
        assert exc.value.status_code == 500
        assert "GPU out of memory" in str(exc.value)

    def test_import_error_during_encode_wrapped_as_dependency_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        class FakeEmbedding:
            def __init__(self, **kwargs):
                pass

            def encode_documents(self, texts):
                raise ImportError("torch not found", name="torch")

        monkeypatch.setattr(zvec, "DefaultLocalDenseEmbedding", FakeEmbedding, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local_dense"}}
            )
        )
        with pytest.raises(AIDependencyMissingError) as exc:
            svc.embed("local", EmbedRequest(texts=["test"], isQuery=False))
        assert exc.value.extra["missingPackage"] == "torch"


class TestEmbedSuccessPath:
    def test_dense_embed_returns_float_vectors(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        class FakeEmbedding:
            def __init__(self, **kwargs):
                pass

            def encode_documents(self, texts):
                return [np.array([0.1, 0.2, 0.3]) for _ in texts]

        monkeypatch.setattr(zvec, "DefaultLocalDenseEmbedding", FakeEmbedding, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local_dense"}}
            )
        )
        result = svc.embed("local", EmbedRequest(texts=["hello"]))
        assert result.kind == "dense"
        assert len(result.vectors) == 1
        assert len(result.vectors[0]) == 3

    def test_sparse_embed_returns_dict_vectors(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        class FakeEmbedding:
            def __init__(self, **kwargs):
                pass

            def encode_documents(self, texts):
                return [{0: 1.0, 5: 0.5} for _ in texts]

        monkeypatch.setattr(zvec, "DefaultLocalSparseEmbedding", FakeEmbedding, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "sparse", "config": {"type": "default_local_sparse"}}
            )
        )
        result = svc.embed("sparse", EmbedRequest(texts=["hello"]))
        assert result.kind == "sparse"
        assert result.vectors[0] == {"0": 1.0, "5": 0.5}

    def test_embed_uses_encode_queries_when_is_query_true(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import zvec

        class FakeEmbedding:
            def __init__(self, **kwargs):
                pass

            def encode_queries(self, texts):
                return [np.array([9.0, 9.0]) for _ in texts]

            def encode_documents(self, texts):
                raise AssertionError("Should not be called")

        monkeypatch.setattr(zvec, "DefaultLocalDenseEmbedding", FakeEmbedding, raising=True)
        reg, svc = _svc(tmp_path)
        reg.create_embedding(
            EmbeddingFunctionRecord.model_validate(
                {"name": "local", "config": {"type": "default_local_dense"}}
            )
        )
        result = svc.embed("local", EmbedRequest(texts=["q"], isQuery=True))
        assert result.vectors[0][0] == 9.0
