"""Unit tests for the export serialization layer (``formats.JsonlFormat``).

Design doc §6.6 rules under test:
* one JSON object per line, ``\\n`` terminated (streaming-friendly);
* sparse vector int keys serialised as JSON string keys
  (``orjson.OPT_NON_STR_KEYS`` — without it orjson raises);
* non-finite floats are rejected up front with the offending location
  (silent ``null`` coercion by orjson would corrupt data);
* nullable-absent semantics pass through untouched.
"""

from __future__ import annotations

import pytest

from zvec_studio.exceptions import ExportNonFiniteError
from zvec_studio.storage.formats import JsonlFormat


def _lines(payload: bytes) -> list[str]:
    return payload.decode("utf-8").splitlines()


class TestJsonlSerialize:
    def test_one_object_per_line_newline_terminated(self) -> None:
        rows = [{"id": "a", "title": "x"}, {"id": "b", "title": "y"}]
        chunks = list(JsonlFormat().serialize(iter(rows)))

        assert len(chunks) == 2
        assert all(c.endswith(b"\n") for c in chunks)
        assert _lines(chunks[0] + chunks[1]) == [
            '{"id":"a","title":"x"}',
            '{"id":"b","title":"y"}',
        ]

    def test_sparse_int_keys_become_string_keys(self) -> None:
        """Without OPT_NON_STR_KEYS orjson raises on int dict keys."""
        rows = [{"id": "a", "keywords": {42: 1.0, 314: 0.5}}]
        payload = b"".join(JsonlFormat().serialize(iter(rows)))

        assert _lines(payload) == ['{"id":"a","keywords":{"42":1.0,"314":0.5}}']

    def test_reserved_pk_key_passes_through(self) -> None:
        rows = [{"$id": "PK-1", "id": "USER-1", "title": "t"}]
        payload = b"".join(JsonlFormat().serialize(iter(rows)))

        assert _lines(payload) == ['{"$id":"PK-1","id":"USER-1","title":"t"}']

    def test_unicode_is_not_escaped(self) -> None:
        rows = [{"id": "a", "title": "héllo 中文"}]
        payload = b"".join(JsonlFormat().serialize(iter(rows)))

        assert "héllo 中文".encode() in payload

    def test_nan_scalar_is_rejected_with_location(self) -> None:
        rows = [{"id": "doc-1", "score": float("nan")}]

        with pytest.raises(ExportNonFiniteError) as exc:
            b"".join(JsonlFormat().serialize(iter(rows)))

        assert exc.value.status_code == 422
        assert exc.value.code == "EXPORT_NON_FINITE_VALUE"
        assert exc.value.extra["documentId"] == "doc-1"
        assert exc.value.extra["path"] == "score"

    def test_infinity_in_vector_is_rejected_with_path(self) -> None:
        rows = [{"id": "doc-1", "embedding": [0.1, float("inf")]}]

        with pytest.raises(ExportNonFiniteError) as exc:
            b"".join(JsonlFormat().serialize(iter(rows)))

        assert exc.value.extra["path"] == "embedding[1]"

    def test_non_finite_in_nested_array_field_is_rejected(self) -> None:
        rows = [{"id": "doc-1", "matrix": [[1.0], [float("-inf")]]}]

        with pytest.raises(ExportNonFiniteError) as exc:
            b"".join(JsonlFormat().serialize(iter(rows)))

        assert exc.value.extra["path"] == "matrix[1][0]"

    def test_finite_rows_before_the_bad_one_are_emitted(self) -> None:
        """The generator yields lazily: good rows stream out before the raise."""
        rows = [{"id": "ok"}, {"id": "bad", "score": float("nan")}]
        gen = JsonlFormat().serialize(iter(rows))

        assert next(gen) == b'{"id":"ok"}\n'
        with pytest.raises(ExportNonFiniteError):
            next(gen)

    def test_document_id_falls_back_to_dollar_id(self) -> None:
        rows = [{"$id": "PK-9", "id": "USER-9", "score": float("nan")}]

        with pytest.raises(ExportNonFiniteError) as exc:
            b"".join(JsonlFormat().serialize(iter(rows)))

        assert exc.value.extra["documentId"] == "PK-9"
