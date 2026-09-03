/**
 * Collections API binding.
 *
 * Thin wrapper over the generic ApiClient that exposes one function per
 * backend endpoint (T2 API surface). Keeping the surface flat keeps the hook
 * layer easy to test with MSW and avoids leaking ``paths[...]`` indirection
 * into feature code.
 */
import type { components } from '@zvec-studio/api-client';
import type { ApiClient } from '@/lib/api-client';

export type CollectionSummary = components['schemas']['CollectionSummary'];
export type CollectionListResponse = components['schemas']['CollectionListResponse'];
export type CollectionListItem = components['schemas']['CollectionListItem'];
export type CollectionCreateRequest = components['schemas']['CollectionCreateRequest'];
export type CollectionOpenRequest = components['schemas']['CollectionOpenRequest'];
export type CollectionImportRequest = components['schemas']['CollectionImportRequest'];
export type CollectionImportResponse = components['schemas']['CollectionImportResponse'];
export type CollectionSchemaPayload = components['schemas']['CollectionSchema'];
export type FieldAddRequest = components['schemas']['FieldAddRequest'];
export type FieldRenameRequest = components['schemas']['FieldRenameRequest'];
export type IndexCreateRequest = components['schemas']['IndexCreateRequest'];
export type ScalarIndexCreateRequest = components['schemas']['ScalarIndexCreateRequest'];
export type MaintenanceResponse = components['schemas']['MaintenanceResponse'];
export type RecentCollectionItem = components['schemas']['RecentCollectionItem'];
export type RecentCollectionListResponse = components['schemas']['RecentCollectionListResponse'];
export type RecentForgetRequest = components['schemas']['RecentForgetRequest'];

export interface CollectionsApi {
  list(signal?: AbortSignal): Promise<CollectionListResponse>;
  get(name: string, signal?: AbortSignal, path?: string): Promise<CollectionSummary>;
  create(body: CollectionCreateRequest, signal?: AbortSignal): Promise<CollectionSummary>;
  open(body: CollectionOpenRequest, signal?: AbortSignal): Promise<CollectionSummary>;
  remove(name: string, signal?: AbortSignal, path?: string): Promise<void>;
  flush(name: string, signal?: AbortSignal): Promise<MaintenanceResponse>;
  optimize(name: string, signal?: AbortSignal): Promise<MaintenanceResponse>;
  destroy(name: string, signal?: AbortSignal): Promise<void>;
  addField(name: string, body: FieldAddRequest, signal?: AbortSignal): Promise<CollectionSummary>;
  dropField(name: string, field: string, signal?: AbortSignal): Promise<CollectionSummary>;
  renameField(
    name: string,
    field: string,
    body: FieldRenameRequest,
    signal?: AbortSignal,
  ): Promise<CollectionSummary>;
  createIndex(
    name: string,
    body: IndexCreateRequest,
    signal?: AbortSignal,
  ): Promise<CollectionSummary>;
  dropIndex(name: string, vectorField: string, signal?: AbortSignal): Promise<CollectionSummary>;
  createScalarIndex(
    name: string,
    field: string,
    body?: ScalarIndexCreateRequest,
    signal?: AbortSignal,
  ): Promise<CollectionSummary>;
  dropScalarIndex(name: string, field: string, signal?: AbortSignal): Promise<CollectionSummary>;
  /**
   * List the recently-opened collections (persisted to ``config.json``,
   * survives process restarts). Distinct from ``list`` which only reflects
   * the currently-opened in-memory set.
   */
  listRecent(signal?: AbortSignal): Promise<RecentCollectionListResponse>;
  /** Drop a single path from the recent list. Idempotent. */
  forgetRecent(body: RecentForgetRequest, signal?: AbortSignal): Promise<void>;
  /** Drop every entry from the recent list. Idempotent. */
  clearRecent(signal?: AbortSignal): Promise<void>;
  /** Import a collection from a snapshot package (collection-level op). */
  importCollection(
    body: CollectionImportRequest,
    signal?: AbortSignal,
  ): Promise<CollectionImportResponse>;
}

/** Build a CollectionsApi bound to the given transport. */
export function createCollectionsApi(client: ApiClient): CollectionsApi {
  return {
    list: (signal) => client.request<CollectionListResponse>('/collections', { signal }),
    get: (name, signal, path) => {
      const base = `/collections/${encodeURIComponent(name)}`;
      const url = path ? `${base}?path=${encodeURIComponent(path)}` : base;
      return client.request<CollectionSummary>(url, { signal });
    },
    create: (body, signal) =>
      client.request<CollectionSummary>('/collections', { method: 'POST', body, signal }),
    open: (body, signal) =>
      client.request<CollectionSummary>('/collections/open', { method: 'POST', body, signal }),
    remove: (name, signal, path) => {
      const base = `/collections/${encodeURIComponent(name)}`;
      const url = path ? `${base}?path=${encodeURIComponent(path)}` : base;
      return client.request<void>(url, { method: 'DELETE', signal });
    },
    flush: (name, signal) =>
      client.request<MaintenanceResponse>(`/collections/${encodeURIComponent(name)}:flush`, {
        method: 'POST',
        signal,
      }),
    optimize: (name, signal) =>
      client.request<MaintenanceResponse>(`/collections/${encodeURIComponent(name)}:optimize`, {
        method: 'POST',
        signal,
      }),
    destroy: (name, signal) =>
      client.request<void>(`/collections/${encodeURIComponent(name)}:destroy`, {
        method: 'POST',
        signal,
      }),
    addField: (name, body, signal) =>
      client.request<CollectionSummary>(`/collections/${encodeURIComponent(name)}/fields`, {
        method: 'POST',
        body,
        signal,
      }),
    dropField: (name, field, signal) =>
      client.request<CollectionSummary>(
        `/collections/${encodeURIComponent(name)}/fields/${encodeURIComponent(field)}`,
        { method: 'DELETE', signal },
      ),
    renameField: (name, field, body, signal) =>
      client.request<CollectionSummary>(
        `/collections/${encodeURIComponent(name)}/fields/${encodeURIComponent(field)}`,
        { method: 'PATCH', body, signal },
      ),
    createIndex: (name, body, signal) =>
      client.request<CollectionSummary>(`/collections/${encodeURIComponent(name)}/indexes`, {
        method: 'POST',
        body,
        signal,
      }),
    dropIndex: (name, vectorField, signal) =>
      client.request<CollectionSummary>(
        `/collections/${encodeURIComponent(name)}/indexes/${encodeURIComponent(vectorField)}`,
        { method: 'DELETE', signal },
      ),
    createScalarIndex: (name, field, body, signal) =>
      client.request<CollectionSummary>(
        `/collections/${encodeURIComponent(name)}/fields/${encodeURIComponent(field)}/index`,
        { method: 'POST', body: body ?? {}, signal },
      ),
    dropScalarIndex: (name, field, signal) =>
      client.request<CollectionSummary>(
        `/collections/${encodeURIComponent(name)}/fields/${encodeURIComponent(field)}/index`,
        { method: 'DELETE', signal },
      ),
    listRecent: (signal) =>
      client.request<RecentCollectionListResponse>('/collections/recent', { signal }),
    forgetRecent: (body, signal) =>
      client.request<void>('/collections/recent:forget', {
        method: 'POST',
        body,
        signal,
      }),
    clearRecent: (signal) =>
      client.request<void>('/collections/recent', { method: 'DELETE', signal }),
    importCollection: (body, signal) =>
      client.request<CollectionImportResponse>('/collections:import', {
        method: 'POST',
        body,
        signal,
      }),
  };
}
