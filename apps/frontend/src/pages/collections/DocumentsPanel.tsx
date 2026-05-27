/**
 * Document browser + writer panel.
 *
 * Mounted as the "Documents" tab of the Collection detail page. Lets the
 * operator:
 *   - type a Zvec SQL-WHERE filter and hit Browse to list matching documents,
 *   - tweak the page-size limit (Zvec 0.4.x has no list-all primitive — every
 *     browse is a filtered scan capped server-side);
 *   - click a row to open a drawer with the full JSON payload,
 *   - insert one or many documents from a JSON editor,
 *   - delete a single row, a multi-select batch, or every row matching a
 *     filter expression (delete-by-filter), each guarded by a confirmation.
 *
 * Cursor-style Prev/Next is gone: the backend cannot offer a stable global
 * order over a vector store, so we promote the filter to first-class UX.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  Dialog,
  EmptyState,
  Input,
  Skeleton,
  Table,
  type TableColumn,
} from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import type { CollectionSummary } from '@/features/collections';
import {
  useDeleteDocument,
  useDeleteDocumentsBatch,
  useDeleteDocumentsByFilter,
  useDocumentDetail,
  useDocumentsBrowse,
  type DocumentBrowseRequest,
  type DocumentRecord,
} from '@/features/documents';

import { InsertDocumentDialog } from './InsertDocumentDialog';
import './DocumentsPanel.css';

export interface DocumentsPanelProps {
  /** Name of the collection whose documents we're browsing. */
  readonly collection: string;
  /** Schema used to seed the Insert dialog template. */
  readonly schema: CollectionSummary['schema'];
  /** Page size cap. Default mirrors backend default. */
  readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
/** Vector columns with ≥ VECTOR_SUMMARY_CUTOFF entries are summarised. */
const VECTOR_SUMMARY_CUTOFF = 10;

export function DocumentsPanel({
  collection,
  schema,
  pageSize = DEFAULT_PAGE_SIZE,
}: DocumentsPanelProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();

  // Build a schema-aware sample template for the Insert dialog.
  const sampleTemplate = useMemo(() => {
    const tpl: Record<string, unknown> = { id: 'doc-1' };
    for (const f of schema.fields ?? []) {
      if (f.name === 'id') continue;
      tpl[f.name] = f.dataType === 'STRING' ? '' : 0;
    }
    for (const v of schema.vectors ?? []) {
      tpl[v.name] = Array.from({ length: v.dimension ?? 3 }, (_, i) =>
        Math.round(((i + 1) / (v.dimension ?? 3)) * 10) / 10,
      );
    }
    return tpl;
  }, [schema]);

  const [filterDraft, setFilterDraft] = useState<string>('');
  const [limitDraft, setLimitDraft] = useState<string>(String(pageSize));
  // Submitted body is the only thing that drives the query. Keeps typing in
  // the filter box from firing a request on every keystroke.
  const [submitted, setSubmitted] = useState<DocumentBrowseRequest | null>({
    filter: null,
    limit: pageSize,
    outputFields: null,
    includeVector: false,
  });

  const query = useDocumentsBrowse(collection, submitted);

  const toastRef = useRef(toast);
  toastRef.current = toast;
  const lastErrorUpdateRef = useRef(0);
  useEffect(() => {
    if (!query.isError || !query.error) return;
    if (query.errorUpdateCount <= lastErrorUpdateRef.current) return;
    lastErrorUpdateRef.current = query.errorUpdateCount;
    const err = query.error;
    if (err instanceof ApiError) {
      const title = t(err.error.messageKey, { defaultValue: err.error.code });
      toastRef.current.push({
        severity: err.error.severity,
        title,
        description: err.error.message,
      });
    } else {
      toastRef.current.push({
        severity: 'error',
        title: t('pages.collections.detail.documentsPanel.loadFailedTitle'),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [query.errorUpdateCount, query.isError, query.error, t]);

  const items = useMemo<ReadonlyArray<DocumentRecord>>(
    () => (query.data?.items ?? []) as ReadonlyArray<DocumentRecord>,
    [query.data],
  );
  const truncated = Boolean(query.data?.truncated);

  const rowKey = (row: DocumentRecord, index: number): string => {
    if ('id' in row && row.id !== null && row.id !== undefined) return String(row.id);
    return `row-${index}`;
  };

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useDocumentDetail(collection, selectedId ?? undefined);

  const [insertOpen, setInsertOpen] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<
    | { kind: 'single'; id: string }
    | { kind: 'batch'; ids: ReadonlyArray<string> }
    | null
  >(null);
  const deleteOne = useDeleteDocument(collection);
  const deleteBatch = useDeleteDocumentsBatch(collection);
  const deleteByFilter = useDeleteDocumentsByFilter(collection);

  // Delete-by-filter dialog state.
  const [byFilterOpen, setByFilterOpen] = useState<boolean>(false);
  const [byFilterDraft, setByFilterDraft] = useState<string>('');
  const [byFilterError, setByFilterError] = useState<string | null>(null);

  // Drop selections that no longer exist in the current page (e.g. after a
  // delete). The set stays stable when the page reference is unchanged.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const visible = new Set(items.map((row, idx) => rowKey(row, idx)));
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (visible.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelectedIds(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function toggleRowSelection(id: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const columns = useMemo<ReadonlyArray<TableColumn<DocumentRecord>>>(() => {
    const keys = collectColumnKeys(items, schema.fields);
    const dataColumns: Array<TableColumn<DocumentRecord>> = keys.map((key) => ({
      key,
      header: key,
      render: (row) => renderCell(row[key]),
    }));
    const allSelected =
      items.length > 0 && items.every((row, idx) => selectedIds.has(rowKey(row, idx)));
    const selectColumn: TableColumn<DocumentRecord> = {
      key: '__select',
      header: (
        <input
          type="checkbox"
          aria-label={t('pages.collections.detail.documentsPanel.selectAllAria')}
          checked={allSelected}
          onChange={(event) => {
            const checked = event.target.checked;
            setSelectedIds(
              checked
                ? new Set(items.map((row, idx) => rowKey(row, idx)))
                : new Set(),
            );
          }}
          data-testid="zv-documents-select-all"
        />
      ),
      render: (row) => {
        const id = rowKey(row, items.indexOf(row));
        return (
          <input
            type="checkbox"
            aria-label={t('pages.collections.detail.documentsPanel.selectRowAria', { id })}
            checked={selectedIds.has(id)}
            onChange={() => toggleRowSelection(id)}
            onClick={(event) => event.stopPropagation()}
            data-testid={`zv-documents-select-${id}`}
          />
        );
      },
    };
    const actionsColumn: TableColumn<DocumentRecord> = {
      key: '__actions',
      header: '',
      render: (row) => {
        const id = rowKey(row, items.indexOf(row));
        return (
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              setPendingDelete({ kind: 'single', id });
            }}
            data-testid={`zv-documents-delete-row-${id}`}
            aria-label={t('pages.collections.detail.documentsPanel.delete.rowAria', { id })}
          >
            {t('pages.collections.detail.documentsPanel.delete.rowLabel')}
          </Button>
        );
      },
    };
    return [selectColumn, ...dataColumns, actionsColumn];
  }, [items, selectedIds, schema.fields, t]);

  async function performDelete(): Promise<void> {
    if (!pendingDelete) return;
    try {
      if (pendingDelete.kind === 'single') {
        await deleteOne.mutateAsync(pendingDelete.id);
        toastRef.current.push({
          severity: 'info',
          title: t('pages.collections.detail.documentsPanel.delete.successSingleTitle'),
          description: t('pages.collections.detail.documentsPanel.delete.successSingleDescription', {
            id: pendingDelete.id,
          }),
        });
      } else {
        const ids = pendingDelete.ids;
        const result = await deleteBatch.mutateAsync({ ids: [...ids] });
        toastRef.current.push({
          severity: 'info',
          title: t('pages.collections.detail.documentsPanel.delete.successBatchTitle'),
          description: t('pages.collections.detail.documentsPanel.delete.successBatchDescription', {
            count: result.deleted,
          }),
        });
        setSelectedIds(new Set());
      }
      setPendingDelete(null);
    } catch (err) {
      if (err instanceof ApiError) {
        toastRef.current.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        toastRef.current.push({
          severity: 'error',
          title: t('pages.collections.detail.documentsPanel.delete.failureTitle'),
          description: err instanceof Error ? err.message : String(err),
        });
      }
      setPendingDelete(null);
    }
  }

  function openByFilterDialog(): void {
    // Pre-fill with the currently submitted filter (if any) — most operators
    // want to delete what they're currently looking at.
    setByFilterDraft(submitted?.filter ?? filterDraft.trim());
    setByFilterError(null);
    setByFilterOpen(true);
  }

  function closeByFilterDialog(): void {
    if (deleteByFilter.isPending) return;
    setByFilterOpen(false);
    setByFilterError(null);
  }

  async function performDeleteByFilter(): Promise<void> {
    const filter = byFilterDraft.trim();
    if (!filter) {
      setByFilterError(
        t('pages.collections.detail.documentsPanel.deleteByFilter.missingFilter'),
      );
      return;
    }
    try {
      const result = await deleteByFilter.mutateAsync({ filter });
      toastRef.current.push({
        severity: 'info',
        title: t('pages.collections.detail.documentsPanel.deleteByFilter.successTitle'),
        description: t(
          'pages.collections.detail.documentsPanel.deleteByFilter.successDescription',
          { count: result.deleted },
        ),
      });
      setByFilterOpen(false);
      setByFilterDraft('');
      setByFilterError(null);
      setSelectedIds(new Set());
    } catch (err) {
      if (err instanceof ApiError) {
        toastRef.current.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        toastRef.current.push({
          severity: 'error',
          title: t('pages.collections.detail.documentsPanel.deleteByFilter.failureTitle'),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function applyBrowse(): void {
    const limit = clampLimit(Number.parseInt(limitDraft, 10), pageSize);
    const trimmed = filterDraft.trim();
    setSubmitted({
      filter: trimmed ? trimmed : null,
      limit,
      outputFields: null,
      includeVector: false,
    });
  }

  function resetFilter(): void {
    setFilterDraft('');
    setLimitDraft(String(pageSize));
    setSubmitted({ filter: null, limit: pageSize, outputFields: null, includeVector: false });
  }

  const selectedCount = selectedIds.size;
  const deleteBusy = deleteOne.isPending || deleteBatch.isPending;
  const activeFilter = submitted?.filter ?? null;

  return (
    <div className="zv-documents-panel" data-testid="zv-documents-panel">
      <div className="zv-documents-panel__toolbar">
        <form
          className="zv-documents-panel__filter"
          onSubmit={(event) => {
            event.preventDefault();
            applyBrowse();
          }}
        >
          <Input
            label={t('pages.collections.detail.documentsPanel.filterLabel')}
            placeholder={t('pages.collections.detail.documentsPanel.filterPlaceholder')}
            value={filterDraft}
            onChange={(event) => setFilterDraft(event.target.value)}
            data-testid="zv-documents-filter"
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            label={t('pages.collections.detail.documentsPanel.limitLabel')}
            type="number"
            min={1}
            max={MAX_PAGE_SIZE}
            value={limitDraft}
            onChange={(event) => setLimitDraft(event.target.value)}
            data-testid="zv-documents-limit"
          />
          <div className="zv-documents-panel__filter-actions">
            <Button type="submit" variant="primary" data-testid="zv-documents-filter-apply">
              {t('pages.collections.detail.documentsPanel.apply')}
            </Button>
            {(filterDraft || activeFilter) && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetFilter}
                data-testid="zv-documents-filter-reset"
              >
                {t('pages.collections.detail.documentsPanel.reset')}
              </Button>
            )}
          </div>
        </form>
        <div className="zv-documents-panel__actions">
          <Button
            variant="primary"
            onClick={() => setInsertOpen(true)}
            data-testid="zv-documents-insert"
          >
            {t('pages.collections.detail.documentsPanel.insert.openLabel')}
          </Button>
          <Button
            variant="ghost"
            onClick={openByFilterDialog}
            data-testid="zv-documents-delete-by-filter"
          >
            {t('pages.collections.detail.documentsPanel.deleteByFilter.openLabel')}
          </Button>
          <span
            className="zv-documents-panel__page"
            data-testid="zv-documents-page"
            aria-live="polite"
          >
            {t('pages.collections.detail.documentsPanel.showing', { count: items.length })}
            {truncated ? ` · ${t('pages.collections.detail.documentsPanel.truncated')}` : ''}
          </span>
        </div>
      </div>

      {selectedCount > 0 && (
        <div
          className="zv-documents-panel__selection"
          data-testid="zv-documents-selection-bar"
          role="region"
          aria-label={t('pages.collections.detail.documentsPanel.selectionAria')}
        >
          <span className="zv-documents-panel__selection-count">
            {t('pages.collections.detail.documentsPanel.selectionCount', { count: selectedCount })}
          </span>
          <Button
            variant="ghost"
            onClick={() => setSelectedIds(new Set())}
            data-testid="zv-documents-selection-clear"
          >
            {t('pages.collections.detail.documentsPanel.selectionClear')}
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              setPendingDelete({ kind: 'batch', ids: Array.from(selectedIds) })
            }
            data-testid="zv-documents-delete-selected"
          >
            {t('pages.collections.detail.documentsPanel.delete.batchLabel', {
              count: selectedCount,
            })}
          </Button>
        </div>
      )}

      <div className="zv-documents-panel__table" aria-busy={query.isFetching || undefined}>
        {query.isLoading ? (
          <div data-testid="zv-documents-loading">
            <Skeleton variant="table-rows" rows={5} columns={4} />
          </div>
        ) : (
          <Table
            columns={columns}
            rows={items}
            rowKey={rowKey}
            onRowClick={(row, index) => setSelectedId(rowKey(row, index))}
            rowTestId={(row, index) => `zv-documents-row-${rowKey(row, index)}`}
            emptyState={
              <EmptyState
                compact
                testId="zv-documents-empty"
                title={
                  activeFilter
                    ? t('pages.collections.detail.documentsPanel.emptyFiltered')
                    : t('pages.collections.detail.documentsPanel.empty')
                }
              />
            }
          />
        )}
      </div>

      <Dialog
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
        title={t('pages.collections.detail.documentsPanel.drawerTitle', {
          id: selectedId ?? '',
        })}
        footer={
          <Button
            variant="primary"
            onClick={() => setSelectedId(null)}
            data-testid="zv-documents-drawer-close"
          >
            {t('pages.collections.detail.documentsPanel.close')}
          </Button>
        }
      >
        {selectedId !== null ? (
          <DrawerBody
            loading={detail.isLoading}
            error={detail.isError}
            data={detail.data}
            errorText={t('pages.collections.detail.documentsPanel.drawerError')}
            loadingText={t('pages.collections.detail.documentsPanel.drawerLoading')}
          />
        ) : (
          <span />
        )}
      </Dialog>

      <InsertDocumentDialog
        open={insertOpen}
        onClose={() => setInsertOpen(false)}
        collection={collection}
        schema={schema}
        sampleTemplate={sampleTemplate}
      />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => (deleteBusy ? undefined : setPendingDelete(null))}
        title={t('pages.collections.detail.documentsPanel.delete.confirmTitle')}
        footer={
          <div className="zv-documents-panel__confirm-actions">
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleteBusy}
              data-testid="zv-documents-delete-cancel"
            >
              {t('pages.collections.detail.documentsPanel.delete.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                void performDelete();
              }}
              disabled={deleteBusy}
              data-testid="zv-documents-delete-confirm"
            >
              {deleteBusy
                ? t('pages.collections.detail.documentsPanel.delete.confirming')
                : t('pages.collections.detail.documentsPanel.delete.confirm')}
            </Button>
          </div>
        }
      >
        <p
          className="zv-documents-panel__confirm-body"
          data-testid="zv-documents-delete-confirm-body"
        >
          {pendingDelete?.kind === 'single'
            ? t('pages.collections.detail.documentsPanel.delete.confirmSingle', {
                id: pendingDelete.id,
              })
            : t('pages.collections.detail.documentsPanel.delete.confirmBatch', {
                count: pendingDelete?.kind === 'batch' ? pendingDelete.ids.length : 0,
              })}
        </p>
      </Dialog>

      <Dialog
        open={byFilterOpen}
        onClose={closeByFilterDialog}
        title={t('pages.collections.detail.documentsPanel.deleteByFilter.title')}
        footer={
          <div className="zv-documents-panel__confirm-actions">
            <Button
              variant="ghost"
              onClick={closeByFilterDialog}
              disabled={deleteByFilter.isPending}
              data-testid="zv-documents-delete-by-filter-cancel"
            >
              {t('pages.collections.detail.documentsPanel.delete.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void performDeleteByFilter()}
              loading={deleteByFilter.isPending}
              disabled={deleteByFilter.isPending}
              data-testid="zv-documents-delete-by-filter-confirm"
            >
              {deleteByFilter.isPending
                ? t('pages.collections.detail.documentsPanel.deleteByFilter.submitting')
                : t('pages.collections.detail.documentsPanel.deleteByFilter.submit')}
            </Button>
          </div>
        }
      >
        <Input
          label={t('pages.collections.detail.documentsPanel.deleteByFilter.filterLabel')}
          placeholder={t('pages.collections.detail.documentsPanel.filterPlaceholder')}
          value={byFilterDraft}
          onChange={(event) => {
            setByFilterDraft(event.target.value);
            if (byFilterError) setByFilterError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          disabled={deleteByFilter.isPending}
          data-testid="zv-documents-delete-by-filter-input"
          errorText={byFilterError ?? undefined}
        />
        <p className="zv-documents-panel__confirm-body">
          {t('pages.collections.detail.documentsPanel.deleteByFilter.filterHint')}
        </p>
      </Dialog>
    </div>
  );
}

interface DrawerBodyProps {
  readonly loading: boolean;
  readonly error: boolean;
  readonly data: DocumentRecord | undefined;
  readonly loadingText: string;
  readonly errorText: string;
}

function DrawerBody({
  loading,
  error,
  data,
  loadingText,
  errorText,
}: DrawerBodyProps): JSX.Element {
  if (loading) {
    return (
      <p className="zv-documents-panel__drawer-msg" data-testid="zv-documents-drawer-loading">
        {loadingText}
      </p>
    );
  }
  if (error) {
    return (
      <p
        className="zv-documents-panel__drawer-msg zv-documents-panel__drawer-msg--error"
        role="alert"
        data-testid="zv-documents-drawer-error"
      >
        {errorText}
      </p>
    );
  }
  return (
    <pre className="zv-documents-panel__drawer-body" data-testid="zv-documents-drawer-body">
      {data ? JSON.stringify(data, null, 2) : ''}
    </pre>
  );
}

function clampLimit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.round(value)));
}

function collectColumnKeys(
  rows: ReadonlyArray<DocumentRecord>,
  schemaFields?: ReadonlyArray<{ name: string }>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  // ``id`` is always pinned first.
  seen.add('id');
  out.push('id');
  // Keys from actual document data.
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  // Append schema-defined fields that no document contained, so newly
  // added fields always appear as columns even before any doc has a value.
  if (schemaFields) {
    for (const f of schemaFields) {
      if (!seen.has(f.name)) {
        seen.add(f.name);
        out.push(f.name);
      }
    }
  }
  return out;
}

function renderCell(value: unknown): ReactNode {
  if (value === null || value === undefined) {
    return <span className="zv-documents-panel__null">—</span>;
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) {
    return renderVectorSummary(value as number[]);
  }
  if (typeof value === 'object') {
    return <code className="zv-documents-panel__code">{JSON.stringify(value)}</code>;
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'string') {
    return <span className="zv-documents-panel__string">&quot;{value}&quot;</span>;
  }
  return String(value);
}

function renderVectorSummary(vec: ReadonlyArray<number>): ReactNode {
  if (vec.length < VECTOR_SUMMARY_CUTOFF) {
    return (
      <code className="zv-documents-panel__vector">
        [{vec.map((n) => n.toFixed(3)).join(', ')}]
      </code>
    );
  }
  const head = vec.slice(0, VECTOR_SUMMARY_CUTOFF).map((n) => n.toFixed(3)).join(', ');
  return (
    <code
      className="zv-documents-panel__vector zv-documents-panel__vector--folded"
      data-testid="zv-documents-vector-summary"
    >
      [{head}, …] ({vec.length}-d)
    </code>
  );
}
