import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type ThemeName = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'zv-theme';

function matchDarkMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
}

function getSystemTheme(): 'light' | 'dark' {
  return matchDarkMedia()?.matches ? 'dark' : 'light';
}

function getStoredPreference(): ThemeName {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch { /* SSR / test */ }
  return 'system';
}

function resolveTheme(pref: ThemeName): 'light' | 'dark' {
  return pref === 'system' ? getSystemTheme() : pref;
}

function applyToDOM(resolved: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

let listeners: Array<() => void> = [];
let currentPref: ThemeName = getStoredPreference();
applyToDOM(resolveTheme(currentPref));

matchDarkMedia()?.addEventListener('change', () => {
  if (currentPref === 'system') {
    applyToDOM(resolveTheme('system'));
    listeners.forEach((l) => l());
  }
});

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): ThemeName {
  return currentPref;
}

function setTheme(next: ThemeName) {
  currentPref = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* test */ }
  applyToDOM(resolveTheme(next));
  listeners.forEach((l) => l());
}

export function useTheme(): {
  preference: ThemeName;
  resolved: 'light' | 'dark';
  setTheme: (t: ThemeName) => void;
  toggle: () => void;
} {
  const preference = useSyncExternalStore(subscribe, getSnapshot);
  const resolved = resolveTheme(preference);

  useEffect(() => {
    applyToDOM(resolved);
  }, [resolved]);

  const toggle = useCallback(() => {
    const next = resolved === 'light' ? 'dark' : 'light';
    setTheme(next);
  }, [resolved]);

  return { preference, resolved, setTheme, toggle };
}
