import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { useCreateEmbedding } from '@/features/ai/hooks';
import type { EmbeddingFunctionRecord } from '@/features/ai/api';

export interface CreateEmbeddingDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const TYPES = [
  { value: 'openai_dense', label: 'OpenAI Dense' },
  { value: 'qwen_dense', label: 'Qwen Dense' },
  { value: 'qwen_sparse', label: 'Qwen Sparse' },
  { value: 'default_local_dense', label: 'Local Dense' },
  { value: 'default_local_sparse', label: 'Local Sparse' },
  { value: 'bm25', label: 'BM25' },
] as const;

const DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  openai_dense: { type: 'openai_dense', model: 'text-embedding-3-small' },
  qwen_dense: { type: 'qwen_dense', model: 'text-embedding-v4', dimension: 1024 },
  qwen_sparse: { type: 'qwen_sparse', model: 'gte-qwen2-1.5b-sparse' },
  default_local_dense: { type: 'default_local_dense', modelSource: 'huggingface', normalizeEmbeddings: true, batchSize: 32 },
  default_local_sparse: { type: 'default_local_sparse', modelSource: 'huggingface', encodingType: 'query' },
  bm25: { type: 'bm25', encodingType: 'query', language: 'zh', b: 0.75, k1: 1.2 },
};

export function CreateEmbeddingDialog({ open, onClose }: CreateEmbeddingDialogProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const mutation = useCreateEmbedding();

  const [name, setName] = useState('');
  const [type, setType] = useState('openai_dense');
  const [configJson, setConfigJson] = useState(JSON.stringify(DEFAULT_CONFIGS.openai_dense, null, 2));

  function handleTypeChange(newType: string) {
    setType(newType);
    setConfigJson(JSON.stringify(DEFAULT_CONFIGS[newType] ?? { type: newType }, null, 2));
  }

  function reset(): void {
    setName('');
    setType('openai_dense');
    setConfigJson(JSON.stringify(DEFAULT_CONFIGS.openai_dense, null, 2));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configJson);
    } catch {
      toast.push({ title: t('pages.aiFunctions.embeddings.invalidJson'), severity: 'error' });
      return;
    }

    const body: EmbeddingFunctionRecord = {
      name: name.trim(),
      config: config as EmbeddingFunctionRecord['config'],
    };

    mutation.mutate(body, {
      onSuccess: (record) => {
        toast.push({
          title: t('pages.aiFunctions.embeddings.createSuccessTitle'),
          description: t('pages.aiFunctions.embeddings.createSuccessBody', { name: record.name }),
          severity: 'info',
        });
        reset();
        onClose();
        navigate(`/embeddings/${encodeURIComponent(record.name)}`);
      },
      onError: (err) => {
        toast.push({
          title: t('pages.aiFunctions.embeddings.createFailed'),
          description: err instanceof Error ? err.message : String(err),
          severity: 'error',
        });
      },
    });
  }

  return (
    <Dialog
      open={open}
      onClose={() => { reset(); onClose(); }}
      title={t('pages.aiFunctions.embeddings.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="zv-create-embedding-form"
            loading={mutation.isPending}
          >
            {mutation.isPending ? t('actions.creating') : t('actions.create')}
          </Button>
        </>
      }
    >
      <form id="zv-create-embedding-form" onSubmit={handleSubmit} noValidate>
        <Input
          label={t('pages.aiFunctions.embeddings.nameLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('pages.aiFunctions.embeddings.namePlaceholder')}
          required
        />
        <Select
          label={t('pages.aiFunctions.embeddings.typeLabel')}
          value={type}
          onChange={(e) => handleTypeChange(e.target.value)}
          options={TYPES.map((tp) => ({ value: tp.value, label: tp.label }))}
        />
        <div className="zv-form-group">
          <label className="zv-form-label">{t('pages.aiFunctions.embeddings.configLabel')}</label>
          <textarea
            className="zv-form-textarea"
            value={configJson}
            onChange={(e) => setConfigJson(e.target.value)}
            style={{ height: 160 }}
            spellCheck={false}
          />
        </div>
      </form>
    </Dialog>
  );
}
