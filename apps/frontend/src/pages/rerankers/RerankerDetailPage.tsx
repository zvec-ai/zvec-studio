import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import {
  useReranker,
  useUpdateReranker,
  useDeleteReranker,
} from '@/features/ai/hooks';
import type { RerankerFunctionRecord } from '@/features/ai/api';

import '../collections/CollectionDetailPage.css';

function iconLabel(type: string): string {
  if (type.includes('qwen')) return 'QW';
  if (type.includes('rrf')) return 'RF';
  if (type.includes('weighted')) return 'WR';
  return 'RR';
}

function iconClass(type: string): string {
  if (type.includes('qwen')) return 'zv-sidebar__item-icon--qwen';
  return 'zv-sidebar__item-icon--local';
}

export function RerankerDetailPage(): JSX.Element {
  const { name } = useParams<{ name: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const rerankerQuery = useReranker(name);
  const updateReranker = useUpdateReranker();
  const deleteReranker = useDeleteReranker();

  const [configJson, setConfigJson] = useState('');
  const [description, setDescription] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);

  const data = rerankerQuery.data;

  useEffect(() => {
    if (data) {
      setConfigJson(JSON.stringify(data.config, null, 2));
      setDescription(data.description ?? '');
    }
  }, [data]);

  if (rerankerQuery.isLoading) {
    return <div className="zv-empty-state">{t('pages.ai.reranker.loading')}</div>;
  }

  if (rerankerQuery.isError || !data) {
    return <div className="zv-empty-state">{t('pages.ai.reranker.loadFailed', { name })}</div>;
  }

  function handleSave() {
    if (!data) return;
    try {
      const config = JSON.parse(configJson);
      const body: RerankerFunctionRecord = {
        name: data.name,
        description: description || null,
        config,
      };
      updateReranker.mutate({ name: data.name, body }, {
        onSuccess: () => {
          toast.push({ severity: 'info', title: t('pages.ai.reranker.saveSuccess') });
        },
        onError: () => {
          toast.push({ severity: 'error', title: t('pages.ai.reranker.saveFailed') });
        },
      });
    } catch {
      toast.push({ severity: 'error', title: t('pages.ai.reranker.invalidJson') });
    }
  }

  function confirmDelete() {
    if (!data) return;
    deleteReranker.mutate(data.name, {
      onSuccess: () => navigate('/collections'),
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
        <label className="zv-form-label">{t('pages.ai.reranker.descriptionLabel')}</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('pages.ai.reranker.descriptionPlaceholder')}
        />
      </div>

      <div className="zv-form-group">
        <label className="zv-form-label">{t('pages.ai.reranker.configLabel')}</label>
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
          loading={updateReranker.isPending}
        >
          {updateReranker.isPending ? t('pages.ai.reranker.saving') : t('pages.ai.reranker.save')}
        </Button>
        <Button
          variant="danger"
          onClick={() => setDeleteOpen(true)}
          disabled={deleteReranker.isPending}
        >
          {t('pages.ai.reranker.delete')}
        </Button>
      </div>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('pages.ai.reranker.deleteTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleteReranker.isPending}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={deleteReranker.isPending}
            >
              {deleteReranker.isPending ? t('pages.ai.reranker.deleting') : t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>{t('pages.ai.reranker.deleteBody', { name: data.name })}</p>
      </Dialog>
    </div>
  );
}
