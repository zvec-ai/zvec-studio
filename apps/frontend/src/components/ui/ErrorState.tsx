/**
 * Generic error-state block.
 *
 * Consumes either a raw ``ApiError`` (preferred) or any ``Error`` instance and
 * renders a localized title, description and a retry action. The trace-id is
 * exposed in a details section so support can correlate logs.
 */
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';

import { ApiError } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';

import { Button } from './Button';

import './ErrorState.css';

export interface ErrorStateProps {
  readonly error: unknown;
  readonly title?: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly actions?: ReactNode;
  readonly testId?: string;
  readonly compact?: boolean;
}

function resolveUserFacing(error: unknown): UserFacingError | null {
  if (error instanceof ApiError) return error.error;
  return null;
}

export function ErrorState({
  error,
  title,
  onRetry,
  retryLabel,
  actions,
  testId,
  compact = false,
}: ErrorStateProps): JSX.Element {
  const { t } = useTranslation();
  const uf = resolveUserFacing(error);

  const resolvedTitle =
    title ??
    (uf
      ? t(uf.messageKey, { defaultValue: uf.message })
      : t('errors.unknown'));

  const description =
    uf && uf.code === 'NETWORK_ERROR' ? t('errors.network') : undefined;
  const traceId = uf?.traceId ?? null;

  const className = ['zv-error-state', compact ? 'zv-error-state--compact' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} role="alert" data-testid={testId}>
      <div className="zv-error-state__body">
        <h3 className="zv-error-state__title">{resolvedTitle}</h3>
        {description && <p className="zv-error-state__desc">{description}</p>}
        {traceId && (
          <p className="zv-error-state__trace">
            <span>trace-id:</span>{' '}
            <code data-testid={testId ? `${testId}-trace` : undefined}>{traceId}</code>
          </p>
        )}
      </div>
      <div className="zv-error-state__actions">
        {onRetry && (
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            data-testid={testId ? `${testId}-retry` : undefined}
          >
            {retryLabel ?? t('actions.retry')}
          </Button>
        )}
        {actions}
      </div>
    </div>
  );
}
