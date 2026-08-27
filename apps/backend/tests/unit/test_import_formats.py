"""Unit tests for the import-format layer (``storage/formats.py``).

Per the design doc (§4.2), formats are the only variable piece of the
import pipeline: ``ImportFormat`` turns a byte stream into ``(line number,
record)`` pairs, and a registry resolves formats by name / file extension.
First version ships JSONL only — the registry exists so adding CSV/Parquet
later is registration, not surgery.
"""

from __future__ import annotations

import io

import pytest

from zvec_studio.exceptions import InvalidDocumentError
from zvec_studio.storage.formats import (
    EXPORT_FORMATS,
    IMPORT_FORMATS,
    JsonlFormat,
    resolve_import_format,
)


def _stream(text: str) -> io.BufferedReader:
    return io.BufferedReader(io.BytesIO(text.encode("utf-8")))


class TestJsonlParsing:
    def test_parses_valid_rows_with_line_numbers(self) -> None:
        stream = _stream('{"id": "a"}\n{"id": "b"}\n')
        rows = list(JsonlFormat().parse(stream))
        assert rows == [(1, {"id": "a"}), (2, {"id": "b"})]

    def test_skips_blank_lines_but_keeps_numbering(self) -> None:
        stream = _stream('{"id": "a"}\n\n   \n{"id": "b"}\n')
        rows = list(JsonlFormat().parse(stream))
        assert rows == [(1, {"id": "a"}), (4, {"id": "b"})]

    def test_accepts_missing_trailing_newline(self) -> None:
        stream = _stream('{"id": "a"}')
        assert list(JsonlFormat().parse(stream)) == [(1, {"id": "a"})]

    def test_invalid_json_line_reports_line_number(self) -> None:
        stream = _stream('{"id": "a"}\nnot json\n{"id": "b"}\n')
        parsed = JsonlFormat().parse(stream)
        assert next(parsed) == (1, {"id": "a"})
        with pytest.raises(InvalidDocumentError) as exc:
            next(parsed)
        assert exc.value.status_code == 422
        assert exc.value.code == "INVALID_DOCUMENT"
        assert exc.value.extra["line"] == 2

    def test_resumes_after_a_row_error(self) -> None:
        """``skip``-mode imports keep going past failing lines, so the
        iterator must survive its own raises (a generator would not)."""
        stream = _stream('{"id": "a"}\nnot json\n{"id": "b"}\n')
        parsed = JsonlFormat().parse(stream)
        assert next(parsed) == (1, {"id": "a"})
        with pytest.raises(InvalidDocumentError):
            next(parsed)
        assert next(parsed) == (3, {"id": "b"})
        with pytest.raises(StopIteration):
            next(parsed)

    def test_line_must_be_a_json_object(self) -> None:
        for body in ('[1, 2]', '"plain string"', "42", "null"):
            stream = _stream(body + "\n")
            with pytest.raises(InvalidDocumentError) as exc:
                list(JsonlFormat().parse(stream))
            assert exc.value.extra["line"] == 1

    def test_empty_stream_yields_nothing(self) -> None:
        assert list(JsonlFormat().parse(_stream(""))) == []
        assert list(JsonlFormat().parse(_stream("\n\n"))) == []


class TestFormatRegistry:
    def test_jsonl_registered_under_name_and_extensions(self) -> None:
        assert "jsonl" in IMPORT_FORMATS
        assert EXPORT_FORMATS["jsonl"].extension == "jsonl"
        assert "ndjson" in JsonlFormat().extensions

    def test_resolve_by_name(self) -> None:
        assert resolve_import_format("jsonl") is IMPORT_FORMATS["jsonl"]

    def test_resolve_by_extension(self) -> None:
        assert resolve_import_format("ndjson") is IMPORT_FORMATS["jsonl"]

    def test_resolve_is_case_insensitive(self) -> None:
        assert resolve_import_format("JSONL") is IMPORT_FORMATS["jsonl"]

    def test_resolve_unknown_lists_supported(self) -> None:
        with pytest.raises(InvalidDocumentError) as exc:
            resolve_import_format("csv")
        assert exc.value.status_code == 400
        assert exc.value.code == "IMPORT_UNSUPPORTED_FORMAT"
        assert "jsonl" in exc.value.message
