"""Collection management endpoints."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request, status

from zvec_studio.config_store import ConfigStore
from zvec_studio.schemas import (
    CollectionCreateRequest,
    CollectionListItem,
    CollectionListResponse,
    CollectionOpenRequest,
    CollectionSchema,
    CollectionStats,
    CollectionSummary,
    FieldAddRequest,
    FieldRenameRequest,
    IndexCreateRequest,
    MaintenanceResponse,
    RecentCollectionItem,
    RecentCollectionListResponse,
    RecentForgetRequest,
    ScalarIndexCreateRequest,
    VectorIndexParam,
)
from zvec_studio.storage import CollectionRecord, SdkBackend

router = APIRouter(prefix="/collections", tags=["collections"])


def _normalise_path(raw: str) -> Path:
    """Expand ``~`` and resolve to an absolute path before handing to backends.

    Users (and browser pickers) often supply relative paths or a bare directory
    name. Resolving here means the persisted schema/metadata lives at a path
    the user can actually inspect on disk, and the summary we return always
    reflects the real location — not whatever string happened to arrive in the
    request body.
    """
    return Path(raw).expanduser().resolve()


def _summary(record: CollectionRecord, backend: SdkBackend) -> CollectionSummary:
    return CollectionSummary.model_validate(
        {
            "name": record.name,
            "path": str(record.path),
            "schema": record.schema,
            "stats": backend.stats(record.name, path=str(record.path)),
        }
    )


def _get_backend(request: Request) -> SdkBackend:
    backend: SdkBackend = request.app.state.backend
    return backend


def _get_config_store(request: Request) -> ConfigStore:
    store: ConfigStore = request.app.state.config_store
    return store


@router.get("", response_model=CollectionListResponse)
def list_collections(
    backend: SdkBackend = Depends(_get_backend),
) -> CollectionListResponse:
    """List collections currently **opened in this server process**.

    The result is sourced from :class:`SdkBackend`'s in-memory registry, so
    every entry here represents a collection whose underlying SDK handle is
    live and ready to serve queries. Closing or destroying a collection
    removes it from this list immediately. For the persistent
    *recently opened* history (which survives process restarts) see
    :func:`list_recent` (``GET /collections/recent``).
    """
    items = [
        CollectionListItem(name=r.name, path=str(r.path)) for r in backend.list_all()
    ]
    return CollectionListResponse(items=items)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=CollectionSummary)
def create_collection(
    body: CollectionCreateRequest,
    backend: SdkBackend = Depends(_get_backend),
    store: ConfigStore = Depends(_get_config_store),
) -> CollectionSummary:
    record = backend.create(path=_normalise_path(body.path), schema=body.schema_)
    store.touch_recent(record.path, name=record.name)
    return _summary(record, backend)


@router.post("/open", response_model=CollectionSummary)
def open_collection(
    body: CollectionOpenRequest,
    backend: SdkBackend = Depends(_get_backend),
    store: ConfigStore = Depends(_get_config_store),
) -> CollectionSummary:
    record = backend.open(_normalise_path(body.path))
    store.touch_recent(record.path, name=record.name)
    return _summary(record, backend)


# ---------------------------------------------------------------------------
# Recent collections (workspace helper). MUST be declared before ``/{name}``
# so the literal ``recent`` segment matches first; ``recent`` is also marked
# as a reserved collection name in the schema layer to keep the two
# namespaces from ever colliding.
# ---------------------------------------------------------------------------


@router.get("/recent", response_model=RecentCollectionListResponse)
def list_recent(
    store: ConfigStore = Depends(_get_config_store),
    backend: SdkBackend = Depends(_get_backend),
) -> RecentCollectionListResponse:
    """List recently opened collections (most-recent first, capped at 10).

    Persisted to ``<data_dir>/config.json``; survives process restarts.
    Distinct from :func:`list_collections` which only reflects the **currently
    opened** in-memory set. Each entry is identified by absolute disk path
    and carries a ``lastOpenedAt`` ISO-8601 timestamp.
    """
    open_by_path = {str(r.path): r.name for r in backend.list_all()}
    items: list[RecentCollectionItem] = []
    for e in store.list_recent():
        name = e.name or open_by_path.get(e.path)
        items.append(RecentCollectionItem(path=e.path, name=name, lastOpenedAt=e.lastOpenedAt))
    return RecentCollectionListResponse(items=items)


@router.delete("/recent", status_code=status.HTTP_204_NO_CONTENT)
def clear_recent(
    store: ConfigStore = Depends(_get_config_store),
) -> None:
    """Drop every entry from the recent list. Idempotent."""
    store.clear_recent()


@router.post("/recent:forget", status_code=status.HTTP_204_NO_CONTENT)
def forget_recent(
    body: RecentForgetRequest,
    store: ConfigStore = Depends(_get_config_store),
) -> None:
    """Remove a single path from the recent list.

    Idempotent: a path that was never recorded still returns 204. The
    gateway resolves ``~`` and relative segments on the request side before
    matching against the canonical absolute paths kept on disk.
    """
    store.forget_recent(body.path)


@router.get("/{name}", response_model=CollectionSummary)
def get_collection(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    """Standard *Get* (AIP-131) for a single opened collection.

    Returns the aggregate :class:`CollectionSummary` (name, path, schema,
    stats) so detail-page clients can render everything in one round trip.
    Returns 404 ``COLLECTION_NOT_FOUND`` if the name is not currently opened
    in this process — callers can therefore use this endpoint as an
    existence/state probe. For partial reads (only ``schema`` or only
    ``stats``) prefer the dedicated sub-resource endpoints below.
    """
    return _summary(backend.get(name, path=path), backend)


@router.get("/{name}/schema", response_model=CollectionSchema)
def get_schema(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSchema:
    return backend.get(name, path=path).schema


@router.get("/{name}/stats", response_model=CollectionStats)
def get_stats(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionStats:
    return backend.stats(name, path=path)


@router.delete("/{name}", status_code=status.HTTP_204_NO_CONTENT)
def close_collection(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> None:
    backend.close(name, path=path)


# ---------------------------------------------------------------------------
# Maintenance / lifecycle endpoints (Zvec ``flush`` / ``optimize`` / ``destroy``)
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat(timespec="seconds")


@router.post("/{name}:flush", response_model=MaintenanceResponse)
def flush_collection(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> MaintenanceResponse:
    backend.flush(name, path=path)
    return MaintenanceResponse(operation="flush", timestamp=_now_iso())


@router.post("/{name}:optimize", response_model=MaintenanceResponse)
def optimize_collection(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> MaintenanceResponse:
    backend.optimize(name, path=path)
    return MaintenanceResponse(operation="optimize", timestamp=_now_iso())


@router.post("/{name}:destroy", status_code=status.HTTP_204_NO_CONTENT)
def destroy_collection(
    name: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> None:
    backend.destroy(name, path=path)


# ---------------------------------------------------------------------------
# DDL: scalar fields
# ---------------------------------------------------------------------------


@router.post(
    "/{name}/fields",
    status_code=status.HTTP_201_CREATED,
    response_model=CollectionSummary,
)
def add_field(
    name: str,
    body: FieldAddRequest,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    record = backend.add_field(name, field=body.field, expression=body.expression)
    return _summary(record, backend)


@router.delete("/{name}/fields/{field}", response_model=CollectionSummary)
def drop_field(
    name: str,
    field: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    record = backend.drop_field(name, field)
    return _summary(record, backend)


@router.patch("/{name}/fields/{field}", response_model=CollectionSummary)
def rename_field(
    name: str,
    field: str,
    body: FieldRenameRequest,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    record = backend.rename_field(name, old_name=field, new_name=body.newName)
    return _summary(record, backend)


# ---------------------------------------------------------------------------
# DDL: vector indexes
# ---------------------------------------------------------------------------


@router.post(
    "/{name}/indexes",
    status_code=status.HTTP_201_CREATED,
    response_model=CollectionSummary,
)
def create_index(
    name: str,
    body: IndexCreateRequest,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    param = VectorIndexParam(
        indexType=body.indexType, metric=body.metric, params=body.params
    )
    record = backend.create_index(name, vector_field=body.vectorField, index_param=param)
    return _summary(record, backend)


@router.delete(
    "/{name}/indexes/{vector_field}", response_model=CollectionSummary
)
def drop_index(
    name: str,
    vector_field: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    record = backend.drop_index(name, vector_field)
    return _summary(record, backend)


# ---------------------------------------------------------------------------
# DDL: scalar indexes
# ---------------------------------------------------------------------------


@router.post(
    "/{name}/fields/{field}/index",
    status_code=status.HTTP_201_CREATED,
    response_model=CollectionSummary,
)
def create_scalar_index(
    name: str,
    field: str,
    body: ScalarIndexCreateRequest | None = None,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    b = body or ScalarIndexCreateRequest()
    record = backend.create_scalar_index(
        name,
        field_name=field,
        enable_range_optimization=b.enableRangeOptimization,
        enable_extended_wildcard=b.enableExtendedWildcard,
    )
    return _summary(record, backend)


@router.delete(
    "/{name}/fields/{field}/index", response_model=CollectionSummary
)
def drop_scalar_index(
    name: str,
    field: str,
    backend: SdkBackend = Depends(_get_backend),
    path: str | None = Query(default=None),
) -> CollectionSummary:
    record = backend.drop_scalar_index(name, field)
    return _summary(record, backend)
