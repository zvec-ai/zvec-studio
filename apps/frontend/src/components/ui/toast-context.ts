/**
 * Toast context and ``useToast`` hook.
 *
 * Kept separate from ``Toast.tsx`` so the component file only exports React
 * components (keeps react-refresh happy and avoids mixed-export warnings).
 */
import { createContext, useContext } from 'react';

import type { ErrorSeverity } from '@/lib/error-mapper';

export interface ToastDescriptor {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly severity: ErrorSeverity;
  /** Milliseconds before auto-dismiss; ``null`` disables the timer. */
  readonly ttl?: number | null;
}

export interface ToastContextValue {
  push(toast: Omit<ToastDescriptor, 'id'> & { id?: string }): string;
  dismiss(id: string): void;
  readonly items: ReadonlyArray<ToastDescriptor>;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return ctx;
}
