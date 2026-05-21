import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient, resolveApiBaseUrl, getResolvedApiBaseUrl, DEFAULT_API_BASE_URL } from './api-client';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
};

describe('createApiClient', () => {
  it('uses DEFAULT_API_BASE_URL when no baseUrl is given', () => {
    const client = createApiClient();
    expect(client.baseUrl).toBe(DEFAULT_API_BASE_URL);
  });

  it('makes a GET request and returns JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [1, 2] }), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const result = await client.request<{ items: number[] }>('/things');
    expect(result).toEqual({ items: [1, 2] });
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test/things',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('makes a POST request with JSON body', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'new' }), { status: 201 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const result = await client.request<{ id: string }>('/items', {
      method: 'POST',
      body: { name: 'x' },
    });
    expect(result).toEqual({ id: 'new' });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ name: 'x' }));
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns undefined for 204 No Content', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    const result = await client.request('/things/1', { method: 'DELETE' });
    expect(result).toBeUndefined();
  });

  it('throws ApiError with parsed ProblemDetails on 4xx', async () => {
    const body = JSON.stringify({ code: 'COLLECTION_NOT_FOUND', detail: 'gone' });
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(body, {
        status: 404,
        headers: { 'x-trace-id': 'trace-1', 'Content-Type': 'application/problem+json' },
      }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(client.request('/col/x')).rejects.toThrow(ApiError);
    try {
      await client.request('/col/x');
    } catch (e) {
      const err = e as ApiError;
      expect(err.error.code).toBe('COLLECTION_NOT_FOUND');
      expect(err.error.traceId).toBe('trace-1');
      expect(err.error.status).toBe(404);
    }
  });

  it('throws ApiError with fallback when error body is not JSON', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('Bad Gateway', { status: 502 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(client.request('/x')).rejects.toThrow(ApiError);
    try {
      await client.request('/x');
    } catch (e) {
      const err = e as ApiError;
      expect(err.error.code).toBe('INTERNAL_ERROR');
      expect(err.error.status).toBe(502);
    }
  });

  it('throws ApiError wrapping TypeError on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await expect(client.request('/x')).rejects.toThrow(ApiError);
    try {
      await client.request('/x');
    } catch (e) {
      const err = e as ApiError;
      expect(err.error.code).toBe('NETWORK_ERROR');
      expect(err.error.status).toBe(0);
    }
  });

  it('passes signal through to fetch', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await client.request('/x', { signal: controller.signal });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });

  it('passes custom headers through to fetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await client.request('/x', { headers: { 'X-Custom': 'val' } });
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers['X-Custom']).toBe('val');
  });

  it('joins URL correctly when path lacks leading slash', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://test/', fetchImpl: mockFetch });
    await client.request('items');
    expect(mockFetch).toHaveBeenCalledWith('http://test/items', expect.anything());
  });

  it('passes absolute URLs through unchanged', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: 'http://test', fetchImpl: mockFetch });
    await client.request('https://other.host/path');
    expect(mockFetch).toHaveBeenCalledWith('https://other.host/path', expect.anything());
  });
});

describe('resolveApiBaseUrl', () => {
  beforeEach(() => {
    // Reset the module-level cache by reimporting would be ideal,
    // but we can test the web path since no Tauri globals are present.
    const w = window as TauriWindow;
    delete w.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    const w = window as TauriWindow;
    delete w.__TAURI_INTERNALS__;
  });

  it('resolves to DEFAULT_API_BASE_URL on web builds', async () => {
    const url = await resolveApiBaseUrl();
    expect(url).toBe(DEFAULT_API_BASE_URL);
  });

  it('getResolvedApiBaseUrl returns DEFAULT_API_BASE_URL on web', () => {
    expect(getResolvedApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
  });
});
