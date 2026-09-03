import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { ImportCollectionDialog } from './ImportCollectionDialog';
import { suggestImportTarget } from './import-utils';

interface FakeState {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  response: unknown;
  error?: Error;
}

function makeClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (state.error) throw state.error;
      return state.response as unknown as T;
    },
  };
}

const OK_RESPONSE = {
  collection: {
    name: 'demo',
    path: '/tmp/restored',
    schema: { name: 'demo', vectors: [], fields: [] },
    stats: { documentCount: 3, indexState: 'none', storageBytes: 0 },
  },
  report: {
    imported: 3,
    failed: 0,
    totalLines: 3,
    aborted: false,
    durationMs: 10.2,
    errors: [],
    errorsTruncated: false,
  },
};

describe('suggestImportTarget', () => {
  it('derives a sibling directory from the snapshot filename', () => {
    expect(suggestImportTarget('/backups/demo.tar.gz')).toBe('/backups/demo');
    expect(suggestImportTarget('/backups/demo.tgz')).toBe('/backups/demo');
  });

  it('prefers the override name when given', () => {
    expect(suggestImportTarget('/backups/demo.tar.gz', 'demo_copy')).toBe('/backups/demo_copy');
  });

  it('handles bare filenames and empty input', () => {
    expect(suggestImportTarget('demo.tar.gz')).toBe('demo');
    expect(suggestImportTarget('')).toBe('');
  });
});

describe('ImportCollectionDialog', () => {
  it('disables submit until snapshot and target are provided', () => {
    const state: FakeState = { calls: [], response: OK_RESPONSE };
    renderWithProviders(<ImportCollectionDialog open onClose={() => {}} />, {
      apiClient: makeClient(state),
    });

    expect(screen.getByTestId('zv-collection-import-submit')).toBeDisabled();
  });

  it('restores and posts source + targetPath (+ no name when empty)', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_RESPONSE };
    renderWithProviders(<ImportCollectionDialog open onClose={() => {}} />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-collection-import-path'), '/backups/demo.tar.gz');
    // The target auto-fills with a sibling suggestion; replace it.
    await user.clear(screen.getByTestId('zv-collection-import-target'));
    await user.type(screen.getByTestId('zv-collection-import-target'), '/tmp/restored');
    await user.click(screen.getByTestId('zv-collection-import-submit'));

    await waitFor(() => {
      const call = state.calls.find((c) => c.path.includes('collections:import'));
      expect(call).toBeDefined();
      expect(call?.method).toBe('POST');
      expect(call?.body).toEqual({
        source: { kind: 'localPath', path: '/backups/demo.tar.gz' },
        targetPath: '/tmp/restored',
      });
    });
  });

  it('keeps the suggested target when the user does not touch it', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_RESPONSE };
    renderWithProviders(<ImportCollectionDialog open onClose={() => {}} />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-collection-import-path'), '/backups/demo.tar.gz');
    expect(screen.getByTestId('zv-collection-import-target')).toHaveValue('/backups/demo');

    // Typing a name override moves the suggestion along.
    await user.type(screen.getByTestId('zv-collection-import-name'), 'demo_copy');
    expect(screen.getByTestId('zv-collection-import-target')).toHaveValue('/backups/demo_copy');

    await user.click(screen.getByTestId('zv-collection-import-submit'));
    await waitFor(() => {
      const call = state.calls.find((c) => c.path.includes('collections:import'));
      expect(call?.body).toEqual({
        source: { kind: 'localPath', path: '/backups/demo.tar.gz' },
        targetPath: '/backups/demo_copy',
        name: 'demo_copy',
      });
    });
  });

  it('does not clobber a hand-edited target', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_RESPONSE };
    renderWithProviders(<ImportCollectionDialog open onClose={() => {}} />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-collection-import-path'), '/backups/demo.tar.gz');
    await user.clear(screen.getByTestId('zv-collection-import-target'));
    await user.type(screen.getByTestId('zv-collection-import-target'), '/custom/place');
    // A later name change must not overwrite the hand-edited target.
    await user.type(screen.getByTestId('zv-collection-import-name'), 'renamed');
    expect(screen.getByTestId('zv-collection-import-target')).toHaveValue('/custom/place');
  });

  it('includes the optional name override', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_RESPONSE };
    renderWithProviders(<ImportCollectionDialog open onClose={() => {}} />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-collection-import-path'), '/backups/demo.tar.gz');
    await user.clear(screen.getByTestId('zv-collection-import-target'));
    await user.type(screen.getByTestId('zv-collection-import-target'), '/tmp/restored');
    await user.type(screen.getByTestId('zv-collection-import-name'), 'demo_copy');
    await user.click(screen.getByTestId('zv-collection-import-submit'));

    await waitFor(() => {
      const call = state.calls.find((c) => c.path.includes('collections:import'));
      expect(call?.body).toEqual({
        source: { kind: 'localPath', path: '/backups/demo.tar.gz' },
        targetPath: '/tmp/restored',
        name: 'demo_copy',
      });
    });
  });
});
