import { useEffect, useState, useMemo, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, CloseButton } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import type { CollectionSummary } from '@/features/collections/api';
import type { SearchRequest, SearchResponse, SearchResult } from '@/features/searches/api';
import { useSearchDocuments } from '@/features/searches/hooks';
import { useListEmbeddings, useEmbed, useListRerankers } from '@/features/ai/hooks';
import type { EmbedResponse, RerankerFunctionRecord } from '@/features/ai/api';
import { getEmbeddingDimension, getEmbeddingTag } from '@/features/ai/utils';
import { FilterBuilder } from './FilterBuilder';
import {
  embeddingMatchesVector,
  isDenseVectorType,
  isSparseVectorType,
  parseRawVector,
  randomVectorText,
  vectorPlaceholder,
  vectorTagLabel,
} from './vector-utils';

interface VQState {
  field: string;
  routeType: 'vector' | 'fts';
  mode: 'vector' | 'id' | 'text';
  embedding: string;
  vectorText: string;
  idText: string;
  queryText: string;
  ftsMode: 'match' | 'query';
  ftsText: string;
  defaultOperator: 'OR' | 'AND';
  hnswEf: string;
  hnswRadius: string;
  hnswLinear: boolean;
  hnswRefiner: boolean;
  ivfNprobe: string;
  vamanaEfSearch: string;
  diskAnnListSize: string;
}

export interface QueryTabProps {
  collection: CollectionSummary;
}

interface AddableQueryField {
  field: string;
  routeType: 'vector' | 'fts';
  label: string;
}

interface QueryTabStoredState {
  queries: VQState[];
  topK: number;
  filter: string;
  outputFields: string[];
  includeVector: boolean;
  rerankerName: string;
  results: SearchResult[];
  tookMs: number | null;
}

const SCORE_PRECISION = 4;
const DEFAULT_MULTIQUERY_RERANKER = 'rrf';
const DEFAULT_MULTIQUERY_RERANKER_RECORD: RerankerFunctionRecord = {
  name: DEFAULT_MULTIQUERY_RERANKER,
  description: 'Reciprocal Rank Fusion',
  config: { type: 'rrf', rankConstant: 60 },
};

const CopyIcon = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
    <path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5" />
  </svg>
);

function makeVectorQuery(field: string): VQState {
  return {
    field,
    routeType: 'vector',
    mode: 'vector',
    embedding: '',
    vectorText: '',
    idText: '',
    queryText: '',
    ftsMode: 'match',
    ftsText: '',
    defaultOperator: 'OR',
    hnswEf: '300',
    hnswRadius: '0',
    hnswLinear: false,
    hnswRefiner: false,
    ivfNprobe: '10',
    vamanaEfSearch: '200',
    diskAnnListSize: '300',
  };
}

function makeFtsQuery(field: string): VQState {
  return {
    ...makeVectorQuery(field),
    routeType: 'fts',
    ftsMode: 'match',
    ftsText: '',
    defaultOperator: 'OR',
  };
}

function makeDefaultQueries(
  vectors: NonNullable<CollectionSummary['schema']['vectors']>,
  ftsFields: NonNullable<CollectionSummary['schema']['fields']>,
): VQState[] {
  if (vectors.length > 0) return [makeVectorQuery(vectors[0].name)];
  if (ftsFields.length > 0) return [makeFtsQuery(ftsFields[0].name)];
  return [];
}

function queryStorageKey(collection: CollectionSummary): string {
  return `zvec-studio.query-tab.${collection.path}.${collection.name}`;
}

function normalizeStoredQuery(
  q: unknown,
  vectors: NonNullable<CollectionSummary['schema']['vectors']>,
  ftsFields: NonNullable<CollectionSummary['schema']['fields']>,
): VQState | null {
  if (!q || typeof q !== 'object') return null;
  const candidate = q as Partial<VQState>;
  if (typeof candidate.field !== 'string' || !candidate.field) return null;

  const hasVectorField =
    candidate.routeType === 'vector' && vectors.some((v) => v.name === candidate.field);
  const hasFtsField =
    candidate.routeType === 'fts' && ftsFields.some((f) => f.name === candidate.field);
  if (!hasVectorField && !hasFtsField) return null;

  const base = hasVectorField ? makeVectorQuery(candidate.field) : makeFtsQuery(candidate.field);
  return {
    ...base,
    mode: candidate.mode === 'id' || candidate.mode === 'text' || candidate.mode === 'vector'
      ? candidate.mode
      : base.mode,
    embedding: typeof candidate.embedding === 'string' ? candidate.embedding : base.embedding,
    vectorText: typeof candidate.vectorText === 'string' ? candidate.vectorText : base.vectorText,
    idText: typeof candidate.idText === 'string' ? candidate.idText : base.idText,
    queryText: typeof candidate.queryText === 'string' ? candidate.queryText : base.queryText,
    ftsMode: candidate.ftsMode === 'query' || candidate.ftsMode === 'match'
      ? candidate.ftsMode
      : base.ftsMode,
    ftsText: typeof candidate.ftsText === 'string' ? candidate.ftsText : base.ftsText,
    defaultOperator: candidate.defaultOperator === 'AND' ? 'AND' : base.defaultOperator,
    hnswEf: typeof candidate.hnswEf === 'string' ? candidate.hnswEf : base.hnswEf,
    hnswRadius: typeof candidate.hnswRadius === 'string' ? candidate.hnswRadius : base.hnswRadius,
    hnswLinear: typeof candidate.hnswLinear === 'boolean' ? candidate.hnswLinear : base.hnswLinear,
    hnswRefiner: typeof candidate.hnswRefiner === 'boolean' ? candidate.hnswRefiner : base.hnswRefiner,
    ivfNprobe: typeof candidate.ivfNprobe === 'string' ? candidate.ivfNprobe : base.ivfNprobe,
    vamanaEfSearch: typeof candidate.vamanaEfSearch === 'string' ? candidate.vamanaEfSearch : base.vamanaEfSearch,
    diskAnnListSize: typeof candidate.diskAnnListSize === 'string' ? candidate.diskAnnListSize : base.diskAnnListSize,
  };
}

function loadStoredState(
  key: string,
  vectors: NonNullable<CollectionSummary['schema']['vectors']>,
  ftsFields: NonNullable<CollectionSummary['schema']['fields']>,
): QueryTabStoredState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QueryTabStoredState>;
    const storedQueries = Array.isArray(parsed.queries)
      ? parsed.queries
        .map((q) => normalizeStoredQuery(q, vectors, ftsFields))
        .filter((q): q is VQState => q !== null)
      : [];
    return {
      queries: storedQueries.length > 0 ? storedQueries : makeDefaultQueries(vectors, ftsFields),
      topK: typeof parsed.topK === 'number' ? parsed.topK : 10,
      filter: typeof parsed.filter === 'string' ? parsed.filter : '',
      outputFields: Array.isArray(parsed.outputFields) ? parsed.outputFields.filter((v): v is string => typeof v === 'string') : [],
      includeVector: Boolean(parsed.includeVector),
      rerankerName: typeof parsed.rerankerName === 'string' ? parsed.rerankerName : '',
      results: Array.isArray(parsed.results) ? parsed.results as SearchResult[] : [],
      tookMs: typeof parsed.tookMs === 'number' ? parsed.tookMs : null,
    };
  } catch {
    return null;
  }
}

function saveStoredState(key: string, state: QueryTabStoredState): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(key, JSON.stringify(state));
}

function numericParam(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildVectorQueryParam(q: VQState, indexType: string | undefined): Record<string, unknown> | undefined {
  switch (indexType) {
    case 'HNSW':
    case 'HNSW_RABITQ':
      return {
        type: indexType,
        ef: numericParam(q.hnswEf, 300),
        radius: numericParam(q.hnswRadius, 0),
        isLinear: q.hnswLinear,
        isUsingRefiner: q.hnswRefiner,
      };
    case 'IVF':
      return { type: 'IVF', nprobe: numericParam(q.ivfNprobe, 10) };
    case 'VAMANA':
      return {
        type: 'VAMANA',
        efSearch: numericParam(q.vamanaEfSearch, 200),
        radius: numericParam(q.hnswRadius, 0),
        isLinear: q.hnswLinear,
        isUsingRefiner: q.hnswRefiner,
      };
    case 'DISKANN':
      return { type: 'DISKANN', listSize: numericParam(q.diskAnnListSize, 300) };
    default:
      return undefined;
  }
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (value.length > 4) return `[${value.slice(0, 3).map(String).join(', ')}, ...]`;
    return `[${value.map(String).join(', ')}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function QueryTab({ collection }: QueryTabProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const vectors = useMemo(() => collection.schema.vectors ?? [], [collection.schema.vectors]);
  const ftsFields = useMemo(
    () =>
      (collection.schema.fields ?? []).filter(
        (f) => f.dataType === 'STRING' && f.indexParam?.indexType === 'FTS',
      ),
    [collection.schema.fields],
  );
  const searchMutation = useSearchDocuments(collection.name);
  const embeddings = useListEmbeddings();
  const rerankers = useListRerankers();
  const embedMutation = useEmbed();
  const storageKey = queryStorageKey(collection);
  const initialStoredState = useMemo(
    () => loadStoredState(storageKey, vectors, ftsFields),
    [storageKey, vectors, ftsFields],
  );

  const [queries, setQueries] = useState<VQState[]>(() => initialStoredState?.queries ?? makeDefaultQueries(vectors, ftsFields));

  const [topK, setTopK] = useState(initialStoredState?.topK ?? 10);
  const [filter, setFilter] = useState(initialStoredState?.filter ?? '');
  const [outputFields, setOutputFields] = useState<string[]>(() => initialStoredState?.outputFields ?? []);
  const [includeVector, setIncludeVector] = useState(initialStoredState?.includeVector ?? false);
  const [rerankerName, setRerankerName] = useState(initialStoredState?.rerankerName ?? '');
  const [results, setResults] = useState<SearchResult[]>(() => initialStoredState?.results ?? []);
  const [tookMs, setTookMs] = useState<number | null>(initialStoredState?.tookMs ?? null);
  const [addFieldKey, setAddFieldKey] = useState('');

  const resultColumnKeys = useMemo(() => {
    if (results.length === 0) return [] as string[];
    const seen = new Set<string>(['id']);
    const out: string[] = [];
    for (const item of results) {
      for (const key of Object.keys(item.fields)) {
        if (!seen.has(key)) {
          seen.add(key);
          out.push(key);
        }
      }
    }
    return out;
  }, [results]);

  function copyText(text: string): void {
    void navigator.clipboard.writeText(text);
    toast.push({ severity: 'info', title: t('pages.collections.detail.browse.copied') });
  }

  function handleCopyResult(item: SearchResult): void {
    const doc = { id: item.id, score: item.score, ...item.fields };
    copyText(JSON.stringify(doc, null, 2));
  }

  function handleCopyCell(value: unknown): void {
    if (value === null || value === undefined) return;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    copyText(text);
  }

  const allEmbeddings = useMemo(() => embeddings.data?.items ?? [], [embeddings.data]);
  const listedRerankerItems = useMemo(() => rerankers.data?.items ?? [], [rerankers.data]);
  const rerankerItems = useMemo(
    () =>
      listedRerankerItems.some((r) => r.name === DEFAULT_MULTIQUERY_RERANKER)
        ? listedRerankerItems
        : [DEFAULT_MULTIQUERY_RERANKER_RECORD, ...listedRerankerItems],
    [listedRerankerItems],
  );

  const usedFields = useMemo(() => new Set(queries.map((q) => q.field)), [queries]);
  const isMultiQuery = queries.length > 1;

  const availableFieldsForAdd = useMemo(
    (): AddableQueryField[] => [
      ...vectors
        .filter((v) => !usedFields.has(v.name))
        .map((v) => ({
          field: v.name,
          routeType: 'vector' as const,
          label: `${v.name} (${vectorTagLabel(v)})`,
        })),
      ...ftsFields
        .filter((f) => !usedFields.has(f.name))
        .map((f) => ({ field: f.name, routeType: 'fts' as const, label: `${f.name} (FTS)` })),
    ],
    [vectors, ftsFields, usedFields],
  );

  useEffect(() => {
    if (addFieldKey && !availableFieldsForAdd.some((f) => `${f.routeType}:${f.field}` === addFieldKey)) {
      setAddFieldKey('');
    }
  }, [addFieldKey, availableFieldsForAdd]);

  useEffect(() => {
    if (!isMultiQuery && rerankerName) {
      setRerankerName('');
      return;
    }
    if (isMultiQuery && !rerankerName) {
      setRerankerName(DEFAULT_MULTIQUERY_RERANKER);
    }
  }, [isMultiQuery, rerankerName]);

  useEffect(() => {
    saveStoredState(storageKey, {
      queries,
      topK,
      filter,
      outputFields,
      includeVector,
      rerankerName: isMultiQuery ? rerankerName : '',
      results,
      tookMs,
    });
  }, [storageKey, queries, topK, filter, outputFields, includeVector, isMultiQuery, rerankerName, results, tookMs]);

  const queryDimMismatches = useMemo(
    () =>
      queries.map((q) => {
        if (q.routeType !== 'vector') return false;
        if (!q.embedding) return false;
        const vec = vectors.find((v) => v.name === q.field);
        if (!vec || !isDenseVectorType(vec.dataType)) return false;
        const emb = allEmbeddings.find((e) => e.name === q.embedding);
        const eDim = emb ? getEmbeddingDimension(emb.config) : null;
        const fDim = vec.dimension ?? null;
        return eDim !== null && fDim !== null && eDim !== fDim;
      }),
    [queries, allEmbeddings, vectors],
  );
  const anyDimMismatch = queryDimMismatches.some(Boolean);

  function updateQuery(index: number, patch: Partial<VQState>): void {
    setQueries((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  function removeQuery(index: number): void {
    setQueries((prev) => prev.filter((_, i) => i !== index));
  }

  function addQuery(): void {
    const next = availableFieldsForAdd.find((f) => `${f.routeType}:${f.field}` === addFieldKey);
    if (!next) return;
    setQueries((prev) => [
      ...prev,
      next.routeType === 'vector' ? makeVectorQuery(next.field) : makeFtsQuery(next.field),
    ]);
    setAddFieldKey('');
  }

  async function handleSearch(e: FormEvent): Promise<void> {
    e.preventDefault();

    const querySpecs: Array<Record<string, unknown>> = [];

    for (const q of queries) {
      if (q.routeType === 'fts') {
        const text = q.ftsText.trim();
        if (!text) continue;
        querySpecs.push({
          field: q.field,
          fts: q.ftsMode === 'match' ? { matchString: text } : { queryString: text },
          param: { type: 'FTS', defaultOperator: q.defaultOperator },
        });
        continue;
      }

      const vecSchema = vectors.find((v) => v.name === q.field);
      if (!vecSchema) continue;
      const param = buildVectorQueryParam(q, vecSchema.indexParam?.indexType);
      if (q.embedding && q.mode === 'text') {
        if (!q.queryText.trim()) continue;
        try {
          const res: EmbedResponse = await embedMutation.mutateAsync({
            name: q.embedding,
            body: { texts: [q.queryText], isQuery: true },
          });
          if (isSparseVectorType(vecSchema.dataType) && res.kind !== 'sparse') continue;
          if (isDenseVectorType(vecSchema.dataType) && res.kind !== 'dense') continue;
          const vec = res.vectors[0];
          if (!vec) continue;
          querySpecs.push({ field: q.field, vector: vec, ...(param ? { param } : {}) });
        } catch (err) {
          toast.push({
            severity: 'error',
            title: t('pages.collections.detail.query.embedFailed'),
            description: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      } else if (q.mode === 'id') {
        if (!q.idText.trim()) continue;
        querySpecs.push({ field: q.field, id: q.idText.trim(), ...(param ? { param } : {}) });
      } else {
        const vec = parseRawVector(q.vectorText, vecSchema);
        if (!vec) continue;
        querySpecs.push({ field: q.field, vector: vec, ...(param ? { param } : {}) });
      }
    }

    if (querySpecs.length === 0) return;

    const body: SearchRequest = {
      queries: querySpecs as SearchRequest['queries'],
      topK,
      filter: filter.trim() || null,
      outputFields: outputFields.includes('__none__') ? [] : outputFields.length > 0 ? outputFields : null,
      includeVector,
      rerankerName: querySpecs.length > 1 ? (rerankerName || DEFAULT_MULTIQUERY_RERANKER) : null,
    };

    try {
      const res: SearchResponse = await searchMutation.mutateAsync(body);
      setResults(res.results);
      setTookMs(res.took_ms);
    } catch (err) {
      toast.push({
        severity: 'error',
        title: t('pages.collections.detail.query.searchFailed'),
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="zv-query-layout">
      <form className="zv-query-form" onSubmit={(e) => void handleSearch(e)} noValidate>
        <div className="zv-section-head">
          <span className="zv-query-section-title">{t('pages.collections.detail.query.queryRoutes')}</span>
          <div className="zv-query-add-control">
            <select
              className="zv-form-select"
              value={addFieldKey}
              onChange={(e) => setAddFieldKey(e.target.value)}
              disabled={availableFieldsForAdd.length === 0}
              aria-label={t('pages.collections.detail.query.selectColumn')}
            >
              <option value="">{t('pages.collections.detail.query.selectColumn')}</option>
              {availableFieldsForAdd.map((f) => (
                <option key={`${f.routeType}:${f.field}`} value={`${f.routeType}:${f.field}`}>
                  {f.label}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={!addFieldKey}
              onClick={addQuery}
              aria-label={t('pages.collections.detail.query.addQuery')}
            >
              +
            </Button>
          </div>
        </div>

        {queries.map((q, idx) => {
          const vecSchema = vectors.find((v) => v.name === q.field);
          const ftsField = ftsFields.find((f) => f.name === q.field);
          const indexType = vecSchema?.indexParam?.indexType;
          const matchingEmbeddings = allEmbeddings.filter((emb) => embeddingMatchesVector(emb, vecSchema));

          const dimMismatch = queryDimMismatches[idx] ?? false;
          const selectedEmb = q.embedding
            ? allEmbeddings.find((e) => e.name === q.embedding)
            : null;
          const embDim = selectedEmb ? getEmbeddingDimension(selectedEmb.config) : null;
          const fieldDim = vecSchema?.dimension ?? null;

        return (
            <div className="zv-vq-card" key={`${q.routeType}:${q.field}`}>
              <div className="zv-vq-card__head">
                <span className="zv-vq-field-name">{q.field}</span>
                {q.routeType === 'vector' && vecSchema && (
                  <span className="zv-vq-field-tag">{vectorTagLabel(vecSchema)}</span>
                )}
                {q.routeType === 'fts' && ftsField && (
                  <span className="zv-vq-field-tag">{t('pages.collections.detail.query.ftsFieldTag')}</span>
                )}
                <CloseButton
                  className="zv-vq-remove"
                  onClick={() => removeQuery(idx)}
                />
              </div>

              {q.routeType === 'fts' ? (
                <>
                  <div className="zv-input-mode-tabs">
                    <button
                      type="button"
                      className={`zv-input-mode-tab${q.ftsMode === 'match' ? ' zv-input-mode-tab--active' : ''}`}
                      onClick={() => updateQuery(idx, { ftsMode: 'match' })}
                    >
                      {t('pages.collections.detail.query.modeFtsMatch')}
                    </button>
                    <button
                      type="button"
                      className={`zv-input-mode-tab${q.ftsMode === 'query' ? ' zv-input-mode-tab--active' : ''}`}
                      onClick={() => updateQuery(idx, { ftsMode: 'query' })}
                    >
                      {t('pages.collections.detail.query.modeFtsQuery')}
                    </button>
                  </div>
                  <div className="zv-form-group" style={{ marginTop: 10 }}>
                    <textarea
                      className="zv-form-textarea"
                      placeholder={
                        q.ftsMode === 'match'
                          ? t('pages.collections.detail.query.ftsMatchPlaceholder')
                          : t('pages.collections.detail.query.ftsQueryPlaceholder')
                      }
                      value={q.ftsText}
                      onChange={(e) => updateQuery(idx, { ftsText: e.target.value })}
                    />
                  </div>
                  <div className="zv-form-group">
                    <label className="zv-form-label">{t('pages.collections.detail.query.defaultOperator')}</label>
                    <select
                      className="zv-form-select"
                      value={q.defaultOperator}
                      onChange={(e) => updateQuery(idx, { defaultOperator: e.target.value as 'OR' | 'AND' })}
                    >
                      <option value="OR">OR</option>
                      <option value="AND">AND</option>
                    </select>
                  </div>
                </>
              ) : (
                <>
              <div className="zv-form-group">
                <label className="zv-form-label">{t('pages.collections.detail.query.embedding')}</label>
                <select
                  className="zv-form-select"
                  value={q.embedding}
                  onChange={(e) => {
                    const val = e.target.value;
                    updateQuery(idx, {
                      embedding: val,
                      mode: val ? 'text' : 'vector',
                    });
                  }}
                >
                  <option value="">{t('pages.collections.detail.query.embeddingNone')}</option>
                  {matchingEmbeddings.map((emb) => (
                    <option key={emb.name} value={emb.name}>
                      {emb.name} ({getEmbeddingTag(emb)})
                    </option>
                  ))}
                </select>
                {dimMismatch && (
                  <span className="zv-form-hint" style={{ color: 'var(--zv-color-warning)' }}>
                    {t('pages.collections.detail.query.dimMismatch', { embDim, fieldDim })}
                  </span>
                )}
              </div>

              {!q.embedding ? (
                <>
                  <div className="zv-input-mode-tabs">
                    <button
                      type="button"
                      className={`zv-input-mode-tab${q.mode === 'vector' ? ' zv-input-mode-tab--active' : ''}`}
                      onClick={() => updateQuery(idx, { mode: 'vector' })}
                    >
                      {t('pages.collections.detail.query.modeVector')}
                    </button>
                    <button
                      type="button"
                      className={`zv-input-mode-tab${q.mode === 'id' ? ' zv-input-mode-tab--active' : ''}`}
                      onClick={() => updateQuery(idx, { mode: 'id' })}
                    >
                      {t('pages.collections.detail.query.modeId')}
                    </button>
                  </div>

                  {q.mode === 'vector' ? (
                    <div className="zv-form-group" style={{ marginTop: 10 }}>
                      <div className="zv-vector-editor">
                        <div className="zv-vector-editor__toolbar">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={!vecSchema}
                            onClick={() => {
                              if (vecSchema) updateQuery(idx, { vectorText: randomVectorText(vecSchema) });
                            }}
                          >
                            {t('pages.collections.detail.query.randomVector')}
                          </Button>
                        </div>
                        <textarea
                          className="zv-form-textarea"
                          placeholder={vectorPlaceholder(vecSchema)}
                          value={q.vectorText}
                          spellCheck={false}
                          onChange={(e) => updateQuery(idx, { vectorText: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="zv-form-group" style={{ marginTop: 10 }}>
                      <input
                        className="zv-form-input"
                        placeholder={t('pages.collections.detail.query.idPlaceholder')}
                        value={q.idText}
                        onChange={(e) => updateQuery(idx, { idText: e.target.value })}
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="zv-form-group">
                  <textarea
                    className="zv-form-textarea"
                    placeholder={dimMismatch ? t('pages.collections.detail.query.textDisabled') : t('pages.collections.detail.query.textPlaceholder')}
                    value={q.queryText}
                    disabled={dimMismatch}
                    onChange={(e) => updateQuery(idx, { queryText: e.target.value })}
                  />
                </div>
              )}
                </>
              )}

              {q.routeType === 'vector' && (indexType === 'HNSW' || indexType === 'HNSW_RABITQ') && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.ef')}</label>
                        <input
                          className="zv-form-input"
                          type="number"
                          value={q.hnswEf}
                          min={1}
                          onChange={(e) => updateQuery(idx, { hnswEf: e.target.value })}
                        />
                        <span className="zv-form-hint">{t('pages.collections.detail.query.efHint')}</span>
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.radius')}</label>
                        <input
                          className="zv-form-input"
                          type="number"
                          value={q.hnswRadius}
                          step="any"
                          onChange={(e) => updateQuery(idx, { hnswRadius: e.target.value })}
                        />
                        <span className="zv-form-hint">{t('pages.collections.detail.query.radiusHint')}</span>
                      </div>
                    </div>
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input
                            type="checkbox"
                            checked={q.hnswLinear}
                            onChange={(e) => updateQuery(idx, { hnswLinear: e.target.checked })}
                          /> {t('pages.collections.detail.query.isLinear')}
                        </label>
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input
                            type="checkbox"
                            checked={q.hnswRefiner}
                            onChange={(e) => updateQuery(idx, { hnswRefiner: e.target.checked })}
                          /> {t('pages.collections.detail.query.isUsingRefiner')}
                        </label>
                      </div>
                    </div>
                  </div>
                </details>
              )}

              {q.routeType === 'vector' && indexType === 'IVF' && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-group">
                      <label className="zv-form-label">{t('pages.collections.detail.query.nprobe')}</label>
                      <input
                        className="zv-form-input"
                        type="number"
                        value={q.ivfNprobe}
                        min={1}
                        onChange={(e) => updateQuery(idx, { ivfNprobe: e.target.value })}
                      />
                      <span className="zv-form-hint">{t('pages.collections.detail.query.nprobeHint')}</span>
                    </div>
                  </div>
                </details>
              )}

              {q.routeType === 'vector' && indexType === 'VAMANA' && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.efSearch')}</label>
                        <input
                          className="zv-form-input"
                          type="number"
                          value={q.vamanaEfSearch}
                          min={1}
                          onChange={(e) => updateQuery(idx, { vamanaEfSearch: e.target.value })}
                        />
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.radius')}</label>
                        <input
                          className="zv-form-input"
                          type="number"
                          value={q.hnswRadius}
                          step="any"
                          onChange={(e) => updateQuery(idx, { hnswRadius: e.target.value })}
                        />
                      </div>
                    </div>
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input
                            type="checkbox"
                            checked={q.hnswLinear}
                            onChange={(e) => updateQuery(idx, { hnswLinear: e.target.checked })}
                          /> {t('pages.collections.detail.query.isLinear')}
                        </label>
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input
                            type="checkbox"
                            checked={q.hnswRefiner}
                            onChange={(e) => updateQuery(idx, { hnswRefiner: e.target.checked })}
                          /> {t('pages.collections.detail.query.isUsingRefiner')}
                        </label>
                      </div>
                    </div>
                  </div>
                </details>
              )}

              {q.routeType === 'vector' && indexType === 'DISKANN' && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-group">
                      <label className="zv-form-label">{t('pages.collections.detail.query.diskAnnListSize')}</label>
                      <input
                        className="zv-form-input"
                        type="number"
                        value={q.diskAnnListSize}
                        min={1}
                        onChange={(e) => updateQuery(idx, { diskAnnListSize: e.target.value })}
                      />
                      <span className="zv-form-hint">{t('pages.collections.detail.query.diskAnnListSizeHint')}</span>
                    </div>
                  </div>
                </details>
              )}

            </div>
          );
        })}

        {isMultiQuery && (
          <div className="zv-form-group">
            <label className="zv-form-label">{t('pages.collections.detail.query.reranker')}</label>
            <select
              className="zv-form-select"
              value={rerankerName}
              onChange={(e) => setRerankerName(e.target.value)}
            >
              <option value="">{t('pages.collections.detail.query.rerankerNone')}</option>
              {rerankerItems.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid var(--zv-color-border)', margin: '10px 0' }} />

        <div className="zv-query-inline-row">
          <div className="zv-query-inline-field">
            <label className="zv-form-label">{t('pages.collections.detail.query.topK')}</label>
            <input
              className="zv-form-input"
              type="number"
              min={1}
              max={100}
              value={topK}
              style={{ width: 72 }}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setTopK(Math.max(1, Math.min(100, Math.round(v))));
              }}
            />
          </div>
          <div className="zv-query-inline-field">
            <label className="zv-form-label">{t('pages.collections.detail.query.includeVector')}</label>
            <button
              type="button"
              className={`zv-toggle-switch${includeVector ? ' zv-toggle-switch--on' : ''}`}
              onClick={() => setIncludeVector((v) => !v)}
              role="switch"
              aria-checked={includeVector}
            >
              <span className="zv-toggle-switch__track">
                <span className="zv-toggle-switch__thumb" />
              </span>
            </button>
          </div>
          <div className="zv-query-inline-field">
            <label className="zv-form-label">{t('pages.collections.detail.query.outputFields')}</label>
            <div className="zv-output-field-select">
              <select
                className="zv-form-select"
                value=""
                onChange={(e) => {
                  const val = e.target.value;
                  if (!val) return;
                  if (val === '__none__') {
                    setOutputFields(['__none__']);
                  } else {
                    setOutputFields((prev) => {
                      const cleaned = prev.filter((n) => n !== '__none__');
                      return cleaned.includes(val) ? cleaned : [...cleaned, val];
                    });
                  }
                }}
              >
                <option value="">
                  {outputFields.length === 0
                    ? t('pages.collections.detail.query.outputFieldsAll')
                    : outputFields.includes('__none__')
                      ? t('pages.collections.detail.query.outputFieldsNone')
                      : outputFields.join(', ')}
                </option>
                <option value="__none__">{t('pages.collections.detail.query.outputFieldsNone')}</option>
                {(collection.schema.fields ?? []).map((f) => (
                  <option key={f.name} value={f.name} disabled={outputFields.includes(f.name)}>
                    {f.name}
                  </option>
                ))}
              </select>
              {outputFields.length > 0 && (
                <CloseButton
                  className="zv-output-field-select__clear"
                  onClick={() => setOutputFields([])}
                  title={t('pages.collections.detail.query.resetToAll')}
                />
              )}
            </div>
          </div>
        </div>

        <div className="zv-form-group">
          <label className="zv-form-label">{t('pages.collections.detail.query.filter')}</label>
          <FilterBuilder fields={collection.schema.fields ?? []} value={filter} onChange={(expr) => setFilter(expr)} />
        </div>

        <Button
          variant="primary"
          type="submit"
          className="zv-btn--full"
          disabled={searchMutation.isPending || embedMutation.isPending || anyDimMismatch}
          loading={searchMutation.isPending || embedMutation.isPending}
        >
          {searchMutation.isPending || embedMutation.isPending
            ? t('pages.collections.detail.query.searching')
            : t('pages.collections.detail.query.search')}
        </Button>
      </form>

      {(results.length > 0 || tookMs !== null) && (
        <div className="zv-query-results">
          <div className="zv-qr-header">
            <span className="zv-qr-title">{t('pages.collections.detail.query.results')}</span>
            <span className="zv-qr-meta">
              {tookMs !== null
                ? t('pages.collections.detail.query.resultsMeta', {
                    count: results.length,
                    ms: tookMs.toFixed(1),
                  })
                : ''}
            </span>
          </div>

          {results.length === 0 ? (
            <div className="zv-empty-state">
              {t('pages.collections.detail.query.noResults')}
            </div>
          ) : (
            <div className="zv-data-table-wrap" style={{ border: 'none', borderRadius: 0 }}>
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>score</th>
                    <th>id</th>
                    {resultColumnKeys.map((key) => (
                      <th key={key}>{key}</th>
                    ))}
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {results.map((item, idx) => (
                    <tr key={item.id}>
                      <td><span className={`zv-qr-rank-inline${idx < 3 ? ' zv-qr-rank-inline--top' : ''}`}>{idx + 1}</span></td>
                      <td><span className="zv-qr-score-inline">{item.score.toFixed(SCORE_PRECISION)}</span></td>
                      <td>
                        <div className="zv-cell-copy">
                          <span className="zv-cell-copy__text">{item.id}</span>
                          <button type="button" className="zv-cell-copy__btn" onClick={() => handleCopyCell(item.id)}>
                            {CopyIcon}
                          </button>
                        </div>
                      </td>
                      {resultColumnKeys.map((key) => (
                        <td key={key}>
                          <div className="zv-cell-copy">
                            <span className="zv-cell-copy__text">{formatCellValue(item.fields[key])}</span>
                            {item.fields[key] != null && (
                              <button type="button" className="zv-cell-copy__btn" onClick={() => handleCopyCell(item.fields[key])}>
                                {CopyIcon}
                              </button>
                            )}
                          </div>
                        </td>
                      ))}
                      <td>
                        <button
                          type="button"
                          className="zv-row-copy-btn"
                          onClick={() => handleCopyResult(item)}
                          title={t('pages.collections.detail.query.copyJson')}
                        >
                          {CopyIcon}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
