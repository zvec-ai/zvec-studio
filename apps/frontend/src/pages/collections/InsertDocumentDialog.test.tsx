/**
 * InsertDocumentDialog unit tests.
 *
 * Focus on the editor's own responsibilities: JSON parse + structural
 * validation, the success Toast, the failure Toast from ``ApiError`` and the
 * bookkeeping around the seed template. The happy-path insert → list-refresh
 * integration is covered by ``DocumentsPanel.test.tsx``.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';

import { InsertDocumentDialog } from './InsertDocumentDialog';

interface Recorder {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  insertError?: UserFacingError;
}

function makeClient(state: Recorder): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      // Auto-embed panel queries the registered embeddings on mount — keep it
      // out of ``state.calls`` so existing assertions on POST count remain stable.
      if (method === 'GET' && path === '/ai/embeddings') {
        return { items: [] } as unknown as T;
      }
      state.calls.push({ method, path, body: opts?.body });
      if (
        opts?.method === 'POST' &&
        /^\/collections\/[^/]+\/documents$/.test(path)
      ) {
        if (state.insertError) throw new ApiError(state.insertError);
        const body = opts.body as { documents: unknown[] };
        return { inserted: body.documents.length } as unknown as T;
      }
      throw new Error(`Unexpected request: ${opts?.method} ${path}`);
    },
  };
}

function renderDialog(state: Recorder) {
  return renderWithProviders(
    <InsertDocumentDialog open onClose={() => undefined} collection="demo" />,
    {
      apiClient: makeClient(state),
      queryClient: new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
    },
  );
}

describe('InsertDocumentDialog', () => {
  it('seeds the textarea with a JSON template on open', () => {
    const state: Recorder = { calls: [] };
    renderDialog(state);
    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    expect(body.value).toMatch(/"hello world"/);
    expect(body.value.trim().startsWith('{')).toBe(true);
  });

  it('accepts a single JSON object and toasts success', async () => {
    const user = userEvent.setup();
    const state: Recorder = { calls: [] };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('{"id": 42, "title": "answer"}');

    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const toast = await screen.findByTestId('zv-toast');
    expect(within(toast).getByText('1 document(s) inserted.')).toBeInTheDocument();

    const call = state.calls.find((c) => c.method === 'POST');
    expect(call).toBeDefined();
    expect((call?.body as { documents: unknown[] }).documents).toEqual([
      { id: 42, title: 'answer' },
    ]);
  });

  it('wraps a bare object in an array and reports the inserted count', async () => {
    const user = userEvent.setup();
    const state: Recorder = { calls: [] };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('[{"id":1},{"id":2},{"id":3}]');
    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const toast = await screen.findByTestId('zv-toast');
    expect(within(toast).getByText('3 document(s) inserted.')).toBeInTheDocument();
  });

  it('surfaces a parse error for invalid JSON without firing a request', async () => {
    const user = userEvent.setup();
    const state: Recorder = { calls: [] };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('not-json');
    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const err = await screen.findByTestId('zv-insert-doc-error');
    expect(err.textContent?.toLowerCase()).toContain('invalid json');
    expect(state.calls.every((c) => c.method !== 'POST')).toBe(true);
  });

  it('rejects an empty array and keeps the dialog open', async () => {
    const user = userEvent.setup();
    const state: Recorder = { calls: [] };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('[]');
    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const err = await screen.findByTestId('zv-insert-doc-error');
    expect(err.textContent).toMatch(/at least one document/i);
    expect(state.calls.every((c) => c.method !== 'POST')).toBe(true);
  });

  it('rejects arrays that contain non-object entries', async () => {
    const user = userEvent.setup();
    const state: Recorder = { calls: [] };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('[{"id":1}, 42]');
    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const err = await screen.findByTestId('zv-insert-doc-error');
    expect(err.textContent).toMatch(/must be a JSON object/i);
    expect(state.calls.every((c) => c.method !== 'POST')).toBe(true);
  });

  it('toasts the Problem Details error when the backend rejects the payload', async () => {
    const user = userEvent.setup();
    const state: Recorder = {
      calls: [],
      insertError: {
        code: 'INVALID_DOCUMENT',
        message: 'bad doc',
        messageKey: 'errors.code.INVALID_DOCUMENT',
        status: 422,
        traceId: null,
        severity: 'warning',
      },
    };
    renderDialog(state);

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await user.clear(body);
    await user.click(body);
    await user.paste('{"id": 1}');
    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const toast = await screen.findByTestId('zv-toast');
    expect(within(toast).getByText('bad doc')).toBeInTheDocument();
  });
});
