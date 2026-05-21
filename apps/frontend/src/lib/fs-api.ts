/**
 * Filesystem browse API client.
 *
 * Wraps the local ``GET /fs/list`` endpoint. The OpenAPI generator runs out
 * of band, so we declare the response type directly here to avoid blocking
 * UI work on a regenerated bundle.
 */
import type { ApiClient } from './api-client';

export interface FsEntry {
  readonly name: string;
  readonly path: string;
}

export interface FsListing {
  readonly path: string;
  readonly parent: string | null;
  readonly home: string;
  readonly entries: ReadonlyArray<FsEntry>;
}

export interface ListDirectoryOptions {
  readonly path?: string;
  readonly showHidden?: boolean;
  readonly signal?: AbortSignal;
}

export function createFsApi(client: ApiClient): {
  list(options?: ListDirectoryOptions): Promise<FsListing>;
  reveal(path: string): Promise<void>;
} {
  return {
    list({ path, showHidden, signal } = {}) {
      const params = new URLSearchParams();
      if (path !== undefined && path !== '') params.set('path', path);
      if (showHidden) params.set('show_hidden', 'true');
      const qs = params.toString();
      const url = qs ? `/fs/list?${qs}` : '/fs/list';
      return client.request<FsListing>(url, { signal });
    },
    reveal(path: string) {
      return client.request<void>('/fs/reveal', {
        method: 'POST',
        body: { path },
      });
    },
  };
}
