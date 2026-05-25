"""Zvec SDK-backed Collection backend (production, sole implementation).

Persists collections via the real ``zvec.create_and_open`` / ``zvec.open``
calls.  The SDK itself stores all schema metadata (including index params
and metric choices) in its on-disk manifest, so no extra sidecar file is
needed.  ``open(path)`` recovers the full schema via ``collection.schema``.

Filter expressions follow Zvec's SQL-WHERE dialect (single ``=`` not ``==``,
single quotes for strings). They are passed through verbatim to ``query`` /
``delete_by_filter``; syntax errors are mapped to
:class:`InvalidFilterExpressionError`.

This module also defines the in-memory :class:`CollectionRecord` handle that
routers consume.  It used to live alongside a separate ``CollectionBackend``
Protocol + ``InMemoryBackend`` test double; both were removed once the SDK
became the only backend.
"""

from __future__ import annotations

import gc
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any

import zvec
from ulid import ULID
from zvec import (
    CollectionSchema as SdkCollectionSchema,
)
from zvec import (
    DataType as SdkDataType,
)
from zvec import (
    Doc as SdkDoc,
)
from zvec import (
    FieldSchema as SdkFieldSchema,
)
from zvec import (
    FlatIndexParam,
    HnswIndexParam,
    HnswQueryParam,
    HnswRabitqIndexParam,
    HnswRabitqQueryParam,
    InvertIndexParam,
    IVFIndexParam,
    IVFQueryParam,
    VamanaIndexParam,
    VamanaQueryParam,
)
from zvec import (
    MetricType as SdkMetricType,
)
from zvec import (
    VectorQuery as SdkVectorQuery,
)
from zvec import (
    VectorSchema as SdkVectorSchema,
)

from zvec_studio.exceptions import (
    CollectionAlreadyExistsError,
    CollectionNotFoundError,
    DimensionMismatchError,
    DocumentNotFoundError,
    InvalidFilterExpressionError,
    InvalidSchemaError,
    ZvecStudioError,
)
from zvec_studio.schemas import (
    CollectionSchema,
    CollectionStats,
    FieldSchema,
    HnswQueryParamSpec,
    HnswRabitqQueryParamSpec,
    IndexType,
    IvfQueryParamSpec,
    MetricType,
    QueryParamSpec,
    ScalarDataType,
    ScalarIndexParam,
    VamanaQueryParamSpec,
    VectorDataType,
    VectorIndexParam,
    VectorQuerySpec,
)


@dataclass
class CollectionRecord:
    """Live representation of an opened Collection.

    ``sdk_obj`` carries the real ``zvec.Collection`` handle returned by
    ``zvec.create_and_open`` / ``zvec.open``; the rest of the fields mirror
    the public API surface so routers never have to touch the SDK directly.
    """

    name: str
    path: Path
    schema: CollectionSchema
    stats: CollectionStats = field(default_factory=CollectionStats)
    sdk_obj: Any = None


_SCALAR_TO_SDK: dict[ScalarDataType, SdkDataType] = {
    ScalarDataType.INT32: SdkDataType.INT32,
    ScalarDataType.INT64: SdkDataType.INT64,
    ScalarDataType.UINT32: SdkDataType.UINT32,
    ScalarDataType.UINT64: SdkDataType.UINT64,
    ScalarDataType.FLOAT: SdkDataType.FLOAT,
    ScalarDataType.DOUBLE: SdkDataType.DOUBLE,
    ScalarDataType.BOOL: SdkDataType.BOOL,
    ScalarDataType.STRING: SdkDataType.STRING,
    ScalarDataType.ARRAY_BOOL: SdkDataType.ARRAY_BOOL,
    ScalarDataType.ARRAY_INT32: SdkDataType.ARRAY_INT32,
    ScalarDataType.ARRAY_INT64: SdkDataType.ARRAY_INT64,
    ScalarDataType.ARRAY_UINT32: SdkDataType.ARRAY_UINT32,
    ScalarDataType.ARRAY_UINT64: SdkDataType.ARRAY_UINT64,
    ScalarDataType.ARRAY_FLOAT: SdkDataType.ARRAY_FLOAT,
    ScalarDataType.ARRAY_DOUBLE: SdkDataType.ARRAY_DOUBLE,
    ScalarDataType.ARRAY_STRING: SdkDataType.ARRAY_STRING,
}

_VECTOR_TO_SDK: dict[VectorDataType, SdkDataType] = {
    VectorDataType.VECTOR_FP32: SdkDataType.VECTOR_FP32,
    VectorDataType.VECTOR_FP16: SdkDataType.VECTOR_FP16,
    VectorDataType.VECTOR_FP64: SdkDataType.VECTOR_FP64,
    VectorDataType.VECTOR_INT8: SdkDataType.VECTOR_INT8,
    VectorDataType.SPARSE_VECTOR_FP32: SdkDataType.SPARSE_VECTOR_FP32,
    VectorDataType.SPARSE_VECTOR_FP16: SdkDataType.SPARSE_VECTOR_FP16,
}

_METRIC_TO_SDK: dict[MetricType, SdkMetricType] = {
    MetricType.L2: SdkMetricType.L2,
    MetricType.IP: SdkMetricType.IP,
    MetricType.COSINE: SdkMetricType.COSINE,
}

_INDEX_CLS: dict[IndexType, type] = {
    IndexType.HNSW: HnswIndexParam,
    IndexType.FLAT: FlatIndexParam,
    IndexType.IVF: IVFIndexParam,
    IndexType.HNSW_RABITQ: HnswRabitqIndexParam,
    IndexType.VAMANA: VamanaIndexParam,
    IndexType.INVERT: InvertIndexParam,
}

_CAMEL_TO_SNAKE_RE = re.compile(r"(?<!^)(?=[A-Z])")


def _normalize_param_keys(params: dict[str, Any]) -> dict[str, Any]:
    """Convert camelCase / PascalCase keys to snake_case.

    Zvec's pybind11 IndexParam constructors expose snake_case kwargs (``m`` /
    ``ef_construction`` / ``nlist`` / ...). Studio accepts the friendlier
    SDK-doc-style names (``M`` / ``efConstruction``) on the wire and converts
    here so users don't have to remember the binding-specific casing.
    """
    return {_CAMEL_TO_SNAKE_RE.sub("_", k).lower(): v for k, v in params.items()}


def _build_index_param(spec: VectorIndexParam | None) -> Any:
    if spec is None:
        return HnswIndexParam()
    cls = _INDEX_CLS[spec.indexType]
    kwargs: dict[str, Any] = {"metric_type": _METRIC_TO_SDK[spec.metric]}
    # Accept either snake_case or camelCase keys from clients; the SDK only
    # speaks snake_case.
    kwargs.update(_normalize_param_keys(spec.params))
    try:
        return cls(**kwargs)
    except TypeError as exc:
        raise InvalidSchemaError(
            f"Unsupported index params for {spec.indexType.value}: {exc}",
            extra={"indexType": spec.indexType.value, "params": dict(spec.params)},
        ) from exc


def _to_sdk_schema(schema: CollectionSchema) -> SdkCollectionSchema:
    sdk_fields = [
        SdkFieldSchema(f.name, _SCALAR_TO_SDK[f.dataType]) for f in schema.fields
    ]
    sdk_vectors = [
        SdkVectorSchema(
            v.name,
            _VECTOR_TO_SDK[v.dataType],
            v.dimension,
            index_param=_build_index_param(v.indexParam),
        )
        for v in schema.vectors
    ]
    return SdkCollectionSchema(
        name=schema.name,
        fields=sdk_fields or None,
        vectors=sdk_vectors,
    )


# ---- Reverse mappings: SDK schema → Studio schema ----

_SDK_TO_SCALAR: dict[SdkDataType, ScalarDataType] = {
    v: k for k, v in _SCALAR_TO_SDK.items()
}

_SDK_TO_VECTOR: dict[SdkDataType, VectorDataType] = {
    v: k for k, v in _VECTOR_TO_SDK.items()
}

_SDK_METRIC_TO_STUDIO: dict[SdkMetricType, MetricType] = {
    v: k for k, v in _METRIC_TO_SDK.items()
}


def _from_sdk_index_param(ip: Any) -> VectorIndexParam | None:
    """Convert a SDK index param object back to Studio VectorIndexParam."""
    if ip is None:
        return None
    # ip.type is an IndexType enum (HNSW, FLAT, IVF, HNSW_RABITQ)
    idx_type_name = str(getattr(ip, "type", "HNSW"))
    # Extract just the name portion, e.g. "IndexType.HNSW" → "HNSW"
    if "." in idx_type_name:
        idx_type_name = idx_type_name.rsplit(".", 1)[-1]
    index_type = IndexType(idx_type_name)

    metric_sdk = getattr(ip, "metric_type", None)
    metric = _SDK_METRIC_TO_STUDIO.get(metric_sdk, MetricType.COSINE) if metric_sdk else MetricType.COSINE

    # Gather extra params (m, ef_construction, nlist, etc.)
    params: dict[str, Any] = {}
    for attr in ("m", "ef_construction", "nlist", "nprobe", "quantize_type", "use_contiguous_memory"):
        val = getattr(ip, attr, None)
        if val is not None and attr not in ("metric_type", "type"):
            # Skip defaults that are noise
            if attr == "quantize_type" and str(val) == "QuantizeType.UNDEFINED":
                continue
            if attr == "use_contiguous_memory" and val is False:
                continue
            params[attr] = val

    return VectorIndexParam(indexType=index_type, metric=metric, params=params)


def _from_sdk_scalar_index_param(ip: Any) -> ScalarIndexParam | None:
    """Convert a SDK scalar (inverted) index param to Studio ScalarIndexParam."""
    if ip is None:
        return None
    return ScalarIndexParam(
        enableRangeOptimization=getattr(ip, "enable_range_optimization", False),
        enableExtendedWildcard=getattr(ip, "enable_extended_wildcard", False),
    )


def _from_sdk_schema(sdk_schema: Any, path: Path) -> CollectionSchema:
    """Reconstruct a Studio CollectionSchema from the SDK's schema object."""
    from zvec_studio.schemas import FieldSchema as StudioFieldSchema
    from zvec_studio.schemas import VectorSchema as StudioVectorSchema

    vectors = []
    for v in (sdk_schema.vectors or []):
        vdt = _SDK_TO_VECTOR.get(v.data_type)
        if vdt is None:
            raise CollectionNotFoundError(
                f"Unknown vector data type {v.data_type} at {path}",
                extra={"path": str(path)},
            )
        vectors.append(
            StudioVectorSchema(
                name=v.name,
                dataType=vdt,
                dimension=v.dimension,
                indexParam=_from_sdk_index_param(v.index_param),
            )
        )

    fields = []
    for f in (sdk_schema.fields or []):
        sdt = _SDK_TO_SCALAR.get(f.data_type)
        if sdt is None:
            continue  # Skip unknown scalar types gracefully
        fields.append(StudioFieldSchema(
            name=f.name,
            dataType=sdt,
            nullable=getattr(f, "nullable", False),
            indexParam=_from_sdk_scalar_index_param(getattr(f, "index_param", None)),
        ))

    return CollectionSchema(name=sdk_schema.name, vectors=vectors, fields=fields)


def _doc_to_dict(doc: SdkDoc, *, include_vector: bool) -> dict[str, Any]:
    out: dict[str, Any] = {"id": doc.id}
    if doc.fields:
        out.update(doc.fields)
    if include_vector and doc.vectors:
        out.update(doc.vectors)
    return out


def _dir_size(path: Path) -> int:
    """Return total size in bytes of all files under *path*."""
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                total += entry.stat().st_size
    except OSError:
        pass
    return total


def _coerce_stats(raw: Any, collection_path: str | Path) -> CollectionStats:
    """Normalise ``zvec.Collection.stats`` into our :class:`CollectionStats`.

    The SDK returns a struct whose ``str()`` is JSON-shaped; field accessors
    may or may not exist depending on the binding version.
    """
    doc_count = 0
    completeness: dict[str, float] = {}
    if hasattr(raw, "doc_count"):
        doc_count = int(getattr(raw, "doc_count", 0))
        completeness = dict(getattr(raw, "index_completeness", {}) or {})
    else:
        try:
            data = json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError):
            data = {}
        doc_count = int(data.get("doc_count", 0))
        completeness = dict(data.get("index_completeness", {}) or {})
    if completeness and all(float(v) >= 1.0 for v in completeness.values()):
        index_state = "ready"
    elif completeness and any(0 < float(v) < 1.0 for v in completeness.values()):
        index_state = "building"
    else:
        index_state = "none"
    return CollectionStats(
        documentCount=doc_count,
        indexState=index_state,
        indexCompleteness={k: float(v) for k, v in completeness.items()},
        storageBytes=_dir_size(Path(collection_path)),
    )


def _ensure_id(doc: dict[str, Any]) -> str:
    raw = doc.get("id")
    if raw is None:
        return str(ULID())
    if not isinstance(raw, str):
        raise InvalidSchemaError(
            "Document 'id' must be a string (Zvec requires str ids).",
            extra={"id": raw},
        )
    return raw


def _build_doc(doc: dict[str, Any], schema: CollectionSchema) -> SdkDoc:
    doc_id = _ensure_id(doc)
    vec_dims = {v.name: v.dimension for v in schema.vectors}
    field_names = {f.name for f in schema.fields}
    # ``Any`` mirrors the SDK's invariant value type (list[float]/list[int]/
    # ndarray/sparse dict) so mypy does not complain about narrowing.
    vectors: dict[str, Any] = {}
    fields: dict[str, Any] = {}
    for k, v in doc.items():
        if k == "id":
            continue
        if k in vec_dims:
            if not isinstance(v, list) or len(v) != vec_dims[k]:
                raise DimensionMismatchError(
                    f"Vector '{k}' must be a list of length {vec_dims[k]}.",
                    extra={
                        "vector": k,
                        "expectedDim": vec_dims[k],
                        "actualDim": len(v) if isinstance(v, list) else None,
                    },
                )
            vectors[k] = v
        elif k in field_names:
            fields[k] = v
        else:
            raise InvalidSchemaError(
                f"Unknown column '{k}' in document.",
                extra={"column": k},
            )
    missing = set(vec_dims) - set(vectors)
    if missing:
        raise InvalidSchemaError(
            f"Document is missing required vectors: {sorted(missing)}",
            extra={"vectors": sorted(missing)},
        )
    return SdkDoc(id=doc_id, fields=fields or None, vectors=vectors)


def _build_doc_partial(doc: dict[str, Any], schema: CollectionSchema) -> SdkDoc:
    """Build a Doc for ``update`` (partial update — vectors optional).

    Unlike :func:`_build_doc`, this does **not** require every vector field
    to be present; only the columns the caller is changing are validated.
    The ``id`` is mandatory (the SDK rejects updates without an id).
    """
    raw_id = doc.get("id")
    if not isinstance(raw_id, str) or not raw_id:
        raise InvalidSchemaError(
            "Update payload requires an explicit string 'id'.",
            extra={"id": raw_id},
        )
    vec_dims = {v.name: v.dimension for v in schema.vectors}
    field_names = {f.name for f in schema.fields}
    # See note on ``_build_doc`` -- ``Any`` matches the SDK's invariant value type.
    vectors: dict[str, Any] = {}
    fields: dict[str, Any] = {}
    for k, v in doc.items():
        if k == "id":
            continue
        if k in vec_dims:
            if not isinstance(v, list) or len(v) != vec_dims[k]:
                raise DimensionMismatchError(
                    f"Vector '{k}' must be a list of length {vec_dims[k]}.",
                    extra={
                        "vector": k,
                        "expectedDim": vec_dims[k],
                        "actualDim": len(v) if isinstance(v, list) else None,
                    },
                )
            vectors[k] = v
        elif k in field_names:
            fields[k] = v
        else:
            raise InvalidSchemaError(
                f"Unknown column '{k}' in document.",
                extra={"column": k},
            )
    return SdkDoc(id=raw_id, fields=fields or None, vectors=vectors)


def _status_ok(status: Any) -> bool:
    """Return True if a Zvec ``Status`` represents success.

    The pybind11 binding exposes ``Status.ok() -> bool`` and ``Status.code()
    -> StatusCode`` as *methods*, not attributes.
    """
    ok = getattr(status, "ok", None)
    if callable(ok):
        try:
            return bool(ok())
        except Exception:
            return False
    code = getattr(status, "code", None)
    if callable(code):
        try:
            return int(code()) == 0
        except Exception:
            return False
    if hasattr(status, "__getitem__"):
        try:
            return int(status["code"]) == 0
        except Exception:
            return False
    return True


class SdkBackend:
    """Zvec-backed Collection backend (only backend in v0.2.0).

    Holds an in-process registry of opened collections keyed by canonical
    absolute path; concurrent access is guarded by ``self._lock``.
    Multiple collections with the same schema name at different paths are
    fully supported.
    """

    def __init__(self) -> None:
        self._by_path: dict[str, CollectionRecord] = {}
        self._lock = RLock()

    # ---- queries ----

    def list_all(self) -> list[CollectionRecord]:
        with self._lock:
            return list(self._by_path.values())

    def get(self, name: str, *, path: str | None = None) -> CollectionRecord:
        with self._lock:
            if path:
                canonical = str(Path(path).expanduser().resolve())
                record = self._by_path.get(canonical)
                if record is not None:
                    return record
            for record in self._by_path.values():
                if record.name == name:
                    return record
            raise CollectionNotFoundError(
                f"Collection '{name}' is not open.", extra={"name": name}
            )

    def exists(self, name: str) -> bool:
        with self._lock:
            return any(r.name == name for r in self._by_path.values())

    def stats(self, name: str, *, path: str | None = None) -> CollectionStats:
        record = self.get(name, path=path)
        return _coerce_stats(record.sdk_obj.stats, record.path)

    # ---- maintenance / lifecycle ----

    def flush(self, name: str, *, path: str | None = None) -> None:
        record = self.get(name, path=path)
        record.sdk_obj.flush()

    def optimize(self, name: str, *, path: str | None = None) -> None:
        record = self.get(name, path=path)
        record.sdk_obj.optimize(zvec.OptimizeOption())

    def destroy(self, name: str, *, path: str | None = None) -> None:
        with self._lock:
            record = self.get(name, path=path)
            key = str(record.path)
            self._by_path.pop(key, None)
            try:
                record.sdk_obj.destroy()
            except Exception as exc:
                self._by_path[key] = record
                raise ZvecStudioError(
                    f"Zvec destroy failed: {exc}",
                    code="DESTROY_FAILED",
                    extra={"name": name},
                ) from exc
            record.sdk_obj = None

    # ---- DDL: scalar fields ----

    def add_field(
        self, name: str, *, field: FieldSchema, expression: str = "", path: str | None = None
    ) -> CollectionRecord:
        record = self.get(name, path=path)
        existing = {f.name for f in record.schema.fields} | {
            v.name for v in record.schema.vectors
        }
        if field.name in existing:
            raise InvalidSchemaError(
                f"Column '{field.name}' already exists on '{name}'.",
                extra={"name": name, "column": field.name},
            )
        # Zvec requires ``nullable=True`` (or a default ``expression``) for
        # add_column on an existing collection; old rows that pre-date the
        # column have no value to fill in otherwise. We always make added
        # columns nullable to keep the API ergonomic.
        sdk_field = SdkFieldSchema(
            field.name, _SCALAR_TO_SDK[field.dataType], nullable=True
        )
        try:
            record.sdk_obj.add_column(
                sdk_field, expression, zvec.AddColumnOption()
            )
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec add_column failed: {exc}",
                extra={"name": name, "column": field.name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    def drop_field(self, name: str, field_name: str, *, path: str | None = None) -> CollectionRecord:
        record = self.get(name, path=path)
        if field_name not in {f.name for f in record.schema.fields}:
            raise InvalidSchemaError(
                f"Scalar field '{field_name}' does not exist on '{name}'.",
                extra={"name": name, "column": field_name},
            )
        try:
            record.sdk_obj.drop_column(field_name)
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec drop_column failed: {exc}",
                extra={"name": name, "column": field_name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    def rename_field(
        self, name: str, *, old_name: str, new_name: str, path: str | None = None
    ) -> CollectionRecord:
        record = self.get(name, path=path)
        all_names = {f.name for f in record.schema.fields} | {
            v.name for v in record.schema.vectors
        }
        if old_name not in all_names:
            raise InvalidSchemaError(
                f"Column '{old_name}' does not exist on '{name}'.",
                extra={"name": name, "column": old_name},
            )
        if new_name in all_names:
            raise InvalidSchemaError(
                f"Column '{new_name}' already exists on '{name}'.",
                extra={"name": name, "column": new_name},
            )
        try:
            record.sdk_obj.alter_column(
                old_name, new_name=new_name, option=zvec.AlterColumnOption()
            )
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec alter_column failed: {exc}",
                extra={"name": name, "oldName": old_name, "newName": new_name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    # ---- DDL: vector indexes ----

    def create_index(
        self,
        name: str,
        *,
        vector_field: str,
        index_param: VectorIndexParam,
        path: str | None = None,
    ) -> CollectionRecord:
        record = self.get(name, path=path)
        matches = [v for v in record.schema.vectors if v.name == vector_field]
        if not matches:
            raise InvalidSchemaError(
                f"Vector field '{vector_field}' does not exist on '{name}'.",
                extra={"name": name, "vectorField": vector_field},
            )
        sdk_param = _build_index_param(index_param)
        try:
            record.sdk_obj.create_index(
                vector_field, sdk_param, zvec.IndexOption()
            )
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec create_index failed: {exc}",
                extra={"name": name, "vectorField": vector_field},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    def drop_index(self, name: str, vector_field: str, *, path: str | None = None) -> CollectionRecord:
        record = self.get(name, path=path)
        matches = [v for v in record.schema.vectors if v.name == vector_field]
        if not matches:
            raise InvalidSchemaError(
                f"Vector field '{vector_field}' does not exist on '{name}'.",
                extra={"name": name, "vectorField": vector_field},
            )
        try:
            record.sdk_obj.drop_index(vector_field)
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec drop_index failed: {exc}",
                extra={"name": name, "vectorField": vector_field},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    # ---- DDL: scalar indexes ----

    def create_scalar_index(
        self,
        name: str,
        *,
        field_name: str,
        enable_range_optimization: bool = False,
        enable_extended_wildcard: bool = False,
        path: str | None = None,
    ) -> CollectionRecord:
        record = self.get(name, path=path)
        if field_name not in {f.name for f in record.schema.fields}:
            raise InvalidSchemaError(
                f"Scalar field '{field_name}' does not exist on '{name}'.",
                extra={"name": name, "field": field_name},
            )
        try:
            import zvec as _zvec
            param = _zvec.InvertIndexParam(
                enable_range_optimization=enable_range_optimization,
                enable_extended_wildcard=enable_extended_wildcard,
            )
            record.sdk_obj.create_index(field_name, param, _zvec.IndexOption())
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec create_index (scalar) failed: {exc}",
                extra={"name": name, "field": field_name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    def drop_scalar_index(self, name: str, field_name: str, *, path: str | None = None) -> CollectionRecord:
        record = self.get(name, path=path)
        if field_name not in {f.name for f in record.schema.fields}:
            raise InvalidSchemaError(
                f"Scalar field '{field_name}' does not exist on '{name}'.",
                extra={"name": name, "field": field_name},
            )
        try:
            record.sdk_obj.drop_index(field_name)
        except (ValueError, RuntimeError) as exc:
            raise InvalidSchemaError(
                f"Zvec drop_index (scalar) failed: {exc}",
                extra={"name": name, "field": field_name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    # ---- documents ----

    def create(self, *, path: Path, schema: CollectionSchema) -> CollectionRecord:
        path = Path(path)
        with self._lock:
            key = str(path)
            if key in self._by_path:
                raise CollectionAlreadyExistsError(
                    f"Collection at path '{path}' is already open.",
                    extra={"path": key},
                )
            if path.exists():
                raise CollectionAlreadyExistsError(
                    f"Path {path} already exists; choose a fresh directory "
                    f"(Zvec creates the collection root itself).",
                    extra={"path": str(path)},
                )
            if not path.parent.exists():
                raise InvalidSchemaError(
                    f"Parent directory {path.parent} does not exist.",
                    extra={"path": str(path)},
                )
            sdk_schema = _to_sdk_schema(schema)
            try:
                sdk_obj = zvec.create_and_open(str(path), sdk_schema)
            except ValueError as exc:
                msg = str(exc)
                if "exists" in msg:
                    raise CollectionAlreadyExistsError(
                        f"Zvec rejected path {path}: {msg}",
                        extra={"path": str(path)},
                    ) from exc
                raise InvalidSchemaError(
                    f"Zvec rejected schema/path: {msg}",
                    extra={"path": str(path), "name": schema.name},
                ) from exc
            record = CollectionRecord(
                name=schema.name,
                path=path,
                schema=schema,
                sdk_obj=sdk_obj,
            )
            self._by_path[key] = record
            return record

    def open(self, path: Path) -> CollectionRecord:
        path = Path(path)
        if not path.exists():
            raise CollectionNotFoundError(
                f"Path {path} does not exist.",
                extra={"path": str(path)},
            )
        with self._lock:
            key = str(path)
            existing = self._by_path.get(key)
            if existing is not None:
                return existing
            try:
                sdk_obj = zvec.open(str(path))
            except Exception as exc:
                raise CollectionNotFoundError(
                    f"Zvec failed to open collection at {path}: {exc}",
                    extra={"path": str(path)},
                ) from exc
            schema = _from_sdk_schema(sdk_obj.schema, path)
            record = CollectionRecord(
                name=schema.name,
                path=path,
                schema=schema,
                sdk_obj=sdk_obj,
            )
            self._by_path[key] = record
            return record

    def close(self, name: str, *, path: str | None = None) -> CollectionRecord:
        with self._lock:
            record = self.get(name, path=path)
            key = str(record.path)
            self._by_path.pop(key, None)
            sdk_obj = record.sdk_obj
            try:
                if sdk_obj is not None and hasattr(sdk_obj, "flush"):
                    sdk_obj.flush()
            except Exception:
                pass
            record.sdk_obj = None
            del sdk_obj
            gc.collect()
            return record

    # ---- documents ----

    def insert_documents(self, name: str, docs: list[dict[str, Any]]) -> list[str]:
        record = self.get(name)
        sdk_docs = [_build_doc(d, record.schema) for d in docs]
        statuses = record.sdk_obj.insert(sdk_docs)
        if not isinstance(statuses, list):
            statuses = [statuses]
        for s in statuses:
            if not _status_ok(s):
                raise ZvecStudioError(
                    f"Zvec insert returned non-zero status: {s}",
                    code="INSERT_FAILED",
                )
        record.sdk_obj.flush()
        return [d.id for d in sdk_docs]

    def upsert_documents(self, name: str, docs: list[dict[str, Any]]) -> list[str]:
        record = self.get(name)
        sdk_docs = [_build_doc(d, record.schema) for d in docs]
        statuses = record.sdk_obj.upsert(sdk_docs)
        if not isinstance(statuses, list):
            statuses = [statuses]
        for s in statuses:
            if not _status_ok(s):
                raise ZvecStudioError(
                    f"Zvec upsert returned non-zero status: {s}",
                    code="UPSERT_FAILED",
                )
        record.sdk_obj.flush()
        return [d.id for d in sdk_docs]

    def update_documents(self, name: str, docs: list[dict[str, Any]]) -> list[str]:
        record = self.get(name)
        sdk_docs = [_build_doc_partial(d, record.schema) for d in docs]
        statuses = record.sdk_obj.update(sdk_docs)
        if not isinstance(statuses, list):
            statuses = [statuses]
        for s, d in zip(statuses, sdk_docs, strict=False):
            if _status_ok(s):
                continue
            # Zvec returns ``code=1, message='Document not found'`` for unknown
            # ids in update().  Surface that as 404 so the UI can react sensibly
            # rather than treating it as an opaque 5xx.
            msg = ""
            getter = getattr(s, "message", None)
            if callable(getter):
                try:
                    msg = str(getter())
                except Exception:
                    msg = ""
            if "not found" in msg.lower():
                raise DocumentNotFoundError(
                    f"Document '{d.id}' not found in '{name}'.",
                    extra={"collection": name, "id": d.id},
                )
            raise ZvecStudioError(
                f"Zvec update returned non-zero status: {s}",
                code="UPDATE_FAILED",
            )
        record.sdk_obj.flush()
        return [d.id for d in sdk_docs]

    def get_document(self, name: str, doc_id: str) -> dict[str, Any]:
        record = self.get(name)
        sid = str(doc_id)
        got = record.sdk_obj.fetch(sid)
        doc: SdkDoc | None = got.get(sid) if isinstance(got, dict) else got
        if doc is None:
            raise DocumentNotFoundError(
                f"Document '{sid}' not found in '{name}'.",
                extra={"collection": name, "id": sid},
            )
        return _doc_to_dict(doc, include_vector=True)

    def delete_document(self, name: str, doc_id: str) -> None:
        record = self.get(name)
        sid = str(doc_id)
        # Probe with fetch so non-existent ids surface as 404 rather than
        # silent no-ops (Zvec's delete is idempotent).
        got = record.sdk_obj.fetch(sid)
        if not got or (isinstance(got, dict) and sid not in got):
            raise DocumentNotFoundError(
                f"Document '{sid}' not found in '{name}'.",
                extra={"collection": name, "id": sid},
            )
        record.sdk_obj.delete(sid)
        record.sdk_obj.flush()

    def delete_documents(self, name: str, ids: list[str]) -> int:
        record = self.get(name)
        sids = [str(i) for i in ids]
        present = record.sdk_obj.fetch(sids)
        deleted_ids = list(present.keys()) if isinstance(present, dict) else []
        if deleted_ids:
            record.sdk_obj.delete(deleted_ids)
            record.sdk_obj.flush()
        return len(deleted_ids)

    def delete_by_filter(self, name: str, filter_expr: str) -> int:
        record = self.get(name)
        # Zvec's ``delete_by_filter`` returns nothing, so we pre-count by
        # running a filter-only query (id projection) up to a hard cap. This
        # is best-effort -- the UI re-queries to refresh the visible page.
        cap = 100_000
        try:
            preview = record.sdk_obj.query(
                vectors=None,
                topk=cap,
                filter=filter_expr,
                include_vector=False,
                output_fields=[],
            )
        except ValueError as exc:
            raise InvalidFilterExpressionError(
                str(exc),
                extra={"filter": filter_expr},
            ) from exc
        count = len(preview)
        try:
            record.sdk_obj.delete_by_filter(filter_expr)
        except ValueError as exc:
            raise InvalidFilterExpressionError(
                str(exc),
                extra={"filter": filter_expr},
            ) from exc
        record.sdk_obj.flush()
        return count

    def browse(
        self,
        name: str,
        *,
        filter_expr: str | None,
        limit: int,
        output_fields: list[str] | None,
        include_vector: bool,
    ) -> list[dict[str, Any]]:
        record = self.get(name)
        # Note: when the collection is empty, Zvec short-circuits ``query``
        # without parsing ``filter``; bad filters only surface once there is
        # at least one indexed doc. That's a SDK quirk we can't paper over
        # without adding our own SQL parser, so callers/tests must seed data
        # before asserting filter-validation behaviour.
        try:
            docs = record.sdk_obj.query(
                vectors=None,
                topk=limit,
                filter=filter_expr,
                include_vector=include_vector,
                output_fields=output_fields,
            )
        except ValueError as exc:
            raise InvalidFilterExpressionError(
                str(exc),
                extra={"filter": filter_expr},
            ) from exc
        return [_doc_to_dict(d, include_vector=include_vector) for d in docs]

    # ---- vector search ----

    def search(
        self,
        name: str,
        *,
        queries: list[VectorQuerySpec] | None = None,
        legacy_vector: list[float] | None = None,
        legacy_vector_field: str | None = None,
        top_k: int,
        filter_expr: str | None = None,
        output_fields: list[str] | None = None,
        include_vector: bool = False,
        reranker: Any | None = None,
    ) -> list[tuple[str, float, dict[str, Any]]]:
        """Run an ANN query.

        Either ``queries`` (canonical multi-vector form) or the legacy single
        ``legacy_vector`` (+ optional ``legacy_vector_field``) must be set.
        Each :class:`VectorQuerySpec` may target a different vector field, may
        be specified by ``id`` or ``vector``, and may carry per-query index
        parameters. ``reranker`` is an opaque ``zvec.ReRanker`` instance built
        by :class:`zvec_studio.ai_service.AIService`.
        """
        record = self.get(name)
        resolved = self._resolve_query_specs(
            record,
            queries=queries,
            legacy_vector=legacy_vector,
            legacy_vector_field=legacy_vector_field,
        )
        sdk_queries = [self._build_sdk_query(record, q) for q in resolved]
        try:
            docs = record.sdk_obj.query(
                vectors=sdk_queries,
                topk=top_k,
                filter=filter_expr,
                include_vector=include_vector,
                output_fields=output_fields,
                reranker=reranker,
            )
        except ValueError as exc:
            raise InvalidFilterExpressionError(
                str(exc),
                extra={"filter": filter_expr},
            ) from exc
        return [
            (
                d.id,
                float(d.score) if d.score is not None else 0.0,
                _doc_to_dict(d, include_vector=include_vector),
            )
            for d in docs
        ]

    # ---- search helpers ----

    @staticmethod
    def _resolve_query_specs(
        record: CollectionRecord,
        *,
        queries: list[VectorQuerySpec] | None,
        legacy_vector: list[float] | None,
        legacy_vector_field: str | None,
    ) -> list[VectorQuerySpec]:
        """Merge canonical ``queries`` with the legacy single-vector form.

        The legacy ``vector`` (+ optional ``vectorField``) is folded into a
        one-element list; when ``vectorField`` is omitted the first declared
        vector field is used (preserves pre-multi-vector behaviour).
        """
        if queries is not None:
            return list(queries)
        if legacy_vector is None:
            raise InvalidSchemaError(
                "either 'queries' or 'vector' must be provided",
                extra={},
            )
        if legacy_vector_field is None:
            legacy_vector_field = record.schema.vectors[0].name
        return [VectorQuerySpec(field=legacy_vector_field, vector=legacy_vector)]

    @staticmethod
    def _build_sdk_query(
        record: CollectionRecord, spec: VectorQuerySpec
    ) -> SdkVectorQuery:
        """Translate a :class:`VectorQuerySpec` to ``zvec.VectorQuery``.

        Validates that the target field exists and (for explicit-vector
        queries) that the dimension matches the field's declared dimension.
        Builds the per-query SDK ``*QueryParam`` if one is supplied.
        """
        matches = [v for v in record.schema.vectors if v.name == spec.field]
        if not matches:
            raise InvalidSchemaError(
                f"Vector field '{spec.field}' not declared on '{record.name}'.",
                extra={"vectorField": spec.field},
            )
        vec_def = matches[0]
        if spec.vector is not None and len(spec.vector) != vec_def.dimension:
            raise DimensionMismatchError(
                f"Query vector has dimension {len(spec.vector)},"
                f" expected {vec_def.dimension}.",
                extra={
                    "expectedDim": vec_def.dimension,
                    "actualDim": len(spec.vector),
                    "vectorField": spec.field,
                },
            )
        kwargs: dict[str, Any] = {"field_name": spec.field}
        if spec.id is not None:
            kwargs["id"] = spec.id
        else:
            kwargs["vector"] = spec.vector
        sdk_param = SdkBackend._build_sdk_query_param(spec.param)
        if sdk_param is not None:
            kwargs["param"] = sdk_param
        return SdkVectorQuery(**kwargs)

    @staticmethod
    def _build_sdk_query_param(param: QueryParamSpec | None) -> Any | None:
        if param is None:
            return None
        if isinstance(param, HnswQueryParamSpec):
            return HnswQueryParam(
                ef=param.ef,
                radius=param.radius,
                is_linear=param.isLinear,
                is_using_refiner=param.isUsingRefiner,
            )
        if isinstance(param, IvfQueryParamSpec):
            return IVFQueryParam(nprobe=param.nprobe)
        if isinstance(param, HnswRabitqQueryParamSpec):
            return HnswRabitqQueryParam(
                ef=param.ef,
                radius=param.radius,
                is_linear=param.isLinear,
                is_using_refiner=param.isUsingRefiner,
            )
        if isinstance(param, VamanaQueryParamSpec):
            return VamanaQueryParam(
                ef_search=param.efSearch,
                radius=param.radius,
                is_linear=param.isLinear,
                is_using_refiner=param.isUsingRefiner,
            )
        raise InvalidSchemaError(  # pragma: no cover - exhaustive
            f"Unsupported query param spec: {type(param).__name__}",
            extra={},
        )
