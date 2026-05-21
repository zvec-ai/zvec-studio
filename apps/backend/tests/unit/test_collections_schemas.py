"""Unit tests for v2 Collection Pydantic schemas (Zvec 0.4.x aligned).

The v0.2.0 contract drops ``isPrimary`` / ``description`` / ``JSON`` /
collection-level ``indexParams`` and adds:
- per-vector ``indexParam`` ({indexType, metric, params})
- reserved field names ``{"id", "_id"}``
- stricter collection-name regex (start with letter, len ≥ 3).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from zvec_studio.schemas.collection import (
    CollectionCreateRequest,
    CollectionSchema,
    FieldSchema,
    IndexType,
    MetricType,
    ScalarDataType,
    VectorDataType,
    VectorIndexParam,
    VectorSchema,
)


def _valid_schema_payload() -> dict:
    return {
        "name": "demo",
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": 8,
                "indexParam": {
                    "indexType": "HNSW",
                    "metric": "COSINE",
                    "params": {"M": 16},
                },
            }
        ],
        "fields": [
            {"name": "title", "dataType": "STRING"},
            {"name": "year", "dataType": "INT64"},
        ],
    }


class TestFieldSchema:
    def test_valid_field(self) -> None:
        f = FieldSchema(name="title", dataType=ScalarDataType.STRING)
        assert f.name == "title"
        assert f.dataType is ScalarDataType.STRING

    @pytest.mark.parametrize("bad_name", ["", "1bad", "with space", "a" * 65, "a-b"])
    def test_invalid_name(self, bad_name: str) -> None:
        with pytest.raises(ValidationError):
            FieldSchema(name=bad_name, dataType=ScalarDataType.INT64)

    @pytest.mark.parametrize("reserved", ["id", "_id"])
    def test_reserved_field_names_rejected(self, reserved: str) -> None:
        with pytest.raises(ValidationError) as exc:
            FieldSchema(name=reserved, dataType=ScalarDataType.STRING)
        assert "reserved" in str(exc.value)

    def test_extra_forbidden(self) -> None:
        with pytest.raises(ValidationError):
            FieldSchema.model_validate(
                {"name": "title", "dataType": "STRING", "isPrimary": True}
            )

    def test_json_data_type_removed(self) -> None:
        with pytest.raises(ValidationError):
            FieldSchema.model_validate({"name": "blob", "dataType": "JSON"})


class TestVectorSchema:
    def test_valid_vector(self) -> None:
        v = VectorSchema(name="v", dataType=VectorDataType.VECTOR_FP32, dimension=8)
        assert v.dimension == 8
        assert v.indexParam is None

    @pytest.mark.parametrize("bad_dim", [0, -1, 32_769])
    def test_dimension_bounds(self, bad_dim: int) -> None:
        with pytest.raises(ValidationError):
            VectorSchema(name="v", dataType=VectorDataType.VECTOR_FP32, dimension=bad_dim)

    @pytest.mark.parametrize("reserved", ["id", "_id"])
    def test_reserved_vector_names_rejected(self, reserved: str) -> None:
        with pytest.raises(ValidationError):
            VectorSchema(
                name=reserved, dataType=VectorDataType.VECTOR_FP32, dimension=4
            )

    def test_index_param_attached(self) -> None:
        v = VectorSchema.model_validate(
            {
                "name": "v",
                "dataType": "VECTOR_FP32",
                "dimension": 16,
                "indexParam": {"indexType": "FLAT", "metric": "L2", "params": {}},
            }
        )
        assert v.indexParam is not None
        assert v.indexParam.indexType is IndexType.FLAT
        assert v.indexParam.metric is MetricType.L2


class TestVectorIndexParam:
    def test_defaults(self) -> None:
        p = VectorIndexParam()
        assert p.indexType is IndexType.HNSW
        assert p.metric is MetricType.COSINE
        assert p.params == {}

    def test_params_passthrough(self) -> None:
        p = VectorIndexParam.model_validate(
            {
                "indexType": "HNSW",
                "metric": "L2",
                "params": {"M": 32, "efConstruction": 200},
            }
        )
        assert p.params == {"M": 32, "efConstruction": 200}

    def test_extra_forbidden_at_top_level(self) -> None:
        # Extras must live under ``params`` so we don't drift from SDK shape.
        with pytest.raises(ValidationError):
            VectorIndexParam.model_validate(
                {"indexType": "HNSW", "metric": "L2", "efConstruction": 200}
            )


class TestCollectionSchema:
    def test_round_trip_preserves_sdk_field_names(self) -> None:
        payload = _valid_schema_payload()
        schema = CollectionSchema.model_validate(payload)
        dumped = schema.model_dump(mode="json", by_alias=True)
        assert dumped["vectors"][0]["dataType"] == "VECTOR_FP32"
        assert dumped["vectors"][0]["indexParam"]["indexType"] == "HNSW"
        # No top-level indexParams / no isPrimary.
        assert "indexParams" not in dumped
        assert all("isPrimary" not in f for f in dumped["fields"])
        # Re-validation must succeed without mutation.
        CollectionSchema.model_validate(dumped)

    def test_requires_at_least_one_vector(self) -> None:
        payload = _valid_schema_payload()
        payload["vectors"] = []
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    def test_top_level_index_params_rejected(self) -> None:
        payload = _valid_schema_payload()
        payload["indexParams"] = {"indexType": "HNSW", "metric": "L2"}
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    def test_description_no_longer_accepted(self) -> None:
        payload = _valid_schema_payload()
        payload["description"] = "should fail"
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    def test_rejects_duplicate_field_names(self) -> None:
        payload = _valid_schema_payload()
        payload["fields"].append({"name": "title", "dataType": "STRING"})
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    def test_rejects_name_collision_between_vector_and_scalar(self) -> None:
        payload = _valid_schema_payload()
        payload["fields"].append({"name": "embedding", "dataType": "STRING"})
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    def test_no_scalar_fields_is_ok(self) -> None:
        # Zvec 0.4.x allows vector-only collections; v0.2.0 follows suit.
        payload = _valid_schema_payload()
        payload["fields"] = []
        schema = CollectionSchema.model_validate(payload)
        assert schema.fields == []

    @pytest.mark.parametrize("bad_name", ["x", "ab", "1abc", "a-b", "_x"])
    def test_collection_name_must_be_at_least_3_chars_letter_first(
        self, bad_name: str
    ) -> None:
        payload = _valid_schema_payload()
        payload["name"] = bad_name
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)


class TestCollectionCreateRequest:
    def test_schema_alias_is_required(self) -> None:
        body = CollectionCreateRequest.model_validate(
            {"path": "/tmp/c", "schema": _valid_schema_payload()}
        )
        assert body.schema_.name == "demo"

    def test_rejects_unknown_top_level_key(self) -> None:
        with pytest.raises(ValidationError):
            CollectionCreateRequest.model_validate(
                {"path": "/tmp/c", "schema": _valid_schema_payload(), "rogue": True}
            )
