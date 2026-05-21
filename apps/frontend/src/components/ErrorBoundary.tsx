/**
 * Top-level React error boundary.
 *
 * Catches synchronous render/commit errors in any subtree and shows a friendly
 * 500 page with a retry affordance. Paired with TanStack Query's own error
 * handling the app is resilient to both unhandled exceptions and async API
 * failures.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { withTranslation, type WithTranslation } from 'react-i18next';

import { Button } from './ui/Button';
import { EmptyState } from './ui/EmptyState';

import './ErrorBoundary.css';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Optional override so unit tests can inspect the rendered fallback. */
  readonly testId?: string;
  /** Called once per caught error; useful for telemetry. */
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
}

interface InnerProps extends ErrorBoundaryProps, WithTranslation {}

interface State {
  readonly error: Error | null;
}

class ErrorBoundaryInner extends Component<InnerProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (this.props.onError) {
      this.props.onError(error, info);
    }
    if (typeof console !== 'undefined' && console.error) {
      console.error('[ErrorBoundary]', error, info);
    }
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    if (typeof window !== 'undefined' && window.location) {
      window.location.reload();
    }
  };

  override render(): ReactNode {
    const { error } = this.state;
    const { t, children, testId } = this.props;
    if (!error) return <>{children}</>;

    return (
      <div className="zv-error-boundary" data-testid={testId ?? 'zv-error-boundary'}>
        <EmptyState
          title={t('pages.errorBoundary.title')}
          description={t('pages.errorBoundary.body')}
          testId="zv-error-boundary-card"
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={this.handleReset}>
                {t('pages.errorBoundary.dismiss')}
              </Button>
              <Button variant="primary" size="sm" onClick={this.handleReload}>
                {t('pages.errorBoundary.reload')}
              </Button>
            </>
          }
        />
        <details className="zv-error-boundary__details">
          <summary>{t('pages.errorBoundary.detailsSummary')}</summary>
          <pre data-testid="zv-error-boundary-message">{error.message}</pre>
        </details>
      </div>
    );
  }
}

export const ErrorBoundary = withTranslation()(ErrorBoundaryInner);
