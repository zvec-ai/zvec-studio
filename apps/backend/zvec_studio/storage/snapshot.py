"""Snapshot packaging: ``manifest.json`` + ``documents.jsonl``.

A snapshot export bundles the collection schema and export options in a
``manifest.json`` next to the JSONL data (design doc §6.2.2). On import the
manifest is read *before any row is written* so schema incompatibility fails
fast (409) instead of surfacing mid-file.

Naming / versioning rules:

* ``MANIFEST_FORMAT`` is ``zvec-studio.export/<major>``. A major bump means
  incompatible manifest changes; parsers reject unknown majors.
* No ``docCount`` is recorded: streaming generation cannot know it up front,
  and the importer counts actual rows anyway (design doc §6.2.2).
"""

from __future__ import annotations

import queue
import tarfile
import threading
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, cast

import orjson
import zvec

from zvec_studio.__about__ import __version__ as STUDIO_VERSION
from zvec_studio.exceptions import (
    ImportManifestInvalidError,
    ImportSchemaMismatchError,
)
from zvec_studio.schemas.collection import CollectionSchema

#: Member file names inside the snapshot package.
MANIFEST_NAME = "manifest.json"
DATA_FILE_NAME = "documents.jsonl"

#: Format identifier written into the manifest (major version = contract).
MANIFEST_FORMAT = "zvec-studio.export/1"
_MANIFEST_PREFIX = "zvec-studio.export/"
_SUPPORTED_MAJOR = "1"


def build_manifest(
    *,
    schema: CollectionSchema,
    include_vector: bool,
    output_fields: list[str] | None,
) -> dict[str, Any]:
    """Build the manifest document for a snapshot export."""
    return {
        "format": MANIFEST_FORMAT,
        "exportedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "zvecVersion": getattr(zvec, "__version__", "unknown"),
        "studioVersion": STUDIO_VERSION,
        "collection": {
            "name": schema.name,
            "schema": schema.model_dump(mode="json"),
        },
        "options": {
            "includeVector": include_vector,
            "outputFields": output_fields,
        },
        "data": {
            "file": DATA_FILE_NAME,
            "format": "jsonl",
            "encoding": "utf-8",
        },
    }


def parse_manifest(raw: bytes) -> dict[str, Any]:
    """Parse and structurally validate a manifest.

    Raises:
        ImportManifestInvalidError: unreadable JSON, wrong shape, unknown
            format major, or missing required members.
    """
    try:
        manifest = orjson.loads(raw)
    except orjson.JSONDecodeError as exc:
        raise ImportManifestInvalidError(
            f"manifest.json is not valid JSON: {exc}"
        ) from exc
    if not isinstance(manifest, dict):
        raise ImportManifestInvalidError("manifest.json must be a JSON object.")

    fmt = manifest.get("format")
    if not isinstance(fmt, str) or not fmt.startswith(_MANIFEST_PREFIX):
        raise ImportManifestInvalidError(
            f"manifest.json carries an unrecognized format: {fmt!r}."
        )
    major = fmt.removeprefix(_MANIFEST_PREFIX)
    if major != _SUPPORTED_MAJOR:
        raise ImportManifestInvalidError(
            f"manifest.json format major '{major}' is not supported "
            f"(supported: {_SUPPORTED_MAJOR}). Upgrade Studio."
        )

    collection = manifest.get("collection")
    if not isinstance(collection, dict) or not isinstance(collection.get("schema"), dict):
        raise ImportManifestInvalidError(
            "manifest.json is missing 'collection.schema'."
        )
    try:
        CollectionSchema.model_validate(collection["schema"])
    except ValueError as exc:
        raise ImportManifestInvalidError(
            f"manifest.json schema is invalid: {exc}"
        ) from exc
    return manifest


def read_snapshot_manifest(path: Path) -> dict[str, Any]:
    """Open a snapshot package and return its parsed manifest.

    Used by collection restore (which needs the schema before creating
    anything). Raises the same 400-class errors the import path reports for
    unreadable / malformed packages.
    """
    try:
        with tarfile.open(path, mode="r:gz") as tar:
            members = {m.name: m for m in tar if m.isfile()}
            if MANIFEST_NAME not in members:
                raise ImportManifestInvalidError(
                    f"Snapshot must contain '{MANIFEST_NAME}'.",
                    extra={"members": sorted(members)},
                )
            manifest_file = tar.extractfile(members[MANIFEST_NAME])
            if manifest_file is None:
                raise ImportManifestInvalidError(
                    f"'{MANIFEST_NAME}' is not a readable file inside the snapshot."
                )
            return parse_manifest(manifest_file.read())
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise ImportManifestInvalidError(
            f"'{path.name}' is not a readable snapshot package: {exc}",
            extra={"path": str(path)},
        ) from exc


def check_schema_compatible(manifest: dict[str, Any], target: CollectionSchema) -> None:
    """Verify the snapshot can be imported into *target*; raise otherwise.

    Rules (all collected, reported together):
    * every vector in the snapshot must exist in the target with the same
      dtype and dimension (indexes are rebuilt, not compared);
    * every scalar field in the snapshot must exist in the target with the
      same dtype (the target may have extra fields — a pruned export is fine);
      fields dropped by ``options.outputFields`` never appear in the data, so
      they are exempt from this check;
    * if the target declares vectors but the snapshot was exported without
      them, repopulating is impossible.

    Raises:
        ImportSchemaMismatchError: with ``extra['mismatches']`` listing all
            incompatibilities.
    """
    source = CollectionSchema.model_validate(manifest["collection"]["schema"])
    options = manifest.get("options") or {}
    mismatches: list[str] = []

    target_vectors = {v.name: v for v in target.vectors}
    for v in source.vectors:
        tv = target_vectors.get(v.name)
        if tv is None:
            mismatches.append(f"Vector '{v.name}' is not defined on the target collection.")
        elif tv.dataType != v.dataType:
            mismatches.append(
                f"Vector '{v.name}' dtype differs: snapshot {v.dataType.value}, "
                f"target {tv.dataType.value}."
            )
        elif v.dimension != tv.dimension:
            mismatches.append(
                f"Vector '{v.name}' dimension differs: snapshot {v.dimension}, "
                f"target {tv.dimension}."
            )

    # ``outputFields`` prunes columns out of the data rows; only the kept
    # columns need to line up with the target schema.
    raw_output_fields = options.get("outputFields")
    pruned: set[str] | None = None
    if isinstance(raw_output_fields, list) and raw_output_fields:
        pruned = {str(name) for name in raw_output_fields}

    target_fields = {f.name: f for f in target.fields}
    for f in source.fields:
        if pruned is not None and f.name not in pruned:
            continue
        tf = target_fields.get(f.name)
        if tf is None:
            mismatches.append(f"Field '{f.name}' is not defined on the target collection.")
        elif tf.dataType != f.dataType:
            mismatches.append(
                f"Field '{f.name}' dtype differs: snapshot {f.dataType.value}, "
                f"target {tf.dataType.value}."
            )

    if target.vectors and not options.get("includeVector", True):
        mismatches.append(
            "The snapshot was exported without vectors, but the target "
            "collection requires them."
        )

    if mismatches:
        raise ImportSchemaMismatchError(
            "Snapshot schema is not compatible with the target collection: "
            + " ".join(mismatches),
            extra={"mismatches": mismatches},
        )


# ---------------------------------------------------------------------------
# Package assembly / streaming
# ---------------------------------------------------------------------------


def write_snapshot_package(
    *,
    rows: Iterator[dict[str, Any]],
    serialize: Any,
    manifest: dict[str, Any],
    tmp_dir: Path,
) -> tuple[Path, Path]:
    """Materialize ``documents.jsonl`` + ``manifest.json`` into *tmp_dir*.

    Streaming caveat (see design doc §5.7): a tar member's header must carry
    its size up front, and the JSONL size is unknown until fully serialized.
    The data is therefore staged on disk first (temp space ~= data size),
    then tar-streamed without holding it in memory. Returns
    ``(manifest_path, data_path)``.
    """
    data_path = tmp_dir / DATA_FILE_NAME
    with data_path.open("wb") as out:
        for chunk in serialize(rows):
            out.write(chunk)
    manifest_path = tmp_dir / MANIFEST_NAME
    manifest_path.write_bytes(orjson.dumps(manifest, option=orjson.OPT_INDENT_2))
    return manifest_path, data_path


class _QueueWriter:
    """File-like adapter feeding a producer thread's bytes into a queue.

    ``cancelled`` lets the consumer (an aborted HTTP download) wake a
    producer that is blocked pushing into the bounded queue — without it the
    thread would sit on ``q.put`` until process exit.
    """

    def __init__(self, q: queue.Queue[bytes | None], cancelled: threading.Event) -> None:
        self._q = q
        self._cancelled = cancelled

    def write(self, data: bytes) -> int:
        if data:
            payload = bytes(data)
            while True:
                if self._cancelled.is_set():
                    raise RuntimeError("snapshot export cancelled")
                try:
                    # A plain ``put`` could block forever on a full queue once the
                    # consumer is gone; poll so cancellation wins promptly.
                    self._q.put(payload, timeout=0.1)
                    break
                except queue.Full:
                    continue
        return len(data)

    def close(self) -> None:  # tarfile calls close(); the queue owns lifetime
        pass


#: Worker thread name — tests use it to assert no producer leaks on abort.
SNAPSHOT_WORKER_NAME = "zvec-studio-snapshot-export"


def stream_snapshot_package(
    *, manifest_path: Path, data_path: Path
) -> Iterator[bytes]:
    """Yield a gzip tar (manifest first, then documents) without buffering it.

    ``tarfile`` writes synchronously, so compression runs on a worker thread
    pushing chunks through a bounded queue; the generator consumes them,
    keeping peak memory at a handful of chunks regardless of package size.
    On early close (client disconnect) a cancellation event unblocks the
    producer so the thread exits promptly instead of leaking.
    """
    q: queue.Queue[bytes | None] = queue.Queue(maxsize=32)
    errors: list[BaseException] = []
    cancelled = threading.Event()

    def produce() -> None:
        try:
            writer = cast(BinaryIO, _QueueWriter(q, cancelled))
            with tarfile.open(fileobj=writer, mode="w|gz") as tar:
                tar.add(str(manifest_path), arcname=MANIFEST_NAME)
                tar.add(str(data_path), arcname=DATA_FILE_NAME)
        except BaseException as exc:  # re-raised in consumer
            if not cancelled.is_set():
                errors.append(exc)
        finally:
            # The sentinel is only needed by a live consumer; once cancelled,
            # nobody drains the queue, so don't block on a full one.
            while not cancelled.is_set():
                try:
                    q.put(None, timeout=0.1)
                    break
                except queue.Full:
                    continue

    worker = threading.Thread(target=produce, name=SNAPSHOT_WORKER_NAME, daemon=True)
    worker.start()
    try:
        while True:
            chunk = q.get()
            if chunk is None:
                break
            yield chunk
    finally:
        cancelled.set()
        worker.join(timeout=5)
    if errors:
        raise errors[0]
