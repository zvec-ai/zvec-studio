/**
 * WelcomePage unit tests.
 *
 * Tests the home page rendering: hero section, open collections list, recent
 * items, and the create/open buttons. Uses a fake ApiClient for reliability.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, Outlet } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';
import { WelcomePage } from './WelcomePage';

interface FakeState {
  collections: Array<{ name: string; path: string }>;
  recent: Array<{ path: string; name?: string; lastOpenedAt: string }>;
}

function makeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(
      path: string,
      opts?: { method?: string; body?: unknown },
    ): Promise<T> => {
      const method = opts?.method ?? 'GET';

      if (method === 'GET' && path === '/collections') {
        return { items: state.collections } as unknown as T;
      }
      if (method === 'GET' && path === '/collections/recent') {
        return { items: state.recent } as unknown as T;
      }
      if (method === 'POST' && path === '/collections/open') {
        const body = opts!.body as { path: string };
        const name = body.path.split('/').pop() ?? 'opened';
        return {
          name,
          path: body.path,
          schema: { name, vectors: [], fields: [] },
          stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
        } as unknown as T;
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

function LayoutStub({
  onCreateClick,
  onOpenClick,
}: {
  onCreateClick: () => void;
  onOpenClick: () => void;
}): JSX.Element {
  return (
    <Outlet
      context={{
        setShowCreateCollection: onCreateClick,
        setShowOpenCollection: onOpenClick,
      }}
    />
  );
}

function renderWelcome(
  state: FakeState,
  opts?: { onCreateClick?: () => void; onOpenClick?: () => void },
) {
  const onCreateClick = opts?.onCreateClick ?? vi.fn();
  const onOpenClick = opts?.onOpenClick ?? vi.fn();

  return {
    ...renderWithProviders(
      <Routes>
        <Route
          element={
            <LayoutStub onCreateClick={onCreateClick} onOpenClick={onOpenClick} />
          }
        >
          <Route index element={<WelcomePage />} />
        </Route>
      </Routes>,
      {
        initialEntries: ['/'],
        apiClient: makeApiClient(state),
        queryClient: makeQueryClient(),
      },
    ),
    onCreateClick,
    onOpenClick,
  };
}

describe('WelcomePage', () => {
  it('renders the welcome heading and action buttons', async () => {
    const state: FakeState = { collections: [], recent: [] };
    renderWelcome(state);

    expect(await screen.findByText(/welcome/i)).toBeInTheDocument();
    expect(screen.getByText(/create collection/i)).toBeInTheDocument();
    expect(screen.getByText(/open from disk/i)).toBeInTheDocument();
  });

  it('calls setShowCreateCollection when the create button is clicked', async () => {
    const user = userEvent.setup();
    const state: FakeState = { collections: [], recent: [] };
    const onCreateClick = vi.fn();

    renderWelcome(state, { onCreateClick });

    await screen.findByText(/welcome/i);
    await user.click(screen.getByText(/create collection/i));
    expect(onCreateClick).toHaveBeenCalledWith(true);
  });

  it('calls setShowOpenCollection when the open button is clicked', async () => {
    const user = userEvent.setup();
    const state: FakeState = { collections: [], recent: [] };
    const onOpenClick = vi.fn();

    renderWelcome(state, { onOpenClick });

    await screen.findByText(/welcome/i);
    await user.click(screen.getByText(/open from disk/i));
    expect(onOpenClick).toHaveBeenCalledWith(true);
  });

  it('shows open collections when they exist', async () => {
    const state: FakeState = {
      collections: [{ name: 'testcol', path: '/tmp/testcol' }],
      recent: [],
    };
    renderWelcome(state);

    expect(await screen.findByText('testcol')).toBeInTheDocument();
    expect(screen.getByText('/tmp/testcol')).toBeInTheDocument();
  });

  it('shows recent items that are not currently open', async () => {
    const state: FakeState = {
      collections: [{ name: 'open1', path: '/tmp/open1' }],
      recent: [
        { path: '/tmp/open1', lastOpenedAt: '2025-01-01T00:00:00Z' },
        { path: '/tmp/recent-only', lastOpenedAt: '2025-01-02T00:00:00Z' },
      ],
    };
    renderWelcome(state);

    expect(await screen.findByText('open1')).toBeInTheDocument();
    expect(screen.getByText('/tmp/recent-only')).toBeInTheDocument();
  });
});
