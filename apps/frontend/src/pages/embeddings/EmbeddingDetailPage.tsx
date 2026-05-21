import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import {
  useEmbedding,
  useUpdateEmbedding,
  useDeleteEmbedding,
} from '@/features/ai/hooks';
import type { EmbeddingFunctionRecord } from '@/features/ai/api';

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
