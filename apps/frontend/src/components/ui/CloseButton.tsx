import type { ButtonHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import './CloseButton.css';

type CloseButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'>;

export function CloseButton({ className, ...props }: CloseButtonProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`zv-close-btn${className ? ` ${className}` : ''}`}
      aria-label={t('actions.remove')}
      {...props}
    >
      ×
    </button>
  );
}
