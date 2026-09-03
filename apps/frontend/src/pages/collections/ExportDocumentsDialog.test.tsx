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

/** A collection with vectors but no scalar columns — the picker's worst case. */
const vectorsOnlySchema = {
  name: 'vectors-only',
  vectors: [{ name: 'embedding', dataType: 'VECTOR_FP32', dimension: 4, indexParam: null }],
  fields: [],
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

  it('warns (but allows) exporting with neither vectors nor fields', async () => {
    // A bare id list is a legitimate (if niche) export — the dialog explains
    // what the file will contain instead of blocking it.
    const user = userEvent.setup();
    const anchors = captureDownload();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-include-vector'));
    await user.click(screen.getByTestId('zv-export-include-fields'));

    expect(screen.getByTestId('zv-export-nothing-warning')).toBeInTheDocument();
    await user.click(screen.getByTestId('zv-export-submit'));

    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0].href).toContain('includeVector=false');
    expect(anchors[0].href).toContain('includeFields=false');
  });

  it('locks trimming options and forces full data in snapshot mode', async () => {
    // Snapshots promise a rebuild: the manifest must describe a collection
    // the packaged data can fully populate, so the dialog pins both options
    // on instead of warning about the mismatch after the fact.
    const user = userEvent.setup();
    const anchors = captureDownload();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    // Trim first in data mode — the choices must not leak into the snapshot.
    await user.click(screen.getByTestId('zv-export-include-vector'));
    await user.click(screen.getByTestId('zv-export-include-fields'));
    await user.click(screen.getByTestId('zv-export-mode-snapshot'));

    // Both checkboxes are pinned checked and disabled; the field picker is
    // gone (its only purpose is trimming) and the hint explains why.
    const vectorBox = screen.getByTestId('zv-export-include-vector') as HTMLInputElement;
    const fieldsBox = screen.getByTestId('zv-export-include-fields') as HTMLInputElement;
    expect(vectorBox.checked).toBe(true);
    expect(vectorBox.disabled).toBe(true);
    expect(fieldsBox.checked).toBe(true);
    expect(fieldsBox.disabled).toBe(true);
    expect(screen.queryByTestId('zv-export-fields')).not.toBeInTheDocument();
    expect(screen.getByTestId('zv-export-snapshot-full-hint')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-export-submit'));
    await waitFor(() => expect(anchors).toHaveLength(1));
    expect(anchors[0].href).toContain('mode=snapshot');
    expect(anchors[0].href).toContain('includeVector=true');
    // includeFields=true is the server default and stays omitted from the URL.
    expect(anchors[0].href).not.toContain('includeFields=false');
    expect(anchors[0].href).not.toContain('outputFields=');
  });

  it('restores trimming choices when switching back to data mode', async () => {
    // Disabling in snapshot mode is a per-mode view state: the user's data
    // trimming choices survive the round trip.
    const user = userEvent.setup();
    renderWithProviders(
      <ExportDocumentsDialog open onClose={() => {}} collection="demo" schema={schema} />,
    );

    await user.click(screen.getByTestId('zv-export-include-vector'));
    await user.click(screen.getByTestId('zv-export-mode-snapshot'));
    await user.click(screen.getByRole('radio', { name: 'Data file (.jsonl)' }));

    const vectorBox = screen.getByTestId('zv-export-include-vector') as HTMLInputElement;
    expect(vectorBox.checked).toBe(false);
    expect(vectorBox.disabled).toBe(false);
  });

  it('hides the scalar-fields option entirely for collections without fields', () => {
    // Regression: the "Include scalar fields" checkbox promised a field
    // picker that can never render when the schema has no scalar columns,
    // which read as "checking it does nothing" (user report).
    renderWithProviders(
      <ExportDocumentsDialog
        open
        onClose={() => {}}
        collection="vectors-only"
        schema={vectorsOnlySchema}
      />,
    );

    expect(screen.queryByTestId('zv-export-include-fields')).not.toBeInTheDocument();
    expect(screen.queryByTestId('zv-export-fields')).not.toBeInTheDocument();
    // Vectors-only export stays fully available.
    expect(screen.getByTestId('zv-export-submit')).toBeEnabled();
    expect(screen.queryByTestId('zv-export-nothing-warning')).not.toBeInTheDocument();
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
    // Snapshot exports carry the full document (see the locking test above).
    expect(anchors[0].href).toContain('includeVector=true');
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
