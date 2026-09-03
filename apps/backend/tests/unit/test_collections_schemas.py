"""Unit tests for Collection Pydantic schemas (Zvec 0.6.x aligned).

The v0.2.0 contract drops ``isPrimary`` / ``description`` / ``JSON`` /
collection-level ``indexParams`` and keeps:
- per-vector ``indexParam`` ({indexType, metric, params})
- stricter collection-name regex (start with letter, len >= 3).
- Zvec 0.6.x FTS scalar indexes and DiskANN vector params.

Column names ``id`` / ``_id`` are *accepted*: Zvec allows them, and rejecting
them stopped Studio from opening SDK-created collections. When a column takes
``id``, the primary key moves to the ``$id`` row key (see
``storage/doc_repr.py``).
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
    ScalarIndexParam,
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

    @pytest.mark.parametrize("name", ["id", "_id"])
    def test_columns_may_be_named_id(self, name: str) -> None:
        """Zvec allows these names; rejecting them blocked opening SDK collections."""
        assert FieldSchema(name=name, dataType=ScalarDataType.STRING).name == name

    def test_dollar_prefixed_scalar_field_name_rejected(self) -> None:
        """Pin the guard the reserved pk chain relies on: Studio (and Zvec)
        reject ``$`` in scalar field names, so ``$id``/``$$id`` can never be
        user columns."""
        with pytest.raises(ValidationError):
            FieldSchema(name="$id", dataType=ScalarDataType.STRING)

    def test_extra_forbidden(self) -> None:
        with pytest.raises(ValidationError):
            FieldSchema.model_validate(
                {"name": "title", "dataType": "STRING", "isPrimary": True}
            )

    def test_json_data_type_removed(self) -> None:
        with pytest.raises(ValidationError):
            FieldSchema.model_validate({"name": "blob", "dataType": "JSON"})

    def test_fts_index_requires_string_field(self) -> None:
        with pytest.raises(ValidationError):
            FieldSchema.model_validate(
                {
                    "name": "year",
                    "dataType": "INT64",
                    "indexParam": {"indexType": "FTS"},
                }
            )

    def test_accepts_fts_index_on_string_field(self) -> None:
        f = FieldSchema.model_validate(
            {
                "name": "content",
                "dataType": "STRING",
                "indexParam": {
                    "indexType": "FTS",
                    "tokenizerName": "jieba",
                    "filters": ["lowercase"],
                    "extraParams": '{"cut_mode":"search"}',
                },
            }
        )
        assert f.indexParam is not None
        assert f.indexParam.indexType is IndexType.FTS
        assert f.indexParam.tokenizerName == "jieba"


class TestVectorSchema:
    def test_valid_vector(self) -> None:
        v = VectorSchema(name="v", dataType=VectorDataType.VECTOR_FP32, dimension=8)
        assert v.dimension == 8
        assert v.indexParam is None

    @pytest.mark.parametrize("bad_dim", [0, -1, 32_769])
    def test_dimension_bounds(self, bad_dim: int) -> None:
        with pytest.raises(ValidationError):
            VectorSchema(name="v", dataType=VectorDataType.VECTOR_FP32, dimension=bad_dim)

    @pytest.mark.parametrize("name", ["id", "_id"])
    def test_vectors_may_be_named_id(self, name: str) -> None:
        """Zvec accepts a vector named ``id`` (it just cannot clash with a field)."""
        v = VectorSchema(name=name, dataType=VectorDataType.VECTOR_FP32, dimension=4)
        assert v.name == name

    def test_vector_fp64_is_rejected_at_validation(self) -> None:
        """Regression: zvec rejects FP64 dense vectors at create time with an
        opaque error; refuse the value up front instead (defect §4.3 in the
        import/export design doc)."""
        with pytest.raises(ValidationError):
            VectorSchema(
                name="v", dataType="VECTOR_FP64", dimension=4  # type: ignore[arg-type]
            )

    def test_supported_vector_types(self) -> None:
        assert VectorDataType.__members__.keys() == {
            "VECTOR_FP32",
            "VECTOR_FP16",
            "VECTOR_INT8",
            "SPARSE_VECTOR_FP32",
            "SPARSE_VECTOR_FP16",
        }

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

    def test_diskann_params_passthrough(self) -> None:
        p = VectorIndexParam.model_validate(
            {
                "indexType": "DISKANN",
                "metric": "COSINE",
                "params": {"maxDegree": 80, "listSize": 50, "pqChunkNum": 8, "quantizeType": "FP16"},
            }
        )
        assert p.indexType is IndexType.DISKANN
        assert p.params["maxDegree"] == 80

    def test_extra_forbidden_at_top_level(self) -> None:
        # Extras must live under ``params`` so we don't drift from SDK shape.
        with pytest.raises(ValidationError):
            VectorIndexParam.model_validate(
                {"indexType": "HNSW", "metric": "L2", "efConstruction": 200}
            )


class TestScalarIndexParam:
    def test_invert_defaults(self) -> None:
        p = ScalarIndexParam()
        assert p.indexType is IndexType.INVERT
        assert p.enableRangeOptimization is False

    def test_fts_defaults(self) -> None:
        p = ScalarIndexParam.model_validate({"indexType": "FTS"})
        assert p.indexType is IndexType.FTS
        assert p.tokenizerName == "standard"
        assert p.filters == ["lowercase"]

    def test_accepts_zvec_06_fts_filters(self) -> None:
        p = ScalarIndexParam.model_validate(
            {
                "indexType": "FTS",
                "filters": ["lowercase", "ascii_folding", "stemmer"],
                "extraParams": '{"stemmer_lang":"english"}',
            }
        )

        assert p.filters == ["lowercase", "ascii_folding", "stemmer"]

    def test_rejects_unknown_fts_filter(self) -> None:
        with pytest.raises(ValidationError):
            ScalarIndexParam.model_validate({"indexType": "FTS", "filters": ["stem"]})


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

    def test_allows_vectorless_fts_collection(self) -> None:
        payload = _valid_schema_payload()
        payload["vectors"] = []
        payload["fields"] = [
            {"name": "content", "dataType": "STRING", "indexParam": {"indexType": "FTS"}}
        ]
        schema = CollectionSchema.model_validate(payload)
        assert schema.vectors == []
        assert schema.fields[0].indexParam is not None
        assert schema.fields[0].indexParam.indexType is IndexType.FTS

    def test_rejects_empty_schema(self) -> None:
        payload = _valid_schema_payload()
        payload["vectors"] = []
        payload["fields"] = []
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
        # Zvec allows vector-only collections; Studio also allows scalar-only
        # collections when at least one scalar field is present.
        payload = _valid_schema_payload()
        payload["fields"] = []
        schema = CollectionSchema.model_validate(payload)
        assert schema.fields == []

    @pytest.mark.parametrize("bad_name", ["", "x", "ab", "a" * 65, "with space", "a@b"])
    def test_collection_name_invalid_rejected(self, bad_name: str) -> None:
        payload = _valid_schema_payload()
        payload["name"] = bad_name
        with pytest.raises(ValidationError):
            CollectionSchema.model_validate(payload)

    @pytest.mark.parametrize(
        "valid_name",
        ["abc", "a-b", "pr-new-collection", "-start", "end-", "1abc", "col_123", "a" * 64],
    )
    def test_collection_name_valid_accepted(self, valid_name: str) -> None:
        payload = _valid_schema_payload()
        payload["name"] = valid_name
        schema = CollectionSchema.model_validate(payload)
        assert schema.name == valid_name



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
