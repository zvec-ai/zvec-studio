/**
 * Navigation aliases for the top-level Documents / Vector search menu items.
 *
 * Document browsing and vector search are scoped *per Collection*, so these
 * pages no longer try to render their own browser/playground — they point the
 * user back to the Collections list and surface a friendly EmptyState. The
 * ``NotFoundPage`` remains here because it has the same EmptyState shape.
 */
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, EmptyState } from '@/components/ui';

export function CollectionsPlaceholder(): JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="page-collections">
      <h1>{t('pages.collections.title')}</h1>
      <p>{t('pages.collections.placeholder')}</p>
    </section>
  );
}

export function DocumentsPlaceholder(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section data-testid="page-documents" className="zv-page-placeholder">
      <EmptyState
        testId="zv-page-documents-empty"
        title={t('pages.documents.title')}
        description={t('pages.documents.placeholder')}
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate('/')}>
            {t('pages.documents.cta')}
          </Button>
        }
      />
    </section>
  );
}

export function SearchPlaceholder(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section data-testid="page-search" className="zv-page-placeholder">
      <EmptyState
        testId="zv-page-search-empty"
        title={t('pages.search.title')}
        description={t('pages.search.placeholder')}
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate('/')}>
            {t('pages.search.cta')}
          </Button>
        }
      />
    </section>
  );
}

export function NotFoundPage(): JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="page-not-found" className="zv-not-found">
      <EmptyState
        testId="zv-not-found-card"
        title={t('pages.notFound.title')}
        description={t('pages.notFound.body')}
        actions={
          <Link to="/">
            <Button variant="primary" size="sm">
              {t('pages.notFound.backHome')}
            </Button>
          </Link>
        }
      />
    </section>
  );
}
