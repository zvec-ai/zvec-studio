/**
 * SchemaPanelDdl smoke tests.
 *
 * Verifies the Schema panel renders the DDL toolbar buttons and per-row
 * Rename/Drop actions, and that opening one of the dialogs (``Add field``)
 * surfaces the expected form controls. Mutation paths are exercised in the
 * hooks tests; here we focus on the wiring.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';
import type { CollectionSummary } from '@/features/collections';
import { SchemaPanelDdl } from './SchemaDdlSection';

function makeSummary(name = 'demo'): CollectionSummary {
  return {
    name,
    path: `/tmp/${name}`,
    schema: {
      name,
      vectors: [
        {
          name: 'embedding',
          dataType: 'VECTOR_FP32',
          dimension: 768,
          indexParam: { indexType: 'HNSW', metric: 'COSINE', params: { M: 16 } },
        },
        {
          name: 'sparse',
          dataType: 'SPARSE_VECTOR_FP32',
          dimension: 128,
        },
      ],
      fields: [
        { name: 'id', dataType: 'INT64', nullable: false },
        { name: 'title', dataType: 'STRING', nullable: true },
      ],
    },
    stats: { documentCount: 0, indexState: 'ready', storageBytes: 0 },
  };
}

interface FakeState {
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeApiClient(state?: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state?.calls.push({ method, path, body: opts?.body });

      if (!state) throw new Error('SchemaPanelDdl smoke test should not call the API');

      if (
        /^\/collections\/demo\/fields/.test(path) ||
        /^\/collections\/demo\/indexes/.test(path)
      ) {
        return makeSummary() as unknown as T;
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

describe('SchemaPanelDdl', () => {
  it('renders the DDL toolbar buttons', () => {
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    expect(screen.getByTestId('zv-schema-add-field')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-create-index-embedding')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-drop-index-embedding')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-create-index-sparse')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-rename-field-title')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-drop-field-title')).toBeInTheDocument();
    expect(screen.getByTestId('zv-schema-create-scalar-index-title')).toBeInTheDocument();
  });

  it('opens the Add field dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    await user.click(screen.getByTestId('zv-schema-add-field'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('zv-schema-add-field-name')).toBeInTheDocument();
    expect(within(dialog).getByTestId('zv-schema-add-field-type')).toBeInTheDocument();
    expect(within(dialog).getByTestId('zv-schema-add-field-submit')).toBeInTheDocument();
  });

  it('locks sparse vector index metric to IP', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    await user.click(screen.getByTestId('zv-schema-create-index-sparse'));
    const metric = await screen.findByTestId('zv-schema-create-index-metric') as HTMLSelectElement;

    expect(metric).toHaveValue('IP');
    expect(metric).toBeDisabled();
  });

  it('renders sparse vector dimension as not applicable', () => {
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    const sparseRow = screen.getByText('sparse').closest('tr')!;
    expect(sparseRow).toHaveTextContent('—');
    expect(sparseRow).not.toHaveTextContent('128');
  });

  it('hides per-row actions for the immutable id field', () => {
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    expect(screen.queryByTestId('zv-schema-drop-field-id')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zv-schema-rename-field-id')).not.toBeInTheDocument();
  });

  it('submits an add-field request after validating required name', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-add-field'));
    await user.click(await screen.findByTestId('zv-schema-add-field-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/field name/i);
    expect(state.calls).toHaveLength(0);

    await user.type(screen.getByTestId('zv-schema-add-field-name'), 'category');
    await user.selectOptions(screen.getByTestId('zv-schema-add-field-type'), 'ARRAY_STRING');
    await user.type(screen.getByTestId('zv-schema-add-field-expression'), 'doc.category');
    await user.click(screen.getByTestId('zv-schema-add-field-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/collections/demo/fields',
        body: {
          field: { name: 'category', dataType: 'ARRAY_STRING', nullable: true },
          expression: 'doc.category',
        },
      });
    });
  });

  it('renames and drops scalar fields through confirmation dialogs', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-rename-field-title'));
    await user.type(await screen.findByTestId('zv-schema-rename-field-input'), 'headline');
    await user.click(screen.getByTestId('zv-schema-rename-field-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'PATCH',
        path: '/collections/demo/fields/title',
        body: { newName: 'headline' },
      });
    });

    await user.click(screen.getByTestId('zv-schema-drop-field-title'));
    await user.click(await screen.findByTestId('zv-schema-drop-field-submit'));

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/collections/demo/fields/title')).toBe(true);
    });
  });

  it('creates and drops vector indexes with JSON params', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-create-index-embedding'));
    await user.selectOptions(await screen.findByTestId('zv-schema-create-index-type'), 'IVF');
    await user.selectOptions(screen.getByTestId('zv-schema-create-index-metric'), 'L2');
    fireEvent.change(screen.getByTestId('zv-schema-create-index-params'), {
      target: { value: '{"nList":64}' },
    });
    await user.click(screen.getByTestId('zv-schema-create-index-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/collections/demo/indexes',
        body: {
          vectorField: 'embedding',
          indexType: 'IVF',
          metric: 'L2',
          params: { nList: 64 },
        },
      });
    });

    await user.click(screen.getByTestId('zv-schema-drop-index-embedding'));
    await user.click(await screen.findByTestId('zv-schema-drop-index-submit'));

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/collections/demo/indexes/embedding')).toBe(true);
    });
  });

  it('creates a DiskANN vector index payload', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-create-index-embedding'));
    await user.selectOptions(await screen.findByTestId('zv-schema-create-index-type'), 'DISKANN');
    await user.selectOptions(screen.getByTestId('zv-schema-create-index-metric'), 'L2');
    fireEvent.change(screen.getByTestId('zv-schema-create-index-params'), {
      target: { value: '{"maxDegree":100,"listSize":64,"pqChunkNum":2}' },
    });
    await user.click(screen.getByTestId('zv-schema-create-index-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/collections/demo/indexes',
        body: {
          vectorField: 'embedding',
          indexType: 'DISKANN',
          metric: 'L2',
          params: { maxDegree: 100, listSize: 64, pqChunkNum: 2 },
        },
      });
    });
  });

  it('blocks invalid vector index params before calling the API', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-create-index-embedding'));
    await user.type(await screen.findByTestId('zv-schema-create-index-params'), 'not-json');
    await user.click(screen.getByTestId('zv-schema-create-index-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/JSON object/i);
    expect(state.calls).toHaveLength(0);
  });

  it('creates and drops scalar indexes', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    const summary = makeSummary();
    renderWithProviders(<SchemaPanelDdl summary={summary} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-create-scalar-index-title'));
    await user.selectOptions(await screen.findByTestId('zv-schema-create-scalar-index-range'), 'true');
    await user.selectOptions(screen.getByTestId('zv-schema-create-scalar-index-wildcard'), 'true');
    await user.click(screen.getByTestId('zv-schema-create-scalar-index-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/collections/demo/fields/title/index',
        body: {
          indexType: 'INVERT',
          enableRangeOptimization: true,
          enableExtendedWildcard: true,
          tokenizerName: 'standard',
          filters: ['lowercase'],
          extraParams: '',
        },
      });
    });

    const indexed = {
      ...summary,
      schema: {
        ...summary.schema,
        fields: [
          { name: 'id', dataType: 'INT64', nullable: false },
          {
            name: 'title',
            dataType: 'STRING',
            nullable: true,
            indexParam: {
              indexType: 'SCALAR',
              enableRangeOptimization: true,
              enableExtendedWildcard: true,
            },
          },
        ],
      },
    } as CollectionSummary;
    renderWithProviders(<SchemaPanelDdl summary={indexed} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-drop-scalar-index-title'));
    await waitFor(() => {
      expect(screen.getAllByTestId('zv-schema-drop-scalar-index-submit').length).toBeGreaterThan(0);
    });
    await user.click(screen.getAllByTestId('zv-schema-drop-scalar-index-submit').pop()!);

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/collections/demo/fields/title/index')).toBe(true);
    });
  });

  it('creates an FTS scalar index payload', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [] };
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(state),
    });

    await user.click(screen.getByTestId('zv-schema-create-scalar-index-title'));
    await user.selectOptions(await screen.findByTestId('zv-schema-create-scalar-index-type'), 'FTS');
    await user.selectOptions(screen.getByTestId('zv-schema-create-scalar-index-tokenizer'), 'whitespace');
    await user.click(screen.getByTestId('zv-schema-create-scalar-index-extra-params'));
    await user.paste('{"case":"fold"}');
    await user.click(screen.getByTestId('zv-schema-create-scalar-index-submit'));

    await waitFor(() => {
      expect(state.calls).toContainEqual({
        method: 'POST',
        path: '/collections/demo/fields/title/index',
        body: {
          indexType: 'FTS',
          enableRangeOptimization: false,
          enableExtendedWildcard: false,
          tokenizerName: 'whitespace',
          filters: ['lowercase'],
          extraParams: '{"case":"fold"}',
        },
      });
    });
  });
});
