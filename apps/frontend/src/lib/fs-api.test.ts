import { describe, expect, it } from 'vitest';

import type { ApiClient } from './api-client';
import { createFsApi } from './fs-api';

describe('createFsApi', () => {
  it('builds list URLs with optional path and hidden flags', async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const client: ApiClient = {
      baseUrl: 'fake',
      request: async <T,>(path: string, opts?: { body?: unknown }): Promise<T> => {
        calls.push({ path, body: opts?.body });
        return { path: '/tmp', parent: '/', home: '/home/bob', entries: [] } as unknown as T;
      },
    };
    const fs = createFsApi(client);

    await fs.list({ path: '/tmp/projects', showHidden: true });
    await fs.list();

    expect(calls[0].path).toBe('/fs/list?path=%2Ftmp%2Fprojects&show_hidden=true');
    expect(calls[1].path).toBe('/fs/list');
  });

  it('sends includeFiles and extension filter for the file picker', async () => {
    const calls: Array<{ path: string }> = [];
    const client: ApiClient = {
      baseUrl: 'fake',
      request: async <T,>(path: string): Promise<T> => {
        calls.push({ path });
        return { path: '/tmp', parent: '/', home: '/home/bob', entries: [] } as unknown as T;
      },
    };
    const fs = createFsApi(client);

    await fs.list({ path: '/data', includeFiles: true, extensions: '.jsonl,.tar.gz' });
    // extensions without includeFiles must not leak into the query
    await fs.list({ extensions: '.jsonl' });

    expect(calls[0].path).toBe(
      '/fs/list?path=%2Fdata&includeFiles=true&extensions=.jsonl%2C.tar.gz',
    );
    expect(calls[1].path).toBe('/fs/list');
  });

  it('sends reveal requests with the selected path', async () => {
    const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
    const client: ApiClient = {
      baseUrl: 'fake',
      request: async <T,>(
        path: string,
        opts?: { method?: string; body?: unknown },
      ): Promise<T> => {
        calls.push({ path, method: opts?.method, body: opts?.body });
        return undefined as unknown as T;
      },
    };

    await createFsApi(client).reveal('/tmp/demo');

    expect(calls).toEqual([
      { path: '/fs/reveal', method: 'POST', body: { path: '/tmp/demo' } },
    ]);
  });
});
