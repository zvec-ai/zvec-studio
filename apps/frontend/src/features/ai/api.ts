/**
 * AI Extension API binding.
 *
 * Thin wrapper over the generic ApiClient that exposes one function per AI
 * endpoint group (embeddings + rerankers). Mirrors the layout of
 * ``features/collections/api.ts`` so MSW-driven hook tests can stay flat.
 *
 * The backend persists records in ``ai_functions.json``; create/update share
 * the same ``EmbeddingFunctionRecord`` / ``RerankerFunctionRecord`` shape.
 */
import type { components } from '@zvec-studio/api-client';
import type { ApiClient } from '@/lib/api-client';

export type EmbeddingFunctionRecord = components['schemas']['EmbeddingFunctionRecord'];
export type EmbeddingFunctionListResponse =
  components['schemas']['EmbeddingFunctionListResponse'];
export type EmbedRequest = components['schemas']['EmbedRequest'];
export type EmbedResponseDense = components['schemas']['EmbedResponseDense'];
export type EmbedResponseSparse = components['schemas']['EmbedResponseSparse'];
export type EmbedResponse = EmbedResponseDense | EmbedResponseSparse;

export type RerankerFunctionRecord = components['schemas']['RerankerFunctionRecord'];
export type RerankerFunctionListResponse =
  components['schemas']['RerankerFunctionListResponse'];
export type RerankRequest = components['schemas']['RerankRequest'];
export type RerankResponse = components['schemas']['RerankResponse'];
export type RerankCandidate = components['schemas']['RerankCandidate'];
export type RerankHit = components['schemas']['RerankHit'];

export interface AiApi {
  // ── Embedding functions (CRUD + execute) ────────────────────────────────
  listEmbeddings(signal?: AbortSignal): Promise<EmbeddingFunctionListResponse>;
  getEmbedding(name: string, signal?: AbortSignal): Promise<EmbeddingFunctionRecord>;
  createEmbedding(
    body: EmbeddingFunctionRecord,
    signal?: AbortSignal,
  ): Promise<EmbeddingFunctionRecord>;
  updateEmbedding(
    name: string,
    body: EmbeddingFunctionRecord,
    signal?: AbortSignal,
  ): Promise<EmbeddingFunctionRecord>;
  deleteEmbedding(name: string, signal?: AbortSignal): Promise<void>;
  embed(
    name: string,
    body: EmbedRequest,
    signal?: AbortSignal,
  ): Promise<EmbedResponse>;

  // ── Reranker functions (CRUD + execute) ─────────────────────────────────
  listRerankers(signal?: AbortSignal): Promise<RerankerFunctionListResponse>;
  getReranker(name: string, signal?: AbortSignal): Promise<RerankerFunctionRecord>;
  createReranker(
    body: RerankerFunctionRecord,
    signal?: AbortSignal,
  ): Promise<RerankerFunctionRecord>;
  updateReranker(
    name: string,
    body: RerankerFunctionRecord,
    signal?: AbortSignal,
  ): Promise<RerankerFunctionRecord>;
  deleteReranker(name: string, signal?: AbortSignal): Promise<void>;
  rerank(
    name: string,
    body: RerankRequest,
    signal?: AbortSignal,
  ): Promise<RerankResponse>;
}

/** Build an AiApi bound to the given transport. */
export function createAiApi(client: ApiClient): AiApi {
  return {
    listEmbeddings: (signal) =>
      client.request<EmbeddingFunctionListResponse>('/ai/embeddings', { signal }),
    getEmbedding: (name, signal) =>
      client.request<EmbeddingFunctionRecord>(
        `/ai/embeddings/${encodeURIComponent(name)}`,
        { signal },
      ),
    createEmbedding: (body, signal) =>
      client.request<EmbeddingFunctionRecord>('/ai/embeddings', {
        method: 'POST',
        body,
        signal,
      }),
    updateEmbedding: (name, body, signal) =>
      client.request<EmbeddingFunctionRecord>(
        `/ai/embeddings/${encodeURIComponent(name)}`,
        { method: 'PUT', body, signal },
      ),
    deleteEmbedding: (name, signal) =>
      client.request<void>(`/ai/embeddings/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        signal,
      }),
    embed: (name, body, signal) =>
      client.request<EmbedResponse>(
        `/ai/embeddings/${encodeURIComponent(name)}:embed`,
        { method: 'POST', body, signal },
      ),

    listRerankers: (signal) =>
      client.request<RerankerFunctionListResponse>('/ai/rerankers', { signal }),
    getReranker: (name, signal) =>
      client.request<RerankerFunctionRecord>(
        `/ai/rerankers/${encodeURIComponent(name)}`,
        { signal },
      ),
    createReranker: (body, signal) =>
      client.request<RerankerFunctionRecord>('/ai/rerankers', {
        method: 'POST',
        body,
        signal,
      }),
    updateReranker: (name, body, signal) =>
      client.request<RerankerFunctionRecord>(
        `/ai/rerankers/${encodeURIComponent(name)}`,
        { method: 'PUT', body, signal },
      ),
    deleteReranker: (name, signal) =>
      client.request<void>(`/ai/rerankers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        signal,
      }),
    rerank: (name, body, signal) =>
      client.request<RerankResponse>(
        `/ai/rerankers/${encodeURIComponent(name)}:rerank`,
        { method: 'POST', body, signal },
      ),
  };
}
