/**
 * DataTab unit tests: the import/export entry points live here (as a sibling
 * of Overview/Browse/Query/Write), so the tab must render both action cards
 * and open the matching dialogs.
 */
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { DataTab } from './DataTab';

const COLLECTION = {
  name: 'demo',
  path: '/tmp/demo',
  schema: {
    name: 'demo',
    vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, indexParam: null }],
    fields: [{ name: 'title', dataType: 'STRING', nullable: false, indexParam: null }],
  },
} as unknown as Parameters<typeof DataTab>[0]['collection'];

function makeApiClient(): ApiClient {
  return {
    baseUrl: 'fake',
    // The dialogs fire list queries when opened; serve them empty.
    request: async <T,>(path: string): Promise<T> => {
      if (path === '/collections') return { items: [] } as unknown as T;
      if (path.startsWith('/fs/list')) {
        return { path: '/', parent: null, home: '/', entries: [] } as unknown as T;
      }
      throw new Error(`Unexpected request: ${path}`);
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderTab(): void {
  renderWithProviders(<DataTab collection={COLLECTION} />, {
    apiClient: makeApiClient(),
    queryClient: makeQueryClient(),
  });
}

describe('DataTab', () => {
  it('exposes the import and export entry points', () => {
    renderTab();

    expect(screen.getByTestId('zv-data-import')).toBeInTheDocument();
    expect(screen.getByTestId('zv-data-export')).toBeInTheDocument();
  });

  it('opens the import dialog from its card', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByTestId('zv-data-import'));
    // ImportDocumentsDialog title (en locale)
    expect(await screen.findByText('Import documents from file')).toBeInTheDocument();
  });

  it('opens the export dialog from its card', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByTestId('zv-data-export'));
    // ExportDocumentsDialog title (en locale)
    expect(await screen.findByText('Export documents')).toBeInTheDocument();
  });
});
