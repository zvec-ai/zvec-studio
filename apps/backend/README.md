# zvec-studio-backend

> Standalone **REST + RFC 7807** gateway for the [Zvec](https://zvec.org) embedded vector database.
> Powers Zvec Studio UI and can be used independently by any HTTP client.

[![Python](https://img.shields.io/badge/python-3.10%20%7C%203.11%20%7C%203.12-blue)]()
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../LICENSE)

---

## Quick start

```bash
# Install (uv recommended)
uv sync                       # core only
uv sync --extra dev           # + tests, ruff, mypy
uv sync --extra dev --extra ai # + sentence-transformers / dashscope / openai / dashtext

# Or via pip
pip install -e ".[dev,ai]"

# Run
uv run zvec-studio --port 7860
```

Open:
- Swagger UI — http://127.0.0.1:7860/docs
- OpenAPI spec — http://127.0.0.1:7860/api/v1/openapi.json

```bash
curl http://127.0.0.1:7860/api/v1/healthz       # → {"status":"ok"}
curl http://127.0.0.1:7860/api/v1/collections   # → []
```

---

## Configuration

All settings via env vars (prefix `ZVEC_STUDIO_`) or `.env` file.
See [`zvec_studio/settings.py`](zvec_studio/settings.py).

| Variable | Default | Description |
| --- | --- | --- |
| `ZVEC_STUDIO_HOST` | `127.0.0.1` | Bind address |
| `ZVEC_STUDIO_PORT` | `7860` | Bind port |
| `ZVEC_STUDIO_LOG_LEVEL` | `info` | `critical \| error \| warning \| info \| debug` |
| `ZVEC_STUDIO_DATA_DIR` | `~/.zvec-studio` | Config & AI functions storage |
| `ZVEC_STUDIO_API_PREFIX` | `/api/v1` | Route prefix |
| `ZVEC_STUDIO_CORS_ORIGINS` | `http://127.0.0.1:5173` | CORS allow-list (comma-separated) |

---

## API overview

28 endpoints under `/api/v1`. Full reference → [`docs/backend.md`](../../docs/backend.md)

| Resource | Highlights |
| --- | --- |
| **Collections** | CRUD, `:flush`, `:optimize`, `:destroy`, field/index DDL |
| **Documents** | CRUD, `:browse`, `:upsert`, `:deleteByFilter` |
| **Searches** | Multi-vector ANN, per-query params, reranker reference |
| **AI Extension** | Embedding & reranker CRUD + `:embed` / `:rerank` verbs |

All errors follow **RFC 7807** (`application/problem+json`). Error codes in [`zvec_studio/exceptions.py`](zvec_studio/exceptions.py).

---

## Testing

```bash
uv run pytest                   # full suite (~216 tests)
uv run pytest tests/unit        # fast, no I/O
uv run pytest tests/integration # real SDK + httpx
make verify                     # full quality gate (from repo root)
```

---

## Packaging

**PyInstaller sidecar** (for Tauri desktop):

```bash
uv sync --extra packaging
uv run pyinstaller zvec_studio.spec    # → dist/zvec-studio-sidecar
```

**Embedding in your own app:**

```python
from fastapi import FastAPI
from zvec_studio.main import create_app

app = FastAPI()
app.mount("/zvec", create_app())
```

---

## Architecture

See [`docs/architecture.md`](../../docs/architecture.md) for the full request flow and module map.

## License

Apache-2.0 — [`LICENSE`](../../LICENSE)
