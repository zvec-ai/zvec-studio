/**
 * Insert Document dialog (T9).
 *
 * Drives ``POST /api/v1/collections/{name}/documents`` from a single textarea
 * that accepts either a JSON object (one document) or an array of objects.
 * Validation is structural only -- the backend enforces schema compatibility
 * and surfaces Problem Details on VALIDATION_ERROR / INVALID_DOCUMENT.
 *
 * Auto-embed panel (collapsed by default) lets the operator pick a registered
 * embedding function + a target vector field, then turn each line of free text
 * into one document by calling :embed and merging the returned dense vector
 * into the JSON draft.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Select, type SelectOption } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import {
  useInsertDocuments,
  type DocumentRecord,
} from '@/features/documents';
import { useListEmbeddings, useEmbed } from '@/features/ai';
import type { CollectionSummary } from '@/features/collections';

export interface InsertDocumentDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly collection: string;
  readonly schema?: CollectionSummary['schema'];
  readonly sampleTemplate?: Record<string, unknown>;
}

const DEFAULT_TEMPLATE: Record<string, unknown> = {
  id: 'doc-1',
  title: 'hello world',
  embedding: [0.1, 0.2, 0.3],
};

export function InsertDocumentDialog({
  open,
  onClose,
  collection,
  schema,
  sampleTemplate,
}: InsertDocumentDialogProps): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useInsertDocuments(collection);
  const embeddings = useListEmbeddings();
  const embed = useEmbed();

  const [draft, setDraft] = useState<string>('');
  const [parseError, setParseError] = useState<string | null>(null);

  // Auto-embed panel state.
  const vectors = useMemo(() => schema?.vectors ?? [], [schema]);
  const defaultVectorField = vectors[0]?.name ?? 'embedding';
  const [autoEmbedOpen, setAutoEmbedOpen] = useState<boolean>(false);
  const [embeddingName, setEmbeddingName] = useState<string>('');
  const [vectorField, setVectorField] = useState<string>(defaultVectorField);
  const [textsDraft, setTextsDraft] = useState<string>('');
  const [autoError, setAutoError] = useState<string | null>(null);

  // Seed the textarea with a schema-shaped template whenever the dialog
  // opens so the operator sees valid JSON to edit rather than a blank slate.
  useEffect(() => {
    if (!open) return;
    const template = sampleTemplate ?? DEFAULT_TEMPLATE;
    setDraft(JSON.stringify(template, null, 2));
    setParseError(null);
    setAutoEmbedOpen(false);
    setEmbeddingName('');
    setVectorField(defaultVectorField);
    setTextsDraft('');
    setAutoError(null);
  }, [open, sampleTemplate, defaultVectorField]);

  const embeddingOptions: ReadonlyArray<SelectOption> = useMemo(() => {
    const items = embeddings.data?.items ?? [];
    return [
      { value: '', label: t('pages.collections.detail.documentsPanel.insert.autoEmbed.embeddingNone') },
      ...items.map((e) => ({ value: e.name, label: e.name })),
    ];
  }, [embeddings.data, t]);

  const vectorFieldOptions: ReadonlyArray<SelectOption> = useMemo(
    () => vectors.map((v) => ({ value: v.name, label: `${v.name} (${v.dimension}d)` })),
    [vectors],
  );

  function parseDraft(): Array<DocumentRecord> | null {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          setParseError(t('pages.collections.detail.documentsPanel.insert.errors.emptyArray'));
          return null;
        }
        if (!parsed.every((item) => isPlainObject(item))) {
          setParseError(t('pages.collections.detail.documentsPanel.insert.errors.notObjects'));
          return null;
        }
        return parsed as Array<DocumentRecord>;
      }
      if (isPlainObject(parsed)) {
        return [parsed as DocumentRecord];
      }
      setParseError(t('pages.collections.detail.documentsPanel.insert.errors.notObject'));
      return null;
    } catch (err) {
      setParseError(
        err instanceof Error
          ? `${t('pages.collections.detail.documentsPanel.insert.errors.invalidJson')}: ${err.message}`
          : t('pages.collections.detail.documentsPanel.insert.errors.invalidJson'),
      );
      return null;
    }
  }

  /**
   * Take each non-empty line of {@link textsDraft}, call :embed once with all
   * of them, and emit a JSON array of documents into the main textarea. Each
   * generated document carries an auto id, the source ``text`` and the dense
   * vector under the chosen ``vectorField``.
   */
  async function generateFromText(): Promise<void> {
    setAutoError(null);
    if (!embeddingName) {
      setAutoError(t('pages.collections.detail.documentsPanel.insert.autoEmbed.errors.embeddingRequired'));
      return;
    }
    if (!vectorField.trim()) {
      setAutoError(t('pages.collections.detail.documentsPanel.insert.autoEmbed.errors.vectorFieldRequired'));
      return;
    }
    const lines = textsDraft.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) {
      setAutoError(t('pages.collections.detail.documentsPanel.insert.autoEmbed.errors.textsRequired'));
      return;
    }
    try {
      const res = await embed.mutateAsync({
        name: embeddingName,
        body: { texts: lines, isQuery: false },
      });
      if (res.kind !== 'dense') {
        setAutoError(t('pages.collections.detail.documentsPanel.insert.autoEmbed.errors.notDense'));
        return;
      }
      // Validate dimension against schema if available.
      const target = vectors.find((v) => v.name === vectorField);
      if (target && res.dimension !== target.dimension) {
        setAutoError(
          t('pages.collections.detail.documentsPanel.insert.autoEmbed.errors.dimensionMismatch', {
            field: vectorField,
            expected: target.dimension,
            actual: res.dimension,
          }),
        );
        return;
      }
      const stamp = Date.now();
      const docs: Array<Record<string, unknown>> = lines.map((text, i) => ({
        id: `doc-${stamp}-${i}`,
        text,
        [vectorField]: res.vectors[i] ?? [],
      }));
      setDraft(JSON.stringify(docs, null, 2));
      setParseError(null);
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.documentsPanel.insert.autoEmbed.successTitle'),
        description: t('pages.collections.detail.documentsPanel.insert.autoEmbed.successDescription', {
          count: docs.length,
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
        setAutoError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setParseError(null);
    const docs = parseDraft();
    if (!docs) return;
    try {
      const result = await mutation.mutateAsync({ documents: docs });
      toast.push({
        severity: 'info',
        title: t('pages.collections.detail.documentsPanel.insert.successTitle'),
        description: t('pages.collections.detail.documentsPanel.insert.successDescription', {
          count: result.inserted,
        }),
      });
      onClose();
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
          title: t('pages.collections.detail.documentsPanel.insert.failureTitle'),
          description: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('pages.collections.detail.documentsPanel.insert.title')}
      ariaLabel={t('pages.collections.detail.documentsPanel.insert.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-testid="zv-insert-doc-cancel">
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="zv-insert-doc-form"
            loading={mutation.isPending}
            data-testid="zv-insert-doc-submit"
          >
            {mutation.isPending
              ? t('pages.collections.detail.documentsPanel.insert.submitting')
              : t('pages.collections.detail.documentsPanel.insert.submit')}
          </Button>
        </>
      }
    >
      <form id="zv-insert-doc-form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="zv-insert-doc__hint">
          {t('pages.collections.detail.documentsPanel.insert.hint')}
        </p>

        <details
          className="zv-insert-doc__auto"
          open={autoEmbedOpen}
          onToggle={(e) => setAutoEmbedOpen((e.target as HTMLDetailsElement).open)}
          data-testid="zv-insert-doc-auto"
        >
          <summary className="zv-insert-doc__auto-summary">
            {t('pages.collections.detail.documentsPanel.insert.autoEmbed.title')}
          </summary>
          <div className="zv-insert-doc__auto-body">
            <p className="zv-insert-doc__hint">
              {t('pages.collections.detail.documentsPanel.insert.autoEmbed.hint')}
            </p>
            <div className="zv-insert-doc__auto-row">
              <Select
                label={t('pages.collections.detail.documentsPanel.insert.autoEmbed.embeddingLabel')}
                options={embeddingOptions}
                value={embeddingName}
                onChange={(e) => setEmbeddingName(e.target.value)}
                data-testid="zv-insert-doc-auto-embedding"
              />
              {vectorFieldOptions.length > 0 ? (
                <Select
                  label={t('pages.collections.detail.documentsPanel.insert.autoEmbed.vectorFieldLabel')}
                  options={vectorFieldOptions}
                  value={vectorField}
                  onChange={(e) => setVectorField(e.target.value)}
                  data-testid="zv-insert-doc-auto-vector-field"
                />
              ) : (
                <label className="zv-insert-doc__label">
                  {t('pages.collections.detail.documentsPanel.insert.autoEmbed.vectorFieldLabel')}
                  <input
                    className="zv-insert-doc__textarea"
                    style={{ minHeight: 'auto', height: '2.25rem' }}
                    value={vectorField}
                    onChange={(e) => setVectorField(e.target.value)}
                    data-testid="zv-insert-doc-auto-vector-field"
                  />
                </label>
              )}
            </div>
            <label className="zv-insert-doc__label" htmlFor="zv-insert-doc-auto-texts">
              {t('pages.collections.detail.documentsPanel.insert.autoEmbed.textsLabel')}
            </label>
            <textarea
              id="zv-insert-doc-auto-texts"
              className="zv-insert-doc__textarea"
              rows={5}
              value={textsDraft}
              spellCheck={true}
              placeholder={t('pages.collections.detail.documentsPanel.insert.autoEmbed.textsPlaceholder')}
              onChange={(e) => setTextsDraft(e.target.value)}
              data-testid="zv-insert-doc-auto-texts"
            />
            {autoError && (
              <p
                role="alert"
                className="zv-insert-doc__error"
                data-testid="zv-insert-doc-auto-error"
              >
                {autoError}
              </p>
            )}
            <div className="zv-insert-doc__auto-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => void generateFromText()}
                loading={embed.isPending}
                data-testid="zv-insert-doc-auto-generate"
              >
                {embed.isPending
                  ? t('pages.collections.detail.documentsPanel.insert.autoEmbed.generating')
                  : t('pages.collections.detail.documentsPanel.insert.autoEmbed.generate')}
              </Button>
            </div>
          </div>
        </details>

        <label className="zv-insert-doc__label" htmlFor="zv-insert-doc-body">
          {t('pages.collections.detail.documentsPanel.insert.bodyLabel')}
        </label>
        <textarea
          id="zv-insert-doc-body"
          className="zv-insert-doc__textarea"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            if (parseError) setParseError(null);
          }}
          rows={14}
          spellCheck={false}
          data-testid="zv-insert-doc-body"
        />
        {parseError && (
          <p
            role="alert"
            className="zv-insert-doc__error"
            data-testid="zv-insert-doc-error"
          >
            {parseError}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
