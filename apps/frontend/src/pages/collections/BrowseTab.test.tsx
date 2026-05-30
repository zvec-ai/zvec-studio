/**
 * BrowseTab unit tests.
 *
 * Uses an injected fake ``ApiClient`` to exercise filter browse, ID lookup,
 * mode switching, empty state, and the truncated indicator.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { BrowseTab } from './BrowseTab';

type DocRecord = Record<string, unknown>;

interface FakeBrowseState {
  docs: DocRecord[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeDocs(count: number): DocRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `doc-${i + 1}`,
    title: `Item ${i + 1}`,
    score: (i + 1) * 10,
  }));
}

function makeApiClient(state: FakeBrowseState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });

      if (method === 'POST' && /\/documents:browse$/.test(path)) {
        const body = (opts!.body ?? {}) as {
          filter?: string | null;
          limit?: number;
          includeVector?: boolean;
        };
        const limit = body.limit ?? 50;
        const page = state.docs.slice(0, limit);
        const truncated = state.docs.length > page.length;
        return { items: page, truncated } as unknown as T;
      }

      const docMatch = path.match(/\/documents\/([^?/]+)$/);
      if (docMatch && method === 'GET') {
        const id = decodeURIComponent(docMatch[1]);
        const doc = state.docs.find((d) => String(d.id) === id);
        if (!doc) throw new Error('DOCUMENT_NOT_FOUND');
        return doc as unknown as T;
      }

      if (method === 'GET' && path === '/ai/embeddings') {
        return { items: [] } as unknown as T;
      }
      if (method === 'GET' && path === '/ai/rerankers') {
        return { items: [] } as unknown as T;
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

const COLLECTION = {
  name: 'demo',
  path: '/tmp/demo',
  schema: {
    name: 'demo',
    vectors: [
      {
        name: 'embedding',
        dataType: 'VECTOR_FP32' as const,
        dimension: 4,
        indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
      },
    ],
    fields: [
      { name: 'title', dataType: 'STRING', nullable: false },
      { name: 'score', dataType: 'INT64', nullable: false },
    ],
  },
  stats: { documentCount: 0, indexState: 'none' as const, storageBytes: 0 },
};

function renderTab(
  state: FakeBrowseState,
  overrides?: { stats?: Partial<typeof COLLECTION.stats>; collection?: Record<string, unknown> },
) {
  const col = {
    ...COLLECTION,
    ...(overrides?.collection ?? {}),
    stats: { ...COLLECTION.stats, ...(overrides?.stats ?? {}) },
  };
  return renderWithProviders(
    <BrowseTab collection={col as any} />,
    { apiClient: makeApiClient(state), queryClient: makeQueryClient() },
  );
}

describe('BrowseTab', () => {
  it('renders in filter mode with document count', async () => {
    const state: FakeBrowseState = { docs: fakeDocs(3), calls: [] };
    renderTab(state, { stats: { documentCount: 3 } });

    // The two mode toggle buttons
    expect(screen.getByText('Filter')).toBeInTheDocument();
    expect(screen.getByText('ID')).toBeInTheDocument();

    await waitFor(() => {
      expect(state.calls.some((c) => c.path.includes(':browse'))).toBe(true);
    });
  });

  it('displays browse results in a table', async () => {
    const state: FakeBrowseState = { docs: fakeDocs(3), calls: [] };
    renderTab(state);

    expect(await screen.findByText('doc-1')).toBeInTheDocument();
    expect(screen.getByText('doc-2')).toBeInTheDocument();
    expect(screen.getByText('doc-3')).toBeInTheDocument();
    expect(screen.queryByText('"doc-1"')).not.toBeInTheDocument();
    expect(screen.getByText('"Item 1"')).toBeInTheDocument();
  });

  it('renders sparse vector keys without JSON quotes', async () => {
    const state: FakeBrowseState = {
      docs: [{ id: 'doc-1', title: 'Sparse', embedding: { '42': 1, '314': 0.5 } }],
      calls: [],
    };
    renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            {
              name: 'embedding',
              dataType: 'SPARSE_VECTOR_FP32' as const,
              dimension: 768,
              indexParam: { indexType: 'HNSW', metric: 'IP', params: {} },
            },
          ],
        },
      },
    });

    expect(await screen.findByText('{42: 1.0, 314: 0.5}')).toBeInTheDocument();
    expect(screen.queryByText('{"42":1,"314":0.5}')).not.toBeInTheDocument();
  });

  it('shows empty state when no documents exist', async () => {
    const state: FakeBrowseState = { docs: [], calls: [] };
    renderTab(state);

    // Wait for browse to fire, then the "No documents found" message
    expect(await screen.findByText(/no documents/i)).toBeInTheDocument();
  });

  it('shows truncated indicator when server caps the result', async () => {
    const docs = fakeDocs(100);
    const state: FakeBrowseState = { docs, calls: [] };
    renderTab(state);

    await screen.findByText('doc-1');
    expect(screen.getByText(/truncat/i)).toBeInTheDocument();
  });

  it('switches to ID mode and renders the ID input', async () => {
    const user = userEvent.setup();
    const state: FakeBrowseState = { docs: fakeDocs(3), calls: [] };
    renderTab(state);

    await screen.findByText('doc-1');
    await user.click(screen.getByText('ID'));

    // The ID-mode input placeholder mentions doc IDs
    const idInput = screen.getByPlaceholderText(/doc_01/);
    expect(idInput).toBeInTheDocument();
  });

  it('fetches document by ID in ID mode', async () => {
    const user = userEvent.setup();
    const state: FakeBrowseState = { docs: fakeDocs(5), calls: [] };
    renderTab(state);

    await screen.findByText('doc-1');
    await user.click(screen.getByText('ID'));

    const idInput = screen.getByPlaceholderText(/doc_01/);
    await user.type(idInput, 'doc-3');

    // The Fetch button
    await user.click(screen.getByRole('button', { name: /fetch/i }));

    await waitFor(() => {
      expect(
        state.calls.some((c) => c.method === 'GET' && c.path.includes('/documents/doc-3')),
      ).toBe(true);
    });
  });

  it('applies filter via the FilterBuilder Browse button', async () => {
    const user = userEvent.setup();
    const state: FakeBrowseState = { docs: fakeDocs(5), calls: [] };
    renderTab(state);

    await screen.findByText('doc-1');

    // Type filter in the SQL input
    const filterInput = screen.getByPlaceholderText(/category = 'news'/);
    await user.type(filterInput, "title = 'test'");

    // Click the Browse button (FilterBuilder's apply button)
    await user.click(screen.getByRole('button', { name: /browse/i }));

    await waitFor(() => {
      const browseCalls = state.calls.filter(
        (c) => c.method === 'POST' && c.path.includes(':browse'),
      );
      const hasFilter = browseCalls.some(
        (c) => (c.body as any)?.filter === "title = 'test'",
      );
      expect(hasFilter).toBe(true);
    });
  });
});
