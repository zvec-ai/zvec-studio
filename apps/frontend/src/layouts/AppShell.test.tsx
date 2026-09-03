import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ToastProvider } from '@/components/ui';
import { AppShell } from './AppShell';
import i18n, { initI18n } from '@/i18n';
import { ApiClientProvider } from '@/lib/api-client-provider';
import type { ApiClient } from '@/lib/api-client';

initI18n();

interface FakeShellState {
  collections: Array<{ name: string; path: string }>;
  recent: Array<{ name: string | null; path: string }>;
  embeddings: Array<{ name: string; description: string | null; config: Record<string, unknown> }>;
  rerankers: Array<{ name: string; description: string | null; config: Record<string, unknown> }>;
  openedPaths: string[];
  closed: Array<{ name: string; path?: string }>;
  forgotten: string[];
  deletedEmbeddings: string[];
  deletedRerankers: string[];
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function freshState(): FakeShellState {
  return {
    collections: [{ name: 'open-demo', path: '/tmp/open-demo' }],
    recent: [{ name: 'closed-demo', path: '/tmp/closed-demo' }],
    embeddings: [
      {
        name: 'local-dense',
        description: null,
        config: { type: 'default_local_dense', dimension: 4 },
      },
    ],
    rerankers: [{ name: 'rrf', description: null, config: { type: 'rrf', rankConstant: 60 } }],
    openedPaths: [],
    closed: [],
    forgotten: [],
    deletedEmbeddings: [],
    deletedRerankers: [],
    calls: [],
  };
}

function makeFakeApiClient(state: FakeShellState): ApiClient {
  return {
    baseUrl: 'http://127.0.0.1/api/v1',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });

      if (method === 'GET' && path === '/healthz') {
        return { status: 'ok', version: '0.1.0', zvecVersion: '1.2.3' } as unknown as T;
      }
      if (method === 'GET' && path === '/collections') {
        return { items: state.collections } as unknown as T;
      }
      if (method === 'GET' && path === '/collections/recent') {
        return { items: state.recent } as unknown as T;
      }
      if (method === 'GET' && path === '/ai/embeddings') {
        return { items: state.embeddings } as unknown as T;
      }
      if (method === 'GET' && path === '/ai/rerankers') {
        return { items: state.rerankers } as unknown as T;
      }
      if (method === 'POST' && path === '/collections/open') {
        const body = opts?.body as { path: string };
        state.openedPaths.push(body.path);
        const item = state.recent.find((r) => r.path === body.path);
        const opened = { name: item?.name ?? 'opened-demo', path: body.path };
        state.collections.push(opened);
        state.recent = state.recent.filter((r) => r.path !== body.path);
        return {
          ...opened,
          schema: { name: opened.name, vectors: [], fields: [] },
          stats: { documentCount: 0, indexState: 'ready', storageBytes: 0 },
        } as unknown as T;
      }
      if (method === 'DELETE' && /^\/collections\/[^/?]+/.test(path)) {
        const [resource, query = ''] = path.split('?');
        const name = decodeURIComponent(resource.replace('/collections/', ''));
        const params = new URLSearchParams(query);
        const colPath = params.get('path') ?? undefined;
        state.closed.push({ name, path: colPath });
        state.collections = state.collections.filter((c) => c.name !== name || c.path !== colPath);
        return undefined as unknown as T;
      }
      if (method === 'POST' && path === '/collections/recent:forget') {
        const body = opts?.body as { path: string };
        state.forgotten.push(body.path);
        state.recent = state.recent.filter((r) => r.path !== body.path);
        return undefined as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/embeddings\//.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/embeddings/', ''));
        state.deletedEmbeddings.push(name);
        state.embeddings = state.embeddings.filter((e) => e.name !== name);
        return undefined as unknown as T;
      }
      if (method === 'DELETE' && /^\/ai\/rerankers\//.test(path)) {
        const name = decodeURIComponent(path.replace('/ai/rerankers/', ''));
        state.deletedRerankers.push(name);
        state.rerankers = state.rerankers.filter((r) => r.name !== name);
        return undefined as unknown as T;
      }

      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function renderShell(
  initialPath: string = '/',
  state: FakeShellState = freshState(),
): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ApiClientProvider client={makeFakeApiClient(state)}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="/" element={<AppShell />}>
                  <Route index element={<div data-testid="child">root</div>} />
                  <Route
                    path="collections"
                    element={<div data-testid="collections-page">collections</div>}
                  />
                  <Route
                    path="collections/:name"
                    element={<div data-testid="collection-detail">collection detail</div>}
                  />
                  <Route
                    path="embeddings/:name"
                    element={<div data-testid="embedding-detail">embedding detail</div>}
                  />
                  <Route
                    path="rerankers/:name"
                    element={<div data-testid="reranker-detail">reranker detail</div>}
                  />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ApiClientProvider>
      </ToastProvider>
    </I18nextProvider>,
  );
}

describe('AppShell', () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18n.changeLanguage('en');
  });

  it('renders the brand and outlet content', () => {
    renderShell('/', freshState());
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('root');
  });

  it('renders the sidebar with app name', () => {
    renderShell('/', freshState());
    expect(screen.getByAltText('Zvec Studio')).toBeInTheDocument();
  });

  it('renders sidebar resources and opens a recent collection', async () => {
    const user = userEvent.setup();
    const state = freshState();
    renderShell('/collections', state);

    expect(await screen.findByText('open-demo')).toBeInTheDocument();
    expect(screen.getByText('closed-demo')).toBeInTheDocument();
    expect(await screen.findByText('Zvec v1.2.3')).toBeInTheDocument();

    await user.click(screen.getByText('closed-demo'));

    await waitFor(() => {
      expect(state.openedPaths).toEqual(['/tmp/closed-demo']);
    });
    expect(await screen.findByTestId('collection-detail')).toBeInTheDocument();
  });

  it('closes open collections and forgets recent collections from the sidebar', async () => {
    const user = userEvent.setup();
    const state = freshState();
    renderShell('/collections/open-demo?path=%2Ftmp%2Fopen-demo', state);

    await user.click(await screen.findByTitle('Close'));

    await waitFor(() => {
      expect(state.closed).toContainEqual({ name: 'open-demo', path: '/tmp/open-demo' });
    });
    expect(await screen.findByTestId('collections-page')).toBeInTheDocument();

    await user.click(await screen.findByTitle('Forget'));
    await waitFor(() => {
      expect(state.forgotten).toEqual(['/tmp/closed-demo']);
    });
  });

  it('deletes embedding and reranker functions from sidebar confirm dialogs', async () => {
    const user = userEvent.setup();
    const state = freshState();
    renderShell('/collections', state);

    const embRow = (await screen.findByText('local-dense')).closest('a')!;
    await user.click(within(embRow).getByTitle('Delete'));
    await user.click(screen.getAllByRole('button', { name: /^delete$/i }).pop()!);
    await waitFor(() => {
      expect(state.deletedEmbeddings).toEqual(['local-dense']);
    });

    const rerRow = (await screen.findByText('rrf')).closest('a')!;
    await user.click(within(rerRow).getByTitle('Delete'));
    await user.click(screen.getAllByRole('button', { name: /^delete$/i }).pop()!);
    await waitFor(() => {
      expect(state.deletedRerankers).toEqual(['rrf']);
    });
  });

  it('opens global create dialogs from sidebar actions', async () => {
    const user = userEvent.setup();
    renderShell('/collections', freshState());

    // The "+" button toggles a menu holding the collection-level actions.
    await user.click(await screen.findByTestId('zv-collections-add'));
    await user.click(screen.getByTestId('zv-collections-menu-create'));
    expect(await screen.findByRole('dialog', { name: /create collection/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(screen.getByTitle('Open existing'));
    expect(await screen.findByRole('dialog', { name: /open collection/i })).toBeInTheDocument();
  });

  it('opens the import-collection dialog from the "+" menu', async () => {
    const user = userEvent.setup();
    renderShell('/collections', freshState());

    await user.click(await screen.findByTestId('zv-collections-add'));
    await user.click(screen.getByTestId('zv-collections-menu-import'));

    expect(await screen.findByRole('dialog', { name: /import collection/i })).toBeInTheDocument();
  });

  it('toggles sidebar visibility, theme, language, and the guide tour', async () => {
    const user = userEvent.setup();
    renderShell('/collections', freshState());

    const beforeTheme = document.documentElement.dataset.theme;
    await user.click(await screen.findByTestId('zv-sidebar-theme'));
    expect(document.documentElement.dataset.theme).not.toBe(beforeTheme);

    await user.click(screen.getByTitle('Hide sidebar'));
    expect(document.querySelector('.zv-sidebar')).toHaveClass('zv-sidebar--hidden');

    await user.click(screen.getByTestId('zv-sidebar-lang'));
    expect(localStorage.getItem('zvec-studio-language')).toBe('zh');

    await user.click(screen.getByTestId('zv-sidebar-guide'));
    expect(await screen.findByTestId('zv-tour')).toBeInTheDocument();
    await user.click(screen.getByTestId('zv-tour-skip'));
    await waitFor(() => {
      expect(screen.queryByTestId('zv-tour')).not.toBeInTheDocument();
    });
  });
});
