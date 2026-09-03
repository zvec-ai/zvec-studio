import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, CloseButton, Dialog, DirectoryInput, Input, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  useCreateCollection,
  type CollectionSchemaPayload,
} from '@/features/collections';

import './CreateCollectionDialog.css';

const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{3,64}$/;
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const VECTOR_TYPES = ['VECTOR_FP32', 'VECTOR_FP16', 'VECTOR_INT8', 'SPARSE_VECTOR_FP32', 'SPARSE_VECTOR_FP16'] as const;
const SCALAR_TYPES = ['INT32', 'INT64', 'UINT32', 'UINT64', 'FLOAT', 'DOUBLE', 'BOOL', 'STRING', 'ARRAY_BOOL', 'ARRAY_INT32', 'ARRAY_INT64', 'ARRAY_UINT32', 'ARRAY_UINT64', 'ARRAY_FLOAT', 'ARRAY_DOUBLE', 'ARRAY_STRING'] as const;
const ALL_DATA_TYPES = [...VECTOR_TYPES, ...SCALAR_TYPES] as const;
type AnyDataType = (typeof ALL_DATA_TYPES)[number];

const METRICS = ['COSINE', 'L2', 'IP'] as const;
const INDEX_TYPES = ['HNSW', 'FLAT', 'IVF', 'HNSW_RABITQ', 'VAMANA', 'DISKANN'] as const;
const QUANTIZE_TYPES = ['UNDEFINED', 'FP16', 'INT8', 'INT4', 'RABITQ'] as const;
const SCALAR_INDEX_TYPES = ['INVERT', 'FTS'] as const;
const FTS_TOKENIZERS = ['standard', 'whitespace', 'jieba'] as const;

function isVectorType(dt: string): boolean {
  return (VECTOR_TYPES as readonly string[]).includes(dt);
}

function isSparseVectorType(dt: string): boolean {
  return dt.startsWith('SPARSE_VECTOR');
}

function isDenseVectorType(dt: string): boolean {
  return isVectorType(dt) && !isSparseVectorType(dt);
}

/**
 * Infer the path separator from an existing path string.
 * If the path contains backslash (Windows-style), return `\`; otherwise `/`.
 */
function inferSep(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/** Strip trailing path separators (both `/` and `\`). */
function stripTrailingSep(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

interface FieldDraft {
  id: string;
  name: string;
  dataType: AnyDataType;
  // Vector-specific
  dimension: string;
  metric: (typeof METRICS)[number];
  indexType: (typeof INDEX_TYPES)[number];
  quantizeType: (typeof QUANTIZE_TYPES)[number];
  enableRotate: boolean;
  m: string;
  efConstruction: string;
  nList: string;
  nIters: string;
  totalBits: string;
  numClusters: string;
  maxDegree: string;
  listSize: string;
  pqChunkNum: string;
  // Scalar-specific
  nullable: boolean;
  indexed: boolean;
  scalarIndexType: (typeof SCALAR_INDEX_TYPES)[number];
  tokenizerName: (typeof FTS_TOKENIZERS)[number];
  ftsAsciiFolding: boolean;
  ftsStemmer: boolean;
  ftsExtraParams: string;
  enableRangeOptimization: boolean;
  enableExtendedWildcard: boolean;
}

function makeField(overrides?: Partial<FieldDraft>): FieldDraft {
  return {
    id: `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    dataType: 'STRING',
    dimension: '768',
    metric: 'COSINE',
    indexType: 'HNSW',
    quantizeType: 'UNDEFINED',
    enableRotate: false,
    m: '50',
    efConstruction: '500',
    nList: '',
    nIters: '10',
    totalBits: '7',
    numClusters: '16',
    maxDegree: '100',
    listSize: '50',
    pqChunkNum: '0',
    nullable: false,
    indexed: false,
    scalarIndexType: 'INVERT',
    tokenizerName: 'standard',
    ftsAsciiFolding: false,
    ftsStemmer: false,
    ftsExtraParams: '',
    enableRangeOptimization: false,
    enableExtendedWildcard: false,
    ...overrides,
  };
}

function makeDefaultVectorField(): FieldDraft {
  return makeField({ name: 'embedding', dataType: 'VECTOR_FP32' });
}

function buildVectorParams(f: FieldDraft): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (f.quantizeType !== 'UNDEFINED') {
    params.quantizeType = f.quantizeType;
  }
  if (
    f.enableRotate &&
    (f.quantizeType === 'INT8' || f.quantizeType === 'INT4') &&
    (f.indexType === 'HNSW' || f.indexType === 'FLAT' || f.indexType === 'VAMANA')
  ) {
    params.quantizerParam = { enableRotate: true };
  }
  switch (f.indexType) {
    case 'HNSW':
      if (f.m) params.M = Number(f.m);
      if (f.efConstruction) params.efConstruction = Number(f.efConstruction);
      break;
    case 'IVF':
      if (f.nList) params.nList = Number(f.nList);
      if (f.nIters) params.nIters = Number(f.nIters);
      break;
    case 'HNSW_RABITQ':
      if (f.m) params.M = Number(f.m);
      if (f.efConstruction) params.efConstruction = Number(f.efConstruction);
      if (f.totalBits) params.totalBits = Number(f.totalBits);
      if (f.numClusters) params.numClusters = Number(f.numClusters);
      break;
    case 'VAMANA':
      if (f.maxDegree) params.maxDegree = Number(f.maxDegree);
      if (f.listSize) params.searchListSize = Number(f.listSize);
      break;
    case 'DISKANN':
      if (f.maxDegree) params.maxDegree = Number(f.maxDegree);
      if (f.listSize) params.listSize = Number(f.listSize);
      if (f.pqChunkNum) params.pqChunkNum = Number(f.pqChunkNum);
      break;
    case 'FLAT':
      break;
  }
  return params;
}

export interface CreateCollectionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function CreateCollectionDialog({
  open,
  onClose,
}: CreateCollectionDialogProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const mutation = useCreateCollection();

  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldDraft[]>(() => [makeDefaultVectorField()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function reset(): void {
    setName('');
    setPath('');
    setParentDir(null);
    setFields([makeDefaultVectorField()]);
    setErrors({});
  }

  function clearError(key: string): void {
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  useEffect(() => {
    if (!parentDir) return;
    const next = name.trim() ? `${stripTrailingSep(parentDir)}${inferSep(parentDir)}${name.trim()}` : parentDir;
    setPath(next);
    if (next.trim()) clearError('path');
  }, [parentDir, name]);

  function onPathChange(next: string): void {
    setPath(next);
    if (next.trim()) clearError('path');
    if (parentDir) setParentDir(null);
  }

  function onNameChange(next: string): void {
    setName(next);
    if (next.trim() && COLLECTION_NAME_RE.test(next)) clearError('name');
  }

  function onParentPicked(picked: string): void {
    setParentDir(picked);
    const sanitized = stripTrailingSep(picked);
    const next = name.trim() ? `${sanitized}${inferSep(picked)}${name.trim()}` : sanitized;
    setPath(next);
    if (next.trim()) clearError('path');
  }

  /* ── Field helpers ── */
  function addField(): void {
    setFields((prev) => [...prev, makeField()]);
    clearError('fields');
  }
  function updateField(id: string, patch: Partial<FieldDraft>): void {
    setFields((prev) => prev.map((f) => {
      if (f.id !== id) return f;
      const updated = { ...f, ...patch };
      if (patch.indexType === 'HNSW_RABITQ' && !patch.quantizeType) {
        updated.quantizeType = 'RABITQ';
      }
      if (patch.dataType && isVectorType(patch.dataType)) {
        updated.indexed = false;
        updated.scalarIndexType = 'INVERT';
      }
      if (patch.dataType && !isVectorType(patch.dataType) && patch.dataType !== 'STRING') {
        updated.scalarIndexType = 'INVERT';
      }
      return updated;
    }));
    clearError('fields');
  }
  function removeField(id: string): void {
    setFields((prev) => prev.filter((f) => f.id !== id));
    clearError('fields');
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('pages.collections.create.errors.nameRequired');
    else if (!COLLECTION_NAME_RE.test(name))
      next.name = t('pages.collections.create.errors.nameFormat');
    if (!path.trim()) next.path = t('pages.collections.create.errors.pathRequired');
    if (fields.length === 0) next.fields = t('pages.collections.create.errors.fieldsRequired');
    for (const f of fields) {
      if (!f.name.trim() || !FIELD_NAME_RE.test(f.name)) {
        next[`field_${f.id}`] = t('pages.collections.create.errors.fieldNameRequired');
      }
      if (isDenseVectorType(f.dataType)) {
        const dim = Number.parseInt(f.dimension, 10);
        if (!Number.isFinite(dim) || dim < 1 || dim > 32768) {
          next[`dim_${f.id}`] = t('pages.collections.create.errors.dimRange');
        }
      }
    }
    // Check duplicate field names across all fields (vector + scalar)
    const seen = new Map<string, string>();
    for (const f of fields) {
      const n = f.name.trim();
      if (!n) continue;
      if (seen.has(n) && !next[`field_${f.id}`]) {
        next[`field_${f.id}`] = t('pages.collections.create.errors.duplicateField', { name: n });
      }
      if (!seen.has(n)) seen.set(n, f.id);
    }
    return next;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const vectorFields = fields.filter((f) => isVectorType(f.dataType));
    const scalarFields = fields.filter((f) => !isVectorType(f.dataType));

    const schema: CollectionSchemaPayload = {
      name,
      vectors: vectorFields.map((v) => ({
        name: v.name,
        dataType: v.dataType as (typeof VECTOR_TYPES)[number],
        dimension: Number.parseInt(v.dimension, 10),
        indexParam: {
          indexType: v.indexType,
          metric: isSparseVectorType(v.dataType) ? 'IP' : v.metric,
          params: buildVectorParams(v),
        },
      })),
      fields: scalarFields.map((f) => ({
        name: f.name,
        dataType: f.dataType as (typeof SCALAR_TYPES)[number],
        nullable: f.nullable,
        ...(f.indexed
          ? {
              indexParam: {
                indexType: f.scalarIndexType,
                enableRangeOptimization: f.scalarIndexType === 'INVERT' ? f.enableRangeOptimization : false,
                enableExtendedWildcard: f.scalarIndexType === 'INVERT' ? f.enableExtendedWildcard : false,
                tokenizerName: f.scalarIndexType === 'FTS' ? f.tokenizerName : 'standard',
                filters: f.scalarIndexType === 'FTS'
                  ? [
                      'lowercase',
                      ...(f.ftsAsciiFolding ? ['ascii_folding'] : []),
                      ...(f.ftsStemmer ? ['stemmer'] : []),
                    ]
                  : ['lowercase'],
                extraParams: f.scalarIndexType === 'FTS' ? f.ftsExtraParams : '',
              },
            }
          : {}),
      })),
    };

    try {
      await mutation.mutateAsync({ path, schema });
      toast.push({
        severity: 'info',
        title: t('pages.collections.create.successTitle'),
        description: t('pages.collections.create.successBody', { name, path }),
      });
      reset();
      onClose();
      navigate(`/collections/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof ApiError) {
        toast.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        toast.push({ title: t('errors.unknown'), severity: 'error' });
      }
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title={t('pages.collections.create.title')}
      ariaLabel={t('pages.collections.create.title')}
      size="wide"
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="zv-create-collection-form"
            loading={mutation.isPending}
            data-testid="zv-create-submit"
          >
            {mutation.isPending ? t('pages.collections.create.submitting') : t('actions.create')}
          </Button>
        </>
      }
    >
      <form id="zv-create-collection-form" onSubmit={(e) => void submit(e)} noValidate>
        <Input
          label={t('pages.collections.create.name')}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          helperText={t('pages.collections.create.nameHelp')}
          errorText={errors.name}
          data-testid="zv-create-name"
          required
        />
        <DirectoryInput
          label={t('pages.collections.create.path')}
          value={path}
          onChange={onPathChange}
          onBrowse={onParentPicked}
          helperText={
            parentDir
              ? name.trim()
                ? t('pages.collections.create.pathBrowseHint', { parent: parentDir, name: name.trim() })
                : t('pages.collections.create.pathBrowseHintNoName', { parent: parentDir })
              : t('pages.collections.create.pathHelp')
          }
          errorText={errors.path}
          browseLabel={t('actions.browse')}
          placeholder={t('pages.collections.create.pathPlaceholder')}
          data-testid="zv-create-path"
          required
        />

        {/* ── Fields ── */}
        <div className="zv-create__section">
          <div className="zv-create__section-title">{t('pages.collections.create.fields')}</div>
          {errors.fields && <p className="zv-create__error" role="alert">{errors.fields}</p>}
          <div className="zv-create__field-list">
            {fields.map((field) => (
              <div key={field.id} className={`zv-create__field-card${errors[`field_${field.id}`] ? ' zv-create__field-card--invalid' : ''}`}>
                <CloseButton
                  className="zv-create__field-close"
                  onClick={() => removeField(field.id)}
                  aria-label={t('actions.removeField')}
                />

                <div className="zv-create__field-head">
                  <Input
                    label={t('pages.collections.create.fieldName')}
                    value={field.name}
                    onChange={(e) => {
                      updateField(field.id, { name: e.target.value });
                      clearError(`field_${field.id}`);
                    }}
                    errorText={errors[`field_${field.id}`]}
                    helperText={
                      field.name.trim() === 'id'
                        ? t('pages.collections.create.hints.idColumn')
                        : undefined
                    }
                  />
                  <Select
                    label={t('pages.collections.create.fieldType')}
                    value={field.dataType}
                    onChange={(e) => {
                      updateField(field.id, { dataType: e.target.value as AnyDataType });
                      clearError(`dim_${field.id}`);
                    }}
                    options={ALL_DATA_TYPES.map((dt) => ({ value: dt, label: dt }))}
                  />
                </div>

                {isVectorType(field.dataType) && (
                  <>
                    <div className="zv-create__field-vector">
                      {isDenseVectorType(field.dataType) && (
                        <>
                          <Input
                            label={t('pages.collections.create.vectorDim')}
                            type="number"
                            value={field.dimension}
                            onChange={(e) => {
                              updateField(field.id, { dimension: e.target.value });
                              clearError(`dim_${field.id}`);
                            }}
                            errorText={errors[`dim_${field.id}`]}
                          />
                          <Select
                            label={t('pages.collections.create.metric')}
                            value={field.metric}
                            onChange={(e) => updateField(field.id, { metric: e.target.value as (typeof METRICS)[number] })}
                            options={METRICS.map((m) => ({ value: m, label: m }))}
                          />
                        </>
                      )}
                      <Select
                        label={t('pages.collections.create.indexType')}
                        value={field.indexType}
                        onChange={(e) => updateField(field.id, { indexType: e.target.value as (typeof INDEX_TYPES)[number] })}
                        options={INDEX_TYPES.map((i) => ({ value: i, label: i }))}
                      />
                      <Select
                        label={t('pages.collections.create.quantizeType')}
                        value={field.quantizeType}
                        onChange={(e) => updateField(field.id, { quantizeType: e.target.value as (typeof QUANTIZE_TYPES)[number] })}
                        options={QUANTIZE_TYPES.map((q) => ({ value: q, label: q === 'UNDEFINED' ? t('pages.collections.create.quantizeNone') : q }))}
                      />
                    </div>

                    {(field.quantizeType === 'INT8' || field.quantizeType === 'INT4') &&
                      (field.indexType === 'HNSW' || field.indexType === 'FLAT' || field.indexType === 'VAMANA') && (
                        <label className="zv-create__checkbox">
                          <input
                            type="checkbox"
                            checked={field.enableRotate}
                            onChange={(e) => updateField(field.id, { enableRotate: e.target.checked })}
                          />
                          {t('pages.collections.create.enableRotate')}
                        </label>
                      )}

                    {(field.indexType === 'HNSW' || field.indexType === 'HNSW_RABITQ') && (
                      <div className="zv-create__index-params">
                        <Input label="M" type="number" value={field.m} onChange={(e) => updateField(field.id, { m: e.target.value })} />
                        <Input label="efConstruction" type="number" value={field.efConstruction} onChange={(e) => updateField(field.id, { efConstruction: e.target.value })} />
                        {field.indexType === 'HNSW_RABITQ' && (
                          <>
                            <Input label="totalBits" type="number" value={field.totalBits} onChange={(e) => updateField(field.id, { totalBits: e.target.value })} />
                            <Input label="numClusters" type="number" value={field.numClusters} onChange={(e) => updateField(field.id, { numClusters: e.target.value })} />
                          </>
                        )}
                      </div>
                    )}
                    {field.indexType === 'IVF' && (
                      <div className="zv-create__index-params">
                        <Input label="nList" type="number" value={field.nList} onChange={(e) => updateField(field.id, { nList: e.target.value })} />
                        <Input label="nIters" type="number" value={field.nIters} onChange={(e) => updateField(field.id, { nIters: e.target.value })} />
                      </div>
                    )}
                    {field.indexType === 'VAMANA' && (
                      <div className="zv-create__index-params">
                        <Input label="maxDegree" type="number" value={field.maxDegree} onChange={(e) => updateField(field.id, { maxDegree: e.target.value })} />
                        <Input label="searchListSize" type="number" value={field.listSize} onChange={(e) => updateField(field.id, { listSize: e.target.value })} />
                      </div>
                    )}
                    {field.indexType === 'DISKANN' && (
                      <div className="zv-create__index-params">
                        <Input label="maxDegree" type="number" value={field.maxDegree} onChange={(e) => updateField(field.id, { maxDegree: e.target.value })} />
                        <Input label="listSize" type="number" value={field.listSize} onChange={(e) => updateField(field.id, { listSize: e.target.value })} />
                        <Input label="pqChunkNum" type="number" value={field.pqChunkNum} onChange={(e) => updateField(field.id, { pqChunkNum: e.target.value })} />
                      </div>
                    )}
                  </>
                )}

                {!isVectorType(field.dataType) && (
                  <div className="zv-create__field-scalar-params">
                    <label className="zv-create__checkbox">
                      <input
                        type="checkbox"
                        checked={field.nullable}
                        onChange={(e) => updateField(field.id, { nullable: e.target.checked })}
                      />
                      {t('pages.collections.create.nullable')}
                    </label>
                    <label className="zv-create__checkbox">
                      <input
                        type="checkbox"
                        checked={field.indexed}
                        onChange={(e) => updateField(field.id, { indexed: e.target.checked })}
                      />
                      {t('pages.collections.create.indexed')}
                    </label>
                    {field.indexed && (
                      <>
                        <Select
                          label={t('pages.collections.create.scalarIndexType')}
                          value={field.scalarIndexType}
                          onChange={(e) => updateField(field.id, { scalarIndexType: e.target.value as (typeof SCALAR_INDEX_TYPES)[number] })}
                          options={(field.dataType === 'STRING' ? SCALAR_INDEX_TYPES : ['INVERT']).map((i) => ({ value: i, label: i }))}
                        />
                        {field.scalarIndexType === 'FTS' ? (
                          <div className="zv-create__index-params">
                            <Select
                              label={t('pages.collections.create.tokenizerName')}
                              value={field.tokenizerName}
                              onChange={(e) => updateField(field.id, { tokenizerName: e.target.value as (typeof FTS_TOKENIZERS)[number] })}
                              options={FTS_TOKENIZERS.map((i) => ({ value: i, label: i }))}
                            />
                            <label className="zv-create__checkbox">
                              <input
                                type="checkbox"
                                checked={field.ftsAsciiFolding}
                                onChange={(e) => updateField(field.id, { ftsAsciiFolding: e.target.checked })}
                              />
                              {t('pages.collections.create.asciiFolding')}
                            </label>
                            <label className="zv-create__checkbox">
                              <input
                                type="checkbox"
                                checked={field.ftsStemmer}
                                onChange={(e) => updateField(field.id, { ftsStemmer: e.target.checked })}
                              />
                              {t('pages.collections.create.stemmer')}
                            </label>
                            <Input
                              label={t('pages.collections.create.extraParams')}
                              value={field.ftsExtraParams}
                              onChange={(e) => updateField(field.id, { ftsExtraParams: e.target.value })}
                            />
                          </div>
                        ) : (
                          <>
                            <label className="zv-create__checkbox">
                              <input
                                type="checkbox"
                                checked={field.enableRangeOptimization}
                                onChange={(e) => updateField(field.id, { enableRangeOptimization: e.target.checked })}
                              />
                              {t('pages.collections.create.rangeOptimization')}
                            </label>
                            <label className="zv-create__checkbox">
                              <input
                                type="checkbox"
                                checked={field.enableExtendedWildcard}
                                onChange={(e) => updateField(field.id, { enableExtendedWildcard: e.target.checked })}
                              />
                              {t('pages.collections.create.extendedWildcard')}
                            </label>
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={addField} className="zv-create__add-field">
            {t('actions.addField')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
