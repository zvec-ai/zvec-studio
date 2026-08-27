import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { SpotlightTour, type TourStep } from '@/features/onboarding';
import { useHealthz } from '@/features/system';
import { Button, CloseButton, Dialog } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import { useTheme } from '@/styles/theme';
import { setLanguage, type Language } from '@/i18n';
import {
  useCollectionsList,
  useListRecent,
  useCloseCollection,
  useOpenCollection,
  useForgetRecent,
} from '@/features/collections/hooks';
import {
  useListEmbeddings,
  useListRerankers,
  useDeleteEmbedding,
  useDeleteReranker,
} from '@/features/ai/hooks';
import type { CollectionListItem, RecentCollectionItem } from '@/features/collections/api';
import type { EmbeddingFunctionRecord, RerankerFunctionRecord } from '@/features/ai/api';
import logoLight from '@/assets/logo-light.svg';
import logoDark from '@/assets/logo-dark.svg';
import { getEmbeddingTag } from '@/features/ai/utils';
import { CreateCollectionDialog } from '@/pages/collections/CreateCollectionDialog';
import { ImportCollectionDialog } from '@/pages/collections/ImportCollectionDialog';
import { OpenCollectionDialog } from '@/pages/collections/OpenCollectionDialog';
import { CreateEmbeddingDialog } from '@/pages/embeddings/CreateEmbeddingDialog';
import { CreateRerankerDialog } from '@/pages/rerankers/CreateRerankerDialog';

import './AppShell.css';

const DOT_COLORS = ['blue', 'purple', 'green', 'orange', 'teal', 'red'] as const;

function nameFromPath(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

function dotColor(index: number): string {
  return DOT_COLORS[index % DOT_COLORS.length];
}

function embeddingIconClass(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('openai')) return 'zv-sidebar__item-icon--openai';
  if (lower.includes('qwen') || lower.includes('dashscope')) return 'zv-sidebar__item-icon--qwen';
  if (lower.includes('jina')) return 'zv-sidebar__item-icon--jina';
  if (lower.includes('local') || lower.includes('onnx')) return 'zv-sidebar__item-icon--local';
  if (lower.includes('bm25') || lower.includes('sparse')) return 'zv-sidebar__item-icon--bm25';
  return 'zv-sidebar__item-icon--default';
}

function embeddingIconLabel(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('openai')) return 'OA';
  if (lower.includes('qwen') || lower.includes('dashscope')) return 'QW';
  if (lower.includes('jina')) return 'JN';
  if (lower.includes('local') || lower.includes('onnx')) return 'LC';
  if (lower.includes('bm25') || lower.includes('sparse')) return 'BM';
  return 'AI';
}

function rerankerIconClass(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('qwen') || lower.includes('dashscope')) return 'zv-sidebar__item-icon--qwen';
  if (lower.includes('local') || lower.includes('default')) return 'zv-sidebar__item-icon--local';
  if (lower.includes('rrf')) return 'zv-sidebar__item-icon--default';
  if (lower.includes('weighted')) return 'zv-sidebar__item-icon--default';
  return 'zv-sidebar__item-icon--default';
}

function rerankerIconLabel(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('qwen') || lower.includes('dashscope')) return 'QW';
  if (lower.includes('local') || lower.includes('default')) return 'LC';
  if (lower.includes('rrf')) return 'RR';
  if (lower.includes('weighted')) return 'WT';
  return 'RR';
}

function usePageTitle(): string {
  const { t } = useTranslation();
  const params = useParams<{ name: string }>();
  const location = useLocation();
  if (params.name) return decodeURIComponent(params.name);
  if (location.pathname === '/collections') return t('nav.collections');
  return '';
}

function DemoTabs(): JSX.Element {
  const { t } = useTranslation();
  const topbar = document.querySelector('.zv-topbar');
  const main = document.querySelector('.zv-main');
  const topbarRect = topbar?.getBoundingClientRect();
  const mainRect = main?.getBoundingClientRect();
  const style: React.CSSProperties = {
    position: 'fixed',
    top: topbarRect ? topbarRect.bottom : mainRect ? mainRect.top + 52 : 52,
    left: mainRect ? mainRect.left : 240,
    width: mainRect ? mainRect.width : 'calc(100vw - 240px)',
    zIndex: 9997,
    pointerEvents: 'none',
  };
  return (
    <div style={style}>
      <div
        data-tour="demo-tabs"
        className="zv-detail-tabs"
        style={{ margin: 0, background: 'var(--zv-color-surface)' }}
      >
        <button className="zv-detail-tab zv-detail-tab--active">
          {t('pages.collections.detail.tabs.overview')}
        </button>
        <button className="zv-detail-tab">{t('pages.collections.detail.tabs.browse')}</button>
        <button className="zv-detail-tab">{t('pages.collections.detail.tabs.query')}</button>
        <button className="zv-detail-tab">{t('pages.collections.detail.tabs.write')}</button>
      </div>
    </div>
  );
}

const TOUR_STEPS: TourStep[] = [
  {
    target: '[data-tour="collections"]',
    titleKey: 'tour.steps.collections.title',
    bodyKey: 'tour.steps.collections.body',
    placement: 'right',
  },
  {
    target: '[data-tour="collection-actions"]',
    titleKey: 'tour.steps.collectionActions.title',
    bodyKey: 'tour.steps.collectionActions.body',
    placement: 'right',
  },
  {
    target: '[data-tour="demo-tabs"]',
    titleKey: 'tour.steps.workspace.title',
    bodyKey: 'tour.steps.workspace.body',
    placement: 'bottom',
    overlay: <DemoTabs />,
  },
  {
    target: '[data-tour="embeddings"]',
    titleKey: 'tour.steps.embeddings.title',
    bodyKey: 'tour.steps.embeddings.body',
    placement: 'right',
  },
  {
    target: '[data-tour="rerankers"]',
    titleKey: 'tour.steps.rerankers.title',
    bodyKey: 'tour.steps.rerankers.body',
    placement: 'right',
  },
];

export function AppShell(): JSX.Element {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const healthz = useHealthz();
  const theme = useTheme();

  const toggleLanguage = () => {
    const next: Language = i18n.language === 'zh' ? 'en' : 'zh';
    setLanguage(next);
  };
  const navigate = useNavigate();
  const location = useLocation();
  const pageTitle = usePageTitle();

  const [showTour, setShowTour] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showCreateCollection, setShowCreateCollection] = useState(false);
  const [showOpenCollection, setShowOpenCollection] = useState(false);
  const [showImportCollection, setShowRestoreSnapshot] = useState(false);
  const [collectionMenuOpen, setCollectionMenuOpen] = useState(false);
  const [showCreateEmbedding, setShowCreateEmbedding] = useState(false);
  const [showCreateReranker, setShowCreateReranker] = useState(false);
  const [deleteEmbeddingTarget, setDeleteEmbeddingTarget] = useState<string | null>(null);
  const [deleteRerankerTarget, setDeleteRerankerTarget] = useState<string | null>(null);

  const collectionsQuery = useCollectionsList();
  const recentQuery = useListRecent();
  const embeddingsQuery = useListEmbeddings();
  const rerankersQuery = useListRerankers();

  const closeCollection = useCloseCollection();
  const openCollection = useOpenCollection();
  const forgetRecent = useForgetRecent();
  const deleteEmbedding = useDeleteEmbedding();
  const deleteReranker = useDeleteReranker();

  const openCollections: CollectionListItem[] = collectionsQuery.data?.items ?? [];
  const recentCollections: RecentCollectionItem[] = recentQuery.data?.items ?? [];
  const embeddings: EmbeddingFunctionRecord[] = embeddingsQuery.data?.items ?? [];
  const rerankers: RerankerFunctionRecord[] = rerankersQuery.data?.items ?? [];

  const openPaths = new Set(openCollections.map((c) => c.path));
  const closedRecent = recentCollections.filter((r) => !openPaths.has(r.path));

  const currentPath = location.pathname;
  const currentPathHint = new URLSearchParams(location.search).get('path');

  function collectionUrl(name: string, path?: string): string {
    const base = `/collections/${encodeURIComponent(name)}`;
    return path ? `${base}?path=${encodeURIComponent(path)}` : base;
  }

  function handleCollectionClick(name: string, isOpen: boolean, path?: string) {
    if (!isOpen && path) {
      openCollection.mutate(
        { path },
        {
          onSuccess: (data) => navigate(collectionUrl(data.name, data.path)),
          onError: (err) => {
            toast.push({
              severity: 'error',
              title: t('errors.openFailed'),
              description: err instanceof Error ? err.message : String(err),
            });
          },
        },
      );
    } else {
      navigate(collectionUrl(name, path));
    }
  }

  function handleCloseCollection(e: React.MouseEvent, name: string, path?: string) {
    e.stopPropagation();
    e.preventDefault();
    closeCollection.mutate(
      { name, path },
      {
        onSuccess: () => {
          if (currentPath === `/collections/${encodeURIComponent(name)}`) {
            navigate('/collections');
          }
        },
      },
    );
  }

  function handleForgetRecent(e: React.MouseEvent, path: string) {
    e.stopPropagation();
    e.preventDefault();
    forgetRecent.mutate(
      { path },
      {
        onError: (err) => {
          const title =
            err instanceof ApiError
              ? t(err.error.messageKey, { defaultValue: err.error.message })
              : t('errors.unknown');
          toast.push({ title, severity: 'error' });
        },
      },
    );
  }

  function handleDeleteEmbeddingClick(e: React.MouseEvent, name: string) {
    e.stopPropagation();
    e.preventDefault();
    setDeleteEmbeddingTarget(name);
  }

  function confirmDeleteEmbedding() {
    if (!deleteEmbeddingTarget) return;
    const name = deleteEmbeddingTarget;
    deleteEmbedding.mutate(name, {
      onSuccess: () => {
        toast.push({ severity: 'info', title: t('pages.aiFunctions.delete.successTitle') });
        setDeleteEmbeddingTarget(null);
        if (currentPath === `/embeddings/${encodeURIComponent(name)}`) navigate('/collections');
      },
      onError: (err) => {
        const title =
          err instanceof ApiError
            ? t(err.error.messageKey, { defaultValue: err.error.message })
            : t('errors.unknown');
        toast.push({ title, severity: 'error' });
      },
    });
  }

  function handleDeleteRerankerClick(e: React.MouseEvent, name: string) {
    e.stopPropagation();
    e.preventDefault();
    setDeleteRerankerTarget(name);
  }

  function confirmDeleteReranker() {
    if (!deleteRerankerTarget) return;
    const name = deleteRerankerTarget;
    deleteReranker.mutate(name, {
      onSuccess: () => {
        toast.push({ severity: 'info', title: t('pages.aiFunctions.delete.successTitle') });
        setDeleteRerankerTarget(null);
        if (currentPath === `/rerankers/${encodeURIComponent(name)}`) navigate('/collections');
      },
      onError: (err) => {
        const title =
          err instanceof ApiError
            ? t(err.error.messageKey, { defaultValue: err.error.message })
            : t('errors.unknown');
        toast.push({ title, severity: 'error' });
      },
    });
  }

  return (
    <div className="zv-shell" data-testid="app-shell">
      {/* ── Sidebar ── */}
      <aside
        className={`zv-sidebar${!pageTitle ? ' zv-sidebar--hidden' : sidebarCollapsed ? ' zv-sidebar--hidden' : ''}`}
      >
        <div
          className="zv-sidebar__header"
          onClick={() => navigate('/')}
          style={{ cursor: 'pointer' }}
        >
          <img
            className="zv-sidebar__logo-img"
            src={theme.resolved === 'dark' ? logoDark : logoLight}
            alt={t('app.name')}
          />
        </div>

        {/* Collections */}
        <div className="zv-sidebar__section" data-tour="collections">
          <div className="zv-sidebar__section-head">
            <span
              className="zv-sidebar__section-label"
              onClick={() => navigate('/collections')}
              style={{ cursor: 'pointer' }}
            >
              {t('nav.collections')}
            </span>
            <div className="zv-sidebar__section-actions" data-tour="collection-actions">
              <div className="zv-sidebar__menu-anchor">
                <button
                  className="zv-sidebar__action-btn"
                  title={t('pages.collections.empty.create')}
                  aria-haspopup="menu"
                  aria-expanded={collectionMenuOpen}
                  onClick={() => setCollectionMenuOpen((prev) => !prev)}
                  data-testid="zv-collections-add"
                >
                  +
                </button>
                {collectionMenuOpen && (
                  <>
                    <div
                      className="zv-sidebar__menu-overlay"
                      onClick={() => setCollectionMenuOpen(false)}
                    />
                    <div className="zv-sidebar__menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setCollectionMenuOpen(false);
                          setShowCreateCollection(true);
                        }}
                        data-testid="zv-collections-menu-create"
                      >
                        {t('pages.collections.empty.create')}
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setCollectionMenuOpen(false);
                          setShowRestoreSnapshot(true);
                        }}
                        data-testid="zv-collections-menu-import"
                      >
                        {t('pages.collections.importCollection.menuItem')}
                      </button>
                    </div>
                  </>
                )}
              </div>
              <button
                className="zv-sidebar__action-btn"
                title={t('pages.collections.empty.open')}
                onClick={() => setShowOpenCollection(true)}
              >
                ↗
              </button>
            </div>
          </div>

          {openCollections.map((col, i) => {
            const nameMatch = currentPath === `/collections/${encodeURIComponent(col.name)}`;
            const active = nameMatch && (!currentPathHint || currentPathHint === col.path);
            return (
              <div
                key={col.path}
                className={`zv-sidebar__item${active ? ' zv-sidebar__item--active' : ''}`}
                title={col.path}
                onClick={() => handleCollectionClick(col.name, true, col.path)}
              >
                <span className={`zv-sidebar__dot zv-sidebar__dot--${dotColor(i)}`} />
                <span className="zv-sidebar__item-name">{col.name}</span>
                <CloseButton
                  className="zv-sidebar__item-delete"
                  title={t('actions.close')}
                  onClick={(e) => handleCloseCollection(e, col.name, col.path)}
                />
              </div>
            );
          })}

          {closedRecent.map((item) => {
            const name = item.name || nameFromPath(item.path);
            const nameMatch = currentPath === `/collections/${encodeURIComponent(name)}`;
            const active = nameMatch && (!currentPathHint || currentPathHint === item.path);
            return (
              <div
                key={item.path}
                className={`zv-sidebar__item zv-sidebar__item--closed${active ? ' zv-sidebar__item--active' : ''}`}
                title={item.path}
                onClick={() => handleCollectionClick(name, false, item.path)}
              >
                <span className="zv-sidebar__dot zv-sidebar__dot--closed" />
                <span className="zv-sidebar__item-name">{name}</span>
                <CloseButton
                  className="zv-sidebar__item-delete"
                  title={t('actions.forget')}
                  onClick={(e) => handleForgetRecent(e, item.path)}
                />
              </div>
            );
          })}
        </div>

        {/* Embeddings */}
        <div className="zv-sidebar__section" data-tour="embeddings">
          <div className="zv-sidebar__section-head">
            <span className="zv-sidebar__section-label">{t('nav.embeddings')}</span>
            <div className="zv-sidebar__section-actions">
              <button
                className="zv-sidebar__action-btn"
                title={t('nav.newEmbedding')}
                onClick={() => setShowCreateEmbedding(true)}
              >
                +
              </button>
            </div>
          </div>
          {embeddings.map((emb) => {
            const active = currentPath === `/embeddings/${encodeURIComponent(emb.name)}`;
            return (
              <NavLink
                key={emb.name}
                to={`/embeddings/${encodeURIComponent(emb.name)}`}
                className={`zv-sidebar__item${active ? ' zv-sidebar__item--active' : ''}`}
              >
                <span className={`zv-sidebar__item-icon ${embeddingIconClass(emb.config.type)}`}>
                  {embeddingIconLabel(emb.config.type)}
                </span>
                <span className="zv-sidebar__item-name">{emb.name}</span>
                <span className="zv-sidebar__item-tag">{getEmbeddingTag(emb)}</span>
                <CloseButton
                  className="zv-sidebar__item-delete"
                  title={t('actions.delete')}
                  onClick={(e) => handleDeleteEmbeddingClick(e, emb.name)}
                />
              </NavLink>
            );
          })}
        </div>

        {/* Rerankers */}
        <div className="zv-sidebar__section" data-tour="rerankers">
          <div className="zv-sidebar__section-head">
            <span className="zv-sidebar__section-label">{t('nav.rerankers')}</span>
            <div className="zv-sidebar__section-actions">
              <button
                className="zv-sidebar__action-btn"
                title={t('nav.newReranker')}
                onClick={() => setShowCreateReranker(true)}
              >
                +
              </button>
            </div>
          </div>
          {rerankers.map((rr) => {
            const active = currentPath === `/rerankers/${encodeURIComponent(rr.name)}`;
            return (
              <NavLink
                key={rr.name}
                to={`/rerankers/${encodeURIComponent(rr.name)}`}
                className={`zv-sidebar__item${active ? ' zv-sidebar__item--active' : ''}`}
              >
                <span className={`zv-sidebar__item-icon ${rerankerIconClass(rr.config.type)}`}>
                  {rerankerIconLabel(rr.config.type)}
                </span>
                <span className="zv-sidebar__item-name">{rr.name}</span>
                <CloseButton
                  className="zv-sidebar__item-delete"
                  title={t('actions.delete')}
                  onClick={(e) => handleDeleteRerankerClick(e, rr.name)}
                />
              </NavLink>
            );
          })}
        </div>

        <div className="zv-sidebar__spacer" />

        <div className="zv-sidebar__footer">
          <div className="zv-sidebar__footer-version">Zvec v{healthz.data?.zvecVersion ?? '…'}</div>
          <div className="zv-sidebar__footer-row">
            <a
              href="https://github.com/alibaba/zvec"
              target="_blank"
              rel="noopener noreferrer"
              className="zv-sidebar__footer-icon-link"
              title={t('sidebar.github')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
            </a>
            <a
              href="https://zvec.org/en/"
              target="_blank"
              rel="noopener noreferrer"
              className="zv-sidebar__footer-icon-link"
              title={t('sidebar.docs')}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 1 11.5v-9zm5.5 1a.5.5 0 0 0-.5.5v5.3l1.76-1.76a.5.5 0 0 1 .71 0L10.5 9.3V4a.5.5 0 0 0-.5-.5h-3z" />
              </svg>
            </a>
            <button
              type="button"
              className="zv-sidebar__footer-icon-link"
              onClick={() => setShowTour(true)}
              title={t('sidebar.guide')}
              data-testid="zv-sidebar-guide"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm6.92 1.56v.19a.75.75 0 0 0 1.5 0v-.4c0-.58.33-.93.86-1.28.56-.37 1.22-.8 1.22-1.82 0-1.36-1.1-2.25-2.5-2.25s-2.5.9-2.5 2.25a.75.75 0 0 0 1.5 0c0-.57.41-.75 1-.75s1 .18 1 .75c0 .32-.17.52-.6.8-.5.33-1.12.74-1.48 1.38-.14.24-.22.52-.22.82l.02.31zM8 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" />
              </svg>
            </button>
            <button
              type="button"
              className="zv-sidebar__footer-icon-link"
              onClick={theme.toggle}
              title={theme.resolved === 'light' ? t('sidebar.darkMode') : t('sidebar.lightMode')}
              data-testid="zv-sidebar-theme"
            >
              {theme.resolved === 'light' ? (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm.5-9.5a.5.5 0 1 1-1 0v-1a.5.5 0 0 1 1 0v1zm0 11a.5.5 0 1 1-1 0v-1a.5.5 0 0 1 1 0v1zM4.146 4.146a.5.5 0 0 1 .708 0l.707.708a.5.5 0 1 1-.708.707l-.707-.707a.5.5 0 0 1 0-.708zm6.292 6.293a.5.5 0 0 1 .708 0l.707.707a.5.5 0 0 1-.707.708l-.708-.708a.5.5 0 0 1 0-.707zM2.5 8.5a.5.5 0 0 1 0-1h1a.5.5 0 0 1 0 1h-1zm11 0a.5.5 0 0 1 0-1h1a.5.5 0 0 1 0 1h-1zM4.146 11.854a.5.5 0 0 1 0-.708l.708-.707a.5.5 0 0 1 .707.707l-.707.708a.5.5 0 0 1-.708 0zm6.293-6.293a.5.5 0 0 1 0-.707l.707-.708a.5.5 0 0 1 .708.708l-.708.707a.5.5 0 0 1-.707 0z" />
                </svg>
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="zv-sidebar__footer-icon-link"
              onClick={toggleLanguage}
              title={i18n.language === 'zh' ? 'Switch to English' : '切换到中文'}
              data-testid="zv-sidebar-lang"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4.545 6.714L4.11 8H3l1.862-5h1.284L8 8H6.833l-.435-1.286H4.545zm1.634-.736L5.5 3.956h-.049l-.679 2.022H6.18z" />
                <path d="M0 2a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3H2a2 2 0 0 1-2-2V2zm2-1a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H2zm7.138 9.995c.193.166.53.377 1.023.636l-.218.451a4.7 4.7 0 0 1-.756-.451 4.7 4.7 0 0 1-.756.451l-.218-.451c.493-.259.83-.47 1.023-.636a3.5 3.5 0 0 1-.627-1.204h-.488v-.408h1.329v-.725h.434v.725h1.329v.408h-.488a3.5 3.5 0 0 1-.627 1.204zm-.185-.862a2.75 2.75 0 0 0 .476.919 2.75 2.75 0 0 0 .476-.92h-.952z" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className="zv-main">
        {pageTitle && (
          <div className="zv-topbar" data-tour="main-area">
            <button
              type="button"
              className="zv-topbar__toggle"
              onClick={() => setSidebarCollapsed((v) => !v)}
              title={sidebarCollapsed ? t('nav.showSidebar') : t('nav.hideSidebar')}
            >
              {sidebarCollapsed ? '☰' : '◁'}
            </button>
            <span className="zv-topbar__title">{pageTitle}</span>
            <div className="zv-topbar__spacer" />
          </div>
        )}

        <main className="zv-content" data-testid="app-content">
          <Outlet
            context={{
              showCreateCollection,
              setShowCreateCollection,
              showOpenCollection,
              setShowOpenCollection,
              showCreateEmbedding,
              setShowCreateEmbedding,
              showCreateReranker,
              setShowCreateReranker,
            }}
          />
        </main>
      </div>

      <SpotlightTour open={showTour} steps={TOUR_STEPS} onDismiss={() => setShowTour(false)} />
      <CreateCollectionDialog
        open={showCreateCollection}
        onClose={() => setShowCreateCollection(false)}
      />
      <OpenCollectionDialog
        open={showOpenCollection}
        onClose={() => setShowOpenCollection(false)}
      />
      <ImportCollectionDialog
        open={showImportCollection}
        onClose={() => setShowRestoreSnapshot(false)}
      />
      <CreateEmbeddingDialog
        open={showCreateEmbedding}
        onClose={() => setShowCreateEmbedding(false)}
      />
      <CreateRerankerDialog
        open={showCreateReranker}
        onClose={() => setShowCreateReranker(false)}
      />

      <Dialog
        open={deleteEmbeddingTarget !== null}
        onClose={() => setDeleteEmbeddingTarget(null)}
        title={t('pages.ai.embedding.deleteTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleteEmbeddingTarget(null)}
              disabled={deleteEmbedding.isPending}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={confirmDeleteEmbedding}
              loading={deleteEmbedding.isPending}
            >
              {deleteEmbedding.isPending ? t('pages.ai.embedding.deleting') : t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>{t('pages.ai.embedding.deleteBody', { name: deleteEmbeddingTarget ?? '' })}</p>
      </Dialog>

      <Dialog
        open={deleteRerankerTarget !== null}
        onClose={() => setDeleteRerankerTarget(null)}
        title={t('pages.ai.reranker.deleteTitle')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDeleteRerankerTarget(null)}
              disabled={deleteReranker.isPending}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={confirmDeleteReranker}
              loading={deleteReranker.isPending}
            >
              {deleteReranker.isPending ? t('pages.ai.reranker.deleting') : t('actions.delete')}
            </Button>
          </>
        }
      >
        <p>{t('pages.ai.reranker.deleteBody', { name: deleteRerankerTarget ?? '' })}</p>
      </Dialog>
    </div>
  );
}
