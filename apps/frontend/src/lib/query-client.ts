/**
 * TanStack Query client factory.
 *
 * We centralize the default behaviour (retry budget, staleness, error logging)
 * so feature pages never instantiate their own clients. The factory is
 * exported so tests can spin up isolated clients.
 */
import { QueryCache, QueryClient } from '@tanstack/react-query';

export interface CreateQueryClientOptions {
  /** Sink called whenever a query throws; the shell wires this to the Toast centre. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Build a ``QueryClient`` configured for the Studio shell.
 *
 * Defaults:
 * - Retry once on 5xx / network errors. 4xx never retry because the server
 *   already validated the request (retrying is pure waste).
 * - 30s stale window so cached Collection lists survive quick in-app navigation.
 * - Failures are surfaced via ``onError`` so the Toast layer can localize them.
 */
export function createQueryClient(options: CreateQueryClientOptions = {}): QueryClient {
  const { onError } = options;
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (err, query) => {
        // Queries that handle their own error UI set meta.skipGlobalError.
        if (query.meta?.skipGlobalError) return;
        onError?.(err);
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (failureCount >= 1) return false;
          // Do not retry on 4xx -- the backend already decided this request is invalid.
          if (error instanceof Response && error.status >= 400 && error.status < 500) {
            return false;
          }
          return true;
        },
      },
      mutations: {
        retry: false,
      },
    },
  });
}
