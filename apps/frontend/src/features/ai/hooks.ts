/**
 * React Query hooks for the AI Extension API.
 *
 * Mirrors ``features/collections/hooks.ts`` patterns: query keys are stable
 * tuples, mutations invalidate the relevant list/detail queries on success.
 *
 * The execute endpoints (``:embed`` / ``:rerank``) are exposed as mutations —
 * they are explicit user actions, never cached, and they don't mutate any
 * server state, so no invalidation runs on success.
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
  createAiApi,
  type EmbedRequest,
  type EmbedResponse,
  type EmbeddingFunctionListResponse,
  type EmbeddingFunctionRecord,
  type RerankRequest,
  type RerankResponse,
  type RerankerFunctionListResponse,
  type RerankerFunctionRecord,
} from './api';

// ── Query keys ──────────────────────────────────────────────────────────────

export const embeddingsListQueryKey = ['ai', 'embeddings', 'list'] as const;
export const embeddingDetailQueryKey = (name: string) =>
  ['ai', 'embeddings', 'detail', name] as const;

export const rerankersListQueryKey = ['ai', 'rerankers', 'list'] as const;
export const rerankerDetailQueryKey = (name: string) =>
  ['ai', 'rerankers', 'detail', name] as const;

// ── Embeddings ──────────────────────────────────────────────────────────────

export function useListEmbeddings(): UseQueryResult<EmbeddingFunctionListResponse, unknown> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useQuery({
    queryKey: embeddingsListQueryKey,
    queryFn: ({ signal }) => api.listEmbeddings(signal),
  });
}

export function useEmbedding(
  name: string | undefined,
): UseQueryResult<EmbeddingFunctionRecord, unknown> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useQuery({
    queryKey: embeddingDetailQueryKey(name ?? ''),
    queryFn: ({ signal }) => api.getEmbedding(name as string, signal),
    enabled: typeof name === 'string' && name.length > 0,
  });
}

function invalidateEmbedding(
  qc: ReturnType<typeof useQueryClient>,
  name: string,
): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: embeddingsListQueryKey }),
    qc.invalidateQueries({ queryKey: embeddingDetailQueryKey(name) }),
  ]);
}

export function useCreateEmbedding(): UseMutationResult<
  EmbeddingFunctionRecord,
  unknown,
  EmbeddingFunctionRecord
> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.createEmbedding(body),
    onSuccess: (record) => invalidateEmbedding(qc, record.name),
  });
}

export interface UpdateEmbeddingVariables {
  readonly name: string;
  readonly body: EmbeddingFunctionRecord;
}

export function useUpdateEmbedding(): UseMutationResult<
  EmbeddingFunctionRecord,
  unknown,
  UpdateEmbeddingVariables
> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }) => api.updateEmbedding(name, body),
    onSuccess: (_data, vars) => invalidateEmbedding(qc, vars.name),
  });
}

export function useDeleteEmbedding(): UseMutationResult<void, unknown, string> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteEmbedding(name),
    onSuccess: (_data, name) => invalidateEmbedding(qc, name),
  });
}

export interface EmbedVariables {
  readonly name: string;
  readonly body: EmbedRequest;
}

export function useEmbed(): UseMutationResult<EmbedResponse, unknown, EmbedVariables> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useMutation({
    mutationFn: ({ name, body }) => api.embed(name, body),
  });
}

// ── Rerankers ───────────────────────────────────────────────────────────────

export function useListRerankers(): UseQueryResult<RerankerFunctionListResponse, unknown> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useQuery({
    queryKey: rerankersListQueryKey,
    queryFn: ({ signal }) => api.listRerankers(signal),
  });
}

export function useReranker(
  name: string | undefined,
): UseQueryResult<RerankerFunctionRecord, unknown> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useQuery({
    queryKey: rerankerDetailQueryKey(name ?? ''),
    queryFn: ({ signal }) => api.getReranker(name as string, signal),
    enabled: typeof name === 'string' && name.length > 0,
  });
}

function invalidateReranker(
  qc: ReturnType<typeof useQueryClient>,
  name: string,
): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: rerankersListQueryKey }),
    qc.invalidateQueries({ queryKey: rerankerDetailQueryKey(name) }),
  ]);
}

export function useCreateReranker(): UseMutationResult<
  RerankerFunctionRecord,
  unknown,
  RerankerFunctionRecord
> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.createReranker(body),
    onSuccess: (record) => invalidateReranker(qc, record.name),
  });
}

export interface UpdateRerankerVariables {
  readonly name: string;
  readonly body: RerankerFunctionRecord;
}

export function useUpdateReranker(): UseMutationResult<
  RerankerFunctionRecord,
  unknown,
  UpdateRerankerVariables
> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }) => api.updateReranker(name, body),
    onSuccess: (_data, vars) => invalidateReranker(qc, vars.name),
  });
}

export function useDeleteReranker(): UseMutationResult<void, unknown, string> {
  const client = useApiClient();
  const api = createAiApi(client);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteReranker(name),
    onSuccess: (_data, name) => invalidateReranker(qc, name),
  });
}

export interface RerankVariables {
  readonly name: string;
  readonly body: RerankRequest;
}

export function useRerank(): UseMutationResult<RerankResponse, unknown, RerankVariables> {
  const client = useApiClient();
  const api = createAiApi(client);
  return useMutation({
    mutationFn: ({ name, body }) => api.rerank(name, body),
  });
}
