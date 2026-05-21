"""Seed a demo Collection + 120 documents so the T8 Documents panel has
content to browse when running `pnpm dev`. Idempotent-ish: recreates the
collection on every run."""
from __future__ import annotations

import urllib.request
import urllib.error
import json
import random

API = "http://127.0.0.1:7860/api/v1"


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8") or "null"
            return resp.status, json.loads(raw) if raw != "null" else None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        return e.code, (json.loads(body) if body else None)


def main() -> None:
    name = "demo_docs"

    # best-effort cleanup
    call("DELETE", f"/collections/{name}")

    schema = {
        "name": name,
        "description": "T8 demo collection",
        "vectors": [
            {"name": "embedding", "dataType": "VECTOR_FP32", "dimension": 32,
             "description": "demo vector"}
        ],
        "fields": [
            {"name": "id", "dataType": "INT64", "isPrimary": True, "description": None},
            {"name": "title", "dataType": "STRING", "isPrimary": False, "description": None},
            {"name": "score", "dataType": "FLOAT", "isPrimary": False, "description": None},
        ],
        "indexParams": {"indexType": "HNSW", "metric": "COSINE", "params": {"M": 16}},
    }
    status, body = call("POST", "/collections", {"path": f"./data/{name}", "schema": schema})
    print("create:", status, body)

    random.seed(42)
    docs = [
        {
            "id": i,
            "title": f"Demo document {i}",
            "score": round(random.random(), 4),
            "embedding": [round(random.random(), 4) for _ in range(32)],
        }
        for i in range(1, 121)
    ]
    status, body = call("POST", f"/collections/{name}/documents", {"documents": docs})
    print("insert:", status, body)


if __name__ == "__main__":
    main()
