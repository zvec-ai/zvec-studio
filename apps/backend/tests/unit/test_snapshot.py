"""Unit tests for snapshot packaging (``storage/snapshot.py``).

Design doc §6.2.2: a snapshot is ``manifest.json`` + ``documents.jsonl``.
The manifest carries the schema and export options so an import can
*pre-check compatibility before writing a single row* (fail-fast, 409).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from zvec_studio.exceptions import (
    ImportManifestInvalidError,
    ImportSchemaMismatchError,
)
from zvec_studio.schemas.collection import CollectionSchema
from zvec_studio.storage.snapshot import (
    DATA_FILE_NAME,
    MANIFEST_FORMAT,
    MANIFEST_NAME,
    build_manifest,
    check_schema_compatible,
    parse_manifest,
)


def _schema(
    name: str = "demo",
    *,
    dim: int = 4,
    fields: list[dict] | None = None,
) -> CollectionSchema:
    return CollectionSchema.model_validate(
        {
            "name": name,
            "vectors": [
                {
                    "name": "embedding",
                    "dataType": "VECTOR_FP32",
                    "dimension": dim,
                    "indexParam": {"indexType": "FLAT", "metric": "L2"},
                }
            ],
            "fields": fields if fields is not None else [{"name": "title", "dataType": "STRING"}],
        }
    )


class TestBuildManifest:
    def test_structure(self) -> None:
        manifest = build_manifest(
            schema=_schema(), include_vector=True, output_fields=None
        )

        assert manifest["format"] == MANIFEST_FORMAT == "zvec-studio.export/1"
        assert manifest["zvecVersion"]
        assert manifest["studioVersion"]
        assert manifest["exportedAt"]
        assert manifest["collection"]["name"] == "demo"
        assert manifest["options"] == {"includeVector": True, "outputFields": None}
        assert manifest["data"]["file"] == DATA_FILE_NAME == "documents.jsonl"
        assert manifest["data"]["format"] == "jsonl"

    def test_schema_roundtrips_through_the_model(self) -> None:
        manifest = build_manifest(
            schema=_schema(fields=[{"name": "score", "dataType": "INT64"}]),
            include_vector=False,
            output_fields=["score"],
        )

        restored = CollectionSchema.model_validate(manifest["collection"]["schema"])
        assert [f.name for f in restored.fields] == ["score"]
        assert restored.vectors[0].dimension == 4

    def test_no_doc_count_is_recorded(self) -> None:
        """Streaming generation cannot know the count up front (design §6.2.2)."""
        manifest = build_manifest(schema=_schema(), include_vector=True, output_fields=None)
        assert "docCount" not in manifest["data"]


class TestParseManifest:
    def test_roundtrip(self) -> None:
        manifest = build_manifest(schema=_schema(), include_vector=True, output_fields=None)
        import orjson

        parsed = parse_manifest(orjson.dumps(manifest))
        assert parsed["format"] == MANIFEST_FORMAT

    def test_invalid_json(self) -> None:
        with pytest.raises(ImportManifestInvalidError):
            parse_manifest(b"not json")

    def test_not_an_object(self) -> None:
        with pytest.raises(ImportManifestInvalidError):
            parse_manifest(b"[1, 2]")

    def test_unknown_major_version(self) -> None:
        manifest = build_manifest(schema=_schema(), include_vector=True, output_fields=None)
        manifest["format"] = "zvec-studio.export/2"
        import orjson

        with pytest.raises(ImportManifestInvalidError) as exc:
            parse_manifest(orjson.dumps(manifest))
        assert exc.value.status_code == 400

    def test_missing_schema(self) -> None:
        manifest = build_manifest(schema=_schema(), include_vector=True, output_fields=None)
        del manifest["collection"]["schema"]
        import orjson

        with pytest.raises(ImportManifestInvalidError):
            parse_manifest(orjson.dumps(manifest))


class TestSchemaCompatibility:
    def _manifest(
        self,
        schema: CollectionSchema,
        *,
        include_vector: bool = True,
        output_fields: list[str] | None = None,
    ) -> dict:
        return build_manifest(
            schema=schema, include_vector=include_vector, output_fields=output_fields
        )

    def test_identical_schemas_pass(self) -> None:
        check_schema_compatible(self._manifest(_schema()), _schema())

    def test_target_with_extra_fields_passes(self) -> None:
        """A pruned export may carry fewer fields than the target has."""
        check_schema_compatible(
            self._manifest(_schema(fields=[{"name": "title", "dataType": "STRING"}])),
            _schema(fields=[{"name": "title", "dataType": "STRING"}, {"name": "extra", "dataType": "INT64"}]),
        )

    def test_pruned_field_is_not_required_on_target(self) -> None:
        """Exported with ``outputFields=["title"]``: the dropped ``body``
        column never appears in the data, so a target without it is fine."""
        source = _schema(
            fields=[
                {"name": "title", "dataType": "STRING"},
                {"name": "body", "dataType": "STRING"},
            ]
        )
        manifest = self._manifest(source, output_fields=["title"])
        check_schema_compatible(manifest, _schema())

    def test_pruned_required_field_rejected(self) -> None:
        """``outputFields`` drops a non-nullable column: every data row will
        lack a value the target schema requires, so the import can never
        succeed — the pre-check must say so instead of letting the row
        writes fail one by one."""
        source = _schema(
            fields=[
                {"name": "title", "dataType": "STRING"},
                {"name": "score", "dataType": "INT64"},  # nullable defaults to False
            ]
        )
        manifest = self._manifest(source, output_fields=["title"])

        with pytest.raises(ImportSchemaMismatchError) as exc:
            check_schema_compatible(
                manifest,
                # Collection-level import builds the target from the manifest
                # schema itself — required column included.
                _schema(
                    fields=[
                        {"name": "title", "dataType": "STRING"},
                        {"name": "score", "dataType": "INT64"},
                    ]
                ),
            )
        assert any("score" in m and "non-nullable" in m for m in exc.value.extra["mismatches"])

    def test_pruned_nullable_field_allowed(self) -> None:
        """A dropped column the target accepts rows without is fine."""
        source = _schema(
            fields=[
                {"name": "title", "dataType": "STRING"},
                {"name": "note", "dataType": "STRING", "nullable": True},
            ]
        )
        manifest = self._manifest(source, output_fields=["title"])
        check_schema_compatible(
            manifest,
            _schema(
                fields=[
                    {"name": "title", "dataType": "STRING"},
                    {"name": "note", "dataType": "STRING", "nullable": True},
                ]
            ),
        )

    def test_kept_field_is_still_checked_when_pruned(self) -> None:
        """outputFields pruning exempts only the dropped columns."""
        source = _schema(
            fields=[
                {"name": "title", "dataType": "STRING"},
                {"name": "body", "dataType": "STRING"},
            ]
        )
        manifest = self._manifest(source, output_fields=["title"])
        target = _schema(fields=[{"name": "title", "dataType": "INT64"}])
        with pytest.raises(ImportSchemaMismatchError) as exc:
            check_schema_compatible(manifest, target)
        assert any("title" in m for m in exc.value.extra["mismatches"])

    def test_vector_dimension_mismatch_rejected(self) -> None:
        with pytest.raises(ImportSchemaMismatchError) as exc:
            check_schema_compatible(self._manifest(_schema(dim=8)), _schema(dim=4))
        assert exc.value.status_code == 409
        assert exc.value.extra["mismatches"]

    def test_missing_vector_in_target_rejected(self) -> None:
        target = CollectionSchema.model_validate(
            {"name": "tgt", "vectors": [], "fields": [{"name": "title", "dataType": "STRING"}]}
        )
        with pytest.raises(ImportSchemaMismatchError):
            check_schema_compatible(self._manifest(_schema()), target)

    def test_field_type_mismatch_rejected(self) -> None:
        with pytest.raises(ImportSchemaMismatchError):
            check_schema_compatible(
                self._manifest(_schema(fields=[{"name": "title", "dataType": "STRING"}])),
                _schema(fields=[{"name": "title", "dataType": "INT64"}]),
            )

    def test_field_absent_in_target_rejected(self) -> None:
        with pytest.raises(ImportSchemaMismatchError):
            check_schema_compatible(
                self._manifest(_schema(fields=[{"name": "title", "dataType": "STRING"}])),
                _schema(fields=[{"name": "other", "dataType": "STRING"}]),
            )

    def test_vectors_not_exported_but_required_rejected(self) -> None:
        """includeVector=false cannot repopulate a collection that needs vectors."""
        with pytest.raises(ImportSchemaMismatchError) as exc:
            check_schema_compatible(
                self._manifest(_schema(), include_vector=False), _schema()
            )
        assert any("vector" in m.lower() for m in exc.value.extra["mismatches"])

class TestPackSnapshot:
    def test_packs_manifest_and_data_in_order(self, tmp_path: Path) -> None:
        """pack_snapshot produces a plain gzip tar with both members."""
        import tarfile

        from zvec_studio.storage.snapshot import pack_snapshot

        (tmp_path / MANIFEST_NAME).write_bytes(b'{"format": "x"}')
        (tmp_path / DATA_FILE_NAME).write_bytes(b'{"id": "a"}\n')
        out = tmp_path / "package.tar.gz"

        pack_snapshot(manifest_path=tmp_path / MANIFEST_NAME,
                      data_path=tmp_path / DATA_FILE_NAME, out_path=out)

        with tarfile.open(out, "r:gz") as tar:
            names = tar.getnames()
            data = tar.extractfile(DATA_FILE_NAME).read()
        assert names == [MANIFEST_NAME, DATA_FILE_NAME]
        assert data == b'{"id": "a"}\n'
