import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';

import { ToastProvider } from './Toast';
import { useToast } from './toast-context';

function Harness({
  children,
  onReady,
}: {
  children?: ReactNode;
  onReady: (toast: ReturnType<typeof useToast>) => void;
}): JSX.Element {
  const toast = useToast();
  onReady(toast);
  return <>{children}</>;
}

describe('ToastProvider / useToast', () => {
  it('pushes a toast and exposes it via role=alert for errors', () => {
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Harness onReady={(t) => { api = t; }} />
      </ToastProvider>,
    );
    act(() => {
      api!.push({ title: 'Something broke', severity: 'error', ttl: null });
    });
    const toast = screen.getByTestId('zv-toast');
    expect(toast).toHaveTextContent('Something broke');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('dismisses a toast when the close button is clicked', async () => {
    const user = userEvent.setup();
    let api: ReturnType<typeof useToast> | null = null;
    render(
      <ToastProvider>
        <Harness onReady={(t) => { api = t; }} />
      </ToastProvider>,
    );
    act(() => {
      api!.push({ title: 'FYI', severity: 'info', ttl: null });
    });
    expect(screen.getByTestId('zv-toast')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByTestId('zv-toast')).not.toBeInTheDocument();
  });

  it('throws when useToast is called outside a provider', () => {
    const BrokenConsumer = (): JSX.Element => {
      useToast();
      return <div />;
    };
    expect(() => render(<BrokenConsumer />)).toThrow(/ToastProvider/);
  });
});
