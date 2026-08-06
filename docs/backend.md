# Backend Reference

> `apps/backend/zvec_studio/` — ~6.5 KLOC. Python ≥ 3.10, FastAPI 0.115+, Pydantic v2, Zvec SDK 0.6.x.

For the module map and request flow, see [architecture.md](architecture.md).
For the HTTP endpoint reference, see [api.md](api.md).

This document covers internal design decisions and SDK integration details useful for contributors.

---

## Configuration (`settings.py`)

| Field | Default | Env Var | Purpose |
|-------|---------|---------|---------|
| `host` | `127.0.0.1` | `ZVEC_STUDIO_HOST` | HTTP bind address |
| `port` | `7860` | `ZVEC_STUDIO_PORT` | HTTP port |
| `log_level` | `info` | `ZVEC_STUDIO_LOG_LEVEL` | critical/error/warning/info/debug |
| `data_dir` | `~/.zvec-studio` | `ZVEC_STUDIO_DATA_DIR` | Persistent config directory |
| `api_prefix` | `/api/v1` | `ZVEC_STUDIO_API_PREFIX` | Route prefix |
| `cors_origins` | `["http://127.0.0.1:5173"]` | `ZVEC_STUDIO_CORS_ORIGINS` | CORS allowlist |

---

## Storage Layer (`storage/sdk.py`)

Single backend: `SdkBackend`. All schema/index persistence is delegated to the Zvec SDK's on-disk manifest.

Key behaviors:
- `_normalize_param_keys`: accepts camelCase (`M`/`efConstruction`), converts to snake_case for pybind11 IndexParam
- SDK exceptions are mapped to Studio exceptions (e.g. `InvalidSchemaError`, `DimensionMismatchError`)
- Thread-safe via instance-level `RLock`

### SDK Quirks

| Behavior | Implication |
|----------|-------------|
| Filter not parsed on empty collection | Must seed a doc before `INVALID_FILTER_EXPRESSION` can trigger |
| `update(unknown_id)` returns status code, not exception | Wrapper detects `message='Document not found'` → 404 |
| `add_column` only supports numeric nullable columns | `add_field` always passes `nullable=True` |
| `drop_index` falls back to FLAT/IP | SDK doesn't truly remove the index structure |
| Filter syntax: single `=`, single-quoted strings | `==` and double quotes are rejected |

---

## Error System

Exception hierarchy in `exceptions.py`:

| Exception | Code | HTTP | Trigger |
|-----------|------|------|---------|
| `CollectionNotFoundError` | `COLLECTION_NOT_FOUND` | 404 | Not opened |
| `CollectionAlreadyExistsError` | `COLLECTION_ALREADY_EXISTS` | 409 | Duplicate create/open |
| `InvalidSchemaError` | `INVALID_SCHEMA` | 400 | Dimension/type/naming error |
| `InvalidFilterExpressionError` | `INVALID_FILTER_EXPRESSION` | 400 | Filter syntax error |
| `DocumentNotFoundError` | `DOCUMENT_NOT_FOUND` | 404 | ID not found |
| `DimensionMismatchError` | `DIMENSION_MISMATCH` | 400 | Vector dim ≠ collection dim |
| `AIDependencyMissingError` | `AI_DEPENDENCY_MISSING` | 503 | Optional ML package not installed |
| `AIFunctionNotFoundError` | `AI_FUNCTION_NOT_FOUND` | 404 | Unknown embedding/reranker |
| `AIFunctionAlreadyExistsError` | `AI_FUNCTION_ALREADY_EXISTS` | 409 | Duplicate name |
| `AIFunctionInvocationError` | `AI_FUNCTION_INVOCATION_ERROR` | 400/500 | Invocation error |

All errors render as RFC 7807 `application/problem+json` with `traceId` and stable `code`.

---

## Middleware Stack

Order (outer → inner): CORS → JsonLinesAccessLog → TraceId.

TraceId must be innermost so the logger can read `request.state.trace_id`.

---

## AI Extension

Zvec SDK AI capabilities exposed as HTTP resources + AIP-136 action verbs.

- 6 embedding types: `default_local_dense`, `default_local_sparse`, `bm25`, `qwen_dense`, `qwen_sparse`, `openai_dense`
- 4 reranker types: `default_local` (cross-encoder), `qwen`, `rrf` (fusion), `weighted` (fusion)

Persistence: `<data_dir>/ai_functions.json` (atomic write + `chmod 0600`).

Factory (`ai_service.py`): lazy-imports SDK extensions at call time. Any `ImportError` → 503 with `{feature, missingPackage}` in the error body.

Fusion rerankers (`rrf`/`weighted`) cannot be invoked via `:rerank` — they only operate inside `Collection.query` when referenced by `rerankerName` in a multi-vector search.

---

## Pydantic Schema Notes

- Collection names: `^[A-Za-z][A-Za-z0-9_]{2,63}$`
- Field/vector names: `^[A-Za-z_][A-Za-z0-9_]{0,63}$`
- Reserved field names: `id`, `_id` (injected by SDK)
- Reserved collection names: `recent`, `open` (conflict with URL paths)
- All request bodies use `extra="forbid"` — unknown fields → 422
- `schema_` attribute with `Field(alias="schema")` works around Pydantic v2's reserved `schema` name

---

## Design Decisions

1. **No sidecar persistence** — SDK 0.4.x handles schema/index on disk; Studio doesn't maintain its own manifest.
2. **AIP-136 custom verbs** — `:flush`/`:optimize`/`:destroy`/`:browse`/`:upsert` avoid confusion with RESTful CRUD paths.
3. **Error codes align with SDK** — frontend i18n matches via `error.<CODE>`.
4. **Filter passthrough** — no custom parser; SDK's SQL-WHERE dialect is forwarded directly.
5. **Localhost-only default** — remote access requires explicit env var override.
6. **Destroy requires UI confirmation** — backend has no gate; the frontend enforces name-typing confirmation.
