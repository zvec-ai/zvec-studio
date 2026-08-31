"""Integration tests for ``POST /collections:import``.

Snapshot restore is a *collection-level* lifecycle operation (create the
collection from the manifest schema, then load the data) — deliberately a
sibling of create/open rather than a variant of document import.
"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration

API = "/api/v1"


def _payload(name: str = "demo") -> dict:
    return {
        "name": name,
        "vectors": [
            {
                "name": "embedding",
                "dataType": "VECTOR_FP32",
                "dimension": 4,
                "indexParam": {"indexType": "FLAT", "metric": "L2"},
            }
        ],
        "fields": [{"name": "title", "dataType": "STRING"}],
    }


async def _make_snapshot(client: AsyncClient, tmp_path: Path) -> Path:
    """Create + seed a collection, then export it as a snapshot package."""
    resp = await client.post(
        f"{API}/collections",
        json={"path": str(tmp_path / "source"), "schema": _payload()},
    )
    assert resp.status_code == 201, resp.text
    docs = [
        {
            "id": f"doc-{i}",
            "title": f"t{i}",
            "embedding": [float(i), 0.0, 0.0, 0.0],
        }
        for i in range(3)
    ]
    resp = await client.post(f"{API}/collections/demo/documents", json={"documents": docs})
    assert resp.status_code == 201, resp.text

    resp = await client.get(f"{API}/collections/demo/documents:export?mode=snapshot")
    assert resp.status_code == 200, resp.text
    snapshot = tmp_path / "demo.tar.gz"
    snapshot.write_bytes(resp.content)
    return snapshot


def _restore_body(snapshot: Path, target: Path, **overrides: object) -> dict:
    body: dict = {
        "source": {"kind": "localPath", "path": str(snapshot)},
        "targetPath": str(target),
    }
    body.update(overrides)
    return body


class TestImportCollection:
    async def test_restores_collection_from_snapshot(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        snapshot = await _make_snapshot(client, tmp_path)

        # The exporter itself is still open under the manifest name, so the
        # restore must rename (the default-name clash has its own test).
        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, tmp_path / "restored", name="restored_demo"),
        )

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["collection"]["name"] == "restored_demo"
        assert body["collection"]["path"].endswith("restored")
        assert body["report"]["imported"] == 3
        assert body["report"]["failed"] == 0

        # The restored collection is live and browsable.
        got = await client.get(f"{API}/collections/restored_demo/documents/doc-1")
        assert got.status_code == 200, got.text
        assert got.json()["title"] == "t1"

    async def test_restore_with_name_override(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The manifest name may clash with an open collection; renaming
        the restored one is always possible."""
        snapshot = await _make_snapshot(client, tmp_path)

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, tmp_path / "copy", name="demo_copy"),
        )

        assert resp.status_code == 201, resp.text
        assert resp.json()["collection"]["name"] == "demo_copy"
        got = await client.get(f"{API}/collections/demo_copy/documents/doc-0")
        assert got.status_code == 200

    async def test_restore_default_name_clash_is_409_with_guidance(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The exporter's own collection is still open under the manifest
        name — restoring with the default name must conflict with a message
        that says to close it or pick another name (the exact scenario that
        once produced two same-named open collections)."""
        snapshot = await _make_snapshot(client, tmp_path)  # 'demo' stays open

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, tmp_path / "restored"),
        )

        assert resp.status_code == 409, resp.text
        body = resp.json()
        assert body["code"] == "COLLECTION_ALREADY_EXISTS"
        assert "close" in body["detail"].lower()
        assert "another name" in body["detail"].lower()

    async def test_missing_snapshot_is_404(self, client: AsyncClient, tmp_path: Path) -> None:
        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(tmp_path / "nope.tar.gz", tmp_path / "out"),
        )
        assert resp.status_code == 404, resp.text
        assert resp.json()["code"] == "IMPORT_FILE_NOT_FOUND"

    async def test_corrupt_snapshot_is_400(self, client: AsyncClient, tmp_path: Path) -> None:
        broken = tmp_path / "broken.tar.gz"
        broken.write_bytes(b"definitely not gzip")

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(broken, tmp_path / "out"),
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "IMPORT_MANIFEST_INVALID"

    async def test_tar_without_manifest_is_400(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        tar_path = tmp_path / "nomani.tar.gz"
        with tarfile.open(tar_path, "w:gz") as tar:
            data = b'{"id": "x"}\n'
            info = tarfile.TarInfo("documents.jsonl")
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(tar_path, tmp_path / "out"),
        )

        assert resp.status_code == 400, resp.text
        assert resp.json()["code"] == "IMPORT_MANIFEST_INVALID"

    async def test_existing_target_directory_is_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        snapshot = await _make_snapshot(client, tmp_path)
        occupied = tmp_path / "occupied"
        occupied.mkdir()
        (occupied / "sentinel.txt").write_text("keep me")

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, occupied),
        )

        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "COLLECTION_ALREADY_EXISTS"
        assert (occupied / "sentinel.txt").exists()  # untouched

    async def test_existing_empty_target_directory_is_409(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """The Zvec engine refuses any existing path, empty dirs included."""
        snapshot = await _make_snapshot(client, tmp_path)
        empty = tmp_path / "empty-dir"
        empty.mkdir()

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, empty),
        )

        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "COLLECTION_ALREADY_EXISTS"

    async def test_invalid_override_name_is_422(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        snapshot = await _make_snapshot(client, tmp_path)

        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, tmp_path / "out", name="x"),  # too short
        )

        assert resp.status_code == 422

    async def test_bad_row_rolls_back_whole_collection(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """Collection import is all-or-nothing: one malformed row must abort
        the load AND roll back the freshly created collection — the report
        channel alone (aborted=true, 201) would leave a half-populated
        collection behind, contradicting the import contract.
        """
        snapshot = await _make_snapshot(client, tmp_path)
        # Rebuild the package with one valid row followed by a bad one.
        import io
        import tarfile as tarfile_mod

        raw = io.BytesIO()
        with (
            tarfile_mod.open(fileobj=raw, mode="w:gz") as tar,
            tarfile_mod.open(snapshot, "r:gz") as src,
        ):
            for member in src:
                if member.name == "documents.jsonl":
                    payload = (
                        b'{"id": "ok", "title": "t", "embedding": [0.0, 0.0, 0.0, 0.0]}\n'
                        b"not json\n"
                    )
                    member.size = len(payload)
                    tar.addfile(member, io.BytesIO(payload))
                else:
                    tar.addfile(member, src.extractfile(member))
        broken = tmp_path / "broken-row.tar.gz"
        broken.write_bytes(raw.getvalue())

        target = tmp_path / "never-kept"
        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(broken, target, name="demo2"),
        )

        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "INVALID_DOCUMENT"
        # Nothing is left behind: not the collection, not the directory.
        names = {i["name"] for i in (await client.get(f"{API}/collections")).json()["items"]}
        assert "demo2" not in names
        assert not target.exists()

    async def test_vectorless_snapshot_rejected_before_anything_is_created(
        self, client: AsyncClient, tmp_path: Path
    ) -> None:
        """A snapshot exported with includeVector=false cannot repopulate a
        vector-bearing collection. The mismatch must be detected BEFORE the
        target directory is created — otherwise the failed import leaves a
        ghost collection that permanently occupies ``targetPath``."""
        source_dir = tmp_path / "src"
        resp = await client.post(
            f"{API}/collections",
            json={"path": str(source_dir), "schema": _payload()},
        )
        assert resp.status_code == 201, resp.text
        await client.post(
            f"{API}/collections/demo/documents",
            json={"documents": [{"id": "d1", "title": "t", "embedding": [0.1, 0.2, 0.3, 0.4]}]},
        )

        # Snapshot WITHOUT vectors.
        resp = await client.get(
            f"{API}/collections/demo/documents:export?mode=snapshot&includeVector=false"
        )
        assert resp.status_code == 200, resp.text
        snapshot = tmp_path / "novectors.tar.gz"
        snapshot.write_bytes(resp.content)

        target = tmp_path / "out"
        resp = await client.post(f"{API}/collections:import", json=_restore_body(snapshot, target))

        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "IMPORT_SCHEMA_MISMATCH"
        # Nothing was created: no directory, no open collection.
        assert not target.exists()
        listing = (await client.get(f"{API}/collections")).json()["items"]
        assert all(i["name"] != "demo" or i["path"] != str(target) for i in listing)

    async def test_mid_load_failure_rolls_back_fresh_collection(
        self, client: AsyncClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """If the data load blows up mid-stream after rows were written (a
        corrupt member decompressing half-way is the real-world trigger —
        see the truncation cases in :mod:`formats` tests and the guarded
        reader in ``sdk._open_import_stream``), the freshly created
        collection must be rolled back instead of being left half-imported
        behind an error response.

        The load itself is stubbed to fail deterministically; what this test
        pins is the rollback orchestration on the route.
        """
        from zvec_studio.exceptions import InvalidDocumentError
        from zvec_studio.storage.sdk import SdkBackend

        snapshot = await _make_snapshot(client, tmp_path)

        def boom(self, *args, **kwargs):
            raise InvalidDocumentError("simulated mid-stream failure")

        monkeypatch.setattr(SdkBackend, "import_documents", boom)

        target = tmp_path / "rolled-back"
        resp = await client.post(
            f"{API}/collections:import",
            json=_restore_body(snapshot, target, name="imported_demo"),
        )

        assert resp.status_code == 422, resp.text
        assert not target.exists(), "rollback must remove the collection directory"
        names = {i["name"] for i in (await client.get(f"{API}/collections")).json()["items"]}
        assert names == {"demo"}
