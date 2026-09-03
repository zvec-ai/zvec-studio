/**
 * Export Documents dialog.
 *
 * Triggers a native browser download of ``GET /collections/{name}/documents:export``.
 * The response is a streamed JSONL file (constant-memory server side), so the
 * download MUST go through an anchor click — never ``fetch().blob()``, which
 * would buffer the whole body in memory (design doc §6.3).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { useApiClient } from '@/lib/api-client-context';
import { buildExportUrl } from '@/features/documents';
import type { CollectionSummary } from '@/features/collections';

import './ImportDocumentsDialog.css';

export interface ExportDocumentsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly collection: string;
  readonly schema: CollectionSummary['schema'];
}

export function ExportDocumentsDialog({
  open,
  onClose,
  collection,
  schema,
}: ExportDocumentsDialogProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const apiClient = useApiClient();

  const [includeVector, setIncludeVector] = useState<boolean>(true);
  const [includeFields, setIncludeFields] = useState<boolean>(true);
  const [mode, setMode] = useState<'data' | 'snapshot'>('data');
  const [selectedFields, setSelectedFields] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setIncludeVector(true);
    setIncludeFields(true);
    setMode('data');
    setSelectedFields(new Set());
  }, [open]);

  const scalarFields = schema.fields ?? [];
  const hasVectors = (schema.vectors ?? []).length > 0;
  // Options that have nothing to offer are hidden entirely (never rendered
  // disabled), so the visible help text always matches what can be done.
  const hasFields = scalarFields.length > 0;
  // Snapshot mode is all-or-nothing: its manifest must describe a collection
  // the packaged data can fully rebuild, so trimming options are disabled
  // there and apply to data exports only (the backend pre-check still
  // rejects partial API-built snapshots as a safety net).
  const full = mode === 'snapshot';
  // Exporting neither is allowed in data mode (a bare id list is a valid, if
  // niche, artifact) — the dialog just says what the file will contain.
  const bothExcluded = !full && !includeVector && !includeFields;

  function toggleField(name: string): void {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function startExport(): void {
    // Picked fields apply only to data exports that include scalars.
    const outputFields =
      !full && includeFields && selectedFields.size > 0 ? [...selectedFields] : undefined;
    const url = buildExportUrl(apiClient.baseUrl, collection, {
      includeVector: full || includeVector,
      includeFields: full || includeFields,
      outputFields,
      mode,
    });
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    toast.push({
      severity: 'info',
      title: t('pages.collections.detail.documentsPanel.export.startedTitle'),
      description: t('pages.collections.detail.documentsPanel.export.startedBody'),
    });
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pages.collections.detail.documentsPanel.export.title')}
      ariaLabel={t('pages.collections.detail.documentsPanel.export.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="zv-export-cancel">
            {t('pages.collections.detail.documentsPanel.export.cancel')}
          </Button>
          <Button onClick={startExport} data-testid="zv-export-submit">
            {t('pages.collections.detail.documentsPanel.export.submit')}
          </Button>
        </>
      }
    >
      <p className="zv-import-dialog__hint">
        {t('pages.collections.detail.documentsPanel.export.maintenanceHint')}
      </p>

      <fieldset className="zv-import-dialog__fieldset" data-testid="zv-export-mode">
        <legend>{t('pages.collections.detail.documentsPanel.export.modeLabel')}</legend>
        <label>
          <input
            type="radio"
            name="export-mode"
            checked={mode === 'data'}
            onChange={() => setMode('data')}
          />
          {t('pages.collections.detail.documentsPanel.export.modeData')}
        </label>
        <label>
          <input
            type="radio"
            name="export-mode"
            checked={mode === 'snapshot'}
            onChange={() => setMode('snapshot')}
            data-testid="zv-export-mode-snapshot"
          />
          {t('pages.collections.detail.documentsPanel.export.modeSnapshot')}
        </label>
        <p className="zv-import-dialog__hint">
          {t('pages.collections.detail.documentsPanel.export.modeHelp')}
        </p>
        {full && (
          <p className="zv-import-dialog__hint" data-testid="zv-export-snapshot-full-hint">
            {t('pages.collections.detail.documentsPanel.export.snapshotFullDataHint')}
          </p>
        )}
      </fieldset>

      {hasVectors && (
        <div className="zv-import-dialog__fieldset">
          <label>
            <input
              type="checkbox"
              checked={full || includeVector}
              disabled={full}
              onChange={(e) => setIncludeVector(e.target.checked)}
              data-testid="zv-export-include-vector"
            />
            {t('pages.collections.detail.documentsPanel.export.includeVector')}
          </label>
          <p className="zv-import-dialog__hint">
            {t('pages.collections.detail.documentsPanel.export.includeVectorHelp')}
          </p>
        </div>
      )}

      {hasFields && (
        <div className="zv-import-dialog__fieldset">
          <label>
            <input
              type="checkbox"
              checked={full || includeFields}
              disabled={full}
              onChange={(e) => setIncludeFields(e.target.checked)}
              data-testid="zv-export-include-fields"
            />
            {t('pages.collections.detail.documentsPanel.export.includeFields')}
          </label>
          <p className="zv-import-dialog__hint">
            {t('pages.collections.detail.documentsPanel.export.includeFieldsHelp')}
          </p>
        </div>
      )}

      {bothExcluded && (
        <p className="zv-import-dialog__hint" data-testid="zv-export-nothing-warning">
          {t('pages.collections.detail.documentsPanel.export.nothingSelectedWarning')}
        </p>
      )}

      {!full && includeFields && hasFields && (
        <fieldset className="zv-import-dialog__fieldset" data-testid="zv-export-fields">
          <legend>{t('pages.collections.detail.documentsPanel.export.fieldsLabel')}</legend>
          <p className="zv-import-dialog__hint">
            {t('pages.collections.detail.documentsPanel.export.fieldsHelp')}
          </p>
          {scalarFields.map((f) => (
            <label key={f.name}>
              <input
                type="checkbox"
                checked={selectedFields.has(f.name)}
                onChange={() => toggleField(f.name)}
              />
              {f.name}
            </label>
          ))}
        </fieldset>
      )}
    </Dialog>
  );
}
