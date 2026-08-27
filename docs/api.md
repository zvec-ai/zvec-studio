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
| POST   | `/collections:import`                    | Import a collection from a snapshot package (`.tar.gz`) |
| GET    | `/collections/{name}`                    | Detail (schema + stats in one call) |
| GET    | `/collections/{name}/schema`             | Schema only |
| GET    | `/collections/{name}/stats`              | Stats only (document count, index status, storage size) |
| DELETE | `/collections/{name}`                    | Remove from in-process registry (does **not** delete files on disk) |

**Open collection names are globally unique.** Creating, opening, or
restoring a collection whose name matches one that is *already open* (even
from a different path) answers `409 COLLECTION_ALREADY_EXISTS` with the
blocking path in `detail` — close it first, or pick another name. This keeps
every name-only API (`browse`, search, stats, …) unambiguous. Destroying or
closing frees the name.

### Import collection (from snapshot)

Collection-level lifecycle operation — a sibling of create/open, not a
variant of document import. The snapshot's embedded `manifest.json` supplies
the schema, `targetPath` gives the new collection its home, and the embedded
`documents.jsonl` is loaded in the same pass. If the data load itself fails
unexpectedly (e.g. a corrupt member), the freshly created collection is
rolled back so a fixed-up retry is possible.

```
POST /api/v1/collections:import
Content-Type: application/json

{
  "source": { "kind": "localPath", "path": "/Users/me/backups/demo.tar.gz" },
  "targetPath": "/Users/me/data/demo-restored",
  "name": "demo_copy"
}
```

- `source`: the snapshot package (produced by `:export?mode=snapshot`).
- `targetPath`: directory for the restored collection; must not exist yet
  (`409 COLLECTION_ALREADY_EXISTS` otherwise — the Zvec engine refuses any
  existing path, empty directories included).
- `name`: optional rename (defaults to the name recorded in the manifest);
  validated with the usual collection-name rules (`422` on violation).

Request-level failures answer `4xx` before anything is created: `404
IMPORT_FILE_NOT_FOUND` (missing file), `400 IMPORT_MANIFEST_INVALID`
(corrupt/manifest-less package). Row failures during the load follow the
standard import report semantics and are embedded in the `201` response
(`{collection, report}`).

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

While a streamed export holds the collection's snapshot iterator, `:optimize`
and DDL (field/index operations) are rejected by Zvec; Studio answers
`409 MAINTENANCE_BLOCKED` — retry after the export finishes. `:flush` and all
document writes remain available throughout (verified against zvec 0.7.0).

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
          "params": {
            "M": 50,
            "efConstruction": 500,
            "quantizeType": "INT8",
            "quantizerParam": {"enableRotate": true}
          }
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
Zvec 0.6 random rotation is available for INT8/INT4 through
`quantizerParam.enableRotate` on FLAT, HNSW, and VAMANA indexes. FTS scalar
indexes accept `lowercase`, `ascii_folding`, and `stemmer` filters; configure
the stemmer language through `extraParams`, for example
`{"stemmer_lang":"english"}`.

Column naming: `id` and `_id` are allowed (Zvec keeps the primary key and a
same-named column independent; see *Primary key representation*). Vector
`dataType` supports FP32, FP16, INT8, and the two sparse types — `VECTOR_FP64`
is not offered because the Zvec engine rejects it at create time.

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
| POST   | `/collections/{name}/documents:import`                    | Bulk import from a local JSONL file |
| GET    | `/collections/{name}/documents:export`                    | Stream every document as a JSONL download |

### Primary key representation

A Zvec document's primary key lives *beside* its scalar fields, and a schema
may declare its own column named `id`. The row key that carries the primary
key therefore depends on the schema:

- schema has **no** `id` column → the primary key sits under `"id"`;
- schema **declares** an `id` column (field or vector) → the primary key sits
  under the reserved key `"$id"`, and the column keeps `"id"`.

`$id` can never collide with a user column (Zvec rejects field names
containing `$`). Writes follow the same rule: on a collection with an `id`
column, a bare `"id"` is ambiguous and rejected with `400`; give the primary
key as `"$id"`. Omitting the key — or giving an explicit `"id": null` /
`"$id": null` — auto-generates a ULID on `POST /documents` and `:upsert`.
All read paths (`GET`, `:browse`, search hits' `fields`) apply the same rule.

### Write semantics

`POST /documents`, `:upsert`, and `PATCH /documents` accept up to 10,000
documents and are written in internal SDK-sized batches. Failure
classification:

- `409 DOCUMENT_CONFLICT` — a primary key already exists (`insert` rejects
  duplicates);
- `404 DOCUMENT_NOT_FOUND` — `PATCH` targets an unknown id;
- `422 INVALID_DOCUMENT` — a document fails SDK validation.

Batching is **not transactional**: when a later chunk fails, documents from
earlier chunks are already written and visible to queries. Clients receiving
one of the errors above must not assume nothing was written.

### Export

Streams the whole collection through the Zvec snapshot iterator (constant
memory; writes during the export are invisible to it) and serves it as a
chunked `application/x-ndjson` download. Consume it with a native download
(`<a download>` / `curl -O`) — never buffer it with `fetch().blob()`.

```
GET /api/v1/collections/demo/documents:export?includeVector=true&outputFields=title,score&format=jsonl&mode=data
→ 200, Content-Type: application/x-ndjson
       Content-Disposition: attachment; filename="demo-20260827-101530.jsonl"
       Body: one JSON document per line
```

- `includeVector` (default `true`): include vector data in each row.
- `outputFields`: comma-separated scalar fields; omit for all.
- `format`: currently only `jsonl`; unknown values return
  `400 EXPORT_UNSUPPORTED_FORMAT`.
- `mode`: `data` (default, a single JSONL file) or `snapshot` (a `.tar.gz`
  bundling `manifest.json` + `documents.jsonl`; the manifest carries the
  schema so the collection can be recreated elsewhere — see Import).
- A document carrying NaN/±Inf cannot be serialized safely: the export fails
  with `422 EXPORT_NON_FINITE_VALUE` (reported before any byte is sent when it
  occurs in the first row).
- While the export runs, schema maintenance (`create_index`, `optimize`, ...)
  is rejected by Zvec; starting an export while maintenance runs returns
  `409 EXPORT_BLOCKED`.

Each row matches the document API representation (`id` + flattened fields and
vectors; a schema with its own `id` column carries the primary key under
`$id`), so an export can be re-imported verbatim via `documents:import`.

### Import

Streams a JSONL file — or, at the API level, a snapshot package
(`.tar.gz` / `.tgz`) — from the backend's local filesystem into the
collection. The file is read row by row and written in batches; the response
carries a per-row report. Row failures stay in the `200` body
(partial-success semantics) — only request-level problems (missing file,
unknown collection, unsupported format, invalid manifest, schema mismatch)
surface as `4xx`.

UI note: the in-collection Import dialog accepts data files only
(`.jsonl` / `.ndjson`). Snapshot packages are a collection-level concern and
are imported through `POST /collections:import` instead (sidebar `+` menu →
*Import Collection*; the dialog pre-fills the target directory as a sibling
of the snapshot file). The tar.gz form remains available here for loading a
snapshot's data into an already compatible collection.

For a snapshot package, the embedded `manifest.json` is parsed and
schema-checked against the target **before any row is written**: an
incompatible schema returns `409 IMPORT_SCHEMA_MISMATCH` (with a `mismatches`
list) and nothing is imported. Fields that the export pruned via
`outputFields` are exempt from the check (their data is not in the file). A
file that is not a readable gzip/tar stream — at open time or mid-read —
returns `400 IMPORT_MANIFEST_INVALID`.

```
POST /api/v1/collections/demo/documents:import
Content-Type: application/json

{
  "source": { "kind": "localPath", "path": "/Users/me/data/demo.jsonl" },
  "mode": "replace",
  "onError": "abort",
  "batchSize": 512
}
```

- `mode`: `replace` (default) overwrites the whole document for an existing
  id — re-importing the same file is idempotent. `insert` fails rows whose id
  already exists.
- `onError`: `abort` (default) stops at the first failing row (rows written
  before it are kept); `skip` records each failing row and continues.
- `format`: optional; defaults to the file extension (`.jsonl`/`.ndjson`),
  and extension-less files are treated as JSONL. Unsupported formats return
  `400 IMPORT_UNSUPPORTED_FORMAT`.
- `batchSize`: optional internal write batch size (1–1024).

Response:

```
{
  "imported": 998, "failed": 2, "totalLines": 1000,
  "aborted": false, "durationMs": 1520.4,
  "errors": [ { "line": 42, "code": "DOCUMENT_CONFLICT", "message": "..." } ],
  "errorsTruncated": false
}
```

`errors` holds at most the first 100 failing rows; `errorsTruncated` is set
when more occurred.

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

### Group-by search

Zvec 0.6 can return the nearest documents per scalar-field group for a single
vector query:

```json
{
  "queries": [
    { "field": "dense", "vector": [0.1, 0.2, "..."] }
  ],
  "groupByField": "category",
  "groupCount": 10,
  "topKPerGroup": 3
}
```

Group-by is supported for FLAT, HNSW, and HNSW_RABITQ indexes. It cannot be
combined with FTS, multi-query, rerankers, or refiner search. Each returned
result includes `groupByValue`.

### Response

```json
{
  "results": [
    {"id": "cat",    "score": 0.98, "fields": {"title": "cat"}},
    {"id": "kitten", "score": 0.92, "fields": {"title": "kitten"}}
  ],
  "took_ms": 3,
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
| GET  | `/fs/list?path=...&includeFiles=true&extensions=.jsonl,.tar.gz` | List files too (for the import file picker UI) |

`includeFiles` adds file entries (each with `kind:"file"` and `size` bytes)
alongside directories; `extensions` filters files only (directories are never
filtered, they are needed for navigation). Without `includeFiles` the response
is the legacy directory-only shape.

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
