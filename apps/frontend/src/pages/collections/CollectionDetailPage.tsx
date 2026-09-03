import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui';
import { useCollection, useListRecent, useOpenCollection } from '@/features/collections/hooks';
import { OverviewTab } from './OverviewTab';
import { DataTab } from './DataTab';
import { QueryTab } from './QueryTab';
import { BrowseTab } from './BrowseTab';
import { MutateTab } from './MutateTab';

import './CollectionDetailPage.css';

type Tab = 'overview' | 'browse' | 'query' | 'write' | 'data';

const TAB_KEYS: Tab[] = ['overview', 'browse', 'query', 'write', 'data'];

const VALID_TABS = new Set<string>(TAB_KEYS);

function nameFromPath(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function CollectionDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const { name } = useParams<{ name: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const pathHint = searchParams.get('path') ?? undefined;
  const tabParam = searchParams.get('tab') ?? '';
  const activeTab: Tab = VALID_TABS.has(tabParam) ? (tabParam as Tab) : 'overview';
  const visitedOwner = `${name ?? ''}:${pathHint ?? ''}`;
  const [visitedTabs, setVisitedTabs] = useState<{ owner: string; tabs: Set<Tab> }>(() => ({
    owner: visitedOwner,
    tabs: new Set([activeTab]),
  }));
  const collectionQuery = useCollection(name, pathHint);
  const recentQuery = useListRecent();
  const openCollection = useOpenCollection();

  function setActiveTab(tab: Tab): void {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (tab === 'overview') {
          next.delete('tab');
        } else {
          next.set('tab', tab);
        }
        return next;
      },
      { replace: true },
    );
  }

  const autoOpenAttempted = useRef<string | null>(null);

  useEffect(() => {
    setVisitedTabs((prev) => {
      if (prev.owner !== visitedOwner) {
        return { owner: visitedOwner, tabs: new Set([activeTab]) };
      }
      if (prev.tabs.has(activeTab)) return prev;
      const next = new Set(prev.tabs);
      next.add(activeTab);
      return { owner: prev.owner, tabs: next };
    });
  }, [activeTab, visitedOwner]);

  const is404 =
    collectionQuery.isError &&
    collectionQuery.error instanceof ApiError &&
    collectionQuery.error.error.status === 404;

  const recentMatch = useMemo(
    () =>
      name && recentQuery.data
        ? recentQuery.data.items.find((r) => r.name === name || nameFromPath(r.path) === name)
        : undefined,
    [name, recentQuery.data],
  );

  useEffect(() => {
    if (!is404 || !name || !recentMatch) return;
    if (autoOpenAttempted.current === name) return;

    autoOpenAttempted.current = name;
    openCollection.mutate(
      { path: recentMatch.path },
      { onSuccess: () => void collectionQuery.refetch() },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is404, name, recentMatch]);

  const shouldShowLoading =
    collectionQuery.isLoading ||
    openCollection.isPending ||
    (is404 && !!recentMatch && autoOpenAttempted.current !== name);

  if (shouldShowLoading) {
    return <div className="zv-empty-state">{t('pages.collections.detail.loadingCollection')}</div>;
  }

  if (collectionQuery.isError || !collectionQuery.data) {
    return (
      <div className="zv-empty-state">
        {t('pages.collections.detail.loadFailed', { name })}
        <Button
          variant="secondary"
          size="sm"
          style={{ marginTop: 12 }}
          onClick={() => collectionQuery.refetch()}
        >
          {t('actions.retry')}
        </Button>
      </div>
    );
  }

  const collection = collectionQuery.data;
  const collectionTabKey = `${collection.path}:${collection.name}`;
  const shouldRenderTab = (tab: Tab): boolean =>
    activeTab === tab || (visitedTabs.owner === visitedOwner && visitedTabs.tabs.has(tab));

  return (
    <div>
      <div className="zv-detail-tabs" data-tour="detail-tabs">
        {TAB_KEYS.map((key) => (
          <button
            key={key}
            className={`zv-detail-tab${activeTab === key ? ' zv-detail-tab--active' : ''}`}
            onClick={() => setActiveTab(key)}
            data-testid={`zv-detail-tab-${key}`}
          >
            {t(`pages.collections.detail.tabs.${key}`)}
          </button>
        ))}
      </div>

      {shouldRenderTab('overview') && (
        <div hidden={activeTab !== 'overview'}>
          <OverviewTab key={`overview:${collectionTabKey}`} collection={collection} />
        </div>
      )}
      {shouldRenderTab('browse') && (
        <div hidden={activeTab !== 'browse'}>
          <BrowseTab key={`browse:${collectionTabKey}`} collection={collection} />
        </div>
      )}
      {shouldRenderTab('query') && (
        <div hidden={activeTab !== 'query'}>
          <QueryTab key={`query:${collectionTabKey}`} collection={collection} />
        </div>
      )}
      {shouldRenderTab('write') && (
        <div hidden={activeTab !== 'write'}>
          <MutateTab key={`write:${collectionTabKey}`} collection={collection} />
        </div>
      )}
      {shouldRenderTab('data') && (
        <div hidden={activeTab !== 'data'}>
          <DataTab key={`data:${collectionTabKey}`} collection={collection} />
        </div>
      )}
    </div>
  );
}
