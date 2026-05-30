import { useState, useMemo, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, CloseButton } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import type { CollectionSummary } from '@/features/collections/api';
import type { SearchRequest, SearchResponse, SearchResult } from '@/features/searches/api';
import { useSearchDocuments } from '@/features/searches/hooks';
import { useListEmbeddings, useEmbed, useListRerankers } from '@/features/ai/hooks';
import type { EmbedResponse } from '@/features/ai/api';
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
  type RawVectorValue,
} from './vector-utils';

interface VQState {
  field: string;
  mode: 'vector' | 'id' | 'text';
  embedding: string;
  vectorText: string;
  idText: string;
  queryText: string;
}

export interface QueryTabProps {
  collection: CollectionSummary;
}

const SCORE_PRECISION = 4;

const CopyIcon = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />
    <path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h2.5" />
  </svg>
);

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
  const searchMutation = useSearchDocuments(collection.name);
  const embeddings = useListEmbeddings();
  const rerankers = useListRerankers();
  const embedMutation = useEmbed();

  const [queries, setQueries] = useState<VQState[]>(() => {
    if (vectors.length === 0) return [];
    return [
      {
        field: vectors[0].name,
        mode: 'vector',
        embedding: '',
        vectorText: '',
        idText: '',
        queryText: '',
      },
    ];
  });

  const [topK, setTopK] = useState(10);
  const [filter, setFilter] = useState('');
  const [outputFields, setOutputFields] = useState<string[]>([]);
  const [includeVector, setIncludeVector] = useState(false);
  const [rerankerName, setRerankerName] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [tookMs, setTookMs] = useState<number | null>(null);

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
  const rerankerItems = useMemo(() => rerankers.data?.items ?? [], [rerankers.data]);

  const usedFields = useMemo(() => new Set(queries.map((q) => q.field)), [queries]);

  const availableFieldsForAdd = useMemo(
    () => vectors.filter((v) => !usedFields.has(v.name)),
    [vectors, usedFields],
  );

  const queryDimMismatches = useMemo(
    () =>
      queries.map((q) => {
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
    const next = availableFieldsForAdd[0];
    if (!next) return;
    setQueries((prev) => [
      ...prev,
      {
        field: next.name,
        mode: 'vector',
        embedding: '',
        vectorText: '',
        idText: '',
        queryText: '',
      },
    ]);
  }

  async function handleSearch(e: FormEvent): Promise<void> {
    e.preventDefault();

    const querySpecs: Array<{ field: string; vector?: RawVectorValue; id?: string }> = [];

    for (const q of queries) {
      const vecSchema = vectors.find((v) => v.name === q.field);
      if (!vecSchema) continue;
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
          querySpecs.push({ field: q.field, vector: vec });
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
        querySpecs.push({ field: q.field, id: q.idText.trim() });
      } else {
        const vec = parseRawVector(q.vectorText, vecSchema);
        if (!vec) continue;
        querySpecs.push({ field: q.field, vector: vec });
      }
    }

    if (querySpecs.length === 0) return;

    const body: SearchRequest = {
      queries: querySpecs,
      topK,
      filter: filter.trim() || null,
      outputFields: outputFields.includes('__none__') ? [] : outputFields.length > 0 ? outputFields : null,
      includeVector,
      rerankerName: rerankerName || null,
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
          <span className="zv-query-section-title">{t('pages.collections.detail.query.vectorQueries')}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={availableFieldsForAdd.length === 0}
            onClick={addQuery}
          >
            +
          </Button>
        </div>

        {queries.map((q, idx) => {
          const vecSchema = vectors.find((v) => v.name === q.field);
          const indexType = vecSchema?.indexParam?.indexType;
          const matchingEmbeddings = allEmbeddings.filter((emb) => embeddingMatchesVector(emb, vecSchema));

          const dimMismatch = queryDimMismatches[idx] ?? false;
          const selectedEmb = q.embedding
            ? allEmbeddings.find((e) => e.name === q.embedding)
            : null;
          const embDim = selectedEmb ? getEmbeddingDimension(selectedEmb.config) : null;
          const fieldDim = vecSchema?.dimension ?? null;

        return (
            <div className="zv-vq-card" key={q.field}>
              <div className="zv-vq-card__head">
                <span className="zv-vq-field-name">{q.field}</span>
                {vecSchema && (
                  <span className="zv-vq-field-tag">{vectorTagLabel(vecSchema)}</span>
                )}
                <CloseButton
                  className="zv-vq-remove"
                  onClick={() => removeQuery(idx)}
                />
              </div>

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

              {(indexType === 'HNSW' || indexType === 'HNSW_RABITQ') && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.ef')}</label>
                        <input className="zv-form-input" type="number" defaultValue={300} min={1} />
                        <span className="zv-form-hint">{t('pages.collections.detail.query.efHint')}</span>
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-form-label">{t('pages.collections.detail.query.radius')}</label>
                        <input className="zv-form-input" type="number" defaultValue={0} step="any" />
                        <span className="zv-form-hint">{t('pages.collections.detail.query.radiusHint')}</span>
                      </div>
                    </div>
                    <div className="zv-form-row">
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input type="checkbox" /> {t('pages.collections.detail.query.isLinear')}
                        </label>
                      </div>
                      <div className="zv-form-group">
                        <label className="zv-checkbox-label">
                          <input type="checkbox" /> {t('pages.collections.detail.query.isUsingRefiner')}
                        </label>
                      </div>
                    </div>
                  </div>
                </details>
              )}

              {indexType === 'IVF' && (
                <details className="zv-query-params-toggle">
                  <summary className="zv-query-params-summary">{t('pages.collections.detail.query.queryParams')}</summary>
                  <div className="zv-query-params-body">
                    <div className="zv-form-group">
                      <label className="zv-form-label">{t('pages.collections.detail.query.nprobe')}</label>
                      <input className="zv-form-input" type="number" defaultValue={10} min={1} />
                      <span className="zv-form-hint">{t('pages.collections.detail.query.nprobeHint')}</span>
                    </div>
                  </div>
                </details>
              )}

            </div>
          );
        })}

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
          <FilterBuilder fields={collection.schema.fields ?? []} onChange={(expr) => setFilter(expr)} />
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
