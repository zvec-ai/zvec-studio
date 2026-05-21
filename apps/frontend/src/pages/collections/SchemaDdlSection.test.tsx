/**
 * SchemaPanelDdl smoke tests.
 *
 * Verifies the Schema panel renders the DDL toolbar buttons and per-row
 * Rename/Drop actions, and that opening one of the dialogs (``Add field``)
 * surfaces the expected form controls. Mutation paths are exercised in the
 * hooks tests; here we focus on the wiring.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
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
          dataType: 'VECTOR_FP32',
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

function makeApiClient(): ApiClient {
  return {
    baseUrl: 'fake',
    request: async () => {
      throw new Error('SchemaPanelDdl smoke test should not call the API');
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

  it('hides per-row actions for the immutable id field', () => {
    renderWithProviders(<SchemaPanelDdl summary={makeSummary()} />, {
      apiClient: makeApiClient(),
    });

    expect(screen.queryByTestId('zv-schema-drop-field-id')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zv-schema-rename-field-id')).not.toBeInTheDocument();
  });
});
