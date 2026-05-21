/**
 * Documents API binding.
 *
 * Thin wrapper over the generic ApiClient for the document CRUD surface.
 * Aligned with the v0.2.0 contract:
 * - browsing is filter-first (``POST :browse``); cursor pagination is gone
 *   because Zvec 0.4.x does not expose a list-all primitive.
 * - document ids are strings (Zvec ``Doc.id: str``).
 */
import type { components } from '@zvec-studio/api-client';

import type { ApiClient } from '@/lib/api-client';

export type DocumentBrowseRequest = components['schemas']['DocumentBrowseRequest'];
export type DocumentBrowseResponse = components['schemas']['DocumentBrowseResponse'];
export type DocumentInsertRequest = components['schemas']['DocumentInsertRequest'];
export type DocumentInsertResponse = components['schemas']['DocumentInsertResponse'];
export type DocumentBatchDeleteRequest = components['schemas']['DocumentBatchDeleteRequest'];
export type DocumentBatchDeleteResponse = components['schemas']['DocumentBatchDeleteResponse'];
export type DocumentUpsertRequest = components['schemas']['DocumentUpsertRequest'];
export type DocumentUpsertResponse = components['schemas']['DocumentUpsertResponse'];
export type DocumentUpdateRequest = components['schemas']['DocumentUpdateRequest'];
export type DocumentUpdateResponse = components['schemas']['DocumentUpdateResponse'];
export type DocumentDeleteByFilterRequest =
  components['schemas']['DocumentDeleteByFilterRequest'];
export type DocumentDeleteByFilterResponse =
  components['schemas']['DocumentDeleteByFilterResponse'];
/** A single document row. The backend returns an open-ended dict of fields. */
export type DocumentRecord = Record<string, unknown>;

export interface DocumentsApi {
  browse(
    collection: string,
    body: DocumentBrowseRequest,
    signal?: AbortSignal,
  ): Promise<DocumentBrowseResponse>;
  get(collection: string, id: string, signal?: AbortSignal): Promise<DocumentRecord>;
  insert(
    collection: string,
    body: DocumentInsertRequest,
    signal?: AbortSignal,
  ): Promise<DocumentInsertResponse>;
  upsert(
    collection: string,
    body: DocumentUpsertRequest,
    signal?: AbortSignal,
  ): Promise<DocumentUpsertResponse>;
  update(
    collection: string,
    body: DocumentUpdateRequest,
    signal?: AbortSignal,
  ): Promise<DocumentUpdateResponse>;
  delete(collection: string, id: string, signal?: AbortSignal): Promise<void>;
  deleteBatch(
    collection: string,
    body: DocumentBatchDeleteRequest,
    signal?: AbortSignal,
  ): Promise<DocumentBatchDeleteResponse>;
  deleteByFilter(
    collection: string,
    body: DocumentDeleteByFilterRequest,
    signal?: AbortSignal,
  ): Promise<DocumentDeleteByFilterResponse>;
}

/** Build a DocumentsApi bound to the given transport. */
export function createDocumentsApi(client: ApiClient): DocumentsApi {
  return {
    browse: (collection, body, signal) =>
      client.request<DocumentBrowseResponse>(
        `/collections/${encodeURIComponent(collection)}/documents:browse`,
        { method: 'POST', body, signal },
      ),
    get: (collection, id, signal) =>
      client.request<DocumentRecord>(
        `/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
        { signal },
      ),
    insert: (collection, body, signal) =>
      client.request<DocumentInsertResponse>(
        `/collections/${encodeURIComponent(collection)}/documents`,
        { method: 'POST', body, signal },
      ),
    upsert: (collection, body, signal) =>
      client.request<DocumentUpsertResponse>(
        `/collections/${encodeURIComponent(collection)}/documents:upsert`,
        { method: 'POST', body, signal },
      ),
    update: (collection, body, signal) =>
      client.request<DocumentUpdateResponse>(
        `/collections/${encodeURIComponent(collection)}/documents`,
        { method: 'PATCH', body, signal },
      ),
    delete: (collection, id, signal) =>
      client.request<void>(
        `/collections/${encodeURIComponent(collection)}/documents/${encodeURIComponent(id)}`,
        { method: 'DELETE', signal },
      ),
    deleteBatch: (collection, body, signal) =>
      client.request<DocumentBatchDeleteResponse>(
        `/collections/${encodeURIComponent(collection)}/documents:deleteBatch`,
        { method: 'POST', body, signal },
      ),
    deleteByFilter: (collection, body, signal) =>
      client.request<DocumentDeleteByFilterResponse>(
        `/collections/${encodeURIComponent(collection)}/documents:deleteByFilter`,
        { method: 'POST', body, signal },
      ),
  };
}
