# Architecture

> Cross-reference: [overview.md](overview.md) carries the product
> positioning, architecture overview, and feature roadmap; this document
> is the implementation map that points every concept at concrete files.

## High-level flow

```
+-------------------+       HTTP/JSON         +-----------------------+
|  React frontend   | <---------------------> |  FastAPI backend      |
|  (apps/frontend)  |  traceId propagated     |  (apps/backend)       |
+---------+---------+                         +-----------+-----------+
          |                                               |
          | localStorage                                  | zvec.Collection
          |  - search history                             |  - in-memory MVP
          |  - onboarding flag                            |  - SDK-backed slot
          v                                               v
  Browser / Tauri WebView                         Local filesystem
  (apps/desktop)  <-- Tauri v2 supervises
                      a PyInstaller-frozen
                      sidecar process over
                      a loopback TCP port.
```

The **same** FastAPI application powers the web and desktop modes —
the desktop shell just spawns it as a sidecar child process. The
frontend never calls Tauri IPC for data operations; it uses ordinary
HTTP so both runtimes share one test surface.

## Backend layout (`apps/backend/zvec_studio/`)

| Module | Responsibility |
|--------|----------------|
| `main.py`               | FastAPI app factory; mounts routers and middleware under `/api/v1` |
| `settings.py`           | Pydantic Settings (port, data dir, log level) via `ZVEC_*` env |
| `middleware/trace_id.py`| Generates ULID traceId per request; binds to `contextvars`; echoes on the response header |
| `middleware/error_handler.py` | Maps `zvec.exceptions.*` → RFC 7807 Problem Details |
| `middleware/logging.py` | JSON-lines structured logging, includes `traceId`, `latencyMs`, `status` |
| `exceptions.py`         | Business exception tree — every error has a stable `code` surfaced to the UI |
| `registry.py`           | Process-wide map `name → zvec.Collection`; thread-safe |
| `filter.py`             | Filter DSL passthrough + validation error wrapping |
| `routers/collections.py`| CRUD + schema + stats |
| `routers/documents.py`  | CRUD, browse, upsert, deleteByFilter |
| `routers/searches.py`   | Multi-vector ANN search with per-query params + reranker reference |
| `routers/ai.py`         | AI extension: embedding & reranker CRUD + `:embed` / `:rerank` verbs |
| `routers/fs.py`         | Directory picker for the desktop UI |
| `schemas/`              | Pydantic v2 request / response models, field names aligned with the SDK |
| `storage/sdk.py`        | `SdkBackend`: the only adapter, talks to `zvec` SDK 0.4.x |
| `ai_store.py`           | Persistent AI function registry (`~/.zvec-studio/ai_functions.json`, `chmod 0600`) |
| `ai_service.py`         | Lazy-import factory for SDK embedding/reranker classes |
| `config_store.py`       | Recent collections persistence (`~/.zvec-studio/config.json`) |

## Frontend layout (`apps/frontend/src/`)

| Directory | Responsibility |
|-----------|----------------|
| `pages/collections/`    | Collection list, detail (Overview / Browse / Query / Write tabs), create dialog, schema DDL |
| `pages/ai/`             | AI Functions page (embedding & reranker management) |
| `pages/embeddings/`     | Create embedding dialog, embedding detail |
| `pages/rerankers/`      | Create reranker dialog, reranker detail |
| `pages/WelcomePage.tsx`  | Empty-state landing with onboarding hooks |
| `features/collections/` | `api.ts` + `hooks.ts` for collection data fetching |
| `features/onboarding/`  | 3-step wizard + `useOnboarding()` |
| `components/ui/`        | Button, Dialog, CloseButton, Input, Select, Table, Toast, EmptyState, ErrorState, Skeleton, Tabs, Spinner, DirectoryInput |
| `layouts/AppShell.tsx`  | Top nav + side nav + content outlet, language switcher, i18n-aware |
| `lib/api-client.ts`     | Reuse of generated `packages/api-client` with Axios-like fetch + traceId surfacing |
| `lib/error-mapper.ts`   | RFC 7807 → Toast & ErrorState props |
| `lib/query-client.ts`   | TanStack Query config (retry, invalidation rules) |
| `lib/runtime.ts`        | `isTauri()` helper |
| `i18n/`                 | `en.json` + `zh.json` — consumed through `useTranslation()`, fallback zh → en |

## Desktop layout (`apps/desktop/src-tauri/`)

| File | Responsibility |
|------|----------------|
| `tauri.conf.json`        | Dev-friendly config — no `externalBin`, so `tauri dev` doesn't require a frozen sidecar |
| `tauri.bundle.conf.json` | Packaging-time override — injects `externalBin` and bundle metadata |
| `build.rs`               | Standard `tauri_build::build()` |
| `src/main.rs`            | Entry point; calls `lib::run()` |
| `src/lib.rs`             | Window setup + sidecar lifecycle hook |
| `src/sidecar.rs`         | `resolve_bundled_sidecar()` (host triple detection), `spawn_sidecar()`, TCP readiness probe with env-tunable timeout |
| `binaries/`              | PyInstaller output drop zone (`.gitkeep` only; actual binaries are CI artifacts) |

### Sidecar decision tree (dev vs bundled)

```
spawn_sidecar()
├── ZVEC_SIDECAR_DISABLED=1  → skip (expect external backend)
├── ZVEC_SIDECAR_BINARY=...   → use override path
├── sibling of current_exe()  → use bundled frozen binary (prod default)
└── otherwise                 → `python -m zvec_studio.cli` (dev default)
```

Ready-probe: open a TCP connect to `127.0.0.1:<port>` every 200 ms up to
`ZVEC_READY_TIMEOUT_SECS` (default 20). First success unblocks the Tauri
window creation.

## Request life-cycle (example: vector search)

1. User clicks **Search**. The `useSearchDocuments` mutation fires
   `POST /api/v1/collections/demo/searches`.
2. Trace middleware mints `traceId=01HQ...`, binds to contextvar,
   sets response header `X-Trace-Id`.
3. `SearchRequest` is validated by Pydantic v2 (dimension, topK bounds).
4. `routers/searches.py` resolves the collection from `registry`,
   invokes `zvec.VectorQuery(...).execute()` or the in-memory brute
   force fallback.
5. Result `{results, tookMs, traceId}` serialised out.
6. Frontend `error-mapper.ts` either passes the happy-path payload to
   the UI, or converts an RFC 7807 error body into a Toast and keeps the
   form state intact.

## What runs where

| Mode    | Where the backend runs | Where the UI runs |
|---------|------------------------|-------------------|
| Web dev | `uvicorn --reload`     | Vite dev (HMR)    |
| Web prod (future) | `zvec-studio` CLI `uvicorn` | static bundle from FastAPI `StaticFiles` |
| Desktop dev  | `python -m zvec_studio.cli` (spawned by Tauri) | Vite dev through the WebView |
| Desktop prod | PyInstaller binary `zvec-studio-sidecar-<triple>` (spawned by Tauri) | bundled static assets |

## Where to look when adding a feature

| You want to… | Start from |
|--------------|------------|
| Add a new API endpoint | `routers/` + `schemas/` + a test in `tests/integration/` |
| Add a new page | `pages/<name>/` + a route in `App.tsx` + i18n keys in `en.json` + `zh.json` |
| Add a new UI component | `components/ui/` + export from `components/ui/index.ts` |
| Map a new SDK exception | `exceptions.py` + `middleware/error_handler.py` + `lib/error-mapper.ts` |
| Add an AI extension | `routers/ai.py` + `ai_service.py` + `ai_store.py` + test in `tests/integration/test_ai_router.py` |
| Add a new Tauri capability | `src-tauri/capabilities/` + permission JSON |
| Add a new CI job | `.github/workflows/ci.yml` or `release.yml` |
| Add an i18n string | Add key to both `i18n/en.json` and `i18n/zh.json`, use via `t('key')` |
