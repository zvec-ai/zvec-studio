# HTTP API reference

Zvec Studio speaks a single versioned REST API under `/api/v1`. The
authoritative schema is served live from the running backend:

- **Swagger UI**: <http://127.0.0.1:7860/docs>
- **ReDoc**:     <http://127.0.0.1:7860/redoc>
- **OpenAPI**:    <http://127.0.0.1:7860/openapi.json>

This document is a **stable highlight reel**. For exact field types and
examples, hit the live OpenAPI and use
[`pnpm gen:api`](../packages/api-client/README.md) to regenerate the
typed client.

---

## Conventions

- Base URL: `http://127.0.0.1:7860/api/v1`
- Every response carries `X-Trace-Id: <ULID>`.
- Errors follow **RFC 7807** (`application/problem+json`), extended
  with `code` and `sdkException` fields — see
  [overview.md](overview.md) and [backend.md](backend.md) §9.
- Action verbs use AIP-136 `:action` suffix (e.g. `:browse`, `:upsert`).

### Error shape

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

| HTTP | Common `code`                   | Meaning |
|------|---------------------------------|---------|
| 400  | `INVALID_FILTER_EXPRESSION`     | Filter DSL failed to parse |
| 400  | `DIMENSION_MISMATCH`            | Query vector ≠ collection dim |
| 404  | `COLLECTION_NOT_FOUND`          | Collection not open |
| 404  | `DOCUMENT_NOT_FOUND`            | Primary key missing |
| 404  | `AI_FUNCTION_NOT_FOUND`         | Embedding/reranker name not found |
| 409  | `COLLECTION_ALREADY_EXISTS`     | Duplicate `open` / `create` call |
| 409  | `AI_FUNCTION_ALREADY_EXISTS`    | Duplicate AI function name |
| 422  | `INVALID_SCHEMA`                | Schema validation error |
| 500  | `INTERNAL_ERROR`                | Unhandled; file an issue with `traceId` |
| 503  | `AI_DEPENDENCY_MISSING`         | Optional ML package not installed |

---

## Health

| Verb | Path                    | Description |
|------|-------------------------|-------------|
| GET  | `/api/v1/healthz`       | Liveness — always `{status: "ok"}` when the process is up |
| GET  | `/api/v1/readyz`        | Readiness — 200 once the registry is initialised |

---

## Collections — Lifecycle

| Verb   | Path                                     | Purpose |
|--------|------------------------------------------|---------|
| GET    | `/collections`                           | List open collections |
| POST   | `/collections`                           | Create **and** open a collection |
| POST   | `/collections/open`                      | Open an existing on-disk collection |
| GET    | `/collections/{name}`                    | Detail (schema + stats in one call) |
| GET    | `/collections/{name}/schema`             | Schema only |
| GET    | `/collections/{name}/stats`              | Stats only (document count, index status, storage size) |
| DELETE | `/collections/{name}`                    | Remove from in-process registry (does **not** delete files on disk) |

## Collections — Recent (workspace persistence)

| Verb   | Path                                     | Purpose |
|--------|------------------------------------------|---------|
| GET    | `/collections/recent`                    | List recently opened paths (persisted in `~/.zvec-studio/config.json`, max 10) |
| DELETE | `/collections/recent`                    | Clear the recent list |
| POST   | `/collections/recent:forget`             | Remove a single `{path}` from recents |

## Collections — Maintenance verbs

| Verb   | Path                                     | Purpose |
|--------|------------------------------------------|---------|
| POST   | `/collections/{name}:flush`              | Persist pending writes |
| POST   | `/collections/{name}:optimize`           | Segment merge + index rebuild |
| POST   | `/collections/{name}:destroy`            | **Permanently delete on-disk data** |

## Collections — DDL (Schema Evolution)

| Verb   | Path                                            | Purpose |
|--------|-------------------------------------------------|---------|
| POST   | `/collections/{name}/fields`                    | Add a scalar field (with optional `expression` for backfill) |
| DELETE | `/collections/{name}/fields/{field}`            | Drop a scalar field |
| PATCH  | `/collections/{name}/fields/{field}`            | Rename a scalar field |
| POST   | `/collections/{name}/indexes`                   | Create / rebuild a vector index |
| DELETE | `/collections/{name}/indexes/{vector_field}`    | Drop a vector index |

### Create payload

```json
{
  "name": "demo",
  "path": "./data/demo",
  "schema": {
    "fields": [
      {"name": "title", "dataType": "STRING"}
    ],
    "vectors": [
      {
        "name": "dense",
        "dataType": "VECTOR_FP32",
        "dimension": 768,
        "indexParam": {
          "indexType": "HNSW",
          "metric": "COSINE",
          "params": {"M": 50, "efConstruction": 500}
        }
      },
      {
        "name": "sparse",
        "dataType": "VECTOR_FP32",
        "dimension": 128,
        "indexParam": {
          "indexType": "FLAT",
          "metric": "L2"
        }
      }
    ]
  }
}
```

Multiple vector fields are supported, each with its own index type
(FLAT, HNSW, IVF, HNSW_RABITQ), metric (L2, IP, COSINE), and
optional quantization (FP16, INT8, INT4, RABITQ).

---

## Documents

| Verb   | Path                                                      | Purpose |
|--------|-----------------------------------------------------------|---------|
| POST   | `/collections/{name}/documents`                           | Insert single or batch |
| PATCH  | `/collections/{name}/documents`                           | Batch partial update (by `id`) |
| GET    | `/collections/{name}/documents/{id}`                      | Fetch by primary key |
| DELETE | `/collections/{name}/documents/{id}`                      | Delete by primary key |
| POST   | `/collections/{name}/documents:browse`                    | Filter browser (`filter` + `limit`) |
| POST   | `/collections/{name}/documents:upsert`                    | Upsert by `id`; missing `id` auto-generates ULID |
| POST   | `/collections/{name}/documents:deleteBatch`               | Batch delete by `{ids: [...]}` |
| POST   | `/collections/{name}/documents:deleteByFilter`            | Delete by filter expression |

### Browse

```
POST /api/v1/collections/demo/documents:browse
Content-Type: application/json

{
  "filter": "title = 'cat'",
  "limit": 50,
  "outputFields": ["id", "title"],
  "includeVector": false
}
```

Response: `{ items: [...], truncated: true/false }`.

### Filter DSL

The filter string is passed through to the Zvec SDK unchanged. Examples:

```
title = 'cat'
score > 0.8 and category in ['animal', 'pet']
```

Note: Zvec uses single `=` (not `==`) and single-quoted strings.

---

## Vector search

### Request

```
POST /api/v1/collections/{name}/searches
Content-Type: application/json

{
  "vector":        [0.10, 0.20, 0.30, 0.40],
  "topK":          10,
  "filter":        "title = 'cat'",
  "outputFields":  ["id", "title"]
}
```

### Multi-vector queries (advanced)

```json
{
  "queries": [
    { "field": "dense", "vector": [0.1, 0.2, "..."], "param": { "type": "HNSW", "ef": 256 } },
    { "field": "sparse", "id": "doc-001" }
  ],
  "topK": 20,
  "rerankerName": "rrf-default"
}
```

- `queries[]` supports 1–8 vector queries; each may specify `vector` (raw array) or `id` (use an existing document's vector).
- Per-query `param` allows index-specific tuning: `HNSW(ef)`, `IVF(nprobe)`, `HNSW_RABITQ(ef, ...)`, `VAMANA(efSearch)`.
- `rerankerName` references a registered reranker (see AI Extension below).
- Legacy single-vector form (`vector` + `vectorField`) is still supported; mutually exclusive with `queries`.

### Response

```json
{
  "results": [
    {"id": "cat",    "score": 0.98, "fields": {"title": "cat"}},
    {"id": "kitten", "score": 0.92, "fields": {"title": "kitten"}}
  ],
  "tookMs": 3,
  "traceId": "01HQY8R2FJDN5WXBN2RY5MQZ1T"
}
```

---

## AI Extension

Zvec Studio surfaces the Zvec SDK's AI capabilities (embeddings, rerankers)
as first-class CRUD resources with persistent registration and `:embed` / `:rerank` action verbs.

### Embeddings

| Verb   | Path                                     | Purpose |
|--------|------------------------------------------|---------|
| GET    | `/ai/embeddings`                         | List registered embedding functions |
| POST   | `/ai/embeddings`                         | Create (409 on duplicate name) |
| GET    | `/ai/embeddings/{name}`                  | Detail |
| PUT    | `/ai/embeddings/{name}`                  | Update (allows name change; 409 on collision) |
| DELETE | `/ai/embeddings/{name}`                  | Delete |
| POST   | `/ai/embeddings/{name}:embed`            | Encode `texts[]` → vectors |

Supported embedding types: `default_local_dense`, `default_local_sparse`, `bm25`, `qwen_dense`, `qwen_sparse`, `openai_dense`.

### Rerankers

| Verb   | Path                                     | Purpose |
|--------|------------------------------------------|---------|
| GET    | `/ai/rerankers`                          | List registered reranker functions |
| POST   | `/ai/rerankers`                          | Create (409 on duplicate name) |
| GET    | `/ai/rerankers/{name}`                   | Detail |
| PUT    | `/ai/rerankers/{name}`                   | Update |
| DELETE | `/ai/rerankers/{name}`                   | Delete |
| POST   | `/ai/rerankers/{name}:rerank`            | Cross-encoder reranking (not for fusion types) |

Supported reranker types: `default_local` (cross-encoder), `qwen`, `rrf` (fusion), `weighted` (fusion).

Fusion rerankers (`rrf`, `weighted`) cannot be invoked via `:rerank` — they
operate inside `Collection.query` when referenced by `rerankerName` in a
multi-vector search.

### Example: register + use

```bash
# Register an RRF reranker
curl -X POST http://127.0.0.1:7860/api/v1/ai/rerankers \
  -H 'Content-Type: application/json' \
  -d '{"name": "rrf-default", "config": {"type": "rrf", "rankConstant": 60}}'

# Use in a multi-vector search
curl -X POST http://127.0.0.1:7860/api/v1/collections/demo/searches \
  -H 'Content-Type: application/json' \
  -d '{"queries": [{"field": "dense", "vector": [...]}, {"field": "sparse", "vector": [...]}], "topK": 10, "rerankerName": "rrf-default"}'
```

---

## Filesystem

| Verb | Path                                     | Purpose |
|------|------------------------------------------|---------|
| GET  | `/fs/list?path=...&show_hidden=false`    | List subdirectories (for the directory picker UI) |

---

## Regenerating the client

```bash
# While a backend is running:
pnpm gen:api
```

This pulls the live `/openapi.json`, generates
`packages/api-client/src/index.ts`, and the frontend type-checks against
it. CI fails if regeneration produces a diff — keep API changes +
generated client in the **same** commit.
