/**
 * Vitest setup file. Registers jest-dom matchers and resets globals between tests.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Node 22+ ships a built-in ``localStorage`` that is missing ``getItem`` /
 * ``setItem`` / ``clear`` etc., and jsdom doesn't paper over it. Tests that
 * exercise storage-backed hooks (e.g. search history) crash without a real
 * implementation, so we install a minimal in-memory replacement up front.
 */
function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const fake: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
  };
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: fake,
    });
  } catch {
    // ignore — fall back to direct assignment below.
  }
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: fake,
    });
  } catch {
    // ignore
  }
}

installMemoryLocalStorage();

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  cleanup();
});
