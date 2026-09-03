/**
 * React Query hooks for the Collections API.
 *
 * The hooks read the ``ApiClient`` from an internal context so components can
 * stay ignorant of transport details. Tests inject an in-memory fake via
 * ``ApiClientProvider`` (see ``test-utils/render``).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { useApiClient } from '@/lib/api-client-context';

import {
  createCollectionsApi,
  type CollectionCreateRequest,
  type CollectionListResponse,
  type CollectionOpenRequest,
  type CollectionImportRequest,
  type CollectionImportResponse,
  type CollectionSummary,
  type FieldAddRequest,
  type FieldRenameRequest,
  type IndexCreateRequest,
  type MaintenanceResponse,
  type RecentCollectionListResponse,
  type RecentForgetRequest,
  type ScalarIndexCreateRequest,
} from './api';

/** Canonical query key for the collections list. */
export const collectionsQueryKey = ['collections', 'list'] as const;

/** Query key factory for a single Collection detail. */
export const collectionDetailQueryKey = (name: string, path?: string) =>
  path
    ? (['collections', 'detail', name, path] as const)
    : (['collections', 'detail', name] as const);

/** Canonical query key for the recently-opened collections list. */
export const recentCollectionsQueryKey = ['collections', 'recent', 'list'] as const;

export function useCollectionsList(): UseQueryResult<CollectionListResponse, unknown> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  return useQuery({
    queryKey: collectionsQueryKey,
    queryFn: ({ signal }) => api.list(signal),
  });
}

export function useCollection(
  name: string | undefined,
  path?: string,
): UseQueryResult<CollectionSummary, unknown> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  return useQuery({
    queryKey: collectionDetailQueryKey(name ?? '', path),
    queryFn: ({ signal }) => api.get(name as string, signal, path),
    enabled: typeof name === 'string' && name.length > 0,
  });
}

export function useCreateCollection(): UseMutationResult<
  CollectionSummary,
  unknown,
  CollectionCreateRequest
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CollectionCreateRequest) => api.create(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsQueryKey });
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

export function useOpenCollection(): UseMutationResult<
  CollectionSummary,
  unknown,
  CollectionOpenRequest
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CollectionOpenRequest) => api.open(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsQueryKey });
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

/**
 * Import a collection from a snapshot package — a collection-level
 * lifecycle operation (create the collection from the manifest schema and
 * load its data in one pass), not a variant of document import.
 */
export function useImportCollection(): UseMutationResult<
  CollectionImportResponse,
  unknown,
  CollectionImportRequest
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CollectionImportRequest) => api.importCollection(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsQueryKey });
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

export interface CloseCollectionVariables {
  readonly name: string;
  readonly path?: string;
}

export function useCloseCollection(): UseMutationResult<void, unknown, CloseCollectionVariables> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, path }: CloseCollectionVariables) => api.remove(name, undefined, path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: collectionsQueryKey });
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

/** Invalidate everything that depends on a Collection's identity / schema. */
function invalidateCollection(
  qc: ReturnType<typeof useQueryClient>,
  name: string,
): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: collectionsQueryKey }),
    qc.invalidateQueries({ queryKey: collectionDetailQueryKey(name) }),
  ]);
}

export function useFlushCollection(): UseMutationResult<MaintenanceResponse, unknown, string> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.flush(name),
    onSuccess: (_data, name) => invalidateCollection(qc, name),
  });
}

export function useOptimizeCollection(): UseMutationResult<MaintenanceResponse, unknown, string> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.optimize(name),
    onSuccess: (_data, name) => invalidateCollection(qc, name),
  });
}

export function useDestroyCollection(): UseMutationResult<void, unknown, string> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.destroy(name),
    onSuccess: (_data, name) => {
      qc.removeQueries({ queryKey: collectionDetailQueryKey(name) });
      // Optimistically remove from list cache so navigation shows updated data immediately.
      qc.setQueryData<CollectionListResponse | undefined>(collectionsQueryKey, (old) =>
        old ? { ...old, items: old.items.filter((c) => c.name !== name) } : old,
      );
      void qc.invalidateQueries({ queryKey: collectionsQueryKey });
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

export interface AddFieldVariables {
  readonly name: string;
  readonly body: FieldAddRequest;
}

export function useAddField(): UseMutationResult<CollectionSummary, unknown, AddFieldVariables> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }) => api.addField(name, body),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

export interface DropFieldVariables {
  readonly name: string;
  readonly field: string;
}

export function useDropField(): UseMutationResult<CollectionSummary, unknown, DropFieldVariables> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, field }) => api.dropField(name, field),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

export interface RenameFieldVariables {
  readonly name: string;
  readonly field: string;
  readonly body: FieldRenameRequest;
}

export function useRenameField(): UseMutationResult<
  CollectionSummary,
  unknown,
  RenameFieldVariables
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, field, body }) => api.renameField(name, field, body),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

export interface CreateIndexVariables {
  readonly name: string;
  readonly body: IndexCreateRequest;
}

export function useCreateIndex(): UseMutationResult<
  CollectionSummary,
  unknown,
  CreateIndexVariables
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }) => api.createIndex(name, body),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

export interface DropIndexVariables {
  readonly name: string;
  readonly vectorField: string;
}

export function useDropIndex(): UseMutationResult<CollectionSummary, unknown, DropIndexVariables> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, vectorField }) => api.dropIndex(name, vectorField),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

// ── Scalar indexes ──────────────────────────────────────────────────────────

export interface CreateScalarIndexVariables {
  readonly name: string;
  readonly field: string;
  readonly body?: ScalarIndexCreateRequest;
}

export function useCreateScalarIndex(): UseMutationResult<
  CollectionSummary,
  unknown,
  CreateScalarIndexVariables
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, field, body }) => api.createScalarIndex(name, field, body),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

export interface DropScalarIndexVariables {
  readonly name: string;
  readonly field: string;
}

export function useDropScalarIndex(): UseMutationResult<
  CollectionSummary,
  unknown,
  DropScalarIndexVariables
> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, field }) => api.dropScalarIndex(name, field),
    onSuccess: (_data, vars) => invalidateCollection(qc, vars.name),
  });
}

// ── Recently opened collections ─────────────────────────────────────────────

export function useListRecent(): UseQueryResult<RecentCollectionListResponse, unknown> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  return useQuery({
    queryKey: recentCollectionsQueryKey,
    queryFn: ({ signal }) => api.listRecent(signal),
  });
}

export function useForgetRecent(): UseMutationResult<void, unknown, RecentForgetRequest> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.forgetRecent(body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}

export function useClearRecent(): UseMutationResult<void, unknown, void> {
  const client = useApiClient();
  const api = createCollectionsApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearRecent(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: recentCollectionsQueryKey });
    },
  });
}
