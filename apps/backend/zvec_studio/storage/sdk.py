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

import contextlib
import gc
import json
import math
import re
import tarfile
import time
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from typing import Any, BinaryIO, cast

import zvec
from ulid import ULID
from zvec import (
    CollectionSchema as SdkCollectionSchema,
)
from zvec import (
    DataType as SdkDataType,
)
from zvec import (
    DiskAnnIndexParam,
    DiskAnnQueryParam,
    FlatIndexParam,
    HnswIndexParam,
    HnswQueryParam,
    HnswRabitqIndexParam,
    HnswRabitqQueryParam,
    InvertIndexParam,
    IVFIndexParam,
    IVFQueryParam,
    QuantizerParam,
    VamanaIndexParam,
    VamanaQueryParam,
)
from zvec import (
    Doc as SdkDoc,
)
from zvec import (
    FieldSchema as SdkFieldSchema,
)
from zvec import (
    MetricType as SdkMetricType,
)
from zvec import (
    Query as SdkQuery,
)
from zvec import (
    VectorSchema as SdkVectorSchema,
)

from zvec_studio.exceptions import (
    CollectionAlreadyExistsError,
    CollectionNotFoundError,
    DimensionMismatchError,
    DocumentConflictError,
    DocumentNotFoundError,
    ImportManifestInvalidError,
    InvalidDocumentError,
    InvalidFilterExpressionError,
    InvalidSchemaError,
    MaintenanceBlockedError,
    UnsupportedVectorDataTypeError,
    ZvecStudioError,
)
from zvec_studio.schemas import (
    CollectionSchema,
    CollectionStats,
    DiskAnnQueryParamSpec,
    FieldSchema,
    FtsQueryParamSpec,
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
from zvec_studio.storage.doc_repr import doc_to_row, pk_key, split_pk
from zvec_studio.storage.formats import ImportFormat
from zvec_studio.storage.import_ import (
    ImportFailure,
    ImportMode,
    ImportReport,
    OnErrorMode,
    validate_import_source,
)
from zvec_studio.storage.snapshot import (
    DATA_FILE_NAME,
    MANIFEST_NAME,
    check_schema_compatible,
    parse_manifest,
)

# Zvec's C++ core rejects write batches larger than this (observed error:
# "Too many docs: N exceeds max write batch size of 1024"). It is a runtime
# guard, not a documented contract -- keep the name honest and adjust it
# (plus any test asserting the value) if the SDK ever publishes otherwise.
_MAX_SDK_WRITE_BATCH = 1024
# Benchmarked sweet spot: writing in 512-doc chunks measured faster than
# 1024-doc chunks on the same workload (~68k vs ~54k docs/s, M-series SSD).
_DEFAULT_WRITE_BATCH = 512

_ZVEC_EXPORTS = vars(zvec)
FtsIndexParam: type[Any] = _ZVEC_EXPORTS["FtsIndexParam"]
FtsQueryParam: type[Any] = _ZVEC_EXPORTS["FtsQueryParam"]
SdkFts: type[Any] = _ZVEC_EXPORTS["Fts"]


def _exc_msg(exc: BaseException) -> str:
    """Extract a human-readable message from an exception.

    The zvec C++ binding sometimes raises exceptions whose ``__str__``
    returns an empty string. In those cases fall back to ``repr(exc)``
    or ``exc.args`` so the API response always carries useful detail.
    """
    msg = str(exc)
    if msg:
        return msg
    if exc.args:
        return " ".join(str(a) for a in exc.args if a)
    return repr(exc)


def _raise_if_maintenance_blocked(exc: BaseException) -> None:
    """Map Zvec's ``iterators are open`` rejection onto a retryable 409.

    While a snapshot iterator is open (an export is running), Zvec refuses
    maintenance operations with ``RuntimeError('... while iterators are
    open')``. That is a transient conflict, not an invalid request — surface
    it as ``MAINTENANCE_BLOCKED`` so clients can retry after the export
    finishes instead of seeing an opaque 4xx/5xx.
    """
    if isinstance(exc, RuntimeError) and "iterator" in _exc_msg(exc).lower():
        raise MaintenanceBlockedError(
            _exc_msg(exc) or "Maintenance is blocked while an export is running."
        ) from exc


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
    # VECTOR_FP64 deliberately omitted: zvec rejects it at schema validation.
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
    IndexType.DISKANN: DiskAnnIndexParam,
    IndexType.INVERT: InvertIndexParam,
}

_SDK_VECTOR_INDEX_TYPES: tuple[tuple[type, IndexType], ...] = (
    (HnswIndexParam, IndexType.HNSW),
    (FlatIndexParam, IndexType.FLAT),
    (IVFIndexParam, IndexType.IVF),
    (HnswRabitqIndexParam, IndexType.HNSW_RABITQ),
    (VamanaIndexParam, IndexType.VAMANA),
    (DiskAnnIndexParam, IndexType.DISKANN),
)

_SDK_VECTOR_INDEX_TYPE_BY_CLASS_NAME: dict[str, IndexType] = {
    cls.__name__: index_type for cls, index_type in _SDK_VECTOR_INDEX_TYPES
}

_SDK_SCALAR_INDEX_TYPES: tuple[tuple[type, IndexType], ...] = (
    (InvertIndexParam, IndexType.INVERT),
    (FtsIndexParam, IndexType.FTS),
)

_SDK_SCALAR_INDEX_TYPE_BY_CLASS_NAME: dict[str, IndexType] = {
    cls.__name__: index_type for cls, index_type in _SDK_SCALAR_INDEX_TYPES
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


def _coerce_quantize_type(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return getattr(zvec.QuantizeType, value)
        except AttributeError as exc:
            raise InvalidSchemaError(
                f"Unsupported quantizeType: {value}",
                extra={"quantizeType": value},
            ) from exc
    return value


def _coerce_quantizer_param(value: Any) -> Any:
    """Build the Zvec 0.6 quantizer config from Studio wire parameters."""
    if isinstance(value, QuantizerParam):
        return value
    if isinstance(value, dict):
        try:
            return QuantizerParam(**_normalize_param_keys(value))
        except TypeError as exc:
            raise InvalidSchemaError(
                f"Unsupported quantizerParam: {exc}",
                extra={"quantizerParam": value},
            ) from exc
    raise InvalidSchemaError(
        "quantizerParam must be an object",
        extra={"quantizerParam": value},
    )


def _build_index_param(spec: VectorIndexParam | None) -> Any:
    if spec is None:
        return HnswIndexParam()
    cls = _INDEX_CLS.get(spec.indexType)
    if cls is None or spec.indexType in {IndexType.INVERT, IndexType.FTS}:
        raise InvalidSchemaError(
            f"Index type {spec.indexType.value} is not valid for vector fields.",
            extra={"indexType": spec.indexType.value},
        )
    kwargs: dict[str, Any] = {"metric_type": _METRIC_TO_SDK[spec.metric]}
    # Accept either snake_case or camelCase keys from clients; the SDK only
    # speaks snake_case.
    kwargs.update(_normalize_param_keys(spec.params))
    if "quantize_type" in kwargs:
        kwargs["quantize_type"] = _coerce_quantize_type(kwargs["quantize_type"])
    if "quantizer_param" in kwargs:
        kwargs["quantizer_param"] = _coerce_quantizer_param(kwargs["quantizer_param"])
        if kwargs["quantizer_param"].enable_rotate:
            supported_indexes = {IndexType.FLAT, IndexType.HNSW, IndexType.VAMANA}
            supported_quantization = {zvec.QuantizeType.INT8, zvec.QuantizeType.INT4}
            if spec.indexType not in supported_indexes:
                raise InvalidSchemaError(
                    f"Random rotation is not supported for {spec.indexType.value} indexes.",
                    extra={"indexType": spec.indexType.value},
                )
            if kwargs.get("quantize_type") not in supported_quantization:
                raise InvalidSchemaError(
                    "Random rotation requires INT8 or INT4 quantization.",
                    extra={"quantizeType": spec.params.get("quantizeType")},
                )
    try:
        return cls(**kwargs)
    except TypeError as exc:
        raise InvalidSchemaError(
            f"Unsupported index params for {spec.indexType.value}: {exc}",
            extra={"indexType": spec.indexType.value, "params": dict(spec.params)},
        ) from exc


def _build_scalar_index_param(spec: ScalarIndexParam | None) -> Any | None:
    if spec is None:
        return None
    if spec.indexType is IndexType.INVERT:
        return InvertIndexParam(
            enable_range_optimization=spec.enableRangeOptimization,
            enable_extended_wildcard=spec.enableExtendedWildcard,
        )
    if spec.indexType is IndexType.FTS:
        return FtsIndexParam(
            tokenizer_name=spec.tokenizerName,
            filters=spec.filters,
            extra_params=spec.extraParams,
        )
    raise InvalidSchemaError(
        f"Index type {spec.indexType.value} is not valid for scalar fields.",
        extra={"indexType": spec.indexType.value},
    )


def _to_sdk_schema(schema: CollectionSchema) -> SdkCollectionSchema:
    sdk_fields = [
        SdkFieldSchema(
            f.name,
            _SCALAR_TO_SDK[f.dataType],
            nullable=f.nullable,
            index_param=_build_scalar_index_param(f.indexParam),
        )
        for f in schema.fields
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
        vectors=sdk_vectors or None,
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

_SPARSE_VECTOR_TYPES: frozenset[VectorDataType] = frozenset(
    {
        VectorDataType.SPARSE_VECTOR_FP32,
        VectorDataType.SPARSE_VECTOR_FP16,
    }
)


def _is_sparse_vector_type(data_type: VectorDataType) -> bool:
    return data_type in _SPARSE_VECTOR_TYPES


def _coerce_sparse_vector(value: Any, *, vector_name: str) -> dict[int, float]:
    if not isinstance(value, dict) or not value:
        raise InvalidSchemaError(
            f"Vector '{vector_name}' must be a non-empty sparse object.",
            extra={"vector": vector_name, "expectedType": "sparse object"},
        )

    out: dict[int, float] = {}
    for raw_key, raw_weight in value.items():
        if isinstance(raw_key, bool):
            key: int | None = None
        elif isinstance(raw_key, int):
            key = raw_key
        elif isinstance(raw_key, str) and raw_key.isdecimal():
            key = int(raw_key)
        else:
            key = None

        if key is None or key < 0 or key > 0xFFFFFFFF:
            raise InvalidSchemaError(
                f"Vector '{vector_name}' must use uint32 sparse keys.",
                extra={"vector": vector_name, "expectedKeyType": "uint32", "actualKey": raw_key},
            )

        if (
            isinstance(raw_weight, bool)
            or not isinstance(raw_weight, int | float)
            or not math.isfinite(float(raw_weight))
        ):
            raise InvalidSchemaError(
                f"Vector '{vector_name}' must use finite float sparse weights.",
                extra={
                    "vector": vector_name,
                    "expectedValueType": "float",
                    "actualValue": raw_weight,
                },
            )

        out[key] = float(raw_weight)
    return out


def _from_sdk_index_param(ip: Any) -> VectorIndexParam | None:
    """Convert a SDK index param object back to Studio VectorIndexParam."""
    if ip is None:
        return None
    index_type = _sdk_vector_index_type(ip)

    metric_sdk = getattr(ip, "metric_type", None)
    metric = _SDK_METRIC_TO_STUDIO.get(metric_sdk, MetricType.COSINE) if metric_sdk else MetricType.COSINE

    # Gather extra params (m, ef_construction, nlist, etc.)
    params: dict[str, Any] = {}
    for attr in (
        "m",
        "ef_construction",
        "n_list",
        "n_iters",
        "use_soar",
        "nlist",
        "nprobe",
        "quantize_type",
        "use_contiguous_memory",
        "total_bits",
        "num_clusters",
        "sample_count",
        "max_degree",
        "list_size",
        "pq_chunk_num",
    ):
        val = getattr(ip, attr, None)
        if val is not None and attr not in ("metric_type", "type"):
            # Skip defaults that are noise
            if attr == "quantize_type" and str(val) == "QuantizeType.UNDEFINED":
                continue
            if attr == "quantize_type":
                params[attr] = getattr(val, "name", str(val).rsplit(".", 1)[-1])
                continue
            if attr == "use_contiguous_memory" and val is False:
                continue
            params[attr] = val

    quantizer_param = getattr(ip, "quantizer_param", None)
    enable_rotate = getattr(quantizer_param, "enable_rotate", False)
    if enable_rotate:
        params["quantizer_param"] = {"enable_rotate": True}

    return VectorIndexParam(indexType=index_type, metric=metric, params=params)


def _sdk_type_name(ip: Any) -> str | None:
    raw_type = getattr(ip, "type", None)
    if raw_type is None:
        return None
    type_name = str(raw_type)
    if "." in type_name:
        type_name = type_name.rsplit(".", 1)[-1]
    return type_name


def _sdk_vector_index_type(ip: Any) -> IndexType:
    for cls, index_type in _SDK_VECTOR_INDEX_TYPES:
        if isinstance(ip, cls):
            return index_type
    by_name = _SDK_VECTOR_INDEX_TYPE_BY_CLASS_NAME.get(type(ip).__name__)
    if by_name is not None:
        return by_name

    type_name = _sdk_type_name(ip)
    if type_name is not None:
        try:
            index_type = IndexType(type_name)
        except ValueError:
            pass
        else:
            if index_type in {
                IndexType.HNSW,
                IndexType.FLAT,
                IndexType.IVF,
                IndexType.HNSW_RABITQ,
                IndexType.VAMANA,
                IndexType.DISKANN,
            }:
                return index_type

    raise InvalidSchemaError(
        f"Unsupported SDK vector index param type: {type(ip).__name__}",
        extra={"sdkClass": type(ip).__name__, "sdkIndexType": type_name},
    )


def _sdk_scalar_index_type(ip: Any) -> IndexType:
    for cls, index_type in _SDK_SCALAR_INDEX_TYPES:
        if isinstance(ip, cls):
            return index_type
    by_name = _SDK_SCALAR_INDEX_TYPE_BY_CLASS_NAME.get(type(ip).__name__)
    if by_name is not None:
        return by_name

    type_name = _sdk_type_name(ip)
    if type_name in {"INVERT", "FTS"}:
        return IndexType(type_name)

    raise InvalidSchemaError(
        f"Unsupported SDK scalar index param type: {type(ip).__name__}",
        extra={"sdkClass": type(ip).__name__, "sdkIndexType": type_name},
    )


def _from_sdk_scalar_index_param(ip: Any) -> ScalarIndexParam | None:
    """Convert a SDK scalar index param to Studio ScalarIndexParam."""
    if ip is None:
        return None
    index_type = _sdk_scalar_index_type(ip)
    if index_type is IndexType.FTS:
        return ScalarIndexParam(
            indexType=IndexType.FTS,
            tokenizerName=getattr(ip, "tokenizer_name", "standard"),
            filters=list(getattr(ip, "filters", ["lowercase"]) or ["lowercase"]),
            extraParams=getattr(ip, "extra_params", ""),
        )
    return ScalarIndexParam(
        indexType=IndexType.INVERT,
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
            # The collection exists and opened fine — this is a dtype Studio
            # cannot represent (e.g. a legacy VECTOR_FP64 collection), not a
            # missing collection.
            raise UnsupportedVectorDataTypeError(
                f"Vector '{v.name}' uses data type {v.data_type}, which this "
                f"version of Studio does not support "
                f"(supported: {', '.join(t.value for t in VectorDataType)}).",
                extra={
                    "path": str(path),
                    "vector": v.name,
                    "dataType": str(v.data_type),
                    "supported": [t.value for t in VectorDataType],
                },
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


def _doc_to_dict(
    doc: SdkDoc, *, schema: CollectionSchema, include_vector: bool
) -> dict[str, Any]:
    """Flatten an SDK document into the wire row representation.

    Delegates to :mod:`zvec_studio.storage.doc_repr` so the primary key lands
    on ``$id`` when the schema declares its own ``id`` column instead of being
    silently overwritten by it.
    """
    return doc_to_row(doc, schema=schema, include_vector=include_vector)


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



# ── Field type validation ──

_NUMERIC_SCALAR_TYPES = frozenset({
    ScalarDataType.INT32, ScalarDataType.INT64,
    ScalarDataType.UINT32, ScalarDataType.UINT64,
    ScalarDataType.FLOAT, ScalarDataType.DOUBLE,
})
_ARRAY_SCALAR_TYPES = frozenset({
    ScalarDataType.ARRAY_INT32, ScalarDataType.ARRAY_INT64,
    ScalarDataType.ARRAY_UINT32, ScalarDataType.ARRAY_UINT64,
    ScalarDataType.ARRAY_FLOAT, ScalarDataType.ARRAY_DOUBLE,
    ScalarDataType.ARRAY_BOOL, ScalarDataType.ARRAY_STRING,
})


def _validate_field_value(name: str, value: Any, field: FieldSchema) -> None:
    """Pre-validate a field value against its schema type.

    Raises :class:`InvalidSchemaError` with a human-readable message when the
    value type does not match the declared schema type, before the SDK can
    produce a confusing error.
    """
    dt = field.dataType

    # Null check
    if value is None:
        if not field.nullable:
            raise InvalidSchemaError(
                f"Field '{name}': expected {dt.value}, got null (field is not nullable).",
                extra={"field": name, "expectedType": dt.value},
            )
        return  # null is valid for nullable fields

    # Numeric scalars: must be int or float, not str/bool
    if dt in _NUMERIC_SCALAR_TYPES:
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise InvalidSchemaError(
                f"Field '{name}': expected {dt.value}, got {type(value).__name__}.",
                extra={"field": name, "expectedType": dt.value, "actualType": type(value).__name__},
            )
        return

    # Boolean
    if dt == ScalarDataType.BOOL:
        if not isinstance(value, bool):
            raise InvalidSchemaError(
                f"Field '{name}': expected BOOL, got {type(value).__name__}.",
                extra={"field": name, "expectedType": "BOOL", "actualType": type(value).__name__},
            )
        return

    # String
    if dt == ScalarDataType.STRING:
        if not isinstance(value, str):
            raise InvalidSchemaError(
                f"Field '{name}': expected STRING, got {type(value).__name__}.",
                extra={"field": name, "expectedType": "STRING", "actualType": type(value).__name__},
            )
        return

    # Array types
    if dt in _ARRAY_SCALAR_TYPES:
        if not isinstance(value, list):
            raise InvalidSchemaError(
                f"Field '{name}': expected array ({dt.value}), got {type(value).__name__}.",
                extra={"field": name, "expectedType": dt.value, "actualType": type(value).__name__},
            )
        return


def _build_doc(doc: dict[str, Any], schema: CollectionSchema) -> SdkDoc:
    found_id, columns = split_pk(doc, schema=schema)
    doc_id = found_id if found_id is not None else str(ULID())
    vec_defs = {v.name: v for v in schema.vectors}
    field_map = {f.name: f for f in schema.fields}
    # ``Any`` mirrors the SDK's invariant value type (list[float]/list[int]/
    # ndarray/sparse dict) so mypy does not complain about narrowing.
    vectors: dict[str, Any] = {}
    fields: dict[str, Any] = {}
    for k, v in columns.items():
        if k in vec_defs:
            vec_def = vec_defs[k]
            if _is_sparse_vector_type(vec_def.dataType):
                v = _coerce_sparse_vector(v, vector_name=k)
            elif not isinstance(v, list) or len(v) != vec_def.dimension:
                raise DimensionMismatchError(
                    f"Vector '{k}' must be a list of length {vec_def.dimension}.",
                    extra={
                        "vector": k,
                        "expectedDim": vec_def.dimension,
                        "actualDim": len(v) if isinstance(v, list) else None,
                    },
                )
            vectors[k] = v
        elif k in field_map:
            _validate_field_value(k, v, field_map[k])
            # SDK does not accept None; omit nullable fields with null value.
            if v is not None:
                fields[k] = v
        else:
            raise InvalidSchemaError(
                f"Unknown column '{k}' in document.",
                extra={"column": k},
            )
    missing = set(vec_defs) - set(vectors)
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
    The primary key is mandatory (the SDK rejects updates without an id).
    """
    found_id, columns = split_pk(doc, schema=schema)
    if not found_id:
        raise InvalidSchemaError(
            f"Update payload requires an explicit string '{pk_key(schema)}'.",
            extra={"primaryKeyKey": pk_key(schema)},
        )
    vec_defs = {v.name: v for v in schema.vectors}
    field_map = {f.name: f for f in schema.fields}
    # See note on ``_build_doc`` -- ``Any`` matches the SDK's invariant value type.
    vectors: dict[str, Any] = {}
    fields: dict[str, Any] = {}
    for k, v in columns.items():
        if k in vec_defs:
            vec_def = vec_defs[k]
            if _is_sparse_vector_type(vec_def.dataType):
                v = _coerce_sparse_vector(v, vector_name=k)
            elif not isinstance(v, list) or len(v) != vec_def.dimension:
                raise DimensionMismatchError(
                    f"Vector '{k}' must be a list of length {vec_def.dimension}.",
                    extra={
                        "vector": k,
                        "expectedDim": vec_def.dimension,
                        "actualDim": len(v) if isinstance(v, list) else None,
                    },
                )
            vectors[k] = v
        elif k in field_map:
            _validate_field_value(k, v, field_map[k])
            # SDK does not accept None; omit nullable fields with null value.
            if v is not None:
                fields[k] = v
        else:
            raise InvalidSchemaError(
                f"Unknown column '{k}' in document.",
                extra={"column": k},
            )
    return SdkDoc(id=found_id, fields=fields or None, vectors=vectors)


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


def _status_msg(status: Any) -> str:
    """Best-effort human-readable message of a Zvec ``Status``.

    ``Status.message()`` is a method on the pybind11 binding; some fallback
    shapes expose it differently (or not at all).
    """
    getter = getattr(status, "message", None)
    if callable(getter):
        try:
            return str(getter())
        except Exception:
            pass
    try:
        return str(status)
    except Exception:
        return ""


def _write_in_batches(
    sdk_docs: list[SdkDoc],
    write_fn: Callable[[list[SdkDoc]], Any],
    *,
    failed_code: str,
    batch_size: int = _DEFAULT_WRITE_BATCH,
) -> list[Any]:
    """Run ``write_fn`` in SDK-sized chunks and classify failures.

    Absorbs the SDK's hard batch limit (:data:`_MAX_SDK_WRITE_BATCH`) so
    callers may pass any number of documents. Per-document failures are
    reported through the SDK ``Status`` list; this helper maps them onto the
    Studio error taxonomy:

    * duplicate primary key      -> :class:`DocumentConflictError` (409)
    * unknown id (update)        -> :class:`DocumentNotFoundError` (404)
    * anything else              -> :class:`ZvecStudioError` (*failed_code*)

    A ``ValueError`` raised *by the SDK itself* (document-level validation)
    becomes :class:`InvalidDocumentError` (422); if it still mentions the
    batch limit, our own batching has regressed and it must stay a 500.
    """
    statuses: list[Any] = []
    chunk = max(1, min(batch_size, _MAX_SDK_WRITE_BATCH))
    try:
        for start in range(0, len(sdk_docs), chunk):
            result = write_fn(sdk_docs[start : start + chunk])
            if not isinstance(result, list):
                result = [result]
            statuses.extend(result)
    except ValueError as exc:
        msg = _exc_msg(exc)
        if "too many docs" in msg.lower():
            raise ZvecStudioError(
                f"Internal write-batch regression: {msg}",
                code="INTERNAL_ERROR",
            ) from exc
        raise InvalidDocumentError(msg, sdk_exception="ValueError") from exc
    _check_write_statuses(statuses, failed_code=failed_code)
    return statuses


def _check_write_statuses(statuses: list[Any], *, failed_code: str) -> None:
    """Raise the first non-OK ``Status``, mapped to the closest HTTP error.

    Classification is shared with the import row reports via
    :func:`_classify_status_code`; only the opaque-failure code differs
    (callers pass their own operation code, e.g. ``INSERT_FAILED``).
    """
    for s in statuses:
        if _status_ok(s):
            continue
        msg = _status_msg(s)
        code = _classify_status_code(msg)
        if code == "DOCUMENT_CONFLICT":
            raise DocumentConflictError(
                msg or "Document already exists.", sdk_exception="Status"
            )
        if code == "DOCUMENT_NOT_FOUND":
            raise DocumentNotFoundError(msg or "Document not found.", sdk_exception="Status")
        raise ZvecStudioError(
            f"Zvec write returned non-zero status: {msg or s}", code=failed_code
        )


def _classify_status_code(message: str) -> str:
    """Map a non-OK ``Status`` message onto a Studio error code (for import
    row reports, which must not raise)."""
    lowered = message.lower()
    if "already exists" in lowered:
        return "DOCUMENT_CONFLICT"
    if "not found" in lowered:
        return "DOCUMENT_NOT_FOUND"
    return "WRITE_FAILED"


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
        try:
            record.sdk_obj.optimize(zvec.OptimizeOption())
        except RuntimeError as exc:
            _raise_if_maintenance_blocked(exc)
            raise

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
                    f"Zvec destroy failed: {_exc_msg(exc)}",
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
            field.name,
            _SCALAR_TO_SDK[field.dataType],
            nullable=True,
            index_param=_build_scalar_index_param(field.indexParam),
        )
        try:
            record.sdk_obj.add_column(
                sdk_field, expression, zvec.AddColumnOption()
            )
        except (ValueError, RuntimeError) as exc:
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec add_column failed: {_exc_msg(exc)}",
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
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec drop_column failed: {_exc_msg(exc)}",
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
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec alter_column failed: {_exc_msg(exc)}",
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
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec create_index failed: {_exc_msg(exc)}",
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
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec drop_index failed: {_exc_msg(exc)}",
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
        index_param: ScalarIndexParam,
        path: str | None = None,
    ) -> CollectionRecord:
        record = self.get(name, path=path)
        field_obj = next((f for f in record.schema.fields if f.name == field_name), None)
        if field_obj is None:
            raise InvalidSchemaError(
                f"Scalar field '{field_name}' does not exist on '{name}'.",
                extra={"name": name, "field": field_name},
            )
        if index_param.indexType is IndexType.FTS and field_obj.dataType is not ScalarDataType.STRING:
            raise InvalidSchemaError(
                f"FTS index can only be created on STRING fields, got {field_obj.dataType.value}.",
                extra={"name": name, "field": field_name, "dataType": field_obj.dataType.value},
            )
        try:
            # If the field already has an index, drop it first (SDK does not
            # support in-place overwrite) so that "Edit Index" works correctly.
            if field_obj.indexParam is not None:
                record.sdk_obj.drop_index(field_name)
            param = _build_scalar_index_param(index_param)
            record.sdk_obj.create_index(field_name, param, zvec.IndexOption())
        except (ValueError, RuntimeError) as exc:
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec create_index (scalar) failed: {_exc_msg(exc)}",
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
            _raise_if_maintenance_blocked(exc)
            raise InvalidSchemaError(
                f"Zvec drop_index (scalar) failed: {_exc_msg(exc)}",
                extra={"name": name, "field": field_name},
            ) from exc
        record.schema = _from_sdk_schema(record.sdk_obj.schema, record.path)
        return record

    # ---- documents ----

    def _ensure_unique_name(self, name: str, path: Path) -> None:
        """Enforce the registry invariant: open collection names are unique.

        Nearly every document API resolves a collection by name alone (the
        optional ``path`` hint is a fast-path), so two same-named collections
        can never be open at once — requests would silently resolve to
        whichever registered first. Callers must close the blocking one or
        pick another name.
        """
        for record in self._by_path.values():
            if record.name == name and record.path != path:
                raise CollectionAlreadyExistsError(
                    f"Collection '{name}' is already open from '{record.path}'. "
                    f"Close it first, or choose another name.",
                    extra={"name": name, "conflictingPath": str(record.path)},
                )

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
            self._ensure_unique_name(schema.name, path)
            sdk_schema = _to_sdk_schema(schema)
            try:
                sdk_obj = zvec.create_and_open(str(path), sdk_schema)
            except (ValueError, RuntimeError) as exc:
                msg = _exc_msg(exc)
                if isinstance(exc, ValueError) and "exists" in msg:
                    raise CollectionAlreadyExistsError(
                        f"Zvec rejected path {path}: {msg}",
                        extra={"path": str(path)},
                        sdk_exception=type(exc).__name__,
                    ) from exc
                raise InvalidSchemaError(
                    f"Zvec rejected schema/path: {msg}",
                    extra={"path": str(path), "name": schema.name},
                    sdk_exception=type(exc).__name__,
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
            try:
                self._ensure_unique_name(schema.name, path)
            except CollectionAlreadyExistsError:
                # Drop the just-opened handle instead of waiting for GC.
                sdk_obj = None  # type: ignore[assignment]
                raise
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
        # The SDK rejects write batches above _MAX_SDK_WRITE_BATCH, so split
        # internally (the HTTP contract accepts up to 10,000 documents).
        _write_in_batches(sdk_docs, record.sdk_obj.insert, failed_code="INSERT_FAILED")
        record.sdk_obj.flush()
        return [d.id for d in sdk_docs]

    def upsert_documents(self, name: str, docs: list[dict[str, Any]]) -> list[str]:
        """Insert-or-merge by id.

        For documents whose id already exists, only the provided fields are
        updated (merge semantics); omitted fields retain their existing values.
        For new ids, the document is inserted as-is.

        Implementation: uses ``update()`` for existing docs (partial merge)
        and falls back to ``insert()`` for new docs. The primary key is
        resolved through :mod:`zvec_studio.storage.doc_repr`, so a schema that
        declares its own ``id`` column (primary key carried on ``$id``) still
        merges by the real key, and ambiguous bare-``id`` rows are rejected.
        """
        record = self.get(name)

        # Split into docs with an explicit primary key vs without (split_pk
        # also validates ambiguous rows before any write happens).
        keyed: list[tuple[str, dict[str, Any]]] = []
        without_id: list[dict[str, Any]] = []
        for d in docs:
            found_id, _ = split_pk(d, schema=record.schema)
            if found_id:
                keyed.append((found_id, d))
            else:
                without_id.append(d)

        result_ids: list[str] = []

        # For docs with id: try update (partial merge), fallback to insert
        if keyed:
            # Check which ids already exist
            fetched = record.sdk_obj.fetch([doc_id for doc_id, _ in keyed])
            existing_ids: set[str] = set()
            if isinstance(fetched, dict):
                existing_ids = {k for k, v in fetched.items() if v is not None}

            to_update: list[dict[str, Any]] = []
            to_insert: list[dict[str, Any]] = []
            for doc_id, d in keyed:
                if doc_id in existing_ids:
                    to_update.append(d)
                else:
                    to_insert.append(d)

            # Update existing docs (partial — only provided fields change)
            if to_update:
                sdk_update_docs = [_build_doc_partial(d, record.schema) for d in to_update]
                _write_in_batches(
                    sdk_update_docs, record.sdk_obj.update, failed_code="UPSERT_FAILED"
                )
                result_ids.extend(d.id for d in sdk_update_docs)

            # Insert new docs with explicit id (full doc required)
            if to_insert:
                sdk_insert_docs = [_build_doc(d, record.schema) for d in to_insert]
                _write_in_batches(
                    sdk_insert_docs, record.sdk_obj.insert, failed_code="UPSERT_FAILED"
                )
                result_ids.extend(d.id for d in sdk_insert_docs)

        # Insert docs without id (auto-generate ULID)
        if without_id:
            sdk_new_docs = [_build_doc(d, record.schema) for d in without_id]
            _write_in_batches(
                sdk_new_docs, record.sdk_obj.insert, failed_code="UPSERT_FAILED"
            )
            result_ids.extend(d.id for d in sdk_new_docs)

        record.sdk_obj.flush()
        return result_ids

    def update_documents(self, name: str, docs: list[dict[str, Any]]) -> list[str]:
        record = self.get(name)
        sdk_docs = [_build_doc_partial(d, record.schema) for d in docs]
        # ``update`` reports unknown ids through a per-doc ``Status`` whose
        # message contains "not found"; _check_write_statuses maps that to
        # DocumentNotFoundError (404) instead of an opaque 5xx.
        _write_in_batches(sdk_docs, record.sdk_obj.update, failed_code="UPDATE_FAILED")
        record.sdk_obj.flush()
        return [d.id for d in sdk_docs]

    def import_documents(
        self,
        name: str,
        *,
        source_path: str,
        fmt: ImportFormat,
        mode: ImportMode = ImportMode.REPLACE,
        on_error: OnErrorMode = OnErrorMode.ABORT,
        batch_size: int = _DEFAULT_WRITE_BATCH,
        path: str | None = None,
    ) -> ImportReport:
        """Import documents from a file, streaming.

        Pipeline: parse row -> build ``SdkDoc`` (schema-validated) -> write in
        SDK-sized batches (``upsert`` for ``replace``, ``insert`` for
        ``insert``) -> aggregate a per-row report. Memory stays bounded by one
        batch regardless of file size; the collection is flushed once at the
        end (including aborts, so partially imported rows are durable).

        Sources ending in ``.tar.gz`` / ``.tgz`` are treated as snapshot
        packages: the embedded ``manifest.json`` is parsed and schema-checked
        *before any row is written* (fail-fast 409), then the embedded JSONL
        member is consumed through the same pipeline.

        ``path`` fast-paths collection lookup (the registry guarantees open
        names are unique, so it is never needed for disambiguation — handy
        all the same when a caller already holds the absolute path).
        """
        record = self.get(name, path=path)
        source = validate_import_source(source_path)
        chunk = max(1, min(batch_size, _MAX_SDK_WRITE_BATCH))
        report = ImportReport()
        started = time.perf_counter()

        with contextlib.ExitStack() as stack:
            parser = self._open_import_stream(stack, source, record.schema, fmt)
            aborted = self._consume_rows(
                record, parser, mode=mode, on_error=on_error, chunk=chunk, report=report
            )

        # One flush for the whole run (see design doc §6.4: per-batch flushing
        # would pay needless segment-seal costs).
        record.sdk_obj.flush()
        report.aborted = aborted
        report.duration_ms = (time.perf_counter() - started) * 1000
        return report

    def _open_import_stream(
        self,
        stack: contextlib.ExitStack,
        source: Path,
        schema: CollectionSchema,
        fmt: ImportFormat,
    ) -> Iterator[tuple[int, dict[str, Any]]]:
        """Open the row stream for plain JSONL files or snapshot packages.

        A ``*.tar.gz`` source that is not actually a readable gzip/tar stream
        (or breaks mid-read) is a user input error, mapped to 400
        ``IMPORT_MANIFEST_INVALID`` instead of leaking tarfile/gzip internals
        as a 500.
        """
        if source.name.lower().endswith((".tar.gz", ".tgz")):
            try:
                tar = stack.enter_context(tarfile.open(source, mode="r:gz"))  # noqa: SIM115
                members = {m.name: m for m in tar if m.isfile()}
            except (tarfile.TarError, EOFError, OSError, zlib.error) as exc:
                raise ImportManifestInvalidError(
                    f"'{source.name}' is not a readable snapshot package: {exc}",
                    extra={"path": str(source)},
                ) from exc
            if MANIFEST_NAME not in members or DATA_FILE_NAME not in members:
                raise ImportManifestInvalidError(
                    f"Snapshot must contain '{MANIFEST_NAME}' and '{DATA_FILE_NAME}'.",
                    extra={"members": sorted(members)},
                )
            manifest_file = tar.extractfile(members[MANIFEST_NAME])
            if manifest_file is None:
                raise ImportManifestInvalidError(
                    f"'{MANIFEST_NAME}' is not a readable file inside the snapshot."
                )
            try:
                manifest = parse_manifest(manifest_file.read())
            except (tarfile.TarError, EOFError, OSError, zlib.error) as exc:
                raise ImportManifestInvalidError(
                    f"'{MANIFEST_NAME}' inside '{source.name}' is corrupted: {exc}",
                    extra={"path": str(source)},
                ) from exc
            check_schema_compatible(manifest, schema)
            data_file = tar.extractfile(members[DATA_FILE_NAME])
            if data_file is None:
                raise ImportManifestInvalidError(
                    f"'{DATA_FILE_NAME}' is not a readable file inside the snapshot."
                )
            return self._guarded_snapshot_rows(fmt.parse(cast(BinaryIO, data_file)), source)
        stream = stack.enter_context(source.open("rb"))
        return fmt.parse(stream)

    @staticmethod
    def _guarded_snapshot_rows(
        rows: Iterator[tuple[int, dict[str, Any]]], source: Path
    ) -> Iterator[tuple[int, dict[str, Any]]]:
        """Re-raise mid-stream gzip/tar corruption as a 400 manifest error.

        Row-level parse failures (``InvalidDocumentError``) pass through
        untouched — only archive-level breakage is reclassified.
        """
        try:
            yield from rows
        except (tarfile.TarError, EOFError, OSError, zlib.error) as exc:
            raise ImportManifestInvalidError(
                f"'{source.name}' is corrupted and cannot be read to the end: {exc}",
                extra={"path": str(source)},
            ) from exc

    def _consume_rows(
        self,
        record: CollectionRecord,
        parser: Iterator[tuple[int, dict[str, Any]]],
        *,
        mode: ImportMode,
        on_error: OnErrorMode,
        chunk: int,
        report: ImportReport,
    ) -> bool:
        """Build rows into batches, write them, and report; return aborted."""
        batch: list[SdkDoc] = []
        batch_lines: list[int] = []
        aborted = False

        def flush_batch() -> bool:
            """Write the pending batch; return True to abort the whole import."""
            nonlocal batch, batch_lines
            if not batch:
                return False
            abort_now = not self._import_write_batch(
                record,
                batch,
                batch_lines,
                mode=mode,
                on_error=on_error,
                report=report,
            )
            batch, batch_lines = [], []
            return abort_now

        while True:
            try:
                line_number, row = next(parser)
            except StopIteration:
                break
            except ImportManifestInvalidError:
                # Request-level: mid-stream archive corruption (see
                # _guarded_snapshot_rows) maps to a 400 response, never to a
                # row-level failure that abort/skip would digest.
                raise
            except ZvecStudioError as exc:
                # Format-level row error (invalid JSON, wrong shape, ...).
                # Malformed lines count toward total_lines too. In skip mode
                # the invariant imported + failed == total_lines holds; under
                # abort, same-batch rows after the first failure are
                # compensated (deleted) and counted in neither bucket, so
                # imported + failed may be less than total_lines.
                report.total_lines += 1
                raw_line = exc.extra.get("line", 0)
                report.add_failure(
                    ImportFailure(
                        line=int(raw_line) if isinstance(raw_line, int) else 0,
                        code=exc.code,
                        message=exc.message,
                    )
                )
                if on_error is OnErrorMode.ABORT:
                    aborted = True
                    break
                continue

            report.total_lines += 1
            try:
                batch.append(_build_doc(row, record.schema))
            except ZvecStudioError as exc:
                report.add_failure(
                    ImportFailure(line=line_number, code=exc.code, message=exc.message)
                )
                if on_error is OnErrorMode.ABORT:
                    aborted = True
                    break
                continue
            batch_lines.append(line_number)

            if len(batch) >= chunk and flush_batch():
                aborted = True
                break

        # Write whatever valid rows are still buffered. After an abort the
        # buffer holds only rows validated *before* the failing one, and
        # "stop at the first error" must not silently discard them.
        if flush_batch():
            aborted = True
        return aborted

    def _import_write_batch(
        self,
        record: CollectionRecord,
        sdk_docs: list[SdkDoc],
        lines: list[int],
        *,
        mode: ImportMode,
        on_error: OnErrorMode,
        report: ImportReport,
    ) -> bool:
        """Write one batch; return True when the import should continue.

        A ``ValueError`` from the SDK means the whole batch was rejected at
        validation time; either way we retry row by row so the valid rows in
        the batch still land — under ``skip`` to locate every offending line,
        under ``abort`` to keep the rows before the first failing one
        (consistent with the other abort paths, which never discard rows that
        were already validated).
        """
        write_fn = (
            record.sdk_obj.upsert if mode is ImportMode.REPLACE else record.sdk_obj.insert
        )
        try:
            statuses = write_fn(sdk_docs)
            if not isinstance(statuses, list):
                statuses = [statuses]
        except ValueError as exc:
            msg = _exc_msg(exc)
            if "too many docs" in msg.lower():
                # Batching regression — never disguise as user input.
                raise ZvecStudioError(
                    f"Internal write-batch regression: {msg}", code="INTERNAL_ERROR"
                ) from exc
            return self._import_write_one_by_one(
                record,
                sdk_docs,
                lines,
                mode=mode,
                report=report,
                stop_at_first_failure=on_error is OnErrorMode.ABORT,
            )

        failed_in_batch = False
        first_failure_idx: int | None = None
        for i, s in enumerate(statuses):
            if _status_ok(s):
                report.imported += 1
                continue
            failed_in_batch = True
            if first_failure_idx is None:
                first_failure_idx = i
            # ``abort`` reports only the first failing row (the import stops);
            # ``skip`` records all of them.
            if on_error is OnErrorMode.SKIP or first_failure_idx == i:
                msg = _status_msg(s)
                report.add_failure(
                    ImportFailure(
                        line=lines[i], code=_classify_status_code(msg), message=msg
                    )
                )
        if failed_in_batch and on_error is OnErrorMode.ABORT:
            if mode is ImportMode.INSERT and first_failure_idx is not None:
                # True prefix semantics: rows submitted *after* the first
                # failing one were already persisted by the batch write.
                # An insert-confirmed id is guaranteed to be fresh (a clash
                # would have failed), so deleting them cannot touch
                # pre-existing data. REPLACE mode is excluded — an upserted
                # row may have overwritten an existing document, and
                # deleting it would destroy the original instead of
                # restoring it.
                stale = [
                    sdk_docs[j].id
                    for j in range(first_failure_idx + 1, len(statuses))
                    if _status_ok(statuses[j])
                ]
                if stale:
                    with contextlib.suppress(Exception):
                        record.sdk_obj.delete(stale)
                    report.imported -= len(stale)
            return False
        return True

    def _import_write_one_by_one(
        self,
        record: CollectionRecord,
        sdk_docs: list[SdkDoc],
        lines: list[int],
        *,
        mode: ImportMode,
        report: ImportReport,
        stop_at_first_failure: bool = False,
    ) -> bool:
        """Row-by-row fallback after a batch-level ValueError.

        ``skip`` uses it to locate every offending line (and keep good rows);
        ``abort`` uses it with ``stop_at_first_failure`` so the rows before
        the first failing one still land. Returns False to abort the import.
        """
        write_fn = (
            record.sdk_obj.upsert if mode is ImportMode.REPLACE else record.sdk_obj.insert
        )
        for doc, line in zip(sdk_docs, lines, strict=True):
            try:
                statuses = write_fn([doc])
                status = statuses[0] if isinstance(statuses, list) else statuses
            except ValueError as exc:
                report.add_failure(
                    ImportFailure(line=line, code="INVALID_DOCUMENT", message=_exc_msg(exc))
                )
                if stop_at_first_failure:
                    return False
                continue
            if _status_ok(status):
                report.imported += 1
            else:
                msg = _status_msg(status)
                report.add_failure(
                    ImportFailure(line=line, code=_classify_status_code(msg), message=msg)
                )
                if stop_at_first_failure:
                    return False
        return True

    def iter_documents(
        self,
        name: str,
        *,
        include_vector: bool,
        output_fields: list[str] | None = None,
        include_fields: bool = True,
        path: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Stream every document as a wire row (design doc §6.3).

        Wraps the SDK snapshot iterator (zvec 0.7 ``iter_docs``) in ``with`` so
        the iterator — which blocks maintenance operations while open — is
        released on EVERY exit path: normal exhaustion, early ``close()``
        (client disconnect), and exceptions mid-stream.

        ``include_fields=False`` keeps only the primary key and the vectors
        (the reverse of ``include_vector=False``).
        """
        record = self.get(name, path=path)
        with record.sdk_obj.iter_docs(
            output_fields=output_fields, include_vector=include_vector
        ) as iterator:
            if include_fields:
                for doc in iterator:
                    yield doc_to_row(
                        doc, schema=record.schema, include_vector=include_vector
                    )
            else:
                vectors = {v.name for v in record.schema.vectors}
                pk = pk_key(record.schema)
                for doc in iterator:
                    row = doc_to_row(
                        doc, schema=record.schema, include_vector=include_vector
                    )
                    yield {k: v for k, v in row.items() if k == pk or k in vectors}

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
        return _doc_to_dict(doc, schema=record.schema, include_vector=True)

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
            # No batching needed here: the write-batch limit is insert/update
            # specific (a 2048-id delete was verified to succeed in one call).
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
        return [
            _doc_to_dict(d, schema=record.schema, include_vector=include_vector)
            for d in docs
        ]

    # ---- search ----

    def search(
        self,
        name: str,
        *,
        queries: list[VectorQuerySpec] | None = None,
        legacy_vector: Any | None = None,
        legacy_vector_field: str | None = None,
        top_k: int,
        filter_expr: str | None = None,
        output_fields: list[str] | None = None,
        include_vector: bool = False,
        reranker: Any | None = None,
    ) -> list[tuple[str, float, dict[str, Any]]]:
        """Run a vector, FTS, or hybrid query.

        Either ``queries`` (canonical multi-vector form) or the legacy single
        ``legacy_vector`` (+ optional ``legacy_vector_field``) must be set.
        Each :class:`VectorQuerySpec` may target a vector field or an FTS
        scalar field and may carry per-query index parameters. ``reranker`` is
        an opaque ``zvec.ReRanker`` instance built by
        :class:`zvec_studio.ai_service.AIService`.
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
                queries=sdk_queries,
                topk=top_k,
                filter=filter_expr,
                include_vector=include_vector,
                output_fields=output_fields,
                reranker=reranker,
            )
        except ValueError as exc:
            msg = _exc_msg(exc)
            if filter_expr is not None and "reranker" not in msg.lower():
                raise InvalidFilterExpressionError(
                    msg,
                    extra={"filter": filter_expr},
                ) from exc
            raise InvalidSchemaError(msg, extra={"name": name}) from exc
        return [
            (
                d.id,
                float(d.score) if d.score is not None else 0.0,
                _doc_to_dict(d, schema=record.schema, include_vector=include_vector),
            )
            for d in docs
        ]

    def group_by_search(
        self,
        name: str,
        *,
        queries: list[VectorQuerySpec] | None = None,
        legacy_vector: Any | None = None,
        legacy_vector_field: str | None = None,
        group_by_field: str,
        group_count: int,
        top_k_per_group: int,
        filter_expr: str | None = None,
        output_fields: list[str] | None = None,
        include_vector: bool = False,
    ) -> list[tuple[str, float, dict[str, Any], str]]:
        """Run Zvec 0.6 group-by search and flatten groups for the REST API."""
        record = self.get(name)
        resolved = self._resolve_query_specs(
            record,
            queries=queries,
            legacy_vector=legacy_vector,
            legacy_vector_field=legacy_vector_field,
        )
        if len(resolved) != 1 or resolved[0].fts is not None:
            raise InvalidSchemaError(
                "Group-by search requires exactly one vector query.",
                extra={"name": name},
            )

        group_field = next(
            (field for field in record.schema.fields if field.name == group_by_field),
            None,
        )
        if group_field is None:
            raise InvalidSchemaError(
                f"Group-by field '{group_by_field}' is not declared on '{name}'.",
                extra={"groupByField": group_by_field},
            )
        if group_field.dataType in _ARRAY_SCALAR_TYPES:
            raise InvalidSchemaError(
                f"Group-by field '{group_by_field}' cannot use an array data type.",
                extra={
                    "groupByField": group_by_field,
                    "dataType": group_field.dataType.value,
                },
            )

        vector_field = next(
            (field for field in record.schema.vectors if field.name == resolved[0].field),
            None,
        )
        supported_indexes = {IndexType.FLAT, IndexType.HNSW, IndexType.HNSW_RABITQ}
        index_type = vector_field.indexParam.indexType if vector_field and vector_field.indexParam else IndexType.HNSW
        if index_type not in supported_indexes:
            raise InvalidSchemaError(
                f"Group-by search is not supported for {index_type.value} indexes.",
                extra={"indexType": index_type.value},
            )

        sdk_query = self._build_sdk_query(record, resolved[0])
        try:
            groups = record.sdk_obj.group_by_query(
                query=sdk_query,
                group_by_field_name=group_by_field,
                group_count=group_count,
                topk_per_group=top_k_per_group,
                filter=filter_expr,
                include_vector=include_vector,
                output_fields=output_fields,
            )
        except ValueError as exc:
            msg = _exc_msg(exc)
            if filter_expr is not None:
                raise InvalidFilterExpressionError(
                    msg,
                    extra={"filter": filter_expr},
                ) from exc
            raise InvalidSchemaError(msg, extra={"name": name}) from exc

        return [
            (
                doc.id,
                float(doc.score) if doc.score is not None else 0.0,
                _doc_to_dict(doc, schema=record.schema, include_vector=include_vector),
                str(group.group_by_value),
            )
            for group in groups
            for doc in group.docs
        ]

    # ---- search helpers ----

    @staticmethod
    def _resolve_query_specs(
        record: CollectionRecord,
        *,
        queries: list[VectorQuerySpec] | None,
        legacy_vector: Any | None,
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
            if not record.schema.vectors:
                raise InvalidSchemaError(
                    "Legacy vector search requires at least one vector field; use queries[].fts for FTS-only collections.",
                    extra={"name": record.name},
                )
            legacy_vector_field = record.schema.vectors[0].name
        return [VectorQuerySpec(field=legacy_vector_field, vector=legacy_vector)]

    @staticmethod
    def _build_sdk_query(
        record: CollectionRecord, spec: VectorQuerySpec
    ) -> SdkQuery:
        """Translate a :class:`VectorQuerySpec` to ``zvec.Query``.

        Validates that the target field exists and (for explicit-vector
        queries) that the dimension matches the field's declared dimension.
        FTS routes must target FTS-indexed ``STRING`` fields. Builds the
        per-query SDK ``*QueryParam`` if one is supplied.
        """
        if spec.fts is not None:
            field_def = next((f for f in record.schema.fields if f.name == spec.field), None)
            if field_def is None:
                raise InvalidSchemaError(
                    f"FTS field '{spec.field}' not declared on '{record.name}'.",
                    extra={"field": spec.field},
                )
            if field_def.dataType is not ScalarDataType.STRING:
                raise InvalidSchemaError(
                    f"FTS field '{spec.field}' must be STRING, got {field_def.dataType.value}.",
                    extra={"field": spec.field, "dataType": field_def.dataType.value},
                )
            if field_def.indexParam is None or field_def.indexParam.indexType is not IndexType.FTS:
                raise InvalidSchemaError(
                    f"Field '{spec.field}' does not have an FTS index.",
                    extra={"field": spec.field},
                )
            fts_kwargs: dict[str, Any] = {
                "field_name": spec.field,
                "fts": SdkFts(
                    match_string=spec.fts.matchString,
                    query_string=spec.fts.queryString,
                ),
            }
            sdk_param = SdkBackend._build_sdk_query_param(spec.param)
            if sdk_param is not None:
                fts_kwargs["param"] = sdk_param
            return SdkQuery(**fts_kwargs)

        matches = [v for v in record.schema.vectors if v.name == spec.field]
        if not matches:
            raise InvalidSchemaError(
                f"Vector field '{spec.field}' not declared on '{record.name}'.",
                extra={"vectorField": spec.field},
            )
        vec_def = matches[0]
        vector: Any = spec.vector
        if spec.vector is not None and _is_sparse_vector_type(vec_def.dataType):
            vector = _coerce_sparse_vector(spec.vector, vector_name=spec.field)
        elif spec.vector is not None and len(spec.vector) != vec_def.dimension:
            raise DimensionMismatchError(
                f"Query vector has dimension {len(spec.vector)},"
                f" expected {vec_def.dimension}.",
                extra={
                    "expectedDim": vec_def.dimension,
                    "actualDim": len(spec.vector),
                    "vectorField": spec.field,
                },
            )
        vector_kwargs: dict[str, Any] = {"field_name": spec.field}
        if spec.id is not None:
            vector_kwargs["id"] = spec.id
        else:
            vector_kwargs["vector"] = vector
        sdk_param = SdkBackend._build_sdk_query_param(spec.param)
        if sdk_param is not None:
            vector_kwargs["param"] = sdk_param
        return SdkQuery(**vector_kwargs)

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
        if isinstance(param, DiskAnnQueryParamSpec):
            return DiskAnnQueryParam(list_size=param.listSize)
        if isinstance(param, FtsQueryParamSpec):
            return FtsQueryParam(default_operator=param.defaultOperator or "")
        raise InvalidSchemaError(  # pragma: no cover - exhaustive
            f"Unsupported query param spec: {type(param).__name__}",
            extra={},
        )
