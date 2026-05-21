/**
 * CreateEmbeddingDialog unit tests.
 *
 * Uses a fake ApiClient to exercise form rendering, validation,
 * type switching, and submission.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { CreateEmbeddingDialog } from './CreateEmbeddingDialog';

interface FakeState {
  created: Array<{ name: string; config: Record<string, unknown> }>;
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
        return { items: state.created } as unknown as T;
      }
      if (method === 'POST' && path === '/ai/embeddings') {
        const body = opts!.body as { name: string; config: Record<string, unknown> };
        state.created.push(body);
        return body as unknown as T;
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

function Harness() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <CreateEmbeddingDialog open={open} onClose={() => setOpen(false)} />
      <span data-testid="harness-open">{open ? 'yes' : 'no'}</span>
    </>
  );
}

function renderDialog(state: FakeState) {
  return renderWithProviders(<Harness />, {
    apiClient: makeApiClient(state),
    queryClient: makeQueryClient(),
  });
}

describe('CreateEmbeddingDialog', () => {
  it('renders the form with name, type select, and config textarea', () => {
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '' })).toBeDefined();
  });

  it('does not submit when name is empty', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('creates an embedding function on valid submission', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'my-emb');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(state.created).toHaveLength(1);
      expect(state.created[0].name).toBe('my-emb');
      expect(state.created[0].config.type).toBe('openai_dense');
    });
  });

  it('changes default config when type is switched', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'bm25');

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'bm25-fn');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(state.created).toHaveLength(1);
      expect(state.created[0].config.type).toBe('bm25');
    });
  });

  it('closes the dialog on successful creation', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'close-test');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(screen.getByTestId('harness-open')).toHaveTextContent('no');
    });
  });
});
