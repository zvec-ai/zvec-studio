/**
 * Tiny wrapper around ``msw/node``'s ``setupServer``.
 *
 * Centralising the import keeps each test file a two-liner and lets us swap
 * to ``setupWorker`` (browser mode) later without touching call sites.
 */
import { setupServer } from 'msw/node';
import type { HttpHandler } from 'msw';

export type TestServer = ReturnType<typeof setupServer>;

export function createTestServer(handlers: HttpHandler[] = []): TestServer {
  return setupServer(...handlers);
}
