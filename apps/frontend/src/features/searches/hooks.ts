/**
 * React Query + localStorage helpers for vector search.
 *
 * ``useSearchDocuments`` wraps the search endpoint in a mutation because
 * searches are intentional user actions and results aren't cached.
 * ``useSearchHistory`` persists up to ``HISTORY_LIMIT`` recent search payloads
 * per Collection in localStorage, giving the operator a quick "re-run" list.
 * The PRD calls for IndexedDB eventually; we start with localStorage because
 * the shape is tiny (< 1 KB per entry) and it keeps the jsdom + Playwright
 * tests deterministic.
 */
import { useCallback, useEffect, useState } from 'react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { useApiClient } from '@/lib/api-client-context';

import {
  createSearchesApi,
  type SearchRequest,
  type SearchResponse,
} from './api';

export const HISTORY_LIMIT = 10;

/** Run a vector search mutation against the given Collection. */
export function useSearchDocuments(
  collection: string,
): UseMutationResult<SearchResponse, unknown, SearchRequest> {
  const client = useApiClient();
  const api = createSearchesApi(client);
  return useMutation({
    mutationFn: (body) => api.run(collection, body),
  });
}

export interface SearchHistoryEntry {
  /** Monotonic id used as the React key and for de-duplication. */
  readonly id: string;
  /** Epoch millis, for sorting + displaying a timestamp label. */
  readonly createdAt: number;
  /** The request body as sent to the backend. */
  readonly request: SearchRequest;
  /** Summary stats so the UI can preview without re-running. */
  readonly resultCount: number;
  readonly tookMs: number;
}

export interface UseSearchHistoryResult {
  readonly entries: ReadonlyArray<SearchHistoryEntry>;
  push(entry: Omit<SearchHistoryEntry, 'id' | 'createdAt'>): SearchHistoryEntry;
  clear(): void;
  remove(id: string): void;
}

function storageKey(collection: string): string {
  return `zvec-studio:search-history:${collection}`;
}

/** Access the window storage if available — returns ``null`` under Node. */
function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Safari private mode / sandbox can throw — fall back to in-memory only.
    return null;
  }
}

function readEntries(collection: string): Array<SearchHistoryEntry> {
  const storage = getStorage();
  if (!storage) return [];
  const raw = storage.getItem(storageKey(collection));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeEntries(collection: string, next: ReadonlyArray<SearchHistoryEntry>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(collection), JSON.stringify(next));
  } catch {
    // Quota exceeded or storage disabled: silently drop — the UI still works.
  }
}

function isEntry(value: unknown): value is SearchHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.createdAt === 'number' &&
    typeof v.resultCount === 'number' &&
    typeof v.tookMs === 'number' &&
    v.request !== null &&
    typeof v.request === 'object'
  );
}

/**
 * React hook that surfaces the persisted search history for ``collection`` and
 * exposes mutations to push / remove / clear entries. New entries are prepended
 * and the list is capped at ``HISTORY_LIMIT``.
 */
export function useSearchHistory(collection: string): UseSearchHistoryResult {
  const [entries, setEntries] = useState<Array<SearchHistoryEntry>>(() =>
    readEntries(collection),
  );

  // Re-hydrate when switching between Collections in the same session.
  useEffect(() => {
    setEntries(readEntries(collection));
  }, [collection]);

  const push = useCallback(
    (entry: Omit<SearchHistoryEntry, 'id' | 'createdAt'>) => {
      const next: SearchHistoryEntry = {
        ...entry,
        id: `sh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
      };
      setEntries((prev) => {
        const merged = [next, ...prev].slice(0, HISTORY_LIMIT);
        writeEntries(collection, merged);
        return merged;
      });
      return next;
    },
    [collection],
  );

  const remove = useCallback(
    (id: string) => {
      setEntries((prev) => {
        const merged = prev.filter((entry) => entry.id !== id);
        writeEntries(collection, merged);
        return merged;
      });
    },
    [collection],
  );

  const clear = useCallback(() => {
    writeEntries(collection, []);
    setEntries([]);
  }, [collection]);

  return { entries, push, remove, clear };
}
