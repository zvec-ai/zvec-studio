/**
 * T6 smoke E2E: Collections list page — Create → List → Delete → Empty.
 *
 * The backend is mocked at the network layer via ``page.route`` so this spec
 * is self-contained and can't be perturbed by the developer's local state.
 * Real backend coverage lives in backend integration + contract tests.
 */
import { test, expect, type Route } from '@playwright/test';

interface FakeCollection {
  name: string;
  path: string;
  documents?: Array<Record<string, unknown>>;
}

/**
 * Install a minimal in-memory backend at the ``/api/v1/collections*`` routes.
 * Returns the underlying state so the spec can peek / seed it.
 */
async function mountFakeBackend(
  page: import('@playwright/test').Page,
  seed: FakeCollection[] = [],
): Promise<{ collections: Map<string, FakeCollection> }> {
  const state = {
    collections: new Map<string, FakeCollection>(seed.map((c) => [c.name, c])),
  };

  async function fulfillList(route: Route): Promise<void> {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: Array.from(state.collections.values()),
      }),
    });
  }

  async function fulfillCreate(route: Route): Promise<void> {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      path: string;
      schema: { name: string };
    };
    const record: FakeCollection = { name: body.schema.name, path: body.path };
    state.collections.set(record.name, record);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        name: record.name,
        path: record.path,
        schema: body.schema,
        stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
      }),
    });
  }

  async function fulfillDelete(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    state.collections.delete(name);
    await route.fulfill({ status: 204, body: '' });
  }

  async function fulfillDetail(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const record = state.collections.get(name);
    if (!record) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'COLLECTION_NOT_FOUND',
          status: 404,
          code: 'COLLECTION_NOT_FOUND',
          detail: 'not found',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: record.name,
        path: record.path,
        schema: {
          name: record.name,
          description: null,
          vectors: [
            { name: 'embedding', dataType: 'VECTOR_FP32', dimension: 128, description: null },
          ],
          fields: [{ name: 'id', dataType: 'INT64', isPrimary: true, description: null }],
          indexParams: { indexType: 'HNSW', metric: 'COSINE', params: {} },
        },
        stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
      }),
    });
  }

  // Order matters -- the more specific DELETE/GET handler must win over the list.
  await page.route('**/api/v1/collections/*/documents/*', async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const last = decodeURIComponent(parts[parts.length - 1] ?? '');
    const name = decodeURIComponent(parts[parts.length - 3] ?? '');
    const record = state.collections.get(name);

    // POST /documents/deleteBatch -- batch delete
    if (method === 'POST' && last === 'deleteBatch') {
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as { ids?: unknown[] };
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const idSet = new Set(ids.map((v) => String(v)));
      const before = (record.documents ?? []).length;
      record.documents = (record.documents ?? []).filter(
        (d) => !idSet.has(String((d as Record<string, unknown>).id)),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: before - (record.documents?.length ?? 0) }),
      });
      return;
    }

    // DELETE /documents/:id -- single delete
    if (method === 'DELETE') {
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
        return;
      }
      const before = (record.documents ?? []).length;
      record.documents = (record.documents ?? []).filter(
        (d) => String((d as Record<string, unknown>).id) !== last,
      );
      if ((record.documents?.length ?? 0) === before) {
        await route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'DOCUMENT_NOT_FOUND',
            status: 404,
            code: 'DOCUMENT_NOT_FOUND',
            detail: 'not found',
          }),
        });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    if (method !== 'GET') {
      await route.continue();
      return;
    }
    const doc = record?.documents?.find(
      (d) => String((d as Record<string, unknown>).id) === last,
    );
    if (!doc) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'DOCUMENT_NOT_FOUND',
          status: 404,
          code: 'DOCUMENT_NOT_FOUND',
          detail: 'not found',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(doc),
    });
  });

  await page.route('**/api/v1/collections/*/documents*', async (route) => {
    const method = route.request().method();
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const lastSeg = parts[parts.length - 1] ?? '';
    // ``parts`` ends with either ``documents`` (insert) or ``documents:verb``;
    // the Collection name is therefore always one segment up.
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    const record = state.collections.get(name);

    // POST /documents:browse -- v0.2.0 Filter Browser replacement for GET cursor list.
    if (method === 'POST' && lastSeg === 'documents:browse') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        filter?: string | null;
        limit?: number;
      };
      const all = record?.documents ?? [];
      const filter = body.filter ?? null;
      const limit = body.limit ?? 50;
      const filtered = filter ? applyE2EFilter(all, filter) : all;
      if (filter && filtered === null) {
        await route.fulfill({
          status: 400,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'INVALID_FILTER_EXPRESSION',
            status: 400,
            code: 'INVALID_FILTER_EXPRESSION',
            detail: 'Unable to parse the filter.',
            messageKey: 'errors.INVALID_FILTER_EXPRESSION',
            severity: 'warning',
          }),
        });
        return;
      }
      const items = (filtered ?? []).slice(0, limit);
      const truncated = (filtered ?? []).length > items.length;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, truncated }),
      });
      return;
    }

    // POST /documents:deleteByFilter -- AIP-136 custom verb for bulk delete.
    if (method === 'POST' && lastSeg === 'documents:deleteByFilter') {
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as { filter?: string };
      const filter = body.filter ?? '';
      const filtered = applyE2EFilter(record.documents ?? [], filter);
      if (filtered === null) {
        await route.fulfill({
          status: 400,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'about:blank',
            title: 'INVALID_FILTER_EXPRESSION',
            status: 400,
            code: 'INVALID_FILTER_EXPRESSION',
            detail: 'Unable to parse the filter.',
            messageKey: 'errors.INVALID_FILTER_EXPRESSION',
            severity: 'warning',
          }),
        });
        return;
      }
      const matchedIds = new Set((filtered ?? []).map((d) => String((d as Record<string, unknown>).id)));
      const before = (record.documents ?? []).length;
      record.documents = (record.documents ?? []).filter(
        (d) => !matchedIds.has(String((d as Record<string, unknown>).id)),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: before - (record.documents?.length ?? 0) }),
      });
      return;
    }

    // POST /documents:deleteBatch -- v0.2.0 custom verb (replaces /documents/deleteBatch).
    if (method === 'POST' && lastSeg === 'documents:deleteBatch') {
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as { ids?: unknown[] };
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const idSet = new Set(ids.map((v) => String(v)));
      const before = (record.documents ?? []).length;
      record.documents = (record.documents ?? []).filter(
        (d) => !idSet.has(String((d as Record<string, unknown>).id)),
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: before - (record.documents?.length ?? 0) }),
      });
      return;
    }

    // POST /documents -- insert
    if (method === 'POST') {
      if (!record) {
        await route.fulfill({ status: 404, contentType: 'application/problem+json', body: '{}' });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        documents?: Array<Record<string, unknown>>;
      };
      const docs = Array.isArray(body.documents) ? body.documents : [];
      record.documents = [...(record.documents ?? []), ...docs];
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ inserted: docs.length }),
      });
      return;
    }

    if (method !== 'GET') {
      await route.continue();
      return;
    }
    const all = record?.documents ?? [];
    const filter = url.searchParams.get('filter');
    const limitRaw = url.searchParams.get('limit');
    const cursorRaw = url.searchParams.get('cursor');
    const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50;
    const filtered = filter
      ? applyE2EFilter(all, filter)
      : all;
    if (filter && filtered === null) {
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'INVALID_FILTER_EXPRESSION',
          status: 400,
          code: 'INVALID_FILTER_EXPRESSION',
          detail: 'Unable to parse the filter.',
          messageKey: 'errors.INVALID_FILTER_EXPRESSION',
          severity: 'warning',
        }),
      });
      return;
    }
    let offset = 0;
    if (cursorRaw) {
      try {
        const decoded = JSON.parse(
          Buffer.from(cursorRaw, 'base64').toString('utf-8'),
        ) as { offset?: number };
        offset = decoded.offset ?? 0;
      } catch {
        offset = 0;
      }
    }
    const pageRows = (filtered ?? []).slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const hasNext = (filtered ?? []).length > nextOffset;
    const nextCursor = hasNext
      ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString('base64')
      : null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: pageRows, nextCursor }),
    });
  });

  await page.route('**/api/v1/collections/*/searches', async (route) => {
    const method = route.request().method();
    if (method !== 'POST') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    const record = state.collections.get(name);
    if (!record) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'COLLECTION_NOT_FOUND',
          status: 404,
          code: 'COLLECTION_NOT_FOUND',
          detail: 'not found',
        }),
      });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      topK?: number;
      filter?: string | null;
      outputFields?: Array<string> | null;
    };
    const topK = Math.max(1, Math.min(100, Number(body.topK ?? 10)));
    const pool = body.filter
      ? (applyE2EFilter(record.documents ?? [], body.filter) ?? [])
      : (record.documents ?? []);
    const outputFields = Array.isArray(body.outputFields) && body.outputFields.length > 0
      ? body.outputFields
      : null;
    const results = pool.slice(0, topK).map((doc, i) => {
      const id = (doc as Record<string, unknown>).id ?? i;
      const fields = outputFields
        ? Object.fromEntries(
            outputFields
              .filter((k) => k in (doc as Record<string, unknown>))
              .map((k) => [k, (doc as Record<string, unknown>)[k]]),
          )
        : { ...(doc as Record<string, unknown>) };
      return { id, score: Number((0.99 - i * 0.05).toFixed(4)), fields };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, took_ms: 1.23, traceId: 'trace-e2e' }),
    });
  });

  await page.route('**/api/v1/collections/*/searches', async (route) => {
    const method = route.request().method();
    if (method !== 'POST') {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const parts = url.pathname.split('/');
    const name = decodeURIComponent(parts[parts.length - 2] ?? '');
    const record = state.collections.get(name);
    if (!record) {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'COLLECTION_NOT_FOUND',
          status: 404,
          code: 'COLLECTION_NOT_FOUND',
          detail: 'not found',
        }),
      });
      return;
    }
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      topK?: number;
      filter?: string | null;
      outputFields?: Array<string> | null;
    };
    const topK = Math.max(1, Math.min(100, Number(body.topK ?? 10)));
    const pool = body.filter
      ? (applyE2EFilter(record.documents ?? [], body.filter) ?? [])
      : (record.documents ?? []);
    const outputFields =
      Array.isArray(body.outputFields) && body.outputFields.length > 0
        ? body.outputFields
        : null;
    const results = pool.slice(0, topK).map((doc, i) => {
      const obj = doc as Record<string, unknown>;
      const id = obj.id ?? i;
      const fields = outputFields
        ? Object.fromEntries(
            outputFields.filter((k) => k in obj).map((k) => [k, obj[k]]),
          )
        : { ...obj };
      return { id, score: Number((0.99 - i * 0.05).toFixed(4)), fields };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results, took_ms: 1.23, traceId: 'trace-e2e' }),
    });
  });

  await page.route('**/api/v1/collections/*', async (route) => {
    const method = route.request().method();
    if (method === 'DELETE') {
      await fulfillDelete(route);
    } else if (method === 'GET') {
      await fulfillDetail(route);
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/v1/collections', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await fulfillList(route);
    } else if (method === 'POST') {
      await fulfillCreate(route);
    } else {
      await route.continue();
    }
  });

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/healthz')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
    } else if (path.includes('/ai/embeddings')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    } else if (path.includes('/ai/rerankers')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  return state;
}

/**
 * Tiny filter evaluator supporting the ``field OP value`` shape used by the
 * T8 smoke spec. Returns ``null`` when the expression cannot be parsed so the
 * caller can surface a 400 Problem Details response like the real backend.
 */
function applyE2EFilter(
  rows: ReadonlyArray<Record<string, unknown>>,
  expr: string,
): Array<Record<string, unknown>> | null {
  const match = expr.trim().match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (!match) return null;
  const [, field, op, rawValue] = match;
  const value: unknown = parseLiteral(rawValue.trim());
  const cmp = (a: unknown, b: unknown): boolean => {
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) {
        case '>': return a > b;
        case '>=': return a >= b;
        case '<': return a < b;
        case '<=': return a <= b;
        case '==': return a === b;
        case '!=': return a !== b;
      }
    }
    if (op === '==') return a === b;
    if (op === '!=') return a !== b;
    return false;
  };
  return rows.filter((row) => cmp(row[field], value));
}

function parseLiteral(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

test.describe('Collections page smoke flow', () => {
  // Existing specs assume the user has already completed onboarding — stamp the
  // flag before navigation so the welcome dialog never intercepts pointer events.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('zvec-studio:onboarded', '1');
      } catch {
        /* ignore */
      }
    });
  });
  test('renders empty state when the list is empty', async ({ page }) => {
    await mountFakeBackend(page, []);
    await page.goto('/');

    await expect(page.getByTestId('zv-collections-empty')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No Collection yet' })).toBeVisible();
  });

  test('creates, lists and deletes a Collection end to end', async ({ page }) => {
    const state = await mountFakeBackend(page, []);
    await page.goto('/');

    // Empty state -> click Create.
    await expect(page.getByTestId('zv-collections-empty')).toBeVisible();
    await page.getByTestId('zv-create-collection').click();

    // Fill the Create dialog with the minimum required payload.
    await page.getByTestId('zv-create-name').fill('smoke_coll');
    await page.getByTestId('zv-create-path').fill('/tmp/smoke_coll');
    await page.getByTestId('zv-create-submit').click();

    // Dialog closes, table appears, row is visible.
    await expect(page.getByTestId('zv-collections-table')).toBeVisible();
    await expect(page.getByTestId('zv-collection-path-smoke_coll')).toHaveText(
      '/tmp/smoke_coll',
    );
    expect(state.collections.has('smoke_coll')).toBe(true);

    // Delete the row via the confirmation dialog.
    await page.getByTestId('zv-collection-delete-smoke_coll').click();
    await expect(page.getByRole('heading', { name: 'Delete Collection?' })).toBeVisible();
    await page.getByTestId('zv-collection-delete-confirm').click();

    // Back to empty state.
    await expect(page.getByTestId('zv-collections-empty')).toBeVisible();
    expect(state.collections.has('smoke_coll')).toBe(false);
  });

  test('views Collection details and returns to the list', async ({ page }) => {
    const state = await mountFakeBackend(page, [
      { name: 'smoke_detail', path: '/tmp/smoke_detail' },
    ]);
    await page.goto('/');

    // Navigate to detail via the name link in the list.
    await page.getByTestId('zv-collection-link-smoke_detail').click();

    // Detail header reflects the fake backend payload.
    await expect(page.getByTestId('zv-collection-detail-name')).toHaveText('smoke_detail');
    await expect(page.getByTestId('zv-collection-detail-path')).toContainText('/tmp/smoke_detail');
    await expect(page.getByTestId('zv-collection-detail-dimension')).toHaveText('128');

    // Schema tab is the default; switch to Stats.
    await page.getByTestId('zv-tab-stats').click();
    await expect(page.getByTestId('zv-collection-detail-stats')).toBeVisible();

    // Closing a Collection now lives only on the list page — the detail page
    // intentionally has no "Close" button. Walk back via the breadcrumb link
    // and use the list-page delete instead.
    await page.getByTestId('zv-collection-back').click();
    await page.getByTestId('zv-collection-delete-smoke_detail').click();
    await page.getByTestId('zv-collection-delete-confirm').click();

    await expect(page.getByTestId('zv-collections-empty')).toBeVisible();
    expect(state.collections.has('smoke_detail')).toBe(false);
  });

  test('browses Collection documents with filter and drawer', async ({
    page,
  }) => {
    // Seed the fake backend with 120 rows so the truncated banner appears at
    // the default limit and the filter result is clearly distinguishable.
    const docs: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 120; i += 1) {
      docs.push({
        id: i,
        title: `doc-${i}`,
        embedding: Array.from({ length: 32 }, (_, k) => (i + k) / 100),
      });
    }
    await mountFakeBackend(page, [
      { name: 'smoke_docs', path: '/tmp/smoke_docs', documents: docs },
    ]);
    await page.goto('/collections/smoke_docs');

    // Switch to the Documents tab and wait for the panel.
    await page.getByTestId('zv-tab-documents').click();
    await expect(page.getByTestId('zv-documents-panel')).toBeVisible();
    await expect(page.getByTestId('zv-documents-row-1')).toBeVisible();

    // Apply a filter that only matches row id=3.
    await page.getByTestId('zv-documents-filter').fill('id == 3');
    await page.getByTestId('zv-documents-filter-apply').click();
    await expect(page.getByTestId('zv-documents-row-3')).toBeVisible();
    await expect(page.getByTestId('zv-documents-row-1')).toHaveCount(0);

    // Click the row to open the drawer with the full JSON.
    await page.getByTestId('zv-documents-row-3').click();
    await expect(page.getByTestId('zv-documents-drawer-body')).toBeVisible();
    await expect(page.getByTestId('zv-documents-drawer-body')).toContainText(
      '"title": "doc-3"',
    );
    await page.getByTestId('zv-documents-drawer-close').click();
    await expect(page.getByTestId('zv-documents-drawer-body')).toHaveCount(0);

    // Reset the filter — the full list comes back.
    await page.getByTestId('zv-documents-filter-reset').click();
    await expect(page.getByTestId('zv-documents-row-1')).toBeVisible();
  });

  test('inserts and batch-deletes documents via the Documents tab', async ({
    page,
  }) => {
    const docs: Array<Record<string, unknown>> = [
      { id: 1, title: 'alpha' },
      { id: 2, title: 'beta' },
      { id: 3, title: 'gamma' },
    ];
    const state = await mountFakeBackend(page, [
      { name: 'smoke_ins', path: '/tmp/smoke_ins', documents: docs },
    ]);
    await page.goto('/collections/smoke_ins');

    await page.getByTestId('zv-tab-documents').click();
    await expect(page.getByTestId('zv-documents-panel')).toBeVisible();
    await expect(page.getByTestId('zv-documents-row-1')).toBeVisible();

    // --- Insert flow ---
    await page.getByTestId('zv-documents-insert').click();
    await expect(page.getByTestId('zv-insert-doc-body')).toBeVisible();

    // Seed template is injected on open — overwrite with our own payload.
    const payload = JSON.stringify(
      [
        { id: 101, title: 'inserted-one' },
        { id: 102, title: 'inserted-two' },
      ],
      null,
      2,
    );
    await page.getByTestId('zv-insert-doc-body').fill(payload);
    await page.getByTestId('zv-insert-doc-submit').click();

    // Dialog closes; new rows appear in the table and fake state grew.
    await expect(page.getByTestId('zv-insert-doc-body')).toBeHidden();
    await expect(page.getByTestId('zv-documents-row-101')).toBeVisible();
    await expect(page.getByTestId('zv-documents-row-102')).toBeVisible();
    expect(state.collections.get('smoke_ins')?.documents?.length).toBe(5);

    // --- Single-row delete via the row action button ---
    await page.getByTestId('zv-documents-delete-row-1').click();
    await expect(page.getByTestId('zv-documents-delete-confirm-body')).toBeVisible();
    await page.getByTestId('zv-documents-delete-confirm').click();
    await expect(page.getByTestId('zv-documents-row-1')).toHaveCount(0);
    expect(state.collections.get('smoke_ins')?.documents?.length).toBe(4);

    // --- Batch delete via selection checkboxes ---
    await page.getByTestId('zv-documents-select-2').click();
    await page.getByTestId('zv-documents-select-3').click();
    await expect(page.getByTestId('zv-documents-selection-bar')).toBeVisible();
    await page.getByTestId('zv-documents-delete-selected').click();
    await expect(page.getByTestId('zv-documents-delete-confirm-body')).toBeVisible();
    await page.getByTestId('zv-documents-delete-confirm').click();
    await expect(page.getByTestId('zv-documents-row-2')).toHaveCount(0);
    await expect(page.getByTestId('zv-documents-row-3')).toHaveCount(0);
    await expect(page.getByTestId('zv-documents-row-101')).toBeVisible();
    await expect(page.getByTestId('zv-documents-row-102')).toBeVisible();
    expect(state.collections.get('smoke_ins')?.documents?.length).toBe(2);
  });

  test('runs a vector search and persists history on the Search tab', async ({
    page,
  }) => {
    // Seed three documents so topK=2 clearly demonstrates result ordering.
    // Backend stub pins dimension=128 in fulfillDetail, so the query must
    // match that exactly or SearchPanel's client-side guard rejects it.
    const makeVec = (offset: number) =>
      Array.from({ length: 128 }, (_, k) => Number(((k + offset) / 1000).toFixed(4)));
    const docs: Array<Record<string, unknown>> = [
      { id: 1, title: 'alpha', embedding: makeVec(0) },
      { id: 2, title: 'beta', embedding: makeVec(1) },
      { id: 3, title: 'gamma', embedding: makeVec(2) },
    ];
    await mountFakeBackend(page, [
      { name: 'smoke_search', path: '/tmp/smoke_search', documents: docs },
    ]);
    await page.goto('/collections/smoke_search');

    // Clear any stale history from previous runs so the empty state renders.
    await page.evaluate(() => window.localStorage.clear());

    await page.getByTestId('zv-tab-search').click();
    await expect(page.getByTestId('zv-search-panel')).toBeVisible();
    await expect(page.getByTestId('zv-search-empty')).toBeVisible();
    await expect(page.getByTestId('zv-search-history-empty')).toBeVisible();

    // Fill a dim-128 query vector, lower topK to 2 and submit.
    const queryVec = JSON.stringify(
      Array.from({ length: 128 }, (_, k) => Number((k / 1000).toFixed(4))),
    );
    await page.getByTestId('zv-search-vector').fill(queryVec);
    await page.getByTestId('zv-search-topk').fill('2');
    await page.getByTestId('zv-search-submit').click();

    // Top two rows appear in score order; third is excluded by topK.
    await expect(page.getByTestId('zv-search-results')).toBeVisible();
    await expect(page.getByTestId('zv-search-row-1')).toBeVisible();
    await expect(page.getByTestId('zv-search-row-2')).toBeVisible();
    await expect(page.getByTestId('zv-search-row-3')).toHaveCount(0);
    await expect(page.getByTestId('zv-search-summary')).toContainText('2');

    // Clicking a row reveals the drawer with the raw JSON payload.
    await page.getByTestId('zv-search-row-1').click();
    await expect(page.getByTestId('zv-search-drawer-body')).toBeVisible();
    await expect(page.getByTestId('zv-search-drawer-body')).toContainText(
      '"title": "alpha"',
    );
    await page.getByTestId('zv-search-drawer-close').click();
    await expect(page.getByTestId('zv-search-drawer-body')).toBeHidden();

    // History captured the query; clearing it restores the empty hint.
    await expect(page.getByTestId('zv-search-history')).toBeVisible();
    await page.getByTestId('zv-search-history-clear').click();
    await expect(page.getByTestId('zv-search-history-empty')).toBeVisible();
  });
});

test.describe('Onboarding & error recovery', () => {
  test('auto-opens the onboarding walkthrough on first visit and finishes in 3 steps', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      try { window.localStorage.removeItem('zvec-studio:onboarded'); } catch { /* noop */ }
    });
    await mountFakeBackend(page, []);
    await page.goto('/');

    await expect(page.getByTestId('zv-onboarding')).toBeVisible();
    await expect(page.getByTestId('zv-onboarding-step-0')).toBeVisible();
    await page.getByTestId('zv-onboarding-next').click();
    await expect(page.getByTestId('zv-onboarding-step-1')).toBeVisible();
    await page.getByTestId('zv-onboarding-next').click();
    await expect(page.getByTestId('zv-onboarding-step-2')).toBeVisible();
    await page.getByTestId('zv-onboarding-next').click();
    await expect(page.getByTestId('zv-onboarding')).toBeHidden();

    const stored = await page.evaluate(() => window.localStorage.getItem('zvec-studio:onboarded'));
    expect(stored).toBe('1');
    await expect(page.getByTestId('zv-collections-empty')).toBeVisible();
  });

  test('surfaces the error state and recovers after the backend comes back', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('zvec-studio:onboarded', '1'); } catch { /* noop */ }
    });

    let allowSuccess = false;
    await page.route('**/api/v1/collections', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      // Until the user clicks Retry we keep returning 500 regardless of how many
      // times the client (StrictMode + TanStack Query retry) dispatches the call.
      if (!allowSuccess) {
        await route.fulfill({
          status: 500,
          contentType: 'application/problem+json',
          headers: { 'x-trace-id': 'trace-smoke-500' },
          body: JSON.stringify({
            type: 'about:blank',
            title: 'INTERNAL_ERROR',
            status: 500,
            code: 'INTERNAL_ERROR',
            detail: 'boom',
            traceId: 'trace-smoke-500',
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ name: 'recovered', path: '/tmp/recovered' }] }),
      });
    });

    await page.goto('/');
    await expect(page.getByTestId('zv-collections-error')).toBeVisible();
    await expect(page.getByTestId('zv-collections-error-retry')).toBeVisible();

    // Flip the backend to healthy BEFORE clicking Retry so the refetch succeeds.
    allowSuccess = true;
    await page.getByTestId('zv-collections-error-retry').click();
    await expect(page.getByTestId('zv-collections-table')).toBeVisible();
    await expect(page.getByTestId('zv-collection-path-recovered')).toHaveText('/tmp/recovered');
  });
});
