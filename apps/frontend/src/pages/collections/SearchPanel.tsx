/**
 * Vector search panel (T10).
 *
 * Mounted as the "Search" tab of the Collection detail page. Operators paste
 * a vector as JSON, tune ``topK`` and an optional ``filter`` / ``outputFields``
 * subset, and submit against ``POST /collections/{name}/searches``. Results
 * land in a table with a per-row score bar and a JSON drawer; the last ten
 * searches are persisted to localStorage so they can be re-run with a click.
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  CloseButton,
  Dialog,
  EmptyState,
  Input,
  Select,
  Table,
  type SelectOption,
  type TableColumn,
} from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  HISTORY_LIMIT,
  useSearchDocuments,
  useSearchHistory,
  type SearchHistoryEntry,
  type SearchRequest,
  type SearchResponse,
  type SearchResult,
} from '@/features/searches';
import type { CollectionSummary } from '@/features/collections';
import { useListRerankers, useListEmbeddings, useEmbed } from '@/features/ai';
import { embeddingMatchesVector, isDenseVectorType, isSparseVectorType, parseRawVector, vectorRawTextTemplate } from './vector-utils';

import './SearchPanel.css';

export interface SearchPanelProps {
  readonly collection: string;
  readonly schema: CollectionSummary['schema'];
}

/** How many digits to keep when formatting the similarity score. */
const SCORE_PRECISION = 4;

export function SearchPanel({ collection, schema }: SearchPanelProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useSearchDocuments(collection);
  const history = useSearchHistory(collection);
  const rerankers = useListRerankers();
  const embeddings = useListEmbeddings();
  const embed = useEmbed();

  const vectors = useMemo(() => schema.vectors ?? [], [schema.vectors]);
  const defaultVectorField = vectors[0]?.name ?? '';

  /**
   * Two query modes are supported:
   *  - 'vector': operator pastes a raw JSON vector (the legacy code path).
   *  - 'text':   operator types text + picks a registered embedding
   *               function; on submit we POST :embed first, take the
   *               returned dense vector, then forward it to /searches.
   */
  const [mode, setMode] = useState<'vector' | 'text'>('vector');
  const [queryText, setQueryText] = useState<string>('');
  const [embeddingName, setEmbeddingName] = useState<string>('');

  const [vectorText, setVectorText] = useState<string>(() =>
    vectors[0] ? vectorRawTextTemplate(vectors[0]) : '[]',
  );
  const [topK, setTopK] = useState<number>(10);
  const [filter, setFilter] = useState<string>('');
  const [outputFieldsText, setOutputFieldsText] = useState<string>('');
  const [vectorField, setVectorField] = useState<string>(defaultVectorField);
  const [rerankerName, setRerankerName] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);
  const selectedVector = vectors.find((v) => v.name === vectorField) ?? vectors[0] ?? null;
  const defaultDimension = selectedVector && isDenseVectorType(selectedVector.dataType) ? selectedVector.dimension ?? 0 : 0;

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selectedResult, setSelectedResult] = useState<SearchResult | null>(null);

  // If we swap between Collections, reset the form + result surface.
  useEffect(() => {
    setVectorText(vectors[0] ? vectorRawTextTemplate(vectors[0]) : '[]');
    setTopK(10);
    setFilter('');
    setOutputFieldsText('');
    setVectorField(defaultVectorField);
    setRerankerName('');
    setMode('vector');
    setQueryText('');
    setEmbeddingName('');
    setParseError(null);
    setResponse(null);
    setSelectedResult(null);
  }, [collection, defaultVectorField, vectors]);

  const vectorFieldOptions: ReadonlyArray<SelectOption> = useMemo(
    () => vectors.map((v) => ({ value: v.name, label: v.name })),
    [vectors],
  );

  const rerankerOptions: ReadonlyArray<SelectOption> = useMemo(() => {
    const items = rerankers.data?.items ?? [];
    return [
      {
        value: '',
        label: t('pages.collections.detail.searchPanel.rerankerNone'),
      },
      ...items.map((r) => ({ value: r.name, label: r.name })),
    ];
  }, [rerankers.data, t]);

  const embeddingOptions: ReadonlyArray<SelectOption> = useMemo(() => {
    const items = embeddings.data?.items ?? [];
    return [
      {
        value: '',
        label: t('pages.collections.detail.searchPanel.embeddingNone'),
      },
      ...items
        .filter((e) => embeddingMatchesVector(e, selectedVector))
        .map((e) => ({ value: e.name, label: e.name })),
    ];
  }, [embeddings.data, selectedVector, t]);

  const columns: ReadonlyArray<TableColumn<SearchResult>> = useMemo(
    () => [
      {
        key: 'id',
        header: t('pages.collections.detail.searchPanel.columns.id'),
        render: (row) => <code>{String(row.id)}</code>,
      },
      {
        key: 'score',
        header: t('pages.collections.detail.searchPanel.columns.score'),
        render: (row) => <ScoreCell score={row.score} />,
      },
      {
        key: 'fields',
        header: t('pages.collections.detail.searchPanel.columns.fields'),
        render: (row) => <FieldsPreview fields={row.fields} />,
      },
    ],
    [t],
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setParseError(null);

    let vector: SearchRequest['vector'] = null;
    if (mode === 'text') {
      if (!queryText.trim()) {
        setParseError(t('pages.collections.detail.searchPanel.errors.queryRequired'));
        return;
      }
      if (!embeddingName) {
        setParseError(t('pages.collections.detail.searchPanel.errors.embeddingRequired'));
        return;
      }
      try {
        const res = await embed.mutateAsync({
          name: embeddingName,
          body: { texts: [queryText], isQuery: true },
        });
        if (selectedVector && isDenseVectorType(selectedVector.dataType) && res.kind !== 'dense') {
          setParseError(t('pages.collections.detail.searchPanel.errors.embeddingNotDense'));
          return;
        }
        if (selectedVector && isSparseVectorType(selectedVector.dataType) && res.kind !== 'sparse') {
          setParseError(t('pages.collections.detail.searchPanel.errors.embeddingNotDense'));
          return;
        }
        vector = res.vectors[0] ?? null;
        if (!vector) {
          setParseError(t('pages.collections.detail.searchPanel.errors.embeddingEmpty'));
          return;
        }
        if (defaultDimension > 0 && Array.isArray(vector) && vector.length !== defaultDimension) {
          setParseError(
            t('pages.collections.detail.searchPanel.errors.dimensionMismatch', {
              expected: defaultDimension,
              actual: vector.length,
            }),
          );
          return;
        }
      } catch (err) {
        if (err instanceof ApiError) {
          toast.push({
            severity: err.error.severity,
            title: t(err.error.messageKey, { defaultValue: err.error.code }),
            description: err.error.message,
          });
        } else {
          toast.push({
            severity: 'error',
            title: t('pages.collections.detail.searchPanel.embeddingFailureTitle'),
            description: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
    } else {
      const parsed = parseRawVector(vectorText, selectedVector);
      if (!parsed) {
        setParseError(t('pages.collections.detail.searchPanel.errors.invalidVector'));
        return;
      }
      if (defaultDimension > 0 && Array.isArray(parsed) && parsed.length !== defaultDimension) {
        setParseError(
          t('pages.collections.detail.searchPanel.errors.dimensionMismatch', {
            expected: defaultDimension,
            actual: parsed.length,
          }),
        );
        return;
      }
      vector = parsed;
    }

    const outputFields = parseOutputFields(outputFieldsText);
    const body: SearchRequest = {
      vector,
      topK,
      filter: filter.trim() ? filter.trim() : null,
      outputFields: outputFields.length > 0 ? outputFields : null,
      vectorField: vectorField ? vectorField : null,
      rerankerName: rerankerName ? rerankerName : null,
      includeVector: false,
      groupByField: null,
      groupCount: 2,
      topKPerGroup: 3,
    };

    try {
      const res = await mutation.mutateAsync(body);
      setResponse(res);
      history.push({
        request: body,
        resultCount: res.results.length,
        tookMs: res.took_ms,
      });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.searchPanel.successTitle'),
        description: t('pages.collections.detail.searchPanel.successDescription', {
          count: res.results.length,
          ms: res.took_ms.toFixed(1),
        }),
      });
    } catch (err) {
      if (err instanceof ApiError) {
        toast.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        toast.push({
          severity: 'error',
          title: t('pages.collections.detail.searchPanel.failureTitle'),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  function applyHistory(entry: SearchHistoryEntry): void {
    setVectorText(JSON.stringify(entry.request.vector ?? []));
    setTopK(entry.request.topK ?? 10);
    setFilter(entry.request.filter ?? '');
    setOutputFieldsText((entry.request.outputFields ?? []).join(', '));
    setVectorField(entry.request.vectorField ?? defaultVectorField);
    setRerankerName(entry.request.rerankerName ?? '');
    setParseError(null);
  }

  const results = response?.results ?? [];

  return (
    <div className="zv-search-panel" data-testid="zv-search-panel">
      <form
        className="zv-search-panel__form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <div className="zv-search-panel__mode">
          <label className="zv-search-panel__mode-option">
            <input
              type="radio"
              name="zv-search-mode"
              value="vector"
              checked={mode === 'vector'}
              onChange={() => setMode('vector')}
              data-testid="zv-search-mode-vector"
            />
            {t('pages.collections.detail.searchPanel.modeVector')}
          </label>
          <label className="zv-search-panel__mode-option">
            <input
              type="radio"
              name="zv-search-mode"
              value="text"
              checked={mode === 'text'}
              onChange={() => setMode('text')}
              data-testid="zv-search-mode-text"
            />
            {t('pages.collections.detail.searchPanel.modeText')}
          </label>
        </div>

        {mode === 'vector' ? (
          <div className="zv-search-panel__vector">
            <label htmlFor="zv-search-vector" className="zv-search-panel__label">
              {t('pages.collections.detail.searchPanel.vectorLabel', {
                dimension: defaultDimension || (selectedVector && isSparseVectorType(selectedVector.dataType) ? 'sparse' : '?'),
              })}
            </label>
            <textarea
              id="zv-search-vector"
              className="zv-search-panel__textarea"
              rows={4}
              value={vectorText}
              spellCheck={false}
              onChange={(e) => {
                setVectorText(e.target.value);
                if (parseError) setParseError(null);
              }}
              data-testid="zv-search-vector"
            />
            {parseError && (
              <p
                role="alert"
                className="zv-search-panel__error"
                data-testid="zv-search-vector-error"
              >
                {parseError}
              </p>
            )}
          </div>
        ) : (
          <div className="zv-search-panel__vector">
            <label htmlFor="zv-search-text" className="zv-search-panel__label">
              {t('pages.collections.detail.searchPanel.textLabel')}
            </label>
            <textarea
              id="zv-search-text"
              className="zv-search-panel__textarea"
              rows={3}
              value={queryText}
              spellCheck={true}
              placeholder={t('pages.collections.detail.searchPanel.textPlaceholder')}
              onChange={(e) => {
                setQueryText(e.target.value);
                if (parseError) setParseError(null);
              }}
              data-testid="zv-search-text"
            />
            <Select
              label={t('pages.collections.detail.searchPanel.embeddingLabel')}
              options={embeddingOptions}
              value={embeddingName}
              onChange={(e) => setEmbeddingName(e.target.value)}
              data-testid="zv-search-embedding"
            />
            {parseError && (
              <p
                role="alert"
                className="zv-search-panel__error"
                data-testid="zv-search-vector-error"
              >
                {parseError}
              </p>
            )}
          </div>
        )}

        <div className="zv-search-panel__row">
          <Input
            label={t('pages.collections.detail.searchPanel.topKLabel')}
            type="number"
            min={1}
            max={100}
            value={String(topK)}
            onChange={(e) => setTopK(clampTopK(Number(e.target.value)))}
            data-testid="zv-search-topk"
          />
          {vectorFieldOptions.length > 1 && (
            <Select
              label={t('pages.collections.detail.searchPanel.vectorFieldLabel')}
              options={vectorFieldOptions}
              value={vectorField}
              onChange={(e) => {
                const nextName = e.target.value;
                const nextVector = vectors.find((v) => v.name === nextName);
                setVectorField(nextName);
                setEmbeddingName('');
                if (nextVector) setVectorText(vectorRawTextTemplate(nextVector));
              }}
              data-testid="zv-search-vector-field"
            />
          )}
          <Input
            label={t('pages.collections.detail.searchPanel.filterLabel')}
            placeholder={t('pages.collections.detail.searchPanel.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="zv-search-filter"
          />
          <Input
            label={t('pages.collections.detail.searchPanel.outputFieldsLabel')}
            placeholder={t('pages.collections.detail.searchPanel.outputFieldsPlaceholder')}
            value={outputFieldsText}
            onChange={(e) => setOutputFieldsText(e.target.value)}
            data-testid="zv-search-output-fields"
          />
          <Select
            label={t('pages.collections.detail.searchPanel.rerankerLabel')}
            options={rerankerOptions}
            value={rerankerName}
            onChange={(e) => setRerankerName(e.target.value)}
            data-testid="zv-search-reranker"
          />
        </div>

        <div className="zv-search-panel__actions">
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            data-testid="zv-search-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.searchPanel.submitting')
              : t('pages.collections.detail.searchPanel.submit')}
          </Button>
          {response && (
            <span className="zv-search-panel__summary" data-testid="zv-search-summary">
              {t('pages.collections.detail.searchPanel.summary', {
                count: response.results.length,
                ms: response.took_ms.toFixed(1),
              })}
            </span>
          )}
        </div>
      </form>

      <section
        className="zv-search-panel__results"
        aria-label={t('pages.collections.detail.searchPanel.resultsAria')}
        data-testid="zv-search-results"
      >
        {response === null ? (
          <EmptyState
            compact
            testId="zv-search-empty"
            title={t('pages.collections.detail.searchPanel.emptyState')}
          />
        ) : results.length === 0 ? (
          <EmptyState
            compact
            testId="zv-search-no-hits"
            title={t('pages.collections.detail.searchPanel.noHits')}
          />
        ) : (
          <Table<SearchResult>
            columns={columns}
            rows={results}
            rowKey={(row) => String(row.id)}
            rowTestId={(row) => `zv-search-row-${String(row.id)}`}
            onRowClick={(row) => setSelectedResult(row)}
          />
        )}
      </section>

      <HistoryList
        entries={history.entries}
        onApply={applyHistory}
        onRemove={history.remove}
        onClear={history.clear}
      />

      <Dialog
        open={selectedResult !== null}
        onClose={() => setSelectedResult(null)}
        title={t('pages.collections.detail.searchPanel.drawerTitle', {
          id: selectedResult ? String(selectedResult.id) : '',
        })}
        footer={
          <Button
            variant="primary"
            onClick={() => setSelectedResult(null)}
            data-testid="zv-search-drawer-close"
          >
            {t('pages.collections.detail.searchPanel.close')}
          </Button>
        }
      >
        {selectedResult !== null ? (
          <pre
            className="zv-search-panel__drawer-body"
            data-testid="zv-search-drawer-body"
          >
            {JSON.stringify(selectedResult, null, 2)}
          </pre>
        ) : (
          <span />
        )}
      </Dialog>
    </div>
  );
}

interface HistoryListProps {
  readonly entries: ReadonlyArray<SearchHistoryEntry>;
  readonly onApply: (entry: SearchHistoryEntry) => void;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
}

function HistoryList({ entries, onApply, onRemove, onClear }: HistoryListProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <section
      className="zv-search-panel__history"
      aria-label={t('pages.collections.detail.searchPanel.historyAria')}
      data-testid="zv-search-history"
    >
      <header className="zv-search-panel__history-header">
        <h3>{t('pages.collections.detail.searchPanel.historyTitle')}</h3>
        {entries.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            data-testid="zv-search-history-clear"
          >
            {t('pages.collections.detail.searchPanel.historyClear')}
          </Button>
        )}
      </header>
      {entries.length === 0 ? (
        <p className="zv-search-panel__hint" data-testid="zv-search-history-empty">
          {t('pages.collections.detail.searchPanel.historyEmpty', { limit: HISTORY_LIMIT })}
        </p>
      ) : (
        <ul className="zv-search-panel__history-list">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="zv-search-panel__history-item"
              data-testid={`zv-search-history-item-${entry.id}`}
            >
              <button
                type="button"
                className="zv-search-panel__history-apply"
                onClick={() => onApply(entry)}
                data-testid={`zv-search-history-apply-${entry.id}`}
              >
                <span className="zv-search-panel__history-title">
                  {t('pages.collections.detail.searchPanel.historySummary', {
                    count: entry.resultCount,
                    topK: entry.request.topK ?? 0,
                  })}
                </span>
                <span className="zv-search-panel__history-meta">
                  {new Date(entry.createdAt).toLocaleTimeString()}
                  {entry.request.filter ? ` · ${entry.request.filter}` : ''}
                </span>
              </button>
              <CloseButton
                onClick={() => onRemove(entry.id)}
                aria-label={t('pages.collections.detail.searchPanel.historyRemoveAria')}
                data-testid={`zv-search-history-remove-${entry.id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScoreCell({ score }: { score: number }): JSX.Element {
  const pct = Math.max(0, Math.min(1, scoreToUnit(score)));
  return (
    <div className="zv-search-panel__score" data-testid="zv-search-score">
      <span className="zv-search-panel__score-value">{score.toFixed(SCORE_PRECISION)}</span>
      <span
        className="zv-search-panel__score-bar"
        style={{ width: `${(pct * 100).toFixed(1)}%` }}
        aria-hidden
      />
    </div>
  );
}

function FieldsPreview({ fields }: { fields: Record<string, unknown> }): ReactNode {
  const entries = Object.entries(fields).slice(0, 3);
  if (entries.length === 0) return <span>—</span>;
  return (
    <span className="zv-search-panel__fields">
      {entries.map(([k, v]) => (
        <span key={k} className="zv-search-panel__field-chip">
          <strong>{k}</strong>: {formatFieldValue(v)}
        </span>
      ))}
    </span>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return value.length > 3
      ? `[${value.slice(0, 3).map(String).join(', ')}, …]`
      : `[${value.map(String).join(', ')}]`;
  }
  if (typeof value === 'object') return '{…}';
  return String(value);
}

function parseOutputFields(text: string): Array<string> {
  return text
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function clampTopK(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(100, Math.round(value)));
}

/**
 * Map a similarity score to the 0..1 range used for the visual bar. Cosine
 * scores are already in ``[-1, 1]``; L2 / IP distances can land anywhere so we
 * compress via ``1 / (1 + score)`` — good enough for a relative indicator.
 */
function scoreToUnit(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score >= -1 && score <= 1) return (score + 1) / 2;
  return 1 / (1 + Math.abs(score));
}
