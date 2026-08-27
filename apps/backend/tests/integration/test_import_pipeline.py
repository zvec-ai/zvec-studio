"""Integration tests for the import pipeline (`SdkBackend.import_documents`).

Exercises the real SDK: file parsing (JSONL), internal batching, write modes
(`insert` / `replace`), error policies (`abort` / `skip`), and the report
shape defined in design doc §6.4.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

zvec = pytest.importorskip("zvec")

from zvec_studio.exceptions import (  # noqa: E402  (import after skip)
    ImportFileNotFoundError,
    ImportFileNotReadableError,
)
from zvec_studio.schemas.collection import CollectionSchema  # noqa: E402
from zvec_studio.storage.formats import JsonlFormat  # noqa: E402
from zvec_studio.storage.import_ import ImportMode, OnErrorMode  # noqa: E402
from zvec_studio.storage.sdk import SdkBackend  # noqa: E402

pytestmark = pytest.mark.integration

DIM = 4


def _schema(name: str = "import_target") -> CollectionSchema:
    return CollectionSchema.model_validate(
        {
            "name": name,
            "vectors": [
                {
                    "name": "embedding",
                    "dataType": "VECTOR_FP32",
                    "dimension": DIM,
                    "indexParam": {"indexType": "FLAT", "metric": "L2"},
                }
            ],
            "fields": [
                {"name": "title", "dataType": "STRING"},
                {"name": "score", "dataType": "INT64"},
            ],
        }
    )


def _make_backend_and_collection(tmp_path: Path, name: str = "import_target") -> SdkBackend:
    backend = SdkBackend()
    backend.create(path=tmp_path / name, schema=_schema(name))
    return backend


def _write_jsonl(tmp_path: Path, rows: list[dict], file_name: str = "data.jsonl") -> Path:
    path = tmp_path / file_name
    path.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return path


def _row(i: int, **overrides: object) -> dict:
    base: dict = {
        "id": f"doc-{i:04d}",
        "title": f"t{i}",
        "score": i,
        "embedding": [float(i), 0.0, 0.0, 0.0],
    }
    base.update(overrides)
    return base


class TestBasicImport:
    def test_imports_rows_and_reports(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        source = _write_jsonl(tmp_path, [_row(i) for i in range(3)])

        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
        )

        assert report.imported == 3
        assert report.failed == 0
        assert report.total_lines == 3
        assert report.aborted is False
        assert report.errors == []
        assert backend.get_document("import_target", "doc-0001")["title"] == "t1"

    def test_blank_lines_are_skipped_and_numbering_kept(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        source = tmp_path / "gaps.jsonl"
        source.write_text(
            json.dumps(_row(0)) + "\n\n" + json.dumps(_row(1)) + "\n",
            encoding="utf-8",
        )

        report = backend.import_documents(
            "import_target", source_path=str(source), fmt=JsonlFormat()
        )

        assert (report.imported, report.total_lines) == (2, 2)

    def test_batches_larger_than_sdk_limit(self, tmp_path: Path) -> None:
        """600 rows crosses the 512-doc batch boundary."""
        backend = _make_backend_and_collection(tmp_path)
        source = _write_jsonl(tmp_path, [_row(i) for i in range(600)])

        report = backend.import_documents(
            "import_target", source_path=str(source), fmt=JsonlFormat()
        )

        assert report.imported == 600
        assert backend.stats("import_target").documentCount == 600

    def test_empty_file(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        source = tmp_path / "empty.jsonl"
        source.write_text("", encoding="utf-8")

        report = backend.import_documents(
            "import_target", source_path=str(source), fmt=JsonlFormat()
        )

        assert (report.imported, report.failed, report.total_lines) == (0, 0, 0)


class TestWriteModes:
    def test_replace_mode_overwrites_whole_document(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        backend.insert_documents("import_target", [_row(0, title="original")])

        source = _write_jsonl(tmp_path, [_row(0, title="replaced", score=99)])
        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            mode=ImportMode.REPLACE,
        )

        assert report.imported == 1
        doc = backend.get_document("import_target", "doc-0000")
        assert doc["title"] == "replaced"
        assert doc["score"] == 99
        assert backend.stats("import_target").documentCount == 1

    def test_insert_mode_rejects_duplicate_and_aborts(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        backend.insert_documents("import_target", [_row(0)])

        source = _write_jsonl(tmp_path, [_row(0, title="dup"), _row(1)])
        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            mode=ImportMode.INSERT,
            on_error=OnErrorMode.ABORT,
        )

        assert report.aborted is True
        assert report.failed == 1
        assert report.errors[0].line == 1
        assert report.errors[0].code == "DOCUMENT_CONFLICT"
        # Abort granularity is the batch: both rows were already submitted to
        # the SDK, whose per-doc statuses are independent — the valid row in
        # the same batch lands. No further rows are read afterwards.
        assert report.imported == 1
        assert backend.stats("import_target").documentCount == 2

    def test_insert_mode_skip_records_and_continues(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        backend.insert_documents("import_target", [_row(0)])

        source = _write_jsonl(tmp_path, [_row(0, title="dup"), _row(1), _row(2)])
        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            mode=ImportMode.INSERT,
            on_error=OnErrorMode.SKIP,
        )

        assert report.aborted is False
        assert (report.imported, report.failed) == (2, 1)
        assert [e.line for e in report.errors] == [1]
        assert backend.stats("import_target").documentCount == 3


class TestErrorPolicies:
    def test_abort_on_invalid_row_keeps_prior_rows(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        # Row 2 has a dimension mismatch.
        rows = [_row(0), _row(1, embedding=[0.0, 0.0]), _row(2)]
        source = _write_jsonl(tmp_path, rows)

        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            on_error=OnErrorMode.ABORT,
        )

        assert report.aborted is True
        assert (report.imported, report.failed) == (1, 1)
        assert report.errors[0].line == 2
        assert report.errors[0].code == "DIMENSION_MISMATCH"
        # Row 0 landed and was flushed; row 2 never written.
        assert backend.stats("import_target").documentCount == 1

    def test_skip_invalid_rows_and_continue(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        rows = [
            _row(0),
            _row(1, embedding=[0.0, 0.0]),  # dimension mismatch
            _row(2, unknownColumn="x"),  # unknown column
            _row(3),
        ]
        source = _write_jsonl(tmp_path, rows)

        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            on_error=OnErrorMode.SKIP,
        )

        assert report.aborted is False
        assert (report.imported, report.failed) == (2, 2)
        assert [(e.line, e.code) for e in report.errors] == [
            (2, "DIMENSION_MISMATCH"),
            (3, "INVALID_SCHEMA"),
        ]

    def test_skip_malformed_json_line(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        source = tmp_path / "bad.jsonl"
        source.write_text(
            json.dumps(_row(0)) + "\n" + "not json" + "\n" + json.dumps(_row(1)) + "\n",
            encoding="utf-8",
        )

        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            on_error=OnErrorMode.SKIP,
        )

        assert (report.imported, report.failed) == (2, 1)
        assert report.errors[0].line == 2
        assert report.errors[0].code == "INVALID_DOCUMENT"

    def test_error_report_is_capped(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        rows = [_row(i, embedding=[0.0]) for i in range(150)]
        source = _write_jsonl(tmp_path, rows)

        report = backend.import_documents(
            "import_target",
            source_path=str(source),
            fmt=JsonlFormat(),
            on_error=OnErrorMode.SKIP,
        )

        assert report.failed == 150
        assert len(report.errors) == 100
        assert report.errors_truncated is True


class TestSourceValidation:
    def test_missing_file(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        with pytest.raises(ImportFileNotFoundError) as exc:
            backend.import_documents(
                "import_target",
                source_path=str(tmp_path / "nope.jsonl"),
                fmt=JsonlFormat(),
            )
        assert exc.value.status_code == 404

    def test_directory_is_not_a_valid_source(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        with pytest.raises(ImportFileNotFoundError) as exc:
            backend.import_documents(
                "import_target", source_path=str(tmp_path), fmt=JsonlFormat()
            )
        assert exc.value.status_code == 404

    def test_unreadable_file(self, tmp_path: Path) -> None:
        backend = _make_backend_and_collection(tmp_path)
        source = _write_jsonl(tmp_path, [_row(0)])
        source.chmod(0o000)
        try:
            with pytest.raises(ImportFileNotReadableError) as exc:
                backend.import_documents(
                    "import_target", source_path=str(source), fmt=JsonlFormat()
                )
            assert exc.value.status_code == 403
        finally:
            source.chmod(0o644)
