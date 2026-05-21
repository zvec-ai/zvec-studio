# Changelog

All notable changes to **Zvec Studio** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

**Frontend**
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
- `.github/workflows/release.yml`: four-runner matrix
  (macos-14 arm64, macos-13 x86_64, ubuntu-latest, windows-latest)
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
