"""Opt-in deferred flushing, verified against the real SDK."""

from pathlib import Path
from unittest.mock import Mock

import pytest

from zvec_studio.main import create_app
from zvec_studio.schemas.collection import CollectionSchema
from zvec_studio.settings import Settings
from zvec_studio.storage.formats import JsonlFormat
from zvec_studio.storage.sdk import SdkBackend


def make_collection(backend: SdkBackend, path: Path) -> None:
    backend.create(
        path=path,
        schema=CollectionSchema.model_validate(
            {
                "name": "batch",
                "fields": [{"name": "title", "dataType": "STRING"}],
                "vectors": [
                    {
                        "name": "embedding",
                        "dataType": "VECTOR_FP32",
                        "dimension": 4,
                        "indexParam": {"indexType": "FLAT", "metric": "L2"},
                    }
                ],
            }
        ),
    )


def doc(id: str) -> dict:
    return {"id": id, "title": id, "embedding": [0.1, 0.2, 0.3, 0.4]}


@pytest.mark.parametrize("deferred", [False, True])
@pytest.mark.parametrize("save", ["flush", "close"])
def test_env_policy_file_reuse_and_reopen(tmp_path, monkeypatch, deferred, save):
    monkeypatch.delenv("ZVEC_STUDIO_AUTO_FLUSH", raising=False)
    if deferred:
        monkeypatch.setenv("ZVEC_STUDIO_AUTO_FLUSH", "false")
    app = create_app(Settings(data_dir=tmp_path / "config", _env_file=None))
    backend = app.state.backend
    path = tmp_path / "collection"
    make_collection(backend, path)
    try:
        for i in range(3):
            backend.insert_documents("batch", [doc(str(i))])
            assert backend.get_document("batch", str(i))["id"] == str(i)
        assert len(list(path.rglob("*.proxima"))) == (1 if deferred else 3)
        getattr(backend, save)("batch")
    finally:
        if backend.exists("batch"):
            backend.close("batch")
    backend.open(path)
    try:
        for i in range(3):
            assert backend.get_document("batch", str(i))["id"] == str(i)
    finally:
        backend.close("batch")


@pytest.mark.parametrize("auto_flush", [False, True])
def test_crud_respects_policy_but_explicit_save_and_import_still_flush(
    tmp_path, monkeypatch, auto_flush
):
    backend = SdkBackend(auto_flush=auto_flush)
    make_collection(backend, tmp_path / "collection")
    try:
        backend.insert_documents("batch", [doc("a"), doc("b"), doc("c")])
        sdk = backend.get("batch").sdk_obj
        with monkeypatch.context() as patch:
            flush = Mock(wraps=sdk.flush)
            patch.setattr(sdk, "flush", flush)
            backend.insert_documents("batch", [doc("d")])
            backend.upsert_documents("batch", [{"id": "a", "title": "merged"}, doc("e")])
            backend.update_documents("batch", [{"id": "a", "title": "updated"}])
            backend.delete_document("batch", "b")
            backend.delete_documents("batch", ["c"])
            backend.delete_by_filter("batch", "title = 'd'")
            assert flush.call_count == (6 if auto_flush else 0)
            backend.flush("batch")
            assert flush.call_count == (7 if auto_flush else 1)
            source = tmp_path / "rows.jsonl"
            source.write_text(
                '{"id":"imported","title":"imported","embedding":[0.1,0.2,0.3,0.4]}\n'
            )
            backend.import_documents("batch", source_path=str(source), fmt=JsonlFormat())
            assert flush.call_count == (8 if auto_flush else 2)
    finally:
        backend.close("batch")


def test_failed_close_keeps_deferred_writes_available_for_retry(tmp_path, monkeypatch):
    backend = SdkBackend(auto_flush=False)
    make_collection(backend, tmp_path / "collection")
    backend.insert_documents("batch", [doc("a")])
    record = backend.get("batch")
    try:
        with monkeypatch.context() as patch:
            patch.setattr(record.sdk_obj, "flush", Mock(side_effect=OSError("disk full")))
            with pytest.raises(OSError, match="disk full"):
                backend.close("batch")
            assert backend.get("batch") is record
            assert backend.get_document("batch", "a")["id"] == "a"
    finally:
        backend.close("batch")
