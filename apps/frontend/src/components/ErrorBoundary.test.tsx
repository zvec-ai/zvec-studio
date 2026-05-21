import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';

import { ErrorBoundary } from './ErrorBoundary';

function Boom({ explode }: { explode: boolean }): JSX.Element {
  if (explode) {
    throw new Error('kaboom');
  }
  return <span>safe</span>;
}

describe('ErrorBoundary', () => {
  // Silence the expected React error log during these tests.
  const originalError = console.error;
  beforeEach(() => {
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalError;
  });

  it('renders children when there is no error', () => {
    renderWithProviders(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('safe')).toBeInTheDocument();
  });

  it('catches a thrown error and renders the fallback', () => {
    renderWithProviders(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('zv-error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('zv-error-boundary-message')).toHaveTextContent('kaboom');
  });

  it('resets when the user clicks dismiss', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <ErrorBoundary>
        <Boom explode />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('zv-error-boundary')).toBeInTheDocument();

    // Swap children FIRST so that when the boundary resets it re-renders a safe tree.
    rerender(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    // Still showing the fallback because state.error has not been cleared yet.
    expect(screen.getByTestId('zv-error-boundary')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.getByText('safe')).toBeInTheDocument();
  });
});
