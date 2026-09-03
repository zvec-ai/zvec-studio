/**
 * Filesystem browse API client.
 *
 * Wraps the local ``GET /fs/list`` endpoint. The OpenAPI generator runs out
 * of band, so we declare the response type directly here to avoid blocking
 * UI work on a regenerated bundle.
 */
import type { ApiClient } from './api-client';

export type FsEntryKind = 'dir' | 'file';

export interface FsEntry {
  readonly name: string;
  readonly path: string;
  /** ``file`` entries only appear when ``includeFiles`` is requested. */
  readonly kind: FsEntryKind;
  /** Size in bytes for files; null for directories. */
  readonly size: number | null;
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
  /** Also list files (not only directories). Needed by the file picker. */
  readonly includeFiles?: boolean;
  /**
   * Comma-separated extension filter applied to files when ``includeFiles``
   * is set, e.g. ``'.jsonl,.tar.gz'``. Directories are never filtered.
   */
  readonly extensions?: string;
  readonly signal?: AbortSignal;
}

export function createFsApi(client: ApiClient): {
  list(options?: ListDirectoryOptions): Promise<FsListing>;
  reveal(path: string): Promise<void>;
} {
  return {
    list({ path, showHidden, includeFiles, extensions, signal } = {}) {
      const params = new URLSearchParams();
      if (path !== undefined && path !== '') params.set('path', path);
      if (showHidden) params.set('show_hidden', 'true');
      if (includeFiles) params.set('includeFiles', 'true');
      if (includeFiles && extensions) params.set('extensions', extensions);
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
