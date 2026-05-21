/**
 * ApiClient provider component.
 *
 * If ``client`` is omitted a default one targeting ``/api/v1`` is constructed;
 * tests normally inject their own.
 */
import { type ReactNode } from 'react';

import { createApiClient, type ApiClient } from './api-client';
import { ApiClientContext } from './api-client-context';

export interface ApiClientProviderProps {
  readonly client?: ApiClient;
  readonly children: ReactNode;
}

export function ApiClientProvider({ client, children }: ApiClientProviderProps): JSX.Element {
  const value = client ?? createApiClient();
  return <ApiClientContext.Provider value={value}>{children}</ApiClientContext.Provider>;
}
