import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import type { CollectionSummary } from '@/features/collections';

import { ExportDocumentsDialog } from './ExportDocumentsDialog';

const schema = {
  name: 'demo',
  vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, indexParam: null }],
  fields: [
    { name: 'title', dataType: 'STRING', nullable: false, indexParam: null },
    { name: 'score', dataType: 'INT64', nullable: false, indexParam: null },
  ],
} as unknown as CollectionSummary['schema'];

describe('ExportDocumentsDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Spy on anchor creation + clicks; returns the created anchors. */
  function captureDownload(): HTMLAnchorElement[] {
    const created: HTMLAnchorElement[] = [];
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag);
      if (tag === 'a') created.push(el as HTMLAnchorElement);
      return el;
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    return created;
  }

  it('triggers a native download with vectors by default', async () => {
    const user = userEvent.setup();
    const anchors = captureDownload();
    const onClose = vi.fn();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={onClose} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-submit'));

    await waitFor(() => expect(anchors).toHaveLength(1));
    const anchor = anchors[0];
    expect(anchor.href).toContain('/collections/demo/documents:export');
    expect(anchor.href).toContain('includeVector=true');
    expect(anchor.href).toContain('format=jsonl');
    expect(anchor.download).toBe('');
    expect(onClose).toHaveBeenCalled();
  });

  it('omits vectors and applies the selected field filter', async () => {
    const user = userEvent.setup();
    const anchors = captureDownload();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-include-vector'));
    await user.click(screen.getByRole('checkbox', { name: 'title' }));
    await user.click(screen.getByTestId('zv-export-submit'));

    await waitFor(() => expect(anchors).toHaveLength(1));
    const anchor = anchors[0];
    expect(anchor.href).toContain('includeVector=false');
    expect(anchor.href).toContain('outputFields=title');
  });

  it('adds mode=snapshot when the snapshot radio is chosen', async () => {
    const user = userEvent.setup();
    const anchors = captureDownload();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-mode-snapshot'));
    await user.click(screen.getByTestId('zv-export-submit'));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0].href).toContain('mode=snapshot');
  });

  it('omits the mode param for the default data export', async () => {
    const user = userEvent.setup();
    const anchors = captureDownload();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-submit'));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0].href).not.toContain('mode=');
  });
});
