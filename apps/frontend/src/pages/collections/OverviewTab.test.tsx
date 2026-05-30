/**
 * OverviewTab unit tests.
 *
 * Uses a fake ApiClient to exercise stat display, schema glance tags,
 * optimize action, and the destroy confirmation dialog.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { OverviewTab } from './OverviewTab';

interface FakeState {
  optimizeCalled: boolean;
  destroyCalled: string | null;
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

      if (method === 'POST' && path.includes(':optimize')) {
        state.optimizeCalled = true;
        return { ok: true } as unknown as T;
      }
      if (method === 'POST' && path.includes(':destroy')) {
        const name = path.split('/collections/')[1]?.replace(':destroy', '') ?? '';
        state.destroyCalled = decodeURIComponent(name);
        return undefined as unknown as T;
      }
      if (method === 'POST' && path === '/fs/reveal') {
        return undefined as unknown as T;
      }
      if (method === 'GET' && path === '/collections') {
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
        dimension: 128,
        indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
      },
    ],
    fields: [
      { name: 'title', dataType: 'STRING', nullable: false },
      { name: 'score', dataType: 'INT64', nullable: false },
    ],
  },
  stats: {
    documentCount: 1234,
    indexState: 'ready' as const,
    storageBytes: 5242880,
  },
};

function renderTab(
  state: FakeState,
  overrides?: { collection?: Record<string, unknown> },
) {
  const col = { ...COLLECTION, ...(overrides?.collection ?? {}) };
  return renderWithProviders(
    <OverviewTab collection={col as any} />,
    { apiClient: makeApiClient(state), queryClient: makeQueryClient() },
  );
}

describe('OverviewTab', () => {
  it('renders stat cards with document count and storage', () => {
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();
  });

  it('renders vector and field tags in the schema glance', () => {
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    // "embedding" appears in both the glance tag and the schema table
    const glance = document.querySelector('.zv-schema-glance')!;
    expect(glance).toBeInTheDocument();
    expect(glance.textContent).toContain('embedding');
    expect(glance.textContent).toContain('title');
    expect(glance.textContent).toContain('score');
  });

  it('does not display a sparse vector dimension in the schema glance', () => {
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
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

    const glance = document.querySelector('.zv-schema-glance')!;
    expect(glance.textContent).toContain('sparse');
    expect(glance.textContent).not.toContain('768d');
  });

  it('shows correct field/index counts', () => {
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    // 1 vector + 2 fields = 3 total
    expect(screen.getByText('3')).toBeInTheDocument();
    // 1v · 2s — split across child elements, match container
    expect(screen.getByText((_, el) =>
      el?.className === 'zv-stat-sub' && el.textContent === '1v · 2s',
    )).toBeInTheDocument();
  });

  it('displays collection path', () => {
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    expect(screen.getByText('/tmp/demo')).toBeInTheDocument();
  });

  it('calls optimize when the optimize button is clicked', async () => {
    const user = userEvent.setup();
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    await user.click(screen.getByRole('button', { name: /optimize/i }));

    await waitFor(() => {
      expect(state.optimizeCalled).toBe(true);
    });
  });

  it('reveals the collection folder through the filesystem API', async () => {
    const user = userEvent.setup();
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    await user.click(screen.getByTitle(/open folder/i));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/fs/reveal',
        body: { path: '/tmp/demo' },
      });
    });
  });

  it('opens destroy dialog and requires name confirmation', async () => {
    const user = userEvent.setup();
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    await user.click(screen.getByRole('button', { name: /destroy/i }));

    // Dialog should be open — the destroy button in the dialog is disabled
    const dialogDestroyBtns = screen.getAllByRole('button', { name: /destroy/i });
    const confirmBtn = dialogDestroyBtns[dialogDestroyBtns.length - 1];
    expect(confirmBtn).toBeDisabled();

    // Type wrong name — button still disabled
    const input = screen.getByPlaceholderText('demo');
    await user.type(input, 'wrong');
    expect(confirmBtn).toBeDisabled();

    // Clear and type correct name
    await user.clear(input);
    await user.type(input, 'demo');
    expect(confirmBtn).not.toBeDisabled();
  });

  it('destroys the collection after exact name confirmation', async () => {
    const user = userEvent.setup();
    const state: FakeState = { optimizeCalled: false, destroyCalled: null, calls: [] };
    renderTab(state);

    await user.click(screen.getByRole('button', { name: /destroy/i }));
    const input = screen.getByPlaceholderText('demo');
    await user.type(input, 'demo');
    const confirmBtn = screen.getAllByRole('button', { name: /destroy/i }).pop()!;
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(state.destroyCalled).toBe('demo');
    });
  });
});
