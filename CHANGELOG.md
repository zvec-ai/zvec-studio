# Changelog

All notable changes to **Zvec Studio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**Backend**
- Document **export**: `GET /collections/{name}/documents:export` streams the
  whole collection as a JSONL download via the Zvec 0.7 snapshot iterator
  (constant memory, snapshot isolation; `includeVector` / `outputFields` /
  `format` parameters). Non-finite values fail fast with
  `422 EXPORT_NON_FINITE_VALUE`.
- Document **import**: `POST /collections/{name}/documents:import` streams a
  local JSONL file in batches with a per-row report (`mode`: replace/insert,
  `onError`: abort/skip). Row failures stay in the `200` body.
- **Snapshot mode**: `mode=snapshot` export bundles `manifest.json` +
  `documents.jsonl` in a `.tar.gz`.
- **Snapshot import**: `POST /collections:import` imports a whole
  collection from a snapshot package (schema from the manifest + data load
  in one pass, optional rename). It is a collection-level lifecycle
  operation — a sibling of create/open — and is reached from the sidebar
  "+" menu ("Import Collection"), not from the in-collection import dialog
  (which accepts data files only). The target directory is pre-filled as a
  sibling of the snapshot file and must not exist yet; if the data load fails
  unexpectedly mid-stream, the freshly created collection is rolled back.
- `GET /fs/list` gained `includeFiles` / `extensions` parameters and
  `kind`/`size` entry fields for the import file picker.
- New error codes: `DOCUMENT_CONFLICT` (409), `INVALID_DOCUMENT` (422),
  `EXPORT_BLOCKED` (409), `EXPORT_NON_FINITE_VALUE` (422),
  `MAINTENANCE_BLOCKED` (409), `UNSUPPORTED_VECTOR_DATA_TYPE` (422),
  `IMPORT_*` request-level codes.

**Frontend**
- Import / Export dialogs on a dedicated collection Data tab (sibling of
  Overview/Browse/Query/Write; file picker, import mode, error policy,
  native streamed download) with full zh-CN coverage.
- "Import Collection…" entry in the sidebar "+" menu (alongside Create
  Collection): rebuilds a whole collection from a snapshot package, with
  auto-prefilled target directory (sibling of the snapshot file) and
  optional rename.
- Collections whose schema declares an `id` column now render and write the
  primary key under `$id` across Browse / Query / Write tabs.
- Zvec 0.6 Group-By search controls and grouped result display.
- FTS ASCII folding and language stemmer controls.
- Optional random rotation for INT8/INT4 quantization.
- Multi-vector field support in Create Collection dialog — users can now
  define multiple vector fields per collection, each with its own index
  type, metric, and quantization settings.
- Structured index parameter inputs (HNSW M/efConstruction, IVF nList/nIters,
  HNSW_RABITQ totalBits/numClusters) replacing the raw JSON textarea.
- Quantization type selector (FP16, INT8, INT4, RABITQ) per vector field.
- Shared `CloseButton` component used across Toast, Dialog, and all dismiss
  actions for consistent close/remove buttons.
- Full Chinese (zh-CN) translation covering all UI strings, with a
  language switcher in the sidebar footer. i18n keys use fallback chain
  zh → en with `localStorage` persistence.

### Changed

**Backend**
- Zvec SDK runtime requirement raised to **0.7** (`iter_docs` is the export
  read path).
- `POST /documents`, `:upsert`, and `PATCH /documents` now write in internal
  batches (up to 10,000 docs work); batching is not transactional — a later
  failure leaves earlier chunks written (documented in `docs/api.md`).
- Collections may declare columns named `id` / `_id`; the primary key moves
  to the reserved `$id` row key in all document representations.
- **Open collection names are now globally unique.** Creating, opening, or
  importing a collection whose name matches one already open answers
  `409` with the blocking path in `detail`; previously two same-named
  collections could be open at once and every name-only API silently
  resolved to whichever registered first. Destroying or closing frees the
  name.
- Upgraded the Zvec SDK runtime to 0.6.x and added Group-By search, expanded
  FTS token filters, and `QuantizerParam` adaptation.

**Frontend**
- All raw `<button className="zv-btn">` instances replaced with the
  `<Button>` component (variant / size / loading props) for visual
  consistency across the app.
- All `window.confirm()` calls replaced with `<Dialog>` component-based
  confirmation flows (embedding/reranker deletion in AppShell).
- All hardcoded English strings (labels, placeholders, `aria-label`,
  `title` attributes) wired to `react-i18next` `t()` calls.
- `CreateEmbeddingDialog` and `CreateRerankerDialog` rewritten to match
  the `CreateCollectionDialog` pattern (Button, Dialog, Input, Select
  components + i18n + proper reset-on-close).
- Collection detail page tabs renamed to Overview / Browse / Query / Write.
- Toast component: `aria-label` attributes now use i18n keys;
  test regex broadened for environments without i18next initialisation.
- Fieldset legend sizing and management bar spacing polished in
  OverviewTab and CreateCollectionDialog.

### Fixed

- Insert/upsert/update of more than 1024 documents no longer answers
  `500 INTERNAL_ERROR` (the SDK write-batch limit is absorbed internally).
- Opening an SDK-created collection with an `id` column no longer fails with
  `500`; the primary key is no longer silently overwritten by that column.
- Corrupted or non-gzip `.tar.gz` import sources answer `400` instead of
  `500`; maintenance during an export answers `409 MAINTENANCE_BLOCKED`
  instead of an opaque error; a collection with an unsupported vector dtype
  reports `422 UNSUPPORTED_VECTOR_DATA_TYPE` instead of a misleading 404.
- An explicit `"id": null` on insert/upsert auto-generates a ULID again
  (matching the historical "omit id" contract).

### Removed

- `VECTOR_FP64` is no longer offered as a vector data type — the Zvec engine
  rejects it at create time ("dense_vector's data type only support FP32").

**Documentation**
- All project documentation updated to reflect current feature set,
  accurate test counts, and correct tab/field names.

## [0.1.0] — 2026-05-13

First public MVP release — Web + Desktop parity for the core collection /
document / vector-search workflow of the [Zvec](https://github.com/zilliztech/zvec)
embedded vector database.

### Added

**Backend (FastAPI)**
- FastAPI application with ULID-based traceId middleware, structured
  JSON-lines logging and RFC 7807 Problem Details error responses
  (`zvec_studio/middleware/`).
- Collection management API: `GET/POST /api/v1/collections`,
  `POST /collections:open`, `GET /{name}/schema`, `GET /{name}/stats`,
  `DELETE /{name}`.
- Document API with Base64-encoded cursor pagination, filter-expression
  pass-through, single + batch insert, single + batch delete
  (`routers/documents.py`).
- Vector search API: `POST /api/v1/collections/{name}/searches`
  with `topK`, `filter`, `outputFields`, returning `{results, tookMs, traceId}`.
- Health/readiness probes under `/api/v1/healthz`, `/api/v1/readyz`.
- In-memory Zvec storage backend (pure-Python, ships today);
  SDK-backed backend slot reserved for the v0.3.x Zvec release.

**Frontend (React 18 + TypeScript)**
- AppShell layout with top nav, side nav, Toast / Dialog / Drawer primitives,
  CSS design tokens (Light + Dark themes with token-based switching).
- TanStack Query + OpenAPI-typescript generated client
  (`packages/api-client/`), regenerated via `pnpm gen:api`.
- Collections list page with 4-state rendering (loading / empty / error / success)
  and create / open / delete flows.
- Collection detail page with Schema / Stats / Documents / Search tabs.
- Documents panel: paginated table, filter input, document drawer, JSON insert
  dialog, inline + batch delete with confirmation, toast-based feedback.
- Vector search panel with JSON vector input, topK slider, output-field picker,
  similarity bars and `localStorage`-backed search history (last 10).
- Onboarding 3-step wizard, `EmptyState` / `ErrorState` / `Skeleton`
  primitives and a global `ErrorBoundary`.
- i18n scaffolding via `react-i18next` (English baseline).

**Desktop (Tauri v2)**
- Tauri v2 shell (`apps/desktop`) with a Rust-supervised Python sidecar:
  auto-detects a bundled PyInstaller binary next to the main exe,
  otherwise falls back to `python -m zvec_studio.cli`.
  Overridable via `ZVEC_SIDECAR_BINARY` / `ZVEC_SIDECAR_DISABLED`.
- `resolve_bundled_sidecar()` host-triple detection + TCP ready-probe with
  configurable timeout (`ZVEC_READY_TIMEOUT_SECS`).
- `runtime.ts` helper exposes `isTauri()` to the frontend without pulling
  `@tauri-apps/api` into the Web bundle.
- 6 Rust unit tests covering sidecar config, ready-probe success/timeout,
  invalid addresses, and launch-summary dev-vs-bundled differentiation.

**Packaging & distribution**
- `scripts/build_sidecar.py`: PyInstaller freeze → rustc host-triple detection
  → copy to `apps/desktop/src-tauri/binaries/zvec-studio-sidecar-<triple>(.exe)`.
- Tauri config split: dev-friendly `tauri.conf.json` (no `externalBin`) +
  `tauri.bundle.conf.json` override injected via `tauri build --config`.
- Makefile `package.sidecar` / `package.desktop` / `package` targets.
- `.github/workflows/release.yml`: four-platform matrix
  (Apple Silicon macOS, Linux x86_64, Linux ARM64, Windows x86_64)
  triggered by `v*` tags or manual dispatch, producing `.dmg`, `.app.tar.gz`,
  `.deb`, `.AppImage`, `.msi`, `.exe` artifacts. Unsigned — see
  [docs/PACKAGING.md](docs/PACKAGING.md) for the signing roadmap.

**Documentation**
- README rewritten with feature matrix, quick-start for Web + Desktop,
  minimal working example, roadmap.
- `docs/getting-started.md`, `docs/architecture.md`, `docs/testing.md`,
  `docs/api.md`, `docs/PACKAGING.md`.
- `benchmarks/baseline.json` with the Task 4 vector search performance
  budgets (topK=10 over 1k docs, p50/p95).

### Test baseline at 0.1.0

- **Backend**: 171 tests passing, overall coverage **94.28 %** (gate 60 %,
  routers / middleware ≥ 75 %).
- **Frontend**: Vitest + React Testing Library + MSW coverage across
  collections, documents, search, onboarding and UI primitives.
- **Desktop**: `cargo fmt --check` + `clippy -D warnings` + 6 Rust unit tests,
  all green.
- **E2E**: Playwright smoke (Create → Insert → Search → Delete → Empty)
  passing with video + trace recording in `artifacts/`.
- **Contract**: Schemathesis against live `/openapi.json`, no 5xx
  regressions across ≥ 100 randomised requests.

### Known limitations (MVP scope)

- Bundles are **unsigned** — macOS Gatekeeper + Windows SmartScreen will
  warn on first launch. Post-MVP signing plan in
  [docs/PACKAGING.md](docs/PACKAGING.md#signing--notarisation-post-mvp-placeholder).
- Zvec SDK ≥ 0.3.x is loaded lazily. The in-memory backend is used until
  contributors install the SDK locally (`pip install "zvec>=0.3,<0.4"`).
- UMAP visualisation, AI Agent panel and the VS Code plugin are
  tracked for **v0.3.x / v0.4.x** per [docs/overview.md](docs/overview.md).
- Chinese i18n is now complete (see [Unreleased] above).

[Unreleased]: https://github.com/zvec/zvec-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zvec/zvec-studio/releases/tag/v0.1.0
