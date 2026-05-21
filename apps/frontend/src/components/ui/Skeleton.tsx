/**
 * Skeleton placeholder component.
 *
 * Rendered while async queries are loading. Three variants match the dominant
 * layouts in the app: single-line ``text``, ``block`` (card-like panels) and
 * ``table-rows`` for tabular data. All variants share the same pulse animation
 * driven from ``Skeleton.css``.
 */
import type { CSSProperties } from 'react';

import './Skeleton.css';

export type SkeletonVariant = 'text' | 'block' | 'table-rows';

export interface SkeletonProps {
  readonly variant?: SkeletonVariant;
  readonly rows?: number;
  readonly columns?: number;
  readonly width?: number | string;
  readonly height?: number | string;
  readonly testId?: string;
}

export function Skeleton({
  variant = 'text',
  rows = 3,
  columns = 3,
  width,
  height,
  testId,
}: SkeletonProps): JSX.Element {
  if (variant === 'table-rows') {
    return (
      <div
        className="zv-skeleton zv-skeleton--table"
        role="status"
        aria-busy="true"
        aria-live="polite"
        data-testid={testId}
      >
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div className="zv-skeleton__row" key={rowIndex}>
            {Array.from({ length: columns }).map((_, colIndex) => (
              <span className="zv-skeleton__cell" key={colIndex} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  const style: CSSProperties = {
    width: width ?? (variant === 'block' ? '100%' : '100%'),
    height: height ?? (variant === 'block' ? 96 : 14),
  };

  return (
    <span
      className={`zv-skeleton zv-skeleton--${variant}`}
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid={testId}
      style={style}
    />
  );
}
