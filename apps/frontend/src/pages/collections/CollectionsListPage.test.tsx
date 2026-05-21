/**
 * Integration tests for the Collections list page.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';
import { CollectionsListPage } from './CollectionsListPage';

function makeApiClient(collections: Array<{ name: string; path: string }>): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string): Promise<T> => {
      if (path === '/collections') {
        return { items: collections } as unknown as T;
      }
      if (path === '/collections/recent') {
        return { items: [] } as unknown as T;
      }
      return { items: [] } as unknown as T;
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe('<CollectionsListPage />', () => {
  it('renders create and open buttons', async () => {
    renderWithProviders(<CollectionsListPage />, {
      apiClient: makeApiClient([]),
      queryClient: makeQueryClient(),
    });

    const buttons = await screen.findAllByRole('button');
    const createBtn = buttons.find((b) => b.textContent?.includes('Create'));
    const openBtn = buttons.find((b) => b.textContent?.includes('Open'));
    expect(createBtn).toBeDefined();
    expect(openBtn).toBeDefined();
  });

  it('renders open collections list when collections exist', async () => {
    renderWithProviders(<CollectionsListPage />, {
      apiClient: makeApiClient([
        { name: 'alpha', path: '/tmp/alpha' },
        { name: 'beta', path: '/tmp/beta' },
      ]),
      queryClient: makeQueryClient(),
    });

    expect(await screen.findByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('does not render collection section when list is empty', async () => {
    renderWithProviders(<CollectionsListPage />, {
      apiClient: makeApiClient([]),
      queryClient: makeQueryClient(),
    });

    const buttons = await screen.findAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    expect(screen.queryByText('alpha')).not.toBeInTheDocument();
  });
});
