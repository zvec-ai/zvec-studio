/**
 * Tests for the Create Collection dialog.
 *
 * The dialog is a controlled component driven by form state + a single
 * mutation. We inject a fake ``ApiClient`` so we can assert the exact request
 * payload that would reach the backend, then drive validation errors via the
 * in-component ``validate`` pass.
 */
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import { ApiError, type ApiClient } from '@/lib/api-client';
import type { UserFacingError } from '@/lib/error-mapper';
import { CreateCollectionDialog } from './CreateCollectionDialog';

// Force the "native picker" branch of DirectoryInput so tests can drive Browse
// synchronously without opening the in-app modal that would call /fs/list.
vi.mock('@/lib/directory-picker', () => ({
  supportsNativeDirectoryPicker: () => true,
  pickDirectoryNative: vi.fn(async () => ({ kind: 'picked' as const, path: '/Users/bigbob/data' })),
}));

interface FakeState {
  createError?: UserFacingError;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function fakeError(code: string): UserFacingError {
  return {
    code,
    message: code,
    messageKey: `errors.code.${code}`,
    status: 409,
    traceId: null,
    severity: 'warning',
  };
}

function makeApiClient(state: FakeState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (path === '/collections' && method === 'GET') {
        return { items: [] } as unknown as T;
      }
      if (path === '/collections' && method === 'POST') {
        if (state.createError) throw new ApiError(state.createError);
        const body = opts!.body as { path: string; schema: { name: string } };
        return {
          name: body.schema.name,
          path: body.path,
          schema: body.schema,
          stats: { documentCount: 0, indexState: 'none', storageBytes: 0 },
        } as unknown as T;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

/** Minimal host component that owns the ``open`` state for the dialog. */
function Harness(): JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <>
      <CreateCollectionDialog open={open} onClose={() => setOpen(false)} />
      <span data-testid="harness-open">{open ? 'yes' : 'no'}</span>
    </>
  );
}

describe('<CreateCollectionDialog />', () => {
  it('shows validation errors when required fields are empty', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.click(screen.getByTestId('zv-create-submit'));

    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Path is required.')).toBeInTheDocument();
    // No POST should have been attempted.
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an invalid name format', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), '1bad name');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/foo');
    await userEvent.click(screen.getByTestId('zv-create-submit'));

    expect(
      await screen.findByText(/Name must match \^\[A-Za-z\]/),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects an out-of-range dimension', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'ok');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/ok');
    const dim = screen.getByLabelText('Dimension');
    await userEvent.clear(dim);
    await userEvent.type(dim, '0');
    await userEvent.click(screen.getByTestId('zv-create-submit'));

    expect(
      await screen.findByText(
        'Dimension must be an integer between 1 and 32768.',
      ),
    ).toBeInTheDocument();
  });

  it('submits the normalized payload and closes on success', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'alpha');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/alpha');
    await userEvent.click(screen.getByTestId('zv-create-submit'));

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST' && c.path === '/collections')).toBe(true);
    });
    const post = state.calls.find((c) => c.method === 'POST')!;
    const body = post.body as { path: string; schema: { name: string; vectors: Array<{ dimension: number }> } };
    expect(body.path).toBe('/tmp/alpha');
    expect(body.schema.name).toBe('alpha');
    expect(body.schema.vectors[0]?.dimension).toBe(768);

    // Harness flips to "no" once the dialog triggers onClose.
    await waitFor(() => {
      expect(screen.getByTestId('harness-open')).toHaveTextContent('no');
    });
  });

  it('keeps the dialog open when the server reports an error', async () => {
    const state: FakeState = {
      createError: fakeError('COLLECTION_ALREADY_EXISTS'),
      calls: [],
    };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'dup');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/dup');
    await userEvent.click(screen.getByTestId('zv-create-submit'));

    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST')).toBe(true);
    });
    // Dialog stays open so the user can adjust and retry.
    expect(screen.getByTestId('harness-open')).toHaveTextContent('yes');
  });

  it('auto-composes path from picked parent directory and collection name', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    // 1. Browse first — parent dir picked, but name is empty: path = parent.
    await userEvent.click(screen.getByTestId('zv-create-path-browse'));
    const pathInput = screen.getByTestId('zv-create-path') as HTMLInputElement;
    await waitFor(() => expect(pathInput.value).toBe('/Users/bigbob/data'));

    // 2. Type name — path auto-composes parent + name.
    await userEvent.type(screen.getByTestId('zv-create-name'), 'orders');
    await waitFor(() => expect(pathInput.value).toBe('/Users/bigbob/data/orders'));

    // 3. Submit — backend receives the composed absolute path.
    await userEvent.click(screen.getByTestId('zv-create-submit'));
    await waitFor(() => {
      expect(state.calls.some((c) => c.method === 'POST' && c.path === '/collections')).toBe(true);
    });
    const post = state.calls.find((c) => c.method === 'POST')!;
    expect((post.body as { path: string }).path).toBe('/Users/bigbob/data/orders');
  });

  it('manual path edit breaks the linkage so subsequent name changes do not override', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'alpha');
    await userEvent.click(screen.getByTestId('zv-create-path-browse'));
    const pathInput = screen.getByTestId('zv-create-path') as HTMLInputElement;
    await waitFor(() => expect(pathInput.value).toBe('/Users/bigbob/data/alpha'));

    // User overrides path manually — linkage breaks.
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/custom/elsewhere');
    expect(pathInput.value).toBe('/custom/elsewhere');

    // Changing name no longer touches path.
    await userEvent.clear(screen.getByTestId('zv-create-name'));
    await userEvent.type(screen.getByTestId('zv-create-name'), 'beta');
    expect(pathInput.value).toBe('/custom/elsewhere');
  });

  it('rejects duplicate field names between scalar fields', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'myCol');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/myCol');

    // Add two scalar fields with the same name.
    const addBtn = screen.getByText('Add field');
    await userEvent.click(addBtn);
    await userEvent.click(addBtn);

    const fieldNameInputs = screen.getAllByLabelText('Name');
    // fieldNameInputs[0] is the vector "embedding"; [1] and [2] are the new scalars.
    await userEvent.type(fieldNameInputs[1], 'status');
    await userEvent.type(fieldNameInputs[2], 'status');

    await userEvent.click(screen.getByTestId('zv-create-submit'));

    expect(
      await screen.findByText(/"status".*unique|"status".*\u91cd\u590d/),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('rejects scalar field name that collides with a vector field name', async () => {
    const state: FakeState = { calls: [] };
    const apiClient = makeApiClient(state);
    renderWithProviders(<Harness />, { apiClient });

    await userEvent.type(screen.getByTestId('zv-create-name'), 'myCol');
    await userEvent.type(screen.getByTestId('zv-create-path'), '/tmp/myCol');

    // Add a scalar field named "embedding" — same as the default vector field.
    await userEvent.click(screen.getByText('Add field'));
    const fieldNameInputs = screen.getAllByLabelText('Name');
    await userEvent.type(fieldNameInputs[1], 'embedding');

    await userEvent.click(screen.getByTestId('zv-create-submit'));

    expect(
      await screen.findByText(/"embedding".*unique|"embedding".*\u91cd\u590d/),
    ).toBeInTheDocument();
    expect(state.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
