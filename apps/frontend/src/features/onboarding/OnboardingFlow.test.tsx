import { describe, expect, it, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';

import { renderWithProviders, TEST_API_BASE } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { OnboardingFlow } from './OnboardingFlow';
import { ONBOARDING_STORAGE_KEY, useOnboarding } from './hooks';

function Harness(): JSX.Element {
  const onboarding = useOnboarding();
  return <OnboardingFlow open={onboarding.open} onDismiss={onboarding.dismiss} />;
}

/**
 * In-memory ApiClient stub that handles only the recent-collections endpoints
 * exercised by the onboarding flow. Anything else throws so a stray request
 * fails fast instead of hitting the real network from jsdom.
 */
function makeFakeApiClient(
  recent: ReadonlyArray<{ path: string; lastOpenedAt: string }>,
): ApiClient {
  return {
    baseUrl: TEST_API_BASE,
    request: async <T,>(path: string): Promise<T> => {
      if (path === '/collections/recent') {
        return { items: recent } as unknown as T;
      }
      if (path === '/collections/recent:forget') {
        return undefined as unknown as T;
      }
      throw new Error(`unexpected request: ${path}`);
    },
  };
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

describe('OnboardingFlow', () => {
  beforeEach(() => {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  });

  it('auto-opens for first-time visitors and walks through 5 steps', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, {
      apiClient: makeFakeApiClient([]),
      queryClient: makeQueryClient(),
    });

    await screen.findByTestId('zv-onboarding');
    expect(screen.getByTestId('zv-onboarding-step-0')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-next'));
    expect(screen.getByTestId('zv-onboarding-step-1')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-next'));
    expect(screen.getByTestId('zv-onboarding-step-2')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-next'));
    expect(screen.getByTestId('zv-onboarding-step-3')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-next'));
    expect(screen.getByTestId('zv-onboarding-step-4')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-next'));

    await waitFor(() => {
      expect(screen.queryByTestId('zv-onboarding')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('1');
  });

  it('skips the flow and stamps localStorage so it never reopens', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, {
      apiClient: makeFakeApiClient([]),
      queryClient: makeQueryClient(),
    });

    await screen.findByTestId('zv-onboarding');
    await user.click(screen.getByTestId('zv-onboarding-skip'));

    await waitFor(() => {
      expect(screen.queryByTestId('zv-onboarding')).not.toBeInTheDocument();
    });
    expect(window.localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('1');
  });

  it('does not open when the user has already completed onboarding', () => {
    window.localStorage.setItem(ONBOARDING_STORAGE_KEY, '1');
    renderWithProviders(<Harness />, {
      apiClient: makeFakeApiClient([]),
      queryClient: makeQueryClient(),
    });
    expect(screen.queryByTestId('zv-onboarding')).not.toBeInTheDocument();
  });

  it('lists recently-opened collections on the first step and forgets one on click', async () => {
    const user = userEvent.setup();
    const recent = [
      { path: '/tmp/alpha', lastOpenedAt: '2026-05-12T10:00:00Z' },
      { path: '/tmp/beta', lastOpenedAt: '2026-05-11T08:00:00Z' },
    ];
    const apiClient = makeFakeApiClient(recent);
    const requestSpy = vi.spyOn(apiClient, 'request');

    renderWithProviders(<Harness />, {
      apiClient,
      queryClient: makeQueryClient(),
    });

    expect(
      await screen.findByTestId('zv-onboarding-recent-item-/tmp/alpha'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('zv-onboarding-recent-item-/tmp/beta'),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-onboarding-recent-forget-/tmp/alpha'));

    await waitFor(() => {
      const calls = requestSpy.mock.calls.map((c) => c[0]);
      expect(calls).toContain('/collections/recent:forget');
    });
  });
});
