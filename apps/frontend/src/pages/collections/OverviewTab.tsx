import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useApiClient } from '@/lib/api-client-context';
import { createFsApi } from '@/lib/fs-api';
import type { CollectionSummary } from '@/features/collections/api';
import {
  useDestroyCollection,
  useOptimizeCollection,
} from '@/features/collections/hooks';

import { Button, Dialog } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import { SchemaPanelDdl } from './SchemaDdlSection';

interface OverviewTabProps {
  collection: CollectionSummary;
}

function completenessColor(pct: number): string {
  if (pct >= 1) return 'var(--zv-color-success)';
  if (pct > 0) return 'var(--zv-color-warning)';
  return 'var(--zv-color-text-subtle)';
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

export function OverviewTab({ collection }: OverviewTabProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { stats, schema } = collection;
  const client = useApiClient();
  const fsApi = createFsApi(client);

  const toast = useToast();
  const [destroyOpen, setDestroyOpen] = useState(false);
  const [destroyConfirm, setDestroyConfirm] = useState('');

  const optimize = useOptimizeCollection();
  const destroy = useDestroyCollection();

  const vectors = useMemo(() => schema.vectors ?? [], [schema.vectors]);
  const fields = useMemo(() => schema.fields ?? [], [schema.fields]);

  const indexedCount = useMemo(() => {
    const vi = vectors.filter((v) => v.indexParam && v.indexParam.indexType !== 'FLAT').length;
    const fi = fields.filter((f) => f.indexParam).length;
    return vi + fi;
  }, [vectors, fields]);

  const totalIndexable = vectors.length + fields.filter((f) => f.name !== 'id').length;

  const indexCompleteness = useMemo(() => {
    const raw = (stats as Record<string, unknown>).indexCompleteness;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, number>;
    }
    return null;
  }, [stats]);

  const completenessEntries = useMemo(
    () => (indexCompleteness ? Object.entries(indexCompleteness) : []),
    [indexCompleteness],
  );

  function handleReveal(): void {
    void fsApi.reveal(collection.path);
  }

  function handleDestroy() {
    if (destroyConfirm !== collection.name) return;
    destroy.mutate(collection.name, {
      onSuccess: () => navigate('/collections'),
      onError: (err) => {
        const title = err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
        toast.push({ title, severity: 'error' });
      },
    });
  }

  return (
    <>
      {/* Stats — 4 cards */}
      <div className="zv-overview-stats">
        <div className="zv-stat-card">
          <div className="zv-stat-label">{t('pages.collections.detail.overview.documents')}</div>
          <div className="zv-stat-value zv-stat-value--primary">{stats.documentCount.toLocaleString()}</div>
        </div>
        <div className="zv-stat-card">
          <div className="zv-stat-label">{t('pages.collections.detail.overview.storage')}</div>
          <div className="zv-stat-value">{formatBytes(stats.storageBytes)}</div>
        </div>
        <div className="zv-stat-card">
          <div className="zv-stat-label">{t('pages.collections.detail.overview.fields')}</div>
          <div className="zv-stat-value">
            {vectors.length + fields.length}
            <span className="zv-stat-sub">{vectors.length}v · {fields.length}s</span>
          </div>
        </div>
        <div className="zv-stat-card">
          <div className="zv-stat-label">{t('pages.collections.detail.overview.indexes')}</div>
          <div className="zv-stat-value">
            {indexedCount}
            <span className="zv-stat-sub">/ {totalIndexable}</span>
          </div>
        </div>
      </div>

      {/* Quick schema glance */}
      <div className="zv-schema-glance">
        {vectors.map((v) => (
          <span key={v.name} className="zv-tag zv-tag--blue">{v.name} <span className="zv-tag__dim">{v.dimension}d</span></span>
        ))}
        {fields.map((f) => (
          <span key={f.name} className="zv-tag zv-tag--green">{f.name}</span>
        ))}
      </div>

      {/* Schema DDL (vectors + fields tables with all dialogs) */}
      <SchemaPanelDdl summary={collection} indexCompleteness={completenessEntries} completenessColor={completenessColor} />

      {/* Management bar */}
      <div className="zv-info-card zv-info-card--compact">
        <div className="zv-manage-inline">
          <span className="zv-info-label">{t('pages.collections.detail.overview.collectionPath')}</span>
          <span className="zv-info-value zv-mono" style={{ fontSize: 12 }}>{collection.path}</span>
          <button
            type="button"
            className="zv-manage-inline__icon-btn"
            onClick={handleReveal}
            title={t('pages.collections.detail.overview.openFolder')}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 4.5V12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V6.5A1.5 1.5 0 0 0 12.5 5H8L6.5 3H3.5A1.5 1.5 0 0 0 2 4.5z" />
              <path d="M9 9.5l2-2m0 0l-2-2m2 2H6" />
            </svg>
          </button>
          <span className="zv-manage-inline__sep" />
          <span className="zv-manage-inline__action">
            <Button
              variant="secondary"
              size="sm"
              className="zv-btn--success"
              loading={optimize.isPending}
              onClick={() =>
                optimize.mutate(collection.name, {
                  onSuccess: () => toast.push({ severity: 'info', title: t('pages.collections.detail.maintenance.optimizeSuccess') }),
                  onError: (err) => toast.push({ severity: 'error', title: err instanceof Error ? err.message : String(err) }),
                })
              }
            >
              {t('pages.collections.detail.overview.optimize')}
            </Button>
            <span className="zv-manage-inline__hint">
              {t('pages.collections.detail.maintenance.optimizeHint')}
              {' '}
              <a href="https://zvec.org/docs/api/optimize" target="_blank" rel="noopener noreferrer" title={t('pages.collections.detail.overview.optimizeDocs')}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: '-1px' }}>
                  <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10" />
                  <path d="M9 2h5v5" />
                  <path d="M14 2L7 9" />
                </svg>
              </a>
            </span>
          </span>
          <span className="zv-manage-inline__sep" />
          <span className="zv-manage-inline__action">
            <Button
              variant="danger"
              size="sm"
              onClick={() => { setDestroyConfirm(''); setDestroyOpen(true); }}
            >
              {t('pages.collections.detail.maintenance.destroy')}
            </Button>
            <span className="zv-manage-inline__hint">
              {t('pages.collections.detail.maintenance.destroyHint')}
            </span>
          </span>
        </div>
      </div>

      {/* Destroy confirmation dialog */}
      <Dialog
        open={destroyOpen}
        onClose={() => setDestroyOpen(false)}
        title={t('pages.collections.detail.maintenance.destroyConfirmTitle')}
      >
        <p style={{ marginBottom: 12 }}>{t('pages.collections.detail.maintenance.destroyHint')}</p>
        <input
          className="zv-form-input"
          style={{ width: '100%', marginBottom: 16 }}
          placeholder={t('pages.collections.detail.maintenance.destroyAcknowledgePlaceholder', { name: collection.name })}
          value={destroyConfirm}
          onChange={(e) => setDestroyConfirm(e.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={() => setDestroyOpen(false)}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={destroyConfirm !== collection.name || destroy.isPending}
            loading={destroy.isPending}
            onClick={() => {
              handleDestroy();
              setDestroyOpen(false);
            }}
          >
            {t('pages.collections.detail.maintenance.destroy')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
