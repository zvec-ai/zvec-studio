/**
 * Application root.
 *
 * Wires up TanStack Query, Toast provider, React Router and i18n, plus the
 * ``ApiClientProvider`` so feature hooks can resolve the transport.
 *
 * We use the declarative ``<Routes>`` API via ``BrowserRouter``/``MemoryRouter``
 * rather than ``createBrowserRouter``/``createMemoryRouter`` because the latter
 * triggers a ``fetch``-based navigation path that fails under jsdom + undici in
 * tests (AbortSignal brand mismatch). Loader/action features are not needed for
 * the MVP; TanStack Query owns page-level data fetching.
 */
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider, useTranslation } from 'react-i18next';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ToastProvider, useToast } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ApiError, createApiClient, resolveApiBaseUrl, getResolvedApiBaseUrl, type ApiClient } from '@/lib/api-client';
import { ApiClientProvider } from '@/lib/api-client-provider';
import { createQueryClient } from '@/lib/query-client';
import i18n, { initI18n } from '@/i18n';
import { AppRoutes } from '@/router/routes';

import './styles/tokens.css';

initI18n();

export interface AppProps {
  readonly initialEntries?: ReadonlyArray<string>;
  readonly apiClient?: ApiClient;
}

export function App({ initialEntries, apiClient }: AppProps = {}): JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    resolveApiBaseUrl().then(() => setReady(true));
  }, []);

  if (!ready && !apiClient) return <></>;

  return (
    <I18nextProvider i18n={i18n}>
      <ErrorBoundary>
        <ToastProvider>
          <ApiClientProvider client={apiClient ?? createApiClient({ baseUrl: getResolvedApiBaseUrl() })}>
            <QueryShell>
              {initialEntries ? (
                <MemoryRouter initialEntries={[...initialEntries]}>
                  <AppRoutes />
                </MemoryRouter>
              ) : (
                <BrowserRouter>
                  <AppRoutes />
                </BrowserRouter>
              )}
            </QueryShell>
          </ApiClientProvider>
        </ToastProvider>
      </ErrorBoundary>
    </I18nextProvider>
  );
}

function QueryShell({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();

  const clientRef = useRef<ReturnType<typeof createQueryClient> | null>(null);
  if (!clientRef.current) {
    clientRef.current = createQueryClient({
      onError: (err: unknown) => {
        if (err instanceof ApiError) {
          toast.push({
            title: t(err.error.messageKey, { defaultValue: err.error.message }),
            description: err.error.traceId ?? undefined,
            severity: err.error.severity,
          });
          return;
        }
        toast.push({
          title: t('errors.unknown'),
          severity: 'error',
        });
      },
    });
  }

  return <QueryClientProvider client={clientRef.current}>{children}</QueryClientProvider>;
}

export default App;
