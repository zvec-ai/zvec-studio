/**
 * Native-select wrapper. Favouring the browser's native picker keeps the MVP
 * accessible out of the box; a richer combobox can replace this in M2.
 */
import { forwardRef, useId, type ReactNode, type SelectHTMLAttributes } from 'react';

import './Select.css';

export interface SelectOption<V extends string = string> {
  readonly value: V;
  readonly label: string;
}

export interface SelectProps<V extends string = string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'defaultValue'> {
  readonly options: ReadonlyArray<SelectOption<V>>;
  readonly value?: V;
  readonly defaultValue?: V;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly errorText?: ReactNode;
}

function SelectInner<V extends string = string>(
  { options, value, defaultValue, label, helperText, errorText, className, id, ...rest }: SelectProps<V>,
  ref: React.ForwardedRef<HTMLSelectElement>,
): JSX.Element {
  const reactId = useId();
  const selectId = id ?? reactId;
  const classes = ['zv-select', errorText ? 'zv-select--invalid' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const extra: Record<string, unknown> = {};
  if (value !== undefined) extra.value = value;
  if (defaultValue !== undefined) extra.defaultValue = defaultValue;
  return (
    <div className="zv-select-field">
      {label !== undefined && (
        <label htmlFor={selectId} className="zv-select-field__label">
          {label}
        </label>
      )}
      <select
        ref={ref}
        id={selectId}
        {...rest}
        {...extra}
        className={classes}
        aria-invalid={errorText ? true : undefined}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {(errorText || helperText) && (
        <p
          className={errorText ? 'zv-select-field__error' : 'zv-select-field__helper'}
          role={errorText ? 'alert' : undefined}
        >
          {errorText ?? helperText}
        </p>
      )}
    </div>
  );
}

export const Select = forwardRef(SelectInner) as <V extends string = string>(
  props: SelectProps<V> & { ref?: React.ForwardedRef<HTMLSelectElement> },
) => JSX.Element;
