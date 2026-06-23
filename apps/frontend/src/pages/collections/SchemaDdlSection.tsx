/**
 * Schema panel with DDL controls (T-extension).
 *
 * Rendered as the "Schema" tab of the Collection detail page. Lists vector
 * and scalar fields, with inline action buttons per row plus toolbar buttons
 * for adding new fields / creating new vector indexes.
 *
 * Hosts five Dialogs:
 *   - Add scalar field        → POST /collections/{name}/fields
 *   - Rename scalar field     → PATCH /collections/{name}/fields/{field}
 *   - Drop   scalar field     → DELETE /collections/{name}/fields/{field}
 *   - Create vector index     → POST /collections/{name}/indexes
 *   - Drop   vector index     → DELETE /collections/{name}/indexes/{vectorField}
 *
 * Each Dialog is a thin wrapper around the corresponding mutation hook from
 * ``features/collections``. On success a toast confirms; on failure the
 * structured ApiError is surfaced via the i18n message key.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  Dialog,
  Input,
  Select,
  Table,
  type SelectOption,
  type TableColumn,
} from '@/components/ui';
import { useToast, type ToastContextValue, type ToastDescriptor } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  useAddField,
  useCreateIndex,
  useCreateScalarIndex,
  useDropField,
  useDropIndex,
  useDropScalarIndex,
  useRenameField,
  type CollectionSummary,
} from '@/features/collections';
import type { components } from '@zvec-studio/api-client';
import { isSparseVectorType, vectorDimensionLabel } from './vector-utils';

type ScalarDataType = components['schemas']['ScalarDataType'];
type IndexType = components['schemas']['IndexType'];
type MetricType = components['schemas']['MetricType'];
type VectorRow = NonNullable<CollectionSummary['schema']['vectors']>[number];
type FieldRow = NonNullable<CollectionSummary['schema']['fields']>[number];

function typeBadgeClass(dataType: string): string {
  if (dataType.startsWith('VECTOR') || dataType.startsWith('SPARSE_VECTOR')) return 'zv-type-badge zv-type-badge--vector';
  if (['INT32', 'INT64', 'UINT32', 'UINT64', 'FLOAT', 'DOUBLE'].includes(dataType)) return 'zv-type-badge zv-type-badge--numeric';
  if (dataType === 'BOOL') return 'zv-type-badge zv-type-badge--bool';
  if (dataType.startsWith('ARRAY_')) return 'zv-type-badge zv-type-badge--array';
  return 'zv-type-badge zv-type-badge--text';
}

const SCALAR_TYPES: ReadonlyArray<SelectOption<ScalarDataType>> = [
  { value: 'INT32', label: 'INT32' },
  { value: 'INT64', label: 'INT64' },
  { value: 'UINT32', label: 'UINT32' },
  { value: 'UINT64', label: 'UINT64' },
  { value: 'FLOAT', label: 'FLOAT' },
  { value: 'DOUBLE', label: 'DOUBLE' },
  { value: 'BOOL', label: 'BOOL' },
  { value: 'STRING', label: 'STRING' },
  { value: 'ARRAY_BOOL', label: 'ARRAY_BOOL' },
  { value: 'ARRAY_INT32', label: 'ARRAY_INT32' },
  { value: 'ARRAY_INT64', label: 'ARRAY_INT64' },
  { value: 'ARRAY_UINT32', label: 'ARRAY_UINT32' },
  { value: 'ARRAY_UINT64', label: 'ARRAY_UINT64' },
  { value: 'ARRAY_FLOAT', label: 'ARRAY_FLOAT' },
  { value: 'ARRAY_DOUBLE', label: 'ARRAY_DOUBLE' },
  { value: 'ARRAY_STRING', label: 'ARRAY_STRING' },
];
const INDEX_TYPES: ReadonlyArray<SelectOption<IndexType>> = [
  { value: 'HNSW', label: 'HNSW' },
  { value: 'FLAT', label: 'FLAT' },
  { value: 'IVF', label: 'IVF' },
  { value: 'HNSW_RABITQ', label: 'HNSW_RABITQ' },
  { value: 'VAMANA', label: 'VAMANA' },
  { value: 'DISKANN', label: 'DISKANN' },
];
const SCALAR_INDEX_TYPES: ReadonlyArray<SelectOption<'INVERT' | 'FTS'>> = [
  { value: 'INVERT', label: 'INVERT' },
  { value: 'FTS', label: 'FTS' },
];
const INVERT_ONLY_INDEX_TYPES: ReadonlyArray<SelectOption<'INVERT' | 'FTS'>> = [
  { value: 'INVERT', label: 'INVERT' },
];
const FTS_TOKENIZERS: ReadonlyArray<SelectOption<string>> = [
  { value: 'standard', label: 'standard' },
  { value: 'whitespace', label: 'whitespace' },
  { value: 'jieba', label: 'jieba' },
];
const METRIC_TYPES: ReadonlyArray<SelectOption<MetricType>> = [
  { value: 'COSINE', label: 'COSINE' },
  { value: 'L2', label: 'L2' },
  { value: 'IP', label: 'IP' },
];

export interface SchemaPanelDdlProps {
  readonly summary: CollectionSummary;
  readonly indexCompleteness?: ReadonlyArray<[string, number]>;
  readonly completenessColor?: (pct: number) => string;
}

/**
 * Top-level Schema panel. Lays out the vector and scalar tables plus the
 * toolbar that opens the Add-field / Create-index dialogs.
 */
export function SchemaPanelDdl({ summary, indexCompleteness, completenessColor }: SchemaPanelDdlProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();

  const vectors: ReadonlyArray<VectorRow> = summary.schema.vectors ?? [];
  const fields: ReadonlyArray<FieldRow> = summary.schema.fields ?? [];

  const [addFieldOpen, setAddFieldOpen] = useState(false);
  const [createIndexTarget, setCreateIndexTarget] = useState<VectorRow | null>(null);
  const [dropField, setDropField] = useState<FieldRow | null>(null);
  const [renameField, setRenameField] = useState<FieldRow | null>(null);
  const [dropIndex, setDropIndex] = useState<VectorRow | null>(null);
  const [createScalarIndexTarget, setCreateScalarIndexTarget] = useState<FieldRow | null>(null);
  const [dropScalarIndexTarget, setDropScalarIndexTarget] = useState<FieldRow | null>(null);

  const vectorCols: ReadonlyArray<TableColumn<VectorRow>> = [
    {
      key: 'name',
      header: t('pages.collections.detail.schema.columnName'),
      render: (row) => <strong>{row.name}</strong>,
    },
    {
      key: 'type',
      header: t('pages.collections.detail.schema.columnType'),
      render: (row) => <span className={typeBadgeClass(row.dataType)}>{row.dataType}</span>,
    },
    {
      key: 'dim',
      header: t('pages.collections.detail.schema.columnDimension'),
      render: (row) => vectorDimensionLabel(row),
    },
    {
      key: 'index',
      header: t('pages.collections.detail.schema.columnIndex'),
      render: (row) => {
        if (!row.indexParam) {
          return (
            <span className="zv-index-status">
              <span className="zv-index-dot zv-index-dot--none" />
              {t('pages.collections.detail.schema.noIndex')}
            </span>
          );
        }
        const entry = indexCompleteness?.find(([n]) => n === row.name);
        const pct = entry ? Math.round(entry[1] * 100) : null;
        const pctColor = entry && completenessColor ? completenessColor(entry[1]) : undefined;
        return (
          <span className="zv-index-status">
            <span className="zv-index-dot zv-index-dot--active" />
            {row.indexParam.indexType}
            {pct != null && (
              <span style={{ marginLeft: 4, fontWeight: 700, color: pctColor }}>({pct}%)</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'metric',
      header: t('pages.collections.detail.schema.columnMetric'),
      render: (row) =>
        row.indexParam ? <code>{row.indexParam.metric}</code> : '—',
    },
    {
      key: 'params',
      header: t('pages.collections.detail.schema.columnParams'),
      render: (row) => {
        const params = row.indexParam?.params ?? {};
        return Object.keys(params).length === 0 ? (
          '—'
        ) : (
          <code>{JSON.stringify(params)}</code>
        );
      },
    },

    {
      key: '__actions',
      header: t('pages.collections.detail.schema.columnActions'),
      render: (row) => {
        const hasIndex = row.indexParam && row.indexParam.indexType !== 'FLAT';
        return (
          <span className="zv-schema-row-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateIndexTarget(row)}
              data-testid={`zv-schema-create-index-${row.name}`}
            >
              {hasIndex
                ? t('pages.collections.detail.schema.ddl.editIndex')
                : t('pages.collections.detail.schema.ddl.createIndex')}
            </Button>
            {hasIndex && (
              <>
                <span className="zv-schema-row-actions__sep" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDropIndex(row)}
                  data-testid={`zv-schema-drop-index-${row.name}`}
                >
                  {t('pages.collections.detail.schema.ddl.dropIndex')}
                </Button>
              </>
            )}
          </span>
        );
      },
    },
  ];

  const fieldCols: ReadonlyArray<TableColumn<FieldRow>> = [
    {
      key: 'name',
      header: t('pages.collections.detail.schema.columnName'),
      render: (row) => <strong>{row.name}</strong>,
    },
    {
      key: 'type',
      header: t('pages.collections.detail.schema.columnType'),
      render: (row) => <span className={typeBadgeClass(row.dataType)}>{row.dataType}</span>,
    },
    {
      key: 'nullable',
      header: t('pages.collections.detail.schema.columnNullable'),
      render: (row) => (row.nullable ? '✓' : '—'),
    },
    {
      key: 'index',
      header: t('pages.collections.detail.schema.columnIndex'),
      render: (row) =>
        row.indexParam ? (
          <span className="zv-index-status">
            <span className="zv-index-dot zv-index-dot--active" />
            {row.indexParam.indexType}
            {row.indexParam.enableRangeOptimization && (
              <span className="zv-index-tag">Range</span>
            )}
            {row.indexParam.enableExtendedWildcard && (
              <span className="zv-index-tag">Wildcard</span>
            )}
            {row.indexParam.indexType === 'FTS' && (
              <span className="zv-index-tag">{row.indexParam.tokenizerName ?? 'standard'}</span>
            )}
          </span>
        ) : (
          <span className="zv-index-status">
            <span className="zv-index-dot zv-index-dot--none" />
            —
          </span>
        ),
    },
    {
      key: '__actions',
      header: t('pages.collections.detail.schema.columnActions'),
      render: (row) => {
        if (row.name === 'id') return <span>—</span>;
        const hasIndex = Boolean(row.indexParam);
        return (
          <span className="zv-schema-row-actions">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenameField(row)}
              data-testid={`zv-schema-rename-field-${row.name}`}
            >
              {t('pages.collections.detail.schema.ddl.renameField')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDropField(row)}
              data-testid={`zv-schema-drop-field-${row.name}`}
            >
              {t('pages.collections.detail.schema.ddl.dropField')}
            </Button>
            <span className="zv-schema-row-actions__sep" />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateScalarIndexTarget(row)}
              data-testid={`zv-schema-create-scalar-index-${row.name}`}
            >
              {hasIndex
                ? t('pages.collections.detail.schema.ddl.editScalarIndex')
                : t('pages.collections.detail.schema.ddl.createScalarIndex')}
            </Button>
            {hasIndex && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDropScalarIndexTarget(row)}
                data-testid={`zv-schema-drop-scalar-index-${row.name}`}
              >
                {t('pages.collections.detail.schema.ddl.dropScalarIndex')}
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <div className="zv-info-card" data-testid="zv-collection-detail-vectors">
        <div className="zv-info-card__head">
          <div className="zv-info-card__title">{t('pages.collections.detail.schema.vectorsTitle')}</div>
        </div>
        <Table<VectorRow>
          columns={vectorCols}
          rows={vectors}
          rowKey={(row) => row.name}
        />
      </div>
      <div className="zv-info-card" data-testid="zv-collection-detail-fields">
        <div className="zv-info-card__head">
          <div className="zv-info-card__title">{t('pages.collections.detail.schema.fieldsTitle')}</div>
        </div>
        <Table<FieldRow>
          columns={fieldCols}
          rows={fields}
          rowKey={(row) => row.name}
          emptyState={t('pages.collections.detail.schema.noFields')}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setAddFieldOpen(true)}
          data-testid="zv-schema-add-field"
          style={{ marginTop: 8 }}
        >
          + {t('pages.collections.detail.schema.ddl.addField')}
        </Button>
      </div>

      <AddFieldDialog
        open={addFieldOpen}
        onClose={() => setAddFieldOpen(false)}
        collection={summary.name}
        toast={toast}
      />
      <RenameFieldDialog
        target={renameField}
        onClose={() => setRenameField(null)}
        collection={summary.name}
        toast={toast}
      />
      <DropFieldDialog
        target={dropField}
        onClose={() => setDropField(null)}
        collection={summary.name}
        toast={toast}
      />
      <CreateIndexDialog
        target={createIndexTarget}
        onClose={() => setCreateIndexTarget(null)}
        collection={summary.name}
        toast={toast}
      />
      <DropIndexDialog
        target={dropIndex}
        onClose={() => setDropIndex(null)}
        collection={summary.name}
        toast={toast}
      />
      <CreateScalarIndexDialog
        target={createScalarIndexTarget}
        onClose={() => setCreateScalarIndexTarget(null)}
        collection={summary.name}
        toast={toast}
      />
      <DropScalarIndexDialog
        target={dropScalarIndexTarget}
        onClose={() => setDropScalarIndexTarget(null)}
        collection={summary.name}
        toast={toast}
      />
    </>
  );
}

type ToastBag = Pick<ToastContextValue, 'push'>;
type ToastInput = Omit<ToastDescriptor, 'id'>;

function pushApiError(toast: ToastBag, err: unknown, fallbackTitle: string, t: (key: string, options?: Record<string, unknown>) => string): void {
  const payload: ToastInput = err instanceof ApiError
    ? {
        severity: err.error.severity,
        title: t(err.error.messageKey, { defaultValue: err.error.code }),
        description: err.error.message,
      }
    : {
        severity: 'error',
        title: fallbackTitle,
        description: err instanceof Error ? err.message : String(err),
      };
  toast.push(payload);
}

interface AddFieldDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function AddFieldDialog({ open, onClose, collection, toast }: AddFieldDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useAddField();
  const [name, setName] = useState('');
  const [dataType, setDataType] = useState<ScalarDataType>('STRING');
  const [expression, setExpression] = useState('');
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setName('');
    setDataType('STRING');
    setExpression('');
    setError(null);
  }

  function close(): void {
    if (mutation.isPending) return;
    onClose();
    // Reset slightly later to avoid flashing empty values during exit anim.
    setTimeout(reset, 0);
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('pages.collections.detail.schema.ddl.addFieldDialog.errors.nameRequired'));
      return;
    }
    if (trimmed === 'id') {
      setError(
        t('pages.collections.detail.schema.ddl.addFieldDialog.errors.reservedName', { name: trimmed }),
      );
      return;
    }
    try {
      await mutation.mutateAsync({
        name: collection,
        body: {
          field: { name: trimmed, dataType, nullable: true },
          expression,
        },
      });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.addFieldDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.addFieldDialog.successDescription', { name: trimmed }),
      });
      onClose();
      setTimeout(reset, 0);
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.addFieldDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.addFieldDialog.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-add-field-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.addFieldDialog.submitting')
              : t('pages.collections.detail.schema.ddl.addFieldDialog.submit')}
          </Button>
        </>
      }
    >
      <Input
        label={t('pages.collections.detail.schema.ddl.addFieldDialog.nameLabel')}
        placeholder={t('pages.collections.detail.schema.ddl.addFieldDialog.namePlaceholder')}
        helperText={t('pages.collections.detail.schema.ddl.addFieldDialog.nameHelp')}
        errorText={error ?? undefined}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          if (error) setError(null);
        }}
        disabled={mutation.isPending}
        autoFocus
        data-testid="zv-schema-add-field-name"
      />
      <Select<ScalarDataType>
        label={t('pages.collections.detail.schema.ddl.addFieldDialog.typeLabel')}
        options={SCALAR_TYPES}
        value={dataType}
        onChange={(event) => setDataType(event.target.value as ScalarDataType)}
        disabled={mutation.isPending}
        data-testid="zv-schema-add-field-type"
      />
      <Input
        label={t('pages.collections.detail.schema.ddl.addFieldDialog.expressionLabel')}
        placeholder={t('pages.collections.detail.schema.ddl.addFieldDialog.expressionPlaceholder')}
        helperText={t('pages.collections.detail.schema.ddl.addFieldDialog.expressionHelp')}
        value={expression}
        onChange={(event) => setExpression(event.target.value)}
        disabled={mutation.isPending}
        data-testid="zv-schema-add-field-expression"
      />
    </Dialog>
  );
}

interface RenameFieldDialogProps {
  readonly target: FieldRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function RenameFieldDialog({ target, onClose, collection, toast }: RenameFieldDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useRenameField();
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    if (mutation.isPending) return;
    onClose();
    setTimeout(() => {
      setNewName('');
      setError(null);
    }, 0);
  }

  async function submit(): Promise<void> {
    if (!target) return;
    const trimmed = newName.trim();
    if (!trimmed) {
      setError(t('pages.collections.detail.schema.ddl.renameFieldDialog.errors.newNameRequired'));
      return;
    }
    if (trimmed === target.name) {
      setError(t('pages.collections.detail.schema.ddl.renameFieldDialog.errors.sameName'));
      return;
    }
    try {
      await mutation.mutateAsync({
        name: collection,
        field: target.name,
        body: { newName: trimmed },
      });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.renameFieldDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.renameFieldDialog.successDescription', {
          oldName: target.name,
          newName: trimmed,
        }),
      });
      close();
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.renameFieldDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.renameFieldDialog.title', {
        name: target?.name ?? '',
      })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-rename-field-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.renameFieldDialog.submitting')
              : t('pages.collections.detail.schema.ddl.renameFieldDialog.submit')}
          </Button>
        </>
      }
    >
      <Input
        label={t('pages.collections.detail.schema.ddl.renameFieldDialog.newNameLabel')}
        helperText={t('pages.collections.detail.schema.ddl.renameFieldDialog.newNameHelp')}
        errorText={error ?? undefined}
        value={newName}
        onChange={(event) => {
          setNewName(event.target.value);
          if (error) setError(null);
        }}
        disabled={mutation.isPending}
        autoFocus
        data-testid="zv-schema-rename-field-input"
      />
    </Dialog>
  );
}

interface DropFieldDialogProps {
  readonly target: FieldRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function DropFieldDialog({ target, onClose, collection, toast }: DropFieldDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useDropField();

  function close(): void {
    if (mutation.isPending) return;
    onClose();
  }

  async function submit(): Promise<void> {
    if (!target) return;
    try {
      await mutation.mutateAsync({ name: collection, field: target.name });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.dropFieldDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.dropFieldDialog.successDescription', {
          name: target.name,
        }),
      });
      onClose();
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.dropFieldDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.dropFieldDialog.title', {
        name: target?.name ?? '',
      })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-drop-field-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.dropFieldDialog.submitting')
              : t('pages.collections.detail.schema.ddl.dropFieldDialog.submit')}
          </Button>
        </>
      }
    >
      <p>
        {t('pages.collections.detail.schema.ddl.dropFieldDialog.body', {
          name: target?.name ?? '',
        })}
      </p>
    </Dialog>
  );
}

interface CreateIndexDialogProps {
  readonly target: VectorRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function CreateIndexDialog({ target, onClose, collection, toast }: CreateIndexDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useCreateIndex();
  const [indexType, setIndexType] = useState<IndexType>('HNSW');
  const [metric, setMetric] = useState<MetricType>('COSINE');
  const [paramsText, setParamsText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const targetIsSparse = target ? isSparseVectorType(target.dataType) : false;
  const effectiveMetric: MetricType = targetIsSparse ? 'IP' : metric;

  function reset(): void {
    setIndexType('HNSW');
    setMetric('COSINE');
    setParamsText('');
    setError(null);
  }

  useEffect(() => {
    if (targetIsSparse) setMetric('IP');
  }, [targetIsSparse]);

  function close(): void {
    if (mutation.isPending) return;
    onClose();
    setTimeout(reset, 0);
  }

  async function submit(): Promise<void> {
    if (!target) return;
    let params: Record<string, unknown> | undefined;
    if (paramsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(paramsText);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        params = parsed as Record<string, unknown>;
      } catch {
        setError(t('pages.collections.detail.schema.ddl.createIndexDialog.errors.invalidParams'));
        return;
      }
    }
    try {
      await mutation.mutateAsync({
        name: collection,
        body: {
          vectorField: target.name,
          indexType,
          metric: effectiveMetric,
          params,
        },
      });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.createIndexDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.createIndexDialog.successDescription', { vectorField: target.name }),
      });
      onClose();
      setTimeout(reset, 0);
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.createIndexDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.createIndexDialog.title')}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-create-index-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.createIndexDialog.submitting')
              : t('pages.collections.detail.schema.ddl.createIndexDialog.submit')}
          </Button>
        </>
      }
    >
      <p style={{ marginBottom: '0.5rem' }}>
        <strong>{target?.name}</strong> ({target ? vectorDimensionLabel(target) : '—'})
      </p>
      <Select<IndexType>
        label={t('pages.collections.detail.schema.ddl.createIndexDialog.indexTypeLabel')}
        options={INDEX_TYPES}
        value={indexType}
        onChange={(event) => setIndexType(event.target.value as IndexType)}
        disabled={mutation.isPending}
        data-testid="zv-schema-create-index-type"
      />
      <Select<MetricType>
        label={t('pages.collections.detail.schema.ddl.createIndexDialog.metricLabel')}
        options={METRIC_TYPES}
        value={effectiveMetric}
        onChange={(event) => setMetric(event.target.value as MetricType)}
        disabled={mutation.isPending || targetIsSparse}
        data-testid="zv-schema-create-index-metric"
      />
      <Input
        label={t('pages.collections.detail.schema.ddl.createIndexDialog.paramsLabel')}
        helperText={t('pages.collections.detail.schema.ddl.createIndexDialog.paramsHelp')}
        errorText={error ?? undefined}
        value={paramsText}
        onChange={(event) => {
          setParamsText(event.target.value);
          if (error) setError(null);
        }}
        disabled={mutation.isPending}
        spellCheck={false}
        autoComplete="off"
        data-testid="zv-schema-create-index-params"
      />
    </Dialog>
  );
}

interface DropIndexDialogProps {
  readonly target: VectorRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function DropIndexDialog({ target, onClose, collection, toast }: DropIndexDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useDropIndex();

  function close(): void {
    if (mutation.isPending) return;
    onClose();
  }

  async function submit(): Promise<void> {
    if (!target) return;
    try {
      await mutation.mutateAsync({ name: collection, vectorField: target.name });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.dropIndexDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.dropIndexDialog.successDescription', {
          vectorField: target.name,
        }),
      });
      onClose();
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.dropIndexDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.dropIndexDialog.title', {
        vectorField: target?.name ?? '',
      })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-drop-index-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.dropIndexDialog.submitting')
              : t('pages.collections.detail.schema.ddl.dropIndexDialog.submit')}
          </Button>
        </>
      }
    >
      <p>
        {t('pages.collections.detail.schema.ddl.dropIndexDialog.body', {
          vectorField: target?.name ?? '',
        })}
      </p>
    </Dialog>
  );
}

interface CreateScalarIndexDialogProps {
  readonly target: FieldRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function CreateScalarIndexDialog({ target, onClose, collection, toast }: CreateScalarIndexDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useCreateScalarIndex();
  const [indexType, setIndexType] = useState<'INVERT' | 'FTS'>('INVERT');
  const [tokenizerName, setTokenizerName] = useState('standard');
  const [extraParams, setExtraParams] = useState('');
  const [rangeOpt, setRangeOpt] = useState(false);
  const [wildcard, setWildcard] = useState(false);
  const targetIsString = target?.dataType === 'STRING';

  // Pre-populate with current index values when editing an existing index.
  useEffect(() => {
    if (target?.indexParam) {
      const currentType = target.indexParam.indexType === 'FTS' && targetIsString ? 'FTS' : 'INVERT';
      setIndexType(currentType);
      setTokenizerName(target.indexParam.tokenizerName ?? 'standard');
      setExtraParams(target.indexParam.extraParams ?? '');
      setRangeOpt(Boolean(target.indexParam.enableRangeOptimization));
      setWildcard(Boolean(target.indexParam.enableExtendedWildcard));
    } else {
      setIndexType('INVERT');
      setTokenizerName('standard');
      setExtraParams('');
      setRangeOpt(false);
      setWildcard(false);
    }
    if (!targetIsString) setIndexType('INVERT');
  }, [target, targetIsString]);

  function reset(): void {
    setIndexType('INVERT');
    setTokenizerName('standard');
    setExtraParams('');
    setRangeOpt(false);
    setWildcard(false);
  }

  function close(): void {
    if (mutation.isPending) return;
    onClose();
    setTimeout(reset, 0);
  }

  async function submit(): Promise<void> {
    if (!target) return;
    try {
      await mutation.mutateAsync({
        name: collection,
        field: target.name,
        body:
          indexType === 'FTS'
            ? {
                indexType: 'FTS',
                enableRangeOptimization: false,
                enableExtendedWildcard: false,
                tokenizerName,
                filters: ['lowercase'],
                extraParams,
              }
            : {
                indexType: 'INVERT',
                enableRangeOptimization: rangeOpt,
                enableExtendedWildcard: wildcard,
                tokenizerName: 'standard',
                filters: ['lowercase'],
                extraParams: '',
              },
      });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.createScalarIndexDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.createScalarIndexDialog.successDescription', { field: target.name }),
      });
      onClose();
      setTimeout(reset, 0);
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.createScalarIndexDialog.failureTitle'),
        t,
      );
    }
  }

  const BOOL_OPTIONS: ReadonlyArray<SelectOption<string>> = [
    { value: 'false', label: t('common.no', { defaultValue: 'No' }) },
    { value: 'true', label: t('common.yes', { defaultValue: 'Yes' }) },
  ];

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.title', {
        field: target?.name ?? '',
      })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-create-scalar-index-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.createScalarIndexDialog.submitting')
              : t('pages.collections.detail.schema.ddl.createScalarIndexDialog.submit')}
          </Button>
        </>
      }
    >
      <p style={{ marginBottom: '0.75rem', fontSize: 'var(--zv-font-size-sm, 13px)', color: 'var(--zv-color-text-subtle)' }}>
        {t('pages.collections.detail.schema.ddl.createScalarIndexDialog.hint')}
      </p>
      <Select<'INVERT' | 'FTS'>
        label={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.indexTypeLabel')}
        options={targetIsString ? SCALAR_INDEX_TYPES : INVERT_ONLY_INDEX_TYPES}
        value={indexType}
        onChange={(event) => setIndexType(event.target.value as 'INVERT' | 'FTS')}
        disabled={mutation.isPending}
        data-testid="zv-schema-create-scalar-index-type"
      />
      {indexType === 'FTS' ? (
        <>
          <Select<string>
            label={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.tokenizerLabel')}
            options={FTS_TOKENIZERS}
            value={tokenizerName}
            onChange={(event) => setTokenizerName(event.target.value)}
            disabled={mutation.isPending}
            data-testid="zv-schema-create-scalar-index-tokenizer"
          />
          <Input
            label={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.extraParamsLabel')}
            value={extraParams}
            onChange={(event) => setExtraParams(event.target.value)}
            disabled={mutation.isPending}
            data-testid="zv-schema-create-scalar-index-extra-params"
          />
        </>
      ) : (
        <>
          <Select<string>
            label={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.rangeLabel')}
            options={BOOL_OPTIONS}
            value={rangeOpt ? 'true' : 'false'}
            onChange={(event) => setRangeOpt(event.target.value === 'true')}
            disabled={mutation.isPending}
            data-testid="zv-schema-create-scalar-index-range"
          />
          <Select<string>
            label={t('pages.collections.detail.schema.ddl.createScalarIndexDialog.wildcardLabel')}
            options={BOOL_OPTIONS}
            value={wildcard ? 'true' : 'false'}
            onChange={(event) => setWildcard(event.target.value === 'true')}
            disabled={mutation.isPending}
            data-testid="zv-schema-create-scalar-index-wildcard"
          />
        </>
      )}
    </Dialog>
  );
}

interface DropScalarIndexDialogProps {
  readonly target: FieldRow | null;
  readonly onClose: () => void;
  readonly collection: string;
  readonly toast: ToastBag;
}

function DropScalarIndexDialog({ target, onClose, collection, toast }: DropScalarIndexDialogProps): JSX.Element {
  const { t } = useTranslation();
  const mutation = useDropScalarIndex();

  function close(): void {
    if (mutation.isPending) return;
    onClose();
  }

  async function submit(): Promise<void> {
    if (!target) return;
    try {
      await mutation.mutateAsync({ name: collection, field: target.name });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.successTitle'),
        description: t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.successDescription', { field: target.name }),
      });
      onClose();
    } catch (err) {
      pushApiError(
        toast,
        err,
        t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.failureTitle'),
        t,
      );
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title={t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.title', {
        field: target?.name ?? '',
      })}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-schema-drop-scalar-index-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.submitting')
              : t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.submit')}
          </Button>
        </>
      }
    >
      <p>
        {t('pages.collections.detail.schema.ddl.dropScalarIndexDialog.body', {
          field: target?.name ?? '',
        })}
      </p>
    </Dialog>
  );
}
