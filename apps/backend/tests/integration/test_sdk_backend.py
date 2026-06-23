"""Integration tests for the real Zvec SDK backend.

These tests bypass the HTTP layer and exercise :class:`SdkBackend` directly to
verify that the wrapper plays well with the actual ``zvec`` Python module:

- create / open / close round-trips persist on disk (manifest.0 + LOCK +
  idmap.0 RocksDB files appear);
- ``insert -> get -> browse -> search -> delete`` honour Zvec's contracts
  (str ids, ULID auto-generation, SQL-WHERE filter syntax);
- error mapping converts Zvec's ``ValueError`` family into Studio's typed
  exceptions.

Skipped automatically if ``zvec`` is not importable (e.g. on environments
without the wheel).
"""

from __future__ import annotations

from pathlib import Path

import pytest

zvec = pytest.importorskip("zvec")

from zvec_studio.exceptions import (  # noqa: E402  (import after skip)
    CollectionAlreadyExistsError,
    CollectionNotFoundError,
    DimensionMismatchError,
    DocumentNotFoundError,
    InvalidFilterExpressionError,
    InvalidSchemaError,
)
from zvec_studio.schemas.collection import CollectionSchema  # noqa: E402
from zvec_studio.storage import sdk as sdk_module  # noqa: E402
from zvec_studio.storage.sdk import SdkBackend  # noqa: E402

pytestmark = pytest.mark.integration


def _schema(name: str = "sdkcol", *, dim: int = 4, metric: str = "COSINE") -> CollectionSchema:
    return CollectionSchema.model_validate(
        {
            "name": name,
            "vectors": [
                {
                    "name": "embedding",
                    "dataType": "VECTOR_FP32",
                    "dimension": dim,
                    "indexParam": {
                        "indexType": "HNSW",
                        "metric": metric,
                        "params": {"M": 16, "efConstruction": 200},
                    },
                }
            ],
            "fields": [
                {"name": "title", "dataType": "STRING"},
                {"name": "year", "dataType": "INT64"},
            ],
        }
    )


def _doc(*, doc_id: str | None, title: str, year: int, vec: list[float]) -> dict:
    body: dict = {"title": title, "year": year, "embedding": vec}
    if doc_id is not None:
        body["id"] = doc_id
    return body


class TestLifecycle:
    def test_create_writes_zvec_artifacts_to_disk(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        path = tmp_path / "col1"
        record = backend.create(path=path, schema=_schema("colalpha"))
        assert record.name == "colalpha"
        # Real Zvec on-disk layout (RocksDB + manifest + LOCK).
        assert (path / "manifest.0").exists()
        assert (path / "LOCK").exists()
        assert (path / "idmap.0").is_dir()
        # No sidecar needed — SDK persists schema in its own manifest.
        assert not (path / "collection.json").exists()
        backend.close("colalpha")

    def test_create_rejects_existing_path(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        target = tmp_path / "exists"
        target.mkdir()
        with pytest.raises(CollectionAlreadyExistsError):
            backend.create(path=target, schema=_schema("colalpha"))

    def test_create_maps_sdk_runtime_error_to_invalid_schema(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def raise_runtime_error(_path: str, _schema: object) -> object:
            raise RuntimeError("DiskAnn is not supported on this platform (Linux x86_64 only)")

        monkeypatch.setattr(sdk_module.zvec, "create_and_open", raise_runtime_error)
        backend = SdkBackend()

        with pytest.raises(InvalidSchemaError) as exc:
            backend.create(path=tmp_path / "diskann", schema=_schema("colalpha"))

        assert "DiskAnn is not supported" in str(exc.value)
        assert exc.value.sdk_exception == "RuntimeError"

    def test_open_round_trip_after_close(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        path = tmp_path / "col"
        backend.create(path=path, schema=_schema("colalpha"))
        backend.close("colalpha")

        # Fresh backend instance -> open must reload schema from sidecar.
        fresh = SdkBackend()
        record = fresh.open(path)
        assert record.name == "colalpha"
        assert record.schema.vectors[0].dimension == 4
        fresh.close("colalpha")

    def test_open_missing_path_raises_not_found(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        with pytest.raises(CollectionNotFoundError):
            backend.open(tmp_path / "nowhere")

    def test_get_unknown_collection_raises_not_found(self) -> None:
        backend = SdkBackend()
        with pytest.raises(CollectionNotFoundError):
            backend.get("ghost")


class TestDocuments:
    def test_insert_then_get_roundtrip(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("cola"))
        try:
            ids = backend.insert_documents(
                "cola",
                [
                    _doc(doc_id="a", title="alpha", year=2024, vec=[1.0, 0.0, 0.0, 0.0]),
                    _doc(doc_id="b", title="beta", year=2025, vec=[0.0, 1.0, 0.0, 0.0]),
                ],
            )
            assert ids == ["a", "b"]
            got = backend.get_document("cola", "a")
            assert got["id"] == "a"
            assert got["title"] == "alpha"
            assert got["year"] == 2024
        finally:
            backend.close("cola")

    def test_insert_auto_ulid_when_id_missing(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("colb"))
        try:
            ids = backend.insert_documents(
                "colb",
                [_doc(doc_id=None, title="x", year=1, vec=[0.1, 0.2, 0.3, 0.4])],
            )
            assert len(ids) == 1
            assert isinstance(ids[0], str) and len(ids[0]) == 26  # ULID
        finally:
            backend.close("colb")

    def test_dimension_mismatch_raises(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("colc"))
        try:
            with pytest.raises(DimensionMismatchError):
                backend.insert_documents(
                    "colc",
                    [_doc(doc_id="x", title="t", year=1, vec=[0.0, 0.0])],
                )
        finally:
            backend.close("colc")

    def test_unknown_column_raises_invalid_schema(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("cold"))
        try:
            with pytest.raises(InvalidSchemaError):
                backend.insert_documents(
                    "cold",
                    [
                        {
                            "id": "x",
                            "title": "t",
                            "year": 1,
                            "embedding": [0.0, 0.0, 0.0, 0.0],
                            "rogue": "extra",
                        }
                    ],
                )
        finally:
            backend.close("cold")

    def test_delete_then_get_returns_404(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("cole"))
        try:
            backend.insert_documents(
                "cole",
                [_doc(doc_id="z", title="t", year=1, vec=[0.0, 0.0, 0.0, 0.0])],
            )
            backend.delete_document("cole", "z")
            with pytest.raises(DocumentNotFoundError):
                backend.get_document("cole", "z")
        finally:
            backend.close("cole")


class TestBrowseAndSearch:
    def test_browse_filter_sql_where(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("colf"))
        try:
            backend.insert_documents(
                "colf",
                [
                    _doc(doc_id=f"d{i}", title="tech" if i % 2 == 0 else "other",
                         year=2020 + i, vec=[float(i), 0.0, 0.0, 0.0])
                    for i in range(5)
                ],
            )
            items = backend.browse(
                "colf",
                filter_expr="title = 'tech'",
                limit=10,
                output_fields=None,
                include_vector=False,
            )
            ids = sorted(d["id"] for d in items)
            assert ids == ["d0", "d2", "d4"]
        finally:
            backend.close("colf")

    def test_browse_invalid_filter_raises(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("colg"))
        try:
            # Filter parser only fires when there is data to scan; insert one
            # row so Zvec actually invokes the SQL-WHERE engine.
            backend.insert_documents(
                "colg",
                [_doc(doc_id="seed", title="t", year=1, vec=[0.0, 0.0, 0.0, 0.0])],
            )
            with pytest.raises(InvalidFilterExpressionError):
                backend.browse(
                    "colg",
                    filter_expr="not a valid expression",
                    limit=5,
                    output_fields=None,
                    include_vector=False,
                )
        finally:
            backend.close("colg")

    def test_search_returns_topk(self, tmp_path: Path) -> None:
        backend = SdkBackend()
        backend.create(path=tmp_path / "c", schema=_schema("colh", metric="L2"))
        try:
            backend.insert_documents(
                "colh",
                [
                    _doc(doc_id=f"d{i:03d}", title="t", year=2020,
                         vec=[float(i), 0.0, 0.0, 0.0])
                    for i in range(1, 6)
                ],
            )
            hits = backend.search(
                "colh",
                legacy_vector=[0.0, 0.0, 0.0, 0.0],
                top_k=3,
                filter_expr=None,
            )
            ids = [doc_id for doc_id, _score, _fields in hits]
            # L2 nearest to origin is the smallest x.
            assert ids[:3] == ["d001", "d002", "d003"]
        finally:
            backend.close("colh")
