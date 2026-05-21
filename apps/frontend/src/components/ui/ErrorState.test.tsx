import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api-client';
import { renderWithProviders } from '@/test-utils/render';

import { ErrorState } from './ErrorState';

describe('ErrorState', () => {
  it('renders a localized title from an ApiError and exposes trace id', () => {
    const apiError = new ApiError({
      code: 'INVALID_FILTER_EXPRESSION',
      messageKey: 'errors.code.INVALID_FILTER_EXPRESSION',
      message: 'bad filter',
      status: 400,
      traceId: 'trace-xyz',
      severity: 'warning',
    });
    renderWithProviders(<ErrorState error={apiError} testId="zv-ut-error" />);

    const root = screen.getByTestId('zv-ut-error');
    expect(root).toHaveTextContent(/filter expression is invalid/i);
    expect(screen.getByTestId('zv-ut-error-trace')).toHaveTextContent('trace-xyz');
  });

  it('falls back to errors.unknown for generic errors', () => {
    renderWithProviders(<ErrorState error={new Error('boom')} testId="zv-ut-error2" />);
    expect(screen.getByTestId('zv-ut-error2')).toHaveTextContent(/something went wrong/i);
  });

  it('triggers onRetry when the retry button is clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    renderWithProviders(
      <ErrorState error={new Error('boom')} onRetry={onRetry} testId="zv-ut-error3" />,
    );
    await user.click(screen.getByTestId('zv-ut-error3-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
