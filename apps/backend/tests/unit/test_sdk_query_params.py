"""Unit tests for SDK query/index param adaptation."""

from __future__ import annotations

from pathlib import Path

import pytest

zvec = pytest.importorskip("zvec")

from zvec_studio.exceptions import InvalidSchemaError  # noqa: E402
from zvec_studio.schemas import (  # noqa: E402
    CollectionStats,
    CollectionSummary,
    DiskAnnQueryParamSpec,
    IndexType,
    VectorIndexParam,
)
from zvec_studio.storage.sdk import (  # noqa: E402
    SdkBackend,
    _build_index_param,
    _from_sdk_index_param,
    _from_sdk_scalar_index_param,
    _from_sdk_schema,
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
    assert param.params["quantize_type"] == "FP16"
    assert '"quantize_type":"FP16"' in param.model_dump_json()


def test_quantized_hnsw_index_round_trips_as_json_safe_name() -> None:
    param = _from_sdk_index_param(
        zvec.HnswIndexParam(
            metric_type=zvec.MetricType.COSINE,
            quantize_type=zvec.QuantizeType.INT8,
        )
    )

    assert param is not None
    assert param.indexType is IndexType.HNSW
    assert param.params["quantize_type"] == "INT8"
    assert '"quantize_type":"INT8"' in param.model_dump_json()


def test_rotated_quantizer_param_maps_to_sdk_and_round_trips() -> None:
    spec = VectorIndexParam.model_validate(
        {
            "indexType": "HNSW",
            "metric": "COSINE",
            "params": {
                "quantizeType": "INT8",
                "quantizerParam": {"enableRotate": True},
            },
        }
    )

    sdk_param = _build_index_param(spec)

    assert sdk_param.quantizer_param.enable_rotate is True
    round_tripped = _from_sdk_index_param(sdk_param)
    assert round_tripped is not None
    assert round_tripped.params["quantizer_param"] == {"enable_rotate": True}


@pytest.mark.parametrize(
    "spec",
    [
        {
            "indexType": "HNSW",
            "params": {
                "quantizeType": "FP16",
                "quantizerParam": {"enableRotate": True},
            },
        },
        {
            "indexType": "IVF",
            "params": {
                "quantizeType": "INT8",
                "quantizerParam": {"enableRotate": True},
            },
        },
    ],
)
def test_rotated_quantizer_rejects_unsupported_combinations(spec: dict) -> None:
    with pytest.raises(InvalidSchemaError, match="Random rotation"):
        _build_index_param(VectorIndexParam.model_validate(spec))


def test_sdk_schema_with_pybind_enum_index_param_serializes_for_summary() -> None:
    sdk_schema = zvec.CollectionSchema(
        name="demo",
        vectors=[
            zvec.VectorSchema(
                "embedding",
                zvec.DataType.VECTOR_FP32,
                4,
                index_param=zvec.HnswIndexParam(
                    metric_type=zvec.MetricType.COSINE,
                    quantize_type=zvec.QuantizeType.INT8,
                ),
            )
        ],
        fields=None,
    )

    schema = _from_sdk_schema(sdk_schema, Path("/tmp/demo"))
    summary = CollectionSummary.model_validate(
        {
            "name": "demo",
            "path": "/tmp/demo",
            "schema": schema,
            "stats": CollectionStats(),
        }
    )

    dumped = summary.model_dump(mode="json", by_alias=True)
    params = dumped["schema"]["vectors"][0]["indexParam"]["params"]
    assert params["quantize_type"] == "INT8"
    assert isinstance(params["quantize_type"], str)
    assert '"quantize_type":"INT8"' in summary.model_dump_json(by_alias=True)


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
