/**
 * MutateTab unit tests.
 *
 * Uses a fake ApiClient to exercise Insert, Upsert, Update, and Delete
 * sub-views including form/JSON mode switching, validation, and confirm dialogs.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { MutateTab } from './MutateTab';

interface FakeState {
  inserted: unknown[];
  upserted: unknown[];
  updated: unknown[];
  deletedIds: string[];
  deletedFilters: string[];
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
        return { items: [] } as unknown as T;
      }
      if (method === 'GET' && path === '/ai/rerankers') {
        return { items: [] } as unknown as T;
      }
      // Insert: POST /collections/{name}/documents
      if (method === 'POST' && /\/collections\/[^/]+\/documents$/.test(path)) {
        const body = opts!.body as { documents: unknown[] };
        state.inserted.push(...body.documents);
        return { inserted: body.documents.length } as unknown as T;
      }
      // Upsert: POST /collections/{name}/documents:upsert
      if (method === 'POST' && path.includes('/documents:upsert')) {
        const body = opts!.body as { documents: unknown[] };
        state.upserted.push(...body.documents);
        return { upserted: body.documents.length } as unknown as T;
      }
      // Update: PATCH /collections/{name}/documents
      if (method === 'PATCH' && /\/collections\/[^/]+\/documents$/.test(path)) {
        const body = opts!.body as { documents: unknown[] };
        state.updated.push(...body.documents);
        return { updated: body.documents.length } as unknown as T;
      }
      // Delete single: DELETE /collections/{name}/documents/{id}
      if (method === 'DELETE' && /\/documents\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.split('/documents/')[1]);
        state.deletedIds.push(id);
        return undefined as unknown as T;
      }
      // Delete by filter: POST /collections/{name}/documents:deleteByFilter
      if (method === 'POST' && path.includes('/documents:deleteByFilter')) {
        const body = opts!.body as { filter: string };
        state.deletedFilters.push(body.filter);
        return { deleted: 5 } as unknown as T;
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

function freshState(): FakeState {
  return { inserted: [], upserted: [], updated: [], deletedIds: [], deletedFilters: [], calls: [] };
}

function renderTab(state: FakeState) {
  return renderWithProviders(
    <MutateTab collection={COLLECTION as any} />,
    { apiClient: makeApiClient(state), queryClient: makeQueryClient() },
  );
}

describe('MutateTab', () => {
  it('renders sub-view tabs: Insert, Upsert, Update, Delete', () => {
    renderTab(freshState());

    expect(screen.getByText('Insert')).toBeInTheDocument();
    expect(screen.getByText('Upsert')).toBeInTheDocument();
    expect(screen.getByText('Update')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('shows the insert form by default with field inputs', () => {
    renderTab(freshState());

    expect(screen.getByText(/insert document/i)).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('score')).toBeInTheDocument();
  });

  it('submits an insert and calls the API', async () => {
    const user = userEvent.setup();
    const state = freshState();
    renderTab(state);

    // Fill title field
    const titleInput = screen.getByPlaceholderText('STRING');
    await user.type(titleInput, 'My Doc');

    // Click the submit button (type=submit)
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await user.click(submitBtn);

    await waitFor(() => {
      expect(state.inserted).toHaveLength(1);
      expect((state.inserted[0] as any).title).toBe('My Doc');
    });
  });

  it('switches to Delete tab and shows By ID mode', async () => {
    const user = userEvent.setup();
    renderTab(freshState());

    await user.click(screen.getByText('Delete'));

    expect(screen.getByText(/delete documents/i)).toBeInTheDocument();
    expect(screen.getByText(/by id/i)).toBeInTheDocument();
    expect(screen.getByText(/by filter/i)).toBeInTheDocument();
  });

  it('deletes a document by ID after confirmation', async () => {
    const user = userEvent.setup();
    const state = freshState();
    renderTab(state);

    await user.click(screen.getByText('Delete'));

    const idInput = screen.getByPlaceholderText(/enter document id/i);
    await user.type(idInput, 'doc-42');

    // Click the submit Delete button (type=submit, not the tab)
    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    await user.click(submitBtn);

    // Confirm in the dialog
    await waitFor(() => {
      expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    });
    const dialogDeleteBtn = screen.getAllByRole('button', { name: /^delete$/i }).pop()!;
    await user.click(dialogDeleteBtn);

    await waitFor(() => {
      expect(state.deletedIds).toContain('doc-42');
    });
  });

  it('switches to By Filter delete mode', async () => {
    const user = userEvent.setup();
    renderTab(freshState());

    await user.click(screen.getByText('Delete'));
    await user.click(screen.getByText(/by filter/i));

    expect(screen.getByPlaceholderText(/category = 'archived'/i)).toBeInTheDocument();
  });

  it('switches to Upsert tab and shows form/JSON mode toggle', async () => {
    const user = userEvent.setup();
    renderTab(freshState());

    await user.click(screen.getByText('Upsert'));

    expect(screen.getByText(/upsert documents/i)).toBeInTheDocument();
    expect(screen.getByText('Form')).toBeInTheDocument();
    expect(screen.getByText('JSON')).toBeInTheDocument();
  });

  it('switches to Update tab', async () => {
    const user = userEvent.setup();
    renderTab(freshState());

    await user.click(screen.getByText('Update'));

    expect(screen.getByText(/update documents/i)).toBeInTheDocument();
    expect(screen.getByText(/partial update/i)).toBeInTheDocument();
  });

  it('adds a second document slot in Insert view', async () => {
    const user = userEvent.setup();
    renderTab(freshState());

    // Initially one title input
    let titleInputs = screen.getAllByPlaceholderText('STRING');
    expect(titleInputs).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /\+ doc/i }));

    titleInputs = screen.getAllByPlaceholderText('STRING');
    expect(titleInputs).toHaveLength(2);

    // Submit button now shows (2)
    expect(screen.getByRole('button', { name: /insert.*\(2\)/i })).toBeInTheDocument();
  });
});
