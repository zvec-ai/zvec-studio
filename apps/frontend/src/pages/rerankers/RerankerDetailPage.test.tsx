/**
 * RerankerDetailPage unit tests.
 *
 * Uses a fake ApiClient to exercise rendering, save, and delete confirmation.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { RerankerDetailPage } from './RerankerDetailPage';

interface FakeRecord {
  name: string;
  description: string | null;
  config: Record<string, unknown>;
}

interface FakeState {
  reranker: FakeRecord | null;
  updated: FakeRecord | null;
  deleted: string | null;
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

      if (method === 'GET' && /^\/ai\/rerankers\/[^/]+$/.test(path)) {
        if (!state.reranker) throw new Error('NOT_FOUND');
        return state.reranker as unknown as T;
      }
      if (method === 'PUT' && /^\/ai\/rerankers\/[^/]+$/.test(path)) {
        state.updated = opts!.body as FakeRecord;
        return state.updated as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/rerankers\/[^/]+$/.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/rerankers/', ''));
        state.deleted = name;
        return undefined as unknown as T;
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

function renderPage(state: FakeState, rerName = 'my-rrf') {
  return renderWithProviders(
    <Routes>
      <Route path="/rerankers/:name" element={<RerankerDetailPage />} />
      <Route path="/collections" element={<div data-testid="collections-page">Collections</div>} />
    </Routes>,
    {
      initialEntries: [`/rerankers/${rerName}`],
      apiClient: makeApiClient(state),
      queryClient: makeQueryClient(),
    },
  );
}

describe('RerankerDetailPage', () => {
  it('renders reranker name and config type', async () => {
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    expect(await screen.findByText('my-rrf')).toBeInTheDocument();
    expect(screen.getByText('rrf')).toBeInTheDocument();
  });

  it('shows error state when reranker not found', async () => {
    const state: FakeState = {
      reranker: null,
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state, 'missing');

    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('saves updated description', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('my-rrf');

    const descInput = screen.getByPlaceholderText(/optional description/i);
    await user.type(descInput, 'Updated desc');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(state.updated).not.toBeNull();
      expect(state.updated!.description).toBe('Updated desc');
    });
  });

  it('opens delete confirmation and sends delete request', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('my-rrf');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(screen.getByText(/permanently remove/i)).toBeInTheDocument();

    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    await waitFor(() => {
      expect(state.deleted).toBe('my-rrf');
    });
  });

  it('navigates to /collections after delete', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('my-rrf');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    expect(await screen.findByTestId('collections-page')).toBeInTheDocument();
  });

  it('does not refetch detail after delete (removeQueries, not invalidate)', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('my-rrf');
    state.calls.length = 0;
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    await waitFor(() => {
      expect(state.deleted).toBe('my-rrf');
    });

    // Only count GETs that occur AFTER the DELETE call (ignore stale refetches
    // that may fire during the click interaction on slower runtimes like Node 20).
    const deleteIdx = state.calls.findIndex((c) => c.method === 'DELETE');
    const getAfterDelete = state.calls.filter(
      (c, i) => i > deleteIdx && c.method === 'GET' && c.path.includes('/ai/rerankers/my-rrf'),
    );
    expect(getAfterDelete).toHaveLength(0);
  });

  it('shows correct icon label for rrf type', async () => {
    const state: FakeState = {
      reranker: { name: 'my-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('my-rrf');
    expect(screen.getByText('RF')).toBeInTheDocument();
  });
});
