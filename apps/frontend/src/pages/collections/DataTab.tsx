/**
 * Data tab: the collection's import/export entry points.
 *
 * A sibling of Overview/Browse/Query/Write (per review feedback): moving data
 * here keeps the other tabs focused on their own concerns, and gives the
 * transfer actions a stable home that survives tab reorganisations.
 *
 * Layout note: each action row leads with its button and follows with the
 * explanation — a separate heading would just repeat the button label.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui';
import type { CollectionSummary } from '@/features/collections';

import { ExportDocumentsDialog } from './ExportDocumentsDialog';
import { ImportDocumentsDialog } from './ImportDocumentsDialog';

export interface DataTabProps {
  readonly collection: CollectionSummary;
}

export function DataTab({ collection }: DataTabProps): JSX.Element {
  const { t } = useTranslation();
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div data-testid="zv-data-tab">
      <div style={{ display: 'grid', gap: 12 }}>
        <section className="zv-info-card zv-info-card--compact" data-testid="zv-data-import-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setImportOpen(true)}
              data-testid="zv-data-import"
            >
              {t('pages.collections.detail.documentsPanel.import.openLabel')}
            </Button>
            <span className="zv-manage-inline__hint">
              {t('pages.collections.detail.data.importHint')}
            </span>
          </div>
        </section>

        <section className="zv-info-card zv-info-card--compact" data-testid="zv-data-export-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setExportOpen(true)}
              data-testid="zv-data-export"
            >
              {t('pages.collections.detail.documentsPanel.export.openLabel')}
            </Button>
            <span className="zv-manage-inline__hint">
              {t('pages.collections.detail.data.exportHint')}
            </span>
          </div>
        </section>
      </div>

      <ImportDocumentsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        collection={collection.name}
      />
      <ExportDocumentsDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        collection={collection.name}
        schema={collection.schema}
      />
    </div>
  );
}
