/**
 * Collections list page.
 *
 * Shows quick actions (create/open) and lists open + recent collections,
 * mirroring the Welcome page layout but without the greeting heading.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useOutletContext } from 'react-router-dom';

import { Button } from '@/components/ui';
import { CreateCollectionDialog } from './CreateCollectionDialog';
import { OpenCollectionDialog } from './OpenCollectionDialog';
import {
  useCollectionsList,
  useListRecent,
  useOpenCollection,
} from '@/features/collections/hooks';

interface OutletCtx {
  setShowCreateCollection: (v: boolean) => void;
  setShowOpenCollection: (v: boolean) => void;
}

export function CollectionsListPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const ctx = useOutletContext<OutletCtx | null>();

  const [localCreateOpen, setLocalCreateOpen] = useState(false);
  const [localOpenOpen, setLocalOpenOpen] = useState(false);

  const setShowCreateCollection = ctx?.setShowCreateCollection ?? setLocalCreateOpen;
  const setShowOpenCollection = ctx?.setShowOpenCollection ?? setLocalOpenOpen;

  const collectionsQuery = useCollectionsList();
  const recentQuery = useListRecent();
  const openCollection = useOpenCollection();

  const openCollections = collectionsQuery.data?.items ?? [];
  const openPaths = new Set(openCollections.map((c) => c.path));
  const recentItems = (recentQuery.data?.items ?? []).filter((r) => !openPaths.has(r.path));

  function handleOpenRecent(path: string): void {
    openCollection.mutate(
      { path },
      { onSuccess: (data) => navigate(`/collections/${encodeURIComponent(data.name)}?path=${encodeURIComponent(data.path)}`) },
    );
  }

  function handleGoToCollection(name: string, path?: string): void {
    const base = `/collections/${encodeURIComponent(name)}`;
    navigate(path ? `${base}?path=${encodeURIComponent(path)}` : base);
  }

  return (
    <div className="zv-welcome">
      <div className="zv-welcome__actions">
        <Button variant="primary" onClick={() => setShowCreateCollection(true)}>
          {t('pages.home.createBtn')}
        </Button>
        <Button variant="secondary" onClick={() => setShowOpenCollection(true)}>
          {t('pages.home.openBtn')}
        </Button>
      </div>

      {openCollections.length > 0 && (
        <section className="zv-welcome__section">
          <h2 className="zv-welcome__section-title">{t('pages.home.openCollections')}</h2>
          <ul className="zv-welcome__list">
            {openCollections.map((col) => (
              <li key={col.path} className="zv-welcome__list-item">
                <button
                  type="button"
                  className="zv-welcome__list-btn"
                  onClick={() => handleGoToCollection(col.name, col.path)}
                >
                  <span className="zv-welcome__list-name">{col.name}</span>
                  <span className="zv-welcome__list-path">{col.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentItems.length > 0 && (
        <section className="zv-welcome__section">
          <h2 className="zv-welcome__section-title">{t('pages.home.recentTitle')}</h2>
          <ul className="zv-welcome__list">
            {recentItems.map((item) => (
              <li key={item.path} className="zv-welcome__list-item">
                <button
                  type="button"
                  className="zv-welcome__list-btn"
                  onClick={() => handleOpenRecent(item.path)}
                  disabled={openCollection.isPending}
                >
                  <span className="zv-welcome__list-name">{item.name ?? item.path.split('/').pop()}</span>
                  <span className="zv-welcome__list-path">{item.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!ctx && (
        <>
          <CreateCollectionDialog open={localCreateOpen} onClose={() => setLocalCreateOpen(false)} />
          <OpenCollectionDialog open={localOpenOpen} onClose={() => setLocalOpenOpen(false)} />
        </>
      )}
    </div>
  );
}
