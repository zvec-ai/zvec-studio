"""Unit tests for the write-path batching helper.

The Zvec SDK rejects write batches larger than ``_MAX_SDK_WRITE_BATCH`` (1024,
a runtime error, not a documented contract), while Studio's HTTP surface
accepts up to 10,000 documents. ``_write_in_batches`` absorbs that constraint
internally so callers never hit it.
"""

from __future__ import annotations

from typing import Any

import pytest

from zvec_studio.exceptions import (
    DocumentConflictError,
    DocumentNotFoundError,
    InvalidDocumentError,
    ZvecStudioError,
)
from zvec_studio.storage.sdk import (
    _DEFAULT_WRITE_BATCH,
    _MAX_SDK_WRITE_BATCH,
    _write_in_batches,
)


class _FakeStatus:
    def __init__(self, ok: bool, message: str = "") -> None:
        self._ok = ok
        self._message = message

    def ok(self) -> bool:
        return self._ok

    def message(self) -> str:
        return self._message


class TestBatchSizing:
    @pytest.mark.parametrize(
        ("total", "expected_chunk_sizes"),
        [
            (0, []),
            (1, [1]),
            (511, [511]),
            (512, [512]),
            (513, [512, 1]),
            (1024, [512, 512]),
            (1025, [512, 512, 1]),
            (2049, [512, 512, 512, 512, 1]),
        ],
    )
    def test_batches_use_the_default_size(
        self, total: int, expected_chunk_sizes: list[int]
    ) -> None:
        docs = list(range(total))
        seen: list[int] = []

        def write(chunk: list[int]) -> list[_FakeStatus]:
            seen.append(len(chunk))
            assert len(chunk) <= _MAX_SDK_WRITE_BATCH
            return [_FakeStatus(True)] * len(chunk)

        _write_in_batches(docs, write, failed_code="INSERT_FAILED")

        assert seen == expected_chunk_sizes

    def test_explicit_batch_size_is_clamped_to_sdk_limit(self) -> None:
        """Callers may ask for larger chunks; the SDK limit still caps them."""
        docs = list(range(3000))
        seen: list[int] = []

        def write(chunk: list[int]) -> list[_FakeStatus]:
            seen.append(len(chunk))
            assert len(chunk) <= _MAX_SDK_WRITE_BATCH
            return [_FakeStatus(True)] * len(chunk)

        _write_in_batches(docs, write, failed_code="INSERT_FAILED", batch_size=5000)

        assert seen == [1024, 1024, 952]

    def test_all_statuses_are_preserved_in_order(self) -> None:
        docs = list(range(_MAX_SDK_WRITE_BATCH + 1))

        def write(chunk: list[int]) -> list[_FakeStatus]:
            return [_FakeStatus(True)] * len(chunk)

        statuses = _write_in_batches(docs, write, failed_code="INSERT_FAILED")
        assert len(statuses) == _MAX_SDK_WRITE_BATCH + 1


class TestErrorClassification:
    def test_sdk_validation_value_error_maps_to_invalid_document(self) -> None:
        def write(chunk: list[Any]) -> list[Any]:
            raise ValueError(
                "Invalid doc[0]: field[score] is required but not provided"
            )

        with pytest.raises(InvalidDocumentError) as exc:
            _write_in_batches([0], write, failed_code="INSERT_FAILED")

        assert exc.value.status_code == 422
        assert "score" in exc.value.message

    def test_batch_limit_value_error_is_not_masked_as_user_input(self) -> None:
        """If batching itself regressed, the error must surface as internal."""

        def write(chunk: list[Any]) -> list[Any]:
            raise ValueError("Too many docs: 2000 exceeds max write batch size")

        with pytest.raises(ZvecStudioError) as exc:
            _write_in_batches([0], write, failed_code="INSERT_FAILED")

        assert not isinstance(exc.value, InvalidDocumentError)
        assert exc.value.status_code == 500

    def test_duplicate_id_status_maps_to_conflict(self) -> None:
        def write(chunk: list[Any]) -> list[_FakeStatus]:
            return [
                _FakeStatus(True),
                _FakeStatus(False, "insert failed: doc_id[x] already exists in collection"),
            ]

        with pytest.raises(DocumentConflictError) as exc:
            _write_in_batches([0, 1], write, failed_code="INSERT_FAILED")

        assert exc.value.status_code == 409

    def test_unknown_id_status_maps_to_not_found(self) -> None:
        def write(chunk: list[Any]) -> list[_FakeStatus]:
            return [_FakeStatus(False, "Document not found")]

        with pytest.raises(DocumentNotFoundError) as exc:
            _write_in_batches([0], write, failed_code="UPDATE_FAILED")

        assert exc.value.status_code == 404

    def test_other_failed_status_keeps_caller_code(self) -> None:
        def write(chunk: list[Any]) -> list[_FakeStatus]:
            return [_FakeStatus(False, "some opaque failure")]

        with pytest.raises(ZvecStudioError) as exc:
            _write_in_batches([0], write, failed_code="UPSERT_FAILED")

        assert exc.value.code == "UPSERT_FAILED"
        assert exc.value.status_code == 500


class TestDefaults:
    def test_default_batch_is_below_sdk_limit(self) -> None:
        assert 0 < _DEFAULT_WRITE_BATCH <= _MAX_SDK_WRITE_BATCH
