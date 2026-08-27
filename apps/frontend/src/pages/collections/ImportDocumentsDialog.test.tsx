import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';

import { ImportDocumentsDialog } from './ImportDocumentsDialog';

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

const OK_REPORT = {
  imported: 3,
  failed: 0,
  totalLines: 3,
  aborted: false,
  durationMs: 12.5,
  errors: [],
  errorsTruncated: false,
};

const PARTIAL_REPORT = {
  imported: 1,
  failed: 2,
  totalLines: 3,
  aborted: false,
  durationMs: 8.1,
  errors: [
    {
      line: 2,
      code: 'DIMENSION_MISMATCH',
      message: "Vector 'embedding' must be a list of length 4",
    },
    { line: 3, code: 'INVALID_DOCUMENT', message: 'Line 3 is not valid JSON' },
  ],
  errorsTruncated: false,
};

describe('ImportDocumentsDialog', () => {
  it('disables submit until a file path is provided', () => {
    const state: FakeState = { calls: [], response: OK_REPORT };
    renderWithProviders(<ImportDocumentsDialog open onClose={() => {}} collection="demo" />, {
      apiClient: makeClient(state),
    });

    expect(screen.getByTestId('zv-import-submit')).toBeDisabled();
  });

  it('submits a replace-mode import and shows the report', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_REPORT };
    renderWithProviders(<ImportDocumentsDialog open onClose={() => {}} collection="demo" />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-import-path'), '/data/demo.jsonl');
    await user.click(screen.getByTestId('zv-import-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('zv-import-report')).toBeInTheDocument();
    });

    const call = state.calls.find((c) => c.path.includes('documents:import'));
    expect(call).toBeDefined();
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({
      source: { kind: 'localPath', path: '/data/demo.jsonl' },
      mode: 'replace',
      onError: 'abort',
    });
  });

  it('renders failing rows and keeps the dialog open on partial failure', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: PARTIAL_REPORT };
    renderWithProviders(<ImportDocumentsDialog open onClose={() => {}} collection="demo" />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-import-path'), '/data/demo.jsonl');
    await user.click(screen.getByTestId('zv-import-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('zv-import-errors')).toBeInTheDocument();
    });
    expect(screen.getByTestId('zv-import-errors').textContent).toContain('DIMENSION_MISMATCH');
    // Partial failure must not close the dialog.
    expect(screen.getByTestId('zv-import-report')).toBeInTheDocument();
    expect(screen.getByTestId('zv-import-done')).toBeInTheDocument();
  });

  it('sends insert mode and skip policy when selected', async () => {
    const user = userEvent.setup();
    const state: FakeState = { calls: [], response: OK_REPORT };
    renderWithProviders(<ImportDocumentsDialog open onClose={() => {}} collection="demo" />, {
      apiClient: makeClient(state),
    });

    await user.type(screen.getByTestId('zv-import-path'), '/data/demo.jsonl');
    await user.click(screen.getByRole('radio', { name: /Insert only/i }));
    await user.click(screen.getByRole('radio', { name: /Skip failing rows/i }));
    await user.click(screen.getByTestId('zv-import-submit'));

    await waitFor(() => {
      const call = state.calls.find((c) => c.path.includes('documents:import'));
      expect(call?.body).toEqual({
        source: { kind: 'localPath', path: '/data/demo.jsonl' },
        mode: 'insert',
        onError: 'skip',
      });
    });
  });
});
