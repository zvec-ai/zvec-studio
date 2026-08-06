/**
 * QueryTab unit tests.
 *
 * Uses a fake ApiClient to exercise the vector search form: mode switching,
 * search execution, results display, and embedding/reranker integration.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { QueryTab } from './QueryTab';

interface FakeState {
  searchResults: Array<{ id: string; score: number; fields: Record<string, unknown>; groupByValue?: string }>;
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
      if (method === 'POST' && path.includes('/ai/embeddings/bm25:embed')) {
        return {
          kind: 'sparse',
          vectors: [{ '42': 1, '314': 0.5 }],
        } as unknown as T;
      }
      if (method === 'POST' && path.includes(':embed')) {
        return {
          kind: 'dense',
          dimension: 4,
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

function renderTab(state: FakeState, overrides?: { collection?: Record<string, unknown> }) {
  const col = { ...COLLECTION, ...(overrides?.collection ?? {}) };
  return renderWithProviders(
    <QueryTab collection={col as any} />,
    { apiClient: makeApiClient(state), queryClient: makeQueryClient() },
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

function queryCards(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('.zv-vq-card'));
}

function queryCard(container: HTMLElement, index = 0): HTMLElement {
  const card = queryCards(container)[index];
  if (!card) throw new Error(`No query card found at index ${index}`);
  return card;
}

function selectWithOption(container: HTMLElement, optionValue: string): HTMLSelectElement {
  const select = Array.from(container.querySelectorAll('select.zv-form-select')).find((el) =>
    Array.from((el as HTMLSelectElement).options).some((option) => option.value === optionValue),
  );
  if (!select) throw new Error(`No select found with option ${optionValue}`);
  return select as HTMLSelectElement;
}

describe('QueryTab', () => {
  beforeEach(() => {
    installMemorySessionStorage();
  });

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

  it('submits group-by parameters and renders group values', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [
        { id: 'doc-1', score: 0.95, fields: { title: 'First' }, groupByValue: 'news' },
      ],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state);

    await user.selectOptions(screen.getByLabelText('Group by'), 'title');
    const groupsInput = screen.getByLabelText('Groups');
    fireEvent.change(groupsInput, { target: { value: '4' } });
    const perGroupInput = screen.getByLabelText('Top K / group');
    fireEvent.change(perGroupInput, { target: { value: '2' } });
    const vectorInput = screen.getByPlaceholderText(/\[0\.1/);
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => expect(screen.getByText('doc-1')).toBeInTheDocument());
    const body = state.calls.find((call) => call.path.includes('/searches'))!.body as any;
    expect(body).toMatchObject({
      groupByField: 'title',
      groupCount: 4,
      topKPerGroup: 2,
    });
    expect(screen.getByText('news')).toBeInTheDocument();
  });

  it('generates and submits a dense random vector from the field dimension', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-random', score: 0.91, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state);

    await user.click(screen.getByRole('button', { name: /random vector/i }));
    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    const vector = JSON.parse(vectorInput.value) as number[];
    expect(vector).toHaveLength(4);
    expect(vector.some((value) => value !== 0)).toBe(true);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);

    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-random')).toBeInTheDocument();
    });
    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((searchCall.body as any).queries[0].vector).toEqual(vector);
  });

  it('submits sparse vector objects without using schema dimension', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-sparse', score: 0.7, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            {
              name: 'sparse',
              dataType: 'SPARSE_VECTOR_FP32' as const,
              dimension: 768,
              indexParam: { indexType: 'HNSW', metric: 'IP', params: {} },
            },
          ],
        },
      },
    });

    expect(screen.getByText(/HNSW sparse/)).toBeInTheDocument();
    expect(screen.queryByText(/768d/)).not.toBeInTheDocument();

    const vectorInput: HTMLTextAreaElement = screen.getByPlaceholderText(/\{42/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('{42: 1.0, 314: 0.5}');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(state.calls.some((c) => c.path.includes('/searches'))).toBe(true);
    });
    const call = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((call.body as any).queries[0].vector).toEqual({ '42': 1, '314': 0.5 });
  });

  it('generates and submits a sparse random vector with numeric weights', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-sparse-random', score: 0.7, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            {
              name: 'sparse',
              dataType: 'SPARSE_VECTOR_FP32' as const,
              dimension: 768,
              indexParam: { indexType: 'HNSW', metric: 'IP', params: {} },
            },
          ],
        },
      },
    });

    await user.click(screen.getByRole('button', { name: /random vector/i }));
    const vectorInput = screen.getByPlaceholderText(/\{42/) as HTMLTextAreaElement;
    expect(vectorInput.value).toMatch(/^\{\d+: /);
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-sparse-random')).toBeInTheDocument();
    });
    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    const vector = (searchCall.body as any).queries[0].vector as Record<string, number>;
    expect(Object.keys(vector)).toHaveLength(6);
    expect(Object.entries(vector).every(([key, value]) => /^\d+$/.test(key) && typeof value === 'number')).toBe(true);
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

  it('restores query state after unmounting and remounting', async () => {
    const user = userEvent.setup();
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    const view = renderTab(state);

    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');

    const topKInput = view.container.querySelector('.zv-query-inline-row input[type="number"]') as HTMLInputElement;
    fireEvent.change(topKInput, { target: { value: '7' } });

    await waitFor(() => {
      expect(window.sessionStorage.getItem('zvec-studio.query-tab./tmp/demo.demo')).toContain('[0.1, 0.2, 0.3, 0.4]');
    });

    view.unmount();
    const remounted = renderTab(state);

    expect(screen.getByPlaceholderText(/\[0\.1/)).toHaveValue('[0.1, 0.2, 0.3, 0.4]');
    expect(remounted.container.querySelector('.zv-query-inline-row input[type="number"]')).toHaveValue(7);
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

  it('submits a dense embedding query without reranker for a single query', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-dense', score: 0.92, fields: { title: 'Dense' } }],
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense', dimension: 4 } },
      ],
      rerankers: [
        { name: 'rrf', description: null, config: { type: 'rrf' } },
      ],
      calls: [],
    };
    const { container } = renderTab(state);

    await waitFor(() => {
      expect(screen.getByText(/local-dense/)).toBeInTheDocument();
    });

    expect(screen.queryByText(/^Reranker$/i)).not.toBeInTheDocument();
    const card = queryCard(container);
    await user.selectOptions(within(card).getByRole('combobox'), 'local-dense');

    const textInput = screen.getByPlaceholderText(/enter query text/i);
    await user.click(textInput);
    await user.paste('semantic dense query');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-dense')).toBeInTheDocument();
    });

    const embedCall = state.calls.find((c) => c.path.includes('/ai/embeddings/local-dense:embed'));
    expect(embedCall?.body).toEqual({
      texts: ['semantic dense query'],
      isQuery: true,
    });

    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((searchCall.body as any).queries).toEqual([
      {
        field: 'embedding',
        vector: [0.1, 0.2, 0.3, 0.4],
        param: {
          type: 'HNSW',
          ef: 300,
          radius: 0,
          isLinear: false,
          isUsingRefiner: false,
        },
      },
    ]);
    expect((searchCall.body as any).rerankerName).toBeNull();
  });

  it('ignores a persisted reranker when only one query is submitted', async () => {
    const user = userEvent.setup();
    window.sessionStorage.setItem(
      'zvec-studio.query-tab./tmp/demo.demo',
      JSON.stringify({
        queries: [
          {
            field: 'embedding',
            routeType: 'vector',
            mode: 'vector',
            vectorText: '[0.1, 0.2, 0.3, 0.4]',
          },
        ],
        rerankerName: 'rrf',
      }),
    );
    const state: FakeState = {
      searchResults: [{ id: 'doc-single', score: 0.91, fields: {} }],
      embeddings: [],
      rerankers: [{ name: 'rrf', description: null, config: { type: 'rrf' } }],
      calls: [],
    };
    renderTab(state);

    expect(screen.queryByText(/^Reranker$/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-single')).toBeInTheDocument();
    });
    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((searchCall.body as any).rerankerName).toBeNull();
  });

  it('filters sparse embeddings and submits sparse embedding output', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-sparse', score: 0.88, fields: {} }],
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense', dimension: 4 } },
        { name: 'bm25', description: null, config: { type: 'bm25' } },
      ],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state, {
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

    await waitFor(() => {
      expect(screen.getByText(/bm25/)).toBeInTheDocument();
    });

    const embeddingSelect = within(queryCard(container)).getByRole('combobox') as HTMLSelectElement;
    expect(Array.from(embeddingSelect.options).map((o) => o.value)).toEqual(['', 'bm25']);

    await user.selectOptions(embeddingSelect, 'bm25');
    const textInput = screen.getByPlaceholderText(/enter query text/i);
    await user.click(textInput);
    await user.paste('sparse query text');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-sparse')).toBeInTheDocument();
    });

    const embedCall = state.calls.find((c) => c.path.includes('/ai/embeddings/bm25:embed'));
    expect(embedCall?.body).toEqual({
      texts: ['sparse query text'],
      isQuery: true,
    });

    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((searchCall.body as any).queries[0].vector).toEqual({ '42': 1, '314': 0.5 });
  });

  it('submits multiple vector queries with a reranker', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-reranked', score: 0.99, fields: {} }],
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense', dimension: 4 } },
      ],
      rerankers: [
        { name: 'weighted', description: null, config: { type: 'weighted', weights: [0.7, 0.3] } },
      ],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            ...COLLECTION.schema.vectors,
            {
              name: 'embedding_alt',
              dataType: 'VECTOR_FP32' as const,
              dimension: 4,
              indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
            },
          ],
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/local-dense/)).toBeInTheDocument();
    });

    const addQueryButton = screen.getByRole('button', { name: /add query/i });
    expect(addQueryButton).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/select column/i), 'vector:embedding_alt');
    expect(addQueryButton).toBeEnabled();
    await user.click(addQueryButton);
    await waitFor(() => {
      expect(container.querySelectorAll('.zv-vq-card')).toHaveLength(2);
    });

    await user.selectOptions(within(queryCard(container, 0)).getByRole('combobox'), 'local-dense');
    await user.selectOptions(within(queryCard(container, 1)).getByRole('combobox'), 'local-dense');
    await user.selectOptions(selectWithOption(container, 'weighted'), 'weighted');

    const textInputs = screen.getAllByPlaceholderText(/enter query text/i);
    await user.click(textInputs[0]);
    await user.paste('primary dense query');
    await user.click(textInputs[1]);
    await user.paste('secondary dense query');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-reranked')).toBeInTheDocument();
    });

    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    const body = searchCall.body as any;
    expect(body.rerankerName).toBe('weighted');
    expect(body.queries).toHaveLength(2);
    expect(body.queries.map((q: any) => q.field)).toEqual(['embedding', 'embedding_alt']);
    expect(body.queries.every((q: any) => Array.isArray(q.vector) && q.vector.length === 4)).toBe(true);
    expect(body.queries.every((q: any) => q.param?.type === 'HNSW')).toBe(true);
  });

  it('defaults the reranker to rrf when a query becomes multiquery', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-rrf', score: 0.99, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            ...COLLECTION.schema.vectors,
            {
              name: 'embedding_alt',
              dataType: 'VECTOR_FP32' as const,
              dimension: 4,
              indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
            },
          ],
        },
      },
    });

    expect(screen.queryByText(/^Reranker$/i)).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/select column/i), 'vector:embedding_alt');
    await user.click(screen.getByRole('button', { name: /add query/i }));

    await waitFor(() => {
      expect(selectWithOption(container, 'rrf')).toHaveValue('rrf');
    });

    const vectorInputs = screen.getAllByPlaceholderText(/\[0\.1/);
    await user.click(vectorInputs[0]);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    await user.click(vectorInputs[1]);
    await user.paste('[0.4, 0.3, 0.2, 0.1]');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-rrf')).toBeInTheDocument();
    });
    expect((state.calls.find((c) => c.path.includes('/searches'))!.body as any).rerankerName).toBe('rrf');
  });

  it('hides and clears the reranker when multiquery is reduced to one query', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-single-after-remove', score: 0.8, fields: {} }],
      embeddings: [],
      rerankers: [{ name: 'rrf', description: null, config: { type: 'rrf' } }],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            ...COLLECTION.schema.vectors,
            {
              name: 'embedding_alt',
              dataType: 'VECTOR_FP32' as const,
              dimension: 4,
              indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
            },
          ],
        },
      },
    });

    await user.selectOptions(screen.getByLabelText(/select column/i), 'vector:embedding_alt');
    await user.click(screen.getByRole('button', { name: /add query/i }));
    await waitFor(() => {
      expect(selectWithOption(container, 'rrf')).toHaveValue('rrf');
    });

    await user.click(within(queryCard(container, 1)).getByRole('button', { name: /remove/i }));
    await waitFor(() => {
      expect(container.querySelectorAll('.zv-vq-card')).toHaveLength(1);
    });
    expect(screen.queryByText(/^Reranker$/i)).not.toBeInTheDocument();

    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-single-after-remove')).toBeInTheDocument();
    });
    const body = state.calls.find((c) => c.path.includes('/searches'))!.body as any;
    expect(body.rerankerName).toBeNull();
  });

  it('submits an FTS match-string query with default operator', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-fts', score: 1.2, fields: { title: 'FTS' } }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          name: 'demo',
          vectors: [],
          fields: [
            {
              name: 'content',
              dataType: 'STRING' as const,
              nullable: false,
              indexParam: { indexType: 'FTS' },
            },
          ],
        },
      },
    });

    expect(screen.getAllByText('content').length).toBeGreaterThan(0);
    expect(screen.getByText(/STRING FTS/i)).toBeInTheDocument();
    const ftsInput = screen.getByPlaceholderText(/search words/i);
    await user.click(ftsInput);
    await user.paste('hello world');
    await user.selectOptions(selectWithOption(container, 'AND'), 'AND');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-fts')).toBeInTheDocument();
    });
    const searchCall = state.calls.find((c) => c.path.includes('/searches'))!;
    expect((searchCall.body as any).queries).toEqual([
      {
        field: 'content',
        fts: { matchString: 'hello world' },
        param: { type: 'FTS', defaultOperator: 'AND' },
      },
    ]);
  });

  it('submits a hybrid FTS and vector query with reranker', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-hybrid', score: 0.99, fields: {} }],
      embeddings: [],
      rerankers: [{ name: 'rrf', description: null, config: { type: 'rrf' } }],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          fields: [
            ...COLLECTION.schema.fields,
            {
              name: 'content',
              dataType: 'STRING' as const,
              nullable: false,
              indexParam: { indexType: 'FTS' },
            },
          ],
        },
      },
    });

    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    await user.selectOptions(screen.getByLabelText(/select column/i), 'fts:content');
    await user.click(screen.getByRole('button', { name: /add query/i }));
    await user.click(screen.getByPlaceholderText(/search words/i));
    await user.paste('hybrid text');
    await user.selectOptions(selectWithOption(container, 'rrf'), 'rrf');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-hybrid')).toBeInTheDocument();
    });
    const body = state.calls.find((c) => c.path.includes('/searches'))!.body as any;
    expect(body.rerankerName).toBe('rrf');
    expect(body.queries).toEqual([
      {
        field: 'embedding',
        vector: [0.1, 0.2, 0.3, 0.4],
        param: {
          type: 'HNSW',
          ef: 300,
          radius: 0,
          isLinear: false,
          isUsingRefiner: false,
        },
      },
      {
        field: 'content',
        fts: { matchString: 'hybrid text' },
        param: { type: 'FTS', defaultOperator: 'OR' },
      },
    ]);
  });

  it('submits HNSW query params from stateful controls', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-hnsw', score: 0.7, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state);
    const card = container.querySelector('.zv-vq-card') as HTMLElement;
    const vectorInput = screen.getByPlaceholderText(/\[0\.1/) as HTMLTextAreaElement;
    await user.click(vectorInput);
    await user.paste('[0.1, 0.2, 0.3, 0.4]');

    const spinboxes = within(card).getAllByRole('spinbutton');
    await user.clear(spinboxes[0]);
    await user.type(spinboxes[0], '77');
    await user.clear(spinboxes[1]);
    await user.type(spinboxes[1], '1.5');
    const checkboxes = within(card).getAllByRole('checkbox');
    await user.click(checkboxes[0]);
    await user.click(checkboxes[1]);
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-hnsw')).toBeInTheDocument();
    });
    const param = ((state.calls.find((c) => c.path.includes('/searches'))!.body as any).queries[0] as any).param;
    expect(param).toEqual({
      type: 'HNSW',
      ef: 77,
      radius: 1.5,
      isLinear: true,
      isUsingRefiner: true,
    });
  });

  it('submits IVF query params', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-ivf', score: 0.7, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            {
              name: 'embedding',
              dataType: 'VECTOR_FP32' as const,
              dimension: 4,
              indexParam: { indexType: 'IVF', metric: 'COSINE', params: {} },
            },
          ],
        },
      },
    });
    await user.click(screen.getByPlaceholderText(/\[0\.1/));
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    const nprobe = within(container.querySelector('.zv-vq-card') as HTMLElement).getByRole('spinbutton');
    await user.clear(nprobe);
    await user.type(nprobe, '32');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-ivf')).toBeInTheDocument();
    });
    expect(((state.calls.find((c) => c.path.includes('/searches'))!.body as any).queries[0] as any).param).toEqual({
      type: 'IVF',
      nprobe: 32,
    });
  });

  it('submits DiskANN query params', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      searchResults: [{ id: 'doc-diskann', score: 0.7, fields: {} }],
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    const { container } = renderTab(state, {
      collection: {
        schema: {
          ...COLLECTION.schema,
          vectors: [
            {
              name: 'embedding',
              dataType: 'VECTOR_FP32' as const,
              dimension: 4,
              indexParam: { indexType: 'DISKANN', metric: 'COSINE', params: {} },
            },
          ],
        },
      },
    });
    await user.click(screen.getByPlaceholderText(/\[0\.1/));
    await user.paste('[0.1, 0.2, 0.3, 0.4]');
    const listSize = within(container.querySelector('.zv-vq-card') as HTMLElement).getByRole('spinbutton');
    await user.clear(listSize);
    await user.type(listSize, '450');
    await user.click(screen.getByRole('button', { name: /search/i }));

    await waitFor(() => {
      expect(screen.getByText('doc-diskann')).toBeInTheDocument();
    });
    expect(((state.calls.find((c) => c.path.includes('/searches'))!.body as any).queries[0] as any).param).toEqual({
      type: 'DISKANN',
      listSize: 450,
    });
  });

  it('shows HNSW query params section', () => {
    const state: FakeState = { searchResults: [], embeddings: [], rerankers: [], calls: [] };
    renderTab(state);

    expect(screen.getByText(/query parameters/i)).toBeInTheDocument();
  });
});
