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
export type DocumentDeleteByFilterRequest = components['schemas']['DocumentDeleteByFilterRequest'];
export type DocumentDeleteByFilterResponse =
  components['schemas']['DocumentDeleteByFilterResponse'];
export type DocumentImportRequest = components['schemas']['DocumentImportRequest'];
export type DocumentImportResponse = components['schemas']['DocumentImportResponse'];
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
  importDocuments(
    collection: string,
    body: DocumentImportRequest,
    signal?: AbortSignal,
  ): Promise<DocumentImportResponse>;
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
    importDocuments: (collection, body, signal) =>
      client.request<DocumentImportResponse>(
        `/collections/${encodeURIComponent(collection)}/documents:import`,
        { method: 'POST', body, signal },
      ),
  };
}

export interface ExportOptions {
  readonly includeVector: boolean;
  readonly outputFields?: ReadonlyArray<string>;
  readonly format?: string;
  /** ``data`` (single JSONL file, default) or ``snapshot`` (tar.gz bundle). */
  readonly mode?: 'data' | 'snapshot';
}

/**
 * Build the download URL for ``GET /collections/{name}/documents:export``.
 *
 * Exported through a *native* browser download (``<a download>``), never
 * ``fetch``: the response streams a potentially gigabyte-sized file and
 * buffering it in JS memory would crash the tab (design doc §6.3).
 */
export function buildExportUrl(
  baseUrl: string,
  collection: string,
  options: ExportOptions,
): string {
  const params = new URLSearchParams();
  params.set('includeVector', String(options.includeVector));
  if (options.outputFields && options.outputFields.length > 0) {
    params.set('outputFields', options.outputFields.join(','));
  }
  params.set('format', options.format ?? 'jsonl');
  if (options.mode === 'snapshot') {
    params.set('mode', 'snapshot');
  }
  const qs = params.toString();
  return `${baseUrl}/collections/${encodeURIComponent(collection)}/documents:export?${qs}`;
}
