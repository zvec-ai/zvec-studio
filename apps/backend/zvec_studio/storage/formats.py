"""Import/export format protocols.

The format is the only variable piece of the import/export pipeline (design
doc §4.2). An :class:`ImportFormat` turns a byte stream into ``(line number,
record)`` pairs; formats are looked up by name or file extension through a
registry. Shipping JSONL today keeps the dependency surface empty (orjson is
already a core dependency); CSV/Parquet can join later by implementing the
protocol and registering — the pipeline itself stays untouched.
"""

from __future__ import annotations

import math
from collections.abc import Iterator
from typing import Any, BinaryIO, Protocol, runtime_checkable

import orjson

from zvec_studio.exceptions import ExportNonFiniteError, InvalidDocumentError
from zvec_studio.storage.doc_repr import PK_KEY, RESERVED_PK_KEY


@runtime_checkable
class ImportFormat(Protocol):
    """Parses a file byte stream into ``(line number, record)`` pairs.

    ``line number`` is the 1-based physical line the record came from, so
    downstream errors can point the user at the exact spot in their editor.
    Implementations must stream: holding more than the current record is
    forbidden (files may be gigabytes).
    """

    name: str
    extensions: tuple[str, ...]

    def parse(self, stream: BinaryIO) -> Iterator[tuple[int, dict[str, Any]]]: ...


@runtime_checkable
class ExportFormat(Protocol):
    """Serializes document rows into file bytes (used by the export API)."""

    name: str
    content_type: str
    extension: str

    def serialize(self, rows: Iterator[dict[str, Any]]) -> Iterator[bytes]: ...


def _row_document_id(row: dict[str, Any]) -> str:
    """Best-effort primary key for error reporting (``$id`` wins over ``id``).

    Key order mirrors :mod:`zvec_studio.storage.doc_repr` — the reserved key
    wins whenever the schema declares its own ``id`` column.
    """
    for key in (RESERVED_PK_KEY, PK_KEY):
        value = row.get(key)
        if value is not None:
            return str(value)
    return "<unknown>"


def _check_finite(value: Any, *, path: str, document_id: str) -> None:
    """Raise :class:`ExportNonFiniteError` at the first NaN/±Inf found.

    Walks scalars, lists and dicts so vectors (``list[float]``), sparse
    vectors (``{index: weight}``) and array fields are all covered.

    Lists (the vector hot path) are scanned in one pass without per-element
    recursion or path strings; the path is only built when an offender or a
    nested container needs to be located.
    """
    if isinstance(value, bool):
        return
    if isinstance(value, float) and not math.isfinite(value):
        raise ExportNonFiniteError(
            f"Document {document_id} contains a non-finite value at '{path}'.",
            extra={"documentId": document_id, "path": path},
        )
    if isinstance(value, list):
        for i, item in enumerate(value):
            if isinstance(item, float):
                if math.isfinite(item):
                    continue
                loc = f"{path}[{i}]"
                raise ExportNonFiniteError(
                    f"Document {document_id} contains a non-finite value at '{loc}'.",
                    extra={"documentId": document_id, "path": loc},
                )
            if isinstance(item, list | dict):
                _check_finite(item, path=f"{path}[{i}]", document_id=document_id)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _check_finite(v, path=f"{path}.{k}", document_id=document_id)


class _JsonlLines:
    """Stateful line iterator for :class:`JsonlFormat`.

    Deliberately a class (not a generator): after raising on a bad line the
    iterator must keep going — ``skip``-mode imports continue past row
    errors, and a generator would be finished by the first raise.
    """

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._line_number = 0

    def __iter__(self) -> _JsonlLines:
        return self

    def __next__(self) -> tuple[int, dict[str, Any]]:
        while True:
            raw = self._stream.readline()
            if not raw:
                raise StopIteration
            self._line_number += 1
            text = raw.strip()
            if not text:
                continue
            try:
                record = orjson.loads(text)
            except orjson.JSONDecodeError as exc:
                raise InvalidDocumentError(
                    f"Line {self._line_number} is not valid JSON: {exc}",
                    code="INVALID_DOCUMENT",
                    extra={"line": self._line_number},
                ) from exc
            if not isinstance(record, dict):
                raise InvalidDocumentError(
                    f"Line {self._line_number} must be a JSON object, got "
                    f"{type(record).__name__}.",
                    code="INVALID_DOCUMENT",
                    extra={"line": self._line_number},
                )
            return self._line_number, record


class JsonlFormat:
    """JSON Lines: one JSON object per line, UTF-8.

    The row structure matches the document API representation (see
    ``storage/doc_repr.py``) so exports can be re-imported verbatim.
    """

    name = "jsonl"
    content_type = "application/x-ndjson"
    extension = "jsonl"
    # Annotated so mypy widens the literal to the protocol's
    # ``tuple[str, ...]`` (a bare literal infers as fixed-length).
    extensions: tuple[str, ...] = ("jsonl", "ndjson")

    def parse(self, stream: BinaryIO) -> Iterator[tuple[int, dict[str, Any]]]:
        return _JsonlLines(stream)

    def serialize(self, rows: Iterator[dict[str, Any]]) -> Iterator[bytes]:
        """Yield one ``\\n``-terminated JSON line per row, lazily.

        Each row is validated for non-finite floats *before* serialization:
        orjson would otherwise coerce NaN/±Inf to ``null`` (silent data loss).
        ``OPT_NON_STR_KEYS`` lets sparse vectors keep their ``int`` indexes
        (orjson rejects non-str dict keys otherwise).
        """
        for row in rows:
            document_id = _row_document_id(row)
            for key, value in row.items():
                _check_finite(value, path=key, document_id=document_id)
            yield orjson.dumps(row, option=orjson.OPT_NON_STR_KEYS) + b"\n"


#: Import formats keyed by canonical name; extensions also resolve here.
IMPORT_FORMATS: dict[str, ImportFormat] = {
    "jsonl": JsonlFormat(),
}

#: Export formats keyed by canonical name (consumed by
#: ``routers/documents.py::export_documents``).
EXPORT_FORMATS: dict[str, ExportFormat] = {
    "jsonl": JsonlFormat(),
}

_EXTENSION_TO_FORMAT: dict[str, ImportFormat] = {
    ext: fmt for fmt in IMPORT_FORMATS.values() for ext in fmt.extensions
}


def resolve_import_format(name_or_extension: str) -> ImportFormat:
    """Look up an import format by name or file extension (case-insensitive).

    Raises:
        InvalidDocumentError: with code ``IMPORT_UNSUPPORTED_FORMAT`` (400)
            when the value matches nothing; the message lists what is
            supported so the caller can fix it.
    """
    key = name_or_extension.strip().lower().lstrip(".")
    fmt = IMPORT_FORMATS.get(key) or _EXTENSION_TO_FORMAT.get(key)
    if fmt is None:
        supported = ", ".join(sorted(IMPORT_FORMATS))
        raise InvalidDocumentError(
            f"Unsupported import format '{name_or_extension}'. Supported: {supported}.",
            code="IMPORT_UNSUPPORTED_FORMAT",
            status_code=400,
            extra={"format": name_or_extension, "supported": sorted(IMPORT_FORMATS)},
        )
    return fmt


def resolve_export_format(name: str) -> ExportFormat:
    """Look up an export format by name (case-insensitive).

    Raises:
        InvalidDocumentError: with code ``EXPORT_UNSUPPORTED_FORMAT`` (400)
            when the name matches nothing; the message lists what is
            supported so the caller can fix it.
    """
    key = name.strip().lower()
    fmt = EXPORT_FORMATS.get(key)
    if fmt is None:
        supported = ", ".join(sorted(EXPORT_FORMATS))
        raise InvalidDocumentError(
            f"Unsupported export format '{name}'. Supported: {supported}.",
            code="EXPORT_UNSUPPORTED_FORMAT",
            status_code=400,
            extra={"format": name, "supported": sorted(EXPORT_FORMATS)},
        )
    return fmt
