/**
 * Typed API client for Zvec Studio backend.
 *
 * We wrap the native ``fetch`` with JSON encoding, Problem Details handling and
 * trace-id propagation, and re-export the generated OpenAPI types so feature
 * pages can ask for ``paths['/api/v1/collections']['get']`` etc.
 */
import type { components } from '@zvec-studio/api-client';

import { mapProblem, mapUnknownError, type UserFacingError } from './error-mapper';

export type { components, paths } from '@zvec-studio/api-client';

import { isTauri, invokeTauri } from './runtime';

export const DEFAULT_API_BASE_URL = '/api/v1';
const TAURI_FALLBACK_BASE_URL = 'http://127.0.0.1:7861/api/v1';

let resolvedBaseUrl: string | null = null;

export async function resolveApiBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) return resolvedBaseUrl;
  if (isTauri()) {
    try {
      const url = await invokeTauri<string>('sidecar_url');
      if (url) {
        resolvedBaseUrl = `${url}/api/v1`;
        return resolvedBaseUrl;
      }
    } catch {
      // invoke failed — fall through to hardcoded default
    }
    resolvedBaseUrl = TAURI_FALLBACK_BASE_URL;
    return resolvedBaseUrl;
  }
  resolvedBaseUrl = DEFAULT_API_BASE_URL;
  return resolvedBaseUrl;
}

export function getResolvedApiBaseUrl(): string {
  if (!resolvedBaseUrl && isTauri()) return TAURI_FALLBACK_BASE_URL;
  return resolvedBaseUrl ?? DEFAULT_API_BASE_URL;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly headers?: Record<string, string>;
}

/**
 * ApiError carries the typed :class:`UserFacingError` alongside the raw status
 * so consumers (TanStack Query, Toast centre) can react uniformly.
 */
export class ApiError extends Error {
  readonly error: UserFacingError;
  constructor(error: UserFacingError) {
    super(error.message);
    this.name = 'ApiError';
    this.error = error;
  }
}

export interface ApiClient {
  readonly baseUrl: string;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
}

export interface CreateApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Build a configured API client. */
export function createApiClient(options: CreateApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? DEFAULT_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, signal, headers } = opts;
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/json, application/problem+json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    if (signal) {
      init.signal = signal;
    }

    let response: Response;
    try {
      response = await fetchImpl(joinUrl(baseUrl, path), init);
    } catch (err) {
      throw new ApiError(await mapUnknownError(err));
    }

    if (!response.ok) {
      const traceId = response.headers.get('x-trace-id');
      try {
        const problem = (await response.clone().json()) as Record<string, unknown>;
        throw new ApiError(
          mapProblem({ ...problem, traceId: (problem.traceId as string) ?? traceId ?? undefined }, response.status),
        );
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(await mapUnknownError(response));
      }
    }

    if (response.status === 204) {
      return undefined as T;
    }
    // Assume JSON; 2xx with empty body is handled by caller typing.
    return (await response.json()) as T;
  }

  return { baseUrl, request };
}

function joinUrl(base: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const trimmedPath = path.startsWith('/') ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

/** Convenience re-exports for common schemas (sugar for call sites). */
export type CollectionSchema = components['schemas']['CollectionSchema'];
export type CollectionSummary = components['schemas']['CollectionSummary'];
export type DocumentInsertRequest = components['schemas']['DocumentInsertRequest'];
export type SearchRequest = components['schemas']['SearchRequest'];
export type SearchResponse = components['schemas']['SearchResponse'];
