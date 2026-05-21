/**
 * Generic empty-state illustration block.
 *
 * Used anywhere a list/collection has no data. Keeps the illustration, title,
 * description and call-to-action buttons in a consistent visual frame so the
 * whole app feels cohesive.
 */
import type { ReactNode } from 'react';

import './EmptyState.css';

export interface EmptyStateProps {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  actions,
  testId,
  compact = false,
}: EmptyStateProps): JSX.Element {
  const className = ['zv-empty-state', compact ? 'zv-empty-state--compact' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-testid={testId} role="status" aria-live="polite">
      {icon && (
        <div className="zv-empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h2 className="zv-empty-state__title">{title}</h2>
      {description && <p className="zv-empty-state__body">{description}</p>}
      {actions && <div className="zv-empty-state__actions">{actions}</div>}
    </div>
  );
}
