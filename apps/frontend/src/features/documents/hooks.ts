/**
 * React Query hooks for the documents API.
 *
 * Browsing is no longer cursor-paginated: ``POST /documents:browse`` returns
 * up to ``limit`` rows that match the SQL-WHERE ``filter`` and a ``truncated``
 * flag. The hook re-fetches whenever the user submits a new browse body.
 */
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { useApiClient } from '@/lib/api-client-context';
import { collectionDetailQueryKey, collectionsQueryKey } from '@/features/collections/hooks';

import {
  createDocumentsApi,
  type DocumentBatchDeleteRequest,
  type DocumentBatchDeleteResponse,
  type DocumentBrowseRequest,
  type DocumentBrowseResponse,
  type DocumentDeleteByFilterRequest,
  type DocumentDeleteByFilterResponse,
  type DocumentImportRequest,
  type DocumentImportResponse,
  type DocumentInsertRequest,
  type DocumentInsertResponse,
  type DocumentRecord,
  type DocumentUpdateRequest,
  type DocumentUpdateResponse,
  type DocumentUpsertRequest,
  type DocumentUpsertResponse,
} from './api';

export const documentsBrowseQueryKey = (
  collection: string,
  body: DocumentBrowseRequest,
) =>
  [
    'documents',
    'browse',
    collection,
    body.filter ?? null,
    body.limit,
    (body.outputFields ?? []).join(','),
    body.includeVector,
  ] as const;

export const documentDetailQueryKey = (collection: string, id: string) =>
  ['documents', 'detail', collection, id] as const;

/**
 * Hook variant of ``POST :browse``. Disabled until the caller commits a
 * ``submittedBody`` — the panel keeps a draft body in local state so typing in
 * the filter box does not fire a request on every keystroke.
 */
export function useDocumentsBrowse(
  collection: string | undefined,
  submittedBody: DocumentBrowseRequest | null,
): UseQueryResult<DocumentBrowseResponse, unknown> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  return useQuery({
    queryKey:
      submittedBody === null
        ? (['documents', 'browse', collection ?? '', null] as const)
        : documentsBrowseQueryKey(collection ?? '', submittedBody),
    queryFn: ({ signal }) =>
      api.browse(collection as string, submittedBody as DocumentBrowseRequest, signal),
    enabled:
      typeof collection === 'string' && collection.length > 0 && submittedBody !== null,
    placeholderData: (prev) => prev,
    meta: { skipGlobalError: true },
  });
}

export function useDocumentDetail(
  collection: string | undefined,
  id: string | undefined,
): UseQueryResult<DocumentRecord, unknown> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  return useQuery({
    queryKey: documentDetailQueryKey(collection ?? '', id ?? ''),
    queryFn: ({ signal }) => api.get(collection as string, id as string, signal),
    enabled:
      typeof collection === 'string' &&
      collection.length > 0 &&
      typeof id === 'string' &&
      id.length > 0,
  });
}

export function useDocumentDetails(
  collection: string | undefined,
  ids: string[],
): { data: (DocumentRecord | undefined)[]; isLoading: boolean; isError: boolean } {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: documentDetailQueryKey(collection ?? '', id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.get(collection as string, id, signal),
      enabled: typeof collection === 'string' && collection.length > 0 && id.length > 0,
    })),
  });
  return {
    data: results.map((r) => r.data),
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}

/**
 * Invalidate every cached query impacted by a write on ``collection`` —
 * browse pages, the affected detail row, and the parent Collection summary
 * (whose ``documentCount`` stat needs refreshing).
 */
function invalidateAfterWrite(
  queryClient: ReturnType<typeof useQueryClient>,
  collection: string,
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['documents', 'browse', collection] }),
    queryClient.invalidateQueries({ queryKey: ['documents', 'detail', collection] }),
    queryClient.invalidateQueries({ queryKey: collectionDetailQueryKey(collection) }),
    queryClient.invalidateQueries({ queryKey: collectionsQueryKey }),
  ]);
}

export function useInsertDocuments(
  collection: string,
): UseMutationResult<DocumentInsertResponse, unknown, DocumentInsertRequest> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.insert(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

export function useDeleteDocument(
  collection: string,
): UseMutationResult<void, unknown, string> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.delete(collection, id),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

export function useDeleteDocumentsBatch(
  collection: string,
): UseMutationResult<DocumentBatchDeleteResponse, unknown, DocumentBatchDeleteRequest> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.deleteBatch(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

export function useUpsertDocuments(
  collection: string,
): UseMutationResult<DocumentUpsertResponse, unknown, DocumentUpsertRequest> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.upsert(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

export function useUpdateDocuments(
  collection: string,
): UseMutationResult<DocumentUpdateResponse, unknown, DocumentUpdateRequest> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.update(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

export function useDeleteDocumentsByFilter(
  collection: string,
): UseMutationResult<
  DocumentDeleteByFilterResponse,
  unknown,
  DocumentDeleteByFilterRequest
> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.deleteByFilter(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}

/**
 * Bulk import from a local JSONL file. The response carries a per-row report
 * (imported / failed / errors); the HTTP status stays 200 for partial
 * success, so callers inspect ``data`` rather than treating it as failure.
 */
export function useImportDocuments(
  collection: string,
): UseMutationResult<DocumentImportResponse, unknown, DocumentImportRequest> {
  const client = useApiClient();
  const api = createDocumentsApi(client);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.importDocuments(collection, body),
    onSuccess: () => invalidateAfterWrite(queryClient, collection),
  });
}
