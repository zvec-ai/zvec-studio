/**
 * SearchPanel unit tests.
 *
 * Drives the panel through an injected fake ``ApiClient`` so the search
 * mutation exercises the real transport path. Covers:
 * - initial empty state render,
 * - client-side validation (invalid JSON, dimension mismatch),
 * - happy path: results table + summary + drawer,
 * - history: push on success, apply re-fills the form, clear empties it,
 * - server-side failure surfaces a toast and keeps the prior results.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import type { CollectionSummary } from '@/features/collections';

import { SearchPanel } from './SearchPanel';

// Node's experimental builtin localStorage (auto-injected when running under
// Node 22+) ships without ``getItem``/``removeItem`` when no file path is
// configured. Replace it with a plain in-memory polyfill so the search
// history hook can read/write deterministically inside jsdom.
function installMemoryLocalStorage(): void {
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
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: fake,
  });
}

installMemoryLocalStorage();

interface FakeSearchState {
  /** Canned response next run() will return. */
  response?: {
    results: Array<{ id: unknown; score: number; fields: Record<string, unknown> }>;
    took_ms: number;
  };
  /** Throw this UserFacingError on the next request instead of returning. */
  error?: UserFacingError;
  /** Spy on every inbound request so tests can assert on the body shape. */
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeError(code: string, status = 400): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status,
    traceId: null,
    severity: 'warning',
  };
}

function makeApiClient(state: FakeSearchState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';
      // The SearchPanel's reranker dropdown lists registered rerankers and the
      // ``From text`` mode lists registered embeddings — return empty lists
      // silently and don't tally the requests, so existing assertions on
      // ``state.calls`` only see the search POST(s).
      if (method === 'GET' && (path === '/ai/rerankers' || path === '/ai/embeddings')) {
        return { items: [] } as unknown as T;
      }
      state.calls.push({ method, path, body: opts?.body });
      if (method === 'POST' && /\/collections\/[^/]+\/searches$/.test(path)) {
        if (state.error) throw new ApiError(state.error);
        const body = (state.response ?? {
          results: [],
          took_ms: 0,
        }) as unknown as T;
        return body;
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

/** Schema used by most tests: single 4-dim vector field. */
const DEFAULT_SCHEMA: CollectionSummary['schema'] = {
  name: 'demo',
  vectors: [
    {
      name: 'embedding',
      dataType: 'VECTOR_FP32',
      dimension: 4,
      indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
    },
  ],
  fields: [{ name: 'id', dataType: 'INT64', nullable: false }],
};

function renderPanel(state: FakeSearchState, schema = DEFAULT_SCHEMA) {
  return renderWithProviders(<SearchPanel collection="demo" schema={schema} />, {
    apiClient: makeApiClient(state),
    queryClient: makeQueryClient(),
  });
}

describe('SearchPanel', () => {
  beforeEach(() => {
    // Every test starts with a blank history so assertions are independent.
    installMemoryLocalStorage();
  });

  it('renders the form and empty state on mount', () => {
    const state: FakeSearchState = { calls: [] };
    renderPanel(state);

    expect(screen.getByTestId('zv-search-panel')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-vector')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-topk')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-submit')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-empty')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-history-empty')).toBeInTheDocument();
    // No request sent on first render.
    expect(state.calls).toHaveLength(0);
  });

  it('flags invalid JSON without calling the backend', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = { calls: [] };
    renderPanel(state);

    const textarea = screen.getByTestId('zv-search-vector');
    await user.clear(textarea);
    await user.type(textarea, 'not json');
    await user.click(screen.getByTestId('zv-search-submit'));

    expect(await screen.findByTestId('zv-search-vector-error')).toBeInTheDocument();
    expect(state.calls).toHaveLength(0);
  });

  it('flags a dimension mismatch before calling the backend', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = { calls: [] };
    renderPanel(state);

    const textarea = screen.getByTestId('zv-search-vector');
    await user.clear(textarea);
    // 3 dims for a 4-dim schema. Use ``fireEvent.change`` instead of
    // ``user.type`` so the JSON brackets are not interpreted as user-event
    // keyboard modifiers.
    fireEvent.change(textarea, { target: { value: '[0.1,0.2,0.3]' } });
    await user.click(screen.getByTestId('zv-search-submit'));

    const err = await screen.findByTestId('zv-search-vector-error');
    expect(err.textContent).toMatch(/4/);
    expect(err.textContent).toMatch(/3/);
    expect(state.calls).toHaveLength(0);
  });

  it('submits a search, renders results, summary, and opens the drawer', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = {
      calls: [],
      response: {
        results: [
          { id: 1, score: 0.99, fields: { title: 'alpha', price: 10 } },
          { id: 2, score: 0.95, fields: { title: 'beta', price: 12 } },
        ],
        took_ms: 2.5,
      },
    };
    renderPanel(state);

    await user.click(screen.getByTestId('zv-search-submit'));

    // Summary + 2 result rows.
    const summary = await screen.findByTestId('zv-search-summary');
    expect(summary.textContent).toMatch(/2/);
    expect(screen.getByTestId('zv-search-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('zv-search-row-2')).toBeInTheDocument();

    // Score cell shows the 4-digit score.
    const scores = screen.getAllByTestId('zv-search-score');
    expect(scores[0].textContent).toContain('0.9900');

    // Click a row → drawer opens with the full JSON.
    await user.click(screen.getByTestId('zv-search-row-1'));
    const drawer = await screen.findByTestId('zv-search-drawer-body');
    expect(drawer).toHaveTextContent('"id": 1');
    expect(drawer).toHaveTextContent('"title": "alpha"');

    // Request body sanity: vector length 4, topK is the default, filter / output null.
    const call = state.calls[0];
    expect(call.method).toBe('POST');
    expect(call.path).toContain('/collections/demo/searches');
    const body = call.body as { vector: number[]; topK: number };
    expect(body.vector).toHaveLength(4);
    expect(body.topK).toBe(10);
  });

  it('renders a no-hits message when the backend returns zero results', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = {
      calls: [],
      response: { results: [], took_ms: 1 },
    };
    renderPanel(state);

    await user.click(screen.getByTestId('zv-search-submit'));
    expect(await screen.findByTestId('zv-search-no-hits')).toBeInTheDocument();
  });

  it('appends to history, re-applies an entry, and clears it', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = {
      calls: [],
      response: {
        results: [{ id: 7, score: 0.8, fields: {} }],
        took_ms: 1,
      },
    };
    renderPanel(state);

    // Tune topK so the applied value is observable. ``fireEvent.change``
    // sets the controlled value directly so we don't have to deal with the
    // multi-keystroke clamping that ``user.type`` would trigger.
    const topk = screen.getByTestId('zv-search-topk') as HTMLInputElement;
    fireEvent.change(topk, { target: { value: '5' } });
    expect(topk.value).toBe('5');

    await user.click(screen.getByTestId('zv-search-submit'));
    await screen.findByTestId('zv-search-row-7');

    // History now has exactly one entry.
    const history = screen.getByTestId('zv-search-history');
    const items = within(history).getAllByRole('listitem');
    expect(items).toHaveLength(1);

    // Mutate topK then "Apply" the historical entry → it should revert to 5.
    fireEvent.change(topk, { target: { value: '20' } });
    expect(topk.value).toBe('20');

    const applyBtn = within(items[0]).getByRole('button', { name: /5/ });
    await user.click(applyBtn);
    expect(topk.value).toBe('5');

    // "Clear" wipes the list.
    await user.click(screen.getByTestId('zv-search-history-clear'));
    expect(screen.getByTestId('zv-search-history-empty')).toBeInTheDocument();
  });

  it('surfaces an ApiError via the toast and does not clobber prior results', async () => {
    const user = userEvent.setup();
    const state: FakeSearchState = {
      calls: [],
      response: {
        results: [{ id: 1, score: 0.5, fields: {} }],
        took_ms: 1,
      },
    };
    renderPanel(state);

    // First call succeeds → results visible.
    await user.click(screen.getByTestId('zv-search-submit'));
    await screen.findByTestId('zv-search-row-1');

    // Second call fails → a failure toast joins the stack; prior row stays.
    state.error = fakeError('INVALID_FILTER_EXPRESSION', 400);
    await user.click(screen.getByTestId('zv-search-submit'));

    const toasts = await screen.findAllByTestId('zv-toast');
    const texts = toasts.map((t) => t.textContent ?? '');
    expect(texts.some((s) => /filter expression is invalid/i.test(s))).toBe(true);
    expect(screen.getByTestId('zv-search-row-1')).toBeInTheDocument();
  });

  it('shows the vector field selector only when multiple vectors exist', async () => {
    const schema: CollectionSummary['schema'] = {
      ...DEFAULT_SCHEMA,
      vectors: [
        { name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4 },
        { name: 'sparse', dataType: 'VECTOR_FP32', dimension: 4 },
      ],
    };
    const state: FakeSearchState = { calls: [] };
    renderPanel(state, schema);

    expect(screen.getByTestId('zv-search-vector-field')).toBeInTheDocument();
  });
});
