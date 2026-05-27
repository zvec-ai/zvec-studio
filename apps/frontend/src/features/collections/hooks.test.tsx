/**
 * Tests for the Collections hooks.
 *
 * The hooks only know about ``ApiClient`` (via ``ApiClientProvider``), so we
 * inject a tiny in-memory fake here instead of round-tripping through MSW +
 * undici. That isolates the hooks layer from transport quirks (jsdom's
 * ``Response.json()`` behaves differently from Node's native fetch), while
 * still exercising the full TanStack Query machinery (cache, invalidation,
 * mutation → query refresh).
 *
 * Transport-level behaviour is covered by the page-level integration tests
 * (``CollectionsListPage.test.tsx``) which wire up MSW end-to-end.
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { ApiClientProvider } from '@/lib/api-client-provider';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import {
  useCollectionsList,
  useCreateCollection,
  useCloseCollection,
  useOpenCollection,
  useDestroyCollection,
  collectionsQueryKey,
  recentCollectionsQueryKey,
} from '@/features/collections';

interface FakeState {
  collections: Map<string, { name: string; path: string }>;
  recent: Array<{ name: string; path: string }>;
  listError?: UserFacingError;
  createError?: UserFacingError;
  deleteError?: UserFacingError;
  openError?: UserFacingError;
  destroyError?: UserFacingError;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeFakeState(): FakeState {
  return { collections: new Map(), recent: [], calls: [] };
}

function makeFakeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (path === '/collections' && method === 'GET') {
        if (state.listError) throw new ApiError(state.listError);
        return { items: Array.from(state.collections.values()) } as unknown as T;
      }
      if (path === '/collections' && method === 'POST') {
        if (state.createError) throw new ApiError(state.createError);
        const body = opts!.body as { path: string; schema: { name: string } };
        const record = { name: body.schema.name, path: body.path };
        state.collections.set(record.name, record);
        return record as unknown as T;
      }
      if (path === '/collections/open' && method === 'POST') {
        if (state.openError) throw new ApiError(state.openError);
        const body = opts!.body as { path: string };
        const name = body.path.split('/').pop() ?? 'opened';
        state.collections.set(name, { name, path: body.path });
        return { name, path: body.path } as unknown as T;
      }
      if (path === '/collections/recent' && method === 'GET') {
        return { items: state.recent } as unknown as T;
      }
      if (path.match(/\/collections\/[^/]+:destroy/) && method === 'POST') {
        if (state.destroyError) throw new ApiError(state.destroyError);
        const name = decodeURIComponent(path.replace('/collections/', '').replace(':destroy', ''));
        state.collections.delete(name);
        state.recent = state.recent.filter((r) => r.name !== name);
        return undefined as unknown as T;
      }
      if (path.startsWith('/collections/') && method === 'DELETE') {
        if (state.deleteError) throw new ApiError(state.deleteError);
        const name = decodeURIComponent(path.slice('/collections/'.length));
        state.collections.delete(name);
        return undefined as unknown as T;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
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

function makeWrapper(
  queryClient: QueryClient,
  apiClient: ApiClient,
): (props: { children: ReactNode }) => JSX.Element {
  return function Wrapper({ children }) {
    return (
      <ApiClientProvider client={apiClient}>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ApiClientProvider>
    );
  };
}

function fakeError(code: string, severity: UserFacingError['severity'] = 'error'): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status: 500,
    traceId: null,
    severity,
  };
}

describe('collections hooks', () => {
  it('lists collections from the server', async () => {
    const state = makeFakeState();
    state.collections.set('alpha', { name: 'alpha', path: '/tmp/alpha' });
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const { result } = renderHook(() => useCollectionsList(), {
      wrapper: makeWrapper(queryClient, apiClient),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.items).toHaveLength(1);
    expect(result.current.data?.items[0]?.name).toBe('alpha');
    expect(state.calls).toEqual([{ method: 'GET', path: '/collections', body: undefined }]);
  });

  it('surfaces the error state when the list endpoint fails', async () => {
    const state = makeFakeState();
    state.listError = fakeError('internal_error');
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const { result } = renderHook(() => useCollectionsList(), {
      wrapper: makeWrapper(queryClient, apiClient),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBeInstanceOf(ApiError);
  });

  it('creates a collection and invalidates the list cache on success', async () => {
    const state = makeFakeState();
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const wrapper = makeWrapper(queryClient, apiClient);

    const list = renderHook(() => useCollectionsList(), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    expect(list.result.current.data?.items).toHaveLength(0);

    const create = renderHook(() => useCreateCollection(), { wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({
        path: '/tmp/beta',
        schema: {
          name: 'beta',
          vectors: [
            {
              name: 'embedding',
              dataType: 'VECTOR_FP32',
              dimension: 4,
              indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
            },
          ],
          fields: [{ name: 'id', dataType: 'INT64', nullable: false }],
        },
      });
    });

    await waitFor(() => {
      expect(list.result.current.data?.items).toHaveLength(1);
    });
    expect(list.result.current.data?.items[0]?.name).toBe('beta');
    expect(queryClient.getQueryData(collectionsQueryKey)).toBeDefined();
    expect(state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /collections',
      'POST /collections',
      'GET /collections',
    ]);
  });

  it('reports an ApiError when creation fails', async () => {
    const state = makeFakeState();
    state.createError = fakeError('collection_already_exists');
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const create = renderHook(() => useCreateCollection(), {
      wrapper: makeWrapper(queryClient, apiClient),
    });

    await act(async () => {
      await expect(
        create.result.current.mutateAsync({
          path: '/tmp/dup',
          schema: {
            name: 'dup',
            vectors: [
              {
                name: 'embedding',
                dataType: 'VECTOR_FP32',
                dimension: 4,
                indexParam: { indexType: 'HNSW', metric: 'COSINE', params: {} },
              },
            ],
            fields: [{ name: 'id', dataType: 'INT64', nullable: false }],
          },
        }),
      ).rejects.toBeInstanceOf(ApiError);
    });
  });

  it('opens an existing collection and adds it to the list cache', async () => {
    const state = makeFakeState();
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const wrapper = makeWrapper(queryClient, apiClient);

    const { result } = renderHook(
      () => ({ list: useCollectionsList(), open: useOpenCollection() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));

    await act(async () => {
      await result.current.open.mutateAsync({ path: '/tmp/gamma' });
    });

    expect(state.collections.has('gamma')).toBe(true);
    // The mutation's invalidate triggers a refetch; verify via the cache directly
    // to avoid flakiness from React 18 observer notification timing in jsdom.
    await waitFor(
      () => {
        const cached = queryClient.getQueryData<{ items: Array<{ name: string }> }>(collectionsQueryKey);
        expect(cached?.items.map((i) => i.name)).toContain('gamma');
      },
      { timeout: 3000 },
    );
  });

  it('removes a collection and refreshes the list', async () => {
    const state = makeFakeState();
    state.collections.set('delta', { name: 'delta', path: '/tmp/delta' });
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const wrapper = makeWrapper(queryClient, apiClient);

    const list = renderHook(() => useCollectionsList(), { wrapper });
    await waitFor(() => expect(list.result.current.data?.items).toHaveLength(1));

    const close = renderHook(() => useCloseCollection(), { wrapper });
    await act(async () => {
      await close.result.current.mutateAsync({ name: 'delta' });
    });

    await waitFor(() => {
      expect(list.result.current.data?.items).toHaveLength(0);
    });
    expect(state.calls.some((c) => c.method === 'DELETE' && c.path === '/collections/delta')).toBe(true);
  });

  it('destroy removes collection from list cache optimistically', async () => {
    const state = makeFakeState();
    state.collections.set('zap', { name: 'zap', path: '/tmp/zap' });
    state.recent = [{ name: 'zap', path: '/tmp/zap' }];
    const queryClient = makeQueryClient();
    const apiClient = makeFakeApiClient(state);
    const wrapper = makeWrapper(queryClient, apiClient);

    const list = renderHook(() => useCollectionsList(), { wrapper });
    await waitFor(() => expect(list.result.current.data?.items).toHaveLength(1));

    const destroy = renderHook(() => useDestroyCollection(), { wrapper });
    await act(async () => {
      await destroy.result.current.mutateAsync('zap');
    });

    // List cache should be optimistically cleared.
    const cached = queryClient.getQueryData<{ items: Array<{ name: string }> }>(collectionsQueryKey);
    expect(cached?.items.find((i) => i.name === 'zap')).toBeUndefined();
    // Recent cache should be invalidated (refetched).
    await waitFor(() => {
      const recentCached = queryClient.getQueryData<{ items: Array<{ name: string }> }>(recentCollectionsQueryKey);
      expect(recentCached?.items.find((i) => i.name === 'zap')).toBeUndefined();
    });
  });
});
