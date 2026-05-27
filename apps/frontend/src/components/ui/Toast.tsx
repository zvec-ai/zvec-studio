/**
 * Global Toast centre.
 *
 * Pattern:
 *  - ``<ToastProvider>`` wraps the app and renders a fixed viewport.
 *  - ``useToast()`` (see ``toast-context.ts``) returns ``push`` / ``dismiss``.
 *  - The QueryClient factory calls ``push`` from its onError sink.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import type { ErrorSeverity } from '@/lib/error-mapper';
import { CloseButton } from './CloseButton';

import './Toast.css';
import {
  ToastContext,
  type ToastContextValue,
  type ToastDescriptor,
} from './toast-context';

const DEFAULT_TTL: Record<ErrorSeverity, number | null> = {
  info: 3_500,
  success: 5_000,
  warning: 5_000,
  error: 7_000,
};

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastDescriptor[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string): void => {
    setItems((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<ToastContextValue['push']>(
    (toast) => {
      const id = toast.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const ttl = toast.ttl ?? DEFAULT_TTL[toast.severity];
      setItems((prev) => [...prev, { ...toast, id }]);
      if (ttl !== null) {
        const timer = setTimeout(() => dismiss(id), ttl);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const ref = timers.current;
    return () => {
      ref.forEach(clearTimeout);
      ref.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ push, dismiss, items }),
    [push, dismiss, items],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="zv-toast-viewport" role="region" aria-label={t('components.toast.notifications')}>
        {items.map((toast) => (
          <div
            key={toast.id}
            className={`zv-toast zv-toast--${toast.severity}`}
            role={toast.severity === 'error' ? 'alert' : 'status'}
            data-testid="zv-toast"
          >
            <div className="zv-toast__title">{toast.title}</div>
            {toast.description && <div className="zv-toast__body">{toast.description}</div>}
            <CloseButton
              className="zv-toast__close"
              aria-label={t('components.toast.dismiss')}
              onClick={() => dismiss(toast.id)}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
