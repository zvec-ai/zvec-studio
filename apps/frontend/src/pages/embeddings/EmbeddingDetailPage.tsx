import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  useEmbedding,
  useUpdateEmbedding,
  useDeleteEmbedding,
  useEmbed,
} from '@/features/ai/hooks';
import type { EmbeddingFunctionRecord, EmbedResponse } from '@/features/ai/api';

import '../collections/CollectionDetailPage.css';

function iconClass(type: string): string {
  if (type.includes('openai')) return 'zv-sidebar__item-icon--openai';
  if (type.includes('qwen')) return 'zv-sidebar__item-icon--qwen';
  return 'zv-sidebar__item-icon--local';
}

function iconLabel(type: string): string {
  if (type.includes('openai')) return 'OA';
  if (type.includes('qwen')) return 'QW';
  return 'LC';
}

export function EmbeddingDetailPage(): JSX.Element {
  const { name } = useParams<{ name: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const embeddingQuery = useEmbedding(name);
  const updateEmbedding = useUpdateEmbedding();
  const deleteEmbedding = useDeleteEmbedding();

  const [configJson, setConfigJson] = useState('');
  const [description, setDescription] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const data = embeddingQuery.data;

  useEffect(() => {
    if (data) {
      setConfigJson(JSON.stringify(data.config, null, 2));
      setDescription(data.description ?? '');
    }
  }, [data]);

  if (embeddingQuery.isLoading) {
    return <div className="zv-empty-state">{t('pages.ai.embedding.loading')}</div>;
  }

  if (embeddingQuery.isError || !data) {
    return <div className="zv-empty-state">{t('pages.ai.embedding.loadFailed', { name })}</div>;
  }

  function handleSave() {
    if (!data) return;
    try {
      const config = JSON.parse(configJson);
      const body: EmbeddingFunctionRecord = {
        name: data.name,
        description: description || null,
        config,
      };
      updateEmbedding.mutate({ name: data.name, body }, {
        onSuccess: () => {
          toast.push({ severity: 'info', title: t('pages.ai.embedding.saveSuccess') });
        },
        onError: () => {
          toast.push({ severity: 'error', title: t('pages.ai.embedding.saveFailed') });
        },
      });
    } catch {
      toast.push({ severity: 'error', title: t('pages.ai.embedding.invalidJson') });
    }
  }

  function confirmDelete() {
    if (!data) return;
    deleteEmbedding.mutate(data.name, {
      onSuccess: () => navigate('/'),
    });
  }

  const type = data.config?.type ?? 'unknown';

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="zv-ai-detail-header">
        <div className={`zv-ai-detail-icon ${iconClass(type)}`}>
          {iconLabel(type)}
        </div>
        <div>
          <div className="zv-ai-detail-name">{data.name}</div>
          <div className="zv-ai-detail-type">{type}</div>
        </div>
      </div>

      <div className="zv-form-group">
        <label className="zv-form-label">{t('pages.ai.embedding.descriptionLabel')}</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('pages.ai.embedding.descriptionPlaceholder')}
        />
      </div>

      <div className="zv-form-group">
        <label className="zv-form-label">{t('pages.ai.embedding.configLabel')}</label>
        <textarea
          className="zv-form-textarea"
          value={configJson}
          onChange={(e) => setConfigJson(e.target.value)}
          style={{ height: 200 }}
        />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="primary"
          onClick={handleSave}
          loading={updateEmbedding.isPending}
        >
          {updateEmbedding.isPending ? t('pages.ai.embedding.saving') : t('pages.ai.embedding.save')}
        </Button>
        <Button
          variant="danger"
          onClick={() => setDeleteOpen(true)}
          disabled={deleteEmbedding.isPending}
        >
          {t('pages.ai.embedding.delete')}
        </Button>
      </div>

      {/* ── Try Embedding ── */}
      {/* The ``key`` forces a fresh sub-tree whenever the user navigates between
          embeddings (e.g. local-dense → local-sparse). Without it React Router
          reuses the same component instance, leaving the previous query text
          and result vector visible under the new function. */}
      <TryEmbeddingSection key={data.name} name={data.name} />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('pages.ai.embedding.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleteEmbedding.isPending}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={deleteEmbedding.isPending}
            >
              {deleteEmbedding.isPending ? t('pages.ai.embedding.deleting') : t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>{t('pages.ai.embedding.deleteBody', { name: data.name })}</p>
      </Dialog>
    </div>
  );
}

// ── Try Embedding sub-component ──────────────────────────────────────────────

/** Number of vector values rendered per line in the dense vector view. */
const VALUES_PER_LINE = 8;

/**
 * Per-embedding-name cache for the "Try Embedding" panel.
 *
 * The user expects to flip between embedding functions (e.g. local-dense ↔
 * local-sparse) without losing their input text or last vector. Because the
 * sub-component is re-mounted on name change (via ``key``) we can't rely on
 * React's local ``useState`` to survive the unmount, so we keep a tiny
 * module-scope cache keyed by function name. It lives for the SPA session and
 * is intentionally not persisted to storage — these are throw-away test runs.
 */
interface TryEmbeddingState {
  readonly queryText: string;
  readonly result: EmbedResponse | null;
  readonly elapsed: number | null;
}
const tryStateCache = new Map<string, TryEmbeddingState>();

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

interface TryEmbeddingSectionProps {
  readonly name: string;
}

function TryEmbeddingSection({ name }: TryEmbeddingSectionProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const embed = useEmbed();

  const cached = tryStateCache.get(name);
  const [queryText, setQueryText] = useState(cached?.queryText ?? '');
  const [result, setResult] = useState<EmbedResponse | null>(cached?.result ?? null);
  const [elapsed, setElapsed] = useState<number | null>(cached?.elapsed ?? null);

  // Mirror local state into the module-scope cache so navigating away and
  // back restores exactly what the user last saw for *this* function.
  useEffect(() => {
    tryStateCache.set(name, { queryText, result, elapsed });
  }, [name, queryText, result, elapsed]);

  const handleEmbed = useCallback(async () => {
    if (!queryText.trim()) return;
    setResult(null);
    setElapsed(null);
    const start = performance.now();
    try {
      const res = await embed.mutateAsync({
        name,
        body: { texts: [queryText.trim()], isQuery: true },
      });
      setElapsed(performance.now() - start);
      setResult(res);
    } catch (err) {
      setElapsed(performance.now() - start);
      if (err instanceof ApiError) {
        toast.push({
          severity: err.error.severity,
          title: t(err.error.messageKey, { defaultValue: err.error.code }),
          description: err.error.message,
        });
      } else {
        toast.push({
          severity: 'error',
          title: t('pages.ai.embedding.try.failedTitle'),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, [queryText, name, embed, toast, t]);

  const handleCopy = useCallback(async () => {
    if (!result) return;
    const text =
      result.kind === 'dense'
        ? JSON.stringify(result.vectors[0])
        : JSON.stringify(result.vectors[0]);
    await navigator.clipboard.writeText(text);
    toast.push({ severity: 'info', title: t('pages.ai.embedding.try.copied') });
  }, [result, toast, t]);

  return (
    <div className="zv-info-card" style={{ marginTop: 24 }}>
      <div className="zv-info-card__title">{t('pages.ai.embedding.try.title')}</div>

      <div className="zv-form-group">
        <label className="zv-form-label">{t('pages.ai.embedding.try.inputLabel')}</label>
        <textarea
          className="zv-form-textarea"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder={t('pages.ai.embedding.try.inputPlaceholder')}
          style={{ height: 80 }}
          spellCheck={false}
        />
      </div>

      <Button
        variant="primary"
        onClick={() => void handleEmbed()}
        loading={embed.isPending}
        disabled={!queryText.trim()}
      >
        {embed.isPending
          ? t('pages.ai.embedding.try.running')
          : t('pages.ai.embedding.try.run')}
      </Button>

      {result && (
        <div className="zv-try-result" style={{ marginTop: 16 }}>
          <div className="zv-try-result__header">
            <span className="zv-try-result__meta">
              {result.kind === 'dense'
                ? t('pages.ai.embedding.try.denseLabel', { dim: (result.vectors[0] as number[]).length })
                : t('pages.ai.embedding.try.sparseLabel', { count: Object.keys(result.vectors[0] as Record<string, number>).length })}
              {elapsed !== null && (
                <> &middot; {formatElapsed(elapsed)}</>
              )}
            </span>
            <button
              className="zv-manage-action-btn"
              onClick={() => void handleCopy()}
              title={t('pages.ai.embedding.try.copy')}
            >
              {t('pages.ai.embedding.try.copy')}
            </button>
          </div>

          <pre className="zv-json-view">
            {result.kind === 'dense'
              ? formatDenseVector(result.vectors[0] as number[])
              : JSON.stringify(result.vectors[0], null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function formatDenseVector(vec: number[]): string {
  // Render the full vector — the user explicitly wants every dimension visible,
  // not a head/tail preview. The container (.zv-json-view) sets max-height +
  // overflow-y:auto, so even 1024d vectors stay scrollable. Group into chunks
  // for readability instead of one value per line (avoids 1000-line scrolls).
  const formatted = vec.map((v) => v.toFixed(6));
  const lines: string[] = [];
  for (let i = 0; i < formatted.length; i += VALUES_PER_LINE) {
    lines.push('  ' + formatted.slice(i, i + VALUES_PER_LINE).join(', '));
  }
  return `[\n${lines.join(',\n')}\n]`;
}
