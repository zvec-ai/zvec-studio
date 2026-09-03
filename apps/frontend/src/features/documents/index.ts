/**
 * Public surface of the documents feature module.
 */
export { buildExportUrl, createDocumentsApi } from './api';
export type { ExportOptions } from './api';
export type {
  DocumentBatchDeleteRequest,
  DocumentBatchDeleteResponse,
  DocumentBrowseRequest,
  DocumentBrowseResponse,
  DocumentDeleteByFilterRequest,
  DocumentDeleteByFilterResponse,
  DocumentImportRequest,
  DocumentImportResponse,
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
  useImportDocuments,
  useUpdateDocuments,
  useUpsertDocuments,
} from './hooks';
