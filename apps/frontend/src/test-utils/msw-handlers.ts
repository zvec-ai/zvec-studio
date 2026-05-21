/**
 * MSW handlers for an in-memory Collections + Documents + Searches backend.
 *
 * The handlers mutate a local Map so mutation/refetch flows can be exercised
 * end-to-end without a real backend. Each test creates a fresh server via
 * ``createCollectionsServer`` for isolation.
 */
import { http, HttpResponse } from 'msw';

export interface FakeCollection {
  name: string;
  path: string;
  /** Optional pre-seeded documents for T8+ tests. */
  documents?: Array<Record<string, unknown>>;
  /** Which field to use as the primary key when paginating. Defaults to 'id'. */
  primaryKey?: string;
}

export interface FakeRecentItem {
  path: string;
  lastOpenedAt: string;
}

export interface FakeServerState {
  readonly collections: Map<string, FakeCollection>;
  /** Persisted recent-collections list, ordered most-recent first. */
  recent?: Array<FakeRecentItem>;
  /** Tweak server behaviour per test. */
  listError?: { status: number; code: string; detail?: string };
  createError?: { status: number; code: string; detail?: string };
  deleteError?: { status: number; code: string; detail?: string };
  documentsError?: { status: number; code: string; detail?: string };
  insertError?: { status: number; code: string; detail?: string };
  deleteDocumentError?: { status: number; code: string; detail?: string };
  deleteBatchError?: { status: number; code: string; detail?: string };
  searchError?: { status: number; code: string; detail?: string };
  recentError?: { status: number; code: string; detail?: string };
}

const BASE = 'http://127.0.0.1/api/v1';

function problem(code: string, status: number, detail?: string) {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: code,
      status,
      detail: detail ?? code,
      code,
      traceId: 'trace-test',
    },
    { status, headers: { 'content-type': 'application/problem+json', 'x-trace-id': 'trace-test' } },
  );
}

/** Build handlers sharing the supplied state. */
export function makeCollectionHandlers(state: FakeServerState) {
  return [
    http.get(`${BASE}/collections`, () => {
      if (state.listError) {
        return problem(state.listError.code, state.listError.status, state.listError.detail);
      }
      return HttpResponse.json({
        items: Array.from(state.collections.values()).map((c) => ({ name: c.name, path: c.path })),
      });
    }),
    http.get(`${BASE}/collections/recent`, () => {
      if (state.recentError) {
        return problem(state.recentError.code, state.recentError.status, state.recentError.detail);
      }
      return HttpResponse.json({ items: state.recent ?? [] });
    }),
    http.delete(`${BASE}/collections/recent`, () => {
      state.recent = [];
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${BASE}/collections/recent:forget`, async ({ request }) => {
      const body = (await request.json()) as { path: string };
      state.recent = (state.recent ?? []).filter((item) => item.path !== body.path);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${BASE}/collections/:name`, ({ params }) => {
      const name = params.name as string;
      const record = state.collections.get(name);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      return HttpResponse.json({
        name: record.name,
        path: record.path,
        schema: {
          name: record.name,
          description: null,
          vectors: [
            { name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, description: null },
          ],
          fields: [{ name: 'id', dataType: 'INT64', isPrimary: true, description: null }],
          indexParams: { indexType: 'HNSW', metric: 'COSINE', params: {} },
        },
        stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
      });
    }),
    http.post(`${BASE}/collections`, async ({ request }) => {
      if (state.createError) {
        return problem(state.createError.code, state.createError.status, state.createError.detail);
      }
      const body = (await request.json()) as { path: string; schema: { name: string } };
      const record: FakeCollection = { name: body.schema.name, path: body.path };
      state.collections.set(record.name, record);
      return HttpResponse.json(
        {
          name: record.name,
          path: record.path,
          schema: body.schema,
          stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
        },
        { status: 201 },
      );
    }),
    http.post(`${BASE}/collections/open`, async ({ request }) => {
      const body = (await request.json()) as { path: string };
      const name = body.path.split('/').pop() ?? 'opened';
      const record: FakeCollection = { name, path: body.path };
      state.collections.set(record.name, record);
      return HttpResponse.json({
        name,
        path: body.path,
        schema: {
          name,
          description: null,
          vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, description: null }],
          fields: [{ name: 'id', dataType: 'INT64', isPrimary: true, description: null }],
          indexParams: { indexType: 'HNSW', metric: 'COSINE', params: {} },
        },
        stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
      });
    }),
    http.delete(`${BASE}/collections/:name`, ({ params }) => {
      if (state.deleteError) {
        return problem(state.deleteError.code, state.deleteError.status, state.deleteError.detail);
      }
      state.collections.delete(params.name as string);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${BASE}/collections/:name/documents`, ({ params, request }) => {
      if (state.documentsError) {
        return problem(
          state.documentsError.code,
          state.documentsError.status,
          state.documentsError.detail,
        );
      }
      const record = state.collections.get(params.name as string);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      const url = new URL(request.url);
      const cursor = url.searchParams.get('cursor');
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
      const filterExpr = url.searchParams.get('filter');
      const pk = record.primaryKey ?? 'id';
      const all = record.documents ?? [];
      let filtered: Array<Record<string, unknown>>;
      try {
        filtered = applyFilter(all, filterExpr);
      } catch (err) {
        return problem('INVALID_FILTER_EXPRESSION', 400, (err as Error).message);
      }
      const startIndex = cursor ? findCursorIndex(filtered, pk, cursor) : 0;
      if (startIndex < 0) {
        return problem('CURSOR_EXPIRED', 410, 'cursor no longer matches');
      }
      const page = filtered.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + page.length;
      const hasMore = page.length >= limit && nextIndex < filtered.length;
      const nextCursor =
        hasMore && page.length > 0 ? String(page[page.length - 1][pk]) : null;
      return HttpResponse.json({ items: page, nextCursor });
    }),
    http.post(`${BASE}/collections/:name/documents`, async ({ params, request }) => {
      if (state.insertError) {
        return problem(state.insertError.code, state.insertError.status, state.insertError.detail);
      }
      const record = state.collections.get(params.name as string);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      const body = (await request.json()) as { documents: Array<Record<string, unknown>> };
      const docs = Array.isArray(body?.documents) ? body.documents : [];
      if (docs.length === 0) {
        return problem('VALIDATION_ERROR', 422, 'documents must be non-empty');
      }
      record.documents = [...(record.documents ?? []), ...docs];
      return HttpResponse.json({ inserted: docs.length }, { status: 201 });
    }),
    http.post(
      `${BASE}/collections/:name/documents/deleteBatch`,
      async ({ params, request }) => {
        if (state.deleteBatchError) {
          return problem(
            state.deleteBatchError.code,
            state.deleteBatchError.status,
            state.deleteBatchError.detail,
          );
        }
        const record = state.collections.get(params.name as string);
        if (!record) {
          return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
        }
        const body = (await request.json()) as { ids: ReadonlyArray<unknown> };
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        const pk = record.primaryKey ?? 'id';
        const idSet = new Set(ids.map((v) => String(v)));
        const before = (record.documents ?? []).length;
        record.documents = (record.documents ?? []).filter(
          (d) => !idSet.has(String(d[pk])),
        );
        return HttpResponse.json({
          deleted: before - (record.documents?.length ?? 0),
        });
      },
    ),
    http.delete(`${BASE}/collections/:name/documents/:docId`, ({ params }) => {
      if (state.deleteDocumentError) {
        return problem(
          state.deleteDocumentError.code,
          state.deleteDocumentError.status,
          state.deleteDocumentError.detail,
        );
      }
      const record = state.collections.get(params.name as string);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      const pk = record.primaryKey ?? 'id';
      const raw = params.docId as string;
      const before = (record.documents ?? []).length;
      record.documents = (record.documents ?? []).filter(
        (d) => String(d[pk]) !== raw,
      );
      if ((record.documents?.length ?? 0) === before) {
        return problem('DOCUMENT_NOT_FOUND', 404, 'document not found');
      }
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${BASE}/collections/:name/documents/:docId`, ({ params }) => {
      const record = state.collections.get(params.name as string);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      const pk = record.primaryKey ?? 'id';
      const raw = params.docId as string;
      const coerced = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw;
      const doc = (record.documents ?? []).find((d) => d[pk] === coerced || String(d[pk]) === raw);
      if (!doc) {
        return problem('DOCUMENT_NOT_FOUND', 404, 'document not found');
      }
      return HttpResponse.json(doc);
    }),
    http.post(`${BASE}/collections/:name/searches`, async ({ params, request }) => {
      if (state.searchError) {
        return problem(state.searchError.code, state.searchError.status, state.searchError.detail);
      }
      const record = state.collections.get(params.name as string);
      if (!record) {
        return problem('COLLECTION_NOT_FOUND', 404, 'collection not found');
      }
      const body = (await request.json()) as {
        vector?: Array<number>;
        topK?: number;
        filter?: string | null;
        outputFields?: Array<string> | null;
      };
      const topK = Math.max(1, Math.min(100, Number(body?.topK ?? 10)));
      const pk = record.primaryKey ?? 'id';
      let pool: Array<Record<string, unknown>>;
      try {
        pool = applyFilter(record.documents ?? [], body?.filter ?? null);
      } catch (err) {
        return problem('INVALID_FILTER_EXPRESSION', 400, (err as Error).message);
      }
      const results = pool.slice(0, topK).map((doc, i) => ({
        id: doc[pk] ?? i,
        score: Number((0.99 - i * 0.05).toFixed(4)),
        fields: projectFields(doc, body?.outputFields ?? null),
      }));
      return HttpResponse.json({
        results,
        took_ms: 1.23,
        traceId: 'trace-test',
      });
    }),
  ];
}

function findCursorIndex(
  rows: ReadonlyArray<Record<string, unknown>>,
  pk: string,
  cursor: string,
): number {
  for (let i = 0; i < rows.length; i += 1) {
    if (String(rows[i][pk]) === cursor) {
      return i + 1;
    }
  }
  return -1;
}

/** Minimal mirror of the backend filter grammar: ``<field> <op> <value>``. */
function applyFilter(
  rows: ReadonlyArray<Record<string, unknown>>,
  expr: string | null,
): Array<Record<string, unknown>> {
  if (!expr || !expr.trim()) return rows.slice();
  const match = expr
    .trim()
    .match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) {
    throw new Error(`Unsupported filter expression: ${expr}`);
  }
  const [, field, op, rawValue] = match;
  const value = parseLiteral(rawValue.trim());
  return rows.filter((row) => {
    const v = row[field];
    if (v === undefined) return false;
    switch (op) {
      case '==':
        return v === value;
      case '!=':
        return v !== value;
      case '>':
        return (v as number) > (value as number);
      case '>=':
        return (v as number) >= (value as number);
      case '<':
        return (v as number) < (value as number);
      case '<=':
        return (v as number) <= (value as number);
      default:
        return false;
    }
  });
}

function parseLiteral(raw: string): unknown {
  if (
    raw.length >= 2 &&
    ((raw[0] === '"' && raw[raw.length - 1] === '"') ||
      (raw[0] === "'" && raw[raw.length - 1] === "'"))
  ) {
    return raw.slice(1, -1);
  }
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const asNum = Number(raw);
  if (!Number.isNaN(asNum)) return asNum;
  throw new Error(`Could not parse filter literal: ${raw}`);
}

function projectFields(
  doc: Record<string, unknown>,
  outputFields: ReadonlyArray<string> | null,
): Record<string, unknown> {
  if (!outputFields || outputFields.length === 0) return { ...doc };
  const picked: Record<string, unknown> = {};
  for (const f of outputFields) {
    if (f in doc) picked[f] = doc[f];
  }
  return picked;
}
