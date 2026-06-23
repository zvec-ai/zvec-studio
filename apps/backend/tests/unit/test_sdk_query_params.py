"""Unit tests for SDK query/index param adaptation."""

from __future__ import annotations

import pytest

zvec = pytest.importorskip("zvec")

from zvec_studio.schemas import DiskAnnQueryParamSpec, IndexType, VectorIndexParam  # noqa: E402
from zvec_studio.storage.sdk import (  # noqa: E402
    SdkBackend,
    _build_index_param,
    _from_sdk_index_param,
    _from_sdk_scalar_index_param,
)


def test_diskann_query_param_maps_list_size_to_sdk() -> None:
    param = SdkBackend._build_sdk_query_param(DiskAnnQueryParamSpec(listSize=120))

    assert isinstance(param, zvec.DiskAnnQueryParam)
    assert param.list_size == 120


def test_diskann_index_param_normalizes_wire_names_to_sdk_kwargs() -> None:
    spec = VectorIndexParam.model_validate(
        {
            "indexType": "DISKANN",
            "metric": "COSINE",
            "params": {
                "maxDegree": 80,
                "listSize": 50,
                "pqChunkNum": 8,
                "quantizeType": "FP16",
            },
        }
    )

    param = _build_index_param(spec)

    assert isinstance(param, zvec.DiskAnnIndexParam)
    assert param.max_degree == 80
    assert param.list_size == 50
    assert param.pq_chunk_num == 8
    assert param.quantize_type == zvec.QuantizeType.FP16


def test_fts_scalar_index_round_trips_from_sdk_param() -> None:
    param = _from_sdk_scalar_index_param(
        zvec.FtsIndexParam(
            tokenizer_name="standard",
            filters=["lowercase"],
            extra_params="",
        )
    )

    assert param is not None
    assert param.indexType is IndexType.FTS
    assert param.tokenizerName == "standard"
    assert param.filters == ["lowercase"]


def test_diskann_vector_index_round_trips_from_sdk_param() -> None:
    param = _from_sdk_index_param(
        zvec.DiskAnnIndexParam(
            metric_type=zvec.MetricType.COSINE,
            max_degree=80,
            list_size=50,
            pq_chunk_num=8,
            quantize_type=zvec.QuantizeType.FP16,
        )
    )

    assert param is not None
    assert param.indexType is IndexType.DISKANN
    assert param.params["max_degree"] == 80
    assert param.params["list_size"] == 50
    assert param.params["pq_chunk_num"] == 8
    assert param.params["quantize_type"] == zvec.QuantizeType.FP16


@pytest.mark.parametrize(
    ("factory", "expected"),
    [
        (lambda: zvec.HnswIndexParam(metric_type=zvec.MetricType.COSINE), IndexType.HNSW),
        (lambda: zvec.FlatIndexParam(metric_type=zvec.MetricType.COSINE), IndexType.FLAT),
        (lambda: zvec.IVFIndexParam(metric_type=zvec.MetricType.COSINE), IndexType.IVF),
        (
            lambda: zvec.HnswRabitqIndexParam(metric_type=zvec.MetricType.COSINE),
            IndexType.HNSW_RABITQ,
        ),
        (lambda: zvec.VamanaIndexParam(metric_type=zvec.MetricType.COSINE), IndexType.VAMANA),
    ],
)
def test_vector_index_round_trips_from_sdk_param_classes(factory, expected: IndexType) -> None:
    param = _from_sdk_index_param(factory())

    assert param is not None
    assert param.indexType is expected
