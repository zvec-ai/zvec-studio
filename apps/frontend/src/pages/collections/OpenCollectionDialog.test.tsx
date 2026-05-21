/**
 * Tests for the Open Collection dialog.
 */
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import { OpenCollectionDialog } from './OpenCollectionDialog';

interface FakeState {
  openError?: UserFacingError;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeError(code: string): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status: 404,
    traceId: null,
    severity: 'warning',
  };
}

function makeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (path === '/collections' && method === 'GET') {
        return { items: [] } as unknown as T;
      }
      if (path === '/collections/open' && method === 'POST') {
        if (state.openError) throw new ApiError(state.openError);
        const body = opts!.body as { path: string };
        const name = body.path.split('/').pop() ?? 'opened';
        return {
          name,
          path: body.path,
          schema: {
            name,
            description: null,
            vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, description: null }],
            fields: [{ name: 'id', dataType: 'INT64', isPrimary: true, description: null }],
            indexParams: { indexType: 'HNSW', metric: 'COSINE', params: {} },
          },
          stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
        } as unknown as T;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

/** Minimal host that owns ``open`` state so we can observe onClose. */
function Harness(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <OpenCollectionDialog open={open} onClose={() => setOpen(false)} />
      <span data-testid="harness-open">{open ? 'yes' : 'no'}</span>
    </>
  );
}

describe('<OpenCollectionDialog />', () => {
  it('shows a validation error when the path is empty', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.click(screen.getByTestId('zv-open-submit'));
    expect(await screen.findByText('Path is required.')).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('submits the path and closes on success', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-open-path'), '/tmp/gamma');
    await userEvent.click(screen.getByTestId('zv-open-submit'));

    await waitFor(() => {
      expect(
        state.calls.some((c) => c.method === 'POST' && c.path === '/collections/open'),
      ).toBe(true);
    });
    const post = state.calls.find((c) => c.path === '/collections/open')!;
    expect(post.body).toEqual({ path: '/tmp/gamma' });

    await waitFor(() => {
      expect(screen.getByTestId('harness-open')).toHaveTextContent('no');
    });
  });

  it('stays open when the server reports the collection does not exist', async () => {
    const state: FakeState = { openError: fakeError('COLLECTION_NOT_FOUND'), calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-open-path'), '/tmp/missing');
    await userEvent.click(screen.getByTestId('zv-open-submit'));

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST')).toBe(true);
    });
    expect(screen.getByTestId('harness-open')).toHaveTextContent('yes');
  });
});
