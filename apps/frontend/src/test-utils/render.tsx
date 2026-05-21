/**
 * Test render helper.
 *
 * Wraps the subject tree in every Provider the app needs (i18n, Toast,
 * ApiClient, TanStack Query and Router) so individual tests only need to care
 * about the component they are exercising.
 *
 * A fresh ``QueryClient`` and ``ApiClient`` are created per render so tests do
 * not leak cache state across each other. When callers pass their own
 * ``apiClient`` the helper respects it verbatim; the default targets
 * ``http://127.0.0.1/api/v1`` which is the base URL the MSW handlers listen
 * on (see ``test-utils/msw-handlers.ts``).
 */
import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';

import { ToastProvider } from '@/components/ui';
import { ApiClientProvider } from '@/lib/api-client-provider';
import { createApiClient, type ApiClient } from '@/lib/api-client';
import { createQueryClient } from '@/lib/query-client';
import i18n, { initI18n } from '@/i18n';

initI18n();

/** Absolute base URL all MSW handlers + the default test ApiClient share. */
export const TEST_API_BASE = 'http://127.0.0.1/api/v1';

export interface RenderWithProvidersOptions {
  readonly initialEntries?: ReadonlyArray<string>;
  readonly apiClient?: ApiClient;
  readonly queryClient?: QueryClient;
}

export interface RenderWithProvidersResult extends RenderResult {
  readonly queryClient: QueryClient;
  readonly apiClient: ApiClient;
}

/**
 * Render ``ui`` inside the full provider stack.
 *
 * Returns the RTL handle augmented with the ``queryClient`` / ``apiClient``
 * that were used so tests can assert on cache state or inject request spies.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithProvidersResult {
  const apiClient = options.apiClient ?? createApiClient({ baseUrl: TEST_API_BASE });
  const queryClient =
    options.queryClient ??
    createQueryClient({
      // Swallow errors during tests so uncaught rejections do not fail the run;
      // individual tests still assert on UI-level outcomes.
      onError: () => undefined,
    });
  const initialEntries = [...(options.initialEntries ?? ['/'])];

  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      <I18nextProvider i18n={i18n}>
        <ToastProvider>
          <ApiClientProvider client={apiClient}>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
            </QueryClientProvider>
          </ApiClientProvider>
        </ToastProvider>
      </I18nextProvider>
    );
  }

  const rendered = render(ui, { wrapper: Wrapper });
  return { ...rendered, queryClient, apiClient };
}
