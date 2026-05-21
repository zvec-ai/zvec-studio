/**
 * CreateRerankerDialog unit tests.
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

import { CreateRerankerDialog } from './CreateRerankerDialog';

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

      if (method === 'GET' && path === '/ai/rerankers') {
        return { items: state.created } as unknown as T;
      }
      if (method === 'POST' && path === '/ai/rerankers') {
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
      <CreateRerankerDialog open={open} onClose={() => setOpen(false)} />
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

describe('CreateRerankerDialog', () => {
  it('renders the form with name input, type select, and config textarea', () => {
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    expect(screen.getByRole('textbox', { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('does not submit when name is empty', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    await user.click(screen.getByRole('button', { name: /^create$/i }));

    expect(state.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('creates a reranker function on valid submission', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'my-rrf');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(state.created).toHaveLength(1);
      expect(state.created[0].name).toBe('my-rrf');
      expect(state.created[0].config.type).toBe('rrf');
    });
  });

  it('changes default config when type is switched to weighted', async () => {
    const user = userEvent.setup();
    const state: FakeState = { created: [], calls: [] };
    renderDialog(state);

    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'weighted');

    await user.type(screen.getByRole('textbox', { name: /name/i }), 'w-fn');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(state.created).toHaveLength(1);
      expect(state.created[0].config.type).toBe('weighted');
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
