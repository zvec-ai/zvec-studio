#!/usr/bin/env python3
"""Launch an installed desktop app and smoke-test its bundled backend."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ARTIFACTS_DIR = REPO_ROOT / "artifacts" / "desktop-smoke"


class SmokeFailure(RuntimeError):
    """Raised when the installed desktop app fails its smoke flow."""


def _request(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    *,
    timeout: float = 10.0,
) -> tuple[int, dict[str, Any] | list[Any] | str | None]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return resp.status, None
            text = raw.decode("utf-8")
            try:
                return resp.status, json.loads(text)
            except json.JSONDecodeError:
                return resp.status, text
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        try:
            payload: dict[str, Any] | str = json.loads(text)
        except json.JSONDecodeError:
            payload = text
        return exc.code, payload


def _expect_status(
    method: str,
    url: str,
    expected: int,
    body: dict[str, Any] | None = None,
) -> dict[str, Any] | list[Any] | str | None:
    status, payload = _request(method, url, body)
    if status != expected:
        raise SmokeFailure(
            f"{method} {url} expected {expected}, got {status}: {json.dumps(payload, default=str)}"
        )
    return payload


def _wait_for_health(base_url: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: str | None = None
    url = f"{base_url}/api/v1/healthz"
    while time.monotonic() < deadline:
        try:
            status, payload = _request("GET", url, timeout=3.0)
            if status == 200 and isinstance(payload, dict) and payload.get("status") == "ok":
                return payload
            last_error = f"status={status} payload={payload!r}"
        except Exception as exc:  # noqa: BLE001 - preserve last startup failure.
            last_error = repr(exc)
        time.sleep(1.0)
    raise SmokeFailure(f"Timed out waiting for {url}; last_error={last_error}")


def _launch_app(args: argparse.Namespace, log_path: Path) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env["ZVEC_HOST"] = args.host
    env["ZVEC_PORT"] = str(args.port)
    env["ZVEC_READY_TIMEOUT_SECS"] = str(args.ready_timeout)
    env["ZVEC_STUDIO_DATA_DIR"] = str(args.artifacts_dir / "data")
    env.setdefault("NO_AT_BRIDGE", "1")
    env.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")

    app_path = args.app_path
    if app_path.suffix == ".app":
        cmd = ["open", "-n", str(app_path)]
    else:
        cmd = [str(app_path)]

    print(f"+ {' '.join(cmd)}", flush=True)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("wb")
    try:
        return subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env)
    except Exception:
        log.close()
        raise


def _terminate(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def _collection_path(root: Path, name: str) -> str:
    path = root / name
    if path.exists():
        shutil.rmtree(path)
    return str(path)


def _run_dense_flow(api: str, root: Path) -> None:
    name = "denseci"
    path = _collection_path(root, name)
    _expect_status(
        "POST",
        f"{api}/collections",
        201,
        {
            "path": path,
            "schema": {
                "name": name,
                "vectors": [
                    {
                        "name": "embedding",
                        "dataType": "VECTOR_FP32",
                        "dimension": 4,
                        "indexParam": {
                            "indexType": "HNSW",
                            "metric": "L2",
                            "params": {"M": 16},
                        },
                    }
                ],
                "fields": [
                    {"name": "title", "dataType": "STRING"},
                    {"name": "score", "dataType": "INT64"},
                ],
            },
        },
    )
    _expect_status(
        "POST",
        f"{api}/collections/{name}/documents",
        201,
        {
            "documents": [
                {"id": "d-001", "title": "alpha", "score": 1, "embedding": [1.0, 0.0, 0.0, 0.0]},
                {"id": "d-002", "title": "beta", "score": 2, "embedding": [2.0, 0.0, 0.0, 0.0]},
                {"id": "d-003", "title": "gamma", "score": 3, "embedding": [3.0, 0.0, 0.0, 0.0]},
            ]
        },
    )
    browse = _expect_status(
        "POST",
        f"{api}/collections/{name}/documents:browse",
        200,
        {"filter": "score >= 2", "limit": 10},
    )
    if not isinstance(browse, dict) or len(browse.get("items", [])) != 2:
        raise SmokeFailure(f"Dense browse returned unexpected payload: {browse!r}")
    search = _expect_status(
        "POST",
        f"{api}/collections/{name}/searches",
        200,
        {"vector": [0.0, 0.0, 0.0, 0.0], "topK": 2},
    )
    if not isinstance(search, dict) or len(search.get("results", [])) != 2:
        raise SmokeFailure(f"Dense search returned unexpected payload: {search!r}")


def _run_sparse_flow(api: str, root: Path) -> None:
    name = "sparseci"
    path = _collection_path(root, name)
    _expect_status(
        "POST",
        f"{api}/collections",
        201,
        {
            "path": path,
            "schema": {
                "name": name,
                "vectors": [
                    {
                        "name": "embedding",
                        "dataType": "SPARSE_VECTOR_FP32",
                        "dimension": 768,
                        "indexParam": {
                            "indexType": "HNSW",
                            "metric": "IP",
                            "params": {"M": 16},
                        },
                    }
                ],
                "fields": [{"name": "title", "dataType": "STRING"}],
            },
        },
    )
    _expect_status(
        "POST",
        f"{api}/collections/{name}/documents",
        201,
        {
            "documents": [
                {"id": "s-001", "title": "sparse-a", "embedding": {"41": 1, "42": 0.5}},
                {"id": "s-002", "title": "sparse-b", "embedding": {"99": 1}},
            ]
        },
    )
    search = _expect_status(
        "POST",
        f"{api}/collections/{name}/searches",
        200,
        {"vector": {"41": 1}, "topK": 1},
    )
    if not isinstance(search, dict) or len(search.get("results", [])) != 1:
        raise SmokeFailure(f"Sparse search returned unexpected payload: {search!r}")


def _tail(path: Path, lines: int = 80) -> str:
    if not path.is_file():
        return ""
    data = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(data[-lines:])


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app-path",
        type=Path,
        default=os.environ.get("DESKTOP_APP_PATH"),
        required=os.environ.get("DESKTOP_APP_PATH") is None,
        help="Installed app executable path.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=17861)
    parser.add_argument("--timeout", type=float, default=90.0)
    parser.add_argument("--ready-timeout", type=int, default=60)
    parser.add_argument("--artifacts-dir", type=Path, default=DEFAULT_ARTIFACTS_DIR)
    parser.add_argument("--keep-running", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    args.app_path = Path(args.app_path)
    if not args.app_path.exists():
        raise SystemExit(f"App path does not exist: {args.app_path}")

    args.artifacts_dir.mkdir(parents=True, exist_ok=True)
    log_path = args.artifacts_dir / "app.log"
    proc = _launch_app(args, log_path)
    base_url = f"http://{args.host}:{args.port}"
    api = f"{base_url}/api/v1"
    try:
        health = _wait_for_health(base_url, args.timeout)
        print(f"healthz={json.dumps(health, sort_keys=True)}", flush=True)
        root = args.artifacts_dir / "collections"
        root.mkdir(parents=True, exist_ok=True)
        _run_dense_flow(api, root)
        print("dense flow: ok", flush=True)
        _run_sparse_flow(api, root)
        print("sparse flow: ok", flush=True)
        return 0
    except Exception as exc:
        print(f"desktop API smoke failed: {exc}", file=sys.stderr, flush=True)
        tail = _tail(log_path)
        if tail:
            print("\n--- app.log tail ---", file=sys.stderr)
            print(tail, file=sys.stderr)
        return 1
    finally:
        if not args.keep_running:
            _terminate(proc)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
