/** Loading spinner, reused by buttons, pages and the global ``<LoadingOverlay />``. */
import './Spinner.css';

export interface SpinnerProps {
  readonly size?: number;
  readonly ariaLabel?: string;
}

export function Spinner({ size = 16, ariaLabel = 'Loading' }: SpinnerProps): JSX.Element {
  return (
    <span
      className="zv-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label={ariaLabel}
    />
  );
}

export interface LoadingOverlayProps {
  readonly label?: string;
}

export function LoadingOverlay({ label = 'Loading…' }: LoadingOverlayProps): JSX.Element {
  return (
    <div className="zv-loading-overlay" role="status" aria-live="polite">
      <Spinner size={24} />
      <span className="zv-loading-overlay__label">{label}</span>
    </div>
  );
}
