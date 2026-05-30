/**
 * EmbeddingDetailPage unit tests.
 *
 * Uses a fake ApiClient to exercise rendering, save, invalid JSON validation,
 * and delete confirmation.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';
import { embeddingDetailQueryKey, embeddingsListQueryKey } from '@/features/ai';

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
  embedResponse?: unknown;
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
      if (method === 'POST' && /^\/ai\/embeddings\/[^/]+:embed$/.test(path)) {
        return (state.embedResponse ?? {
          kind: 'dense',
          dimension: 3,
          vectors: [[0.1, 0.2, 0.3]],
        }) as unknown as T;
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

function renderPage(
  state: FakeState,
  embName = 'test-emb',
  queryClient = makeQueryClient(),
) {
  return renderWithProviders(
    <Routes>
      <Route path="/embeddings/:name" element={<EmbeddingDetailPage />} />
      <Route path="/collections" element={<div data-testid="collections-page">Collections</div>} />
    </Routes>,
    {
      initialEntries: [`/embeddings/${embName}`],
      apiClient: makeApiClient(state),
      queryClient,
    },
  );
}

describe('EmbeddingDetailPage', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

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

  it('rejects invalid config JSON before saving', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      embedding: { name: 'test-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state);

    await screen.findByText('test-emb');
    const configEditor = screen.getByDisplayValue(/default_local_dense/) as HTMLTextAreaElement;
    await user.clear(configEditor);
    await user.click(configEditor);
    await user.paste('not-json');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByTestId('zv-toast')).toHaveTextContent(/invalid json/i);
    expect(state.updated).toBeNull();
  });

  it('runs a dense try-embedding request and copies the vector', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const state: FakeState = {
      embedding: { name: 'dense-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      embedResponse: {
        kind: 'dense',
        dimension: 3,
        vectors: [[0.1, 0.2, 0.3]],
      },
      calls: [],
    };
    renderPage(state, 'dense-emb');

    await screen.findByText('dense-emb');
    await user.type(screen.getByPlaceholderText(/type a query or sentence/i), 'hello vector');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    expect(await screen.findByText(/Dense.*3d/i)).toBeInTheDocument();
    expect(screen.getByText(/0\.100000/)).toBeInTheDocument();

    const embedCall = state.calls.find((c) => c.path.includes('/ai/embeddings/dense-emb:embed'));
    expect(embedCall?.body).toEqual({
      texts: ['hello vector'],
      isQuery: true,
    });

    await user.click(screen.getByRole('button', { name: /^copy$/i }));
    expect(writeText).toHaveBeenCalledWith('[0.1,0.2,0.3]');
  });

  it('renders sparse try-embedding output', async () => {
    const user = userEvent.setup();
    const state: FakeState = {
      embedding: { name: 'sparse-emb', description: null, config: { type: 'bm25' } },
      updated: null,
      deleted: null,
      embedResponse: {
        kind: 'sparse',
        vectors: [{ '42': 1, '314': 0.5 }],
      },
      calls: [],
    };
    renderPage(state, 'sparse-emb');

    await screen.findByText('sparse-emb');
    await user.type(screen.getByPlaceholderText(/type a query or sentence/i), 'hello sparse');
    await user.click(screen.getByRole('button', { name: /^generate$/i }));

    expect(await screen.findByText(/Sparse.*2 tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/"42": 1/)).toBeInTheDocument();
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

  it('navigates to /collections after delete (not Welcome page)', async () => {
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
    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    expect(await screen.findByTestId('collections-page')).toBeInTheDocument();
  });

  it('removes detail query after delete instead of invalidating it', async () => {
    const user = userEvent.setup();
    const queryClient = makeQueryClient();
    const removeSpy = vi.spyOn(queryClient, 'removeQueries');
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const state: FakeState = {
      embedding: { name: 'test-emb', description: null, config: { type: 'default_local_dense' } },
      updated: null,
      deleted: null,
      calls: [],
    };
    renderPage(state, 'test-emb', queryClient);

    await screen.findByText('test-emb');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const deleteBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteBtns[deleteBtns.length - 1]);

    await waitFor(() => {
      expect(state.deleted).toBe('test-emb');
    });
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith({
        queryKey: embeddingDetailQueryKey('test-emb'),
      });
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: embeddingDetailQueryKey('test-emb'),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: embeddingsListQueryKey });
  });
});
