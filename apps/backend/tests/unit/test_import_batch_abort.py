"""Unit tests for the abort-mode batch fallback in the import pipeline.

When the SDK rejects a whole batch with a ``ValueError`` (batch-level
validation), ``abort`` must behave like the other abort paths: rows that
were already validated inside the same batch still land, and the import
stops at the first failing row — not silently discard everything.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import zvec

from zvec_studio.schemas.collection import (
    CollectionSchema,
    VectorDataType,
    VectorSchema,
)
from zvec_studio.storage.import_ import ImportMode, ImportReport, OnErrorMode
from zvec_studio.storage.sdk import CollectionRecord, SdkBackend


class _FakeStatus:
    def __init__(self, ok: bool) -> None:
        self._ok = ok

    def ok(self) -> bool:
        return self._ok


class _BatchRejectingSdk:
    """Rejects multi-doc writes with ValueError; single-doc writes succeed
    unless the id is the planted bad row."""

    def __init__(self, bad_id: str) -> None:
        self.bad_id = bad_id
        self.written: list[str] = []

    def insert(self, docs: list) -> list[_FakeStatus]:
        if len(docs) > 1:
            raise ValueError(f"Invalid doc[{self.bad_id}]: batch-level rejection")
        doc = docs[0]
        if doc.id == self.bad_id:
            raise ValueError(f"Invalid doc[{self.bad_id}]: bad row")
        self.written.append(doc.id)
        return [_FakeStatus(True)]

    upsert = insert


def _record(sdk: _BatchRejectingSdk) -> CollectionRecord:
    schema = CollectionSchema.model_construct(
        name="target",
        vectors=[
            VectorSchema(name="embedding", dataType=VectorDataType.VECTOR_FP32, dimension=2)
        ],
        fields=[],
    )
    return CollectionRecord(
        name="target", path=Path("/tmp/target"), schema=schema, sdk_obj=sdk
    )


def _docs(*ids: str) -> list:
    return [zvec.Doc(id=i, vectors={"embedding": [0.1, 0.2]}) for i in ids]


class TestAbortBatchFallback:
    def test_abort_keeps_prior_rows_on_batch_value_error(self) -> None:
        sdk = _BatchRejectingSdk(bad_id="doc-1")
        backend = SdkBackend()
        report = ImportReport()

        keep_going = backend._import_write_batch(
            _record(sdk),
            _docs("doc-0", "doc-1", "doc-2"),
            [1, 2, 3],
            mode=ImportMode.INSERT,
            on_error=OnErrorMode.ABORT,
            report=report,
        )

        assert keep_going is False  # abort
        # The valid row before the failing one still landed.
        assert sdk.written == ["doc-0"]
        assert report.imported == 1
        assert report.failed == 1
        # Exact line of the offending row (not best-effort).
        assert report.errors[0].line == 2
        assert report.errors[0].code == "INVALID_DOCUMENT"

    def test_skip_still_locates_every_offending_row(self) -> None:
        """Regression guard: the pre-existing skip behaviour is unchanged."""
        sdk = _BatchRejectingSdk(bad_id="doc-1")
        backend = SdkBackend()
        report = ImportReport()

        keep_going = backend._import_write_batch(
            _record(sdk),
            _docs("doc-0", "doc-1", "doc-2"),
            [1, 2, 3],
            mode=ImportMode.INSERT,
            on_error=OnErrorMode.SKIP,
            report=report,
        )

        assert keep_going is True
        assert sdk.written == ["doc-0", "doc-2"]
        assert report.imported == 2
        assert [(e.line, e.code) for e in report.errors] == [(2, "INVALID_DOCUMENT")]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
