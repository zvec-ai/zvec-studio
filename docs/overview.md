# Product Overview

**Zvec Studio** is a visual management tool for the [Zvec](https://github.com/alibaba/zvec) embedded vector database — browse data, test queries, and manage schemas without writing code.

## Target Users

| Role | Primary Need |
|------|-------------|
| AI/ML developer | Browse vector data, test queries, debug embedding quality |
| Backend developer | Manage collection schemas, CRUD operations, troubleshoot data |
| Data engineer | Batch import/export, inspect data distribution, evaluate performance |
| Evaluator / learner | Experience Zvec without code, understand vector DB concepts |

## Delivery Modes

Web + Desktop ship from the same codebase:

| | Web | Desktop |
|--|-----|---------|
| Install | `pip install zvec-studio` | Download installer |
| Python required | Yes (3.10+) | No (embedded runtime) |
| Package size | ~5 MB | ~30 MB |
| Native features | None | File picker, system notifications |

## Architecture

```
┌───────────────────────────────────────────────┐
│  Desktop (Tauri v2)          Web (Browser)    │
│  ┌────────────┐             ┌────────────┐    │
│  │ Rust shell │             │ Vite proxy │    │
│  │ + sidecar  │             │ /api/*     │    │
│  └─────┬──────┘             └─────┬──────┘    │
│        ▼                          ▼           │
│  ┌────────────────────────────────────────┐   │
│  │       React 18 SPA (frontend)         │   │
│  │  TanStack Query · react-router · i18n │   │
│  └──────────────────┬────────────────────┘   │
│                     │ HTTP                     │
│  ┌──────────────────┴────────────────────┐   │
│  │       FastAPI Backend (Python)         │   │
│  │  Zvec SDK · Pydantic · RFC 7807       │   │
│  └──────────────────┬────────────────────┘   │
│                     ▼                         │
│  ┌────────────────────────────────────────┐   │
│  │       Zvec (embedded vector DB)        │   │
│  │  Local file storage · no server        │   │
│  └────────────────────────────────────────┘   │
└───────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | React 18 + TypeScript | Mature ecosystem, type safety |
| State | TanStack Query | Server-state best practice |
| Build | Vite | Fast dev, Tauri integration |
| Backend | FastAPI (Python) | Zvec Python SDK is most complete; async + built-in OpenAPI |
| Desktop | Tauri v2 | Lightweight (~3 MB), native sidecar management |
| Packaging | PyInstaller | Embeds Python runtime for desktop |

## API Design Principles

- Resource-Oriented REST, aligned with SDK naming
- OpenAPI-first: auto-generated TypeScript client
- Single API layer consumable by any HTTP client
- Versioned under `/api/v1/`
- RFC 7807 errors with `code` + `traceId`

See [api.md](api.md) for the full reference.

## Feature Status

### Shipped (v0.1.x)

- Collection CRUD with multi-vector fields, schema viewer, recent list
- Schema evolution: add/drop/rename fields, create/drop indexes
- Document browsing with filter expressions, pagination, detail drawer
- Document operations: insert/upsert/update/delete (single + batch)
- Multi-vector ANN search with filter, TopK, search history
- AI extension: embedding & reranker management (6 embedding + 4 reranker types)
- Collection maintenance: optimize, destroy
- Dark/light theme
- Onboarding wizard
- Bilingual UI (English + Chinese)
- Desktop app (macOS / Linux / Windows)

### Planned

| Version | Focus |
|---------|-------|
| v0.2.x | Data import/export, virtual scrolling, batch operations, advanced search |
| v0.3.x | Vector visualization (UMAP/t-SNE), clustering, AI Agent, SDK code generation |
| v0.4.x | VS Code extension, API Playground, webhooks & notifications |

### Out of Scope

- Cloud SaaS (Zvec is local-first)
- RBAC (Zvec has no built-in permissions)
- Cluster monitoring (Zvec is single-machine embedded)

## Quality Baseline

- Backend: 216 tests, 94% coverage
- Frontend: 97 tests (Vitest + RTL)
- Desktop: 6 Rust unit tests
- E2E: Playwright smoke tests
- Contract: Schemathesis OpenAPI fuzz testing

## License

Apache License 2.0 (same as Zvec).
