"""Document CRUD + Filter Browser endpoints (Zvec 0.4.x).

The legacy ``GET /documents?cursor=...`` listing was removed in v0.2.0: Zvec
0.4.x has no ``list_all`` API and exposing a synthetic full-table walker over
``query`` would mislead users. The canonical browser is now
``POST /collections/{name}/documents:browse`` which forwards a SQL-WHERE
``filter`` straight to the SDK.
"""

from __future__ import annotations

import itertools
import shutil
import tempfile
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path as _Path
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, status
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from zvec_studio.exceptions import ZvecStudioError
from zvec_studio.schemas import (
    DocumentBatchDeleteRequest,
    DocumentBatchDeleteResponse,
    DocumentBrowseRequest,
    DocumentBrowseResponse,
    DocumentDeleteByFilterRequest,
    DocumentDeleteByFilterResponse,
    DocumentImportErrorEntry,
    DocumentImportRequest,
    DocumentImportResponse,
    DocumentInsertRequest,
    DocumentInsertResponse,
    DocumentUpdateRequest,
    DocumentUpdateResponse,
    DocumentUpsertRequest,
    DocumentUpsertResponse,
)
from zvec_studio.storage import SdkBackend
from zvec_studio.storage.formats import resolve_export_format, resolve_import_format
from zvec_studio.storage.import_ import ImportMode, ImportReport, OnErrorMode
from zvec_studio.storage.snapshot import (
    build_manifest,
    pack_snapshot,
    write_snapshot_package,
)

router = APIRouter(prefix="/collections/{name}/documents", tags=["documents"])


def _get_backend(request: Request) -> SdkBackend:
    backend: SdkBackend = request.app.state.backend
    return backend


def _resolve(backend: SdkBackend, name: str, path: str | None) -> str:
    """Resolve collection name to its canonical name using optional path hint."""
    record = backend.get(name, path=path)
    return record.name


@router.post(
    ":browse",
    response_model=DocumentBrowseResponse,
)
def browse_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentBrowseRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentBrowseResponse:
    """Filter Browser.

    Returns up to ``limit`` rows that match ``filter`` (SQL-WHERE syntax,
    e.g. ``category = 'tech' AND year > 2020``). When the page is full we set
    ``truncated=true`` so the UI can prompt for a tighter filter.
    """
    items = backend.browse(
        _resolve(backend, name, path),
        filter_expr=body.filter,
        limit=body.limit,
        output_fields=body.outputFields,
        include_vector=body.includeVector,
    )
    return DocumentBrowseResponse(items=items, truncated=len(items) >= body.limit)


@router.get("/{doc_id}")
def get_document(
    name: Annotated[str, Path(min_length=1)],
    doc_id: Annotated[str, Path(min_length=1)],
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> dict[str, Any]:
    return backend.get_document(_resolve(backend, name, path), doc_id)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=DocumentInsertResponse,
)
def insert_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentInsertRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentInsertResponse:
    ids = backend.insert_documents(_resolve(backend, name, path), body.documents)
    return DocumentInsertResponse(inserted=len(ids), ids=ids)


@router.delete("/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_document(
    name: Annotated[str, Path(min_length=1)],
    doc_id: Annotated[str, Path(min_length=1)],
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> None:
    backend.delete_document(_resolve(backend, name, path), doc_id)


@router.post(":deleteBatch", response_model=DocumentBatchDeleteResponse)
def delete_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentBatchDeleteRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentBatchDeleteResponse:
    deleted = backend.delete_documents(_resolve(backend, name, path), body.ids)
    return DocumentBatchDeleteResponse(deleted=deleted)


@router.post(
    ":upsert",
    response_model=DocumentUpsertResponse,
)
def upsert_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentUpsertRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentUpsertResponse:
    """Insert-or-update by ``id``.

    Mirrors :meth:`zvec.Collection.upsert`: documents that already exist (by
    ``id``) are replaced; new ids are inserted. Auto-generated ULIDs are used
    for any payload missing an explicit id.
    """
    ids = backend.upsert_documents(_resolve(backend, name, path), body.documents)
    return DocumentUpsertResponse(upserted=len(ids), ids=ids)


@router.patch("", response_model=DocumentUpdateResponse)
def update_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentUpdateRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentUpdateResponse:
    """Partial update by ``id`` — omitted columns are preserved.

    Each payload entry MUST carry an explicit ``id`` that already exists in
    the collection; only the keys present in the entry are mutated.
    """
    ids = backend.update_documents(_resolve(backend, name, path), body.documents)
    return DocumentUpdateResponse(updated=len(ids), ids=ids)


@router.post(
    ":deleteByFilter",
    response_model=DocumentDeleteByFilterResponse,
)
def delete_by_filter(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentDeleteByFilterRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentDeleteByFilterResponse:
    deleted = backend.delete_by_filter(_resolve(backend, name, path), body.filter)
    return DocumentDeleteByFilterResponse(deleted=deleted)


@router.post(
    ":import",
    response_model=DocumentImportResponse,
)
def import_documents(
    name: Annotated[str, Path(min_length=1)],
    body: DocumentImportRequest,
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
) -> DocumentImportResponse:
    """Bulk-import documents from a JSONL file, streaming.

    The file is read from the backend's local filesystem (Studio is
    local-first — the file lives on the same machine), parsed row by row,
    and written in SDK-sized batches. Row-level failures are reported in the
    200 body (partial-success semantics); only request-level problems (bad
    format, unreadable file, unknown collection) surface as 4xx.

    ``format`` defaults to the file extension; extension-less files are
    treated as JSONL. Snapshot packages (``.tar.gz`` / ``.tgz``) always
    carry a JSONL data member, so their format resolves to ``jsonl``.
    """
    source_path = body.source.path
    if source_path.lower().endswith((".tar.gz", ".tgz")):
        fmt_name = body.format or "jsonl"
    else:
        fmt_name = body.format or _Path(source_path).suffix.lstrip(".") or "jsonl"
    fmt = resolve_import_format(fmt_name)

    extra: dict[str, Any] = {}
    if body.batchSize is not None:
        extra["batch_size"] = body.batchSize
    report = backend.import_documents(
        _resolve(backend, name, path),
        source_path=source_path,
        fmt=fmt,
        mode=ImportMode(body.mode),
        on_error=OnErrorMode(body.onError),
        **extra,
    )
    return import_report_to_response(report)


def import_report_to_response(report: ImportReport) -> DocumentImportResponse:
    """Map the storage-layer ``ImportReport`` onto its HTTP payload.

    Shared with the collection-level ``:import`` endpoint, which embeds
    the same row-level report in its response.
    """
    return DocumentImportResponse(
        imported=report.imported,
        failed=report.failed,
        totalLines=report.total_lines,
        aborted=report.aborted,
        durationMs=report.duration_ms,
        errors=[
            DocumentImportErrorEntry(line=e.line, code=e.code, message=e.message)
            for e in report.errors
        ],
        errorsTruncated=report.errors_truncated,
    )


@router.get(":export")
def export_documents(
    name: Annotated[str, Path(min_length=1)],
    backend: Annotated[SdkBackend, Depends(_get_backend)],
    path: str | None = Query(default=None),
    includeVector: Annotated[
        bool,
        Query(description="Include vector data in each row (default true)."),
    ] = True,
    includeFields: Annotated[
        bool,
        Query(description="Include scalar fields in each row (default true)."),
    ] = True,
    outputFields: Annotated[
        str | None,
        Query(description="Comma-separated scalar fields to include; omit for all."),
    ] = None,
    format: Annotated[
        str,
        Query(description="Export format name. Supported: jsonl."),
    ] = "jsonl",
    mode: Annotated[
        Literal["data", "snapshot"],
        Query(
            description=(
                "data: a single JSONL file. snapshot: manifest.json + JSONL "
                "bundled in a tar.gz (carries the schema for migration)."
            )
        ),
    ] = "data",
) -> StreamingResponse:
    """Stream every document in the collection as a downloadable file.

    Uses the SDK snapshot iterator (constant memory; writes during the export
    are invisible to it), so arbitrarily large collections can be exported.
    The response is chunked — the frontend must trigger a *native* download
    (``<a download>``), never ``fetch().blob()``, which would buffer the whole
    body in memory.

    In ``data`` mode the first chunk is pulled eagerly so failures that occur
    before any byte is sent (blocked iterator, non-finite value in the first
    row) still map to a proper 4xx/5xx instead of truncating a stream that
    already started. In ``snapshot`` mode the JSONL is staged in a temp dir
    first (a tar member must declare its size up front), then the tar.gz is
    streamed; the temp dir is removed after the response finishes.
    """
    fmt = resolve_export_format(format)
    resolved = _resolve(backend, name, path)
    fields = (
        [f.strip() for f in outputFields.split(",") if f.strip()] if outputFields else None
    )
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    if mode == "snapshot":
        tmp_dir = _Path(tempfile.mkdtemp(prefix="zvec-studio-export-"))
        try:
            record = backend.get(resolved)
            manifest = build_manifest(
                schema=record.schema,
                include_vector=includeVector,
                # An empty list is meaningful: it prunes every scalar column.
                output_fields=fields if includeFields else [],
            )
            rows = backend.iter_documents(
                resolved,
                include_vector=includeVector,
                output_fields=fields,
                include_fields=includeFields,
            )
            manifest_path, data_path = write_snapshot_package(
                rows=rows, serialize=fmt.serialize, manifest=manifest, tmp_dir=tmp_dir
            )
            package_path = tmp_dir / "package.tar.gz"
            pack_snapshot(
                manifest_path=manifest_path, data_path=data_path, out_path=package_path
            )
        except RuntimeError as exc:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise ZvecStudioError(
                f"Export cannot start: {exc}",
                code="EXPORT_BLOCKED",
                status_code=409,
            ) from exc
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        def file_chunks(path: _Path) -> Iterator[bytes]:
            """Yield *path* in 256 KiB chunks, closing promptly on disconnect."""
            with path.open("rb") as f:
                while chunk := f.read(256 * 1024):
                    yield chunk

        return StreamingResponse(
            file_chunks(package_path),
            media_type="application/gzip",
            headers={
                "Content-Disposition": f'attachment; filename="{resolved}-{stamp}.tar.gz"'
            },
            background=BackgroundTask(shutil.rmtree, str(tmp_dir), True),
        )

    rows = backend.iter_documents(
        resolved,
        include_vector=includeVector,
        output_fields=fields,
        include_fields=includeFields,
    )
    chunks = fmt.serialize(rows)

    try:
        first = next(chunks)
    except StopIteration:
        body: Any = iter(())
    except RuntimeError as exc:
        # The SDK raises while an iterator cannot be opened (e.g. a
        # maintenance op is running) — surface as a retryable 409.
        raise ZvecStudioError(
            f"Export cannot start: {exc}",
            code="EXPORT_BLOCKED",
            status_code=409,
        ) from exc
    else:
        body = itertools.chain((first,), chunks)

    filename = f"{resolved}-{stamp}.{fmt.extension}"
    return StreamingResponse(
        body,
        media_type=fmt.content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
