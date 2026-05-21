"""Document CRUD + Filter Browser endpoints (Zvec 0.4.x).

The legacy ``GET /documents?cursor=...`` listing was removed in v0.2.0: Zvec
0.4.x has no ``list_all`` API and exposing a synthetic full-table walker over
``query`` would mislead users. The canonical browser is now
``POST /collections/{name}/documents:browse`` which forwards a SQL-WHERE
``filter`` straight to the SDK.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request, status

from zvec_studio.schemas import (
    DocumentBatchDeleteRequest,
    DocumentBatchDeleteResponse,
    DocumentBrowseRequest,
    DocumentBrowseResponse,
    DocumentDeleteByFilterRequest,
    DocumentDeleteByFilterResponse,
    DocumentInsertRequest,
    DocumentInsertResponse,
    DocumentUpdateRequest,
    DocumentUpdateResponse,
    DocumentUpsertRequest,
    DocumentUpsertResponse,
)
from zvec_studio.storage import SdkBackend

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
