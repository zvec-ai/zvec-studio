/**
 * Modal Dialog using the native ``<dialog>`` element.
 *
 * Using the HTML5 element gives us focus trap, escape-to-close and backdrop
 * for free without pulling in a full headless-UI dependency.
 */
import { useEffect, useRef, type ReactNode } from 'react';

import './Dialog.css';

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title?: string;
  readonly ariaLabel?: string;
  readonly size?: 'default' | 'wide';
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Dialog({ open, onClose, title, ariaLabel, size = 'default', children, footer }: DialogProps): JSX.Element | null {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    // jsdom lacks the native HTML <dialog> APIs, so we feature-detect both
    // ``showModal`` and ``close`` and fall back to the ``open`` attribute.
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        dialog.setAttribute('open', '');
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handleCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', handleCancel);
    return () => {
      dialog.removeEventListener('cancel', handleCancel);
    };
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={`zv-dialog${size === 'wide' ? ' zv-dialog--wide' : ''}`}
      aria-label={ariaLabel ?? title}
      aria-modal="true"
      role="dialog"
    >
      <div className="zv-dialog__panel">
        {title && <h2 className="zv-dialog__title">{title}</h2>}
        <div className="zv-dialog__body">{children}</div>
        {footer && <footer className="zv-dialog__footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
