/**
 * Text input with label + helper/error slots.
 *
 * Composes a ``<label>`` wrapper around a styled ``<input>`` so feature code
 * can render a full form row in one component. Errors take precedence over
 * helper text; ``aria-invalid`` is set automatically when ``errorText`` is
 * present.
 */
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

import './Input.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly invalid?: boolean;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly errorText?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, label, helperText, errorText, className, id, ...rest },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const describedById = `${inputId}-desc`;
  const isInvalid = Boolean(invalid || errorText);

  const classes = ['zv-input', isInvalid ? 'zv-input--invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className="zv-input-field">
      {label !== undefined && (
        <label htmlFor={inputId} className="zv-input-field__label">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        {...rest}
        className={classes}
        aria-invalid={isInvalid || undefined}
        aria-describedby={errorText || helperText ? describedById : rest['aria-describedby']}
      />
      {(errorText || helperText) && (
        <p
          id={describedById}
          className={errorText ? 'zv-input-field__error' : 'zv-input-field__helper'}
          role={errorText ? 'alert' : undefined}
        >
          {errorText ?? helperText}
        </p>
      )}
    </div>
  );
});
