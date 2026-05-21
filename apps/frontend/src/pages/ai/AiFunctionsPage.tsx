/**
 * AI Functions management page.
 *
 * Single page that manages two parallel resources exposed by the AI Extension
 * backend (``/ai/embeddings`` and ``/ai/rerankers``). Both follow the same
 * Persisted-Function shape (name + description + discriminated `config`),
 * so the page renders one tab per resource and a shared list/CRUD layout.
 *
 * Config editing uses a raw JSON textarea on purpose:
 *   - the union has 6 embedding configs and 4 reranker configs (and will grow);
 *   - the backend is the source of truth for valid fields/defaults;
 *   - duplicating that schema in a typed form would only invite drift.
 * The textarea is seeded with a per-type template so users see valid JSON.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  LoadingOverlay,
  Select,
  Table,
  Tabs,
  type SelectOption,
  type TableColumn,
} from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  useListEmbeddings,
  useCreateEmbedding,
  useDeleteEmbedding,
  useListRerankers,
  useCreateReranker,
  useDeleteReranker,
  type EmbeddingFunctionRecord,
  type RerankerFunctionRecord,
} from '@/features/ai';

import './AiFunctionsPage.css';

type Tab = 'embeddings' | 'rerankers';

const EMBEDDING_TEMPLATES: Record<string, Record<string, unknown>> = {
  default_local_dense: {
    type: 'default_local_dense',
    modelSource: 'huggingface',
  },
  default_local_sparse: {
    type: 'default_local_sparse',
    modelSource: 'huggingface',
    encodingType: 'query',
  },
  bm25: {
    type: 'bm25',
    encodingType: 'query',
    language: 'zh',
    b: 0.75,
  },
  qwen_dense: {
    type: 'qwen_dense',
    dimension: 1024,
    model: 'text-embedding-v4',
  },
  qwen_sparse: {
    type: 'qwen_sparse',
    dimension: 1024,
    model: 'text-embedding-v4',
  },
  openai_dense: {
    type: 'openai_dense',
    model: 'text-embedding-3-small',
  },
};

const RERANKER_TEMPLATES: Record<string, Record<string, unknown>> = {
  default_local_reranker: {
    type: 'default_local_reranker',
    modelSource: 'huggingface',
  },
  qwen_reranker: {
    type: 'qwen_reranker',
    model: 'gte-rerank',
  },
  rrf: { type: 'rrf', rankConstant: 60 },
  weighted: { type: 'weighted', weights: [0.5, 0.5], metric: 'COSINE' },
};

/** Top-level page rendered at /ai-functions. */
export function AiFunctionsPage(): JSX.Element {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('embeddings');

  return (
    <section className="zv-ai-page" data-testid="page-ai-functions">
      <header className="zv-ai-page__header">
        <div>
          <h1>{t('pages.aiFunctions.title')}</h1>
          <p>{t('pages.aiFunctions.subtitle')}</p>
        </div>
      </header>
      <Tabs
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        items={[
          { key: 'embeddings', label: t('pages.aiFunctions.tabs.embeddings') },
          { key: 'rerankers', label: t('pages.aiFunctions.tabs.rerankers') },
        ]}
        ariaLabel={t('pages.aiFunctions.title')}
      />
      {tab === 'embeddings' ? <EmbeddingsTab /> : <RerankersTab />}
    </section>
  );
}

// ─── Embeddings ────────────────────────────────────────────────────────────

function EmbeddingsTab(): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const query = useListEmbeddings();
  const remove = useDeleteEmbedding();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<EmbeddingFunctionRecord | null>(null);

  const items = query.data?.items ?? [];

  const columns = useMemo<ReadonlyArray<TableColumn<EmbeddingFunctionRecord>>>(
    () => [
      {
        key: 'name',
        header: t('pages.aiFunctions.columns.name'),
        render: (row) => (
          <strong data-testid={`zv-ai-emb-name-${row.name}`}>{row.name}</strong>
        ),
      },
      {
        key: 'type',
        header: t('pages.aiFunctions.columns.type'),
        render: (row) => <code>{(row.config as { type?: string }).type ?? '?'}</code>,
      },
      {
        key: 'description',
        header: t('pages.aiFunctions.columns.description'),
        render: (row) => row.description ?? '',
      },
      {
        key: 'actions',
        header: t('pages.aiFunctions.columns.actions'),
        render: (row) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPendingDelete(row)}
            data-testid={`zv-ai-emb-delete-${row.name}`}
          >
            {t('actions.delete')}
          </Button>
        ),
      },
    ],
    [t],
  );

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.name);
      setPendingDelete(null);
      toast.push({
        severity: 'info',
        title: t('pages.aiFunctions.delete.successTitle'),
        description: pendingDelete.name,
      });
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      toast.push({ title, severity: 'error' });
    }
  }

  return (
    <div className="zv-ai-page__body">
      <div className="zv-ai-page__toolbar">
        <Button
          variant="primary"
          onClick={() => setCreateOpen(true)}
          data-testid="zv-ai-emb-create"
        >
          {t('pages.aiFunctions.embeddings.create')}
        </Button>
      </div>

      {query.isError && (
        <ErrorState
          testId="zv-ai-emb-error"
          error={query.error}
          title={t('pages.aiFunctions.loadFailedTitle')}
          retryLabel={t('pages.aiFunctions.loadFailedRetry')}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && <LoadingOverlay label={t('status.loading')} />}
      {!query.isPending && !query.isError && items.length === 0 && (
        <EmptyState
          testId="zv-ai-emb-empty"
          title={t('pages.aiFunctions.embeddings.emptyTitle')}
          description={t('pages.aiFunctions.embeddings.emptyBody')}
          actions={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {t('pages.aiFunctions.embeddings.create')}
            </Button>
          }
        />
      )}
      {!query.isPending && !query.isError && items.length > 0 && (
        <div data-testid="zv-ai-emb-table">
          <Table<EmbeddingFunctionRecord>
            columns={columns}
            rows={items}
            rowKey={(row) => row.name}
          />
        </div>
      )}

      <CreateEmbeddingDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('pages.aiFunctions.delete.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              loading={remove.isPending}
              data-testid="zv-ai-emb-delete-confirm"
            >
              {t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>
          {t('pages.aiFunctions.delete.body', {
            name: pendingDelete?.name ?? '',
          })}
        </p>
      </Dialog>
    </div>
  );
}

interface CreateEmbeddingDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

function CreateEmbeddingDialog({ open, onClose }: CreateEmbeddingDialogProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useCreateEmbedding();

  const typeOptions: ReadonlyArray<SelectOption> = useMemo(
    () => Object.keys(EMBEDDING_TEMPLATES).map((v) => ({ value: v, label: v })),
    [],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('default_local_dense');
  const [configText, setConfigText] = useState<string>(
    JSON.stringify(EMBEDDING_TEMPLATES.default_local_dense, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setName('');
    setDescription('');
    setType('default_local_dense');
    setConfigText(JSON.stringify(EMBEDDING_TEMPLATES.default_local_dense, null, 2));
    setError(null);
  }

  function onTypeChange(next: string): void {
    setType(next);
    const template = EMBEDDING_TEMPLATES[next];
    if (template) setConfigText(JSON.stringify(template, null, 2));
  }

  async function submit(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError(t('pages.aiFunctions.errors.nameRequired'));
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch {
      setError(t('pages.aiFunctions.errors.invalidJson'));
      return;
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      setError(t('pages.aiFunctions.errors.invalidJson'));
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      config: { ...(config as Record<string, unknown>), type } as EmbeddingFunctionRecord['config'],
    } satisfies EmbeddingFunctionRecord;
    try {
      await mutation.mutateAsync(body);
      toast.push({
        severity: 'info',
        title: t('pages.aiFunctions.embeddings.createSuccessTitle'),
        description: name.trim(),
      });
      reset();
      onClose();
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      toast.push({ title, severity: 'error' });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('pages.aiFunctions.embeddings.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-ai-emb-create-submit"
          >
            {t('actions.create')}
          </Button>
        </>
      }
    >
      <div className="zv-ai-form">
        <Input
          label={t('pages.aiFunctions.fields.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-testid="zv-ai-emb-name"
        />
        <Input
          label={t('pages.aiFunctions.fields.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Select
          label={t('pages.aiFunctions.fields.type')}
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          options={typeOptions}
          data-testid="zv-ai-emb-type"
        />
        <label className="zv-ai-form__label" htmlFor="zv-ai-emb-config">
          {t('pages.aiFunctions.fields.config')}
        </label>
        <textarea
          id="zv-ai-emb-config"
          className="zv-ai-form__textarea"
          rows={10}
          spellCheck={false}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          data-testid="zv-ai-emb-config"
        />
        {error && (
          <p className="zv-ai-form__error" role="alert" data-testid="zv-ai-emb-error-msg">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ─── Rerankers ─────────────────────────────────────────────────────────────

function RerankersTab(): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const query = useListRerankers();
  const remove = useDeleteReranker();
  const [createOpen, setCreateOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<RerankerFunctionRecord | null>(null);

  const items = query.data?.items ?? [];

  const columns = useMemo<ReadonlyArray<TableColumn<RerankerFunctionRecord>>>(
    () => [
      {
        key: 'name',
        header: t('pages.aiFunctions.columns.name'),
        render: (row) => (
          <strong data-testid={`zv-ai-rer-name-${row.name}`}>{row.name}</strong>
        ),
      },
      {
        key: 'type',
        header: t('pages.aiFunctions.columns.type'),
        render: (row) => <code>{(row.config as { type?: string }).type ?? '?'}</code>,
      },
      {
        key: 'description',
        header: t('pages.aiFunctions.columns.description'),
        render: (row) => row.description ?? '',
      },
      {
        key: 'actions',
        header: t('pages.aiFunctions.columns.actions'),
        render: (row) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPendingDelete(row)}
            data-testid={`zv-ai-rer-delete-${row.name}`}
          >
            {t('actions.delete')}
          </Button>
        ),
      },
    ],
    [t],
  );

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return;
    try {
      await remove.mutateAsync(pendingDelete.name);
      setPendingDelete(null);
      toast.push({
        severity: 'info',
        title: t('pages.aiFunctions.delete.successTitle'),
        description: pendingDelete.name,
      });
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      toast.push({ title, severity: 'error' });
    }
  }

  return (
    <div className="zv-ai-page__body">
      <div className="zv-ai-page__toolbar">
        <Button
          variant="primary"
          onClick={() => setCreateOpen(true)}
          data-testid="zv-ai-rer-create"
        >
          {t('pages.aiFunctions.rerankers.create')}
        </Button>
      </div>

      {query.isError && (
        <ErrorState
          testId="zv-ai-rer-error"
          error={query.error}
          title={t('pages.aiFunctions.loadFailedTitle')}
          retryLabel={t('pages.aiFunctions.loadFailedRetry')}
          onRetry={() => void query.refetch()}
        />
      )}
      {query.isPending && <LoadingOverlay label={t('status.loading')} />}
      {!query.isPending && !query.isError && items.length === 0 && (
        <EmptyState
          testId="zv-ai-rer-empty"
          title={t('pages.aiFunctions.rerankers.emptyTitle')}
          description={t('pages.aiFunctions.rerankers.emptyBody')}
          actions={
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              {t('pages.aiFunctions.rerankers.create')}
            </Button>
          }
        />
      )}
      {!query.isPending && !query.isError && items.length > 0 && (
        <div data-testid="zv-ai-rer-table">
          <Table<RerankerFunctionRecord>
            columns={columns}
            rows={items}
            rowKey={(row) => row.name}
          />
        </div>
      )}

      <CreateRerankerDialog open={createOpen} onClose={() => setCreateOpen(false)} />

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={t('pages.aiFunctions.delete.title')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmDelete()}
              loading={remove.isPending}
              data-testid="zv-ai-rer-delete-confirm"
            >
              {t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>
          {t('pages.aiFunctions.delete.body', {
            name: pendingDelete?.name ?? '',
          })}
        </p>
      </Dialog>
    </div>
  );
}

interface CreateRerankerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

function CreateRerankerDialog({ open, onClose }: CreateRerankerDialogProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useCreateReranker();

  const typeOptions: ReadonlyArray<SelectOption> = useMemo(
    () => Object.keys(RERANKER_TEMPLATES).map((v) => ({ value: v, label: v })),
    [],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<string>('default_local_reranker');
  const [configText, setConfigText] = useState<string>(
    JSON.stringify(RERANKER_TEMPLATES.default_local_reranker, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  function reset(): void {
    setName('');
    setDescription('');
    setType('default_local_reranker');
    setConfigText(JSON.stringify(RERANKER_TEMPLATES.default_local_reranker, null, 2));
    setError(null);
  }

  function onTypeChange(next: string): void {
    setType(next);
    const template = RERANKER_TEMPLATES[next];
    if (template) setConfigText(JSON.stringify(template, null, 2));
  }

  async function submit(): Promise<void> {
    setError(null);
    if (!name.trim()) {
      setError(t('pages.aiFunctions.errors.nameRequired'));
      return;
    }
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch {
      setError(t('pages.aiFunctions.errors.invalidJson'));
      return;
    }
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      setError(t('pages.aiFunctions.errors.invalidJson'));
      return;
    }
    const body = {
      name: name.trim(),
      description: description.trim() ? description.trim() : null,
      config: { ...(config as Record<string, unknown>), type } as RerankerFunctionRecord['config'],
    } satisfies RerankerFunctionRecord;
    try {
      await mutation.mutateAsync(body);
      toast.push({
        severity: 'info',
        title: t('pages.aiFunctions.rerankers.createSuccessTitle'),
        description: name.trim(),
      });
      reset();
      onClose();
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      toast.push({ title, severity: 'error' });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('pages.aiFunctions.rerankers.createTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            loading={mutation.isPending}
            data-testid="zv-ai-rer-create-submit"
          >
            {t('actions.create')}
          </Button>
        </>
      }
    >
      <div className="zv-ai-form">
        <Input
          label={t('pages.aiFunctions.fields.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          data-testid="zv-ai-rer-name"
        />
        <Input
          label={t('pages.aiFunctions.fields.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Select
          label={t('pages.aiFunctions.fields.type')}
          value={type}
          onChange={(e) => onTypeChange(e.target.value)}
          options={typeOptions}
          data-testid="zv-ai-rer-type"
        />
        <label className="zv-ai-form__label" htmlFor="zv-ai-rer-config">
          {t('pages.aiFunctions.fields.config')}
        </label>
        <textarea
          id="zv-ai-rer-config"
          className="zv-ai-form__textarea"
          rows={10}
          spellCheck={false}
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          data-testid="zv-ai-rer-config"
        />
        {error && (
          <p className="zv-ai-form__error" role="alert" data-testid="zv-ai-rer-error-msg">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
