/**
 * QueryTab unit tests.
 *
 * Uses a fake ApiClient to exercise the vector search form: mode switching,
 * search execution, results display, and embedding/reranker integration.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { QueryTab } from './QueryTab';

interface FakeState {
  searchResults: Array<{ id: string; score: number; fields: Record<string, unknown> }>;
  embeddings: Array<{ name: string; description: string | null; config: Record<string, unknown> }>;
  rerankers: Array<{ name: string; description: string | null; config: Record<string, unknown> }>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });

      if (method === 'GET' && path === '/ai/embeddings') {
        return { items: state.embeddings } as unknown as T;
      }
      if (method === 'GET' && path === '/ai/rerankers') {
        return { items: state.rerankers } as unknown as T;
      }
      if (method === 'POST' && path.includes('/searches')) {
        return {
          results: state.searchResults,
          took_ms: 1.5,
        } as unknown as T;
      }
      if (method === 'POST' && path.includes(':embed')) {
        return {
          kind: 'dense',
          vectors: [[0.1, 0.2, 0.3, 0.4]],
        } as unknown as T;
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
  stats: { documentCount: 100, indexState: 'ready' as const, storageBytes: 1024 },
};

function renderTab(state: FakeState, overrides?: { collection?: Partial<typeof COLLECTION> }) {
  const col = { ...COLLECTION, ...(overrides?.collection ?? {}) };
  return renderWithProviders(
    <QueryTab collection={col as any} />,
    { apiClient: makeApiClient(state), queryClient: makeQueryClient() },
  );
}

describe('QueryTab', () => {
  it('renders the query form with vector field card', async () => {
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    expect(screen.getByText('embedding')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument();
  });

  it('shows Vector and By ID mode tabs', () => {
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    expect(screen.getByText(/^vector$/i)).toBeInTheDocument();
    expect(screen.getByText(/by id/i)).toBeInTheDocument();
  });

  it('switches to ID mode and shows ID input', async () => {
    const user = userEvent.setup();
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    await user.click(screen.getByText(/by id/i));
    expect(screen.getByPlaceholderText(/document id/i)).toBeInTheDocument();
  });

  it('executes a vector search and shows results', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [
        { id: 'doc-1', score: 0.95, fields: { title: 'First' } },
        { id: 'doc-2', score: 0.85, fields: { title: 'Second' } },
      ],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state);

    const vectorInput: HTMLTextAreaElement = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    // userEvent.type treats "[" as keyboard modifier — use paste for JSON
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');

    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-1')).toBeInTheDocument();
      expect(screen.getByText('doc-2')).toBeInTheDocument();
    });

    expect(screen.getByText('0.9500')).toBeInTheDocument();
    expect(screen.getByText('0.8500')).toBeInTheDocument();
  });

  it('shows results meta with hit count and timing', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [
        { id: 'doc-1', score: 0.9, fields: {} },
      ],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state);

    const vectorInput = screen.getByPlaceholderText(/\[0\.1/);
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 hits in 1\.5 ms/i)).toBeInTheDocument();
    });
  });

  it('does not submit when vector input is empty', async () => {
    const user = userEvent.setup();
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    await user.click(screen.getByRole('button', { name: /search/i }));

    // No search call was made
    expect(state.calls.filter((c) => c.path.includes('/searches'))).toHaveLength(0);
  });

  it('populates embedding dropdown from API', async () => {
    const state: FakeState = {
      searchResults: [],
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense', dimension: 4 } },
      ],
      rerankers: [],
      calls: [],
    };
    renderTab(state);

    await waitFor(() => {
      expect(screen.getByText(/local-dense/)).toBeInTheDocument();
    });
  });

  it('shows HNSW query params section', () => {
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    expect(screen.getByText(/query parameters/i)).toBeInTheDocument();
  });
});
