import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, CloseButton, Dialog } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import type { CollectionSummary } from '@/features/collections/api';
import type {
  DocumentDeleteByFilterRequest,
  DocumentInsertRequest,
  DocumentUpdateRequest,
  DocumentUpsertRequest,
} from '@/features/documents/api';
import {
  useInsertDocuments,
  useUpdateDocuments,
  useUpsertDocuments,
  useDeleteDocument,
  useDeleteDocumentsByFilter,
} from '@/features/documents/hooks';
import { coerceFieldValue } from './coerce-field-value';
import { useListEmbeddings, useEmbed } from '@/features/ai/hooks';
import type { EmbedResponse } from '@/features/ai/api';
import { isDenseEmbedding, getEmbeddingTag, getEmbeddingDimension } from '@/features/ai/utils';

type SubView = 'insert' | 'upsert' | 'update' | 'delete';
type DeleteMode = 'byId' | 'byFilter';

interface MutateTabProps {
  collection: CollectionSummary;
}

export function MutateTab({ collection }: MutateTabProps): JSX.Element {
  const { t } = useTranslation();
  const [view, setView] = useState<SubView>('insert');
  const { schema } = collection;
  const vectors = schema.vectors ?? [];
  const fields = schema.fields ?? [];

  const subViews: ReadonlyArray<{ key: SubView; label: string }> = [
    { key: 'insert', label: t('pages.collections.detail.mutate.insert') },
    { key: 'upsert', label: t('pages.collections.detail.mutate.upsert') },
    { key: 'update', label: t('pages.collections.detail.mutate.update') },
    { key: 'delete', label: t('pages.collections.detail.mutate.delete') },
  ];

  return (
    <div>
      <div className="zv-data-subnav">
        <div className="zv-data-subnav__tabs">
          {subViews.map((sv) => (
            <button
              key={sv.key}
              type="button"
              className={`zv-data-subnav__tab${view === sv.key ? ' zv-data-subnav__tab--active' : ''}`}
              onClick={() => setView(sv.key)}
            >
              {sv.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'insert' && (
        <InsertView collectionName={collection.name} fields={fields} vectors={vectors} />
      )}
      {view === 'upsert' && (
        <UpsertView collectionName={collection.name} fields={fields} vectors={vectors} />
      )}
      {view === 'update' && (
        <UpdateView collectionName={collection.name} fields={fields} vectors={vectors} />
      )}
      {view === 'delete' && <DeleteView collectionName={collection.name} />}
    </div>
  );
}

/* ─── Shared types ─── */

interface VectorInputState {
  mode: 'raw' | 'embed';
  rawText: string;
  embedding: string;
  embedText: string;
}

interface DocSlot {
  id: string;
  docId: string;
  fieldValues: Record<string, string>;
  vectorInputs: Record<string, VectorInputState>;
}

function makeDocSlot(
  fields: ReadonlyArray<{ name: string }>,
  vectors: ReadonlyArray<{ name: string; dimension: number }>,
): DocSlot {
  const fv: Record<string, string> = {};
  for (const f of fields) if (f.name !== 'id') fv[f.name] = '';
  const vi: Record<string, VectorInputState> = {};
  for (const v of vectors) {
    vi[v.name] = { mode: 'raw', rawText: JSON.stringify(Array.from({ length: v.dimension }, () => 0)), embedding: '', embedText: '' };
  }
  return { id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, docId: '', fieldValues: fv, vectorInputs: vi };
}

/* ─── InsertView ─── */

function InsertView({
  collectionName,
  fields,
  vectors,
}: {
  collectionName: string;
  fields: ReadonlyArray<{ name: string; dataType: string; nullable: boolean }>;
  vectors: ReadonlyArray<{ name: string; dataType: string; dimension: number }>;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useInsertDocuments(collectionName);
  const embedMutation = useEmbed();
  const embeddingsQuery = useListEmbeddings();
  const denseEmbeddings = useMemo(
    () => (embeddingsQuery.data?.items ?? []).filter((e) => isDenseEmbedding(e.config)),
    [embeddingsQuery.data],
  );

  const [slots, setSlots] = useState<DocSlot[]>(() => [makeDocSlot(fields, vectors)]);
  const busy = mutation.isPending || embedMutation.isPending;

  function addSlot(): void {
    setSlots((prev) => [...prev, makeDocSlot(fields, vectors)]);
  }
  function removeSlot(slotId: string): void {
    setSlots((prev) => prev.length > 1 ? prev.filter((s) => s.id !== slotId) : prev);
  }
  function updateSlot(slotId: string, patch: Partial<DocSlot>): void {
    setSlots((prev) => prev.map((s) => s.id === slotId ? { ...s, ...patch } : s));
  }
  function updateSlotVector(slotId: string, vecName: string, patch: Partial<VectorInputState>): void {
    setSlots((prev) => prev.map((s) => {
      if (s.id !== slotId) return s;
      return { ...s, vectorInputs: { ...s.vectorInputs, [vecName]: { ...s.vectorInputs[vecName], ...patch } } };
    }));
  }

  const dimMismatches = useMemo(() => {
    const result: Record<string, { embDim: number; fieldDim: number } | null> = {};
    const firstSlot = slots[0];
    if (!firstSlot) return result;
    for (const v of vectors) {
      const input = firstSlot.vectorInputs[v.name];
      if (input.mode === 'embed' && input.embedding) {
        const emb = denseEmbeddings.find((e) => e.name === input.embedding);
        const eDim = emb ? getEmbeddingDimension(emb.config) : null;
        if (eDim !== null && eDim !== v.dimension) {
          result[v.name] = { embDim: eDim, fieldDim: v.dimension };
        } else {
          result[v.name] = null;
        }
      } else {
        result[v.name] = null;
      }
    }
    return result;
  }, [vectors, slots, denseEmbeddings]);

  const anyDimMismatch = Object.values(dimMismatches).some(Boolean);

  async function handleInsert(e: FormEvent): Promise<void> {
    e.preventDefault();
    const docs: Record<string, unknown>[] = [];

    for (const slot of slots) {
      if (!slot.docId.trim()) {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.insertIdRequired') });
        return;
      }
      const doc: Record<string, unknown> = { id: slot.docId.trim() };

      for (const f of fields) {
        if (f.name === 'id') continue;
        const raw = slot.fieldValues[f.name] ?? '';
        try {
          doc[f.name] = coerceFieldValue(raw, f.dataType, f.nullable, f.name);
        } catch (err) {
          toast.push({ severity: 'error', title: err instanceof Error ? err.message : String(err) });
          return;
        }
      }

      for (const v of vectors) {
        const input = slot.vectorInputs[v.name];
        if (input.mode === 'embed') {
          if (!input.embedding) {
            toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.selectEmbedding') });
            return;
          }
          if (!input.embedText.trim()) {
            toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.embedTextPlaceholder') });
            return;
          }
          try {
            const res: EmbedResponse = await embedMutation.mutateAsync({
              name: input.embedding,
              body: { texts: [input.embedText], isQuery: false },
            });
            if (res.kind !== 'dense' || !res.vectors[0]) {
              toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.insertFailed') });
              return;
            }
            doc[v.name] = res.vectors[0];
          } catch (err) {
            toast.push({
              severity: 'error',
              title: t('pages.collections.detail.mutate.insertFailed'),
              description: err instanceof ApiError ? err.error.message : err instanceof Error ? err.message : String(err),
            });
            return;
          }
        } else {
          try {
            doc[v.name] = JSON.parse(input.rawText || '[]');
          } catch {
            toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJson') });
            return;
          }
        }
      }
      docs.push(doc);
    }

    const body: DocumentInsertRequest = { documents: docs };
    mutation.mutate(body, {
      onSuccess: (res) => {
        const count = (res as Record<string, unknown>).inserted ?? docs.length;
        toast.push({ severity: 'success', title: t('pages.collections.detail.mutate.insertSuccess', { count }) });
        setSlots([makeDocSlot(fields, vectors)]);
      },
      onError: (err) => {
        toast.push({
          severity: 'error',
          title: t('pages.collections.detail.mutate.insertFailed'),
          description: err instanceof Error ? err.message : String(err),
        });
      },
    });
  }

  return (
    <div className="zv-info-card">
      <div className="zv-info-card__title">
        {t('pages.collections.detail.mutate.insertTitle')}
      </div>
      <form className="zv-dml-layout" onSubmit={(e) => void handleInsert(e)}>
        {slots.map((slot, idx) => (
          <div key={slot.id} className="zv-insert-slot">
            {slots.length > 1 && (
              <div className="zv-insert-slot__header">
                <span className="zv-insert-slot__label">{t('pages.collections.detail.mutate.docLabel', { index: idx + 1 })}</span>
                <CloseButton className="zv-insert-slot__remove" onClick={() => removeSlot(slot.id)} />
              </div>
            )}
            <div className="zv-form-group">
              <label className="zv-form-label">{t('pages.collections.detail.mutate.insertIdLabel')}</label>
              <input
                className="zv-form-input"
                type="text"
                placeholder={t('pages.collections.detail.mutate.insertIdPlaceholder')}
                value={slot.docId}
                onChange={(e) => updateSlot(slot.id, { docId: e.target.value })}
                spellCheck={false}
                required
              />
            </div>

            {fields
              .filter((f) => f.name !== 'id')
              .map((f) => (
                <div className="zv-dml-field-row" key={f.name}>
                  <span className="zv-dml-field-name">{f.name}</span>
                  <input
                    className="zv-form-input"
                    type="text"
                    placeholder={f.dataType}
                    value={slot.fieldValues[f.name] ?? ''}
                    onChange={(e) =>
                      updateSlot(slot.id, { fieldValues: { ...slot.fieldValues, [f.name]: e.target.value } })
                    }
                  />
                </div>
              ))}

            {vectors.map((v) => {
              const input = slot.vectorInputs[v.name];
              return (
                <div className="zv-dml-vector-field" key={v.name}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span className="zv-mono" style={{ fontWeight: 600 }}>{v.name}</span>
                    <span className="zv-vq-field-tag">{v.dimension}d {v.dataType}</span>
                  </div>

                  <div className="zv-input-mode-tabs" style={{ marginBottom: 10 }}>
                    <button type="button" className={`zv-input-mode-tab${input.mode === 'raw' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'raw' })}>
                      {t('pages.collections.detail.mutate.modeRaw')}
                    </button>
                    <button type="button" className={`zv-input-mode-tab${input.mode === 'embed' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'embed' })}>
                      {t('pages.collections.detail.mutate.modeEmbed')}
                    </button>
                  </div>

                  {input.mode === 'raw' ? (
                    <textarea className="zv-form-textarea" value={input.rawText} onChange={(e) => updateSlotVector(slot.id, v.name, { rawText: e.target.value })} spellCheck={false} />
                  ) : (
                    <>
                      <select className="zv-form-select" value={input.embedding} onChange={(e) => updateSlotVector(slot.id, v.name, { embedding: e.target.value })} style={{ marginBottom: 8 }}>
                        <option value="">{t('pages.collections.detail.mutate.selectEmbedding')}</option>
                        {denseEmbeddings.map((emb) => (
                          <option key={emb.name} value={emb.name}>{emb.name} ({getEmbeddingTag(emb)})</option>
                        ))}
                      </select>
                      {dimMismatches[v.name] && (
                        <span className="zv-form-hint" style={{ color: 'var(--zv-color-warning)', marginBottom: 4, display: 'block' }}>
                          {t('pages.collections.detail.mutate.dimMismatch', { embDim: dimMismatches[v.name]!.embDim, fieldDim: dimMismatches[v.name]!.fieldDim })}
                        </span>
                      )}
                      <textarea className="zv-form-textarea" placeholder={dimMismatches[v.name] ? t('pages.collections.detail.mutate.dimMismatchDisabled') : t('pages.collections.detail.mutate.embedTextPlaceholder')} value={input.embedText} disabled={!!dimMismatches[v.name]} onChange={(e) => updateSlotVector(slot.id, v.name, { embedText: e.target.value })} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        <div className="zv-insert-actions">
          <Button type="button" variant="secondary" size="sm" onClick={addSlot}>{t('pages.collections.detail.mutate.addDoc')}</Button>
          <Button variant="primary" type="submit" disabled={busy || anyDimMismatch} loading={busy}>
            {busy ? t('pages.collections.detail.mutate.insertSubmitting') : t('pages.collections.detail.mutate.insertSubmit')} ({slots.length})
          </Button>
        </div>
      </form>
    </div>
  );
}

/* ─── UpsertView ─── */

function UpsertView({
  collectionName,
  fields,
  vectors,
}: {
  collectionName: string;
  fields: ReadonlyArray<{ name: string; dataType: string; nullable: boolean }>;
  vectors: ReadonlyArray<{ name: string; dataType: string; dimension: number }>;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useUpsertDocuments(collectionName);
  const embedMutation = useEmbed();
  const embeddingsQuery = useListEmbeddings();
  const denseEmbeddings = useMemo(
    () => (embeddingsQuery.data?.items ?? []).filter((e) => isDenseEmbedding(e.config)),
    [embeddingsQuery.data],
  );

  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [slots, setSlots] = useState<DocSlot[]>(() => [makeDocSlot(fields, vectors)]);
  const [jsonBody, setJsonBody] = useState('[\n  \n]');
  const busy = mutation.isPending || embedMutation.isPending;

  function addSlot(): void {
    setSlots((prev) => [...prev, makeDocSlot(fields, vectors)]);
  }
  function removeSlot(slotId: string): void {
    setSlots((prev) => prev.length > 1 ? prev.filter((s) => s.id !== slotId) : prev);
  }
  function updateSlot(slotId: string, patch: Partial<DocSlot>): void {
    setSlots((prev) => prev.map((s) => s.id === slotId ? { ...s, ...patch } : s));
  }
  function updateSlotVector(slotId: string, vecName: string, patch: Partial<VectorInputState>): void {
    setSlots((prev) => prev.map((s) => {
      if (s.id !== slotId) return s;
      return { ...s, vectorInputs: { ...s.vectorInputs, [vecName]: { ...s.vectorInputs[vecName], ...patch } } };
    }));
  }

  async function handleUpsertForm(e: FormEvent): Promise<void> {
    e.preventDefault();
    const docs: Record<string, unknown>[] = [];
    for (const slot of slots) {
      if (!slot.docId.trim()) {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.upsertIdRequired') });
        return;
      }
      const doc: Record<string, unknown> = { id: slot.docId.trim() };
      for (const f of fields) {
        if (f.name === 'id') continue;
        const raw = slot.fieldValues[f.name] ?? '';
        if (!raw) continue;
        try {
          doc[f.name] = coerceFieldValue(raw, f.dataType, f.nullable, f.name);
        } catch (err) {
          toast.push({ severity: 'error', title: err instanceof Error ? err.message : String(err) });
          return;
        }
      }
      for (const v of vectors) {
        const input = slot.vectorInputs[v.name];
        if (input.mode === 'embed') {
          if (!input.embedding || !input.embedText.trim()) {
            // Skip vector if user didn't configure embedding
            continue;
          }
          try {
            const res: EmbedResponse = await embedMutation.mutateAsync({ name: input.embedding, body: { texts: [input.embedText], isQuery: false } });
            if (res.kind !== 'dense' || !res.vectors[0]) { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.upsertFailed') }); return; }
            doc[v.name] = res.vectors[0];
          } catch (err) {
            toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.upsertFailed'), description: err instanceof ApiError ? err.error.message : err instanceof Error ? err.message : String(err) });
            return;
          }
        } else {
          // Skip vector if user left it as default (empty or all-zeros)
          if (!input.rawText || input.rawText === '[]') continue;
          try { doc[v.name] = JSON.parse(input.rawText); } catch { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJson') }); return; }
        }
      }
      docs.push(doc);
    }
    const body: DocumentUpsertRequest = { documents: docs };
    mutation.mutate(body, {
      onSuccess: (res) => {
        const count = (res as Record<string, unknown>).upserted ?? docs.length;
        toast.push({ severity: 'success', title: t('pages.collections.detail.mutate.upsertSuccess', { count }) });
        setSlots([makeDocSlot(fields, vectors)]);
      },
      onError: (err) => {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.upsertFailed'), description: err instanceof Error ? err.message : String(err) });
      },
    });
  }

  function handleUpsertJson(e: FormEvent): void {
    e.preventDefault();
    let parsed: unknown;
    try { parsed = JSON.parse(jsonBody); } catch { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJson') }); return; }
    if (!Array.isArray(parsed)) { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJsonArray') }); return; }
    const upsertBody: DocumentUpsertRequest = { documents: parsed };
    mutation.mutate(upsertBody, {
      onSuccess: (res) => {
        const count = (res as Record<string, unknown>).upserted ?? parsed.length;
        toast.push({ severity: 'success', title: t('pages.collections.detail.mutate.upsertSuccess', { count }) });
      },
      onError: (err) => {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.upsertFailed'), description: err instanceof Error ? err.message : String(err) });
      },
    });
  }

  return (
    <div className="zv-info-card">
      <div className="zv-info-card__title">{t('pages.collections.detail.mutate.upsertTitle')}</div>
      <div className="zv-input-mode-tabs" style={{ marginBottom: 12, maxWidth: 200 }}>
        <button type="button" className={`zv-input-mode-tab${mode === 'form' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => setMode('form')}>{t('pages.collections.detail.mutate.modeForm')}</button>
        <button type="button" className={`zv-input-mode-tab${mode === 'json' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => setMode('json')}>{t('pages.collections.detail.mutate.modeJson')}</button>
      </div>

      {mode === 'json' ? (
        <form className="zv-dml-layout" onSubmit={handleUpsertJson}>
          <div className="zv-form-group">
            <label className="zv-form-label">{t('pages.collections.detail.mutate.upsertLabel')}</label>
            <textarea className="zv-form-textarea" value={jsonBody} onChange={(e) => setJsonBody(e.target.value)} spellCheck={false} style={{ height: 200 }} />
          </div>
          <Button variant="primary" type="submit" disabled={busy} loading={busy}>
            {busy ? t('pages.collections.detail.mutate.upsertSubmitting') : t('pages.collections.detail.mutate.upsertSubmit')}
          </Button>
        </form>
      ) : (
        <form className="zv-dml-layout" onSubmit={(e) => void handleUpsertForm(e)}>
          {slots.map((slot, idx) => (
            <div key={slot.id} className="zv-insert-slot">
              {slots.length > 1 && (
                <div className="zv-insert-slot__header">
                  <span className="zv-insert-slot__label">{t('pages.collections.detail.mutate.docLabel', { index: idx + 1 })}</span>
                  <CloseButton className="zv-insert-slot__remove" onClick={() => removeSlot(slot.id)} />
                </div>
              )}
              <div className="zv-form-group">
                <label className="zv-form-label">{t('pages.collections.detail.mutate.idRequired')}</label>
                <input className="zv-form-input" type="text" placeholder={t('pages.collections.detail.mutate.upsertIdPlaceholder')} value={slot.docId} onChange={(e) => updateSlot(slot.id, { docId: e.target.value })} spellCheck={false} required />
              </div>
              {fields.filter((f) => f.name !== 'id').map((f) => (
                <div className="zv-dml-field-row" key={f.name}>
                  <span className="zv-dml-field-name">{f.name}</span>
                  <input className="zv-form-input" type="text" placeholder={f.dataType} value={slot.fieldValues[f.name] ?? ''} onChange={(e) => updateSlot(slot.id, { fieldValues: { ...slot.fieldValues, [f.name]: e.target.value } })} />
                </div>
              ))}
              {vectors.map((v) => {
                const input = slot.vectorInputs[v.name];
                return (
                  <div className="zv-dml-vector-field" key={v.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="zv-mono" style={{ fontWeight: 600 }}>{v.name}</span>
                      <span className="zv-vq-field-tag">{v.dimension}d {v.dataType}</span>
                    </div>
                    <div className="zv-input-mode-tabs" style={{ marginBottom: 10 }}>
                      <button type="button" className={`zv-input-mode-tab${input.mode === 'raw' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'raw' })}>{t('pages.collections.detail.mutate.modeRaw')}</button>
                      <button type="button" className={`zv-input-mode-tab${input.mode === 'embed' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'embed' })}>{t('pages.collections.detail.mutate.modeEmbed')}</button>
                    </div>
                    {input.mode === 'raw' ? (
                      <textarea className="zv-form-textarea" value={input.rawText} onChange={(e) => updateSlotVector(slot.id, v.name, { rawText: e.target.value })} spellCheck={false} />
                    ) : (
                      <>
                        <select className="zv-form-select" value={input.embedding} onChange={(e) => updateSlotVector(slot.id, v.name, { embedding: e.target.value })} style={{ marginBottom: 8 }}>
                          <option value="">{t('pages.collections.detail.mutate.selectEmbedding')}</option>
                          {denseEmbeddings.map((emb) => (<option key={emb.name} value={emb.name}>{emb.name} ({getEmbeddingTag(emb)})</option>))}
                        </select>
                        <textarea className="zv-form-textarea" placeholder={t('pages.collections.detail.mutate.embedTextPlaceholder')} value={input.embedText} onChange={(e) => updateSlotVector(slot.id, v.name, { embedText: e.target.value })} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="zv-insert-actions">
            <Button type="button" variant="secondary" size="sm" onClick={addSlot}>{t('pages.collections.detail.mutate.addDoc')}</Button>
            <Button variant="primary" type="submit" disabled={busy} loading={busy}>
              {busy ? t('pages.collections.detail.mutate.upsertSubmitting') : t('pages.collections.detail.mutate.upsertSubmit')} ({slots.length})
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ─── UpdateView ─── */

function UpdateView({
  collectionName,
  fields,
  vectors,
}: {
  collectionName: string;
  fields: ReadonlyArray<{ name: string; dataType: string; nullable: boolean }>;
  vectors: ReadonlyArray<{ name: string; dataType: string; dimension: number }>;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useUpdateDocuments(collectionName);
  const embedMutation = useEmbed();
  const embeddingsQuery = useListEmbeddings();
  const denseEmbeddings = useMemo(
    () => (embeddingsQuery.data?.items ?? []).filter((e) => isDenseEmbedding(e.config)),
    [embeddingsQuery.data],
  );

  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [slots, setSlots] = useState<DocSlot[]>(() => [makeDocSlot(fields, vectors)]);
  const [jsonBody, setJsonBody] = useState('[\n  {\n    "id": "",\n    \n  }\n]');
  const busy = mutation.isPending || embedMutation.isPending;

  function addSlot(): void {
    setSlots((prev) => [...prev, makeDocSlot(fields, vectors)]);
  }
  function removeSlot(slotId: string): void {
    setSlots((prev) => prev.length > 1 ? prev.filter((s) => s.id !== slotId) : prev);
  }
  function updateSlot(slotId: string, patch: Partial<DocSlot>): void {
    setSlots((prev) => prev.map((s) => s.id === slotId ? { ...s, ...patch } : s));
  }
  function updateSlotVector(slotId: string, vecName: string, patch: Partial<VectorInputState>): void {
    setSlots((prev) => prev.map((s) => {
      if (s.id !== slotId) return s;
      return { ...s, vectorInputs: { ...s.vectorInputs, [vecName]: { ...s.vectorInputs[vecName], ...patch } } };
    }));
  }

  function submitDocs(docs: Record<string, unknown>[]): void {
    const body: DocumentUpdateRequest = { documents: docs };
    mutation.mutate(body, {
      onSuccess: (res) => {
        const count = (res as Record<string, unknown>).updated ?? docs.length;
        toast.push({ severity: 'success', title: t('pages.collections.detail.mutate.updateSuccess', { count }) });
        if (mode === 'form') setSlots([makeDocSlot(fields, vectors)]);
      },
      onError: (err) => {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.updateFailed'), description: err instanceof Error ? err.message : String(err) });
      },
    });
  }

  async function handleUpdateForm(e: FormEvent): Promise<void> {
    e.preventDefault();
    const docs: Record<string, unknown>[] = [];
    for (const slot of slots) {
      if (!slot.docId.trim()) {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.updateIdRequired') });
        return;
      }
      const doc: Record<string, unknown> = { id: slot.docId.trim() };
      for (const f of fields) {
        if (f.name === 'id') continue;
        const raw = slot.fieldValues[f.name] ?? '';
        if (!raw) continue;
        try {
          doc[f.name] = coerceFieldValue(raw, f.dataType, f.nullable, f.name);
        } catch (err) {
          toast.push({ severity: 'error', title: err instanceof Error ? err.message : String(err) });
          return;
        }
      }
      for (const v of vectors) {
        const input = slot.vectorInputs[v.name];
        if (input.mode === 'embed') {
          if (!input.embedding || !input.embedText.trim()) continue;
          try {
            const res: EmbedResponse = await embedMutation.mutateAsync({ name: input.embedding, body: { texts: [input.embedText], isQuery: false } });
            if (res.kind !== 'dense' || !res.vectors[0]) continue;
            doc[v.name] = res.vectors[0];
          } catch (err) {
            toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.updateFailed'), description: err instanceof ApiError ? err.error.message : err instanceof Error ? err.message : String(err) });
            return;
          }
        } else {
          const raw = input.rawText.trim();
          if (!raw || raw === JSON.stringify(Array.from({ length: v.dimension }, () => 0))) continue;
          try { doc[v.name] = JSON.parse(raw); } catch { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJson') }); return; }
        }
      }
      docs.push(doc);
    }
    submitDocs(docs);
  }

  function handleUpdateJson(e: FormEvent): void {
    e.preventDefault();
    let parsed: unknown;
    try { parsed = JSON.parse(jsonBody); } catch { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJson') }); return; }
    if (!Array.isArray(parsed)) { toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.invalidJsonArray') }); return; }
    for (const doc of parsed) {
      if (!doc || typeof doc !== 'object' || !('id' in doc) || !(doc as Record<string, unknown>).id) {
        toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.updateIdRequired') });
        return;
      }
    }
    submitDocs(parsed as Record<string, unknown>[]);
  }

  return (
    <div className="zv-info-card">
      <div className="zv-info-card__title">{t('pages.collections.detail.mutate.updateTitle')}</div>
      <p className="zv-form-hint" style={{ marginBottom: 12 }}>
        {t('pages.collections.detail.mutate.updateHint')}
      </p>
      <div className="zv-input-mode-tabs" style={{ marginBottom: 12, maxWidth: 200 }}>
        <button type="button" className={`zv-input-mode-tab${mode === 'form' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => setMode('form')}>{t('pages.collections.detail.mutate.modeForm')}</button>
        <button type="button" className={`zv-input-mode-tab${mode === 'json' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => setMode('json')}>{t('pages.collections.detail.mutate.modeJson')}</button>
      </div>

      {mode === 'json' ? (
        <form className="zv-dml-layout" onSubmit={handleUpdateJson}>
          <div className="zv-form-group">
            <label className="zv-form-label">{t('pages.collections.detail.mutate.updateLabel')}</label>
            <textarea className="zv-form-textarea" value={jsonBody} onChange={(e) => setJsonBody(e.target.value)} spellCheck={false} style={{ height: 200 }} />
          </div>
          <Button variant="primary" type="submit" disabled={busy} loading={busy}>
            {busy ? t('pages.collections.detail.mutate.updateSubmitting') : t('pages.collections.detail.mutate.updateSubmit')}
          </Button>
        </form>
      ) : (
        <form className="zv-dml-layout" onSubmit={(e) => void handleUpdateForm(e)}>
          {slots.map((slot, idx) => (
            <div key={slot.id} className="zv-insert-slot">
              {slots.length > 1 && (
                <div className="zv-insert-slot__header">
                  <span className="zv-insert-slot__label">{t('pages.collections.detail.mutate.docLabel', { index: idx + 1 })}</span>
                  <CloseButton className="zv-insert-slot__remove" onClick={() => removeSlot(slot.id)} />
                </div>
              )}
              <div className="zv-form-group">
                <label className="zv-form-label">{t('pages.collections.detail.mutate.idRequired')}</label>
                <input className="zv-form-input" type="text" placeholder={t('pages.collections.detail.mutate.upsertIdPlaceholder')} value={slot.docId} onChange={(e) => updateSlot(slot.id, { docId: e.target.value })} spellCheck={false} required />
              </div>
              {fields.filter((f) => f.name !== 'id').map((f) => (
                <div className="zv-dml-field-row" key={f.name}>
                  <span className="zv-dml-field-name">{f.name}</span>
                  <input className="zv-form-input" type="text" placeholder={f.dataType} value={slot.fieldValues[f.name] ?? ''} onChange={(e) => updateSlot(slot.id, { fieldValues: { ...slot.fieldValues, [f.name]: e.target.value } })} />
                </div>
              ))}
              {vectors.map((v) => {
                const input = slot.vectorInputs[v.name];
                return (
                  <div className="zv-dml-vector-field" key={v.name}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="zv-mono" style={{ fontWeight: 600 }}>{v.name}</span>
                      <span className="zv-vq-field-tag">{v.dimension}d {v.dataType}</span>
                    </div>
                    <div className="zv-input-mode-tabs" style={{ marginBottom: 10 }}>
                      <button type="button" className={`zv-input-mode-tab${input.mode === 'raw' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'raw' })}>{t('pages.collections.detail.mutate.modeRaw')}</button>
                      <button type="button" className={`zv-input-mode-tab${input.mode === 'embed' ? ' zv-input-mode-tab--active' : ''}`} onClick={() => updateSlotVector(slot.id, v.name, { mode: 'embed' })}>{t('pages.collections.detail.mutate.modeEmbed')}</button>
                    </div>
                    {input.mode === 'raw' ? (
                      <textarea className="zv-form-textarea" value={input.rawText} onChange={(e) => updateSlotVector(slot.id, v.name, { rawText: e.target.value })} spellCheck={false} />
                    ) : (
                      <>
                        <select className="zv-form-select" value={input.embedding} onChange={(e) => updateSlotVector(slot.id, v.name, { embedding: e.target.value })} style={{ marginBottom: 8 }}>
                          <option value="">{t('pages.collections.detail.mutate.selectEmbedding')}</option>
                          {denseEmbeddings.map((emb) => (<option key={emb.name} value={emb.name}>{emb.name} ({getEmbeddingTag(emb)})</option>))}
                        </select>
                        <textarea className="zv-form-textarea" placeholder={t('pages.collections.detail.mutate.embedTextPlaceholder')} value={input.embedText} onChange={(e) => updateSlotVector(slot.id, v.name, { embedText: e.target.value })} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="zv-insert-actions">
            <Button type="button" variant="secondary" size="sm" onClick={addSlot}>{t('pages.collections.detail.mutate.addDoc')}</Button>
            <Button variant="primary" type="submit" disabled={busy} loading={busy}>
              {busy ? t('pages.collections.detail.mutate.updateSubmitting') : t('pages.collections.detail.mutate.updateSubmit')} ({slots.length})
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ─── DeleteView ─── */

function DeleteView({
  collectionName,
}: {
  collectionName: string;
}): JSX.Element {
  const { t } = useTranslation();
  const toast = useToast();
  const [mode, setMode] = useState<DeleteMode>('byId');
  const [deleteId, setDeleteId] = useState('');
  const [filterExpr, setFilterExpr] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const deleteOne = useDeleteDocument(collectionName);
  const deleteByFilter = useDeleteDocumentsByFilter(collectionName);
  const busy = deleteOne.isPending || deleteByFilter.isPending;

  function requestDelete(e: FormEvent): void {
    e.preventDefault();
    if (mode === 'byId' && !deleteId.trim()) return;
    if (mode === 'byFilter' && !filterExpr.trim()) return;
    setConfirmOpen(true);
  }

  function confirmDelete(): void {
    setConfirmOpen(false);
    if (mode === 'byId') {
      const trimmed = deleteId.trim();
      deleteOne.mutate(trimmed, {
        onSuccess: () => {
          toast.push({ severity: 'info', title: t('pages.collections.detail.mutate.deleteIdSuccess', { id: trimmed }) });
          setDeleteId('');
        },
        onError: (err) => {
          toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.deleteFailed'), description: err instanceof Error ? err.message : String(err) });
        },
      });
    } else {
      const trimmed = filterExpr.trim();
      const body: DocumentDeleteByFilterRequest = { filter: trimmed };
      deleteByFilter.mutate(body, {
        onSuccess: (res) => {
          const count = (res as Record<string, unknown>).deleted ?? '?';
          toast.push({ severity: 'info', title: t('pages.collections.detail.mutate.deleteFilterSuccess', { count }) });
          setFilterExpr('');
        },
        onError: (err) => {
          toast.push({ severity: 'error', title: t('pages.collections.detail.mutate.deleteFailed'), description: err instanceof Error ? err.message : String(err) });
        },
      });
    }
  }

  return (
    <div className="zv-info-card">
      <div className="zv-info-card__title">{t('pages.collections.detail.mutate.deleteTitle')}</div>

      <div className="zv-input-mode-tabs" style={{ marginBottom: 16, maxWidth: 240 }}>
        <button
          type="button"
          className={`zv-input-mode-tab${mode === 'byId' ? ' zv-input-mode-tab--active' : ''}`}
          onClick={() => setMode('byId')}
        >
          {t('pages.collections.detail.mutate.deleteById')}
        </button>
        <button
          type="button"
          className={`zv-input-mode-tab${mode === 'byFilter' ? ' zv-input-mode-tab--active' : ''}`}
          onClick={() => setMode('byFilter')}
        >
          {t('pages.collections.detail.mutate.deleteByFilter')}
        </button>
      </div>

      {mode === 'byId' && (
        <form className="zv-dml-layout" onSubmit={requestDelete}>
          <div className="zv-form-group">
            <label className="zv-form-label">ID</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="zv-form-input"
                type="text"
                placeholder={t('pages.collections.detail.mutate.deleteIdPlaceholder')}
                value={deleteId}
                onChange={(e) => setDeleteId(e.target.value)}
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <Button variant="danger" type="submit" disabled={busy || !deleteId.trim()} loading={deleteOne.isPending}>
                {deleteOne.isPending ? t('pages.collections.detail.mutate.deleteSubmitting') : t('pages.collections.detail.mutate.deleteSubmit')}
              </Button>
            </div>
          </div>
        </form>
      )}

      {mode === 'byFilter' && (
        <form className="zv-dml-layout" onSubmit={requestDelete}>
          <div className="zv-form-group">
            <label className="zv-form-label">{t('pages.collections.detail.mutate.filterLabel')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="zv-form-input"
                type="text"
                placeholder={t('pages.collections.detail.mutate.deleteFilterPlaceholder')}
                value={filterExpr}
                onChange={(e) => setFilterExpr(e.target.value)}
                spellCheck={false}
                style={{ flex: 1 }}
              />
              <Button variant="danger" type="submit" disabled={busy || !filterExpr.trim()} loading={deleteByFilter.isPending}>
                {deleteByFilter.isPending ? t('pages.collections.detail.mutate.deleteSubmitting') : t('pages.collections.detail.mutate.deleteSubmit')}
              </Button>
            </div>
          </div>
        </form>
      )}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={mode === 'byId'
          ? t('pages.collections.detail.mutate.deleteIdConfirmTitle')
          : t('pages.collections.detail.mutate.deleteFilterConfirmTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('actions.cancel')}
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              {t('pages.collections.detail.mutate.deleteSubmit')}
            </Button>
          </>
        }
      >
        <p>
          {mode === 'byId'
            ? t('pages.collections.detail.mutate.deleteIdConfirmBody', { id: deleteId.trim() })
            : t('pages.collections.detail.mutate.deleteFilterConfirmBody')}
        </p>
      </Dialog>
    </div>
  );
}
