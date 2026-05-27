/**
 * Integration tests for the Collections list page.
 */
import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import { CollectionsListPage } from './CollectionsListPage';

function makeApiClient(collections: Array<{ name: string; path: string }>, recentItems?: Array<{ name: string; path: string }>): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      if (path === '/collections' && method === 'GET') {
        return { items: collections } as unknown as T;
      }
      if (path === '/collections/recent' && method === 'GET') {
        return { items: recentItems ?? [] } as unknown as T;
      }
      if (path === '/collections/open' && method === 'POST') {
        const err: UserFacingError = {
          code: 'COLLECTION_NOT_FOUND',
          message: 'Path /tmp/ghost does not exist.',
          messageKey: 'errors.code.COLLECTION_NOT_FOUND',
          status: 404,
          traceId: null,
          severity: 'warning',
        };
        throw new ApiError(err);
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

  it('shows error toast when opening a recent collection fails', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CollectionsListPage />, {
      apiClient: makeApiClient([], [{ name: 'ghost', path: '/tmp/ghost' }]),
      queryClient: makeQueryClient(),
    });

    // Wait for recent item to appear.
    const recentBtn = await screen.findByText('ghost');
    await user.click(recentBtn);

    // Toast should show with the error message.
    await waitFor(() => {
      expect(screen.getByTestId('zv-toast')).toBeInTheDocument();
    });
  });
});
