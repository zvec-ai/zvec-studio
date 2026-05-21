/**
 * Public surface of the documents feature module.
 */
export { createDocumentsApi } from './api';
export type {
  DocumentBatchDeleteRequest,
  DocumentBatchDeleteResponse,
  DocumentBrowseRequest,
  DocumentBrowseResponse,
  DocumentDeleteByFilterRequest,
  DocumentDeleteByFilterResponse,
  DocumentInsertRequest,
  DocumentInsertResponse,
  DocumentRecord,
  DocumentUpdateRequest,
  DocumentUpdateResponse,
  DocumentUpsertRequest,
  DocumentUpsertResponse,
  DocumentsApi,
} from './api';

export {
  documentsBrowseQueryKey,
  documentDetailQueryKey,
  useDocumentsBrowse,
  useDocumentDetail,
  useInsertDocuments,
  useDeleteDocument,
  useDeleteDocumentsBatch,
  useDeleteDocumentsByFilter,
  useUpdateDocuments,
  useUpsertDocuments,
} from './hooks';
