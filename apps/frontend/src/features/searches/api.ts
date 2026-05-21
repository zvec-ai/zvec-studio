/**
 * Vector search API binding.
 *
 * Thin wrapper around the generic ApiClient for ``POST /api/v1/collections/{name}/searches``.
 * Consumers use the typed request/response that T10 drives through a React Query
 * mutation — searches are explicit user actions so caching is intentionally off.
 */
import type { components } from '@zvec-studio/api-client';

import type { ApiClient } from '@/lib/api-client';

export type SearchRequest = components['schemas']['SearchRequest'];
export type SearchResponse = components['schemas']['SearchResponse'];
export type SearchResult = components['schemas']['SearchResult'];

export interface SearchesApi {
  /** Run a vector search against ``collection``. */
  run(
    collection: string,
    body: SearchRequest,
    signal?: AbortSignal,
  ): Promise<SearchResponse>;
}

/** Build a SearchesApi bound to the given transport. */
export function createSearchesApi(client: ApiClient): SearchesApi {
  return {
    run: (collection, body, signal) =>
      client.request<SearchResponse>(
        `/collections/${encodeURIComponent(collection)}/searches`,
        { method: 'POST', body, signal },
      ),
  };
}
