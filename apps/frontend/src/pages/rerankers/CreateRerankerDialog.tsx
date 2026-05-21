import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input, Select } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { useCreateReranker } from '@/features/ai/hooks';
import type { RerankerFunctionRecord } from '@/features/ai/api';

export interface CreateRerankerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

const TYPES = [
  { value: 'rrf', label: 'RRF (Reciprocal Rank Fusion)' },
  { value: 'weighted', label: 'Weighted' },
  { value: 'qwen', label: 'Qwen Reranker' },
  { value: 'default_local', label: 'Local Cross-Encoder' },
] as const;

const DEFAULT_CONFIGS: Record<string, Record<string, unknown>> = {
  rrf: { type: 'rrf', rankConstant: 60 },
  weighted: { type: 'weighted', weights: [1.0, 1.0] },
  qwen: { type: 'qwen', model: 'gte-reranker' },
  default_local: { type: 'default_local', modelSource: 'huggingface', batchSize: 32 },
};

export function CreateRerankerDialog({ open, onClose }: CreateRerankerDialogProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const mutation = useCreateReranker();

  const [name, setName] = useState('');
  const [type, setType] = useState('rrf');
  const [configJson, setConfigJson] = useState(JSON.stringify(DEFAULT_CONFIGS.rrf, null, 2));

  function handleTypeChange(newType: string) {
    setType(newType);
    setConfigJson(JSON.stringify(DEFAULT_CONFIGS[newType] ?? { type: newType }, null, 2));
  }

  function reset(): void {
    setName('');
    setType('rrf');
    setConfigJson(JSON.stringify(DEFAULT_CONFIGS.rrf, null, 2));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configJson);
    } catch {
      toast.push({ title: t('pages.aiFunctions.rerankers.invalidJson'), severity: 'error' });
      return;
    }

    const body: RerankerFunctionRecord = {
      name: name.trim(),
      config: config as RerankerFunctionRecord['config'],
    };

    mutation.mutate(body, {
      onSuccess: (record) => {
        toast.push({
          title: t('pages.aiFunctions.rerankers.createSuccessTitle'),
          description: t('pages.aiFunctions.rerankers.createSuccessBody', { name: record.name }),
          severity: 'info',
        });
        reset();
        onClose();
        navigate(`/rerankers/${encodeURIComponent(record.name)}`);
      },
      onError: (err) => {
        toast.push({
          title: t('pages.aiFunctions.rerankers.createFailed'),
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
      title={t('pages.aiFunctions.rerankers.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="zv-create-reranker-form"
            loading={mutation.isPending}
          >
            {mutation.isPending ? t('actions.creating') : t('actions.create')}
          </Button>
        </>
      }
    >
      <form id="zv-create-reranker-form" onSubmit={handleSubmit} noValidate>
        <Input
          label={t('pages.aiFunctions.rerankers.nameLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('pages.aiFunctions.rerankers.namePlaceholder')}
          required
        />
        <Select
          label={t('pages.aiFunctions.rerankers.typeLabel')}
          value={type}
          onChange={(e) => handleTypeChange(e.target.value)}
          options={TYPES.map((tp) => ({ value: tp.value, label: tp.label }))}
        />
        <div className="zv-form-group">
          <label className="zv-form-label">{t('pages.aiFunctions.rerankers.configLabel')}</label>
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
