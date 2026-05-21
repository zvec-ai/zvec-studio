/**
 * DirectoryPickerDialog: a modal browser for the host filesystem.
 *
 * The browser's native ``showDirectoryPicker`` only returns the leaf name
 * (W3C File System Access spec); for a local-first tool that needs an
 * absolute storage path we fall back to ``GET /fs/list`` on the backend
 * (which lives on the same machine as the user) and render an in-app
 * navigator. The selected absolute path is returned via ``onSelect``.
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

export interface DirectoryPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSelect: (absolutePath: string) => void;
  /** Optional initial path. Defaults to the user's home (server-resolved). */
  readonly initialPath?: string;
  readonly title?: string;
}

export function DirectoryPickerDialog({
  open,
  onClose,
  onSelect,
  initialPath,
  title,
}: DirectoryPickerDialogProps): JSX.Element {
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
        const next = await fsApi.list({ path, signal: controller.signal });
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
    [fsApi, t],
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

  function handleSelect(): void {
    if (!listing) return;
    onSelect(draft || listing.path);
    onClose();
  }

  function handleGo(): void {
    if (!draft || draft === listing?.path) return;
    void load(draft);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? t('components.directoryPicker.title')}
      ariaLabel={title ?? t('components.directoryPicker.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="zv-dirpicker-cancel">
            {t('components.directoryPicker.cancel')}
          </Button>
          <Button
            onClick={handleSelect}
            disabled={loading || !listing}
            data-testid="zv-dirpicker-select"
          >
            {t('components.directoryPicker.select')}
          </Button>
        </>
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
            aria-label={t('components.directoryPicker.pathLabel')}
            data-testid="zv-dirpicker-path"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleGo}
            disabled={loading || draft === listing?.path}
            data-testid="zv-dirpicker-go"
          >
            {t('components.directoryPicker.go')}
          </Button>
        </div>

        <div className="zv-dirpicker__shortcuts">
          {listing?.home && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(listing.home)}
              data-testid="zv-dirpicker-home"
            >
              {t('components.directoryPicker.home')}
            </Button>
          )}
          {listing?.parent && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load(listing.parent ?? undefined)}
              data-testid="zv-dirpicker-parent"
            >
              {t('components.directoryPicker.parent')}
            </Button>
          )}
        </div>

        {loading && (
          <div className="zv-dirpicker__loading">
            <Spinner />
          </div>
        )}

        {error && !loading && (
          <p className="zv-dirpicker__error" role="alert" data-testid="zv-dirpicker-error">
            {error}
          </p>
        )}

        {!loading && !error && listing && (
          <ul className="zv-dirpicker__entries" data-testid="zv-dirpicker-entries">
            {listing.entries.length === 0 && (
              <li className="zv-dirpicker__empty">
                {t('components.directoryPicker.empty')}
              </li>
            )}
            {listing.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="zv-dirpicker__entry"
                  onClick={() => void load(entry.path)}
                  onDoubleClick={() => {
                    setDraft(entry.path);
                  }}
                  data-testid={`zv-dirpicker-entry-${entry.name}`}
                >
                  <span aria-hidden>📁</span>
                  <span>{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
