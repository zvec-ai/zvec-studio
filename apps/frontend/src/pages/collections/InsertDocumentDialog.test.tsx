/**
 * InsertDocumentDialog unit tests.
 *
 * Focus on the editor's own responsibilities: JSON parse + structural
 * validation, the success Toast, the failure Toast from ``ApiError`` and the
 * bookkeeping around the seed template. The happy-path insert → list-refresh
 * integration is covered by ``DocumentsPanel.test.tsx``.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';

import { InsertDocumentDialog } from './InsertDocumentDialog';

interface Recorder {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  embeddings?: Array<{ name: string; description: string | null; config: Record<string, unknown> }>;
  embedResponse?: unknown;
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
        return { items: state.embeddings ?? [] } as unknown as T;
      }
      state.calls.push({ method, path, body: opts?.body });
      if (opts?.method === 'POST' && path.includes(':embed')) {
        return (state.embedResponse ?? {
          kind: 'dense',
          dimension: 3,
          vectors: [[0.1, 0.2, 0.3]],
        }) as unknown as T;
      }
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

function renderDialog(state: Recorder, schema?: any) {
  return renderWithProviders(
    <InsertDocumentDialog open onClose={() => undefined} collection="demo" schema={schema} />,
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

  it('generates JSON documents from auto-embed text before inserting', async () => {
    const user = userEvent.setup();
    const state: Recorder = {
      calls: [],
      embeddings: [
        { name: 'local-dense', description: null, config: { type: 'default_local_dense', dimension: 3 } },
      ],
      embedResponse: {
        kind: 'dense',
        dimension: 3,
        vectors: [
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ],
      },
    };
    renderDialog(state, {
      name: 'demo',
      vectors: [
        {
          name: 'embedding',
          dataType: 'VECTOR_FP32',
          dimension: 3,
          indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
        },
      ],
      fields: [],
    });

    const summary = screen.getByTestId('zv-insert-doc-auto').querySelector('summary')!;
    await user.click(summary);

    await waitFor(() => {
      expect(screen.getByTestId('zv-insert-doc-auto-embedding')).toHaveTextContent('local-dense');
    });

    await user.selectOptions(screen.getByTestId('zv-insert-doc-auto-embedding'), 'local-dense');
    const textArea = screen.getByTestId('zv-insert-doc-auto-texts');
    await user.click(textArea);
    await user.paste('alpha\nbeta');
    await user.click(screen.getByTestId('zv-insert-doc-auto-generate'));

    const body = screen.getByTestId('zv-insert-doc-body') as HTMLTextAreaElement;
    await waitFor(() => {
      expect(body.value).toContain('"text": "alpha"');
      expect(body.value).toContain('"embedding": [');
    });

    const embedCall = state.calls.find((c) => c.path.includes('/ai/embeddings/local-dense:embed'));
    expect(embedCall?.body).toEqual({
      texts: ['alpha', 'beta'],
      isQuery: false,
    });

    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    const insertCall = await waitFor(() => {
      const call = state.calls.find((c) => /^\/collections\/[^/]+\/documents$/.test(c.path));
      expect(call).toBeDefined();
      return call!;
    });
    const docs = (insertCall.body as { documents: Array<Record<string, unknown>> }).documents;
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ text: 'alpha', embedding: [0.1, 0.2, 0.3] });
    expect(docs[1]).toMatchObject({ text: 'beta', embedding: [0.4, 0.5, 0.6] });
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
