/**
 * Base button component.
 *
 * Three intents (``primary``, ``secondary``, ``ghost``) and two sizes cover
 * every control surface shipped in MVP. All visual state comes from CSS
 * variables in ``styles/tokens.css`` so dark mode and future theming just
 * work.
 */
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, type = 'button', children, ...rest },
  ref,
) {
  const classes = [
    'zv-btn',
    `zv-btn--${variant}`,
    `zv-btn--${size}`,
    loading ? 'zv-btn--loading' : '',
    rest.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      {...rest}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="zv-btn__spinner" aria-hidden="true" />}
      <span className="zv-btn__label">{children}</span>
    </button>
  );
});
