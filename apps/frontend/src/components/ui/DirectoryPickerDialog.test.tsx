import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import type { ApiClient } from '@/lib/api-client';
import type { FsListing } from '@/lib/fs-api';

import { DirectoryInput } from './DirectoryInput';
import { DirectoryPickerDialog } from './DirectoryPickerDialog';

interface FakeFsState {
  listings: Record<string, FsListing>;
  error?: Error;
  calls: Array<{ method: string; path: string; body?: unknown }>;
}

function makeClient(state: FakeFsState): ApiClient {
  return {
    baseUrl: 'fake',
    request: async <T,>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> => {
      const method = opts?.method ?? 'GET';
      state.calls.push({ method, path, body: opts?.body });
      if (state.error) throw state.error;
      if (method === 'GET' && path.startsWith('/fs/list')) {
        const [, query = ''] = path.split('?');
        const params = new URLSearchParams(query);
        const requested = params.get('path') ?? '/';
        const listing = state.listings[requested];
        if (!listing) throw new Error(`Missing listing: ${requested}`);
        return listing as unknown as T;
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  };
}

function fixtures(): Record<string, FsListing> {
  return {
    '/': {
      path: '/',
      parent: null,
      home: '/home/bob',
      entries: [{ name: 'tmp', path: '/tmp' }],
    },
    '/tmp': {
      path: '/tmp',
      parent: '/',
      home: '/home/bob',
      entries: [{ name: 'projects', path: '/tmp/projects' }],
    },
    '/tmp/projects': {
      path: '/tmp/projects',
      parent: '/tmp',
      home: '/home/bob',
      entries: [],
    },
    '/home/bob': {
      path: '/home/bob',
      parent: '/home',
      home: '/home/bob',
      entries: [],
    },
  };
}

describe('DirectoryPickerDialog', () => {
  it('loads directories, navigates shortcuts, and selects the current path', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const state: FakeFsState = { listings: fixtures(), calls: [] };

    renderWithProviders(
      <DirectoryPickerDialog
        open
        initialPath="/tmp"
        onSelect={onSelect}
        onClose={onClose}
      />,
      { apiClient: makeClient(state) },
    );

    expect(await screen.findByDisplayValue('/tmp')).toBeInTheDocument();
    await user.click(screen.getByTestId('zv-dirpicker-entry-projects'));
    expect(await screen.findByDisplayValue('/tmp/projects')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-dirpicker-parent'));
    expect(await screen.findByDisplayValue('/tmp')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-dirpicker-home'));
    expect(await screen.findByDisplayValue('/home/bob')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-dirpicker-select'));
    expect(onSelect).toHaveBeenCalledWith('/home/bob');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('loads a typed path when pressing Enter or Go', async () => {
    const user = userEvent.setup();
    const state: FakeFsState = { listings: fixtures(), calls: [] };
    renderWithProviders(
      <DirectoryPickerDialog open initialPath="/" onSelect={() => undefined} onClose={() => undefined} />,
      { apiClient: makeClient(state) },
    );

    const pathInput = await screen.findByTestId('zv-dirpicker-path');
    fireEvent.change(pathInput, { target: { value: '/tmp' } });
    fireEvent.keyDown(pathInput, { key: 'Enter' });
    expect(await screen.findByDisplayValue('/tmp')).toBeInTheDocument();

    fireEvent.change(pathInput, { target: { value: '/home/bob' } });
    await user.click(screen.getByTestId('zv-dirpicker-go'));
    expect(await screen.findByDisplayValue('/home/bob')).toBeInTheDocument();

    expect(state.calls.some((c) => c.path === '/fs/list?path=%2Fhome%2Fbob')).toBe(true);
  });

  it('surfaces filesystem listing errors', async () => {
    const state: FakeFsState = {
      listings: fixtures(),
      error: new Error('permission denied'),
      calls: [],
    };
    renderWithProviders(
      <DirectoryPickerDialog open onSelect={() => undefined} onClose={() => undefined} />,
      { apiClient: makeClient(state) },
    );

    expect(await screen.findByTestId('zv-dirpicker-error')).toHaveTextContent('permission denied');
  });

  it('lets DirectoryInput open the web picker and emit selected paths', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const state: FakeFsState = { listings: fixtures(), calls: [] };

    renderWithProviders(
      <DirectoryInput
        value="/tmp"
        onChange={onChange}
        label="Path"
        data-testid="zv-path"
      />,
      { apiClient: makeClient(state) },
    );

    await user.click(screen.getByTestId('zv-path-browse'));
    expect(await screen.findByTestId('zv-dirpicker-entries')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-dirpicker-entry-projects'));
    expect(await screen.findByDisplayValue('/tmp/projects')).toBeInTheDocument();
    await user.click(screen.getByTestId('zv-dirpicker-select'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('/tmp/projects');
    });
  });

  it('sends DirectoryInput browse selections to onBrowse when provided', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onBrowse = vi.fn();
    const state: FakeFsState = { listings: fixtures(), calls: [] };

    renderWithProviders(
      <DirectoryInput
        value="/tmp"
        onChange={onChange}
        onBrowse={onBrowse}
        data-testid="zv-parent"
      />,
      { apiClient: makeClient(state) },
    );

    await user.click(screen.getByTestId('zv-parent-browse'));
    const pickerPath = await screen.findByTestId('zv-dirpicker-path');
    expect(pickerPath).toHaveValue('/tmp');
    await user.click(screen.getByTestId('zv-dirpicker-select'));

    expect(onBrowse).toHaveBeenCalledWith('/tmp');
    expect(onChange).not.toHaveBeenCalled();
  });
});
