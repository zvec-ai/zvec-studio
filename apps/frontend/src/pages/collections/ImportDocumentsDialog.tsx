/**
 * Import Documents dialog.
 *
 * Drives ``POST /api/v1/collections/{name}/documents:import`` from a local
 * JSONL file path (Studio is local-first: the file lives on the same machine
 * as the backend, so no upload is needed). The user picks the file through
 * the in-app FilePickerDialog, chooses the write mode (replace = whole-doc
 * overwrite via upsert; insert = strict) and the error policy (abort / skip).
 *
 * Row-level failures come back in the 200 response body (partial-success
 * semantics), so the dialog renders a result panel instead of treating a
 * non-zero ``failed`` count as an error.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, FilePickerDialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import { useImportDocuments, type DocumentImportResponse } from '@/features/documents';

import './ImportDocumentsDialog.css';

export interface ImportDocumentsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly collection: string;
}

const IMPORT_EXTENSIONS = '.jsonl,.ndjson';

export function ImportDocumentsDialog({
  open,
  onClose,
  collection,
}: ImportDocumentsDialogProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useImportDocuments(collection);

  const [filePath, setFilePath] = useState<string>('');
  const [mode, setMode] = useState<'replace' | 'insert'>('replace');
  const [onError, setOnError] = useState<'abort' | 'skip'>('abort');
  const [pickerOpen, setPickerOpen] = useState<boolean>(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [report, setReport] = useState<DocumentImportResponse | null>(null);

  // Reset the form whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFilePath('');
    setMode('replace');
    setOnError('abort');
    setRequestError(null);
    setReport(null);
  }, [open]);

  function close(): void {
    if (mutation.isPending) return;
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setRequestError(null);
    if (!filePath.trim()) return;
    try {
      const res = await mutation.mutateAsync({
        source: { kind: 'localPath', path: filePath.trim() },
        mode,
        onError,
      });
      setReport(res);
      const allOk = res.failed === 0 && !res.aborted;
      toast.push({
        severity: allOk ? 'success' : 'warning',
        title: t('pages.collections.detail.documentsPanel.import.resultTitle', {
          imported: res.imported,
          failed: res.failed,
        }),
      });
      if (allOk) {
        onClose();
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setRequestError(err.error.message);
        toast.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        setRequestError(err instanceof Error ? err.message : String(err));
        toast.push({
          title: t('errors.unknown'),
          severity: 'error',
        });
      }
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={close}
        title={t('pages.collections.detail.documentsPanel.import.title')}
        ariaLabel={t('pages.collections.detail.documentsPanel.import.title')}
        footer={
          report ? (
            <Button onClick={onClose} data-testid="zv-import-done">
              {t('pages.collections.detail.documentsPanel.import.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close} data-testid="zv-import-cancel">
                {t('pages.collections.detail.documentsPanel.import.cancel')}
              </Button>
              <Button
                type="submit"
                form="zv-import-form"
                disabled={mutation.isPending || !filePath.trim()}
                data-testid="zv-import-submit"
              >
                {mutation.isPending
                  ? t('pages.collections.detail.documentsPanel.import.submitting')
                  : t('pages.collections.detail.documentsPanel.import.submit')}
              </Button>
            </>
          )
        }
      >
        {report ? (
          <div data-testid="zv-import-report">
            <p className="zv-import-dialog__summary">
              {t('pages.collections.detail.documentsPanel.import.reportSummary', {
                imported: report.imported,
                failed: report.failed,
                total: report.totalLines,
              })}
              {report.durationMs != null
                ? ` · ${t('pages.collections.detail.documentsPanel.import.duration', {
                    seconds: (report.durationMs / 1000).toFixed(1),
                  })}`
                : ''}
              {report.aborted
                ? ` · ${t(
                    mode === 'replace'
                      ? 'pages.collections.detail.documentsPanel.import.abortedReplace'
                      : 'pages.collections.detail.documentsPanel.import.abortedInsert',
                  )}`
                : ''}
            </p>
            {report.errors.length > 0 && (
              <div className="zv-import-dialog__errors" data-testid="zv-import-errors">
                <p className="zv-import-dialog__errors-caption">
                  {t('pages.collections.detail.documentsPanel.import.errorsCaption')}
                  {report.errorsTruncated
                    ? ` ${t('pages.collections.detail.documentsPanel.import.errorsTruncated')}`
                    : ''}
                </p>
                <ul>
                  {report.errors.map((e) => (
                    <li key={`${e.line}-${e.code}`}>
                      <code>{e.line}</code> <code>{e.code}</code> {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <form id="zv-import-form" onSubmit={submit}>
            <Input
              label={t('pages.collections.detail.documentsPanel.import.fileLabel')}
              value={filePath}
              onChange={(e) => {
                setFilePath(e.target.value);
                setRequestError(null);
              }}
              helperText={t('pages.collections.detail.documentsPanel.import.fileHelp')}
              errorText={requestError ?? undefined}
              data-testid="zv-import-path"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setPickerOpen(true)}
              data-testid="zv-import-browse"
            >
              {t('pages.collections.detail.documentsPanel.import.browse')}
            </Button>

            <fieldset className="zv-import-dialog__fieldset">
              <legend>{t('pages.collections.detail.documentsPanel.import.modeLabel')}</legend>
              <label>
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                />
                {t('pages.collections.detail.documentsPanel.import.modeReplace')}
              </label>
              <p className="zv-import-dialog__hint">
                {t('pages.collections.detail.documentsPanel.import.modeReplaceHelp')}
              </p>
              <label>
                <input
                  type="radio"
                  name="import-mode"
                  checked={mode === 'insert'}
                  onChange={() => setMode('insert')}
                />
                {t('pages.collections.detail.documentsPanel.import.modeInsert')}
              </label>
            </fieldset>

            <fieldset className="zv-import-dialog__fieldset">
              <legend>{t('pages.collections.detail.documentsPanel.import.onErrorLabel')}</legend>
              <label>
                <input
                  type="radio"
                  name="import-on-error"
                  checked={onError === 'abort'}
                  onChange={() => setOnError('abort')}
                />
                {t('pages.collections.detail.documentsPanel.import.onErrorAbort')}
              </label>
              <label>
                <input
                  type="radio"
                  name="import-on-error"
                  checked={onError === 'skip'}
                  onChange={() => setOnError('skip')}
                />
                {t('pages.collections.detail.documentsPanel.import.onErrorSkip')}
              </label>
            </fieldset>
          </form>
        )}
      </Dialog>

      <FilePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(p) => setFilePath(p)}
        extensions={IMPORT_EXTENSIONS}
        title={t('pages.collections.detail.documentsPanel.import.pickerTitle')}
      />
    </>
  );
}
