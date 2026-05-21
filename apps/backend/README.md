# zvec-studio-backend

> A standalone **REST + RFC 7807** gateway for the [Zvec embedded vector database](https://zvec.org).
> Powers the Zvec Studio Web/Desktop UI **and** can be used independently by any HTTP client
> that needs collection management, document CRUD, vector search and AI extension wiring.

[![Tests](https://img.shields.io/badge/tests-216%20passing-brightgreen)](#testing)
[![Python](https://img.shields.io/badge/python-3.10%20%7C%203.11%20%7C%203.12-blue)]()
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../LICENSE)

---

## Why this exists

The Zvec Python SDK is a `pybind11` wrapper around a C++ engine — great for in-process use,
inconvenient for:

- web/desktop UIs that need a versioned wire contract,
- polyglot stacks (Node / Go / Java) that can't link a Python extension,
- containerised deployments that want a clean process boundary,
- multi-tenant scenarios that need request tracing, structured logging, and uniform error reporting.

**`zvec-studio-backend`** wraps the SDK with:

- a **FastAPI** application exposing 28 versioned endpoints under `/api/v1`,
- **Pydantic v2** schemas (`extra="forbid"`) and a typed OpenAPI 3.1 contract,
- **AIP-136** custom verbs for side-effectful actions (`:flush`, `:browse`, `:embed`, …),
- **RFC 7807 Problem Details** for every error path,
- request **tracing** + **JSON-Lines** access log for production observability,
- the SDK's **AI Extension** (embeddings, rerankers) surfaced as first-class CRUD resources
  with `chmod 0600` on-disk persistence (see [docs/backend.md §16](../../docs/backend.md)).

It runs as:

1. a **standalone HTTP service** (`pip install zvec-studio` then `zvec-studio --port 7860`),
2. a **PyInstaller-frozen binary** consumed by the Tauri desktop app as a sidecar,
3. an **embedded ASGI app** importable as `zvec_studio.main:app` for tests / custom mounts.

---

## Project layout

Tracked source (everything else is build/cache output, see [`.gitignore`](../../.gitignore)):

```
apps/backend/
├── README.md              ← this file
├── pyproject.toml         ← package metadata, [project], [optional-dependencies], ruff/mypy/pytest config
├── uv.lock                ← reproducible dependency resolution (uv)
├── zvec_studio.spec       ← PyInstaller recipe for the Tauri sidecar binary
├── zvec_studio/           ← the Python package
│   ├── __about__.py       ← single source of truth for __version__
│   ├── __main__.py        ← `python -m zvec_studio` shim
│   ├── cli.py             ← `zvec-studio` console-script entry point
│   ├── main.py            ← FastAPI app factory `create_app()` + module-level `app`
│   ├── settings.py        ← Pydantic Settings (env vars `ZVEC_STUDIO_*`)
│   ├── deps.py            ← shared FastAPI dependencies
│   ├── exceptions.py      ← ZvecStudioError hierarchy + business codes
│   ├── registry.py        ← in-process Collection registry (thread-safe)
│   ├── config_store.py    ← `~/.zvec-studio/config.json` recent-collections persistence
│   ├── ai_store.py        ← `~/.zvec-studio/ai_functions.json` (atomic mkstemp + chmod 0600)
│   ├── ai_service.py      ← lazy-import factory for SDK embedding/reranker classes
│   ├── routers/           ← FastAPI routers grouped by resource
│   │   ├── collections.py     ← lifecycle, recent, DDL, maintenance verbs
│   │   ├── documents.py       ← CRUD, browse, upsert, deleteByFilter
│   │   ├── searches.py        ← multi-vector ANN + per-query params + reranker reference
│   │   ├── ai.py              ← /ai/embeddings, /ai/rerankers, :embed, :rerank
│   │   └── fs.py              ← /fs/list directory picker for the desktop UI
│   ├── schemas/           ← Pydantic models split by resource
│   │   ├── collection.py, document.py, search.py, ai.py
│   │   └── __init__.py    ← re-exports the public surface
│   ├── storage/
│   │   └── sdk.py         ← SdkBackend: the only adapter, talks to `zvec` SDK 0.4.x
│   ├── middleware/
│   │   ├── trace_id.py    ← X-Trace-Id header + ContextVar
│   │   ├── logging.py     ← JSON Lines access log
│   │   └── error_handler.py ← maps ZvecStudioError / Validation / HTTPException → RFC 7807
│   └── py.typed           ← PEP 561 marker (the package ships type information)
└── tests/
    ├── conftest.py        ← async httpx client + isolated tmp data dir per test
    ├── unit/              ← pure-Python, no I/O (schemas, registry, factories, …)
    ├── integration/       ← real ASGI client + real zvec SDK + tmp_path persistence
    └── contract/          ← schemathesis OpenAPI fuzz placeholder
```

Anything you may see locally but is **not** committed (covered by the root `.gitignore`):

| Path | What it is |
| --- | --- |
| `.venv/` | local virtualenv created by `uv sync` / `pip install -e .` |
| `.pytest_cache/` `.mypy_cache/` `.ruff_cache/` `.hypothesis/` `.benchmarks/` | tool caches |
| `.coverage` `.coverage.*` `htmlcov/` | coverage artefacts |
| `build/` `dist/` | PyInstaller intermediate + final sidecar binary |
| `artifacts/` | per-failure pytest log dumps used by the self-heal loop |
| `data/` | local zvec collection directories created by demos / dev scripts |
| `.run/` | foreground/background server logs (e.g. `nohup uvicorn` output) |
| `zvec_studio.egg-info/` | setuptools metadata generated on editable install |

---

## Quick start

### 1. Install

```bash
# Option A — uv (recommended, fastest, deterministic via uv.lock)
uv sync                       # core only
uv sync --extra dev           # + tests, ruff, mypy
uv sync --extra ai            # + sentence-transformers / dashscope / openai
uv sync --extra packaging     # + pyinstaller (sidecar build)

# Option B — pip
pip install -e ".[dev]"
pip install -e ".[ai]"

# Option C — published wheel (when released)
pip install zvec-studio
pip install "zvec-studio[ai]"
```

`[ai]` is opt-in because `sentence-transformers` pulls PyTorch (~1 GB).
The SDK extension classes are imported lazily; missing extras surface as a
**503 `AI_DEPENDENCY_MISSING`** Problem Details response, not a startup crash.

### 2. Run

```bash
# Console script (installed by [project.scripts])
zvec-studio --port 7860

# Or directly with uvicorn
uvicorn zvec_studio.main:app --host 127.0.0.1 --port 7860 --reload

# Or as a module
python -m zvec_studio --port 7860
```

Open:

- Swagger UI — http://127.0.0.1:7860/docs
- ReDoc — http://127.0.0.1:7860/redoc
- Raw OpenAPI 3.1 — http://127.0.0.1:7860/api/v1/openapi.json

### 3. Smoke test

```bash
curl http://127.0.0.1:7860/api/v1/healthz       # → {"status":"ok","version":"…"}
curl http://127.0.0.1:7860/api/v1/readyz        # → {"status":"ready","version":"…"}
curl http://127.0.0.1:7860/api/v1/collections   # → []  (empty registry)
```

---

## Configuration

All settings are read from environment variables (prefix `ZVEC_STUDIO_`) or a `.env`
file next to the package. See [`zvec_studio/settings.py`](zvec_studio/settings.py).

| Variable | Default | Description |
| --- | --- | --- |
| `ZVEC_STUDIO_HOST` | `127.0.0.1` | bind address — keep loopback unless you front it with a TLS proxy |
| `ZVEC_STUDIO_PORT` | `7860` | bind port |
| `ZVEC_STUDIO_LOG_LEVEL` | `info` | `critical | error | warning | info | debug` |
| `ZVEC_STUDIO_DATA_DIR` | `~/.zvec-studio` | where `config.json` and `ai_functions.json` live (the latter at `chmod 0600`) |
| `ZVEC_STUDIO_API_PREFIX` | `/api/v1` | mount prefix for all routes |
| `ZVEC_STUDIO_CORS_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | CORS allow-list (comma-separated) |

For production deployments, override CORS and bind address explicitly:

```bash
ZVEC_STUDIO_HOST=0.0.0.0 \
ZVEC_STUDIO_CORS_ORIGINS=https://studio.example.com \
zvec-studio --port 8080
```

---

## API surface (28 endpoints under `/api/v1`)

Full reference in [`docs/backend.md` §6](../../docs/backend.md). Highlights:

| Resource | Endpoints |
| --- | --- |
| **Meta** | `GET /healthz`, `GET /readyz` |
| **Collections** | `GET/POST /collections`, `POST /collections/open`, `GET /collections/{name}` (`/schema`, `/stats`), `DELETE /collections/{name}`, plus `:flush`, `:optimize`, `:destroy` verbs and `fields` / `indexes` DDL |
| **Documents** | `POST/PATCH /collections/{name}/documents`, `GET/DELETE /documents/{doc_id}`, plus `:browse`, `:upsert`, `:deleteBatch`, `:deleteByFilter` verbs |
| **Searches** | `POST /collections/{name}/searches` — multi-vector `queries[]`, per-query `HnswQueryParam`/`IVFQueryParam`/`HnswRabitqQueryParam`/`VamanaQueryParam`, `rerankerName` reference |
| **AI Extension** | `GET/POST /ai/embeddings(/{name})` + `:embed`, `GET/POST /ai/rerankers(/{name})` + `:rerank` (CRUD with persistent registry) |
| **FS** | `GET /fs/list?path=…` — directory picker for the desktop UI |

Every error response is a `application/problem+json` body:

```json
{
  "type": "about:blank",
  "title": "Collection Not Found",
  "status": 404,
  "code": "COLLECTION_NOT_FOUND",
  "detail": "Collection 'demo' is not open.",
  "traceId": "01HZX…",
  "sdkException": "CollectionNotFoundError",
  "name": "demo"
}
```

The full error-code catalogue is in [`zvec_studio/exceptions.py`](zvec_studio/exceptions.py)
and mirrored in [`docs/backend.md` §9](../../docs/backend.md).

---

## Testing

```bash
pytest                                 # 216 tests, ~7 s
pytest tests/unit                      # fast, no I/O
pytest tests/integration               # real httpx + real zvec SDK
pytest --cov=zvec_studio               # coverage report
pytest -m "not slow"                   # skip slow markers

# From the repo root: full quality gate
make verify                            # ruff + mypy + pytest + frontend lint/build
```

The test suite covers schemas, middleware, all four CRUD-style routers, the AI registry's
`chmod 0600` atomic write path, lazy-import 503 mapping, fusion-vs-cross-encoder reranker
dispatch, and SDK quirks (filter syntax, `update(unknown_id)` translation, etc.).

`hypothesis` powers property-based tests for schema validation; `schemathesis` is wired up
under `tests/contract/` (currently a placeholder, planned for v0.4).

---

## Packaging & deployment

### a) PyInstaller sidecar (used by the Tauri desktop bundle)

```bash
pip install -e ".[packaging]"
pyinstaller zvec_studio.spec
# → dist/zvec-studio-sidecar  (single-file executable, ~22 MB)
```

The Tauri app bundles this binary under `apps/desktop/src-tauri/binaries/` and spawns it
on a free port at startup. See `apps/desktop/README.md` for the integration story.

### b) Container image (suggested, not yet shipped)

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY zvec_studio ./zvec_studio
RUN pip install --no-cache-dir .
ENV ZVEC_STUDIO_HOST=0.0.0.0 ZVEC_STUDIO_PORT=8080
EXPOSE 8080
CMD ["zvec-studio", "--host", "0.0.0.0", "--port", "8080"]
```

For the AI extension add `RUN pip install --no-cache-dir ".[ai]"` (image grows ~1.5 GB).

### c) systemd unit (Linux)

```ini
[Unit]
Description=Zvec Studio backend
After=network-online.target

[Service]
Environment=ZVEC_STUDIO_HOST=127.0.0.1
Environment=ZVEC_STUDIO_PORT=7860
Environment=ZVEC_STUDIO_DATA_DIR=/var/lib/zvec-studio
ExecStart=/usr/local/bin/zvec-studio --port 7860
Restart=on-failure
User=zvec
Group=zvec

[Install]
WantedBy=multi-user.target
```

---

## Embedding into your own FastAPI app

```python
from fastapi import FastAPI
from zvec_studio.main import create_app

# Get a fully-wired Zvec Studio app and mount it under your service.
parent = FastAPI()
parent.mount("/zvec", create_app())
```

The factory accepts an optional `Settings` object so you can override config without
relying on env vars (useful in tests):

```python
from zvec_studio.main import create_app
from zvec_studio.settings import Settings

app = create_app(Settings(host="0.0.0.0", api_prefix="/v1", cors_origins=["*"]))
```

---

## Relationship to Zvec Studio frontends

`zvec-studio-backend` is the **single source of truth** for all UI surfaces in this
monorepo:

```
apps/frontend/   (Vite + React) ──┐
apps/desktop/    (Tauri v2)     ──┼──► HTTP /api/v1 ──► apps/backend/  ──► zvec SDK
apps/vscode/     (planned)      ──┘                           │
                                                              └─► AI extension (lazy)
```

All three frontends consume the same OpenAPI contract via `packages/api-client`
(typed by `openapi-typescript`). No UI-specific endpoints exist on the backend —
the rule is: **if it isn't useful to a third-party HTTP client, it doesn't belong here**.

Concretely, this means you can:

- run `zvec-studio` standalone and drive it with `curl` / Postman / your own client,
- replace the React UI with anything you like and keep the backend untouched,
- use it as a SaaS-style gateway in front of a shared zvec data directory.

---

## Roadmap

See the project-level [roadmap](../../docs/overview.md#功能规划) for the full feature plan.

## License

Apache-2.0. See [`LICENSE`](../../LICENSE) at the repo root.
