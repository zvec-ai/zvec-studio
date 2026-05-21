/**
 * DocumentsPanel unit tests (T7 v0.2.0).
 *
 * Uses an in-memory fake ``ApiClient`` that speaks the Filter Browser
 * contract: ``POST /collections/:name/documents:browse`` replaces the old
 * GET cursor list, and ``POST /collections/:name/documents:deleteBatch``
 * replaces the old ``/deleteBatch`` path suffix.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';

import { DocumentsPanel } from './DocumentsPanel';

type DocRecord = Record<string, unknown>;

interface FakeDocsState {
  docs: DocRecord[];
  filterError?: UserFacingError;
  insertError?: UserFacingError;
  deleteError?: UserFacingError;
  batchError?: UserFacingError;
  /** Records (method, path, body) of every request so assertions can inspect. */
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeDocs(count: number): DocRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    title: `doc ${i + 1}`,
    // Vectors longer than 10 dims trigger the folded summary.
    embedding: Array.from({ length: 128 }, (_, d) => (i + d) / 100),
  }));
}

function makeApiClient(state: FakeDocsState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });

      // POST batch delete — Google-style custom verb ``:deleteBatch``.
      if (
        method === 'POST' &&
        /^\/collections\/[^/]+\/documents:deleteBatch$/.test(path)
      ) {
        if (state.batchError) throw new ApiError(state.batchError);
        const body = opts!.body as { ids: ReadonlyArray<unknown> };
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        const idSet = new Set(ids.map((v) => String(v)));
        const before = state.docs.length;
        state.docs = state.docs.filter((d) => !idSet.has(String(d.id)));
        return { deleted: before - state.docs.length } as unknown as T;
      }

      // POST delete-by-filter — AIP-136 custom verb.
      if (
        method === 'POST' &&
        /^\/collections\/[^/]+\/documents:deleteByFilter$/.test(path)
      ) {
        const body = (opts!.body ?? {}) as { filter?: string };
        const filter = body.filter ?? '';
        const m = filter.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
        if (!m) throw new ApiError(fakeError('INVALID_FILTER_EXPRESSION'));
        const [, field, op, rawValue] = m;
        const value = parseLiteral(rawValue.trim());
        const before = state.docs.length;
        state.docs = state.docs.filter((row) => {
          const v = row[field];
          if (v === undefined) return true;
          switch (op) {
            case '==':
              return v !== value;
            case '!=':
              return v === value;
            default:
              return true;
          }
        });
        return { deleted: before - state.docs.length } as unknown as T;
      }

      // POST browse — Filter Browser replacement for the old cursor list.
      if (
        method === 'POST' &&
        /^\/collections\/[^/]+\/documents:browse$/.test(path)
      ) {
        const body = (opts!.body ?? {}) as {
          filter?: string | null;
          limit?: number;
          outputFields?: ReadonlyArray<string> | null;
          includeVector?: boolean;
        };
        const filter = body.filter ?? null;
        const limit = body.limit ?? 50;

        let filtered = state.docs;
        if (filter) {
          if (state.filterError) throw new ApiError(state.filterError);
          const m = filter.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
          if (!m) throw new ApiError(fakeError('INVALID_FILTER_EXPRESSION'));
          const [, field, op, rawValue] = m;
          const value = parseLiteral(rawValue.trim());
          filtered = state.docs.filter((row) => {
            const v = row[field];
            if (v === undefined) return false;
            switch (op) {
              case '==':
                return v === value;
              case '!=':
                return v !== value;
              case '>':
                return (v as number) > (value as number);
              case '>=':
                return (v as number) >= (value as number);
              case '<':
                return (v as number) < (value as number);
              case '<=':
                return (v as number) <= (value as number);
              default:
                return false;
            }
          });
        }

        const page = filtered.slice(0, limit);
        const truncated = filtered.length > page.length;
        return { items: page, truncated } as unknown as T;
      }

      // POST insert
      if (method === 'POST' && /^\/collections\/[^/]+\/documents$/.test(path)) {
        if (state.insertError) throw new ApiError(state.insertError);
        const body = opts!.body as { documents: DocRecord[] };
        const docs = Array.isArray(body?.documents) ? body.documents : [];
        state.docs = [...state.docs, ...docs];
        return { inserted: docs.length } as unknown as T;
      }

      // DELETE single
      const deleteMatch = path.match(
        /^\/collections\/[^/]+\/documents\/([^?]+)$/,
      );
      if (deleteMatch && method === 'DELETE') {
        if (state.deleteError) throw new ApiError(state.deleteError);
        const raw = decodeURIComponent(deleteMatch[1]);
        const before = state.docs.length;
        state.docs = state.docs.filter((d) => String(d.id) !== raw);
        if (state.docs.length === before) {
          throw new ApiError(fakeError('DOCUMENT_NOT_FOUND'));
        }
        return undefined as unknown as T;
      }

      // GET single
      if (deleteMatch && method === 'GET') {
        const id = decodeURIComponent(deleteMatch[1]);
        const doc = state.docs.find((d) => String(d.id) === id);
        if (!doc) throw new ApiError(fakeError('DOCUMENT_NOT_FOUND'));
        return doc as unknown as T;
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function fakeError(code: string): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status: code === 'INVALID_FILTER_EXPRESSION' ? 400 : 500,
    traceId: null,
    severity: code === 'INVALID_FILTER_EXPRESSION' ? 'warning' : 'error',
  };
}

function parseLiteral(raw: string): unknown {
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  return raw;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderPanel(
  state: FakeDocsState,
  overrides?: { pageSize?: number },
) {
  const apiClient = makeApiClient(state);
  return renderWithProviders(
    <DocumentsPanel
      collection="demo"
      schema={{ name: 'demo', vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 128 }], fields: [] }}
      pageSize={overrides?.pageSize ?? 50}
    />,
    { apiClient, queryClient: makeQueryClient() },
  );
}

describe('DocumentsPanel', () => {
  it('renders inferred columns and summarises long vectors', async () => {
    const state: FakeDocsState = { docs: fakeDocs(3), calls: [] };
    renderPanel(state);

    // Headers derived from the first row's keys.
    expect(await screen.findByText('id')).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('embedding')).toBeInTheDocument();

    // All 3 rows are rendered by primary key.
    expect(screen.getByTestId('zv-documents-row-1')).toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-3')).toBeInTheDocument();

    // Vector columns with ≥10 dims are folded.
    const summaries = screen.getAllByTestId('zv-documents-vector-summary');
    expect(summaries.length).toBe(3);
    expect(summaries[0]).toHaveTextContent('(128-d)');
  });

  it('summarises document count and truncated flag in the toolbar', async () => {
    const state: FakeDocsState = { docs: fakeDocs(3), calls: [] };
    renderPanel(state, { pageSize: 10 });

    await screen.findByTestId('zv-documents-row-1');
    expect(screen.getByTestId('zv-documents-page')).toHaveTextContent(/3 document/i);
    // Fewer docs than the page size → no “More may exist” marker.
    expect(screen.getByTestId('zv-documents-page')).not.toHaveTextContent(
      /more may exist/i,
    );

    // The browse call used the configured limit.
    const browse = state.calls.find((c) => c.path.endsWith(':browse'));
    expect(browse?.body).toMatchObject({ limit: 10 });
  });

  it('surfaces the truncated hint when the server caps the page', async () => {
    const state: FakeDocsState = { docs: fakeDocs(5), calls: [] };
    renderPanel(state, { pageSize: 3 });

    await screen.findByTestId('zv-documents-row-1');
    expect(screen.getByTestId('zv-documents-page')).toHaveTextContent(/more may exist/i);
  });

  it('opens the Drawer with full JSON when a row is clicked', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(2), calls: [] };
    renderPanel(state);

    const row = await screen.findByTestId('zv-documents-row-1');
    await user.click(row);

    const body = await screen.findByTestId('zv-documents-drawer-body');
    expect(body).toHaveTextContent('"id": "1"');
    expect(body).toHaveTextContent('"title": "doc 1"');
    expect(body).toHaveTextContent('"embedding"');

    await user.click(screen.getByTestId('zv-documents-drawer-close'));
    expect(screen.queryByTestId('zv-documents-drawer-body')).not.toBeInTheDocument();
  });

  it('applies a valid filter and shows the filtered rows', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(5), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-1');
    await user.type(screen.getByTestId('zv-documents-filter'), 'id > 3');
    await user.click(screen.getByTestId('zv-documents-filter-apply'));

    expect(await screen.findByTestId('zv-documents-row-4')).toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-5')).toBeInTheDocument();
    expect(screen.queryByTestId('zv-documents-row-1')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('zv-documents-filter-reset'));
    expect(await screen.findByTestId('zv-documents-row-1')).toBeInTheDocument();
  });

  it('toasts the Problem Details error when the filter is rejected', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = {
      docs: fakeDocs(3),
      filterError: fakeError('INVALID_FILTER_EXPRESSION'),
      calls: [],
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderPanel(state);
    await screen.findByTestId('zv-documents-row-1');

    await user.type(screen.getByTestId('zv-documents-filter'), 'garbage');
    await user.click(screen.getByTestId('zv-documents-filter-apply'));

    const toast = await screen.findByTestId('zv-toast');
    expect(within(toast).getByText(/filter expression is invalid/i)).toBeInTheDocument();

    spy.mockRestore();
  });

  // ---------- T9 write-flow coverage ----------

  it('deletes a single document via the row action + confirm dialog', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(3), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-2');
    await user.click(screen.getByTestId('zv-documents-delete-row-2'));

    // Confirm dialog surfaces the target id.
    const confirmBody = await screen.findByTestId('zv-documents-delete-confirm-body');
    expect(confirmBody).toHaveTextContent(/Delete document 2/i);

    await user.click(screen.getByTestId('zv-documents-delete-confirm'));

    // Row disappears after the cache refetches.
    await screen.findByTestId('zv-documents-row-1');
    expect(screen.queryByTestId('zv-documents-row-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-3')).toBeInTheDocument();

    // DELETE was issued to the correct path.
    expect(
      state.calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/documents/2')),
    ).toBe(true);
  });

  it('cancelling the delete dialog keeps the row and fires no DELETE', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(2), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-1');
    await user.click(screen.getByTestId('zv-documents-delete-row-1'));
    await user.click(screen.getByTestId('zv-documents-delete-cancel'));

    expect(screen.getByTestId('zv-documents-row-1')).toBeInTheDocument();
    expect(state.calls.every((c) => c.method !== 'DELETE')).toBe(true);
  });

  it('batch-deletes via selection checkboxes + the selection bar', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(4), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-1');

    // Tick two rows. Checkbox onClick is stopPropagation'd so the drawer
    // stays closed.
    await user.click(screen.getByTestId('zv-documents-select-1'));
    await user.click(screen.getByTestId('zv-documents-select-3'));
    expect(screen.queryByTestId('zv-documents-drawer-body')).not.toBeInTheDocument();

    const bar = await screen.findByTestId('zv-documents-selection-bar');
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-documents-delete-selected'));
    await user.click(screen.getByTestId('zv-documents-delete-confirm'));

    // Selected rows gone, untouched rows remain.
    await screen.findByTestId('zv-documents-row-2');
    expect(screen.queryByTestId('zv-documents-row-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zv-documents-row-3')).not.toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-4')).toBeInTheDocument();

    // Batch POST went to the ``:deleteBatch`` path with the chosen ids.
    const batchCall = state.calls.find(
      (c) => c.method === 'POST' && c.path.endsWith('/documents:deleteBatch'),
    );
    expect(batchCall).toBeDefined();
    expect(batchCall?.body).toEqual({ ids: ['1', '3'] });

    // Selection bar collapses after the batch clears.
    expect(screen.queryByTestId('zv-documents-selection-bar')).not.toBeInTheDocument();
  });

  it('inserts via the Insert dialog and refreshes the listing', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(1), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-1');
    await user.click(screen.getByTestId('zv-documents-insert'));

    // Dialog seeded with a schema-shaped template.
    const body = await screen.findByTestId('zv-insert-doc-body');
    expect(body).toBeInTheDocument();

    // Swap the seed with a two-doc array payload.
    const textarea = body as HTMLTextAreaElement;
    await user.clear(textarea);
    await user.click(textarea);
    await user.paste(
      JSON.stringify([
        { id: '10', title: 'ten' },
        { id: '11', title: 'eleven' },
      ]),
    );

    await user.click(screen.getByTestId('zv-insert-doc-submit'));

    // Newly inserted rows appear after the list refetch.
    expect(await screen.findByTestId('zv-documents-row-10')).toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-11')).toBeInTheDocument();

    const insertCall = state.calls.find(
      (c) => c.method === 'POST' && /\/documents$/.test(c.path),
    );
    expect(insertCall).toBeDefined();
    expect(
      Array.isArray((insertCall?.body as { documents: unknown[] }).documents),
    ).toBe(true);
  });

  it('deletes by filter via the dialog and refreshes the listing', async () => {
    const user = userEvent.setup();
    const state: FakeDocsState = { docs: fakeDocs(3), calls: [] };
    renderPanel(state);

    await screen.findByTestId('zv-documents-row-1');

    await user.click(screen.getByTestId('zv-documents-delete-by-filter'));
    const input = await screen.findByTestId('zv-documents-delete-by-filter-input');
    await user.clear(input);
    await user.type(input, 'id == "2"');
    await user.click(screen.getByTestId('zv-documents-delete-by-filter-confirm'));

    // Row 2 disappears, the rest remain.
    await screen.findByTestId('zv-documents-row-1');
    expect(screen.queryByTestId('zv-documents-row-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('zv-documents-row-3')).toBeInTheDocument();

    const call = state.calls.find(
      (c) => c.method === 'POST' && /\/documents:deleteByFilter$/.test(c.path),
    );
    expect(call).toBeDefined();
    expect((call?.body as { filter?: string }).filter).toBe('id == "2"');
  });
});
