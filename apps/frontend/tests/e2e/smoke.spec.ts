/**
 * E2E smoke tests for Zvec Studio.
 *
 * The backend is mocked at the network layer via ``page.route`` so this spec
 * is self-contained and can't be perturbed by the developer's local state.
 * Real backend coverage lives in backend integration + contract tests.
 */
import { test, expect, type Route, type Page } from '@playwright/test';

interface FakeCollection {
  name: string;
  path: string;
  documents?: Array<Record<string, unknown>>;
}

interface FakeBackendState {
  collections: Map<string, FakeCollection>;
}

/**
 * Install a minimal in-memory backend at the API routes.
 * Mocks all endpoints that the AppShell calls on boot so the SPA doesn't hang
 * waiting for a real server.
 */
async function mountFakeBackend(
  page: Page,
  seed: FakeCollection[] = [],
): Promise<FakeBackendState> {
  const state: FakeBackendState = {
    collections: new Map<string, FakeCollection>(seed.map((c) => [c.name, c])),
  };

  async function fulfillList(route: Route): Promise<void> {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: Array.from(state.collections.values()).map((c) => ({
          name: c.name,
          path: c.path,
        })),
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

  async function fulfillOpen(route: Route): Promise<void> {
    const body = JSON.parse(route.request().postData() ?? '{}') as { path: string };
    const existing = Array.from(state.collections.values()).find((c) => c.path === body.path);
    if (existing) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ name: existing.name, path: existing.path }),
      });
      return;
    }
    const name = body.path.split('/').pop() ?? 'unknown';
    const record: FakeCollection = { name, path: body.path };
    state.collections.set(name, record);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name, path: body.path }),
    });
  }

  async function fulfillDetail(route: Route): Promise<void> {
    const url = new URL(route.request().url());
    const segments = url.pathname.split('/');
    const name = decodeURIComponent(segments[segments.length - 1] ?? '');
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
        stats: { documentCount: record.documents?.length ?? 0, indexState: 'none', storageBytes: 0 },
      }),
    });
  }

  // Route registration order matters: Playwright matches last-registered first.
  // Register the catch-all FIRST (lowest priority) then more specific routes.

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/healthz')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', zvecVersion: '0.4.0' }),
      });
    } else if (path.includes('/ai/embeddings')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    } else if (path.includes('/ai/rerankers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
    } else if (path.includes('/collections/recent')) {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [] }),
        });
      } else {
        await route.fulfill({ status: 204, body: '' });
      }
    } else if (path.includes('/collections/open')) {
      await fulfillOpen(route);
    } else if (path.includes('/collections') && path.includes('/documents')) {
      const method = route.request().method();
      const parts = path.split('/');
      const lastSeg = parts[parts.length - 1] ?? '';
      const nameIdx = parts.indexOf('collections') + 1;
      const name = decodeURIComponent(parts[nameIdx] ?? '');
      const record = state.collections.get(name);

      if (method === 'POST' && lastSeg === 'documents:browse') {
        const all = record?.documents ?? [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: all.slice(0, 50), truncated: all.length > 50 }),
        });
      } else if (method === 'POST' && (lastSeg === 'documents' || lastSeg.startsWith('documents'))) {
        const body = JSON.parse(route.request().postData() ?? '{}') as {
          documents?: Array<Record<string, unknown>>;
        };
        const docs = Array.isArray(body.documents) ? body.documents : [];
        if (record) record.documents = [...(record.documents ?? []), ...docs];
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ inserted: docs.length }),
        });
      } else {
        const all = record?.documents ?? [];
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: all.slice(0, 50), nextCursor: null }),
        });
      }
    } else if (path.includes('/collections') && path.includes('/searches')) {
      const parts = path.split('/');
      const nameIdx = parts.indexOf('collections') + 1;
      const name = decodeURIComponent(parts[nameIdx] ?? '');
      const record = state.collections.get(name);
      if (!record) {
        await route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          body: JSON.stringify({ type: 'about:blank', title: 'NOT_FOUND', status: 404 }),
        });
        return;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as { topK?: number };
      const topK = Math.max(1, Math.min(100, Number(body.topK ?? 10)));
      const pool = record.documents ?? [];
      const results = pool.slice(0, topK).map((doc, i) => ({
        id: (doc as Record<string, unknown>).id ?? i,
        score: Number((0.99 - i * 0.05).toFixed(4)),
        fields: { ...(doc as Record<string, unknown>) },
      }));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ results, took_ms: 1.23, traceId: 'trace-e2e' }),
      });
    } else if (path.match(/\/collections\/[^/]+$/)) {
      const method = route.request().method();
      if (method === 'GET') {
        await fulfillDetail(route);
      } else if (method === 'DELETE') {
        const name = decodeURIComponent(path.split('/').pop() ?? '');
        state.collections.delete(name);
        await route.fulfill({ status: 204, body: '' });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    } else if (path.endsWith('/collections')) {
      const method = route.request().method();
      if (method === 'GET') {
        await fulfillList(route);
      } else if (method === 'POST') {
        await fulfillCreate(route);
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
  });

  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding (auto-open removed; only manual SpotlightTour remains)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Onboarding', () => {
  test('does not auto-open onboarding on first visit', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.removeItem('zvec-studio:onboarded');
      } catch { /* noop */ }
    });
    await mountFakeBackend(page, []);
    await page.goto('/');

    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('zv-onboarding')).toBeHidden();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// App shell & navigation
// ─────────────────────────────────────────────────────────────────────────────

test.describe('App shell & navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('zvec-studio:onboarded', '1');
      } catch { /* noop */ }
    });
  });

  test('renders the app shell with sidebar and main content', async ({ page }) => {
    await mountFakeBackend(page, [
      { name: 'my_collection', path: '/tmp/my_collection' },
    ]);
    // Use /collections path where the sidebar is visible (sidebar is hidden on /).
    await page.goto('/collections');

    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('app-content')).toBeVisible();

    // Sidebar shows collection names.
    await expect(page.locator('.zv-sidebar__item-name', { hasText: 'my_collection' })).toBeVisible();
  });

  test('navigates to collection detail page from sidebar', async ({ page }) => {
    await mountFakeBackend(page, [
      { name: 'nav_test', path: '/tmp/nav_test' },
    ]);
    await page.goto('/collections');

    // Click the collection in the sidebar.
    await page.locator('.zv-sidebar__item', { hasText: 'nav_test' }).click();

    // Should navigate to the detail page and show tabs.
    await expect(page.locator('.zv-detail-tab')).toHaveCount(4);
    await expect(page.locator('.zv-detail-tab--active')).toContainText(/overview/i);
  });

  test('navigates to collection detail via URL', async ({ page }) => {
    await mountFakeBackend(page, [
      { name: 'direct_nav', path: '/tmp/direct_nav' },
    ]);
    await page.goto('/collections/direct_nav?path=%2Ftmp%2Fdirect_nav');

    await expect(page.locator('.zv-detail-tab')).toHaveCount(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Create Collection dialog
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Create Collection', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('zvec-studio:onboarded', '1');
      } catch { /* noop */ }
    });
  });

  test('creates a collection via the sidebar action button', async ({ page }) => {
    const state = await mountFakeBackend(page, []);
    await page.goto('/collections');

    // Click the + button in the sidebar Collections section.
    await page.locator('[data-tour="collection-actions"] .zv-sidebar__action-btn').first().click();

    // Fill the dialog form.
    await expect(page.getByTestId('zv-create-name')).toBeVisible();
    await page.getByTestId('zv-create-name').fill('smoke_new');
    await page.getByTestId('zv-create-path').fill('/tmp/smoke_new');
    await page.getByTestId('zv-create-submit').click();

    // The collection should appear in the sidebar after creation.
    await expect(page.locator('.zv-sidebar__item-name', { hasText: 'smoke_new' })).toBeVisible();
    expect(state.collections.has('smoke_new')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spotlight tour (guide)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Spotlight Tour', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('zvec-studio:onboarded', '1');
      } catch { /* noop */ }
    });
  });

  test('opens the spotlight tour from the sidebar guide button', async ({ page }) => {
    await mountFakeBackend(page, [
      { name: 'tour_col', path: '/tmp/tour_col' },
    ]);
    await page.goto('/collections/tour_col?path=%2Ftmp%2Ftour_col');

    // Wait for page to settle with sidebar visible.
    await expect(page.getByTestId('app-shell')).toBeVisible();

    await page.getByTestId('zv-sidebar-guide').click();
    await expect(page.getByTestId('zv-tour')).toBeVisible();

    // Skip dismisses.
    await page.getByTestId('zv-tour-skip').click();
    await expect(page.getByTestId('zv-tour')).toBeHidden();
  });
});
