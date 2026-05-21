/**
 * Text input paired with a "Browse…" button that opens a directory picker.
 * Reuses the same label/helper/error slots as ``<Input>`` so feature forms
 * can swap them one-for-one.
 *
 * Picker selection is runtime-aware:
 * - **Tauri desktop**: native OS dialog via the dialog plugin → real
 *   absolute path.
 * - **Browser**: the W3C File System Access API only returns the leaf
 *   directory name and is therefore useless for absolute paths. We instead
 *   open a custom modal that calls the backend's ``GET /fs/list`` endpoint
 *   to navigate the host filesystem and return a real absolute path.
 */
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

import { Button } from './Button';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';
import { pickDirectoryNative, supportsNativeDirectoryPicker } from '@/lib/directory-picker';

import './DirectoryInput.css';
import './Input.css';

export interface DirectoryInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  readonly value: string;
  readonly onChange: (next: string) => void;
  /**
   * Optional callback invoked with the directory chosen via Browse (native
   * dialog or the in-app picker). When provided, the picker result is sent to
   * `onBrowse` instead of `onChange`, letting the parent treat the picked
   * value as a *parent directory* rather than the final field value.
   */
  readonly onBrowse?: (picked: string) => void;
  readonly label?: ReactNode;
  readonly helperText?: ReactNode;
  readonly errorText?: ReactNode;
  readonly browseLabel?: ReactNode;
  readonly 'data-testid'?: string;
}

export const DirectoryInput = forwardRef<HTMLInputElement, DirectoryInputProps>(
  function DirectoryInput(
    {
      value,
      onChange,
      onBrowse,
      label,
      helperText,
      errorText,
      browseLabel = 'Browse…',
      className,
      id,
      disabled,
      'data-testid': testId,
      ...rest
    },
    ref,
  ) {
    const reactId = useId();
    const inputId = id ?? reactId;
    const describedById = `${inputId}-desc`;
    const isInvalid = Boolean(errorText);
    const native = supportsNativeDirectoryPicker();
    const [pickerOpen, setPickerOpen] = useState<boolean>(false);

    const inputClasses = ['zv-input', isInvalid ? 'zv-input--invalid' : '', className ?? '']
      .filter(Boolean)
      .join(' ');

    function emitPicked(picked: string): void {
      if (onBrowse) onBrowse(picked);
      else onChange(picked);
    }

    async function onBrowseClick(): Promise<void> {
      if (native) {
        const result = await pickDirectoryNative();
        if (result.kind === 'picked') emitPicked(result.path);
        return;
      }
      // Web: open the in-app browser-side picker (backed by /fs/list).
      setPickerOpen(true);
    }

    return (
      <div className="zv-input-field zv-directory-input">
        {label !== undefined && (
          <label htmlFor={inputId} className="zv-input-field__label">
            {label}
          </label>
        )}
        <div className="zv-directory-input__row">
          <input
            ref={ref}
            id={inputId}
            {...rest}
            className={inputClasses}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={isInvalid || undefined}
            aria-describedby={
              errorText || helperText ? describedById : rest['aria-describedby']
            }
            disabled={disabled}
            data-testid={testId}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void onBrowseClick()}
            disabled={disabled}
            data-testid={testId ? `${testId}-browse` : undefined}
          >
            {browseLabel}
          </Button>
        </div>
        {(errorText || helperText) && (
          <p
            id={describedById}
            className={errorText ? 'zv-input-field__error' : 'zv-input-field__helper'}
            role={errorText ? 'alert' : undefined}
          >
            {errorText ?? helperText}
          </p>
        )}
        <DirectoryPickerDialog
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={(picked) => emitPicked(picked)}
          initialPath={value || undefined}
        />
      </div>
    );
  },
);
