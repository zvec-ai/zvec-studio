import { Route, Routes } from 'react-router-dom';

import { AppShell } from '@/layouts/AppShell';
import { WelcomePage } from '@/pages/WelcomePage';
import { CollectionsListPage } from '@/pages/collections/CollectionsListPage';
import { CollectionDetailPage } from '@/pages/collections/CollectionDetailPage';
import { EmbeddingDetailPage } from '@/pages/embeddings/EmbeddingDetailPage';
import { RerankerDetailPage } from '@/pages/rerankers/RerankerDetailPage';
import { NotFoundPage } from '@/pages/Placeholders';

export function AppRoutes(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<AppShell />}>
        <Route index element={<WelcomePage />} />
        <Route path="collections" element={<CollectionsListPage />} />
        <Route path="collections/:name" element={<CollectionDetailPage />} />
        <Route path="embeddings/:name" element={<EmbeddingDetailPage />} />
        <Route path="rerankers/:name" element={<RerankerDetailPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
