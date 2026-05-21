import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ToastProvider } from '@/components/ui';
import { AppShell } from './AppShell';
import i18n, { initI18n } from '@/i18n';
import { ApiClientProvider } from '@/lib/api-client-provider';
import type { ApiClient } from '@/lib/api-client';

initI18n();

function makeFakeApiClient(): ApiClient {
  return {
    baseUrl: 'http://127.0.0.1/api/v1',
    request: async <T,>(): Promise<T> => ({ items: [] } as unknown as T),
  };
}

function renderShell(initialPath: string = '/'): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <ToastProvider>
        <ApiClientProvider client={makeFakeApiClient()}>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={[initialPath]}>
              <Routes>
                <Route path="/" element={<AppShell />}>
                  <Route index element={<div data-testid="child">root</div>} />
                </Route>
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </ApiClientProvider>
      </ToastProvider>
    </I18nextProvider>,
  );
}

describe('AppShell', () => {
  it('renders the brand and outlet content', () => {
    renderShell('/');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toHaveTextContent('root');
  });

  it('renders the sidebar with app name', () => {
    renderShell('/');
    expect(screen.getAllByText('Zvec Studio').length).toBeGreaterThanOrEqual(1);
  });
});
