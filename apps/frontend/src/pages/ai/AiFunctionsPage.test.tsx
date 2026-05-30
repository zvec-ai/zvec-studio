/**
 * AiFunctionsPage unit tests.
 *
 * Uses an injected fake ``ApiClient`` to exercise the Embeddings + Rerankers
 * tabs end-to-end: list, create, delete, validation, tab switching.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';

import { AiFunctionsPage } from './AiFunctionsPage';

interface FakeRecord {
  name: string;
  description: string | null;
  config: Record<string, unknown>;
}

interface FakeAiState {
  embeddings: FakeRecord[];
  rerankers: FakeRecord[];
  createError?: UserFacingError;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeApiClient(state: FakeAiState): ApiClient {
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
      if (method === 'POST' && path === '/ai/embeddings') {
        if (state.createError) throw new ApiError(state.createError);
        const body = opts!.body as FakeRecord;
        state.embeddings.push(body);
        return body as unknown as T;
      }
      if (method === 'POST' && path === '/ai/rerankers') {
        if (state.createError) throw new ApiError(state.createError);
        const body = opts!.body as FakeRecord;
        state.rerankers.push(body);
        return body as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/embeddings\//.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/embeddings/', ''));
        state.embeddings = state.embeddings.filter((e) => e.name !== name);
        return undefined as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/rerankers\//.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/rerankers/', ''));
        state.rerankers = state.rerankers.filter((r) => r.name !== name);
        return undefined as unknown as T;
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
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

function renderPage(state: FakeAiState) {
  return renderWithProviders(<AiFunctionsPage />, {
    apiClient: makeApiClient(state),
    queryClient: makeQueryClient(),
  });
}

describe('AiFunctionsPage', () => {
  it('renders the page with Embeddings tab active by default', async () => {
    const state: FakeAiState = {
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense' } },
      ],
      rerankers: [],
      calls: [],
    };
    renderPage(state);

    expect(screen.getByTestId('page-ai-functions')).toBeInTheDocument();
    expect(await screen.findByTestId('zv-ai-emb-table')).toBeInTheDocument();
    expect(screen.getByTestId('zv-ai-emb-name-local-dense')).toHaveTextContent('local-dense');
  });

  it('shows empty state when no embeddings exist', async () => {
    const state: FakeAiState = {
      embeddings: [],
      rerankers: [],
      calls: [],
    };
    renderPage(state);

    expect(await screen.findByTestId('zv-ai-emb-empty')).toBeInTheDocument();
  });

  it('switches to the Rerankers tab and lists reranker records', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = {
      embeddings: [],
      rerankers: [
        { name: 'rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      ],
      calls: [],
    };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    const rerankersTab = screen.getByRole('tab', { name: /rerankers/i });
    await user.click(rerankersTab);

    expect(await screen.findByTestId('zv-ai-rer-table')).toBeInTheDocument();
    expect(screen.getByTestId('zv-ai-rer-name-rrf')).toHaveTextContent('rrf');
  });

  it('opens the Create Embedding dialog and validates empty name', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByTestId('zv-ai-emb-create'));

    // Submit without filling the name
    await user.click(screen.getByTestId('zv-ai-emb-create-submit'));

    expect(await screen.findByTestId('zv-ai-emb-error-msg')).toBeInTheDocument();
    // No create request was sent
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('creates an embedding function and refreshes the list', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByTestId('zv-ai-emb-create'));

    const nameInput = screen.getByTestId('zv-ai-emb-name');
    await user.type(nameInput, 'my-emb');

    await user.click(screen.getByTestId('zv-ai-emb-create-submit'));

    // Table appears with the created embedding
    expect(await screen.findByTestId('zv-ai-emb-table')).toBeInTheDocument();
    expect(screen.getByTestId('zv-ai-emb-name-my-emb')).toHaveTextContent('my-emb');
  });

  it('updates embedding config template when changing embedding type', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByTestId('zv-ai-emb-create'));
    await user.type(screen.getByTestId('zv-ai-emb-name'), 'bm25-emb');
    await user.selectOptions(screen.getByTestId('zv-ai-emb-type'), 'bm25');

    expect((screen.getByTestId('zv-ai-emb-config') as HTMLTextAreaElement).value).toContain('"type": "bm25"');
    await user.click(screen.getByTestId('zv-ai-emb-create-submit'));

    await waitFor(() => {
      expect(state.embeddings[0].config.type).toBe('bm25');
    });
  });

  it('toasts backend errors when creating an embedding fails', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = {
      embeddings: [],
      rerankers: [],
      createError: {
        code: 'AI_FUNCTION_EXISTS',
        message: 'duplicate embedding',
        messageKey: 'errors.code.AI_FUNCTION_EXISTS',
        status: 409,
        traceId: null,
        severity: 'warning',
      },
      calls: [],
    };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByTestId('zv-ai-emb-create'));
    await user.type(screen.getByTestId('zv-ai-emb-name'), 'dup');
    await user.click(screen.getByTestId('zv-ai-emb-create-submit'));

    expect(await screen.findByTestId('zv-toast')).toHaveTextContent('duplicate embedding');
  });

  it('deletes an embedding via the confirm dialog', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = {
      embeddings: [
        { name: 'to-delete', description: null, config: { type: 'default_local_dense' } },
      ],
      rerankers: [],
      calls: [],
    };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-table');
    await user.click(screen.getByTestId('zv-ai-emb-delete-to-delete'));

    // Confirm dialog opens
    await user.click(screen.getByTestId('zv-ai-emb-delete-confirm'));

    // After deletion, empty state or table refreshes
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === 'DELETE' && c.path.includes('/ai/embeddings/to-delete'),
        ),
      ).toBe(true);
    });
  });

  it('shows the reranker empty state and creates a reranker', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    // Switch to rerankers tab
    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByRole('tab', { name: /rerankers/i }));
    expect(await screen.findByTestId('zv-ai-rer-empty')).toBeInTheDocument();

    // Open create dialog
    await user.click(screen.getByTestId('zv-ai-rer-create'));
    const nameInput = screen.getByTestId('zv-ai-rer-name');
    await user.type(nameInput, 'my-rrf');

    await user.click(screen.getByTestId('zv-ai-rer-create-submit'));

    // Table appears
    expect(await screen.findByTestId('zv-ai-rer-table')).toBeInTheDocument();
    expect(screen.getByTestId('zv-ai-rer-name-my-rrf')).toHaveTextContent('my-rrf');
  });

  it('updates reranker config template and validates invalid reranker JSON', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByRole('tab', { name: /rerankers/i }));
    await screen.findByTestId('zv-ai-rer-empty');
    await user.click(screen.getByTestId('zv-ai-rer-create'));

    await user.selectOptions(screen.getByTestId('zv-ai-rer-type'), 'weighted');
    expect((screen.getByTestId('zv-ai-rer-config') as HTMLTextAreaElement).value).toContain('"type": "weighted"');

    const configTextarea = screen.getByTestId('zv-ai-rer-config');
    await user.clear(configTextarea);
    await user.click(configTextarea);
    await user.paste('not-json');
    await user.type(screen.getByTestId('zv-ai-rer-name'), 'bad-reranker');
    await user.click(screen.getByTestId('zv-ai-rer-create-submit'));

    expect(await screen.findByTestId('zv-ai-rer-error-msg')).toBeInTheDocument();
    expect(state.calls.filter((c) => c.method === 'POST' && c.path === '/ai/rerankers')).toHaveLength(0);
  });

  it('validates invalid JSON in the Create Embedding config textarea', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = { embeddings: [], rerankers: [], calls: [] };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByTestId('zv-ai-emb-create'));

    await user.type(screen.getByTestId('zv-ai-emb-name'), 'test-emb');

    // Corrupt the JSON config
    const configTextarea = screen.getByTestId('zv-ai-emb-config');
    await user.clear(configTextarea);
    await user.type(configTextarea, 'not valid json');

    await user.click(screen.getByTestId('zv-ai-emb-create-submit'));

    expect(await screen.findByTestId('zv-ai-emb-error-msg')).toBeInTheDocument();
    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('deletes a reranker via the confirm dialog', async () => {
    const user = userEvent.setup();
    const state: FakeAiState = {
      embeddings: [],
      rerankers: [
        { name: 'old-rrf', description: null, config: { type: 'rrf', rankConstant: 60 } },
      ],
      calls: [],
    };
    renderPage(state);

    await screen.findByTestId('zv-ai-emb-empty');
    await user.click(screen.getByRole('tab', { name: /rerankers/i }));
    await screen.findByTestId('zv-ai-rer-table');

    await user.click(screen.getByTestId('zv-ai-rer-delete-old-rrf'));
    await user.click(screen.getByTestId('zv-ai-rer-delete-confirm'));

    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === 'DELETE' && c.path.includes('/ai/rerankers/old-rrf'),
        ),
      ).toBe(true);
    });
  });
});
