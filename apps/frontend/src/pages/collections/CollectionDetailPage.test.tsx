/**
 * CollectionDetailPage unit tests.
 *
 * Drives the new tab-based detail page (Overview / Query / Data) through an
 * injected fake ApiClient. Covers:
 * - loading state,
 * - success: overview tab with stats, collection info, schema DDL, maintenance,
 * - tab switching,
 * - error with retry,
 * - destroy flow (confirmation gate, navigates home).
 */
import type { JSX } from 'react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import type { CollectionSummary } from '@/features/collections';
import { CollectionDetailPage } from './CollectionDetailPage';

interface FakeCollection {
  readonly summary: CollectionSummary;
}

interface FakeState {
  collections: Map<string, FakeCollection>;
  recent?: Array<{ name?: string | null; path: string }>;
  getError?: UserFacingError;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeSummary(name = 'demo'): CollectionSummary {
  return {
    name,
    path: `/tmp/${name}`,
    schema: {
      name,
      vectors: [
        {
          name: 'embedding',
          dataType: 'VECTOR_FP32',
          dimension: 768,
          indexParam: { indexType: 'HNSW', metric: 'COSINE', params: { M: 16 } },
        },
      ],
      fields: [
        { name: 'id', dataType: 'INT64', nullable: false },
        { name: 'title', dataType: 'STRING', nullable: false },
      ],
    },
    stats: { documentCount: 42, indexState: 'ready', storageBytes: 2048 },
  };
}

function fakeError(code: string): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status: 500,
    traceId: null,
    severity: 'error',
  };
}

function makeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (path === '/collections/recent' && method === 'GET') {
        return { items: state.recent ?? [] } as unknown as T;
      }
      if (path.startsWith('/collections/') && method === 'GET') {
        if (state.getError) throw new ApiError(state.getError);
        const [resource] = path.split('?');
        const name = decodeURIComponent(resource.slice('/collections/'.length));
        const record = state.collections.get(name);
        if (!record) throw new ApiError(fakeError('COLLECTION_NOT_FOUND'));
        return record.summary as unknown as T;
      }
      if (path === '/collections/open' && method === 'POST') {
        const body = opts?.body as { path: string };
        const name = body.path.split('/').pop() ?? 'opened';
        const summary = fakeSummary(name);
        state.collections.set(name, { summary: { ...summary, path: body.path } });
        state.getError = undefined;
        return state.collections.get(name)!.summary as unknown as T;
      }
      if (path.endsWith(':flush') && method === 'POST') {
        return { name: 'ok', performed: true } as unknown as T;
      }
      if (path.endsWith(':optimize') && method === 'POST') {
        return { name: 'ok', performed: true } as unknown as T;
      }
      if (path.endsWith(':destroy') && method === 'POST') {
        const name = decodeURIComponent(
          path.slice('/collections/'.length, path.length - ':destroy'.length),
        );
        state.collections.delete(name);
        return undefined as unknown as T;
      }
      if (path.endsWith('/documents:browse') && method === 'POST') {
        return { items: [], truncated: false } as unknown as T;
      }
      if (path.startsWith('/collections/') && method === 'DELETE') {
        return undefined as unknown as T;
      }
      if (method === 'GET' && (path === '/ai/rerankers' || path === '/ai/embeddings')) {
        return { items: [] } as unknown as T;
      }
      if (path === '/fs/reveal' && method === 'POST') {
        return undefined as unknown as T;
      }
      return { items: [] } as unknown as T;
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderDetail(name: string, apiClient: ApiClient) {
  function CollectionsLanding(): JSX.Element {
    return <div data-testid="collections-page">Collections List</div>;
  }
  return renderWithProviders(
    <Routes>
      <Route path="/collections" element={<CollectionsLanding />} />
      <Route path="/collections/:name" element={<CollectionDetailPage />} />
    </Routes>,
    {
      apiClient,
      queryClient: makeQueryClient(),
      initialEntries: [`/collections/${encodeURIComponent(name)}`],
    },
  );
}

function installMemorySessionStorage(): void {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    key: (index) => Array.from(store.keys())[index] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: fake,
  });
}

describe('CollectionDetailPage', () => {
  beforeEach(() => {
    installMemorySessionStorage();
  });

  it('renders overview tab with collection info and schema', async () => {
    const state: FakeState = {
      collections: new Map([['demo', { summary: fakeSummary('demo') }]]),
      calls: [],
    };
    renderDetail('demo', makeApiClient(state));

    expect(await screen.findByText(/\/tmp\/demo/)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();

    const vectors = screen.getByTestId('zv-collection-detail-vectors');
    expect(within(vectors).getByText('embedding')).toBeInTheDocument();
    expect(within(vectors).getByText('VECTOR_FP32')).toBeInTheDocument();
  });

  it('switches tabs', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      collections: new Map([['demo', { summary: fakeSummary('demo') }]]),
      calls: [],
    };
    renderDetail('demo', makeApiClient(state));

    await screen.findByText(/\/tmp\/demo/);

    await user.click(screen.getByText('Query'));
    expect(screen.getByText('Queries')).toBeInTheDocument();
    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');

    await user.click(screen.getByTestId('zv-detail-tab-browse'));
    expect(screen.getByText(/42 docs/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-detail-tab-query'));
    expect(screen.getByPlaceholderText(/\[0\.1/)).toHaveValue('[0.1, 0.2, 0.3, 0.4]');

    await user.click(screen.getByText('Write'));
    expect(screen.getByText('Insert')).toBeInTheDocument();

    await user.click(screen.getByText('Overview'));
    expect(screen.getByText('Vector fields')).toBeInTheDocument();
  });

  it('shows error state and retries on failure', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      collections: new Map([['demo', { summary: fakeSummary('demo') }]]),
      getError: fakeError('INTERNAL_ERROR'),
      calls: [],
    };
    const client = makeApiClient(state);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    renderDetail('demo', client);

    expect(await screen.findByText(/Failed to load/)).toBeInTheDocument();

    state.getError = undefined;
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/\/tmp\/demo/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('auto-opens a recently used collection when detail lookup returns 404', async () => {
    const state: FakeState = {
      collections: new Map(),
      recent: [{ name: 'closed', path: '/tmp/closed' }],
      getError: { ...fakeError('COLLECTION_NOT_FOUND'), status: 404 },
      calls: [],
    };
    renderDetail('closed', makeApiClient(state));

    expect(await screen.findByText(/\/tmp\/closed/)).toBeInTheDocument();
    expect(state.calls).toContainEqual({
      method: 'POST',
      path: '/collections/open',
      body: { path: '/tmp/closed' },
    });
  });

  it('destroy is gated by typing the Collection name and navigates to /collections', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      collections: new Map([['demo', { summary: fakeSummary('demo') }]]),
      calls: [],
    };
    renderDetail('demo', makeApiClient(state));
    await screen.findByText(/\/tmp\/demo/);

    // Click the Destroy button to open confirmation dialog
    const openBtn = screen.getByRole('button', { name: /destroy/i });
    await user.click(openBtn);

    // Inside dialog: confirm button should be disabled until name is typed
    const confirmBtns = screen.getAllByRole('button', { name: /destroy/i });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    expect(confirmBtn).toBeDisabled();

    const confirmInput = screen.getByPlaceholderText('demo');
    await user.type(confirmInput, 'demo');
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    expect(await screen.findByTestId('collections-page')).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'POST' && c.path.endsWith(':destroy'))).toBe(true);
  });

  it('does not refetch detail after destroy (removeQueries, not invalidate)', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      collections: new Map([['demo', { summary: fakeSummary('demo') }]]),
      calls: [],
    };
    renderDetail('demo', makeApiClient(state));
    await screen.findByText(/\/tmp\/demo/);

    // Clear call log before destroy
    state.calls.length = 0;

    const openBtn = screen.getByRole('button', { name: /destroy/i });
    await user.click(openBtn);
    const confirmBtns = screen.getAllByRole('button', { name: /destroy/i });
    const confirmBtn = confirmBtns[confirmBtns.length - 1];
    const confirmInput = screen.getByPlaceholderText('demo');
    await user.type(confirmInput, 'demo');
    await user.click(confirmBtn);

    expect(await screen.findByTestId('collections-page')).toBeInTheDocument();

    // After destroy, no GET to the destroyed collection should have been issued
    const getAfterDestroy = state.calls.filter(
      (c) => c.method === 'GET' && c.path.includes('/collections/demo'),
    );
    expect(getAfterDestroy).toHaveLength(0);
  });
});
