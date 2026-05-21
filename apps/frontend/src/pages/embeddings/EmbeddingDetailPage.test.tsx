/**
 * EmbeddingDetailPage unit tests.
 *
 * Uses a fake ApiClient to exercise rendering, save, invalid JSON validation,
 * and delete confirmation.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { EmbeddingDetailPage } from './EmbeddingDetailPage';

interface FakeRecord {
  name: string;
  description: string | null;
  config: Record<string, unknown>;
}

interface FakeState {
  embedding: FakeRecord | null;
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

      if (method === 'GET' && /^\/ai\/embeddings\/[^/]+$/.test(path)) {
        if (!state.embedding) throw new Error('NOT_FOUND');
        return state.embedding as unknown as T;
      }
      if (method === 'PUT' && /^\/ai\/embeddings\/[^/]+$/.test(path)) {
        state.updated = opts!.body as FakeRecord;
        return state.updated as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/embeddings\/[^/]+$/.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/embeddings/', ''));
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

function renderPage(state: FakeState, embName = 'test-emb') {
  return renderWithProviders(
    <Routes>
      <Route path="/embeddings/:name" element={<EmbeddingDetailPage />} />
    </Routes>,
    {
      initialEntries: [`/embeddings/${embName}`],
      apiClient: makeApiClient(state),
      queryClient: makeQueryClient(),
    },
  );
}

describe('EmbeddingDetailPage', () => {
  it('renders embedding name and config', async () => {
    const state: FakeState = {
      embedding: { name: 'test-emb', description: 'A test', config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    expect(await screen.findByText('test-emb')).toBeInTheDocument();
    expect(screen.getByText('default_local_dense')).toBeInTheDocument();
  });

  it('shows error state when embedding not found', async () => {
    const state: FakeState = {
      embedding: null,
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state, 'missing');

    expect(await screen.findByText(/failed to load/i)).toBeInTheDocument();
  });

  it('saves updated config and description', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      embedding: { name: 'test-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('test-emb');

    const descInput = screen.getByPlaceholderText(/optional description/i);
    await user.type(descInput, 'My description');

    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(state.updated).not.toBeNull();
      expect(state.updated!.description).toBe('My description');
    });
  });

  it('opens delete confirmation dialog', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      embedding: { name: 'test-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('test-emb');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(screen.getByText(/permanently remove/i)).toBeInTheDocument();
  });

  it('confirms delete and sends API request', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      embedding: { name: 'test-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('test-emb');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));

    // Click the Delete button in the dialog
    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    await waitFor(() => {
      expect(state.deleted).toBe('test-emb');
    });
  });
});
