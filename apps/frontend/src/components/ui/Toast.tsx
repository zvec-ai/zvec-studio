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
import { createPortal } from 'react-dom';
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

function resolveToastHost(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const openDialogs = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'));
  return openDialogs.at(-1) ?? document.body;
}

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

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(() => resolveToastHost());

  const refreshHost = useCallback(() => {
    const nextHost = resolveToastHost();
    setPortalHost((prev) => (prev === nextHost ? prev : nextHost));
  }, []);

  useEffect(() => {
    refreshHost();
  }, [items.length, refreshHost]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('zv-dialog-stack-change', refreshHost);
    return () => {
      window.removeEventListener('zv-dialog-stack-change', refreshHost);
    };
  }, [refreshHost]);

  // Keep the toast viewport in the browser top layer. Re-showing when a toast
  // arrives moves it above any modal dialog that was opened after app mount.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof el.showPopover !== 'function') return;
    const isOpen = el.matches(':popover-open');
    try {
      if (items.length === 0) {
        if (isOpen && typeof el.hidePopover === 'function') el.hidePopover();
        return;
      }
      if (isOpen && typeof el.hidePopover === 'function') el.hidePopover();
      el.showPopover();
    } catch {
      // Already showing, unsupported, or blocked by the current browser state.
    }
  }, [items.length, portalHost]);

  const viewport = (
    <div
      ref={viewportRef}
      className="zv-toast-viewport"
      role="region"
      aria-label={t('components.toast.notifications')}
      // @ts-expect-error -- popover is valid HTML but not yet in React's type defs
      popover="manual"
    >
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
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {portalHost ? createPortal(viewport, portalHost) : viewport}
    </ToastContext.Provider>
  );
}
