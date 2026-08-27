import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import type { CollectionSummary } from '@/features/collections/api';
import type { DocumentBrowseRequest } from '@/features/documents/api';
import { useDocumentsBrowse, useDocumentDetails } from '@/features/documents/hooks';
import { FilterBuilder } from './FilterBuilder';
import { ImportDocumentsDialog } from './ImportDocumentsDialog';
import { ExportDocumentsDialog } from './ExportDocumentsDialog';
import { primaryKeyFor } from './doc-repr';
import { formatSparseVectorValue, isSparseVectorType } from './vector-utils';

type BrowseMode = 'filter' | 'id';

interface BrowseTabProps {
  collection: CollectionSummary;
}

const CopyIcon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
    <path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5" />
  </svg>
);

export function BrowseTab({ collection }: BrowseTabProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const { schema, stats } = collection;
  const fields = useMemo(() => schema.fields ?? [], [schema.fields]);
  // Row key carrying the primary key: ``id`` normally, ``$id`` when the
  // schema declares its own ``id`` column (backend doc_repr contract).
  const pkKey = primaryKeyFor(schema);
  const sparseVectorFields = useMemo(
    () =>
      new Set(
        (schema.vectors ?? []).filter((v) => isSparseVectorType(v.dataType)).map((v) => v.name),
      ),
    [schema.vectors],
  );

  const [mode, setMode] = useState<BrowseMode>('filter');
  const [idInput, setIdInput] = useState('');
  const [importOpen, setImportOpen] = useState<boolean>(false);
  const [exportOpen, setExportOpen] = useState<boolean>(false);

  // Filter-mode state
  const [submittedBody, setSubmittedBody] = useState<DocumentBrowseRequest>({
    limit: 50,
    includeVector: true,
  });
  const browseQuery = useDocumentsBrowse(collection.name, submittedBody);
  const browseItems = useMemo(
    () => (browseQuery.data?.items ?? []) as ReadonlyArray<Record<string, unknown>>,
    [browseQuery.data],
  );
  const truncated = Boolean(browseQuery.data?.truncated);

  // ID-mode state — supports multiple IDs separated by ;
  const [submittedIds, setSubmittedIds] = useState<string[]>([]);
  const fetchDetails = useDocumentDetails(collection.name, submittedIds);

  const fetchedDocs = useMemo(
    () => fetchDetails.data.filter((d): d is Record<string, unknown> => d != null),
    [fetchDetails.data],
  );

  // Which rows to display
  const displayRows: ReadonlyArray<Record<string, unknown>> =
    mode === 'id' ? fetchedDocs : browseItems;

  // Derive columns from actual data + schema-defined fields.
  // Schema fields are always shown so newly added fields appear even when
  // existing documents have no value for them yet.
  const columnKeys = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    // The primary-key column (``id`` or ``$id``) is always first
    seen.add(pkKey);
    out.push(pkKey);
    // Append keys found in returned documents
    for (const row of displayRows) {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
    // Append schema-defined fields that no document contained
    for (const f of fields) {
      if (!seen.has(f.name)) {
        seen.add(f.name);
        out.push(f.name);
      }
    }
    return out;
  }, [displayRows, fields, pkKey]);

  function handleFilterApply(expr: string): void {
    setSubmittedBody({
      filter: expr || undefined,
      limit: 50,
      includeVector: true,
    });
  }

  function handleIdSubmit(e: FormEvent): void {
    e.preventDefault();
    const ids = idInput
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return;
    setSubmittedIds(ids);
  }

  function handleFetchById(id: string): void {
    setMode('id');
    setIdInput(id);
    setSubmittedIds([id]);
  }

  function copyText(text: string): void {
    void navigator.clipboard.writeText(text);
    toast.push({ severity: 'info', title: t('pages.collections.detail.browse.copied') });
  }

  function handleCopyRow(row: Record<string, unknown>): void {
    copyText(JSON.stringify(row, null, 2));
  }

  function handleCopyCell(value: unknown): void {
    if (value === null || value === undefined) return;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    copyText(text);
  }

  const isLoading =
    mode === 'id' ? submittedIds.length > 0 && fetchDetails.isLoading : browseQuery.isLoading;
  const browseError = mode === 'filter' && browseQuery.isError ? browseQuery.error : null;
  const browseErrorMessage = browseError instanceof ApiError ? browseError.error.message : null;
  const isEmpty =
    !isLoading &&
    !browseError &&
    displayRows.length === 0 &&
    (mode === 'id' ? submittedIds.length > 0 : true);
  const showTable = !browseError && displayRows.length > 0;

  return (
    <div>
      {/* Mode toggle + doc count */}
      <div className="zv-browse-bar">
        <div className="zv-input-mode-tabs zv-browse-bar__mode">
          <button
            type="button"
            className={`zv-input-mode-tab${mode === 'filter' ? ' zv-input-mode-tab--active' : ''}`}
            onClick={() => setMode('filter')}
          >
            {t('pages.collections.detail.browse.modeFilter')}
          </button>
          <button
            type="button"
            className={`zv-input-mode-tab${mode === 'id' ? ' zv-input-mode-tab--active' : ''}`}
            onClick={() => setMode('id')}
          >
            ID
          </button>
        </div>
        <span className="zv-data-subnav__meta" style={{ marginLeft: 'auto' }}>
          {t('pages.collections.detail.browse.docCount', {
            count: stats.documentCount.toLocaleString(),
          })}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setImportOpen(true)}
          data-testid="zv-browse-import"
        >
          {t('pages.collections.detail.documentsPanel.import.openLabel')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setExportOpen(true)}
          data-testid="zv-browse-export"
        >
          {t('pages.collections.detail.documentsPanel.export.openLabel')}
        </Button>
      </div>

      {/* Filter mode — FilterBuilder (always mounted to preserve state) */}
      <div style={{ display: mode === 'filter' ? undefined : 'none' }}>
        <FilterBuilder fields={fields} onApply={handleFilterApply} />
      </div>

      {/* ID mode — input bar */}
      {mode === 'id' && (
        <form className="zv-browse-bar" onSubmit={handleIdSubmit} style={{ marginBottom: 16 }}>
          <input
            className="zv-form-input"
            type="text"
            placeholder={t('pages.collections.detail.browse.idPlaceholder')}
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            style={{ flex: 1 }}
          />
          <Button variant="primary" type="submit" disabled={!idInput.trim()}>
            {t('pages.collections.detail.browse.fetchBtn')}
          </Button>
        </form>
      )}

      {/* Unified results table */}
      <div className="zv-data-table-wrap">
        {browseError ? (
          <div className="zv-empty-state zv-empty-state--error">
            {browseErrorMessage ?? t('pages.collections.detail.browse.filterError')}
          </div>
        ) : isLoading ? (
          <div className="zv-empty-state">{t('pages.collections.detail.browse.loading')}</div>
        ) : isEmpty ? (
          <div className="zv-empty-state">{t('pages.collections.detail.browse.empty')}</div>
        ) : showTable ? (
          <table>
            <thead>
              <tr>
                {columnKeys.map((key) => (
                  <th key={key}>{key}</th>
                ))}
                <th style={{ width: 32 }} />
              </tr>
            </thead>
            <tbody>
              {displayRows.map((row, idx) => (
                <tr key={row[pkKey] != null ? String(row[pkKey]) : `row-${idx}`}>
                  {columnKeys.map((key) => (
                    <td key={key}>
                      {key === pkKey && row[pkKey] != null && mode === 'filter' ? (
                        <div className="zv-cell-copy">
                          <button
                            type="button"
                            className="zv-cell-copy__text zv-browse-id-btn"
                            onClick={() => handleFetchById(String(row[pkKey]))}
                          >
                            {formatCellValue(row[key], false, true)}
                          </button>
                          <button
                            type="button"
                            className="zv-cell-copy__btn"
                            onClick={() => handleCopyCell(row[key])}
                          >
                            {CopyIcon}
                          </button>
                        </div>
                      ) : (
                        <div className="zv-cell-copy">
                          <span className="zv-cell-copy__text">
                            {formatCellValue(row[key], sparseVectorFields.has(key), key === pkKey)}
                          </span>
                          {row[key] != null && (
                            <button
                              type="button"
                              className="zv-cell-copy__btn"
                              onClick={() => handleCopyCell(row[key])}
                            >
                              {CopyIcon}
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      className="zv-row-copy-btn"
                      onClick={() => handleCopyRow(row)}
                      title={t('pages.collections.detail.browse.copyJson')}
                    >
                      {CopyIcon}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {mode === 'filter' && truncated && (
          <div className="zv-pagination">
            <span>{t('pages.collections.detail.browse.truncated')}</span>
          </div>
        )}
      </div>

      <ImportDocumentsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        collection={collection.name}
      />
      <ExportDocumentsDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        collection={collection.name}
        schema={schema}
      />
    </div>
  );
}

function formatCellValue(value: unknown, isSparseVector = false, isId = false): string {
  if (value === null || value === undefined) return '—';
  if (isSparseVector) {
    const formatted = formatSparseVectorValue(value);
    if (formatted) return formatted;
  }
  if (Array.isArray(value)) {
    if (value.length > 4) return `[${value.slice(0, 3).map(String).join(', ')}, ...]`;
    return `[${value.map(String).join(', ')}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return isId ? value : `"${value}"`;
  return String(value);
}
