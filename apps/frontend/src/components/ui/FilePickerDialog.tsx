/**
 * FilePickerDialog: a modal browser for picking a *file* on the host
 * filesystem (the import source).
 *
 * Built on the same ``GET /fs/list`` backend endpoint as the directory
 * picker, but requests ``includeFiles=true`` so files appear alongside
 * directories. Directories navigate on click; files select on click.
 * An optional comma-separated ``extensions`` filter narrows the listed
 * files (directories are never filtered, they are needed for navigation).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { Spinner } from './Spinner';
import { useApiClient } from '@/lib/api-client-context';
import { ApiError } from '@/lib/api-client';
import { createFsApi, type FsListing } from '@/lib/fs-api';

import './DirectoryPickerDialog.css';

export interface FilePickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (absolutePath: string) => void;
  /** Optional initial directory. Defaults to the user's home. */
  readonly initialPath?: string;
  /** Comma-separated extension filter, e.g. ``'.jsonl,.tar.gz'``. */
  readonly extensions?: string;
  readonly title?: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilePickerDialog({
  open,
  onClose,
  onSelect,
  initialPath,
  extensions,
  title,
}: FilePickerDialogProps): JSX.Element {
  const { t } = useTranslation();
  const apiClient = useApiClient();
  const fsApi = createFsApi(apiClient);

  const [listing, setListing] = useState<FsListing | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (path: string | undefined): Promise<void> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(null);
      try {
        const next = await fsApi.list({
          path,
          includeFiles: true,
          extensions,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setListing(next);
        setDraft(next.path);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) {
          setError(t(err.error.messageKey, { defaultValue: err.error.message }));
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError(String(err));
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [fsApi, t, extensions],
  );

  useEffect(() => {
    if (open) {
      void load(initialPath);
    }
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleGo(): void {
    if (!draft || draft === listing?.path) return;
    void load(draft);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? t('components.filePicker.title')}
      ariaLabel={title ?? t('components.filePicker.title')}
      footer={
        <Button variant="ghost" onClick={onClose} data-testid="zv-filepicker-cancel">
          {t('components.filePicker.cancel')}
        </Button>
      }
    >
      <div className="zv-dirpicker">
        <div className="zv-dirpicker__path-row">
          <input
            className="zv-input zv-dirpicker__path-input"
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleGo();
              }
            }}
            aria-label={t('components.filePicker.pathLabel')}
            data-testid="zv-filepicker-path"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGo}
            disabled={loading || draft === listing?.path}
            data-testid="zv-filepicker-go"
          >
            {t('components.filePicker.go')}
          </Button>
        </div>

        <div className="zv-dirpicker__shortcuts">
          {listing?.home && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(listing.home)}
              data-testid="zv-filepicker-home"
            >
              {t('components.filePicker.home')}
            </Button>
          )}
          {listing?.parent && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(listing.parent ?? undefined)}
              data-testid="zv-filepicker-parent"
            >
              {t('components.filePicker.parent')}
            </Button>
          )}
        </div>

        {loading && (
          <div className="zv-dirpicker__loading">
            <Spinner />
          </div>
        )}

        {error && !loading && (
          <p className="zv-dirpicker__error" role="alert" data-testid="zv-filepicker-error">
            {error}
          </p>
        )}

        {!loading && !error && listing && (
          <ul className="zv-dirpicker__entries" data-testid="zv-filepicker-entries">
            {listing.entries.length === 0 && (
              <li className="zv-dirpicker__empty">{t('components.filePicker.empty')}</li>
            )}
            {listing.entries.map((entry) =>
              entry.kind === 'dir' ? (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="zv-dirpicker__entry"
                    onClick={() => void load(entry.path)}
                    data-testid={`zv-filepicker-dir-${entry.name}`}
                  >
                    <span aria-hidden>📁</span>
                    <span>{entry.name}</span>
                  </button>
                </li>
              ) : (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="zv-dirpicker__entry"
                    onClick={() => {
                      onSelect(entry.path);
                      onClose();
                    }}
                    data-testid={`zv-filepicker-file-${entry.name}`}
                  >
                    <span aria-hidden>📄</span>
                    <span>{entry.name}</span>
                    <span className="zv-dirpicker__entry-size">{formatSize(entry.size)}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
