/**
 * ApiClient context value + hook.
 *
 * Kept in a plain ``.ts`` module (no JSX) so react-refresh/only-export-components
 * does not flag the co-located ``ApiClientProvider`` component file.
 */
import { createContext, useContext } from 'react';

import type { ApiClient } from './api-client';

export const ApiClientContext = createContext<ApiClient | null>(null);

export function useApiClient(): ApiClient {
  const ctx = useContext(ApiClientContext);
  if (!ctx) {
    throw new Error('useApiClient must be used inside an <ApiClientProvider>');
  }
  return ctx;
}
