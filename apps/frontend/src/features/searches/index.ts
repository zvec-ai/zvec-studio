/**
 * Public surface of the searches feature module.
 */
export { createSearchesApi } from './api';
export type {
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchesApi,
} from './api';
export {
  useSearchDocuments,
  useSearchHistory,
  HISTORY_LIMIT,
  type SearchHistoryEntry,
  type UseSearchHistoryResult,
} from './hooks';
